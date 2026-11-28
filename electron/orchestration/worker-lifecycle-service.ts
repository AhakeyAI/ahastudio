import { randomUUID } from 'node:crypto';
import { runGitCommand } from '../git/git-exec.js';
import { driverCapabilities } from '../agent-drivers/driver-capabilities.js';
import type { AgentPaneStatus, AgentStatusStore } from '../agent/agent-status-store.js';
import type { TerminalReadResult, TerminalRuntimeTracker } from '../terminal-runtime-tracker.js';
import type {
  AgentGoalStatus,
  AgentSessionDriver,
  AgentSessionEvents,
  AgentSessionPolicy,
  AgentTurnResult,
} from './agent-session-driver.js';
import { AGENT_SESSION_ID } from './agent-session-manager.js';
import {
  HEADLESS_DRIVER_LABELS,
  HEADLESS_WORKER_ID,
  headlessWorkerControlsError,
  headlessWorkerDriver,
  headlessWorkerSupports,
  isHeadlessWorkerDriver,
  type HeadlessWorkerDriver,
} from './headless-workers.js';
import { WorkerNativeQuestionManager } from './worker-native-questions.js';
import { OrchestrationBoardService } from './board-service.js';
import { OrchestrationDelegationService } from './delegation-service.js';
import { OrchestrationIntegrationService } from './integration-service.js';
import { OrchestrationReviewService } from './review-service.js';
import { WorkerTimeline, type WorkerTimelineTurnStatus } from './worker-timeline.js';
import { RuntimeMessageWaiters } from './mailbox-waiters.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import { exposeMessage } from './orchestration-messaging.js';
import { OrchestrationStore } from './orchestration-store.js';
import {
  OrchestrationError,
  type OrchestrationDispatchRecord,
  type OrchestrationDispatchStage,
  type OrchestrationMessagePriority,
  type OrchestrationMessageRecord,
  type OrchestrationMessageType,
  type OrchestrationRunRecord,
  type OrchestrationTaskContext,
  type OrchestrationTaskKind,
  type OrchestrationTaskRecord,
} from './orchestration-types.js';
import { formatBoardPostForAgent, boardLookupCommands } from './board-protocol.js';
import { PermissionApprovalManager } from './permission-approvals.js';
import type { BuildDispatchPreambleInput } from './worker-dispatch-preamble.js';
import { mergeTaskContext, normalizeTaskContext } from './worker-brief-context.js';
import { normalizeWorkerCliId, resolveWorkerLaunchConfig } from './worker-launch-catalog.js';
import { WorkerTurnStopMonitor } from './worker-turn-stops.js';
import {
  buildAdversarialReviewTask,
  buildRunAdversarialReviewTask,
  MAX_ADVERSARIAL_REVIEW_ROUNDS,
} from './adversarial-review.js';
import {
  captureWorkerSnapshotOid,
  createDetachedReviewWorktree,
  inspectCommitRangeDiff,
  inspectWorkerDiff,
  isSameGitRepo,
  removeDetachedReviewWorktree,
  resolveBranchRefOid,
  resolveMainRepoRoot,
} from './worker-git-integration.js';
import {
  assertWorkerWorktreeClean,
  prepareWorkerWorktreePlacement,
  removeOwnedWorkerWorktree,
  WORKER_BRANCH_PREFIX,
} from './worker-worktree-placement.js';
import type { DeliverAndObserveAgentTurnResult } from './turn-start-observation.js';
import type {
  OrchestrationPaneSpawnedEvent,
  OrchestrationPaneClosedEvent,
  OrchestrationSendResult,
  OrchestrationWorkerSummary,
  OrchestrationSessionCoordinators,
  HeadlessWorkerControls,
  OrchestrationServiceDependencies,
  SettledWorkerFollowUpInput,
  OrchestrationService,
} from './orchestration-service.js';

/** Service capabilities the OrchestrationWorkerLifecycleService relies on; supplied by OrchestrationService. */
export interface OrchestrationWorkerLifecycleHost {
  readonly agentStatusStore: AgentStatusStore;
  readonly approvals: PermissionApprovalManager;
  readonly archiveWorkerTimeline: (workerId: string, dispatchId: string | null | undefined) => void;
  readonly assertCanDelegateFrom: (callerPaneId: string) => void;
  readonly assertWorkerStartControls: (
    input: {
      reviewOf?: string; reviewRun?: boolean | string; readOnly?: boolean;
      policy?: AgentSessionPolicy; network?: boolean; allowSubWorkers?: boolean; userInitiated?: boolean;
    },
    from: string,
  ) => void;
  readonly authorizeRunAccess: OrchestrationService['authorizeRunAccess'];
  readonly board: OrchestrationBoardService;
  readonly buildWorkerDispatchBrief: (input: BuildDispatchPreambleInput) => string;
  readonly canHeadlessWorkerDelegate: OrchestrationService['canHeadlessWorkerDelegate'];
  readonly cliCommand: string;
  readonly closeWorkerPty: OrchestrationServiceDependencies['closeWorkerPty'] | undefined;
  readonly codexPilot: OrchestrationServiceDependencies['codexPilot'] | undefined;
  readonly createWorkerTimeline: (
    workerId: string, cliId: HeadlessWorkerDriver, model: string | null,
    controls: { policy: AgentSessionPolicy; network: boolean }, redact: (text: string) => string,
  ) => WorkerTimeline;
  readonly delegation: OrchestrationDelegationService;
  readonly deliverAndObserveDispatchTurn: (dispatchId: string | null, opts: { ptyId: string; prompt: string; submit?: boolean; }) => Promise<DeliverAndObserveAgentTurnResult>;
  readonly disposed: boolean;
  readonly emitChanged: (reason: string, runId?: string) => void;
  readonly emitPaneClosed: (event: OrchestrationPaneClosedEvent) => void;
  readonly emitPaneSpawned: (event: OrchestrationPaneSpawnedEvent) => void;
  readonly exitedPanes: Set<string>;
  readonly failTaskIfReady: (taskId: string) => void;
  readonly getDefaultCwd: (() => string | undefined) | undefined;
  readonly headlessWorkers: OrchestrationServiceDependencies['headlessWorkers'] | undefined;
  readonly inferRunIdOptional: (from?: string) => string | undefined;
  readonly integration: OrchestrationIntegrationService;
  readonly isActiveSessionCoordinator: (id: string) => boolean;
  readonly isMcpEnabledForCliDep: ((cliId: string) => boolean) | undefined;
  readonly isPaneAlive: OrchestrationService['isPaneAlive'];
  readonly listCodingAgents: OrchestrationService['listCodingAgents'];
  readonly listCodingAgentsDep: OrchestrationServiceDependencies['listCodingAgents'] | undefined;
  readonly markPtyExited: OrchestrationService['markPtyExited'];
  readonly maxDepth: number;
  readonly nativeQuestions: WorkerNativeQuestionManager;
  readonly notifyTargetAndAliases: (toHandle: string, messageType: OrchestrationMessageType, message?: OrchestrationMessageRecord) => void;
  readonly paneMismatch: (id: string, cwd?: string | null, cliId?: string | null) => string | null;
  readonly redactTaskContext: (context: OrchestrationTaskContext | null) => OrchestrationTaskContext | null;
  readonly resolveActiveParentMailbox: (dispatch: OrchestrationDispatchRecord) => string;
  readonly resolveCallerDepth: (callerPaneId: string) => number;
  readonly retiringPanes: Set<string>;
  readonly review: OrchestrationReviewService;
  readonly runCreate: OrchestrationService['runCreate'];
  readonly sessionCoordinator: (id: string) => ReturnType<OrchestrationSessionCoordinators["get"]>;
  readonly spawnWorkerPty: OrchestrationServiceDependencies['spawnWorkerPty'] | undefined;
  readonly spawnedWorkerMeta: Map<string, { runId: string; taskId: string; }>;
  readonly spawnedWorkerPanes: Set<string>;
  readonly store: OrchestrationStore;
  readonly terminalTracker: TerminalRuntimeTracker | undefined;
  readonly turnStopMonitor: WorkerTurnStopMonitor;
  readonly verifyCodeInputs: (task: OrchestrationTaskRecord, cwd?: string | null) => Promise<void>;
  readonly waiters: RuntimeMessageWaiters;
  readonly workerTimelines: Map<string, WorkerTimeline>;
}

/** Worker start, follow-up, stop, release and abandon, plus the headless Worker session bridge. */
export class OrchestrationWorkerLifecycleService {
  constructor(private readonly host: OrchestrationWorkerLifecycleHost) {}

  readonly codexWorkers = new Map<string, AgentSessionDriver>();
  private readonly workerGoalLimits = new Map<string, Extract<AgentGoalStatus, 'usageLimited' | 'budgetLimited'>>();
  /** Live per-Worker controls; the next turn of that Worker runs with them. */
  private readonly codexWorkerControls = new Map<string, HeadlessWorkerControls>();
  private readonly pendingCodexTurnDiffs = new Set<Promise<void>>();
  readonly codexSubmitting = new Set<string>();
  /** Pending wake-ups per headless Worker; `opaque` means at least one wake carried no message record. */
  private readonly codexMailbox = new Map<string, { messages: OrchestrationMessageRecord[]; opaque: boolean }>();
  private readonly workerMutations = new Set<string>();

  getWorkerGoalLimit(workerId: string) {
    return this.workerGoalLimits.get(workerId);
  }

  async workerInterrupt(input: { dispatchId?: string; worker?: string; taskId?: string }): Promise<{
    dispatch: OrchestrationDispatchRecord; interrupted: boolean;
  }> {
    const dispatch = this.resolveTargetDispatch(input);
    const session = dispatch.executionMode === 'codex-app-server'
      ? this.codexWorkers.get(dispatch.assigneeHandle) : undefined;
    if (!session?.alive) {
      throw new OrchestrationError('dispatch_inactive', 'Only a live headless Worker turn can be interrupted.');
    }
    const interrupted = await session.interrupt();
    return { dispatch: this.host.store.getDispatchContext(dispatch.id) ?? dispatch, interrupted };
  }

  /**
   * Changes a live headless Worker's permission tier or network access from the next turn on. Only
   * the person calls this (IPC), so it may choose `full-auto`; the Worker's driver must support the
   * tier, network access needs a driver that sandboxes it, and review Workers stay locked.
   */
  workerUpdateControls(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    policy?: AgentSessionPolicy;
    network?: boolean;
  }): { dispatch: OrchestrationDispatchRecord; policy: AgentSessionPolicy; network: boolean } {
    if (input.policy === undefined && input.network === undefined) {
      throw new OrchestrationError('invalid_argument', 'Specify policy and/or network to update Worker controls.');
    }
    const target = this.resolveTargetDispatch(input);
    const dispatch = this.host.store.resolveDispatchLineage(target.id) ?? target;
    const driver = headlessWorkerDriver(dispatch.assigneeHandle);
    const session = dispatch.executionMode === 'codex-app-server' ? this.codexWorkers.get(dispatch.assigneeHandle) : undefined;
    if (!driver || !session?.alive || dispatch.releasedAt) {
      throw new OrchestrationError('dispatch_inactive', 'Only a live headless Worker can change its permission or network controls.');
    }
    if (session.busy || this.codexSubmitting.has(dispatch.id)) {
      throw new OrchestrationError('worker_busy', 'Wait for the current turn to finish before changing Worker controls.');
    }
    if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
      throw new OrchestrationError('operation_rejected', 'Review Workers stay read-only without network access.');
    }
    const unsupported = headlessWorkerControlsError(driver, input);
    if (unsupported) throw new OrchestrationError('operation_rejected', unsupported);
    const current = this.headlessControls(dispatch);
    const next: HeadlessWorkerControls = {
      ...current,
      policy: input.policy ?? current.policy,
      network: driverCapabilities(driver).network ? input.network ?? current.network : false,
    };
    this.codexWorkerControls.set(dispatch.assigneeHandle, next);
    const updated = this.host.store.updateDispatchWorkerControls(dispatch.id, {
      workerPolicy: next.policy, workerNetwork: next.network,
    }) ?? dispatch;
    this.host.workerTimelines.get(dispatch.assigneeHandle)?.setMeta({ policy: next.policy, network: next.network });
    this.host.emitChanged('worker:controls-updated', updated.runId);
    return { dispatch: updated, policy: next.policy, network: next.network };
  }

  /** A headless Worker's controls: live ones, else the dispatch record, else what legacy records imply. */
  private headlessControls(dispatch: OrchestrationDispatchRecord): HeadlessWorkerControls {
    const live = this.codexWorkerControls.get(dispatch.assigneeHandle);
    if (live) return live;
    const header = this.host.workerTimelines.get(dispatch.assigneeHandle)?.getHeader();
    return {
      policy: dispatch.workerPolicy ?? (header?.readOnly ? 'read-only' : 'workspace-write'),
      network: dispatch.workerNetwork ?? header?.network ?? false,
      allowSubWorkers: dispatch.allowSubWorkers === true,
    };
  }

  retireFinishedCodexWorkers(runId?: string): void {
    for (const [workerId, codex] of this.codexWorkers) {
      if (!codex.alive || !codex.latestTurnKey || this.host.store.getActiveDispatchForIdentity(workerId, null)) continue;
      const dispatch = this.host.store.getDispatchContext(codex.latestTurnKey);
      if (!dispatch || dispatch.retained || (runId && dispatch.runId !== runId)) continue;
      const run = this.host.store.getRun(dispatch.runId);
      if (run?.status === 'active') continue;
      this.archiveCodexOutput(codex, dispatch.id);
      this.host.archiveWorkerTimeline(workerId, dispatch.id);
      void codex.close(true);
    }
  }

  // ==================== Autonomous Worker Lifecycle (Phases 7–9) ====================

  deriveLiveStage(dispatch: OrchestrationDispatchRecord): OrchestrationDispatchStage {
    if (dispatch.releasedAt) return 'released';
    if (dispatch.status === 'completed') return 'done';
    if (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') {
      return dispatch.lastFailureReason === 'worker_stopped' ? 'stopped' : 'failed';
    }
    if (dispatch.stage === 'needs_reconciliation') return dispatch.stage;
    if (this.host.approvals.hasOpenApprovalForDispatch(dispatch.id)) {
      return 'waiting_permission';
    }
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const status = this.host.agentStatusStore.get(paneId);
    if (status?.state === 'waiting') {
      return status.waitKind === 'permission' ? 'waiting_permission' : 'waiting_input';
    }
    if (
      this.host.nativeQuestions.hasOpenQuestionForDispatch(dispatch.id) ||
      this.host.store.listQuestions({ dispatchId: dispatch.id, status: 'pending' }).length > 0
    ) {
      return 'waiting_input';
    }
    if (dispatch.executionMode === 'codex-app-server') return dispatch.stage ?? 'starting';
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

  resolveTargetDispatch(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
  }): OrchestrationDispatchRecord {
    if (input.dispatchId?.trim()) {
      const clean = input.dispatchId.trim().startsWith('dispatch:')
        ? input.dispatchId.trim().slice('dispatch:'.length)
        : input.dispatchId.trim();
      const ctx = this.host.store.getDispatchContext(clean);
      if (!ctx) {
        throw new OrchestrationError('dispatch_not_found', `Dispatch not found: ${clean}`);
      }
      return ctx;
    }
    if (input.taskId?.trim()) {
      const latest = this.host.store.getLatestDispatchForTask(input.taskId.trim());
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
        const ctx = this.host.store.getDispatchContext(target.slice('dispatch:'.length));
        if (ctx) return ctx;
      }
      const active = this.host.store.getActiveDispatchForIdentity(target, target);
      if (active) return active;
      const allMatching = this.host.store
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

  toWorkerSummary(dispatch: OrchestrationDispatchRecord): OrchestrationWorkerSummary {
    const task = this.host.store.getTask(dispatch.taskId) ?? null;
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const paneAlive = paneId ? this.host.isPaneAlive(paneId) : false;
    const agentStatus = paneId ? this.host.agentStatusStore.get(paneId) : null;
    const stage = this.deriveLiveStage(dispatch);
    const followUpChild = this.host.store.getFollowUpChildDispatch(dispatch.id);
    const openApprovals = this.host.approvals.listOpenApprovals({ dispatchId: dispatch.id });
    const openQuestions = this.host.store.listQuestions({
      dispatchId: dispatch.id,
      status: 'pending',
    });
    const openNativeQuestions = this.host.nativeQuestions.listOpenQuestions({ dispatchId: dispatch.id });
    const terminal = dispatch.executionMode !== 'codex-app-server' && paneId
      ? this.host.terminalTracker?.getTerminal(paneId) ?? null : null;
    return {
      dispatch: { ...dispatch, stage },
      task,
      paneAlive,
      agentStatus,
      stage,
      followUpChildDispatchId: followUpChild?.id ?? null,
      openApprovals,
      openQuestions,
      openNativeQuestions,
      terminal,
    };
  }

  async workerStart(input: {
    from?: string;
    callerPaneId?: string;
    runId?: string;
    taskId?: string;
    spec?: string;
    taskContext?: OrchestrationTaskContext | null;
    context?: string;
    background?: string;
    constraints?: string[];
    files?: string[];
    acceptance?: string;
    taskTitle?: string;
    displayName?: string;
    deps?: string[];
    codeDeps?: string[];
    priority?: OrchestrationMessagePriority;
    retryOfDispatchId?: string;
    reviewOf?: string;
    reviewRun?: boolean | string;
    reviewFocus?: string;
    readOnly?: boolean;
    taskKind?: OrchestrationTaskKind;
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
    mcpEnabled?: boolean;
    role?: string;
    /** Headless Worker controls; omitted ones follow the task (read-only tasks) and the Coordinator session. */
    policy?: AgentSessionPolicy;
    network?: boolean;
    allowSubWorkers?: boolean;
    /** Only the person (UI start, UI proposal approval) may start a full-auto Worker. */
    userInitiated?: boolean;
  }, queueClaim?: symbol): Promise<{
    dispatch: OrchestrationDispatchRecord;
    task: OrchestrationTaskRecord;
    run: OrchestrationRunRecord;
    ptyId: string | null;
    worktreePath: string | null;
    branch: string | null;
    ownsWorktree: boolean;
    ownsPane: boolean;
    cliId: string;
    model: string | null;
    effort: string | null;
    injected: boolean;
    briefBoardSeq?: number;
  }> {
    const from = input.from?.trim() || 'coordinator';
    if (HEADLESS_WORKER_ID.test(from) && !this.host.canHeadlessWorkerDelegate(from)) {
      throw new OrchestrationError('operation_rejected', 'Headless Workers cannot start other Workers.');
    }
    const callerDispatch = this.host.store.getActiveDispatchForIdentity(from, from);
    this.host.assertCanDelegateFrom(from);
    this.host.assertWorkerStartControls(input, from);
    this.host.store.assertDispatchCapacity();

    if (input.taskId && this.host.store.getTask(input.taskId)?.queuedLaunch && (!queueClaim || this.host.delegation.claimedLaunches.get(input.taskId) !== queueClaim)) throw new OrchestrationError('task_not_ready', '任务由已批准的队列管理。');
    const reusingTerminal = input.terminal?.trim() || undefined;
    const isReviewRunRequest =
      input.reviewRun === true ||
      (typeof input.reviewRun === 'string' && input.reviewRun.trim().length > 0);
    if (input.reviewOf?.trim() && isReviewRunRequest) {
      throw new OrchestrationError(
        'invalid_argument',
        'Cannot combine reviewOf and reviewRun in the same dispatch.',
      );
    }
    if (
      typeof input.reviewRun === 'string' &&
      input.reviewRun.trim() &&
      input.runId?.trim() &&
      input.reviewRun.trim() !== input.runId.trim()
    ) {
      throw new OrchestrationError(
        'invalid_argument',
        `Conflicting runId (${input.runId.trim()}) and reviewRun (${input.reviewRun.trim()}).`,
      );
    }
    if ((input.reviewOf?.trim() || isReviewRunRequest) && reusingTerminal) {
      throw new OrchestrationError(
        'operation_rejected',
        'Adversarial review cannot reuse an existing terminal. Spawn a fresh reviewer in an isolated detached worktree.',
      );
    }
    if (reusingTerminal && reusingTerminal === from) {
      throw new OrchestrationError(
        'terminal_is_coordinator',
        `Terminal ${reusingTerminal} is the caller's own terminal. Choose a different worker terminal.`
      );
    }
    if (reusingTerminal && AGENT_SESSION_ID.test(reusingTerminal)) {
      throw new OrchestrationError(
        'terminal_is_coordinator',
        `${reusingTerminal} is an Agent session, not a worker terminal.`
      );
    }
    if (reusingTerminal && (HEADLESS_WORKER_ID.test(reusingTerminal) || !this.host.isPaneAlive(reusingTerminal))) {
      throw new OrchestrationError(
        'terminal_unavailable',
        `Target terminal ${reusingTerminal} is not alive.`
      );
    }
    if (reusingTerminal) {
      const existingActive = this.host.store.getActiveDispatchForIdentity(reusingTerminal, reusingTerminal);
      if (existingActive) {
        throw new OrchestrationError(
          'worker_busy',
          `Terminal ${reusingTerminal} already holds active dispatch ${existingActive.id}.`
        );
      }
    }

    const callerStatus = this.host.agentStatusStore.get(from);
    const inferredCli =
      input.cliId?.trim() ||
      input.agent?.trim() ||
      (reusingTerminal ? this.host.agentStatusStore.get(reusingTerminal)?.agentId : undefined) ||
      callerDispatch?.cliId ||
      callerStatus?.agentId ||
      'claude';

    const launchConfig = resolveWorkerLaunchConfig({
      cliId: inferredCli,
      model: input.model,
      effort: input.effort,
      reusingTerminal: Boolean(reusingTerminal),
    });

    if (!reusingTerminal && !this.host.spawnWorkerPty) {
      throw new OrchestrationError(
        'terminal_unavailable',
        'Autonomous worker spawning is not configured on this OrchestrationService instance.'
      );
    }

    // Serialize concurrent adversarial review starts with per-Run integration locks and track
    // in-flight starts so an earlier peer's PASS cannot finalize or merge while a parallel peer is still booting.
    if (input.reviewOf?.trim()) {
      const targetPreview = this.host.delegation.resolveDispatchByRoleOrTarget(
        input.reviewOf.trim(),
        input.callerPaneId ?? from,
        input.runId,
      );
      return this.host.review.withInFlightReviewStart(`dispatch:${targetPreview.id}`, () =>
        this.host.integration.withRunIntegrationLock(targetPreview.runId, () =>
          this.host.review.withReviewStartLock(targetPreview.id, () =>
            this.executeWorkerStartCore(input, from, callerDispatch, callerStatus, reusingTerminal, launchConfig),
          ),
        ),
      );
    }
    if (isReviewRunRequest) {
      const explicitRunTarget =
        typeof input.reviewRun === 'string' ? input.reviewRun.trim() : input.runId;
      const runPreview = this.host.integration.resolveTargetRunForOperation(
        explicitRunTarget,
        input.callerPaneId,
        from,
      );
      // Share the per-Run integration lock so runFinalizeIntegration / workerIntegrate cannot
      // race ahead while a Run-level review terminal is booting and before runReviewStatus="pending" is persisted.
      return this.host.review.withInFlightReviewStart(`run:${runPreview.id}`, () =>
        this.host.integration.withRunIntegrationLock(runPreview.id, () =>
          this.executeWorkerStartCore(input, from, callerDispatch, callerStatus, reusingTerminal, launchConfig),
        ),
      );
    }
    if (input.retryOfDispatchId) {
      const previous = this.host.store.getDispatchContext(input.retryOfDispatchId);
      if (previous?.codexDeliveryFailure === 'unknown_acceptance') {
        return this.mutateWorkerResources(previous, () => {
          if (this.host.store.getLatestDispatchForTask(previous.taskId)?.id !== previous.id || previous.lastFailureReason !== 'worker_stopped') {
            throw new OrchestrationError('operation_rejected', '请先停止旧派发。每次待核对派发只能重试一次。');
          }
          return this.executeWorkerStartCore(input, from, callerDispatch, callerStatus, reusingTerminal, launchConfig);
        });
      }
    }
    return this.executeWorkerStartCore(input, from, callerDispatch, callerStatus, reusingTerminal, launchConfig);
  }

  private async executeWorkerStartCore(
    input: Parameters<OrchestrationService['workerStart']>[0],
    from: string,
    callerDispatch: OrchestrationDispatchRecord | undefined,
    callerStatus: AgentPaneStatus | null,
    reusingTerminal: string | undefined,
    launchConfig: ReturnType<typeof resolveWorkerLaunchConfig>,
  ): ReturnType<OrchestrationService['workerStart']> {
    // Resolve or create Run and Task.
    const normalizedInputContext = this.host.redactTaskContext(normalizeTaskContext(input));
    let task: OrchestrationTaskRecord;
    // Only a task made by this call may be failed when its worker never starts.
    let createdTask = false;
    let run: OrchestrationRunRecord;
    let reviewTarget: OrchestrationDispatchRecord | null = null;
    let reviewRunTarget: OrchestrationRunRecord | null = null;
    let reviewBatchId: string | null = null;
    let reviewSnapshotOid: string | null = null;
    let reviewBaseCommit: string | null = null;
    let reviewRunBaseCommit: string | null = null;
    let reviewDetachedWorktree: { worktreePath: string; mainRepoRoot: string } | null = null;
    let reviewRoundForTarget = 0;

    const isReviewRunRequest =
      input.reviewRun === true ||
      (typeof input.reviewRun === 'string' && input.reviewRun.trim().length > 0);

    if (input.reviewOf?.trim()) {
      const target = this.host.delegation.resolveDispatchByRoleOrTarget(
        input.reviewOf.trim(),
        input.callerPaneId ?? from,
        input.runId,
      );
      if (input.callerPaneId !== undefined) {
        this.host.authorizeRunAccess(target.runId, input.callerPaneId);
      }
      if (ACTIVE_DISPATCH_STATUSES.has(target.status)) {
        throw new OrchestrationError(
          'operation_rejected',
          `Target worker ${target.id} is still active (${target.status}). Wait for it to report done before starting an adversarial review.`,
        );
      }
      if (target.cliId && this.host.listCodingAgentsDep) {
        const authorCli = normalizeWorkerCliId(target.cliId);
        const reviewerCli = normalizeWorkerCliId(launchConfig.cliId);
        if (authorCli && reviewerCli === authorCli) {
          const available = this.host.listCodingAgents(from).filter((entry) => entry.available);
          const heterogeneous = available.filter((entry) => entry.cliId !== authorCli);
          if (heterogeneous.length > 0) {
            throw new OrchestrationError(
              'operation_rejected',
              `Heterogeneous review must avoid the author's Coding Agent (${authorCli}); available alternative(s): ${heterogeneous.map((e) => e.cliId).join(', ')}.`,
              { authorCliId: authorCli, requestedCliId: reviewerCli },
            );
          }
        }
      }
      reviewTarget = target;
      run = this.host.store.requireRun(target.runId);
      if (run.status !== 'active') {
        run = this.host.store.updateRunStatus(run.id, 'active');
      }
      const targetTask = this.host.store.requireTask(target.taskId);
      const targetPath = target.worktreePath ?? this.host.getDefaultCwd?.() ?? process.cwd();

      // Strictly require a clean, unambiguous Git snapshot (no staged/unstaged divergence)
      // and an isolated detached worktree; never fall back to the author's workspace.
      const snap = await captureWorkerSnapshotOid(targetPath, { rejectStagedDivergence: true });
      if (!snap.snapshotOid) {
        throw new OrchestrationError(
          'operation_rejected',
          `Adversarial review requires a valid Git snapshot for ${target.id}; cannot fall back to the author workspace.`,
        );
      }
      reviewSnapshotOid = snap.snapshotOid;

      const mainRepoRoot = await resolveMainRepoRoot(
        targetPath,
        target.repoRootPath ?? this.host.getDefaultCwd?.() ?? null,
      );
      if (!mainRepoRoot) {
        throw new OrchestrationError(
          'operation_rejected',
          `Could not resolve Git repository root for ${target.id}; isolated detached review worktree is required.`,
        );
      }

      const effectiveReviewBase = await this.host.integration.resolveEffectiveWorkerDiffBase(
        run,
        target,
        targetPath,
        mainRepoRoot,
        reviewSnapshotOid,
      );
      const diff = await inspectWorkerDiff({
        worktreePath: targetPath,
        baseCommit: effectiveReviewBase,
        maxDiffBytes: 16 * 1024,
        pinnedSnapshot: {
          headCommit: snap.headCommit,
          snapshotOid: snap.snapshotOid,
          dirtyFiles: snap.dirtyFiles,
          stagedDivergentFiles: snap.stagedDivergentFiles,
        },
      });
      reviewBaseCommit = diff.baseCommit ?? effectiveReviewBase ?? null;

      // Parallel L2 perspectives targeting the same snapshot join the current pending batch;
      // a new snapshot or a previously settled batch starts a brand new batch and bumps reviewRound.
      const canJoinCurrentBatch =
        Boolean(target.reviewBatchId) &&
        target.reviewStatus === 'pending' &&
        target.reviewSnapshotOid === reviewSnapshotOid &&
        (!target.reviewBaseCommit || !reviewBaseCommit || target.reviewBaseCommit === reviewBaseCommit) &&
        (target.reviewRound ?? 0) > 0;
      if (canJoinCurrentBatch) {
        reviewBatchId = target.reviewBatchId!;
        reviewRoundForTarget = target.reviewRound!;
      } else {
        reviewRoundForTarget = (target.reviewRound ?? 0) + 1;
        if (reviewRoundForTarget > MAX_ADVERSARIAL_REVIEW_ROUNDS) {
          if (target.reviewStatus === 'passed' && target.reviewSnapshotOid === reviewSnapshotOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Adversarial review limit reached (${MAX_ADVERSARIAL_REVIEW_ROUNDS} rounds) for ${target.id}, and this exact snapshot already passed. Integrate it instead of requesting another review.`,
              { targetDispatchId: target.id, maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS },
            );
          }
          this.host.store.updateDispatchReviewState(target.id, { reviewStatus: 'escalated' });
          throw new OrchestrationError(
            'operation_rejected',
            `Adversarial review limit reached (${MAX_ADVERSARIAL_REVIEW_ROUNDS} rounds) for ${target.id}. Escalate the remaining disagreement to the user.`,
            { targetDispatchId: target.id, maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS },
          );
        }
        reviewBatchId = `rbat_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      }

      const effectiveMcpForReview =
        input.mcpEnabled ?? this.host.isMcpEnabledForCliDep?.(launchConfig.cliId) ?? false;
      const targetRole = this.host.delegation.resolveRoleNameForDispatch(target) || target.id;
      const builtReview = buildAdversarialReviewTask({
        targetRole,
        targetDispatchId: target.id,
        targetTaskSpec: targetTask.spec,
        targetTaskContext: targetTask.taskContext,
        diff,
        reviewFocus: input.reviewFocus ?? (input.spec?.trim() || undefined),
        reviewRound: reviewRoundForTarget,
        maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS,
        mcpEnabled: effectiveMcpForReview,
        cliCommand: this.host.cliCommand,
      });
      // Do NOT merge arbitrary caller-provided context into adversarial review tasks (prevents
      // smuggling author summaries or weakening read-only constraints).
      const detached = await createDetachedReviewWorktree({
        mainRepoRoot,
        snapshotOid: reviewSnapshotOid,
        reviewSlug: `${targetRole}-r${reviewRoundForTarget}`,
      });
      reviewDetachedWorktree = { worktreePath: detached.worktreePath, mainRepoRoot };

      const reviewLabel = input.role?.trim() || input.displayName?.trim() || `review-${targetRole}`;
      createdTask = true;
      task = this.host.store.createTask({
        singleShot: true,
        runId: run.id,
        spec: builtReview.taskSpec,
        taskContext: builtReview.taskContext,
        taskTitle: input.taskTitle ?? `Adversarial review of @${targetRole}`,
        displayName: reviewLabel,
        priority: input.priority ?? 'high',
      });
    } else if (isReviewRunRequest) {
      const explicitRunTarget =
        typeof input.reviewRun === 'string' ? input.reviewRun.trim() : input.runId;
      let targetRun = this.host.integration.resolveTargetRunForOperation(
        explicitRunTarget,
        input.callerPaneId,
        from,
      );
      if (targetRun.status !== 'active') {
        targetRun = this.host.store.updateRunStatus(targetRun.id, 'active');
      }
      run = targetRun;
      reviewRunTarget = targetRun;

      const resolvedTarget = await this.host.integration.resolveRunCombinedDiffTarget(targetRun, {
        requireCleanIntegrationWorktree: true,
      });
      if (this.host.listCodingAgentsDep) {
        const integratedAuthorClis = new Set<string>(
          resolvedTarget.integratedWorkers
            .map((w) => (w.cliId ? normalizeWorkerCliId(w.cliId) : ''))
            .filter(Boolean),
        );
        const reviewerCli = normalizeWorkerCliId(launchConfig.cliId);
        if (integratedAuthorClis.has(reviewerCli)) {
          const available = this.host.listCodingAgents(from).filter((entry) => entry.available);
          const heterogeneous = available.filter((entry) => !integratedAuthorClis.has(entry.cliId));
          if (heterogeneous.length > 0) {
            throw new OrchestrationError(
              'operation_rejected',
              `Heterogeneous Run-level review must avoid integrated author Coding Agent(s) (${[...integratedAuthorClis].join(', ')}); available alternative(s): ${heterogeneous.map((e) => e.cliId).join(', ')}.`,
              { authorCliIds: [...integratedAuthorClis], requestedCliId: reviewerCli },
            );
          }
        }
      }
      if (!resolvedTarget.hasChanges || !resolvedTarget.mainRepoRoot || !resolvedTarget.baseCommit || !resolvedTarget.targetCommit) {
        throw new OrchestrationError(
          'operation_rejected',
          `No integrated changes found for run ${targetRun.id}. Integrate at least one worker before launching a Run-level adversarial review.`,
          { runId: targetRun.id },
        );
      }

      const combinedDiff = await inspectCommitRangeDiff({
        repoPath: resolvedTarget.repoPath ?? resolvedTarget.mainRepoRoot,
        baseCommit: resolvedTarget.baseCommit,
        targetCommit: resolvedTarget.targetCommit,
        branch: resolvedTarget.branch,
        maxDiffBytes: 16 * 1024,
      });
      if (combinedDiff.diffError || combinedDiff.changedFiles.length === 0) {
        throw new OrchestrationError(
          'operation_rejected',
          combinedDiff.diffError
            ? `Could not inspect combined Run diff for ${targetRun.id}: ${combinedDiff.diffError}`
            : `Combined Run diff for ${targetRun.id} has no file changes to review.`,
          { runId: targetRun.id },
        );
      }

      reviewSnapshotOid = resolvedTarget.targetCommit;
      reviewRunBaseCommit = resolvedTarget.baseCommit;

      const canJoinCurrentBatch =
        Boolean(targetRun.runReviewBatchId) &&
        targetRun.runReviewStatus === 'pending' &&
        targetRun.runReviewSnapshotOid === reviewSnapshotOid &&
        (targetRun.runReviewRound ?? 0) > 0;
      if (canJoinCurrentBatch) {
        reviewBatchId = targetRun.runReviewBatchId!;
        reviewRoundForTarget = targetRun.runReviewRound!;
      } else {
        const isFreshPostPassSnapshot =
          targetRun.runReviewStatus === 'passed' &&
          Boolean(targetRun.runReviewSnapshotOid) &&
          targetRun.runReviewSnapshotOid !== reviewSnapshotOid;
        reviewRoundForTarget = isFreshPostPassSnapshot ? 1 : (targetRun.runReviewRound ?? 0) + 1;
        if (reviewRoundForTarget > MAX_ADVERSARIAL_REVIEW_ROUNDS) {
          if (targetRun.runReviewStatus === 'passed' && targetRun.runReviewSnapshotOid === reviewSnapshotOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Run-level adversarial review limit reached (${MAX_ADVERSARIAL_REVIEW_ROUNDS} rounds) for ${targetRun.id}, and this exact snapshot already passed. Finalize it instead of requesting another review.`,
              { runId: targetRun.id, maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS },
            );
          }
          this.host.store.updateRunReviewState(targetRun.id, { runReviewStatus: 'escalated' });
          throw new OrchestrationError(
            'operation_rejected',
            `Run-level adversarial review limit reached (${MAX_ADVERSARIAL_REVIEW_ROUNDS} rounds) for ${targetRun.id}. Escalate the remaining disagreement to the user.`,
            { runId: targetRun.id, maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS },
          );
        }
        reviewBatchId = `rrbat_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      }

      const effectiveMcpForReview =
        input.mcpEnabled ?? this.host.isMcpEnabledForCliDep?.(launchConfig.cliId) ?? false;
      const builtRunReview = buildRunAdversarialReviewTask({
        runId: targetRun.id,
        runObjective: targetRun.objective,
        diff: combinedDiff,
        integratedWorkers: resolvedTarget.integratedWorkers,
        reviewFocus: input.reviewFocus ?? (input.spec?.trim() || undefined),
        reviewRound: reviewRoundForTarget,
        maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS,
        mcpEnabled: effectiveMcpForReview,
        cliCommand: this.host.cliCommand,
      });

      const detached = await createDetachedReviewWorktree({
        mainRepoRoot: resolvedTarget.mainRepoRoot,
        snapshotOid: reviewSnapshotOid,
        reviewSlug: `run-${targetRun.id}-r${reviewRoundForTarget}`,
      });
      reviewDetachedWorktree = {
        worktreePath: detached.worktreePath,
        mainRepoRoot: resolvedTarget.mainRepoRoot,
      };

      const reviewLabel = input.role?.trim() || input.displayName?.trim() || 'review-run';
      createdTask = true;
      task = this.host.store.createTask({
        singleShot: true,
        runId: run.id,
        spec: builtRunReview.taskSpec,
        taskContext: builtRunReview.taskContext,
        taskTitle: input.taskTitle ?? `Run-level adversarial review (${targetRun.id})`,
        displayName: reviewLabel,
        priority: input.priority ?? 'high',
      });
    } else if (input.retryOfDispatchId?.trim()) {
      const prior = this.host.store.getDispatchContext(input.retryOfDispatchId.trim());
      if (!prior) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Prior dispatch not found: ${input.retryOfDispatchId}`
        );
      }
      run = this.host.store.requireRun(prior.runId);
      if (input.callerPaneId !== undefined) this.host.board.resolveBoardCallerContext({ from: input.callerPaneId, runId: run.id });
      const priorTask = this.host.store.requireTask(prior.taskId);
      if (prior.codexDeliveryFailure === 'unknown_acceptance' && (ACTIVE_DISPATCH_STATUSES.has(prior.status) || this.codexWorkers.get(prior.assigneeHandle)?.alive)) {
        throw new OrchestrationError('operation_rejected', '请先核对结果并停止原执行者，再从已核实的基线重新派发。');
      }
      if (prior.codexDeliveryFailure === 'unknown_acceptance') {
        if (!prior.repoRootPath || !prior.baseCommit || input.terminal || input.noWorktree) {
          throw new OrchestrationError('operation_rejected', '无法确认独立工作树的基线，请先人工核对。');
        }
        input = { ...input, cwd: prior.repoRootPath, baseBranch: prior.baseCommit, worktree: true, branch: undefined,
          readOnly: prior.taskKind === 'research' || prior.taskKind === 'review', taskKind: prior.taskKind };
      }
      if (priorTask.status === 'completed') {
        const retryContext = mergeTaskContext(priorTask.taskContext, normalizedInputContext);
        createdTask = true;
        task = this.host.store.createTask({
          singleShot: true,
          runId: run.id,
          spec: input.spec?.trim() || priorTask.spec,
          ...(retryContext ? { taskContext: retryContext } : {}),
          taskTitle: input.taskTitle ?? `Retry: ${priorTask.taskTitle}`,
          displayName: input.displayName,
          priority: input.priority ?? priorTask.priority,
        });
      } else {
        task = this.host.store.requeueTaskForRetry(priorTask.id);
      }
    } else if (input.taskId?.trim()) {
      const existingTask = this.host.store.requireTask(input.taskId.trim());
      run = this.host.store.requireRun(existingTask.runId);
      if (input.callerPaneId !== undefined) this.host.board.resolveBoardCallerContext({ from: input.callerPaneId, runId: run.id });
      this.host.store.promoteReadyTasks(run.id);
      task = this.host.store.requireTask(existingTask.id);

    } else if (input.spec?.trim()) {
      const explicitRunId = input.runId?.trim();
      if (explicitRunId && input.callerPaneId !== undefined) {
        this.host.board.resolveBoardCallerContext({ from: input.callerPaneId, runId: explicitRunId });
      }
      let inferredRunId = explicitRunId || (input.callerPaneId === undefined
        ? this.host.inferRunIdOptional(from)
        : this.host.board.resolveBoardMemberForPane(from)?.runId);
      if (!explicitRunId && inferredRunId && !callerDispatch && from !== 'coordinator') {
        const candidateRun = this.host.store.getRun(inferredRunId);
        if (
          candidateRun?.coordinatorPaneId &&
          candidateRun.coordinatorPaneId !== from &&
          candidateRun.coordinatorHandle !== from
        ) {
          inferredRunId = undefined;
        }
      }
      if (inferredRunId) {
        run = this.host.store.requireRun(inferredRunId);
        if (run.status !== 'active') {
          run = this.host.store.updateRunStatus(run.id, 'active');
        }
      } else {
        const callerPane = callerStatus || this.host.isActiveSessionCoordinator(from) ? from : undefined;
        run = this.host.runCreate({
          objective: input.taskTitle?.trim() || input.spec.trim().slice(0, 120),
          from,
          paneId: callerPane,
        }).run;
      }
      createdTask = true;
      task = this.host.store.createTask({
        singleShot: true,
        runId: run.id,
        spec: input.spec.trim(),
        ...(normalizedInputContext ? { taskContext: normalizedInputContext } : {}),
        taskTitle: input.taskTitle,
        displayName: input.displayName,
        deps: input.deps,
      codeDeps: input.codeDeps,
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

    const parentPaneId = callerStatus || this.host.isActiveSessionCoordinator(from)
      ? from
      : (callerDispatch?.assigneePaneId ?? run.coordinatorPaneId ?? null);
    const parentTerminal = parentPaneId ? this.host.terminalTracker?.getTerminal(parentPaneId) : null;
    const baseCwd =
      input.cwd?.trim() ||
      task.worktreePath ||
      callerDispatch?.worktreePath ||
      input.callerCwd?.trim() ||
      parentTerminal?.cwd ||
      (parentPaneId ? this.host.sessionCoordinator(parentPaneId)?.cwd : undefined) ||
      this.host.getDefaultCwd?.() ||
      process.cwd();

    if (reusingTerminal) {
      const mismatch = this.host.paneMismatch(reusingTerminal, task.worktreePath ?? baseCwd, launchConfig.cliId);
      if (mismatch) {
        if (createdTask) this.host.failTaskIfReady(task.id);
        throw new OrchestrationError('terminal_unavailable', mismatch);
      }
    }
    const reusingTerminalCwd = reusingTerminal
      ? this.host.terminalTracker?.getTerminal(reusingTerminal)?.cwd
      : undefined;

    let effectiveBaseBranch = input.baseBranch;
    if (
      !reviewDetachedWorktree &&
      !effectiveBaseBranch?.trim() &&
      this.host.integration.isRunIntegrationBranchLive(run) &&
      run.integrationBranch &&
      run.integrationRepoRootPath
    ) {
      const [sameRepo, branchOid] = await Promise.all([
        isSameGitRepo(baseCwd, run.integrationRepoRootPath),
        resolveBranchRefOid(run.integrationRepoRootPath, run.integrationBranch),
      ]);
      if (sameRepo && branchOid) {
        effectiveBaseBranch = run.integrationBranch;
      }
    }

    const placement = reviewDetachedWorktree
      ? {
          cwd: reviewDetachedWorktree.worktreePath,
          worktreePath: reviewDetachedWorktree.worktreePath,
          branch: null,
          baseCommit: reviewRunBaseCommit ?? reviewBaseCommit ?? reviewTarget?.baseCommit ?? null,
          ownsWorktree: true,
          ownsBranch: false,
          repoRootPath: reviewDetachedWorktree.mainRepoRoot,
        }
      : await prepareWorkerWorktreePlacement({
          baseCwd: reviewTarget?.worktreePath ?? baseCwd,
          taskId: task.id,
          taskTitle: task.taskTitle,
          name: input.name,
          worktree: reviewTarget ? false : input.worktree,
          noWorktree: reviewTarget ? true : input.noWorktree,
          branch: input.branch,
          baseBranch: effectiveBaseBranch,
          reusingTerminalCwd,
        });

    try {
      await this.host.verifyCodeInputs(task, placement.cwd);
    } catch (error) {
      if (placement.ownsWorktree) await this.rollbackWorkerResources(undefined, placement.worktreePath);
      if (createdTask) this.host.failTaskIfReady(task.id);
      throw error;
    }
    // A run a session coordinates runs every non-reused task of a headless-capable driver as a
    // headless Worker, even when the Codex pilot setting is off; terminal-coordinated runs keep the
    // read-only Codex pilot gate. A driver that cannot enforce the task's policy keeps a terminal.
    const runIsSessionCoordinated =
      AGENT_SESSION_ID.test(run.coordinatorPaneId ?? '') || this.host.isActiveSessionCoordinator(from);
    const readOnlyTask = input.readOnly === true || input.policy === 'read-only' || Boolean(reviewTarget || reviewRunTarget);
    const workerPolicy: AgentSessionPolicy = readOnlyTask ? 'read-only' : input.policy ?? 'workspace-write';
    if (!reusingTerminal && runIsSessionCoordinated && isHeadlessWorkerDriver(launchConfig.cliId)) {
      // An explicit control the driver cannot enforce is refused; an implied read-only tier keeps a terminal.
      const unsupported = headlessWorkerControlsError(launchConfig.cliId, {
        ...(input.policy !== undefined ? { policy: input.policy } : {}),
        ...(input.network !== undefined ? { network: input.network } : {}),
      });
      if (unsupported) {
        if (placement.ownsWorktree && placement.worktreePath) await this.rollbackWorkerResources(undefined, placement.worktreePath);
        if (createdTask) this.host.failTaskIfReady(task.id);
        throw new OrchestrationError('operation_rejected', unsupported, { cliId: launchConfig.cliId });
      }
    }
    const headlessCli = !reusingTerminal && headlessWorkerSupports(launchConfig.cliId, workerPolicy)
      ? launchConfig.cliId as HeadlessWorkerDriver : null;
    const usePilot = headlessCli === 'codex'
      ? Boolean(this.host.codexPilot && (runIsSessionCoordinated || (readOnlyTask && this.host.codexPilot.enabled())))
      : Boolean(headlessCli && runIsSessionCoordinated && this.host.headlessWorkers &&
        this.host.headlessWorkers.available?.(headlessCli) !== false);
    const coordinatorSession =
      (run.coordinatorPaneId && this.host.isActiveSessionCoordinator(run.coordinatorPaneId)
        ? this.host.sessionCoordinator(run.coordinatorPaneId)
        : null) ??
      (this.host.isActiveSessionCoordinator(from) ? this.host.sessionCoordinator(from) : null);
    // Inherited network access is dropped on drivers that cannot sandbox it per turn.
    const workerNetwork = !reviewTarget && !reviewRunTarget && Boolean(headlessCli && driverCapabilities(headlessCli).network) &&
      (input.network ?? (runIsSessionCoordinated && Boolean(coordinatorSession?.network)));
    const allowSubWorkers = input.allowSubWorkers === true;
    const pilot = usePilot && headlessCli
      ? await this.openCodexWorker(headlessCli, placement.cwd ?? process.cwd(), launchConfig.model, {
          policy: workerPolicy,
          network: workerNetwork,
          allowSubWorkers,
        })
      : null;

    const spawnPane = async (): Promise<string> => {
      try {
        const spawned = await this.host.spawnWorkerPty!({
          runId: run.id,
          task,
          cliId: launchConfig.cliId,
          cwd: placement.cwd,
          extraArgs: usePilot && headlessCli === 'codex' && readOnlyTask
            ? [...launchConfig.extraArgs, '--sandbox', 'read-only', '--ask-for-approval', 'on-request']
            : launchConfig.extraArgs,
        });
        if (!spawned) {
          throw new OrchestrationError(
            'terminal_unavailable',
            `Failed to spawn worker terminal for CLI "${launchConfig.cliId}".`,
            { taskId: task.id, cliId: launchConfig.cliId }
          );
        }
        this.host.exitedPanes.delete(spawned.ptyId);
        return spawned.ptyId;
      } catch (err) {
        if (placement.ownsWorktree && placement.worktreePath) {
          await this.rollbackWorkerResources(undefined, placement.worktreePath);
        }
        if (createdTask) this.host.failTaskIfReady(task.id);
        if (err instanceof OrchestrationError) {
          if (err.code === 'terminal_unavailable' && !err.data?.taskId) {
            throw new OrchestrationError(err.code, err.message, {
              ...(err.data ?? {}),
              taskId: task.id,
              cliId: launchConfig.cliId,
            });
          }
          throw err;
        }
        throw new OrchestrationError(
          'terminal_unavailable',
          err instanceof Error ? err.message : String(err),
          { taskId: task.id, cliId: launchConfig.cliId }
        );
      }
    };

    let ptyId = pilot ? null : reusingTerminal ?? await spawnPane();
    let ownsPane = !pilot && !reusingTerminal;
    let ctx: OrchestrationDispatchRecord;
    try {
      ctx = this.host.store.createDispatchContext({
        approvedQueueLaunch: task.queuedLaunch?.state === 'claimed' && this.host.delegation.claimedLaunches.has(task.id),
        taskId: task.id,
        assigneeHandle: pilot?.id ?? ptyId!,
        assigneePaneId: ptyId,
        ...(pilot ? {
          providerSessionId: pilot.sessionId, workerPolicy, workerNetwork, allowSubWorkers,
        } : {}),
        creator: from,
        creatorRunId: run.id,
        creatorDispatchId: callerDispatch?.id ?? null,
        parentDepth: this.host.resolveCallerDepth(from),
        parentPaneId,
        worktreePath: placement.worktreePath,
        branch: placement.branch,
        baseCommit: placement.baseCommit,
        repoRootPath: placement.repoRootPath,
        ownsWorktree: placement.ownsWorktree,
        taskKind: input.taskKind ?? (readOnlyTask ? 'research' : undefined),
        ownsBranch: placement.ownsBranch,
        isDetachedReviewWorktree: Boolean(reviewDetachedWorktree),
        reviewOfDispatchId: reviewTarget?.id ?? null,
        reviewOfRunId: reviewRunTarget?.id ?? null,
        reviewFocus: input.reviewFocus?.trim() || null,
        reviewBatchId,
        reviewSnapshotOid,
        reviewBaseCommit: reviewRunBaseCommit ?? reviewBaseCommit,
        ...(reviewTarget || reviewRunTarget ? { reviewRound: reviewRoundForTarget } : {}),
        ownsPane,
        cliId: launchConfig.cliId,
        model: launchConfig.model,
        effort: launchConfig.effort,
        processGeneration: 1,
        retained: Boolean(input.keepOpen),
        maxDepth: this.host.maxDepth,
      });
      if (reviewTarget) {
        const latestTarget = this.host.store.getDispatchContext(reviewTarget.id);
        const alreadyRejectedSameBatch =
          Boolean(reviewBatchId) &&
          latestTarget?.reviewBatchId === reviewBatchId &&
          (latestTarget.reviewStatus === 'rejected' || latestTarget.reviewStatus === 'escalated');
        this.host.store.updateDispatchReviewState(reviewTarget.id, {
          reviewStatus: alreadyRejectedSameBatch ? latestTarget!.reviewStatus : 'pending',
          reviewRound: reviewRoundForTarget,
          reviewBatchId,
          reviewSnapshotOid,
          reviewBaseCommit,
        });
      }
      if (reviewRunTarget) {
        const latestRunTarget = this.host.store.getRun(reviewRunTarget.id);
        const alreadyRejectedSameRunBatch =
          Boolean(reviewBatchId) &&
          latestRunTarget?.runReviewBatchId === reviewBatchId &&
          (latestRunTarget.runReviewStatus === 'rejected' || latestRunTarget.runReviewStatus === 'escalated');
        this.host.store.updateRunReviewState(reviewRunTarget.id, {
          runReviewStatus: alreadyRejectedSameRunBatch ? latestRunTarget!.runReviewStatus : 'pending',
          runReviewRound: reviewRoundForTarget,
          runReviewBatchId: reviewBatchId,
          runReviewSnapshotOid: reviewSnapshotOid,
          runReviewBaseCommit: reviewRunBaseCommit,
        });
      }
    } catch (err) {
      if (pilot) await pilot.session.close();
      await this.rollbackWorkerResources(
        ownsPane ? ptyId ?? undefined : undefined,
        placement.ownsWorktree ? placement.worktreePath : null,
      );
      if (createdTask) this.host.failTaskIfReady(task.id);
      throw err;
    }

    const announcePane = (id: string) => {
      this.host.emitPaneSpawned({
        ptyId: id,
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
        displayName: task.displayName ?? null,
        taskTitle: task.taskTitle,
      });
    };
    if (ownsPane && ptyId) announcePane(ptyId);

    const coordinatorHandle = callerDispatch ? `dispatch:${callerDispatch.id}` : `run:${run.id}`;
    const effectiveMcpEnabled =
      input.mcpEnabled ?? this.host.isMcpEnabledForCliDep?.(launchConfig.cliId) ?? false;
    const preambleRole =
      (input.role ?? input.displayName)?.trim().replace(/^@+/, '') || null;
    if (normalizedInputContext && (input.taskId || input.retryOfDispatchId)) {
      task = this.host.store.mergeTaskContext(task.id, normalizedInputContext);
    }
    const makePreamble = () => this.host.buildWorkerDispatchBrief({
      taskId: task.id,
      dispatchId: ctx.id,
      runId: run.id,
      taskSpec: task.spec,
      taskContext: task.taskContext,
      coordinatorHandle,
      workerHandle: ctx.assigneeHandle,
      worktreePath: placement.worktreePath,
      branch: placement.branch,
      canDispatchSubWorkers: (ctx.executionMode !== 'codex-app-server' || ctx.allowSubWorkers === true) &&
        ctx.depth < this.host.maxDepth,
      mcpEnabled: ctx.executionMode === 'codex-app-server' || effectiveMcpEnabled,
      headless: ctx.executionMode === 'codex-app-server',
      leaveUncommitted: ctx.executionMode === 'codex-app-server' && workerPolicy !== 'read-only',
      role: preambleRole,
    });

    let preamble = makePreamble();
    if (task.queuedLaunch || task.codeDeps?.length) {
      try {
        await this.host.store.flushDurable();
        await this.host.verifyCodeInputs(task, placement.cwd);
      } catch (error) {
        if (pilot) await pilot.session.close();
        await this.rollbackWorkerResources(ownsPane ? ptyId ?? undefined : undefined, placement.ownsWorktree ? placement.worktreePath : null);
        this.host.store.failDispatch(ctx.id, 'Worker launch preflight failed before submission', { forceFailTask: true });
        throw error;
      }
    }
    let acceptedByCodex = false;
    if (pilot) {
      const outcome = await this.submitCodexTurn(ctx, pilot.session, preamble);
      if (outcome.status === 'not_accepted') {
        await pilot.session.close();
        if (this.host.disposed) throw new OrchestrationError('operation_rejected', 'Orchestration is closing.');
        try {
          ptyId = await spawnPane();
          ctx = this.host.store.switchUnacceptedCodexDispatchToPane(ctx.id, ptyId);
        } catch (error) {
          if (ptyId) await this.rollbackWorkerResources(ptyId);
          this.failCodexDispatch(ctx.id, 'not_accepted', outcome.reason);
          throw error;
        }
        ownsPane = true;
        this.host.store.cleanupDispatchBrief(ctx.id);
        preamble = makePreamble();
        announcePane(ptyId);
      } else if (outcome.status === 'unknown_acceptance') {
        await pilot.session.close();
        throw new OrchestrationError('prompt_delivery_failed', `${HEADLESS_DRIVER_LABELS[headlessCli!]} turn acceptance is unknown. Check Worker output before retrying.`, {
          dispatchId: ctx.id, taskId: task.id, acceptance: outcome.status,
        });
      } else {
        acceptedByCodex = true;
        this.host.emitPaneSpawned({
          ptyId: pilot.id, runId: run.id, taskId: task.id, dispatchId: ctx.id, parentPaneId,
          cwd: placement.cwd, worktreePath: placement.worktreePath, branch: placement.branch,
          cliId: launchConfig.cliId, ownsWorktree: placement.ownsWorktree, ownsPane: false,
          displayName: task.displayName ?? null, taskTitle: task.taskTitle, headless: true,
        });
      }
    }

    if (reusingTerminal) {
      const mismatch = this.host.paneMismatch(reusingTerminal, placement.cwd, launchConfig.cliId);
      if (mismatch) {
        this.host.store.failDispatch(ctx.id, mismatch, { forceFailTask: true });
        throw new OrchestrationError('terminal_unavailable', mismatch);
      }
    }
    const delivery = acceptedByCodex ? null : await this.host.deliverAndObserveDispatchTurn(ctx.id, {
      ptyId: ptyId!,
      prompt: preamble,
      submit: true,
    });

    if (delivery && !delivery.ok) {
      const reason = delivery.error ?? `Failed to deliver worker prompt to ${ptyId}`;
      this.host.store.failDispatch(ctx.id, reason);
      if (ctx.reviewOfDispatchId || ctx.reviewOfRunId) {
        this.host.store.updateDispatchReviewState(ctx.id, { reviewStatus: 'rejected' });
        this.host.failTaskIfReady(task.id);
        this.host.review.reconcileAnyReviewBatch(ctx.id, {
          overrideVerdict: 'reject',
          failedReason: 'Reviewer prompt delivery failed',
        });
      }
      const closed = await this.rollbackWorkerResources(
        ownsPane ? ptyId ?? undefined : undefined,
        placement.ownsWorktree ? placement.worktreePath : null,
      );
      if (closed && ownsPane && ptyId) {
        this.host.emitPaneClosed({ ptyId, runId: run.id, taskId: task.id, dispatchId: ctx.id });
      }
      this.host.emitChanged('dispatch:failed', run.id);
      throw new OrchestrationError('prompt_delivery_failed', reason, {
        dispatchId: ctx.id,
        taskId: task.id,
        ptyId,
      });
    }

    const updatedCtx = delivery
      ? this.host.store.updateDispatchObservation(ctx.id, delivery.startObservation, {
        reason: delivery.observationReason ?? null,
        refreshHeartbeat:
          delivery.startObservation === 'observed' ||
          delivery.startObservation === 'queued' ||
          delivery.startObservation === 'permission',
        ...(delivery.promptDeferred ? {} : { promptSent: true }),
      }) ?? ctx
      : this.host.store.getDispatchContext(ctx.id)?.stage === 'awaiting_review' ? this.host.store.getDispatchContext(ctx.id)!
      : this.host.store.updateDispatchObservation(ctx.id, 'observed', { refreshHeartbeat: true, promptSent: true }) ?? ctx;

    const briefFromRole = callerDispatch
      ? this.host.delegation.resolveRoleNameForDispatch(callerDispatch).toLowerCase() || 'worker'
      : 'coordinator';
    const briefWorkerRole =
      (input.role ?? input.displayName)?.trim().replace(/^@+/, '').toLowerCase() ||
      this.host.delegation.resolveRoleNameForDispatch(ctx).toLowerCase() ||
      ctx.id;
    const auditMsg = this.host.store.insertMessage({
      runId: run.id,
      from,
      to: `dispatch:${ctx.id}`,
      type: 'dispatch',
      subject: `Started worker for ${task.id}`,
      body: this.host.store.redactDispatchCredentials(preamble),
      fromRole: briefFromRole,
      mentions: briefWorkerRole ? [briefWorkerRole] : undefined,
      kind: 'brief',
    });
    this.host.store.markAsReadAndDelivered([auditMsg.id]);
    if (typeof auditMsg.boardSeq === 'number') {
      if (briefWorkerRole) {
        this.host.store.advanceMemberCursor(run.id, briefWorkerRole, {
          lastReadSeq: auditMsg.boardSeq,
          lastDeliveredSeq: auditMsg.boardSeq,
        });
      }
      this.host.store.advanceMemberCursor(run.id, briefFromRole, {
        lastPostSeq: auditMsg.boardSeq,
      });
    }

    this.host.emitChanged('worker:started', run.id);
    return {
      dispatch: this.host.store.getDispatchContext(ctx.id) ?? updatedCtx,
      task: this.host.store.requireTask(task.id),
      run: this.host.store.requireRun(run.id),
      ptyId,
      worktreePath: placement.worktreePath,
      branch: placement.branch,
      ownsWorktree: placement.ownsWorktree,
      ownsPane,
      cliId: launchConfig.cliId,
      model: launchConfig.model,
      effort: launchConfig.effort,
      injected: true,
      ...(typeof auditMsg.boardSeq === 'number' ? { briefBoardSeq: auditMsg.boardSeq } : {}),
    };
  }

  /** Starts a headless Worker on `cliId`'s native protocol; null when it could not start, before any turn. */
  private async openCodexWorker(
    cliId: HeadlessWorkerDriver, cwd: string, model: string | null, options: HeadlessWorkerControls,
  ) {
    const codexPilot = this.host.codexPilot;
    const headlessWorkers = this.host.headlessWorkers;
    if (this.host.disposed || (cliId === 'codex' ? !codexPilot : !headlessWorkers)) return null;
    const id = `${cliId}-worker-${randomUUID()}`;
    let session: AgentSessionDriver | undefined;
    const timeline = this.host.createWorkerTimeline(
      id, cliId, model, { policy: options.policy, network: options.network }, (text) => session?.redactText(text) ?? text,
    );
    this.codexWorkerControls.set(id, { ...options });
    try {
      const launch = (events: AgentSessionEvents): AgentSessionDriver => cliId === 'codex'
        ? codexPilot!.launch(id, cwd, events, { ...options })
        : headlessWorkers!.launch(cliId, id, cwd, events, { ...options });
      session = launch({
        onGoalChanged: (goal) => {
          if (goal?.status === 'usageLimited' || goal?.status === 'budgetLimited') {
            this.workerGoalLimits.set(id, goal.status);
          } else {
            this.workerGoalLimits.delete(id);
          }
        },
        onTimeline: (dispatchId, event) => {
          if (timeline.activeTurn?.dispatchId === dispatchId) timeline.apply(event);
        },
        onTurnStarted: (dispatchId) => {
          const waiting = this.host.approvals.hasOpenApprovalForDispatch(dispatchId);
          const asking = this.host.nativeQuestions.hasOpenQuestionForDispatch(dispatchId);
          const updated = this.host.store.updateDispatchObservation(dispatchId, waiting ? 'permission' : 'observed', {
            promptSent: true, refreshHeartbeat: true,
          });
          if (updated && !waiting && !asking) this.host.store.updateDispatchStage(dispatchId, 'working');
          if (updated) this.host.emitChanged('worker:turn-started', updated.runId);
        },
        onTurnCompleted: (dispatchId, result) => this.completeCodexTurn(id, cwd, dispatchId, result),
        onRequest: async (dispatchId, request) => {
          const dispatch = this.host.store.getDispatchContext(dispatchId);
          if (!dispatch || dispatch.assigneeHandle !== id) return { decision: 'decline' };
          if (request.kind === 'question') {
            return this.host.nativeQuestions.holdQuestion(dispatch, {
              provider: headlessWorkerDriver(id) ?? dispatch.cliId ?? 'codex',
              method: request.method,
              questions: request.questions ?? [],
              signal: request.signal,
              redact: (text) => session?.redactText(text) ?? text,
            });
          }
          // Anything that is neither a question nor an approval fails closed.
          const allowed = request.kind === 'approval' && await this.host.approvals.holdCodexRequest(dispatch, request);
          return { decision: allowed ? 'accept' : 'decline' };
        },
        onExit: (reason, exitCode) => {
          const dispatchId = session?.latestTurnKey;
          if (session && dispatchId) this.archiveCodexOutput(session, dispatchId);
          timeline.endActiveTurn(session?.closing ? 'interrupted' : 'failed', reason);
          timeline.setMeta({ alive: false });
          this.host.archiveWorkerTimeline(id, dispatchId);
          this.host.workerTimelines.delete(id);
          this.codexWorkers.delete(id);
          this.workerGoalLimits.delete(id);
          this.codexMailbox.delete(id);
          this.codexWorkerControls.delete(id);
          this.host.approvals.cancelForPane(id, reason);
          this.host.nativeQuestions.cancelForWorker(id, reason);
          this.host.waiters.cancel(id);
          this.host.waiters.cancelConsumer(id);
          const announced = Boolean(dispatchId && !this.codexSubmitting.has(dispatchId) &&
            this.handleCodexExit(dispatchId, reason, exitCode));
          const exited = !announced && dispatchId ? this.host.store.getDispatchContext(dispatchId) : undefined;
          if (exited) this.host.emitChanged('worker:exited', exited.runId);
        },
      });
      this.codexWorkers.set(id, session);
      const sessionId = await session.open({ cwd, model, policy: options.policy, network: options.network });
      if (!session.alive || this.host.disposed) throw new Error(`${HEADLESS_DRIVER_LABELS[cliId]} closed during initialization`);
      timeline.setMeta({ providerSessionId: sessionId });
      return { id, session, sessionId };
    } catch (error) {
      // No turn was sent, so PTY fallback can safely proceed after process teardown.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[orchestration] ${HEADLESS_DRIVER_LABELS[cliId]} headless Worker startup failed:`, session ? session.redactText(reason) : reason);
      this.codexWorkers.delete(id);
      this.workerGoalLimits.delete(id);
      this.codexWorkerControls.delete(id);
      await session?.close();
      this.host.workerTimelines.delete(id);
      return null;
    }
  }

  private archiveCodexOutput(session: AgentSessionDriver, dispatchId: string): void {
    const result = session.read(dispatchId, 0, undefined, true);
    if (result) this.host.store.archiveDispatchOutput(dispatchId, result.text);
  }

  private publishCodexStatus(
    dispatch: OrchestrationDispatchRecord, subject: string, body: string, payload: Record<string, unknown>,
  ): void {
    const to = this.host.resolveActiveParentMailbox(dispatch);
    this.host.store.insertMessage({
      runId: dispatch.runId, from: `dispatch:${dispatch.id}`, to,
      type: 'status', subject, body: this.host.store.redactDispatchCredentials(body),
      payload: this.host.store.redactDispatchCredentials(JSON.stringify({ dispatchId: dispatch.id, ...payload })),
      mentions: ['coordinator'], kind: 'post',
    });
    this.host.notifyTargetAndAliases(to, 'status');
    this.host.emitChanged('dispatch:codex-status', dispatch.runId);
  }

  private completeCodexTurn(workerId: string, cwd: string, dispatchId: string, result: AgentTurnResult): void {
    const session = this.codexWorkers.get(workerId);
    if (session) this.archiveCodexOutput(session, dispatchId);
    const label = this.headlessLabel(workerId);
    this.host.approvals.cancelForDispatch(dispatchId, `${label} turn ended`);
    this.host.nativeQuestions.cancelForDispatch(dispatchId, `${label} turn ended`);
    const timeline = this.host.workerTimelines.get(workerId);
    const status: WorkerTimelineTurnStatus = result.stopReason === 'completed' ? 'completed'
      : result.stopReason === 'interrupted' ? 'interrupted' : 'failed';
    timeline?.completeTurn({
      turnId: result.turnId, status, stopReason: result.stopReason, usage: result.usage, error: result.error,
    });
    this.host.store.recordCodexTurn(dispatchId, result);
    this.host.archiveWorkerTimeline(workerId, dispatchId);
    const dispatch = this.host.store.getDispatchContext(dispatchId);
    if (!dispatch || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return;
    const announce = (diff: string | null) => {
      if (this.host.disposed) return;
      const current = this.host.store.getDispatchContext(dispatchId);
      if (!current || !ACTIVE_DISPATCH_STATUSES.has(current.status) || current.codexTurn?.turnId !== result.turnId) return;
      if (diff !== result.diff) this.host.store.recordCodexTurn(dispatchId, { ...result, diff }, false);
      const liveTimeline = this.host.workerTimelines.get(workerId);
      liveTimeline?.addSettlement(dispatchId, {
        settlement: 'turn_pending_confirmation', stopReason: result.stopReason, outcome: null, verdict: null,
        findings: [], summary: result.finalText.slice(0, 4_000), diff,
        diffSource: diff === null ? null : result.diff !== null ? 'provider' : 'git',
      });
      this.host.archiveWorkerTimeline(workerId, dispatchId);
      this.publishCodexStatus(current, `${label} turn ended; result pending confirmation`,
        `${label} turn ${result.stopReason} without a recorded report_done. Read the Worker output and diff evidence before deciding what to do.\n\n${result.finalText.slice(0, 4_000)}`,
        { turnId: result.turnId, stopReason: result.stopReason, error: result.error, usage: result.usage, diff });
      this.deliverCodexMailbox(workerId);
    };
    if (result.diff !== null) {
      announce(result.diff);
    } else if (!this.host.disposed) {
      // Working-tree files can contain Worker credentials; redact before the diff is stored or published.
      const redactDiff = (diff: string) => this.host.store.redactDispatchCredentials(session?.redactText(diff) ?? diff);
      const task: Promise<void> = Promise.all([
        runGitCommand(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], {
          cwd, readOnly: true, maxBytes: 128 * 1024, timeoutMs: 3_000,
        }),
        runGitCommand(['ls-files', '--others', '--exclude-standard', '-z'], {
          cwd, readOnly: true, maxBytes: 32 * 1024, timeoutMs: 3_000,
        }),
      ]).then(([git, untracked]) => {
        if (git.exitCode !== 0) {
          announce(null);
          return;
        }
        const rawUntracked = untracked.exitCode === 0 || untracked.truncated ? untracked.stdout : '';
        const safeUntracked = untracked.truncated
          ? rawUntracked.slice(0, Math.max(0, rawUntracked.lastIndexOf('\0')))
          : rawUntracked;
        const untrackedPaths = safeUntracked.split('\0').filter(Boolean);
        const untrackedDiff = untrackedPaths
          .map((file) => `diff --git a/${file} b/${file}\nnew file (untracked)\n--- /dev/null\n+++ b/${file}`)
          .join('\n');
        const combined = untrackedPaths.length === 0
          ? git.stdout
          : `${[git.stdout.trimEnd(), untrackedDiff].filter(Boolean).join('\n')}\n`;
        announce(redactDiff(combined));
      }, () => announce(null)).finally(() => {
        this.pendingCodexTurnDiffs.delete(task);
      });
      this.pendingCodexTurnDiffs.add(task);
    }
  }

  private failCodexDispatch(dispatchId: string, failure: 'not_accepted' | 'unknown_acceptance', reason: string): void {
    const dispatch = this.host.store.getDispatchContext(dispatchId);
    if (!dispatch || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return;
    if (failure === 'unknown_acceptance') return; // submitCodexTurn has already parked and archived it.
    const label = this.headlessLabel(dispatch.assigneeHandle);
    this.host.store.recordCodexDeliveryFailure(dispatchId, failure);
    this.host.store.failDispatch(dispatchId, `${label} ${failure}`, {
      forceFailTask: true, summary: this.host.store.redactDispatchCredentials(reason),
    });
    this.cleanupCodexDispatch(dispatch, `${label} delivery ${failure}`);
    this.publishCodexStatus(dispatch, `${label} delivery: ${failure}`, reason, { acceptance: failure });
  }

  private cleanupCodexDispatch(dispatch: OrchestrationDispatchRecord, reason: string): void {
    this.host.approvals.cancelForDispatch(dispatch.id, reason);
    this.host.nativeQuestions.cancelForDispatch(dispatch.id, reason);
    this.host.waiters.cancel(`dispatch:${dispatch.id}`);
    this.host.waiters.notifyPrefix(`question:${dispatch.id}:`, 'status');
    this.host.store.cleanupDispatchBrief(dispatch.id);
    if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
      this.host.store.updateDispatchReviewState(dispatch.id, { reviewStatus: 'rejected' });
      this.host.review.reconcileAnyReviewBatch(dispatch.id, { overrideVerdict: 'reject', failedReason: reason });
    }
  }

  private handleCodexExit(dispatchId: string, reason: string, exitCode: number | null): boolean {
    const dispatch = this.host.store.getDispatchContext(dispatchId);
    if (!dispatch?.promptSentAt || dispatch.stage === 'needs_reconciliation' || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return false;
    if (exitCode === 0 && dispatch.stage === 'awaiting_review') return false;
    const label = this.headlessLabel(dispatch.assigneeHandle);
    this.host.store.failDispatch(dispatch.id, dispatch.assigneeHandle.startsWith('codex-') ? 'Codex app-server exited' : `${label} exited`, {
      forceFailTask: true, summary: reason,
    });
    this.cleanupCodexDispatch(dispatch, reason);
    this.publishCodexStatus(dispatch, `${label} Worker exited before report_done`, reason, { exitCode });
    return true;
  }

  /** The agent a headless Worker runs, for coordinator-facing status text. */
  private headlessLabel(workerId: string): string {
    const driver = headlessWorkerDriver(workerId);
    return driver ? HEADLESS_DRIVER_LABELS[driver] : 'Codex';
  }

  private async submitCodexTurn(dispatch: OrchestrationDispatchRecord, session: AgentSessionDriver, prompt: string) {
    this.codexSubmitting.add(dispatch.id);
    const timeline = this.host.workerTimelines.get(dispatch.assigneeHandle);
    timeline?.beginTurn({ dispatchId: dispatch.id, prompt });
    try {
      const controls = this.headlessControls(dispatch);
      const result = await session.startTurn({
        turnKey: dispatch.id, prompt, effort: dispatch.effort ?? null, policy: controls.policy, network: controls.network,
      });
      if (result.status !== 'accepted') timeline?.endActiveTurn('failed', result.reason);
      if (result.status === 'unknown_acceptance') {
        this.host.store.recordCodexDeliveryFailure(dispatch.id, result.status);
        this.archiveCodexOutput(session, dispatch.id);
        this.host.archiveWorkerTimeline(dispatch.assigneeHandle, dispatch.id);
        const cwd = dispatch.worktreePath;
        if (cwd) {
          const diff = await runGitCommand(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], {
            cwd, readOnly: true, timeoutMs: 3000, maxBytes: 128 * 1024,
          }).catch(() => null);
          const files = await runGitCommand(['ls-files', '--others', '--exclude-standard'], {
            cwd, readOnly: true, timeoutMs: 3000, maxBytes: 16 * 1024,
          }).catch(() => null);
          this.host.store.recordReconciliationDiff(dispatch.id, diff?.exitCode === 0
            ? session.redactText([diff.stdout, files?.stdout].filter(Boolean).join('\n')) : null);
        }
        await this.host.store.flushDurable();
        this.publishCodexStatus(dispatch, '接单结果需核对', result.reason, { acceptance: result.status });
      }
      if (result.status === 'accepted' && !session.alive) {
        this.handleCodexExit(dispatch.id, `${this.headlessLabel(dispatch.assigneeHandle)} disconnected after accepting the turn`, null);
      }
      return result;
    } finally {
      this.codexSubmitting.delete(dispatch.id);
    }
  }

  queueCodexMail(workerId: string, message?: OrchestrationMessageRecord): void {
    if (message) {
      const firewall = this.host.review.getReviewFirewallContext(workerId);
      if (firewall && this.host.review.isPostHiddenByReviewFirewall(message, firewall)) return;
    }
    const pending = this.codexMailbox.get(workerId) ?? { messages: [], opaque: false };
    if (!message) pending.opaque = true;
    else if (!pending.messages.some((entry) => entry.id === message.id)) pending.messages.push(message);
    this.codexMailbox.set(workerId, pending);
  }

  /** Inlines one or two short messages, like PTY direct delivery; anything else points the Worker at read_board. */
  private codexMailboxPrompt(pending: { messages: OrchestrationMessageRecord[]; opaque: boolean }) {
    const pointer = 'You have a new message from AhaStation. Use the Aha read_board tool to read unread messages for your role, then continue the current assignment.';
    const messages = pending.messages
      .map((message) => this.host.store.getMessageById(message.id) ?? message)
      .filter((message) => message.lifecycleRejectedReason === null && message.type !== 'heartbeat');
    const lookups = pending.opaque ? null : boardLookupCommands(messages);
    const notification = {
      prompt: lookups ? pointer + ' Fetch the referenced posts with ' + lookups + '.' : pointer,
      messages,
      inlined: false,
    };
    if (pending.opaque || messages.length === 0 || messages.length > 2) return notification;
    const rendered = this.host.store.redactDispatchCredentials(messages.map((message) => formatBoardPostForAgent(message)).join('\n\n'));
    if (rendered.length > 1_000) return notification;
    const prompt = `${rendered}\n\n(Full message above from AhaStation; no read_board call is needed for it. Continue the current assignment.)`;
    return { prompt, messages, inlined: true };
  }

  private acknowledgeCodexMail(workerId: string, messages: OrchestrationMessageRecord[]): void {
    this.host.store.markAsDeliveredForConsumer(messages.map((message) => message.id), workerId);
    const member = this.host.board.resolveBoardMemberForPane(workerId);
    const maxSeq = Math.max(0, ...messages
      .filter((message) => member && message.runId === member.runId && typeof message.boardSeq === 'number')
      .map((message) => message.boardSeq as number));
    if (member && maxSeq > 0) this.host.store.advanceMemberCursor(member.runId, member.memberKey, { lastDeliveredSeq: maxSeq });
  }

  deliverCodexMailbox(workerId: string): void {
    const session = this.codexWorkers.get(workerId);
    const pending = this.codexMailbox.get(workerId);
    if (!session?.alive || session.busy || !pending) return;
    this.codexMailbox.delete(workerId);
    const dispatch = this.host.store.getActiveDispatchForIdentity(workerId, null);
    if (!dispatch || dispatch.stage === 'needs_reconciliation' || this.codexSubmitting.has(dispatch.id)) {
      if (dispatch) this.codexMailbox.set(workerId, pending);
      return;
    }
    const member = this.host.board.resolveBoardMemberForPane(workerId);
    const unreadMessages = pending.messages.filter(
      (message) => !(member && message.runId === member.runId && this.host.store.wasBoardPostRead(message.id, member.memberKey))
    );
    if (!pending.opaque && unreadMessages.length === 0) return;
    const { prompt, messages, inlined } = this.codexMailboxPrompt({
      opaque: pending.opaque,
      messages: unreadMessages,
    });
    if (!pending.opaque && messages.length === 0) return;
    void this.submitCodexTurn(dispatch, session, prompt).then(async (outcome) => {
      if (outcome.status === 'accepted') {
        const member = this.host.board.resolveBoardMemberForPane(workerId);
        this.acknowledgeCodexMail(workerId, messages);
        if (member && inlined) this.host.store.recordBoardRead(member.runId, member.memberKey, messages.map(m => m.id));
        if (member && this.host.store.recordBoardReceipt(messages.map(m => m.id), member.memberKey, inlined ? 'delivered' : 'notified')) {
          this.host.emitChanged('board:delivery', member.runId);
        }
      } else {
        this.failCodexDispatch(dispatch.id, outcome.status, outcome.reason);
        await session.close();
      }
    }).catch((error) => console.warn(`[orchestration] ${this.headlessLabel(workerId)} mailbox delivery failed:`, error));
  }

  async followUpSettledWorker(
    settledDispatch: OrchestrationDispatchRecord,
    input: SettledWorkerFollowUpInput,
  ): Promise<OrchestrationSendResult> {
    return this.mutateWorkerResources(settledDispatch, () => this.startFollowUp(settledDispatch, input));
  }

  private async startFollowUp(
    settledDispatch: OrchestrationDispatchRecord,
    input: SettledWorkerFollowUpInput,
  ): Promise<OrchestrationSendResult> {
    if (settledDispatch.releasedAt) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Worker dispatch ${settledDispatch.id} has already been released; start a new worker with worker-start.`
      );
    }

    const from = input.from?.trim() || 'coordinator';
    const run = this.host.store.requireRun(settledDispatch.runId);
    if (run.status !== 'active') {
      this.host.store.updateRunStatus(run.id, 'active');
    }
    const prevTask = this.host.store.getTask(settledDispatch.taskId);
    const followUpInstructions = [
      input.subject,
      ...(input.body?.trim() ? ['', input.body.trim()] : []),
    ].join('\n');

    const existingPaneId = settledDispatch.assigneePaneId ?? settledDispatch.assigneeHandle;
    if (this.host.retiringPanes.has(existingPaneId)) {
      throw new OrchestrationError('operation_rejected', 'This worker terminal is still closing. Retry once it exits.');
    }
    const isHeadless = settledDispatch.executionMode === 'codex-app-server';
    const session = isHeadless ? this.codexWorkers.get(existingPaneId) : undefined;
    if (isHeadless && (!session?.alive || !await session.waitForIdle(15_000) || !session.alive ||
        this.host.store.getActiveDispatchForIdentity(existingPaneId, null))) {
      throw new OrchestrationError('dispatch_inactive', `${this.headlessLabel(existingPaneId)} Worker is unavailable or still finishing its previous turn.`);
    }
    const canReuseLivePane =
      Boolean(existingPaneId) &&
      this.host.isPaneAlive(existingPaneId) &&
      !this.host.store.getActiveDispatchForIdentity(existingPaneId, existingPaneId);

    const originalDispatchId = this.host.store.listDispatchAncestorIds(settledDispatch.id).at(-1);
    const originalDispatch = originalDispatchId ? this.host.store.getDispatchContext(originalDispatchId) : undefined;
    const originalTask = originalDispatch ? this.host.store.getTask(originalDispatch.taskId) : prevTask;
    const followUpSpec = !canReuseLivePane && originalTask
      ? ['### Follow-up Instructions', followUpInstructions, '### Original Task', originalTask.spec].join('\n\n')
      : followUpInstructions;
    const followUpTask = this.host.store.createTask({
      singleShot: true,
      runId: settledDispatch.runId,
      spec: followUpSpec,
      taskContext: prevTask?.taskContext ?? originalTask?.taskContext,
      taskTitle: 'Follow-up: ' + input.subject.slice(0, 80),
      priority: input.priority ?? prevTask?.priority ?? 'normal',
      worktreePath: settledDispatch.worktreePath ?? prevTask?.worktreePath ?? null,
    });

    let targetPtyId: string;
    let reusedPane = false;
    let spawnedNewPane = false;

    if (canReuseLivePane) {
      targetPtyId = existingPaneId;
      reusedPane = !session;
    } else {
      if (!this.host.spawnWorkerPty) {
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
      const spawned = await this.host.spawnWorkerPty({
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
      this.host.exitedPanes.delete(targetPtyId);
    }

    const nextGeneration = (settledDispatch.processGeneration ?? 1) + 1;
    const controls = session ? this.headlessControls(settledDispatch) : null;
    let nextCtx: OrchestrationDispatchRecord;
    try {
      nextCtx = this.host.store.createDispatchContext({
        taskId: followUpTask.id,
        taskKind: settledDispatch.taskKind,
        assigneeHandle: targetPtyId,
        assigneePaneId: session ? null : targetPtyId,
        ...(session?.sessionId ? { providerSessionId: session.sessionId } : {}),
        ...(controls ? {
          workerPolicy: controls.policy, workerNetwork: controls.network, allowSubWorkers: controls.allowSubWorkers,
        } : {}),
        creator: from,
        creatorRunId: settledDispatch.runId,
        creatorDispatchId: settledDispatch.creatorDispatchId ?? null,
        parentPaneId: settledDispatch.parentPaneId ?? null,
        worktreePath: settledDispatch.worktreePath ?? null,
        branch: settledDispatch.branch ?? null,
        baseCommit: settledDispatch.baseCommit ?? null,
        repoRootPath: settledDispatch.repoRootPath ?? null,
        ownsWorktree: Boolean(settledDispatch.ownsWorktree),
        ownsBranch: Boolean(settledDispatch.ownsBranch),
        reviewRound: settledDispatch.reviewRound ?? 0,
        ownsPane: spawnedNewPane ? true : Boolean(settledDispatch.ownsPane),
        cliId: settledDispatch.cliId ?? null,
        model: settledDispatch.model ?? null,
        effort: settledDispatch.effort ?? null,
        processGeneration: nextGeneration,
        followUpOfDispatchId: settledDispatch.id,
        retained: Boolean(settledDispatch.retained),
        maxDepth: Math.max(this.host.maxDepth, settledDispatch.depth),
      });
    } catch (error) {
      if (spawnedNewPane) {
        if (await this.rollbackWorkerResources(targetPtyId)) this.host.markPtyExited(targetPtyId);
      }
      throw error;
    }

    this.host.store.transferCustodyToFollowUp(settledDispatch.id, nextCtx.id);

    if (spawnedNewPane) {
      this.host.emitPaneSpawned({
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
        displayName: followUpTask.displayName ?? null,
        taskTitle: followUpTask.taskTitle,
      });
    }

    const payloadString =
      input.payload === undefined || input.payload === null
        ? null
        : typeof input.payload === 'string'
          ? input.payload
          : JSON.stringify(input.payload);

    const followUpRole = this.host.delegation.resolveRoleNameForDispatch(settledDispatch) || null;
    const followUpFromRole =
      input.fromRole?.trim().replace(/^@+/, '').toLowerCase() ||
      (from === 'user' ? 'user' : 'coordinator');
    const msg =
      input.existingMessage ??
      this.host.store.insertMessage({
        runId: settledDispatch.runId,
        from,
        to: `dispatch:${nextCtx.id}`,
        type: input.type ?? 'status',
        priority: input.priority ?? 'normal',
        subject: input.subject,
        body: input.body,
        payload: payloadString,
        threadId: input.threadId,
        fromRole: followUpFromRole,
        mentions:
          input.mentions && input.mentions.length > 0
            ? input.mentions
            : followUpRole
              ? [followUpRole.toLowerCase()]
              : undefined,
        refs: input.refs,
        kind: input.kind ?? 'post',
      });
    this.host.store.linkFollowUpMessage(nextCtx.id, msg.id);
    if (!input.existingMessage) {
      this.host.store.markAsReadAndDelivered([msg.id]);
    }
    const coordinatorHandle = this.host.resolveActiveParentMailbox(nextCtx);
    const followUpMcpEnabled = nextCtx.cliId
      ? (this.host.isMcpEnabledForCliDep?.(nextCtx.cliId) ?? false)
      : false;
    const preamble = this.host.buildWorkerDispatchBrief({
      taskId: followUpTask.id,
      dispatchId: nextCtx.id,
      runId: settledDispatch.runId,
      taskSpec: followUpTask.spec,
      taskContext: reusedPane || session ? null : followUpTask.taskContext,
      coordinatorHandle,
      workerHandle: targetPtyId,
      worktreePath: nextCtx.worktreePath,
      branch: nextCtx.branch,
      canDispatchSubWorkers: (!session || controls?.allowSubWorkers === true) && nextCtx.depth < this.host.maxDepth,
      isFollowUp: reusedPane || Boolean(session),
      previousDispatchId: settledDispatch.id,
      mcpEnabled: Boolean(session) || followUpMcpEnabled,
      headless: Boolean(session),
      leaveUncommitted: controls !== null && controls.policy !== 'read-only',
      role: followUpRole,
    });

    if (session) {
      const outcome = await this.submitCodexTurn(nextCtx, session, preamble);
      if (outcome.status !== 'accepted') {
        this.failCodexDispatch(nextCtx.id, outcome.status, outcome.reason);
        await session.close();
        throw new OrchestrationError('prompt_delivery_failed', `${this.headlessLabel(targetPtyId)} follow-up delivery failed.`, {
          dispatchId: nextCtx.id, acceptance: outcome.status,
        });
      }
      if (followUpRole) this.host.store.recordBoardRead(settledDispatch.runId, followUpRole.toLowerCase(), [msg.id]);
      this.host.emitChanged('worker:follow-up', settledDispatch.runId);
      return {
        message: exposeMessage(msg),
        followUp: {
          reactivated: true, previousDispatchId: settledDispatch.id,
          dispatch: this.host.store.getDispatchContext(nextCtx.id)!,
          task: this.host.store.requireTask(followUpTask.id), reusedPane: false,
        },
      };
    }

    const delivery = await this.host.deliverAndObserveDispatchTurn(nextCtx.id, {
      ptyId: targetPtyId,
      prompt: preamble,
      submit: true,
    });
    if (!delivery.ok) {
      const reason = delivery.error ?? `Failed to deliver follow-up prompt to ${targetPtyId}`;
      this.host.store.failDispatch(nextCtx.id, reason);
      if (spawnedNewPane && await this.rollbackWorkerResources(targetPtyId)) {
        this.host.spawnedWorkerPanes.delete(targetPtyId);
        this.host.spawnedWorkerMeta.delete(targetPtyId);
        this.host.markPtyExited(targetPtyId);
        this.host.emitPaneClosed({
          ptyId: targetPtyId,
          runId: settledDispatch.runId,
          taskId: followUpTask.id,
          dispatchId: nextCtx.id,
        });
      }
      this.host.emitChanged('dispatch:failed', settledDispatch.runId);
      throw new OrchestrationError('prompt_delivery_failed', reason, {
        dispatchId: nextCtx.id,
        previousDispatchId: settledDispatch.id,
      });
    }

    if (!delivery.promptDeferred && followUpRole) {
      this.host.store.recordBoardRead(settledDispatch.runId, followUpRole.toLowerCase(), [msg.id]);
    }
    this.host.store.updateDispatchObservation(nextCtx.id, delivery.startObservation, {
      reason: delivery.observationReason ?? null,
      refreshHeartbeat:
        delivery.startObservation === 'observed' ||
        delivery.startObservation === 'queued' ||
        delivery.startObservation === 'permission',
      ...(delivery.promptDeferred ? {} : { promptSent: true }),
    });

    this.host.emitChanged('worker:follow-up', settledDispatch.runId);
    return {
      message: exposeMessage(msg),
      followUp: {
        reactivated: true,
        previousDispatchId: settledDispatch.id,
        dispatch: this.host.store.getDispatchContext(nextCtx.id)!,
        task: this.host.store.requireTask(followUpTask.id),
        reusedPane,
      },
    };
  }

  workerList(input: {
    runId?: string;
    status?: OrchestrationDispatchRecord['status'];
    includeSettled?: boolean;
  } = {}, callerPaneId?: string): {
    workers: OrchestrationWorkerSummary[];
    count: number;
  } {
    const includeSettled = input.includeSettled !== false;
    const firewall = callerPaneId !== undefined ? this.host.review.getReviewFirewallContext(callerPaneId) : null;
    const dispatches = this.host.store
      .listDispatches({
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.status ? { status: input.status } : {}),
      })
      .filter((d) => includeSettled || ACTIVE_DISPATCH_STATUSES.has(d.status))
      .filter(
        (d) =>
          !firewall ||
          (!firewall.targetDispatchIds.has(d.id) && !firewall.targetTaskIds.has(d.taskId)),
      );
    const workers = dispatches.map((d) => this.toWorkerSummary(d));
    return { workers, count: workers.length };
  }

  workerShow(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
  }, callerPaneId?: string): OrchestrationWorkerSummary {
    const dispatch = this.resolveTargetDispatch(input);
    if (callerPaneId !== undefined) {
      this.host.authorizeRunAccess(dispatch.runId, callerPaneId);
      this.host.review.assertNotFirewalledReviewRead(callerPaneId, dispatch, 'worker-show');
    }
    return this.toWorkerSummary(dispatch);
  }

  workerRead(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    cursor?: number;
    limit?: number;
    screen?: boolean;
  }, callerPaneId?: string): TerminalReadResult & { dispatchId: string; archived: boolean } {
    const dispatch = this.resolveTargetDispatch(input);
    if (callerPaneId !== undefined) {
      this.host.authorizeRunAccess(dispatch.runId, callerPaneId);
      this.host.review.assertNotFirewalledReviewRead(callerPaneId, dispatch, 'worker-read');
    }
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const codex = this.codexWorkers.get(dispatch.assigneeHandle);
    const headlessRead = codex?.read(dispatch.id, input.cursor, input.limit, input.screen);
    if (headlessRead) {
      return {
        ...headlessRead, ptyId: dispatch.assigneeHandle, dispatchId: dispatch.id,
        text: this.host.store.redactDispatchCredentials(headlessRead.text),
        archived: !headlessRead.alive || Boolean(dispatch.releasedAt),
      };
    }

    if (dispatch.executionMode !== 'codex-app-server' && paneId && this.host.terminalTracker) {
      const liveRead = this.host.terminalTracker.readOutput(paneId, {
        cursor: input.cursor,
        limit: input.limit,
        screen: input.screen,
      });
      if (liveRead && (liveRead.alive || !dispatch.archivedOutput)) {
        return {
          ...liveRead,
          text: this.host.store.redactDispatchCredentials(liveRead.text),
          dispatchId: dispatch.id,
          archived: !liveRead.alive || Boolean(dispatch.releasedAt),
        };
      }
    }

    const archived = this.host.store.redactDispatchCredentials(dispatch.archivedOutput ?? '');
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
    const updated = this.host.store.setDispatchRetained(target.id, retained);
    this.host.emitChanged('worker:retained', updated.runId);
    return { dispatch: updated, retained };
  }

  async confirmWorkerPaneClosed(ptyId: string): Promise<void> {
    try {
      if (!this.host.closeWorkerPty) {
        if (!this.host.isPaneAlive(ptyId)) return;
        throw new Error('Terminal termination is unavailable');
      }
      const result = await this.host.closeWorkerPty(ptyId);
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

  async mutateWorkerResources<T>(
    dispatch: OrchestrationDispatchRecord,
    mutation: () => Promise<T>,
  ): Promise<T> {
    const lineage = new Set([dispatch.id]);
    let root = dispatch;
    while (root.followUpOfDispatchId && !lineage.has(root.followUpOfDispatchId)) {
      const parent = this.host.store.getDispatchContext(root.followUpOfDispatchId);
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
    keepBranch?: boolean;
    expectedBranchOid?: string | null;
    force?: boolean;
  }): Promise<{
    dispatch: OrchestrationDispatchRecord;
    closedPane: boolean;
    removedWorktree: boolean;
    removedBranch?: boolean;
    worktreeError?: string;
  }> {
    const rawTarget = this.resolveTargetDispatch(input);
    const dispatch = this.host.store.resolveDispatchLineage(rawTarget.id) ?? rawTarget;
    return this.mutateWorkerResources(dispatch, () => this.releaseWorker(dispatch, input));
  }

  async releaseWorker(
    dispatch: OrchestrationDispatchRecord,
    input: Parameters<OrchestrationService['workerRelease']>[0],
    integratedSnapshotOid?: string,
  ) {
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      throw new OrchestrationError(
        'operation_rejected',
        `Worker dispatch ${dispatch.id} is still active (${dispatch.status}). Call worker-stop to abort an active worker or wait for it to finish.`
      );
    }
    if (dispatch.releasedAt && (!dispatch.ownsWorktree || input.keepWorktree)) {
      return { dispatch, closedPane: false, removedWorktree: false };
    }

    if (!input.force && !integratedSnapshotOid && this.host.store.hasUnreadReportFromDispatch(dispatch.id)) {
      throw new OrchestrationError(
        'operation_rejected',
        `Unread worker report mail remains from ${dispatch.id}. Run \`${this.host.cliCommand} orchestration check\` before releasing, or pass --force.`
      );
    }

    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    if (paneId && this.host.terminalTracker) {
      const transcript = this.host.terminalTracker.readFullTranscript(paneId);
      if (transcript) {
        this.host.store.archiveDispatchOutput(dispatch.id, transcript);
      }
    }

    const repoRootPath =
      dispatch.repoRootPath ??
      (dispatch.parentPaneId
        ? this.host.terminalTracker?.getTerminal(dispatch.parentPaneId)?.cwd ??
          this.host.sessionCoordinator(dispatch.parentPaneId)?.cwd
        : undefined) ??
      this.host.getDefaultCwd?.() ??
      null;

    const codex = this.codexWorkers.get(dispatch.assigneeHandle);
    const shouldCloseCodex = codex && !input.keepPane &&
      (!dispatch.retained || Boolean(input.force) || Boolean(integratedSnapshotOid));
    let closedPane = false;
    const shouldClosePane =
      Boolean(dispatch.ownsPane) &&
      Boolean(paneId) &&
      this.host.isPaneAlive(paneId) &&
      !input.keepPane &&
      (!dispatch.retained || Boolean(input.force) || Boolean(integratedSnapshotOid));
    // A pane explicitly kept open continues to use its worktree.
    const worktreeToRemove = dispatch.ownsWorktree && !input.keepWorktree &&
      (shouldClosePane || shouldCloseCodex || !this.host.isPaneAlive(paneId)) ? dispatch.worktreePath : null;
    const forceRemoveWorktree = Boolean(input.force || dispatch.isDetachedReviewWorktree);
    if (worktreeToRemove && !forceRemoveWorktree && !integratedSnapshotOid) await assertWorkerWorktreeClean(worktreeToRemove);

    if (shouldCloseCodex) await codex.close(true);

    if (shouldClosePane && paneId) {
      await this.confirmWorkerPaneClosed(paneId);
      this.host.spawnedWorkerPanes.delete(paneId);
      this.host.spawnedWorkerMeta.delete(paneId);
      this.host.markPtyExited(paneId);
      this.host.store.markDispatchPaneClosed(dispatch.id);
      closedPane = true;
      this.host.emitPaneClosed({
        ptyId: paneId,
        runId: dispatch.runId,
        taskId: dispatch.taskId,
        dispatchId: dispatch.id,
      });
    }

    if (integratedSnapshotOid && dispatch.ownsWorktree) {
      const verified = worktreeToRemove && !this.host.isPaneAlive(paneId)
        ? await Promise.all([
            captureWorkerSnapshotOid(worktreeToRemove, { rejectStagedDivergence: false }),
            dispatch.ownsBranch && dispatch.branch?.startsWith(WORKER_BRANCH_PREFIX) && repoRootPath
              ? resolveBranchRefOid(repoRootPath, dispatch.branch)
              : Promise.resolve(null),
          ]).catch(() => null)
        : null;
      const snapAfterShutdown = verified?.[0] ?? null;
      const branchOidAfterShutdown = verified?.[1] ?? null;
      const snapshotStillMatches = Boolean(
        snapAfterShutdown &&
          snapAfterShutdown.snapshotOid === integratedSnapshotOid &&
          snapAfterShutdown.stagedDivergentFiles.length === 0,
      );
      const branchStillMatches =
        !input.expectedBranchOid ||
        !branchOidAfterShutdown ||
        branchOidAfterShutdown === input.expectedBranchOid;
      if (!verified || !snapshotStillMatches || !branchStillMatches) {
        this.host.emitChanged('worker:release-incomplete', dispatch.runId);
        return {
          dispatch: this.host.store.getDispatchContext(dispatch.id) ?? dispatch,
          closedPane,
          removedWorktree: false,
          removedBranch: false,
          worktreeError:
            'Worker workspace changed after shutdown or could not be verified; retained worktree and branch.',
        };
      }
    }

    let removedWorktree = false;
    let removedBranch = false;
    let worktreeError: string | undefined;
    if (worktreeToRemove) {
      if (dispatch.isDetachedReviewWorktree && repoRootPath) {
        const res = await removeDetachedReviewWorktree(repoRootPath, worktreeToRemove);
        removedWorktree = res.removed;
        if (!res.removed) {
          worktreeError = res.error || `Failed to remove detached review worktree: ${worktreeToRemove}`;
        }
      } else {
        const shouldDeleteBranch =
          !input.keepBranch &&
          Boolean(dispatch.ownsBranch && dispatch.branch?.startsWith(WORKER_BRANCH_PREFIX)) &&
          Boolean(dispatch.integrationStatus === 'merged' || input.force) &&
          (!integratedSnapshotOid || Boolean(input.expectedBranchOid));
        const res = await removeOwnedWorkerWorktree({
          worktreePath: worktreeToRemove,
          repoRootPath,
          // When integratedSnapshotOid has been verified after terminal shutdown, every uncommitted
          // tracked/untracked file in this worktree is already committed into the target branch.
          force: forceRemoveWorktree || Boolean(integratedSnapshotOid),
          deleteBranch: shouldDeleteBranch ? dispatch.branch : null,
          expectedBranchOid: input.expectedBranchOid ?? null,
          allowSquashCasDelete: Boolean(integratedSnapshotOid && input.expectedBranchOid),
        });
        removedWorktree = res.removed;
        removedBranch = res.removedBranch;
        if (!res.removed) {
          worktreeError = `Worktree was not removed: ${worktreeToRemove}`;
        }
      }
    }

    for (const id of this.host.store.listDispatchAncestorIds(dispatch.id)) this.host.store.cleanupDispatchBrief(id);
    if (worktreeToRemove && !removedWorktree) {
      // Do NOT mark releasedAt when worktree deletion failed so cleanup remains retryable and honest.
      this.host.emitChanged('worker:release-incomplete', dispatch.runId);
      return {
        dispatch: this.host.store.getDispatchContext(dispatch.id) ?? dispatch,
        closedPane,
        removedWorktree: false,
        removedBranch,
        worktreeError,
      };
    }

    const released = this.host.store.markDispatchReleased(dispatch.id, {
      keepPane: !closedPane,
      keepWorktree: !removedWorktree,
    });
    this.host.emitChanged('worker:released', released.runId);
    return { dispatch: released, closedPane, removedWorktree, removedBranch };
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
    const dispatch = this.host.store.resolveDispatchLineage(rawTarget.id) ?? rawTarget;
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

    const lineageIds = new Set(this.host.store.listDispatchAncestorIds(dispatch.id));

    const stoppedHelperIds: string[] = [];
    const childSeedDispatches = this.host.store
      .listDispatches({ runId: dispatch.runId })
      .filter((child) => Boolean(child.creatorDispatchId && lineageIds.has(child.creatorDispatchId)));

    for (const seed of childSeedDispatches) {
      const child = this.host.store.resolveDispatchLineage(seed.id) ?? seed;
      if (visitedDispatchIds.has(child.id) || child.releasedAt) continue;
      if (child.retained && !input.force) continue;
      if (!ACTIVE_DISPATCH_STATUSES.has(child.status) && !child.ownsPane &&
          !this.codexWorkers.has(child.assigneeHandle)) continue;
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

    const headless = dispatch.executionMode === 'codex-app-server';
    const codex = this.codexWorkers.get(dispatch.assigneeHandle);
    const shouldClosePane = !headless && Boolean(paneId && (dispatch.ownsPane || input.force));
    if (shouldClosePane) await this.confirmWorkerPaneClosed(paneId);

    this.host.approvals.cancelForDispatch(dispatch.id, input.reason || 'Worker stopped');
    this.host.nativeQuestions.cancelForDispatch(dispatch.id, input.reason || 'Worker stopped');
    if (!headless && paneId) {
      this.host.turnStopMonitor.cancelForPane(paneId);
      if (this.host.terminalTracker) {
        const transcript = this.host.terminalTracker.readFullTranscript(paneId);
        if (transcript) {
          this.host.store.archiveDispatchOutput(dispatch.id, transcript);
        }
      }
    }

    let settled = dispatch;
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      this.host.store.deleteDeferredDispatchPrompt(dispatch.id);
      this.host.waiters.cancel(`dispatch:${dispatch.id}`);
      this.host.waiters.notifyPrefix(`question:${dispatch.id}:`, 'status');
      settled = this.host.store.failDispatch(dispatch.id, 'worker_stopped', {
        forceFailTask: true,
        summary: input.reason?.trim() || 'Worker stopped by coordinator',
      });
      if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
        this.host.store.updateDispatchReviewState(dispatch.id, { reviewStatus: 'rejected' });
        this.host.review.reconcileAnyReviewBatch(dispatch.id, {
          overrideVerdict: 'reject',
          failedReason: 'Reviewer stopped before completing verification',
        });
      }
    } else {
      this.host.store.updateDispatchStage(dispatch.id, 'stopped');
      settled = this.host.store.getDispatchContext(dispatch.id) ?? settled;
    }

    if (codex) {
      this.host.archiveWorkerTimeline(dispatch.assigneeHandle, dispatch.id);
      await codex.close(true);
    }

    let closedPane = false;
    if (shouldClosePane) {
      this.host.spawnedWorkerPanes.delete(paneId);
      this.host.spawnedWorkerMeta.delete(paneId);
      this.host.markPtyExited(paneId);
      closedPane = true;
      this.host.emitPaneClosed({
        ptyId: paneId,
        runId: dispatch.runId,
        taskId: dispatch.taskId,
        dispatchId: dispatch.id,
      });
    }

    const repoRootPath =
      dispatch.repoRootPath ??
      (dispatch.parentPaneId
        ? this.host.terminalTracker?.getTerminal(dispatch.parentPaneId)?.cwd ??
          this.host.sessionCoordinator(dispatch.parentPaneId)?.cwd
        : undefined) ??
      this.host.getDefaultCwd?.() ??
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

    for (const id of lineageIds) this.host.store.cleanupDispatchBrief(id);
    this.host.emitChanged('worker:stopped', settled.runId);
    return {
      dispatch: this.host.store.getDispatchContext(settled.id) ?? settled,
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
    const dispatch = this.host.store.resolveDispatchLineage(rawTarget.id) ?? rawTarget;
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const headless = dispatch.executionMode === 'codex-app-server';
    const codex = headless ? this.codexWorkers.get(dispatch.assigneeHandle) : undefined;
    if (codex) this.archiveCodexOutput(codex, dispatch.id);

    this.host.approvals.cancelForDispatch(dispatch.id, input.reason || 'Worker abandoned');
    this.host.nativeQuestions.cancelForDispatch(dispatch.id, input.reason || 'Worker abandoned');
    if (codex) this.host.archiveWorkerTimeline(dispatch.assigneeHandle, dispatch.id);
    if (!headless && paneId) {
      this.host.turnStopMonitor.cancelForPane(paneId);
      if (this.host.terminalTracker) {
        const transcript = this.host.terminalTracker.readFullTranscript(paneId);
        if (transcript) {
          this.host.store.archiveDispatchOutput(dispatch.id, transcript);
        }
      }
    }

    let settled = dispatch;
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      this.host.store.deleteDeferredDispatchPrompt(dispatch.id);
      this.host.waiters.cancel(`dispatch:${dispatch.id}`);
      this.host.waiters.notifyPrefix(`question:${dispatch.id}:`, 'status');
      settled = this.host.store.failDispatch(dispatch.id, 'abandoned', {
        forceFailTask: true,
        summary: input.reason?.trim() || 'Worker dispatch abandoned by coordinator',
      });
      if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
        this.host.store.updateDispatchReviewState(dispatch.id, { reviewStatus: 'rejected' });
        this.host.review.reconcileAnyReviewBatch(dispatch.id, {
          overrideVerdict: 'reject',
          failedReason: 'Reviewer dispatch abandoned before completing verification',
        });
      }
    }
    if (codex) void codex.close(true);
    const warning = headless
      ? 'Dispatch abandoned; its headless Codex session has been retired.'
      : 'Dispatch abandoned in orchestration state without killing any external process; use worker-stop to terminate the PTY.';
    this.host.emitChanged('worker:abandoned', settled.runId);
    return {
      dispatch: this.host.store.getDispatchContext(settled.id) ?? settled,
      task: this.host.store.requireTask(settled.taskId),
      warning,
    };
  }

  hasCodexWorkers(): boolean {
    return this.codexWorkers.size > 0;
  }

  /** Closes every headless Worker session and waits for in-flight turn diffs. */
  async closeAllCodexWorkers(): Promise<void> {
    await Promise.all([
      ...[...this.codexWorkers.values()].map((codex) => codex.close(true)),
      ...this.pendingCodexTurnDiffs,
    ]);
  }
}
