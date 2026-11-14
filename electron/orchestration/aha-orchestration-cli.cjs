#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const TWO_WORD_COMMANDS = {
  run: ['create', 'use', 'current', 'list', 'show'],
  task: ['create', 'list', 'update', 'show'],
  gate: ['create', 'resolve', 'list'],
  dispatch: ['show'],
  coordinator: ['start', 'stop', 'tick', 'status'],
};

const BOOLEAN_FLAGS = new Set([
  'json',
  'full',
  'wait',
  'peek',
  'all',
  'unread',
  'holdAck',
  'inject',
  'dryRun',
  'preamble',
  'autoSpawn',
  'autoSpawnWorkers',
  'format',
  'help',
]);

function parseCliArgs(argv) {
  let args = argv.slice();
  if (args[0] === 'orchestration' || args[0] === 'orch') {
    args = args.slice(1);
  }
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { help: true };
  }

  let verb = args.shift();
  const subVerbs = TWO_WORD_COMMANDS[verb];
  if (subVerbs && args.length > 0 && !args[0].startsWith('-') && subVerbs.includes(args[0])) {
    verb = `${verb}-${args.shift()}`;
  }

  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i];
    if (token === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!token.startsWith('--')) {
      positional.push(token);
      continue;
    }
    if (token.startsWith('--no-')) {
      flags[toCamel(token.slice(5))] = false;
      continue;
    }
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      const rawKey = token.slice(2, eqIndex);
      if (!rawKey) continue;
      const key = toCamel(rawKey);
      const rawVal = token.slice(eqIndex + 1);
      flags[key] = BOOLEAN_FLAGS.has(key) ? toBoolean(rawVal) : rawVal;
      continue;
    }
    const key = toCamel(token.slice(2));
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      i += 1;
    } else {
      // PowerShell drops unquoted @name arguments (splatting); never send the string "true" instead.
      throw new Error(
        `Missing value for --${token.slice(2)}${key === 'to' ? " (in PowerShell quote mailbox names, e.g. --to '@all')" : ''}`
      );
    }
  }

  return { help: false, verb, flags, positional };
}

function toCamel(kebab) {
  return kebab.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
    if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  }
  return Boolean(value);
}

function splitCsv(value) {
  if (typeof value !== 'string') return undefined;
  const items = value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

function toNumber(value) {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
  }
  return undefined;
}

/**
 * Terminals survive app restarts with their original env, but the server port/token change.
 * The app keeps the live endpoint in a file whose path is stable, so prefer it when present.
 */
function readEndpointFile() {
  const file = process.env.AHA_AGENT_HOOK_ENDPOINT_FILE;
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(data && data.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (typeof data.token !== 'string' || !/^[a-f0-9]{16,128}$/i.test(data.token)) return null;
    return { baseUrl: `http://127.0.0.1:${port}/orchestration`, token: data.token };
  } catch {
    return null;
  }
}

function resolveEndpoint() {
  const fromFile = readEndpointFile();
  if (fromFile) return fromFile;
  return { baseUrl: resolveBaseUrl(), token: process.env.AHA_AGENT_HOOK_TOKEN || '' };
}

function resolveBaseUrl() {
  if (process.env.AHA_ORCHESTRATION_URL) {
    return process.env.AHA_ORCHESTRATION_URL.replace(/\/+$/, '');
  }
  if (process.env.AHA_AGENT_HOOK_URL) {
    return process.env.AHA_AGENT_HOOK_URL.replace(/\/hook\/?$/, '') + '/orchestration';
  }
  if (process.env.AHA_AGENT_HOOK_PORT) {
    return `http://127.0.0.1:${process.env.AHA_AGENT_HOOK_PORT}/orchestration`;
  }
  throw new Error(
    'Missing orchestration endpoint env (AHA_ORCHESTRATION_URL or AHA_AGENT_HOOK_URL).'
  );
}

function postJson(urlStr, token, bodyObj) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr);
    const bodyText = JSON.stringify(bodyObj);
    const client = parsed.protocol === 'https:' ? https : http;

    const req = client.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(bodyText),
          ...(token ? { 'x-aha-agent-hook-token': token } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            const json = JSON.parse(text);
            resolve({ status: res.statusCode || 500, body: json });
          } catch {
            reject(new Error(`Invalid JSON response (${res.statusCode}): ${text}`));
          }
        });
      }
    );

    const onSignal = () => {
      req.destroy(new Error('Aborted'));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);

    req.on('error', (err) => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      reject(err);
    });
    req.on('close', () => {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    });

    req.write(bodyText);
    req.end();
  });
}

function buildPayload(verb, flags, positional) {
  const defaultFrom =
    typeof flags.from === 'string' ? flags.from : process.env.AHA_TERMINAL_ID || undefined;
  const capability =
    typeof flags.capability === 'string' ? flags.capability : process.env.AHA_DISPATCH_CAPABILITY || undefined;
  const withCapability = (obj) => (capability ? { ...obj, capability } : obj);
  const runId = typeof flags.run === 'string' ? flags.run : flags.runId;
  const wantJson = flags.json === true;
  const full = flags.full === true;

  switch (verb) {
    case 'run-create':
      return {
        action: 'run-create',
        payload: {
          ...(flags.id ? { id: String(flags.id) } : {}),
          objective: String(flags.objective ?? positional.join(' ')),
          ...(defaultFrom ? { from: defaultFrom } : {}),
        },
      };
    case 'run-use':
      return {
        action: 'run-use',
        payload: {
          id: String(flags.id ?? positional[0] ?? ''),
          ...(defaultFrom ? { from: defaultFrom } : {}),
        },
      };
    case 'run-current':
      return {
        action: 'run-current',
        payload: { ...(defaultFrom ? { from: defaultFrom } : {}) },
      };
    case 'run-list':
      return {
        action: 'run-list',
        payload: { ...(flags.status ? { status: String(flags.status) } : {}) },
      };
    case 'run-show':
      return {
        action: 'run-show',
        payload: { id: String(flags.id ?? positional[0] ?? '') },
      };
    case 'task-create':
      return {
        action: 'task-create',
        payload: {
          ...(flags.id ? { id: String(flags.id) } : {}),
          ...(runId ? { runId: String(runId) } : {}),
          ...(defaultFrom ? { from: defaultFrom } : {}),
          spec: String(flags.spec ?? positional.join(' ')),
          ...(flags.title ? { taskTitle: String(flags.title) } : {}),
          ...(flags.priority ? { priority: String(flags.priority) } : {}),
          ...(flags.deps ? { deps: splitCsv(String(flags.deps)) } : {}),
          ...(flags.worktree ? { worktreePath: String(flags.worktree) } : {}),
        },
      };
    case 'task-list':
      return {
        action: 'task-list',
        payload: {
          ...(runId ? { runId: String(runId) } : {}),
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.status ? { status: String(flags.status) } : {}),
          ...(flags.priority ? { priority: String(flags.priority) } : {}),
        },
      };
    case 'task-show':
      return {
        action: 'task-show',
        payload: {
          id: String(flags.id ?? flags.task ?? flags.taskId ?? positional[0] ?? ''),
          receiptText: !wantJson,
          full,
        },
      };
    case 'task-update':
      return {
        action: 'task-update',
        payload: {
          id: String(flags.id ?? positional[0] ?? ''),
          status: String(flags.status ?? positional[1] ?? ''),
        },
      };
    case 'dispatch':
      return {
        action: 'dispatch',
        payload: {
          taskId: String(flags.task ?? flags.taskId ?? positional[0] ?? ''),
          ...(flags.to ? { to: String(flags.to) } : {}),
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.inject !== undefined ? { inject: toBoolean(flags.inject) } : {}),
          ...(flags.dryRun !== undefined ? { dryRun: toBoolean(flags.dryRun) } : {}),
        },
      };
    case 'dispatch-show':
      return {
        action: 'dispatch-show',
        payload: {
          taskId: String(flags.task ?? flags.taskId ?? positional[0] ?? ''),
          ...(flags.preamble !== undefined ? { preamble: toBoolean(flags.preamble) } : {}),
        },
      };
    case 'coordinator-start': {
      const autoSpawnRaw = flags.autoSpawnWorkers ?? flags.autoSpawn;
      const workerCli = flags.workerCli ?? flags.workerCliId ?? flags.cli;
      return {
        action: 'coordinator-start',
        payload: {
          ...(runId ? { runId: String(runId) } : {}),
          ...(flags.spec ? { spec: String(flags.spec) } : {}),
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.pollIntervalMs ? { pollIntervalMs: toNumber(flags.pollIntervalMs) } : {}),
          ...(flags.maxConcurrent ? { maxConcurrent: toNumber(flags.maxConcurrent) } : {}),
          ...(autoSpawnRaw !== undefined ? { autoSpawnWorkers: toBoolean(autoSpawnRaw) } : {}),
          ...(workerCli ? { workerCliId: String(workerCli) } : {}),
          ...(flags.workers ? { workerPaneIds: splitCsv(String(flags.workers)) ?? [] } : {}),
          ...(flags.cwd ? { cwd: String(flags.cwd) } : {}),
        },
      };
    }
    case 'coordinator-stop':
      return { action: 'coordinator-stop', payload: {} };
    case 'coordinator-tick':
      return {
        action: 'coordinator-tick',
        payload: { ...(runId ? { runId: String(runId) } : {}) },
      };
    case 'coordinator-status':
      return {
        action: 'coordinator-status',
        payload: {
          ...(runId ? { runId: String(runId) } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    case 'send':
      return {
        action: 'send',
        payload: withCapability({
          ...(defaultFrom ? { from: defaultFrom } : {}),
          to: String(flags.to ?? ''),
          ...(flags.type ? { type: String(flags.type) } : {}),
          ...(flags.priority ? { priority: String(flags.priority) } : {}),
          subject: String(flags.subject ?? 'Message'),
          ...(flags.body !== undefined ? { body: String(flags.body) } : {}),
          ...(flags.payload !== undefined ? { payload: String(flags.payload) } : {}),
          ...(runId ? { runId: String(runId) } : {}),
          ...(flags.thread ? { threadId: String(flags.thread) } : {}),
          receiptText: !wantJson,
          full,
        }),
      };
    case 'worker-done':
      return {
        action: 'worker-done',
        payload: withCapability({
          ...(defaultFrom ? { from: defaultFrom } : {}),
          taskId: String(flags.task ?? flags.taskId ?? ''),
          dispatchId: String(flags.dispatch ?? flags.dispatchId ?? ''),
          ...(flags.outcome ? { outcome: String(flags.outcome) } : {}),
          ...(flags.summary !== undefined ? { summary: String(flags.summary) } : {}),
          receiptText: !wantJson,
          full,
        }),
      };
    case 'check':
      return {
        action: 'check',
        payload: {
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(runId ? { runId: String(runId) } : {}),
          ...(flags.unread !== undefined ? { unread: toBoolean(flags.unread) } : {}),
          ...(flags.peek !== undefined ? { peek: toBoolean(flags.peek) } : {}),
          ...(flags.all !== undefined ? { all: toBoolean(flags.all) } : {}),
          ...(flags.wait !== undefined ? { wait: toBoolean(flags.wait) } : {}),
          ...(flags.timeoutMs ? { timeoutMs: toNumber(flags.timeoutMs) } : {}),
          ...(flags.types ? { types: splitCsv(String(flags.types)) } : {}),
          ...(flags.ack ? { ack: String(flags.ack) } : {}),
          ...(flags.holdAck !== undefined ? { holdAck: toBoolean(flags.holdAck) } : {}),
          ...(flags.format !== undefined ? { format: toBoolean(flags.format) } : { format: true }),
          receiptText: !wantJson,
          full,
        },
      };
    case 'inbox':
      return {
        action: 'inbox',
        payload: {
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(runId ? { runId: String(runId) } : {}),
          ...(flags.limit ? { limit: toNumber(flags.limit) } : {}),
          ...(flags.types ? { types: splitCsv(String(flags.types)) } : {}),
          ...(flags.unread ? { unreadOnly: true } : {}),
        },
      };
    case 'ask':
      return {
        action: 'ask',
        payload: withCapability({
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.to ? { to: String(flags.to) } : {}),
          ...(flags.question || positional.length > 0
            ? { question: String(flags.question ?? positional.join(' ')) }
            : {}),
          ...(flags.options ? { options: splitCsv(String(flags.options)) } : {}),
          ...(flags.wait ? { wait: true } : {}),
          ...(flags.timeoutMs ? { timeoutMs: toNumber(flags.timeoutMs) } : {}),
          ...(flags.resume ? { resume: String(flags.resume) } : {}),
          ...(flags.dispatch || flags.dispatchId
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId) }
            : {}),
          ...(runId ? { runId: String(runId) } : {}),
          receiptText: !wantJson,
          full,
        }),
      };
    case 'reply':
      return {
        action: 'reply',
        payload: {
          id: String(flags.id ?? positional[0] ?? ''),
          body: String(flags.body ?? positional.slice(1).join(' ')),
          ...(defaultFrom ? { from: defaultFrom } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    case 'gate-create': {
      const explicitTask = flags.task ?? flags.taskId;
      const gateQuestion =
        flags.question ?? (explicitTask ? positional.join(' ') : positional.slice(1).join(' '));
      return {
        action: 'gate-create',
        payload: {
          taskId: String(explicitTask ?? positional[0] ?? ''),
          question: String(gateQuestion ?? ''),
          ...(flags.options ? { options: splitCsv(String(flags.options)) } : {}),
          ...(defaultFrom ? { from: defaultFrom } : {}),
        },
      };
    }
    case 'gate-resolve':
      return {
        action: 'gate-resolve',
        payload: {
          id: String(flags.id ?? positional[0] ?? ''),
          resolution: String(flags.resolution ?? positional.slice(1).join(' ')),
        },
      };
    case 'gate-list':
      return {
        action: 'gate-list',
        payload: {
          ...(runId ? { runId: String(runId) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(flags.status ? { status: String(flags.status) } : {}),
        },
      };
    default:
      throw new Error(`Unknown orchestration command: ${verb}`);
  }
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.help) {
    console.log(
      [
        'AhaStation Multi-Agent Orchestration CLI',
        'Usage: aha orchestration <command> [options]',
        '',
        'Commands:',
        '  run-create | run-use | run-current | run-list | run-show',
        '  task-create | task-list | task-update | task-show',
        '  dispatch | dispatch-show',
        '  coordinator-start | coordinator-stop | coordinator-tick | coordinator-status',
        '  send | worker-done | check | inbox | ask | reply',
        '  gate-create | gate-resolve | gate-list',
      ].join('\n')
    );
    return;
  }

  const { baseUrl, token } = resolveEndpoint();
  const { action, payload } = buildPayload(parsed.verb, parsed.flags, parsed.positional);
  const res = await postJson(`${baseUrl}/${action}`, token, payload);

  if (!res.body || res.body.ok !== true) {
    if (parsed.flags.json) {
      console.error(JSON.stringify(res.body));
    } else {
      const code = res.body && res.body.code ? `[${res.body.code}] ` : '';
      const msg = (res.body && res.body.error) || `HTTP ${res.status}`;
      console.error(`${code}${msg}`);
    }
    process.exitCode = 1;
    return;
  }

  if (parsed.flags.json) {
    console.log(JSON.stringify(res.body.result, null, 2));
  } else if (typeof res.body.receiptText === 'string' && res.body.receiptText.length > 0) {
    console.log(res.body.receiptText);
  } else {
    console.log(JSON.stringify(res.body.result, null, 2));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  });
}

module.exports = {
  parseCliArgs,
  resolveEndpoint,
  buildPayload,
  toBoolean,
};
