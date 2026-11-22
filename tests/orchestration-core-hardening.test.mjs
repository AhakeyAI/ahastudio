import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { evaluateDagConvergence } from '../dist-electron/orchestration/coordinator.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';

function harness(t, extra = {}) {
  let nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
  const now = () => nowMs;
  const store = extra.store ?? new OrchestrationStore({ now: () => new Date(nowMs).toISOString() });
  const agentStatusStore = new AgentStatusStore({ now });
  const spawned = [];
  const state = { failSpawn: false, failWrite: false };
  const { store: _ignored, ...deps } = extra;
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async () => (state.failWrite ? { ok: false, error: 'write refused' } : { ok: true }),
    spawnWorkerPty: async ({ cliId }) => {
      if (state.failSpawn) throw new Error('spawn refused');
      const ptyId = `spawned-${spawned.length + 1}`;
      spawned.push(ptyId);
      agentStatusStore.registerPane(ptyId, { agentId: cliId });
      return { ptyId, cwd: process.cwd() };
    },
    isPtyAlive: (id) => agentStatusStore.get(id) !== null,
    turnStartObserveTimeoutMs: 0,
    settleDelayMs: 0,
    getDefaultWorktree: () => false,
    getConfirmMode: () => 'auto',
    now,
    ...deps,
  });
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  t.after(() => service.dispose());
  return { store, agentStatusStore, service, spawned, state, advance: (ms) => (nowMs += ms) };
}

const delegate = (service, from, role, extra = {}) =>
  service.delegateTask({ from, role, task: `do ${role}`, agent: 'claude', worktree: false, ...extra });

const http = (service, action, payload, callerPaneId) =>
  dispatchOrchestrationHttpAction(service, action, payload, { signal: new AbortController().signal, callerPaneId });

test('① a prompt-submit hook alone never counts as the user confirming a dispatch', async (t) => {
  const { service, advance } = harness(t, { getConfirmMode: () => 'chat-and-guard' });
  service.recordUserPromptTurn('coord', 'pty');
  const first = await delegate(service, 'coord', 'impl');
  assert.equal(first.status, 'confirmation_required');

  // Mailbox pointers and stall nudges are typed into the coordinator and fire the hook too.
  advance(30_000);
  service.recordUserPromptTurn('coord', 'hook');
  const injected = await delegate(service, 'coord', 'impl', { confirmed: true, proposalId: first.proposal.id });
  assert.equal(injected.status, 'confirmation_required', 'a hook-only turn must not confirm');

  advance(30_000);
  service.recordUserPromptTurn('coord', 'pty');
  advance(200);
  service.recordUserPromptTurn('coord', 'hook');
  const confirmed = await delegate(service, 'coord', 'impl', { confirmed: true, proposalId: injected.proposal.id });
  assert.equal(confirmed.status, 'started', 'a real keystroke turn confirms');
});

test('② a worker that already reported keeps its depth, and active workers are capped globally', async (t) => {
  const { service, store, spawned } = harness(t, { maxActiveWorkers: 3 });
  const l1 = await delegate(service, 'coord', 'l1');
  const l2 = await delegate(service, l1.ptyId, 'l2');
  assert.equal(l2.dispatch.depth, 2);
  await assert.rejects(delegate(service, l2.ptyId, 'l3'), /depth 3 exceeds max depth 2/);

  await service.workerDoneByPane(l2.ptyId, { summary: 'done' });
  await assert.rejects(
    delegate(service, l2.ptyId, 'l3b'),
    /depth 3 exceeds max depth 2/,
    'reporting done must not turn a worker pane into a depth-0 coordinator',
  );
  assert.equal(service.getMcpContextForPane(l2.ptyId).canDelegate, false);

  await delegate(service, 'coord', 'a');
  await delegate(service, 'coord', 'b');
  const before = spawned.length;
  await assert.rejects(delegate(service, 'coord', 'c'), (err) => err.code === 'worker_limit_reached');
  assert.equal(spawned.length, before, 'the cap is checked before any terminal is spawned');
  assert.equal(store.listDispatches().filter((d) => d.status === 'dispatched').length, 3);
});

test('④ a failed dependency blocks its dependents instead of leaving them pending forever', (t) => {
  const { store } = harness(t);
  const run = store.createRun({ objective: 'dag', coordinatorHandle: 'coord' });
  const a = store.createTask({ runId: run.id, spec: 'A' });
  const b = store.createTask({ runId: run.id, spec: 'B', deps: [a.id] });
  const c = store.createTask({ runId: run.id, spec: 'C', deps: [b.id] });

  store.updateTaskStatus(a.id, 'failed');
  assert.equal(store.getTask(b.id).status, 'blocked');
  assert.match(store.getTask(b.id).blockedReason, /^dependency_failed/);
  assert.equal(store.getTask(c.id).status, 'blocked', 'blocking is transitive');
  assert.equal(evaluateDagConvergence(store.listTasks({ runId: run.id })), 'all-done');

  store.requeueTaskForRetry(a.id);
  assert.equal(store.getTask(b.id).status, 'pending', 'retrying the dependency unblocks dependents');
  assert.equal(store.getTask(b.id).blockedReason ?? null, null);
  assert.equal(store.getTask(c.id).status, 'pending');
  store.updateTaskStatus(a.id, 'completed');
  assert.equal(store.getTask(b.id).status, 'ready');
});

test('⑤ a run with a live worker survives restart, and new work reopens a settled run', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-core-hardening-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'orchestration-state.json');
  const store = new OrchestrationStore({ resolveFile: () => file });
  const { service } = harness(t, { store });

  const w1 = await delegate(service, 'coord', 'impl');
  await service.workerDoneByPane(w1.ptyId, { summary: 'done' });
  assert.equal(store.getRun(w1.run.id).status, 'active', 'only the coordinator decides the run is done');

  store.updateRunStatus(w1.run.id, 'completed');
  const extra = store.createTask({ runId: w1.run.id, spec: 'late fix' });
  store.createDispatchContext({ taskId: extra.id, assigneeHandle: 'late-worker' });
  assert.equal(store.getRun(w1.run.id).status, 'active', 'dispatching into a settled run reopens it');

  store.flushSync();
  const reloaded = new OrchestrationStore({ resolveFile: () => file });
  reloaded.load();
  assert.equal(reloaded.getRun(w1.run.id).status, 'active', 'a run with a live worker is not stopped on restart');
});

test('⑦ a task created for a dispatch that never started is failed, not left ready', async (t) => {
  const { service, store, state } = harness(t);
  state.failSpawn = true;
  await assert.rejects(delegate(service, 'coord', 'spawn-fails'), (err) => err.code === 'terminal_unavailable');
  state.failSpawn = false;
  state.failWrite = true;
  await assert.rejects(delegate(service, 'coord', 'write-fails'), (err) => err.code === 'prompt_delivery_failed');

  const tasks = store.listTasks();
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((task) => task.status), ['failed', 'failed']);
});

test('⑧ settled workers cannot reset state, and only the run coordinator controls its loop', async (t) => {
  const { service, store, agentStatusStore } = harness(t);
  const w = await delegate(service, 'coord', 'impl');
  await service.workerDoneByPane(w.ptyId, { summary: 'done' });

  const reset = await http(service, 'reset', { messages: true }, w.ptyId);
  assert.equal(reset.status >= 400, true, 'a pane that has been a worker cannot reset global state');

  // Queued work with no allowed worker panes keeps the loop running for the checks below.
  const { run } = service.runCreate({ objective: 'loop', from: 'coord', paneId: 'coord' });
  store.createTask({ runId: run.id, spec: 'queued' });
  const started = await http(service, 'coordinator-start', { runId: run.id, workerPaneIds: [] }, 'coord');
  assert.equal(started.status, 200);
  agentStatusStore.registerPane('other', { agentId: 'codex' });
  for (const action of ['coordinator-stop', 'coordinator-tick']) {
    const res = await http(service, action, {}, 'other');
    assert.equal(res.status >= 400, true, `${action} from another terminal is rejected`);
  }
  assert.equal((await http(service, 'coordinator-start', { spec: 'x' }, w.ptyId)).status >= 400, true);
  assert.equal((await http(service, 'coordinator-stop', {}, 'coord')).status, 200);
});
