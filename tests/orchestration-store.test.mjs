import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DISPATCH_CIRCUIT_BREAK_FAILURES,
  OrchestrationError,
  UNBOUND_RUN_ID,
} from '../dist-electron/orchestration/orchestration-types.js';
import { buildOrchestrationTaskDisplayMetadata } from '../dist-electron/orchestration/orchestration-task-display.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { reconcileLifecycleMessage } from '../dist-electron/orchestration/lifecycle-reconciliation.js';

test('run creation, binding, consumer generation fencing, and unbound run isolation', () => {
  const store = new OrchestrationStore();
  const r1 = store.createRun({
    id: 'run_alpha',
    objective: 'Build multi-agent orchestration',
    coordinatorHandle: 'pane-coord',
    coordinatorPaneId: 'pane-coord',
  });
  assert.equal(r1.id, 'run_alpha');
  assert.equal(r1.consumerGeneration, 1);
  assert.equal(store.getCurrentRunForConsumer('pane-coord')?.id, 'run_alpha');

  // Sending without explicit runId lazily creates unbound run without polluting listRuns.
  const unboundMsg = store.insertMessage({
    from: 'pane-a',
    to: 'pane-b',
    subject: 'Direct ping',
    body: 'Hello',
  });
  assert.equal(unboundMsg.runId, UNBOUND_RUN_ID);
  assert.deepEqual(
    store.listRuns().map((r) => r.id),
    ['run_alpha']
  );

  // Rebinding bumps consumerGeneration.
  const bound = store.bindRun({
    runId: 'run_alpha',
    coordinatorHandle: 'pane-coord-2',
    coordinatorPaneId: 'pane-coord-2',
  });
  assert.equal(bound?.consumerGeneration, 2);
  assert.equal(store.getCurrentRunForConsumer('pane-coord-2')?.id, 'run_alpha');
  assert.equal(store.bindRun({ runId: UNBOUND_RUN_ID, coordinatorHandle: 'x' }), null);
});

test('task DAG dependencies, diamond promotion, cycle/cross-run validation, and display metadata', () => {
  const meta = buildOrchestrationTaskDisplayMetadata({
    spec: `\n   \nImplement Foo Bar ${'x'.repeat(120)}\nSecond line`,
  });
  assert.ok(meta.taskTitle.length <= 80);
  assert.ok(meta.taskTitle.endsWith('...'));
  assert.equal(meta.displayName, meta.taskTitle);

  const store = new OrchestrationStore();
  const r1 = store.createRun({ id: 'r1', objective: 'Run 1', coordinatorHandle: 'coord' });
  const r2 = store.createRun({ id: 'r2', objective: 'Run 2', coordinatorHandle: 'coord2' });

  const tA = store.createTask({ id: 'tA', runId: r1.id, spec: 'Task A' });
  const tB = store.createTask({ id: 'tB', runId: r1.id, spec: 'Task B', deps: ['tA'] });
  const tC = store.createTask({ id: 'tC', runId: r1.id, spec: 'Task C', deps: ['tA'] });
  const tD = store.createTask({ id: 'tD', runId: r1.id, spec: 'Task D', deps: ['tB', 'tC'] });

  assert.equal(tA.status, 'ready');
  assert.equal(tB.status, 'pending');
  assert.equal(tC.status, 'pending');
  assert.equal(tD.status, 'pending');

  assert.throws(
    () => store.createTask({ id: 'tSelf', runId: r1.id, spec: 'Self cycle', deps: ['tSelf'] }),
    (err) => err instanceof OrchestrationError && err.code === 'task_cycle'
  );
  assert.throws(
    () => store.createTask({ id: 'tCross', runId: r2.id, spec: 'Cross run', deps: ['tA'] }),
    (err) => err instanceof OrchestrationError && err.code === 'invalid_argument'
  );
  assert.throws(
    () => store.createTask({ id: 'tMissing', runId: r1.id, spec: 'Missing', deps: ['nope'] }),
    (err) => err instanceof OrchestrationError && err.code === 'task_not_found'
  );

  store.updateTaskStatus('tA', 'completed');
  assert.equal(store.getTask('tB')?.status, 'ready');
  assert.equal(store.getTask('tC')?.status, 'ready');
  assert.equal(store.getTask('tD')?.status, 'pending');

  store.updateTaskStatus('tB', 'completed');
  assert.equal(store.getTask('tD')?.status, 'pending');

  store.updateTaskStatus('tC', 'completed');
  assert.equal(store.getTask('tD')?.status, 'ready');
});

test('dispatch claims, nested depth limit, failure retry accumulation, and 3-strike circuit breaker', () => {
  const store = new OrchestrationStore();
  const run = store.createRun({ id: 'run_cb', objective: 'Circuit test', coordinatorHandle: 'c' });
  const task = store.createTask({ id: 't1', runId: run.id, spec: 'Flaky task' });
  const task2 = store.createTask({ id: 't2', runId: run.id, spec: 'Second task' });

  const d1 = store.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'worker-1',
    assigneePaneId: 'worker-1',
  });
  assert.equal(d1.status, 'dispatched');
  assert.equal(d1.failureCount, 0);
  assert.equal(store.getTask(task.id)?.status, 'dispatched');

  // Same worker cannot take a second active dispatch while busy.
  assert.throws(
    () =>
      store.createDispatchContext({
        taskId: task2.id,
        assigneeHandle: 'worker-1',
        assigneePaneId: 'worker-1',
      }),
    (err) => err instanceof OrchestrationError && err.code === 'worker_busy'
  );

  // Fail attempt 1 -> retries (task -> ready).
  const f1 = store.failDispatch(d1.id, 'transient failure 1');
  assert.equal(f1.status, 'failed');
  assert.equal(f1.failureCount, 1);
  assert.equal(store.getTask(task.id)?.status, 'ready');

  // Depth exceeding maxDepth rejected.
  assert.throws(
    () =>
      store.createDispatchContext({
        taskId: task2.id,
        assigneeHandle: 'worker-2',
        creatorDispatchId: d1.id,
        maxDepth: 1,
      }),
    (err) => err instanceof OrchestrationError && err.code === 'operation_rejected'
  );

  // Attempt 2 starts with accumulated failureCount = 1.
  const d2 = store.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'worker-1',
    assigneePaneId: 'worker-1',
  });
  assert.equal(d2.failureCount, 1);
  const f2 = store.failDispatch(d2.id, 'transient failure 2');
  assert.equal(f2.status, 'failed');
  assert.equal(f2.failureCount, 2);
  assert.equal(store.getTask(task.id)?.status, 'ready');

  // Attempt 3 hits DISPATCH_CIRCUIT_BREAK_FAILURES (3) -> circuit_broken + task failed.
  const d3 = store.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'worker-1',
    assigneePaneId: 'worker-1',
  });
  assert.equal(d3.failureCount, 2);
  const f3 = store.failDispatch(d3.id, 'fatal failure 3');
  assert.equal(f3.failureCount, DISPATCH_CIRCUIT_BREAK_FAILURES);
  assert.equal(f3.status, 'circuit_broken');
  assert.equal(store.getTask(task.id)?.status, 'failed');
});

test('lifecycle reconciliation validates worker_done authority, idempotency, heartbeats, and rejections', () => {
  const store = new OrchestrationStore();
  const run = store.createRun({ id: 'run_lc', objective: 'Lifecycle test', coordinatorHandle: 'coord' });
  const t1 = store.createTask({ id: 't1', runId: run.id, spec: 'Step 1' });
  const t2 = store.createTask({ id: 't2', runId: run.id, spec: 'Step 2', deps: ['t1'] });
  const d1 = store.createDispatchContext({
    taskId: t1.id,
    assigneeHandle: 'worker-1',
    assigneePaneId: 'worker-1',
  });

  // Unauthorized sender rejected cleanly.
  const badSenderMsg = store.insertMessage({
    runId: run.id,
    from: 'rogue-pane',
    to: `run:${run.id}`,
    type: 'worker_done',
    subject: 'spoofed done',
    payload: JSON.stringify({ taskId: t1.id, dispatchId: d1.id, outcome: 'completed' }),
  });
  const badRes = reconcileLifecycleMessage(store, badSenderMsg);
  assert.equal(badRes.action, 'rejected');
  assert.ok(store.getMessageById(badSenderMsg.id)?.lifecycleRejectedReason);
  assert.equal(store.getTask(t1.id)?.status, 'dispatched');

  // Valid heartbeat is auto-read/delivered and updates lastHeartbeatAt.
  const hbMsg = store.insertMessage({
    runId: run.id,
    from: `dispatch:${d1.id}`,
    to: `run:${run.id}`,
    type: 'heartbeat',
    subject: 'hb',
    payload: JSON.stringify({ dispatchId: d1.id }),
  });
  assert.equal(hbMsg.read, true);
  assert.ok(hbMsg.deliveredAt !== null);
  assert.equal(reconcileLifecycleMessage(store, hbMsg).action, 'heartbeat');

  // Authorized worker_done settles dispatch & promotes t2.
  const doneMsg = store.insertMessage({
    runId: run.id,
    from: 'worker-1',
    to: `run:${run.id}`,
    type: 'worker_done',
    subject: 'done t1',
    payload: JSON.stringify({ taskId: t1.id, dispatchId: d1.id, outcome: 'completed' }),
  });
  const okRes = reconcileLifecycleMessage(store, doneMsg);
  assert.equal(okRes.action, 'settled');
  assert.equal(store.getDispatchContext(d1.id)?.status, 'completed');
  assert.equal(store.getTask(t1.id)?.status, 'completed');
  assert.equal(store.getTask(t2.id)?.status, 'ready');

  // Duplicate worker_done is idempotent.
  const dupMsg = store.insertMessage({
    runId: run.id,
    from: `dispatch:${d1.id}`,
    to: `run:${run.id}`,
    type: 'worker_done',
    subject: 'done t1 duplicate',
    payload: JSON.stringify({ taskId: t1.id, dispatchId: d1.id, outcome: 'completed' }),
  });
  assert.equal(reconcileLifecycleMessage(store, dupMsg).action, 'duplicate');
});

test('decision gates block tasks, settle active dispatches, and restore readiness only after all pending gates resolve', () => {
  const store = new OrchestrationStore();
  const run = store.createRun({ id: 'run_g', objective: 'Gate test', coordinatorHandle: 'coord' });
  const t1 = store.createTask({ id: 't1', runId: run.id, spec: 'Auth feature' });
  const d1 = store.createDispatchContext({
    taskId: t1.id,
    assigneeHandle: 'worker-1',
    assigneePaneId: 'worker-1',
  });
  const q = store.insertMessage({
    runId: run.id,
    from: `dispatch:${d1.id}`,
    to: `run:${run.id}`,
    type: 'question',
    subject: 'Q?',
    body: 'Which provider?',
  });
  store.createQuestion({
    messageId: q.id,
    runId: run.id,
    dispatchId: d1.id,
    fromHandle: `dispatch:${d1.id}`,
    toHandle: `run:${run.id}`,
    question: 'Which provider?',
  });

  const g1 = store.createGate({
    taskId: t1.id,
    question: 'Approve OAuth scopes?',
    options: ['read-only', 'full'],
    requesterDispatchId: d1.id,
  });
  const g2 = store.createGate({
    taskId: t1.id,
    question: 'Confirm secret storage location?',
  });

  assert.equal(store.getTask(t1.id)?.status, 'blocked');
  assert.equal(store.getDispatchContext(d1.id)?.status, 'completed');
  assert.equal(store.getQuestion(q.id)?.status, 'closed');

  // Resolving only g1 keeps task blocked due to g2.
  store.resolveGate(g1.id, 'read-only');
  assert.equal(store.getTask(t1.id)?.status, 'blocked');

  // Re-resolving g1 fails cleanly.
  assert.throws(
    () => store.resolveGate(g1.id, 'full'),
    (err) => err instanceof OrchestrationError && err.code === 'gate_already_resolved'
  );

  // Resolving g2 restores task -> ready.
  store.resolveGate(g2.id, 'keychain');
  assert.equal(store.getTask(t1.id)?.status, 'ready');
});

test('AtomicSnapshotWriter persists orchestration state across reload and recovers interrupted coordinator runs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-orch-store-'));
  try {
    const file = join(dir, 'orchestration-state.json');
    const store1 = new OrchestrationStore({ resolveFile: () => file });
    const run = store1.createRun({
      id: 'run_persist',
      objective: 'Persist me',
      coordinatorHandle: 'coord',
    });
    const t1 = store1.createTask({ id: 'task_1', runId: run.id, spec: 'Work' });
    store1.createCoordinatorRun({
      runId: run.id,
      spec: 'Run spec',
      coordinatorHandle: 'coord',
      pollIntervalMs: 250,
      maxConcurrent: 2,
    });
    store1.insertMessage({
      runId: run.id,
      from: 'coord',
      to: `run:${run.id}`,
      type: 'status',
      subject: 'Hello',
      body: 'World',
    });
    store1.close();

    const store2 = new OrchestrationStore({ resolveFile: () => file });
    store2.load();
    const snap = store2.getSnapshot(run.id);
    assert.equal(snap.runs.length, 1);
    assert.equal(snap.tasks.length, 1);
    assert.equal(snap.tasks[0].id, t1.id);
    assert.equal(snap.messages.length, 1);
    // Interrupted running coordinator run recovers to stopped so restarts never lock out new runs.
    assert.equal(snap.activeCoordinatorRun, null);
    assert.equal(snap.coordinatorRuns[0]?.status, 'stopped');
    store2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runUse fences old consumerGeneration deliveries and lets new coordinator take unread mail', () => {
  const store = new OrchestrationStore();
  const run = store.createRun({
    id: 'run_fence',
    objective: 'Fencing test',
    coordinatorHandle: 'coord-1',
    coordinatorPaneId: 'coord-1',
  });
  const msg = store.insertMessage({
    runId: run.id,
    from: 'worker-1',
    to: `run:${run.id}`,
    type: 'status',
    subject: 'Progress',
    body: 'Half done',
  });

  // Generation 1 coordinator holds ack on batch.
  const gen1Batch = store.takeMailboxDelivery({
    runId: run.id,
    mailboxHandle: `run:${run.id}`,
    consumerGeneration: 1,
    holdAck: true,
  });
  assert.ok(gen1Batch);
  assert.equal(gen1Batch.delivery.status, 'pending');

  // New coordinator binds run -> bumps consumerGeneration to 2 and fences gen-1 delivery.
  const rebound = store.bindRun({
    runId: run.id,
    coordinatorHandle: 'coord-2',
    coordinatorPaneId: 'coord-2',
  });
  assert.equal(rebound?.consumerGeneration, 2);
  assert.equal(store.getCurrentRunForConsumer('coord-1'), undefined);
  assert.equal(store.getDelivery(gen1Batch.delivery.id)?.status, 'fenced');
  assert.equal(store.getMessageById(msg.id)?.deliveredAt, null);

  // Evicted gen-1 consumer cannot ack or take under gen 1.
  assert.throws(
    () => store.acknowledgeDelivery(gen1Batch.delivery.id, `run:${run.id}`, 1),
    (err) => err instanceof OrchestrationError && err.code === 'consumer_fenced'
  );
  assert.throws(
    () =>
      store.takeMailboxDelivery({
        runId: run.id,
        mailboxHandle: `run:${run.id}`,
        consumerGeneration: 1,
      }),
    (err) => err instanceof OrchestrationError && err.code === 'consumer_fenced'
  );

  // Generation 2 consumer cleanly reads and acknowledges the unread message.
  const gen2Batch = store.takeMailboxDelivery({
    runId: run.id,
    mailboxHandle: `run:${run.id}`,
    consumerGeneration: 2,
  });
  assert.ok(gen2Batch);
  assert.equal(gen2Batch.messages.length, 1);
  assert.equal(gen2Batch.messages[0].id, msg.id);
});
