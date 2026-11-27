// Offline tests for the multi-driver session base: JsonlRpc, the ACP engine and its dialects, and Pi.
// ACP and Pi transcripts under tests/fixtures/orca-* are recordings from Orca (MIT).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import {
  JSON_RPC_2_ENVELOPE, JsonlRpc, JsonlRpcClosedError, JsonlRpcError, JsonlRpcWriteError, TYPED_COMMAND_ENVELOPE,
} from '../dist-electron/agent-drivers/jsonl-rpc.js';
import { AcpSessionDriver } from '../dist-electron/agent-drivers/acp/acp-session-driver.js';
import { ACP_LAUNCH_SPECS, ANTIGRAVITY_DIALECT, GROK_DIALECT } from '../dist-electron/agent-drivers/acp/acp-dialects.js';
import { acpFormQuestions } from '../dist-electron/agent-drivers/acp/acp-form-elicitation.js';
import { PiSessionDriver, piModelEfforts, piRpcArgs } from '../dist-electron/agent-drivers/pi/pi-session-driver.js';
import {
  AGENT_DRIVER_CAPABILITIES, normalizeDriverId, supportedPolicy, terminalResumeArgs,
} from '../dist-electron/agent-drivers/driver-capabilities.js';
import { DriverRegistry } from '../dist-electron/agent-drivers/driver-registry.js';
import { npmShimEntry } from '../dist-electron/agent-drivers/agent-process.js';
import { scoreWorkspacePath } from '../dist-electron/agent-drivers/workspace-file-search.js';
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

/** A child process whose stdio the test drives: the driver writes stdin, the "agent" writes stdout. */
function fakeChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 4242;
  child.exit = (code = 0) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.stdout.end();
    setImmediate(() => child.emit('close', code, null));
  };
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

/** Records what the driver writes, so the agent side can wait for a particular message. */
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
    // A reply the replay has not asked for yet waits here instead of being lost.
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
  const completed = [];
  const exits = [];
  let resolve;
  const finished = new Promise((done) => { resolve = done; });
  return {
    timeline, requests, completed, exits, finished,
    events: {
      onTurnStarted() {},
      onTimeline: (_key, event) => timeline.push(event),
      onRequest: (key, request) => {
        requests.push(request);
        return onRequest(request);
      },
      onTurnCompleted: (_key, result) => {
        completed.push(result);
        resolve(result);
      },
      onExit: (reason) => exits.push(reason),
    },
  };
}

const items = (timeline, kind) => timeline.filter((event) => event.type === 'item' && event.item.kind === kind).map((event) => event.item);
const deltaText = (timeline, kind) => timeline.filter((event) => event.type === 'delta' && event.kind === kind).map((event) => event.delta).join('');

// --- ACP fixture replay ---

const ACP_INIT = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, authMethods: [] };

/**
 * Plays an Orca ACP recording against the driver: setup calls get synthetic answers, the recorded
 * prompt is replayed with its ids rewritten, and every recorded client reply waits for the driver's own.
 */
function acpAgent(child, file, { init = ACP_INIT, sessionNew } = {}) {
  const records = file ? readFileSync(fixture('orca-acp', file), 'utf8').split('\n').filter(Boolean).map(JSON.parse) : [];
  const replies = [];
  const io = wire(child, (message) => {
    if (message.method === 'initialize') io.send({ jsonrpc: '2.0', id: message.id, result: init });
    else if (message.method === 'session/new') io.send({ jsonrpc: '2.0', id: message.id, result: sessionNew });
    else if (message.method === 'session/prompt') void replay(message.id);
    else if (message.method && message.id !== undefined) io.send({ jsonrpc: '2.0', id: message.id, result: {} });
  });
  const replay = async (promptId) => {
    const start = records.findIndex((record) => record.direction === 'out' && record.message.method === 'session/prompt');
    const recordedId = records[start].message.id;
    for (const { direction, message } of records.slice(start + 1)) {
      await tick();
      if (direction === 'in') {
        const isPromptReply = message.id === recordedId && !message.method;
        io.send(isPromptReply ? { ...message, id: promptId } : message);
        if (isPromptReply) return;
        if (message.method && message.id !== undefined) {
          replies.push(await io.waitFor((sent) => sent.id === message.id && !sent.method));
        }
      } else if (message.method === 'session/cancel') {
        await io.waitFor((sent) => sent.method === 'session/cancel');
      }
    }
  };
  return { ...io, replies };
}

const opencodeSession = (mode = 'build') => ({
  sessionId: 'session-1',
  configOptions: [
    { id: 'model', category: 'model', type: 'select', currentValue: 'opencode/big-pickle', options: [{ value: 'opencode/big-pickle', name: 'Big Pickle' }] },
    { id: 'mode', category: 'mode', type: 'select', currentValue: mode, options: [{ value: 'build', name: 'Build' }, { value: 'plan', name: 'Plan' }] },
  ],
});

async function runAcp({ file, driver = 'opencode', policy = 'workspace-write', onRequest, sessionNew = opencodeSession(), init }) {
  const child = fakeChild();
  const agent = acpAgent(child, file, { sessionNew, ...(init ? { init } : {}) });
  const rec = recorder(onRequest);
  const acp = new AcpSessionDriver(child, ACP_LAUNCH_SPECS[driver], rec.events, { acceptanceWindowMs: 200 });
  const sessionId = await acp.open({ cwd: tmpdir(), model: null, policy });
  return { child, agent, rec, acp, sessionId };
}

test('JsonlRpc frames split and CRLF lines, skips bad and oversized lines, and correlates both envelopes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const records = [];
  const diagnostics = [];
  const rpc = new JsonlRpc(input, output, JSON_RPC_2_ENVELOPE, {
    onRecord: (record) => records.push(record), onDiagnostic: (message) => diagnostics.push(message),
  }, { maxLineBytes: 160 });
  const written = [];
  createInterface({ input: output }).on('line', (line) => written.push(JSON.parse(line)));
  const call = rpc.request('initialize', { a: 1 });
  const rejected = rpc.request('session/new', {});
  await tick();
  assert.deepEqual(written[0], { jsonrpc: '2.0', id: 1, method: 'initialize', params: { a: 1 } });
  input.write('{"jsonrpc":"2.0","id":1,"res');
  input.write('ult":{"ok":true}}\r\nnot json\n');
  input.write(`{"x":"${'y'.repeat(200)}"}\n`);
  input.write('{"jsonrpc":"2.0","id":2,"error":{"code":-32000,"message":"Authentication required"}}\n{"jsonrpc":"2.0","method":"session/update","params":{}}\n');
  assert.deepEqual(await call, { ok: true });
  await assert.rejects(rejected, (error) => error instanceof JsonlRpcError && error.code === -32000);
  assert.deepEqual(records.map((record) => record.method), ['session/update'], 'only non-replies reach the driver');
  assert.ok(diagnostics.some((message) => message.includes('non-JSON')));
  assert.ok(diagnostics.some((message) => message.includes('over 160 bytes')), 'an oversized line is dropped, the stream stays open');

  const pending = rpc.request('never', {}, { timeoutMs: null });
  input.end();
  await assert.rejects(pending, (error) => error instanceof JsonlRpcClosedError);
  await assert.rejects(rpc.write({ late: true }), (error) => error instanceof JsonlRpcWriteError, 'nothing is written after close');

  // Pi's typed commands: a reply may omit its id and is matched to the oldest pending call of its command.
  const piIn = new PassThrough();
  const pi = new JsonlRpc(piIn, new PassThrough(), TYPED_COMMAND_ENVELOPE);
  const prompt = pi.request('prompt', { message: 'hi' });
  const state = pi.request('get_state');
  piIn.write('{"type":"response","command":"get_state","id":"aha-2","success":true,"data":{"isStreaming":false}}\n');
  piIn.write('{"type":"response","command":"prompt","success":false,"error":"No API key"}\n');
  assert.deepEqual(await state, { isStreaming: false });
  await assert.rejects(prompt, (error) => error instanceof JsonlRpcError && error.message === 'No API key');
  pi.close();
});

test('OpenCode tool turn: thoughts and command stream to the timeline, approval waits for the person, allow_once is chosen', async () => {
  const { rec, acp, agent } = await runAcp({ file: 'opencode-v2-tool.jsonl', onRequest: async () => ({ decision: 'accept' }) });
  assert.deepEqual(await acp.startTurn({ turnKey: 'k1', prompt: 'Run the shell tool' }), { status: 'accepted' });
  const result = await rec.finished;
  assert.equal(result.stopReason, 'completed');
  assert.equal(result.finalText, 'TOOL-OK');
  assert.equal(result.usage.inputTokens, 7667);
  assert.equal(rec.requests.length, 1);
  assert.equal(rec.requests[0].kind, 'approval');
  assert.equal(rec.requests[0].toolInput, 'printf "TOOL-OK\\n"');
  assert.deepEqual(agent.replies[0].result, { outcome: { outcome: 'selected', optionId: 'once' } });
  const command = items(rec.timeline, 'command').at(-1);
  assert.equal(command.status, 'completed');
  assert.match(items(rec.timeline, 'command').filter((item) => item.command).at(-1).command, /^printf "TOOL-OK\\n"$/,
    'the generic first title gives way to the real command');
  assert.match(deltaText(rec.timeline, 'reasoning'), /The user wants me to run the shell tool/);
  assert.equal(deltaText(rec.timeline, 'message'), 'TOOL-OK');
  await acp.close();
});

test('full-auto approves an ordinary permission by itself; read-only refuses it and switches OpenCode to plan mode', async () => {
  const auto = await runAcp({ file: 'opencode-v2-tool.jsonl', policy: 'full-auto' });
  await auto.acp.startTurn({ turnKey: 'k1', prompt: 'x' });
  await auto.rec.finished;
  assert.equal(auto.rec.requests.length, 0, 'nobody was asked');
  assert.equal(auto.agent.replies[0].result.outcome.optionId, 'once');
  await auto.acp.close();

  const readOnly = await runAcp({ file: 'opencode-v2-deny.jsonl', policy: 'read-only' });
  assert.deepEqual(
    readOnly.agent.seen.find((message) => message.method === 'session/set_config_option')?.params,
    { sessionId: 'session-1', configId: 'mode', value: 'plan' },
  );
  await readOnly.acp.startTurn({ turnKey: 'k1', prompt: 'x' });
  const result = await readOnly.rec.finished;
  assert.equal(readOnly.rec.requests.length, 0);
  assert.equal(readOnly.agent.replies[0].result.outcome.optionId, 'reject');
  assert.equal(result.stopReason, 'completed', 'the agent ending after a refusal is not the person\'s stop');
  assert.ok(rec(readOnly).some((event) => event.type === 'notice' && /只读/.test(event.text)));
  await readOnly.acp.close();
  function rec(run) { return run.rec.timeline; }
});

test('interrupt sends session/cancel and the cancelled turn ends interrupted', async () => {
  const { rec, acp, agent } = await runAcp({ file: 'opencode-v2-stop.jsonl', onRequest: async () => ({ decision: 'accept' }) });
  await acp.startTurn({ turnKey: 'k1', prompt: 'sleep' });
  await until(() => agent.replies.length === 1);
  assert.equal(await acp.interrupt(), true);
  const result = await rec.finished;
  assert.equal(result.stopReason, 'interrupted');
  assert.ok(agent.seen.some((message) => message.method === 'session/cancel'));
  await acp.close();
});

test('Antigravity retry notices become warnings instead of reply text', async () => {
  const { rec, acp } = await runAcp({
    file: 'antigravity-v1.5.9-empty-output-retries.jsonl', driver: 'antigravity',
    sessionNew: { sessionId: '9620f06b-38e2-415e-86a8-cff6775d3a80' },
  });
  await acp.startTurn({ turnKey: 'k1', prompt: 'Say hello.' });
  const result = await rec.finished;
  assert.equal(result.finalText, 'Hello from fake model.');
  assert.equal(rec.timeline.filter((event) => event.type === 'notice' && event.level === 'warning').length, 2);
  assert.doesNotMatch(deltaText(rec.timeline, 'message'), /invalid output/);
  await acp.close();
});

test('Grok: a hook-denied prompt completes with the hook reason, and its initialize fixture handshakes', async () => {
  const init = JSON.parse(readFileSync(fixture('orca-acp', 'grok-v1.0.70-initialize.jsonl'), 'utf8').split('\n')[0]).message.result;
  const { rec, acp } = await runAcp({
    file: 'grok-hook-denied.jsonl', driver: 'grok', init, sessionNew: {
      sessionId: 'session-1',
      models: { currentModelId: 'grok-4.6', availableModels: [{ modelId: 'grok-4.6', name: 'Grok 4.6' }] },
      configOptions: [{ id: 'reasoning_effort', category: 'thought_level', currentValue: 'high', options: [{ value: 'high', name: 'High' }, { value: 'low', name: 'Low' }] }],
    },
  });
  assert.equal(acp.effectiveModel, 'grok-4.6');
  assert.deepEqual(acp.models().map((model) => [model.id, model.efforts.map((effort) => effort.value), model.images]), [['grok-4.6', ['high', 'low'], true]]);
  await acp.startTurn({ turnKey: 'k1', prompt: 'BLOCKME please' });
  const result = await rec.finished;
  assert.equal(result.stopReason, 'completed');
  assert.ok(rec.timeline.some((event) => event.type === 'notice' && /Hook 拦截：QA policy/.test(event.text)));
  await acp.close();
});

test('ACP delivery: a refusal before any work is not_accepted; a disconnect after sending is unknown_acceptance', async () => {
  // Refused: the agent answers the prompt with an error before any update.
  const refusedChild = fakeChild();
  const refused = wire(refusedChild, (message) => {
    if (message.method === 'initialize') refused.send({ jsonrpc: '2.0', id: message.id, result: ACP_INIT });
    else if (message.method === 'session/new') refused.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's' } });
    else if (message.method === 'session/prompt') refused.send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'bad prompt' } });
  });
  const refusedDriver = new AcpSessionDriver(refusedChild, ACP_LAUNCH_SPECS.grok, recorder().events, { acceptanceWindowMs: 500 });
  await refusedDriver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  assert.deepEqual(await refusedDriver.startTurn({ turnKey: 'k', prompt: 'x' }), { status: 'not_accepted', reason: 'bad prompt' });
  assert.equal(refusedDriver.busy, false, 'a refused prompt leaves the session free for another');
  await refusedDriver.close();

  // Unknown: the process dies after the prompt was written and before any sign of work.
  const lostChild = fakeChild();
  const lostRec = recorder();
  const lost = wire(lostChild, (message) => {
    if (message.method === 'initialize') lost.send({ jsonrpc: '2.0', id: message.id, result: ACP_INIT });
    else if (message.method === 'session/new') lost.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's' } });
    else if (message.method === 'session/prompt') lostChild.exit(1);
  });
  const lostDriver = new AcpSessionDriver(lostChild, ACP_LAUNCH_SPECS.grok, lostRec.events, { acceptanceWindowMs: 2_000 });
  await lostDriver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  const delivery = await lostDriver.startTurn({ turnKey: 'k', prompt: 'x' });
  assert.equal(delivery.status, 'unknown_acceptance');
  await until(() => lostRec.exits.length === 1);
  assert.equal((await lostDriver.startTurn({ turnKey: 'k2', prompt: 'x' })).status, 'not_accepted', 'a dead session takes nothing');
});

test('ACP sign-in: auth_required on session/new authenticates with the dialect method once and retries', async () => {
  const child = fakeChild();
  let attempts = 0;
  const io = wire(child, (message) => {
    if (message.method === 'initialize') io.send({ jsonrpc: '2.0', id: message.id, result: { ...ACP_INIT, authMethods: [{ id: 'cached_token' }, { id: 'grok.com' }] } });
    else if (message.method === 'session/new') {
      io.send(++attempts === 1
        ? { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: 'Authentication required' } }
        : { jsonrpc: '2.0', id: message.id, result: { sessionId: 'after-auth' } });
    } else if (message.method === 'authenticate') io.send({ jsonrpc: '2.0', id: message.id, result: {} });
  });
  const driver = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.grok, recorder().events);
  assert.equal(await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' }), 'after-auth');
  assert.equal(io.seen.find((message) => message.method === 'authenticate').params.methodId, 'cached_token');
  await driver.close();
});

test('dialect requests: questions are claimed (never approved by policy) and forms map answers back to their schema', () => {
  // Antigravity's formless question arrives as an interaction_ permission.
  const claimed = ANTIGRAVITY_DIALECT.request('session/request_permission', {
    sessionId: 's', toolCall: { toolCallId: 'interaction_1', title: '用哪个方案？' },
    options: [{ optionId: 'a', name: '方案 A', kind: 'allow_once' }, { optionId: 'b', name: '方案 B', kind: 'allow_once' }],
  });
  assert.equal(claimed.kind, 'question');
  assert.deepEqual(claimed.questions[0].options.map((option) => option.label), ['方案 A', '方案 B']);
  assert.deepEqual(claimed.reply({ q1: ['方案 B'] }), { outcome: { outcome: 'selected', optionId: 'b' } });
  assert.deepEqual(claimed.reply(null), { outcome: { outcome: 'cancelled' } });
  assert.throws(() => claimed.reply({ q1: ['自由文本'] }), /offered option/);

  const form = acpFormQuestions({
    mode: 'form', message: '配置部署',
    requestedSchema: {
      properties: {
        env: { type: 'string', title: '环境', oneOf: [{ const: 'prod', title: '生产' }, { const: 'other', title: '其他' }] },
        env_other: { type: 'string' },
        confirm: { type: 'boolean', title: '确认？' },
        note: { type: 'string', title: '备注' },
      },
      required: ['confirm'],
    },
  });
  assert.deepEqual(form.questions.map((question) => [question.id, question.allowOther, question.options.length]), [
    ['q1', true, 1], ['q2', false, 2], ['q3', true, 0],
  ]);
  assert.deepEqual(form.reply({ q1: ['staging'], q2: ['是'], q3: [] }), {
    action: 'accept', content: { env: 'other', env_other: 'staging', confirm: true },
  });
  assert.throws(() => form.reply({ q1: ['生产'] }), /does not match/, 'a required field cannot be skipped');
  assert.deepEqual(form.reply(null), { action: 'cancel' });

  const grok = GROK_DIALECT.request('_x.ai/ask_user_question', {
    sessionId: 's', toolCallId: 't', questions: [{ question: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }],
  });
  assert.deepEqual(grok.reply({ q1: ['SQLite'] }), { outcome: 'accepted', answers: { 'Which DB?': 'SQLite' } });
  assert.deepEqual(grok.reply({ q1: ['MySQL please'] }), {
    outcome: 'accepted', answers: { 'Which DB?': 'Other' }, annotations: { 'Which DB?': { notes: 'MySQL please' } },
  });
});

test('a claimed question is still asked under full-auto', async () => {
  const child = fakeChild();
  let answered;
  const io = wire(child, (message) => {
    if (message.method === 'initialize') io.send({ jsonrpc: '2.0', id: message.id, result: ACP_INIT });
    else if (message.method === 'session/new') io.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 's' } });
    else if (message.method === 'session/prompt') {
      io.send({ jsonrpc: '2.0', id: 900, method: 'session/request_permission', params: {
        sessionId: 's', toolCall: { toolCallId: 'interaction_7', title: 'Pick one' },
        options: [{ optionId: 'x', name: 'X', kind: 'allow_once' }, { optionId: 'y', name: 'Y', kind: 'allow_once' }],
      } });
      void io.waitFor((sent) => sent.id === 900 && !sent.method).then((reply) => {
        answered = reply.result;
        io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
      });
    }
  });
  const rec = recorder(async () => ({ answers: { q1: ['Y'] } }));
  const driver = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.antigravity, rec.events);
  await driver.open({ cwd: tmpdir(), model: null, policy: 'full-auto' });
  await driver.startTurn({ turnKey: 'k', prompt: 'x' });
  await rec.finished;
  assert.equal(rec.requests[0].kind, 'question', 'full-auto did not answer the question by itself');
  assert.deepEqual(answered, { outcome: { outcome: 'selected', optionId: 'y' } });
  await driver.close();
});

// --- Pi fixture replay ---

function piAgent(child, file) {
  const records = readFileSync(fixture('orca-pi', file), 'utf8').split('\n').filter(Boolean).map((line) => {
    const record = JSON.parse(line);
    return { dir: record.dir, message: JSON.parse(record.raw) };
  });
  const recorded = (command) => records.find((record) => record.dir === 'out' && record.message.command === command)?.message.data;
  const state = { sessionFile: join(tmpdir(), 'pi-session.jsonl'), ...recorded('get_state'), isStreaming: false, isCompacting: false };
  const dialogReplies = [];
  const respond = (message, data, success = true) => io.send({ id: message.id, type: 'response', command: message.type, success, ...(data === undefined ? {} : { data }) });
  const io = wire(child, (message) => {
    if (message.type === 'get_state') respond(message, state);
    else if (message.type === 'get_available_models') respond(message, recorded('get_available_models') ?? { models: [] });
    else if (message.type === 'prompt') void replay(message.id);
    else if (message.type !== 'abort' && message.type !== 'extension_ui_response') respond(message);
  });
  const replay = async (promptId) => {
    const start = records.findIndex((record) => record.dir === 'in' && record.message.type === 'prompt');
    const recordedId = records[start].message.id;
    let abort = null;
    for (const { dir, message } of records.slice(start + 1)) {
      await tick();
      if (dir === 'out') {
        if (message.type === 'response') {
          if (message.id === recordedId) io.send({ ...message, id: promptId });
          else if (abort && message.id === abort.recorded) io.send({ ...message, id: abort.id });
          continue;
        }
        io.send(message);
      } else if (message.type === 'extension_ui_response') {
        dialogReplies.push(await io.waitFor((sent) => sent.type === 'extension_ui_response' && sent.id === message.id));
      } else if (message.type === 'abort') {
        abort = { recorded: message.id, id: (await io.waitFor((sent) => sent.type === 'abort')).id };
      } else {
        return;
      }
    }
  };
  return { ...io, dialogReplies };
}

async function runPi(file, onRequest, policy = 'full-auto') {
  const child = fakeChild();
  const agent = piAgent(child, file);
  const rec = recorder(onRequest);
  const pi = new PiSessionDriver(child, rec.events, { policy });
  const sessionFile = await pi.open({ cwd: tmpdir(), model: null, policy });
  return { child, agent, rec, pi, sessionFile };
}

test('Pi launch arguments: read-only gets its read tools without MCP; resume names the session file', () => {
  assert.deepEqual(piRpcArgs({ policy: 'full-auto' }), ['--mode', 'rpc']);
  assert.deepEqual(piRpcArgs({ policy: 'read-only', sessionFile: 'C:\\s\\a.jsonl' }), [
    '--mode', 'rpc', '--tools', 'read,grep,find,ls', '--no-mcp', '--session', 'C:\\s\\a.jsonl',
  ]);
  assert.deepEqual(piModelEfforts({ reasoning: true, thinkingLevelMap: { minimal: null, high: 'high', max: 'max' } }), ['off', 'high', 'max']);
  assert.deepEqual(piModelEfforts({ reasoning: false }), []);
});

test('Pi dialogs: confirm, select, input and editor all wait for the person and answer in Pi\'s own shape', async () => {
  const answers = { 'pi/select': { answers: { q1: ['Beta'] } }, 'pi/input': { answers: { q1: ['typed'] } }, 'pi/editor': { answers: { q1: ['one\nchanged line end'] } } };
  const { rec, pi, agent, sessionFile } = await runPi('dialogs.jsonl', async (request) =>
    request.kind === 'approval' ? { decision: 'accept' } : answers[request.method]);
  assert.match(sessionFile, /\.jsonl$/);
  assert.equal((await pi.startTurn({ turnKey: 'k', prompt: '/qa-dialogs' })).status, 'accepted');
  const result = await rec.finished;
  assert.equal(result.stopReason, 'completed', 'a command Pi handled itself ends the turn');
  assert.deepEqual(rec.requests.map((request) => request.method), ['pi/confirm', 'pi/select', 'pi/input', 'pi/editor']);
  assert.deepEqual(rec.requests[1].questions[0].options.map((option) => option.label), ['Alpha', 'Beta']);
  assert.deepEqual(agent.dialogReplies.map(({ id: _id, type: _type, ...reply }) => reply), [
    { confirmed: true }, { value: 'Beta' }, { value: 'typed' }, { value: 'one\nchanged line end' },
  ]);
  assert.ok(rec.timeline.some((event) => event.type === 'notice' && event.text.includes('"choice":"Beta"')), 'notify is shown, not asked');
  await pi.close();
});

test('Pi stop mid-tool: abort ends the turn interrupted and the bash call shows as a command', async () => {
  const { rec, pi, agent } = await runPi('stop-mid-tool.jsonl');
  await pi.startTurn({ turnKey: 'k', prompt: 'sleep' });
  await until(() => items(rec.timeline, 'command').length > 0);
  assert.equal(await pi.interrupt(), true);
  const result = await rec.finished;
  assert.equal(result.stopReason, 'interrupted');
  assert.match(items(rec.timeline, 'command')[0].command, /printf capture-start; sleep 20/);
  assert.ok(agent.seen.some((message) => message.type === 'abort'));
  await pi.close();
});

test('Pi delivery: a refused prompt is not_accepted; a lost reply is unknown_acceptance; a dead session takes nothing', async () => {
  const signedOut = await runPi('signed-out.jsonl');
  const refused = await signedOut.pi.startTurn({ turnKey: 'k', prompt: 'hi' });
  assert.equal(refused.status, 'not_accepted');
  assert.equal(refused.reason, 'No API key found for the selected model.', 'only Pi\'s first paragraph, without local paths');
  assert.equal(signedOut.pi.busy, false);
  await signedOut.pi.close();

  const child = fakeChild();
  const io = wire(child, (message) => {
    if (message.type === 'get_state') io.send({ id: message.id, type: 'response', command: 'get_state', success: true, data: { sessionFile: 'f.jsonl', isStreaming: false } });
    else if (message.type === 'get_available_models') io.send({ id: message.id, type: 'response', command: message.type, success: true, data: { models: [] } });
    else if (message.type === 'prompt') child.exit(1);
  });
  const rec = recorder();
  const pi = new PiSessionDriver(child, rec.events, { policy: 'full-auto' });
  await pi.open({ cwd: tmpdir(), model: null, policy: 'full-auto' });
  assert.equal((await pi.startTurn({ turnKey: 'k', prompt: 'hi' })).status, 'unknown_acceptance');
  assert.equal((await pi.startTurn({ turnKey: 'k2', prompt: 'hi' })).status, 'not_accepted');
  assert.equal((await pi.startTurn({ turnKey: 'k3', prompt: 'hi', policy: 'read-only' })).status, 'not_accepted');
});

// --- Capabilities, registry, manager ---

test('capability table: legacy providers fall back to Codex, policies never widen past what a driver enforces', () => {
  for (const legacy of [undefined, null, 'acp', 42]) assert.equal(normalizeDriverId(legacy), 'codex');
  assert.equal(normalizeDriverId('claude'), 'claude');
  assert.equal(normalizeDriverId('pi'), 'pi');
  const codex = AGENT_DRIVER_CAPABILITIES.codex;
  assert.ok(codex.goal && codex.feedback && codex.usageLimits && codex.skills && codex.plugins && codex.history && codex.orchestration && codex.network,
    'Codex keeps every capability it had');
  for (const id of ['claude', 'antigravity', 'grok', 'opencode', 'pi']) {
    const caps = AGENT_DRIVER_CAPABILITIES[id];
    assert.equal(caps.goal || caps.feedback || caps.usageLimits || caps.skills || caps.plugins || caps.history || caps.network, false, id);
    assert.equal(caps.orchestration, id === 'claude' || id === 'antigravity' || id === 'grok', `${id} orchestration`);
  }
  const claude = AGENT_DRIVER_CAPABILITIES.claude;
  assert.deepEqual(claude.policies, ['workspace-write', 'read-only', 'full-auto']);
  assert.equal(claude.policyNeedsRelaunch, false);
  assert.ok(claude.models && claude.efforts && claude.images && claude.compact && claude.rename && claude.resume && claude.terminalResume);
  assert.equal(supportedPolicy('claude', 'read-only'), 'read-only');
  assert.equal(supportedPolicy('grok', 'read-only'), 'workspace-write', 'a read-only request for a driver without it still asks');
  assert.equal(supportedPolicy('opencode', 'read-only'), 'read-only');
  assert.equal(supportedPolicy('pi', 'read-only'), 'read-only');
  assert.deepEqual(terminalResumeArgs('codex', 't1'), ['resume', 't1']);
  assert.deepEqual(terminalResumeArgs('claude', 'c-uuid-1'), ['--resume', 'c-uuid-1']);
  assert.deepEqual(terminalResumeArgs('antigravity', 'c1'), ['--conversation', 'c1']);
  assert.deepEqual(terminalResumeArgs('grok', 's1'), ['--resume', 's1']);
  assert.deepEqual(terminalResumeArgs('opencode', 's1'), ['--session', 's1']);
  assert.deepEqual(terminalResumeArgs('pi', 'C:\\pi\\s.jsonl'), ['--session', 'C:\\pi\\s.jsonl']);
  assert.equal(terminalResumeArgs('claude', '--evil'), null, 'an id cannot smuggle a flag');
  assert.equal(terminalResumeArgs('grok', '--evil'), null, 'an id cannot smuggle a flag');

  const registry = new DriverRegistry([{ id: 'codex', label: 'Codex', command: 'codex', capabilities: codex, launch: () => null }], (command) => (command === 'codex' ? 'C:/codex.cmd' : null));
  assert.deepEqual(registry.list().map((entry) => [entry.id, entry.installed]), [['codex', true]]);
  assert.equal(registry.get('acp').id, 'codex', 'a legacy provider launches Codex');
});

function fakeDriverLaunch(log) {
  return (sessionId, cwd, events, options) => {
    log.push(options);
    const driver = {
      provider: options.provider, capabilities: { resume: true, steer: false, policies: [] },
      alive: true, busy: false, closing: false, sessionId: null, latestTurnKey: null,
      async open({ resumeSessionId }) { driver.sessionId = resumeSessionId ?? `prov-${log.length}`; return driver.sessionId; },
      async startTurn({ turnKey }) {
        setImmediate(() => events.onTurnCompleted(turnKey, { turnId: 't', stopReason: 'completed', finalText: '', diff: null, usage: null, error: null }));
        return { status: 'accepted' };
      },
      async interrupt() { return false; }, async waitForIdle() { return true; }, read() { return null; },
      redactText: (text) => text,
      async close() { driver.alive = false; driver.closing = true; },
    };
    return driver;
  };
}

test('manager: legacy saved sessions load as Codex with its capabilities; other drivers get trimmed controls', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-drivers-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'agent-sessions.json');
  const timeline = { workerHandle: 'x', providerSessionId: 'thread-1', cliId: 'codex', model: null, readOnly: false, alive: false, seq: 0, turns: [] };
  writeFileSync(file, JSON.stringify({ version: 1, sessions: [{
    id: 'agent-session-00000000-0000-0000-0000-000000000001', provider: 'acp', title: 'old', cwd: dir, model: null, effort: null,
    policy: 'workspace-write', network: true, orchestration: true, providerSessionId: 'thread-1', createdAt: 1, timeline,
  }] }));
  const log = [];
  const manager = new AgentSessionManager({ launch: fakeDriverLaunch(log), storageFile: () => file, coordinatorInstructions: () => 'rules' });
  const [legacy] = manager.list();
  assert.equal(legacy.provider, 'codex');
  assert.equal(legacy.capabilities.goal, true);
  assert.equal(legacy.orchestration, true, 'a Codex coordinator stays one');
  assert.equal(legacy.handoff, null);

  const grok = await manager.create({ cwd: dir, policy: 'read-only', provider: 'grok', network: true, effort: 'high' });
  assert.equal(grok.provider, 'grok');
  assert.equal(grok.policy, 'workspace-write');
  assert.equal(grok.network, false, 'no network switch for a driver without one');
  assert.equal((await manager.send(grok.id, { text: 'x', network: true })).status, 'not_accepted');
  assert.equal(log.at(-1).provider, 'grok');
  const opencode = await manager.create({ cwd: dir, policy: 'workspace-write', provider: 'opencode' });
  assert.deepEqual(await manager.setOrchestration(opencode.id, true), { ok: false, error: '当前会话驱动不支持编排模式' });
  const agy = await manager.create({ cwd: dir, policy: 'workspace-write', provider: 'antigravity' });
  assert.deepEqual(await manager.setOrchestration(agy.id, true), { ok: true });
  await manager.dispose();
});

test('manager: Pi restarts onto the same conversation when its tool tier changes', async () => {
  const log = [];
  const manager = new AgentSessionManager({ launch: fakeDriverLaunch(log) });
  const pi = await manager.create({ cwd: tmpdir(), policy: 'workspace-write', provider: 'pi' });
  assert.equal(pi.policy, 'full-auto', 'Pi cannot ask, so it starts in its default tier');
  assert.equal((await manager.send(pi.id, { text: 'one' })).status, 'accepted');
  await until(() => manager.list()[0].status === 'idle');
  assert.equal((await manager.send(pi.id, { text: 'two', policy: 'read-only' })).status, 'accepted');
  assert.deepEqual(log.map(({ policy, resumeSessionId }) => [policy, resumeSessionId ?? null]), [
    ['full-auto', null], ['read-only', 'prov-1'],
  ]);
  assert.equal(manager.list()[0].policy, 'read-only');
  await manager.dispose();
});

test('manager: terminal handoff keeps a single writer until the terminal has exited', async () => {
  const log = [];
  const manager = new AgentSessionManager({ launch: fakeDriverLaunch(log) });
  const grok = await manager.create({ cwd: tmpdir(), policy: 'workspace-write', provider: 'grok' });
  assert.equal((await manager.handoffToTerminal(grok.id)).ok, false, 'nothing to continue before the first message');
  await manager.send(grok.id, { text: 'hello' });
  await until(() => manager.list()[0].status === 'idle');
  const handoff = await manager.handoffToTerminal(grok.id);
  assert.deepEqual(handoff, { ok: true, cliId: 'grok', args: ['--resume', 'prov-1'], cwd: tmpdir() });
  assert.equal(manager.list()[0].status, 'suspended');
  assert.equal((await manager.send(grok.id, { text: 'from here' })).status, 'not_accepted', 'the native side sends nothing meanwhile');
  assert.equal((await manager.enqueue(grok.id, { text: 'queued from here' })).ok, false, 'enqueue is also blocked while handed off');
  assert.equal((await manager.runGoal(grok.id, { type: 'show' })).ok, false, 'goal actions are blocked while handed off');
  assert.equal(manager.bindHandoff(grok.id, 'local-handoff-1'), true);
  assert.equal(manager.reclaim(grok.id, () => true).ok, false, 'a running terminal keeps the conversation');
  assert.deepEqual(manager.reclaim(grok.id, () => false), { ok: true });
  assert.equal((await manager.send(grok.id, { text: 'back' })).status, 'accepted');
  assert.equal(log.at(-1).resumeSessionId, 'prov-1', 'taking it back rejoins the same conversation');
  await manager.dispose();
});

test('helpers: npm shims run their JS entry through node; workspace search ranks file names first', () => {
  const shim = '@ECHO off\r\n"%_prog%"  "%dp0%\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js" %*\r\n';
  assert.equal(npmShimEntry('C:\\npm\\pi.cmd', () => shim), 'C:\\npm\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js');
  assert.equal(npmShimEntry('C:\\npm\\x.cmd', () => 'echo hi'), null);
  assert.equal(scoreWorkspacePath('src/lib/session-title.ts', 'session-title.ts'), 0);
  assert.equal(scoreWorkspacePath('src/lib/session-title.ts', 'session'), 1);
  assert.equal(scoreWorkspacePath('src/lib/session-title.ts', 'lib/sess'), 3);
  assert.equal(scoreWorkspacePath('src/lib/session-title.ts', 'sltt'), 4);
  assert.equal(scoreWorkspacePath('src/lib/session-title.ts', 'zzz'), null);
});

test('slash menu hides commands the driver lacks and never runs them locally', async () => {
  const bundle = await build({
    entryPoints: [join(here, '..', 'src', 'lib', 'composer-slash-commands.ts')], bundle: true, format: 'esm', write: false, platform: 'node',
  });
  const slash = await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
  const base = {
    isAtPromptStart: true, hasTurns: true, canCompact: true, hasUsageLimits: true, canHistory: true, canRename: true,
    canOrchestration: true, orchestrationOn: false, skills: [],
  };
  const commands = (ctx) => slash.buildSlashCommandItems(ctx).map((item) => item.label);
  assert.deepEqual(commands(base), ['/model', '/clear', '/history', '/rename', '/orchestration', '/compact', '/usage-limits', '/goal', '/feedback']);
  // A Grok session: compact and rename stay, everything Codex-only goes.
  assert.deepEqual(commands({
    ...base, hasUsageLimits: false, canHistory: false, canOrchestration: false, canGoal: false, canFeedback: false,
  }), ['/model', '/clear', '/rename', '/compact']);
  const local = { text: '/goal ship it', holdsOnlyText: true, hasTurns: true, hasUsageLimits: false, canHistory: false, canRename: true, canOrchestration: false };
  assert.equal(slash.runsSlashCommandLocally(local), true);
  assert.equal(slash.runsSlashCommandLocally({ ...local, canGoal: false }), false, 'a driver without /goal gets it as a prompt');
  assert.equal(slash.runsSlashCommandLocally({ ...local, text: '/model', canModel: false }), false);
});

test('ACP: prefers session/resume over session/load when both are advertised, and settles streamed segments on phase switch', async () => {
  const child = fakeChild();
  const rec = recorder();
  const methods = [];
  const io = wire(child, (message) => {
    if (message.method) methods.push(message.method);
    if (message.method === 'initialize') {
      io.send({
        jsonrpc: '2.0', id: message.id,
        result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { resume: {} } }, authMethods: [] },
      });
    } else if (message.method === 'session/resume') {
      io.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'sess-prev' } });
    } else if (message.method === 'session/prompt') {
      io.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-prev', update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking...' } } } });
      io.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-prev', update: { sessionUpdate: 'tool_call', toolCallId: 'c1', kind: 'execute', title: 'npm test', status: 'in_progress', rawInput: { command: 'npm test' } } } });
      io.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-prev', update: { sessionUpdate: 'tool_call_update', toolCallId: 'c1', status: 'completed', rawOutput: { stdout: 'ok', exitCode: 0 } } } });
      io.send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-prev', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done!' } } } });
      io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    }
  });
  const driver = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.antigravity, rec.events);
  const id = await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write', resumeSessionId: 'sess-prev' });
  assert.equal(id, 'sess-prev');
  assert.equal(methods.includes('session/resume'), true, 'should prefer session/resume to avoid replaying full history');
  assert.equal(methods.includes('session/load'), false);

  const delivery = await driver.startTurn({ turnKey: 't1', prompt: 'run tests' });
  assert.equal(delivery.status, 'accepted');
  await rec.finished;

  const thoughtClosedIndex = rec.timeline.findIndex((e) => e.type === 'item' && e.item.kind === 'reasoning' && e.item.status === 'completed');
  const firstToolIndex = rec.timeline.findIndex((e) => e.type === 'item' && e.item.kind === 'command');
  const messageClosedIndex = rec.timeline.findIndex((e) => e.type === 'item' && e.item.kind === 'message' && e.item.status === 'completed');
  assert.ok(thoughtClosedIndex >= 0 && firstToolIndex > thoughtClosedIndex, 'reasoning item must settle before tool starts');
  assert.ok(messageClosedIndex > firstToolIndex, 'streamed message item must settle on turn end');
  await driver.close();
});

test('manager: caches non-Codex models across restarts so suspended sessions can pick a model before resuming', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-model-cache-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'agent-sessions.json');
  const catalog = [
    { id: 'gemini-4-neon', model: 'gemini-4-neon', displayName: 'Gemini 4 Neon', description: '', isDefault: true, efforts: [{ value: 'high', description: '' }, { value: 'xhigh', description: '' }], defaultEffort: 'high', images: true },
    { id: 'gemini-4-carbon', model: 'gemini-4-carbon', displayName: 'Gemini 4 Carbon', description: '', isDefault: false, efforts: [{ value: 'medium', description: '' }, { value: 'high', description: '' }], defaultEffort: 'high', images: true },
  ];
  const opens = [];
  let failOpen = false;
  const launch = (_sessionId, _cwd, events, options) => {
    const driver = {
      provider: options.provider,
      capabilities: { resume: true, steer: false, policies: AGENT_DRIVER_CAPABILITIES[options.provider].policies },
      alive: true, busy: false, closing: false, sessionId: null, latestTurnKey: null,
      effectiveModel: null, effectiveEffort: null,
      models: () => catalog,
      async open(openOpts) {
        opens.push(openOpts);
        if (failOpen) throw new Error('offline');
        driver.sessionId = openOpts.resumeSessionId ?? 'agy-sess-1';
        driver.effectiveModel = openOpts.model ?? 'gemini-4-neon';
        driver.effectiveEffort = openOpts.effort ?? 'high';
        return driver.sessionId;
      },
      async startTurn({ turnKey }) {
        driver.busy = true;
        driver.latestTurnKey = turnKey;
        setImmediate(() => {
          driver.busy = false;
          events.onTurnCompleted(turnKey, { turnId: 't1', stopReason: 'completed', finalText: 'ok', diff: null, usage: null, error: null });
        });
        return { status: 'accepted' };
      },
      async interrupt() { return false; },
      async waitForIdle() { return true; },
      read() { return null; },
      redactText: (text) => text,
      async close() { driver.alive = false; driver.closing = true; },
    };
    return driver;
  };

  // 1. Live Antigravity session populates and persists the provider model cache.
  const first = new AgentSessionManager({ launch, storageFile: () => file });
  const created = await first.create({ cwd: dir, policy: 'workspace-write', provider: 'antigravity' });
  assert.equal((await first.send(created.id, { text: 'hello' })).status, 'accepted');
  await until(() => first.list()[0].status === 'idle');
  await first.dispose();

  // 2. After restart, the session is suspended (no live process) yet models() returns the cached list immediately.
  const second = new AgentSessionManager({ launch, storageFile: () => file });
  t.after(() => second.dispose());
  const [suspended] = second.list();
  assert.equal(suspended.status, 'suspended');
  assert.deepEqual(second.models(suspended.id).map((m) => m.id), ['gemini-4-neon', 'gemini-4-carbon']);

  // 3. Failed resume rolls back model/effort cleanly.
  failOpen = true;
  const failed = await second.send(suspended.id, { text: 'switch', model: 'gemini-4-carbon', effort: 'medium' });
  assert.equal(failed.status, 'not_accepted');
  assert.equal(second.list()[0].model, 'gemini-4-neon');
  assert.equal(second.list()[0].effort, 'high');

  // 4. Successful resume opens directly with the newly chosen model and effort.
  failOpen = false;
  const resumed = await second.send(suspended.id, { text: 'switch now', model: 'gemini-4-carbon', effort: 'medium' });
  assert.equal(resumed.status, 'accepted');
  assert.equal(opens.at(-1).resumeSessionId, 'agy-sess-1');
  assert.equal(opens.at(-1).model, 'gemini-4-carbon');
  assert.equal(opens.at(-1).effort, 'medium');
  await until(() => second.list()[0].status === 'idle');
  assert.equal(second.list()[0].model, 'gemini-4-carbon');
  assert.equal(second.list()[0].effort, 'medium');
});
