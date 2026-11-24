import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atNextDelivery, createTrackedTestService } from './fixtures/tracked-orchestration-service.mjs';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { Coordinator } from '../dist-electron/orchestration/coordinator.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import {
  AGENT_PROMPT_STALLED_ERROR,
  OrchestrationError,
} from '../dist-electron/orchestration/orchestration-types.js';
import { deliverAndObserveAgentTurn } from '../dist-electron/orchestration/turn-start-observation.js';

function createClockedHarness(opts = {}) {
  let nowMs = opts.initialNowMs ?? Date.UTC(2026, 0, 1, 12, 0, 0);
  const now = () => nowMs;
  const isoNow = () => new Date(nowMs).toISOString();

  const store = new OrchestrationStore({ now: isoNow });
  const agentStatusStore = new AgentStatusStore({ now });
  const writes = [];
  const events = [];

  const service = createTrackedTestService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      if (opts.writePty) {
        return opts.writePty(ptyId, data, writes);
      }
      writes.push({ ptyId, data });
      return { ok: true };
    },
    isPtyAlive: opts.isPtyAlive,
    turnStartObserveTimeoutMs: opts.turnStartObserveTimeoutMs ?? 25,
    startConfirmationTimeoutMs: opts.startConfirmationTimeoutMs ?? 60_000,
    heartbeatTimeoutMs: opts.heartbeatTimeoutMs ?? 300_000,
    staleWarningTimeoutMs: opts.staleWarningTimeoutMs ?? 0,
    settleDelayMs: opts.settleDelayMs ?? 0,
    now,
  });

  const offEvents = service.onEvent((event) => {
    events.push(event);
  });

  return {
    store,
    agentStatusStore,
    service,
    writes,
    events,
    now,
    isoNow,
    advance: (ms) => {
      nowMs += ms;
      return nowMs;
    },
    setNow: (ms) => {
      nowMs = ms;
      return nowMs;
    },
    pasteWritesFor: (ptyId) =>
      writes.filter((w) => w.ptyId === ptyId && w.data.includes('\x1b[200~')),
    dispose: () => {
      offEvents();
      service.dispose();
    },
  };
}

function createCoordinatorRuntimeForStore({
  store,
  agentStatusStore,
  coordinatorPaneId,
  writePty,
  observeTimeoutMs = 0,
  settleDelayMs = 0,
  notifications = [],
}) {
  return {
    cliCommand: 'aha',
    maxDepth: 2,
    listWorkerCandidates: (excludePaneIds) => {
      const candidates = [];
      for (const pane of agentStatusStore.list()) {
        if (excludePaneIds.has(pane.ptyId)) continue;
        if (coordinatorPaneId && pane.ptyId === coordinatorPaneId) continue;
        if (pane.state === 'working' || pane.state === 'waiting') continue;
        if (!pane.agentId) continue;
        const boundRun = store.getCurrentRunForConsumer(pane.ptyId);
        if (boundRun && (boundRun.coordinatorPaneId === pane.ptyId || boundRun.coordinatorHandle === pane.ptyId)) {
          continue;
        }
        candidates.push({ ptyId: pane.ptyId, agentId: pane.agentId });
      }
      return candidates;
    },
    isPaneAlive: (ptyId) => agentStatusStore.get(ptyId) !== null,
    hasPaneExited: () => false,
    sendTurn: async (turn) =>
      deliverAndObserveAgentTurn({
        ptyId: turn.ptyId,
        prompt: turn.body,
        submit: turn.submit !== false,
        settleDelayMs,
        writePty,
        agentStatusStore,
        isPaneAlive: (ptyId) => agentStatusStore.get(ptyId) !== null,
        observeTimeoutMs,
      }),
    notifyStateChanged: (reason, runId) => {
      notifications.push({ reason, runId });
    },
  };
}

test('1. unobserved turn-start keeps dispatch active without blind re-paste, promotes on delayed working with 5s heartbeat throttle, and settles on late workerDone', async () => {
  const h = createClockedHarness({
    turnStartObserveTimeoutMs: 25,
    startConfirmationTimeoutMs: 60_000,
    settleDelayMs: 0,
  });

  const activityEvents = [];
  const offActivity = h.agentStatusStore.onActivity((snap) => {
    activityEvents.push(snap);
  });

  try {
    h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w1', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w2', { agentId: 'codex' });

    const { run } = h.service.runCreate({
      id: 'run_unobs',
      objective: 'Verify unobserved start observation',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_coord', runId: run.id, spec: 'Coordinator tick unobserved task' });
    h.service.taskCreate({ id: 't_manual', runId: run.id, spec: 'Manual dispatch unobserved task' });

    // Restrict coordinatorTick to w1 so t_manual stays ready for manual dispatch test.
    const tick1 = await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
    assert.equal(tick1.converged, false);

    const dCoord = h.store.getLatestDispatchForTask('t_coord');
    assert.ok(dCoord);
    assert.equal(dCoord.status, 'dispatched');
    assert.equal(dCoord.startObservation, 'unobserved');
    assert.ok(dCoord.startObservationReason);
    assert.equal(dCoord.failureCount, 0);
    assert.equal(dCoord.turnStartedAt, null);
    assert.equal(h.store.getTask('t_coord')?.status, 'dispatched');
    assert.equal(h.pasteWritesFor('w1').length, 1);
    const writesAfterTick1 = h.writes.filter((w) => w.ptyId === 'w1').length;
    assert.equal(writesAfterTick1, 2); // bracketed paste + '\r'
    assert.ok(h.events.some((e) => e.reason === 'coordinator:dispatch-unobserved'));

    // Subsequent coordinator ticks within startConfirmationTimeoutMs NEVER re-paste.
    h.advance(10_000);
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
    h.advance(20_000);
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });

    const dCoordAfterTicks = h.store.getDispatchContext(dCoord.id);
    assert.equal(dCoordAfterTicks?.status, 'dispatched');
    assert.equal(dCoordAfterTicks?.startObservation, 'unobserved');
    assert.equal(dCoordAfterTicks?.failureCount, 0);
    assert.equal(h.store.getTask('t_coord')?.status, 'dispatched');
    assert.equal(h.pasteWritesFor('w1').length, 1);
    assert.equal(h.writes.filter((w) => w.ptyId === 'w1').length, writesAfterTick1);

    // Same unobserved behavior verified for manual service.dispatchTask.
    const manualRes = await h.service.dispatchTask({
      taskId: 't_manual',
      to: 'w2',
      from: 'coord',
    });
    assert.equal(manualRes.injected, true);
    assert.equal(manualRes.dispatch?.status, 'dispatched');
    assert.equal(manualRes.dispatch?.startObservation, 'unobserved');
    assert.equal(manualRes.dispatch?.failureCount, 0);
    assert.equal(manualRes.dispatch?.turnStartedAt, null);
    assert.equal(h.store.getTask('t_manual')?.status, 'dispatched');
    assert.equal(h.pasteWritesFor('w2').length, 1);
    assert.ok(h.events.some((e) => e.reason === 'dispatch:unobserved'));

    // Delayed 'working' hook promotes 'unobserved' -> 'observed', sets turnStartedAt, and throttles heartbeats.
    const tWorking = h.advance(1_000);
    const expectedTurnStartIso = new Date(tWorking).toISOString();
    const observedCountBefore = h.events.filter((e) => e.reason === 'dispatch:observed').length;

    h.agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'working' });
    const dObserved = h.store.getDispatchContext(dCoord.id);
    assert.equal(dObserved?.startObservation, 'observed');
    assert.equal(dObserved?.startObservationReason, null);
    assert.equal(dObserved?.turnStartedAt, expectedTurnStartIso);
    assert.equal(dObserved?.lastHeartbeatAt, expectedTurnStartIso);
    assert.equal(
      h.events.filter((e) => e.reason === 'dispatch:observed').length,
      observedCountBefore + 1
    );

    // Rapid same-state 'working' pings fire onActivity but throttle lastHeartbeatAt (< 5_000ms).
    const seqBeforeBurst = activityEvents.filter((s) => s.ptyId === 'w1').length;
    h.advance(1_500);
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'working' });
    h.advance(3_499); // cumulative 4_999ms since expectedTurnStartIso
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'working' });

    const w1Activities = activityEvents.filter((s) => s.ptyId === 'w1');
    assert.equal(w1Activities.length, seqBeforeBurst + 2);
    assert.equal(w1Activities.at(-1)?.workingSequence, 3);
    const dThrottled = h.store.getDispatchContext(dCoord.id);
    assert.equal(dThrottled?.lastHeartbeatAt, expectedTurnStartIso);
    assert.equal(dThrottled?.updatedAt, expectedTurnStartIso);
    assert.equal(
      h.events.filter((e) => e.reason === 'dispatch:observed').length,
      observedCountBefore + 1
    );

    // Once >= 5_000ms have elapsed, another 'working' ping updates lastHeartbeatAt without changing turnStartedAt.
    const tAfterThrottle = h.advance(1); // exactly 5_000ms after expectedTurnStartIso
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'working' });
    const dRefreshed = h.store.getDispatchContext(dCoord.id);
    assert.equal(dRefreshed?.lastHeartbeatAt, new Date(tAfterThrottle).toISOString());
    assert.equal(dRefreshed?.turnStartedAt, expectedTurnStartIso);

    // Late workerDone on the still-'unobserved' manual dispatch (before timeout) settles both dispatch and task.
    const lateDone = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(manualRes.dispatch.id),
      from: 'w2',
      taskId: 't_manual',
      dispatchId: manualRes.dispatch.id,
      outcome: 'completed',
      summary: 'Finished before start confirmation timeout',
    });
    assert.equal(lateDone.lifecycle.action, 'settled');
    assert.equal(lateDone.dispatch.status, 'completed');
    assert.equal(lateDone.dispatch.startObservation, 'observed');
    assert.ok(lateDone.dispatch.turnStartedAt);
    assert.equal(lateDone.task.status, 'completed');
  } finally {
    offActivity();
    h.dispose();
  }
});

test('2. queued and permission start observations keep dispatches alive and exempt permission from heartbeat timeout', async () => {
  const h = createClockedHarness({
    turnStartObserveTimeoutMs: 120,
    startConfirmationTimeoutMs: 10_000,
    heartbeatTimeoutMs: 20_000,
    settleDelayMs: 0,
    writePty: async (ptyId, data, writes) => {
      writes.push({ ptyId, data });
      if (ptyId === 'w_perm_immediate' && data === '\r') {
        setTimeout(() => {
          h.agentStatusStore.ingestHookEvent({
            ptyId: 'w_perm_immediate',
            state: 'waiting',
            waitKind: 'permission',
          });
        }, 5);
      }
      return { ok: true };
    },
  });

  try {
    h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w_queued', { agentId: 'codex' });
    h.agentStatusStore.registerPane('w_perm_immediate', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w_perm_later', { agentId: 'claude' });

    // Pre-mark w_queued as already 'working'.
    atNextDelivery(h.service, () => h.agentStatusStore.ingestHookEvent({ ptyId: 'w_queued', state: 'working' }));

    const { run } = h.service.runCreate({
      id: 'run_qp',
      objective: 'Queued and permission handling',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_queued', runId: run.id, spec: 'Queued task' });
    h.service.taskCreate({ id: 't_perm_1', runId: run.id, spec: 'Immediate permission prompt' });
    h.service.taskCreate({ id: 't_perm_2', runId: run.id, spec: 'Later permission prompt' });

    // 2a. Already 'working' pane -> startObservation: 'queued', failureCount: 0, stays active on tick, settles on workerDone.
    const queuedRes = await h.service.dispatchTask({
      taskId: 't_queued',
      to: 'w_queued',
      from: 'coord',
    });
    assert.equal(queuedRes.dispatch?.startObservation, 'queued');
    assert.equal(queuedRes.dispatch?.status, 'dispatched');
    assert.equal(queuedRes.dispatch?.failureCount, 0);
    assert.equal(h.store.getTask('t_queued')?.status, 'dispatched');

    await h.service.coordinatorTick(run.id, { workerPaneIds: [] });
    assert.equal(h.store.getDispatchContext(queuedRes.dispatch.id)?.status, 'dispatched');
    assert.equal(h.store.getDispatchContext(queuedRes.dispatch.id)?.startObservation, 'queued');

    const queuedDone = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(queuedRes.dispatch.id),
      from: 'w_queued',
      taskId: 't_queued',
      dispatchId: queuedRes.dispatch.id,
      outcome: 'completed',
      summary: 'Queued turn finished',
    });
    assert.equal(queuedDone.lifecycle.action, 'settled');
    assert.equal(queuedDone.dispatch.status, 'completed');
    assert.equal(queuedDone.task.status, 'completed');

    // 2b. Pane transitions to 'waiting' right after write -> startObservation: 'permission'.
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w_perm_immediate'] });
    const dPerm1 = h.store.getLatestDispatchForTask('t_perm_1');
    assert.ok(dPerm1);
    assert.equal(dPerm1.status, 'dispatched');
    assert.equal(dPerm1.startObservation, 'permission');
    assert.equal(dPerm1.failureCount, 0);
    assert.ok(h.events.some((e) => e.reason === 'coordinator:dispatch-permission'));

    // 2c. Dispatch starts 'observed' and later transitions to 'waiting' -> 'permission' (preserving turnStartedAt).
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w_perm_later'] });
    const dPerm2Initial = h.store.getLatestDispatchForTask('t_perm_2');
    assert.ok(dPerm2Initial);
    assert.equal(dPerm2Initial.startObservation, 'unobserved');

    const observedAt = new Date(h.advance(1_000)).toISOString();
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w_perm_later', state: 'working' });
    assert.equal(h.store.getDispatchContext(dPerm2Initial.id)?.startObservation, 'observed');
    assert.equal(h.store.getDispatchContext(dPerm2Initial.id)?.turnStartedAt, observedAt);

    h.advance(1_000);
    h.agentStatusStore.ingestHookEvent({
      ptyId: 'w_perm_later',
      state: 'waiting',
      waitKind: 'permission',
    });
    const dPerm2Waiting = h.store.getDispatchContext(dPerm2Initial.id);
    assert.equal(dPerm2Waiting?.startObservation, 'permission');
    assert.equal(dPerm2Waiting?.turnStartedAt, observedAt);
    assert.ok(h.events.some((e) => e.reason === 'dispatch:permission'));

    // Advance clock well past both heartbeatTimeoutMs and startConfirmationTimeoutMs: neither permission dispatch fails.
    h.advance(500_000);
    await h.service.coordinatorTick(run.id, { workerPaneIds: [] });

    assert.equal(h.store.getDispatchContext(dPerm1.id)?.status, 'dispatched');
    assert.equal(h.store.getDispatchContext(dPerm1.id)?.startObservation, 'permission');
    assert.equal(h.store.getDispatchContext(dPerm1.id)?.failureCount, 0);
    assert.equal(h.store.getTask('t_perm_1')?.status, 'dispatched');

    assert.equal(h.store.getDispatchContext(dPerm2Initial.id)?.status, 'dispatched');
    assert.equal(h.store.getDispatchContext(dPerm2Initial.id)?.startObservation, 'permission');
    assert.equal(h.store.getDispatchContext(dPerm2Initial.id)?.failureCount, 0);
    assert.equal(h.store.getTask('t_perm_2')?.status, 'dispatched');

    // Granting permission resumes 'observed' while keeping original turnStartedAt, and settles cleanly.
    h.advance(1_000);
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w_perm_later', state: 'working' });
    const dPerm2Resumed = h.store.getDispatchContext(dPerm2Initial.id);
    assert.equal(dPerm2Resumed?.startObservation, 'observed');
    assert.equal(dPerm2Resumed?.turnStartedAt, observedAt);
    const permDone = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(dPerm2Initial.id),
      from: 'w_perm_later',
      taskId: 't_perm_2',
      dispatchId: dPerm2Initial.id,
      outcome: 'completed',
      summary: 'Permission approved and completed',
    });
    assert.equal(permDone.lifecycle.action, 'settled');
    assert.equal(permDone.task.status, 'completed');
  } finally {
    h.dispose();
  }
});

test('3. start-confirmation timeout fails dispatch/task cleanly, late workerDone corrects stalled dispatch & promotes deps, and invalid/superseded reports are rejected', async () => {
  const h = createClockedHarness({
    turnStartObserveTimeoutMs: 25,
    startConfirmationTimeoutMs: 10_000,
    heartbeatTimeoutMs: 300_000,
    settleDelayMs: 0,
  });

  try {
    h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w1', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w2', { agentId: 'codex' });

    const { run } = h.service.runCreate({
      id: 'run_stall_recover',
      objective: 'Stall timeout and late worker_done correction',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't1', runId: run.id, spec: 'Step 1' });
    h.service.taskCreate({ id: 't2', runId: run.id, spec: 'Dependent step 2', deps: ['t1'] });

    // Dispatch t1 to w1 -> unobserved.
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
    const d1 = h.store.getLatestDispatchForTask('t1');
    assert.ok(d1);
    assert.equal(d1.startObservation, 'unobserved');
    assert.equal(h.store.getTask('t2')?.status, 'pending');
    const pasteCountAfterDispatch = h.pasteWritesFor('w1').length;
    assert.equal(pasteCountAfterDispatch, 1);

    // Just before threshold (9_999ms): still active.
    h.advance(9_999);
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
    assert.equal(h.store.getDispatchContext(d1.id)?.status, 'dispatched');
    assert.equal(h.store.getTask('t1')?.status, 'dispatched');

    // Cross startConfirmationTimeoutMs (10_000ms): fails with agent_prompt_stalled and forceFailTask: true.
    h.advance(1);
    const stalledTick = await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
    assert.equal(stalledTick.converged, true); // t1 failed, so t2 is blocked by its failed dependency
    const d1Stalled = h.store.getDispatchContext(d1.id);
    assert.equal(d1Stalled?.status, 'failed');
    assert.equal(d1Stalled?.failureCount, 1);
    assert.ok(d1Stalled?.lastFailureReason?.startsWith(`${AGENT_PROMPT_STALLED_ERROR}:`));
    assert.equal(h.store.getTask('t1')?.status, 'failed');
    assert.equal(h.store.getTask('t2')?.status, 'blocked');
    assert.ok(h.events.some((e) => e.reason === 'coordinator:start-timeout'));

    // Next tick does NOT blindly re-paste or re-dispatch failed task.
    h.advance(5_000);
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
    assert.equal(h.pasteWritesFor('w1').length, pasteCountAfterDispatch);
    assert.equal(h.store.getTask('t1')?.status, 'failed');
    assert.equal(h.store.getTask('t2')?.status, 'blocked');

    // Unauthorized late workerDone on stalled dispatch is rejected cleanly.
    const unauth = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(d1.id),
      from: 'rogue-worker',
      taskId: 't1',
      dispatchId: d1.id,
      outcome: 'completed',
      summary: 'Spoofed completion',
    });
    assert.equal(unauth.lifecycle.action, 'rejected');
    assert.equal(h.store.getDispatchContext(d1.id)?.status, 'failed');
    assert.equal(h.store.getTask('t1')?.status, 'failed');

    // Authorized late workerDone settles stalled dispatch & task to completed and readies downstream t2.
    h.advance(1_000);
    const recovered = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(d1.id),
      from: 'w1',
      taskId: 't1',
      dispatchId: d1.id,
      outcome: 'completed',
      summary: 'Worker completed without emitting working hook',
    });
    assert.equal(recovered.lifecycle.action, 'settled');
    assert.equal(recovered.dispatch.status, 'completed');
    assert.equal(recovered.dispatch.startObservation, 'observed');
    assert.equal(recovered.dispatch.lastFailureReason, null);
    assert.equal(recovered.dispatch.failureSummary, null);
    assert.ok(recovered.dispatch.turnStartedAt);
    assert.equal(recovered.task.status, 'completed');
    assert.equal(h.store.getTask('t2')?.status, 'ready');

    // Next tick dispatches downstream t2 cleanly.
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w2'] });
    const d2 = h.store.getLatestDispatchForTask('t2');
    assert.ok(d2);
    assert.equal(h.store.getTask('t2')?.status, 'dispatched');

    // Second duplicate workerDone on d1 returns duplicate without error or corrupting t2.
    const dup = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(d1.id),
      from: 'w1',
      taskId: 't1',
      dispatchId: d1.id,
      outcome: 'completed',
      summary: 'Duplicate report',
    });
    assert.equal(dup.lifecycle.action, 'duplicate');
    assert.equal(dup.dispatch.status, 'completed');
    assert.equal(dup.task.status, 'completed');
    assert.equal(h.store.getTask('t2')?.status, 'dispatched');

    // Also verify 'pending' startObservation times out identically and superseded stalled dispatch rejects late reports.
    h.agentStatusStore.registerPane('w3', { agentId: 'claude' });
    const { run: run2 } = h.service.runCreate({
      id: 'run_superseded',
      objective: 'Pending timeout and superseded dispatch rejection',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_sup', runId: run2.id, spec: 'Superseded task' });
    const dOldPending = h.store.createDispatchContext({
      taskId: 't_sup',
      assigneeHandle: 'w1',
      assigneePaneId: 'w1',
      startObservation: 'pending',
    });
    assert.equal(dOldPending.startObservation, 'pending');
    assert.equal(dOldPending.promptSentAt, null);

    // Never injected (promptSentAt = null): the start-confirmation timeout must NOT fire.
    h.advance(10_000);
    await h.service.coordinatorTick(run2.id, { workerPaneIds: [] });
    assert.equal(h.store.getDispatchContext(dOldPending.id)?.status, 'dispatched');
    assert.equal(h.store.getTask('t_sup')?.status, 'dispatched');

    // Once actually delivered, the timeout counts from the delivery anchor, not createdAt.
    h.store.updateDispatchObservation(dOldPending.id, 'pending', { promptSent: true });
    await h.service.coordinatorTick(run2.id, { workerPaneIds: [] });
    assert.equal(h.store.getDispatchContext(dOldPending.id)?.status, 'dispatched');

    h.advance(10_000);
    await h.service.coordinatorTick(run2.id, { workerPaneIds: [] });
    assert.equal(h.store.getDispatchContext(dOldPending.id)?.status, 'failed');
    assert.ok(
      h.store.getDispatchContext(dOldPending.id)?.lastFailureReason?.startsWith(
        `${AGENT_PROMPT_STALLED_ERROR}:`
      )
    );
    assert.equal(h.store.getTask('t_sup')?.status, 'failed');

    // Re-open task and create a newer dispatch dNew; late workerDone for dOldPending must be rejected.
    h.advance(1_000);
    h.service.taskUpdate({ id: 't_sup', status: 'ready' });
    const dNewRes = await h.service.dispatchTask({
      taskId: 't_sup',
      to: 'w3',
      from: 'coord',
    });
    assert.ok(dNewRes.dispatch);

    const lateWhileNewActive = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(dOldPending.id),
      from: 'w1',
      taskId: 't_sup',
      dispatchId: dOldPending.id,
      outcome: 'completed',
    });
    assert.equal(lateWhileNewActive.lifecycle.action, 'rejected');
    assert.equal(h.store.getDispatchContext(dNewRes.dispatch.id)?.status, 'dispatched');
    assert.equal(h.store.getTask('t_sup')?.status, 'dispatched');

    // Even if dNew also stalls and task becomes 'failed', old superseded dOldPending must still be rejected.
    h.advance(10_000);
    await h.service.coordinatorTick(run2.id, { workerPaneIds: [] });
    assert.equal(h.store.getTask('t_sup')?.status, 'failed');
    const lateWhenNewAlsoFailed = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(dOldPending.id),
      from: 'w1',
      taskId: 't_sup',
      dispatchId: dOldPending.id,
      outcome: 'completed',
    });
    assert.equal(lateWhenNewAlsoFailed.lifecycle.action, 'rejected');
    assert.equal(h.store.getTask('t_sup')?.status, 'failed');
  } finally {
    h.dispose();
  }
});

test('4. heartbeat timeout parks observed dispatches without retry, queued/unsupported are exempt, and late workerDone settles', async () => {
  let autoEmitWorking = true;
  const h = createClockedHarness({
    turnStartObserveTimeoutMs: 25,
    startConfirmationTimeoutMs: 60_000,
    heartbeatTimeoutMs: 15_000,
    settleDelayMs: 0,
    writePty: async (ptyId, data, writes) => {
      writes.push({ ptyId, data });
      if (autoEmitWorking && data === '\r') {
        h.agentStatusStore.ingestHookEvent({ ptyId, state: 'working' });
      }
      return { ok: true };
    },
  });

  try {
    h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w1', { agentId: 'claude' });

    const { run } = h.service.runCreate({
      id: 'run_hb',
      objective: 'Heartbeat timeout & circuit break',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_flaky', runId: run.id, spec: 'Silent hang task' });

    // Attempt 1: becomes observed.
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
    const d1 = h.store.getLatestDispatchForTask('t_flaky');
    assert.ok(d1);
    assert.equal(d1.startObservation, 'observed');
    assert.equal(d1.failureCount, 0);

    // Advance past heartbeatTimeoutMs: the worker is parked, NOT retried. w1 may still be
    // executing the task, so re-dispatching it to another pane would run the task twice.
    const writesBeforeTimeout = h.pasteWritesFor('w1').length;
    h.advance(15_000);
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
    const d1Failed = h.store.getDispatchContext(d1.id);
    assert.equal(d1Failed?.status, 'failed');
    assert.equal(d1Failed?.failureCount, 0); // unresponsiveness is not a retryable failure
    assert.ok(d1Failed?.lastFailureReason?.startsWith('heartbeat_timeout:'));
    assert.equal(h.store.getTask('t_flaky')?.status, 'blocked');
    assert.ok(h.events.some((e) => e.reason === 'coordinator:heartbeat-timeout'));
    assert.ok(
      h.store
        .getAllMessagesForHandle(`run:${run.id}`, { types: ['escalation'] })
        .some((m) => m.payload?.includes(d1.id))
    );

    // An idle pane is available, but the blocked task must never be re-dispatched.
    h.agentStatusStore.registerPane('w2', { agentId: 'codex' });
    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w2'] });
    assert.equal(h.store.getLatestDispatchForTask('t_flaky')?.id, d1.id);
    assert.equal(h.pasteWritesFor('w1').length, writesBeforeTimeout);
    assert.equal(h.pasteWritesFor('w2').length, 0);

    // The still-running worker's late report is authoritative and settles the task.
    const late = h.service.workerDone({
    capability: h.service.store.getDispatchCapability(d1.id),
      from: 'w1',
      taskId: 't_flaky',
      dispatchId: d1.id,
      outcome: 'completed',
      summary: 'Finished after the heartbeat timeout',
    });
    assert.equal(late.lifecycle.action, 'settled');
    assert.equal(late.dispatch.status, 'completed');
    assert.equal(late.task.status, 'completed');

    // 'queued' turns wait behind earlier work and are exempt from the heartbeat timeout.
    autoEmitWorking = false;
    const { run: runQueued } = h.service.runCreate({
      id: 'run_hb_queued',
      objective: 'Queued heartbeat exemption',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_q_hb', runId: runQueued.id, spec: 'Queued behind earlier work' });
    h.agentStatusStore.registerPane('w_q', { agentId: 'claude' });
    atNextDelivery(h.service, () => h.agentStatusStore.ingestHookEvent({ ptyId: 'w_q', state: 'working' }));
    const qDisp = await h.service.dispatchTask({ taskId: 't_q_hb', to: 'w_q', from: 'coord' });
    assert.equal(qDisp.dispatch?.startObservation, 'queued');
    assert.equal(qDisp.dispatch?.queuedWorkingBaseline != null, true);

    h.advance(15_000);
    await h.service.coordinatorTick(runQueued.id, { workerPaneIds: [] });
    const qAlive = h.store.getDispatchContext(qDisp.dispatch.id);
    assert.equal(qAlive?.status, 'dispatched');
    assert.equal(qAlive?.lastFailureReason, null);
    assert.equal(h.store.getTask('t_q_hb')?.status, 'dispatched');

    // 'unsupported' panes cannot report activity at all, so they are exempt too.
    const rawHarness = createClockedHarness({
      heartbeatTimeoutMs: 15_000,
      settleDelayMs: 0,
      isPtyAlive: () => true,
    });
    try {
      rawHarness.agentStatusStore.registerPane('coord', { agentId: 'claude' });
      const { run: runRaw } = rawHarness.service.runCreate({
        id: 'run_hb_unsupported',
        objective: 'Unsupported heartbeat exemption',
        from: 'coord',
        paneId: 'coord',
      });
      rawHarness.service.taskCreate({ id: 't_raw', runId: runRaw.id, spec: 'Unregistered pane' });
      rawHarness.agentStatusStore.registerPane('w_raw', { agentId: 'codex' });
      atNextDelivery(rawHarness.service, () => rawHarness.agentStatusStore.removePane('w_raw'));
      const rawDisp = await rawHarness.service.dispatchTask({
        taskId: 't_raw',
        to: 'w_raw',
        from: 'coord',
      });
      assert.equal(rawDisp.dispatch?.startObservation, 'unsupported');
      rawHarness.advance(15_000);
      rawHarness.service.reconcileStaleDispatches();
      assert.equal(rawHarness.store.getDispatchContext(rawDisp.dispatch.id)?.status, 'dispatched');
      assert.equal(rawHarness.store.getTask('t_raw')?.status, 'dispatched');
    } finally {
      rawHarness.dispose();
    }

    // Periodic 'working' activity and explicit heartbeat prevent premature timeout.
    autoEmitWorking = true;
    const { run: runAlive } = h.service.runCreate({
      id: 'run_hb_alive',
      objective: 'Heartbeat keepalive',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_alive', runId: runAlive.id, spec: 'Long task with activity' });
    h.agentStatusStore.registerPane('w_alive', { agentId: 'claude' });

    await h.service.coordinatorTick(runAlive.id, { workerPaneIds: ['w_alive'] });
    const dAlive = h.store.getLatestDispatchForTask('t_alive');
    assert.ok(dAlive);
    assert.equal(dAlive.startObservation, 'observed');

    // Refresh via working activity at +10s (past 5s minHeartbeatIntervalMs).
    const tPing1 = h.advance(10_000);
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w_alive', state: 'working' });
    assert.equal(
      h.store.getDispatchContext(dAlive.id)?.lastHeartbeatAt,
      new Date(tPing1).toISOString()
    );

    // At +18s since dispatch (8s since working ping < 15s timeout), tick keeps dispatch alive.
    h.advance(8_000);
    await h.service.coordinatorTick(runAlive.id, { workerPaneIds: [] });
    assert.equal(h.store.getDispatchContext(dAlive.id)?.status, 'dispatched');

    // Refresh via explicit orchestration heartbeat message at +20s.
    const tPing2 = h.advance(2_000);
    h.service.send({
    capability: h.service.store.getDispatchCapability(dAlive.id),
      from: `dispatch:${dAlive.id}`,
      to: `run:${runAlive.id}`,
      type: 'heartbeat',
      subject: 'still running',
      payload: { dispatchId: dAlive.id },
    });
    assert.equal(
      h.store.getDispatchContext(dAlive.id)?.lastHeartbeatAt,
      new Date(tPing2).toISOString()
    );

    // At +32s since dispatch (12s since explicit heartbeat < 15s timeout), still alive.
    h.advance(12_000);
    await h.service.coordinatorTick(runAlive.id, { workerPaneIds: [] });
    assert.equal(h.store.getDispatchContext(dAlive.id)?.status, 'dispatched');

    // After full 15s silence since explicit heartbeat, timeout triggers cleanly.
    h.advance(3_000);
    await h.service.coordinatorTick(runAlive.id, { workerPaneIds: [] });
    assert.equal(h.store.getDispatchContext(dAlive.id)?.status, 'failed');
    assert.ok(
      h.store.getDispatchContext(dAlive.id)?.lastFailureReason?.startsWith('heartbeat_timeout:')
    );
  } finally {
    h.dispose();
  }
});

test('5. maxConcurrent throttles dispatches and restores availableSlots when writePty fails or throws without retrying failed pane in same tick', async () => {
  // 5a. maxConcurrent: 2 with 4 ready tasks & 4 idle panes.
  {
    const nowMs = Date.UTC(2026, 0, 1, 14, 0, 0);
    const store = new OrchestrationStore({ now: () => new Date(nowMs).toISOString() });
    const agentStatusStore = new AgentStatusStore({ now: () => nowMs });
    try {
      agentStatusStore.registerPane('coord', { agentId: 'claude' });
      for (const p of ['w1', 'w2', 'w3', 'w4']) {
        agentStatusStore.registerPane(p, { agentId: 'codex' });
      }
      const run = store.createRun({
        id: 'run_max_conc',
        objective: 'Concurrency cap',
        coordinatorHandle: 'coord',
        coordinatorPaneId: 'coord',
      });
      for (const id of ['t1', 't2', 't3', 't4']) {
        store.createTask({ id, runId: run.id, spec: `Task ${id}` });
      }

      const runtime = createCoordinatorRuntimeForStore({
        store,
        agentStatusStore,
        coordinatorPaneId: 'coord',
        writePty: async () => ({ ok: true }),
      });
      const coordinator = new Coordinator(store, runtime, {
        runId: run.id,
        spec: run.objective,
        coordinatorHandle: 'coord',
        coordinatorPaneId: 'coord',
        maxConcurrent: 2,
        autoSpawnWorkers: false,
        now: () => nowMs,
      });

      await coordinator.tick();
      assert.equal(store.listTasks({ runId: run.id, status: 'dispatched' }).length, 2);
      assert.equal(store.listTasks({ runId: run.id, status: 'ready' }).length, 2);

      const d1 = store.getLatestDispatchForTask('t1');
      assert.ok(d1);
      store.settleWorkerReport({
        dispatchId: d1.id,
        taskId: 't1',
        outcome: 'completed',
        reportedByHandle: d1.assigneeHandle,
      });

      await coordinator.tick();
      assert.equal(store.getTask('t1')?.status, 'completed');
      assert.equal(store.listTasks({ runId: run.id, status: 'dispatched' }).length, 2);
      assert.equal(store.listTasks({ runId: run.id, status: 'ready' }).length, 1);
    } finally {
      store.close();
    }
  }

  // 5b. availableSlots restored on writePty { ok: false }, writePty throw, and sendTurn throw without retrying w1 in same tick.
  for (const failureMode of ['return_false', 'write_throw', 'send_turn_throw']) {
    const nowMs = Date.UTC(2026, 0, 1, 15, 0, 0);
    const store = new OrchestrationStore({ now: () => new Date(nowMs).toISOString() });
    const agentStatusStore = new AgentStatusStore({ now: () => nowMs });
    try {
      agentStatusStore.registerPane('coord', { agentId: 'claude' });
      for (const p of ['w1', 'w2', 'w3']) {
        agentStatusStore.registerPane(p, { agentId: 'codex' });
      }
      const run = store.createRun({
        id: `run_slots_${failureMode}`,
        objective: `Slot leak check (${failureMode})`,
        coordinatorHandle: 'coord',
        coordinatorPaneId: 'coord',
      });
      for (const id of ['t1', 't2', 't3']) {
        store.createTask({ id, runId: run.id, spec: `Task ${id}` });
      }

      const attemptsByPane = new Map();
      const notifications = [];
      const baseRuntime = createCoordinatorRuntimeForStore({
        store,
        agentStatusStore,
        coordinatorPaneId: 'coord',
        notifications,
        writePty: async (ptyId) => {
          attemptsByPane.set(ptyId, (attemptsByPane.get(ptyId) ?? 0) + 1);
          if (ptyId === 'w1') {
            if (failureMode === 'return_false') {
              return { ok: false, error: 'Simulated PTY write failure' };
            }
            if (failureMode === 'write_throw') {
              throw new Error('Simulated PTY write exception');
            }
          }
          return { ok: true };
        },
      });
      const runtime =
        failureMode === 'send_turn_throw'
          ? {
              ...baseRuntime,
              sendTurn: async (turn) => {
                if (turn.ptyId === 'w1') {
                  attemptsByPane.set('w1', (attemptsByPane.get('w1') ?? 0) + 1);
                  throw new Error('Simulated sendTurn exception');
                }
                return baseRuntime.sendTurn(turn);
              },
            }
          : baseRuntime;

      const coordinator = new Coordinator(store, runtime, {
        runId: run.id,
        spec: run.objective,
        coordinatorHandle: 'coord',
        coordinatorPaneId: 'coord',
        maxConcurrent: 2,
        autoSpawnWorkers: false,
        now: () => nowMs,
      });

      await coordinator.tick();

      // w1 failed once and was NOT retried again in the same tick; w2 and w3 both dispatched in the same tick.
      assert.equal(attemptsByPane.get('w1'), 1);
      assert.ok((attemptsByPane.get('w2') ?? 0) >= 1);
      assert.ok((attemptsByPane.get('w3') ?? 0) >= 1);

      assert.equal(store.getTask('t1')?.status, 'ready');
      assert.equal(store.getLatestDispatchForTask('t1')?.status, 'failed');
      assert.equal(store.getLatestDispatchForTask('t1')?.assigneeHandle, 'w1');

      assert.equal(store.getTask('t2')?.status, 'dispatched');
      assert.equal(store.getTask('t3')?.status, 'dispatched');
      const activeDispatches = store
        .listDispatches({ runId: run.id })
        .filter((d) => d.status === 'dispatched');
      assert.equal(activeDispatches.length, 2);
      assert.deepEqual(
        activeDispatches.map((d) => d.assigneeHandle).sort(),
        ['w2', 'w3']
      );
      assert.ok(notifications.some((n) => n.reason === 'coordinator:dispatch-failed'));
    } finally {
      store.close();
    }
  }
});

test('6. mid-delivery pane exit fails cleanly without orphaned dispatched task, legacy JSON hydrates safely, and dispatchStartDiagnostic matches contract', async () => {
  // 6a. Pane marked exited during deliverPromptToPty settleDelayMs (both dispatchTask and coordinatorTick).
  {
    const h = createClockedHarness({
      settleDelayMs: 30,
      turnStartObserveTimeoutMs: 40,
      writePty: async (ptyId, data, writes) => {
        writes.push({ ptyId, data });
        if (data.includes('\x1b[200~')) {
          setTimeout(() => {
            h.service.markPtyExited(ptyId);
          }, 5);
        }
        return { ok: true };
      },
    });

    try {
      h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
      h.agentStatusStore.registerPane('w_settle_1', { agentId: 'claude' });
      h.agentStatusStore.registerPane('w_settle_2', { agentId: 'claude' });

      const { run } = h.service.runCreate({
        id: 'run_exit_settle',
        objective: 'Exit during settle delay (manual)',
        from: 'coord',
        paneId: 'coord',
      });
      h.service.taskCreate({ id: 't_s1', runId: run.id, spec: 'Exit during manual settle' });

      await assert.rejects(
        () => h.service.dispatchTask({ taskId: 't_s1', to: 'w_settle_1', from: 'coord' }),
        (err) => err instanceof OrchestrationError && err.code === 'terminal_unavailable'
      );
      assert.equal(h.store.getTask('t_s1')?.status, 'ready');
      assert.equal(h.store.getLatestDispatchForTask('t_s1')?.status, 'failed');

      const { run: runCoord } = h.service.runCreate({
        id: 'run_exit_settle_coord',
        objective: 'Exit during settle delay (coordinator)',
        from: 'coord',
        paneId: 'coord',
      });
      h.service.taskCreate({ id: 't_s2', runId: runCoord.id, spec: 'Exit during coordinator settle' });

      await h.service.coordinatorTick(runCoord.id, { workerPaneIds: ['w_settle_2'] });
      assert.equal(h.store.getTask('t_s2')?.status, 'ready');
      assert.equal(h.store.getLatestDispatchForTask('t_s2')?.status, 'failed');
    } finally {
      h.dispose();
    }
  }

  // 6b. Pane marked exited during turnStartObserveTimeoutMs wait (both dispatchTask and coordinatorTick).
  {
    const h = createClockedHarness({
      settleDelayMs: 0,
      turnStartObserveTimeoutMs: 120,
      writePty: async (ptyId, data, writes) => {
        writes.push({ ptyId, data });
        if (data === '\r') {
          setTimeout(() => {
            h.service.markPtyExited(ptyId);
          }, 15);
        }
        return { ok: true };
      },
    });

    try {
      h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
      h.agentStatusStore.registerPane('w_obs_1', { agentId: 'codex' });
      h.agentStatusStore.registerPane('w_obs_2', { agentId: 'codex' });

      const { run } = h.service.runCreate({
        id: 'run_exit_observe',
        objective: 'Exit during observation window (manual)',
        from: 'coord',
        paneId: 'coord',
      });
      h.service.taskCreate({ id: 't_o1', runId: run.id, spec: 'Exit during manual observe' });

      await assert.rejects(
        () => h.service.dispatchTask({ taskId: 't_o1', to: 'w_obs_1', from: 'coord' }),
        (err) => err instanceof OrchestrationError && err.code === 'terminal_unavailable'
      );
      assert.equal(h.store.getTask('t_o1')?.status, 'ready');
      assert.equal(h.store.getLatestDispatchForTask('t_o1')?.status, 'failed');

      const { run: runCoord } = h.service.runCreate({
        id: 'run_exit_observe_coord',
        objective: 'Exit during observation window (coordinator)',
        from: 'coord',
        paneId: 'coord',
      });
      h.service.taskCreate({ id: 't_o2', runId: runCoord.id, spec: 'Exit during coordinator observe' });

      await h.service.coordinatorTick(runCoord.id, { workerPaneIds: ['w_obs_2'] });
      assert.equal(h.store.getTask('t_o2')?.status, 'ready');
      assert.equal(h.store.getLatestDispatchForTask('t_o2')?.status, 'failed');
    } finally {
      h.dispose();
    }
  }

  // 6c. OrchestrationStore.load() hydrates legacy JSON missing observation fields safely.
  {
    const dir = mkdtempSync(join(tmpdir(), 'aha-orch-legacy-'));
    const stateFile = join(dir, 'orchestration-state.json');
    const ts = '2026-01-01T00:00:00.000Z';
    const legacyPayload = {
      version: 1,
      nextSequence: 1,
      currentRunByConsumer: { coord: 'run_legacy' },
      runs: [
        {
          id: 'run_legacy',
          objective: 'Legacy run',
          status: 'active',
          coordinatorHandle: 'coord',
          coordinatorPaneId: 'coord',
          consumerGeneration: 1,
          createdAt: ts,
          updatedAt: ts,
          endedAt: null,
        },
      ],
      tasks: [
        {
          id: 't_legacy',
          runId: 'run_legacy',
          spec: 'Legacy task',
          taskTitle: 'Legacy task',
          displayName: 'Legacy task',
          deps: [],
          priority: 'normal',
          status: 'dispatched',
          worktreePath: null,
          createdAt: ts,
          updatedAt: ts,
        },
      ],
      dispatches: [
        {
          id: 'ctx_legacy',
          taskId: 't_legacy',
          runId: 'run_legacy',
          creator: 'coord',
          creatorRunId: 'run_legacy',
          depth: 1,
          assigneeHandle: 'w1',
          assigneePaneId: 'w1',
          processIncarnation: null,
          status: 'dispatched',
          failureCount: 0,
          lastFailureReason: null,
          failureSummary: null,
          lastHeartbeatAt: ts,
          consumerGeneration: 1,
          createdAt: ts,
          updatedAt: ts,
          completedAt: null,
        },
      ],
      gates: [],
      messages: [],
      deliveries: [],
      questions: [],
      coordinatorRuns: [],
    };
    writeFileSync(stateFile, JSON.stringify(legacyPayload), 'utf8');

    const store = new OrchestrationStore({ resolveFile: () => stateFile });
    try {
      store.load();
      const hydrated = store.getDispatchContext('ctx_legacy');
      assert.ok(hydrated);
      assert.equal(hydrated.startObservation, 'pending');
      assert.equal(hydrated.startObservationReason, null);
      assert.equal(hydrated.turnStartedAt, null);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }

  // 6d. Verify dispatchStartDiagnostic in src/lib/orchestration-view.ts.
  {
    const dir = mkdtempSync(join(tmpdir(), 'aha-orch-view-'));
    try {
      const source = readFileSync(new URL('../src/lib/orchestration-view.ts', import.meta.url), 'utf8');
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      const viewFile = join(dir, 'orchestration-view.mjs');
      writeFileSync(viewFile, output, 'utf8');
      const view = await import(pathToFileURL(viewFile).href);

      assert.equal(view.dispatchStartDiagnostic(null), null);
      assert.equal(view.dispatchStartDiagnostic(undefined), null);

      for (const obs of ['pending', 'observed', 'unsupported']) {
        assert.equal(
          view.dispatchStartDiagnostic({
            status: 'dispatched',
            startObservation: obs,
            startObservationReason: 'Ignored',
          }),
          null
        );
      }

      for (const inactiveStatus of ['pending', 'completed', 'failed', 'circuit_broken']) {
        assert.equal(
          view.dispatchStartDiagnostic({
            status: inactiveStatus,
            startObservation: 'unobserved',
            startObservationReason: 'Stalled',
          }),
          null
        );
      }

      assert.deepEqual(
        view.dispatchStartDiagnostic({
          status: 'dispatched',
          startObservation: 'unobserved',
          startObservationReason: '  Prompt written; awaiting hook  ',
        }),
        {
          observation: 'unobserved',
          label: view.START_OBSERVATION_LABELS.unobserved,
          tone: view.START_OBSERVATION_TONES.unobserved,
          reason: 'Prompt written; awaiting hook',
        }
      );

      assert.deepEqual(
        view.dispatchStartDiagnostic({
          status: 'dispatched',
          startObservation: 'permission',
          startObservationReason: '   ',
        }),
        {
          observation: 'permission',
          label: view.START_OBSERVATION_LABELS.permission,
          tone: view.START_OBSERVATION_TONES.permission,
          reason: null,
        }
      );

      assert.deepEqual(
        view.dispatchStartDiagnostic({
          status: 'dispatched',
          startObservation: 'queued',
          startObservationReason: null,
        }),
        {
          observation: 'queued',
          label: view.START_OBSERVATION_LABELS.queued,
          tone: view.START_OBSERVATION_TONES.queued,
          reason: null,
        }
      );
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }
});

test('7. Defect 1 regression: raw PTY stdout mid-delivery or post-settle never falsely promotes queued dispatch to observed until workingSequence advances', async (t) => {
  const h = createClockedHarness({
    turnStartObserveTimeoutMs: 40,
    settleDelayMs: 25,
    writePty: async (ptyId, data, writes) => {
      writes.push({ ptyId, data });
      if (data.includes('\x1b[200~')) {
        // Emit prior-turn stdout mid-delivery during settleDelayMs while deliverAndObserveAgentTurn is awaiting.
        setTimeout(() => {
          h.agentStatusStore.ingestPtyData(ptyId, 'prior turn stdout chunk during settle\r\n');
        }, 5);
      }
      return { ok: true };
    },
  });

  try {
    h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w_manual_q', { agentId: 'codex' });
    h.agentStatusStore.registerPane('w_coord_q', { agentId: 'claude' });

    const { run } = h.service.runCreate({
      id: 'run_defect1_stdout',
      objective: 'Verify stdout does not falsely promote queued dispatches',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_q_manual', runId: run.id, spec: 'Manual queued stdout check' });
    h.service.taskCreate({ id: 't_q_coord', runId: run.id, spec: 'Coordinator queued stdout check' });

    // 7a. Manual dispatchTask to an already-'working' pane.
    const seqManualBefore = 1;
    atNextDelivery(h.service, () => h.agentStatusStore.ingestHookEvent({ ptyId: 'w_manual_q', state: 'working' }));

    const manualRes = await h.service.dispatchTask({
      taskId: 't_q_manual',
      to: 'w_manual_q',
      from: 'coord',
    });
    assert.equal(manualRes.dispatch?.startObservation, 'queued');
    assert.equal(manualRes.dispatch?.turnStartedAt, null);

    // Post-settle raw stdout chunks without a new working hook must keep startObservation === 'queued'.
    h.advance(1_000);
    h.agentStatusStore.ingestPtyData('w_manual_q', 'post-settle stdout 1\r\n');
    h.agentStatusStore.ingestPtyData('w_manual_q', 'post-settle stdout 2\r\n');
    assert.equal(h.agentStatusStore.getActivitySnapshot('w_manual_q')?.workingSequence, seqManualBefore);
    const manualAfterStdout = h.store.getDispatchContext(manualRes.dispatch.id);
    assert.equal(manualAfterStdout?.startObservation, 'queued');
    assert.equal(manualAfterStdout?.turnStartedAt, null);
    assert.equal(h.events.filter((e) => e.reason === 'dispatch:observed').length, 0);

    // Only a new working hook that increments workingSequence promotes 'queued' -> 'observed'.
    const manualObservedMs = h.advance(1_000);
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w_manual_q', state: 'working' });
    const manualObserved = h.store.getDispatchContext(manualRes.dispatch.id);
    assert.equal(h.agentStatusStore.getActivitySnapshot('w_manual_q')?.workingSequence, 2);
    assert.equal(manualObserved?.startObservation, 'observed');
    assert.equal(manualObserved?.turnStartedAt, new Date(manualObservedMs).toISOString());
    assert.equal(h.events.filter((e) => e.reason === 'dispatch:observed').length, 1);

    // Settle t_q_manual so coordinatorTick only dispatches t_q_coord.
    h.service.workerDone({
    capability: h.service.store.getDispatchCapability(manualRes.dispatch.id),
      from: 'w_manual_q',
      taskId: 't_q_manual',
      dispatchId: manualRes.dispatch.id,
      outcome: 'completed',
    });

    // 7b. coordinatorTick (sendTurn) when pane enters 'working' right before dispatch creation / delivery.
    atNextDelivery(h.service, () => h.agentStatusStore.ingestHookEvent({ ptyId: 'w_coord_q', state: 'working' }));

    await h.service.coordinatorTick(run.id, { workerPaneIds: ['w_coord_q'] });
    const dCoordQ = h.store.getLatestDispatchForTask('t_q_coord');
    assert.ok(dCoordQ);
    assert.equal(dCoordQ.startObservation, 'queued');
    assert.equal(dCoordQ.turnStartedAt, null);
    assert.equal(h.agentStatusStore.getActivitySnapshot('w_coord_q')?.workingSequence, 1);

    // Post-settle raw stdout must not promote coordinator-dispatched 'queued' -> 'observed'.
    h.advance(1_000);
    h.agentStatusStore.ingestPtyData('w_coord_q', 'more prior-turn stdout\r\n');
    h.agentStatusStore.ingestPtyData('w_coord_q', 'still streaming old output\r\n');
    const coordAfterStdout = h.store.getDispatchContext(dCoordQ.id);
    assert.equal(coordAfterStdout?.startObservation, 'queued');
    assert.equal(coordAfterStdout?.turnStartedAt, null);
    assert.equal(h.events.filter((e) => e.reason === 'dispatch:observed').length, 1);

    // New working hook advances workingSequence and promotes 'queued' -> 'observed'.
    const coordObservedMs = h.advance(1_000);
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w_coord_q', state: 'working' });
    const coordObserved = h.store.getDispatchContext(dCoordQ.id);
    assert.equal(h.agentStatusStore.getActivitySnapshot('w_coord_q')?.workingSequence, 2);
    assert.equal(coordObserved?.startObservation, 'observed');
    assert.equal(coordObserved?.turnStartedAt, new Date(coordObservedMs).toISOString());
    assert.equal(h.events.filter((e) => e.reason === 'dispatch:observed').length, 2);
  } finally {
    h.dispose();
  }
});

test('8. Defect 2 regression: single-side synthetic-epoch clock injection aligns Store, Service, and Coordinator timeout boundaries', async () => {
  const INITIAL_EPOCH = 1_000_000;

  // 8a. now injected ONLY on OrchestrationService (OrchestrationStore uses default constructor).
  {
    let nowMs = INITIAL_EPOCH;
    const store = new OrchestrationStore();
    const agentStatusStore = new AgentStatusStore({ now: () => nowMs });
    const service = createTrackedTestService({
      store,
      agentStatusStore,
      writePty: async () => ({ ok: true }),
      turnStartObserveTimeoutMs: 25,
      startConfirmationTimeoutMs: 10_000,
      heartbeatTimeoutMs: 20_000,
      settleDelayMs: 0,
      now: () => nowMs,
    });

    try {
      agentStatusStore.registerPane('coord', { agentId: 'claude' });
      agentStatusStore.registerPane('w1', { agentId: 'claude' });
      agentStatusStore.registerPane('w2', { agentId: 'codex' });

      const { run } = service.runCreate({
        id: 'run_clk_svc',
        objective: 'Service-only clock injection',
        from: 'coord',
        paneId: 'coord',
      });
      service.taskCreate({ id: 't_start', runId: run.id, spec: 'Start timeout boundary' });
      service.taskCreate({ id: 't_hb', runId: run.id, spec: 'Heartbeat timeout boundary' });

      await service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
      const dStart = store.getLatestDispatchForTask('t_start');
      assert.ok(dStart);
      assert.equal(Date.parse(dStart.createdAt), INITIAL_EPOCH);
      assert.equal(dStart.startObservation, 'unobserved');

      nowMs += 9_999;
      await service.coordinatorTick(run.id, { workerPaneIds: [] });
      assert.equal(store.getDispatchContext(dStart.id)?.status, 'dispatched');

      nowMs += 1;
      await service.coordinatorTick(run.id, { workerPaneIds: ['w2'] });
      assert.equal(store.getDispatchContext(dStart.id)?.status, 'failed');
      assert.ok(
        store.getDispatchContext(dStart.id)?.lastFailureReason?.startsWith(`${AGENT_PROMPT_STALLED_ERROR}:`)
      );

      // t_hb was dispatched to w2 on that same tick at INITIAL_EPOCH + 10_000.
      const dHb = store.getLatestDispatchForTask('t_hb');
      assert.ok(dHb);
      assert.equal(Date.parse(dHb.createdAt), INITIAL_EPOCH + 10_000);
      agentStatusStore.ingestHookEvent({ ptyId: 'w2', state: 'working' });
      assert.equal(store.getDispatchContext(dHb.id)?.startObservation, 'observed');

      nowMs += 19_999;
      await service.coordinatorTick(run.id, { workerPaneIds: [] });
      assert.equal(store.getDispatchContext(dHb.id)?.status, 'dispatched');

      nowMs += 1;
      await service.coordinatorTick(run.id, { workerPaneIds: [] });
      assert.equal(store.getDispatchContext(dHb.id)?.status, 'failed');
      assert.ok(store.getDispatchContext(dHb.id)?.lastFailureReason?.startsWith('heartbeat_timeout:'));
    } finally {
      service.dispose();
    }
  }

  // 8b. now injected ONLY on Coordinator directly (OrchestrationStore uses default constructor).
  {
    let nowMs = INITIAL_EPOCH;
    const store = new OrchestrationStore();
    const agentStatusStore = new AgentStatusStore({ now: () => nowMs });
    const runtime = createCoordinatorRuntimeForStore({
      store,
      agentStatusStore,
      coordinatorPaneId: 'coord',
      writePty: async () => ({ ok: true }),
      observeTimeoutMs: 0,
      settleDelayMs: 0,
    });
    const coordinator = new Coordinator(store, runtime, {
      runId: 'run_clk_coord',
      spec: 'Coordinator-only clock injection',
      coordinatorHandle: 'coord',
      coordinatorPaneId: 'coord',
      autoSpawnWorkers: false,
      startConfirmationTimeoutMs: 10_000,
      heartbeatTimeoutMs: 20_000,
      now: () => nowMs,
    });

    try {
      agentStatusStore.registerPane('coord', { agentId: 'claude' });
      agentStatusStore.registerPane('w1', { agentId: 'claude' });
      agentStatusStore.registerPane('w2', { agentId: 'codex' });

      const run = store.createRun({
        id: 'run_clk_coord',
        objective: 'Coordinator-only clock injection',
        coordinatorHandle: 'coord',
        coordinatorPaneId: 'coord',
      });
      store.createTask({ id: 't_c_start', runId: run.id, spec: 'Pending start timeout' });
      store.createTask({ id: 't_c_hb', runId: run.id, spec: 'Observed heartbeat timeout' });

      await coordinator.tick();
      const d1 = store.getLatestDispatchForTask('t_c_start');
      const d2 = store.getLatestDispatchForTask('t_c_hb');
      assert.ok(d1 && d2);
      assert.equal(Date.parse(d1.createdAt), INITIAL_EPOCH);
      assert.equal(Date.parse(d2.createdAt), INITIAL_EPOCH);
      assert.equal(d1.startObservation, 'pending');

      store.updateDispatchObservation(d2.id, 'observed', { refreshHeartbeat: true });

      nowMs += 9_999;
      await coordinator.tick();
      assert.equal(store.getDispatchContext(d1.id)?.status, 'dispatched');

      nowMs += 1;
      await coordinator.tick();
      assert.equal(store.getDispatchContext(d1.id)?.status, 'failed');
      assert.ok(
        store.getDispatchContext(d1.id)?.lastFailureReason?.startsWith(`${AGENT_PROMPT_STALLED_ERROR}:`)
      );
      assert.equal(store.getDispatchContext(d2.id)?.status, 'dispatched');

      nowMs += 9_999; // total 19_999ms since INITIAL_EPOCH
      await coordinator.tick();
      assert.equal(store.getDispatchContext(d2.id)?.status, 'dispatched');

      nowMs += 1; // total 20_000ms since INITIAL_EPOCH
      await coordinator.tick();
      assert.equal(store.getDispatchContext(d2.id)?.status, 'failed');
      assert.ok(store.getDispatchContext(d2.id)?.lastFailureReason?.startsWith('heartbeat_timeout:'));
    } finally {
      store.close();
    }
  }

  // 8c. now injected ONLY on OrchestrationStore (Service and Coordinator omit now).
  {
    let nowMs = INITIAL_EPOCH;
    const store = new OrchestrationStore({ now: () => new Date(nowMs).toISOString() });
    const agentStatusStore = new AgentStatusStore({ now: () => nowMs });
    assert.equal(store.hasCustomClock(), true);
    assert.equal(store.getClockMs(), INITIAL_EPOCH);

    const service = createTrackedTestService({
      store,
      agentStatusStore,
      writePty: async () => ({ ok: true }),
      turnStartObserveTimeoutMs: 25,
      startConfirmationTimeoutMs: 10_000,
      heartbeatTimeoutMs: 20_000,
      settleDelayMs: 0,
    });

    try {
      agentStatusStore.registerPane('coord', { agentId: 'claude' });
      agentStatusStore.registerPane('w1', { agentId: 'claude' });
      agentStatusStore.registerPane('w2', { agentId: 'codex' });
      agentStatusStore.registerPane('w3', { agentId: 'claude' });
      agentStatusStore.registerPane('w4', { agentId: 'codex' });

      // Via OrchestrationService omitting now:
      const { run } = service.runCreate({
        id: 'run_clk_store_svc',
        objective: 'Store-only clock with Service',
        from: 'coord',
        paneId: 'coord',
      });
      service.taskCreate({ id: 't_s_start', runId: run.id, spec: 'Service start boundary' });
      service.taskCreate({ id: 't_s_hb', runId: run.id, spec: 'Service heartbeat boundary' });

      await service.coordinatorTick(run.id, { workerPaneIds: ['w1'] });
      const dsStart = store.getLatestDispatchForTask('t_s_start');
      assert.ok(dsStart);
      assert.equal(Date.parse(dsStart.createdAt), INITIAL_EPOCH);

      nowMs += 9_999;
      await service.coordinatorTick(run.id, { workerPaneIds: [] });
      assert.equal(store.getDispatchContext(dsStart.id)?.status, 'dispatched');

      nowMs += 1;
      await service.coordinatorTick(run.id, { workerPaneIds: ['w2'] });
      assert.equal(store.getDispatchContext(dsStart.id)?.status, 'failed');
      assert.ok(
        store.getDispatchContext(dsStart.id)?.lastFailureReason?.startsWith(
          `${AGENT_PROMPT_STALLED_ERROR}:`
        )
      );

      const dsHb = store.getLatestDispatchForTask('t_s_hb');
      assert.ok(dsHb);
      agentStatusStore.ingestHookEvent({ ptyId: 'w2', state: 'working' });
      nowMs += 19_999;
      await service.coordinatorTick(run.id, { workerPaneIds: [] });
      assert.equal(store.getDispatchContext(dsHb.id)?.status, 'dispatched');

      nowMs += 1;
      await service.coordinatorTick(run.id, { workerPaneIds: [] });
      assert.equal(store.getDispatchContext(dsHb.id)?.status, 'failed');
      assert.ok(store.getDispatchContext(dsHb.id)?.lastFailureReason?.startsWith('heartbeat_timeout:'));

      // Via Coordinator omitting now (still inheriting Store's custom clock):
      const run2 = store.createRun({
        id: 'run_clk_store_coord',
        objective: 'Store-only clock with Coordinator',
        coordinatorHandle: 'coord',
        coordinatorPaneId: 'coord',
      });
      store.createTask({ id: 't_sc_start', runId: run2.id, spec: 'Direct Coordinator start boundary' });
      store.createTask({ id: 't_sc_hb', runId: run2.id, spec: 'Direct Coordinator hb boundary' });

      const runtime = createCoordinatorRuntimeForStore({
        store,
        agentStatusStore,
        coordinatorPaneId: 'coord',
        writePty: async () => ({ ok: true }),
      });
      const coordinator = new Coordinator(store, runtime, {
        runId: run2.id,
        spec: run2.objective,
        coordinatorHandle: 'coord',
        coordinatorPaneId: 'coord',
        autoSpawnWorkers: false,
        startConfirmationTimeoutMs: 10_000,
        heartbeatTimeoutMs: 20_000,
      });

      const base2 = nowMs;
      await coordinator.tick();
      const dsc1 = store.getLatestDispatchForTask('t_sc_start');
      const dsc2 = store.getLatestDispatchForTask('t_sc_hb');
      assert.ok(dsc1 && dsc2);
      assert.equal(Date.parse(dsc1.createdAt), base2);
      store.updateDispatchObservation(dsc2.id, 'observed', { refreshHeartbeat: true });

      nowMs += 9_999;
      await coordinator.tick();
      assert.equal(store.getDispatchContext(dsc1.id)?.status, 'dispatched');

      nowMs += 1;
      await coordinator.tick();
      assert.equal(store.getDispatchContext(dsc1.id)?.status, 'failed');
      assert.ok(
        store.getDispatchContext(dsc1.id)?.lastFailureReason?.startsWith(`${AGENT_PROMPT_STALLED_ERROR}:`)
      );

      nowMs += 9_999;
      await coordinator.tick();
      assert.equal(store.getDispatchContext(dsc2.id)?.status, 'dispatched');

      nowMs += 1;
      await coordinator.tick();
      assert.equal(store.getDispatchContext(dsc2.id)?.status, 'failed');
      assert.ok(store.getDispatchContext(dsc2.id)?.lastFailureReason?.startsWith('heartbeat_timeout:'));
    } finally {
      service.dispose();
    }
  }
});

test('9. stale sweep works without a coordinator, never-injected dispatches survive, and post-delivery bookkeeping failures do not re-queue', async () => {
  const h = createClockedHarness({
    turnStartObserveTimeoutMs: 25,
    startConfirmationTimeoutMs: 10_000,
    heartbeatTimeoutMs: 300_000,
    settleDelayMs: 0,
  });

  try {
    h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w1', { agentId: 'claude' });

    const { run } = h.service.runCreate({
      id: 'run_sweep',
      objective: 'Sweep without coordinator',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_manual', runId: run.id, spec: 'Manual unobserved dispatch' });
    h.service.taskCreate({ id: 't_preview', runId: run.id, spec: 'Never injected' });

    // Manual dispatchTask delivers the prompt but no working hook arrives -> unobserved.
    const manual = await h.service.dispatchTask({ taskId: 't_manual', to: 'w1', from: 'coord' });
    assert.equal(manual.dispatch?.startObservation, 'unobserved');
    assert.ok(manual.dispatch?.promptSentAt);

    // inject:false creates a live dispatch whose prompt is never written.
    const preview = await h.service.dispatchTask({
      taskId: 't_preview',
      to: 'w_preview',
      from: 'coord',
      inject: false,
    });
    assert.equal(preview.dispatch?.promptSentAt, null);

    // No coordinator is running for this run; the service-level sweep must do the reconciliation.
    h.service.reconcileStaleDispatches();
    assert.equal(h.store.getDispatchContext(manual.dispatch.id)?.status, 'dispatched');

    h.advance(10_000);
    h.service.reconcileStaleDispatches();
    assert.equal(h.store.getDispatchContext(manual.dispatch.id)?.status, 'failed');
    assert.ok(
      h.store
        .getDispatchContext(manual.dispatch.id)
        ?.lastFailureReason?.startsWith(`${AGENT_PROMPT_STALLED_ERROR}:`)
    );
    assert.equal(h.store.getTask('t_manual')?.status, 'failed');

    // The never-injected dispatch is still alive after the same sweep.
    assert.equal(h.store.getDispatchContext(preview.dispatch.id)?.status, 'dispatched');
    assert.equal(h.store.getTask('t_preview')?.status, 'dispatched');

    // Post-delivery bookkeeping failure: the prompt reached the worker, so the dispatch must stay
    // active instead of being failed and re-queued.
    h.agentStatusStore.registerPane('w2', { agentId: 'codex' });
    const { run: run2 } = h.service.runCreate({
      id: 'run_bookkeeping',
      objective: 'Bookkeeping failure after delivery',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_bk', runId: run2.id, spec: 'Delivered but audit write fails' });

    const originalInsertMessage = h.store.insertMessage.bind(h.store);
    h.store.insertMessage = () => {
      throw new Error('simulated audit write failure');
    };
    try {
      await h.service.coordinatorTick(run2.id, { workerPaneIds: ['w2'] });
    } finally {
      h.store.insertMessage = originalInsertMessage;
    }

    const delivered = h.store.getLatestDispatchForTask('t_bk');
    assert.ok(delivered);
    assert.equal(delivered.status, 'dispatched');
    assert.ok(delivered.promptSentAt);
    assert.equal(h.store.getTask('t_bk')?.status, 'dispatched');
    const pastesAfterDelivery = h.pasteWritesFor('w2').length;

    // The next tick must not re-dispatch or re-paste the already-delivered task.
    await h.service.coordinatorTick(run2.id, { workerPaneIds: ['w2'] });
    assert.equal(h.store.getLatestDispatchForTask('t_bk')?.id, delivered.id);
    assert.equal(h.pasteWritesFor('w2').length, pastesAfterDelivery);
  } finally {
    h.dispose();
  }
});

test('10. sweep reaps exited workers without a coordinator, and stale warnings are advisory and non-repeating', async () => {
  const h = createClockedHarness({
    turnStartObserveTimeoutMs: 25,
    startConfirmationTimeoutMs: 60_000,
    heartbeatTimeoutMs: 300_000,
    staleWarningTimeoutMs: 15_000,
    settleDelayMs: 0,
  });

  try {
    h.agentStatusStore.registerPane('coord', { agentId: 'claude' });
    h.agentStatusStore.registerPane('w_dead', { agentId: 'claude' });

    const { run } = h.service.runCreate({
      id: 'run_exit_sweep',
      objective: 'Exit reconciliation without coordinator',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_dead', runId: run.id, spec: 'Worker will die' });
    h.service.taskCreate({ id: 't_claim', runId: run.id, spec: 'Never injected claim' });

    const dead = await h.service.dispatchTask({ taskId: 't_dead', to: 'w_dead', from: 'coord' });
    assert.ok(dead.dispatch?.promptSentAt);
    const claim = await h.service.dispatchTask({
      taskId: 't_claim',
      to: 'w_claim',
      from: 'coord',
      inject: false,
    });

    // The worker PTY dies while no coordinator loop exists for this run.
    h.service.markPtyExited('w_dead');
    h.service.markPtyExited('w_claim');
    h.service.reconcileStaleDispatches();

    // A genuinely dead, delivered worker is failed and its task becomes retryable.
    assert.equal(h.store.getDispatchContext(dead.dispatch.id)?.status, 'failed');
    assert.match(
      h.store.getDispatchContext(dead.dispatch.id)?.lastFailureReason ?? '',
      /exited before worker_done/
    );
    assert.equal(h.store.getTask('t_dead')?.status, 'ready');

    // The never-delivered claim is not failed by the background sweep.
    assert.equal(h.store.getDispatchContext(claim.dispatch.id)?.status, 'dispatched');
    assert.equal(h.store.getTask('t_claim')?.status, 'dispatched');

    // Warn-only path: a queued turn behind earlier work gets one advisory, no state change.
    h.agentStatusStore.registerPane('w_q', { agentId: 'claude' });
    atNextDelivery(h.service, () => h.agentStatusStore.ingestHookEvent({ ptyId: 'w_q', state: 'working' }));
    const { run: runQueued } = h.service.runCreate({
      id: 'run_advisory',
      objective: 'Advisory stale warning',
      from: 'coord',
      paneId: 'coord',
    });
    h.service.taskCreate({ id: 't_q', runId: runQueued.id, spec: 'Queued turn' });
    const queued = await h.service.dispatchTask({ taskId: 't_q', to: 'w_q', from: 'coord' });
    assert.equal(queued.dispatch?.startObservation, 'queued');

    h.advance(15_000);
    h.service.reconcileStaleDispatches();
    const afterWarning = h.store.getDispatchContext(queued.dispatch.id);
    assert.equal(afterWarning?.status, 'dispatched');
    assert.equal(h.store.getTask('t_q')?.status, 'dispatched');
    assert.ok(afterWarning?.staleWarningAt);
    const advisories = () =>
      h.store
        .getAllMessagesForHandle(`run:${runQueued.id}`, { types: ['escalation'] })
        .filter((m) => m.payload?.includes('"advisory":true'));
    assert.equal(advisories().length, 1);

    // Further sweeps do not repeat the advisory.
    h.advance(60_000);
    h.service.reconcileStaleDispatches();
    assert.equal(advisories().length, 1);

    // The coordinator consumes the advisory escalation without settling the dispatch.
    await h.service.coordinatorTick(runQueued.id, { workerPaneIds: [] });
    assert.equal(h.store.getDispatchContext(queued.dispatch.id)?.status, 'dispatched');
    assert.equal(h.store.getTask('t_q')?.status, 'dispatched');

    // Real progress clears the warning marker so a later stall can warn again.
    h.agentStatusStore.ingestHookEvent({ ptyId: 'w_q', state: 'working' });
    const promoted = h.store.getDispatchContext(queued.dispatch.id);
    assert.equal(promoted?.startObservation, 'observed');
    assert.equal(promoted?.staleWarningAt, null);

    // Unsupported panes also only get an advisory, never a heartbeat failure.
    const rawHarness = createClockedHarness({
      staleWarningTimeoutMs: 15_000,
      settleDelayMs: 0,
      isPtyAlive: () => true,
    });
    try {
      rawHarness.agentStatusStore.registerPane('coord', { agentId: 'claude' });
      const { run: runRaw } = rawHarness.service.runCreate({
        id: 'run_advisory_raw',
        objective: 'Unsupported advisory',
        from: 'coord',
        paneId: 'coord',
      });
      rawHarness.service.taskCreate({ id: 't_raw', runId: runRaw.id, spec: 'Unregistered pane' });
      rawHarness.agentStatusStore.registerPane('w_raw', { agentId: 'codex' });
      atNextDelivery(rawHarness.service, () => rawHarness.agentStatusStore.removePane('w_raw'));
      const rawDisp = await rawHarness.service.dispatchTask({
        taskId: 't_raw',
        to: 'w_raw',
        from: 'coord',
      });
      assert.equal(rawDisp.dispatch?.startObservation, 'unsupported');
      rawHarness.advance(15_000);
      rawHarness.service.reconcileStaleDispatches();
      assert.equal(rawHarness.store.getDispatchContext(rawDisp.dispatch.id)?.status, 'dispatched');
      assert.ok(rawHarness.store.getDispatchContext(rawDisp.dispatch.id)?.staleWarningAt);
      assert.equal(rawHarness.store.getTask('t_raw')?.status, 'dispatched');
    } finally {
      rawHarness.dispose();
    }
  } finally {
    h.dispose();
  }
});
