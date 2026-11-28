import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { TerminalRuntimeTracker } from '../dist-electron/terminal-runtime-tracker.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';

test('manual and automatic dispatch reject unknown directories, sibling worktrees and busy panes before writing', async t => {
  const root = mkdtempSync(join(tmpdir(), 'aha-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sibling = join(root, 'sibling');
  mkdirSync(sibling);
  const store = new OrchestrationStore();
  const agents = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  const writes = [];
  const service = new OrchestrationService({ store, agentStatusStore: agents, terminalTracker: tracker,
    getDefaultCwd: () => root, writePty: async (...args) => { writes.push(args); return { ok: true }; } });
  t.after(() => service.dispose());
  for (const id of ['coord', 'wrong', 'unknown', 'busy']) {
    agents.registerPane(id, { agentId: 'codex' });
    tracker.registerPty({ ptyId: id, cwd: id === 'unknown' ? undefined : id === 'wrong' ? sibling : root, cliId: 'codex' });
  }
  agents.ingestHookEvent({ ptyId: 'busy', state: 'working' });
  const run = service.runCreate({ objective: 'routing', from: 'coord', paneId: 'coord' }).run;
  const task = service.taskCreate({ runId: run.id, spec: 'A', worktreePath: root }).task;
  for (const id of ['wrong', 'unknown', 'busy']) await assert.rejects(service.dispatchTask({ taskId: task.id, from: 'coord', to: id }), { code: 'terminal_unavailable' });
  await service.coordinatorTick(run.id, { workerPaneIds: ['wrong', 'unknown', 'busy'] });
  assert.deepEqual(writes, []);
  assert.equal(store.listDispatches().length, 0);
});

test('history retains a kept worktree after release and deleting its record requires selecting that Run', () => {
  const store = new OrchestrationStore({ maxRuns: 1 });
  const run = store.createRun({ objective: 'retained', coordinatorHandle: 'coord' });
  const task = store.createTask({ runId: run.id, spec: 'work' });
  const dispatch = store.createDispatchContext({ taskId: task.id, assigneeHandle: 'worker', ownsWorktree: true, worktreePath: 'retained' });
  store.settleWorkerReport({ taskId: task.id, dispatchId: dispatch.id, outcome: 'completed' });
  store.markDispatchReleased(dispatch.id, { keepWorktree: true });
  store.updateRunStatus(run.id, 'completed');
  store.createRun({ objective: 'next', coordinatorHandle: 'coord' });
  assert.ok(store.getDispatchContext(dispatch.id));
  assert.ok(store.clearFinishedHistory().retained.some(r => r.id === run.id));
  store.markDispatchReleased(dispatch.id);
  store.updateRunIntegrationState(run.id, { integrationStatus: 'finalized', integrationWorktreePath: 'retained-integration-tree' });
  assert.ok(store.clearFinishedHistory().retained.some(r => r.id === run.id));
  assert.equal(store.clearFinishedHistory(run.id).removed.runs, 1);
  assert.equal(store.getDispatchContext(dispatch.id), undefined);
});

test('two code dependencies require both latest handoffs and cannot be claimed by a competing dispatch path', () => {
  const store = new OrchestrationStore();
  const run = store.createRun({ objective: 'multi', coordinatorHandle: 'coord' });
  const make = id => store.createTask({ id, runId: run.id, spec: id });
  const a = make('a'), c = make('c');
  const queue = { from: 'coord', state: 'waiting', coordinatorGeneration: 1, agent: 'codex', role: 'b', worktree: true, authorizeReviews: false };
  store.updateRunStatus(run.id, 'stopped');
  const b = store.createTask({ runId: run.id, spec: 'b', codeDeps: [a.id, c.id], queuedLaunch: queue });
  assert.equal(store.requireRun(run.id).status, 'active', 'newly approved work reopens the run');
  for (const parent of [a, c]) {
    const dispatch = store.createDispatchContext({ taskId: parent.id, assigneeHandle: parent.id });
    store.settleWorkerReport({ taskId: parent.id, dispatchId: dispatch.id, outcome: 'completed' });
    store.updateDispatchIntegrationState(dispatch.id, { integrationStatus: 'skipped' });
    store.promoteReadyTasks(run.id);
    assert.equal(store.getTask(b.id).status, 'pending');
    store.updateDispatchIntegrationState(dispatch.id, { integrationStatus: 'merged', integratedCommit: 'a'.repeat(40), noChanges: true });
    store.promoteReadyTasks(run.id);
  }
  assert.equal(store.getTask(b.id).status, 'ready');
  assert.throws(() => store.createDispatchContext({ taskId: b.id, assigneeHandle: 'other' }), { code: 'task_not_ready' });
});

test('an unknown delivery and an interrupted queue claim survive snapshot recovery without resending', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-handoff-restart-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = () => join(dir, 'state.json');
  const first = new OrchestrationStore({ resolveFile: file });
  const run = first.createRun({ coordinatorHandle: 'coord', objective: 'recover' });
  const a = first.createTask({ runId: run.id, spec: 'A' });
  const dispatch = first.createDispatchContext({ taskId: a.id, assigneeHandle: 'worker' });
  first.recordCodexDeliveryFailure(dispatch.id, 'unknown_acceptance');
  const b = first.createTask({ runId: run.id, spec: 'B', queuedLaunch: { state: 'claimed', from: 'coord', coordinatorGeneration: 1, role: 'other', agent: 'codex', worktree: true, authorizeReviews: false } });
  await first.waitForPendingWrite();
  first.close();
  const restored = new OrchestrationStore({ resolveFile: file });
  restored.load();
  const svc = new OrchestrationService({ store: restored, agentStatusStore: new AgentStatusStore(), writePty: async () => { throw Error('Unexpected duplicate write'); } });
  t.after(() => svc.dispose());
  svc.reconcileStaleDispatches();
  assert.equal(restored.getRun(run.id).status, 'active');
  assert.equal(restored.getDispatchContext(dispatch.id).stage, 'needs_reconciliation');
  assert.equal(restored.getTask(b.id).queuedLaunch.state, 'needs_reconciliation');
  assert.equal(restored.settleWorkerReport({ taskId: a.id, dispatchId: dispatch.id, outcome: 'completed', reportedByHandle: 'worker' }).action, 'settled');
});

test('board receipts advance independently, and unrelated posts cannot manufacture replies', () => {
  const store = new OrchestrationStore();
  const run = store.createRun({ objective: 'mail', coordinatorHandle: 'coord' });
  const post = store.insertMessage({ runId: run.id, from: 'coord', to: 'run:' + run.id, subject: 'constraints', mentions: ['one', 'two'], kind: 'post' });
  store.recordBoardReceipt([post.id], 'one', 'notified');
  store.recordBoardReceipt([post.id], 'two', 'delivered');
  store.insertMessage({ runId: run.id, from: 'two', fromRole: 'two', to: 'coord', kind: 'update', subject: 'for reference only', refs: [post.boardSeq] });
  assert.deepEqual(store.getMessageById(post.id).receipts, { one: 'notified', two: 'delivered' });
  store.recordBoardReceipt([post.id], 'one', 'replied');
  store.recordBoardReceipt([post.id], 'one', 'delivered');
  assert.equal(store.getMessageById(post.id).receipts.one, 'replied');
});
