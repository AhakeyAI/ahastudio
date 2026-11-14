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

function antigravityReplyFor(eventName) {
  const ev = eventName || eventArg;
  // PreToolUse treats empty stdout or {} as denial; "ask" keeps permission policy active.
  if (ev === 'PreToolUse') return '{"decision":"ask"}\n';
  if (ev === 'Stop') return '{"decision":""}\n';
  return '{}\n';
}

function finish(eventName) {
  if (finished) return;
  finished = true;
  clearTimeout(idleTimer);
  clearTimeout(fallbackTimer);
  try { process.stdin.pause(); } catch {}
  if (provider === 'antigravity') {
    process.stdout.write(antigravityReplyFor(eventName || resolvedEventName), () => process.exit(0));
  } else {
    process.exit(0);
  }
}
setTimeout(() => finish(), 3000).unref();

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
  try { target = new URL(hookUrl.replace(/\/+$/, '') + (provider ? '/' + provider : '')); } catch { finish(); return; }
  const req = http.request(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
      'x-aha-agent-hook-token': token,
      'x-aha-pty-id': ptyId,
    },
    timeout: 1500,
  }, (res) => { res.resume(); res.on('end', () => finish()); res.on('error', () => finish()); });
  req.on('timeout', () => { req.destroy(); finish(); });
  req.on('error', () => finish());
  req.end(body);
}

if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/hook\/?$/.test(hookUrl) || !token || !/^[A-Za-z0-9._-]{1,128}$/.test(ptyId)) {
  finish();
} else if (provider === 'codex') {
  // Codex `notify` passes the event JSON as the last argv entry.
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
