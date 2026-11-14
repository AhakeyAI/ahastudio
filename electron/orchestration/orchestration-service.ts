import type { PtyWriteFn } from '../agent/agent-prompt-delivery.js';
import type { AgentStatusStore } from '../agent/agent-status-store.js';
import {
  Coordinator,
  reconcileExitedDispatches as reconcileExitedDispatchesForRun,
  reconcileStaleDispatches as reconcileStaleDispatchesForRun,
  type CoordinatorOptions,
} from './coordinator.js';
import type { CoordinatorRuntime, WorkerPaneCandidate } from './coordinator-runtime.js';
import { hasLifecycleAuthority, reconcileLifecycleMessage } from './lifecycle-reconciliation.js';
import { MailboxPointerDelivery } from './mailbox-pointer-delivery.js';
import { RuntimeMessageWaiters, type MessageWake } from './mailbox-waiters.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import {
  completionReportDispatchId,
  exposeMessage,
  exposeMessages,
  formatAgentFieldsText,
  formatMessageBanner,
  reportFollowUpAction,
} from './orchestration-messaging.js';
import { OrchestrationStore } from './orchestration-store.js';
import {
  DEFAULT_NESTED_WORKER_MAX_DEPTH,
  ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS,
  OrchestrationError,
  type OrchestrationCoordinatorRunRecord,
  type OrchestrationCoordinatorStatusResult,
  type OrchestrationDispatchRecord,
  type OrchestrationExposedMessage,
  type OrchestrationGateRecord,
  type OrchestrationGateStatus,
  type OrchestrationMessagePriority,
  type OrchestrationMessageRecord,
  type OrchestrationMessageType,
  type OrchestrationQuestionRecord,
  type OrchestrationRunRecord,
  type OrchestrationSnapshot,
  type OrchestrationTaskRecord,
  type OrchestrationTaskShowResult,
  type OrchestrationTaskStatus,
  type OrchestrationTaskWithDispatch,
  type OrchestrationWorkerReportOutcome,
} from './orchestration-types.js';
import { buildDispatchPreamble, redactDispatchCapability } from './worker-dispatch-preamble.js';
import {
  deliverAndObserveAgentTurn,
  type DeliverAndObserveAgentTurnResult,
} from './turn-start-observation.js';

export interface OrchestrationEvent {
  reason: string;
  runId?: string;
  updatedAt: string;
  snapshot: OrchestrationSnapshot;
}

export interface OrchestrationPaneSpawnedEvent {
  ptyId: string;
  runId: string;
  taskId: string;
  cwd?: string;
  cliId?: string;
}

export interface OrchestrationServiceDependencies {
  store: OrchestrationStore;
  agentStatusStore: AgentStatusStore;
  writePty: PtyWriteFn;
  spawnWorkerPty?: (opts: {
    runId: string;
    task: OrchestrationTaskRecord;
    cliId?: string;
    cwd?: string;
  }) => Promise<WorkerPaneCandidate | null>;
  isPtyAlive?: (ptyId: string) => boolean;
  /** Whether an id names an agent CLI (not a plain shell); auto-spawned workers must be agents. */
  isAgentCliId?: (cliId: string) => boolean;
  cliCommand?: string;
  maxDepth?: number;
  turnStartObserveTimeoutMs?: number;
  startConfirmationTimeoutMs?: number;
  heartbeatTimeoutMs?: number;
  /** Reconcile stale dispatches even when no coordinator loop is running; 0 disables the timer. */
  staleSweepIntervalMs?: number;
  /** Warn-only timeout for queued/unsupported dispatches; 0 disables. */
  staleWarningTimeoutMs?: number;
  settleDelayMs?: number;
  now?: () => number;
}

export class OrchestrationService {
  readonly store: OrchestrationStore;
  readonly waiters: RuntimeMessageWaiters;
  readonly pointerDelivery: MailboxPointerDelivery;

  private readonly agentStatusStore: AgentStatusStore;
  private readonly writePty: PtyWriteFn;
  private readonly spawnWorkerPty?: OrchestrationServiceDependencies['spawnWorkerPty'];
  private readonly externalIsPtyAlive?: (ptyId: string) => boolean;
  private readonly isAgentCliId?: (cliId: string) => boolean;
  /** Worker panes this service spawned; always eligible for coordinator dispatch while alive. */
  private readonly spawnedWorkerPanes = new Set<string>();
  private readonly cliCommand: string;
  private readonly maxDepth: number;
  private readonly turnStartObserveTimeoutMs: number;
  private readonly startConfirmationTimeoutMs: number;
  private readonly heartbeatTimeoutMs: number;
  private readonly staleWarningTimeoutMs: number;
  private readonly settleDelayMs: number | undefined;
  private readonly clock: () => number;
  private staleSweepTimer: ReturnType<typeof setInterval> | null = null;

  private readonly eventListeners = new Set<(event: OrchestrationEvent) => void>();
  private readonly paneSpawnedListeners = new Set<
    (event: OrchestrationPaneSpawnedEvent) => void
  >();
  private readonly exitedPanes = new Set<string>();
  private readonly inFlightObservationDispatches = new Set<string>();
  private readonly disposeStatusListener: () => void;
  private readonly disposeActivityListener: () => void;

  private activeCoordinator: {
    coordinator: Coordinator;
    coordinatorRunId: string;
    runId: string;
    loopPromise: Promise<void>;
  } | null = null;

  constructor(deps: OrchestrationServiceDependencies) {
    this.store = deps.store;
    this.agentStatusStore = deps.agentStatusStore;
    this.writePty = deps.writePty;
    this.spawnWorkerPty = deps.spawnWorkerPty;
    this.externalIsPtyAlive = deps.isPtyAlive;
    this.isAgentCliId = deps.isAgentCliId;
    this.cliCommand = deps.cliCommand ?? 'aha';
    this.maxDepth = deps.maxDepth ?? DEFAULT_NESTED_WORKER_MAX_DEPTH;
    this.turnStartObserveTimeoutMs = deps.turnStartObserveTimeoutMs ?? 0;
    this.startConfirmationTimeoutMs = deps.startConfirmationTimeoutMs ?? 60_000;
    this.heartbeatTimeoutMs = deps.heartbeatTimeoutMs ?? 300_000;
    this.staleWarningTimeoutMs = deps.staleWarningTimeoutMs ?? 0;
    this.settleDelayMs = deps.settleDelayMs;
    if (deps.now) {
      this.clock = deps.now;
      this.store.bindDefaultClock?.(() => new Date(this.clock()).toISOString());
    } else if (this.store.hasCustomClock?.()) {
      this.clock = () => this.store.getClockMs?.() ?? Date.now();
    } else {
      this.clock = () => Date.now();
    }

    this.waiters = new RuntimeMessageWaiters();
    this.pointerDelivery = new MailboxPointerDelivery({
      store: this.store,
      waiters: this.waiters,
      agentStatusStore: this.agentStatusStore,
      writePty: this.writePty,
      isPaneAlive: (ptyId) => this.isPaneAlive(ptyId),
      cliCommand: this.cliCommand,
    });

    this.disposeStatusListener = this.agentStatusStore.onChange((status) => {
      if (status.state === 'working' || status.state === 'waiting') {
        this.exitedPanes.delete(status.ptyId);
      }
    });

    this.disposeActivityListener = this.agentStatusStore.onActivity((snapshot) => {
      if (snapshot.state !== 'working' && snapshot.state !== 'waiting') {
        return;
      }
      this.exitedPanes.delete(snapshot.ptyId);
      for (const dispatch of this.store.getActiveDispatchesForPane(snapshot.ptyId)) {
        if (this.inFlightObservationDispatches.has(dispatch.id)) continue;
        const previousObservation = dispatch.startObservation ?? 'pending';
        if (snapshot.state === 'working') {
          if (previousObservation === 'queued') {
            const baselineSeq = dispatch.queuedWorkingBaseline;
            if (baselineSeq != null && snapshot.workingSequence <= baselineSeq) {
              continue;
            }
          }
          const updated = this.store.updateDispatchObservation(dispatch.id, 'observed', {
            refreshHeartbeat: true,
            minHeartbeatIntervalMs: 5_000,
          });
          if (updated && previousObservation !== 'observed') {
            this.emitChanged('dispatch:observed', dispatch.runId);
          }
        } else if (previousObservation !== 'permission') {
          const updated = this.store.updateDispatchObservation(dispatch.id, 'permission', {
            reason: 'Agent entered permission/input wait state',
            refreshHeartbeat: true,
            minHeartbeatIntervalMs: 5_000,
          });
          if (updated) {
            this.emitChanged('dispatch:permission', dispatch.runId);
          }
        }
      }
    });

    const staleSweepIntervalMs = deps.staleSweepIntervalMs ?? 0;
    if (staleSweepIntervalMs > 0) {
      this.staleSweepTimer = setInterval(() => {
        try {
          this.reconcileStaleDispatches();
        } catch (error) {
          console.warn('[orchestration] stale dispatch sweep failed:', error);
        }
      }, staleSweepIntervalMs);
      this.staleSweepTimer.unref?.();
    }
  }

  markPtyExited(ptyId: string): void {
    this.exitedPanes.add(ptyId);
    this.pointerDelivery.retirePane(ptyId);
    this.waiters.cancel(ptyId);
    this.waiters.cancelConsumer(ptyId);
    for (const dispatch of this.store.listDispatches()) {
      if (
        ACTIVE_DISPATCH_STATUSES.has(dispatch.status) &&
        (dispatch.assigneePaneId === ptyId || dispatch.assigneeHandle === ptyId)
      ) {
        this.waiters.cancel(`dispatch:${dispatch.id}`);
        this.waiters.notifyPrefix(`question:${dispatch.id}:`, 'status');
      }
    }
  }

  isPaneAlive(ptyId: string): boolean {
    if (this.exitedPanes.has(ptyId)) {
      return false;
    }
    if (this.externalIsPtyAlive) {
      return this.externalIsPtyAlive(ptyId);
    }
    return this.agentStatusStore.get(ptyId) !== null;
  }

  onEvent(listener: (event: OrchestrationEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  onPaneSpawned(listener: (event: OrchestrationPaneSpawnedEvent) => void): () => void {
    this.paneSpawnedListeners.add(listener);
    return () => this.paneSpawnedListeners.delete(listener);
  }

  private emitChanged(reason: string, runId?: string): void {
    const event: OrchestrationEvent = {
      reason,
      runId,
      updatedAt: new Date(this.clock()).toISOString(),
      snapshot: this.store.getSnapshot(),
    };
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[orchestration] event listener failed:', error);
      }
    }
  }

  private emitPaneSpawned(event: OrchestrationPaneSpawnedEvent): void {
    for (const listener of this.paneSpawnedListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[orchestration] pane spawned listener failed:', error);
      }
    }
  }

  // ==================== Runs ====================

  runCreate(input: {
    id?: string;
    objective: string;
    from?: string;
    paneId?: string;
  }): { run: OrchestrationRunRecord } {
    const handle = input.from?.trim() || 'coordinator';
    const paneId = input.paneId?.trim() || (this.agentStatusStore.get(handle) ? handle : null);
    const run = this.store.createRun({
      id: input.id,
      objective: input.objective,
      coordinatorHandle: handle,
      coordinatorPaneId: paneId,
    });
    this.waiters.cancel(handle);
    this.waiters.cancelConsumer(handle);
    if (paneId && paneId !== handle) {
      this.waiters.cancel(paneId);
      this.waiters.cancelConsumer(paneId);
    }
    this.emitChanged('run:created', run.id);
    return { run };
  }

  runUse(input: {
    id: string;
    from?: string;
    paneId?: string;
  }): { run: OrchestrationRunRecord } {
    const handle = input.from?.trim() || 'coordinator';
    const paneId = input.paneId?.trim() || (this.agentStatusStore.get(handle) ? handle : null);
    const run = this.store.bindRun({
      runId: input.id,
      coordinatorHandle: handle,
      coordinatorPaneId: paneId,
    });
    if (!run) {
      throw new OrchestrationError(
        'run_not_found',
        `Run ${input.id} was not found or cannot be bound.`
      );
    }
    this.waiters.cancel(handle);
    this.waiters.cancelConsumer(handle);
    if (paneId && paneId !== handle) {
      this.waiters.cancel(paneId);
      this.waiters.cancelConsumer(paneId);
    }
    this.waiters.cancel(`run:${run.id}`);
    this.emitChanged('run:bound', run.id);
    return { run };
  }

  runCurrent(input: { from?: string } = {}): { run: OrchestrationRunRecord | null } {
    const handle = input.from?.trim() || 'coordinator';
    const run = this.store.getCurrentRunForConsumer(handle) ?? null;
    return { run };
  }

  runList(filter?: { status?: string }): {
    runs: OrchestrationRunRecord[];
    count: number;
  } {
    const runs = this.store.listRuns(filter);
    return { runs, count: runs.length };
  }

  runShow(id: string): {
    run: OrchestrationRunRecord;
    tasks: OrchestrationTaskWithDispatch[];
    gates: OrchestrationGateRecord[];
  } {
    const run = this.store.requireRun(id);
    const tasks = this.store.listTasksWithDispatch({ runId: run.id });
    const gates = this.store.listGates({ runId: run.id });
    return { run, tasks, gates };
  }

  // ==================== Tasks ====================

  private resolveRunIdForCaller(explicitRunId?: string, from?: string): string {
    if (explicitRunId?.trim()) {
      return this.store.requireRun(explicitRunId.trim()).id;
    }
    if (from?.trim()) {
      const bound = this.store.getCurrentRunForConsumer(from.trim());
      if (bound) {
        return bound.id;
      }
      const dispatch = this.store.getActiveDispatchForIdentity(from.trim(), from.trim());
      if (dispatch) {
        return dispatch.runId;
      }
    }
    const activeCoord = this.store.getActiveCoordinatorRun();
    if (activeCoord) {
      return activeCoord.runId;
    }
    const runs = this.store.listRuns({ status: 'active' });
    if (runs.length === 1) {
      return runs[0]!.id;
    }
    throw new OrchestrationError(
      'run_not_found',
      'No active run specified or bound to caller. Pass --run <runId> or call run-create first.'
    );
  }

  taskCreate(input: {
    id?: string;
    runId?: string;
    from?: string;
    spec: string;
    taskTitle?: string;
    displayName?: string;
    deps?: string[];
    priority?: OrchestrationMessagePriority;
    worktreePath?: string;
  }): { task: OrchestrationTaskRecord } {
    const runId = this.resolveRunIdForCaller(input.runId, input.from);
    const task = this.store.createTask({
      id: input.id,
      runId,
      spec: input.spec,
      taskTitle: input.taskTitle,
      displayName: input.displayName,
      deps: input.deps,
      priority: input.priority,
      worktreePath: input.worktreePath,
    });
    this.emitChanged('task:created', runId);
    return { task };
  }

  taskList(input: {
    runId?: string;
    from?: string;
    status?: OrchestrationTaskStatus;
    priority?: OrchestrationMessagePriority;
  } = {}): { tasks: OrchestrationTaskWithDispatch[]; count: number } {
    const runId = input.runId?.trim() || undefined;
    const tasks = this.store
      .listTasksWithDispatch({ runId, status: input.status })
      .filter((t) => !input.priority || t.priority === input.priority);
    return { tasks, count: tasks.length };
  }

  taskShow(input: string | { id: string }): OrchestrationTaskShowResult {
    const taskId = typeof input === 'string' ? input.trim() : input.id.trim();
    const task = this.store.requireTask(taskId);
    const latestDispatch = this.store.getLatestDispatchForTask(task.id) ?? null;
    const dispatches = this.store.listDispatches({ taskId: task.id });
    const gates = this.store.listGates({ taskId: task.id });
    return { task, latestDispatch, dispatches, gates };
  }

  taskUpdate(input: {
    id: string;
    status: OrchestrationTaskStatus;
  }): { task: OrchestrationTaskRecord } {
    const settledTargets =
      input.status === 'completed' || input.status === 'failed'
        ? this.store.getActiveDispatchesForTask(input.id)
        : [];
    const task = this.store.updateTaskStatus(input.id, input.status);
    for (const d of settledTargets) {
      this.waiters.cancel(`dispatch:${d.id}`);
      this.waiters.notifyPrefix(`question:${d.id}:`, 'status');
    }
    this.emitChanged('task:updated', task.runId);
    return { task };
  }

  // ==================== Dispatch ====================

  async dispatchTask(input: {
    taskId: string;
    to?: string;
    from?: string;
    inject?: boolean;
    dryRun?: boolean;
  }): Promise<{
    dispatch: OrchestrationDispatchRecord | null;
    injected: boolean;
    dryRun?: boolean;
    preamble?: string;
  }> {
    const task = this.store.requireTask(input.taskId);
    const from = input.from?.trim() || 'coordinator';
    const assignee = input.to?.trim() || '';

    if (input.dryRun) {
      const preamble = buildDispatchPreamble({
        taskId: task.id,
        dispatchId: 'ctx_dryrun',
        runId: task.runId,
        taskSpec: task.spec,
        coordinatorHandle: `run:${task.runId}`,
        workerHandle: assignee || 'worker',
        worktreePath: task.worktreePath,
        canDispatchSubWorkers: true,
        cliCommand: this.cliCommand,
      });
      return { dispatch: null, injected: false, dryRun: true, preamble };
    }

    if (!assignee) {
      throw new OrchestrationError('invalid_argument', 'Missing target pane/handle (--to)');
    }

    const inject = input.inject !== false;
    if (inject && assignee === from) {
      throw new OrchestrationError(
        'terminal_is_coordinator',
        `Terminal ${assignee} is this coordinator's own terminal. Dispatch to a different worker pane.`
      );
    }

    if (inject && !this.isPaneAlive(assignee)) {
      throw new OrchestrationError(
        'no_agent_detected',
        `Target pane ${assignee} is not live or registered for agent prompt delivery.`
      );
    }

    const paneStatus = this.agentStatusStore.get(assignee);

    const callerDispatch = this.store.getActiveDispatchForIdentity(from, from);
    const ctx = this.store.createDispatchContext({
      taskId: task.id,
      assigneeHandle: assignee,
      assigneePaneId: paneStatus?.ptyId ?? null,
      creator: from,
      creatorRunId: task.runId,
      creatorDispatchId: callerDispatch?.id ?? null,
      maxDepth: this.maxDepth,
    });

    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: ctx.id,
      runId: task.runId,
      taskSpec: task.spec,
      coordinatorHandle: `run:${task.runId}`,
      workerHandle: assignee,
      worktreePath: task.worktreePath,
      canDispatchSubWorkers: ctx.depth < this.maxDepth,
      cliCommand: this.cliCommand,
      dispatchCapability: this.store.getDispatchCapability(ctx.id),
    });

    let injected = false;
    let updatedCtx = ctx;
    let delivered = false;
    if (inject) {
      try {
        const res = await this.deliverAndObserveDispatchTurn(ctx.id, {
          ptyId: assignee,
          prompt: preamble,
          submit: true,
        });
        if (!res.ok) {
          const reason = res.error ?? `Failed to deliver prompt to ${assignee}`;
          const code =
            !this.isPaneAlive(assignee) ||
            /unavail|not found|not alive|closed|exited|dead|no pty|missing pty|unknown pty/i.test(
              reason
            )
              ? 'terminal_unavailable'
              : 'prompt_delivery_failed';
          throw new OrchestrationError(code, reason, {
            dispatchId: ctx.id,
            taskId: task.id,
            target: assignee,
          });
        }
        delivered = true;
        updatedCtx =
          this.store.updateDispatchObservation(ctx.id, res.startObservation, {
            reason: res.observationReason ?? null,
            refreshHeartbeat:
              res.startObservation === 'observed' ||
              res.startObservation === 'queued' ||
              res.startObservation === 'permission',
            promptSent: true,
          }) ?? ctx;
        injected = true;
      } catch (error) {
        if (delivered) {
          // The prompt already reached the worker; re-queuing here would run the task twice.
          console.warn(`[orchestration] dispatch ${ctx.id} bookkeeping failed after delivery:`, error);
          injected = true;
        } else {
          const reason = error instanceof Error ? error.message : String(error);
          this.store.failDispatch(ctx.id, reason);
          this.emitChanged('dispatch:failed', task.runId);
          if (error instanceof OrchestrationError) {
            throw error;
          }
          const code =
            !this.isPaneAlive(assignee) ||
            /unavail|not found|not alive|closed|exited|dead|no pty|missing pty|unknown pty/i.test(
              reason
            )
              ? 'terminal_unavailable'
              : 'prompt_delivery_failed';
          throw new OrchestrationError(code, reason, {
            dispatchId: ctx.id,
            taskId: task.id,
            target: assignee,
          });
        }
      }
    }

    try {
      const dispatchAuditMsg = this.store.insertMessage({
        runId: task.runId,
        from,
        to: `dispatch:${ctx.id}`,
        type: 'dispatch',
        subject: `Dispatched task ${task.id}`,
        body: redactDispatchCapability(preamble, this.store.getDispatchCapability(ctx.id)),
      });
      this.store.markAsReadAndDelivered([dispatchAuditMsg.id]);
    } catch (error) {
      if (!delivered) {
        throw error;
      }
      console.warn(`[orchestration] dispatch ${ctx.id} audit message failed after delivery:`, error);
    }

    this.emitChanged(
      updatedCtx.startObservation === 'unobserved' ? 'dispatch:unobserved' : 'dispatch:created',
      task.runId
    );
    return {
      dispatch: updatedCtx,
      injected,
      preamble: redactDispatchCapability(preamble, this.store.getDispatchCapability(ctx.id)),
    };
  }

  dispatchShow(input: { taskId: string; preamble?: boolean }): {
    dispatch: OrchestrationDispatchRecord | null;
    preamble?: string;
  } {
    const task = this.store.requireTask(input.taskId);
    const ctx = this.store.getLatestDispatchForTask(task.id) ?? null;
    if (!input.preamble) {
      return { dispatch: ctx };
    }
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: ctx?.id ?? 'ctx_preview',
      runId: task.runId,
      taskSpec: task.spec,
      coordinatorHandle: `run:${task.runId}`,
      workerHandle: ctx?.assigneeHandle ?? 'worker',
      worktreePath: task.worktreePath,
      canDispatchSubWorkers: (ctx?.depth ?? 1) < this.maxDepth,
      cliCommand: this.cliCommand,
      dispatchCapability: ctx ? this.store.getDispatchCapability(ctx.id) : null,
    });
    return {
      dispatch: ctx,
      preamble: redactDispatchCapability(preamble, ctx ? this.store.getDispatchCapability(ctx.id) : null),
    };
  }

  // ==================== Coordinator Lifecycle ====================

  private createCoordinatorRuntime(options: {
    coordinatorPaneId?: string | null;
    workerCliId?: string;
    cwd?: string;
    /**
     * Existing panes the coordinator may dispatch to. When omitted, any idle agent pane qualifies
     * (CLI callers); when given, only these plus panes this service spawned.
     */
    workerPaneIds?: string[];
  }): CoordinatorRuntime {
    const allowed = options.workerPaneIds ? new Set(options.workerPaneIds) : null;
    return {
      cliCommand: this.cliCommand,
      maxDepth: this.maxDepth,
      listWorkerCandidates: (excludePaneIds) => {
        const candidates: WorkerPaneCandidate[] = [];
        for (const pane of this.agentStatusStore.list()) {
          if (!this.isPaneAlive(pane.ptyId)) continue;
          if (excludePaneIds.has(pane.ptyId)) continue;
          if (options.coordinatorPaneId && pane.ptyId === options.coordinatorPaneId) continue;
          if (pane.state === 'working' || pane.state === 'waiting') continue;
          // A plain shell would execute the task text as commands.
          if (!pane.agentId) continue;
          if (allowed && !allowed.has(pane.ptyId) && !this.spawnedWorkerPanes.has(pane.ptyId)) continue;
          const boundRun = this.store.getCurrentRunForConsumer(pane.ptyId);
          if (boundRun && (boundRun.coordinatorPaneId === pane.ptyId || boundRun.coordinatorHandle === pane.ptyId)) {
            continue;
          }
          candidates.push({ ptyId: pane.ptyId, agentId: pane.agentId });
        }
        return candidates;
      },
      spawnWorker: this.spawnWorkerPty
        ? async (spawnInput) => {
            const spawned = await this.spawnWorkerPty!({
              runId: spawnInput.runId,
              task: spawnInput.task,
              cliId: spawnInput.cliId ?? options.workerCliId,
              cwd: spawnInput.cwd ?? options.cwd,
            });
            if (spawned) {
              this.exitedPanes.delete(spawned.ptyId);
              this.spawnedWorkerPanes.add(spawned.ptyId);
              this.emitPaneSpawned({
                ptyId: spawned.ptyId,
                runId: spawnInput.runId,
                taskId: spawnInput.task.id,
                cwd: spawned.cwd,
                cliId: spawnInput.cliId ?? options.workerCliId,
              });
            }
            return spawned;
          }
        : undefined,
      isPaneAlive: (ptyId) => this.isPaneAlive(ptyId),
      hasPaneExited: (ptyId) => this.exitedPanes.has(ptyId),
      sendTurn: async (turn) => {
        const matchingActive = this.store
          .listDispatches()
          .filter(
            (d) =>
              ACTIVE_DISPATCH_STATUSES.has(d.status) &&
              (d.assigneePaneId === turn.ptyId || d.assigneeHandle === turn.ptyId)
          );
        const dispatchId = matchingActive[matchingActive.length - 1]?.id ?? null;
        return this.deliverAndObserveDispatchTurn(dispatchId, {
          ptyId: turn.ptyId,
          prompt: turn.body,
          submit: turn.submit !== false,
        });
      },
      notifyStateChanged: (reason, runId) => {
        if (reason === 'coordinator:worker-exited' && runId) {
          this.pointerDelivery.notifyMessageArrived(`run:${runId}`);
        }
        this.emitChanged(reason, runId);
      },
    };
  }

  coordinatorStart(input: {
    runId?: string;
    spec?: string;
    from?: string;
    pollIntervalMs?: number;
    maxConcurrent?: number;
    autoSpawnWorkers?: boolean;
    workerCliId?: string;
    cwd?: string;
    workerPaneIds?: string[];
  } = {}): {
    coordinatorRun: OrchestrationCoordinatorRunRecord;
    runId: string;
    status: 'running';
  } {
    const existing = this.store.getActiveCoordinatorRun();
    if (existing || this.activeCoordinator) {
      throw new OrchestrationError(
        'coordinator_already_running',
        `Coordinator already running: ${existing?.id ?? this.activeCoordinator?.coordinatorRunId}`
      );
    }

    const from = input.from?.trim() || 'coordinator';
    const workerCliId = input.workerCliId?.trim() || undefined;
    if (input.autoSpawnWorkers) {
      if (!workerCliId) {
        throw new OrchestrationError(
          'invalid_argument',
          'autoSpawnWorkers requires workerCliId (an agent CLI such as claude or codex).'
        );
      }
      if (this.isAgentCliId && !this.isAgentCliId(workerCliId)) {
        throw new OrchestrationError(
          'invalid_argument',
          `workerCliId must be an agent CLI, not a shell: ${workerCliId}`
        );
      }
    }
    const paneId = this.agentStatusStore.get(from) ? from : null;
    // Without an explicit run, keep working on the caller's bound run instead of starting an empty one.
    const boundRun = input.runId?.trim() ? null : this.store.getCurrentRunForConsumer(from);
    const explicitRunId =
      input.runId?.trim() || (boundRun?.status === 'active' ? boundRun.id : undefined);
    let run = explicitRunId
      ? this.store.requireRun(explicitRunId)
      : this.runCreate({
          objective: input.spec?.trim() || 'Orchestrated Multi-Agent Run',
          from,
          paneId: paneId ?? undefined,
        }).run;
    if (run.status !== 'active') {
      run = this.store.updateRunStatus(run.id, 'active');
    }

    const spec = input.spec?.trim() || run.objective;
    const pollIntervalMs = input.pollIntervalMs ?? 500;
    const maxConcurrent = input.maxConcurrent ?? 3;

    const coordinatorRun = this.store.createCoordinatorRun({
      runId: run.id,
      spec,
      coordinatorHandle: from,
      pollIntervalMs,
      maxConcurrent,
    });

    const runtime = this.createCoordinatorRuntime({
      coordinatorPaneId: run.coordinatorPaneId ?? paneId,
      workerCliId,
      cwd: input.cwd,
      workerPaneIds: input.workerPaneIds,
    });
    const coordinatorOptions: CoordinatorOptions = {
      runId: run.id,
      spec,
      coordinatorHandle: from,
      coordinatorPaneId: run.coordinatorPaneId ?? paneId,
      pollIntervalMs,
      maxConcurrent,
      autoSpawnWorkers: input.autoSpawnWorkers ?? false,
      workerCliId,
      cwd: input.cwd,
      startConfirmationTimeoutMs: this.startConfirmationTimeoutMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      staleWarningTimeoutMs: this.staleWarningTimeoutMs,
      now: this.clock,
    };

    const coordinator = new Coordinator(this.store, runtime, coordinatorOptions);
    const loopPromise = coordinator.runFromExistingRun(coordinatorRun.id).finally(() => {
      if (this.activeCoordinator?.coordinator === coordinator) {
        this.activeCoordinator = null;
      }
    });

    this.activeCoordinator = {
      coordinator,
      coordinatorRunId: coordinatorRun.id,
      runId: run.id,
      loopPromise,
    };

    this.emitChanged('coordinator:started', run.id);
    return { coordinatorRun, runId: run.id, status: 'running' };
  }

  coordinatorStop(): { runId: string; coordinatorRunId: string; stopped: boolean } {
    const active = this.store.getActiveCoordinatorRun();
    if (!active && !this.activeCoordinator) {
      throw new OrchestrationError('not_found', 'No active coordinator run');
    }

    if (this.activeCoordinator) {
      this.activeCoordinator.coordinator.stop();
    }
    const runId = this.activeCoordinator?.runId ?? active!.runId;
    const coordinatorRunId = this.activeCoordinator?.coordinatorRunId ?? active!.id;

    if (active && (active.status === 'running' || active.status === 'paused')) {
      this.store.updateCoordinatorRun(active.id, {
        status: 'stopped',
        endedAt: new Date(this.clock()).toISOString(),
      });
      this.store.updateRunStatus(runId, 'stopped');
    }

    this.activeCoordinator = null;
    this.emitChanged('coordinator:stopped', runId);
    return { runId, coordinatorRunId, stopped: true };
  }

  async coordinatorTick(
    runId?: string,
    opts: { workerPaneIds?: string[] } = {}
  ): Promise<{ converged: boolean; runId: string }> {
    if (this.activeCoordinator && (!runId || this.activeCoordinator.runId === runId)) {
      const converged = await this.activeCoordinator.coordinator.tick();
      return { converged, runId: this.activeCoordinator.runId };
    }
    const targetRunId = this.resolveRunIdForCaller(runId);
    const run = this.store.requireRun(targetRunId);
    const runtime = this.createCoordinatorRuntime({
      coordinatorPaneId: run.coordinatorPaneId,
      workerPaneIds: opts.workerPaneIds,
    });
    const coordinator = new Coordinator(this.store, runtime, {
      runId: run.id,
      spec: run.objective,
      coordinatorHandle: run.coordinatorHandle,
      coordinatorPaneId: run.coordinatorPaneId,
      autoSpawnWorkers: false,
      startConfirmationTimeoutMs: this.startConfirmationTimeoutMs,
      heartbeatTimeoutMs: this.heartbeatTimeoutMs,
      staleWarningTimeoutMs: this.staleWarningTimeoutMs,
      now: this.clock,
    });
    const converged = await coordinator.tick();
    return { converged, runId: run.id };
  }

  coordinatorStatus(
    input: string | { runId?: string } = {}
  ): OrchestrationCoordinatorStatusResult {
    const requestedRunId =
      (typeof input === 'string' ? input : input.runId)?.trim() || undefined;
    if (requestedRunId) {
      this.store.requireRun(requestedRunId);
    }

    const activeCoordinatorRun = this.store.getActiveCoordinatorRun() ?? null;
    const resolvedRunId =
      requestedRunId ?? this.activeCoordinator?.runId ?? activeCoordinatorRun?.runId ?? null;
    const run = resolvedRunId ? this.store.getRun(resolvedRunId) ?? null : null;
    const coordinatorRun = resolvedRunId
      ? (this.activeCoordinator && this.activeCoordinator.runId === resolvedRunId
          ? this.store.getCoordinatorRun(this.activeCoordinator.coordinatorRunId) ?? null
          : this.store.listCoordinatorRuns(resolvedRunId).at(-1) ?? null)
      : activeCoordinatorRun;
    const running =
      this.activeCoordinator !== null &&
      (!requestedRunId || this.activeCoordinator.runId === requestedRunId);

    const tasks = resolvedRunId
      ? this.store.listTasks({ runId: resolvedRunId })
      : this.store.listTasks();
    const taskCounts = {
      total: tasks.length,
      pending: 0,
      ready: 0,
      dispatched: 0,
      blocked: 0,
      completed: 0,
      failed: 0,
    };
    for (const task of tasks) {
      taskCounts[task.status] += 1;
    }

    const dispatches = resolvedRunId
      ? this.store.listDispatches({ runId: resolvedRunId })
      : this.store.listDispatches();
    const activeDispatches = dispatches.filter((d) =>
      ACTIVE_DISPATCH_STATUSES.has(d.status)
    ).length;
    const pendingGates = this.store.listGates({
      ...(resolvedRunId ? { runId: resolvedRunId } : {}),
      status: 'pending',
    }).length;

    return {
      running,
      runId: resolvedRunId,
      coordinatorRun,
      activeCoordinatorRun,
      run,
      taskCounts,
      activeDispatches,
      pendingGates,
    };
  }

  // ==================== Messaging ====================

  private inferRunIdOptional(from?: string): string | undefined {
    if (from?.trim()) {
      const bound = this.store.getCurrentRunForConsumer(from.trim());
      if (bound) return bound.id;
      const dispatch = this.store.getActiveDispatchForIdentity(from.trim(), from.trim());
      if (dispatch) return dispatch.runId;
    }
    const activeCoord = this.store.getActiveCoordinatorRun();
    if (activeCoord) return activeCoord.runId;
    const runs = this.store.listRuns({ status: 'active' });
    return runs.length === 1 ? runs[0]!.id : undefined;
  }

  private notifyTargetAndAliases(
    toHandle: string,
    messageType: OrchestrationMessageType
  ): void {
    this.waiters.notify(toHandle, messageType);
    this.pointerDelivery.notifyMessageArrived(toHandle);

    if (toHandle === '@workers' || toHandle === '@all') {
      for (const paneId of this.pointerDelivery.resolvePanesForMailbox(toHandle)) {
        this.waiters.notify(paneId, messageType);
        const activeDispatch = this.store.getActiveDispatchForIdentity(paneId, paneId);
        if (activeDispatch) {
          this.waiters.notify(`dispatch:${activeDispatch.id}`, messageType);
        }
        const boundRun = this.store.getCurrentRunForConsumer(paneId);
        if (
          toHandle === '@all' &&
          boundRun &&
          (boundRun.coordinatorPaneId === paneId || boundRun.coordinatorHandle === paneId)
        ) {
          this.waiters.notify(`run:${boundRun.id}`, messageType);
        }
      }
      return;
    }

    if (!toHandle.startsWith('run:') && !toHandle.startsWith('dispatch:')) {
      const activeDispatch = this.store.getActiveDispatchForIdentity(toHandle, toHandle);
      if (activeDispatch) {
        const dispatchAddr = `dispatch:${activeDispatch.id}`;
        this.waiters.notify(dispatchAddr, messageType);
        this.pointerDelivery.notifyMessageArrived(dispatchAddr);
      }
      const boundRun = this.store.getCurrentRunForConsumer(toHandle);
      if (boundRun && (boundRun.coordinatorPaneId === toHandle || boundRun.coordinatorHandle === toHandle)) {
        const runAddr = `run:${boundRun.id}`;
        this.waiters.notify(runAddr, messageType);
        this.pointerDelivery.notifyMessageArrived(runAddr);
      }
    }
  }

  private expandGroupTargets(target: string, from: string, runId?: string): string[] {
    const resolvedRunId = runId?.trim() || this.inferRunIdOptional(from);
    const targets = new Set<string>();

    if (target === '@workers' || target === '@all') {
      const dispatches = this.store.listDispatches(
        resolvedRunId ? { runId: resolvedRunId } : undefined
      );
      for (const d of dispatches) {
        if (!ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
        const addr = `dispatch:${d.id}`;
        if (addr !== from && d.assigneeHandle !== from && d.assigneePaneId !== from) {
          targets.add(addr);
        }
      }
    }

    if (target === '@all') {
      const resolvedRun = resolvedRunId ? this.store.getRun(resolvedRunId) : undefined;
      if (resolvedRunId) {
        const runAddr = `run:${resolvedRunId}`;
        const isCallerRunCoordinator =
          resolvedRun &&
          (resolvedRun.coordinatorHandle === from || resolvedRun.coordinatorPaneId === from);
        if (runAddr !== from && !isCallerRunCoordinator) {
          targets.add(runAddr);
        }
      }
      const dispatches = this.store.listDispatches(
        resolvedRunId ? { runId: resolvedRunId } : undefined
      );
      for (const pane of this.agentStatusStore.list()) {
        if (!this.isPaneAlive(pane.ptyId) || pane.ptyId === from) continue;
        const hasActiveDispatch = dispatches.some(
          (d) =>
            ACTIVE_DISPATCH_STATUSES.has(d.status) &&
            (d.assigneeHandle === pane.ptyId || d.assigneePaneId === pane.ptyId)
        );
        if (hasActiveDispatch) continue;
        const bound = this.store.getCurrentRunForConsumer(pane.ptyId);
        const isBoundToResolvedRun =
          Boolean(resolvedRunId) &&
          (bound?.id === resolvedRunId ||
            resolvedRun?.coordinatorPaneId === pane.ptyId ||
            resolvedRun?.coordinatorHandle === pane.ptyId);
        if (isBoundToResolvedRun) continue;
        const isCoordinatorElsewhere =
          bound && (bound.coordinatorPaneId === pane.ptyId || bound.coordinatorHandle === pane.ptyId);
        if (isCoordinatorElsewhere) {
          targets.add(`run:${bound.id}`);
          continue;
        }
        targets.add(pane.ptyId);
      }
    }

    return [...targets];
  }

  send(input: {
    from?: string;
    to: string;
    type?: OrchestrationMessageType;
    priority?: OrchestrationMessagePriority;
    subject: string;
    body?: string;
    payload?: string | Record<string, unknown> | null;
    runId?: string;
    threadId?: string;
    capability?: string;
  }): {
    message: OrchestrationExposedMessage;
    messages?: OrchestrationExposedMessage[];
    recipients?: string[];
    lifecycle?: ReturnType<typeof reconcileLifecycleMessage>;
  } {
    const from = input.from?.trim() || 'coordinator';
    const rawTo = input.to.trim();
    if (!rawTo) {
      throw new OrchestrationError('invalid_argument', 'Missing message recipient (--to)');
    }

    const payloadString =
      input.payload === undefined || input.payload === null
        ? null
        : typeof input.payload === 'string'
          ? input.payload
          : JSON.stringify(input.payload);

    if (input.type === 'worker_done' || input.type === 'heartbeat') {
      let reportedDispatchId = '';
      try {
        const parsed = payloadString ? JSON.parse(payloadString) : null;
        if (parsed && typeof parsed.dispatchId === 'string') {
          reportedDispatchId = parsed.dispatchId;
        }
      } catch {
        reportedDispatchId = '';
      }
      if (reportedDispatchId) {
        this.store.assertDispatchCapability(reportedDispatchId, input.capability);
      }
    }

    if (rawTo === '@all' || rawTo === '@workers') {
      const resolvedRunId = input.runId?.trim() || this.inferRunIdOptional(from);
      const recipients = this.expandGroupTargets(rawTo, from, resolvedRunId);
      if (recipients.length === 0) {
        throw new OrchestrationError('not_found', `No active recipients matched ${rawTo}.`);
      }
      const inserted = recipients.map((recipient) => {
        const msg = this.store.insertMessage({
          runId: resolvedRunId ?? input.runId,
          from,
          to: recipient,
          type: input.type,
          priority: input.priority,
          subject: input.subject,
          body: input.body,
          payload: payloadString,
          threadId: input.threadId,
        });
        this.notifyTargetAndAliases(recipient, msg.type);
        return msg;
      });
      this.emitChanged('message:sent', inserted[0]?.runId);
      const exposed = exposeMessages(this.store, inserted);
      return {
        message: exposed[0]!,
        messages: exposed,
        recipients,
      };
    }

    let resolvedTo = rawTo;
    if (rawTo === 'coordinator') {
      const inferredRunId = this.resolveRunIdForCaller(input.runId, from);
      resolvedTo = `run:${inferredRunId}`;
    }

    const msg = this.store.insertMessage({
      runId: input.runId,
      from,
      to: resolvedTo,
      type: input.type,
      priority: input.priority,
      subject: input.subject,
      body: input.body,
      payload: payloadString,
      threadId: input.threadId,
    });

    const lifecycle =
      msg.type === 'worker_done' || msg.type === 'heartbeat'
        ? reconcileLifecycleMessage(this.store, msg)
        : undefined;

    const latestMsg = this.store.getMessageById(msg.id) ?? msg;
    if (lifecycle?.action === 'settled' && latestMsg.payload) {
      try {
        const parsedPayload = JSON.parse(latestMsg.payload) as { dispatchId?: unknown };
        if (typeof parsedPayload?.dispatchId === 'string' && parsedPayload.dispatchId) {
          this.waiters.cancel(`dispatch:${parsedPayload.dispatchId}`);
          this.waiters.notifyPrefix(`question:${parsedPayload.dispatchId}:`, 'status');
          this.notifyTargetAndAliases(`run:${latestMsg.runId}`, 'status');
        }
      } catch {
        /* ignore malformed payload */
      }
    }
    this.notifyTargetAndAliases(latestMsg.toHandle, latestMsg.type);
    this.emitChanged('message:sent', latestMsg.runId);

    return {
      message: exposeMessages(this.store, [latestMsg])[0]!,
      lifecycle,
    };
  }

  workerDone(input: {
    from?: string;
    taskId: string;
    dispatchId: string;
    outcome?: OrchestrationWorkerReportOutcome;
    summary?: string;
    capability?: string;
  }): {
    message: OrchestrationExposedMessage;
    lifecycle: ReturnType<typeof reconcileLifecycleMessage>;
    task: OrchestrationTaskRecord;
    dispatch: OrchestrationDispatchRecord;
  } {
    const dispatch = this.store.getDispatchContext(input.dispatchId);
    if (!dispatch) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch not found: ${input.dispatchId}`
      );
    }
    const outcome: OrchestrationWorkerReportOutcome = input.outcome ?? 'completed';
    const summary = input.summary?.trim() || '';
    const from = input.from?.trim();
    if (!from) {
      // Never default to the assignee: that would let any caller settle any dispatch.
      throw new OrchestrationError(
        'invalid_argument',
        'workerDone requires the caller identity (--from or an injected terminal handle).'
      );
    }
    this.store.assertDispatchCapability(dispatch.id, input.capability);
    const to = `run:${dispatch.runId}`;

    const sent = this.send({
      from,
      to,
      runId: dispatch.runId,
      type: 'worker_done',
      priority: outcome === 'failed' || outcome === 'escalated' ? 'high' : 'normal',
      subject: `worker_done ${input.taskId} (${outcome})`,
      body: summary,
      payload: {
        taskId: input.taskId,
        dispatchId: input.dispatchId,
        outcome,
        ...(summary ? { summary } : {}),
      },
      capability: input.capability,
    });

    return {
      message: sent.message,
      lifecycle: sent.lifecycle ?? { action: 'ignored' },
      task: this.store.requireTask(input.taskId),
      dispatch: this.store.getDispatchContext(input.dispatchId)!,
    };
  }

  private resolveCallerMailbox(input: {
    from: string;
    runId?: string;
  }):
    | { kind: 'run'; run: OrchestrationRunRecord; mailboxHandle: string }
    | { kind: 'dispatch'; dispatch: OrchestrationDispatchRecord; mailboxHandle: string }
    | { kind: 'direct'; mailboxHandle: string } {
    if (input.runId?.trim()) {
      const run = this.store.requireRun(input.runId.trim());
      return { kind: 'run', run, mailboxHandle: `run:${run.id}` };
    }

    const activeDispatch = this.store.getActiveDispatchForIdentity(input.from, input.from);
    const boundRun = this.store.getCurrentRunForConsumer(input.from);

    if (boundRun && !activeDispatch) {
      return { kind: 'run', run: boundRun, mailboxHandle: `run:${boundRun.id}` };
    }
    if (activeDispatch) {
      return {
        kind: 'dispatch',
        dispatch: activeDispatch,
        mailboxHandle: `dispatch:${activeDispatch.id}`,
      };
    }
    return { kind: 'direct', mailboxHandle: input.from };
  }

  private routeDirectMailIntoScope(
    scope: ReturnType<OrchestrationService['resolveCallerMailbox']>,
    callerHandle: string
  ): void {
    if (scope.kind === 'run') {
      this.store.routeUnreadDirectMessages(callerHandle, scope.mailboxHandle, scope.run.id);
      if (scope.run.coordinatorHandle && scope.run.coordinatorHandle !== callerHandle) {
        this.store.routeUnreadDirectMessages(
          scope.run.coordinatorHandle,
          scope.mailboxHandle,
          scope.run.id
        );
      }
    } else if (scope.kind === 'dispatch') {
      this.store.routeUnreadDirectMessages(
        callerHandle,
        scope.mailboxHandle,
        scope.dispatch.runId
      );
      if (scope.dispatch.assigneeHandle !== callerHandle) {
        this.store.routeUnreadDirectMessages(
          scope.dispatch.assigneeHandle,
          scope.mailboxHandle,
          scope.dispatch.runId
        );
      }
    }
  }

  async check(
    input: {
      from?: string;
      runId?: string;
      unread?: boolean;
      peek?: boolean;
      all?: boolean;
      wait?: boolean;
      timeoutMs?: number;
      types?: OrchestrationMessageType[];
      ack?: string;
      holdAck?: boolean;
      format?: boolean;
    },
    signal?: AbortSignal
  ): Promise<{
    mailbox: string;
    runId?: string;
    dispatchId?: string;
    deliveryId: string | null;
    acknowledged: string | null;
    replayed: boolean;
    messages: OrchestrationExposedMessage[];
    count: number;
    timedOut: boolean;
    cancelled: boolean;
    connectionLost: boolean;
    formatted?: string;
  }> {
    const from = input.from?.trim() || 'coordinator';
    const scope = this.resolveCallerMailbox({ from, runId: input.runId });
    this.routeDirectMailIntoScope(scope, from);

    const runId =
      scope.kind === 'run'
        ? scope.run.id
        : scope.kind === 'dispatch'
          ? scope.dispatch.runId
          : undefined;
    const dispatchId = scope.kind === 'dispatch' ? scope.dispatch.id : undefined;
    const consumerGeneration =
      scope.kind === 'run'
        ? scope.run.consumerGeneration
        : scope.kind === 'dispatch'
          ? scope.dispatch.consumerGeneration
          : 1;

    let acknowledgedId: string | null = null;
    if (input.ack) {
      const acked = this.store.acknowledgeDelivery(
        input.ack,
        scope.mailboxHandle,
        consumerGeneration,
        from
      );
      acknowledgedId = acked.id;
      if (!input.wait && !input.peek && !input.all) {
        return {
          mailbox: scope.mailboxHandle,
          runId,
          dispatchId,
          deliveryId: null,
          acknowledged: acknowledgedId,
          replayed: false,
          messages: [],
          count: 0,
          timedOut: false,
          cancelled: false,
          connectionLost: false,
        };
      }
    }

    const showAll = input.all === true || (input.unread === false && input.peek !== true);
    const shouldFormat = input.format !== false;

    const buildOutput = (
      msgs: OrchestrationMessageRecord[],
      opts: {
        mailbox?: string;
        deliveryId?: string | null;
        replayed?: boolean;
        timedOut?: boolean;
        cancelled?: boolean;
        connectionLost?: boolean;
      } = {}
    ) => {
      const exposed = exposeMessages(this.store, msgs);
      const formatted = shouldFormat
        ? msgs
            .map((m, idx) =>
              formatMessageBanner(m, {
                cliCommand: this.cliCommand,
                followUp: exposed[idx]?.followUp,
              })
            )
            .join('\n\n')
        : undefined;
      return {
        mailbox: opts.mailbox ?? scope.mailboxHandle,
        runId,
        dispatchId,
        deliveryId: opts.deliveryId ?? null,
        acknowledged: acknowledgedId,
        replayed: opts.replayed ?? false,
        messages: exposed,
        count: exposed.length,
        timedOut: opts.timedOut ?? false,
        cancelled: opts.cancelled ?? false,
        connectionLost: opts.connectionLost ?? false,
        ...(formatted !== undefined ? { formatted } : {}),
      };
    };

    if (showAll) {
      const msgs = this.store.getAllMessagesForHandle(scope.mailboxHandle, {
        types: input.types,
        limit: 100,
      });
      return buildOutput(msgs);
    }

    const broadcastRunId = runId ?? this.inferRunIdOptional(from);
    const broadcastCheckHandles = (() => {
      const boundRun = broadcastRunId ? this.store.getRun(broadcastRunId) : undefined;
      const isCoord =
        scope.kind === 'run' ||
        (boundRun !== undefined &&
          (boundRun.coordinatorHandle === from || boundRun.coordinatorPaneId === from));
      return isCoord ? (['@all'] as const) : (['@workers', '@all'] as const);
    })();

    const takeOrRead = (): {
      mailbox?: string;
      deliveryId: string | null;
      replayed: boolean;
      messages: OrchestrationMessageRecord[];
    } => {
      this.routeDirectMailIntoScope(scope, from);
      if (input.peek) {
        const directOrPrimary = this.store.getUnreadMessages(scope.mailboxHandle, {
          types: input.types,
          consumerHandle: from,
          limit: 100,
        });
        if (directOrPrimary.length > 0) {
          return {
            deliveryId: null,
            replayed: false,
            messages: directOrPrimary,
          };
        }
        for (const bHandle of broadcastCheckHandles) {
          const bMsgs = this.store.getUnreadMessages(bHandle, {
            types: input.types,
            consumerHandle: from,
            limit: 100,
          });
          if (bMsgs.length > 0) {
            return {
              mailbox: bHandle,
              deliveryId: null,
              replayed: false,
              messages: bMsgs,
            };
          }
        }
        return { deliveryId: null, replayed: false, messages: [] };
      }

      if (scope.kind !== 'direct') {
        const batch = this.store.takeMailboxDelivery({
          runId: runId!,
          mailboxHandle: scope.mailboxHandle,
          consumerHandle: from,
          consumerGeneration,
          types: input.types,
          holdAck: input.holdAck,
        });
        if (batch) {
          const processed = batch.messages.map((m) => {
            if (m.type === 'worker_done' || m.type === 'heartbeat') {
              reconcileLifecycleMessage(this.store, m);
              return this.store.getMessageById(m.id) ?? m;
            }
            return m;
          });
          return {
            deliveryId: batch.delivery.id,
            replayed: batch.replayed,
            messages: processed,
          };
        }
      } else {
        const unread = this.store.getUnreadMessages(scope.mailboxHandle, {
          types: input.types,
          limit: 100,
        });
        if (unread.length > 0) {
          const reconciled = unread.map((m) => {
            if (m.type === 'worker_done' || m.type === 'heartbeat') {
              reconcileLifecycleMessage(this.store, m);
              return this.store.getMessageById(m.id) ?? m;
            }
            return m;
          });
          this.store.markAsRead(unread.map((m) => m.id));
          return { deliveryId: null, replayed: false, messages: reconciled };
        }
      }

      for (const bHandle of broadcastCheckHandles) {
        const bBatch = this.store.takeMailboxDelivery({
          runId: broadcastRunId ?? '',
          mailboxHandle: bHandle,
          consumerHandle: from,
          consumerGeneration: 1,
          types: input.types,
          holdAck: input.holdAck,
        });
        if (bBatch) {
          const processed = bBatch.messages.map((m) => {
            if (m.type === 'worker_done' || m.type === 'heartbeat') {
              reconcileLifecycleMessage(this.store, m);
              return this.store.getMessageById(m.id) ?? m;
            }
            return m;
          });
          return {
            mailbox: bHandle,
            deliveryId: bBatch.delivery.id,
            replayed: bBatch.replayed,
            messages: processed,
          };
        }
      }

      return { deliveryId: null, replayed: false, messages: [] };
    };

    const initial = takeOrRead();
    if (initial.messages.length > 0 || !input.wait) {
      if (initial.messages.length > 0 && !input.peek) {
        this.emitChanged('mailbox:checked', runId);
      }
      return buildOutput(initial.messages, {
        mailbox: initial.mailbox,
        deliveryId: initial.deliveryId,
        replayed: initial.replayed,
      });
    }

    const waitResult = await this.waiters.wait(scope.mailboxHandle, {
      typeFilter: input.types,
      timeoutMs: input.timeoutMs,
      signal,
      consumerHandle: from,
    });

    if (waitResult === 'timed_out' || waitResult === 'cancelled') {
      if (
        this.store.getUndeliveredUnreadMessages(scope.mailboxHandle, {
          consumerHandle: from,
        }).length > 0
      ) {
        this.pointerDelivery.notifyMessageArrived(scope.mailboxHandle);
      }
      return buildOutput([], {
        timedOut: waitResult === 'timed_out',
        cancelled: waitResult === 'cancelled',
        connectionLost: waitResult === 'cancelled' && signal?.aborted === true,
      });
    }

    const typesKey = input.types?.length ? [...input.types].sort().join(',') : '*';
    const shareKey = `${scope.mailboxHandle}:${from}:${consumerGeneration}:${input.peek ? 'peek' : 'take'}:${input.holdAck ? 'hold' : 'ack'}:${typesKey}`;
    const arrived = waitResult.share(shareKey, takeOrRead, (first) =>
      input.peek || first.messages.length === 0 ? first : { ...first, replayed: true }
    );
    if (arrived.messages.length > 0 && !input.peek) {
      this.emitChanged('mailbox:checked', runId);
    }
    return buildOutput(arrived.messages, {
      mailbox: arrived.mailbox,
      deliveryId: arrived.deliveryId,
      replayed: arrived.replayed,
    });
  }

  inbox(input: {
    from?: string;
    runId?: string;
    limit?: number;
    types?: OrchestrationMessageType[];
    unreadOnly?: boolean;
  } = {}): {
    mailbox: string;
    messages: OrchestrationExposedMessage[];
    count: number;
  } {
    const from = input.from?.trim() || 'coordinator';
    const scope = this.resolveCallerMailbox({ from, runId: input.runId });
    const msgs = input.unreadOnly
      ? this.store.getUnreadMessages(scope.mailboxHandle, {
          types: input.types,
          consumerHandle: from,
          limit: input.limit ?? 100,
        })
      : this.store.getAllMessagesForHandle(scope.mailboxHandle, {
          types: input.types,
          limit: input.limit ?? 100,
        });
    return {
      mailbox: scope.mailboxHandle,
      messages: exposeMessages(this.store, msgs),
      count: msgs.length,
    };
  }

  // ==================== Questions / Ask / Reply ====================

  async ask(
    input: {
      from?: string;
      to?: string;
      question?: string;
      options?: string[];
      wait?: boolean;
      timeoutMs?: number;
      resume?: string;
      dispatchId?: string;
      runId?: string;
      capability?: string;
    },
    signal?: AbortSignal
  ): Promise<{
    messageId: string;
    threadId: string;
    answer: string | null;
    answerMessageId?: string | null;
    pending: boolean;
    timedOut: boolean;
    cancelled: boolean;
    connectionLost: boolean;
  }> {
    let questionRecord: OrchestrationQuestionRecord;
    const timeoutMs = input.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS;
    let preWaitAbort: AbortController | null = null;
    let preWaitPromise: Promise<MessageWake | 'timed_out' | 'cancelled'> | null = null;
    const onExternalAbort = () => {
      preWaitAbort?.abort();
    };
    const cleanupPreWait = () => {
      if (signal) {
        signal.removeEventListener('abort', onExternalAbort);
      }
      preWaitAbort?.abort();
      preWaitAbort = null;
      preWaitPromise = null;
    };

    try {
      if (input.resume?.trim()) {
        const existing = this.store.getQuestion(input.resume.trim());
        if (!existing) {
          throw new OrchestrationError('not_found', `Question not found: ${input.resume}`);
        }
        questionRecord = existing;
      } else {
        const questionText = input.question?.trim();
        if (!questionText) {
          throw new OrchestrationError('invalid_argument', 'Missing --question text');
        }
        const from = input.from?.trim() || 'worker';
        const activeDispatch = input.dispatchId?.trim()
          ? this.store.getDispatchContext(input.dispatchId.trim())
          : this.store.getActiveDispatchForIdentity(from, from);

        if (!activeDispatch || !ACTIVE_DISPATCH_STATUSES.has(activeDispatch.status)) {
          throw new OrchestrationError(
            'dispatch_inactive',
            `ask requires an active dispatch context (caller=${from}).`
          );
        }
        if (input.dispatchId?.trim()) {
          // An explicitly named dispatch requires both ownership and its per-dispatch credential.
          // Without --dispatch, ask always resolves the caller's own active dispatch instead.
          if (!hasLifecycleAuthority(activeDispatch, from)) {
            throw new OrchestrationError(
              'operation_rejected',
              `Caller ${from} does not own dispatch ${activeDispatch.id}.`
            );
          }
          this.store.assertDispatchCapability(activeDispatch.id, input.capability);
        }

        const rawTo = input.to?.trim() || `run:${activeDispatch.runId}`;
        const resolvedTo =
          rawTo === 'coordinator' ? `run:${activeDispatch.runId}` : rawTo;

        const msg = this.store.insertMessage({
          runId: input.runId ?? activeDispatch.runId,
          from: `dispatch:${activeDispatch.id}`,
          to: resolvedTo,
          type: 'question',
          priority: 'high',
          subject: questionText.slice(0, 80),
          body: questionText,
          payload: JSON.stringify({
            dispatchId: activeDispatch.id,
            taskId: activeDispatch.taskId,
            ...(input.options?.length ? { options: input.options } : {}),
          }),
        });

        questionRecord = this.store.createQuestion({
          messageId: msg.id,
          runId: msg.runId,
          dispatchId: activeDispatch.id,
          fromHandle: `dispatch:${activeDispatch.id}`,
          toHandle: msg.toHandle,
          question: questionText,
          options: input.options,
        });

        const preWaitHandle = `question:${questionRecord.dispatchId}:${questionRecord.messageId}`;
        if (input.wait && !signal?.aborted) {
          preWaitAbort = new AbortController();
          if (signal) {
            signal.addEventListener('abort', onExternalAbort, { once: true });
          }
          preWaitPromise = this.waiters.wait(preWaitHandle, {
            timeoutMs,
            signal: preWaitAbort.signal,
            consumerHandle: `dispatch:${activeDispatch.id}`,
          });
        }

        this.notifyTargetAndAliases(msg.toHandle, 'question');
        this.emitChanged('question:asked', msg.runId);
      }

      if (!input.wait && !input.resume) {
        return {
          messageId: questionRecord.messageId,
          threadId: questionRecord.messageId,
          answer: null,
          pending: true,
          timedOut: false,
          cancelled: false,
          connectionLost: false,
        };
      }

      const waitHandle = `question:${questionRecord.dispatchId}:${questionRecord.messageId}`;
      const deadline = Date.now() + timeoutMs;

      while (true) {
        const current = this.store.getQuestion(questionRecord.messageId);
        if (signal?.aborted) {
          if (current?.status === 'answered') {
            this.notifyTargetAndAliases(`dispatch:${current.dispatchId}`, 'status');
          }
          return {
            messageId: questionRecord.messageId,
            threadId: questionRecord.messageId,
            answer: null,
            pending: current?.status === 'pending',
            timedOut: false,
            cancelled: true,
            connectionLost: true,
          };
        }
        if (!current || current.status === 'closed') {
          throw new OrchestrationError(
            'dispatch_inactive',
            `Dispatch ${questionRecord.dispatchId} ended while waiting for answer.`
          );
        }
        if (current.status === 'answered') {
          if (current.answerMessageId) {
            this.store.markAsReadAndDelivered([current.answerMessageId]);
            this.store.acknowledgeDeliveriesForMessages([current.answerMessageId]);
          }
          return {
            messageId: current.messageId,
            threadId: current.messageId,
            answer: current.answerBody,
            answerMessageId: current.answerMessageId,
            pending: false,
            timedOut: false,
            cancelled: false,
            connectionLost: false,
          };
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          return {
            messageId: questionRecord.messageId,
            threadId: questionRecord.messageId,
            answer: null,
            pending: true,
            timedOut: true,
            cancelled: false,
            connectionLost: false,
          };
        }
        let outcome: MessageWake | 'timed_out' | 'cancelled';
        if (preWaitPromise) {
          const pending = preWaitPromise;
          preWaitPromise = null;
          outcome = await pending;
        } else {
          outcome = await this.waiters.wait(waitHandle, {
            timeoutMs: remaining,
            signal,
            consumerHandle: `dispatch:${questionRecord.dispatchId}`,
          });
        }
        if (outcome === 'timed_out') {
          return {
            messageId: questionRecord.messageId,
            threadId: questionRecord.messageId,
            answer: null,
            pending: true,
            timedOut: true,
            cancelled: false,
            connectionLost: false,
          };
        }
      }
    } finally {
      cleanupPreWait();
    }
  }

  reply(input: {
    id: string;
    body: string;
    from?: string;
  }): {
    message: OrchestrationExposedMessage;
    question?: OrchestrationQuestionRecord;
    duplicate?: boolean;
  } {
    const original = this.store.getMessageById(input.id);
    if (!original) {
      throw new OrchestrationError('not_found', `Message not found: ${input.id}`);
    }

    const question = this.store.getQuestion(original.id);
    if (question) {
      const answered = this.store.answerQuestion({
        messageId: question.messageId,
        answeredBy: input.from?.trim() || original.toHandle,
        body: input.body,
      });

      const waitHandle = `question:${question.dispatchId}:${question.messageId}`;
      const wokeAsker = this.waiters.notify(waitHandle, 'status');
      if (!wokeAsker) {
        this.notifyTargetAndAliases(`dispatch:${question.dispatchId}`, 'status');
      }
      this.emitChanged('question:answered', question.runId);
      return {
        message: exposeMessage(answered.message),
        question: answered.question,
        duplicate: answered.duplicate,
      };
    }

    const reportDispatchId = completionReportDispatchId(this.store, original);
    if (reportDispatchId) {
      const followUp = reportFollowUpAction(this.store, reportDispatchId);
      if (followUp) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Completion report ${original.id} for dispatch ${reportDispatchId} is finished; its worker no longer reads replies.`,
          { followUp }
        );
      }
    }

    this.store.markAsRead([original.id]);
    const replyMsg = this.store.insertMessage({
      runId: original.runId,
      from: input.from?.trim() || original.toHandle,
      to: original.fromHandle,
      type: 'status',
      subject: original.subject.startsWith('Re:')
        ? original.subject
        : `Re: ${original.subject}`,
      body: input.body,
      threadId: original.threadId ?? original.id,
    });

    this.notifyTargetAndAliases(replyMsg.toHandle, replyMsg.type);
    this.emitChanged('message:replied', replyMsg.runId);
    return {
      message: exposeMessage(replyMsg),
    };
  }

  // ==================== Decision Gates ====================

  gateCreate(input: {
    taskId: string;
    question: string;
    options?: string[];
    from?: string;
  }): { gate: OrchestrationGateRecord } {
    const task = this.store.requireTask(input.taskId);
    const activeDispatches = this.store.getActiveDispatchesForTask(task.id);
    const from = input.from?.trim();
    const activeDispatch = from ? this.store.getActiveDispatchForIdentity(from, from) : undefined;
    if (activeDispatch && activeDispatch.taskId !== task.id) {
      // A worker may only gate the task it is executing, never another dispatch's task.
      throw new OrchestrationError(
        'operation_rejected',
        `Worker ${from} holds dispatch ${activeDispatch.id} for task ${activeDispatch.taskId} and cannot open a gate for ${task.id}.`
      );
    }
    const gate = this.store.createGate({
      taskId: task.id,
      question: input.question,
      options: input.options,
      requesterDispatchId:
        activeDispatch?.taskId === task.id ? activeDispatch.id : undefined,
      requesterHandle: from ?? null,
    });
    for (const d of activeDispatches) {
      this.waiters.cancel(`dispatch:${d.id}`);
      this.waiters.notifyPrefix(`question:${d.id}:`, 'status');
    }

    const msg = this.store.insertMessage({
      runId: task.runId,
      from: from || 'orchestrator',
      to: `run:${task.runId}`,
      type: 'decision_gate',
      priority: 'urgent',
      subject: `Decision gate opened for ${task.id}`,
      body: gate.question,
      payload: JSON.stringify({
        gateId: gate.id,
        taskId: gate.taskId,
        options: gate.options,
      }),
    });
    this.notifyTargetAndAliases(msg.toHandle, msg.type);
    this.emitChanged('gate:created', task.runId);
    return { gate };
  }

  gateResolve(input: {
    id: string;
    resolution: string;
    from?: string;
  }): { gate: OrchestrationGateRecord } {
    const from = input.from?.trim();
    if (from && this.store.getActiveDispatchForIdentity(from, from)) {
      throw new OrchestrationError(
        'operation_rejected',
        `Worker ${from} cannot resolve a decision gate; the coordinator or a human operator must resolve it.`
      );
    }
    const gate = this.store.resolveGate(input.id, input.resolution);
    const msg = this.store.insertMessage({
      runId: gate.runId,
      from: 'human',
      to: `run:${gate.runId}`,
      type: 'status',
      priority: 'high',
      subject: `Decision gate ${gate.id} resolved`,
      body: input.resolution,
      payload: JSON.stringify({
        gateId: gate.id,
        taskId: gate.taskId,
        resolution: gate.resolution,
      }),
    });
    this.notifyTargetAndAliases(msg.toHandle, msg.type);
    this.emitChanged('gate:resolved', gate.runId);
    return { gate };
  }

  gateList(input: {
    runId?: string;
    taskId?: string;
    status?: OrchestrationGateStatus;
  } = {}): { gates: OrchestrationGateRecord[]; count: number } {
    const gates = this.store.listGates(input);
    return { gates, count: gates.length };
  }

  // ==================== Snapshot & Agent Text Views ====================

  getSnapshot(runId?: string): OrchestrationSnapshot {
    return this.store.getSnapshot(runId);
  }

  formatActionReceiptText(action: string, data: unknown, options: { full?: boolean } = {}): string {
    const record = (typeof data === 'object' && data !== null ? data : {}) as Record<
      string,
      unknown
    >;

    if (action === 'check') {
      const formatted = typeof record.formatted === 'string' ? record.formatted : '';
      const count = typeof record.count === 'number' ? record.count : 0;
      const deliveryId = typeof record.deliveryId === 'string' ? record.deliveryId : null;
      const mailbox = typeof record.mailbox === 'string' ? record.mailbox : '';
      const header = formatAgentFieldsText(
        [
          ['Mailbox', mailbox],
          ['Messages', String(count)],
          ['Delivery', deliveryId],
          ['Acknowledged', typeof record.acknowledged === 'string' ? record.acknowledged : null],
          ['Replayed', record.replayed ? 'true' : undefined],
          ['TimedOut', record.timedOut ? 'true' : undefined],
          ['Cancelled', record.cancelled ? 'true' : undefined],
        ],
        count > 0
          ? deliveryId
            ? `Review the messages above; acknowledgment ${deliveryId} recorded.`
            : 'Messages checked.'
          : 'No unread messages.'
      );
      if (count === 0) return header;
      if (options.full && formatted) {
        return `${header}\n\n${formatted}`;
      }
      return formatted ? `${header}\n\n${formatted}` : header;
    }

    if (action === 'send') {
      const msg = record.message as OrchestrationExposedMessage | undefined;
      return formatAgentFieldsText(
        [
          ['Message', msg?.id],
          ['From', msg?.fromHandle],
          ['To', msg?.toHandle],
          ['Type', msg?.type],
          ['Run', msg?.runId],
        ],
        'Message sent.'
      );
    }

    if (action === 'worker-done') {
      const task = record.task as OrchestrationTaskRecord | undefined;
      const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
      return formatAgentFieldsText(
        [
          ['Task', task?.id],
          ['TaskStatus', task?.status],
          ['Dispatch', dispatch?.id],
          ['DispatchStatus', dispatch?.status],
        ],
        'Worker completion report settled.'
      );
    }

    if (action === 'ask') {
      const pending = record.pending === true;
      return formatAgentFieldsText(
        [
          ['Question', String(record.messageId ?? '')],
          ['Pending', pending ? 'true' : 'false'],
          ['Answer', typeof record.answer === 'string' ? record.answer : null],
          ['TimedOut', record.timedOut ? 'true' : undefined],
        ],
        pending
          ? `Question pending; resume with: ${this.cliCommand} orchestration ask --resume ${String(record.messageId ?? '')} --wait`
          : 'Question answered.'
      );
    }

    if (action === 'reply') {
      const msg = record.message as OrchestrationExposedMessage | undefined;
      return formatAgentFieldsText(
        [
          ['Reply', msg?.id],
          ['To', msg?.toHandle],
          ['Thread', msg?.threadId],
          ['Duplicate', record.duplicate ? 'true' : undefined],
        ],
        'Reply delivered.'
      );
    }

    if (action === 'task-show') {
      const task = record.task as OrchestrationTaskRecord | undefined;
      const latestDispatch = record.latestDispatch as OrchestrationDispatchRecord | null | undefined;
      const gates = Array.isArray(record.gates) ? record.gates : [];
      return formatAgentFieldsText(
        [
          ['Task', task?.id],
          ['Title', task?.taskTitle],
          ['Status', task?.status],
          ['Run', task?.runId],
          ['Deps', task?.deps?.length ? task.deps.join(', ') : null],
          ['LatestDispatch', latestDispatch?.id ?? null],
          ['DispatchStatus', latestDispatch?.status ?? null],
          ['Gates', String(gates.length)],
        ],
        task ? `Task ${task.id} (${task.status}).` : 'Task details.'
      );
    }

    if (action === 'coordinator-status') {
      const counts = (record.taskCounts ?? {}) as Partial<
        OrchestrationCoordinatorStatusResult['taskCounts']
      >;
      return formatAgentFieldsText(
        [
          ['Running', record.running ? 'true' : 'false'],
          ['Run', typeof record.runId === 'string' ? record.runId : null],
          ['Tasks', counts.total !== undefined ? String(counts.total) : undefined],
          ['Ready', counts.ready !== undefined ? String(counts.ready) : undefined],
          ['Dispatched', counts.dispatched !== undefined ? String(counts.dispatched) : undefined],
          ['Completed', counts.completed !== undefined ? String(counts.completed) : undefined],
          [
            'ActiveDispatches',
            typeof record.activeDispatches === 'number' ? String(record.activeDispatches) : undefined,
          ],
          [
            'PendingGates',
            typeof record.pendingGates === 'number' ? String(record.pendingGates) : undefined,
          ],
        ],
        record.running ? 'Coordinator is running.' : 'Coordinator is idle.'
      );
    }

    return JSON.stringify(data, null, 2);
  }

  dispose(): void {
    try {
      this.activeCoordinator?.coordinator.stop();
    } catch {
      // ignore
    }
    const activeCoordRun = this.store.getActiveCoordinatorRun();
    if (
      activeCoordRun &&
      (activeCoordRun.status === 'running' || activeCoordRun.status === 'paused')
    ) {
      try {
        this.store.updateCoordinatorRun(activeCoordRun.id, {
          status: 'stopped',
          endedAt: new Date(this.clock()).toISOString(),
        });
      } catch {
        // ignore
      }
    }
    this.activeCoordinator = null;
    this.pointerDelivery.stop();
    this.waiters.dispose();
    this.disposeStatusListener();
    this.disposeActivityListener();
    if (this.staleSweepTimer !== null) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
    this.inFlightObservationDispatches.clear();
    this.store.close();
  }

  private async deliverAndObserveDispatchTurn(
    dispatchId: string | null,
    opts: {
      ptyId: string;
      prompt: string;
      submit?: boolean;
    }
  ): Promise<DeliverAndObserveAgentTurnResult> {
    const baselineWorkingSequence =
      this.agentStatusStore.getActivitySnapshot?.(opts.ptyId)?.workingSequence ?? 0;
    if (dispatchId) {
      this.inFlightObservationDispatches.add(dispatchId);
    }
    try {
      const res = await deliverAndObserveAgentTurn({
        ptyId: opts.ptyId,
        prompt: opts.prompt,
        submit: opts.submit ?? true,
        settleDelayMs: this.settleDelayMs,
        writePty: this.writePty,
        agentStatusStore: this.agentStatusStore,
        isPaneAlive: (ptyId) => this.isPaneAlive(ptyId),
        observeTimeoutMs: this.turnStartObserveTimeoutMs,
      });
      if (dispatchId && res.ok) {
        // Record delivery and the queued baseline on the dispatch itself so both survive restarts.
        this.store.updateDispatchObservation(dispatchId, res.startObservation, {
          promptSent: true,
          ...(res.startObservation === 'queued'
            ? { queuedWorkingBaseline: baselineWorkingSequence }
            : {}),
        });
      }
      return res;
    } finally {
      if (dispatchId) {
        this.inFlightObservationDispatches.delete(dispatchId);
      }
    }
  }

  /** Resolve after every queued snapshot write (temp-file fsync + rename) has completed. */
  async waitForPendingWrites(): Promise<void> {
    await this.store.waitForPendingWrite();
  }

  /** Reconcile stale dispatches for every run, including runs without a coordinator loop. */
  reconcileStaleDispatches(): void {
    const runIds = new Set<string>();
    for (const dispatch of this.store.listDispatches()) {
      if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
        runIds.add(dispatch.runId);
      }
    }
    for (const runId of runIds) {
      // Exits are reconciled too: without a coordinator loop nothing else fails dead workers.
      // Never-delivered claims are skipped so previews cannot be failed by a background sweep.
      reconcileExitedDispatchesForRun(this.store, runId, {
        hasPaneExited: (ptyId) => this.exitedPanes.has(ptyId),
        isPaneAlive: (ptyId) => this.isPaneAlive(ptyId),
        onlyDelivered: true,
        onEvent: (reason, id) => this.emitChanged(reason, id),
      });
      reconcileStaleDispatchesForRun(this.store, runId, {
        nowMs: this.clock(),
        startConfirmationTimeoutMs: this.startConfirmationTimeoutMs,
        heartbeatTimeoutMs: this.heartbeatTimeoutMs,
        staleWarningTimeoutMs: this.staleWarningTimeoutMs,
        onEvent: (reason, id) => this.emitChanged(reason, id),
      });
    }
  }
}
