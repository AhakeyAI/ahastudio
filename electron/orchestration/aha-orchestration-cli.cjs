#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');

const TWO_WORD_COMMANDS = {
  run: ['create', 'use', 'current', 'list', 'show', 'diff', 'finalize'],
  task: ['create', 'list', 'update', 'show', 'done', 'fail'],
  gate: ['create', 'resolve', 'list'],
  dispatch: ['show'],
  worker: [
    'start',
    'list',
    'show',
    'read',
    'diff',
    'integrate',
    'keep-open',
    'retain',
    'release',
    'stop',
    'abandon',
    'done',
  ],
  coordinator: ['start', 'stop', 'tick', 'status'],
};

const COMPANION_NAMESPACES = new Set(['terminal', 'worktree', 'skills']);

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
  'screen',
  'keepOpen',
  'keepPane',
  'keepWorktree',
  'removeWorktree',
  'force',
  'submit',
  'enter',
  'includeExited',
  'includeSettled',
  'detach',
  'releaseAfter',
  'deleteBranch',
  'reviewRun',
  'tasks',
  'messages',
  'help',
]);

const FREE_TEXT_FLAGS = new Set([
  'spec',
  'body',
  'subject',
  'reason',
  'summary',
  'question',
  'resolution',
  'text',
  'objective',
  'title',
  'taskTitle',
  'displayName',
]);

const REPEATABLE_FLAGS = new Set(['constraint', 'file']);
const CONTEXT_TEXT_FLAGS = new Set(['context', 'background', 'acceptance', 'constraint']);
const CONTEXT_FILE_MAX_BYTES = 64 * 1024;

function parseCliArgs(argv) {
  let args = argv.slice();
  let namespace = 'orchestration';

  if (args[0] === 'mcp') {
    return { help: false, namespace: 'mcp', verb: 'serve', flags: {}, positional: args.slice(1) };
  }
  if (args[0] === 'orchestration' || args[0] === 'orch') {
    args = args.slice(1);
  } else if (COMPANION_NAMESPACES.has(args[0])) {
    namespace = args.shift();
  }

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    return { help: true, namespace };
  }

  let verb = args.shift();
  if (namespace === 'orchestration') {
    const subVerbs = TWO_WORD_COMMANDS[verb];
    if (subVerbs && args.length > 0 && !args[0].startsWith('-') && subVerbs.includes(args[0])) {
      verb = `${verb}-${args.shift()}`;
    }
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
      const noKey = toCamel(token.slice(5));
      flags[noKey] = false;
      if (noKey === 'worktree') {
        flags.noWorktree = true;
      }
      continue;
    }
    const eqIndex = token.indexOf('=');
    if (eqIndex !== -1) {
      const rawKey = token.slice(2, eqIndex);
      if (!rawKey) continue;
      const key = toCamel(rawKey);
      const rawVal = token.slice(eqIndex + 1);
      const val =
        key === 'reviewRun' && rawVal.trim() && !/^(true|false|1|0|yes|no)$/i.test(rawVal.trim())
          ? rawVal.trim()
          : BOOLEAN_FLAGS.has(key)
            ? toBoolean(rawVal)
            : rawVal;
      if (REPEATABLE_FLAGS.has(key)) {
        if (!Array.isArray(flags[key])) flags[key] = [];
        flags[key].push(val);
      } else {
        flags[key] = val;
      }
      continue;
    }
    const key = toCamel(token.slice(2));
    if (BOOLEAN_FLAGS.has(key)) {
      flags[key] = true;
      continue;
    }
    const next = args[i + 1];
    const acceptsDashPrefix =
      FREE_TEXT_FLAGS.has(key) || (namespace === 'worktree' && key === 'prompt');
    if (next !== undefined && (acceptsDashPrefix || !next.startsWith('--'))) {
      if (REPEATABLE_FLAGS.has(key)) {
        if (!Array.isArray(flags[key])) flags[key] = [];
        flags[key].push(next);
      } else {
        flags[key] = next;
      }
      i += 1;
    } else {
      if (CONTEXT_TEXT_FLAGS.has(key)) {
        throw new Error('Missing value for ' + token + '. Use ' + token + '=value for text starting with --.');
      }
      // PowerShell drops unquoted @name arguments (splatting); never send the string "true" instead.
      throw new Error(
        `Missing value for --${token.slice(2)}${key === 'to' ? " (in PowerShell quote mailbox names, e.g. --to '@all')" : ''}`
      );
    }
  }

  return { help: false, namespace, verb, flags, positional };
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

function extractContextPayload(flags) {
  const inlineContext = flags.context ?? flags.background;
  if (inlineContext !== undefined && flags.contextFile !== undefined) {
    throw new Error('Cannot combine --context and --context-file.');
  }
  const contextVal =
    flags.contextFile !== undefined
      ? readContextFile(flags.contextFile)
      : inlineContext !== undefined
        ? String(inlineContext)
        : undefined;
  const constraints = [
    ...(Array.isArray(flags.constraint) ? flags.constraint : flags.constraint ? [flags.constraint] : []),
    ...(flags.constraints ? splitCsv(String(flags.constraints)) || [] : []),
  ]
    .map((v) => String(v).trim())
    .filter(Boolean);
  const files = [
    ...(Array.isArray(flags.file) ? flags.file : flags.file ? [flags.file] : []),
    ...(flags.files ? splitCsv(String(flags.files)) || [] : []),
  ]
    .map((v) => String(v).trim())
    .filter(Boolean);
  const acceptance = flags.acceptance !== undefined ? String(flags.acceptance).trim() : '';
  return {
    ...(contextVal && contextVal.trim().length > 0 ? { context: contextVal.trim() } : {}),
    ...(constraints.length > 0 ? { constraints } : {}),
    ...(files.length > 0 ? { files } : {}),
    ...(acceptance ? { acceptance } : {}),
  };
}

function parseOptionsList(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        const cleaned = parsed.map((item) => String(item).trim()).filter(Boolean);
        return cleaned.length > 0 ? cleaned : undefined;
      }
    } catch {
      // Fall through to CSV split.
    }
  }
  return splitCsv(value);
}

function readContextFile(filePath) {
  const target = String(filePath);
  const fd = target === '-' ? 0 : fs.openSync(target, 'r');
  try {
    const buffer = Buffer.alloc(CONTEXT_FILE_MAX_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const count = fs.readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (count === 0) break;
      bytes += count;
    }
    if (bytes > CONTEXT_FILE_MAX_BYTES) {
      throw new Error('Context file exceeds the 64 KiB read limit.');
    }
    return buffer.toString('utf8', 0, bytes);
  } finally {
    if (target !== '-') fs.closeSync(fd);
  }
}

function readSpecFile(filePath) {
  const target = String(filePath);
  if (target === '-') {
    return fs.readFileSync(0, 'utf8');
  }
  return fs.readFileSync(target, 'utf8');
}

function buildStructuredSendPayload(flags) {
  const taskId = flags.taskId ?? flags.task;
  const dispatchId = flags.dispatchId ?? flags.dispatch;
  const outcome = flags.outcome;
  const filesModified = flags.filesModified;
  const reportPath = flags.reportPath;
  const phase = flags.phase;
  const hasStructured =
    taskId !== undefined ||
    dispatchId !== undefined ||
    outcome !== undefined ||
    filesModified !== undefined ||
    reportPath !== undefined ||
    phase !== undefined;
  if (!hasStructured) {
    return flags.payload !== undefined ? String(flags.payload) : undefined;
  }
  if (flags.payload !== undefined) {
    throw new Error('Use either --payload or structured payload flags (--task-id/--dispatch-id/--outcome), not both.');
  }
  if (outcome !== undefined && flags.type !== 'worker_done') {
    throw new Error('--outcome is only valid with --type worker_done.');
  }
  const structured = {};
  if (taskId) structured.taskId = String(taskId);
  if (dispatchId) structured.dispatchId = String(dispatchId);
  if (outcome) {
    const norm = String(outcome).trim();
    structured.outcome = norm === 'succeeded' ? 'completed' : norm;
  }
  if (filesModified) {
    structured.filesModified = splitCsv(String(filesModified)) ?? [];
  }
  if (reportPath) structured.reportPath = String(reportPath);
  if (phase) structured.phase = String(phase);
  return JSON.stringify(structured);
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
function readEndpointFile(namespace = 'orchestration') {
  const file = process.env.AHA_AGENT_HOOK_ENDPOINT_FILE;
  if (!file) return null;
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const port = Number(data && data.port);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (typeof data.token !== 'string' || !/^[a-f0-9]{16,128}$/i.test(data.token)) return null;
    return { baseUrl: `http://127.0.0.1:${port}/${namespace}`, token: data.token };
  } catch {
    return null;
  }
}

function resolveEndpoint(namespace = 'orchestration') {
  const fromFile = readEndpointFile(namespace);
  if (fromFile) return fromFile;
  return { baseUrl: resolveBaseUrl(namespace), token: process.env.AHA_AGENT_HOOK_TOKEN || '' };
}

function resolveBaseUrl(namespace = 'orchestration') {
  if (process.env.AHA_ORCHESTRATION_URL) {
    const orchUrl = process.env.AHA_ORCHESTRATION_URL.replace(/\/+$/, '');
    if (namespace === 'orchestration') return orchUrl;
    return orchUrl.replace(/\/orchestration$/, '') + `/${namespace}`;
  }
  if (process.env.AHA_AGENT_HOOK_URL) {
    return process.env.AHA_AGENT_HOOK_URL.replace(/\/hook\/?$/, '') + `/${namespace}`;
  }
  if (process.env.AHA_AGENT_HOOK_PORT) {
    return `http://127.0.0.1:${process.env.AHA_AGENT_HOOK_PORT}/${namespace}`;
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
          ...(process.env.AHA_WORKER_ID
            ? { 'x-aha-worker-id': process.env.AHA_WORKER_ID, 'x-aha-worker-token': process.env.AHA_WORKER_TOKEN || '' }
            : process.env.AHA_TERMINAL_ID && process.env.AHA_ORCHESTRATION_PANE_TOKEN
            ? {
                'x-aha-pty-id': process.env.AHA_TERMINAL_ID,
                'x-aha-pane-token': process.env.AHA_ORCHESTRATION_PANE_TOKEN,
              }
            : {}),
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

function buildCompanionPayload(namespace, verb, flags, positional) {
  const defaultFrom =
    typeof flags.from === 'string' ? flags.from : process.env.AHA_WORKER_ID || process.env.AHA_TERMINAL_ID || undefined;
  const wantJson = flags.json === true;

  if (namespace === 'terminal') {
    switch (verb) {
      case 'list':
        return {
          action: 'list',
          payload: {
            ...(flags.includeExited !== undefined
              ? { includeExited: toBoolean(flags.includeExited) }
              : {}),
            receiptText: !wantJson,
          },
        };
      case 'show':
        return {
          action: 'show',
          payload: {
            id: String(
              flags.id ?? flags.terminal ?? positional[0] ?? process.env.AHA_TERMINAL_ID ?? ''
            ),
            receiptText: !wantJson,
          },
        };
      case 'read':
        return {
          action: 'read',
          payload: {
            id: String(
              flags.id ?? flags.terminal ?? positional[0] ?? process.env.AHA_TERMINAL_ID ?? ''
            ),
            ...(flags.cursor !== undefined ? { cursor: toNumber(flags.cursor) } : {}),
            ...(flags.limit !== undefined ? { limit: toNumber(flags.limit) } : {}),
            ...(flags.screen !== undefined ? { screen: toBoolean(flags.screen) } : {}),
            receiptText: !wantJson,
          },
        };
      case 'send': {
        const submitRaw = flags.submit !== undefined ? flags.submit : flags.enter;
        return {
          action: 'send',
          payload: {
            id: String(flags.id ?? flags.to ?? flags.terminal ?? positional[0] ?? ''),
            text: String(flags.text ?? flags.body ?? positional.slice(1).join(' ')),
            ...(submitRaw !== undefined ? { submit: toBoolean(submitRaw) } : {}),
            ...(defaultFrom ? { from: defaultFrom } : {}),
            receiptText: !wantJson,
          },
        };
      }
      case 'wait':
        return {
          action: 'wait',
          payload: {
            id: String(
              flags.id ?? flags.terminal ?? positional[0] ?? process.env.AHA_TERMINAL_ID ?? ''
            ),
            ...(flags.for ? { for: String(flags.for) } : {}),
            ...(flags.timeoutMs !== undefined ? { timeoutMs: toNumber(flags.timeoutMs) } : {}),
            ...(flags.idleMs !== undefined ? { idleMs: toNumber(flags.idleMs) } : {}),
            receiptText: !wantJson,
          },
        };
      default:
        throw new Error(`Unknown terminal command: ${verb}`);
    }
  }

  if (namespace === 'worktree') {
    switch (verb) {
      case 'list':
        return {
          action: 'list',
          payload: {
            ...(flags.cwd ? { cwd: String(flags.cwd) } : { cwd: process.cwd() }),
            receiptText: !wantJson,
          },
        };
      case 'create':
        return {
          action: 'create',
          payload: {
            ...(flags.cwd ? { cwd: String(flags.cwd) } : { cwd: process.cwd() }),
            ...(flags.path ? { path: String(flags.path) } : {}),
            ...(flags.branch ? { branch: String(flags.branch) } : {}),
            ...(flags.baseBranch ? { baseBranch: String(flags.baseBranch) } : {}),
            ...(flags.name ? { name: String(flags.name) } : {}),
            ...(flags.agent || flags.cli ? { agent: String(flags.agent ?? flags.cli) } : {}),
            ...(flags.model ? { model: String(flags.model) } : {}),
            ...(flags.effort ? { effort: String(flags.effort) } : {}),
            ...(flags.prompt !== undefined ? { prompt: String(flags.prompt) } : {}),
            ...(flags.detach !== undefined ? { detach: toBoolean(flags.detach) } : {}),
            receiptText: !wantJson,
          },
        };
      case 'remove':
      case 'rm':
      case 'delete':
        return {
          action: 'remove',
          payload: {
            ...(flags.cwd ? { cwd: String(flags.cwd) } : { cwd: process.cwd() }),
            path: String(flags.path ?? flags.worktree ?? positional[0] ?? ''),
            ...(flags.force !== undefined ? { force: toBoolean(flags.force) } : {}),
            receiptText: !wantJson,
          },
        };
      default:
        throw new Error(`Unknown worktree command: ${verb}`);
    }
  }

  // namespace === 'skills'
  switch (verb) {
    case 'list':
      return { action: 'list', payload: { receiptText: !wantJson } };
    case 'get':
      return {
        action: 'get',
        payload: {
          ...(flags.name || positional[0] ? { name: String(flags.name ?? positional[0]) } : {}),
          ...(flags.reference || flags.ref
            ? { reference: String(flags.reference ?? flags.ref) }
            : {}),
          ...(flags.full !== undefined ? { full: toBoolean(flags.full) } : {}),
          receiptText: !wantJson,
        },
      };
    case 'sync':
      return {
        action: 'sync',
        payload: {
          ...(flags.homeDir ? { homeDir: String(flags.homeDir) } : {}),
          receiptText: !wantJson,
        },
      };
    default:
      throw new Error(`Unknown skills command: ${verb}`);
  }
}

function buildPayload(verb, flags, positional, namespace = 'orchestration') {
  if (namespace !== 'orchestration') {
    return buildCompanionPayload(namespace, verb, flags, positional);
  }

  const defaultFrom =
    typeof flags.from === 'string' ? flags.from : process.env.AHA_WORKER_ID || process.env.AHA_TERMINAL_ID || undefined;
  const explicitCap = flags.capability ?? flags.dispatchCapability;
  const capability =
    typeof explicitCap === 'string' ? explicitCap : process.env.AHA_DISPATCH_CAPABILITY || undefined;
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
    case 'run-diff': {
      const files = [
        ...(Array.isArray(flags.file) ? flags.file : flags.file ? [flags.file] : []),
        ...(flags.files ? splitCsv(String(flags.files)) || [] : []),
      ]
        .map((v) => String(v).trim())
        .filter(Boolean);
      const targetRunId = runId || flags.id || positional[0];
      return {
        action: 'run-diff',
        payload: {
          ...(targetRunId ? { runId: String(targetRunId) } : {}),
          ...(files.length > 0 ? { files } : {}),
          ...(flags.maxDiffBytes ? { maxDiffBytes: toNumber(flags.maxDiffBytes) } : {}),
        },
      };
    }
    case 'run-finalize': {
      const targetRunId = runId || flags.id || positional[0];
      return {
        action: 'run-finalize',
        payload: {
          ...(targetRunId ? { runId: String(targetRunId) } : {}),
          ...(flags.mode ? { mode: String(flags.mode) } : {}),
          ...(flags.expectedSnapshot || flags.expectedSnapshotOid
            ? { expectedSnapshotOid: String(flags.expectedSnapshot ?? flags.expectedSnapshotOid) }
            : {}),
          ...(flags.commitMessage || flags.message
            ? { commitMessage: String(flags.commitMessage ?? flags.message) }
            : {}),
          ...(flags.deleteBranch !== undefined ? { deleteBranch: toBoolean(flags.deleteBranch) } : {}),
          ...(flags.keepWorktree !== undefined ? { keepWorktree: toBoolean(flags.keepWorktree) } : {}),
          ...(flags.force !== undefined ? { force: toBoolean(flags.force) } : {}),
        },
      };
    }
    case 'task-create': {
      if (flags.spec !== undefined && flags.specFile !== undefined) {
        throw new Error('Cannot combine --spec and --spec-file.');
      }
      const specText =
        flags.specFile !== undefined
          ? readSpecFile(flags.specFile)
          : (flags.spec ?? positional.join(' '));
      return {
        action: 'task-create',
        payload: {
          ...(flags.id ? { id: String(flags.id) } : {}),
          ...(runId ? { runId: String(runId) } : {}),
          ...(defaultFrom ? { from: defaultFrom } : {}),
          spec: String(specText),
          ...extractContextPayload(flags),
          ...(flags.title || flags.taskTitle
            ? { taskTitle: String(flags.title ?? flags.taskTitle) }
            : {}),
          ...(flags.displayName ? { displayName: String(flags.displayName) } : {}),
          ...(flags.priority ? { priority: String(flags.priority) } : {}),
          ...(flags.deps ? { deps: splitCsv(String(flags.deps)) } : {}),
          ...(typeof flags.worktree === 'string' ? { worktreePath: String(flags.worktree) } : {}),
        },
      };
    }
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
    case 'worker-start': {
      if (flags.spec !== undefined && flags.specFile !== undefined) {
        throw new Error('Cannot combine --spec and --spec-file.');
      }
      const workerCli = flags.agent ?? flags.cli ?? flags.cliId;
      const specVal =
        flags.specFile !== undefined
          ? readSpecFile(flags.specFile)
          : (flags.spec ??
            (positional.length > 0 && !flags.task && !flags.taskId
              ? positional.join(' ')
              : undefined));
      return {
        action: 'worker-start',
        payload: {
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(runId ? { runId: String(runId) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(specVal !== undefined && String(specVal).length > 0 ? { spec: String(specVal) } : {}),
          ...extractContextPayload(flags),
          ...(flags.title || flags.taskTitle ? { taskTitle: String(flags.title ?? flags.taskTitle) } : {}),
          ...(flags.displayName ? { displayName: String(flags.displayName) } : {}),
          ...(flags.name ? { name: String(flags.name) } : {}),
          ...(flags.deps ? { deps: splitCsv(String(flags.deps)) } : {}),
          ...(flags.priority ? { priority: String(flags.priority) } : {}),
          ...(flags.retryOf ? { retryOfDispatchId: String(flags.retryOf) } : {}),
          ...(flags.reviewOf ? { reviewOf: String(flags.reviewOf) } : {}),
          ...(flags.reviewRun
            ? { reviewRun: typeof flags.reviewRun === 'string' ? flags.reviewRun : true }
            : {}),
          ...(flags.reviewFocus ? { reviewFocus: String(flags.reviewFocus) } : {}),
          ...(workerCli ? { cliId: String(workerCli) } : {}),
          ...(flags.readOnly === true ? { readOnly: true } : {}),
          ...(flags.model ? { model: String(flags.model) } : {}),
          ...(flags.effort ? { effort: String(flags.effort) } : {}),
          ...(flags.terminal ? { terminal: String(flags.terminal) } : {}),
          ...(flags.worktree !== undefined ? { worktree: flags.worktree } : {}),
          ...(flags.noWorktree ? { noWorktree: true } : {}),
          ...(flags.branch ? { branch: String(flags.branch) } : {}),
          ...(flags.baseBranch ? { baseBranch: String(flags.baseBranch) } : {}),
          ...(flags.cwd ? { cwd: String(flags.cwd) } : {}),
          callerCwd: process.cwd(),
          ...(flags.keepOpen !== undefined ? { keepOpen: toBoolean(flags.keepOpen) } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    }
    case 'worker-diff': {
      const files = [
        ...(Array.isArray(flags.file) ? flags.file : flags.file ? [flags.file] : []),
        ...(flags.files ? splitCsv(String(flags.files)) || [] : []),
      ]
        .map((v) => String(v).trim())
        .filter(Boolean);
      return {
        action: 'worker-diff',
        payload: {
          ...(flags.dispatch || flags.dispatchId || flags.id
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId ?? flags.id) }
            : positional[0]
              ? { worker: String(positional[0]) }
              : {}),
          ...(flags.worker ? { worker: String(flags.worker) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(files.length > 0 ? { files } : {}),
          ...(flags.maxDiffBytes ? { maxDiffBytes: toNumber(flags.maxDiffBytes) } : {}),
        },
      };
    }
    case 'worker-integrate':
      return {
        action: 'worker-integrate',
        payload: {
          ...(flags.dispatch || flags.dispatchId || flags.id
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId ?? flags.id) }
            : positional[0]
              ? { worker: String(positional[0]) }
              : {}),
          ...(flags.worker ? { worker: String(flags.worker) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(flags.mode ? { mode: String(flags.mode) } : {}),
          ...(flags.targetBranch ? { targetBranch: String(flags.targetBranch) } : {}),
          ...(flags.expectedSnapshot || flags.expectedSnapshotOid
            ? { expectedSnapshotOid: String(flags.expectedSnapshot ?? flags.expectedSnapshotOid) }
            : {}),
          ...(flags.commitMessage || flags.message
            ? { commitMessage: String(flags.commitMessage ?? flags.message) }
            : {}),
          ...(flags.releaseAfter !== undefined ? { releaseAfter: toBoolean(flags.releaseAfter) } : {}),
          ...(flags.deleteBranch !== undefined ? { deleteBranch: toBoolean(flags.deleteBranch) } : {}),
          ...(flags.force !== undefined ? { force: toBoolean(flags.force) } : {}),
        },
      };
    case 'worker-list':
      return {
        action: 'worker-list',
        payload: {
          ...(runId ? { runId: String(runId) } : {}),
          ...(flags.status ? { status: String(flags.status) } : {}),
          ...(flags.includeSettled !== undefined
            ? { includeSettled: toBoolean(flags.includeSettled) }
            : {}),
        },
      };
    case 'worker-show':
      return {
        action: 'worker-show',
        payload: {
          ...(flags.dispatch || flags.dispatchId || flags.id
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId ?? flags.id) }
            : positional[0]
              ? { dispatchId: String(positional[0]) }
              : {}),
          ...(flags.worker ? { worker: String(flags.worker) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    case 'worker-read':
      return {
        action: 'worker-read',
        payload: {
          ...(flags.dispatch || flags.dispatchId || flags.id
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId ?? flags.id) }
            : positional[0]
              ? { dispatchId: String(positional[0]) }
              : {}),
          ...(flags.worker ? { worker: String(flags.worker) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(flags.cursor !== undefined ? { cursor: toNumber(flags.cursor) } : {}),
          ...(flags.limit !== undefined ? { limit: toNumber(flags.limit) } : {}),
          ...(flags.screen !== undefined ? { screen: toBoolean(flags.screen) } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    case 'worker-keep-open':
    case 'worker-retain':
      return {
        action: 'worker-keep-open',
        payload: {
          ...(flags.dispatch || flags.dispatchId || flags.id
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId ?? flags.id) }
            : positional[0]
              ? { dispatchId: String(positional[0]) }
              : {}),
          ...(flags.worker ? { worker: String(flags.worker) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(flags.keepOpen !== undefined ? { keepOpen: toBoolean(flags.keepOpen) } : {}),
        },
      };
    case 'worker-release':
      return {
        action: 'worker-release',
        payload: {
          ...(flags.dispatch || flags.dispatchId || flags.id
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId ?? flags.id) }
            : positional[0]
              ? { dispatchId: String(positional[0]) }
              : {}),
          ...(flags.worker ? { worker: String(flags.worker) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(flags.keepPane !== undefined ? { keepPane: toBoolean(flags.keepPane) } : {}),
          ...(flags.keepWorktree !== undefined
            ? { keepWorktree: toBoolean(flags.keepWorktree) }
            : {}),
          ...(flags.force !== undefined ? { force: toBoolean(flags.force) } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    case 'worker-stop':
      return {
        action: 'worker-stop',
        payload: {
          ...(flags.dispatch || flags.dispatchId || flags.id
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId ?? flags.id) }
            : positional[0]
              ? { dispatchId: String(positional[0]) }
              : {}),
          ...(flags.worker ? { worker: String(flags.worker) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(flags.reason ? { reason: String(flags.reason) } : {}),
          ...(flags.removeWorktree !== undefined
            ? { removeWorktree: toBoolean(flags.removeWorktree) }
            : {}),
          ...(flags.force !== undefined ? { force: toBoolean(flags.force) } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    case 'worker-abandon':
      return {
        action: 'worker-abandon',
        payload: {
          ...(flags.dispatch || flags.dispatchId || flags.id
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId ?? flags.id) }
            : positional[0]
              ? { dispatchId: String(positional[0]) }
              : {}),
          ...(flags.worker ? { worker: String(flags.worker) } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(flags.reason ? { reason: String(flags.reason) } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    case 'reset':
      return {
        action: 'reset',
        payload: {
          ...(flags.all !== undefined ? { all: toBoolean(flags.all) } : {}),
          ...(flags.tasks !== undefined ? { tasks: toBoolean(flags.tasks) } : {}),
          ...(flags.messages !== undefined ? { messages: toBoolean(flags.messages) } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    case 'coordinator-start': {
      if (flags.spec !== undefined && flags.specFile !== undefined) {
        throw new Error('Cannot combine --spec and --spec-file.');
      }
      const coordSpec =
        flags.specFile !== undefined ? readSpecFile(flags.specFile) : flags.spec;
      const autoSpawnRaw = flags.autoSpawnWorkers ?? flags.autoSpawn;
      const workerCli = flags.workerCli ?? flags.workerCliId ?? flags.cli;
      return {
        action: 'coordinator-start',
        payload: {
          ...(runId ? { runId: String(runId) } : {}),
          ...(coordSpec ? { spec: String(coordSpec) } : {}),
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
    case 'send': {
      const sendPayload = buildStructuredSendPayload(flags);
      const threadVal = flags.thread ?? flags.threadId;
      return {
        action: 'send',
        payload: withCapability({
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.to !== undefined ? { to: String(flags.to) } : {}),
          ...(flags.type ? { type: String(flags.type) } : {}),
          ...(flags.priority ? { priority: String(flags.priority) } : {}),
          subject: String(flags.subject ?? 'Message'),
          ...(flags.body !== undefined ? { body: String(flags.body) } : {}),
          ...(sendPayload !== undefined ? { payload: sendPayload } : {}),
          ...(runId ? { runId: String(runId) } : {}),
          ...(threadVal ? { threadId: String(threadVal) } : {}),
          receiptText: !wantJson,
          full,
        }),
      };
    }
    case 'worker-done':
    case 'task-done':
    case 'task-fail':
      return {
        action: verb,
        payload: withCapability({
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.task || flags.taskId ? { taskId: String(flags.task ?? flags.taskId) } : {}),
          ...(flags.dispatch || flags.dispatchId
            ? { dispatchId: String(flags.dispatch ?? flags.dispatchId) }
            : {}),
          ...(flags.outcome
            ? { outcome: String(flags.outcome) }
            : verb === 'task-done'
              ? { outcome: 'completed' }
              : verb === 'task-fail'
                ? { outcome: 'failed' }
                : {}),
          ...(flags.summary !== undefined
            ? { summary: String(flags.summary) }
            : positional.length > 0
              ? { summary: positional.join(' ') }
              : {}),
          ...(flags.verdict ? { verdict: String(flags.verdict).toLowerCase() } : {}),
          ...(flags.findingsJson ? { findings: JSON.parse(String(flags.findingsJson)) } : {}),
          receiptText: !wantJson,
          full,
        }),
      };
    case 'approve': {
      const explicitApprovalId = flags.id ?? flags.prompt ?? flags.approval;
      const explicitDispatchId = flags.dispatch ?? flags.dispatchId;
      return {
        action: 'approve',
        payload: {
          id: String(explicitApprovalId ?? explicitDispatchId ?? positional[0] ?? ''),
          ...(explicitApprovalId && explicitDispatchId
            ? { dispatchId: String(explicitDispatchId) }
            : {}),
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.reason !== undefined
            ? { reason: String(flags.reason) }
            : positional.length > 1
              ? { reason: positional.slice(1).join(' ') }
              : {}),
          receiptText: !wantJson,
          full,
        },
      };
    }
    case 'deny': {
      const explicitApprovalId = flags.id ?? flags.prompt ?? flags.approval;
      const explicitDispatchId = flags.dispatch ?? flags.dispatchId;
      return {
        action: 'deny',
        payload: {
          id: String(explicitApprovalId ?? explicitDispatchId ?? positional[0] ?? ''),
          ...(explicitApprovalId && explicitDispatchId
            ? { dispatchId: String(explicitDispatchId) }
            : {}),
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.reason !== undefined
            ? { reason: String(flags.reason) }
            : positional.length > 1
              ? { reason: positional.slice(1).join(' ') }
              : {}),
          receiptText: !wantJson,
          full,
        },
      };
    }
    case 'check': {
      const checkFrom =
        typeof flags.terminal === 'string' && flags.terminal.trim()
          ? flags.terminal.trim()
          : defaultFrom;
      return {
        action: 'check',
        payload: {
          ...(checkFrom ? { from: checkFrom } : {}),
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
    }
    case 'inbox': {
      const inboxFrom =
        typeof flags.terminal === 'string' && flags.terminal.trim()
          ? flags.terminal.trim()
          : defaultFrom;
      return {
        action: 'inbox',
        payload: {
          ...(inboxFrom ? { from: inboxFrom } : {}),
          ...(runId ? { runId: String(runId) } : {}),
          ...(flags.limit ? { limit: toNumber(flags.limit) } : {}),
          ...(flags.types ? { types: splitCsv(String(flags.types)) } : {}),
          ...(flags.unread ? { unreadOnly: true } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    }
    case 'ask':
      return {
        action: 'ask',
        payload: withCapability({
          ...(defaultFrom ? { from: defaultFrom } : {}),
          ...(flags.to ? { to: String(flags.to) } : {}),
          ...(flags.question || positional.length > 0
            ? { question: String(flags.question ?? positional.join(' ')) }
            : {}),
          ...(flags.options ? { options: parseOptionsList(String(flags.options)) } : {}),
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
          ...(flags.options ? { options: parseOptionsList(String(flags.options)) } : {}),
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
          ...(defaultFrom ? { from: defaultFrom } : {}),
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
    case 'agents':
      return {
        action: 'agents',
        payload: {
          ...(defaultFrom ? { callerPaneId: defaultFrom } : {}),
          receiptText: !wantJson,
          full,
        },
      };
    default:
      throw new Error(`Unknown orchestration command: ${verb}`);
  }
}

async function main() {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (parsed.namespace === 'mcp') {
    const { runMcpServer } = require('./aha-mcp-server.cjs');
    await runMcpServer();
    return;
  }
  if (parsed.help) {
    console.log(
      [
        'AhaStation Multi-Agent Orchestration & Companion CLI',
        'Usage:',
        '  aha mcp',
        '  aha orchestration <command> [options]',
        '  aha terminal <list|show|read|send|wait> [options]',
        '  aha worktree <list|create|remove> [options]',
        '  aha skills <list|get|sync> [options]',
        '',
        'Orchestration Commands:',
        '  agents',
        '  worker-start | worker-list | worker-show | worker-read | worker-diff | worker-integrate | worker-keep-open | worker-release | worker-stop | worker-abandon',
        '  approve | deny | reset',
        '  run-create | run-use | run-current | run-list | run-show | run-diff | run-finalize',
        '  task-create | task-list | task-update | task-show | task-done | task-fail',
        '  dispatch | dispatch-show',
        '  coordinator-start | coordinator-stop | coordinator-tick | coordinator-status',
        '  send | worker-done | check | inbox | ask | reply',
        '  gate-create | gate-resolve | gate-list',
      ].join('\n')
    );
    return;
  }

  const namespace = parsed.namespace || 'orchestration';
  const { baseUrl, token } = resolveEndpoint(namespace);
  const { action, payload } = buildPayload(parsed.verb, parsed.flags, parsed.positional, namespace);

  const isWaitCall =
    namespace === 'orchestration' &&
    ((action === 'check' && Boolean(payload.wait)) ||
      (action === 'ask' && Boolean(payload.wait || payload.resume)));
  const rawKeepaliveMs = Number(process.env.AHA_CLI_KEEPALIVE_MS);
  const keepaliveMs =
    Number.isFinite(rawKeepaliveMs) && rawKeepaliveMs > 0 ? rawKeepaliveMs : 15_000;
  let keepaliveTimer = null;
  if (isWaitCall) {
    keepaliveTimer = setInterval(() => {
      try {
        process.stderr.write(
          `${JSON.stringify({ _keepalive: true, ts: new Date().toISOString() })}\n`
        );
      } catch {
        // Ignore closed stderr stream.
      }
    }, keepaliveMs);
    if (typeof keepaliveTimer.unref === 'function') keepaliveTimer.unref();
  }

  let res;
  try {
    res = await postJson(`${baseUrl}/${action}`, token, payload);
  } finally {
    if (keepaliveTimer !== null) clearInterval(keepaliveTimer);
  }

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

  if (
    namespace === 'orchestration' &&
    action === 'send' &&
    res.body.result &&
    res.body.result.lifecycle &&
    res.body.result.lifecycle.action === 'rejected'
  ) {
    const reason = res.body.result.lifecycle.reason || 'Lifecycle report rejected';
    if (parsed.flags.json) {
      console.error(
        JSON.stringify({ ok: false, code: 'lifecycle_rejected', error: reason, result: res.body.result })
      );
    } else {
      console.error(`[lifecycle_rejected] ${reason}`);
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
