import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ipcMain } from 'electron';

import {
  classifyAgentTitleStatus,
  createAgentPtyOscScanner,
  parseProgramStatusBody,
  PROGRAM_STATUS_MAX_BODY_BYTES,
  PROGRAM_STATUS_QUERY_REPLY,
} from '../dist-electron/agent/program-status-osc.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import {
  deliverPromptToPty,
  formatAgentPromptPayload,
  sanitizeBracketedPasteText,
} from '../dist-electron/agent/agent-prompt-delivery.js';
import { registerShellPtyIpc } from '../dist-electron/ipc/shell-pty.js';
import { registerAgentIpc } from '../dist-electron/ipc/agent.js';
import { getPtyHost } from '../dist-electron/pty-host.js';

function createAgentIpcHarness(t, opts = {}) {
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => {
    handlers.set(channel, fn);
  });

  const sentEvents = [];
  const contents = Object.assign(new EventEmitter(), {
    id: 42,
    send(channel, payload) {
      sentEvents.push({ channel, payload });
    },
  });

  const ctx = {
    liveWindow: () => ({
      webContents: contents,
      isFocused: () => opts.focused ?? true,
      isMinimized: () => false,
      isDestroyed: () => false,
    }),
    getCurrentCwd: () => opts.cwd,
    agentStatusStore: opts.store,
    agentHookEnv: opts.agentHookEnv,
  };

  const ptyCtrl = registerShellPtyIpc(ctx);
  const agentCtrl = registerAgentIpc(ctx, {
    store: opts.store,
    hookServer: opts.hookServer,
    sendInput: ptyCtrl.sendInput,
  });
  t.after(() => agentCtrl.dispose());

  return {
    contents,
    sentEvents,
    call: (channel, payload, senderId = 42) => {
      const handler = handlers.get(channel);
      assert.ok(handler, `expected handler for ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    },
  };
}

test('OSC 7501 grammar parser handles queries, UTF-8 reports, child ids, and rejects malformed/oversized input', () => {
  assert.deepEqual(parseProgramStatusBody(' ? '), { type: 'query' });

  const zhMsg = Buffer.from('正在重构模块', 'utf8').toString('base64');
  const titleB64 = Buffer.from('Agent 任务', 'utf8').toString('base64');
  const parsed = parseProgramStatusBody(
    `state=working:progress=42:app=claude-code:title=${titleB64}:msg=${zhMsg}`,
  );
  assert.deepEqual(parsed, {
    type: 'report',
    report: {
      id: null,
      state: 'working',
      progress: 42,
      app: 'claude',
      title: 'Agent 任务',
      msg: '正在重构模块',
    },
  });

  const blocked = parseProgramStatusBody('state=blocked:kind=permission:id=sub/task-1:app=agy');
  assert.deepEqual(blocked, {
    type: 'report',
    report: {
      id: 'sub/task-1',
      state: 'blocked',
      kind: 'permission',
      app: 'antigravity',
    },
  });

  const grokOsc = parseProgramStatusBody('state=working:app=grok-build');
  assert.deepEqual(grokOsc, {
    type: 'report',
    report: {
      id: null,
      state: 'working',
      app: 'grok',
    },
  });

  // Kind is only retained for `blocked`; progress is only retained for live states.
  assert.deepEqual(parseProgramStatusBody('state=done:kind=permission:progress=99'), {
    type: 'report',
    report: { id: null, state: 'done' },
  });

  // Security & bounds checks
  assert.equal(parseProgramStatusBody('state=working:id=../escape'), null);
  assert.equal(parseProgramStatusBody('state=working:msg=' + 'A'.repeat(4100)), null);
  assert.equal(
    parseProgramStatusBody(`state=working:msg=${Buffer.from('ok\x1b[31m', 'utf8').toString('base64')}`),
    null,
  );
  assert.equal(parseProgramStatusBody('state=working:msg=abcde'), null);
  assert.equal(parseProgramStatusBody('x'.repeat(PROGRAM_STATUS_MAX_BODY_BYTES + 1)), null);
});

test('OSC PTY stream scanner handles split chunks, title glyphs, and shell prompt/reset boundaries', () => {
  const scan = createAgentPtyOscScanner();

  // Split query across multiple small chunks + ST ending split between ESC and backslash
  assert.deepEqual(scan('\x1b]7501'), []);
  assert.deepEqual(scan(';?\x1b'), []);
  assert.deepEqual(scan('\\hello'), [{ type: 'osc7501-query' }]);

  // Split OSC 2 title + normal output
  assert.deepEqual(scan('plain \x1b]2;⠋ Run'), []);
  assert.deepEqual(scan('ning tests\x07after'), [
    { type: 'title', title: '⠋ Running tests' },
  ]);

  // OSC 133;AB must NOT trigger prompt-start; OSC 133;A does.
  assert.deepEqual(scan('\x1b]133;AB\x07\x1b]133;A\x07'), [{ type: 'prompt-start' }]);

  // Split RIS reset across chunks
  assert.deepEqual(scan('\x1b'), []);
  assert.deepEqual(scan('c'), [{ type: 'full-reset' }]);

  // Classifier precedence and word boundaries
  assert.deepEqual(classifyAgentTitleStatus('✋ Approve edit'), {
    state: 'waiting',
    waitKind: 'permission',
    cleanTitle: 'Approve edit',
  });
  assert.deepEqual(classifyAgentTitleStatus('✦ Antigravity Thinking'), {
    state: 'working',
    cleanTitle: 'Antigravity Thinking',
  });
  assert.deepEqual(classifyAgentTitleStatus('✳ Claude Code'), {
    state: 'idle',
    cleanTitle: 'Claude Code',
  });
  assert.equal(classifyAgentTitleStatus('reworking-directory'), null);
});

test('AgentHookServer enforces loopback HTTP security and feeds hook precedence in AgentStatusStore', async (t) => {
  let clock = 1_000;
  const store = new AgentStatusStore({ now: () => clock });
  const server = new AgentHookServer(store);
  const { port, token } = await server.start();
  t.after(() => server.stop());

  const url = `http://127.0.0.1:${port}/hook/claude-code?ptyId=pane-1`;

  // Wrong method -> 405
  const getRes = await fetch(url, { method: 'GET' });
  assert.equal(getRes.status, 405);

  // Missing / invalid token -> 403
  const noAuthRes = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ hook_event_name: 'SessionStart' }),
  });
  assert.equal(noAuthRes.status, 403);

  const badAuthRes = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aha-agent-hook-token': '0'.repeat(token.length),
    },
    body: JSON.stringify({ hook_event_name: 'SessionStart' }),
  });
  assert.equal(badAuthRes.status, 403);

  // Oversized body -> 413
  const bigRes = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aha-agent-hook-token': token,
    },
    body: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: 'x'.repeat(70_000) }),
  });
  assert.equal(bigRes.status, 413);

  // Full Claude hook lifecycle
  const postHook = async (providerPath, payload, useBearer = false, expectedStatus = 200) => {
    const res = await fetch(`http://127.0.0.1:${port}${providerPath}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(useBearer
          ? { authorization: `Bearer ${token}` }
          : { 'x-aha-agent-hook-token': token }),
      },
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, expectedStatus);
    if (expectedStatus === 200) assert.deepEqual(await res.json(), {});
  };

  store.registerPane('pane-1', { agentId: 'claude' });
  await postHook('/hook/claude-code?ptyId=pane-1', {
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Fix tests',
  });
  assert.equal(store.get('pane-1').state, 'working');
  assert.equal(store.get('pane-1').source, 'hook');

  await postHook('/hook/claude-code?ptyId=pane-1', {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
  });
  assert.equal(store.get('pane-1').toolName, 'Bash');
  assert.equal(store.get('pane-1').toolInput, 'npm test');

  // Stale terminal title glyph must NOT override recent hook status within 120s
  clock += 5_000;
  store.ingestPtyData('pane-1', '\x1b]0;✳ Claude Code\x07');
  assert.equal(store.get('pane-1').state, 'working');
  assert.equal(store.get('pane-1').source, 'hook');

  // AskUserQuestion -> waiting(question) + unread=true
  await postHook('/hook/claude-code?ptyId=pane-1', {
    hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion',
    tool_input: { prompt: 'Proceed?' },
  });
  assert.equal(store.get('pane-1').state, 'waiting');
  assert.equal(store.get('pane-1').waitKind, 'question');
  assert.equal(store.get('pane-1').unread, true);
  assert.equal(store.acknowledge('pane-1').unread, false);

  // Subagent start & stop + Stop
  await postHook('/hook/claude?ptyId=pane-1', {
    hook_event_name: 'SubagentStart',
    agent_id: 'worker-7',
    agent_type: 'Explore codebase',
  });
  assert.equal(store.get('pane-1').subagents.length, 1);
  assert.equal(store.get('pane-1').subagents[0].title, 'Explore codebase');

  await postHook('/hook/claude?ptyId=pane-1', {
    hook_event_name: 'SubagentStop',
    agent_id: 'worker-7',
  });
  assert.equal(store.get('pane-1').subagents.length, 0);

  await postHook(
    '/hook/claude?ptyId=pane-1',
    { hook_event_name: 'Stop', last_assistant_message: 'All tests passed.' },
    true,
  );
  const doneStatus = store.get('pane-1');
  assert.equal(doneStatus.state, 'done');
  assert.equal(doneStatus.unread, true);
  assert.equal(doneStatus.message, 'All tests passed.');

  // Antigravity lifecycle on a second pane
  await postHook('/hook/antigravity?ptyId=pane-2', {
    hookEventName: 'PreInvocation',
    lastUserInput: 'Fix bug',
  });
  assert.equal(store.get('pane-2').agentId, 'antigravity');
  assert.equal(store.get('pane-2').state, 'working');
  assert.equal(store.get('pane-2').message, 'Fix bug');

  await postHook('/hook/antigravity?ptyId=pane-2', {
    hookEventName: 'PreToolUse',
    toolCall: { id: 'tc-1', name: 'run_command', args: { CommandLine: 'npm test' } },
  });
  assert.equal(store.get('pane-2').state, 'working');
  assert.equal(store.get('pane-2').toolName, 'run_command');
  assert.equal(store.get('pane-2').toolInput, 'npm test');

  await postHook('/hook/antigravity?ptyId=pane-2', {
    hookEventName: 'PreToolUse',
    toolCall: { id: 'tc-2', name: 'ask_question', args: { Prompt: 'Which DB?' } },
  });
  assert.equal(store.get('pane-2').state, 'waiting');
  assert.equal(store.get('pane-2').waitKind, 'question');

  await postHook('/hook/antigravity?ptyId=pane-2', {
    hookEventName: 'Stop',
    fullyIdle: false,
  });
  assert.equal(store.get('pane-2').state, 'working');

  await postHook('/hook/antigravity?ptyId=pane-2', {
    hookEventName: 'Stop',
    fullyIdle: true,
    terminationReason: 'NO_TOOL_CALL',
    last_assistant_message: 'Updated file.',
  });
  assert.equal(store.get('pane-2').state, 'done');
  assert.equal(store.get('pane-2').message, 'Updated file.');

  await postHook('/hook/antigravity?ptyId=pane-2', {
    hookEventName: 'Stop',
    fullyIdle: true,
    terminationReason: 'ERROR',
    error: 'Rate limit exceeded',
  });
  assert.equal(store.get('pane-2').state, 'error');
  assert.equal(store.get('pane-2').message, 'Rate limit exceeded');

  // Grok Build lifecycle on a third pane (camelCase/snake_case, ask_user_question, subagent isolation, backgroundTasks, StopCancelled)
  store.registerPane('pane-3', { agentId: 'grok' });
  await postHook('/hook/grok?ptyId=pane-3', { hookEventName: 'user_prompt_submit', prompt: 'Check status' });
  assert.equal(store.get('pane-3').state, 'working');
  assert.equal(store.get('pane-3').message, 'Check status');

  // Routine info-level permission_prompt must not falsely flip working state to waiting
  await postHook(
    '/hook/grok?ptyId=pane-3',
    {
      hook_event_name: 'Notification',
      notificationType: 'permission_prompt',
      message: 'Tool permission requested',
      level: 'info',
    },
    false,
    400,
  );
  assert.equal(store.get('pane-3').state, 'working');

  // Child subagent events carry subagentType and must not clobber parent session status
  await postHook(
    '/hook/grok?ptyId=pane-3',
    {
      hook_event_name: 'Stop',
      subagentType: 'explore',
      lastAssistantMessage: 'Subagent finished',
    },
    false,
    400,
  );
  assert.equal(store.get('pane-3').state, 'working');

  await postHook('/hook/grok?ptyId=pane-3', {
    hookEventName: 'pre_tool_use',
    toolName: 'ask_user_question',
    toolInput: { questions: [{ question: 'Deploy to staging?' }] },
  });
  assert.equal(store.get('pane-3').state, 'waiting');
  assert.equal(store.get('pane-3').waitKind, 'question');
  assert.equal(store.get('pane-3').toolInput, 'Deploy to staging?');

  // Finite running backgroundTasks keep pane working when turn pauses
  await postHook('/hook/grok?ptyId=pane-3', {
    hook_event_name: 'Stop',
    backgroundTasks: [{ id: 'bg-1', type: 'shell', status: 'running' }],
  });
  assert.equal(store.get('pane-3').state, 'working');

  await postHook('/hook/grok?ptyId=pane-3', {
    hookEventName: 'stop_cancelled',
    lastAssistantMessage: 'Cancelled by user',
  });
  assert.equal(store.get('pane-3').state, 'done');
  assert.equal(store.get('pane-3').message, 'Cancelled by user');

  await postHook('/hook/grok?ptyId=pane-3', {
    hook_event_name: 'StopFailure',
    errorDetails: 'API timeout',
  });
  assert.equal(store.get('pane-3').state, 'error');
  assert.equal(store.get('pane-3').message, 'API timeout');

  await postHook('/hook/grok?ptyId=pane-3', {
    hookEventName: 'session_end',
  });
  assert.equal(store.get('pane-3').state, 'idle');
});

test('Agent prompt delivery sanitizes ESC/CSI/NUL and enforces bracketed paste + size caps', async () => {
  const malicious = 'line1\r\n\x1b[201~rm -rf /\x9b201~\x00line2';
  const clean = sanitizeBracketedPasteText(malicious);
  assert.equal(clean, 'line1\n[201~rm -rf /201~line2');
  assert.equal(clean.includes('\x1b'), false);
  assert.equal(clean.includes('\x9b'), false);
  assert.equal(clean.includes('\x00'), false);

  const framed = formatAgentPromptPayload({
    prompt: 'Please review \x1b[201~',
    filePath: 'src/demo.ts',
    startLine: 12,
    endLine: 20,
    diffSnippet: '+const x = 1;\n\x1b[201~bad',
  });
  assert.ok(framed.startsWith('\x1b[200~'));
  assert.ok(framed.endsWith('\x1b[201~'));
  const inner = framed.slice('\x1b[200~'.length, -'\x1b[201~'.length);
  assert.equal(inner.includes('\x1b'), false);
  assert.match(inner, /^\[文件: src\/demo\.ts#L12-L20\]/);
  assert.match(inner, /```diff\n\+const x = 1;\n\[201~bad\n```/);

  const writes = [];
  const res = await deliverPromptToPty(
    {
      ptyId: 'local-1',
      prompt: 'Check this',
      submit: true,
      settleDelayMs: 10,
    },
    (ptyId, data) => {
      writes.push({ ptyId, data });
      return { ok: true };
    },
  );
  assert.equal(res.ok, true);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].data, '\x1b[200~Check this\x1b[201~');
  assert.equal(writes[1].data, '\r');

  const tooBig = await deliverPromptToPty(
    { ptyId: 'local-1', prompt: 'a'.repeat(9000) },
    () => ({ ok: true }),
  );
  assert.equal(tooBig.ok, false);
});

test('PTY IPC auto-answers OSC 7501 queries, pushes agent:status-changed, and safely delivers prompts', async (t) => {
  const store = new AgentStatusStore();
  const hookServer = new AgentHookServer(store);
  await hookServer.start();
  t.after(() => hookServer.stop());

  const host = getPtyHost();
  const fakePtys = new Map();
  t.mock.method(host, 'spawn', (id, opts) => {
    const entry = { opts, writes: [], onData: () => {}, onExit: () => {} };
    fakePtys.set(id, entry);
    return 4321;
  });
  t.mock.method(host, 'onData', (id, cb) => {
    fakePtys.get(id).onData = cb;
    return () => {};
  });
  t.mock.method(host, 'onExit', (id, cb) => {
    fakePtys.get(id).onExit = cb;
    return () => {};
  });
  t.mock.method(host, 'write', (id, data) => {
    const pty = fakePtys.get(id);
    if (!pty) return false;
    pty.writes.push(data);
    return true;
  });
  t.mock.method(host, 'replayBuffer', () => Buffer.alloc(0));
  t.mock.method(host, 'kill', (id) => fakePtys.delete(id));

  const { call, sentEvents, contents } = createAgentIpcHarness(t, {
    store,
    hookServer,
    agentHookEnv: (ptyId) => hookServer.envForPane(ptyId),
  });
  t.after(() => contents.emit('destroyed'));

  const created = await call('shell-pty:create', { terminalId: 'agent-pane-1', shellId: 'default' });
  assert.equal(created.ok, true);
  const ptyId = created.ptyId;
  const fakePty = fakePtys.get(ptyId);

  // Spawned environment carries pane id, PI_PROGRAM_STATUS=1, and loopback hook credentials
  assert.equal(fakePty.opts.env.AHA_TERMINAL_ID, ptyId);
  assert.equal(fakePty.opts.env.PI_PROGRAM_STATUS, '1');
  assert.equal(fakePty.opts.env.AHA_AGENT_HOOK_PORT, String(hookServer.port));
  assert.equal(fakePty.opts.env.AHA_AGENT_HOOK_TOKEN, hookServer.authToken);

  // PTY emits OSC 7501 query -> host immediately writes PROGRAM_STATUS_QUERY_REPLY back to PTY
  fakePty.onData('\x1b]7501;?\x1b\\');
  assert.ok(
    fakePty.writes.includes(PROGRAM_STATUS_QUERY_REPLY),
    'expected host to automatically answer OSC 7501 ? query',
  );

  // PTY emits OSC 7501 working -> IPC pushes agent:status-changed & agent:get-status reflects it
  const workingMsg = Buffer.from('Reading codebase', 'utf8').toString('base64');
  fakePty.onData(`\x1b]7501;state=working:app=claude-code:progress=55:msg=${workingMsg}\x1b\\`);

  const statusWorking = await call('agent:get-status', { ptyId });
  assert.equal(statusWorking.ok, true);
  assert.equal(statusWorking.status.state, 'working');
  assert.equal(statusWorking.status.agentId, 'claude');
  assert.equal(statusWorking.status.progress, 55);
  assert.equal(statusWorking.status.message, 'Reading codebase');
  assert.ok(
    sentEvents.some(
      (ev) =>
        ev.channel === 'agent:status-changed' &&
        ev.payload.ptyId === ptyId &&
        ev.payload.state === 'working',
    ),
  );

  // Unsafe snippet injected via agent:send-prompt cannot escape bracketed paste
  const sendRes = await call('agent:send-prompt', {
    ptyId,
    prompt: 'Fix bug',
    filePath: 'src/index.ts',
    startLine: 5,
    diffSnippet: '-old\n+new\x1b[201~echo pwned',
    submit: false,
  });
  assert.equal(sendRes.ok, true);
  const lastWrite = fakePty.writes.at(-1);
  assert.ok(lastWrite.startsWith('\x1b[200~'));
  assert.ok(lastWrite.endsWith('\x1b[201~'));
  const innerPaste = lastWrite.slice('\x1b[200~'.length, -'\x1b[201~'.length);
  assert.equal(innerPaste.includes('\x1b'), false);
  assert.match(innerPaste, /\[201~echo pwned/);

  // Unauthorized sender rejected
  assert.equal((await call('agent:list-statuses', {}, 999)).ok, false);
  assert.equal((await call('agent:send-prompt', { ptyId, prompt: 'hi' }, 999)).ok, false);

  // PTY emits done -> unread becomes true, acknowledge clears it
  fakePty.onData('\x1b]7501;state=done\x1b\\');
  assert.equal((await call('agent:get-status', { ptyId })).status.state, 'done');
  assert.equal((await call('agent:get-status', { ptyId })).status.unread, true);
  const ackRes = await call('agent:acknowledge', { ptyId });
  assert.equal(ackRes.ok, true);
  assert.equal(ackRes.status.unread, false);

  const listRes = await call('agent:list-statuses', {});
  assert.equal(listRes.ok, true);
  assert.equal(listRes.hookPort, hookServer.port);
  assert.ok(listRes.statuses.some((s) => s.ptyId === ptyId));
});

test('real PTY child emits OSC 7501 + posts to loopback hook server using injected AHA_* env', async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'aha-phase4-realpty-'));
  const binDir = join(baseDir, 'bin');
  const scriptPath = join(baseDir, 'fake-cli.mjs');
  const envOutPath = join(baseDir, 'env.json');
  mkdirSync(binDir, { recursive: true });

  writeFileSync(
    scriptPath,
    `
import { writeFileSync } from 'node:fs';
const outPath = ${JSON.stringify(envOutPath)};
writeFileSync(outPath, JSON.stringify({
  ptyId: process.env.AHA_TERMINAL_ID,
  port: process.env.AHA_AGENT_HOOK_PORT,
  piStatus: process.env.PI_PROGRAM_STATUS,
}));
const b64 = Buffer.from('Real PTY running', 'utf8').toString('base64');
process.stdout.write('\\x1b]7501;?\\x1b\\\\');
process.stdout.write('\\x1b]7501;state=working:app=codex:msg=' + b64 + '\\x1b\\\\');
await fetch(process.env.AHA_AGENT_HOOK_URL + '/codex', {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-aha-agent-hook-token': process.env.AHA_AGENT_HOOK_TOKEN,
    'x-aha-pty-id': process.env.AHA_TERMINAL_ID,
  },
  body: JSON.stringify({ event: 'agent-turn-complete', 'last-assistant-message': 'Hook finished cleanly' }),
});
setTimeout(() => process.exit(0), 250);
`,
    'utf8',
  );

  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'codex.cmd'),
      `@echo off\r\n"${process.execPath}" "${scriptPath}"\r\n`,
      'utf8',
    );
  } else {
    writeFileSync(
      join(binDir, 'codex'),
      `#!/bin/sh\n"${process.execPath}" "${scriptPath}"\n`,
      { encoding: 'utf8', mode: 0o755 },
    );
  }

  const prevPath = process.env.PATH;
  process.env.PATH = `${binDir}${process.platform === 'win32' ? ';' : ':'}${prevPath ?? ''}`;

  const store = new AgentStatusStore();
  const hookServer = new AgentHookServer(store);
  await hookServer.start();

  const { call, contents } = createAgentIpcHarness(t, {
    store,
    hookServer,
    cwd: baseDir,
    agentHookEnv: (ptyId) => hookServer.envForPane(ptyId),
  });

  t.after(async () => {
    process.env.PATH = prevPath;
    contents.emit('destroyed');
    await hookServer.stop();
    rmSync(baseDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  const created = await call('shell-pty:create', {
    terminalId: 'real-codex-1',
    cliId: 'codex',
    cwd: baseDir,
  });
  assert.equal(created.ok, true);

  const deadline = Date.now() + 8_000;
  let finalStatus = null;
  while (Date.now() < deadline) {
    if (existsSync(envOutPath)) {
      const res = await call('agent:get-status', { ptyId: created.ptyId });
      if (res.status?.state === 'done' && res.status?.source === 'hook') {
        finalStatus = res.status;
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.ok(finalStatus, 'expected real PTY child to complete hook lifecycle');
  assert.equal(finalStatus.agentId, 'codex');
  assert.equal(finalStatus.message, 'Hook finished cleanly');

  const capturedEnv = JSON.parse(readFileSync(envOutPath, 'utf8'));
  assert.equal(capturedEnv.ptyId, created.ptyId);
  assert.equal(capturedEnv.port, String(hookServer.port));
  assert.equal(capturedEnv.piStatus, '1');
});
