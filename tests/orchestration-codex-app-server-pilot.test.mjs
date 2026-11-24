import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { CodexAppServerPilot, enabledCodexPilot } from '../dist-electron/orchestration/codex-app-server-pilot.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { spawnWindowsCodexJob } from '../dist-electron/orchestration/windows-codex-job.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import {
  TIMELINE_LIMITS, WorkerTimeline, WorkerTimelinePatchCoalescer, trimTimelineSnapshot,
} from '../dist-electron/orchestration/worker-timeline.js';

const cwd = process.cwd();
const stderrSecret = 'pilot-stderr-credential-example';

function fakeCodexChild() {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, kill: () => true,
  });
  return child;
}

function recordCodexExit(exits) {
  return {
    onTurnStarted() {}, onTurnCompleted() {}, onRequest: async () => ({ decision: 'decline' }),
    onExit: (reason, code) => exits.push({ reason, code }),
  };
}

async function until(read, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  assert.fail('Expected pilot state did not appear');
}

async function setup(t, scenario = 'normal', enabled = true, { confirmMode } = {}) {
  const dir = mkdtempSync(join(cwd, '.codex-pilot-test-'));
  const trace = join(dir, 'rpc.jsonl');
  const agentStatusStore = new AgentStatusStore();
  const statePath = join(dir, 'state.json');
  const store = new OrchestrationStore({ resolveFile: () => statePath });
  const hook = new AgentHookServer(agentStatusStore);
  const workers = new Map();
  const children = [];
  const exits = [];
  const writes = [];
  const spawnCalls = [];
  let ptyStarts = 0;
  let codexStarts = 0;
  const service = new OrchestrationService({
    store, agentStatusStore, getDefaultCwd: () => cwd,
    settleDelayMs: 0, turnStartObserveTimeoutMs: 250, turnStopSettleMs: 10_000,
    ...(confirmMode ? { getConfirmMode: () => confirmMode } : {}),
    writePty: async (id, data) => {
      writes.push({ id, data });
      agentStatusStore.ingestHookEvent({ ptyId: id, agentId: 'codex', state: 'working' });
      return { ok: true };
    },
    spawnWorkerPty: async (opts) => {
      ptyStarts++;
      spawnCalls.push(opts);
      agentStatusStore.registerPane('fallback-pane', { agentId: 'codex' });
      return { ptyId: 'fallback-pane' };
    },
    isPtyAlive: (id) => id === 'fallback-pane' || id === 'coordinator-pane',
    codexPilot: {
      enabled: () => enabled,
      launch(workerId, workdir, events) {
        codexStarts++;
        workers.set(workerId, hook.envForWorker(workerId));
        const child = scenario === 'spawn-error'
          ? fakeCodexChild()
          : spawn(process.execPath, [join(cwd, 'tests/fixtures/mock-codex-app-server.mjs'), scenario, trace], {
            cwd: workdir, stdio: 'pipe', windowsHide: true,
          });
        if (scenario === 'spawn-error') {
          setImmediate(() => child.emit('error', new Error('spawn codex ENOENT')));
        }
        children.push(child);
        return new CodexAppServerPilot(child, {
          ...events,
          onExit(reason, code) {
            exits.push({ reason, code });
            events.onExit(reason, code);
          },
        }, 850, [stderrSecret]);
      },
    },
  });
  hook.setOrchestrationHandler((action, payload, context) => dispatchOrchestrationHttpAction(service, action, payload, context));
  await hook.start();
  t.after(async () => {
    await hook.stop();
    await service.stopCodexWorkers();
    service.dispose();
    await service.waitForPendingWrites();
    rmSync(dir, { force: true, recursive: true });
  });
  const { run } = service.runCreate({ from: 'coordinator-pane', paneId: 'coordinator-pane', objective: 'Test pilot' });

  const start = (spec, overrides = {}) => service.workerStart({
    runId: run.id, from: 'coordinator-pane', cliId: 'codex', spec, readOnly: true, noWorktree: true,
    ...overrides,
  });
  const getTrace = () => readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  const workerHttp = async (id, action, body, token = workers.get(id).AHA_WORKER_TOKEN) => {
    const env = workers.get(id);
    const response = await fetch(env.AHA_ORCHESTRATION_URL + '/' + action, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-aha-agent-hook-token': env.AHA_AGENT_HOOK_TOKEN,
        'x-aha-worker-id': id, 'x-aha-worker-token': token,
      },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  return {
    dir, service, store, statePath, start, run, getTrace, writes, spawnCalls, workers, workerHttp, children, exits,
    ptyStarts: () => ptyStarts, codexStarts: () => codexStarts,
  };
}

async function reportDone(env, summary) {
  const child = spawn(process.execPath, ['electron/orchestration/aha-mcp-server.cjs'], {
    env: { ...process.env, ...env }, stdio: 'pipe', windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  try {
    const answer = new Promise((resolve, reject) => {
      child.once('error', reject);
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        if (message.id === 1) resolve(message.result);
      });
      child.once('close', () => reject(new Error('MCP worker exited before responding')));
    });
    child.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'tools/call',
      params: { name: 'report_done', arguments: { outcome: 'completed', summary } },
    }) + '\n');
    return await answer;
  } finally {
    child.stdin.end();
    child.kill();
    await closed;
  }
}

test('pilot opt-in is Windows-only and inactive by default', () => {
  assert.equal(enabledCodexPilot('win32', false), false);
  assert.equal(enabledCodexPilot('win32', false, '1'), true);
  assert.equal(enabledCodexPilot('win32', true, '0'), false);
  assert.equal(enabledCodexPilot('linux', true, '1'), false);
});

test('independent Worker auth, long stdin input, pending turn and same-thread report/follow-up', async (t) => {
  const app = await setup(t);
  const spec = '第一段\n\n' + '这是只读验收数据。'.repeat(2_000) + '\n末尾唯一标记。';
  const first = await app.start(spec);
  const id = first.dispatch.assigneeHandle;
  const sessionId = first.dispatch.providerSessionId;
  assert.equal(first.ptyId, null);
  assert.equal(first.dispatch.assigneePaneId, null);
  assert.equal(first.dispatch.ownsPane, false);
  assert.equal(first.dispatch.executionMode, 'codex-app-server');
  assert.equal(app.ptyStarts(), 0);
  assert.deepEqual(app.writes, []);
  const turn = await until(() => app.store.getDispatchContext(first.dispatch.id)?.codexTurn);
  assert.equal(turn.stopReason, 'completed');
  assert.deepEqual(turn.usage, { inputTokens: 23, outputTokens: 7 });
  assert.equal(app.store.getDispatchContext(first.dispatch.id).status, 'dispatched');
  assert.equal(app.service.workerShow({ dispatchId: first.dispatch.id }).stage, 'awaiting_review');
  const submitted = app.getTrace().filter((message) => message.method === 'turn/start');
  assert.equal(submitted.length, 1);
  assert.deepEqual(submitted[0].params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
  assert.equal(submitted[0].params.approvalPolicy, 'on-request');
  const opened = app.getTrace().find((message) => message.method === 'thread/start').params;
  assert.deepEqual([opened.sandbox, opened.approvalPolicy], ['read-only', 'on-request']);
  assert.ok(submitted[0].params.input[0].text.includes(spec));
  const read = app.service.workerRead({ dispatchId: first.dispatch.id, limit: 3 });
  assert.equal(read.text, '模拟输');
  assert.equal(read.nextCursor, 3);
  assert.equal(read.hasMore, true);
  const fake = await app.workerHttp(id, 'worker-done-self', { summary: 'forged' }, 'bad-token');
  assert.equal(fake.ok, false);
  assert.equal(app.store.getDispatchContext(first.dispatch.id).status, 'dispatched');
  const actual = await reportDone(app.workers.get(id), 'authenticated MCP report');
  assert.equal(actual.isError, undefined);
  assert.equal(app.store.getDispatchContext(first.dispatch.id).status, 'completed');
  assert.equal(app.service.isPaneAlive(id), true);

  const follow = await app.service.send({
    from: 'coordinator-pane', to: 'dispatch:' + first.dispatch.id, runId: app.run.id,
    type: 'status', subject: 'Follow up', body: 'Check another readonly path',
  });
  const second = follow.followUp.dispatch;
  assert.equal(second.assigneeHandle, id);
  assert.equal(second.assigneePaneId, null);
  assert.equal(second.providerSessionId, sessionId);
  assert.equal(app.codexStarts(), 1);
  const secondTurn = await until(() => app.store.getDispatchContext(second.id)?.codexTurn);
  assert.deepEqual(secondTurn.usage, { inputTokens: 23, outputTokens: 7 });
  await app.service.waitForPendingWrites();
  const restored = new OrchestrationStore({ resolveFile: () => app.statePath });
  restored.load();
  assert.equal(restored.getDispatchContext(first.dispatch.id)?.providerSessionId, sessionId);
  assert.equal(restored.getDispatchContext(first.dispatch.id)?.archivedOutput.trim(), '模拟输出 1');
  assert.equal(app.getTrace().filter((message) => message.method === 'thread/start').length, 1);
  assert.equal(app.getTrace().filter((message) => message.method === 'turn/start').length, 2);
  assert.match(app.service.workerRead({ dispatchId: first.dispatch.id, screen: true }).text, /模拟输出 1/);
});

test('authenticated catalog discovery before dispatch exposes the Worker role only', async (t) => {
  const app = await setup(t, 'catalog-wait');
  const pending = app.start('Check catalog registration');
  const id = await until(() => app.workers.keys().next().value);
  const catalogContext = await app.workerHttp(id, 'mcp-context', {});
  assert.equal(catalogContext.result.role, 'worker');
  assert.equal(catalogContext.result.canDelegate, false);
  assert.equal(catalogContext.result.activeDispatch, null);
  const premature = await app.workerHttp(id, 'worker-done-self', { summary: 'not yet assigned' });
  assert.equal(premature.ok, false);
  await pending;
});

test('Codex MCP form confirmation uses the Coordinator approval response', async (t) => {
  const app = await setup(t);
  const { dispatch } = await app.start('ASK_FOR_MCP_CONFIRMATION');
  const approval = await until(() => app.service.workerShow({ dispatchId: dispatch.id }).openApprovals[0]);
  assert.equal(approval.eventName, 'mcpServer/elicitation/request');
  assert.equal(JSON.parse(approval.toolInput).server, 'aha');
  app.service.approve({ id: approval.approvalId }, 'coordinator-pane');
  const turn = await until(() => app.store.getDispatchContext(dispatch.id)?.codexTurn);
  assert.equal(turn.finalText, 'approval decision: accept');
  assert.deepEqual(app.getTrace().find((message) => message.id === 'mcp-approval-1').result,
    { action: 'accept', content: {}, _meta: null });
});

test('spawn error without close releases the session and falls back once', { timeout: 6_000 }, async (t) => {
  const app = await setup(t, 'spawn-error');
  const result = await app.start('Launch after ENOENT');
  assert.equal(result.ptyId, 'fallback-pane');
  assert.equal(app.ptyStarts(), 1);
  assert.equal(app.service.hasCodexWorkers(), false);
  assert.match(app.exits[0].reason, /ENOENT/);
});

test('close reuses a bounded wait when neither child error nor close arrives', { timeout: 7_000 }, async () => {
  const child = fakeCodexChild();
  child.pid = 1;
  const exits = [];
  let signals = 0;
  child.kill = (signal) => {
    assert.equal(signal, 'SIGKILL');
    signals++;
    return true;
  };
  const session = new CodexAppServerPilot(child, recordCodexExit(exits));
  const closing = session.close();
  assert.equal(session.close(true), closing);
  await closing;
  assert.equal(signals, 1);
  assert.equal(session.alive, false);
  assert.equal(child.stderr.destroyed, true);
  assert.match(exits[0].reason, /Timed out waiting for Codex app-server to close/);
});

async function openDriver(t, { scenario = 'normal', onRequest, ...open } = {}) {
  const dir = mkdtempSync(join(cwd, '.codex-driver-test-'));
  const trace = join(dir, 'rpc.jsonl');
  const child = spawn(process.execPath, [join(cwd, 'tests/fixtures/mock-codex-app-server.mjs'), scenario, trace], {
    cwd, stdio: 'pipe', windowsHide: true,
  });
  const turns = [];
  const requests = [];
  const session = new CodexAppServerPilot(child, {
    onTurnStarted() {},
    onTurnCompleted: (turnKey, result) => turns.push({ turnKey, ...result }),
    onRequest: async (turnKey, request) => {
      requests.push(request);
      return onRequest ? onRequest(request) : { decision: 'decline' };
    },
    onExit() {},
  }, 850);
  t.after(async () => {
    await session.close();
    rmSync(dir, { force: true, recursive: true });
  });
  const opened = session.open({ cwd, model: null, policy: 'read-only', ...open });
  const sent = (method) => readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((message) => message.method === method).map((message) => message.params);
  return { session, opened, turns, requests, sent };
}

test('each policy maps to a sandbox and approval mode, and a turn can switch policy and model', async (t) => {
  const { session, opened, turns, sent } = await openDriver(t, { policy: 'workspace-write', model: 'gpt-a' });
  await opened;
  const start = sent('thread/start')[0];
  assert.deepEqual([start.sandbox, start.approvalPolicy, start.model], ['workspace-write', 'on-request', 'gpt-a']);

  assert.equal((await session.startTurn({ turnKey: 'one', prompt: 'first' })).status, 'accepted');
  await until(() => turns.length === 1);
  assert.equal((await session.startTurn({
    turnKey: 'two', prompt: 'second', policy: 'full-auto', model: 'gpt-b', effort: 'high',
  })).status, 'accepted');
  await until(() => turns.length === 2);
  assert.equal((await session.startTurn({ turnKey: 'three', prompt: 'third' })).status, 'accepted');
  await until(() => turns.length === 3);

  const [first, second, third] = sent('turn/start');
  assert.deepEqual([first.sandboxPolicy.type, first.approvalPolicy, first.model], ['workspaceWrite', 'on-request', undefined]);
  assert.deepEqual(
    [second.sandboxPolicy.type, second.sandboxPolicy.networkAccess, second.approvalPolicy, second.model, second.effort],
    ['workspaceWrite', false, 'never', 'gpt-b', 'high'],
    'full-auto stops asking but stays inside the workspace sandbox',
  );
  assert.equal(third.approvalPolicy, 'never', 'a policy set on one turn stays in effect');
});

test('a sandbox Codex did not grant as requested fails the session before any turn', async (t) => {
  const { session, opened, sent } = await openDriver(t, { scenario: 'sandbox-mismatch', policy: 'read-only' });
  await assert.rejects(opened, /did not confirm the requested read-only sandbox/);
  assert.equal(session.sessionId, null);
  assert.equal((await session.startTurn({ turnKey: 'one', prompt: 'nope' })).status, 'not_accepted');
  assert.equal(sent('turn/start').length, 0);
});

test('resume continues the given thread and reports per-turn usage without a baseline', async (t) => {
  const { session, opened, turns, sent } = await openDriver(t, { resumeSessionId: 'mock-thread-id', policy: 'workspace-write' });
  assert.equal(await opened, 'mock-thread-id');
  assert.equal(sent('thread/start').length, 0);
  const resume = sent('thread/resume')[0];
  assert.deepEqual([resume.threadId, resume.sandbox, resume.excludeTurns], ['mock-thread-id', 'workspace-write', true]);

  await session.startTurn({ turnKey: 'one', prompt: 'continue' });
  await until(() => turns.length === 1);
  // The thread total (23/7) includes turns from before the resume; only this turn's share is known.
  assert.deepEqual(turns[0].usage, { inputTokens: 11, outputTokens: 3 });
});

test('a question from Codex is answered through onRequest; secret or unanswered ones are refused', async (t) => {
  const { session, opened, turns, requests } = await openDriver(t, {
    onRequest: (request) => (request.kind === 'question' && requests.length === 1
      ? { answers: { db: ['SQLite'] } } : { decision: 'decline' }),
  });
  await opened;
  await session.startTurn({ turnKey: 'one', prompt: 'ASK_A_QUESTION' });
  await until(() => turns.length === 1);
  assert.equal(requests[0].kind, 'question');
  assert.deepEqual(requests[0].questions, [{
    id: 'db', header: 'Database', prompt: 'Which database?', allowOther: false,
    options: [{ label: 'SQLite', description: 'Local file' }, { label: 'Postgres', description: 'Server' }],
  }]);
  assert.equal(turns[0].finalText, 'answer: {"db":{"answers":["SQLite"]}}');

  await session.startTurn({ turnKey: 'two', prompt: 'ASK_A_QUESTION' });
  await until(() => turns.length === 2);
  assert.equal(turns[1].finalText, 'request refused');

  await session.startTurn({ turnKey: 'three', prompt: 'ASK_A_QUESTION SECRET' });
  await until(() => turns.length === 3);
  assert.equal(requests.length, 2, 'a secret question is never forwarded');
  assert.equal(turns[2].finalText, 'request refused');
});

test('bounded stderr is included and redacted on startup failure and process exit', async () => {
  const child = fakeCodexChild();
  const exits = [];
  const session = new CodexAppServerPilot(child, recordCodexExit(exits), 850, [stderrSecret]);
  const opening = session.open({ cwd, model: null, policy: 'read-only' });
  child.stderr.write(Buffer.from('discarded-prefix ' + 'a'.repeat(5_000)));
  child.stderr.write(Buffer.from('\nTOML denied credential=' + stderrSecret.slice(0, 10)));
  child.stderr.write(Buffer.from(stderrSecret.slice(10) + '\n末尾'));
  child.stdout.write(JSON.stringify({
    id: 1, error: { code: -32602, message: 'initialization rejected: ' + stderrSecret },
  }) + '\n');
  const checkSummary = (summary) => {
    assert.doesNotMatch(summary, /discarded-prefix|pilot-stderr-credential-example/);
    assert.match(summary, /TOML denied credential=<redacted>\n末尾/);
    assert.ok(Buffer.byteLength(summary.split('Codex stderr:\n')[1]) <= 4_096);
    return true;
  };
  await assert.rejects(opening, (error) => checkSummary(error.message));
  assert.equal(session.alive, true);
  child.exitCode = 1;
  child.emit('close', 1, null);
  await session.close();
  assert.equal(exits.length, 1);
  assert.equal(exits[0].code, 1);
  checkSummary(exits[0].reason);
});

test('CLI defaults to the Worker identity in orchestration and companion payloads', () => {
  const workerId = 'codex-worker-00000000-0000-0000-0000-000000000001';
  const stdout = execFileSync(process.execPath, ['-e', `
    const { buildPayload } = require('./electron/orchestration/aha-orchestration-cli.cjs');
    console.log(JSON.stringify([
      buildPayload('check', {}, []).payload.from,
      buildPayload('send', { id: 'other-pane', text: 'test' }, [], 'terminal').payload.from,
    ]));
  `], { cwd, encoding: 'utf8', env: { ...process.env, AHA_WORKER_ID: workerId, AHA_TERMINAL_ID: 'old-pane' } });
  assert.deepEqual(JSON.parse(stdout), [workerId, workerId]);
});

test('headless HTTP permits scoped Worker operations and rejects control actions and auth bypasses', async (t) => {
  const app = await setup(t);
  const { dispatch } = await app.start('Check Worker HTTP scope');
  const id = dispatch.assigneeHandle;
  for (const action of [
    'worker-stop', 'worker-release', 'worker-abandon', 'worker-start', 'delegate-task', 'worker-integrate',
    'run-create', 'run-use', 'run-stop', 'coordinator-start', 'approve', 'deny', 'reset', 'role-manage',
  ]) {
    const reply = await app.workerHttp(id, action, {});
    assert.equal(reply.code, 'operation_rejected', action);
  }
  const foreign = app.service.runCreate({ objective: 'Unrelated run' }).run;
  const current = await app.workerHttp(id, 'run-current', { from: foreign.coordinatorHandle });
  assert.equal(current.result.run.id, app.run.id);
  const task = await app.workerHttp(id, 'task-show', { id: dispatch.taskId });
  assert.equal(task.ok, true);
  assert.equal((await app.workerHttp(id, 'board-read', { runId: app.run.id })).ok, true);
  assert.equal((await app.workerHttp(id, 'check', { peek: true })).ok, true);

  const mail = await app.workerHttp(id, 'send', {
    from: 'coordinator-pane', to: 'coordinator', type: 'status', subject: 'A Worker update',
  });
  assert.equal(mail.result.message.fromHandle, id);
  const heartbeat = await app.workerHttp(id, 'send', {
    type: 'heartbeat', subject: 'alive', payload: { dispatchId: 'forged-dispatch' },
  });
  assert.equal(heartbeat.result.lifecycle.action, 'heartbeat');
  assert.equal(JSON.parse(heartbeat.result.message.payload).dispatchId, dispatch.id);
  assert.equal((await app.workerHttp(id, 'send', {
    to: 'run:' + foreign.id, subject: 'Wrong run',
  })).code, 'operation_rejected');
  assert.equal((await app.workerHttp(id, 'send', {
    type: 'worker_done', subject: 'Fake completion',
  })).code, 'operation_rejected');

  const env = app.workers.get(id);
  const origin = new URL(env.AHA_ORCHESTRATION_URL).origin;
  for (const [path, workerHeaders] of [
    ['/orchestration/run-create', {}],
    ['/terminal/send', { 'x-aha-worker-id': id, 'x-aha-worker-token': env.AHA_WORKER_TOKEN }],
  ]) {
    const response = await fetch(origin + path, {
      method: 'POST',
      headers: { 'x-aha-agent-hook-token': env.AHA_AGENT_HOOK_TOKEN, ...workerHeaders },
      body: JSON.stringify({ objective: 'Bypass guard' }),
    });
    assert.equal(response.status, 403);
  }
  assert.equal(app.store.getDispatchContext(dispatch.id).status, 'dispatched');
});

for (const scenario of ['initialize-error', 'rejected']) {
  test(scenario + ' permits one PTY fallback', async (t) => {
    const app = await setup(t, scenario);
    const started = await app.start('Check fallback');
    assert.equal(started.ptyId, 'fallback-pane');
    assert.equal(started.dispatch.executionMode, undefined);
    assert.equal(app.ptyStarts(), 1);
    assert.ok(app.spawnCalls[0].extraArgs.includes('--sandbox'));
    assert.ok(app.spawnCalls[0].extraArgs.includes('read-only'));
    assert.ok(app.writes.length);
  });
}

for (const scenario of ['timeout', 'disconnect', 'started-then-error']) {
  test(scenario + ' never resubmits to a PTY', async (t) => {
    const app = await setup(t, scenario);
    await assert.rejects(app.start('Only submit me once'), (error) => error.data?.acceptance === 'unknown_acceptance');
    assert.equal(app.ptyStarts(), 0);
    assert.deepEqual(app.writes, []);
    const [dispatch] = app.store.listDispatches();
    assert.equal(dispatch.status, 'dispatched');
    assert.equal(dispatch.stage, 'needs_reconciliation');
    app.service.reconcileStaleDispatches();
    assert.equal(app.store.getDispatchContext(dispatch.id).stage, 'needs_reconciliation');
    assert.equal(dispatch.codexDeliveryFailure, 'unknown_acceptance');
    assert.equal(app.service.isPaneAlive(dispatch.assigneeHandle), false);
  });
}

test('an accepted headless pointer advances notification cursor; the exact board read proves delivery', async t => {
  const app = await setup(t);
  const worker = (await app.start('Read the board', { role: 'scout', displayName: 'scout' })).dispatch;
  await until(() => app.store.getDispatchContext(worker.id)?.codexTurn);
  await app.service.boardPost({ from: 'coordinator-pane', runId: app.run.id, text: '@scout pointer-marker ' + 'x'.repeat(1400) });
  const post = app.store.listBoardPosts(app.run.id).find(m => m.body.includes('pointer-marker'));
  assert.ok(post);
  await until(() => app.store.getMessageById(post.id).receipts?.scout === 'notified');
  assert.ok(app.store.getMemberCursor(app.run.id, 'scout').lastDeliveredSeq >= post.boardSeq);
  app.service.boardRead({ from: worker.assigneeHandle, runId: app.run.id, seqs: [post.boardSeq] });
  assert.equal(app.store.getMessageById(post.id).receipts.scout, 'delivered');
});

for (const delivery of ['mailbox', 'follow-up']) {
  test(delivery + ' with unknown acceptance preserves the active attempt without re-sending', async t => {
    const app = await setup(t, 'second-timeout');
    const first = (await app.start('First turn')).dispatch;
    await until(() => app.store.getDispatchContext(first.id)?.codexTurn);
    if (delivery === 'follow-up') await app.service.workerDoneByPane(first.assigneeHandle, { outcome: 'completed', summary: 'First result' });
    const send = () => app.service.send({ from: 'coordinator-pane', to: 'dispatch:' + first.id, runId: app.run.id,
      type: 'status', subject: 'Second turn', body: 'Read the next detail.' });
    if (delivery === 'follow-up') await assert.rejects(send, err => err.data?.acceptance === 'unknown_acceptance');
    else await send();
    const parked = await until(() => app.store.listDispatches().find(d => d.stage === 'needs_reconciliation'));
    assert.equal(parked.status, 'dispatched');
    app.service.reconcileStaleDispatches();
    assert.equal(app.store.getDispatchContext(parked.id).stage, 'needs_reconciliation');
    assert.equal(app.getTrace().filter(m => m.method === 'turn/start').length, 2);
    assert.equal(app.ptyStarts(), 0);
  });
}

test('PTY remains default, including selected Codex when not read-only', async (t) => {
  const disabled = await setup(t, 'normal', false);
  const started = await disabled.start('Return from the unchanged PTY path');
  assert.equal(started.ptyId, 'fallback-pane');
  assert.equal(disabled.codexStarts(), 0);

  // Even when the pilot setting is on, a terminal-coordinated writable Codex task still uses PTY.
  const enabled = await setup(t, 'normal', true);
  const writable = await enabled.start('Writable task from terminal coordinator', { readOnly: false });
  assert.equal(writable.ptyId, 'fallback-pane');
  assert.equal(writable.dispatch.executionMode, undefined);
  assert.equal(enabled.codexStarts(), 0);
  assert.equal(enabled.ptyStarts(), 1);
  assert.ok(!enabled.spawnCalls[0].extraArgs.includes('--sandbox'));
});

test('approval denial, mailbox turn, interrupt, and archive', async (t) => {
  const app = await setup(t);
  const { dispatch } = await app.start('ASK_FOR_APPROVAL');
  const approval = await until(() => app.service.workerShow({ dispatchId: dispatch.id }).openApprovals[0]);
  app.service.deny({ id: approval.approvalId, reason: 'test decline' }, 'coordinator-pane');
  const turn = await until(() => app.store.getDispatchContext(dispatch.id)?.codexTurn);
  assert.equal(turn.finalText, 'approval decision: decline');
  assert.equal(app.getTrace().find((message) => message.id === 'approval-1').result.decision, 'decline');
  const before = app.getTrace().filter((message) => message.method === 'turn/start').length;
  await app.service.send({
    from: 'coordinator-pane', to: 'dispatch:' + dispatch.id, runId: app.run.id,
    type: 'status', subject: 'Mailbox follow-up', body: 'Read the next detail.',
  });
  await until(() => app.getTrace().filter((message) => message.method === 'turn/start').length > before);
  await until(() => app.store.getDispatchContext(dispatch.id)?.codexTurn?.turnId === 'mock-turn-2');
  const stopped = await app.service.workerStop({ dispatchId: dispatch.id });
  assert.equal(stopped.dispatch.status, 'failed');
  assert.equal(app.service.isPaneAlive(dispatch.assigneeHandle), false);
  const archived = app.service.workerRead({ dispatchId: dispatch.id, screen: true });
  assert.equal(archived.archived, true);
  assert.match(archived.text, /approval decision: decline/);
  assert.equal(app.service.workerShow({ dispatchId: dispatch.id }).openApprovals.length, 0);
});

test('workerAbandon archives output and interrupts the headless process', async (t) => {
  const app = await setup(t);
  const { dispatch } = await app.start('WAIT_FOR_INTERRUPT');
  await until(() => app.service.workerRead({ dispatchId: dispatch.id }).text);
  const result = app.service.workerAbandon({ dispatchId: dispatch.id });
  assert.equal(result.dispatch.lastFailureReason, 'abandoned');
  assert.equal(app.service.isPaneAlive(dispatch.assigneeHandle), false);
  assert.match(result.dispatch.archivedOutput, /output before cancel/);
  await until(() => app.exits[0]);
  assert.ok(app.getTrace().some((message) => message.method === 'turn/interrupt'));
  assert.equal(app.service.hasCodexWorkers(), false);
  assert.equal(app.service.workerRead({ dispatchId: dispatch.id }).archived, true);
});

for (const terminalStatus of ['completed', 'failed']) {
  test('coordinator convergence reaps idle headless Workers in a ' + terminalStatus + ' run', async (t) => {
    const app = await setup(t);
    const { dispatch } = await app.start('Check terminal-run retirement');
    await until(() => app.store.getDispatchContext(dispatch.id).codexTurn);
    const report = await app.workerHttp(dispatch.assigneeHandle, 'worker-done-self', {
      summary: 'Convergence check', outcome: terminalStatus,
    });
    assert.equal(report.ok, true);
    assert.equal(app.service.isPaneAlive(dispatch.assigneeHandle), true);
    if (terminalStatus === 'failed') app.service.taskUpdate({ id: dispatch.taskId, status: 'failed' });
    app.service.coordinatorStart({ runId: app.run.id, coordinatorPaneId: 'coordinator-pane' });
    await until(() => app.store.getRun(app.run.id).status === terminalStatus);
    await until(() => app.exits[0]);
    const read = app.service.workerRead({ dispatchId: dispatch.id });
    assert.equal(read.archived, true);
    assert.match(read.text, /模拟输出 1/);
    assert.equal(app.service.isPaneAlive(dispatch.assigneeHandle), false);
  });
}

test('stopping a run spares active or retained headless Workers until eligible', async (t) => {
  const app = await setup(t);
  const idle = (await app.start('Idle Worker')).dispatch;
  const retained = (await app.start('Retained Worker', { keepOpen: true })).dispatch;
  const active = (await app.start('WAIT_FOR_INTERRUPT')).dispatch;
  for (const dispatch of [idle, retained]) {
    const report = await app.workerHttp(dispatch.assigneeHandle, 'worker-done-self', { summary: 'Idle now' });
    assert.equal(report.ok, true);
  }
  app.service.coordinatorStart({ runId: app.run.id, coordinatorPaneId: 'coordinator-pane' });
  app.service.coordinatorStop();
  assert.equal(app.store.getRun(app.run.id).status, 'stopped');
  assert.equal(app.service.isPaneAlive(idle.assigneeHandle), false);
  assert.equal(app.service.isPaneAlive(retained.assigneeHandle), true);
  assert.equal(app.service.isPaneAlive(active.assigneeHandle), true);
  const report = await app.workerHttp(active.assigneeHandle, 'worker-done-self', { summary: 'Finished after stop' });
  assert.equal(report.ok, true);
  await until(() => app.exits.length === 2);
  assert.equal(app.service.isPaneAlive(active.assigneeHandle), false);
  assert.equal(app.service.isPaneAlive(retained.assigneeHandle), true);
  for (const dispatch of [idle, active]) {
    const read = app.service.workerRead({ dispatchId: dispatch.id });
    assert.equal(read.archived, true);
    assert.ok(read.text.length);
  }
});

test('Windows closes the complete Codex job when its application process crashes', {
  skip: process.platform !== 'win32', timeout: 20_000,
}, async () => {
  const program = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });",
    "console.log(JSON.stringify({ parent: process.pid, child: child.pid }));",
    "process.stdin.once('data', () => process.exit(19));",
  ].join(' ');
  const job = spawnWindowsCodexJob(process.execPath, ['-e', program], cwd, process.env);
  const closed = new Promise((resolve) => job.once('close', resolve));
  const dead = (pid) => {
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return true;
    }
  };
  const lines = createInterface({ input: job.stdout });
  let stderr = '';
  job.stderr.on('data', (data) => { stderr += data; });
  try {
    const pids = await Promise.race([
      new Promise((resolve) => lines.once('line', (line) => resolve(JSON.parse(line)))),
      closed.then(() => assert.fail(stderr || 'Windows job exited before the child launched')),
    ]);
    assert.equal(dead(pids.parent), false);
    assert.equal(dead(pids.child), false);
    job.stdin.write('crash\n');
    assert.equal(await closed, 19);
    await until(() => dead(pids.parent) && dead(pids.child));
  } finally {
    if (job.exitCode === null) job.kill();
    await closed;
  }
});

test('active interrupt and unexpected exit both reap the mock and archive live output', async (t) => {
  const app = await setup(t);
  const stopped = await app.start('WAIT_FOR_INTERRUPT');
  await until(() => app.service.workerRead({ dispatchId: stopped.dispatch.id }).text);
  await app.service.workerStop({ dispatchId: stopped.dispatch.id });
  assert.ok(app.getTrace().some((message) => message.method === 'turn/interrupt'));
  assert.match(app.service.workerRead({ dispatchId: stopped.dispatch.id }).text, /output before cancel/);
  assert.ok(app.children[0].exitCode !== null || app.children[0].signalCode !== null);

  const crashed = await app.start('CRASH_LATER');
  await until(() => app.store.getDispatchContext(crashed.dispatch.id)?.status === 'failed');
  assert.equal(app.service.isPaneAlive(crashed.dispatch.assigneeHandle), false);
  assert.match(app.service.workerRead({ dispatchId: crashed.dispatch.id }).text, /output before process crash/);
  assert.equal(app.ptyStarts(), 0);
});

const timelineItems = (snapshot, turn = 0) => Object.fromEntries(snapshot.turns[turn].items.map((item) => [item.id, item]));

test('headless timeline captures every process step in place, redacts secrets, and archives on stop', async (t) => {
  const app = await setup(t);
  const changes = [];
  app.service.onWorkerTimelineChange((change) => changes.push(change));
  const { dispatch } = await app.start('RICH_TIMELINE');
  await until(() => app.store.getDispatchContext(dispatch.id)?.codexTurn);
  const live = await until(() => {
    const snapshot = app.service.getWorkerTimeline({ dispatchId: dispatch.id });
    return snapshot?.turns[0]?.items.some((item) => item.kind === 'settlement') ? snapshot : null;
  });
  assert.equal(live.workerHandle, dispatch.assigneeHandle);
  assert.equal(live.cliId, 'codex');
  assert.equal(live.readOnly, true);
  assert.equal(live.alive, true);
  assert.equal(live.providerSessionId, dispatch.providerSessionId);
  assert.deepEqual(app.service.getWorkerTimeline({ workerHandle: dispatch.assigneeHandle }).turns.length, 1);
  const [turn] = live.turns;
  assert.equal(turn.status, 'completed');
  assert.equal(turn.turnId, 'mock-turn-1');
  assert.equal(turn.dispatchId, dispatch.id);
  assert.deepEqual(turn.usage, { inputTokens: 23, outputTokens: 7 });
  assert.match(turn.prompt, /RICH_TIMELINE/);
  assert.deepEqual(turn.items.map((item) => item.kind),
    ['reasoning', 'plan', 'command', 'file_change', 'tool_call', 'message', 'settlement']);
  const items = timelineItems(live);
  assert.equal(items.think.summary, 'Inspecting the workspace');
  assert.equal(items.think.status, 'completed');
  assert.deepEqual(items['plan:mock-turn-1'].steps, [
    { step: 'List files', status: 'completed' }, { step: 'Summarize', status: 'in_progress' },
  ]);
  assert.equal(items['plan:mock-turn-1'].explanation, 'Two steps');
  assert.equal(items.cmd.command, 'Get-ChildItem');
  assert.equal(items.cmd.exitCode, 0);
  assert.equal(items.cmd.durationMs, 120);
  assert.equal(items.cmd.status, 'completed');
  assert.match(items.cmd.output, /^README\.md\ntoken=<redacted>/);
  assert.equal(items.patch.files.length, 1);
  assert.deepEqual(
    { path: items.patch.files[0].path, change: items.patch.files[0].change,
      added: items.patch.files[0].added, removed: items.patch.files[0].removed },
    { path: 'src/demo.ts', change: 'update', added: 2, removed: 1 },
  );
  assert.match(items.patch.files[0].diff, /\+extra line/);
  assert.equal(items.mcp.toolType, 'mcp');
  assert.equal(`${items.mcp.server}/${items.mcp.tool}`, 'aha/read_board');
  assert.equal(items.mcp.args, '{"limit":5}');
  assert.equal(items.mcp.progress, 'reading board');
  assert.equal(items.mcp.output, 'board ok');
  assert.equal(items.answer.text, 'Rich **timeline** done');
  assert.equal(items.answer.status, 'completed');
  const settlement = turn.items.at(-1);
  assert.equal(settlement.settlement, 'turn_pending_confirmation');
  assert.equal(settlement.stopReason, 'completed');
  assert.doesNotMatch(JSON.stringify(live), new RegExp(stderrSecret));
  assert.ok(changes.length > 0);
  assert.ok(changes.every((change) => change.timeline.workerHandle === dispatch.assigneeHandle));

  const view = app.service.getSnapshot(app.run.id).dispatches.find((entry) => entry.id === dispatch.id);
  assert.equal(view.hasArchivedTimeline, true);
  assert.equal(view.archivedTimeline, undefined, 'renderer snapshots never carry the archive itself');

  await app.service.workerStop({ dispatchId: dispatch.id });
  const archived = await until(() => {
    const value = app.store.getArchivedTimeline(dispatch.id);
    return value?.alive === false ? value : null;
  });
  assert.deepEqual(archived.turns[0].items.map((item) => item.id), turn.items.map((item) => item.id));
  const fallback = app.service.getWorkerTimeline({ dispatchId: dispatch.id });
  assert.equal(fallback.alive, false);
  assert.equal(fallback.turns[0].key, turn.key);
  await app.service.waitForPendingWrites();
  const persisted = JSON.parse(readFileSync(app.statePath, 'utf8')).dispatches.find((entry) => entry.id === dispatch.id);
  assert.equal(persisted.archivedTimeline.turns[0].key, turn.key);
  assert.doesNotMatch(JSON.stringify(persisted.archivedTimeline), new RegExp(stderrSecret));
  const restored = new OrchestrationStore({ resolveFile: () => app.statePath });
  restored.load();
  assert.equal(restored.getArchivedTimeline(dispatch.id).turns[0].items.length, turn.items.length);
});

test('timeline shows inline approvals with their resolution and a follow-up as a second turn', async (t) => {
  const app = await setup(t);
  const { dispatch } = await app.start('ASK_FOR_APPROVAL');
  const pending = await until(() => app.service.getWorkerTimeline({ dispatchId: dispatch.id })
    ?.turns[0]?.items.find((item) => item.kind === 'approval'));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.method, 'item/commandExecution/requestApproval');
  assert.match(pending.input, /Get-Location/);
  app.service.deny({ id: pending.approvalId, reason: 'test decline' }, 'coordinator-pane');
  const resolved = await until(() => {
    const item = app.service.getWorkerTimeline({ dispatchId: dispatch.id }).turns[0].items
      .find((entry) => entry.kind === 'approval');
    return item.status === 'denied' ? item : null;
  });
  assert.equal(resolved.resolution, 'test decline');
  await until(() => app.store.getDispatchContext(dispatch.id)?.codexTurn);
  await app.service.send({
    from: 'coordinator-pane', to: 'dispatch:' + dispatch.id, runId: app.run.id,
    type: 'status', subject: 'Mailbox follow-up', body: 'Read the next detail.',
  });
  const two = await until(() => {
    const snapshot = app.service.getWorkerTimeline({ workerHandle: dispatch.assigneeHandle });
    return snapshot.turns.length === 2 && snapshot.turns[1].status === 'completed' ? snapshot : null;
  });
  assert.notEqual(two.turns[0].key, two.turns[1].key);
  assert.equal(two.turns[1].turnId, 'mock-turn-2');
  assert.equal(timelineItems(two, 0).answer.text, 'approval decision: decline');
  assert.equal(timelineItems(two, 1).answer.text, '模拟输出 2', 'repeated provider item ids stay in their own turn');
});

test('timeline interrupt keeps the Worker alive and a crash archives a failed turn', async (t) => {
  const app = await setup(t);
  const waiting = (await app.start('WAIT_FOR_INTERRUPT')).dispatch;
  await until(() => app.service.getWorkerTimeline({ dispatchId: waiting.id })?.turns[0]?.turnId);
  const result = await app.service.workerInterrupt({ dispatchId: waiting.id });
  assert.equal(result.interrupted, true);
  const interrupted = await until(() => {
    const snapshot = app.service.getWorkerTimeline({ dispatchId: waiting.id });
    return snapshot.turns[0].status === 'interrupted' ? snapshot : null;
  });
  assert.equal(interrupted.alive, true);
  assert.equal(timelineItems(interrupted).answer.text, 'output before cancel');
  assert.ok(app.getTrace().some((message) => message.method === 'turn/interrupt'));
  assert.equal(app.service.isPaneAlive(waiting.assigneeHandle), true);

  const crashed = (await app.start('CRASH_LATER')).dispatch;
  const archived = await until(() => {
    const value = app.store.getArchivedTimeline(crashed.id);
    return value?.alive === false ? value : null;
  });
  assert.equal(archived.turns[0].status, 'failed');
  assert.match(archived.turns[0].error, /exited/);
  assert.equal(timelineItems(archived).answer.text, 'output before process crash');
  assert.equal(app.service.getWorkerTimeline({ dispatchId: crashed.id }).alive, false);
  await assert.rejects(app.service.workerInterrupt({ dispatchId: crashed.id }), (error) => error.code === 'dispatch_inactive');
});

test('timeline redacts secrets split across deltas and caps oversized output', () => {
  const timeline = new WorkerTimeline({
    workerHandle: 'w', cliId: 'codex', model: null, readOnly: true,
    redact: (text) => text.replaceAll(stderrSecret, '<redacted>'),
  });
  timeline.beginTurn({ dispatchId: 'd1', prompt: 'prompt with ' + stderrSecret });
  timeline.apply({ type: 'turn_started', turnId: 't1' });
  timeline.apply({ type: 'item', item: { id: 'c', kind: 'command', command: 'echo' } });
  timeline.apply({ type: 'delta', id: 'c', kind: 'command', field: 'output', delta: stderrSecret.slice(0, 9) });
  timeline.apply({ type: 'delta', id: 'c', kind: 'command', field: 'output', delta: stderrSecret.slice(9) + '\n' });
  let snapshot = timeline.snapshot();
  assert.equal(snapshot.turns[0].prompt, 'prompt with <redacted>');
  assert.equal(snapshot.turns[0].items[0].output, '<redacted>\n');
  timeline.apply({ type: 'delta', id: 'c', kind: 'command', field: 'output', delta: 'x'.repeat(TIMELINE_LIMITS.output + 10) + 'TAIL' });
  snapshot = timeline.snapshot();
  const command = snapshot.turns[0].items[0];
  assert.equal(command.outputTruncated, true);
  assert.ok(command.output.endsWith('TAIL'));
  assert.ok(command.output.length <= TIMELINE_LIMITS.output + 20);
  timeline.completeTurn({ turnId: 't1', status: 'completed' });
  assert.equal(timeline.snapshot().turns[0].items[0].status, 'completed');
  const archived = timeline.archive(8 * 1024);
  assert.ok(Buffer.byteLength(JSON.stringify(archived)) <= 8 * 1024);
  assert.equal(archived.turns[0].itemsTrimmed, true);
  const tiny = trimTimelineSnapshot(timeline.snapshot(), 1024);
  assert.ok(tiny.turns.length >= 1);
});

test('timeline patch coalescer merges streamed deltas into one patch per 30ms window', async () => {
  const sent = [];
  const coalescer = new WorkerTimelinePatchCoalescer((patch) => sent.push(patch), 30);
  const timeline = new WorkerTimeline({
    workerHandle: 'w', cliId: 'codex', model: 'gpt', readOnly: true, onPatch: (change) => coalescer.push(change),
  });
  timeline.beginTurn({ dispatchId: 'd1', prompt: 'go' });
  for (let i = 0; i < 200; i++) {
    timeline.apply({ type: 'delta', id: 'm', kind: 'message', field: 'text', delta: String(i % 10) });
  }
  timeline.apply({ type: 'delta', id: 'r', kind: 'reasoning', field: 'summary', delta: 'think' });
  assert.equal(sent.length, 0, 'nothing is sent synchronously');
  await delay(10);
  assert.equal(sent.length, 0, 'nothing is sent before the window closes');
  await delay(60);
  assert.equal(sent.length, 1);
  const [patch] = sent;
  assert.equal(patch.workerHandle, 'w');
  assert.equal(patch.seq, timeline.getHeader().seq);
  assert.equal(patch.turns.length, 1);
  assert.equal(patch.turns[0].key, 'd1#1');
  assert.deepEqual(patch.turns[0].items.map((item) => item.id), ['m', 'r']);
  assert.equal(patch.turns[0].items[0].text.length, 200);
  timeline.apply({ type: 'delta', id: 'm', kind: 'message', field: 'text', delta: '!' });
  patch.turns[0].items[0].text = 'mutated';
  assert.equal(timeline.snapshot().turns[0].items[0].text.length, 201, 'patches are detached copies');
  coalescer.dispose();
  await delay(60);
  assert.equal(sent.length, 1, 'dispose drops the pending patch and its timer');
  timeline.apply({ type: 'delta', id: 'm', kind: 'message', field: 'text', delta: '?' });
  await delay(60);
  assert.equal(sent.length, 1);
});

test('short mailbox messages are inlined into the next headless turn; long ones point at read_board', async (t) => {
  const app = await setup(t);
  const { dispatch } = await app.start('Stay active');
  await until(() => app.store.getDispatchContext(dispatch.id)?.codexTurn);
  const turnPrompts = () => app.getTrace().filter((message) => message.method === 'turn/start')
    .map((message) => message.params.input[0].text);
  await app.service.send({
    from: 'coordinator-pane', to: 'dispatch:' + dispatch.id, runId: app.run.id,
    type: 'status', subject: 'Quick question', body: 'Please also list the tests folder.',
  });
  await until(() => turnPrompts().length === 2);
  const inline = turnPrompts()[1];
  assert.match(inline, /Please also list the tests folder\./);
  assert.match(inline, /Quick question/);
  assert.doesNotMatch(inline, /Use the Aha read_board tool/);
  const timeline = await until(() => {
    const snapshot = app.service.getWorkerTimeline({ dispatchId: dispatch.id });
    return snapshot.turns.length === 2 && snapshot.turns[1].status === 'completed' ? snapshot : null;
  });
  assert.match(timeline.turns[1].prompt, /Please also list the tests folder\./);

  await app.service.send({
    from: 'coordinator-pane', to: 'dispatch:' + dispatch.id, runId: app.run.id,
    type: 'status', subject: 'Long context', body: 'detail '.repeat(300),
  });
  await until(() => turnPrompts().length === 3);
  assert.match(turnPrompts()[2], /Use the Aha read_board tool/);
});

test('git fallback diff is redacted before it is stored, announced, or shown', async (t) => {
  const app = await setup(t);
  // A shared sparse clone gives a real HEAD without creating commits; only README.md is checked out.
  const repo = join(app.dir, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: app.dir, encoding: 'utf8', windowsHide: true });
  git('clone', '--quiet', '--shared', '--no-checkout', cwd, repo);
  git('-C', repo, 'sparse-checkout', 'set', '--no-cone', '/README.md');
  git('-C', repo, 'checkout', '--quiet');
  writeFileSync(join(repo, 'README.md'), readFileSync(join(repo, 'README.md'), 'utf8') + '\nleaked ' + stderrSecret + '\n');
  const { dispatch } = await app.start('Report the diff', { cwd: repo });
  const settled = await until(() => app.service.getWorkerTimeline({ dispatchId: dispatch.id })
    ?.turns[0]?.items.find((item) => item.kind === 'settlement'));
  assert.equal(settled.diffSource, 'git');
  assert.match(settled.diff, /leaked <redacted>/);
  assert.match(app.store.getDispatchContext(dispatch.id).codexTurn.diff, /leaked <redacted>/);
  await app.service.waitForPendingWrites();
  assert.doesNotMatch(readFileSync(app.statePath, 'utf8'), new RegExp(stderrSecret));
});

test('git fallback diff includes untracked new files without modifying the git index', async (t) => {
  const app = await setup(t);
  const repo = join(app.dir, 'repo-untracked');
  const git = (...args) => execFileSync('git', args, { cwd: app.dir, encoding: 'utf8', windowsHide: true });
  git('clone', '--quiet', '--shared', '--no-checkout', cwd, repo);
  git('-C', repo, 'sparse-checkout', 'set', '--no-cone', '/README.md');
  git('-C', repo, 'checkout', '--quiet');
  writeFileSync(join(repo, 'brand-new-note.txt'), 'hello from worker\n');
  writeFileSync(join(repo, `secret-${stderrSecret}.txt`), 'secret filename\n');
  const statusBefore = git('-C', repo, 'status', '--porcelain');

  const { dispatch } = await app.start('Check untracked files in fallback diff', { cwd: repo });
  const settled = await until(() => app.service.getWorkerTimeline({ dispatchId: dispatch.id })
    ?.turns[0]?.items.find((item) => item.kind === 'settlement'));
  assert.equal(settled.diffSource, 'git');
  assert.match(settled.diff, /brand-new-note\.txt/);
  assert.match(settled.diff, /secret-<redacted>\.txt/);
  assert.doesNotMatch(settled.diff, new RegExp(stderrSecret));
  assert.match(app.store.getDispatchContext(dispatch.id).codexTurn.diff, /brand-new-note\.txt/);
  // Read-only inspection must never stage or intent-to-add untracked files.
  assert.equal(git('-C', repo, 'status', '--porcelain'), statusBefore);
  assert.equal(git('-C', repo, 'diff', '--cached', '--name-only').trim(), '');
});

test('session Coordinator runs a writable headless Worker in a worktree, integrates via squash and run-finalize, and reaps it', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aha-codex-e2e-'));
  const repo = join(root, 'repo');
  const git = (workdir, ...args) => execFileSync('git', args, { cwd: workdir, encoding: 'utf8', windowsHide: true }).trim();
  git(root, 'init', '-b', 'main', 'repo');
  git(repo, 'config', 'user.name', 'Test User');
  git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# Demo\n', 'utf8');
  git(repo, 'add', '.');
  git(repo, 'commit', '-m', 'initial commit');
  const baseHead = git(repo, 'rev-parse', 'HEAD');

  const app = await setup(t, 'normal', false, { confirmMode: 'auto' });
  t.after(async () => {
    await app.service.stopCodexWorkers();
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  });
  const SESSION = 'agent-session-00000000-0000-0000-0000-0000000000e2';
  app.service.setSessionCoordinators({
    get: (id) => (id === SESSION ? { cwd: repo, provider: 'codex', active: true, idle: true, network: false } : null),
  });
  const callSession = (action, payload) =>
    dispatchOrchestrationHttpAction(app.service, action, payload, {
      signal: new AbortController().signal, callerPaneId: SESSION,
    }).then((reply) => reply.body);
  const processDead = (pid) => {
    if (!pid) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
      return true;
    }
  };

  // 1. Direct squash integration into main.
  const started = await callSession('delegate-task', {
    role: 'writer', task: 'Create hello.txt via WRITE_FILE:hello.txt', agent: 'codex', worktree: true,
  });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.result.status, 'started', JSON.stringify(started.result));
  const dispatch = started.result.dispatch;
  const workerId = dispatch.assigneeHandle;
  const worktreePath = dispatch.worktreePath;
  const workerBranch = dispatch.branch;
  const workerChild = app.children[0];
  assert.equal(dispatch.executionMode, 'codex-app-server');
  assert.equal(dispatch.assigneePaneId, null);
  assert.equal(dispatch.ownsPane, false);
  assert.equal(dispatch.ownsWorktree, true);
  assert.ok(worktreePath && worktreePath !== repo);
  assert.ok(workerBranch && workerBranch.startsWith('aha/worker/'));
  assert.equal(app.ptyStarts(), 0);
  assert.equal(app.service.getWorkerTimeline({ dispatchId: dispatch.id }).readOnly, false);

  const settled = await until(() => app.service.getWorkerTimeline({ dispatchId: dispatch.id })
    ?.turns[0]?.items.find((item) => item.kind === 'settlement'));
  assert.equal(existsSync(join(worktreePath, 'hello.txt')), true);
  assert.equal(existsSync(join(repo, 'hello.txt')), false);
  assert.equal(settled.diffSource, 'git');
  assert.match(settled.diff ?? '', /hello\.txt/);
  assert.match(app.store.getDispatchContext(dispatch.id).codexTurn.diff ?? '', /hello\.txt/);

  const done = await reportDone(app.workers.get(workerId), 'Wrote hello.txt');
  assert.equal(done.isError, undefined);
  assert.equal(app.store.getDispatchContext(dispatch.id).status, 'completed');

  const integrated = await callSession('worker-integrate', { dispatchId: dispatch.id, mode: 'squash' });
  assert.equal(integrated.ok, true, integrated.error);
  assert.equal(integrated.result.integrated, true);
  assert.equal(integrated.result.mode, 'squash');
  assert.equal(integrated.result.released, true);
  assert.equal(readFileSync(join(repo, 'hello.txt'), 'utf8'), 'written by mock headless worker (hello.txt)\n');
  assert.equal(git(repo, 'rev-list', '--count', `${baseHead}..HEAD`), '1');

  const releasedDispatch = app.store.getDispatchContext(dispatch.id);
  assert.ok(releasedDispatch.releasedAt);
  assert.equal(releasedDispatch.stage, 'released');
  assert.equal(releasedDispatch.ownsWorktree, false);
  assert.equal(existsSync(worktreePath), false);
  assert.equal(git(repo, 'branch', '--list', workerBranch), '');
  assert.equal(app.service.hasCodexWorkers(), false);
  assert.equal(app.service.isPaneAlive(workerId), false);
  assert.ok(workerChild.exitCode !== null || workerChild.signalCode !== null);
  assert.equal(processDead(workerChild.pid), true);
  assert.equal(app.ptyStarts(), 0);

  // 2. Dirty main routes to aha/run/* integration branch, then run-finalize promotes it cleanly.
  writeFileSync(join(repo, 'user-wip.txt'), 'unsaved local edit\n', 'utf8');
  const second = await callSession('delegate-task', {
    role: 'writer-two', task: 'Create staged.txt via WRITE_FILE:staged.txt', agent: 'codex', worktree: true,
  });
  assert.equal(second.ok, true, second.error);
  const secondDispatch = second.result.dispatch;
  const secondChild = app.children[1];
  await until(() => app.store.getDispatchContext(secondDispatch.id)?.codexTurn);
  const secondDone = await reportDone(app.workers.get(secondDispatch.assigneeHandle), 'Wrote staged.txt');
  assert.equal(secondDone.isError, undefined);

  const staged = await callSession('worker-integrate', { dispatchId: secondDispatch.id, mode: 'squash' });
  assert.equal(staged.ok, true, staged.error);
  assert.equal(staged.result.integrated, true);
  assert.equal(staged.result.usedRunIntegrationBranch, true);
  assert.equal(staged.result.released, true);
  assert.equal(existsSync(join(repo, 'staged.txt')), false, 'dirty main stays untouched until finalize');
  assert.equal(existsSync(secondDispatch.worktreePath), false);
  assert.equal(app.service.hasCodexWorkers(), false);
  assert.equal(processDead(secondChild.pid), true);

  rmSync(join(repo, 'user-wip.txt'));
  const finalized = await callSession('run-finalize', { runId: secondDispatch.runId, mode: 'squash' });
  assert.equal(finalized.ok, true, finalized.error);
  assert.equal(finalized.result.integrated, true);
  assert.equal(finalized.result.removedWorktree, true);
  assert.equal(finalized.result.removedBranch, true);
  assert.equal(readFileSync(join(repo, 'staged.txt'), 'utf8'), 'written by mock headless worker (staged.txt)\n');
  assert.equal(app.ptyStarts(), 0);
});
