// Offline tests for the native Claude Code stream-json session driver.
// Fixtures under tests/fixtures/orca-claude/ are recordings from Orca (MIT).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { AGENT_DRIVER_CAPABILITIES } from '../dist-electron/agent-drivers/driver-capabilities.js';
import { agentEnvironment } from '../dist-electron/agent-drivers/agent-process.js';
import {
  buildClaudeUserContent,
  CLAUDE_CONTROL_ENVELOPE,
  CLAUDE_PARENT_SESSION_ENV_KEYS,
  claudeLaunchArgs,
  formatClaudeModelLabel,
  normalizeClaudeUsage,
  parseClaudeAskUserQuestion,
  parseClaudeModels,
} from '../dist-electron/agent-drivers/claude/claude-protocol.js';
import { ClaudeSessionDriver } from '../dist-electron/agent-drivers/claude/claude-session-driver.js';
import { JsonlRpc, JsonlRpcError } from '../dist-electron/agent-drivers/jsonl-rpc.js';
import { AgentSessionManager } from '../dist-electron/orchestration/agent-session-manager.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (...parts) => join(here, 'fixtures', ...parts);
const tick = () => new Promise((resolve) => setImmediate(resolve));
const until = async (check, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

function fakeChild({ exitOnStdinEnd = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 7777;
  child.exit = (code = 0) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.stdout.end();
    setImmediate(() => child.emit('close', code, null));
  };
  if (exitOnStdinEnd) {
    child.stdin.on('finish', () => child.exit(0));
  }
  child.kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.signalCode = 'SIGKILL';
      child.stdout.end();
      setImmediate(() => child.emit('close', null, 'SIGKILL'));
    }
    return true;
  };
  return child;
}

function wire(child, onMessage) {
  const seen = [];
  const backlog = [];
  const waiters = [];
  createInterface({ input: child.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    seen.push(message);
    const waiter = waiters.find((entry) => entry.match(message));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
      return;
    }
    backlog.push(message);
    onMessage(message);
  });
  return {
    seen,
    send: (message) => child.stdout.write(JSON.stringify(message) + '\n'),
    waitFor: (match) => {
      const early = backlog.findIndex(match);
      if (early >= 0) return Promise.resolve(backlog.splice(early, 1)[0]);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

function recorder(onRequest = async () => ({ decision: 'decline' })) {
  const timeline = [];
  const requests = [];
  const started = [];
  const completed = [];
  const exits = [];
  const order = [];
  let resolve;
  const finished = new Promise((done) => { resolve = done; });
  return {
    timeline, requests, started, completed, exits, order, finished,
    events: {
      onTurnStarted: (key) => {
        started.push(key);
        order.push('started');
      },
      onTimeline: (_key, event) => timeline.push(event),
      onRequest: (_key, request) => {
        requests.push(request);
        return onRequest(request);
      },
      onTurnCompleted: (_key, result) => {
        completed.push(result);
        order.push('completed');
        resolve(result);
      },
      onExit: (reason) => exits.push(reason),
    },
  };
}

const SAMPLE_MODELS = [
  {
    value: 'default',
    resolvedModel: 'claude-opus-4-6[1m]',
    displayName: 'Default (recommended)',
    description: 'Opus 4.6 with 1M context',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'],
  },
  {
    value: 'sonnet',
    resolvedModel: 'claude-sonnet-4-6',
    displayName: 'Sonnet',
    description: 'Sonnet 4.6',
    supportsEffort: true,
    supportedEffortLevels: ['low', 'medium', 'high'],
  },
  {
    value: 'haiku',
    resolvedModel: 'claude-haiku-4-5-20251001',
    displayName: 'Haiku',
    description: 'Fast model',
    supportsEffort: false,
  },
  {
    value: 'cc-update-required-1',
    displayName: 'Disabled',
    disabled: true,
  },
];

function controlSuccess(requestId, response = {}) {
  return { type: 'control_response', response: { subtype: 'success', request_id: requestId, response } };
}

function controlError(requestId, error, extra = {}) {
  return { type: 'control_response', response: { subtype: 'error', request_id: requestId, error, ...extra } };
}

function standardClaudeAgent(child, {
  initResponse = {
    models: SAMPLE_MODELS,
    current_permission_mode: 'default',
    capabilities: ['interrupt_receipt_v1', 'interrupt_cancel_queued_v1'],
  },
  settingsResponse = { applied: { model: 'claude-opus-4-6[1m]', effort: 'medium' } },
  onControl,
  onUser,
} = {}) {
  const io = wire(child, (msg) => {
    if (msg.type === 'control_request') {
      const sub = msg.request?.subtype;
      if (onControl && onControl(msg, io) === true) return;
      if (sub === 'initialize') io.send(controlSuccess(msg.request_id, initResponse));
      else if (sub === 'list_models') io.send(controlSuccess(msg.request_id, { models: SAMPLE_MODELS }));
      else if (sub === 'get_settings') {
        if (settingsResponse === null) io.send(controlError(msg.request_id, 'Unsupported control subtype: get_settings'));
        else io.send(controlSuccess(msg.request_id, settingsResponse));
      } else if (sub === 'set_permission_mode') io.send(controlSuccess(msg.request_id, { mode: msg.request.mode }));
      else if (sub === 'set_model') io.send(controlSuccess(msg.request_id, { model: msg.request.model }));
      else if (sub === 'apply_flag_settings') io.send(controlSuccess(msg.request_id, {}));
      else if (sub === 'rename_session') io.send(controlSuccess(msg.request_id, {}));
      else if (sub === 'interrupt') io.send(controlSuccess(msg.request_id, { still_queued: [] }));
      else io.send(controlSuccess(msg.request_id, {}));
    } else if (msg.type === 'user') {
      onUser?.(msg, io);
    }
  });
  return io;
}

const items = (timeline, kind) => timeline.filter((event) => event.type === 'item' && event.item.kind === kind).map((event) => event.item);
const deltaText = (timeline, kind) => timeline.filter((event) => event.type === 'delta' && event.kind === kind).map((event) => event.delta).join('');

// --- Pure protocol helpers ---

test('Claude launch args, parent env scrubbing, control envelope, and model parsing', async () => {
  assert.deepEqual(claudeLaunchArgs({ policy: 'workspace-write', sessionId: 'sid-1' }), [
    '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio',
    '--permission-mode', 'default', '--allow-dangerously-skip-permissions', '--session-id', 'sid-1',
  ]);
  assert.deepEqual(claudeLaunchArgs({ policy: 'read-only', resumeSessionId: 'sid-prev' }), [
    '-p', '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--replay-user-messages', '--permission-prompt-tool', 'stdio',
    '--permission-mode', 'plan', '--allow-dangerously-skip-permissions', '--resume', 'sid-prev',
  ]);
  assert.ok(claudeLaunchArgs({ policy: 'full-auto', sessionId: 'sid-2' }).includes('bypassPermissions'));

  const savedClaudeCode = process.env.CLAUDECODE;
  const savedEntrypoint = process.env.CLAUDE_CODE_ENTRYPOINT;
  try {
    process.env.CLAUDECODE = '1';
    process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
    const env = agentEnvironment({ CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1' }, CLAUDE_PARENT_SESSION_ENV_KEYS);
    assert.equal(env.CLAUDECODE, undefined);
    assert.equal(env.CLAUDE_CODE_ENTRYPOINT, undefined);
    assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, '1');
  } finally {
    if (savedClaudeCode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = savedClaudeCode;
    if (savedEntrypoint === undefined) delete process.env.CLAUDE_CODE_ENTRYPOINT;
    else process.env.CLAUDE_CODE_ENTRYPOINT = savedEntrypoint;
  }

  // Control envelope round-trip on JsonlRpc.
  const inp = new PassThrough();
  const out = new PassThrough();
  const written = [];
  createInterface({ input: out }).on('line', (line) => written.push(JSON.parse(line)));
  const rpc = new JsonlRpc(inp, out, CLAUDE_CONTROL_ENVELOPE);
  const okCall = rpc.request('set_model', { model: 'sonnet' });
  const errCall = rpc.request('set_permission_mode', { mode: 'bypassPermissions' });
  await tick();
  assert.deepEqual(written[0], { type: 'control_request', request_id: 'aha-1', request: { subtype: 'set_model', model: 'sonnet' } });
  inp.write(JSON.stringify(controlSuccess('aha-1', { model: 'claude-sonnet-4-6' })) + '\n');
  inp.write(JSON.stringify(controlError('aha-2', 'bypass disabled')) + '\n');
  assert.deepEqual(await okCall, { model: 'claude-sonnet-4-6' });
  await assert.rejects(errCall, (err) => err instanceof JsonlRpcError && err.message === 'bypass disabled');
  rpc.close();

  // Model label & catalog deduplication.
  assert.equal(formatClaudeModelLabel('claude-opus-4-6[1m]'), 'Opus 4.6 (1M)');
  assert.equal(formatClaudeModelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(formatClaudeModelLabel('DeepSeek-V4.1-Flash-1017[1m]'), 'DeepSeek-V4.1-Flash-1017[1m]');

  const models = parseClaudeModels(SAMPLE_MODELS, 'high');
  assert.deepEqual(models.map((m) => [m.id, m.displayName, m.isDefault, m.efforts.map((e) => e.value), m.defaultEffort, m.images]), [
    ['claude-sonnet-4-6', 'Sonnet', false, ['low', 'medium', 'high'], 'high', true],
    ['claude-haiku-4-5-20251001', 'Haiku', false, [], null, true],
    ['claude-opus-4-6[1m]', 'Opus 4.6 (1M)', true, ['low', 'medium', 'high', 'xhigh', 'max'], 'high', true],
  ]);

  // Proxy aliases resolving to the same model deduplicate cleanly.
  const proxyModels = parseClaudeModels([
    { value: 'default', resolvedModel: 'Custom-1[1m]', displayName: 'Default', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'opus', resolvedModel: 'Custom-1', displayName: 'Custom-1', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
    { value: 'sonnet', resolvedModel: 'Custom-1', displayName: 'Custom-1', supportsEffort: true, supportedEffortLevels: ['low', 'high'] },
  ]);
  assert.deepEqual(proxyModels.map((m) => m.id), ['Custom-1', 'Custom-1[1m]']);

  // Usage normalization includes Anthropic cache tokens in inputTokens.
  assert.deepEqual(normalizeClaudeUsage({
    input_tokens: 10, cache_creation_input_tokens: 100, cache_read_input_tokens: 500, output_tokens: 40,
  }), {
    inputTokens: 610, outputTokens: 40, totalTokens: 650, cacheReadInputTokens: 500, cacheCreationInputTokens: 100,
  });
});

// --- Orca recorded fixture replay ---

test('Orca fixture replay (fold): Bash tool calls, streamed text without duplication, and normalized usage', async () => {
  const records = readFileSync(fixture('orca-claude', 'claude-adapter-capture-fold.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const child = fakeChild();
  const io = standardClaudeAgent(child, {
    onUser: async (msg) => {
      for (const entry of records) {
        if (entry.kind !== 'frame') continue;
        await tick();
        const frame = structuredClone(entry.frame);
        if (frame.command_uuid === 'c1a5941b-1bd4-4729-8289-5a25b22ff5b2') frame.command_uuid = msg.uuid;
        if (frame.type === 'user' && frame.isReplay && frame.uuid === 'c1a5941b-1bd4-4729-8289-5a25b22ff5b2') frame.uuid = msg.uuid;
        io.send(frame);
      }
    },
  });
  const rec = recorder();
  const driver = new ClaudeSessionDriver(child, rec.events, { sessionId: '00000000-0000-4000-8000-00000000c1a0', policy: 'workspace-write' });
  const sid = await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  assert.equal(sid, '00000000-0000-4000-8000-00000000c1a0');
  assert.equal(driver.effectiveModel, 'claude-opus-4-6[1m]');
  assert.equal(driver.effectiveEffort, 'medium');

  const delivery = await driver.startTurn({ turnKey: 'k1', prompt: 'run sleep 8 twice' });
  assert.deepEqual(delivery, { status: 'accepted' });
  const result = await rec.finished;
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.finalText, 'FIRST DONE banana');
  assert.deepEqual(rec.order, ['started', 'completed']);
  assert.equal(result.usage.outputTokens, 173);
  assert.equal(result.usage.inputTokens, 6 + 17090 + 33724);
  assert.equal(deltaText(rec.timeline, 'message'), 'FIRST DONE banana');
  const messageIds = new Set(rec.timeline.filter((e) => (e.type === 'delta' && e.kind === 'message') || (e.type === 'item' && e.item.kind === 'message')).map((e) => (e.type === 'delta' ? e.id : e.item.id)));
  assert.equal(messageIds.size, 1, 'streamed text and companion assistant frame reconcile onto one timeline item');
  const commands = items(rec.timeline, 'command');
  assert.equal(commands.filter((c) => c.status === 'completed').length, 2);
  assert.equal(commands[0].command, 'sleep 8');
  await driver.close();
});

test('Orca fixture replay (auth-failed): synthetic API error fails the turn without emitting a normal assistant reply', async () => {
  const records = readFileSync(fixture('orca-claude', 'claude-lifecycle-capture-auth-failed.jsonl'), 'utf8')
    .split('\n').filter(Boolean).map(JSON.parse);
  const child = fakeChild();
  const io = standardClaudeAgent(child, {
    settingsResponse: null, // Also verify older CLIs without get_settings still open cleanly.
    onUser: async (msg) => {
      for (const entry of records) {
        if (entry.kind !== 'frame') continue;
        await tick();
        const frame = structuredClone(entry.frame);
        if (frame.command_uuid) frame.command_uuid = msg.uuid;
        io.send(frame);
      }
    },
  });
  const rec = recorder();
  const driver = new ClaudeSessionDriver(child, rec.events, { sessionId: '00000000-0000-4000-8000-00000000c1a0' });
  await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  assert.equal((await driver.startTurn({ turnKey: 'k1', prompt: 'hi' })).status, 'accepted');
  const result = await rec.finished;
  assert.equal(result.stopReason, 'failed');
  assert.match(result.error, /Not logged in/);
  assert.equal(items(rec.timeline, 'message').length, 0, 'is_api_error_message does not create a normal assistant reply');
  await driver.close();
});

// --- Streaming thinking, diffs, tools, subagents ---

test('thinking streams without duplication, Edit upgrades diff with structuredPatch, TodoWrite/MCP/WebSearch/subagents map cleanly', async () => {
  const child = fakeChild();
  const io = standardClaudeAgent(child, {
    onUser: async (msg) => {
      const sid = msg.session_id;
      const send = (frame) => io.send({ session_id: sid, parent_tool_use_id: null, ...frame });
      await tick();
      send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_1', usage: { input_tokens: 50, output_tokens: 10 } } } });
      send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Checking app.ts...' } } });
      send({ type: 'assistant', message: { id: 'msg_1', role: 'assistant', content: [{ type: 'thinking', thinking: 'Checking app.ts...' }] } });
      send({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
      send({
        type: 'assistant',
        message: {
          id: 'msg_1',
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: '/repo/app.ts', old_string: 'const x = 1;', new_string: 'const x = 2;' } },
            { type: 'tool_use', id: 'tu_write', name: 'Write', input: { file_path: '/repo/new.ts', content: 'export const ok = true;\n' } },
            { type: 'tool_use', id: 'tu_todo', name: 'TodoWrite', input: { todos: [{ content: 'Patch app.ts', status: 'completed' }, { content: 'Run tests', status: 'in_progress' }] } },
            { type: 'tool_use', id: 'tu_mcp', name: 'mcp__github__list_prs', input: { state: 'open' } },
            { type: 'tool_use', id: 'tu_web', name: 'WebSearch', input: { query: 'claude stream json' } },
            { type: 'tool_use', id: 'tu_sub', name: 'Task', input: { description: 'Inspect tests' } },
          ],
        },
      });
      // Subagent frames must not create root prose; they update parent Task progress.
      io.send({
        type: 'stream_event', session_id: sid, parent_tool_use_id: 'tu_sub',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'SUBAGENT SECRET TEXT' } },
      });
      io.send({
        type: 'assistant', session_id: sid, parent_tool_use_id: 'tu_sub',
        message: { id: 'sub_msg', role: 'assistant', content: [{ type: 'tool_use', id: 'sub_read', name: 'Read', input: { file_path: '/repo/a.test.ts' } }] },
      });
      // Tool results, including structuredPatch for Edit.
      send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_edit', content: 'Updated', is_error: false }] },
        tool_use_result: {
          filePath: '/repo/app.ts',
          structuredPatch: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-const x = 1;', '+const x = 2;'] }],
        },
      });
      send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_write', content: 'Created', is_error: false }] },
        tool_use_result: { type: 'create', filePath: '/repo/new.ts' },
      });
      send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_mcp', content: '[{"number":7}]', is_error: false }] },
      });
      send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_web', content: 'Results...', is_error: false }] },
      });
      send({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_sub', content: 'Subagent done', is_error: false }] },
      });
      send({ type: 'stream_event', event: { type: 'message_start', message: { id: 'msg_2' } } });
      send({ type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } });
      send({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'All updated.' } } });
      send({ type: 'assistant', message: { id: 'msg_2', role: 'assistant', content: [{ type: 'text', text: 'All updated.' }] } });
      send({ type: 'result', subtype: 'success', is_error: false, result: 'All updated.', usage: { input_tokens: 100, output_tokens: 25 } });
    },
  });
  const rec = recorder();
  const driver = new ClaudeSessionDriver(child, rec.events, { sessionId: 'sid-tools' });
  await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  await driver.startTurn({ turnKey: 'k1', prompt: 'edit and inspect' });
  const result = await rec.finished;
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.finalText, 'All updated.');
  assert.doesNotMatch(deltaText(rec.timeline, 'message'), /SUBAGENT SECRET TEXT/);

  // Reasoning reconciled to one id and settled completed.
  const reasoningIds = new Set(rec.timeline.filter((e) => (e.type === 'delta' && e.kind === 'reasoning') || (e.type === 'item' && e.item.kind === 'reasoning')).map((e) => (e.type === 'delta' ? e.id : e.item.id)));
  assert.equal(reasoningIds.size, 1);
  assert.equal(deltaText(rec.timeline, 'reasoning'), 'Checking app.ts...');
  assert.equal(items(rec.timeline, 'reasoning').at(-1).status, 'completed');

  // File changes carry structuredPatch hunk header on Edit and 'add' on Write.
  const editFinal = items(rec.timeline, 'file_change').filter((i) => i.id === 'tool:tu_edit').at(-1);
  assert.equal(editFinal.status, 'completed');
  assert.match(editFinal.files[0].diff, /@@ -10,1 \+10,1 @@/);
  const writeFinal = items(rec.timeline, 'file_change').filter((i) => i.id === 'tool:tu_write').at(-1);
  assert.equal(writeFinal.files[0].change, 'add');

  // Plan, MCP, WebSearch, and subagent progress.
  const plan = items(rec.timeline, 'plan').at(-1);
  assert.deepEqual(plan.steps, [
    { step: 'Patch app.ts', status: 'completed' },
    { step: 'Run tests', status: 'in_progress' },
  ]);
  const mcp = items(rec.timeline, 'tool_call').find((i) => i.id === 'tool:tu_mcp');
  assert.equal(mcp.toolType, 'mcp');
  assert.equal(mcp.server, 'github');
  assert.equal(mcp.tool, 'list_prs');
  const web = items(rec.timeline, 'tool_call').find((i) => i.id === 'tool:tu_web');
  assert.equal(web.toolType, 'search');
  assert.ok(items(rec.timeline, 'tool_call').some((i) => i.id === 'tool:tu_sub' && i.progress === '子代理调用 Read'));
  await driver.close();
});

// --- Permissions, fallback ladder, AskUserQuestion, control_cancel_request ---

test('permissions: workspace-write asks user & sanitizes ANSI; read-only denies; full-auto auto-approves except AskUserQuestion & ExitPlanMode', async () => {
  // 1. workspace-write approval accept + decline (marks file_change declined)
  const child1 = fakeChild();
  const replies1 = [];
  const io1 = standardClaudeAgent(child1, {
    onUser: async (msg) => {
      io1.send({
        type: 'assistant', session_id: msg.session_id, parent_tool_use_id: null,
        message: { id: 'm1', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_bash', name: 'Bash', input: { command: 'npm test' } }] },
      });
      io1.send({
        type: 'control_request', request_id: 'perm-1',
        request: {
          subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu_bash',
          input: { command: 'npm test' }, decision_reason: '\x1b[31mRuns tests\x1b[0m',
        },
      });
      replies1.push(await io1.waitFor((sent) => sent.type === 'control_response' && sent.response?.request_id === 'perm-1'));

      io1.send({
        type: 'assistant', session_id: msg.session_id, parent_tool_use_id: null,
        message: { id: 'm2', role: 'assistant', content: [{ type: 'tool_use', id: 'tu_edit', name: 'Edit', input: { file_path: '/repo/x.ts', old_string: 'a', new_string: 'b' } }] },
      });
      io1.send({
        type: 'control_request', request_id: 'perm-2',
        request: { subtype: 'can_use_tool', tool_name: 'Edit', tool_use_id: 'tu_edit', input: { file_path: '/repo/x.ts', old_string: 'a', new_string: 'b' } },
      });
      replies1.push(await io1.waitFor((sent) => sent.type === 'control_response' && sent.response?.request_id === 'perm-2'));
      io1.send({
        type: 'user', session_id: msg.session_id, parent_tool_use_id: null,
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_edit', content: 'Denied', is_error: true }] },
      });
      io1.send({ type: 'result', subtype: 'success', is_error: false, result: 'Done' });
    },
  });
  let askCount = 0;
  const rec1 = recorder(async () => (++askCount === 1 ? { decision: 'accept' } : { decision: 'decline' }));
  const d1 = new ClaudeSessionDriver(child1, rec1.events, { sessionId: 'sid-p1', policy: 'workspace-write' });
  await d1.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  await d1.startTurn({ turnKey: 'k1', prompt: 'run and edit' });
  await rec1.finished;
  assert.equal(rec1.requests.length, 2);
  assert.equal(rec1.requests[0].toolInput, 'npm test');
  assert.equal(rec1.requests[0].message, 'Runs tests', 'ANSI escapes stripped from decision_reason');
  assert.deepEqual(replies1[0].response.response, { behavior: 'allow', updatedInput: { command: 'npm test' }, toolUseID: 'tu_bash' });
  assert.equal(replies1[1].response.response.behavior, 'deny');
  assert.equal(items(rec1.timeline, 'file_change').at(-1).status, 'declined');
  await d1.close();

  // 2. read-only denies without asking user
  const child2 = fakeChild();
  let roReply;
  const io2 = standardClaudeAgent(child2, {
    initResponse: { models: SAMPLE_MODELS, current_permission_mode: 'plan' },
    onUser: async () => {
      io2.send({
        type: 'control_request', request_id: 'perm-ro',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu_ro', input: { command: 'rm -rf tmp' } },
      });
      roReply = await io2.waitFor((sent) => sent.type === 'control_response' && sent.response?.request_id === 'perm-ro');
      io2.send({ type: 'result', subtype: 'success', is_error: false, result: 'Read-only ok' });
    },
  });
  const rec2 = recorder();
  const d2 = new ClaudeSessionDriver(child2, rec2.events, { sessionId: 'sid-ro', policy: 'read-only' });
  await d2.open({ cwd: tmpdir(), model: null, policy: 'read-only' });
  await d2.startTurn({ turnKey: 'k1', prompt: 'delete' });
  await rec2.finished;
  assert.equal(rec2.requests.length, 0);
  assert.equal(roReply.response.response.behavior, 'deny');
  assert.ok(rec2.timeline.some((e) => e.type === 'notice' && /只读/.test(e.text)));
  await d2.close();

  // 3. full-auto bypass refusal falls back to auto -> default, auto-approves Bash, still asks ExitPlanMode & AskUserQuestion
  const child3 = fakeChild();
  const modesTried = [];
  const replies3 = [];
  const io3 = standardClaudeAgent(child3, {
    initResponse: { models: SAMPLE_MODELS, current_permission_mode: 'plan' },
    onControl: (msg, io) => {
      if (msg.request?.subtype === 'set_permission_mode') {
        modesTried.push(msg.request.mode);
        if (msg.request.mode === 'bypassPermissions') {
          io.send(controlError(msg.request_id, 'Cannot set bypassPermissions because it is disabled by settings'));
          return true;
        }
        if (msg.request.mode === 'auto') {
          io.send(controlError(msg.request_id, 'Cannot set permission mode to auto: auto mode disabled by settings'));
          return true;
        }
      }
      return false;
    },
    onUser: async () => {
      io3.send({
        type: 'control_request', request_id: 'fa-bash',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu_1', input: { command: 'echo ok' } },
      });
      replies3.push(await io3.waitFor((sent) => sent.type === 'control_response' && sent.response?.request_id === 'fa-bash'));

      io3.send({
        type: 'control_request', request_id: 'fa-plan',
        request: { subtype: 'can_use_tool', tool_name: 'ExitPlanMode', tool_use_id: 'tu_2', input: { plan: '1. Refactor' } },
      });
      replies3.push(await io3.waitFor((sent) => sent.type === 'control_response' && sent.response?.request_id === 'fa-plan'));

      io3.send({
        type: 'control_request', request_id: 'fa-ask',
        request: {
          subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tu_3',
          input: {
            questions: [
              { header: 'DB', question: 'Which DB?', multiSelect: false, options: [{ label: 'Postgres', description: 'SQL' }, { label: 'SQLite', description: 'Embedded' }] },
              { header: 'Features', question: 'Which features?', multiSelect: true, options: [{ label: 'Auth', description: '' }, { label: 'Cache', description: '' }] },
            ],
          },
        },
      });
      replies3.push(await io3.waitFor((sent) => sent.type === 'control_response' && sent.response?.request_id === 'fa-ask'));
      io3.send({ type: 'result', subtype: 'success', is_error: false, result: 'All done' });
    },
  });
  const rec3 = recorder(async (req) => {
    if (req.kind === 'approval') return { decision: 'accept' };
    return { answers: { q1: ['SQLite'], q2: ['Auth', 'Cache'] } };
  });
  const d3 = new ClaudeSessionDriver(child3, rec3.events, { sessionId: 'sid-fa', policy: 'full-auto' });
  await d3.open({ cwd: tmpdir(), model: null, policy: 'full-auto' });
  assert.deepEqual(modesTried, ['bypassPermissions', 'auto', 'default']);
  await d3.startTurn({ turnKey: 'k1', prompt: 'go' });
  await rec3.finished;
  assert.equal(rec3.requests.length, 2, 'Bash auto-approved; ExitPlanMode and AskUserQuestion asked user');
  assert.equal(rec3.requests[0].kind, 'approval');
  assert.equal(rec3.requests[0].toolInput, '1. Refactor');
  assert.equal(rec3.requests[1].kind, 'question');
  assert.equal(rec3.requests[1].questions[1].multiSelect, true);
  assert.equal(replies3[0].response.response.behavior, 'allow');
  assert.equal(replies3[1].response.response.behavior, 'allow');
  assert.deepEqual(replies3[2].response.response, {
    behavior: 'allow',
    toolUseID: 'tu_3',
    updatedInput: {
      questions: [
        { header: 'DB', question: 'Which DB?', multiSelect: false, options: [{ label: 'Postgres', description: 'SQL' }, { label: 'SQLite', description: 'Embedded' }] },
        { header: 'Features', question: 'Which features?', multiSelect: true, options: [{ label: 'Auth', description: '' }, { label: 'Cache', description: '' }] },
      ],
      answers: {
        'Which DB?': 'SQLite',
        'Which features?': 'Auth, Cache',
      },
    },
  });
  await d3.close();

  // AskUserQuestion dismissal produces deny.
  const parsed = parseClaudeAskUserQuestion({
    questions: [{ header: 'Env', question: 'Target?', options: [{ label: 'Prod', description: '' }] }],
  });
  assert.equal(parsed.reply(null, 'tu_dismiss').behavior, 'deny');
});

test('control_cancel_request aborts in-flight prompt signal and sends no control_response', async () => {
  const child = fakeChild();
  let observedSignal;
  const io = standardClaudeAgent(child, {
    onUser: async () => {
      io.send({
        type: 'control_request', request_id: 'cancel-me',
        request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 'tu_c', input: { command: 'sleep 9' } },
      });
      await until(() => observedSignal !== undefined);
      io.send({ type: 'control_cancel_request', request_id: 'cancel-me' });
      await tick();
      io.send({ type: 'result', subtype: 'success', is_error: false, terminal_reason: 'aborted_tools', result: '' });
    },
  });
  const rec = recorder((req) => new Promise(() => { observedSignal = req.signal; }));
  const driver = new ClaudeSessionDriver(child, rec.events, { sessionId: 'sid-cancel' });
  await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  await driver.startTurn({ turnKey: 'k1', prompt: 'sleep' });
  const result = await rec.finished;
  assert.equal(observedSignal.aborted, true);
  assert.equal(result.stopReason, 'interrupted');
  assert.equal(io.seen.some((m) => m.type === 'control_response' && m.response?.request_id === 'cancel-me'), false);
  await driver.close();
});

// --- Model/effort switching, images, /compact, interrupt, rename, delivery ---

test('model switch, effort switch, image attachments, /compact, interrupt, and rename', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-claude-img-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const pngPath = join(dir, 'shot.png');
  const txtPath = join(dir, 'notes.txt');
  const emptyPng = join(dir, 'empty.png');
  writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(txtPath, 'hello');
  writeFileSync(emptyPng, Buffer.alloc(0));

  // Image block precedes the trailing text block.
  const blocks = buildClaudeUserContent('Inspect this', [
    { type: 'localImage', path: pngPath, name: 'shot.png' },
    { type: 'file', path: txtPath, name: 'notes.txt' },
  ]);
  assert.equal(blocks[0].type, 'image');
  assert.equal(blocks[0].source.media_type, 'image/png');
  assert.equal(blocks[1].type, 'text');
  assert.match(blocks[1].text, /^Inspect this[\s\S]*shot\.png[\s\S]*notes\.txt/);
  assert.throws(() => buildClaudeUserContent('hi', [{ type: 'localImage', path: emptyPng }]), /空的/);

  const child = fakeChild();
  let turnIndex = 0;
  const io = standardClaudeAgent(child, {
    onUser: async (msg) => {
      turnIndex += 1;
      await tick();
      if (turnIndex === 1) {
        io.send({ type: 'user', uuid: msg.uuid, isReplay: true, message: msg.message });
        io.send({ type: 'result', subtype: 'success', is_error: false, result: 'OK1' });
      } else if (turnIndex === 2) {
        // /compact sequence
        io.send({ type: 'system', subtype: 'status', status: 'compacting' });
        io.send({ type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 13576, post_tokens: 1011 } });
        io.send({ type: 'user', isSynthetic: true, message: { role: 'user', content: 'Continued summary' } });
        io.send({ type: 'result', subtype: 'success', is_error: false, result: '' });
      } else if (turnIndex === 3) {
        // Wait for interrupt control_request and reply with receipt before aborted result.
        io.send({ type: 'system', subtype: 'status', status: 'requesting' });
        const interruptReq = await io.waitFor((sent) => sent.type === 'control_request' && sent.request?.subtype === 'interrupt');
        io.send(controlSuccess(interruptReq.request_id, { still_queued: [], cancelled: [] }));
        io.send({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'Aborted' });
      }
    },
  });

  const timeline = [];
  const completed = [];
  let waitDone;
  const nextDone = () => new Promise((resolve) => { waitDone = resolve; });
  const driver = new ClaudeSessionDriver(child, {
    onTurnStarted() {},
    onTimeline: (_k, e) => timeline.push(e),
    onRequest: async () => ({ decision: 'decline' }),
    onTurnCompleted: (_k, res) => { completed.push(res); waitDone?.(res); },
    onExit() {},
  }, { sessionId: 'sid-ops' });
  await driver.open({ cwd: dir, model: null, policy: 'workspace-write' });

  // Unsupported effort is refused pre-send (not_accepted) without mutating the active model.
  const badEffort = await driver.startTurn({ turnKey: 'bad', prompt: 'hi', model: 'claude-sonnet-4-6', effort: 'max' });
  assert.equal(badEffort.status, 'not_accepted');
  assert.equal(driver.busy, false);
  assert.equal(driver.effectiveModel, 'claude-opus-4-6[1m]');

  // Turn 1: switch effort to high + attach image.
  const p1 = nextDone();
  assert.equal((await driver.startTurn({
    turnKey: 'k1', prompt: 'check image', effort: 'high',
    attachments: [{ type: 'localImage', path: pngPath, name: 'shot.png' }],
  })).status, 'accepted');
  await p1;
  assert.ok(io.seen.some((m) => m.type === 'control_request' && m.request?.subtype === 'apply_flag_settings' && m.request?.settings?.effortLevel === 'high'));
  const userMsg1 = io.seen.find((m) => m.type === 'user');
  assert.equal(userMsg1.message.content[0].type, 'image');
  assert.equal(userMsg1.message.content[1].type, 'text');

  // Turn 2: /compact.
  const p2 = nextDone();
  assert.equal((await driver.compactThread('k2')).status, 'accepted');
  assert.equal((await p2).stopReason, 'completed');
  assert.ok(timeline.some((e) => e.type === 'notice' && e.text.includes('13,576') && e.text.includes('1,011')));

  // Turn 3: interrupt sends cancel_queued: true when advertised.
  const p3 = nextDone();
  assert.equal((await driver.startTurn({ turnKey: 'k3', prompt: 'long work' })).status, 'accepted');
  assert.equal(await driver.interrupt(), true);
  assert.equal((await p3).stopReason, 'interrupted');
  assert.ok(io.seen.some((m) => m.type === 'control_request' && m.request?.subtype === 'interrupt' && m.request?.cancel_queued === true));

  // Rename sends rename_session with source: 'host'.
  assert.equal(await driver.setName('Fix login bug'), true);
  assert.ok(io.seen.some((m) => m.type === 'control_request' && m.request?.subtype === 'rename_session' && m.request?.title === 'Fix login bug' && m.request?.source === 'host'));
  await driver.close();
});

test('delivery safety: disconnect after write before evidence is unknown_acceptance; dead session returns not_accepted', async () => {
  const child = fakeChild();
  standardClaudeAgent(child, {
    onUser: () => { child.exit(1); },
  });
  const rec = recorder();
  const driver = new ClaudeSessionDriver(child, rec.events, { sessionId: 'sid-lost', acceptanceWindowMs: 2_000 });
  await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  const delivery = await driver.startTurn({ turnKey: 'k1', prompt: 'hello' });
  assert.equal(delivery.status, 'unknown_acceptance');
  await until(() => rec.exits.length === 1);
  assert.equal((await driver.startTurn({ turnKey: 'k2', prompt: 'again' })).status, 'not_accepted');
});

// --- AgentSessionManager integration ---

test('AgentSessionManager: Claude session switches policy live, saves/restores as claude, hands off with --resume, and clears cancelled questions', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-claude-mgr-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const storageFile = join(dir, 'agent-sessions.json');

  const launches = [];
  let activeCancel;
  const launch = (_sessionId, _cwd, events, options) => {
    const child = fakeChild();
    launches.push(options);
    const sid = options.resumeSessionId ?? `claude-sid-${launches.length}`;
    const io = standardClaudeAgent(child, {
      onUser: async (msg) => {
        const text = msg.message.content.at(-1)?.text ?? '';
        if (text === 'ask-then-cancel') {
          io.send({
            type: 'control_request', request_id: 'q-cancel',
            request: {
              subtype: 'can_use_tool', tool_name: 'AskUserQuestion', tool_use_id: 'tu_qc',
              input: { questions: [{ header: 'H', question: 'Pick?', options: [{ label: 'A', description: '' }] }] },
            },
          });
          activeCancel = () => {
            io.send({ type: 'control_cancel_request', request_id: 'q-cancel' });
            io.send({ type: 'result', subtype: 'success', is_error: false, result: 'Moved on' });
          };
          return;
        }
        io.send({ type: 'result', subtype: 'success', is_error: false, result: `Echo: ${text}` });
      },
    });
    return new ClaudeSessionDriver(child, events, { sessionId: sid, policy: options.policy });
  };

  const manager = new AgentSessionManager({ launch, storageFile: () => storageFile });
  const session = await manager.create({ cwd: dir, policy: 'workspace-write', provider: 'claude' });
  assert.equal(session.provider, 'claude');
  assert.equal(session.policy, 'workspace-write');
  assert.equal(session.providerSessionId, 'claude-sid-1');
  assert.equal(manager.models(session.id).length, 3);

  // Switch policy live across all three tiers without relaunching.
  assert.equal((await manager.send(session.id, { text: 'one', policy: 'read-only' })).status, 'accepted');
  await until(() => manager.list()[0].status === 'idle');
  assert.equal((await manager.send(session.id, { text: 'two', policy: 'full-auto' })).status, 'accepted');
  await until(() => manager.list()[0].status === 'idle');
  assert.equal(launches.length, 1, 'Claude switches permission modes live without relaunching');

  // control_cancel_request clears pendingQuestions in AgentSessionManager immediately.
  assert.equal((await manager.send(session.id, { text: 'ask-then-cancel' })).status, 'accepted');
  await until(() => manager.list()[0].pendingQuestions.length === 1);
  activeCancel();
  await until(() => manager.list()[0].pendingQuestions.length === 0 && manager.list()[0].status === 'idle');

  // Terminal handoff produces `claude --resume <id>` and enforces single writer.
  const handoff = await manager.handoffToTerminal(session.id);
  assert.deepEqual(handoff, { ok: true, cliId: 'claude', args: ['--resume', 'claude-sid-1'], cwd: dir });
  assert.equal(manager.bindHandoff(session.id, 'local-handoff-claude'), true);
  assert.equal(manager.reclaim(session.id, () => true).ok, false);
  assert.deepEqual(manager.reclaim(session.id, () => false), { ok: true });
  assert.equal((await manager.send(session.id, { text: 'back from terminal' })).status, 'accepted');
  await until(() => manager.list()[0].status === 'idle');
  assert.equal(launches.at(-1).resumeSessionId, 'claude-sid-1');
  await manager.dispose();

  // Reloading from disk preserves `provider: 'claude'` and Claude capabilities.
  const restored = new AgentSessionManager({ launch, storageFile: () => storageFile });
  const [saved] = restored.list();
  assert.equal(saved.provider, 'claude');
  assert.equal(saved.capabilities.terminalResume, true);
  assert.equal(saved.capabilities.compact, true);
  assert.equal(saved.providerSessionId, 'claude-sid-1');
  await restored.dispose();
});

test('hung Claude process falls back to SIGKILL after gracefulCloseMs', async () => {
  const child = fakeChild({ exitOnStdinEnd: false });
  standardClaudeAgent(child);
  const rec = recorder();
  const driver = new ClaudeSessionDriver(child, rec.events, { sessionId: 'sid-hung', gracefulCloseMs: 25 });
  await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  await driver.close();
  assert.equal(driver.alive, false);
  assert.equal(child.signalCode, 'SIGKILL');
});

test('SessionComposer renders Claude Code provider label, multi-select hint, and capability-gated controls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-claude-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const outfile = join(dir, 'composer.cjs');
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { SessionComposer } from './src/components/agent-session/SessionComposer.tsx';
        export const render = (props) => renderToStaticMarkup(createElement(SessionComposer, props));`,
      resolveDir: join(here, '..'),
      loader: 'js',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  const render = (mod.default ?? mod).render;
  const html = render({
    alive: true,
    running: true,
    sending: false,
    interrupting: false,
    approvals: [],
    questions: [],
    branch: null,
    direct: true,
    policy: 'workspace-write',
    onPolicyChange: () => {},
    directQuestions: [{
      requestId: 'req_1',
      questions: [{
        id: 'q1',
        header: 'Features',
        prompt: 'Which features should be enabled?',
        allowOther: true,
        multiSelect: true,
        options: [{ label: 'Auth', description: '' }, { label: 'Cache', description: '' }],
      }],
    }],
    onAnswer: async () => true,
    toolbar: {
      sessionId: 'agent-session-00000000-0000-4000-8000-000000000001',
      provider: 'claude',
      capabilities: AGENT_DRIVER_CAPABILITIES.claude,
      modelId: 'claude-opus-4-6[1m]',
      effort: 'high',
      onModelChange: () => {},
      onEffortChange: () => {},
    },
    usage: null,
    onSend: async () => true,
    onInterrupt: () => {},
  });
  assert.match(html, /Claude Code 在等你的答复/);
  assert.doesNotMatch(html, /Codex 在等你的答复/);
  assert.match(html, /（可多选）/);
  assert.match(html, /只读/);
  assert.match(html, /可写 · 需确认/);
  assert.match(html, /自动/);
  assert.doesNotMatch(html, /不联网/);
});
