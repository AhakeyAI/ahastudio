// AhaStation agent hook relay. Installed by AhaStation Local CLI; safe to delete.
// Forwards Agent CLI hook payloads to the AhaStation loopback hook server.
// Does nothing unless launched inside an AhaStation terminal (env vars below).
'use strict';
const fs = require('node:fs');
const http = require('node:http');
const { StringDecoder } = require('node:string_decoder');

const provider = /^[a-z0-9._-]{1,32}$/.test(process.argv[2] || '') ? process.argv[2] : '';
const eventArg = /^[A-Za-z0-9._-]{1,64}$/.test(process.argv[3] || '') ? process.argv[3] : '';

// Terminals outlive app restarts with stale env; the app keeps the live port/token in this file.
function liveEndpoint() {
  const file = process.env.AHA_AGENT_HOOK_ENDPOINT_FILE;
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(data && data.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (typeof data.token !== 'string' || !/^[a-f0-9]{16,128}$/i.test(data.token)) return null;
    return { url: 'http://127.0.0.1:' + port + '/hook', token: data.token };
  } catch {
    return null;
  }
}
const live = liveEndpoint();
const hookUrl = live ? live.url : process.env.AHA_AGENT_HOOK_URL || '';
const token = live ? live.token : process.env.AHA_AGENT_HOOK_TOKEN || '';
const ptyId = process.env.AHA_TERMINAL_ID || '';
const MAX_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_BODY_BYTES = 60000;

let finished = false;
let stdinHandled = false;
let resolvedEventName = eventArg;
let idleTimer = null;
let fallbackTimer = null;
let safetyTimer = null;

function isHoldablePermissionEvent(evName, payload) {
  const norm = String(evName || '').replace(/[-_\s]+/g, '').toLowerCase();
  if (norm === 'permissionrequest') return true;
  if (norm === 'beforetool') {
    return payload.requiresApproval === true || payload.requires_approval === true ||
      payload.askPermission === true || payload.ask_permission === true || payload.confirmationDetails != null;
  }
  return norm === 'pretooluse' && (
    (payload.tool_name || payload.toolName) === 'ask_permission' ||
    payload.requiresApproval === true || payload.requires_approval === true ||
    payload.permissionPrompt === true || payload.holdForApproval === true
  );
}

function unavailableDecision(eventName) {
  const reason = 'AhaStation could not confirm this permission request.';
  const norm = String(eventName || '').replace(/[-_\s]+/g, '').toLowerCase();
  if (provider === 'claude' && norm === 'pretooluse') {
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason,
    } }) + '\n';
  }
  if (provider === 'claude' || provider === 'qwen' || provider === 'codex') {
    return JSON.stringify({ hookSpecificOutput: {
      hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: reason },
    } }) + '\n';
  }
  return JSON.stringify({ decision: 'deny', reason }) + '\n';
}

function antigravityReplyFor(eventName) {
  const ev = eventName || eventArg;
  // PreToolUse treats empty stdout or {} as denial; "ask" keeps permission policy active.
  if (ev === 'PreToolUse') return '{"decision":"ask"}\n';
  if (ev === 'Stop') return '{"decision":""}\n';
  return '{}\n';
}

function finish(eventName, customStdout) {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  clearTimeout(fallbackTimer);
  clearTimeout(safetyTimer);
  try { process.stdin.pause(); } catch {}
  if (typeof customStdout === 'string' && customStdout.length > 0) {
    process.stdout.write(customStdout, () => process.exit(0));
  } else if (provider === 'antigravity') {
    process.stdout.write(antigravityReplyFor(eventName || resolvedEventName), () => process.exit(0));
  } else if (provider === 'gemini') {
    process.stdout.write('{}\n', () => process.exit(0));
  } else {
    process.exit(0);
  }
}
safetyTimer = setTimeout(() => finish(), 3000);
safetyTimer.unref();

function hasCompleteJsonObject(str) {
  let depth = 0;
  let started = false;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (!started) {
      if (/\s/.test(ch)) continue;
      if (ch !== '{') return false;
      started = true;
      depth = 1;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return true;
    }
  }
  return false;
}

function shrink(value, depth) {
  if (typeof value === 'string') return value.length > 2000 ? value.slice(0, 2000) : value;
  if (!value || typeof value !== 'object') return value;
  if (depth >= 4) return undefined;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => shrink(v, depth + 1));
  const out = {};
  for (const key of Object.keys(value).slice(0, 60)) out[key] = shrink(value[key], depth + 1);
  return out;
}

function send(raw) {
  let payload;
  if (!raw.trim() && eventArg) {
    payload = { hook_event_name: eventArg };
  } else {
    try { payload = JSON.parse(raw); } catch { finish(); return; }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { finish(); return; }
  if (eventArg && !payload.hook_event_name && !payload.hookEventName && !payload.event && !payload.type) {
    payload.hook_event_name = eventArg;
  }
  const ev = payload.hook_event_name || payload.hookEventName || payload.event || payload.type;
  if (typeof ev === 'string' && ev.trim()) resolvedEventName = ev.trim();
  const gated = isHoldablePermissionEvent(resolvedEventName, payload);
  const managedWorker = Boolean(process.env.AHA_DISPATCH_CAPABILITY);
  let connected = false;
  // Once connected to AhaStation (or inside an automated worker), fail closed on drop/timeout.
  // If AhaStation was closed (`ECONNREFUSED` before connect) in an interactive user terminal,
  // exit silently so the CLI falls back to its own terminal permission prompt.
  const transportFailed = () =>
    finish(
      resolvedEventName,
      gated && (connected || managedWorker) ? unavailableDecision(resolvedEventName) : undefined
    );

  let body = JSON.stringify(shrink(payload, 0));
  if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
    const flat = {};
    for (const [key, val] of Object.entries(payload)) {
      if (typeof val === 'string') flat[key] = val.slice(0, 300);
      else if (typeof val === 'number' || typeof val === 'boolean') flat[key] = val;
    }
    body = JSON.stringify(flat);
  }
  let target;
  try { target = new URL(hookUrl.replace(/\/+$/, '') + (provider ? '/' + provider : '')); } catch { transportFailed(); return; }
  const req = http.request(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-aha-agent-hook-token': token,
      'x-aha-pty-id': ptyId,
    },
    timeout: 1500,
  }, (res) => {
    const chunks = [];
    let total = 0;
    res.on('data', (chunk) => {
      if (total < 65536) {
        chunks.push(chunk);
        total += chunk.length;
      }
    });
    res.on('end', () => {
      if (res.statusCode !== 200) {
        transportFailed();
        return;
      }
      let hookStdout = '';
      if (chunks.length > 0) {
        try {
          const parsedRes = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (parsedRes && typeof parsedRes.hookStdout === 'string') {
            hookStdout = parsedRes.hookStdout;
          }
        } catch {}
      }
      finish(resolvedEventName, hookStdout);
    });
    res.on('error', transportFailed);
  });
  req.on('socket', (socket) => {
    socket.once('connect', () => {
      connected = true;
      if (gated) {
        // Only extend wait window after confirming the local hook server is reachable.
        req.setTimeout(125000);
        clearTimeout(safetyTimer);
        safetyTimer = setTimeout(transportFailed, 125000);
        safetyTimer.unref();
      }
    });
  });
  req.on('timeout', () => { req.destroy(); transportFailed(); });
  req.on('error', transportFailed);
  req.end(body);
}

if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/hook\/?$/.test(hookUrl) || !token || !/^[A-Za-z0-9._-]{1,128}$/.test(ptyId)) {
  finish();
} else if (provider === 'codex' && process.argv.length >= 4 && /^\s*\{/.test(process.argv[process.argv.length - 1] || '')) {
  // Legacy Codex `notify` passes the event JSON as the last argv entry;
  // Codex `hooks.json` pipes JSON over stdin (handled below).
  send(process.argv[process.argv.length - 1] || '');
} else if (process.stdin.isTTY) {
  if (eventArg) send('{}');
  else finish();
} else {
  const decoder = new StringDecoder('utf8');
  let raw = '';
  let size = 0;

  const finishStdin = () => {
    if (stdinHandled) return;
    stdinHandled = true;
    clearTimeout(idleTimer);
    clearTimeout(fallbackTimer);
    try { process.stdin.pause(); } catch {}
    raw += decoder.end();
    send(raw);
  };

  fallbackTimer = setTimeout(finishStdin, 1500);
  fallbackTimer.unref();

  process.stdin.on('data', (chunk) => {
    if (stdinHandled) return;
    size += chunk.length;
    if (size > MAX_STDIN_BYTES) {
      stdinHandled = true;
      finish();
      return;
    }
    raw += decoder.write(chunk);
    // agy on Windows can keep stdin open after sending the JSON payload.
    if (hasCompleteJsonObject(raw)) {
      finishStdin();
      return;
    }
    clearTimeout(idleTimer);
    idleTimer = setTimeout(finishStdin, 200);
    idleTimer.unref();
  });
  process.stdin.on('end', finishStdin);
  process.stdin.on('error', () => finish());
}
