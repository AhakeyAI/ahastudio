import type { PtyWriteFn } from '../agent/agent-prompt-delivery.js';
import type { AgentPaneStatus, AgentStatusStore } from '../agent/agent-status-store.js';
import type { TerminalReadResult, TerminalRuntimeTracker, TerminalSummary } from '../terminal-runtime-tracker.js';
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
  type OrchestrationDispatchStage,
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
  type WorkerApprovalPayload,
} from './orchestration-types.js';
import {
  PermissionApprovalManager,
  type PermissionHookInterceptInput,
} from './permission-approvals.js';
import { buildDispatchPreamble, redactDispatchCapability } from './worker-dispatch-preamble.js';
import { normalizeWorkerCliId, resolveWorkerLaunchConfig } from './worker-launch-catalog.js';
import { WorkerTurnStopMonitor } from './worker-turn-stops.js';
import {
  assertWorkerWorktreeClean,
  prepareWorkerWorktreePlacement,
  removeOwnedWorkerWorktree,
} from './worker-worktree-placement.js';
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
  dispatchId?: string;
  parentPaneId?: string | null;
  cwd?: string;
  worktreePath?: string | null;
  branch?: string | null;
  cliId?: string;
  ownsWorktree?: boolean;
  ownsPane?: boolean;
}

export interface OrchestrationPaneClosedEvent {
  ptyId: string;
  runId?: string;
  taskId?: string;
  dispatchId?: string;
}

export type OrchestrationSendResult = {
  message: OrchestrationExposedMessage;
  messages?: OrchestrationExposedMessage[];
  recipients?: string[];
  lifecycle?: ReturnType<typeof reconcileLifecycleMessage>;
  followUp?: {
    reactivated: true;
    previousDispatchId: string;
    dispatch: OrchestrationDispatchRecord;
    task: OrchestrationTaskRecord;
    reusedPane: boolean;
  };
};

export interface OrchestrationWorkerSummary {
  dispatch: OrchestrationDispatchRecord;
  task: OrchestrationTaskRecord | null;
  paneAlive: boolean;
  agentStatus: AgentPaneStatus | null;
  stage: OrchestrationDispatchStage;
  followUpChildDispatchId: string | null;
  openApprovals: WorkerApprovalPayload[];
  openQuestions: OrchestrationQuestionRecord[];
  terminal: TerminalSummary | null;
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
    extraArgs?: string[];
  }) => Promise<WorkerPaneCandidate | null>;
  closeWorkerPty?: (ptyId: string) => Promise<unknown> | unknown;
  isPtyAlive?: (ptyId: string) => boolean;
  /** Whether an id names an agent CLI (not a plain shell); auto-spawned workers must be agents. */
  isAgentCliId?: (cliId: string) => boolean;
  terminalTracker?: TerminalRuntimeTracker;
  getDefaultCwd?: () => string | undefined;
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
  turnStopSettleMs?: number;
  approvalHoldTimeoutMs?: number;
  now?: () => number;
}

export class OrchestrationService {
  readonly store: OrchestrationStore;
  readonly waiters: RuntimeMessageWaiters;
  readonly pointerDelivery: MailboxPointerDelivery;
  readonly approvals: PermissionApprovalManager;
  private readonly turnStopMonitor: WorkerTurnStopMonitor;

  private readonly agentStatusStore: AgentStatusStore;
  private readonly writePty: PtyWriteFn;
  private readonly spawnWorkerPty?: OrchestrationServiceDependencies['spawnWorkerPty'];
  private readonly closeWorkerPty?: OrchestrationServiceDependencies['closeWorkerPty'];
  private readonly externalIsPtyAlive?: (ptyId: string) => boolean;
  private readonly isAgentCliId?: (cliId: string) => boolean;
  private readonly terminalTracker?: TerminalRuntimeTracker;
  private readonly getDefaultCwd?: () => string | undefined;
  /** Worker panes auto-spawned by the Coordinator loop; retired on loop task completion unless retained. */
  private readonly spawnedWorkerPanes = new Set<string>();
  private readonly spawnedWorkerMeta = new Map<string, { runId: string; taskId: string }>();
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
  private readonly paneClosedListeners = new Set<
    (event: OrchestrationPaneClosedEvent) => void
  >();
  private readonly exitedPanes = new Set<string>();
  private readonly inFlightObservationDispatches = new Set<string>();
  private readonly workerMutations = new Set<string>();
  private readonly retiringPanes = new Set<string>();
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
    this.closeWorkerPty = deps.closeWorkerPty;
    this.externalIsPtyAlive = deps.isPtyAlive;
    this.isAgentCliId = deps.isAgentCliId;
    this.terminalTracker = deps.terminalTracker;
    this.getDefaultCwd = deps.getDefaultCwd;
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

    this.approvals = new PermissionApprovalManager({
      store: this.store,
      agentStatusStore: this.agentStatusStore,
      notifyMailbox: (mailbox, type) => this.notifyTargetAndAliases(mailbox, type),
      onChanged: (reason, runId) => this.emitChanged(reason, runId),
      cliCommand: this.cliCommand,
      holdTimeoutMs: deps.approvalHoldTimeoutMs,
      now: this.clock,
    });

    this.turnStopMonitor = new WorkerTurnStopMonitor({
      store: this.store,
      agentStatusStore: this.agentStatusStore,
      waiters: this.waiters,
      isPaneAlive: (ptyId) => this.isPaneAlive(ptyId),
      hasPaneExited: (ptyId) => this.exitedPanes.has(ptyId),
      capturePaneTail: (ptyId, maxChars) => this.terminalTracker?.captureTail(ptyId, maxChars) ?? '',
      hasOpenApprovalForDispatch: (dispatchId) => this.approvals.hasOpenApprovalForDispatch(dispatchId),
      isDeliveryInFlight: (dispatchId) => this.inFlightObservationDispatches.has(dispatchId),
      notifyMailbox: (mailbox, type) => this.notifyTargetAndAliases(mailbox, type),
      onTurnStopEscalated: (_dispatchId, runId) => this.emitChanged('worker:turn-stopped', runId),
      cliCommand: this.cliCommand,
      settleMs: deps.turnStopSettleMs,
    });

    this.disposeStatusListener = this.agentStatusStore.onChange((status) => {
      if (status.state === 'working' || status.state === 'waiting') {
        this.exitedPanes.delete(status.ptyId);
      } else if (status.state === 'idle') {
        this.exitedPanes.delete(status.ptyId);
        this.flushDeferredPromptsForPane(status.ptyId);
      }
    });

    this.disposeActivityListener = this.agentStatusStore.onActivity((snapshot) => {
      if (snapshot.state === 'idle') {
        this.exitedPanes.delete(snapshot.ptyId);
        this.flushDeferredPromptsForPane(snapshot.ptyId);
        return;
      }
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
    this.approvals.cancelForPane(ptyId);
    this.turnStopMonitor.notifyPaneExited(ptyId);
    this.pointerDelivery.retirePane(ptyId);
    this.waiters.cancel(ptyId);
    this.waiters.cancelConsumer(ptyId);
    for (const [dispatchId, deferred] of this.store.listDeferredDispatchPrompts()) {
      if (deferred.ptyId === ptyId) {
        this.store.deleteDeferredDispatchPrompt(dispatchId);
      }
    }
    for (const dispatch of this.store.listDispatches()) {
      if (dispatch.assigneePaneId === ptyId || dispatch.assigneeHandle === ptyId) {
        if (!dispatch.archivedOutput && this.terminalTracker) {
          const archived = this.terminalTracker.readFullTranscript(ptyId);
          if (archived) {
            this.store.archiveDispatchOutput(dispatch.id, archived);
          }
        }
      }
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

  onPaneClosed(listener: (event: OrchestrationPaneClosedEvent) => void): () => void {
    this.paneClosedListeners.add(listener);
    return () => this.paneClosedListeners.delete(listener);
  }

  private emitChanged(reason: string, runId?: string): void {
    if (this.eventListeners.size === 0) {
      return;
    }
    const event: OrchestrationEvent = {
      reason,
      runId,
      updatedAt: new Date(this.clock()).toISOString(),
      snapshot: this.getSnapshot(runId),
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

  private emitPaneClosed(event: OrchestrationPaneClosedEvent): void {
    for (const listener of this.paneClosedListeners) {
      try {
        listener(event);
      } catch (error) {
        console.warn('[orchestration] pane closed listener failed:', error);
      }
    }
  }

  private retireFinishedSpawnedWorkers(runId?: string): void {
    if (this.spawnedWorkerPanes.size === 0) {
      return;
    }
    for (const ptyId of [...this.spawnedWorkerPanes]) {
      if (this.retiringPanes.has(ptyId) || this.store.getActiveDispatchesForPane(ptyId).length > 0) {
        continue;
      }
      const retainedOnPane = this.store
        .listDispatches()
        .some((d) => (d.assigneePaneId === ptyId || d.assigneeHandle === ptyId) && d.retained);
      if (retainedOnPane) {
        continue;
      }
      const meta = this.spawnedWorkerMeta.get(ptyId);
      this.retiringPanes.add(ptyId);
      void this.confirmWorkerPaneClosed(ptyId)
        .then(() => {
          this.spawnedWorkerPanes.delete(ptyId);
          this.spawnedWorkerMeta.delete(ptyId);
          this.markPtyExited(ptyId);
          this.emitPaneClosed({
            ptyId,
            runId: meta?.runId ?? runId,
            taskId: meta?.taskId,
          });
        })
        .catch(error => console.warn(`[orchestration] failed to close worker PTY ${ptyId}:`, error))
        .finally(() => this.retiringPanes.delete(ptyId));
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

  assertRunCoordinator(runId: string, callerPaneId: string): void {
    const run = this.store.requireRun(runId);
    if (run.coordinatorPaneId !== callerPaneId) {
      throw new OrchestrationError('operation_rejected', 'Only this run’s coordinator may perform this action.');
    }
  }

  assertCanBindRunCoordinator(runId: string, callerPaneId: string): void {
    const run = this.store.requireRun(runId);
    if (this.store.getActiveDispatchesForPane(callerPaneId).some((d) => d.runId === run.id)) {
      throw new OrchestrationError(
        'operation_rejected',
        'A worker executing a task in this run cannot become its coordinator.'
      );
    }
    if (
      run.coordinatorPaneId &&
      run.coordinatorPaneId !== callerPaneId &&
      this.isPaneAlive(run.coordinatorPaneId)
    ) {
      throw new OrchestrationError(
        'operation_rejected',
        'Only this run’s active coordinator may rebind it while that terminal is still open.'
      );
    }
  }

  assertTaskCoordinator(taskId: string, callerPaneId: string): void {
    const task = this.store.requireTask(taskId);
    if (
      this.store
        .getActiveDispatchesForTask(task.id)
        .some((d) => d.assigneePaneId === callerPaneId || d.assigneeHandle === callerPaneId)
    ) {
      throw new OrchestrationError(
        'operation_rejected',
        'A worker cannot directly mutate task status; report completion with worker-done / task-done.'
      );
    }
    const run = this.store.requireRun(task.runId);
    const parentOfTask = this.store
      .listDispatches({ taskId: task.id })
      .some((d) => {
        if (d.parentPaneId === callerPaneId) return true;
        const parent = d.creatorDispatchId ? this.store.getDispatchContext(d.creatorDispatchId) : undefined;
        return Boolean(
          parent &&
            ACTIVE_DISPATCH_STATUSES.has(parent.status) &&
            (parent.assigneePaneId === callerPaneId || parent.assigneeHandle === callerPaneId)
        );
      });
    if (parentOfTask) return;
    if (!run.coordinatorPaneId && this.store.getActiveDispatchesForPane(callerPaneId).length === 0) {
      return;
    }
    this.assertRunCoordinator(task.runId, callerPaneId);
  }

  assertWorkerController(
    targetInput: { dispatchId?: string; worker?: string; taskId?: string },
    callerPaneId: string
  ): void {
    const rawTarget = this.resolveTargetDispatch(targetInput);
    const dispatch = this.store.resolveDispatchLineage(rawTarget.id) ?? rawTarget;
    const assignee = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    if (callerPaneId === assignee) {
      throw new OrchestrationError(
        'operation_rejected',
        'A worker cannot stop, release, or modify retention of its own dispatch.'
      );
    }
    const run = this.store.getRun(dispatch.runId);
    const parent = dispatch.creatorDispatchId
      ? this.store.getDispatchContext(dispatch.creatorDispatchId)
      : undefined;
    const parentPane = parent ? (parent.assigneePaneId ?? parent.assigneeHandle) : null;
    const authorized =
      callerPaneId === run?.coordinatorPaneId ||
      callerPaneId === dispatch.parentPaneId ||
      Boolean(parent && ACTIVE_DISPATCH_STATUSES.has(parent.status) && callerPaneId === parentPane) ||
      (!run?.coordinatorPaneId && this.store.getActiveDispatchesForPane(callerPaneId).length === 0);
    if (!authorized) {
      throw new OrchestrationError(
        'operation_rejected',
        'Only the run coordinator or spawning parent worker may control this worker.'
      );
    }
  }

  assertCanReply(messageId: string, callerPaneId: string): void {
    const original = this.store.getMessageById(messageId);
    if (!original) return;
    const question = this.store.getQuestion(original.id);
    if (!question) return;
    const dispatch = this.store.getDispatchContext(question.dispatchId);
    const askerPane = dispatch?.assigneePaneId ?? dispatch?.assigneeHandle ?? original.fromHandle;
    if (callerPaneId === askerPane) {
      throw new OrchestrationError(
        'operation_rejected',
        'A worker cannot answer its own blocking question.'
      );
    }
    const run = this.store.getRun(question.runId);
    const parent = dispatch?.creatorDispatchId
      ? this.store.getDispatchContext(dispatch.creatorDispatchId)
      : undefined;
    const parentPane = parent ? (parent.assigneePaneId ?? parent.assigneeHandle) : null;
    const authorized =
      callerPaneId === run?.coordinatorPaneId ||
      callerPaneId === dispatch?.parentPaneId ||
      Boolean(parent && ACTIVE_DISPATCH_STATUSES.has(parent.status) && callerPaneId === parentPane) ||
      callerPaneId === original.toHandle ||
      (!run?.coordinatorPaneId && this.store.getActiveDispatchesForPane(callerPaneId).length === 0);
    if (!authorized) {
      throw new OrchestrationError(
        'operation_rejected',
        'Only the addressed coordinator or parent worker may answer this question.'
      );
    }
  }

  assertNotActiveWorker(callerPaneId: string): void {
    if (this.store.getActiveDispatchesForPane(callerPaneId).length > 0) {
      throw new OrchestrationError(
        'operation_rejected',
        'An active worker cannot reset global orchestration state.'
      );
    }
  }

  isCoordinatorTerminal(ptyId: string): boolean {
    return this.store.listRuns().some(run =>
      (run.status === 'active' || run.status === 'stopped') && run.coordinatorPaneId === ptyId);
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
    if (runs.length === 0) {
      const stoppedRuns = this.store.listRuns({ status: 'stopped' });
      if (stoppedRuns.length === 1) {
        return stoppedRuns[0]!.id;
      }
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
      this.store.deleteDeferredDispatchPrompt(d.id);
      this.waiters.cancel(`dispatch:${d.id}`);
      this.waiters.notifyPrefix(`question:${d.id}:`, 'status');
    }
    if (settledTargets.length > 0) {
      this.retireFinishedSpawnedWorkers(task.runId);
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
    const parentPaneId = this.agentStatusStore.get(from)
      ? from
      : (callerDispatch?.assigneePaneId ?? this.store.getRun(task.runId)?.coordinatorPaneId ?? null);
    const ctx = this.store.createDispatchContext({
      taskId: task.id,
      assigneeHandle: assignee,
      assigneePaneId: paneStatus?.ptyId ?? null,
      creator: from,
      creatorRunId: task.runId,
      creatorDispatchId: callerDispatch?.id ?? null,
      parentPaneId,
      cliId: paneStatus?.agentId ?? null,
      ownsPane: false,
      ownsWorktree: false,
      maxDepth: this.maxDepth,
    });

    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: ctx.id,
      runId: task.runId,
      taskSpec: task.spec,
      coordinatorHandle: callerDispatch ? `dispatch:${callerDispatch.id}` : `run:${task.runId}`,
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
            ...(res.promptDeferred ? {} : { promptSent: true }),
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
    const parentForPreview = ctx?.creatorDispatchId
      ? (this.store.resolveDispatchLineage(ctx.creatorDispatchId) ??
          this.store.getDispatchContext(ctx.creatorDispatchId))
      : undefined;
    const previewCoordinatorHandle =
      parentForPreview && ACTIVE_DISPATCH_STATUSES.has(parentForPreview.status)
        ? `dispatch:${parentForPreview.id}`
        : `run:${task.runId}`;
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: ctx?.id ?? 'ctx_preview',
      runId: task.runId,
      taskSpec: task.spec,
      coordinatorHandle: previewCoordinatorHandle,
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
              this.spawnedWorkerMeta.set(spawned.ptyId, {
                runId: spawnInput.runId,
                taskId: spawnInput.task.id,
              });
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
        if (
          reason === 'coordinator:messages-processed' ||
          reason === 'coordinator:worker-exited' ||
          reason === 'coordinator:start-timeout' ||
          reason === 'coordinator:heartbeat-timeout' ||
          reason === 'coordinator:dispatch-failed' ||
          reason === 'coordinator:converged' ||
          reason === 'coordinator:stopped' ||
          reason === 'coordinator:failed'
        ) {
          this.retireFinishedSpawnedWorkers(runId);
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
    const canReuseBoundRun =
      boundRun &&
      (boundRun.status === 'active' || (boundRun.status === 'stopped' && !input.spec?.trim()));
    const explicitRunId = input.runId?.trim() || (canReuseBoundRun ? boundRun.id : undefined);
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
      isDeliberatelyWaiting: (d) => this.isDispatchDeliberatelyWaiting(d),
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
    this.retireFinishedSpawnedWorkers(runId);
    this.emitChanged('coordinator:stopped', runId);
    return { runId, coordinatorRunId, stopped: true };
  }

  async coordinatorTick(
    runId?: string,
    opts: { workerPaneIds?: string[] } = {}
  ): Promise<{ converged: boolean; runId: string }> {
    if (this.activeCoordinator && (!runId || this.activeCoordinator.runId === runId)) {
      const converged = await this.activeCoordinator.coordinator.tick();
      this.retireFinishedSpawnedWorkers(this.activeCoordinator.runId);
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
      isDeliberatelyWaiting: (d) => this.isDispatchDeliberatelyWaiting(d),
      now: this.clock,
    });
    const converged = await coordinator.tick();
    this.retireFinishedSpawnedWorkers(run.id);
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
    if (runs.length === 1) return runs[0]!.id;
    if (runs.length === 0) {
      const stoppedRuns = this.store.listRuns({ status: 'stopped' });
      if (stoppedRuns.length === 1) return stoppedRuns[0]!.id;
    }
    return undefined;
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

  private static readonly CLI_GROUP_TARGETS: Record<string, string> = {
    '@claude': 'claude',
    '@codex': 'codex',
    '@gemini': 'gemini',
    '@opencode': 'opencode',
    '@antigravity': 'antigravity',
    '@agy': 'antigravity',
    '@grok': 'grok',
  };

  private isGroupTarget(target: string): boolean {
    const lower = target.toLowerCase();
    return (
      lower === '@all' ||
      lower === '@workers' ||
      lower === '@idle' ||
      Object.hasOwn(OrchestrationService.CLI_GROUP_TARGETS, lower)
    );
  }

  private normalizeRecipientHandle(raw: string): string {
    const trimmed = raw.trim();
    if (!trimmed) return '';
    if (this.isGroupTarget(trimmed)) {
      return trimmed.toLowerCase();
    }
    if (trimmed.startsWith('@')) {
      return trimmed.slice(1).trim();
    }
    return trimmed;
  }

  private resolveActiveParentMailbox(dispatch: OrchestrationDispatchRecord): string {
    if (dispatch.creatorDispatchId) {
      const parent =
        this.store.resolveDispatchLineage(dispatch.creatorDispatchId) ??
        this.store.getDispatchContext(dispatch.creatorDispatchId);
      if (parent && ACTIVE_DISPATCH_STATUSES.has(parent.status)) {
        return `dispatch:${parent.id}`;
      }
    }
    return `run:${dispatch.runId}`;
  }

  private expandGroupTargets(target: string, from: string, runId?: string): string[] {
    const normalizedTarget = target.toLowerCase();
    const resolvedRunId = runId?.trim() || this.inferRunIdOptional(from);
    const targets = new Set<string>();
    const cliGroup = OrchestrationService.CLI_GROUP_TARGETS[normalizedTarget];

    if (
      normalizedTarget === '@workers' ||
      normalizedTarget === '@all' ||
      normalizedTarget === '@idle' ||
      cliGroup !== undefined
    ) {
      const dispatches = this.store.listDispatches(
        resolvedRunId ? { runId: resolvedRunId } : undefined
      );
      for (const d of dispatches) {
        if (!ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
        const addr = `dispatch:${d.id}`;
        if (addr === from || d.assigneeHandle === from || d.assigneePaneId === from) {
          continue;
        }
        if (normalizedTarget === '@idle') {
          const paneId = d.assigneePaneId ?? d.assigneeHandle;
          const paneState = this.agentStatusStore.get(paneId)?.state;
          if (paneState !== 'idle' && paneState !== 'done') {
            continue;
          }
        } else if (cliGroup !== undefined) {
          const paneId = d.assigneePaneId ?? d.assigneeHandle;
          const rawCli = d.cliId ?? this.agentStatusStore.get(paneId)?.agentId;
          let normCli: string | null = null;
          if (rawCli) {
            try {
              normCli = normalizeWorkerCliId(rawCli);
            } catch {
              normCli = rawCli.toLowerCase();
            }
          }
          if (normCli !== cliGroup) {
            continue;
          }
        }
        targets.add(addr);
      }
    }

    if (normalizedTarget === '@all') {
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
    to?: string;
    type?: OrchestrationMessageType;
    priority?: OrchestrationMessagePriority;
    subject: string;
    body?: string;
    payload?: string | Record<string, unknown> | null;
    runId?: string;
    threadId?: string;
    capability?: string;
  }): OrchestrationSendResult | Promise<OrchestrationSendResult> {
    const rawInputTo = input.to?.trim() ?? '';
    const isLifecycleReport = input.type === 'worker_done' || input.type === 'heartbeat';
    if (isLifecycleReport && rawInputTo.startsWith('@')) {
      throw new OrchestrationError(
        'invalid_argument',
        `${input.type} messages belong to a single dispatch and cannot target a group address (${rawInputTo}).`
      );
    }
    const rawTo = this.normalizeRecipientHandle(rawInputTo);
    if (!isLifecycleReport) {
      if (rawTo.startsWith('dispatch:')) {
        const requestedDispatchId = rawTo.slice('dispatch:'.length).trim();
        const latestInLineage = this.store.resolveDispatchLineage(requestedDispatchId);
        if (latestInLineage && !ACTIVE_DISPATCH_STATUSES.has(latestInLineage.status)) {
          return this.followUpSettledWorker(latestInLineage, { ...input, to: rawTo });
        }
        if (latestInLineage && latestInLineage.id !== requestedDispatchId) {
          return this.sendMailSync({ ...input, to: `dispatch:${latestInLineage.id}` });
        }
      } else if (
        rawTo &&
        !rawTo.startsWith('run:') &&
        rawTo !== 'coordinator' &&
        !this.isGroupTarget(rawTo) &&
        !this.store.getActiveDispatchForIdentity(rawTo, rawTo) &&
        !this.store.getCurrentRunForConsumer(rawTo)
      ) {
        const supervisedMatch = this.store
          .listDispatches()
          .filter(
            (d) =>
              (d.assigneePaneId === rawTo || d.assigneeHandle === rawTo) &&
              (d.ownsPane || d.ownsWorktree || Boolean(d.followUpOfDispatchId))
          )
          .at(-1);
        if (supervisedMatch) {
          const latestInLineage =
            this.store.resolveDispatchLineage(supervisedMatch.id) ?? supervisedMatch;
          if (!latestInLineage.releasedAt) {
            if (!ACTIVE_DISPATCH_STATUSES.has(latestInLineage.status)) {
              return this.followUpSettledWorker(latestInLineage, {
                ...input,
                to: `dispatch:${latestInLineage.id}`,
              });
            }
            return this.sendMailSync({ ...input, to: `dispatch:${latestInLineage.id}` });
          }
        }
      }
    }
    return this.sendMailSync({ ...input, to: rawTo });
  }

  private sendMailSync(input: {
    from?: string;
    to?: string;
    type?: OrchestrationMessageType;
    priority?: OrchestrationMessagePriority;
    subject: string;
    body?: string;
    payload?: string | Record<string, unknown> | null;
    runId?: string;
    threadId?: string;
    capability?: string;
  }): OrchestrationSendResult {
    const from = input.from?.trim() || 'coordinator';
    let rawTo = this.normalizeRecipientHandle(input.to ?? '');

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
          reportedDispatchId = parsed.dispatchId.trim();
        }
      } catch {
        reportedDispatchId = '';
      }
      if (reportedDispatchId) {
        this.store.assertDispatchCapability(reportedDispatchId, input.capability);
      }
      if (!rawTo) {
        const inferredDispatch = reportedDispatchId
          ? this.store.getDispatchContext(reportedDispatchId)
          : this.store.getActiveDispatchForIdentity(from, from);
        if (inferredDispatch) {
          rawTo = this.resolveActiveParentMailbox(inferredDispatch);
        } else {
          const inferredRunId = this.resolveRunIdForCaller(input.runId, from);
          rawTo = `run:${inferredRunId}`;
        }
      }
    }

    if (!rawTo) {
      throw new OrchestrationError('invalid_argument', 'Missing message recipient (--to)');
    }

    if (this.isGroupTarget(rawTo)) {
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
      const callerDispatch = this.store.getActiveDispatchForIdentity(from, from);
      if (callerDispatch) {
        resolvedTo = this.resolveActiveParentMailbox(callerDispatch);
      } else {
        const inferredRunId = this.resolveRunIdForCaller(input.runId, from);
        resolvedTo = `run:${inferredRunId}`;
      }
    }

    if (resolvedTo.startsWith('dispatch:')) {
      const activeId = resolvedTo.slice('dispatch:'.length);
      this.store.bumpDispatchGenerationForSteering(activeId);
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
          this.approvals.cancelForDispatch(parsedPayload.dispatchId, 'Dispatch settled');
          this.store.deleteDeferredDispatchPrompt(parsedPayload.dispatchId);
          this.waiters.cancel(`dispatch:${parsedPayload.dispatchId}`);
          this.waiters.notifyPrefix(`question:${parsedPayload.dispatchId}:`, 'status');
          this.notifyTargetAndAliases(`run:${latestMsg.runId}`, 'status');
        }
      } catch {
        /* ignore malformed payload */
      }
      this.retireFinishedSpawnedWorkers(latestMsg.runId);
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
    taskId?: string;
    dispatchId?: string;
    outcome?: OrchestrationWorkerReportOutcome | 'succeeded';
    summary?: string;
    capability?: string;
  }): {
    message: OrchestrationExposedMessage;
    lifecycle: ReturnType<typeof reconcileLifecycleMessage>;
    task: OrchestrationTaskRecord;
    dispatch: OrchestrationDispatchRecord;
  } {
    const from = input.from?.trim();
    const resolvedDispatch = input.dispatchId?.trim()
      ? this.store.getDispatchContext(input.dispatchId.trim())
      : from
        ? this.store.getActiveDispatchForIdentity(from, from)
        : undefined;
    if (!resolvedDispatch) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `Dispatch not found: ${input.dispatchId || '(inferred from caller)'}`
      );
    }
    const taskId = input.taskId?.trim() || resolvedDispatch.taskId;
    const outcome: OrchestrationWorkerReportOutcome =
      input.outcome === 'succeeded' || input.outcome === undefined ? 'completed' : input.outcome;
    const summary = input.summary?.trim() || '';
    if (!from) {
      // Never default to the assignee: that would let any caller settle any dispatch.
      throw new OrchestrationError(
        'invalid_argument',
        'workerDone requires the caller identity (--from or an injected terminal handle).'
      );
    }
    this.store.assertDispatchCapability(resolvedDispatch.id, input.capability);
    const to = this.resolveActiveParentMailbox(resolvedDispatch);

    const sent = this.sendMailSync({
      from,
      to,
      runId: resolvedDispatch.runId,
      type: 'worker_done',
      priority: outcome === 'failed' || outcome === 'escalated' ? 'high' : 'normal',
      subject: `worker_done ${taskId} (${outcome})`,
      body: summary,
      payload: {
        taskId,
        dispatchId: resolvedDispatch.id,
        outcome,
        ...(summary ? { summary } : {}),
      },
      capability: input.capability,
    });

    return {
      message: sent.message,
      lifecycle: sent.lifecycle ?? { action: 'ignored' },
      task: this.store.requireTask(taskId),
      dispatch: this.store.getDispatchContext(resolvedDispatch.id)!,
    };
  }

  taskDone(input: {
    from?: string;
    taskId?: string;
    dispatchId?: string;
    summary?: string;
    capability?: string;
  }) {
    return this.workerDone({ ...input, outcome: 'completed' });
  }

  taskFail(input: {
    from?: string;
    taskId?: string;
    dispatchId?: string;
    summary?: string;
    outcome?: 'failed' | 'blocked' | 'escalated' | 'abandoned';
    capability?: string;
  }) {
    return this.workerDone({ ...input, outcome: input.outcome ?? 'failed' });
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
    if (input.from.startsWith('run:')) {
      const explicitRunId = input.from.slice('run:'.length).trim();
      if (explicitRunId) {
        const run = this.store.requireRun(explicitRunId);
        return { kind: 'run', run, mailboxHandle: `run:${run.id}` };
      }
    }
    if (input.from.startsWith('dispatch:')) {
      const explicitDispatchId = input.from.slice('dispatch:'.length).trim();
      const explicitDispatch = explicitDispatchId
        ? this.store.getDispatchContext(explicitDispatchId)
        : undefined;
      if (explicitDispatch && ACTIVE_DISPATCH_STATUSES.has(explicitDispatch.status)) {
        return {
          kind: 'dispatch',
          dispatch: explicitDispatch,
          mailboxHandle: `dispatch:${explicitDispatch.id}`,
        };
      }
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

        const defaultParentMailbox = this.resolveActiveParentMailbox(activeDispatch);
        const normalizedExplicitTo = input.to?.trim()
          ? this.normalizeRecipientHandle(input.to)
          : '';
        const resolvedTo =
          !normalizedExplicitTo || normalizedExplicitTo === 'coordinator'
            ? defaultParentMailbox
            : normalizedExplicitTo;

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
      this.store.recordHeartbeat(question.dispatchId);

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
      this.store.deleteDeferredDispatchPrompt(d.id);
      this.waiters.cancel(`dispatch:${d.id}`);
      this.waiters.notifyPrefix(`question:${d.id}:`, 'status');
    }
    if (activeDispatches.length > 0) {
      this.retireFinishedSpawnedWorkers(task.runId);
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
  }, callerPaneId?: string): { gate: OrchestrationGateRecord } {
    const from = callerPaneId ?? input.from?.trim();
    if (callerPaneId) {
      const gate = this.store.getGate(input.id);
      if (!gate) throw new OrchestrationError('not_found', `Gate not found: ${input.id}`);
      this.assertRunCoordinator(gate.runId, callerPaneId);
    }
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

  // ==================== Autonomous Worker Lifecycle (Phases 7–9) ====================

  private deriveLiveStage(dispatch: OrchestrationDispatchRecord): OrchestrationDispatchStage {
    if (dispatch.releasedAt) return 'released';
    if (dispatch.status === 'completed') return 'done';
    if (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') {
      return dispatch.lastFailureReason === 'worker_stopped' ? 'stopped' : 'failed';
    }
    if (this.approvals.hasOpenApprovalForDispatch(dispatch.id)) {
      return 'waiting_permission';
    }
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const status = this.agentStatusStore.get(paneId);
    if (status?.state === 'waiting') {
      return status.waitKind === 'permission' ? 'waiting_permission' : 'waiting_input';
    }
    if (this.store.listQuestions({ dispatchId: dispatch.id, status: 'pending' }).length > 0) {
      return 'waiting_input';
    }
    const gen = dispatch.processGeneration ?? 1;
    if (dispatch.turnStopReportedGeneration === gen && status?.state !== 'working') {
      return 'awaiting_review';
    }
    if (status?.state === 'working' || dispatch.startObservation === 'observed') {
      return 'working';
    }
    if (dispatch.startObservation === 'permission') {
      return 'waiting_permission';
    }
    return dispatch.stage ?? 'starting';
  }

  private resolveTargetDispatch(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
  }): OrchestrationDispatchRecord {
    if (input.dispatchId?.trim()) {
      const clean = input.dispatchId.trim().startsWith('dispatch:')
        ? input.dispatchId.trim().slice('dispatch:'.length)
        : input.dispatchId.trim();
      const ctx = this.store.getDispatchContext(clean);
      if (!ctx) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch not found: ${clean}`);
      }
      return ctx;
    }
    if (input.taskId?.trim()) {
      const latest = this.store.getLatestDispatchForTask(input.taskId.trim());
      if (!latest) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `No dispatch found for task ${input.taskId.trim()}`
        );
      }
      return latest;
    }
    if (input.worker?.trim()) {
      const target = input.worker.trim();
      if (target.startsWith('dispatch:')) {
        const ctx = this.store.getDispatchContext(target.slice('dispatch:'.length));
        if (ctx) return ctx;
      }
      const active = this.store.getActiveDispatchForIdentity(target, target);
      if (active) return active;
      const allMatching = this.store
        .listDispatches()
        .filter((d) => d.assigneeHandle === target || d.assigneePaneId === target);
      const last = allMatching[allMatching.length - 1];
      if (last) return last;
      throw new OrchestrationError('dispatch_not_found', `Worker not found: ${target}`);
    }
    throw new OrchestrationError(
      'invalid_argument',
      'Specify --dispatch <dispatchId>, --worker <ptyId>, or --task <taskId>.'
    );
  }

  private toWorkerSummary(dispatch: OrchestrationDispatchRecord): OrchestrationWorkerSummary {
    const task = this.store.getTask(dispatch.taskId) ?? null;
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const paneAlive = paneId ? this.isPaneAlive(paneId) : false;
    const agentStatus = paneId ? this.agentStatusStore.get(paneId) : null;
    const stage = this.deriveLiveStage(dispatch);
    const followUpChild = this.store.getFollowUpChildDispatch(dispatch.id);
    const openApprovals = this.approvals.listOpenApprovals({ dispatchId: dispatch.id });
    const openQuestions = this.store.listQuestions({
      dispatchId: dispatch.id,
      status: 'pending',
    });
    const terminal = paneId ? (this.terminalTracker?.getTerminal(paneId) ?? null) : null;
    return {
      dispatch: { ...dispatch, stage },
      task,
      paneAlive,
      agentStatus,
      stage,
      followUpChildDispatchId: followUpChild?.id ?? null,
      openApprovals,
      openQuestions,
      terminal,
    };
  }

  async workerStart(input: {
    from?: string;
    runId?: string;
    taskId?: string;
    spec?: string;
    taskTitle?: string;
    displayName?: string;
    deps?: string[];
    priority?: OrchestrationMessagePriority;
    retryOfDispatchId?: string;
    cliId?: string;
    agent?: string;
    model?: string;
    effort?: string;
    terminal?: string;
    worktree?: string | boolean;
    noWorktree?: boolean;
    branch?: string;
    baseBranch?: string;
    name?: string;
    cwd?: string;
    callerCwd?: string;
    keepOpen?: boolean;
  }): Promise<{
    dispatch: OrchestrationDispatchRecord;
    task: OrchestrationTaskRecord;
    run: OrchestrationRunRecord;
    ptyId: string;
    worktreePath: string | null;
    branch: string | null;
    ownsWorktree: boolean;
    ownsPane: boolean;
    cliId: string;
    model: string | null;
    effort: string | null;
    injected: boolean;
  }> {
    const from = input.from?.trim() || 'coordinator';
    const callerDispatch = this.store.getActiveDispatchForIdentity(from, from);
    const nextDepth = this.store.resolveChildDispatchDepth(callerDispatch?.id ?? null);
    if (nextDepth > this.maxDepth) {
      throw new OrchestrationError(
        'operation_rejected',
        `Nested worker dispatch depth ${nextDepth} exceeds max depth ${this.maxDepth}.`,
        { depth: nextDepth, maxDepth: this.maxDepth }
      );
    }

    const reusingTerminal = input.terminal?.trim() || undefined;
    if (reusingTerminal && reusingTerminal === from) {
      throw new OrchestrationError(
        'terminal_is_coordinator',
        `Terminal ${reusingTerminal} is the caller's own terminal. Choose a different worker terminal.`
      );
    }
    if (reusingTerminal && !this.isPaneAlive(reusingTerminal)) {
      throw new OrchestrationError(
        'terminal_unavailable',
        `Target terminal ${reusingTerminal} is not alive.`
      );
    }
    if (reusingTerminal) {
      const existingActive = this.store.getActiveDispatchForIdentity(reusingTerminal, reusingTerminal);
      if (existingActive) {
        throw new OrchestrationError(
          'worker_busy',
          `Terminal ${reusingTerminal} already holds active dispatch ${existingActive.id}.`
        );
      }
    }

    const callerStatus = this.agentStatusStore.get(from);
    const inferredCli =
      input.cliId?.trim() ||
      input.agent?.trim() ||
      (reusingTerminal ? this.agentStatusStore.get(reusingTerminal)?.agentId : undefined) ||
      callerDispatch?.cliId ||
      callerStatus?.agentId ||
      'claude';

    const launchConfig = resolveWorkerLaunchConfig({
      cliId: inferredCli,
      model: input.model,
      effort: input.effort,
      reusingTerminal: Boolean(reusingTerminal),
    });

    if (!reusingTerminal && !this.spawnWorkerPty) {
      throw new OrchestrationError(
        'terminal_unavailable',
        'Autonomous worker spawning is not configured on this OrchestrationService instance.'
      );
    }

    // Resolve or create Run and Task.
    let task: OrchestrationTaskRecord;
    let run: OrchestrationRunRecord;
    if (input.retryOfDispatchId?.trim()) {
      const prior = this.store.getDispatchContext(input.retryOfDispatchId.trim());
      if (!prior) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Prior dispatch not found: ${input.retryOfDispatchId}`
        );
      }
      run = this.store.requireRun(prior.runId);
      const priorTask = this.store.requireTask(prior.taskId);
      if (priorTask.status === 'completed') {
        task = this.store.createTask({
          runId: run.id,
          spec: input.spec?.trim() || priorTask.spec,
          taskTitle: input.taskTitle ?? `Retry: ${priorTask.taskTitle}`,
          displayName: input.displayName,
          priority: input.priority ?? priorTask.priority,
        });
      } else {
        task = this.store.requeueTaskForRetry(priorTask.id);
      }
    } else if (input.taskId?.trim()) {
      this.store.promoteReadyTasks();
      task = this.store.requireTask(input.taskId.trim());
      run = this.store.requireRun(task.runId);
    } else if (input.spec?.trim()) {
      const inferredRunId = input.runId?.trim() || this.inferRunIdOptional(from);
      if (inferredRunId) {
        run = this.store.requireRun(inferredRunId);
        if (run.status !== 'active') {
          run = this.store.updateRunStatus(run.id, 'active');
        }
      } else {
        const callerPane = callerStatus ? from : undefined;
        run = this.runCreate({
          objective: input.taskTitle?.trim() || input.spec.trim().slice(0, 120),
          from,
          paneId: callerPane,
        }).run;
      }
      task = this.store.createTask({
        runId: run.id,
        spec: input.spec.trim(),
        taskTitle: input.taskTitle,
        displayName: input.displayName,
        deps: input.deps,
        priority: input.priority,
      });
    } else {
      throw new OrchestrationError(
        'invalid_argument',
        'worker-start requires either --task <taskId>, --spec "<spec>", or --retry-of <dispatchId>.'
      );
    }

    if (task.status !== 'ready') {
      throw new OrchestrationError(
        'task_not_ready',
        `Task ${task.id} is ${task.status}; only ready tasks can be started.`
      );
    }

    const parentPaneId = callerStatus
      ? from
      : (callerDispatch?.assigneePaneId ?? run.coordinatorPaneId ?? null);
    const parentTerminal = parentPaneId ? this.terminalTracker?.getTerminal(parentPaneId) : null;
    const baseCwd =
      input.cwd?.trim() ||
      task.worktreePath ||
      callerDispatch?.worktreePath ||
      input.callerCwd?.trim() ||
      parentTerminal?.cwd ||
      this.getDefaultCwd?.() ||
      process.cwd();

    const reusingTerminalCwd = reusingTerminal
      ? this.terminalTracker?.getTerminal(reusingTerminal)?.cwd ?? baseCwd
      : undefined;

    const placement = await prepareWorkerWorktreePlacement({
      baseCwd,
      taskId: task.id,
      taskTitle: task.taskTitle,
      name: input.name,
      worktree: input.worktree,
      noWorktree: input.noWorktree,
      branch: input.branch,
      baseBranch: input.baseBranch,
      reusingTerminalCwd,
    });

    let ptyId: string;
    let ownsPane = false;
    if (reusingTerminal) {
      ptyId = reusingTerminal;
      ownsPane = false;
    } else {
      try {
        const spawned = await this.spawnWorkerPty!({
          runId: run.id,
          task,
          cliId: launchConfig.cliId,
          cwd: placement.cwd,
          extraArgs: launchConfig.extraArgs,
        });
        if (!spawned) {
          throw new OrchestrationError(
            'terminal_unavailable',
            `Failed to spawn worker terminal for CLI "${launchConfig.cliId}".`
          );
        }
        ptyId = spawned.ptyId;
        ownsPane = true;
        this.exitedPanes.delete(ptyId);
      } catch (err) {
        if (placement.ownsWorktree && placement.worktreePath) {
          await this.rollbackWorkerResources(undefined, placement.worktreePath);
        }
        throw err instanceof OrchestrationError
          ? err
          : new OrchestrationError(
              'terminal_unavailable',
              err instanceof Error ? err.message : String(err)
            );
      }
    }

    let ctx: OrchestrationDispatchRecord;
    try {
      ctx = this.store.createDispatchContext({
        taskId: task.id,
        assigneeHandle: ptyId,
        assigneePaneId: ptyId,
        creator: from,
        creatorRunId: run.id,
        creatorDispatchId: callerDispatch?.id ?? null,
        parentPaneId,
        worktreePath: placement.worktreePath,
        branch: placement.branch,
        ownsWorktree: placement.ownsWorktree,
        ownsPane,
        cliId: launchConfig.cliId,
        model: launchConfig.model,
        effort: launchConfig.effort,
        processGeneration: 1,
        retained: Boolean(input.keepOpen),
        maxDepth: this.maxDepth,
      });
    } catch (err) {
      await this.rollbackWorkerResources(
        ownsPane ? ptyId : undefined,
        placement.ownsWorktree ? placement.worktreePath : null,
      );
      throw err;
    }

    if (ownsPane) {
      this.emitPaneSpawned({
        ptyId,
        runId: run.id,
        taskId: task.id,
        dispatchId: ctx.id,
        parentPaneId,
        cwd: placement.cwd,
        worktreePath: placement.worktreePath,
        branch: placement.branch,
        cliId: launchConfig.cliId,
        ownsWorktree: placement.ownsWorktree,
        ownsPane: true,
      });
    }

    const coordinatorHandle = callerDispatch ? `dispatch:${callerDispatch.id}` : `run:${run.id}`;
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: ctx.id,
      runId: run.id,
      taskSpec: task.spec,
      coordinatorHandle,
      workerHandle: ptyId,
      worktreePath: placement.worktreePath,
      branch: placement.branch,
      canDispatchSubWorkers: ctx.depth < this.maxDepth,
      cliCommand: this.cliCommand,
      dispatchCapability: this.store.getDispatchCapability(ctx.id),
    });

    const delivery = await this.deliverAndObserveDispatchTurn(ctx.id, {
      ptyId,
      prompt: preamble,
      submit: true,
    });

    if (!delivery.ok) {
      const reason = delivery.error ?? `Failed to deliver worker prompt to ${ptyId}`;
      this.store.failDispatch(ctx.id, reason);
      const closed = await this.rollbackWorkerResources(
        ownsPane ? ptyId : undefined,
        placement.ownsWorktree ? placement.worktreePath : null,
      );
      if (closed && ownsPane) {
        this.emitPaneClosed({ ptyId, runId: run.id, taskId: task.id, dispatchId: ctx.id });
      }
      this.emitChanged('dispatch:failed', run.id);
      throw new OrchestrationError('prompt_delivery_failed', reason, {
        dispatchId: ctx.id,
        taskId: task.id,
        ptyId,
      });
    }

    const updatedCtx =
      this.store.updateDispatchObservation(ctx.id, delivery.startObservation, {
        reason: delivery.observationReason ?? null,
        refreshHeartbeat:
          delivery.startObservation === 'observed' ||
          delivery.startObservation === 'queued' ||
          delivery.startObservation === 'permission',
        ...(delivery.promptDeferred ? {} : { promptSent: true }),
      }) ?? ctx;

    const auditMsg = this.store.insertMessage({
      runId: run.id,
      from,
      to: `dispatch:${ctx.id}`,
      type: 'dispatch',
      subject: `Started worker for ${task.id}`,
      body: redactDispatchCapability(preamble, this.store.getDispatchCapability(ctx.id)),
    });
    this.store.markAsReadAndDelivered([auditMsg.id]);

    this.emitChanged('worker:started', run.id);
    return {
      dispatch: this.store.getDispatchContext(ctx.id) ?? updatedCtx,
      task: this.store.requireTask(task.id),
      run: this.store.requireRun(run.id),
      ptyId,
      worktreePath: placement.worktreePath,
      branch: placement.branch,
      ownsWorktree: placement.ownsWorktree,
      ownsPane,
      cliId: launchConfig.cliId,
      model: launchConfig.model,
      effort: launchConfig.effort,
      injected: true,
    };
  }

  private async followUpSettledWorker(
    settledDispatch: OrchestrationDispatchRecord,
    input: {
      from?: string;
      to: string;
      type?: OrchestrationMessageType;
      priority?: OrchestrationMessagePriority;
      subject: string;
      body?: string;
      payload?: string | Record<string, unknown> | null;
      runId?: string;
      threadId?: string;
    }
  ): Promise<OrchestrationSendResult> {
    return this.mutateWorkerResources(settledDispatch, () => this.startFollowUp(settledDispatch, input));
  }

  private async startFollowUp(
    settledDispatch: OrchestrationDispatchRecord,
    input: Parameters<OrchestrationService['followUpSettledWorker']>[1]
  ): Promise<OrchestrationSendResult> {
    if (settledDispatch.releasedAt) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Worker dispatch ${settledDispatch.id} has already been released; start a new worker with worker-start.`
      );
    }

    const from = input.from?.trim() || 'coordinator';
    const run = this.store.requireRun(settledDispatch.runId);
    if (run.status !== 'active') {
      this.store.updateRunStatus(run.id, 'active');
    }
    const prevTask = this.store.getTask(settledDispatch.taskId);
    const followUpInstructions = [
      input.subject,
      ...(input.body?.trim() ? ['', input.body.trim()] : []),
    ].join('\n');

    const followUpTask = this.store.createTask({
      runId: settledDispatch.runId,
      spec: followUpInstructions,
      taskTitle: `Follow-up: ${input.subject.slice(0, 80)}`,
      priority: input.priority ?? prevTask?.priority ?? 'normal',
      worktreePath: settledDispatch.worktreePath ?? prevTask?.worktreePath ?? null,
    });

    const existingPaneId = settledDispatch.assigneePaneId ?? settledDispatch.assigneeHandle;
    if (this.retiringPanes.has(existingPaneId)) {
      throw new OrchestrationError('operation_rejected', 'This worker terminal is still closing. Retry once it exits.');
    }
    const canReuseLivePane =
      Boolean(existingPaneId) &&
      this.isPaneAlive(existingPaneId) &&
      !this.store.getActiveDispatchForIdentity(existingPaneId, existingPaneId);

    let targetPtyId: string;
    let reusedPane = false;
    let spawnedNewPane = false;

    if (canReuseLivePane) {
      targetPtyId = existingPaneId;
      reusedPane = true;
    } else {
      if (!this.spawnWorkerPty) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Worker pane ${existingPaneId} is no longer alive and worker respawning is unavailable.`
        );
      }
      const launch = resolveWorkerLaunchConfig({
        cliId: settledDispatch.cliId ?? 'claude',
        model: settledDispatch.model,
        effort: settledDispatch.effort,
      });
      const spawned = await this.spawnWorkerPty({
        runId: settledDispatch.runId,
        task: followUpTask,
        cliId: launch.cliId,
        cwd: settledDispatch.worktreePath ?? undefined,
        extraArgs: launch.extraArgs,
      });
      if (!spawned) {
        throw new OrchestrationError(
          'terminal_unavailable',
          `Failed to respawn worker terminal for follow-up on ${settledDispatch.id}.`
        );
      }
      targetPtyId = spawned.ptyId;
      spawnedNewPane = true;
      this.exitedPanes.delete(targetPtyId);
    }

    const nextGeneration = (settledDispatch.processGeneration ?? 1) + 1;
    let nextCtx: OrchestrationDispatchRecord;
    try {
      nextCtx = this.store.createDispatchContext({
        taskId: followUpTask.id,
        assigneeHandle: targetPtyId,
        assigneePaneId: targetPtyId,
        creator: from,
        creatorRunId: settledDispatch.runId,
        creatorDispatchId: settledDispatch.creatorDispatchId ?? null,
        parentPaneId: settledDispatch.parentPaneId ?? null,
        worktreePath: settledDispatch.worktreePath ?? null,
        branch: settledDispatch.branch ?? null,
        ownsWorktree: Boolean(settledDispatch.ownsWorktree),
        ownsPane: spawnedNewPane ? true : Boolean(settledDispatch.ownsPane),
        cliId: settledDispatch.cliId ?? null,
        model: settledDispatch.model ?? null,
        effort: settledDispatch.effort ?? null,
        processGeneration: nextGeneration,
        followUpOfDispatchId: settledDispatch.id,
        retained: Boolean(settledDispatch.retained),
        maxDepth: Math.max(this.maxDepth, settledDispatch.depth),
      });
    } catch (error) {
      if (spawnedNewPane) {
        if (await this.rollbackWorkerResources(targetPtyId)) this.markPtyExited(targetPtyId);
      }
      throw error;
    }

    this.store.transferCustodyToFollowUp(settledDispatch.id, nextCtx.id);

    if (spawnedNewPane) {
      this.emitPaneSpawned({
        ptyId: targetPtyId,
        runId: settledDispatch.runId,
        taskId: followUpTask.id,
        dispatchId: nextCtx.id,
        parentPaneId: settledDispatch.parentPaneId ?? null,
        cwd: settledDispatch.worktreePath ?? undefined,
        worktreePath: settledDispatch.worktreePath ?? null,
        branch: settledDispatch.branch ?? null,
        cliId: settledDispatch.cliId ?? undefined,
        ownsWorktree: Boolean(nextCtx.ownsWorktree),
        ownsPane: true,
      });
    }

    const payloadString =
      input.payload === undefined || input.payload === null
        ? null
        : typeof input.payload === 'string'
          ? input.payload
          : JSON.stringify(input.payload);

    const msg = this.store.insertMessage({
      runId: settledDispatch.runId,
      from,
      to: `dispatch:${nextCtx.id}`,
      type: input.type ?? 'status',
      priority: input.priority ?? 'normal',
      subject: input.subject,
      body: input.body,
      payload: payloadString,
      threadId: input.threadId,
    });
    this.store.markAsReadAndDelivered([msg.id]);

    const coordinatorHandle = this.resolveActiveParentMailbox(nextCtx);
    const preamble = buildDispatchPreamble({
      taskId: followUpTask.id,
      dispatchId: nextCtx.id,
      runId: settledDispatch.runId,
      taskSpec: followUpInstructions,
      coordinatorHandle,
      workerHandle: targetPtyId,
      worktreePath: nextCtx.worktreePath,
      branch: nextCtx.branch,
      canDispatchSubWorkers: nextCtx.depth < this.maxDepth,
      cliCommand: this.cliCommand,
      dispatchCapability: this.store.getDispatchCapability(nextCtx.id),
      isFollowUp: true,
      previousDispatchId: settledDispatch.id,
    });

    const delivery = await this.deliverAndObserveDispatchTurn(nextCtx.id, {
      ptyId: targetPtyId,
      prompt: preamble,
      submit: true,
    });
    if (!delivery.ok) {
      const reason = delivery.error ?? `Failed to deliver follow-up prompt to ${targetPtyId}`;
      this.store.failDispatch(nextCtx.id, reason);
      if (spawnedNewPane && await this.rollbackWorkerResources(targetPtyId)) {
        this.spawnedWorkerPanes.delete(targetPtyId);
        this.spawnedWorkerMeta.delete(targetPtyId);
        this.markPtyExited(targetPtyId);
        this.emitPaneClosed({
          ptyId: targetPtyId,
          runId: settledDispatch.runId,
          taskId: followUpTask.id,
          dispatchId: nextCtx.id,
        });
      }
      this.emitChanged('dispatch:failed', settledDispatch.runId);
      throw new OrchestrationError('prompt_delivery_failed', reason, {
        dispatchId: nextCtx.id,
        previousDispatchId: settledDispatch.id,
      });
    }

    this.store.updateDispatchObservation(nextCtx.id, delivery.startObservation, {
      reason: delivery.observationReason ?? null,
      refreshHeartbeat:
        delivery.startObservation === 'observed' ||
        delivery.startObservation === 'queued' ||
        delivery.startObservation === 'permission',
      ...(delivery.promptDeferred ? {} : { promptSent: true }),
    });

    this.emitChanged('worker:follow-up', settledDispatch.runId);
    return {
      message: exposeMessage(msg),
      followUp: {
        reactivated: true,
        previousDispatchId: settledDispatch.id,
        dispatch: this.store.getDispatchContext(nextCtx.id)!,
        task: this.store.requireTask(followUpTask.id),
        reusedPane,
      },
    };
  }

  workerList(input: {
    runId?: string;
    status?: OrchestrationDispatchRecord['status'];
    includeSettled?: boolean;
  } = {}): {
    workers: OrchestrationWorkerSummary[];
    count: number;
  } {
    const includeSettled = input.includeSettled !== false;
    const dispatches = this.store
      .listDispatches({
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.status ? { status: input.status } : {}),
      })
      .filter((d) => includeSettled || ACTIVE_DISPATCH_STATUSES.has(d.status));
    const workers = dispatches.map((d) => this.toWorkerSummary(d));
    return { workers, count: workers.length };
  }

  workerShow(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
  }): OrchestrationWorkerSummary {
    const dispatch = this.resolveTargetDispatch(input);
    return this.toWorkerSummary(dispatch);
  }

  workerRead(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    cursor?: number;
    limit?: number;
    screen?: boolean;
  }): TerminalReadResult & { dispatchId: string; archived: boolean } {
    const dispatch = this.resolveTargetDispatch(input);
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const capability = this.store.getDispatchCapability(dispatch.id);

    if (paneId && this.terminalTracker) {
      const liveRead = this.terminalTracker.readOutput(paneId, {
        cursor: input.cursor,
        limit: input.limit,
        screen: input.screen,
      });
      if (liveRead && (liveRead.alive || !dispatch.archivedOutput)) {
        return {
          ...liveRead,
          text: redactDispatchCapability(liveRead.text, capability),
          dispatchId: dispatch.id,
          archived: !liveRead.alive || Boolean(dispatch.releasedAt),
        };
      }
    }

    const archived = redactDispatchCapability(dispatch.archivedOutput ?? '', capability);
    if (input.screen) {
      return {
        ptyId: paneId ?? dispatch.id,
        dispatchId: dispatch.id,
        screen: true,
        text: archived,
        cursor: archived.length,
        nextCursor: archived.length,
        truncated: false,
        hasMore: false,
        alive: false,
        exitCode: null,
        archived: true,
      };
    }

    const limit = Math.max(1, Math.min(256_000, Math.floor(input.limit ?? 16_384)));
    const start = Math.min(
      archived.length,
      Math.max(0, typeof input.cursor === 'number' ? Math.floor(input.cursor) : 0)
    );
    const slice = archived.slice(start, start + limit);
    return {
      ptyId: paneId ?? dispatch.id,
      dispatchId: dispatch.id,
      screen: false,
      text: slice,
      cursor: start,
      nextCursor: start + slice.length,
      truncated: false,
      hasMore: start + slice.length < archived.length,
      alive: false,
      exitCode: null,
      archived: true,
    };
  }

  workerKeepOpen(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    keepOpen?: boolean;
  }): { dispatch: OrchestrationDispatchRecord; retained: boolean } {
    const target = this.resolveTargetDispatch(input);
    const retained = input.keepOpen ?? true;
    const updated = this.store.setDispatchRetained(target.id, retained);
    this.emitChanged('worker:retained', updated.runId);
    return { dispatch: updated, retained };
  }

  private async confirmWorkerPaneClosed(ptyId: string): Promise<void> {
    try {
      if (!this.closeWorkerPty) {
        if (!this.isPaneAlive(ptyId)) return;
        throw new Error('Terminal termination is unavailable');
      }
      const result = await this.closeWorkerPty(ptyId);
      if (result === false) throw new Error('Terminal termination could not be confirmed');
      if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
        throw new Error('error' in result && typeof result.error === 'string'
          ? result.error
          : 'Terminal termination could not be confirmed');
      }
    } catch (error) {
      throw new OrchestrationError(
        'operation_rejected',
        `Could not close worker terminal ${ptyId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  private async rollbackWorkerResources(ptyId?: string, worktreePath?: string | null): Promise<boolean> {
    if (ptyId) {
      try {
        await this.confirmWorkerPaneClosed(ptyId);
      } catch (error) {
        console.warn('[orchestration] worker launch cleanup could not confirm terminal closure:', error);
        return false;
      }
    }
    if (worktreePath) {
      try {
        await removeOwnedWorkerWorktree({ worktreePath });
      } catch (error) {
        console.warn('[orchestration] worker launch cleanup retained its worktree:', error);
      }
    }
    return true;
  }

  private async mutateWorkerResources<T>(
    dispatch: OrchestrationDispatchRecord,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const lineage = new Set([dispatch.id]);
    let root = dispatch;
    while (root.followUpOfDispatchId && !lineage.has(root.followUpOfDispatchId)) {
      const parent = this.store.getDispatchContext(root.followUpOfDispatchId);
      if (!parent) break;
      root = parent;
      lineage.add(root.id);
    }
    if (this.workerMutations.has(root.id)) {
      throw new OrchestrationError('operation_rejected', 'Another operation is updating this worker. Retry after it finishes.');
    }
    this.workerMutations.add(root.id);
    try {
      return await mutation();
    } finally {
      this.workerMutations.delete(root.id);
    }
  }

  async workerRelease(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    keepPane?: boolean;
    keepWorktree?: boolean;
    force?: boolean;
  }): Promise<{
    dispatch: OrchestrationDispatchRecord;
    closedPane: boolean;
    removedWorktree: boolean;
  }> {
    const rawTarget = this.resolveTargetDispatch(input);
    const dispatch = this.store.resolveDispatchLineage(rawTarget.id) ?? rawTarget;
    return this.mutateWorkerResources(dispatch, () => this.releaseWorker(dispatch, input));
  }

  private async releaseWorker(
    dispatch: OrchestrationDispatchRecord,
    input: Parameters<OrchestrationService['workerRelease']>[0],
  ) {
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      throw new OrchestrationError(
        'operation_rejected',
        `Worker dispatch ${dispatch.id} is still active (${dispatch.status}). Call worker-stop to abort an active worker or wait for it to finish.`
      );
    }
    if (dispatch.releasedAt) {
      return { dispatch, closedPane: false, removedWorktree: false };
    }

    if (!input.force && this.store.hasUnreadReportFromDispatch(dispatch.id)) {
      throw new OrchestrationError(
        'operation_rejected',
        `Unread worker report mail remains from ${dispatch.id}. Run \`${this.cliCommand} orchestration check\` before releasing, or pass --force.`
      );
    }

    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    if (paneId && this.terminalTracker) {
      const transcript = this.terminalTracker.readFullTranscript(paneId);
      if (transcript) {
        this.store.archiveDispatchOutput(dispatch.id, transcript);
      }
    }

    const repoRootPath =
      (dispatch.parentPaneId
        ? this.terminalTracker?.getTerminal(dispatch.parentPaneId)?.cwd
        : undefined) ??
      this.getDefaultCwd?.() ??
      null;

    let closedPane = false;
    const shouldClosePane =
      Boolean(dispatch.ownsPane) &&
      Boolean(paneId) &&
      !input.keepPane &&
      (!dispatch.retained || Boolean(input.force));
    // A pane explicitly kept open continues to use its worktree.
    const worktreeToRemove = dispatch.ownsWorktree && !input.keepWorktree &&
      (shouldClosePane || !this.isPaneAlive(paneId)) ? dispatch.worktreePath : null;
    if (worktreeToRemove && !input.force) await assertWorkerWorktreeClean(worktreeToRemove);

    if (shouldClosePane && paneId) {
      await this.confirmWorkerPaneClosed(paneId);
      this.spawnedWorkerPanes.delete(paneId);
      this.spawnedWorkerMeta.delete(paneId);
      this.markPtyExited(paneId);
      closedPane = true;
      this.emitPaneClosed({
        ptyId: paneId,
        runId: dispatch.runId,
        taskId: dispatch.taskId,
        dispatchId: dispatch.id,
      });
    }

    let removedWorktree = false;
    if (worktreeToRemove) {
      const res = await removeOwnedWorkerWorktree({
        worktreePath: worktreeToRemove,
        repoRootPath,
        force: input.force,
      });
      removedWorktree = res.removed;
    }

    const released = this.store.markDispatchReleased(dispatch.id, {
      keepPane: !closedPane,
      keepWorktree: !removedWorktree,
    });
    this.emitChanged('worker:released', released.runId);
    return { dispatch: released, closedPane, removedWorktree };
  }

  async workerStop(
    input: {
      dispatchId?: string;
      worker?: string;
      taskId?: string;
      reason?: string;
      removeWorktree?: boolean;
      force?: boolean;
    },
    visitedDispatchIds = new Set<string>()
  ): Promise<{
    dispatch: OrchestrationDispatchRecord;
    closedPane: boolean;
    removedWorktree: boolean;
    stoppedHelperIds: string[];
  }> {
    const rawTarget = this.resolveTargetDispatch(input);
    const dispatch = this.store.resolveDispatchLineage(rawTarget.id) ?? rawTarget;
    return this.mutateWorkerResources(dispatch, () => this.stopWorker(dispatch, input, visitedDispatchIds));
  }

  private async stopWorker(
    dispatch: OrchestrationDispatchRecord,
    input: Parameters<OrchestrationService['workerStop']>[0],
    visitedDispatchIds: Set<string>,
  ) {
    if (input.removeWorktree && dispatch.ownsWorktree && dispatch.worktreePath && !input.force) {
      await assertWorkerWorktreeClean(dispatch.worktreePath);
    }
    visitedDispatchIds.add(dispatch.id);
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;

    const lineageIds = new Set<string>([dispatch.id]);
    let prevId = dispatch.followUpOfDispatchId ?? null;
    while (prevId && !lineageIds.has(prevId)) {
      lineageIds.add(prevId);
      prevId = this.store.getDispatchContext(prevId)?.followUpOfDispatchId ?? null;
    }

    const stoppedHelperIds: string[] = [];
    const childSeedDispatches = this.store
      .listDispatches({ runId: dispatch.runId })
      .filter((child) => Boolean(child.creatorDispatchId && lineageIds.has(child.creatorDispatchId)));

    for (const seed of childSeedDispatches) {
      const child = this.store.resolveDispatchLineage(seed.id) ?? seed;
      if (visitedDispatchIds.has(child.id) || child.releasedAt) continue;
      if (child.retained && !input.force) continue;
      if (!ACTIVE_DISPATCH_STATUSES.has(child.status) && !child.ownsPane) continue;
      const childStopped = await this.workerStop(
        {
          dispatchId: child.id,
          reason: input.reason?.trim() || `Parent worker ${dispatch.id} stopped`,
          removeWorktree: input.removeWorktree,
          force: input.force,
        },
        visitedDispatchIds
      );
      stoppedHelperIds.push(child.id, ...childStopped.stoppedHelperIds);
    }

    const shouldClosePane = Boolean(paneId && (dispatch.ownsPane || input.force));
    if (shouldClosePane) await this.confirmWorkerPaneClosed(paneId);

    this.approvals.cancelForDispatch(dispatch.id, input.reason || 'Worker stopped');
    if (paneId) {
      this.turnStopMonitor.cancelForPane(paneId);
      if (this.terminalTracker) {
        const transcript = this.terminalTracker.readFullTranscript(paneId);
        if (transcript) {
          this.store.archiveDispatchOutput(dispatch.id, transcript);
        }
      }
    }

    let settled = dispatch;
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      this.store.deleteDeferredDispatchPrompt(dispatch.id);
      this.waiters.cancel(`dispatch:${dispatch.id}`);
      this.waiters.notifyPrefix(`question:${dispatch.id}:`, 'status');
      settled = this.store.failDispatch(dispatch.id, 'worker_stopped', {
        forceFailTask: true,
        summary: input.reason?.trim() || 'Worker stopped by coordinator',
      });
    } else {
      this.store.updateDispatchStage(dispatch.id, 'stopped');
      settled = this.store.getDispatchContext(dispatch.id) ?? settled;
    }

    let closedPane = false;
    if (shouldClosePane) {
      this.spawnedWorkerPanes.delete(paneId);
      this.spawnedWorkerMeta.delete(paneId);
      this.markPtyExited(paneId);
      closedPane = true;
      this.emitPaneClosed({
        ptyId: paneId,
        runId: dispatch.runId,
        taskId: dispatch.taskId,
        dispatchId: dispatch.id,
      });
    }

    const repoRootPath =
      (dispatch.parentPaneId
        ? this.terminalTracker?.getTerminal(dispatch.parentPaneId)?.cwd
        : undefined) ??
      this.getDefaultCwd?.() ??
      null;

    let removedWorktree = false;
    if (input.removeWorktree && dispatch.ownsWorktree && dispatch.worktreePath) {
      const res = await removeOwnedWorkerWorktree({
        worktreePath: dispatch.worktreePath,
        repoRootPath,
        force: input.force,
      });
      removedWorktree = res.removed;
    }

    this.emitChanged('worker:stopped', settled.runId);
    return {
      dispatch: this.store.getDispatchContext(settled.id) ?? settled,
      closedPane,
      removedWorktree,
      stoppedHelperIds,
    };
  }

  workerAbandon(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    reason?: string;
  }): {
    dispatch: OrchestrationDispatchRecord;
    task: OrchestrationTaskRecord;
    warning: string;
  } {
    const rawTarget = this.resolveTargetDispatch(input);
    const dispatch = this.store.resolveDispatchLineage(rawTarget.id) ?? rawTarget;
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;

    this.approvals.cancelForDispatch(dispatch.id, input.reason || 'Worker abandoned');
    if (paneId) {
      this.turnStopMonitor.cancelForPane(paneId);
      if (this.terminalTracker) {
        const transcript = this.terminalTracker.readFullTranscript(paneId);
        if (transcript) {
          this.store.archiveDispatchOutput(dispatch.id, transcript);
        }
      }
    }

    let settled = dispatch;
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      this.store.deleteDeferredDispatchPrompt(dispatch.id);
      this.waiters.cancel(`dispatch:${dispatch.id}`);
      this.waiters.notifyPrefix(`question:${dispatch.id}:`, 'status');
      settled = this.store.failDispatch(dispatch.id, 'abandoned', {
        forceFailTask: true,
        summary: input.reason?.trim() || 'Worker dispatch abandoned by coordinator',
      });
    }
    const warning =
      'Dispatch abandoned in orchestration state without killing any external process; use worker-stop to terminate the PTY.';
    this.emitChanged('worker:abandoned', settled.runId);
    return {
      dispatch: this.store.getDispatchContext(settled.id) ?? settled,
      task: this.store.requireTask(settled.taskId),
      warning,
    };
  }

  reset(input: {
    all?: boolean;
    tasks?: boolean;
    messages?: boolean;
  }): ReturnType<OrchestrationStore['reset']> {
    const scopes = [
      input.all ? ('all' as const) : null,
      input.tasks ? ('tasks' as const) : null,
      input.messages ? ('messages' as const) : null,
    ].filter((s): s is 'all' | 'tasks' | 'messages' => s !== null);
    if (scopes.length !== 1) {
      throw new OrchestrationError(
        'invalid_argument',
        'Choose exactly one reset scope: --all, --tasks, or --messages.'
      );
    }
    const scope = scopes[0]!;
    if (scope === 'all' || scope === 'tasks') {
      if (this.activeCoordinator) {
        try {
          this.activeCoordinator.coordinator.stop();
        } catch {
          /* ignore */
        }
        this.activeCoordinator = null;
      }
      for (const d of this.store.listDispatches()) {
        this.approvals.cancelForDispatch(d.id, 'Orchestration state reset');
        const pty = d.assigneePaneId ?? d.assigneeHandle;
        if (pty) this.turnStopMonitor.cancelForPane(pty);
      }
      this.inFlightObservationDispatches.clear();
    }
    if (scope === 'all' || scope === 'messages') {
      this.waiters.dispose();
    }
    const res = this.store.reset(scope);
    this.emitChanged(`orchestration:reset-${scope}`);
    return res;
  }

  approve(input: {
    id: string;
    dispatchId?: string;
    from?: string;
    reason?: string;
    updatedInput?: Record<string, unknown>;
  }, callerPaneId?: string): { approval: WorkerApprovalPayload } {
    return this.approvals.approve(input, callerPaneId);
  }

  deny(input: {
    id: string;
    dispatchId?: string;
    from?: string;
    reason?: string;
  }, callerPaneId?: string): { approval: WorkerApprovalPayload } {
    return this.approvals.deny(input, callerPaneId);
  }

  handlePermissionHookRequest(
    input: PermissionHookInterceptInput
  ): Promise<{ held: false } | { held: true; hookStdout?: string }> {
    return this.approvals.maybeHoldHookRequest(input);
  }

  // ==================== Snapshot & Agent Text Views ====================

  getSnapshot(runId?: string): OrchestrationSnapshot {
    const base = this.store.getSnapshot(runId);
    return {
      ...base,
      openApprovals: this.approvals.listOpenApprovals(runId ? { runId } : undefined),
    };
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

    if (action === 'inbox') {
      const messages = Array.isArray(record.messages)
        ? (record.messages as OrchestrationExposedMessage[])
        : [];
      const count = typeof record.count === 'number' ? record.count : messages.length;
      const mailbox = typeof record.mailbox === 'string' ? record.mailbox : '';
      const header = formatAgentFieldsText(
        [
          ['Mailbox', mailbox],
          ['Messages', String(count)],
        ],
        count > 0 ? 'Inbox history (read-only).' : 'Inbox is empty.'
      );
      if (messages.length === 0) return header;
      const banners = messages
        .map((m) =>
          formatMessageBanner(
            {
              ...m,
              seq: 0,
              read: true,
            },
            { cliCommand: this.cliCommand, followUp: m.followUp }
          )
        )
        .join('\n\n');
      return `${header}\n\n${banners}`;
    }

    if (action === 'send') {
      const msg = record.message as OrchestrationExposedMessage | undefined;
      const followUp = record.followUp as
        | {
            previousDispatchId?: string;
            dispatch?: OrchestrationDispatchRecord;
            task?: OrchestrationTaskRecord;
            reusedPane?: boolean;
          }
        | undefined;
      return formatAgentFieldsText(
        [
          ['Message', msg?.id],
          ['From', msg?.fromHandle],
          ['To', msg?.toHandle],
          ['Type', msg?.type],
          ['Run', msg?.runId],
          ['ReactivatedDispatch', followUp?.dispatch?.id],
          ['ReactivatedTask', followUp?.task?.id],
          ['ReusedPane', followUp ? (followUp.reusedPane ? 'true' : 'false') : undefined],
        ],
        followUp
          ? `Settled worker ${followUp.previousDispatchId} reactivated as ${followUp.dispatch?.id}.`
          : 'Message sent.'
      );
    }

    if (action === 'worker-done' || action === 'task-done' || action === 'task-fail') {
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

    if (action === 'worker-start') {
      const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
      const task = record.task as OrchestrationTaskRecord | undefined;
      return formatAgentFieldsText(
        [
          ['Dispatch', dispatch?.id],
          ['Worker', typeof record.ptyId === 'string' ? record.ptyId : dispatch?.assigneePaneId],
          ['Task', task?.id],
          ['Run', dispatch?.runId],
          ['Agent', typeof record.cliId === 'string' ? record.cliId : dispatch?.cliId],
          ['Model', typeof record.model === 'string' ? record.model : dispatch?.model],
          ['Effort', typeof record.effort === 'string' ? record.effort : dispatch?.effort],
          ['Worktree', typeof record.worktreePath === 'string' ? record.worktreePath : null],
          ['Branch', typeof record.branch === 'string' ? record.branch : null],
          ['OwnsWorktree', record.ownsWorktree ? 'true' : 'false'],
        ],
        `Worker started. Wait for updates with: ${this.cliCommand} orchestration check --wait`
      );
    }

    if (action === 'worker-show') {
      const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
      const task = record.task as OrchestrationTaskRecord | null | undefined;
      return formatAgentFieldsText(
        [
          ['Dispatch', dispatch?.id],
          ['Worker', dispatch?.assigneePaneId ?? dispatch?.assigneeHandle],
          ['Stage', typeof record.stage === 'string' ? record.stage : dispatch?.stage],
          ['Status', dispatch?.status],
          ['PaneAlive', record.paneAlive ? 'true' : 'false'],
          ['Task', task?.id],
          ['Agent', dispatch?.cliId],
          ['Model', dispatch?.model],
          ['Effort', dispatch?.effort],
          ['Generation', String(dispatch?.processGeneration ?? 1)],
          ['Worktree', dispatch?.worktreePath],
          ['Branch', dispatch?.branch],
          ['FollowUpChild', typeof record.followUpChildDispatchId === 'string' ? record.followUpChildDispatchId : null],
        ],
        dispatch ? `Worker ${dispatch.id} (${String(record.stage ?? dispatch.status)}).` : 'Worker details.'
      );
    }

    if (action === 'worker-read') {
      const text = typeof record.text === 'string' ? record.text : '';
      const header = formatAgentFieldsText([
        ['Dispatch', typeof record.dispatchId === 'string' ? record.dispatchId : undefined],
        ['Terminal', typeof record.ptyId === 'string' ? record.ptyId : undefined],
        ['Mode', record.screen ? 'screen' : 'cursor'],
        ['Cursor', typeof record.cursor === 'number' ? String(record.cursor) : undefined],
        ['NextCursor', typeof record.nextCursor === 'number' ? String(record.nextCursor) : undefined],
        ['HasMore', record.hasMore ? 'true' : 'false'],
        ['Archived', record.archived ? 'true' : undefined],
      ]);
      return text ? `${header}\n\n${text}` : `${header}\n\n(empty)`;
    }

    if (action === 'worker-release' || action === 'worker-stop') {
      const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
      return formatAgentFieldsText(
        [
          ['Dispatch', dispatch?.id],
          ['Stage', dispatch?.stage],
          ['ClosedPane', record.closedPane ? 'true' : 'false'],
          ['RemovedWorktree', record.removedWorktree ? 'true' : 'false'],
        ],
        action === 'worker-release' ? 'Worker released.' : 'Worker stopped.'
      );
    }

    if (action === 'worker-abandon') {
      const dispatch = record.dispatch as OrchestrationDispatchRecord | undefined;
      return formatAgentFieldsText(
        [
          ['Dispatch', dispatch?.id],
          ['Status', dispatch?.status],
          ['Warning', typeof record.warning === 'string' ? record.warning : undefined],
        ],
        'Worker dispatch abandoned.'
      );
    }

    if (action === 'reset') {
      const removed = (record.removed ?? {}) as Record<string, unknown>;
      return formatAgentFieldsText(
        [
          ['Scope', typeof record.reset === 'string' ? record.reset : undefined],
          ['RemovedRuns', removed.runs !== undefined ? String(removed.runs) : undefined],
          ['RemovedTasks', removed.tasks !== undefined ? String(removed.tasks) : undefined],
          ['RemovedDispatches', removed.dispatches !== undefined ? String(removed.dispatches) : undefined],
          ['RemovedMessages', removed.messages !== undefined ? String(removed.messages) : undefined],
        ],
        'Orchestration state reset.'
      );
    }

    if (action === 'approve' || action === 'deny') {
      const approval = record.approval as WorkerApprovalPayload | undefined;
      return formatAgentFieldsText(
        [
          ['Approval', approval?.approvalId],
          ['Status', approval?.status],
          ['Dispatch', approval?.dispatchId],
          ['Tool', approval?.toolName],
          ['Reason', approval?.reason ?? null],
        ],
        action === 'approve' ? 'Permission approved.' : 'Permission denied.'
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
        const run = this.store.getRun(activeCoordRun.runId);
        if (run && run.status === 'active') {
          this.store.updateRunStatus(activeCoordRun.runId, 'stopped');
        }
      } catch {
        // ignore
      }
    }
    this.activeCoordinator = null;
    this.turnStopMonitor.dispose();
    this.approvals.dispose();
    this.pointerDelivery.stop();
    this.waiters.dispose();
    this.disposeStatusListener();
    this.disposeActivityListener();
    if (this.staleSweepTimer !== null) {
      clearInterval(this.staleSweepTimer);
      this.staleSweepTimer = null;
    }
    this.inFlightObservationDispatches.clear();
    this.spawnedWorkerPanes.clear();
    this.spawnedWorkerMeta.clear();
    this.paneClosedListeners.clear();
    this.store.close();
  }

  private flushDeferredPromptsForPane(ptyId: string): void {
    if (!this.isPaneAlive(ptyId)) {
      return;
    }
    for (const [dispatchId, deferred] of this.store.listDeferredDispatchPrompts()) {
      if (deferred.ptyId !== ptyId || this.inFlightObservationDispatches.has(dispatchId)) continue;
      const dispatch = this.store.getDispatchContext(dispatchId);
      if (
        !dispatch ||
        !ACTIVE_DISPATCH_STATUSES.has(dispatch.status) ||
        (dispatch.assigneePaneId !== ptyId && dispatch.assigneeHandle !== ptyId)
      ) {
        continue;
      }
      this.store.deleteDeferredDispatchPrompt(dispatchId);
      void this.store.waitForPendingWrite().then(() => {
        const latest = this.store.getDispatchContext(dispatchId);
        if (!latest || !ACTIVE_DISPATCH_STATUSES.has(latest.status)) return null;
        return this.deliverAndObserveDispatchTurn(dispatchId, deferred);
      })
        .then((res) => {
          if (!res) return;
          const latest = this.store.getDispatchContext(dispatchId);
          if (!latest || !ACTIVE_DISPATCH_STATUSES.has(latest.status)) {
            return;
          }
          if (!res.ok) {
            this.store.failDispatch(
              dispatchId,
              res.error ?? `Failed to deliver deferred dispatch prompt to ${ptyId}`
            );
            this.retireFinishedSpawnedWorkers(latest.runId);
            this.emitChanged('dispatch:failed', latest.runId);
            return;
          }
          if (res.promptDeferred) {
            return;
          }
          this.store.updateDispatchObservation(dispatchId, res.startObservation, {
            reason: res.observationReason ?? null,
            refreshHeartbeat:
              res.startObservation === 'observed' ||
              res.startObservation === 'queued' ||
              res.startObservation === 'permission',
            promptSent: true,
          });
          this.emitChanged(
            res.startObservation === 'unobserved' ? 'dispatch:unobserved' : 'dispatch:resumed',
            latest.runId
          );
        })
        .catch((error) => {
          console.warn(`[orchestration] deferred dispatch ${dispatchId} delivery failed:`, error);
        });
    }
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
        if (res.promptDeferred) {
          this.store.saveDeferredDispatchPrompt(dispatchId, {
            ptyId: opts.ptyId,
            prompt: opts.prompt,
            submit: opts.submit ?? true,
          });
          this.store.updateDispatchObservation(dispatchId, 'permission', {
            reason: res.observationReason ?? null,
            refreshHeartbeat: true,
          });
        } else {
          // Record delivery and the queued baseline on the dispatch itself so both survive restarts.
          this.store.updateDispatchObservation(dispatchId, res.startObservation, {
            promptSent: true,
            ...(res.startObservation === 'queued'
              ? { queuedWorkingBaseline: baselineWorkingSequence }
              : {}),
          });
        }
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

  private isDispatchDeliberatelyWaiting(dispatch: OrchestrationDispatchRecord): boolean {
    if (this.approvals.hasOpenApprovalForDispatch(dispatch.id)) {
      return true;
    }
    const dispatchMailbox = `dispatch:${dispatch.id}`;
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    return (
      this.waiters.hasActiveWaiterFor(dispatchMailbox) ||
      (paneId ? this.waiters.hasActiveWaiterFor(paneId) : false) ||
      this.waiters.hasActiveWaiterFor(dispatch.assigneeHandle)
    );
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
        isDeliberatelyWaiting: (d) => this.isDispatchDeliberatelyWaiting(d),
        onEvent: (reason, id) => this.emitChanged(reason, id),
      });
      this.retireFinishedSpawnedWorkers(runId);
    }
  }
}
