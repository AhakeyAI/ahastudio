import test from 'node:test';
import { createTrackedTestService } from './fixtures/tracked-orchestration-service.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { Coordinator } from '../dist-electron/orchestration/coordinator.js';
import { resolveDefaultOrchestrationCliPath } from '../dist-electron/orchestration/orchestration-bin-shim.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';

const require = createRequire(import.meta.url);
const cliModule = require('../electron/orchestration/aha-orchestration-cli.cjs');

function makeTempDir(prefix = 'aha-orch-fix-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

function removeTempDir(dir) {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
}

function createHarness(opts = {}) {
  const dir = makeTempDir();
  const store = OrchestrationStore.forUserDataDir(() => dir);
  const agentStatusStore = new AgentStatusStore();
  const writes = [];
  const exited = new Set();

  const service = createTrackedTestService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      if (opts.writePty) {
        return opts.writePty(ptyId, data);
      }
      writes.push({ ptyId, data });
      return { ok: true };
    },
    isPtyAlive: opts.isPtyAlive,
    cliCommand: opts.cliCommand ?? 'aha',
  });

  const registerIdlePane = (ptyId, agentId = 'claude') => {
    agentStatusStore.registerPane(ptyId, { agentId });
    // Ensure pane settles into idle/done state for pointer notifications.
    agentStatusStore.ingestHookEvent({ ptyId, agentId, state: 'working' });
    agentStatusStore.ingestHookEvent({ ptyId, agentId, state: 'idle' });
  };

  return {
    dir,
    store,
    agentStatusStore,
    service,
    writes,
    exited,
    registerIdlePane,
    cleanup: () => {
      service.dispose();
      removeTempDir(dir);
    },
  };
}

function runCliSubprocess(cliPath, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', rejectRun);
    child.on('close', (code) => {
      resolveRun({ code, stdout, stderr });
    });
  });
}

// ==================== Fix 1: taskShow & coordinatorStatus ====================

test('Fix 1: taskShow and coordinatorStatus work via Service, HTTP router, Preload, IPC, and CLI', async () => {
  const h = createHarness();
  let server;
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    const { run } = h.service.runCreate({ id: 'run_show_1', objective: 'Ship fixes', from: 'coord-1' });
    const { task: t1 } = h.service.taskCreate({ id: 'task_a', runId: run.id, spec: 'Step A' });
    const { task: t2 } = h.service.taskCreate({
      id: 'task_b',
      runId: run.id,
      spec: 'Step B',
      deps: [t1.id],
    });
    await h.service.dispatchTask({ taskId: t1.id, to: 'worker-1', from: 'coord-1' });
    h.service.gateCreate({ taskId: t2.id, question: 'Approve step B?', options: ['yes', 'no'] });

    // Service direct calls
    const shown = h.service.taskShow({ id: t1.id });
    assert.equal(shown.task.id, t1.id);
    assert.equal(shown.task.status, 'dispatched');
    assert.ok(shown.latestDispatch);
    assert.equal(shown.dispatches.length, 1);

    const shownB = h.service.taskShow(t2.id);
    assert.equal(shownB.gates.length, 1);
    assert.equal(shownB.task.status, 'blocked');

    const idleCoordStatus = h.service.coordinatorStatus({ runId: run.id });
    assert.equal(idleCoordStatus.running, false);
    assert.equal(idleCoordStatus.runId, run.id);
    assert.equal(idleCoordStatus.taskCounts.total, 2);
    assert.equal(idleCoordStatus.taskCounts.dispatched, 1);
    assert.equal(idleCoordStatus.taskCounts.blocked, 1);
    assert.equal(idleCoordStatus.activeDispatches, 1);
    assert.equal(idleCoordStatus.pendingGates, 1);

    // Start coordinator and verify active status
    h.service.coordinatorStart({ runId: run.id, from: 'coord-1', pollIntervalMs: 5000 });
    const runningCoordStatus = h.service.coordinatorStatus();
    assert.equal(runningCoordStatus.running, true);
    assert.equal(runningCoordStatus.runId, run.id);
    assert.equal(runningCoordStatus.coordinatorRun?.status, 'running');

    // HTTP router dispatch + real loopback CLI execution
    server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => {
        const action = (req.url || '').replace(/^\/orchestration\//, '').split('?')[0];
        const raw = chunks.length > 0 ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        const out = await dispatchOrchestrationHttpAction(h.service, action, raw, {});
        res.statusCode = out.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(out.body));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    const cliPath = resolveDefaultOrchestrationCliPath();

    const taskShowCli = await runCliSubprocess(
      cliPath,
      ['orchestration', 'task', 'show', t1.id, '--json=true'],
      { AHA_ORCHESTRATION_URL: `http://127.0.0.1:${port}/orchestration` }
    );
    assert.equal(taskShowCli.code, 0, taskShowCli.stderr);
    const taskShowJson = JSON.parse(taskShowCli.stdout);
    assert.equal(taskShowJson.task.id, t1.id);
    assert.equal(taskShowJson.dispatches.length, 1);

    const coordStatusCli = await runCliSubprocess(
      cliPath,
      ['orchestration', 'coordinator', 'status', `--run=${run.id}`, '--json'],
      { AHA_ORCHESTRATION_URL: `http://127.0.0.1:${port}/orchestration` }
    );
    assert.equal(coordStatusCli.code, 0, coordStatusCli.stderr);
    const coordStatusJson = JSON.parse(coordStatusCli.stdout);
    assert.equal(coordStatusJson.running, true);
    assert.equal(coordStatusJson.runId, run.id);

    // Preload & IPC channel wiring check
    const preloadSrc = readFileSync(resolve('electron/preload.cjs'), 'utf8');
    const ipcSrc = readFileSync(resolve('electron/ipc/orchestration.ts'), 'utf8');
    assert.match(preloadSrc, /taskShow:.*orchestration:task-show/);
    assert.match(preloadSrc, /coordinatorStatus:.*orchestration:coordinator-status/);
    assert.match(ipcSrc, /'orchestration:task-show'/);
    assert.match(ipcSrc, /'orchestration:coordinator-status'/);
  } finally {
    if (server) {
      await new Promise((r) => server.close(r));
    }
    h.cleanup();
  }
});

// ==================== Fix 2: reconcileExitedDispatches run scoping ====================

test('Fix 2: Coordinator.reconcileExitedDispatches only fails dispatches in the target runId (no cross-run bleed)', async () => {
  const dir = makeTempDir();
  try {
    const store = OrchestrationStore.forUserDataDir(() => dir);
    const r1 = store.createRun({ id: 'run_1', objective: 'Run 1', coordinatorHandle: 'coord-1' });
    const r2 = store.createRun({ id: 'run_2', objective: 'Run 2', coordinatorHandle: 'coord-2' });
    const t1 = store.createTask({ id: 't_r1', runId: r1.id, spec: 'R1 work' });
    const t2 = store.createTask({ id: 't_r2', runId: r2.id, spec: 'R2 work' });

    const d1 = store.createDispatchContext({
      taskId: t1.id,
      assigneeHandle: 'worker-1',
      assigneePaneId: 'worker-1',
      creator: 'coord-1',
      creatorRunId: r1.id,
    });
    const d2 = store.createDispatchContext({
      taskId: t2.id,
      assigneeHandle: 'worker-2',
      assigneePaneId: 'worker-2',
      creator: 'coord-2',
      creatorRunId: r2.id,
    });

    const exited = new Set(['worker-1', 'worker-2']);
    const runtime = {
      listWorkerCandidates: () => [],
      isPaneAlive: (ptyId) => !exited.has(ptyId),
      hasPaneExited: (ptyId) => exited.has(ptyId),
      sendTurn: async () => ({ ok: true }),
      notifyStateChanged: () => {},
    };

    const coordinatorRun1 = new Coordinator(store, runtime, {
      runId: r1.id,
      spec: r1.objective,
      coordinatorHandle: 'coord-1',
      autoSpawnWorkers: false,
    });

    await coordinatorRun1.tick();

    assert.equal(store.getDispatchContext(d1.id)?.status, 'failed');
    assert.equal(store.requireTask(t1.id).status, 'ready');
    // Crucial: run_2's exited worker-2 MUST NOT be touched by run_1's tick!
    assert.equal(store.getDispatchContext(d2.id)?.status, 'dispatched');
    assert.equal(store.requireTask(t2.id).status, 'dispatched');
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

// ==================== Fix 3: dispatchTask rollback & typed errors ====================

test('Fix 3: dispatchTask rolls back dispatch and throws prompt_delivery_failed when write fails on live pane', async () => {
  const h = createHarness({
    writePty: async () => ({ ok: false, error: 'Write buffer full' }),
  });
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    const { run } = h.service.runCreate({ objective: 'Rollback test', from: 'coord-1' });
    const { task } = h.service.taskCreate({ runId: run.id, spec: 'Task prompt' });

    await assert.rejects(
      () => h.service.dispatchTask({ taskId: task.id, to: 'worker-1', from: 'coord-1' }),
      (err) => err.code === 'prompt_delivery_failed'
    );

    const updatedTask = h.store.requireTask(task.id);
    assert.equal(updatedTask.status, 'ready');
    const latestDispatch = h.store.getLatestDispatchForTask(task.id);
    assert.equal(latestDispatch?.status, 'failed');
    assert.match(latestDispatch?.lastFailureReason ?? '', /Write buffer full/);
  } finally {
    h.cleanup();
  }
});

test('Fix 3: dispatchTask rolls back dispatch and throws terminal_unavailable when pane dies during delivery', async () => {
  let alive = true;
  const h = createHarness({
    isPtyAlive: (ptyId) => (ptyId === 'worker-1' ? alive : true),
    writePty: async () => {
      alive = false;
      return { ok: false, error: 'PTY session closed' };
    },
  });
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    const { run } = h.service.runCreate({ objective: 'Unavailable terminal', from: 'coord-1' });
    const { task } = h.service.taskCreate({ runId: run.id, spec: 'Task prompt' });

    await assert.rejects(
      () => h.service.dispatchTask({ taskId: task.id, to: 'worker-1', from: 'coord-1' }),
      (err) => err.code === 'terminal_unavailable'
    );

    assert.equal(h.store.requireTask(task.id).status, 'ready');
    assert.equal(h.store.getLatestDispatchForTask(task.id)?.status, 'failed');
  } finally {
    h.cleanup();
  }
});

// ==================== Fix 4: MailboxPointerDelivery broadcast, preemption & stop ====================

test('Fix 4: MailboxPointerDelivery resolves @workers, @all, and run:<id> target panes independently', async () => {
  const dir = makeTempDir();
  const pointerWrites = [];
  const store = OrchestrationStore.forUserDataDir(() => dir);
  const agentStatusStore = new AgentStatusStore();
  try {
    agentStatusStore.registerPane('coord-1', { agentId: 'claude' });
    agentStatusStore.registerPane('coord-2', { agentId: 'claude' });
    agentStatusStore.registerPane('worker-1', { agentId: 'codex' });
    agentStatusStore.registerPane('worker-2', { agentId: 'codex' });
    for (const id of ['coord-1', 'coord-2', 'worker-1', 'worker-2']) {
      agentStatusStore.ingestHookEvent({ ptyId: id, agentId: 'claude', state: 'idle' });
    }

    const run = store.createRun({
      id: 'run_bcast',
      objective: 'Broadcast target panes',
      coordinatorHandle: 'coord-1',
      coordinatorPaneId: 'coord-1',
    });
    store.bindRun({
      runId: run.id,
      coordinatorHandle: 'coord-2',
      coordinatorPaneId: 'coord-2',
    });
    const t1 = store.createTask({ runId: run.id, spec: 'Task 1' });
    const t2 = store.createTask({ runId: run.id, spec: 'Task 2' });
    store.createDispatchContext({
      taskId: t1.id,
      assigneeHandle: 'worker-1',
      assigneePaneId: 'worker-1',
      creator: 'coord-2',
      creatorRunId: run.id,
    });
    store.createDispatchContext({
      taskId: t2.id,
      assigneeHandle: 'worker-2',
      assigneePaneId: 'worker-2',
      creator: 'coord-2',
      creatorRunId: run.id,
    });

    const service = createTrackedTestService({
      store,
      agentStatusStore,
      writePty: async (ptyId, data) => {
        pointerWrites.push({ ptyId, data });
        return { ok: true };
      },
    });

    // resolvePanesForMailbox covers @workers, @all, and run:<id>
    const workerPanes = service.pointerDelivery.resolvePanesForMailbox('@workers').sort();
    assert.deepEqual(workerPanes, ['worker-1', 'worker-2']);

    const allPanes = service.pointerDelivery.resolvePanesForMailbox('@all').sort();
    assert.ok(allPanes.includes('coord-2'));
    assert.ok(allPanes.includes('worker-1'));
    assert.ok(allPanes.includes('worker-2'));

    assert.ok(service.pointerDelivery.resolvePanesForMailbox(`run:${run.id}`).includes('coord-2'));

    // Broadcast message inserted to @workers notifies BOTH worker panes (not coord)
    store.insertMessage({
      runId: run.id,
      from: 'coord-2',
      to: '@workers',
      subject: 'Sync',
      body: 'Rebase onto main',
    });
    await service.pointerDelivery.flushPane('worker-1');
    await service.pointerDelivery.flushPane('worker-2');
    await service.pointerDelivery.flushPane('coord-2');

    const notifiedPayloads = pointerWrites.filter((w) => w.data !== '\r').map((w) => w.ptyId);
    assert.equal(notifiedPayloads.filter((id) => id === 'worker-1').length, 1);
    assert.equal(notifiedPayloads.filter((id) => id === 'worker-2').length, 1);
    assert.equal(pointerWrites.some((w) => w.ptyId === 'coord-1'), false);
    assert.equal(pointerWrites.some((w) => w.ptyId === 'coord-2'), false);

    // dispose() calls pointerDelivery.stop() and clears pending timers
    service.pointerDelivery.scheduleRedriveForPane('worker-1');
    let stopCalled = false;
    const origStop = service.pointerDelivery.stop.bind(service.pointerDelivery);
    service.pointerDelivery.stop = () => {
      stopCalled = true;
      origStop();
    };
    service.dispose();
    assert.equal(stopCalled, true);
  } finally {
    removeTempDir(dir);
  }
});

test('Fix 4: check --wait preemption cleans up waiters on run switch and PTY exit without cross-consumer bleed', async () => {
  const h = createHarness();
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('coord-2');
    h.registerIdlePane('worker-1');
    const { run: run1 } = h.service.runCreate({ id: 'run_w1', objective: 'Run 1', from: 'coord-1' });
    const { run: run2 } = h.service.runCreate({ id: 'run_w2', objective: 'Run 2', from: 'coord-2' });

    const waitC1 = h.service.check({ from: 'coord-1', runId: run1.id, wait: true, timeoutMs: 10_000 });
    const waitC2 = h.service.check({ from: 'coord-2', runId: run1.id, wait: true, timeoutMs: 10_000 });
    const waitW1 = h.service.check({ from: 'worker-1', wait: true, timeoutMs: 10_000 });

    assert.equal(h.service.waiters.getWaiters(`run:${run1.id}`)?.size, 2);

    // Preempt coord-1 by binding to run2 -> cancels only coord-1's waiter, not coord-2!
    h.service.runUse({ id: run2.id, from: 'coord-1' });
    const resC1 = await waitC1;
    assert.equal(resC1.cancelled, true);
    assert.equal(h.service.waiters.getWaiters(`run:${run1.id}`)?.size, 1);

    // Preempt worker-1 by marking PTY exited -> cancels worker-1 waiter immediately
    h.service.markPtyExited('worker-1');
    const resW1 = await waitW1;
    assert.equal(resW1.cancelled, true);
    assert.equal(h.service.waiters.getWaiters('worker-1'), undefined);

    // Remaining coord-2 waiter can still receive messages
    h.service.send({ from: 'worker-1', to: `run:${run1.id}`, subject: 'Update', body: 'Still here' });
    const resC2 = await waitC2;
    assert.equal(resC2.count, 1);
    assert.equal(resC2.messages[0].subject, 'Update');
  } finally {
    h.cleanup();
  }
});

// ==================== Fix 5: ask --wait vs immediate reply race & auto-ack ====================

test('Fix 5: ask({ wait: true }) vs immediate synchronous reply prevents duplicate wake/pointer and auto-acks reply', async () => {
  const h = createHarness();
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    const { run } = h.service.runCreate({ objective: 'Ask race', from: 'coord-1' });
    const { task } = h.service.taskCreate({ runId: run.id, spec: 'Do work' });
    const { dispatch } = await h.service.dispatchTask({
      taskId: task.id,
      to: 'worker-1',
      from: 'coord-1',
    });

    h.writes.length = 0;

    let wokeImmediately = false;
    const disposeListener = h.service.onEvent((event) => {
      if (event.reason === 'question:asked') {
        const q = h.store.listQuestions({ runId: run.id })[0];
        const waitHandle = `question:${q.dispatchId}:${q.messageId}`;
        // Crucial: pre-registered waiter is ALREADY present when question:asked fires!
        assert.ok((h.service.waiters.getWaiters(waitHandle)?.size ?? 0) >= 1);
        wokeImmediately = true;
        h.service.reply({ id: q.messageId, body: 'Proceed with plan B', from: 'coord-1' });
      }
    });

    const answerRes = await h.service.ask({
      from: 'worker-1',
      question: 'Plan A or B?',
      wait: true,
      timeoutMs: 2000,
    });
    disposeListener();

    assert.equal(wokeImmediately, true);
    assert.equal(answerRes.pending, false);
    assert.equal(answerRes.answer, 'Proceed with plan B');
    assert.ok(answerRes.answerMessageId);

    // Reply message is marked both read and delivered so worker mailbox check stays clean
    const replyMsg = h.store.getMessageById(answerRes.answerMessageId);
    assert.equal(replyMsg?.read, true);
    assert.notEqual(replyMsg?.deliveredAt, null);

    const postAskCheck = await h.service.check({ from: 'worker-1' });
    assert.equal(postAskCheck.count, 0);

    // No stray pointer delivery queued to dispatch mailbox because reply woke pre-registered waiter
    assert.equal(h.writes.some((w) => w.ptyId === 'worker-1'), false);
    void dispatch;
  } finally {
    h.cleanup();
  }
});

test('Fix 5: held reply/question deliveries are automatically acknowledged when resolved via ask --resume / reply', async () => {
  const h = createHarness();
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    const { run } = h.service.runCreate({ objective: 'Auto ack', from: 'coord-1' });
    const { task } = h.service.taskCreate({ runId: run.id, spec: 'Work' });
    await h.service.dispatchTask({ taskId: task.id, to: 'worker-1', from: 'coord-1' });

    const pendingAsk = await h.service.ask({
      from: 'worker-1',
      question: 'Need approval?',
      wait: false,
    });

    // Coordinator reads the question with holdAck: true
    const heldQ = await h.service.check({ from: 'coord-1', runId: run.id, holdAck: true });
    assert.equal(heldQ.count, 1);
    assert.ok(heldQ.deliveryId);

    // Coordinator replies -> held question delivery should auto-acknowledge
    h.service.reply({ id: pendingAsk.messageId, body: 'Approved', from: 'coord-1' });
    assert.equal(h.store.getDelivery(heldQ.deliveryId)?.status, 'acknowledged');

    // Suppose worker also had a held delivery containing the reply message
    const heldReply = await h.service.check({ from: 'worker-1', holdAck: true });
    assert.equal(heldReply.count, 1);
    assert.ok(heldReply.deliveryId);

    // Worker calls ask --resume -> consumes reply & auto-acknowledges held delivery
    const resumed = await h.service.ask({
      from: 'worker-1',
      resume: pendingAsk.messageId,
      wait: true,
    });
    assert.equal(resumed.answer, 'Approved');
    assert.equal(h.store.getDelivery(heldReply.deliveryId)?.status, 'acknowledged');
  } finally {
    h.cleanup();
  }
});

// ==================== Fix 6: Per-consumer broadcast isolation & --ack ownership ====================

test('Fix 6: run:<id> per-consumer isolation prevents consumers from consuming or stealing each other deliveries', async () => {
  const h = createHarness();
  try {
    const { run } = h.service.runCreate({ id: 'run_iso', objective: 'Iso test', from: 'coord-1' });
    h.service.send({
      from: 'worker-1',
      to: `run:${run.id}`,
      subject: 'Shared status',
      body: 'Event #1',
    });

    // Consumer 1 reads with holdAck -> gets own delivery
    const check1 = await h.service.check({ from: 'coord-1', runId: run.id, holdAck: true });
    assert.equal(check1.count, 1);
    assert.ok(check1.deliveryId);

    // Consumer 2 MUST still see the message independently (not consumed by coord-1!)
    const check2 = await h.service.check({ from: 'coord-2', runId: run.id, holdAck: true });
    assert.equal(check2.count, 1);
    assert.ok(check2.deliveryId);
    assert.notEqual(check2.deliveryId, check1.deliveryId);

    // Consumer 2 cannot --ack Consumer 1's delivery -> delivery_not_found
    await assert.rejects(
      () => h.service.check({ from: 'coord-2', runId: run.id, ack: check1.deliveryId }),
      (err) => err.code === 'delivery_not_found'
    );

    // Missing deliveryId -> delivery_not_found
    await assert.rejects(
      () => h.service.check({ from: 'coord-1', runId: run.id, ack: 'dlv_nonexistent' }),
      (err) => err.code === 'delivery_not_found'
    );

    // Each consumer can ack its own delivery and afterwards sees 0 unread
    await h.service.check({ from: 'coord-1', runId: run.id, ack: check1.deliveryId });
    const afterAck1 = await h.service.check({ from: 'coord-1', runId: run.id });
    assert.equal(afterAck1.count, 0);

    // Consumer 2 still owns check2.deliveryId until coord-2 acks it
    const replay2 = await h.service.check({ from: 'coord-2', runId: run.id, holdAck: true });
    assert.equal(replay2.replayed, true);
    assert.equal(replay2.deliveryId, check2.deliveryId);
    await h.service.check({ from: 'coord-2', runId: run.id, ack: check2.deliveryId });
    const afterAck2 = await h.service.check({ from: 'coord-2', runId: run.id });
    assert.equal(afterAck2.count, 0);
  } finally {
    h.cleanup();
  }
});

test('Fix 6: @workers broadcast per-consumer isolation and ownership check on --ack', async () => {
  const h = createHarness();
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    h.registerIdlePane('worker-2');
    const { run } = h.service.runCreate({ objective: 'Workers iso', from: 'coord-1' });
    const { task: t1 } = h.service.taskCreate({ runId: run.id, spec: 'Task 1' });
    const { task: t2 } = h.service.taskCreate({ runId: run.id, spec: 'Task 2' });
    await h.service.dispatchTask({ taskId: t1.id, to: 'worker-1', from: 'coord-1' });
    await h.service.dispatchTask({ taskId: t2.id, to: 'worker-2', from: 'coord-1' });

    // Broadcast message inserted to @workers
    h.store.insertMessage({
      runId: run.id,
      from: 'coord-1',
      to: '@workers',
      subject: 'Cluster notice',
      body: 'Pause pushes',
    });

    const w1Check = await h.service.check({ from: 'worker-1', holdAck: true });
    assert.equal(w1Check.count, 1);
    assert.ok(w1Check.deliveryId);

    const w2Check = await h.service.check({ from: 'worker-2', holdAck: true });
    assert.equal(w2Check.count, 1);
    assert.ok(w2Check.deliveryId);
    assert.notEqual(w2Check.deliveryId, w1Check.deliveryId);

    // worker-2 cannot ack worker-1's @workers delivery
    await assert.rejects(
      () => h.service.check({ from: 'worker-2', ack: w1Check.deliveryId }),
      (err) => err.code === 'delivery_not_found'
    );

    // worker-1 can ack its own @workers delivery; worker-2's remains pending until acked
    const ack1 = await h.service.check({ from: 'worker-1', ack: w1Check.deliveryId });
    assert.equal(ack1.acknowledged, w1Check.deliveryId);
    assert.equal(h.store.getDelivery(w2Check.deliveryId)?.status, 'pending');
    await h.service.check({ from: 'worker-2', ack: w2Check.deliveryId });
    assert.equal(h.store.getDelivery(w2Check.deliveryId)?.status, 'acknowledged');
  } finally {
    h.cleanup();
  }
});

// ==================== Fix 7: DAG cycles, duplicates, cascade, CLI flags, asar ====================

test('Fix 7: createRun and createTask reject duplicate IDs with duplicate_run / duplicate_task', () => {
  const dir = makeTempDir();
  try {
    const store = OrchestrationStore.forUserDataDir(() => dir);
    store.createRun({ id: 'run_dup', objective: 'First', coordinatorHandle: 'coord' });
    assert.throws(
      () => store.createRun({ id: 'run_dup', objective: 'Second', coordinatorHandle: 'coord' }),
      (err) => err.code === 'duplicate_run'
    );

    store.createTask({ id: 'task_dup', runId: 'run_dup', spec: 'Task 1' });
    assert.throws(
      () => store.createTask({ id: 'task_dup', runId: 'run_dup', spec: 'Task 2' }),
      (err) => err.code === 'duplicate_task'
    );
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test('Fix 7: createTask detects multi-hop cyclic_dependency while permitting valid diamond DAGs', () => {
  const dir = makeTempDir();
  try {
    const stateFile = join(dir, 'orchestration-state.json');
    const now = new Date().toISOString();
    // Seed a 3-hop chain fragment t1 -> t3 and t2 -> t1 persisted on disk
    writeFileSync(
      stateFile,
      JSON.stringify({
        version: 1,
        nextSequence: 1,
        currentRunByConsumer: {},
        runs: [
          {
            id: 'run_dag',
            objective: 'DAG',
            status: 'active',
            coordinatorHandle: 'coord',
            coordinatorPaneId: null,
            consumerGeneration: 1,
            createdAt: now,
            updatedAt: now,
            endedAt: null,
          },
        ],
        tasks: [
          {
            id: 't1',
            runId: 'run_dag',
            spec: 'Step 1',
            taskTitle: 'Step 1',
            displayName: 'Step 1',
            deps: ['t3'],
            priority: 'normal',
            status: 'pending',
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 't2',
            runId: 'run_dag',
            spec: 'Step 2',
            taskTitle: 'Step 2',
            displayName: 'Step 2',
            deps: ['t1'],
            priority: 'normal',
            status: 'pending',
            worktreePath: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        dispatches: [],
        gates: [],
        messages: [],
        deliveries: [],
        questions: [],
        coordinatorRuns: [],
      }),
      'utf8'
    );

    const store = OrchestrationStore.forUserDataDir(() => dir);
    // Closing the 3-hop cycle t3 -> t2 -> t1 -> t3 MUST fail with cyclic_dependency
    assert.throws(
      () => store.createTask({ id: 't3', runId: 'run_dag', spec: 'Step 3', deps: ['t2'] }),
      (err) => err.code === 'cyclic_dependency'
    );

    // Diamond DAG must succeed without false positive
    const root = store.createTask({ id: 'd_root', runId: 'run_dag', spec: 'Root' });
    const left = store.createTask({ id: 'd_left', runId: 'run_dag', spec: 'Left', deps: [root.id] });
    const right = store.createTask({
      id: 'd_right',
      runId: 'run_dag',
      spec: 'Right',
      deps: [root.id],
    });
    const joinTask = store.createTask({
      id: 'd_join',
      runId: 'run_dag',
      spec: 'Join',
      deps: [left.id, right.id],
    });
    assert.equal(joinTask.status, 'pending');
    store.close();
  } finally {
    removeTempDir(dir);
  }
});

test('Fix 7: taskUpdate cascades ready promotion to downstream dependent tasks', () => {
  const h = createHarness();
  try {
    const { run } = h.service.runCreate({ objective: 'Cascade DAG', from: 'coord-1' });
    const { task: t1 } = h.service.taskCreate({ id: 't_1', runId: run.id, spec: 'Step 1' });
    const { task: t2 } = h.service.taskCreate({
      id: 't_2',
      runId: run.id,
      spec: 'Step 2',
      deps: [t1.id],
    });
    const { task: t3 } = h.service.taskCreate({
      id: 't_3',
      runId: run.id,
      spec: 'Step 3',
      deps: [t2.id],
    });
    const { task: t4 } = h.service.taskCreate({
      id: 't_4',
      runId: run.id,
      spec: 'Step 4',
      deps: [t1.id, t2.id],
    });

    assert.equal(t1.status, 'ready');
    assert.equal(t2.status, 'pending');
    assert.equal(t3.status, 'pending');
    assert.equal(t4.status, 'pending');

    h.service.taskUpdate({ id: t1.id, status: 'completed' });
    assert.equal(h.store.requireTask(t2.id).status, 'ready');
    assert.equal(h.store.requireTask(t3.id).status, 'pending');
    assert.equal(h.store.requireTask(t4.id).status, 'pending');

    h.service.taskUpdate({ id: t2.id, status: 'completed' });
    assert.equal(h.store.requireTask(t3.id).status, 'ready');
    assert.equal(h.store.requireTask(t4.id).status, 'ready');
  } finally {
    h.cleanup();
  }
});

test('Fix 7: CLI parses --flag=value syntax including booleans and values containing =', () => {
  const parsedTaskShow = cliModule.parseCliArgs([
    'orchestration',
    'task',
    'show',
    '--id=task_abc',
    '--json=false',
    '--full=true',
  ]);
  assert.equal(parsedTaskShow.verb, 'task-show');
  assert.equal(parsedTaskShow.flags.id, 'task_abc');
  assert.equal(parsedTaskShow.flags.json, false);
  assert.equal(parsedTaskShow.flags.full, true);

  const builtTaskShow = cliModule.buildPayload(
    parsedTaskShow.verb,
    parsedTaskShow.flags,
    parsedTaskShow.positional
  );
  assert.deepEqual(builtTaskShow, {
    action: 'task-show',
    payload: { id: 'task_abc', receiptText: true, full: true },
  });

  const parsedSend = cliModule.parseCliArgs([
    'orchestration',
    'send',
    '--from=worker-1',
    '--to=@workers',
    '--subject=a=b=c',
    '--body=',
    '--wait=true',
  ]);
  assert.equal(parsedSend.flags.from, 'worker-1');
  assert.equal(parsedSend.flags.to, '@workers');
  assert.equal(parsedSend.flags.subject, 'a=b=c');
  assert.equal(parsedSend.flags.body, '');
  assert.equal(parsedSend.flags.wait, true);

  const parsedCoordStatus = cliModule.parseCliArgs([
    'coordinator',
    'status',
    '--run-id=run_xyz',
    '--json=true',
  ]);
  assert.equal(parsedCoordStatus.verb, 'coordinator-status');
  const builtStatus = cliModule.buildPayload(
    parsedCoordStatus.verb,
    parsedCoordStatus.flags,
    parsedCoordStatus.positional
  );
  assert.deepEqual(builtStatus, {
    action: 'coordinator-status',
    payload: { runId: 'run_xyz', receiptText: false, full: false },
  });
});

test('Fix 7: resolveDefaultOrchestrationCliPath resolves app.asar.unpacked paths and dev path', () => {
  const defaultPath = resolveDefaultOrchestrationCliPath();
  assert.equal(defaultPath.endsWith('aha-orchestration-cli.cjs'), true);

  const winAsarUrl =
    'file:///C:/Program%20Files/AhaStation/resources/app.asar/dist-electron/orchestration/orchestration-bin-shim.js';
  const winResolved = resolveDefaultOrchestrationCliPath(winAsarUrl);
  assert.ok(winResolved.includes('app.asar.unpacked'), `Expected app.asar.unpacked in ${winResolved}`);
  assert.equal(winResolved.includes('app.asar\\dist') || winResolved.includes('app.asar/dist'), false);

  const posixAsarPath = '/opt/AhaStation/resources/app.asar/dist-electron/orchestration/orchestration-bin-shim.js';
  const posixResolved = resolveDefaultOrchestrationCliPath(posixAsarPath);
  assert.ok(
    posixResolved.includes('app.asar.unpacked'),
    `Expected app.asar.unpacked in ${posixResolved}`
  );
  assert.equal(posixResolved.endsWith('aha-orchestration-cli.cjs'), true);
});

test('Fix 4+7: HTTP router maps duplicate_run/duplicate_task to 409, delivery_not_found to 404, terminal_unavailable/prompt_delivery_failed to 503', async () => {
  const h = createHarness({
    writePty: async () => ({ ok: false, error: 'Write rejected' }),
  });
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    h.service.runCreate({ id: 'run_http_1', objective: 'HTTP codes', from: 'coord-1' });
    const { task } = h.service.taskCreate({ id: 'task_http_1', runId: 'run_http_1', spec: 'Work' });

    const dupRunRes = await dispatchOrchestrationHttpAction(
      h.service,
      'run-create',
      { id: 'run_http_1', objective: 'Dup' },
      {}
    );
    assert.equal(dupRunRes.status, 409);
    assert.equal(dupRunRes.body.code, 'duplicate_run');

    const dupTaskRes = await dispatchOrchestrationHttpAction(
      h.service,
      'task-create',
      { id: 'task_http_1', runId: 'run_http_1', spec: 'Dup' },
      {}
    );
    assert.equal(dupTaskRes.status, 409);
    assert.equal(dupTaskRes.body.code, 'duplicate_task');

    const missingDlvRes = await dispatchOrchestrationHttpAction(
      h.service,
      'check',
      { from: 'coord-1', runId: 'run_http_1', ack: 'dlv_missing' },
      {}
    );
    assert.equal(missingDlvRes.status, 404);
    assert.equal(missingDlvRes.body.code, 'delivery_not_found');

    const promptFailRes = await dispatchOrchestrationHttpAction(
      h.service,
      'dispatch',
      { taskId: task.id, to: 'worker-1', from: 'coord-1' },
      {}
    );
    assert.equal(promptFailRes.status, 503);
    assert.equal(promptFailRes.body.code, 'prompt_delivery_failed');
  } finally {
    h.cleanup();
  }
});

test('Fix 4: check --wait handles timeoutMs <= 0 immediately and redrives pending mail on abort', async () => {
  const h = createHarness();
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    const { run } = h.service.runCreate({ objective: 'Abort redrive', from: 'coord-1' });
    const { task } = h.service.taskCreate({ runId: run.id, spec: 'Work' });
    await h.service.dispatchTask({ taskId: task.id, to: 'worker-1', from: 'coord-1' });
    h.writes.length = 0;

    // timeoutMs <= 0 returns timedOut immediately without hanging
    const zeroWait = await h.service.check({ from: 'worker-1', wait: true, timeoutMs: 0 });
    assert.equal(zeroWait.timedOut, true);
    assert.equal(zeroWait.count, 0);

    // Aborted wait redrives undelivered mail if still unread
    const ac = new AbortController();
    const waitP = h.service.check({ from: 'worker-1', wait: true, timeoutMs: 5000 }, ac.signal);
    const activeDispatch = h.store.getActiveDispatchForIdentity('worker-1', 'worker-1');
    h.store.insertMessage({
      runId: run.id,
      from: 'coord-1',
      to: `dispatch:${activeDispatch.id}`,
      subject: 'Late note',
      body: 'Check this',
    });
    ac.abort();
    const abortedRes = await waitP;
    assert.equal(abortedRes.cancelled, true);
    assert.equal(abortedRes.connectionLost, true);

    await new Promise((r) => setTimeout(r, 250));
    assert.equal(
      h.writes.some((w) => w.ptyId === 'worker-1' && w.data.includes('aha')),
      true
    );
  } finally {
    h.cleanup();
  }
});

test('Fix 4+6: send({ to: "@all" }) infers caller runId when omitted and notifies run + peer workers', async () => {
  const h = createHarness();
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    h.registerIdlePane('worker-2');
    const { run } = h.service.runCreate({ objective: 'Infer runId', from: 'coord-1' });
    const { task: t1 } = h.service.taskCreate({ runId: run.id, spec: 'Task A' });
    const { task: t2 } = h.service.taskCreate({ runId: run.id, spec: 'Task B' });
    const { dispatch: d1 } = await h.service.dispatchTask({
      taskId: t1.id,
      to: 'worker-1',
      from: 'coord-1',
    });
    const { dispatch: d2 } = await h.service.dispatchTask({
      taskId: t2.id,
      to: 'worker-2',
      from: 'coord-1',
    });

    // Worker sends @all without explicit --run; coordinator run:<id> and worker-2 MUST be included!
    const sent = h.service.send({
      from: 'worker-1',
      to: '@all',
      subject: 'All hands',
      body: 'Status ping',
    });
    assert.ok(sent.recipients?.includes(`run:${run.id}`));
    assert.ok(sent.recipients?.includes(`dispatch:${d2.id}`));
    assert.equal(sent.recipients?.includes(`dispatch:${d1.id}`), false);

    const coordCheck = await h.service.check({ from: 'coord-1', runId: run.id });
    assert.equal(coordCheck.count, 1);
    assert.equal(coordCheck.messages[0].subject, 'All hands');

    const w2Check = await h.service.check({ from: 'worker-2' });
    assert.equal(w2Check.count, 1);
    assert.equal(w2Check.messages[0].subject, 'All hands');
  } finally {
    h.cleanup();
  }
});

test('Fix 3: repeated deliverPromptToPty failures increment dispatch failure count cleanly without orphan dispatched task', async () => {
  const h = createHarness({
    writePty: async () => ({ ok: false, error: 'Terminal unavailable (disconnected)' }),
  });
  try {
    h.registerIdlePane('coord-1');
    h.registerIdlePane('worker-1');
    const { run } = h.service.runCreate({ objective: 'Retry fail', from: 'coord-1' });
    const { task } = h.service.taskCreate({ runId: run.id, spec: 'Flaky prompt' });

    await assert.rejects(
      () => h.service.dispatchTask({ taskId: task.id, to: 'worker-1', from: 'coord-1' }),
      (err) => err.code === 'terminal_unavailable'
    );
    assert.equal(h.store.requireTask(task.id).status, 'ready');
    assert.equal(h.store.getLatestDispatchForTask(task.id)?.failureCount, 1);
    assert.equal(h.store.getLatestDispatchForTask(task.id)?.status, 'failed');

    // Second failure with live-but-failing write throws prompt_delivery_failed and still rolls back cleanly
    let writesCount = 0;
    const h2 = createHarness({
      writePty: async () => {
        writesCount += 1;
        return { ok: false, error: 'Transient EAGAIN' };
      },
    });
    try {
      h2.registerIdlePane('coord-1');
      h2.registerIdlePane('worker-1');
      const { run: r2 } = h2.service.runCreate({ objective: 'EAGAIN', from: 'coord-1' });
      const { task: t2 } = h2.service.taskCreate({ runId: r2.id, spec: 'Work' });
      await assert.rejects(
        () => h2.service.dispatchTask({ taskId: t2.id, to: 'worker-1', from: 'coord-1' }),
        (err) => err.code === 'prompt_delivery_failed'
      );
      assert.equal(writesCount >= 1, true);
      assert.equal(h2.store.requireTask(t2.id).status, 'ready');
    } finally {
      h2.cleanup();
    }
  } finally {
    h.cleanup();
  }
});

