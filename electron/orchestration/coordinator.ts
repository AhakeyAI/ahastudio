import type { CoordinatorRuntime, WorkerPaneCandidate } from './coordinator-runtime.js';
import { reconcileLifecycleMessage } from './lifecycle-reconciliation.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import type { OrchestrationStore } from './orchestration-store.js';
import {
  AGENT_PROMPT_STALLED_ERROR,
  DEFAULT_NESTED_WORKER_MAX_DEPTH,
  DISPATCH_HEARTBEAT_TIMEOUT_ERROR,
  type OrchestrationDispatchRecord,
  type OrchestrationMessagePriority,
  type OrchestrationMessageRecord,
  type OrchestrationStartObservation,
  type OrchestrationTaskRecord,
} from './orchestration-types.js';
import { buildDispatchPreamble } from './worker-dispatch-preamble.js';

const PRIORITY_RANK: Record<OrchestrationMessagePriority, number> = {
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
};

export type DagConvergenceStatus = 'empty' | 'all-done' | 'active';

export function evaluateDagConvergence(
  tasks: readonly OrchestrationTaskRecord[]
): DagConvergenceStatus {
  if (tasks.length === 0) {
    return 'empty';
  }
  const allTerminal = tasks.every((t) => t.status === 'completed' || t.status === 'failed');
  return allTerminal ? 'all-done' : 'active';
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw || !raw.trim()) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function openDecisionGateFromMessage(
  store: OrchestrationStore,
  runId: string,
  msg: OrchestrationMessageRecord
): boolean {
  const payload = parseJsonObject(msg.payload);
  // Announcements emitted by gateCreate already contain gateId and must not spawn a second gate.
  if (typeof payload?.gateId === 'string' && payload.gateId.trim()) {
    return false;
  }
  const explicitTaskId = typeof payload?.taskId === 'string' ? payload.taskId.trim() : '';
  const activeDispatch = store.getActiveDispatchForIdentity(msg.fromHandle);
  const taskId = explicitTaskId || activeDispatch?.taskId || '';
  if (!taskId) {
    return false;
  }
  const task = store.getTask(taskId);
  if (!task || task.runId !== runId) {
    return false;
  }
  const question =
    (typeof payload?.question === 'string' && payload.question.trim()) ||
    msg.body.trim() ||
    msg.subject;
  const options = Array.isArray(payload?.options)
    ? payload.options.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
  const requesterDispatchId =
    (typeof payload?.dispatchId === 'string' && payload.dispatchId.trim()) ||
    (msg.fromHandle.startsWith('dispatch:')
      ? msg.fromHandle.slice('dispatch:'.length)
      : activeDispatch?.id) ||
    null;

  try {
    store.createGate({
      taskId: task.id,
      question,
      options,
      requesterDispatchId,
      requesterHandle: msg.fromHandle,
    });
    return true;
  } catch (err) {
    store.markLifecycleRejected(msg.id, err instanceof Error ? err.message : String(err));
    return false;
  }
}

export function applyEscalationToDispatch(
  store: OrchestrationStore,
  runId: string,
  msg: OrchestrationMessageRecord
): boolean {
  const payload = parseJsonObject(msg.payload);
  // Advisory, permission-hold, and non-fatal synthetic turn-stop escalations notify the parent without settling the dispatch.
  if (
    payload?.advisory === true ||
    payload?.permissionApproval === true ||
    (payload?.syntheticTurnStop === true &&
      payload?.stopReason !== 'exited' &&
      payload?.stopReason !== 'lost')
  ) {
    return false;
  }
  const explicitDispatchId =
    typeof payload?.dispatchId === 'string' ? payload.dispatchId.trim() : '';
  const dispatch = explicitDispatchId
    ? store.getDispatchContext(explicitDispatchId)
    : store.getActiveDispatchForIdentity(msg.fromHandle);
  if (!dispatch || dispatch.runId !== runId || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
    return false;
  }
  const reason = msg.body.trim() || msg.subject || 'Worker escalated task';
  const forceFailTask = payload?.forceFail === true;
  try {
    store.failDispatch(dispatch.id, reason, { forceFailTask, summary: reason });
    return true;
  } catch (err) {
    store.markLifecycleRejected(msg.id, err instanceof Error ? err.message : String(err));
    return false;
  }
}

export interface ExitedDispatchReconcileOptions {
  hasPaneExited: (ptyId: string) => boolean;
  isPaneAlive: (ptyId: string) => boolean;
  /** Background sweeps skip never-delivered claims: no worker was ever engaged for them. */
  onlyDelivered?: boolean;
  onEvent?: (reason: string, runId: string) => void;
}

export function reconcileExitedDispatches(
  store: OrchestrationStore,
  runId: string,
  options: ExitedDispatchReconcileOptions
): void {
  for (const dispatch of store.listDispatches({ runId })) {
    if (dispatch.runId !== runId || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) continue;
    if (options.onlyDelivered && !dispatch.promptSentAt) continue;
    const paneGone =
      Boolean(dispatch.assigneePaneId) &&
      (options.hasPaneExited(dispatch.assigneePaneId!) ||
        !options.isPaneAlive(dispatch.assigneePaneId!));
    const handleExited =
      Boolean(dispatch.assigneeHandle) && options.hasPaneExited(dispatch.assigneeHandle);
    if (paneGone || handleExited) {
      const label = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
      store.failDispatch(dispatch.id, `Worker pane ${label} exited before worker_done`);
      options.onEvent?.('coordinator:worker-exited', runId);
    }
  }
}

export interface StaleDispatchReconcileOptions {
  nowMs: number;
  startConfirmationTimeoutMs: number;
  heartbeatTimeoutMs: number;
  /** Warn-only timeout for queued/unsupported dispatches; 0 disables. Never changes task state. */
  staleWarningTimeoutMs?: number;
  /** True when the worker is legitimately parked waiting on coordinator/human/child/mailbox. */
  isDeliberatelyWaiting?: (dispatch: OrchestrationDispatchRecord) => boolean;
  onEvent?: (reason: string, runId: string) => void;
}

/**
 * Reconcile dispatches whose worker never confirmed a turn start or went silent.
 * Only 'observed' dispatches are heartbeat-checked: 'queued' turns are legitimately waiting
 * behind earlier work and 'unsupported' panes cannot report activity, so timing those out
 * would kill healthy work. Heartbeat timeouts park the task instead of retrying it.
 */
export function reconcileStaleDispatches(
  store: OrchestrationStore,
  runId: string,
  options: StaleDispatchReconcileOptions
): void {
  for (const dispatch of store.listDispatches({ runId })) {
    if (dispatch.runId !== runId || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) continue;
    const obs = dispatch.startObservation ?? 'pending';
    const parkedOnWait =
      dispatch.stage === 'awaiting_review' ||
      dispatch.stage === 'waiting_permission' ||
      dispatch.stage === 'waiting_input' ||
      store.listQuestions({ dispatchId: dispatch.id, status: 'pending' }).length > 0 ||
      store.hasActiveChildDispatches(dispatch.id) ||
      Boolean(options.isDeliberatelyWaiting?.(dispatch));

    if (
      !parkedOnWait &&
      options.startConfirmationTimeoutMs > 0 &&
      (obs === 'unobserved' || obs === 'pending')
    ) {
      // Anchor on actual delivery: dispatches created without injection must never time out.
      const sentMs = dispatch.promptSentAt ? Date.parse(dispatch.promptSentAt) : Number.NaN;
      if (Number.isFinite(sentMs) && options.nowMs - sentMs >= options.startConfirmationTimeoutMs) {
        store.failDispatch(
          dispatch.id,
          `${AGENT_PROMPT_STALLED_ERROR}: start confirmation timed out after ${options.nowMs - sentMs}ms without turn start`,
          {
            forceFailTask: true,
            summary: 'Worker did not confirm turn start before confirmation timeout',
          }
        );
        options.onEvent?.('coordinator:start-timeout', runId);
        continue;
      }
    }

    if (!parkedOnWait && options.heartbeatTimeoutMs > 0 && obs === 'observed') {
      const anchorMs = Date.parse(
        dispatch.lastHeartbeatAt ??
          dispatch.turnStartedAt ??
          dispatch.promptSentAt ??
          dispatch.createdAt
      );
      if (Number.isFinite(anchorMs) && options.nowMs - anchorMs >= options.heartbeatTimeoutMs) {
        store.blockUnresponsiveDispatch(
          dispatch.id,
          `${DISPATCH_HEARTBEAT_TIMEOUT_ERROR}: worker inactive for ${options.nowMs - anchorMs}ms`
        );
        options.onEvent?.('coordinator:heartbeat-timeout', runId);
        continue;
      }
    }

    // Advisory only: queued turns wait behind earlier work and unsupported panes cannot report
    // activity, so neither may be failed here. Surface one escalation and leave state untouched.
    if ((options.staleWarningTimeoutMs ?? 0) > 0 && (obs === 'queued' || obs === 'unsupported')) {
      const anchorMs = Date.parse(
        dispatch.lastHeartbeatAt ?? dispatch.promptSentAt ?? dispatch.createdAt
      );
      if (
        Number.isFinite(anchorMs) &&
        options.nowMs - anchorMs >= (options.staleWarningTimeoutMs ?? 0)
      ) {
        store.markStaleDispatchWarned(
          dispatch.id,
          obs === 'queued'
            ? `Task ${dispatch.taskId} is still queued behind earlier work`
            : `Task ${dispatch.taskId} has no observable agent activity`,
          `No progress for ${options.nowMs - anchorMs}ms. The dispatch is left untouched; check the worker pane or re-dispatch manually.`
        );
        options.onEvent?.('coordinator:stale-warning', runId);
      }
    }
  }
}

export interface CoordinatorOptions {
  runId: string;
  spec: string;
  coordinatorHandle: string;
  coordinatorPaneId?: string | null;
  pollIntervalMs?: number;
  maxConcurrent?: number;
  autoSpawnWorkers?: boolean;
  workerCliId?: string;
  cwd?: string;
  startConfirmationTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  staleWarningTimeoutMs?: number;
  isDeliberatelyWaiting?: (dispatch: OrchestrationDispatchRecord) => boolean;
  now?: () => number;
}

export class Coordinator {
  private readonly pollIntervalMs: number;
  private readonly maxConcurrent: number;
  private readonly startConfirmationTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly staleWarningTimeoutMs: number;
  private readonly clock: () => number;
  private stopRequested = false;
  private sleepTimer: ReturnType<typeof setTimeout> | null = null;
  private sleepResolve: (() => void) | null = null;
  private running = false;

  constructor(
    private readonly store: OrchestrationStore,
    private readonly runtime: CoordinatorRuntime,
    private readonly options: CoordinatorOptions
  ) {
    this.pollIntervalMs = Math.max(50, options.pollIntervalMs ?? 500);
    this.maxConcurrent = Math.max(1, options.maxConcurrent ?? 3);
    this.startConfirmationTimeoutMs = options.startConfirmationTimeoutMs ?? 60_000;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? 300_000;
    this.staleWarningTimeoutMs = options.staleWarningTimeoutMs ?? 0;
    if (options.now) {
      this.clock = options.now;
      this.store.bindDefaultClock?.(() => new Date(this.clock()).toISOString());
    } else if (this.store.hasCustomClock?.()) {
      this.clock = () => this.store.getClockMs?.() ?? Date.now();
    } else {
      this.clock = () => Date.now();
    }
  }

  stop(): void {
    this.stopRequested = true;
    if (this.sleepTimer !== null) {
      clearTimeout(this.sleepTimer);
      this.sleepTimer = null;
    }
    this.sleepResolve?.();
    this.sleepResolve = null;
  }

  isRunning(): boolean {
    return this.running && !this.stopRequested;
  }

  async runFromExistingRun(coordinatorRunId: string): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    this.stopRequested = false;
    try {
      while (!this.stopRequested) {
        const converged = await this.tick();
        if (this.stopRequested) break;
        if (converged) {
          const tasks = this.store.listTasks({ runId: this.options.runId });
          const hasFailed = tasks.some((t) => t.status === 'failed');
          const terminalStatus = hasFailed ? 'failed' : 'completed';
          const endedAt = new Date(this.clock()).toISOString();
          this.store.updateCoordinatorRun(coordinatorRunId, {
            status: terminalStatus,
            endedAt,
          });
          this.store.updateRunStatus(this.options.runId, terminalStatus);
          this.runtime.notifyStateChanged('coordinator:converged', this.options.runId);
          return;
        }
        if (this.stopRequested) break;
        await this.waitNextPoll();
      }
      const existingCr = this.store.getCoordinatorRun(coordinatorRunId);
      if (existingCr && (existingCr.status === 'running' || existingCr.status === 'paused')) {
        const endedAt = new Date(this.clock()).toISOString();
        this.store.updateCoordinatorRun(coordinatorRunId, {
          status: 'stopped',
          endedAt,
        });
        this.store.updateRunStatus(this.options.runId, 'stopped');
        this.runtime.notifyStateChanged('coordinator:stopped', this.options.runId);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      try {
        this.store.updateCoordinatorRun(coordinatorRunId, {
          status: 'failed',
          endedAt: new Date(this.clock()).toISOString(),
          error: msg,
        });
        this.store.updateRunStatus(this.options.runId, 'failed');
      } catch {
        // Store already clean/unavailable.
      }
      this.runtime.notifyStateChanged('coordinator:failed', this.options.runId);
      throw error;
    } finally {
      this.running = false;
    }
  }

  private waitNextPoll(): Promise<void> {
    if (this.stopRequested) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.sleepResolve = resolve;
      this.sleepTimer = setTimeout(() => {
        this.sleepTimer = null;
        this.sleepResolve = null;
        resolve();
      }, this.pollIntervalMs);
      this.sleepTimer.unref?.();
    });
  }

  /**
   * Executes a single coordinator reconciliation & dispatch pass.
   * Returns `true` when the DAG has reached `'all-done'` convergence.
   */
  async tick(): Promise<boolean> {
    const runId = this.options.runId;
    this.processMessages(runId);
    this.reblockTasksWithPendingGates(runId);
    this.reconcileExitedDispatches(runId);
    this.reconcileStaleDispatches(runId);
    await this.dispatchReadyTasks(runId);

    const tasks = this.store.listTasks({ runId });
    return evaluateDagConvergence(tasks) === 'all-done';
  }

  private processMessages(runId: string): void {
    const targetHandles = new Set<string>([
      `run:${runId}`,
      this.options.coordinatorHandle,
      ...(this.options.coordinatorPaneId ? [this.options.coordinatorPaneId] : []),
    ]);

    const lifecycleTypes = ['worker_done', 'heartbeat', 'escalation', 'decision_gate'] as const;
    const processedIds: string[] = [];

    for (const handle of targetHandles) {
      const unread = this.store.getUnreadMessages(handle, {
        types: lifecycleTypes,
        limit: 100,
      });
      for (const msg of unread) {
        if (msg.runId !== runId && !msg.toHandle.startsWith(`run:${runId}`)) {
          // Only process lifecycle mail belonging to this run when reading direct coordinator handles.
          const payload = parseJsonObject(msg.payload);
          const payloadDispatch =
            typeof payload?.dispatchId === 'string'
              ? this.store.getDispatchContext(payload.dispatchId)
              : undefined;
          if (payloadDispatch?.runId !== runId) {
            continue;
          }
        }
        if (msg.type === 'worker_done' || msg.type === 'heartbeat') {
          reconcileLifecycleMessage(this.store, msg);
          processedIds.push(msg.id);
        } else if (msg.type === 'decision_gate') {
          openDecisionGateFromMessage(this.store, runId, msg);
          processedIds.push(msg.id);
        } else if (msg.type === 'escalation') {
          applyEscalationToDispatch(this.store, runId, msg);
          processedIds.push(msg.id);
        }
      }
    }

    if (processedIds.length > 0) {
      this.store.markAsRead(processedIds);
      this.runtime.notifyStateChanged('coordinator:messages-processed', runId);
    }
  }

  private reblockTasksWithPendingGates(runId: string): void {
    const tasks = this.store.listTasks({ runId });
    for (const task of tasks) {
      if (
        task.status !== 'blocked' &&
        task.status !== 'completed' &&
        task.status !== 'failed' &&
        this.store.hasPendingGates(task.id)
      ) {
        this.store.updateTaskStatus(task.id, 'blocked');
      }
    }
  }

  private reconcileExitedDispatches(runId: string): void {
    reconcileExitedDispatches(this.store, runId, {
      hasPaneExited: (ptyId) => this.runtime.hasPaneExited(ptyId),
      isPaneAlive: (ptyId) => this.runtime.isPaneAlive(ptyId),
      onEvent: (reason, id) => this.runtime.notifyStateChanged(reason, id),
    });
  }

  private reconcileStaleDispatches(runId: string): void {
    reconcileStaleDispatches(this.store, runId, {
      nowMs: this.clock(),
      startConfirmationTimeoutMs: this.startConfirmationTimeoutMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      staleWarningTimeoutMs: this.staleWarningTimeoutMs,
      isDeliberatelyWaiting: this.options.isDeliberatelyWaiting,
      onEvent: (reason, id) => this.runtime.notifyStateChanged(reason, id),
    });
  }

  private async dispatchReadyTasks(runId: string): Promise<void> {
    this.store.promoteReadyTasks(runId);

    const activeDispatches = this.store
      .listDispatches({ runId })
      .filter((d) => ACTIVE_DISPATCH_STATUSES.has(d.status));
    let availableSlots = this.maxConcurrent - activeDispatches.length;
    if (availableSlots <= 0) {
      return;
    }

    const readyTasks = this.store
      .listTasks({ runId, status: 'ready' })
      .filter((t) => !this.store.hasPendingGates(t.id))
      .sort((a, b) => {
        const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
        return rankDiff !== 0 ? rankDiff : a.createdAt.localeCompare(b.createdAt);
      });

    if (readyTasks.length === 0) {
      return;
    }

    const busyPaneIds = new Set<string>();
    if (this.options.coordinatorPaneId) {
      busyPaneIds.add(this.options.coordinatorPaneId);
    }
    if (this.options.coordinatorHandle) {
      busyPaneIds.add(this.options.coordinatorHandle);
    }
    for (const d of this.store.listDispatches()) {
      if (ACTIVE_DISPATCH_STATUSES.has(d.status)) {
        busyPaneIds.add(d.assigneeHandle);
        if (d.assigneePaneId) busyPaneIds.add(d.assigneePaneId);
      }
    }

    for (const task of readyTasks) {
      if (availableSlots <= 0 || this.stopRequested) {
        break;
      }

      const candidates = this.runtime.listWorkerCandidates(busyPaneIds);
      let chosen: WorkerPaneCandidate | null = candidates[0] ?? null;

      if (!chosen && this.options.autoSpawnWorkers !== false && this.runtime.spawnWorker) {
        try {
          chosen = await this.runtime.spawnWorker({
            runId,
            task,
            cliId: this.options.workerCliId,
            cwd: task.worktreePath ?? this.options.cwd,
          });
        } catch (err) {
          console.warn(`[orchestration] worker spawn failed for task ${task.id}:`, err);
          break;
        }
      }

      if (!chosen) {
        break;
      }

      busyPaneIds.add(chosen.ptyId);
      availableSlots -= 1;

      let ctxId: string | null = null;
      let delivered = false;
      let obs: OrchestrationStartObservation = 'unsupported';
      try {
        const ctx = this.store.createDispatchContext({
          taskId: task.id,
          assigneeHandle: chosen.ptyId,
          assigneePaneId: chosen.ptyId,
          creator: this.options.coordinatorHandle,
          creatorRunId: runId,
          maxDepth: this.runtime.maxDepth ?? DEFAULT_NESTED_WORKER_MAX_DEPTH,
        });
        ctxId = ctx.id;

        const buildBrief = this.runtime.buildDispatchBrief ?? buildDispatchPreamble;
        const preamble = buildBrief({
          taskId: task.id,
          dispatchId: ctx.id,
          runId,
          taskSpec: task.spec,
          taskContext: task.taskContext,
          redactText: (text) => this.store.redactDispatchCredentials(text),
          coordinatorHandle: `run:${runId}`,
          workerHandle: chosen.ptyId,
          worktreePath: task.worktreePath,
          canDispatchSubWorkers: ctx.depth < (this.runtime.maxDepth ?? DEFAULT_NESTED_WORKER_MAX_DEPTH),
          cliCommand: this.runtime.cliCommand ?? 'aha',
          dispatchCapability: this.store.getDispatchCapability(ctx.id),
        });

        const delivery = await this.runtime.sendTurn({
          ptyId: chosen.ptyId,
          body: preamble,
          submit: true,
        });
        if (!delivery.ok) {
          this.store.failDispatch(
            ctx.id,
            delivery.error ?? `Failed to deliver dispatch prompt to ${chosen.ptyId}`
          );
          availableSlots += 1;
          this.runtime.notifyStateChanged('coordinator:dispatch-failed', runId);
          continue;
        }

        delivered = true;
        obs = delivery.startObservation ?? 'unsupported';
        this.store.updateDispatchObservation(ctx.id, obs, {
          reason: delivery.observationReason ?? null,
          refreshHeartbeat: obs === 'observed' || obs === 'queued' || obs === 'permission',
          ...(delivery.promptDeferred ? {} : { promptSent: true }),
        });
        const dispatchAuditMsg = this.store.insertMessage({
          runId,
          from: this.options.coordinatorHandle,
          to: `dispatch:${ctx.id}`,
          type: 'dispatch',
          subject: `Dispatched task ${task.id}`,
          body: this.store.redactDispatchCredentials(preamble),
        });
        this.store.markAsReadAndDelivered([dispatchAuditMsg.id]);
      } catch (err) {
        if (delivered) {
          // The prompt already reached the worker; re-queuing here would run the task twice.
          console.warn(`[orchestration] dispatch ${ctxId} bookkeeping failed after delivery:`, err);
        } else {
          availableSlots += 1;
          if (ctxId) {
            this.store.failDispatch(ctxId, err instanceof Error ? err.message : String(err));
          }
          this.runtime.notifyStateChanged('coordinator:dispatch-failed', runId);
          continue;
        }
      }

      this.runtime.notifyStateChanged(
        obs === 'unobserved'
          ? 'coordinator:dispatch-unobserved'
          : obs === 'permission'
            ? 'coordinator:dispatch-permission'
            : 'coordinator:dispatched',
        runId
      );
    }
  }
}
