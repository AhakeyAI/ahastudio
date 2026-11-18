import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ipcMain } from 'electron';

import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { registerOrchestrationIpc } from '../dist-electron/ipc/orchestration.js';
import { registerShellPtyIpc } from '../dist-electron/ipc/shell-pty.js';
import { getPtyHost } from '../dist-electron/pty-host.js';
import { OrchestrationError } from '../dist-electron/orchestration/orchestration-types.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';

function createHarness() {
  const agentStatusStore = new AgentStatusStore();
  const writes = [];
  const store = new OrchestrationStore();
  const spawned = [];
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      writes.push({ ptyId, data });
      return { ok: true };
    },
    spawnWorkerPty: async ({ cliId, cwd }) => {
      const ptyId = `spawned-${spawned.length + 1}`;
      spawned.push({ ptyId, cliId, cwd });
      agentStatusStore.registerPane(ptyId, { agentId: cliId ?? null });
      return { ptyId, cwd };
    },
  });
  return { agentStatusStore, store, service, writes, spawned };
}

test('manual dispatch safety: dryRun, self-dispatch refusal, dead pane refusal, and bracketed paste delivery', async () => {
  const { agentStatusStore, service, writes } = createHarness();
  agentStatusStore.registerPane('coord-pane', { agentId: 'claude' });
  agentStatusStore.registerPane('worker-pane', { agentId: 'codex' });

  const { run } = service.runCreate({
    id: 'run_disp',
    objective: 'Manual dispatch checks',
    from: 'coord-pane',
    paneId: 'coord-pane',
  });
  const { task } = service.taskCreate({
    id: 't_disp',
    runId: run.id,
    spec: 'Inspect repository files',
  });

  const dry = await service.dispatchTask({
    taskId: task.id,
    to: 'worker-pane',
    from: 'coord-pane',
    dryRun: true,
  });
  assert.equal(dry.dryRun, true);
  assert.equal(dry.injected, false);
  assert.equal(dry.dispatch, null);
  assert.match(dry.preamble, /ctx_dryrun/);
  assert.equal(service.store.getTask(task.id)?.status, 'ready');

  await assert.rejects(
    () =>
      service.dispatchTask({
        taskId: task.id,
        to: 'coord-pane',
        from: 'coord-pane',
        inject: true,
      }),
    (err) => err instanceof OrchestrationError && err.code === 'terminal_is_coordinator'
  );

  await assert.rejects(
    () =>
      service.dispatchTask({
        taskId: task.id,
        to: 'ghost-pane',
        from: 'coord-pane',
        inject: true,
      }),
    (err) => err instanceof OrchestrationError && err.code === 'no_agent_detected'
  );

  const live = await service.dispatchTask({
    taskId: task.id,
    to: 'worker-pane',
    from: 'coord-pane',
    inject: true,
  });
  assert.equal(live.injected, true);
  assert.equal(live.dispatch?.status, 'dispatched');
  assert.ok(writes.some((w) => w.ptyId === 'worker-pane' && w.data.includes('\x1b[200~')));
  assert.ok(writes.some((w) => w.ptyId === 'worker-pane' && w.data === '\r'));

  service.dispose();
});

test('coordinator tick loop dispatches parallel DAG tasks, reconciles worker_done, promotes deps, and converges to all-done', async () => {
  const { agentStatusStore, service, writes } = createHarness();
  agentStatusStore.registerPane('coord-pane', { agentId: 'claude' });
  agentStatusStore.registerPane('worker-a', { agentId: 'codex' });
  agentStatusStore.registerPane('worker-b', { agentId: 'pi' });

  const { run } = service.runCreate({
    id: 'run_dag',
    objective: 'Parallel + serial DAG',
    from: 'coord-pane',
    paneId: 'coord-pane',
  });
  service.taskCreate({ id: 't1', runId: run.id, spec: 'Step 1', priority: 'high' });
  service.taskCreate({ id: 't2', runId: run.id, spec: 'Step 2', priority: 'normal' });
  service.taskCreate({ id: 't3', runId: run.id, spec: 'Final Step', deps: ['t1', 't2'] });

  // Tick 1: dispatches t1 and t2 to worker-a & worker-b, skips coord-pane.
  const tick1 = await service.coordinatorTick(run.id);
  assert.equal(tick1.converged, false);
  assert.equal(service.store.getTask('t1')?.status, 'dispatched');
  assert.equal(service.store.getTask('t2')?.status, 'dispatched');
  assert.equal(service.store.getTask('t3')?.status, 'pending');
  assert.ok(!writes.some((w) => w.ptyId === 'coord-pane'));

  const d1 = service.store.getLatestDispatchForTask('t1');
  const d2 = service.store.getLatestDispatchForTask('t2');
  assert.ok(d1 && d2);
  assert.notEqual(d1.assigneeHandle, d2.assigneeHandle);

  // Workers send worker_done messages (without direct settle bypass, letting tick reconcile OR workerDone).
  service.store.insertMessage({
    runId: run.id,
    from: d1.assigneeHandle,
    to: `run:${run.id}`,
    type: 'worker_done',
    subject: 't1 complete',
    payload: JSON.stringify({ taskId: 't1', dispatchId: d1.id, outcome: 'completed' }),
  });
  service.store.insertMessage({
    runId: run.id,
    from: `dispatch:${d2.id}`,
    to: `run:${run.id}`,
    type: 'worker_done',
    subject: 't2 complete',
    payload: JSON.stringify({ taskId: 't2', dispatchId: d2.id, outcome: 'completed' }),
  });

  // Tick 2: processes both worker_done messages, promotes t3 -> ready, dispatches t3.
  const tick2 = await service.coordinatorTick(run.id);
  assert.equal(tick2.converged, false);
  assert.equal(service.store.getTask('t1')?.status, 'completed');
  assert.equal(service.store.getTask('t2')?.status, 'completed');
  assert.equal(service.store.getTask('t3')?.status, 'dispatched');

  const d3 = service.store.getLatestDispatchForTask('t3');
  assert.ok(d3);

  service.store.insertMessage({
    runId: run.id,
    from: `dispatch:${d3.id}`,
    to: `run:${run.id}`,
    type: 'worker_done',
    subject: 't3 complete',
    payload: JSON.stringify({ taskId: 't3', dispatchId: d3.id, outcome: 'completed' }),
  });

  const tick3 = await service.coordinatorTick(run.id);
  assert.equal(tick3.converged, true);
  assert.equal(service.store.getTask('t3')?.status, 'completed');

  service.dispose();
});

test('coordinator handles escalation, worker pane exit, decision gates, and background auto-spawn convergence', async () => {
  const { agentStatusStore, service, spawned } = createHarness();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  agentStatusStore.registerPane('w1', { agentId: 'codex' });

  const { run } = service.runCreate({
    id: 'run_esc',
    objective: 'Escalation and gate flow',
    from: 'coord',
    paneId: 'coord',
  });
  service.taskCreate({ id: 't_gate', runId: run.id, spec: 'Needs decision' });

  await service.coordinatorTick(run.id);
  const d1 = service.store.getLatestDispatchForTask('t_gate');
  assert.ok(d1);

  // Worker opens decision gate via message.
  service.store.insertMessage({
    runId: run.id,
    from: `dispatch:${d1.id}`,
    to: `run:${run.id}`,
    type: 'decision_gate',
    subject: 'Need approval',
    body: 'Deploy to staging?',
    payload: JSON.stringify({ taskId: 't_gate', options: ['yes', 'no'] }),
  });

  await service.coordinatorTick(run.id);
  assert.equal(service.store.getTask('t_gate')?.status, 'blocked');
  const gates = service.gateList({ taskId: 't_gate', status: 'pending' }).gates;
  assert.equal(gates.length, 1);

  // Resolve gate -> ready -> tick re-dispatches.
  service.gateResolve({ id: gates[0].id, resolution: 'yes' });
  assert.equal(service.store.getTask('t_gate')?.status, 'ready');
  await service.coordinatorTick(run.id);
  const d2 = service.store.getLatestDispatchForTask('t_gate');
  assert.ok(d2 && d2.id !== d1.id);

  // Simulate worker PTY exit mid-dispatch without worker_done.
  service.markPtyExited('w1');
  await service.coordinatorTick(run.id);
  assert.equal(service.store.getDispatchContext(d2.id)?.status, 'failed');
  assert.equal(service.store.getTask('t_gate')?.status, 'ready');

  // Now start background coordinator loop with autoSpawnWorkers: true & wait for completion.
  const started = service.coordinatorStart({
    runId: run.id,
    from: 'coord',
    pollIntervalMs: 50,
    maxConcurrent: 1,
    autoSpawnWorkers: true,
    workerCliId: 'codex',
  });
  assert.equal(started.status, 'running');

  // Cannot start a second coordinator while running.
  assert.throws(
    () => service.coordinatorStart({ runId: run.id }),
    (err) => err instanceof OrchestrationError && err.code === 'coordinator_already_running'
  );

  // Wait briefly until spawned worker claims task.
  for (let i = 0; i < 40; i++) {
    if (service.store.getLatestDispatchForTask('t_gate')?.status === 'dispatched') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(spawned.length, 1);
  const d3 = service.store.getLatestDispatchForTask('t_gate');
  assert.equal(d3?.assigneeHandle, spawned[0].ptyId);

  // Complete task via workerDone.
  service.workerDone({
    capability: service.store.getDispatchCapability(d3.id),
    from: spawned[0].ptyId,
    taskId: 't_gate',
    dispatchId: d3.id,
    outcome: 'completed',
    summary: 'Deployed cleanly',
  });

  // Wait for coordinator convergence.
  for (let i = 0; i < 40; i++) {
    if (service.store.getRun(run.id)?.status === 'completed') break;
    await new Promise((r) => setTimeout(r, 25));
  }
  assert.equal(service.store.getRun(run.id)?.status, 'completed');
  assert.equal(service.store.getActiveCoordinatorRun(), undefined);

  service.dispose();
});

test('coordinatorStart + coordinatorStop cleanly stops running loop', async () => {
  const { agentStatusStore, service } = createHarness();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  const { run } = service.runCreate({ id: 'run_stop', objective: 'Stoppable run', from: 'coord' });

  service.coordinatorStart({ runId: run.id, pollIntervalMs: 50, autoSpawnWorkers: false });
  assert.ok(service.store.getActiveCoordinatorRun());

  const stopped = service.coordinatorStop();
  assert.equal(stopped.stopped, true);
  assert.equal(service.store.getRun(run.id)?.status, 'stopped');
  assert.equal(service.store.getActiveCoordinatorRun(), undefined);

  service.dispose();
});

test('coordinator escalation circuit-breaks after 3 attempts and converges run to failed', async () => {
  const { agentStatusStore, service } = createHarness();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  agentStatusStore.registerPane('w1', { agentId: 'codex' });
  const { run } = service.runCreate({
    id: 'run_esc_cb',
    objective: '3-strike escalation convergence',
    from: 'coord',
    paneId: 'coord',
  });
  service.taskCreate({ id: 't_bad', runId: run.id, spec: 'Unresolvable failure' });

  for (let attempt = 1; attempt <= 3; attempt++) {
    const t = await service.coordinatorTick(run.id);
    assert.equal(t.converged, false);
    const d = service.store.getLatestDispatchForTask('t_bad');
    assert.ok(d);
    assert.equal(d.status, 'dispatched');
    service.store.insertMessage({
      runId: run.id,
      from: 'w1',
      to: `run:${run.id}`,
      type: 'escalation',
      subject: `Escalate attempt ${attempt}`,
      body: `Failure #${attempt}`,
      payload: JSON.stringify({ dispatchId: d.id }),
    });
  }

  const finalTick = await service.coordinatorTick(run.id);
  assert.equal(finalTick.converged, true);
  assert.equal(service.store.getTask('t_bad')?.status, 'failed');
  assert.equal(service.store.getLatestDispatchForTask('t_bad')?.status, 'circuit_broken');

  service.dispose();
});

test('live OSC shell boundaries do not kill active dispatches, gateCreate announcements do not duplicate gates, and stale gate msgs do not crash coordinator', async () => {
  const { agentStatusStore, service } = createHarness();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  agentStatusStore.registerPane('w1', { agentId: 'codex' });

  const { run } = service.runCreate({
    id: 'run_resilience',
    objective: 'Resilience checks',
    from: 'coord',
    paneId: 'coord',
  });
  service.taskCreate({ id: 't1', runId: run.id, spec: 'Step 1' });
  service.taskCreate({ id: 't2', runId: run.id, spec: 'Step 2' });

  // Dispatch t1 to w1.
  await service.dispatchTask({ taskId: 't1', to: 'w1', from: 'coord', inject: false });

  // Simulate w1 finishing a shell command: OSC prompt-start emits source='process', state='done'.
  agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'working' });
  agentStatusStore.ingestPtyData('w1', '\x1b]133;A\x07');
  assert.equal(agentStatusStore.get('w1')?.state, 'done');
  assert.equal(agentStatusStore.get('w1')?.source, 'process');

  // Coordinator tick must NOT treat live w1 as exited!
  await service.coordinatorTick(run.id);
  assert.equal(service.isPaneAlive('w1'), true);
  assert.equal(service.store.getTask('t1')?.status, 'dispatched');

  // gateCreate inserts a 'decision_gate' announcement with gateId; coordinatorTick must not spawn a 2nd ghost gate.
  const { gate } = service.gateCreate({ taskId: 't1', question: 'Confirm deploy?', from: 'coord' });
  await service.coordinatorTick(run.id);
  const gates = service.gateList({ taskId: 't1' }).gates;
  assert.equal(gates.length, 1);
  assert.equal(gates[0].id, gate.id);

  // Late/invalid decision_gate message targeting an inactive dispatch must be safely rejected without crashing tick.
  const closedDispatch = service.store.getLatestDispatchForTask('t1');
  service.store.insertMessage({
    runId: run.id,
    from: 'w1',
    to: `run:${run.id}`,
    type: 'decision_gate',
    subject: 'Stale gate msg',
    body: 'Too late',
    payload: JSON.stringify({ taskId: 't1', dispatchId: closedDispatch?.id }),
  });
  await service.coordinatorTick(run.id);
  assert.equal(service.gateList({ taskId: 't1' }).gates.length, 1);

  // Resolving the single gate unblocks t1 cleanly.
  service.gateResolve({ id: gate.id, resolution: 'approved' });
  assert.equal(service.store.getTask('t1')?.status, 'ready');

  service.dispose();
});

test('registerShellPtyIpc createPty defaults cleanly to shellId=default, validates cliId, and closePty marks worker exited', async (t) => {
  t.mock.method(ipcMain, 'handle', () => {});
  const host = getPtyHost();
  const spawnedPids = new Map();
  t.mock.method(host, 'spawn', (id, opts) => {
    spawnedPids.set(id, { opts, onExit() {} });
    return 999;
  });
  t.mock.method(host, 'onData', () => () => {});
  t.mock.method(host, 'onExit', (id, cb) => {
    spawnedPids.get(id).onExit = cb;
    return () => {};
  });
  t.mock.method(host, 'kill', (id) => spawnedPids.delete(id));

  const agentStatusStore = new AgentStatusStore();
  const store = new OrchestrationStore();
  const shellPtyCtrl = registerShellPtyIpc({
    liveWindow: () => null,
    getCurrentCwd: () => process.cwd(),
    agentStatusStore,
  });
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: shellPtyCtrl.sendInput,
    spawnWorkerPty: ({ cliId, cwd }) => shellPtyCtrl.createPty({ cliId, cwd }),
  });
  const offExit = shellPtyCtrl.onPtyExit((ptyId) => service.markPtyExited(ptyId));

  try {
    // Omitting workerCliId must spawn default shell without crashing resolveLocalTerminal('default').
    const created = await shellPtyCtrl.createPty({ cwd: process.cwd() });
    assert.ok(created.ptyId.startsWith('local-orch-'));
    assert.equal(service.isPaneAlive(created.ptyId), true);

    // Invalid cliId fails explicitly instead of unhandled TypeError.
    await assert.rejects(() => shellPtyCtrl.createPty({ cliId: 'nonexistent-cli' }), /Unknown worker cliId/);

    // Closing PTY immediately notifies onPtyExit -> marks worker pane exited and fails active dispatch cleanly.
    agentStatusStore.registerPane('coord', { agentId: 'claude' });
    const { run } = service.runCreate({ id: 'run_shell', objective: 'Shell spawn', from: 'coord', paneId: 'coord' });
    service.taskCreate({ id: 't_spawn', runId: run.id, spec: 'Run command' });
    // A plain shell would run the task text as commands, so it is never a dispatch candidate.
    await service.coordinatorTick(run.id);
    assert.equal(service.store.getLatestDispatchForTask('t_spawn'), undefined);
    // Once an agent is detected in the pane it becomes eligible.
    agentStatusStore.registerPane(created.ptyId, { agentId: 'claude' });
    await service.coordinatorTick(run.id);
    const activeDispatch = service.store.getLatestDispatchForTask('t_spawn');
    assert.equal(activeDispatch?.assigneeHandle, created.ptyId);

    await shellPtyCtrl.closePty(created.ptyId);
    assert.equal(service.isPaneAlive(created.ptyId), false);
    await service.coordinatorTick(run.id);
    assert.equal(service.store.getDispatchContext(activeDispatch.id)?.status, 'failed');
  } finally {
    offExit();
    service.dispose();
  }
});

test('emitChanged scopes snapshots to runId, auto-closes finished spawned workers, and dispose/resume preserves run continuity', async () => {
  const agentStatusStore = new AgentStatusStore();
  const store = new OrchestrationStore();
  const closedPtys = [];
  const closedEvents = [];
  const events = [];
  let spawnCounter = 0;
  let confirmClosed;
  const closeConfirmation = new Promise((resolve) => { confirmClosed = resolve; });

  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async ({ cliId, cwd }) => {
      const ptyId = `local-orch-auto-${++spawnCounter}`;
      agentStatusStore.registerPane(ptyId, { agentId: cliId ?? 'codex' });
      return { ptyId, cwd };
    },
    closeWorkerPty: (ptyId) => {
      closedPtys.push(ptyId);
      return closeConfirmation;
    },
  });

  const offEvents = service.onEvent((event) => events.push(event));
  const offClosed = service.onPaneClosed((event) => closedEvents.push(event));

  try {
    agentStatusStore.registerPane('coord', { agentId: 'claude' });
    agentStatusStore.registerPane('manual-worker', { agentId: 'codex' });

    const { run: runA } = service.runCreate({ id: 'run_a', objective: 'Run A', from: 'coord' });
    const { run: runB } = service.runCreate({ id: 'run_b', objective: 'Run B', from: 'coord-b' });
    service.taskCreate({ id: 'tA', runId: runA.id, spec: 'Task A' });
    service.taskCreate({ id: 'tB', runId: runB.id, spec: 'Task B' });

    const taskBEvent = events.filter((e) => e.reason === 'task:created' && e.runId === runB.id).at(-1);
    assert.ok(taskBEvent);
    assert.deepEqual(taskBEvent.snapshot.tasks.map((t) => t.id), ['tB']);
    assert.equal(taskBEvent.snapshot.runs.length, 2);

    // Manual worker completion must NOT close manual-worker.
    await service.dispatchTask({ taskId: 'tA', to: 'manual-worker', from: 'coord' });
    const dManual = service.store.getLatestDispatchForTask('tA');
    service.workerDone({
      capability: service.store.getDispatchCapability(dManual.id),
      from: 'manual-worker',
      taskId: 'tA',
      dispatchId: dManual.id,
      outcome: 'completed',
    });
    assert.deepEqual(closedPtys, []);

    // Auto-spawned worker closes automatically when settled, and dispose stops active runs.
    const { run: runAuto } = service.runCreate({ id: 'run_auto', objective: 'Auto close', from: 'coord-auto' });
    service.taskCreate({ id: 'tAuto1', runId: runAuto.id, spec: 'Auto 1' });
    service.taskCreate({ id: 'tAuto2', runId: runAuto.id, spec: 'Auto 2', deps: ['tAuto1'] });
    service.coordinatorStart({
      runId: runAuto.id,
      from: 'coord-auto',
      pollIntervalMs: 40,
      autoSpawnWorkers: true,
      workerCliId: 'codex',
      workerPaneIds: [],
    });

    for (let i = 0; i < 40 && !service.store.getLatestDispatchForTask('tAuto1'); i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const dAuto1 = service.store.getLatestDispatchForTask('tAuto1');
    assert.ok(dAuto1);
    assert.equal(dAuto1.assigneePaneId, 'local-orch-auto-1');

    service.workerDone({
      capability: service.store.getDispatchCapability(dAuto1.id),
      from: 'local-orch-auto-1',
      taskId: 'tAuto1',
      dispatchId: dAuto1.id,
      outcome: 'completed',
    });
    assert.deepEqual(closedPtys, ['local-orch-auto-1']);
    assert.equal(closedEvents.length, 0, 'closure is published after the PTY confirms termination');
    confirmClosed({ ok: true });
    for (let i = 0; i < 40 && !closedEvents.length; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.equal(closedEvents.length, 1);
    assert.equal(closedEvents[0].ptyId, 'local-orch-auto-1');
    assert.equal(closedEvents[0].runId, runAuto.id);
    assert.equal(closedEvents[0].taskId, 'tAuto1');

    // Stop active coordinator before checking dispose + resume of a bound stopped run.
    service.coordinatorStop();
    const { run: runResume } = service.runCreate({ id: 'run_resume', objective: 'Resume me', from: 'coord-res' });
    service.taskCreate({ id: 'tRes', runId: runResume.id, spec: 'Pending task' });
    service.coordinatorStart({ runId: runResume.id, from: 'coord-res', pollIntervalMs: 500 });
    service.dispose();
    assert.equal(store.getRun(runResume.id)?.status, 'stopped');

    // New service on same store resumes the stopped bound run without spec/runId.
    const resumedService = new OrchestrationService({
      store,
      agentStatusStore,
      writePty: async () => ({ ok: true }),
    });
    const restarted = resumedService.coordinatorStart({ from: 'coord-res', pollIntervalMs: 500 });
    assert.equal(restarted.runId, runResume.id);
    assert.equal(store.getRun(runResume.id)?.status, 'active');
    resumedService.dispose();
  } finally {
    offEvents();
    offClosed();
    service.dispose();
  }
});

test('IPC check/ask with wait can be cancelled via orchestration:cancel-wait and sender destroy', async (t) => {
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
  const sender = Object.assign(new EventEmitter(), { id: 77, send: () => {} });
  const agentStatusStore = new AgentStatusStore();
  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async () => ({ ok: true }),
  });

  const ipc = registerOrchestrationIpc({
    liveWindow: () => ({ webContents: sender }),
    getCurrentCwd: () => process.cwd(),
    orchestrationService: service,
  });

  try {
    agentStatusStore.registerPane('coord', { agentId: 'claude' });
    agentStatusStore.registerPane('w1', { agentId: 'codex' });
    const { run } = service.runCreate({ id: 'run_ipc_cancel', objective: 'IPC Cancel', from: 'coord', paneId: 'coord' });
    const { task } = service.taskCreate({ id: 't_cancel', runId: run.id, spec: 'Work' });
    await service.dispatchTask({ taskId: task.id, to: 'w1', from: 'coord', inject: false });

    const call = (channel, payload) => handlers.get(channel)({ sender }, payload);

    const waitingCheck = call('orchestration:check', {
      from: 'coord',
      runId: run.id,
      wait: true,
      timeoutMs: 30_000,
      requestId: 'req-check-1',
    });
    await new Promise((r) => setTimeout(r, 20));
    const cancelCheck = await call('orchestration:cancel-wait', { requestId: 'req-check-1' });
    assert.deepEqual(cancelCheck, { ok: true, cancelled: true });
    const checkRes = await waitingCheck;
    assert.equal(checkRes.ok, true);
    assert.equal(checkRes.cancelled, true);
    assert.equal(checkRes.count, 0);

    const waitingAsk = call('orchestration:ask', {
      from: 'w1',
      question: 'Proceed?',
      wait: true,
      timeoutMs: 30_000,
      requestId: 'req-ask-1',
    });
    await new Promise((r) => setTimeout(r, 20));
    const cancelAsk = await call('orchestration:cancel-wait', { requestId: 'req-ask-1' });
    assert.deepEqual(cancelAsk, { ok: true, cancelled: true });
    const askRes = await waitingAsk;
    assert.equal(askRes.ok, true);
    assert.equal(askRes.cancelled, true);
    assert.equal(askRes.pending, true);

    const missingCancel = await call('orchestration:cancel-wait', { requestId: 'nonexistent' });
    assert.deepEqual(missingCancel, { ok: true, cancelled: false });

    // Drain the unread question posted by waitingAsk so destroyCheck actually blocks on wait.
    await call('orchestration:check', { from: 'coord', runId: run.id });

    const destroyCheck = call('orchestration:check', {
      from: 'coord',
      runId: run.id,
      wait: true,
      timeoutMs: 30_000,
      requestId: 'req-destroy',
    });
    await new Promise((r) => setTimeout(r, 20));
    sender.emit('destroyed');
    const destroyRes = await destroyCheck;
    assert.equal(destroyRes.ok, true);
    assert.equal(destroyRes.cancelled, true);
  } finally {
    ipc.dispose();
    service.dispose();
  }
});

test('startup trust confirmation blocks quiet-ready return and defers dispatch prompt until user confirms', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-trust-guard-'));
  const prevPath = process.env.PATH;
  const binName = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  writeFileSync(
    join(dir, binName),
    process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    { mode: 0o755 },
  );
  process.env.PATH = `${dir}${process.platform === 'win32' ? ';' : ':'}${prevPath ?? ''}`;
  t.after(() => {
    process.env.PATH = prevPath;
    rmSync(dir, { recursive: true, force: true });
  });

  t.mock.method(ipcMain, 'handle', () => {});
  const host = getPtyHost();
  const ptys = new Map();
  t.mock.method(host, 'spawn', (id) => {
    ptys.set(id, { onData: () => {}, onExit: () => {} });
    return 1001;
  });
  t.mock.method(host, 'onData', (id, cb) => {
    ptys.get(id).onData = cb;
    return () => {};
  });
  t.mock.method(host, 'onExit', (id, cb) => {
    ptys.get(id).onExit = cb;
    return () => {};
  });
  t.mock.method(host, 'kill', (id) => ptys.delete(id));

  const agentStatusStore = new AgentStatusStore();
  const shellPtyCtrl = registerShellPtyIpc({
    liveWindow: () => null,
    getCurrentCwd: () => dir,
    agentStatusStore,
  });

  // 1. waitForReady must NOT return early on 150ms silence while trust confirmation puts pane in 'waiting'.
  const createPromise = shellPtyCtrl.createPty({
    terminalId: 'orch-trust-ready',
    cliId: 'codex',
    cwd: dir,
    waitForReady: { quietMs: 120, maxMs: 2_000 },
  });
  await new Promise((r) => setTimeout(r, 30));
  const expectedPtyId = 'local-orch-trust-ready';
  ptys.get(expectedPtyId).onData('Do you trust the files in this folder?\r\n1. Yes, proceed');
  assert.equal(agentStatusStore.get(expectedPtyId)?.state, 'waiting');

  let settledEarly = false;
  void createPromise.then(() => {
    settledEarly = true;
  });
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(settledEarly, false, 'must stay blocked past quietMs while trust prompt is waiting');

  // Confirming trust via user Enter unblocks waitForReady promptly.
  agentStatusStore.notifyUserInput(expectedPtyId, '\r');
  assert.equal(agentStatusStore.get(expectedPtyId)?.state, 'idle');
  await createPromise;
  await shellPtyCtrl.closePty(expectedPtyId);

  // 2. Dispatching to a pane already stuck on directory trust defers the prompt until confirmed.
  const store = new OrchestrationStore();
  const writes = [];
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      writes.push({ ptyId, data });
      return { ok: true };
    },
  });
  try {
    agentStatusStore.registerPane('coord', { agentId: 'claude' });
    agentStatusStore.registerPane('w_trust', { agentId: 'claude' });
    agentStatusStore.ingestPtyData('w_trust', 'Do you trust the files in this folder?\nYes, proceed');
    assert.equal(agentStatusStore.get('w_trust')?.state, 'waiting');

    const { run } = service.runCreate({ id: 'run_trust', objective: 'Trust guard', from: 'coord', paneId: 'coord' });
    const { task } = service.taskCreate({ id: 't_trust', runId: run.id, spec: 'Safe task' });
    const res = await service.dispatchTask({ taskId: task.id, to: 'w_trust', from: 'coord' });

    assert.equal(res.dispatch?.startObservation, 'permission');
    assert.equal(res.dispatch?.promptSentAt, null);
    assert.equal(writes.length, 0, 'must not write task text + Enter into trust dialog');

    // User presses Enter on trust dialog -> pane returns to idle -> deferred prompt is delivered once.
    agentStatusStore.notifyUserInput('w_trust', '\r');
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(writes.some((w) => w.ptyId === 'w_trust' && w.data.includes('\x1b[200~')));
    assert.ok(writes.some((w) => w.ptyId === 'w_trust' && w.data === '\r'));
    assert.ok(service.store.getLatestDispatchForTask(task.id)?.promptSentAt);
  } finally {
    service.dispose();
  }
});
