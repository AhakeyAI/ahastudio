// Offline tests for headless Worker native questions and per-Worker policy, network, and sub-Worker controls.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { AcpSessionDriver } from '../dist-electron/agent-drivers/acp/acp-session-driver.js';
import { ACP_LAUNCH_SPECS } from '../dist-electron/agent-drivers/acp/acp-dialects.js';
import { AGENT_DRIVER_CAPABILITIES } from '../dist-electron/agent-drivers/driver-capabilities.js';
import { ahaMcpSecrets } from '../dist-electron/agent-drivers/secret-redaction.js';
import { workerApprovedMcpTools } from '../dist-electron/orchestration/codex-app-server-pilot.js';
import {
  HEADLESS_SUB_WORKER_ACTIONS, HEADLESS_WORKER_DRIVERS, ahaToolDecision, headlessWorkerControlsError,
} from '../dist-electron/orchestration/headless-workers.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';

const cwd = process.cwd();
const SESSION_A = 'agent-session-00000000-0000-0000-0000-00000000000a';

const modDir = mkdtempSync(join(tmpdir(), 'aha-hwc-ui-'));
test.after(() => rmSync(modDir, { recursive: true, force: true }));

async function loadRenderer(rel, name, rewrite = (source) => source) {
  const source = await readFile(new URL(rel, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const out = join(modDir, name);
  writeFileSync(out, rewrite(js), 'utf8');
  return import(pathToFileURL(out).href);
}

async function loadCrewModel() {
  await loadRenderer('../src/lib/git-panel-model.ts', 'git-panel-model.mjs');
  await loadRenderer('../src/lib/orchestration-view.ts', 'orchestration-view.mjs');
  return loadRenderer('../src/lib/orchestration-crew-model.ts', 'orchestration-crew-model.mjs', (source) => source
    .replace("'./git-panel-model'", "'./git-panel-model.mjs'")
    .replace("'./orchestration-view'", "'./orchestration-view.mjs'"));
}

const until = async (read, ms = 5_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await delay(10);
  }
};

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, pid: 4343,
  });
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

const ACP_INIT = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, authMethods: [] };

function grokAgent(child, onPrompt) {
  const io = wire(child, (message) => {
    if (message.method === 'initialize') io.send({ jsonrpc: '2.0', id: message.id, result: ACP_INIT });
    else if (message.method === 'session/new') io.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'grok-1' } });
    else if (message.method === 'session/prompt') void onPrompt(message, io);
    else if (message.method && message.id !== undefined) io.send({ jsonrpc: '2.0', id: message.id, result: {} });
  });
  return io;
}

const endTurn = (io, message) => io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });

let nextRequestId = 700;
/** Sends an agent-side request and resolves with the client's reply. */
function agentRequest(io, method, params) {
  const id = nextRequestId++;
  io.send({ jsonrpc: '2.0', id, method, params: { sessionId: 'grok-1', ...params } });
  return io.waitFor((sent) => sent.id === id && !sent.method).then((reply) => reply.result ?? reply.error);
}

const grokAsk = (io, question, options) => agentRequest(io, '_x.ai/ask_user_question', {
  toolCallId: `t${nextRequestId}`, questions: [{ question, options: options.map((label) => ({ label })) }],
});

async function serviceSetup(t, { confirmMode = 'auto' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aha-hwc-'));
  const agentStatusStore = new AgentStatusStore();
  const store = new OrchestrationStore({ resolveFile: () => join(dir, 'state.json') });
  const hook = new AgentHookServer(agentStatusStore);
  const sessions = new Map();
  const launches = [];
  const app = {
    confirmMode,
    // Each prompt runs this; the default ends the turn at once.
    onPrompt: async ({ message, io }) => endTurn(io, message),
  };
  const fakeLaunch = (cliId, workerId, workdir, events, options) => {
    const env = hook.envForWorker(workerId);
    const child = fakeChild();
    const launch = { cliId, workerId, cwd: workdir, options, env, child, turns: [] };
    launch.io = grokAgent(child, (message, io) => app.onPrompt({ message, io, launch }));
    launches.push(launch);
    const driver = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.grok, events, {
      acceptanceWindowMs: 500,
      mcpServers: [{ name: 'aha', command: 'node', args: ['aha-mcp-server.cjs'], env: Object.entries(env).map(([name, value]) => ({ name, value })) }],
      ahaMcp: { role: 'worker' }, secrets: ahaMcpSecrets(env),
    });
    // The fake Grok agent stands in for every CLI; record what each process and turn was asked to run with.
    const open = driver.open.bind(driver);
    driver.open = (opts) => {
      launch.open = opts;
      return open({ ...opts, policy: opts.policy === 'read-only' ? 'workspace-write' : opts.policy });
    };
    const startTurn = driver.startTurn.bind(driver);
    driver.startTurn = (turn) => {
      launch.turns.push({ policy: turn.policy, network: turn.network });
      return startTurn({ ...turn, policy: turn.policy === 'read-only' ? 'workspace-write' : turn.policy });
    };
    return driver;
  };
  const service = new OrchestrationService({
    store, agentStatusStore, getDefaultCwd: () => cwd,
    settleDelayMs: 0, turnStartObserveTimeoutMs: 250, turnStopSettleMs: 10_000,
    getConfirmMode: () => app.confirmMode,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async () => {
      throw new Error('no terminals in this test');
    },
    isPtyAlive: () => false,
    codexPilot: {
      enabled: () => false,
      launch: (workerId, workdir, events, options) => fakeLaunch('codex', workerId, workdir, events, options),
    },
    headlessWorkers: { available: () => true, launch: fakeLaunch },
  });
  service.setSessionCoordinators({
    get: (id) => sessions.get(id) ?? null,
    requestApproval: async () => true,
  });
  hook.setOrchestrationHandler((action, payload, context) => dispatchOrchestrationHttpAction(service, action, payload, context));
  await hook.start();
  t.after(async () => {
    await hook.stop();
    await service.stopCodexWorkers();
    service.dispose();
    await service.waitForPendingWrites();
    rmSync(dir, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
  });
  const call = (caller, action, payload = {}) =>
    dispatchOrchestrationHttpAction(service, action, payload, { signal: new AbortController().signal, callerPaneId: caller })
      .then((reply) => reply.body);
  const workerHttp = async (id, action, body) => {
    const env = launches.find((entry) => entry.workerId === id).env;
    const response = await fetch(env.AHA_ORCHESTRATION_URL + '/' + action, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-aha-agent-hook-token': env.AHA_AGENT_HOOK_TOKEN,
        'x-aha-worker-id': id, 'x-aha-worker-token': env.AHA_WORKER_TOKEN,
      },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  const sessionCwd = mkdtempSync(join(dir, 'session-'));
  sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'claude', active: true, idle: true, network: true, policy: 'workspace-write' });
  const delegate = (payload) => call(SESSION_A, 'delegate-task', { worktree: false, task: 'Do it', ...payload });
  return Object.assign(app, { dir, sessionCwd, service, store, hook, sessions, launches, call, workerHttp, delegate });
}

const openQuestions = (app) => app.service.getSnapshot().openNativeQuestions;
const errorOf = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  assert.fail('expected an error');
};

// --- Policy tables ---

test('controls tables: driver tiers and network, sub-Worker Aha tools, and the renderer mirror stay in step', async () => {
  for (const driver of HEADLESS_WORKER_DRIVERS) {
    const caps = AGENT_DRIVER_CAPABILITIES[driver];
    for (const policy of ['read-only', 'workspace-write', 'full-auto']) {
      assert.equal(headlessWorkerControlsError(driver, { policy }) === null, caps.policies.includes(policy), `${driver} ${policy}`);
    }
    assert.equal(headlessWorkerControlsError(driver, { network: true }) === null, caps.network, `${driver} network`);
    assert.equal(headlessWorkerControlsError(driver, { network: false }), null, 'turning network off is always allowed');
  }
  assert.match(headlessWorkerControlsError('grok', { policy: 'read-only' }), /Grok headless Workers do not support the read-only policy/);
  assert.match(headlessWorkerControlsError('antigravity', { policy: 'read-only' }), /Antigravity/);
  assert.match(headlessWorkerControlsError('claude', { network: true }), /cannot enable network access/);
  assert.equal(headlessWorkerControlsError('codex', { policy: 'full-auto', network: true }), null);

  assert.ok(!workerApprovedMcpTools({ policy: 'workspace-write' }).includes('delegate_task'));
  // The approved set is fixed at launch, so it cannot depend on a tier the person may switch later.
  assert.deepEqual(workerApprovedMcpTools({ policy: 'workspace-write' }), workerApprovedMcpTools({ policy: 'full-auto' }));
  assert.ok(workerApprovedMcpTools({ policy: 'workspace-write' }).includes('board_wait'));
  const subTools = ['list_coding_agents', 'delegate_task', 'team_status', 'team_wait', 'message_worker', 'inspect_worker_diff'];
  for (const tool of [...subTools, 'board_wait', 'report_done']) {
    assert.ok(workerApprovedMcpTools({ policy: 'workspace-write', allowSubWorkers: true }).includes(tool), tool);
  }
  for (const tool of ['integrate_worker', 'manage_worker', 'finalize_run_integration']) {
    assert.ok(!workerApprovedMcpTools({ policy: 'full-auto', allowSubWorkers: true }).includes(tool), tool);
  }
  assert.equal(ahaToolDecision('worker', 'delegate_task', 'workspace-write'), 'ask');
  assert.equal(ahaToolDecision('worker', 'delegate_task', 'full-auto'), 'deny');
  assert.equal(ahaToolDecision('worker', 'delegate_task', 'workspace-write', { allowSubWorkers: true }), 'allow');
  assert.equal(ahaToolDecision('worker', 'delegate_task', 'full-auto', { allowSubWorkers: true }), 'allow');
  assert.equal(ahaToolDecision('worker', 'integrate_worker', 'workspace-write', { allowSubWorkers: true }), 'ask', 'only sub-Worker tools open up');
  assert.deepEqual([...HEADLESS_SUB_WORKER_ACTIONS].sort(), ['agents', 'delegate-task', 'role-message'],
    'nothing destructive (stop, abandon, integrate) opens up to a Worker');

  // The MCP server lists the same sub-Worker tools, and only to a Worker that may delegate.
  const require = createRequire(import.meta.url);
  const { buildToolsForContext } = require('../electron/orchestration/aha-mcp-server.cjs');
  const names = (ctx) => buildToolsForContext(ctx).map((tool) => tool.name);
  const plainTools = names({ role: 'worker', canDelegate: false, confirmMode: 'always-ui', roster: [] });
  for (const tool of subTools) assert.ok(!plainTools.includes(tool), tool);
  const leadTools = names({ role: 'worker', canDelegate: true, confirmMode: 'always-ui', roster: [] });
  for (const tool of subTools) assert.ok(leadTools.includes(tool), tool);
  for (const tool of ['integrate_worker', 'manage_worker', 'finalize_run_integration']) assert.ok(!leadTools.includes(tool), tool);
  const delegateTool = buildToolsForContext({ role: 'worker', canDelegate: true, confirmMode: 'always-ui', roster: [] })
    .find((tool) => tool.name === 'delegate_task');
  assert.match(delegateTool.description, /waits for the user to approve/);
  assert.doesNotMatch(delegateTool.description, /confirmed=false/);

  const caps = await loadRenderer('../src/lib/session-capabilities.ts', 'session-capabilities.mjs');
  for (const driver of HEADLESS_WORKER_DRIVERS) {
    assert.deepEqual(caps.headlessWorkerControls(driver), {
      policies: AGENT_DRIVER_CAPABILITIES[driver].policies, network: AGENT_DRIVER_CAPABILITIES[driver].network,
    }, `renderer mirror for ${driver}`);
  }
  for (const driver of ['opencode', 'pi', null, 'unknown']) assert.equal(caps.headlessWorkerControls(driver), null, String(driver));

  const proposal = { taskKind: null, policy: null, network: null, allowSubWorkers: null, coordinatorPaneId: SESSION_A };
  assert.deepEqual(caps.proposalControlsDefault(proposal), { policy: 'workspace-write', network: false, allowSubWorkers: false });
  assert.equal(caps.proposalControlsDefault({ ...proposal, taskKind: 'research' }).policy, 'read-only');
  assert.equal(caps.proposalControlOptions(proposal, 'pi', []), null, 'terminal-only drivers have no controls');
  assert.deepEqual(caps.proposalControlOptions({ ...proposal, taskKind: 'review' }, 'codex', []),
    { policies: ['read-only'], network: false, subWorkers: false, locked: true });
  assert.deepEqual(caps.proposalControlOptions({ ...proposal, taskKind: 'research' }, 'grok', []).policies,
    ['read-only', 'workspace-write', 'full-auto'], 'an implied tier the driver lacks stays listed');
  const fromWorker = [{ assigneeHandle: 'grok-worker-x', assigneePaneId: null }];
  assert.equal(caps.proposalControlOptions({ ...proposal, coordinatorPaneId: 'grok-worker-x' }, 'codex', fromWorker).subWorkers, false,
    'a Worker\u2019s proposal cannot grant sub-Workers');

  const draft = { policy: 'workspace-write', network: false, allowSubWorkers: false };
  assert.deepEqual(caps.proposalControlOverrides(proposal, 'codex', draft, []), {}, 'nothing changed, nothing sent');
  assert.deepEqual(caps.proposalControlOverrides(proposal, 'codex', { policy: 'full-auto', network: true, allowSubWorkers: true }, []),
    { policy: 'full-auto', network: true, allowSubWorkers: true });
  assert.deepEqual(caps.proposalControlOverrides({ ...proposal, network: true }, 'grok', { ...draft, network: true }, []),
    { network: false }, 'a driver without network drops the Coordinator\u2019s request');
  assert.deepEqual(caps.proposalControlOverrides({ ...proposal, taskKind: 'research' }, 'grok', { ...draft, policy: 'read-only' }, []), {});
  assert.deepEqual(caps.proposalControlOverrides({ ...proposal, taskKind: 'review' }, 'codex', { policy: 'full-auto', network: true, allowSubWorkers: true }, []),
    {}, 'review proposals stay locked');
  assert.deepEqual(caps.proposalControlOverrides({ ...proposal, coordinatorPaneId: 'grok-worker-x' }, 'codex', { ...draft, allowSubWorkers: true }, fromWorker), {});
  assert.deepEqual(caps.proposalControlOptions({ ...proposal, policy: 'read-only' }, 'grok', []).policies,
    ['workspace-write', 'full-auto'], 'an explicit tier the driver lacks is not offered');

  // Switching the agent on a card clamps what the new driver cannot run.
  const wide = { policy: 'read-only', network: true, allowSubWorkers: true };
  assert.deepEqual(caps.proposalDraftForAgent(proposal, 'codex', wide, []), wide);
  assert.deepEqual(caps.proposalDraftForAgent(proposal, 'grok', wide, []), { policy: 'workspace-write', network: false, allowSubWorkers: true });
  assert.deepEqual(caps.proposalDraftForAgent(proposal, 'pi', wide, []), wide, 'terminal drivers keep the draft untouched');
  assert.deepEqual(caps.proposalControlOverrides(proposal, 'grok', wide, []), { allowSubWorkers: true },
    'a clamped draft sends nothing the driver would refuse');
  assert.deepEqual(caps.proposalControlOverrides({ ...proposal, network: true }, 'antigravity', { ...wide, policy: 'workspace-write' }, []),
    { network: false, allowSubWorkers: true });
});

// --- Native questions ---

test('native questions: a Grok Worker question is held, redacted, validated, answered, skipped, and multi-select forms round-trip', async (t) => {
  const app = await serviceSetup(t);
  const replies = [];
  app.onPrompt = async ({ message, io, launch }) => {
    const token = launch.env.AHA_WORKER_TOKEN;
    replies.push(await grokAsk(io, `Which DB for ${token}?`, ['Postgres', 'SQLite']));
    replies.push(await grokAsk(io, 'Skip me?', ['Yes']));
    replies.push(await agentRequest(io, 'elicitation/create', {
      mode: 'form', message: 'Pick',
      requestedSchema: {
        type: 'object', required: ['langs', 'tier'],
        properties: {
          langs: { type: 'array', title: 'Languages', items: { anyOf: [{ const: 'ts', title: 'TypeScript' }, { const: 'rs', title: 'Rust' }] } },
          tier: { type: 'string', title: 'Tier', oneOf: [{ const: 'a', title: 'Alpha' }, { const: 'b', title: 'Beta' }] },
        },
      },
    }));
    endTurn(io, message);
  };
  const started = await app.delegate({ role: 'asker', agent: 'grok' });
  assert.equal(started.ok, true, started.error);
  const { dispatch } = started.result;
  const [launch] = app.launches;
  const token = launch.env.AHA_WORKER_TOKEN;

  const first = await until(() => openQuestions(app)[0]);
  assert.equal(first.provider, 'grok');
  assert.equal(first.method, '_x.ai/ask_user_question');
  assert.equal(first.dispatchId, dispatch.id);
  assert.equal(first.workerHandle, dispatch.assigneeHandle);
  assert.equal(first.status, 'pending');
  assert.equal(first.questions[0].prompt, 'Which DB for <redacted>?');
  assert.doesNotMatch(JSON.stringify(app.service.getSnapshot()), new RegExp(token), 'no Worker credentials in the snapshot');
  assert.equal(app.store.getDispatchContext(dispatch.id).stage, 'waiting_input');
  assert.equal(app.service.getSnapshot(started.result.run.id).openNativeQuestions.length, 1, 'scoped to the run');

  // Validation: every question needs an answer, single-select takes one, and the dispatch must match.
  assert.equal(errorOf(() => app.service.answerWorkerNativeQuestion({ id: first.requestId, answers: {} })).code, 'invalid_argument');
  assert.equal(errorOf(() => app.service.answerWorkerNativeQuestion({ id: first.requestId, answers: { q1: ['  '] } })).code, 'invalid_argument');
  assert.match(errorOf(() => app.service.answerWorkerNativeQuestion({ id: first.requestId, answers: { q1: ['Postgres', 'SQLite'] } })).message,
    /takes a single answer/);
  assert.match(errorOf(() => app.service.answerWorkerNativeQuestion({ id: first.requestId, dispatchId: 'other', answers: { q1: ['Postgres'] } })).message,
    /belongs to dispatch/);
  assert.equal(errorOf(() => app.service.answerWorkerNativeQuestion({ id: 'wq_missing', answers: null })).code, 'not_found');
  assert.equal(openQuestions(app).length, 1, 'a rejected answer leaves the question open');

  const answered = app.service.answerWorkerNativeQuestion({ id: first.requestId, dispatchId: dispatch.id, answers: { q1: ['Postgres'] } });
  assert.equal(answered.question.status, 'answered');
  assert.deepEqual(answered.question.answers, { q1: ['Postgres'] });
  assert.equal(errorOf(() => app.service.answerWorkerNativeQuestion({ id: first.requestId, answers: { q1: ['SQLite'] } })).code, 'answer_conflict');
  await until(() => replies.length === 1);
  assert.equal(replies[0].outcome, 'accepted');
  assert.deepEqual(Object.values(replies[0].answers), ['Postgres'], 'the Worker gets the answer');

  // The second question is skipped by the dispatch id alone (the only open question for it).
  const second = await until(() => openQuestions(app).find((q) => q.requestId !== first.requestId));
  assert.equal(app.store.getDispatchContext(dispatch.id).stage, 'waiting_input');
  assert.equal(app.service.answerWorkerNativeQuestion({ id: `dispatch:${dispatch.id}`, answers: null }).question.status, 'skipped');
  await until(() => replies.length === 2);
  assert.deepEqual(replies[1], { outcome: 'cancelled' });

  // ACP form arrays are multi-select; a closed single-select field refuses free text.
  const form = await until(() => openQuestions(app).find((q) => q.requestId !== second.requestId && q.requestId !== first.requestId));
  assert.equal(form.method, 'elicitation/create');
  assert.equal(form.questions[0].multiSelect, true);
  assert.equal(form.questions[1].multiSelect, undefined);
  assert.match(errorOf(() => app.service.answerWorkerNativeQuestion({ id: form.requestId, answers: { q1: ['TypeScript'], q2: ['Gamma'] } })).message,
    /is not an option/);
  app.service.answerWorkerNativeQuestion({ id: form.requestId, answers: { q1: ['TypeScript', 'Rust'], q2: ['Beta'] } });
  await until(() => replies.length === 3);
  assert.deepEqual(replies[2], { action: 'accept', content: { langs: ['ts', 'rs'], tier: 'b' } });

  await until(() => openQuestions(app).length === 0);
  const timeline = app.service.getWorkerTimeline({ dispatchId: dispatch.id });
  const notices = timeline.turns.flatMap((turn) => turn.items).filter((item) => item.kind === 'notice' && /已回答提问/.test(item.text ?? ''));
  assert.equal(notices.length, 2, 'answered (not skipped) questions leave a notice');
  assert.doesNotMatch(JSON.stringify(timeline), new RegExp(token));
  await until(() => app.store.getDispatchContext(dispatch.id).stage !== 'waiting_input');
});

test('native questions expire when the turn ends or the Worker exits, and the dispatch stage recovers', async (t) => {
  const app = await serviceSetup(t);
  const replies = [];
  let release;
  app.onPrompt = async ({ message, io }) => {
    const reply = grokAsk(io, 'Still there?', ['Yes']);
    await new Promise((resolve) => {
      release = resolve;
    });
    endTurn(io, message);
    replies.push(await reply);
  };
  const started = await app.delegate({ role: 'leaver', agent: 'grok' });
  assert.equal(started.ok, true, started.error);
  const { dispatch } = started.result;
  const question = await until(() => openQuestions(app)[0]);
  assert.equal(app.store.getDispatchContext(dispatch.id).stage, 'waiting_input');
  release();
  await until(() => openQuestions(app).length === 0);
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { outcome: 'cancelled' }, 'the agent hears the question was not answered');
  const late = errorOf(() => app.service.answerWorkerNativeQuestion({ id: question.requestId, answers: { q1: ['Yes'] } }));
  assert.equal(late.code, 'answer_conflict');
  assert.match(late.message, /expired/);
  assert.notEqual(app.store.getDispatchContext(dispatch.id).stage, 'waiting_input');

  // A Worker process that exits with a question open drops it.
  app.onPrompt = async ({ io }) => {
    void grokAsk(io, 'Before I go?', ['Yes']);
  };
  const second = await app.delegate({ role: 'crasher', agent: 'grok' });
  assert.equal(second.ok, true, second.error);
  await until(() => openQuestions(app)[0]);
  app.launches[1].child.exit(1);
  await until(() => openQuestions(app).length === 0);
});

// --- Start controls ---

test('start controls: unsupported tiers and network are refused per driver, network is clamped, and reviews stay locked', async (t) => {
  const app = await serviceSetup(t);
  const refused = [
    [{ agent: 'grok', policy: 'read-only' }, /Grok headless Workers do not support the read-only policy/],
    [{ agent: 'antigravity', policy: 'read-only' }, /Antigravity headless Workers do not support the read-only policy/],
    [{ agent: 'grok', network: true }, /Grok headless Workers cannot enable network access/],
    [{ agent: 'claude', network: true }, /Claude Code headless Workers cannot enable network access|cannot enable network access/],
    [{ agent: 'codex', taskKind: 'review', network: true }, /Review Workers stay read-only/],
    [{ agent: 'codex', taskKind: 'review', policy: 'workspace-write' }, /Review Workers stay read-only/],
    [{ agent: 'codex', taskKind: 'review', allowSubWorkers: true }, /Review Workers stay read-only/],
    [{ agent: 'codex', policy: 'full-auto' }, /cannot start a full-auto Worker on its own/],
  ];
  for (const [payload, message] of refused) {
    const reply = await app.delegate({ role: `r${app.launches.length}`, ...payload });
    assert.equal(reply.ok, false, JSON.stringify(payload));
    assert.equal(reply.code, 'operation_rejected', JSON.stringify(reply));
    assert.match(reply.error, message);
  }
  assert.equal(app.launches.length, 0, 'nothing launched for a refused control');

  // The Coordinator session has network on: Codex inherits it, Grok cannot carry it.
  const codex = await app.delegate({ role: 'net-codex', agent: 'codex' });
  assert.equal(codex.ok, true, codex.error);
  assert.deepEqual(app.launches[0].options, { policy: 'workspace-write', network: true, allowSubWorkers: false });
  await until(() => app.launches[0].turns.length === 1);
  assert.deepEqual(app.launches[0].turns[0], { policy: 'workspace-write', network: true });
  const codexRecord = app.store.getDispatchContext(codex.result.dispatch.id);
  assert.deepEqual([codexRecord.workerPolicy, codexRecord.workerNetwork], ['workspace-write', true]);
  const header = app.service.getWorkerTimeline({ dispatchId: codex.result.dispatch.id });
  assert.deepEqual([header.policy, header.network, header.readOnly], ['workspace-write', true, false]);

  const grok = await app.delegate({ role: 'net-grok', agent: 'grok' });
  assert.equal(grok.ok, true, grok.error);
  assert.equal(app.launches[1].options.network, false);
  const offline = await app.delegate({ role: 'off-codex', agent: 'codex', network: false });
  assert.equal(offline.ok, true, offline.error);
  assert.equal(app.launches[2].options.network, false, 'an explicit off wins over the session');

  // Research tasks default to read-only but may name a writable tier; Claude supports read-only.
  const research = await app.delegate({ role: 'scout', agent: 'claude', taskKind: 'research' });
  assert.equal(research.ok, true, research.error);
  assert.equal(app.launches[3].options.policy, 'read-only');
  const writer = await app.delegate({ role: 'scout-w', agent: 'claude', taskKind: 'research', policy: 'workspace-write' });
  assert.equal(writer.ok, true, writer.error);
  assert.equal(app.launches[4].options.policy, 'workspace-write');
});

test('full-auto: only the person starts one, directly or by approving a Coordinator proposal in the UI', async (t) => {
  const app = await serviceSetup(t, { confirmMode: 'always-ui' });
  const pending = app.delegate({ role: 'auto', agent: 'claude', policy: 'full-auto', network: false });
  const proposal = await until(() => app.service.getSnapshot().pendingProposals[0]);
  assert.equal(proposal.policy, 'full-auto');
  assert.equal(app.launches.length, 0, 'held until the person approves');
  app.service.approveDispatchProposal(proposal.id);
  const started = await pending;
  assert.equal(started.ok, true, started.error);
  assert.equal(app.launches[0].options.policy, 'full-auto');
  assert.equal(app.store.getDispatchContext(started.result.dispatch.id).workerPolicy, 'full-auto');

  // The person may narrow the controls when approving; an unsupported override is refused.
  const narrowed = app.delegate({ role: 'narrow', agent: 'codex', policy: 'full-auto' });
  const second = await until(() => app.service.getSnapshot().pendingProposals[0]);
  app.service.approveDispatchProposal(second.id, { policy: 'workspace-write', network: true, allowSubWorkers: true });
  const narrowedReply = await narrowed;
  assert.equal(narrowedReply.ok, true, narrowedReply.error);
  assert.deepEqual(app.launches[1].options, { policy: 'workspace-write', network: true, allowSubWorkers: true });
  assert.equal(app.store.getDispatchContext(narrowedReply.result.dispatch.id).allowSubWorkers, true);

  const bad = app.delegate({ role: 'bad', agent: 'grok' });
  const third = await until(() => app.service.getSnapshot().pendingProposals[0]);
  assert.match(errorOf(() => app.service.approveDispatchProposal(third.id, { policy: 'read-only' })).message,
    /do not support the read-only policy/);
  assert.equal(app.service.getSnapshot().pendingProposals.length, 1, 'an unsupported override leaves the card open');
  app.service.rejectDispatchProposal(third.id, 'unsupported');
  const badReply = await bad;
  assert.equal(badReply.result.status, 'rejected');
  assert.equal(app.launches.length, 2);

  // Review proposals cannot be widened at approval time.
  const review = app.delegate({ role: 'rev', agent: 'codex', taskKind: 'review' });
  const fourth = await until(() => app.service.getSnapshot().pendingProposals[0]);
  assert.equal(errorOf(() => app.service.approveDispatchProposal(fourth.id, { network: true })).code, 'operation_rejected');
  assert.equal(app.service.getSnapshot().pendingProposals.length, 1, 'still open after a refused approval');
  app.service.rejectDispatchProposal?.(fourth.id, 'done');
  await review.catch(() => {});

  // Switching the agent alone drops network the new driver cannot run; asking for it is refused while the card stays open.
  const netted = app.delegate({ role: 'net', agent: 'codex', network: true });
  const fifth = await until(() => app.service.getSnapshot().pendingProposals[0]);
  assert.match(errorOf(() => app.service.approveDispatchProposal(fifth.id, { agent: 'grok', network: true })).message,
    /cannot enable network access/);
  assert.match(errorOf(() => app.service.approveDispatchProposal(fifth.id, { agent: 'grok', policy: 'read-only' })).message,
    /do not support the read-only policy/);
  assert.equal(app.service.getSnapshot().pendingProposals.length, 1, 'still open after a refused approval');
  const launchedBefore = app.launches.length;
  app.service.approveDispatchProposal(fifth.id, { agent: 'grok' });
  const nettedReply = await netted;
  assert.equal(nettedReply.ok, true, nettedReply.error);
  assert.equal(app.launches.length, launchedBefore + 1);
  assert.equal(app.launches.at(-1).cliId, 'grok');
  assert.equal(app.launches.at(-1).options.network, false);
  // A start the person makes directly (IPC sets userInitiated) may choose full-auto.
  app.confirmMode = 'auto';
  const direct = await app.service.workerStart({
    from: SESSION_A, runId: started.result.run.id, spec: 'Direct', agent: 'grok', policy: 'full-auto', userInitiated: true, worktree: false,
  });
  assert.equal(direct.dispatch.workerPolicy, 'full-auto');
  assert.equal(app.launches.at(-1).options.policy, 'full-auto');
  await assert.rejects(app.service.workerStart({
    from: SESSION_A, runId: started.result.run.id, spec: 'Sneaky', agent: 'grok', policy: 'full-auto', worktree: false,
  }), /Only the person can start a full-auto Worker/);
});

// --- Sub-Workers ---

test('sub-Workers: only an opted-in Worker with depth left gets delegate tools and Coordinator actions', async (t) => {
  const app = await serviceSetup(t);
  const lead = await app.delegate({ role: 'lead', agent: 'grok', allowSubWorkers: true });
  assert.equal(lead.ok, true, lead.error);
  const plain = await app.delegate({ role: 'plain', agent: 'grok' });
  assert.equal(plain.ok, true, plain.error);
  const leadId = lead.result.dispatch.assigneeHandle;
  const plainId = plain.result.dispatch.assigneeHandle;
  assert.equal(app.launches[0].options.allowSubWorkers, true, 'the process is launched with sub-Worker tools');
  assert.equal(app.launches[1].options.allowSubWorkers, false);
  assert.equal(app.service.canHeadlessWorkerDelegate(leadId), true);
  assert.equal(app.service.canHeadlessWorkerDelegate(plainId), false);
  assert.equal(app.service.getMcpContextForPane(leadId).canDelegate, true);
  assert.equal(app.service.getMcpContextForPane(plainId).canDelegate, false);

  const refusedHttp = await app.workerHttp(plainId, 'delegate-task', { role: 'sub', task: 'Help', agent: 'grok', worktree: false });
  assert.equal(refusedHttp.ok, false);
  assert.match(refusedHttp.error, /unavailable to headless Workers/);

  // A sub-Worker sits at the max depth (2), so it can neither be granted nor use sub-Workers itself.
  const deep = await app.workerHttp(leadId, 'delegate-task', { role: 'sub-lead', task: 'Help', agent: 'grok', worktree: false, allowSubWorkers: true });
  assert.equal(deep.ok, false);
  assert.match(deep.error, /cannot start sub-Workers \(max depth 2\)/);
  const sub = await app.workerHttp(leadId, 'delegate-task', { role: 'sub', task: 'Help', agent: 'grok', worktree: false });
  assert.equal(sub.ok, true, sub.error);
  const subDispatch = sub.result.dispatch;
  assert.equal(subDispatch.depth, 2);
  const subId = subDispatch.assigneeHandle;
  assert.match(subId, /^grok-worker-/);
  assert.equal(app.service.canHeadlessWorkerDelegate(subId), false);
  assert.equal(app.service.getMcpContextForPane(subId).canDelegate, false);
  const agents = await app.workerHttp(leadId, 'agents', {});
  assert.equal(agents.ok, true, agents.error);
  const subTry = await app.workerHttp(subId, 'delegate-task', { role: 'subsub', task: 'Help', agent: 'grok', worktree: false });
  assert.equal(subTry.ok, false);
  assert.match(subTry.error, /unavailable to headless Workers/);
  // A sub-Worker-enabled Worker sees its sub-Workers but cannot stop, abandon, or integrate them.
  const status = await app.workerHttp(leadId, 'mcp-context', {});
  assert.equal(status.ok, true, status.error);
  const diff = await app.workerHttp(leadId, 'worker-diff', { worker: subId });
  assert.equal(diff.ok, true, diff.error);
  const siblingDiff = await app.workerHttp(plainId, 'worker-diff', { worker: subId });
  assert.equal(siblingDiff.ok, false, 'an unrelated Worker cannot inspect the sub-Worker');
  const told = await app.workerHttp(leadId, 'role-message', { role: 'sub', message: 'Keep going' });
  assert.equal(told.ok, true, told.error);
  const manage = await app.workerHttp(leadId, 'role-manage', { role: 'sub', action: 'stop', reason: 'no' });
  assert.equal(manage.ok, false, 'role-manage stays closed to Workers');
  assert.match(manage.error, /unavailable to headless Workers/);

  // Session Coordinators at depth 0 may grant it; reviews never.
  const reviewSub = await app.delegate({ role: 'rv', agent: 'codex', taskKind: 'review', allowSubWorkers: true });
  assert.equal(reviewSub.code, 'operation_rejected');
});

test('sub-Workers: under chat-and-guard a Worker\u2019s delegate waits for a UI card instead of a chat turn it cannot have', async (t) => {
  const app = await serviceSetup(t);
  const lead = await app.delegate({ role: 'lead', agent: 'grok', allowSubWorkers: true });
  assert.equal(lead.ok, true, lead.error);
  const leadId = lead.result.dispatch.assigneeHandle;
  app.confirmMode = 'chat-and-guard';
  assert.equal(app.service.getMcpContextForPane(leadId).confirmMode, 'always-ui');
  assert.equal(app.service.getMcpContextForPane(SESSION_A).confirmMode, 'chat-and-guard', 'Coordinators still confirm in chat');

  const pending = app.workerHttp(leadId, 'delegate-task', { role: 'sub', task: 'Help', agent: 'grok', worktree: false });
  const proposal = await until(() => app.service.getSnapshot().pendingProposals[0]);
  assert.equal(app.launches.length, 1, 'held until the person approves');
  app.service.approveDispatchProposal(proposal.id);
  const sub = await pending;
  assert.equal(sub.ok, true, sub.error);
  assert.equal(sub.result.dispatch.depth, 2);
  assert.equal(app.launches.length, 2);

  const declined = app.workerHttp(leadId, 'delegate-task', { role: 'sub2', task: 'More', agent: 'grok', worktree: false });
  const second = await until(() => app.service.getSnapshot().pendingProposals.find((p) => p.id !== proposal.id));
  app.service.rejectDispatchProposal(second.id, 'not now');
  const reply = await declined;
  assert.equal(reply.ok, true, reply.error);
  assert.equal(reply.result.status, 'rejected');
  assert.equal(app.launches.length, 2);

  // Even a confirmed=true call cannot skip the card.
  const sneaky = app.workerHttp(leadId, 'delegate-task', { role: 'sub3', task: 'More', agent: 'grok', worktree: false, confirmed: true });
  const third = await until(() => app.service.getSnapshot().pendingProposals[0]);
  app.service.rejectDispatchProposal(third.id, 'no');
  assert.equal((await sneaky).result.status, 'rejected');
});
// --- Live controls ---

test('live controls: a Worker between turns switches tier and network; busy, unsupported, and stopped Workers are refused', async (t) => {
  const app = await serviceSetup(t);
  const crew = await loadCrewModel();
  let pushedSnapshot = app.service.getSnapshot();
  const events = [];
  app.service.onEvent((event) => {
    events.push(event.reason);
    pushedSnapshot = event.snapshot;
  });
  const controlsFor = (dispatchId, snapshot = pushedSnapshot) => {
    const dispatch = snapshot.dispatches.find((entry) => entry.id === dispatchId);
    const entry = crew.buildCrewViewForPane(snapshot, SESSION_A).managing
      .find((member) => member.dispatch.id === dispatchId);
    return { live: dispatch.headlessLive, controls: entry.workerControls, stage: entry.stage };
  };
  let release = null;
  app.onPrompt = async ({ message, io }) => {
    if (app.holdTurns) {
      await new Promise((resolve) => {
        release = resolve;
      });
    }
    endTurn(io, message);
  };
  app.holdTurns = true;
  const grok = await app.delegate({ role: 'g', agent: 'grok' });
  assert.equal(grok.ok, true, grok.error);
  const grokDispatch = grok.result.dispatch;
  await until(() => release);
  assert.deepEqual(controlsFor(grokDispatch.id).live, { alive: true, busy: true });
  assert.equal(controlsFor(grokDispatch.id).controls.changeable, false, 'the Crew panel locks controls during a turn');
  assert.equal(errorOf(() => app.service.workerUpdateControls({ dispatchId: grokDispatch.id, policy: 'full-auto' })).code, 'worker_busy');
  app.holdTurns = false;
  release();
  await until(() => app.service.getWorkerTimeline({ dispatchId: grokDispatch.id }).turns[0]?.status !== 'running');
  await delay(50);
  assert.deepEqual(controlsFor(grokDispatch.id).live, { alive: true, busy: false });
  assert.equal(controlsFor(grokDispatch.id).controls.changeable, true, 'the Crew panel unlocks controls between turns');

  assert.equal(errorOf(() => app.service.workerUpdateControls({ dispatchId: grokDispatch.id })).code, 'invalid_argument');
  assert.match(errorOf(() => app.service.workerUpdateControls({ dispatchId: grokDispatch.id, policy: 'read-only' })).message,
    /do not support the read-only policy/);
  assert.match(errorOf(() => app.service.workerUpdateControls({ dispatchId: grokDispatch.id, network: true })).message,
    /cannot enable network access/);
  const updated = app.service.workerUpdateControls({ dispatchId: grokDispatch.id, policy: 'full-auto' });
  assert.deepEqual([updated.policy, updated.network], ['full-auto', false]);
  assert.equal(app.store.getDispatchContext(grokDispatch.id).workerPolicy, 'full-auto');
  assert.equal(app.service.getWorkerTimeline({ dispatchId: grokDispatch.id }).policy, 'full-auto');

  // Codex switches network per turn; the next turn runs with the new controls.
  const codex = await app.delegate({ role: 'c', agent: 'codex', network: false });
  assert.equal(codex.ok, true, codex.error);
  const codexLaunch = app.launches[1];
  await until(() => codexLaunch.turns.length === 1);
  await until(() => app.service.getWorkerTimeline({ dispatchId: codex.result.dispatch.id }).turns[0]?.status !== 'running');
  await delay(50);
  const codexUpdate = app.service.workerUpdateControls({ worker: codex.result.dispatch.assigneeHandle, network: true, policy: 'read-only' });
  assert.deepEqual([codexUpdate.policy, codexUpdate.network], ['read-only', true]);
  app.holdTurns = true;
  release = null;
  const message = await app.call(SESSION_A, 'role-message', { role: 'c', message: 'Next step' });
  assert.equal(message.ok, true, message.error);
  await until(() => release);
  await until(() => controlsFor(codex.result.dispatch.id).live?.busy === true);
  assert.equal(controlsFor(codex.result.dispatch.id).controls.changeable, false, 'pushed snapshot locks controls on mailbox turn');
  app.holdTurns = false;
  release();
  await until(() => codexLaunch.turns.length === 2);
  assert.deepEqual(codexLaunch.turns[1], { policy: 'read-only', network: true });

  // A stopped Worker has no live process to change, and its clean exit pushes an updated snapshot.
  events.length = 0;
  app.launches[0].child.exit(0);
  await until(() => controlsFor(grokDispatch.id).live?.alive === false);
  assert.ok(events.includes('worker:exited'));
  assert.equal(controlsFor(grokDispatch.id).controls.changeable, false, 'a dead process cannot be changed from the Crew panel');
  assert.equal(errorOf(() => app.service.workerUpdateControls({ dispatchId: grokDispatch.id, policy: 'workspace-write' })).code, 'dispatch_inactive');
});
