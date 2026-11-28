import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { resolve as resolveFsPath } from 'node:path';
import { runGitCommand } from '../git/git-exec.js';
import type {
  AgentSessionDriver, AgentSessionEvents, AgentSessionPolicy, AgentTurnResult, TurnDelivery,
} from './agent-session-driver.js';
import { SESSION_WAKE_HEADER } from './coordinator-prompt.js';
import { AGENT_SESSION_ID } from './agent-session-manager.js';
import {
  HEADLESS_DRIVER_LABELS, HEADLESS_WORKER_ID, SESSION_GATED_COORDINATOR_ACTIONS, headlessWorkerControlsError,
  headlessWorkerDriver, headlessWorkerSupports, isHeadlessWorkerDriver, sessionGateDecision, type HeadlessWorkerDriver,
} from './headless-workers.js';
import { driverCapabilities } from '../agent-drivers/driver-capabilities.js';
import { WorkerNativeQuestionManager } from './worker-native-questions.js';
import { formatActionReceiptText } from './orchestration-text-views.js';
import { OrchestrationBoardService, type BoardPostInput } from './board-service.js';
import { OrchestrationReviewService } from './review-service.js';
import {
  WorkerTimeline, type WorkerTimelineChange, type WorkerTimelineSnapshot, type WorkerTimelineTurnStatus,
} from './worker-timeline.js';
import type { PtyWriteFn } from '../agent/agent-prompt-delivery.js';
import type { AgentPaneStatus, AgentStatusStore } from '../agent/agent-status-store.js';
import { getGitStatus } from '../git/git-service.js';
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
  formatMessageBanner,
  reportFollowUpAction,
} from './orchestration-messaging.js';
import { OrchestrationStore } from './orchestration-store.js';
import {
  DEFAULT_MAX_ACTIVE_WORKERS,
  DEFAULT_NESTED_WORKER_MAX_DEPTH,
  ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS,
  OrchestrationError,
  type OrchestrationAgentRosterEntry,
  type OrchestrationBoardPostKind,
  type OrchestrationConfirmMode,
  type OrchestrationCoordinatorRunRecord,
  type OrchestrationCoordinatorStatusResult,
  type OrchestrationDispatchProposal,
  type OrchestrationDispatchRecord,
  type OrchestrationDispatchStage,
  type OrchestrationExposedMessage,
  type OrchestrationGateRecord,
  type OrchestrationGateStatus,
  type OrchestrationMessagePriority,
  type OrchestrationMessageRecord,
  type OrchestrationMessageType,
  type OrchestrationPeerMessagingMode,
  type OrchestrationQuestionRecord,
  type OrchestrationReportArtifacts,
  type OrchestrationReviewFinding,
  type OrchestrationReviewVerdict,
  type OrchestrationRunRecord,
  type OrchestrationSnapshot,
  type OrchestrationTaskContext,
  type OrchestrationTaskKind,
  type OrchestrationTaskRecord,
  type OrchestrationTaskShowResult,
  type OrchestrationTaskStatus,
  type OrchestrationTaskWithDispatch,
  type OrchestrationWorkerReportOutcome,
  type WorkerApprovalPayload,
  type WorkerNativeQuestionPayload,
} from './orchestration-types.js';
import {
  PeerPingPongTracker,
  collectWorkerReportArtifacts,
  formatBoardPostForAgent,
  boardLookupCommands,
  parseBoardRefs,
} from './board-protocol.js';
import { BoardStallWatchdog } from './stall-watchdog.js';
import {
  DispatchProposalManager,
  type DispatchProposalOverrides,
  type UserTurnSource,
} from './dispatch-proposals.js';
import {
  PermissionApprovalManager,
  type PermissionHookInterceptInput,
} from './permission-approvals.js';
import {
  buildDispatchPreamble,
  buildDispatchPreambleWithBrief,
  type BuildDispatchPreambleInput,
} from './worker-dispatch-preamble.js';
import {
  mergeTaskContext,
  normalizeTaskContext,
  type SharedRunBoardPostSummary,
  type SharedRunContext,
  type SharedRunPeerSummary,
} from './worker-brief-context.js';
import { normalizeWorkerCliId, resolveWorkerLaunchConfig } from './worker-launch-catalog.js';
import { WorkerTurnStopMonitor } from './worker-turn-stops.js';
import {
  buildAdversarialReviewTask,
  buildRunAdversarialReviewTask,
  evaluateAdversarialVerdict,
  formatReviewVerdictForBoard,
  MAX_ADVERSARIAL_REVIEW_ROUNDS,
  normalizeReviewFindings,
  type RunIntegratedWorkerSummaryForReview,
} from './adversarial-review.js';
import {
  captureWorkerSnapshotOid,
  createDetachedReviewWorktree,
  detectReviewWorktreeMutation,
  finalizeRunIntegrationBranch,
  inspectCommitRangeDiff,
  inspectWorkerDiff,
  integrateWorkerChanges,
  integrateWorkerIntoRunBranch,
  isGitCommitAncestor,
  isSameGitRepo,
  removeDetachedReviewWorktree,
  resolveBranchRefOid,
  resolveIntegrationMergeBase,
  resolveMainRepoRoot,
  resolveTargetSymbolicRef,
  type RunCommitRangeDiffInspection,
  type RunFinalizeIntegrationResult,
  type WorkerDiffInspection,
  type WorkerIntegrateMode,
  type WorkerIntegrateTargetBranch,
  type WorkerIntegrationResult,
} from './worker-git-integration.js';
import {
  assertWorkerWorktreeClean,
  prepareWorkerWorktreePlacement,
  removeOwnedWorkerWorktree,
  WORKER_BRANCH_PREFIX,
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
  displayName?: string | null;
  taskTitle?: string;
  /** Set for app-server Workers: ptyId is the headless worker handle, not a terminal. */
  headless?: boolean;
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
  openNativeQuestions: WorkerNativeQuestionPayload[];
  terminal: TerminalSummary | null;
}

export interface OrchestrationAgentSelectionResult {
  cliId: string;
  reason: string;
  model: string | null;
  effort: string | null;
  idlePaneId: string | null;
  fallbacks: string[];
}

export type OrchestrationDelegateTaskResult =
  | { status: 'queued'; task: OrchestrationTaskRecord; message: string; proposal?: undefined }
  | {
      status: 'confirmation_required';
      proposal: OrchestrationDispatchProposal;
      message: string;
    }
  | {
      status: 'rejected';
      proposal: OrchestrationDispatchProposal;
      message: string;
    }
  | {
      status: 'started';
      role: string;
      agent: string;
      selectionReason: string;
      fallbackFrom: string | null;
      dispatch: OrchestrationDispatchRecord;
      task: OrchestrationTaskRecord;
      run: OrchestrationRunRecord;
      ptyId: string | null;
      worktreePath: string | null;
      branch: string | null;
      briefBoardSeq?: number;
    };

export interface OrchestrationMcpWorkerBrief {
  dispatchId: string;
  taskId: string;
  role: string;
  cliId: string | null;
  stage: OrchestrationDispatchStage;
  status: OrchestrationDispatchRecord['status'];
  ptyId: string | null;
  paneAlive: boolean;
  worktreePath: string | null;
  branch: string | null;
  openApprovalCount: number;
  openQuestionCount: number;
}

export interface OrchestrationMcpContext {
  ptyId: string;
  role: 'worker' | 'coordinator';
  orchestrationMode: boolean;
  confirmMode: OrchestrationConfirmMode;
  activeDispatch: OrchestrationDispatchRecord | null;
  canDelegate: boolean;
  roster: OrchestrationAgentRosterEntry[];
  workers: OrchestrationMcpWorkerBrief[];
  pendingProposals: OrchestrationDispatchProposal[];
}

/** Agent sessions (no PTY) that a person switched into orchestration mode to act as Coordinators. */
export interface OrchestrationSessionCoordinators {
  /**
   * `active`: the session exists, is in orchestration mode, and has not closed or failed.
   * `idle`: active, between turns, and not waiting on the person.
   * `network`: whether sandboxed commands in this session may reach the network.
   */
  get(sessionId: string): {
    cwd: string; provider: string; active: boolean; idle?: boolean; network?: boolean;
    /** The policy the session's provider process was launched with. */
    policy?: AgentSessionPolicy;
  } | null;
  /**
   * Asks the person, inside the session's running turn, to allow an orchestration action; resolves
   * false when declined. Omitted means actions that need the person are refused.
   */
  requestApproval?(sessionId: string, request: { method: string; toolInput: string; message?: string }, signal: AbortSignal): Promise<boolean>;
  /** Starts a system turn (never counted as the person's message); omitted means sessions are never woken. */
  wake?(sessionId: string, prompt: string): Promise<TurnDelivery>;
}

/** A headless Worker's permission tier, network access, and whether it may start sub-Workers. */
export interface HeadlessWorkerControls {
  policy: AgentSessionPolicy;
  network: boolean;
  allowSubWorkers: boolean;
}

/** How a headless Worker process is launched; sub-Worker tools are fixed for the life of the process. */
export type HeadlessWorkerLaunchOptions = HeadlessWorkerControls;

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
  codexPilot?: {
    enabled: () => boolean;
    launch: (workerId: string, cwd: string, events: AgentSessionEvents, options?: HeadlessWorkerLaunchOptions) => AgentSessionDriver;
  };
  /**
   * Headless Workers for the other `HEADLESS_WORKER_DRIVERS` (Codex uses `codexPilot`), launched
   * with the Worker's own Aha MCP credentials. Only session-coordinated runs use them.
   */
  headlessWorkers?: {
    /** Whether the driver's CLI can be launched here; false keeps its tasks in a terminal. */
    available?: (cliId: Exclude<HeadlessWorkerDriver, 'codex'>) => boolean;
    launch: (
      cliId: Exclude<HeadlessWorkerDriver, 'codex'>, workerId: string, cwd: string, events: AgentSessionEvents,
      options: HeadlessWorkerLaunchOptions,
    ) => AgentSessionDriver;
  };
  closeWorkerPty?: (ptyId: string) => Promise<unknown> | unknown;
  isPtyAlive?: (ptyId: string) => boolean;
  /** Whether an id names an agent CLI (not a plain shell); auto-spawned workers must be agents. */
  isAgentCliId?: (cliId: string) => boolean;
  terminalTracker?: TerminalRuntimeTracker;
  getDefaultCwd?: () => string | undefined;
  listCodingAgents?: (opts?: {
    callerPaneId?: string | null;
    includeIdlePanes?: boolean;
  }) => OrchestrationAgentRosterEntry[];
  selectAgentForTask?: (opts: {
    roster: readonly OrchestrationAgentRosterEntry[];
    requestedAgent?: string | null;
    taskKind?: OrchestrationTaskKind | null;
    coordinatorCliId?: string | null;
    authorCliId?: string | null;
    authorCliIds?: readonly string[];
    excludeCliIds?: readonly string[];
    preferIdle?: boolean;
  }) => OrchestrationAgentSelectionResult;
  getConfirmMode?: () => OrchestrationConfirmMode;
  getDefaultWorktree?: () => boolean;
  getPeerMessagingMode?: () => OrchestrationPeerMessagingMode;
  isMcpEnabledForCli?: (cliId: string) => boolean;
  proposalHoldTimeoutMs?: number;
  proposalTtlMs?: number;
  stallWatchdogIntervalMs?: number;
  stallThresholdMs?: number;
  cliCommand?: string;
  briefsDir?: string | null;
  maxDepth?: number;
  /** Simultaneously active workers across all runs (default 8). */
  maxActiveWorkers?: number;
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
  /** Optional safety timeout for native Worker questions; 0 (default) waits for the person. */
  nativeQuestionHoldTimeoutMs?: number;
  now?: () => number;
}

export interface SettledWorkerFollowUpInput {
  from?: string;
  to: string;
  type?: OrchestrationMessageType;
  priority?: OrchestrationMessagePriority;
  subject: string;
  body?: string;
  payload?: string | Record<string, unknown> | null;
  runId?: string;
  threadId?: string;
  fromRole?: string;
  mentions?: readonly string[];
  refs?: readonly number[];
  kind?: OrchestrationBoardPostKind;
  existingMessage?: OrchestrationMessageRecord;
}

export class OrchestrationService {
  readonly store: OrchestrationStore;
  readonly waiters: RuntimeMessageWaiters;
  readonly pointerDelivery: MailboxPointerDelivery;
  readonly approvals: PermissionApprovalManager;
  readonly nativeQuestions: WorkerNativeQuestionManager;
  readonly proposals: DispatchProposalManager;
  readonly peerPingPong = new PeerPingPongTracker();
  readonly stallWatchdog: BoardStallWatchdog;
  private readonly turnStopMonitor: WorkerTurnStopMonitor;
  private readonly board: OrchestrationBoardService;
  private readonly review: OrchestrationReviewService;

  private readonly agentStatusStore: AgentStatusStore;
  private readonly writePty: PtyWriteFn;
  private readonly spawnWorkerPty?: OrchestrationServiceDependencies['spawnWorkerPty'];
  private readonly codexPilot?: OrchestrationServiceDependencies['codexPilot'];
  private readonly headlessWorkers?: OrchestrationServiceDependencies['headlessWorkers'];
  private readonly codexWorkers = new Map<string, AgentSessionDriver>();
  /** Live per-Worker controls; the next turn of that Worker runs with them. */
  private readonly codexWorkerControls = new Map<string, HeadlessWorkerControls>();
  private readonly pendingCodexTurnDiffs = new Set<Promise<void>>();
  private sessionCoordinators: OrchestrationSessionCoordinators | null = null;
  private readonly codexSubmitting = new Set<string>();
  /** Pending wake-ups per headless Worker; `opaque` means at least one wake carried no message record. */
  private readonly codexMailbox = new Map<string, { messages: OrchestrationMessageRecord[]; opaque: boolean }>();
  private readonly workerTimelines = new Map<string, WorkerTimeline>();
  private readonly timelineListeners = new Set<(change: WorkerTimelineChange) => void>();
  private disposed = false;
  private queueSweepScheduled = false;
  private readonly claimedLaunches = new Map<string, symbol>();
  private readonly closeWorkerPty?: OrchestrationServiceDependencies['closeWorkerPty'];
  private readonly externalIsPtyAlive?: (ptyId: string) => boolean;
  private readonly isAgentCliId?: (cliId: string) => boolean;
  private readonly terminalTracker?: TerminalRuntimeTracker;
  private readonly getDefaultCwd?: () => string | undefined;
  private readonly listCodingAgentsDep?: OrchestrationServiceDependencies['listCodingAgents'];
  private readonly selectAgentForTaskDep?: OrchestrationServiceDependencies['selectAgentForTask'];
  private readonly getConfirmModeDep?: () => OrchestrationConfirmMode;
  private readonly getDefaultWorktreeDep?: () => boolean;
  private readonly getPeerMessagingModeDep?: () => OrchestrationPeerMessagingMode;
  private readonly isMcpEnabledForCliDep?: (cliId: string) => boolean;
  private readonly orchestrationModePanes = new Set<string>();
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
  private readonly runIntegrationLocks = new Map<string, Promise<void>>();
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
    this.codexPilot = deps.codexPilot;
    this.headlessWorkers = deps.headlessWorkers;
    this.closeWorkerPty = deps.closeWorkerPty;
    this.externalIsPtyAlive = deps.isPtyAlive;
    this.isAgentCliId = deps.isAgentCliId;
    this.terminalTracker = deps.terminalTracker;
    this.getDefaultCwd = deps.getDefaultCwd;
    this.listCodingAgentsDep = deps.listCodingAgents;
    this.selectAgentForTaskDep = deps.selectAgentForTask;
    this.getConfirmModeDep = deps.getConfirmMode;
    this.getDefaultWorktreeDep = deps.getDefaultWorktree;
    this.getPeerMessagingModeDep = deps.getPeerMessagingMode;
    this.isMcpEnabledForCliDep = deps.isMcpEnabledForCli;
    this.cliCommand = deps.cliCommand ?? 'aha';
    if (deps.briefsDir?.trim()) this.store.configureBriefsDir(deps.briefsDir.trim());
    this.maxDepth = deps.maxDepth ?? DEFAULT_NESTED_WORKER_MAX_DEPTH;
    this.store.configureMaxActiveDispatches(deps.maxActiveWorkers ?? DEFAULT_MAX_ACTIVE_WORKERS);
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

    const svc = this;
    this.review = new OrchestrationReviewService({
      emitChanged: (...args) => this.emitChanged(...args),
      failTaskIfReady: (...args) => this.failTaskIfReady(...args),
      resolveRoleNameForDispatch: (...args) => this.resolveRoleNameForDispatch(...args),
      get store() { return svc.store; },
    });
    this.board = new OrchestrationBoardService({
      get agentStatusStore() { return svc.agentStatusStore; },
      get approvals() { return svc.approvals; },
      get clock() { return svc.clock; },
      deliverCodexMailbox: (...args) => this.deliverCodexMailbox(...args),
      deriveLiveStage: (...args) => this.deriveLiveStage(...args),
      emitChanged: (...args) => this.emitChanged(...args),
      followUpSettledWorker: (...args) => this.followUpSettledWorker(...args),
      get getPeerMessagingModeDep() { return svc.getPeerMessagingModeDep; },
      getReviewFirewallContext: (...args) => this.review.getReviewFirewallContext(...args),
      inferRunIdOptional: (...args) => this.inferRunIdOptional(...args),
      isPostHiddenByReviewFirewall: (...args) => this.review.isPostHiddenByReviewFirewall(...args),
      get nativeQuestions() { return svc.nativeQuestions; },
      get peerPingPong() { return svc.peerPingPong; },
      get pointerDelivery() { return svc.pointerDelivery; },
      get proposals() { return svc.proposals; },
      queueCodexMail: (...args) => this.queueCodexMail(...args),
      resolveRoleNameForDispatch: (...args) => this.resolveRoleNameForDispatch(...args),
      sessionCoordinator: (...args) => this.sessionCoordinator(...args),
      get store() { return svc.store; },
      toWorkerSummary: (...args) => this.toWorkerSummary(...args),
      get waiters() { return svc.waiters; },
    });
    this.waiters = new RuntimeMessageWaiters();
    this.pointerDelivery = new MailboxPointerDelivery({
      onReceipt: runId => this.emitChanged('board:delivery', runId),
      store: this.store,
      waiters: this.waiters,
      agentStatusStore: this.agentStatusStore,
      writePty: this.writePty,
      isPaneAlive: (ptyId) => this.isPaneAlive(ptyId),
      isMcpEnabledForPane: (ptyId) => this.isMcpEnabledForPane(ptyId),
      resolveMemberKeyForPane: (ptyId) => this.board.resolveBoardMemberForPane(ptyId),
      findPendingBoardPostsForPane: (ptyId) => this.board.findUndeliveredBoardPostsForPane(ptyId),
      shouldDeliverMessageToPane: (msg, ptyId) => {
        const member = this.board.resolveBoardMemberForPane(ptyId);
        if (!member || member.runId !== msg.runId) return true;
        const firewall = this.review.getReviewFirewallContext(ptyId);
        if (firewall && this.review.isPostHiddenByReviewFirewall(msg, firewall)) return false;
        if (this.store.wasBoardPostRead(msg.id, member.memberKey)) return false;
        if (!msg.kind) return true;
        return this.board.doesBoardPostWakeMember(
          msg,
          member.role,
          ptyId,
          member.runId,
          member.dispatchId
        );
      },
      formatDirectDeliveryText: (msgs) => {
        if (msgs.length === 0 || msgs.length > 2) return null;
        const rendered = msgs.map((m) => formatBoardPostForAgent(m)).join('\n\n');
        return rendered.length <= 1000 ? rendered : null;
      },
      turnTarget: (id) => this.sessionWakeTarget(id),
      cliCommand: this.cliCommand,
    });

    this.approvals = new PermissionApprovalManager({
      store: this.store,
      agentStatusStore: this.agentStatusStore,
      notifyMailbox: (mailbox, type) => this.notifyTargetAndAliases(mailbox, type),
      onChanged: (reason, runId) => this.emitChanged(reason, runId),
      onApprovalChanged: (approval) => this.timelineApproval(approval),
      resolveRoleName: (dispatch) => this.resolveRoleNameForDispatch(dispatch) || null,
      cliCommand: this.cliCommand,
      holdTimeoutMs: deps.approvalHoldTimeoutMs,
      now: this.clock,
    });

    this.nativeQuestions = new WorkerNativeQuestionManager({
      store: this.store,
      hasOpenApprovalForDispatch: (dispatchId) => this.approvals.hasOpenApprovalForDispatch(dispatchId),
      onChanged: (reason, runId) => this.emitChanged(reason, runId),
      onAnswered: (payload, answers) => this.timelineNativeQuestionAnswered(payload, answers),
      holdTimeoutMs: deps.nativeQuestionHoldTimeoutMs,
      now: this.clock,
    });

    this.proposals = new DispatchProposalManager({
      onChanged: (reason, runId) => this.emitChanged(reason, runId),
      holdTimeoutMs: deps.proposalHoldTimeoutMs,
      proposalTtlMs: deps.proposalTtlMs,
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
      resolveRoleName: (dispatch) => this.resolveRoleNameForDispatch(dispatch) || null,
      notifyMailbox: (mailbox, type) => this.notifyTargetAndAliases(mailbox, type),
      onTurnStopEscalated: (_dispatchId, runId, stopReason) => {
        if (stopReason === 'exited') this.review.settleUnreportedReviewDispatches();
        this.emitChanged('worker:turn-stopped', runId);
      },
      cliCommand: this.cliCommand,
      settleMs: deps.turnStopSettleMs,
    });

    this.stallWatchdog = new BoardStallWatchdog({
      intervalMs: deps.stallWatchdogIntervalMs ?? 0,
      stallThresholdMs: deps.stallThresholdMs,
      now: this.clock,
      inspectRuns: () => this.board.inspectRunsForStallWatchdog(),
      onStallDetected: (runId, headSeq, idleMs) =>
        this.board.handleBoardStallDetected(runId, headSeq, idleMs),
    });
    if ((deps.stallWatchdogIntervalMs ?? 0) > 0) {
      this.stallWatchdog.start();
    }

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

    void this.recoverGitPublications().catch(error => console.warn('[orchestration] Git recovery:', error)).finally(() => this.scheduleQueuedLaunches());
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
    this.proposals.cancelForPane(ptyId);
    const removedMode = this.orchestrationModePanes.delete(ptyId);
    this.turnStopMonitor.notifyPaneExited(ptyId);
    this.pointerDelivery.retirePane(ptyId);
    this.waiters.cancel(ptyId);
    this.waiters.cancelConsumer(ptyId);
    for (const [dispatchId, deferred] of this.store.listDeferredDispatchPrompts()) {
      if (deferred.ptyId === ptyId) {
        this.store.deleteDeferredDispatchPrompt(dispatchId);
        this.store.cleanupDispatchBrief(dispatchId);
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
        this.store.cleanupDispatchBrief(dispatch.id);
        this.waiters.cancel(`dispatch:${dispatch.id}`);
        this.waiters.notifyPrefix(`question:${dispatch.id}:`, 'status');
      }
    }
    if (removedMode) {
      this.emitChanged('pane-mode:changed');
    }
  }

  setSessionCoordinators(registry: OrchestrationSessionCoordinators | null): void {
    this.sessionCoordinators = registry;
    this.scheduleQueuedLaunches();
  }

  /** An Agent session left orchestration mode or closed: drop what was waiting on it as Coordinator. */
  endSessionCoordinator(sessionId: string): void {
    if (!AGENT_SESSION_ID.test(sessionId)) return;
    this.approvals.cancelForPane(sessionId);
    this.proposals.cancelForPane(sessionId);
    this.waiters.cancel(sessionId);
    this.waiters.cancelConsumer(sessionId);
    this.pointerDelivery.retirePane(sessionId);
    this.emitChanged('pane-mode:changed');
  }

  /** An orchestrating session finished a turn: deliver what arrived for it meanwhile. */
  sessionCoordinatorIdle(sessionId: string): void {
    this.scheduleQueuedLaunches();
    if (this.isActiveSessionCoordinator(sessionId)) this.pointerDelivery.scheduleRedriveForPane(sessionId);
  }

  private sessionCoordinator(id: string): ReturnType<OrchestrationSessionCoordinators['get']> {
    return AGENT_SESSION_ID.test(id) ? this.sessionCoordinators?.get(id) ?? null : null;
  }

  private sessionWakeTarget(id: string): { idle: boolean; startTurn: (prompt: string) => Promise<TurnDelivery> } | null {
    if (!AGENT_SESSION_ID.test(id)) return null;
    const wake = this.sessionCoordinators?.wake?.bind(this.sessionCoordinators);
    const state = this.sessionCoordinator(id);
    return {
      idle: Boolean(wake && state?.active && state.idle),
      startTurn: (prompt) => wake
        ? wake(id, `${SESSION_WAKE_HEADER}\n\n${prompt}`)
        : Promise.resolve({ status: 'not_accepted', reason: 'Agent sessions cannot be woken' }),
    };
  }

  /**
   * Applies the Codex approval rules to a non-Codex session Coordinator's actions that change
   * Workers or Git history. A Codex session prompts for these in its own app-server, so it passes.
   */
  async gateSessionCoordinatorAction(id: string, action: string, payload: Record<string, unknown>, signal: AbortSignal): Promise<void> {
    const state = this.sessionCoordinator(id);
    if (!state || state.provider === 'codex') return;
    const decision = sessionGateDecision(action, state.policy ?? 'workspace-write');
    if (decision === 'allow') return;
    const tool = SESSION_GATED_COORDINATOR_ACTIONS[action]!;
    if (decision === 'deny') {
      throw new OrchestrationError('operation_rejected', `${tool} needs the person's approval, which full-auto cannot ask for. Ask the person to run it, or to switch this session to another permission tier.`);
    }
    const request = this.sessionCoordinators?.requestApproval;
    const approved = request
      ? await request.call(this.sessionCoordinators, id, {
        method: `aha/${tool}`,
        toolInput: JSON.stringify(payload, null, 2).slice(0, 4_000),
        message: `协调者请求执行 ${tool}`,
      }, signal)
      : false;
    if (!approved) throw new OrchestrationError('operation_rejected', `The person declined ${tool}.`);
  }

  private isActiveSessionCoordinator(id: string): boolean {
    return this.sessionCoordinator(id)?.active ?? false;
  }

  /** Whether a caller owns a live surface (terminal pane or orchestrating Agent session) to bind runs to. */
  private isCallerSurface(id: string): boolean {
    return this.agentStatusStore.get(id) !== null || this.isActiveSessionCoordinator(id);
  }

  isAuthenticatedCallerActive(id: string, discoverTools = false, reporting = false): boolean {
    if (reporting && HEADLESS_WORKER_ID.test(id) && this.store.getActiveDispatchForIdentity(id, null)?.stage === 'needs_reconciliation') return true;
    if (AGENT_SESSION_ID.test(id)) return this.isActiveSessionCoordinator(id);
    return !HEADLESS_WORKER_ID.test(id) ||
      (this.isPaneAlive(id) && (discoverTools || Boolean(this.store.getActiveDispatchForIdentity(id, null))));
  }

  isPaneAlive(ptyId: string): boolean {
    if (HEADLESS_WORKER_ID.test(ptyId)) return this.codexWorkers.get(ptyId)?.alive ?? false;
    if (AGENT_SESSION_ID.test(ptyId)) return this.isActiveSessionCoordinator(ptyId);
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

  onWorkerTimelineChange(listener: (change: WorkerTimelineChange) => void): () => void {
    this.timelineListeners.add(listener);
    return () => this.timelineListeners.delete(listener);
  }

  /** Live timeline for a running headless Worker, else the archived copy on its dispatch. */
  getWorkerTimeline(input: { dispatchId?: string; workerHandle?: string }): WorkerTimelineSnapshot | null {
    const rawId = input.dispatchId?.trim().replace(/^dispatch:/, '');
    if (rawId) {
      const dispatch = this.store.getDispatchContext(rawId);
      if (!dispatch) throw new OrchestrationError('dispatch_not_found', `Dispatch not found: ${rawId}`);
      const live = this.workerTimelines.get(dispatch.assigneeHandle);
      if (live) return live.snapshot();
      const latest = this.store.resolveDispatchLineage(dispatch.id);
      return (latest ? this.store.getArchivedTimeline(latest.id) : null) ?? this.store.getArchivedTimeline(dispatch.id);
    }
    const handle = input.workerHandle?.trim();
    if (!handle) throw new OrchestrationError('invalid_argument', 'dispatchId or workerHandle is required.');
    const live = this.workerTimelines.get(handle);
    if (live) return live.snapshot();
    const archived = this.store.listDispatches()
      .filter((dispatch) => dispatch.assigneeHandle === handle && dispatch.archivedTimeline)
      .at(-1);
    return archived ? this.store.getArchivedTimeline(archived.id) : null;
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
    return { dispatch: this.store.getDispatchContext(dispatch.id) ?? dispatch, interrupted };
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
    const dispatch = this.store.resolveDispatchLineage(target.id) ?? target;
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
    const updated = this.store.updateDispatchWorkerControls(dispatch.id, {
      workerPolicy: next.policy, workerNetwork: next.network,
    }) ?? dispatch;
    this.workerTimelines.get(dispatch.assigneeHandle)?.setMeta({ policy: next.policy, network: next.network });
    this.emitChanged('worker:controls-updated', updated.runId);
    return { dispatch: updated, policy: next.policy, network: next.network };
  }

  /** A headless Worker's controls: live ones, else the dispatch record, else what legacy records imply. */
  private headlessControls(dispatch: OrchestrationDispatchRecord): HeadlessWorkerControls {
    const live = this.codexWorkerControls.get(dispatch.assigneeHandle);
    if (live) return live;
    const header = this.workerTimelines.get(dispatch.assigneeHandle)?.getHeader();
    return {
      policy: dispatch.workerPolicy ?? (header?.readOnly ? 'read-only' : 'workspace-write'),
      network: dispatch.workerNetwork ?? header?.network ?? false,
      allowSubWorkers: dispatch.allowSubWorkers === true,
    };
  }

  /** How `caller`'s dispatches are confirmed; headless Workers cannot confirm in chat, so they use UI cards. */
  private effectiveConfirmMode(caller: string): OrchestrationConfirmMode {
    const mode: OrchestrationConfirmMode = this.getConfirmModeDep?.() ?? 'chat-and-guard';
    return mode === 'chat-and-guard' && HEADLESS_WORKER_ID.test(caller.trim()) ? 'always-ui' : mode;
  }

  /**
   * Whether a headless Worker may call Coordinator actions to start and manage sub-Workers: its
   * active dispatch must have been allowed to, must not be a review, and must leave depth for one.
   */
  canHeadlessWorkerDelegate(workerId: string): boolean {
    if (!HEADLESS_WORKER_ID.test(workerId)) return false;
    const dispatch = this.store.getActiveDispatchForIdentity(workerId, null);
    return Boolean(dispatch && dispatch.allowSubWorkers === true && !dispatch.reviewOfDispatchId &&
      !dispatch.reviewOfRunId && !dispatch.releasedAt && dispatch.depth < this.maxDepth);
  }

  private timelineNativeQuestionAnswered(payload: WorkerNativeQuestionPayload, answers: Record<string, string[]>): void {
    const timeline = this.workerTimelines.get(payload.workerHandle);
    if (!timeline) return;
    const text = payload.questions
      .map((question) => `${question.header || question.prompt}：${(answers[question.id] ?? []).join('、')}`)
      .join('\n');
    timeline.apply({ type: 'notice', id: `answer:${payload.requestId}`, level: 'info', text: `已回答提问\n${text}` });
  }

  answerWorkerNativeQuestion(input: {
    id: string;
    dispatchId?: string;
    answers: Record<string, string[]> | null;
    from?: string;
  }): { question: WorkerNativeQuestionPayload } {
    return this.nativeQuestions.answer(input);
  }

  private createWorkerTimeline(
    workerId: string, cliId: HeadlessWorkerDriver, model: string | null,
    controls: { policy: AgentSessionPolicy; network: boolean }, redact: (text: string) => string,
  ): WorkerTimeline {
    const timeline = new WorkerTimeline({
      workerHandle: workerId, cliId, model, readOnly: controls.policy === 'read-only',
      policy: controls.policy, network: controls.network,
      redact: (text) => this.store.redactDispatchCredentials(redact(text)),
      now: this.clock,
      onPatch: (change) => {
        for (const listener of this.timelineListeners) {
          try {
            listener(change);
          } catch (error) {
            console.warn('[orchestration] worker timeline listener failed:', error);
          }
        }
      },
    });
    this.workerTimelines.set(workerId, timeline);
    return timeline;
  }

  private archiveWorkerTimeline(workerId: string, dispatchId: string | null | undefined): void {
    const timeline = this.workerTimelines.get(workerId);
    if (timeline && dispatchId) this.store.archiveDispatchTimeline(dispatchId, timeline.archive());
  }

  private timelineApproval(approval: WorkerApprovalPayload): void {
    const timeline = this.workerTimelines.get(approval.workerHandle);
    if (!timeline) return;
    timeline.upsertApproval({
      approvalId: approval.approvalId,
      dispatchId: approval.dispatchId,
      method: approval.eventName,
      tool: approval.toolName,
      input: approval.toolInput,
      reason: approval.message ?? null,
      status: approval.status,
      resolution: approval.status === 'pending' ? null : approval.reason,
    });
  }
  onPaneClosed(listener: (event: OrchestrationPaneClosedEvent) => void): () => void {
    this.paneClosedListeners.add(listener);
    return () => this.paneClosedListeners.delete(listener);
  }

  private async recoverGitPublications(onlyRunId?: string): Promise<void> {
    for (const run of this.store.listRuns()) {
      if (onlyRunId && run.id !== onlyRunId) continue;
      const intent = run.integrationIntent;
      if (!intent) continue;
      await this.withRunIntegrationLock(run.id, async () => {
        const current = this.store.requireRun(run.id).integrationIntent;
        if (current?.commit !== intent.commit) return;
        const head = await resolveBranchRefOid(intent.repo, intent.target);
        if (!head || !await isGitCommitAncestor(intent.repo, intent.commit, head)) return;
        if (intent.dispatchId) {
          this.store.updateDispatchIntegrationState(intent.dispatchId, { integrationStatus: 'merged',
            integratedCommit: intent.commit, integratedTargetBranch: intent.target, noChanges: intent.commit === intent.before });
          this.store.updateRunIntegrationState(run.id, {
            ...(intent.baseBranch ? { integrationStatus: 'active', integrationBranch: intent.target,
              integrationWorktreePath: intent.worktree, integrationBaseBranch: intent.baseBranch,
              integrationBaseCommit: intent.baseCommit, integrationRepoRootPath: intent.repo } : {}),
            integrationHeadCommit: intent.commit, integrationIntent: null,
          });
        } else if (intent.members) {
          this.store.updateRunIntegrationState(run.id, { integrationStatus: 'finalized', finalizedCommit: intent.commit,
            integrationHeadCommit: intent.commit, integrationIntent: null, finalizedBatch: {
              branch: intent.target, sourceHead: intent.sourceHead, targetCommit: intent.commit, members: intent.members,
            },
            integrationBranch: await resolveBranchRefOid(intent.repo, run.integrationBranch) ? run.integrationBranch : null,
            integrationWorktreePath: run.integrationWorktreePath && existsSync(run.integrationWorktreePath) ? run.integrationWorktreePath : null,
          });
        }
        this.emitChanged('run:integration-recovered', run.id);
      });
    }
  }

  async reconcilePublication(input: { runId: string; expectedCommit: string; acceptUnpublished?: boolean }): Promise<{ message: string }> {
    await this.recoverGitPublications(input.runId);
    return this.withRunIntegrationLock(input.runId, async () => {
      const run = this.store.requireRun(input.runId);
      const intent = run.integrationIntent;
      if (!intent) return { message: '已核对 Git 交付位置。' };
      if (intent.commit !== input.expectedCommit) throw new OrchestrationError('operation_rejected', '交付记录已更新，请重新查看。');
      const head = await resolveBranchRefOid(intent.repo, intent.target);
      if (input.acceptUnpublished && head === intent.before) {
        this.store.updateRunIntegrationState(run.id, { integrationIntent: null });
        this.emitChanged('run:publication-unapplied', run.id);
        return { message: '已确认目标分支仍在原提交；本次操作未标记为合入。' };
      }
      throw new OrchestrationError('operation_rejected', `需核对 ${intent.target}：当前 ${head ?? '无此分支'}，预期 ${intent.commit}，写入前 ${intent.before}。`);
    });
  }

  private scheduleQueuedLaunches(): void {
    if (this.disposed || this.queueSweepScheduled || !this.store.hasQueuedWork()) return;
    this.queueSweepScheduled = true;
    queueMicrotask(() => {
      this.queueSweepScheduled = false;
      if (this.disposed) return;
      for (const task of this.store.listTasks()) {
        if (!task.queuedLaunch || task.queuedLaunch.state !== 'waiting' || this.claimedLaunches.has(task.id)) continue;
        this.store.promoteReadyTasks(task.runId);
        if (this.store.getTask(task.id)?.status !== 'ready' || this.store.hasPendingGates(task.id) || task.codeDeps?.some(dep => !this.store.codeReady(dep))) continue;
        this.claimedLaunches.set(task.id, Symbol(task.id));
        void this.launchQueuedTask(task).catch(error => console.warn('[orchestration] queued launch:', error))
          .finally(() => this.claimedLaunches.delete(task.id));
      }
    });
  }

  private async launchQueuedTask(task: OrchestrationTaskRecord): Promise<void> {
    const q = task.queuedLaunch!;
    const run = this.store.requireRun(task.runId);
    if (run.integrationIntent || run.status !== 'active' || run.consumerGeneration !== q.coordinatorGeneration ||
        !this.isCallerSurface(q.from) || !this.isPaneAlive(q.from) || (run.coordinatorPaneId ?? run.coordinatorHandle) !== q.from ||
        this.store.getRemainingDispatchCapacity() < 1) return;
    this.store.setQueuedLaunch(task.id, { ...q, state: 'claimed' });
    try {
      await this.store.flushDurable();
      if (this.disposed || !this.isCallerSurface(q.from) || !this.isPaneAlive(q.from) ||
          this.store.requireRun(run.id).consumerGeneration !== q.coordinatorGeneration) {
        this.store.setQueuedLaunch(task.id, q);
        return;
      }
      this.assertRunCoordinator(run.id, q.from);
      if ((q.requiresPaneMode && !this.isPaneOrchestrationMode(q.from)) ||
          (q.authorizedNetwork !== undefined && q.authorizedNetwork !== Boolean(this.sessionCoordinator(q.from)?.network))) {
        throw new OrchestrationError('operation_rejected', '原协调者的编排或联网权限已改变，请恢复原设置再核对派发。');
      }
      await this.workerStart({
        taskId: task.id, runId: run.id, from: q.from, callerPaneId: q.callerPaneId,
        callerCwd: q.callerCwd, baseBranch: q.baseBranch, agent: q.agent, role: q.role, name: q.role,
        terminal: q.terminal, model: q.model, effort: q.effort, noWorktree: !q.worktree,
        taskKind: q.taskKind, mcpEnabled: this.isMcpEnabledForCliDep?.(q.agent),
        ...((q.taskKind === 'review' || q.taskKind === 'research') && q.policy === undefined ? { readOnly: true } : {}),
        ...(q.policy !== undefined ? { policy: q.policy } : {}),
        ...(q.network !== undefined ? { network: q.network } : {}),
        ...(q.allowSubWorkers ? { allowSubWorkers: true } : {}),
        ...(q.userInitiated ? { userInitiated: true } : {}),
      }, this.claimedLaunches.get(task.id));
      if (q.authorizeReviews) this.store.setRunAutoReviewAuthorized(run.id, true);
      this.store.setQueuedLaunch(task.id);
    } catch (error) {
      if (this.store.getLatestDispatchForTask(task.id)) this.store.setQueuedLaunch(task.id);
      else if (error instanceof OrchestrationError && error.code === 'worker_limit_reached') this.store.setQueuedLaunch(task.id, q);
      else this.store.setQueuedLaunch(task.id, { ...q, state: 'needs_reconciliation',
        reason: this.store.redactDispatchCredentials(error instanceof Error ? error.message : String(error)) });
    }
    this.emitChanged('task:queue-updated', run.id);
  }

  private emitChanged(reason: string, runId?: string): void {
    this.scheduleQueuedLaunches();
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

  private retireFinishedCodexWorkers(runId?: string): void {
    for (const [workerId, codex] of this.codexWorkers) {
      if (!codex.alive || !codex.latestTurnKey || this.store.getActiveDispatchForIdentity(workerId, null)) continue;
      const dispatch = this.store.getDispatchContext(codex.latestTurnKey);
      if (!dispatch || dispatch.retained || (runId && dispatch.runId !== runId)) continue;
      const run = this.store.getRun(dispatch.runId);
      if (run?.status === 'active') continue;
      this.archiveCodexOutput(codex, dispatch.id);
      this.archiveWorkerTimeline(workerId, dispatch.id);
      void codex.close(true);
    }
  }

  private retireFinishedSpawnedWorkers(runId?: string): void {
    this.retireFinishedCodexWorkers(runId);
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
    const paneId = input.paneId?.trim() || (this.isCallerSurface(handle) ? handle : null);
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
    takeOverQueue?: boolean;
    id: string;
    from?: string;
    paneId?: string;
  }): { run: OrchestrationRunRecord } {
    const handle = input.from?.trim() || 'coordinator';
    const paneId = input.paneId?.trim() || (this.isCallerSurface(handle) ? handle : null);
    if (input.takeOverQueue) {
      if (!paneId || !this.isCallerSurface(paneId) || !this.isPaneAlive(paneId)) throw new OrchestrationError('operation_rejected', '请选择活跃的协调者。');
      this.assertCanBindRunCoordinator(input.id, paneId);
    }
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
    if (input.takeOverQueue && paneId) {
      if (run.status === 'stopped') this.store.updateRunStatus(run.id, 'active');
      for (const task of this.store.listTasks({ runId: run.id })) {
        const q = task.queuedLaunch;
        if (!q || q.state !== 'waiting') continue;
        this.store.setQueuedLaunch(task.id, { ...q, from: paneId, callerPaneId: paneId,
          coordinatorGeneration: run.consumerGeneration });
      }
    }
    this.waiters.cancel(`run:${run.id}`);
    this.emitChanged('run:bound', run.id);
    return { run };
  }

  authorizeRunAccess(runId: string | undefined, callerPaneId: string): string {
    return this.board.resolveBoardCallerContext({ from: callerPaneId, runId }).runId;
  }

  assertRunCoordinator(runId: string, callerPaneId: string): void {
    const run = this.store.requireRun(runId);
    if (run.coordinatorPaneId !== callerPaneId) {
      throw new OrchestrationError('operation_rejected', 'Only this run’s coordinator may perform this action.');
    }
  }

  assertCanBindRunCoordinator(runId: string, callerPaneId: string): void {
    const run = this.store.requireRun(runId);
    const hasRunWorkerHistory = this.store
      .listDispatches({ runId: run.id })
      .some((d) => d.assigneePaneId === callerPaneId || d.assigneeHandle === callerPaneId);
    if (hasRunWorkerHistory) {
      throw new OrchestrationError(
        'operation_rejected',
        'A worker terminal assigned to a task in this run cannot become its coordinator.'
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

  private async withRunIntegrationLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.runIntegrationLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const tail = previous.then(() => current);
    this.runIntegrationLocks.set(runId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.runIntegrationLocks.get(runId) === tail) {
        this.runIntegrationLocks.delete(runId);
      }
    }
  }

  private isRunIntegrationBranchLive(run: OrchestrationRunRecord): boolean {
    return Boolean(
      (run.integrationStatus === 'active' || run.integrationStatus === 'conflict') &&
      run.integrationBranch &&
      run.integrationWorktreePath,
    );
  }

  private async resolveLiveTargetRepoForDispatch(
    run: OrchestrationRunRecord,
    mainRepoRoot: string,
  ): Promise<string> {
    if (
      this.isRunIntegrationBranchLive(run) &&
      run.integrationWorktreePath &&
      run.integrationRepoRootPath &&
      (await isSameGitRepo(mainRepoRoot, run.integrationRepoRootPath))
    ) {
      return run.integrationWorktreePath;
    }
    return mainRepoRoot;
  }

  private async resolveEffectiveWorkerDiffBase(
    run: OrchestrationRunRecord,
    dispatch: OrchestrationDispatchRecord,
    worktreePath: string,
    mainRepoRoot: string | null,
    snapshotOid: string | null,
  ): Promise<string | null> {
    const recordedBase = dispatch.baseCommit?.trim() || null;
    if (!mainRepoRoot || !snapshotOid) return recordedBase;
    const targetRepo = await this.resolveLiveTargetRepoForDispatch(run, mainRepoRoot);
    const normPath = (p: string) => {
      const r = resolveFsPath(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const isIsolatedWorktree =
      Boolean(dispatch.ownsWorktree) || normPath(worktreePath) !== normPath(targetRepo);
    if (!isIsolatedWorktree) return recordedBase;
    const liveMergeBase = await resolveIntegrationMergeBase(targetRepo, snapshotOid);
    return liveMergeBase ?? recordedBase;
  }

  private failTaskIfReady(taskId: string): void {
    // A task created for a worker that never started has nobody to run it; left `ready`, the
    // coordinator loop would later dispatch it as ordinary work (and a review outside its worktree).
    if (this.store.getTask(taskId)?.status === 'ready') {
      this.store.updateTaskStatus(taskId, 'failed');
    }
  }

  private resolveTargetRunForOperation(
    explicitRunId?: string | null,
    callerPaneId?: string,
    fallbackFrom?: string,
  ): OrchestrationRunRecord {
    const cleanRunId = explicitRunId?.trim() || undefined;
    if (callerPaneId !== undefined) {
      const runId = this.authorizeRunAccess(cleanRunId, callerPaneId);
      this.assertRunCoordinator(runId, callerPaneId);
      return this.store.requireRun(runId);
    }
    if (cleanRunId) {
      return this.store.requireRun(cleanRunId);
    }
    const inferred = this.inferRunIdOptional(fallbackFrom || 'coordinator');
    if (inferred) {
      return this.store.requireRun(inferred);
    }
    const activeRuns = this.store.listRuns({ status: 'active' });
    if (activeRuns.length === 1) {
      return activeRuns[0]!;
    }
    throw new OrchestrationError(
      'run_not_found',
      'No active run could be resolved. Specify runId explicitly.',
    );
  }

  private async resolveRunCombinedDiffTarget(
    run: OrchestrationRunRecord,
    opts?: { requireCleanIntegrationWorktree?: boolean },
  ): Promise<{
    hasChanges: boolean;
    mainRepoRoot: string | null;
    repoPath: string | null;
    branch: string | null;
    baseCommit: string | null;
    targetCommit: string | null;
    isActiveIntegrationBranch: boolean;
    integratedWorkers: RunIntegratedWorkerSummaryForReview[];
  }> {
    const integratedDispatches = this.store.listIntegratedDispatchesForRun(run.id);
    const integratedWorkers: RunIntegratedWorkerSummaryForReview[] = integratedDispatches.map((d) => {
      const t = this.store.getTask(d.taskId);
      return {
        dispatchId: d.id,
        role: this.resolveRoleNameForDispatch(d) || d.id,
        cliId: d.cliId ?? null,
        taskSpec: t?.spec ?? '',
        taskContext: t?.taskContext ?? null,
        integratedCommit: d.integratedCommit ?? null,
      };
    });

    const isActiveIntegrationBranch = this.isRunIntegrationBranchLive(run);

    if (isActiveIntegrationBranch) {
      const wtPath = run.integrationWorktreePath!;
      const branch = run.integrationBranch!;
      const mainRepoRoot =
        run.integrationRepoRootPath ??
        (await resolveMainRepoRoot(wtPath, this.getDefaultCwd?.() ?? null));
      if (opts?.requireCleanIntegrationWorktree) {
        const [status, ref] = await Promise.all([
          getGitStatus(wtPath),
          resolveTargetSymbolicRef(wtPath),
        ]);
        if (!status.ok || !status.isGitRepo) {
          throw new OrchestrationError(
            'worktree_failed',
            `Run integration worktree at ${wtPath} is missing or invalid.`,
          );
        }
        if (ref !== `refs/heads/${branch}`) {
          throw new OrchestrationError(
            'operation_rejected',
            `Run integration worktree is on ${ref ?? 'detached HEAD'} instead of refs/heads/${branch}.`,
          );
        }
        const dirty = status.entries.map((e) => e.path).filter((p): p is string => Boolean(p));
        if (dirty.length > 0) {
          throw new OrchestrationError(
            'operation_rejected',
            `Run integration worktree has ${dirty.length} uncommitted file(s): ${dirty.join(', ')}. Clean or commit them before reviewing.`,
            { dirtyFiles: dirty },
          );
        }
      }
      const headOid =
        (mainRepoRoot ? await resolveBranchRefOid(mainRepoRoot, branch) : null) ??
        run.integrationHeadCommit ??
        null;
      const baseCommit = run.integrationBaseCommit ?? null;
      return {
        hasChanges: Boolean(baseCommit && headOid && baseCommit !== headOid),
        mainRepoRoot,
        repoPath: mainRepoRoot ?? wtPath,
        branch,
        baseCommit,
        targetCommit: headOid,
        isActiveIntegrationBranch: true,
        integratedWorkers,
      };
    }

    const fallbackRepoCandidate =
      run.integrationRepoRootPath ??
      integratedDispatches[0]?.repoRootPath ??
      integratedDispatches[0]?.worktreePath ??
      this.getDefaultCwd?.() ??
      null;
    const mainRepoRoot = fallbackRepoCandidate
      ? await resolveMainRepoRoot(fallbackRepoCandidate, run.integrationRepoRootPath ?? this.getDefaultCwd?.() ?? null)
      : null;
    const baseCommit = run.integrationBaseCommit ?? null;
    const targetCommit =
      run.integrationHeadCommit ??
      (run.integrationStatus === 'finalized' ? run.finalizedCommit : null) ??
      null;
    return {
      hasChanges: Boolean(mainRepoRoot && baseCommit && targetCommit && baseCommit !== targetCommit),
      mainRepoRoot,
      repoPath: mainRepoRoot,
      branch: run.integrationBaseBranch ?? null,
      baseCommit,
      targetCommit,
      isActiveIntegrationBranch: false,
      integratedWorkers,
    };
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

  /**
   * Depth of the lineage a caller acts in: its active dispatch, or the latest dispatch it ran in a
   * run that is still open. Reporting done must not turn a worker pane back into a coordinator.
   */
  private resolveCallerDepth(callerPaneId: string): number {
    const active = this.store.getActiveDispatchForIdentity(callerPaneId, callerPaneId);
    if (active) return active.depth;
    const latest = this.store
      .listDispatches()
      .filter((d) => d.assigneePaneId === callerPaneId || d.assigneeHandle === callerPaneId)
      .at(-1);
    return latest && this.store.getRun(latest.runId)?.status === 'active' ? latest.depth : 0;
  }

  /**
   * Refuses Worker controls a caller may not ask for: reviews stay read-only with no network or
   * sub-Workers, only the person starts a full-auto Worker, and a sub-Worker opt-in needs depth left.
   */
  private assertWorkerStartControls(
    input: {
      reviewOf?: string; reviewRun?: boolean | string; readOnly?: boolean;
      policy?: AgentSessionPolicy; network?: boolean; allowSubWorkers?: boolean; userInitiated?: boolean;
    },
    from: string,
  ): void {
    const isReview = Boolean(input.reviewOf?.trim()) || input.reviewRun === true ||
      (typeof input.reviewRun === 'string' && input.reviewRun.trim().length > 0);
    if (isReview && ((input.policy !== undefined && input.policy !== 'read-only') ||
        input.network === true || input.allowSubWorkers === true)) {
      throw new OrchestrationError('operation_rejected', 'Review Workers stay read-only, without network access or sub-Workers.');
    }
    if (input.readOnly === true && input.policy !== undefined && input.policy !== 'read-only') {
      throw new OrchestrationError('invalid_argument', `A read-only task cannot run with the ${input.policy} policy.`);
    }
    if (input.policy === 'full-auto' && input.userInitiated !== true) {
      throw new OrchestrationError(
        'operation_rejected',
        'Only the person can start a full-auto Worker. Start it with workspace-write, or ask them to approve full-auto in AhaStation.',
      );
    }
    if (input.allowSubWorkers === true && this.resolveCallerDepth(from) + 1 >= this.maxDepth) {
      throw new OrchestrationError(
        'operation_rejected',
        `A Worker at depth ${this.resolveCallerDepth(from) + 1} cannot start sub-Workers (max depth ${this.maxDepth}).`,
        { maxDepth: this.maxDepth },
      );
    }
  }

  private assertCanDelegateFrom(callerPaneId: string): void {
    const nextDepth = this.resolveCallerDepth(callerPaneId) + 1;
    if (nextDepth > this.maxDepth) {
      throw new OrchestrationError(
        'operation_rejected',
        `Nested worker dispatch depth ${nextDepth} exceeds max depth ${this.maxDepth}.`,
        { depth: nextDepth, maxDepth: this.maxDepth }
      );
    }
  }

  /** Whether a pane has ever been the assignee of a dispatch; such panes act with worker rights. */
  private hasWorkerHistory(callerPaneId: string): boolean {
    return this.store
      .listDispatches()
      .some((d) => d.assigneePaneId === callerPaneId || d.assigneeHandle === callerPaneId);
  }

  assertNotActiveWorker(callerPaneId: string): void {
    if (this.hasWorkerHistory(callerPaneId)) {
      throw new OrchestrationError(
        'operation_rejected',
        'A worker terminal cannot reset global orchestration state.'
      );
    }
  }

  /** Coordinator-loop control over HTTP: never from a worker, and stop/tick only by the run's coordinator. */
  assertCanControlCoordinatorLoop(callerPaneId: string, runId?: string): void {
    if (this.hasWorkerHistory(callerPaneId)) {
      throw new OrchestrationError('operation_rejected', 'A worker terminal cannot control the coordinator loop.');
    }
    if (!runId) return;
    const run = this.store.requireRun(runId);
    if (run.coordinatorPaneId !== callerPaneId && run.coordinatorHandle !== callerPaneId) {
      throw new OrchestrationError('operation_rejected', 'Only this run’s coordinator may control its coordinator loop.');
    }
  }

  /** Run the active (or given) coordinator loop belongs to, for authorization. */
  coordinatorLoopRunId(runId?: string): string | undefined {
    return runId?.trim() || this.store.getActiveCoordinatorRun()?.runId;
  }

  isCoordinatorTerminal(ptyId: string): boolean {
    return this.store.listRuns().some(run =>
      (run.status === 'active' || run.status === 'stopped') && run.coordinatorPaneId === ptyId);
  }

  runCurrent(input: { from?: string } = {}): { run: OrchestrationRunRecord | null } {
    const handle = input.from?.trim() || 'coordinator';
    const dispatch = HEADLESS_WORKER_ID.test(handle)
      ? this.store.getActiveDispatchForIdentity(handle, null) : undefined;
    const run = (dispatch ? this.store.getRun(dispatch.runId) : this.store.getCurrentRunForConsumer(handle)) ?? null;
    return { run };
  }

  runList(filter?: { status?: string }): {
    runs: OrchestrationRunRecord[];
    count: number;
  } {
    const runs = this.store.listRuns(filter);
    return { runs, count: runs.length };
  }

  runShow(id: string, callerPaneId?: string): {
    run: OrchestrationRunRecord;
    tasks: OrchestrationTaskWithDispatch[];
    gates: OrchestrationGateRecord[];
  } {
    if (callerPaneId !== undefined) this.authorizeRunAccess(id, callerPaneId);
    const run = this.store.requireRun(id);
    const firewall = callerPaneId !== undefined ? this.review.getReviewFirewallContext(callerPaneId) : null;
    const rawTasks = this.store.listTasksWithDispatch({ runId: run.id });
    const tasks = firewall
      ? rawTasks.filter((t) => !firewall.targetTaskIds.has(t.id))
      : rawTasks;
    const rawGates = this.store.listGates({ runId: run.id });
    const gates = firewall
      ? rawGates.filter((g) => !g.taskId || !firewall.targetTaskIds.has(g.taskId))
      : rawGates;
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

  private buildWorkerDispatchBrief(input: BuildDispatchPreambleInput): string {
    const run = input.runId ? this.store.getRun(input.runId) : undefined;
    const { preamble, briefFilePath } = buildDispatchPreambleWithBrief({
      ...input,
      sharedContext: run && !input.isFollowUp ? this.buildSharedRunContextForDispatch(run, input.dispatchId) : null,
      briefsDir: this.store.getBriefsDir(),
      cliCommand: this.cliCommand,
      dispatchCapability: this.store.getDispatchCapability(input.dispatchId),
      redactText: (text) => this.store.redactDispatchCredentials(text),
    });
    if (briefFilePath) this.store.setDispatchBriefFilePath(input.dispatchId, briefFilePath);
    return preamble;
  }

  private buildSharedRunContextForDispatch(
    run: OrchestrationRunRecord,
    excludeDispatchId?: string | null,
  ): SharedRunContext | null {
    const dispatches = this.store.listDispatches({ runId: run.id });
    const activePeers: SharedRunPeerSummary[] = [];
    for (const d of dispatches) {
      if (d.id === excludeDispatchId) continue;
      if (!ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
      const peerTask = this.store.getTask(d.taskId);
      const role = this.resolveRoleNameForDispatch(d) || d.id;
      activePeers.push({
        role: this.store.redactDispatchCredentials(role),
        taskTitle: this.store.redactDispatchCredentials(peerTask?.taskTitle || d.taskId),
      });
      if (activePeers.length >= 6) break;
    }

    const firewall = excludeDispatchId ? this.review.getReviewFirewallContext(excludeDispatchId) : null;
    const redact = (text: string) => this.store.redactDispatchCredentials(text);
    const messages = this.store.listBoardPosts(run.id, { limit: 80 });
    const latestBoardSeq = this.store.getHeadBoardSeq(run.id);
    const recentBoardPosts: SharedRunBoardPostSummary[] = [];
    for (const m of messages) {
      if (typeof m.boardSeq !== 'number') continue;
      if (excludeDispatchId && m.toHandle === `dispatch:${excludeDispatchId}`) continue;
      if (firewall && this.review.isPostHiddenByReviewFirewall(m, firewall)) continue;
      if (m.kind !== 'handoff' && m.kind !== 'answer' && m.kind !== 'brief') continue;
      const summary =
        redact(m.body || '')
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(
            (line) =>
              line.length > 0 &&
              !line.startsWith('[Worker ') &&
              !line.startsWith('[ORCHESTRATION ') &&
              !line.startsWith('Workspace:') &&
              !line.startsWith('Workspace CWD:') &&
              !line.startsWith('Branch:') &&
              !line.startsWith('Git Branch:') &&
              !line.startsWith('Previous Dispatch:') &&
              !line.startsWith('Read full context file first.') &&
              !line.startsWith('[Specification truncated') &&
              !line.startsWith('[Section truncated.') &&
              !line.startsWith('Full Brief File:') &&
              !line.startsWith('Task:') &&
              !line.startsWith('Run:') &&
              !line.startsWith('Worker Handle:') &&
              !line.startsWith('Coordinator Handle:') &&
              !line.startsWith('Dispatch Capability:') &&
              !line.startsWith('==='),
          ) || m.subject;
      if (!summary) continue;
      recentBoardPosts.push({
        boardSeq: m.boardSeq,
        kind: m.kind,
        fromRole: redact(m.fromRole || m.fromHandle || 'coordinator'),
        summary: redact(summary),
      });
    }

    const trimmedObjective = run.objective ? redact(run.objective).trim() || null : null;
    const latestThree = recentBoardPosts.sort((a, b) => a.boardSeq - b.boardSeq).slice(-3);
    if (!trimmedObjective && activePeers.length === 0 && latestThree.length === 0) {
      return null;
    }
    return {
      runObjective: trimmedObjective,
      activePeers,
      recentBoardPosts: latestThree,
      ...(latestBoardSeq > 0 ? { latestBoardSeq } : {}),
    };
  }

  private redactTaskContext(context: OrchestrationTaskContext | null): OrchestrationTaskContext | null {
    const redact = (value: string) => this.store.redactDispatchCredentials(value);
    return normalizeTaskContext({
      background: context?.background && redact(context.background),
      constraints: context?.constraints?.map(redact),
      files: context?.files?.map(redact),
      acceptance: context?.acceptance && redact(context.acceptance),
    });
  }

  taskCreate(input: {
    id?: string;
    runId?: string;
    from?: string;
    spec: string;
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
    worktreePath?: string;
  }): { task: OrchestrationTaskRecord } {
    const runId = this.resolveRunIdForCaller(input.runId, input.from);
    const taskContext = this.redactTaskContext(normalizeTaskContext(input));
    const task = this.store.createTask({
      id: input.id,
      runId,
      spec: input.spec,
      ...(taskContext ? { taskContext } : {}),
      taskTitle: input.taskTitle,
      displayName: input.displayName,
      deps: input.deps,
      codeDeps: input.codeDeps,
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
  } = {}, callerPaneId?: string): { tasks: OrchestrationTaskWithDispatch[]; count: number } {
    const runId = input.runId?.trim() || undefined;
    const firewall = callerPaneId !== undefined ? this.review.getReviewFirewallContext(callerPaneId) : null;
    const tasks = this.store
      .listTasksWithDispatch({ runId, status: input.status })
      .filter((t) => !input.priority || t.priority === input.priority)
      .filter((t) => !firewall || !firewall.targetTaskIds.has(t.id));
    return { tasks, count: tasks.length };
  }

  taskShow(input: string | { id: string }, callerPaneId?: string): OrchestrationTaskShowResult {
    const taskId = typeof input === 'string' ? input.trim() : input.id.trim();
    const task = this.store.requireTask(taskId);
    if (callerPaneId !== undefined) this.authorizeRunAccess(task.runId, callerPaneId);
    const latestDispatch = this.store.getLatestDispatchForTask(task.id) ?? null;
    if (latestDispatch && callerPaneId !== undefined) {
      this.review.assertNotFirewalledReviewRead(callerPaneId, latestDispatch, 'task-show');
    }
    const dispatches = this.store.listDispatches({ taskId: task.id });
    const gates = this.store.listGates({ taskId: task.id });
    return { task, latestDispatch, dispatches, gates };
  }

  taskUpdate(input: {
    id: string;
    status: OrchestrationTaskStatus;
    queueDecision?: 'cancel' | 'resume';
  }): { task: OrchestrationTaskRecord } {
    if (input.queueDecision) {
      const task = this.store.requireTask(input.id);
      if (!task.queuedLaunch || task.queuedLaunch.state === 'claimed' || this.claimedLaunches.has(task.id) ||
          this.store.getActiveDispatchesForTask(task.id).length) throw new OrchestrationError('worker_busy', '派发已经领取，请处理当前 Worker。');
      if (input.queueDecision === 'resume') {
        if (this.store.getLatestDispatchForTask(task.id) || task.queuedLaunch.state !== 'needs_reconciliation') throw new OrchestrationError('task_not_ready', '请先处理已有派发。');
        this.store.setQueuedLaunch(task.id, { ...task.queuedLaunch, reason: undefined, state: 'waiting' });
        this.emitChanged('task:queue-resumed', task.runId);
        return { task: this.store.requireTask(task.id) };
      }
      if (input.status !== 'failed') throw new OrchestrationError('invalid_argument', '取消排队须结束任务。');
      this.store.setQueuedLaunch(task.id);
    }
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
    callerPaneId?: string;
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
    if (input.callerPaneId !== undefined) this.authorizeRunAccess(task.runId, input.callerPaneId);
    const from = input.callerPaneId ?? (input.from?.trim() || 'coordinator');
    const assignee = input.to?.trim() || '';

    if (input.dryRun) {
      const dryRun = this.store.getRun(task.runId);
      const preamble = buildDispatchPreamble({
        taskId: task.id,
        dispatchId: 'ctx_dryrun',
        runId: task.runId,
        taskSpec: task.spec,
        taskContext: task.taskContext,
        sharedContext: dryRun ? this.buildSharedRunContextForDispatch(dryRun, null) : null,
        coordinatorHandle: `run:${task.runId}`,
        workerHandle: assignee || 'worker',
        worktreePath: task.worktreePath,
        canDispatchSubWorkers: true,
        cliCommand: this.cliCommand,
      });
      return { dispatch: null, injected: false, dryRun: true, preamble: this.store.redactDispatchCredentials(preamble) };
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

    if (AGENT_SESSION_ID.test(assignee)) {
      throw new OrchestrationError('terminal_is_coordinator', 'An Agent session coordinates runs; choose a worker terminal.');
    }
    if (inject && !this.isPaneAlive(assignee)) {
      throw new OrchestrationError(
        'no_agent_detected',
        `Target pane ${assignee} is not live or registered for agent prompt delivery.`
      );
    }

    if (inject) {
      const caller = this.terminalTracker?.getTerminal(from);
      const expectedCwd = task.worktreePath ?? this.sessionCoordinator(from)?.cwd ??
        (caller?.cwdKnown ? caller.cwd : this.getDefaultCwd?.());
      await this.verifyCodeInputs(task, this.terminalTracker?.getTerminal(assignee)?.cwd);
      const mismatch = this.paneMismatch(assignee, expectedCwd);
      if (mismatch) throw new OrchestrationError('terminal_unavailable', mismatch);
    }
    const paneStatus = this.agentStatusStore.get(assignee);

    const callerDispatch = this.store.getActiveDispatchForIdentity(from, from);
    const parentPaneId = this.isCallerSurface(from)
      ? from
      : (callerDispatch?.assigneePaneId ?? this.store.getRun(task.runId)?.coordinatorPaneId ?? null);
    const ctx = this.store.createDispatchContext({
      taskId: task.id,
      assigneeHandle: assignee,
      assigneePaneId: paneStatus?.ptyId ?? null,
      creator: from,
      creatorRunId: task.runId,
      creatorDispatchId: callerDispatch?.id ?? null,
      parentDepth: this.resolveCallerDepth(from),
      parentPaneId,
      cliId: paneStatus?.agentId ?? null,
      ownsPane: false,
      ownsWorktree: false,
      maxDepth: this.maxDepth,
    });

    const preamble = this.buildWorkerDispatchBrief({
      taskId: task.id,
      dispatchId: ctx.id,
      runId: task.runId,
      taskSpec: task.spec,
      taskContext: task.taskContext,
      coordinatorHandle: callerDispatch ? `dispatch:${callerDispatch.id}` : `run:${task.runId}`,
      workerHandle: assignee,
      worktreePath: task.worktreePath,
      canDispatchSubWorkers: ctx.depth < this.maxDepth,
    });

    let injected = false;
    let updatedCtx = this.store.getDispatchContext(ctx.id) ?? ctx;
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
        body: this.store.redactDispatchCredentials(preamble),
      });
      this.store.markAsReadAndDelivered([dispatchAuditMsg.id]);
    } catch (error) {
      if (!delivered) {
        this.store.failDispatch(ctx.id, 'Could not record dispatch audit');
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
      preamble: this.store.redactDispatchCredentials(preamble),
    };
  }

  dispatchShow(input: { taskId: string; preamble?: boolean; callerPaneId?: string }): {
    dispatch: OrchestrationDispatchRecord | null;
    preamble?: string;
  } {
    const task = this.store.requireTask(input.taskId);
    if (input.callerPaneId !== undefined) this.authorizeRunAccess(task.runId, input.callerPaneId);
    const ctx = this.store.getLatestDispatchForTask(task.id) ?? null;
    if (ctx && input.callerPaneId !== undefined) {
      this.review.assertNotFirewalledReviewRead(input.callerPaneId, ctx, 'dispatch-show');
    }
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
    const previewRun = this.store.getRun(task.runId);
    const preamble = buildDispatchPreamble({
      taskId: task.id,
      dispatchId: ctx?.id ?? 'ctx_preview',
      runId: task.runId,
      taskSpec: task.spec,
      taskContext: task.taskContext,
      sharedContext: previewRun ? this.buildSharedRunContextForDispatch(previewRun, ctx?.id ?? null) : null,
      coordinatorHandle: previewCoordinatorHandle,
      workerHandle: ctx?.assigneeHandle ?? 'worker',
      worktreePath: task.worktreePath,
      canDispatchSubWorkers: (ctx?.depth ?? 1) < this.maxDepth,
      cliCommand: this.cliCommand,
      redactText: (text) => this.store.redactDispatchCredentials(text),
    });
    return {
      dispatch: ctx,
      preamble: this.store.redactDispatchCredentials(preamble),
    };
  }

  // ==================== Coordinator Lifecycle ====================

  private async verifyCodeInputs(task: OrchestrationTaskRecord, cwd?: string | null): Promise<void> {
    if (!task.codeDeps?.length) return;
    if (!cwd) throw new OrchestrationError('task_not_ready', '无法核实下游工作目录。');
    const result = await runGitCommand(['rev-parse', '--verify', 'HEAD^{commit}'], { cwd, readOnly: true });
    const head = result.exitCode === 0 ? result.stdout.trim() : '';
    const run = this.store.requireRun(task.runId);
    for (const id of task.codeDeps) {
      const upstream = this.store.codeDependency(id);
      const commit = upstream?.integratedCommit;
      if (!upstream || upstream.status !== 'completed' || upstream.integrationStatus !== 'merged' || !commit) {
        throw new OrchestrationError('task_not_ready', `等待 ${id} 合入共享分支；未提交的工作区改动无法交接。`);
      }
      const repo = upstream.repoRootPath ?? run.integrationRepoRootPath;
      const commits = [commit, ...(run.finalizedBatches ?? [])
        .filter(batch => batch.members[upstream.id] === commit).map(batch => batch.targetCommit)];
      if (head && repo && await isSameGitRepo(repo, cwd)) {
        let included = false;
        for (const candidate of commits) {
          if (await isGitCommitAncestor(cwd, candidate, head)) { included = true; break; }
        }
        if (included) continue;
      }
      throw new OrchestrationError('task_not_ready', `工作目录 ${cwd} 的 HEAD 尚未包含 ${id} 的交付提交 ${commit}。`);
    }
  }

  private paneMismatch(id: string, cwd?: string | null, cliId?: string | null): string | null {
    const pane = this.agentStatusStore.get(id);
    if (!this.isPaneAlive(id) || !pane?.agentId) return 'Terminal has no live coding agent.';
    if (pane.state === 'working' || pane.state === 'waiting') return 'Terminal is busy.';
    if (cliId && pane.agentId !== cliId) return `Expected CLI ${cliId}, found ${pane.agentId}.`;
    const terminal = this.terminalTracker?.getTerminal(id);
    if (terminal?.alive === false) return 'Terminal has exited.';
    if (!terminal?.cwdKnown) return 'Terminal working directory is unknown.';
    if (cwd) {
      try {
        const canonical = (path: string) => {
          const resolved = realpathSync.native(path);
          return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
        };
        if (canonical(cwd) === canonical(terminal.cwd)) return null;
      } catch { /* An inaccessible directory cannot be verified. */ }
      return `Expected working directory ${cwd}, found ${terminal.cwd}.`;
    }
    return null;
  }

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
      launchDependent: async (task, cliId) => {
        const run = this.store.requireRun(task.runId);
        await this.workerStart({ runId: run.id, taskId: task.id, agent: cliId, from: run.coordinatorHandle, worktree: true });
      },
      verifyCodeInputs: (task, cwd) => this.verifyCodeInputs(task, cwd),
      listWorkerCandidates: (excludePaneIds, cwd, cliId) => {
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
          const caller = options.coordinatorPaneId ? this.terminalTracker?.getTerminal(options.coordinatorPaneId) : null;
          if (this.paneMismatch(pane.ptyId, cwd ?? (caller?.cwdKnown ? caller.cwd : this.getDefaultCwd?.()), cliId)) continue;
          candidates.push({ ptyId: pane.ptyId, agentId: pane.agentId, cwd: this.terminalTracker?.getTerminal(pane.ptyId)?.cwd });
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
                displayName: spawnInput.task.displayName ?? null,
                taskTitle: spawnInput.task.taskTitle,
              });
            }
            return spawned;
          }
        : undefined,
      isPaneAlive: (ptyId) => this.isPaneAlive(ptyId),
      hasPaneExited: (ptyId) => this.exitedPanes.has(ptyId),
      buildDispatchBrief: (input) => this.buildWorkerDispatchBrief(input),
      sendTurn: async (turn) => {
        const matchingActive = this.store
          .listDispatches()
          .filter(
            (d) =>
              ACTIVE_DISPATCH_STATUSES.has(d.status) &&
              (d.assigneePaneId === turn.ptyId || d.assigneeHandle === turn.ptyId)
          );
        const dispatchId = matchingActive[matchingActive.length - 1]?.id ?? null;
        if (dispatchId) {
          const current = this.store.getDispatchContext(dispatchId)!;
          const task = this.store.requireTask(current.taskId);
          const caller = options.coordinatorPaneId ? this.terminalTracker?.getTerminal(options.coordinatorPaneId) : null;
          const expected = task.worktreePath ?? options.cwd ?? (caller?.cwdKnown ? caller.cwd : this.getDefaultCwd?.());
          const mismatch = turn.freshlySpawned ? null : this.paneMismatch(turn.ptyId, expected, options.workerCliId);
          if (mismatch) return { ok: false, error: mismatch };
          await this.verifyCodeInputs(task, this.terminalTracker?.getTerminal(turn.ptyId)?.cwd);
        }
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
    messageType: OrchestrationMessageType,
    message?: OrchestrationMessageRecord,
  ): void {
    this.waiters.notify(toHandle, messageType);
    const codexTarget = toHandle.startsWith('dispatch:')
      ? this.store.getDispatchContext(toHandle.slice('dispatch:'.length))?.assigneeHandle : toHandle;
    if (codexTarget && HEADLESS_WORKER_ID.test(codexTarget)) {
      if (this.codexWorkers.has(codexTarget)) {
        this.queueCodexMail(codexTarget, message);
        this.deliverCodexMailbox(codexTarget);
      }
    } else {
      this.pointerDelivery.notifyMessageArrived(toHandle);
    }

    if (toHandle.startsWith('run:')) {
      const runId = toHandle.slice('run:'.length);
      this.waiters.notify(`board:${runId}:role:coordinator`, messageType);
      this.waiters.notify(`board:${runId}:all`, messageType);
      const run = this.store.getRun(runId);
      if (run?.coordinatorPaneId) {
        this.waiters.notify(`board-pane:${run.coordinatorPaneId}`, messageType);
      }
    } else if (toHandle.startsWith('dispatch:')) {
      const dispatchId = toHandle.slice('dispatch:'.length);
      const dispatch = this.store.getDispatchContext(dispatchId);
      if (dispatch) {
        const role = this.resolveRoleNameForDispatch(dispatch).toLowerCase() || dispatch.id;
        this.waiters.notify(`board:${dispatch.runId}:role:${role}`, messageType);
        this.waiters.notify(`board:${dispatch.runId}:all`, messageType);
        if (dispatch.assigneePaneId) {
          this.waiters.notify(`board-pane:${dispatch.assigneePaneId}`, messageType);
        }
      }
    }

    if (toHandle === '@workers' || toHandle === '@all') {
      for (const paneId of this.pointerDelivery.resolvePanesForMailbox(toHandle)) {
        this.waiters.notify(paneId, messageType);
        this.waiters.notify(`board-pane:${paneId}`, messageType);
        const activeDispatch = this.store.getActiveDispatchForIdentity(paneId, paneId);
        if (activeDispatch) {
          this.waiters.notify(`dispatch:${activeDispatch.id}`, messageType);
          const role =
            this.resolveRoleNameForDispatch(activeDispatch).toLowerCase() || activeDispatch.id;
          this.waiters.notify(`board:${activeDispatch.runId}:role:${role}`, messageType);
          this.waiters.notify(`board:${activeDispatch.runId}:all`, messageType);
        }
        const boundRun = this.store.getCurrentRunForConsumer(paneId);
        if (
          toHandle === '@all' &&
          boundRun &&
          (boundRun.coordinatorPaneId === paneId || boundRun.coordinatorHandle === paneId)
        ) {
          this.waiters.notify(`run:${boundRun.id}`, messageType);
          this.waiters.notify(`board:${boundRun.id}:role:coordinator`, messageType);
          this.waiters.notify(`board:${boundRun.id}:all`, messageType);
        }
      }
      return;
    }

    if (!toHandle.startsWith('run:') && !toHandle.startsWith('dispatch:')) {
      this.waiters.notify(`board-pane:${toHandle}`, messageType);
      const activeDispatch = this.store.getActiveDispatchForIdentity(toHandle, toHandle);
      if (activeDispatch) {
        const dispatchAddr = `dispatch:${activeDispatch.id}`;
        this.waiters.notify(dispatchAddr, messageType);
        this.pointerDelivery.notifyMessageArrived(dispatchAddr);
        const role =
          this.resolveRoleNameForDispatch(activeDispatch).toLowerCase() || activeDispatch.id;
        this.waiters.notify(`board:${activeDispatch.runId}:role:${role}`, messageType);
        this.waiters.notify(`board:${activeDispatch.runId}:all`, messageType);
      }
      const boundRun = this.store.getCurrentRunForConsumer(toHandle);
      if (boundRun && (boundRun.coordinatorPaneId === toHandle || boundRun.coordinatorHandle === toHandle)) {
        const runAddr = `run:${boundRun.id}`;
        this.waiters.notify(runAddr, messageType);
        this.pointerDelivery.notifyMessageArrived(runAddr);
        this.waiters.notify(`board:${boundRun.id}:role:coordinator`, messageType);
        this.waiters.notify(`board:${boundRun.id}:all`, messageType);
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
    fromRole?: string;
    mentions?: readonly string[];
    refs?: readonly number[];
    kind?: OrchestrationBoardPostKind;
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

  sendFromCodexWorker(workerId: string, input: Parameters<OrchestrationService['send']>[0]): OrchestrationSendResult {
    const dispatch = this.store.getActiveDispatchForIdentity(workerId, null);
    if (!dispatch || dispatch.executionMode !== 'codex-app-server') {
      throw new OrchestrationError('operation_rejected', 'An active headless Worker dispatch is required.');
    }
    const runId = this.authorizeRunAccess(input.runId, workerId);
    if (input.type === 'heartbeat') {
      return this.sendMailSync({
        from: workerId, runId, type: 'heartbeat', subject: input.subject,
        payload: { dispatchId: dispatch.id },
        capability: this.store.getDispatchCapability(dispatch.id),
      });
    }
    if (input.type && !['status', 'handoff', 'escalation', 'question'].includes(input.type)) {
      throw new OrchestrationError('operation_rejected', 'Headless Workers cannot send this message type.');
    }
    const to = this.normalizeRecipientHandle(input.to ?? '');
    const run = this.store.requireRun(runId);
    const target = to.startsWith('dispatch:')
      ? this.store.getDispatchContext(to.slice('dispatch:'.length))
      : this.store.getActiveDispatchForIdentity(to, to);
    if (to !== 'coordinator' && to !== `run:${runId}` &&
        to !== run.coordinatorPaneId && to !== run.coordinatorHandle && target?.runId !== runId) {
      throw new OrchestrationError('operation_rejected', 'Headless Workers can only send mail within their run.');
    }
    // Mail to a settled dispatch is still mail. Only the Coordinator can reactivate it.
    return this.sendMailSync({ ...input, from: workerId, to, runId });
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
    fromRole?: string;
    mentions?: readonly string[];
    refs?: readonly number[];
    kind?: OrchestrationBoardPostKind;
    artifacts?: OrchestrationReportArtifacts | null;
  }, onSettled?: () => void): OrchestrationSendResult {
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
      const targetDispatchForDone = reportedDispatchId
        ? this.store.getDispatchContext(reportedDispatchId)
        : this.store.getActiveDispatchForIdentity(from, from);
      if (
        input.type === 'worker_done' &&
        !onSettled &&
        targetDispatchForDone &&
        (targetDispatchForDone.reviewOfDispatchId || targetDispatchForDone.reviewOfRunId)
      ) {
        throw new OrchestrationError(
          'operation_rejected',
          `Review dispatch ${targetDispatchForDone.id} must report completion via report_done / worker-done with an explicit verdict ("pass" or "reject"), not generic send(type="worker_done").`,
          { dispatchId: targetDispatchForDone.id },
        );
      }
      if (!rawTo) {
        const inferredDispatch = targetDispatchForDone;
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
        this.notifyTargetAndAliases(recipient, msg.type, msg);
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
      if (this.store.getDispatchContext(activeId)?.executionMode !== 'codex-app-server') {
        this.store.bumpDispatchGenerationForSteering(activeId);
      }
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
      fromRole: input.fromRole,
      mentions: input.mentions,
      refs: input.refs,
      kind: input.kind,
      artifacts: input.artifacts,
    });

    const lifecycle =
      msg.type === 'worker_done' || msg.type === 'heartbeat'
        ? reconcileLifecycleMessage(this.store, msg)
        : undefined;

    if (lifecycle?.action === 'settled') {
      if (onSettled) {
        onSettled();
      } else if (msg.payload) {
        try {
          const parsedDone = JSON.parse(msg.payload) as { dispatchId?: unknown };
          const settledId = typeof parsedDone?.dispatchId === 'string' ? parsedDone.dispatchId : '';
          const settledDispatch = settledId ? this.store.getDispatchContext(settledId) : undefined;
          if (
            settledDispatch &&
            (settledDispatch.reviewOfDispatchId || settledDispatch.reviewOfRunId) &&
            (!settledDispatch.reviewStatus || settledDispatch.reviewStatus === 'pending' || settledDispatch.reviewStatus === 'none')
          ) {
            this.store.updateDispatchReviewState(settledDispatch.id, { reviewStatus: 'rejected' });
            this.review.reconcileAnyReviewBatch(settledDispatch.id, {
              failedReason: 'Review dispatch settled without a structured verdict',
            });
          }
        } catch {
          /* ignore malformed payload */
        }
      }
    }
    const latestMsg = this.store.getMessageById(msg.id) ?? msg;
    if (lifecycle?.action === 'settled' && latestMsg.payload) {
      try {
        const parsedPayload = JSON.parse(latestMsg.payload) as { dispatchId?: unknown };
        if (typeof parsedPayload?.dispatchId === 'string' && parsedPayload.dispatchId) {
          this.approvals.cancelForDispatch(parsedPayload.dispatchId, 'Dispatch settled');
          this.nativeQuestions.cancelForDispatch(parsedPayload.dispatchId, 'Dispatch settled');
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
    this.notifyTargetAndAliases(latestMsg.toHandle, latestMsg.type, latestMsg);
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
    fromRole?: string;
    artifacts?: OrchestrationReportArtifacts | null;
    verdict?: OrchestrationReviewVerdict;
    findings?: OrchestrationReviewFinding[];
    mutatedReviewWorkspace?: boolean;
    reviewVerificationFailed?: boolean;
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
    let summary = input.summary?.trim() || '';
    if (!from) {
      // Never default to the assignee: that would let any caller settle any dispatch.
      throw new OrchestrationError(
        'invalid_argument',
        'workerDone requires the caller identity (--from or an injected terminal handle).'
      );
    }
    this.store.assertDispatchCapability(resolvedDispatch.id, input.capability);
    const to = this.resolveActiveParentMailbox(resolvedDispatch);
    const workerRole =
      input.fromRole?.trim().replace(/^@+/, '').toLowerCase() ||
      this.resolveRoleNameForDispatch(resolvedDispatch).toLowerCase() ||
      undefined;

    let effectiveArtifacts: OrchestrationReportArtifacts | null | undefined = input.artifacts;
    const normalizedFindings = normalizeReviewFindings(input.findings ?? []);
    let settleReview: (() => void) | undefined;
    if (resolvedDispatch.reviewOfDispatchId || resolvedDispatch.reviewOfRunId) {
      if (!hasLifecycleAuthority(resolvedDispatch, from)) {
        throw new OrchestrationError(
          'operation_rejected',
          `Sender ${from} lacks lifecycle authority to report review verdict for ${resolvedDispatch.id}.`,
          { dispatchId: resolvedDispatch.id },
        );
      }
      if (!ACTIVE_DISPATCH_STATUSES.has(resolvedDispatch.status)) {
        // Already settled: return idempotent duplicate without polluting the Board or waking Coordinator.
        const existingMsg = this.store.findLatestWorkerDoneMessage(resolvedDispatch.id);
        return {
          message: existingMsg
            ? exposeMessages(this.store, [existingMsg])[0]!
            : exposeMessage({
                id: `dup_${resolvedDispatch.id}`,
                seq: 0,
                runId: resolvedDispatch.runId,
                fromHandle: from,
                toHandle: to,
                type: 'worker_done',
                priority: 'normal',
                subject: `worker_done ${taskId} (${outcome})`,
                body: '',
                payload: null,
                threadId: null,
                createdAt: resolvedDispatch.updatedAt,
                read: true,
                deliveredAt: resolvedDispatch.updatedAt,
                lifecycleRejectedReason: null,
              }),
          lifecycle: { action: 'duplicate' },
          task: this.store.requireTask(taskId),
          dispatch: resolvedDispatch,
        };
      }
      const isRunReview = Boolean(resolvedDispatch.reviewOfRunId && !resolvedDispatch.reviewOfDispatchId);
      if (outcome === 'completed') {
        if (input.verdict !== 'pass' && input.verdict !== 'reject') {
          throw new OrchestrationError(
            'invalid_argument',
            'Adversarial review completion requires an explicit verdict ("pass" or "reject").',
            { dispatchId: resolvedDispatch.id },
          );
        }
        const targetDispatch = resolvedDispatch.reviewOfDispatchId
          ? this.store.getDispatchContext(resolvedDispatch.reviewOfDispatchId)
          : undefined;
        const targetRun = resolvedDispatch.reviewOfRunId
          ? this.store.getRun(resolvedDispatch.reviewOfRunId)
          : undefined;
        const workspaceCompromised = Boolean(
          input.mutatedReviewWorkspace || input.reviewVerificationFailed,
        );
        const evaluation = evaluateAdversarialVerdict({
          verdict: input.verdict,
          findings: normalizedFindings,
          summary,
          mutatedWorkspace: Boolean(input.mutatedReviewWorkspace),
          verificationFailed: Boolean(input.reviewVerificationFailed),
        });
        settleReview = () => {
          this.store.updateDispatchReviewState(resolvedDispatch.id, {
            reviewStatus: evaluation.effectiveVerdict === 'pass' ? 'passed' : 'rejected',
            reviewFindings: evaluation.findings,
            ...(workspaceCompromised ? { reviewMutatedWorkspace: true } : {}),
          });
          this.review.reconcileAnyReviewBatch(resolvedDispatch.id);
        };
        const reviewRound =
          resolvedDispatch.reviewRound ??
          (isRunReview ? targetRun?.runReviewRound : targetDispatch?.reviewRound) ??
          1;
        const escalated = evaluation.effectiveVerdict === 'reject' && reviewRound >= MAX_ADVERSARIAL_REVIEW_ROUNDS;
        const targetRole = isRunReview
          ? (resolvedDispatch.reviewOfRunId ?? resolvedDispatch.runId)
          : targetDispatch
            ? this.resolveRoleNameForDispatch(targetDispatch) || targetDispatch.id
            : (resolvedDispatch.reviewOfDispatchId ?? resolvedDispatch.id);
        summary = formatReviewVerdictForBoard({
          targetRole,
          reviewRound,
          maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS,
          evaluation,
          escalated,
          mutatedWorkspace: workspaceCompromised,
          summary,
          isRunReview,
        });
        const reviewBatchPeers = resolvedDispatch.reviewBatchId
          ? (isRunReview
              ? this.store.listReviewDispatchesForRunBatch(
                  resolvedDispatch.reviewOfRunId ?? resolvedDispatch.runId,
                  resolvedDispatch.reviewBatchId,
                )
              : targetDispatch
                ? this.store.listReviewDispatchesForBatch(targetDispatch.id, resolvedDispatch.reviewBatchId)
                : []
            ).filter((d) => d.id !== resolvedDispatch.id)
          : [];
        const hasPendingPeer = reviewBatchPeers.some((d) => ACTIVE_DISPATCH_STATUSES.has(d.status));
        const hasRejectedPeer = reviewBatchPeers.some(
          (d) => d.reviewStatus === 'rejected' || d.reviewStatus === 'escalated',
        );
        let reviewNextStep: string;
        if (evaluation.effectiveVerdict === 'pass') {
          if (hasRejectedPeer) {
            reviewNextStep = isRunReview
              ? 'Another parallel reviewer in this Run batch rejected; address those findings before finalizing.'
              : `Another parallel reviewer rejected @${targetRole}; send those findings to @${targetRole} via message_worker before integrating.`;
          } else if (hasPendingPeer) {
            reviewNextStep = isRunReview
              ? 'Waiting for remaining parallel Run reviewer(s) in this batch before finalizing.'
              : `Waiting for remaining parallel reviewer(s) for @${targetRole} before integrating.`;
          } else if (isRunReview) {
            reviewNextStep = targetRun && this.isRunIntegrationBranchLive(targetRun)
              ? 'Run-level review passed — call finalize_run_integration() once main workspace is clean.'
              : 'Run-level review passed on main — ready to run final verification and report to the user.';
          } else {
            reviewNextStep = `Review passed for @${targetRole} — call integrate_worker(role="@${targetRole}") (defaults to mode="squash", targetBranch="auto").`;
          }
        } else if (escalated) {
          reviewNextStep = isRunReview
            ? `Run-level review reached max rounds (${reviewRound}/${MAX_ADVERSARIAL_REVIEW_ROUNDS}) and escalated — summarize remaining findings for the user to approve or direct fixes.`
            : `Review for @${targetRole} reached max rounds (${reviewRound}/${MAX_ADVERSARIAL_REVIEW_ROUNDS}) and escalated — summarize remaining findings for the user to decide (or approve/rework from the Board panel).`;
        } else {
          reviewNextStep = isRunReview
            ? `Run-level review rejected (Round ${reviewRound}/${MAX_ADVERSARIAL_REVIEW_ROUNDS}) — dispatch a fix worker for the findings, integrate it, then re-run reviewRun.`
            : `Review rejected (Round ${reviewRound}/${MAX_ADVERSARIAL_REVIEW_ROUNDS}) — send these findings to @${targetRole} via message_worker(role="@${targetRole}", ...) to fix, then re-review.`;
        }
        effectiveArtifacts = {
          ...(effectiveArtifacts ?? {}),
          reviewVerdict: evaluation.effectiveVerdict,
          ...(evaluation.findings.length > 0 ? { reviewFindings: evaluation.findings } : {}),
          recommendedNextStep: reviewNextStep,
        };
      } else {
        settleReview = () => {
          this.store.updateDispatchReviewState(resolvedDispatch.id, {
            reviewStatus: 'rejected',
            reviewFindings: normalizedFindings,
            ...(input.mutatedReviewWorkspace || input.reviewVerificationFailed
              ? { reviewMutatedWorkspace: true }
              : {}),
          });
          this.review.reconcileAnyReviewBatch(resolvedDispatch.id, {
            failedReason: 'Reviewer reported ' + outcome,
          });
        };
      }
    }

    const reportMentions = ['coordinator'];
    if (resolvedDispatch.reviewOfDispatchId) {
      const reviewedTarget = this.store.getDispatchContext(resolvedDispatch.reviewOfDispatchId);
      const reviewedRole = reviewedTarget
        ? this.resolveRoleNameForDispatch(reviewedTarget).trim().replace(/^@+/, '').toLowerCase()
        : '';
      if (reviewedRole && !reportMentions.includes(reviewedRole)) {
        reportMentions.push(reviewedRole);
      }
    }

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
        ...(effectiveArtifacts?.reviewVerdict ? { verdict: effectiveArtifacts.reviewVerdict } : {}),
        ...(effectiveArtifacts?.reviewFindings ? { findings: effectiveArtifacts.reviewFindings } : {}),
      },
      capability: input.capability,
      fromRole: workerRole,
      mentions: reportMentions,
      kind: 'report',
      artifacts: effectiveArtifacts,
    }, settleReview);

    const timeline = resolvedDispatch.executionMode === 'codex-app-server'
      ? this.workerTimelines.get(resolvedDispatch.assigneeHandle) : undefined;
    if (timeline && sent.lifecycle?.action !== 'duplicate') {
      timeline.addSettlement(resolvedDispatch.id, {
        settlement: 'report_done', stopReason: null, outcome,
        verdict: effectiveArtifacts?.reviewVerdict ?? input.verdict ?? null,
        findings: (effectiveArtifacts?.reviewFindings ?? normalizedFindings).map((finding) =>
          [finding.severity, finding.location, finding.title].filter(Boolean).join(' · ')),
        summary, diff: null, diffSource: null,
      });
      this.archiveWorkerTimeline(resolvedDispatch.assigneeHandle, resolvedDispatch.id);
    }

    if (workerRole && resolvedDispatch.followUpMessageId && sent.lifecycle?.action === 'settled') this.store.recordBoardReceipt([resolvedDispatch.followUpMessageId], workerRole, 'replied');
    if (workerRole && typeof sent.message.boardSeq === 'number') {
      this.store.advanceMemberCursor(resolvedDispatch.runId, workerRole, {
        lastPostSeq: sent.message.boardSeq,
      });
    }

    return {
      message: sent.message,
      lifecycle: sent.lifecycle ?? { action: 'ignored' },
      task: this.store.requireTask(taskId),
      dispatch: this.store.getDispatchContext(resolvedDispatch.id)!,
    };
  }

  async workerDoneWithArtifacts(input: {
    from?: string;
    taskId?: string;
    dispatchId?: string;
    outcome?: OrchestrationWorkerReportOutcome | 'succeeded';
    summary?: string;
    capability?: string;
    fromRole?: string;
    verdict?: OrchestrationReviewVerdict;
    findings?: OrchestrationReviewFinding[];
  }): Promise<ReturnType<OrchestrationService['workerDone']>> {
    const from = input.from?.trim();
    const resolvedDispatch = input.dispatchId?.trim()
      ? this.store.getDispatchContext(input.dispatchId.trim())
      : from
        ? this.store.getActiveDispatchForIdentity(from, from)
        : undefined;
    let artifacts: OrchestrationReportArtifacts | null = null;
    let mutatedReviewWorkspace = false;
    let reviewVerificationFailed = false;
    if (resolvedDispatch) {
      const repoPath =
        resolvedDispatch.worktreePath ??
        (resolvedDispatch.assigneePaneId
          ? this.terminalTracker?.getTerminal(resolvedDispatch.assigneePaneId)?.cwd
          : undefined) ??
        null;
      if (resolvedDispatch.reviewOfDispatchId || resolvedDispatch.reviewOfRunId) {
        if (!resolvedDispatch.isDetachedReviewWorktree || !repoPath) {
          mutatedReviewWorkspace = true;
          reviewVerificationFailed = true;
        } else {
          const mut = await detectReviewWorktreeMutation(repoPath, resolvedDispatch.reviewSnapshotOid);
          mutatedReviewWorkspace = mut.mutated;
          reviewVerificationFailed = mut.verificationFailed;
        }
      } else if (repoPath) {
        const normalizedOutcome =
          input.outcome === 'succeeded' ? 'completed' : (input.outcome ?? 'completed');
        let enrichedFromDiff = false;
        if (normalizedOutcome === 'completed' && resolvedDispatch.ownsWorktree && resolvedDispatch.worktreePath) {
          try {
            const runForWorker = this.store.getRun(resolvedDispatch.runId);
            const mainRepoRoot = await resolveMainRepoRoot(
              repoPath,
              resolvedDispatch.repoRootPath ?? this.getDefaultCwd?.() ?? null,
            ).catch(() => null);
            const wtHead = mainRepoRoot
              ? await resolveBranchRefOid(repoPath, resolvedDispatch.branch ?? '').catch(() => null)
              : null;
            const effectiveBase =
              runForWorker && mainRepoRoot && wtHead
                ? await this.resolveEffectiveWorkerDiffBase(
                    runForWorker,
                    resolvedDispatch,
                    repoPath,
                    mainRepoRoot,
                    wtHead,
                  )
                : resolvedDispatch.baseCommit;
            const diffSummary = await inspectWorkerDiff({
              worktreePath: repoPath,
              baseCommit: effectiveBase,
              maxDiffBytes: 4 * 1024,
            });
            if (diffSummary.isGitRepo) {
              enrichedFromDiff = true;
              const cleanRole = this.resolveRoleNameForDispatch(resolvedDispatch) || resolvedDispatch.id;
              const autoAuthNote = runForWorker?.reviewAutoAuthorized
                ? ' (review pre-authorized for this Run)'
                : '';
              let recommendedNextStep: string;
              if (diffSummary.stagedDivergentFiles.length > 0) {
                recommendedNextStep = `Staged vs working-tree divergence in ${diffSummary.stagedDivergentFiles.slice(0, 4).join(', ')} — ask @${cleanRole} to reconcile staged changes before integrating.`;
              } else if (diffSummary.changedFiles.length === 0) {
                recommendedNextStep = `No code diff relative to target — verify via inspect_worker_diff(role="@${cleanRole}") or release.`;
              } else if (diffSummary.recommendedReviewTier === 'L0') {
                recommendedNextStep = `L0 (${diffSummary.tierReason}) — can integrate directly via integrate_worker(role="@${cleanRole}") (targetBranch defaults to "auto").`;
              } else if (diffSummary.recommendedReviewTier === 'L2') {
                recommendedNextStep = `L2 (${diffSummary.tierReason}) — launch 1–2 parallel heterogeneous reviews via delegate_task(reviewOf="@${cleanRole}", reviewFocus="...") before integrating${autoAuthNote}.`;
              } else {
                recommendedNextStep = `L1 (${diffSummary.tierReason}) — launch heterogeneous review via delegate_task(reviewOf="@${cleanRole}") before integrating${autoAuthNote}.`;
              }
              artifacts = {
                ...(diffSummary.branch ? { branch: diffSummary.branch } : {}),
                worktreePath: repoPath,
                ...(diffSummary.baseCommit ? { baseCommit: diffSummary.baseCommit } : {}),
                ...(diffSummary.headCommit ? { headCommit: diffSummary.headCommit } : {}),
                ...(diffSummary.snapshotOid ? { snapshotOid: diffSummary.snapshotOid } : {}),
                commitsAhead: diffSummary.commitsAhead,
                uncommittedCount: diffSummary.uncommittedFiles.length,
                changedFiles: diffSummary.changedFiles.slice(0, 20),
                changedFileCount: diffSummary.changedFiles.length,
                reviewTier: diffSummary.recommendedReviewTier,
                reviewTierReason: diffSummary.tierReason,
                recommendedNextStep,
              };
            }
          } catch {
            // Non-fatal: fall back to base artifacts if diff classification cannot run.
          }
        }
        if (!enrichedFromDiff) {
          const rawArtifacts = await collectWorkerReportArtifacts(
            repoPath,
            resolvedDispatch.branch,
            undefined,
            resolvedDispatch.baseCommit,
          );
          if (
            rawArtifacts &&
            (resolvedDispatch.worktreePath ||
              rawArtifacts.branch ||
              rawArtifacts.headCommit ||
              rawArtifacts.changedFileCount > 0)
          ) {
            artifacts = rawArtifacts;
          }
        }
      }
    }
    return this.workerDone({
      ...input,
      artifacts,
      mutatedReviewWorkspace,
      reviewVerificationFailed,
    });
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
      callerPaneId?: string;
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
    const firewall = this.review.getReviewFirewallContext(input.callerPaneId);
    const from = firewall ? input.callerPaneId! : input.from?.trim() || 'coordinator';
    const scope = this.resolveCallerMailbox({ from, runId: firewall ? undefined : input.runId });
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

    const callerMcpMode = this.isMcpEnabledForPane(from);
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
      const visible = firewall ? msgs.filter((message) => !this.review.isPostHiddenByReviewFirewall(message, firewall)) : msgs;
      if (!input.peek && !showAll && opts.deliveryId && visible.length) {
        const member = this.board.resolveBoardMemberForPane(from);
        if (member) this.store.recordBoardRead(member.runId, member.memberKey, visible.map(message => message.id));
      }
      const exposed = exposeMessages(this.store, visible);
      const formatted = shouldFormat
        ? visible
            .map((m, idx) =>
              formatMessageBanner(m, {
                cliCommand: this.cliCommand,
                followUp: exposed[idx]?.followUp,
                mcpMode: callerMcpMode,
                roleLabel: m.fromRole,
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
    callerPaneId?: string;
    runId?: string;
    limit?: number;
    types?: OrchestrationMessageType[];
    unreadOnly?: boolean;
  } = {}): {
    mailbox: string;
    messages: OrchestrationExposedMessage[];
    count: number;
  } {
    const firewall = this.review.getReviewFirewallContext(input.callerPaneId);
    const from = firewall ? input.callerPaneId! : input.from?.trim() || 'coordinator';
    const scope = this.resolveCallerMailbox({ from, runId: firewall ? undefined : input.runId });
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
    const visible = firewall ? msgs.filter((message) => !this.review.isPostHiddenByReviewFirewall(message, firewall)) : msgs;
    return {
      mailbox: scope.mailboxHandle,
      messages: exposeMessages(this.store, visible),
      count: visible.length,
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

        const askerRole =
          this.resolveRoleNameForDispatch(activeDispatch).toLowerCase() || undefined;
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
          fromRole: askerRole,
          mentions: ['coordinator'],
          refs: parseBoardRefs(questionText),
          kind: 'question',
        });
        if (askerRole && typeof msg.boardSeq === 'number') {
          this.store.advanceMemberCursor(msg.runId, askerRole, {
            lastPostSeq: msg.boardSeq,
          });
        }

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

        this.notifyTargetAndAliases(msg.toHandle, 'question', msg);
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
            this.notifyTargetAndAliases(`dispatch:${current.dispatchId}`, 'status', current.answerMessageId ? this.store.getMessageById(current.answerMessageId) : undefined);
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
            const asker = this.store.getDispatchContext(current.dispatchId);
            if (asker) this.store.recordBoardRead(current.runId, this.resolveRoleNameForDispatch(asker).toLowerCase() || asker.id, [current.answerMessageId]);
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
      const answeredBy = input.from?.trim() || original.toHandle;
      const targetDispatch = this.store.getDispatchContext(question.dispatchId);
      const targetRole = targetDispatch
        ? this.resolveRoleNameForDispatch(targetDispatch).toLowerCase() || undefined
        : undefined;
      const replierDispatch = this.store.getActiveDispatchForIdentity(answeredBy, answeredBy);
      const replierRole =
        answeredBy === 'user'
          ? 'user'
          : replierDispatch
            ? this.resolveRoleNameForDispatch(replierDispatch).toLowerCase() || 'worker'
            : 'coordinator';
      const answered = this.store.answerQuestion({
        messageId: question.messageId,
        answeredBy,
        body: input.body,
        fromRole: replierRole,
        mentions: targetRole ? [targetRole] : undefined,
        refs: original.boardSeq ? [original.boardSeq] : undefined,
      });
      this.store.recordBoardRead(question.runId, replierRole, [original.id]);
      this.store.recordHeartbeat(question.dispatchId);
      if (replierRole === 'coordinator' || replierRole === 'user') {
        this.peerPingPong.recordCoordinatorOrUserActivity(question.runId);
      }
      if (typeof answered.message.boardSeq === 'number') {
        this.store.advanceMemberCursor(question.runId, replierRole, {
          lastPostSeq: answered.message.boardSeq,
        });
      }

      const waitHandle = `question:${question.dispatchId}:${question.messageId}`;
      const wokeAsker = this.waiters.notify(waitHandle, 'status');
      if (!wokeAsker) {
        this.notifyTargetAndAliases(`dispatch:${question.dispatchId}`, 'status', answered.message);
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
    const member = input.from && this.board.resolveBoardMemberForPane(input.from);
    const senderRole = member && member.runId === original.runId ? member.role : undefined;
    const replyMsg = this.store.insertMessage({
      runId: original.runId,
      from: input.from?.trim() || original.toHandle,
      to: original.fromHandle,
      type: 'status',
      fromRole: senderRole,
      mentions: original.fromRole ? [original.fromRole] : undefined,
      refs: original.boardSeq ? [original.boardSeq] : undefined,
      kind: original.fromRole ? 'answer' : undefined,
      subject: original.subject.startsWith('Re:')
        ? original.subject
        : `Re: ${original.subject}`,
      body: input.body,
      threadId: original.threadId ?? original.id,
    });

    if (senderRole) {
      this.store.recordBoardRead(original.runId, senderRole, [original.id]);
      this.store.recordBoardReceipt([original.id], senderRole, 'replied');
    }
    this.notifyTargetAndAliases(replyMsg.toHandle, replyMsg.type, replyMsg);
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
    if (dispatch.stage === 'needs_reconciliation') return dispatch.stage;
    if (this.approvals.hasOpenApprovalForDispatch(dispatch.id)) {
      return 'waiting_permission';
    }
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const status = this.agentStatusStore.get(paneId);
    if (status?.state === 'waiting') {
      return status.waitKind === 'permission' ? 'waiting_permission' : 'waiting_input';
    }
    if (
      this.nativeQuestions.hasOpenQuestionForDispatch(dispatch.id) ||
      this.store.listQuestions({ dispatchId: dispatch.id, status: 'pending' }).length > 0
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
    const openNativeQuestions = this.nativeQuestions.listOpenQuestions({ dispatchId: dispatch.id });
    const terminal = dispatch.executionMode !== 'codex-app-server' && paneId
      ? this.terminalTracker?.getTerminal(paneId) ?? null : null;
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
    if (HEADLESS_WORKER_ID.test(from) && !this.canHeadlessWorkerDelegate(from)) {
      throw new OrchestrationError('operation_rejected', 'Headless Workers cannot start other Workers.');
    }
    const callerDispatch = this.store.getActiveDispatchForIdentity(from, from);
    this.assertCanDelegateFrom(from);
    this.assertWorkerStartControls(input, from);
    this.store.assertDispatchCapacity();

    if (input.taskId && this.store.getTask(input.taskId)?.queuedLaunch && (!queueClaim || this.claimedLaunches.get(input.taskId) !== queueClaim)) throw new OrchestrationError('task_not_ready', '任务由已批准的队列管理。');
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
    if (reusingTerminal && (HEADLESS_WORKER_ID.test(reusingTerminal) || !this.isPaneAlive(reusingTerminal))) {
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

    // Serialize concurrent adversarial review starts with per-Run integration locks and track
    // in-flight starts so an earlier peer's PASS cannot finalize or merge while a parallel peer is still booting.
    if (input.reviewOf?.trim()) {
      const targetPreview = this.resolveDispatchByRoleOrTarget(
        input.reviewOf.trim(),
        input.callerPaneId ?? from,
        input.runId,
      );
      return this.review.withInFlightReviewStart(`dispatch:${targetPreview.id}`, () =>
        this.withRunIntegrationLock(targetPreview.runId, () =>
          this.review.withReviewStartLock(targetPreview.id, () =>
            this.executeWorkerStartCore(input, from, callerDispatch, callerStatus, reusingTerminal, launchConfig),
          ),
        ),
      );
    }
    if (isReviewRunRequest) {
      const explicitRunTarget =
        typeof input.reviewRun === 'string' ? input.reviewRun.trim() : input.runId;
      const runPreview = this.resolveTargetRunForOperation(
        explicitRunTarget,
        input.callerPaneId,
        from,
      );
      // Share the per-Run integration lock so runFinalizeIntegration / workerIntegrate cannot
      // race ahead while a Run-level review terminal is booting and before runReviewStatus="pending" is persisted.
      return this.review.withInFlightReviewStart(`run:${runPreview.id}`, () =>
        this.withRunIntegrationLock(runPreview.id, () =>
          this.executeWorkerStartCore(input, from, callerDispatch, callerStatus, reusingTerminal, launchConfig),
        ),
      );
    }
    if (input.retryOfDispatchId) {
      const previous = this.store.getDispatchContext(input.retryOfDispatchId);
      if (previous?.codexDeliveryFailure === 'unknown_acceptance') {
        return this.mutateWorkerResources(previous, () => {
          if (this.store.getLatestDispatchForTask(previous.taskId)?.id !== previous.id || previous.lastFailureReason !== 'worker_stopped') {
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
    const normalizedInputContext = this.redactTaskContext(normalizeTaskContext(input));
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
      const target = this.resolveDispatchByRoleOrTarget(
        input.reviewOf.trim(),
        input.callerPaneId ?? from,
        input.runId,
      );
      if (input.callerPaneId !== undefined) {
        this.authorizeRunAccess(target.runId, input.callerPaneId);
      }
      if (ACTIVE_DISPATCH_STATUSES.has(target.status)) {
        throw new OrchestrationError(
          'operation_rejected',
          `Target worker ${target.id} is still active (${target.status}). Wait for it to report done before starting an adversarial review.`,
        );
      }
      if (target.cliId && this.listCodingAgentsDep) {
        const authorCli = normalizeWorkerCliId(target.cliId);
        const reviewerCli = normalizeWorkerCliId(launchConfig.cliId);
        if (authorCli && reviewerCli === authorCli) {
          const available = this.listCodingAgents(from).filter((entry) => entry.available);
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
      run = this.store.requireRun(target.runId);
      if (run.status !== 'active') {
        run = this.store.updateRunStatus(run.id, 'active');
      }
      const targetTask = this.store.requireTask(target.taskId);
      const targetPath = target.worktreePath ?? this.getDefaultCwd?.() ?? process.cwd();

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
        target.repoRootPath ?? this.getDefaultCwd?.() ?? null,
      );
      if (!mainRepoRoot) {
        throw new OrchestrationError(
          'operation_rejected',
          `Could not resolve Git repository root for ${target.id}; isolated detached review worktree is required.`,
        );
      }

      const effectiveReviewBase = await this.resolveEffectiveWorkerDiffBase(
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
          this.store.updateDispatchReviewState(target.id, { reviewStatus: 'escalated' });
          throw new OrchestrationError(
            'operation_rejected',
            `Adversarial review limit reached (${MAX_ADVERSARIAL_REVIEW_ROUNDS} rounds) for ${target.id}. Escalate the remaining disagreement to the user.`,
            { targetDispatchId: target.id, maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS },
          );
        }
        reviewBatchId = `rbat_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      }

      const effectiveMcpForReview =
        input.mcpEnabled ?? this.isMcpEnabledForCliDep?.(launchConfig.cliId) ?? false;
      const targetRole = this.resolveRoleNameForDispatch(target) || target.id;
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
        cliCommand: this.cliCommand,
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
      task = this.store.createTask({
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
      let targetRun = this.resolveTargetRunForOperation(
        explicitRunTarget,
        input.callerPaneId,
        from,
      );
      if (targetRun.status !== 'active') {
        targetRun = this.store.updateRunStatus(targetRun.id, 'active');
      }
      run = targetRun;
      reviewRunTarget = targetRun;

      const resolvedTarget = await this.resolveRunCombinedDiffTarget(targetRun, {
        requireCleanIntegrationWorktree: true,
      });
      if (this.listCodingAgentsDep) {
        const integratedAuthorClis = new Set<string>(
          resolvedTarget.integratedWorkers
            .map((w) => (w.cliId ? normalizeWorkerCliId(w.cliId) : ''))
            .filter(Boolean),
        );
        const reviewerCli = normalizeWorkerCliId(launchConfig.cliId);
        if (integratedAuthorClis.has(reviewerCli)) {
          const available = this.listCodingAgents(from).filter((entry) => entry.available);
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
          this.store.updateRunReviewState(targetRun.id, { runReviewStatus: 'escalated' });
          throw new OrchestrationError(
            'operation_rejected',
            `Run-level adversarial review limit reached (${MAX_ADVERSARIAL_REVIEW_ROUNDS} rounds) for ${targetRun.id}. Escalate the remaining disagreement to the user.`,
            { runId: targetRun.id, maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS },
          );
        }
        reviewBatchId = `rrbat_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
      }

      const effectiveMcpForReview =
        input.mcpEnabled ?? this.isMcpEnabledForCliDep?.(launchConfig.cliId) ?? false;
      const builtRunReview = buildRunAdversarialReviewTask({
        runId: targetRun.id,
        runObjective: targetRun.objective,
        diff: combinedDiff,
        integratedWorkers: resolvedTarget.integratedWorkers,
        reviewFocus: input.reviewFocus ?? (input.spec?.trim() || undefined),
        reviewRound: reviewRoundForTarget,
        maxRounds: MAX_ADVERSARIAL_REVIEW_ROUNDS,
        mcpEnabled: effectiveMcpForReview,
        cliCommand: this.cliCommand,
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
      task = this.store.createTask({
        singleShot: true,
        runId: run.id,
        spec: builtRunReview.taskSpec,
        taskContext: builtRunReview.taskContext,
        taskTitle: input.taskTitle ?? `Run-level adversarial review (${targetRun.id})`,
        displayName: reviewLabel,
        priority: input.priority ?? 'high',
      });
    } else if (input.retryOfDispatchId?.trim()) {
      const prior = this.store.getDispatchContext(input.retryOfDispatchId.trim());
      if (!prior) {
        throw new OrchestrationError(
          'dispatch_not_found',
          `Prior dispatch not found: ${input.retryOfDispatchId}`
        );
      }
      run = this.store.requireRun(prior.runId);
      if (input.callerPaneId !== undefined) this.board.resolveBoardCallerContext({ from: input.callerPaneId, runId: run.id });
      const priorTask = this.store.requireTask(prior.taskId);
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
        task = this.store.createTask({
          singleShot: true,
          runId: run.id,
          spec: input.spec?.trim() || priorTask.spec,
          ...(retryContext ? { taskContext: retryContext } : {}),
          taskTitle: input.taskTitle ?? `Retry: ${priorTask.taskTitle}`,
          displayName: input.displayName,
          priority: input.priority ?? priorTask.priority,
        });
      } else {
        task = this.store.requeueTaskForRetry(priorTask.id);
      }
    } else if (input.taskId?.trim()) {
      const existingTask = this.store.requireTask(input.taskId.trim());
      run = this.store.requireRun(existingTask.runId);
      if (input.callerPaneId !== undefined) this.board.resolveBoardCallerContext({ from: input.callerPaneId, runId: run.id });
      this.store.promoteReadyTasks(run.id);
      task = this.store.requireTask(existingTask.id);

    } else if (input.spec?.trim()) {
      const explicitRunId = input.runId?.trim();
      if (explicitRunId && input.callerPaneId !== undefined) {
        this.board.resolveBoardCallerContext({ from: input.callerPaneId, runId: explicitRunId });
      }
      let inferredRunId = explicitRunId || (input.callerPaneId === undefined
        ? this.inferRunIdOptional(from)
        : this.board.resolveBoardMemberForPane(from)?.runId);
      if (!explicitRunId && inferredRunId && !callerDispatch && from !== 'coordinator') {
        const candidateRun = this.store.getRun(inferredRunId);
        if (
          candidateRun?.coordinatorPaneId &&
          candidateRun.coordinatorPaneId !== from &&
          candidateRun.coordinatorHandle !== from
        ) {
          inferredRunId = undefined;
        }
      }
      if (inferredRunId) {
        run = this.store.requireRun(inferredRunId);
        if (run.status !== 'active') {
          run = this.store.updateRunStatus(run.id, 'active');
        }
      } else {
        const callerPane = callerStatus || this.isActiveSessionCoordinator(from) ? from : undefined;
        run = this.runCreate({
          objective: input.taskTitle?.trim() || input.spec.trim().slice(0, 120),
          from,
          paneId: callerPane,
        }).run;
      }
      createdTask = true;
      task = this.store.createTask({
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

    const parentPaneId = callerStatus || this.isActiveSessionCoordinator(from)
      ? from
      : (callerDispatch?.assigneePaneId ?? run.coordinatorPaneId ?? null);
    const parentTerminal = parentPaneId ? this.terminalTracker?.getTerminal(parentPaneId) : null;
    const baseCwd =
      input.cwd?.trim() ||
      task.worktreePath ||
      callerDispatch?.worktreePath ||
      input.callerCwd?.trim() ||
      parentTerminal?.cwd ||
      (parentPaneId ? this.sessionCoordinator(parentPaneId)?.cwd : undefined) ||
      this.getDefaultCwd?.() ||
      process.cwd();

    if (reusingTerminal) {
      const mismatch = this.paneMismatch(reusingTerminal, task.worktreePath ?? baseCwd, launchConfig.cliId);
      if (mismatch) {
        if (createdTask) this.failTaskIfReady(task.id);
        throw new OrchestrationError('terminal_unavailable', mismatch);
      }
    }
    const reusingTerminalCwd = reusingTerminal
      ? this.terminalTracker?.getTerminal(reusingTerminal)?.cwd
      : undefined;

    let effectiveBaseBranch = input.baseBranch;
    if (
      !reviewDetachedWorktree &&
      !effectiveBaseBranch?.trim() &&
      this.isRunIntegrationBranchLive(run) &&
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
      await this.verifyCodeInputs(task, placement.cwd);
    } catch (error) {
      if (placement.ownsWorktree) await this.rollbackWorkerResources(undefined, placement.worktreePath);
      if (createdTask) this.failTaskIfReady(task.id);
      throw error;
    }
    // A run a session coordinates runs every non-reused task of a headless-capable driver as a
    // headless Worker, even when the Codex pilot setting is off; terminal-coordinated runs keep the
    // read-only Codex pilot gate. A driver that cannot enforce the task's policy keeps a terminal.
    const runIsSessionCoordinated =
      AGENT_SESSION_ID.test(run.coordinatorPaneId ?? '') || this.isActiveSessionCoordinator(from);
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
        if (createdTask) this.failTaskIfReady(task.id);
        throw new OrchestrationError('operation_rejected', unsupported, { cliId: launchConfig.cliId });
      }
    }
    const headlessCli = !reusingTerminal && headlessWorkerSupports(launchConfig.cliId, workerPolicy)
      ? launchConfig.cliId as HeadlessWorkerDriver : null;
    const usePilot = headlessCli === 'codex'
      ? Boolean(this.codexPilot && (runIsSessionCoordinated || (readOnlyTask && this.codexPilot.enabled())))
      : Boolean(headlessCli && runIsSessionCoordinated && this.headlessWorkers &&
        this.headlessWorkers.available?.(headlessCli) !== false);
    const coordinatorSession =
      (run.coordinatorPaneId && this.isActiveSessionCoordinator(run.coordinatorPaneId)
        ? this.sessionCoordinator(run.coordinatorPaneId)
        : null) ??
      (this.isActiveSessionCoordinator(from) ? this.sessionCoordinator(from) : null);
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
        const spawned = await this.spawnWorkerPty!({
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
        this.exitedPanes.delete(spawned.ptyId);
        return spawned.ptyId;
      } catch (err) {
        if (placement.ownsWorktree && placement.worktreePath) {
          await this.rollbackWorkerResources(undefined, placement.worktreePath);
        }
        if (createdTask) this.failTaskIfReady(task.id);
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
      ctx = this.store.createDispatchContext({
        approvedQueueLaunch: task.queuedLaunch?.state === 'claimed' && this.claimedLaunches.has(task.id),
        taskId: task.id,
        assigneeHandle: pilot?.id ?? ptyId!,
        assigneePaneId: ptyId,
        ...(pilot ? {
          providerSessionId: pilot.sessionId, workerPolicy, workerNetwork, allowSubWorkers,
        } : {}),
        creator: from,
        creatorRunId: run.id,
        creatorDispatchId: callerDispatch?.id ?? null,
        parentDepth: this.resolveCallerDepth(from),
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
        maxDepth: this.maxDepth,
      });
      if (reviewTarget) {
        const latestTarget = this.store.getDispatchContext(reviewTarget.id);
        const alreadyRejectedSameBatch =
          Boolean(reviewBatchId) &&
          latestTarget?.reviewBatchId === reviewBatchId &&
          (latestTarget.reviewStatus === 'rejected' || latestTarget.reviewStatus === 'escalated');
        this.store.updateDispatchReviewState(reviewTarget.id, {
          reviewStatus: alreadyRejectedSameBatch ? latestTarget!.reviewStatus : 'pending',
          reviewRound: reviewRoundForTarget,
          reviewBatchId,
          reviewSnapshotOid,
          reviewBaseCommit,
        });
      }
      if (reviewRunTarget) {
        const latestRunTarget = this.store.getRun(reviewRunTarget.id);
        const alreadyRejectedSameRunBatch =
          Boolean(reviewBatchId) &&
          latestRunTarget?.runReviewBatchId === reviewBatchId &&
          (latestRunTarget.runReviewStatus === 'rejected' || latestRunTarget.runReviewStatus === 'escalated');
        this.store.updateRunReviewState(reviewRunTarget.id, {
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
      if (createdTask) this.failTaskIfReady(task.id);
      throw err;
    }

    const announcePane = (id: string) => {
      this.emitPaneSpawned({
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
      input.mcpEnabled ?? this.isMcpEnabledForCliDep?.(launchConfig.cliId) ?? false;
    const preambleRole =
      (input.role ?? input.displayName)?.trim().replace(/^@+/, '') || null;
    if (normalizedInputContext && (input.taskId || input.retryOfDispatchId)) {
      task = this.store.mergeTaskContext(task.id, normalizedInputContext);
    }
    const makePreamble = () => this.buildWorkerDispatchBrief({
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
        ctx.depth < this.maxDepth,
      mcpEnabled: ctx.executionMode === 'codex-app-server' || effectiveMcpEnabled,
      headless: ctx.executionMode === 'codex-app-server',
      leaveUncommitted: ctx.executionMode === 'codex-app-server' && workerPolicy !== 'read-only',
      role: preambleRole,
    });

    let preamble = makePreamble();
    if (task.queuedLaunch || task.codeDeps?.length) {
      try {
        await this.store.flushDurable();
        await this.verifyCodeInputs(task, placement.cwd);
      } catch (error) {
        if (pilot) await pilot.session.close();
        await this.rollbackWorkerResources(ownsPane ? ptyId ?? undefined : undefined, placement.ownsWorktree ? placement.worktreePath : null);
        this.store.failDispatch(ctx.id, 'Worker launch preflight failed before submission', { forceFailTask: true });
        throw error;
      }
    }
    let acceptedByCodex = false;
    if (pilot) {
      const outcome = await this.submitCodexTurn(ctx, pilot.session, preamble);
      if (outcome.status === 'not_accepted') {
        await pilot.session.close();
        if (this.disposed) throw new OrchestrationError('operation_rejected', 'Orchestration is closing.');
        try {
          ptyId = await spawnPane();
          ctx = this.store.switchUnacceptedCodexDispatchToPane(ctx.id, ptyId);
        } catch (error) {
          if (ptyId) await this.rollbackWorkerResources(ptyId);
          this.failCodexDispatch(ctx.id, 'not_accepted', outcome.reason);
          throw error;
        }
        ownsPane = true;
        this.store.cleanupDispatchBrief(ctx.id);
        preamble = makePreamble();
        announcePane(ptyId);
      } else if (outcome.status === 'unknown_acceptance') {
        await pilot.session.close();
        throw new OrchestrationError('prompt_delivery_failed', `${HEADLESS_DRIVER_LABELS[headlessCli!]} turn acceptance is unknown. Check Worker output before retrying.`, {
          dispatchId: ctx.id, taskId: task.id, acceptance: outcome.status,
        });
      } else {
        acceptedByCodex = true;
        this.emitPaneSpawned({
          ptyId: pilot.id, runId: run.id, taskId: task.id, dispatchId: ctx.id, parentPaneId,
          cwd: placement.cwd, worktreePath: placement.worktreePath, branch: placement.branch,
          cliId: launchConfig.cliId, ownsWorktree: placement.ownsWorktree, ownsPane: false,
          displayName: task.displayName ?? null, taskTitle: task.taskTitle, headless: true,
        });
      }
    }

    if (reusingTerminal) {
      const mismatch = this.paneMismatch(reusingTerminal, placement.cwd, launchConfig.cliId);
      if (mismatch) {
        this.store.failDispatch(ctx.id, mismatch, { forceFailTask: true });
        throw new OrchestrationError('terminal_unavailable', mismatch);
      }
    }
    const delivery = acceptedByCodex ? null : await this.deliverAndObserveDispatchTurn(ctx.id, {
      ptyId: ptyId!,
      prompt: preamble,
      submit: true,
    });

    if (delivery && !delivery.ok) {
      const reason = delivery.error ?? `Failed to deliver worker prompt to ${ptyId}`;
      this.store.failDispatch(ctx.id, reason);
      if (ctx.reviewOfDispatchId || ctx.reviewOfRunId) {
        this.store.updateDispatchReviewState(ctx.id, { reviewStatus: 'rejected' });
        this.failTaskIfReady(task.id);
        this.review.reconcileAnyReviewBatch(ctx.id, {
          overrideVerdict: 'reject',
          failedReason: 'Reviewer prompt delivery failed',
        });
      }
      const closed = await this.rollbackWorkerResources(
        ownsPane ? ptyId ?? undefined : undefined,
        placement.ownsWorktree ? placement.worktreePath : null,
      );
      if (closed && ownsPane && ptyId) {
        this.emitPaneClosed({ ptyId, runId: run.id, taskId: task.id, dispatchId: ctx.id });
      }
      this.emitChanged('dispatch:failed', run.id);
      throw new OrchestrationError('prompt_delivery_failed', reason, {
        dispatchId: ctx.id,
        taskId: task.id,
        ptyId,
      });
    }

    const updatedCtx = delivery
      ? this.store.updateDispatchObservation(ctx.id, delivery.startObservation, {
        reason: delivery.observationReason ?? null,
        refreshHeartbeat:
          delivery.startObservation === 'observed' ||
          delivery.startObservation === 'queued' ||
          delivery.startObservation === 'permission',
        ...(delivery.promptDeferred ? {} : { promptSent: true }),
      }) ?? ctx
      : this.store.getDispatchContext(ctx.id)?.stage === 'awaiting_review' ? this.store.getDispatchContext(ctx.id)!
      : this.store.updateDispatchObservation(ctx.id, 'observed', { refreshHeartbeat: true, promptSent: true }) ?? ctx;

    const briefFromRole = callerDispatch
      ? this.resolveRoleNameForDispatch(callerDispatch).toLowerCase() || 'worker'
      : 'coordinator';
    const briefWorkerRole =
      (input.role ?? input.displayName)?.trim().replace(/^@+/, '').toLowerCase() ||
      this.resolveRoleNameForDispatch(ctx).toLowerCase() ||
      ctx.id;
    const auditMsg = this.store.insertMessage({
      runId: run.id,
      from,
      to: `dispatch:${ctx.id}`,
      type: 'dispatch',
      subject: `Started worker for ${task.id}`,
      body: this.store.redactDispatchCredentials(preamble),
      fromRole: briefFromRole,
      mentions: briefWorkerRole ? [briefWorkerRole] : undefined,
      kind: 'brief',
    });
    this.store.markAsReadAndDelivered([auditMsg.id]);
    if (typeof auditMsg.boardSeq === 'number') {
      if (briefWorkerRole) {
        this.store.advanceMemberCursor(run.id, briefWorkerRole, {
          lastReadSeq: auditMsg.boardSeq,
          lastDeliveredSeq: auditMsg.boardSeq,
        });
      }
      this.store.advanceMemberCursor(run.id, briefFromRole, {
        lastPostSeq: auditMsg.boardSeq,
      });
    }

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
      ...(typeof auditMsg.boardSeq === 'number' ? { briefBoardSeq: auditMsg.boardSeq } : {}),
    };
  }

  /** Starts a headless Worker on `cliId`'s native protocol; null when it could not start, before any turn. */
  private async openCodexWorker(
    cliId: HeadlessWorkerDriver, cwd: string, model: string | null, options: HeadlessWorkerControls,
  ) {
    const codexPilot = this.codexPilot;
    const headlessWorkers = this.headlessWorkers;
    if (this.disposed || (cliId === 'codex' ? !codexPilot : !headlessWorkers)) return null;
    const id = `${cliId}-worker-${randomUUID()}`;
    let session: AgentSessionDriver | undefined;
    const timeline = this.createWorkerTimeline(
      id, cliId, model, { policy: options.policy, network: options.network }, (text) => session?.redactText(text) ?? text,
    );
    this.codexWorkerControls.set(id, { ...options });
    try {
      const launch = (events: AgentSessionEvents): AgentSessionDriver => cliId === 'codex'
        ? codexPilot!.launch(id, cwd, events, { ...options })
        : headlessWorkers!.launch(cliId, id, cwd, events, { ...options });
      session = launch({
        onTimeline: (dispatchId, event) => {
          if (timeline.activeTurn?.dispatchId === dispatchId) timeline.apply(event);
        },
        onTurnStarted: (dispatchId) => {
          const waiting = this.approvals.hasOpenApprovalForDispatch(dispatchId);
          const asking = this.nativeQuestions.hasOpenQuestionForDispatch(dispatchId);
          const updated = this.store.updateDispatchObservation(dispatchId, waiting ? 'permission' : 'observed', {
            promptSent: true, refreshHeartbeat: true,
          });
          if (updated && !waiting && !asking) this.store.updateDispatchStage(dispatchId, 'working');
          if (updated) this.emitChanged('worker:turn-started', updated.runId);
        },
        onTurnCompleted: (dispatchId, result) => this.completeCodexTurn(id, cwd, dispatchId, result),
        onRequest: async (dispatchId, request) => {
          const dispatch = this.store.getDispatchContext(dispatchId);
          if (!dispatch || dispatch.assigneeHandle !== id) return { decision: 'decline' };
          if (request.kind === 'question') {
            return this.nativeQuestions.holdQuestion(dispatch, {
              provider: headlessWorkerDriver(id) ?? dispatch.cliId ?? 'codex',
              method: request.method,
              questions: request.questions ?? [],
              signal: request.signal,
              redact: (text) => session?.redactText(text) ?? text,
            });
          }
          // Anything that is neither a question nor an approval fails closed.
          const allowed = request.kind === 'approval' && await this.approvals.holdCodexRequest(dispatch, request);
          return { decision: allowed ? 'accept' : 'decline' };
        },
        onExit: (reason, exitCode) => {
          const dispatchId = session?.latestTurnKey;
          if (session && dispatchId) this.archiveCodexOutput(session, dispatchId);
          timeline.endActiveTurn(session?.closing ? 'interrupted' : 'failed', reason);
          timeline.setMeta({ alive: false });
          this.archiveWorkerTimeline(id, dispatchId);
          this.workerTimelines.delete(id);
          this.codexWorkers.delete(id);
          this.codexMailbox.delete(id);
          this.codexWorkerControls.delete(id);
          this.approvals.cancelForPane(id, reason);
          this.nativeQuestions.cancelForWorker(id, reason);
          this.waiters.cancel(id);
          this.waiters.cancelConsumer(id);
          const announced = Boolean(dispatchId && !this.codexSubmitting.has(dispatchId) &&
            this.handleCodexExit(dispatchId, reason, exitCode));
          const exited = !announced && dispatchId ? this.store.getDispatchContext(dispatchId) : undefined;
          if (exited) this.emitChanged('worker:exited', exited.runId);
        },
      });
      this.codexWorkers.set(id, session);
      const sessionId = await session.open({ cwd, model, policy: options.policy, network: options.network });
      if (!session.alive || this.disposed) throw new Error(`${HEADLESS_DRIVER_LABELS[cliId]} closed during initialization`);
      timeline.setMeta({ providerSessionId: sessionId });
      return { id, session, sessionId };
    } catch (error) {
      // No turn was sent, so PTY fallback can safely proceed after process teardown.
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[orchestration] ${HEADLESS_DRIVER_LABELS[cliId]} headless Worker startup failed:`, session ? session.redactText(reason) : reason);
      this.codexWorkers.delete(id);
      this.codexWorkerControls.delete(id);
      await session?.close();
      this.workerTimelines.delete(id);
      return null;
    }
  }

  private archiveCodexOutput(session: AgentSessionDriver, dispatchId: string): void {
    const result = session.read(dispatchId, 0, undefined, true);
    if (result) this.store.archiveDispatchOutput(dispatchId, result.text);
  }

  private publishCodexStatus(
    dispatch: OrchestrationDispatchRecord, subject: string, body: string, payload: Record<string, unknown>,
  ): void {
    const to = this.resolveActiveParentMailbox(dispatch);
    this.store.insertMessage({
      runId: dispatch.runId, from: `dispatch:${dispatch.id}`, to,
      type: 'status', subject, body: this.store.redactDispatchCredentials(body),
      payload: this.store.redactDispatchCredentials(JSON.stringify({ dispatchId: dispatch.id, ...payload })),
      mentions: ['coordinator'], kind: 'post',
    });
    this.notifyTargetAndAliases(to, 'status');
    this.emitChanged('dispatch:codex-status', dispatch.runId);
  }

  private completeCodexTurn(workerId: string, cwd: string, dispatchId: string, result: AgentTurnResult): void {
    const session = this.codexWorkers.get(workerId);
    if (session) this.archiveCodexOutput(session, dispatchId);
    const label = this.headlessLabel(workerId);
    this.approvals.cancelForDispatch(dispatchId, `${label} turn ended`);
    this.nativeQuestions.cancelForDispatch(dispatchId, `${label} turn ended`);
    const timeline = this.workerTimelines.get(workerId);
    const status: WorkerTimelineTurnStatus = result.stopReason === 'completed' ? 'completed'
      : result.stopReason === 'interrupted' ? 'interrupted' : 'failed';
    timeline?.completeTurn({
      turnId: result.turnId, status, stopReason: result.stopReason, usage: result.usage, error: result.error,
    });
    this.store.recordCodexTurn(dispatchId, result);
    this.archiveWorkerTimeline(workerId, dispatchId);
    const dispatch = this.store.getDispatchContext(dispatchId);
    if (!dispatch || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return;
    const announce = (diff: string | null) => {
      if (this.disposed) return;
      const current = this.store.getDispatchContext(dispatchId);
      if (!current || !ACTIVE_DISPATCH_STATUSES.has(current.status) || current.codexTurn?.turnId !== result.turnId) return;
      if (diff !== result.diff) this.store.recordCodexTurn(dispatchId, { ...result, diff }, false);
      const liveTimeline = this.workerTimelines.get(workerId);
      liveTimeline?.addSettlement(dispatchId, {
        settlement: 'turn_pending_confirmation', stopReason: result.stopReason, outcome: null, verdict: null,
        findings: [], summary: result.finalText.slice(0, 4_000), diff,
        diffSource: diff === null ? null : result.diff !== null ? 'provider' : 'git',
      });
      this.archiveWorkerTimeline(workerId, dispatchId);
      this.publishCodexStatus(current, `${label} turn ended; result pending confirmation`,
        `${label} turn ${result.stopReason} without a recorded report_done. Read the Worker output and diff evidence before deciding what to do.\n\n${result.finalText.slice(0, 4_000)}`,
        { turnId: result.turnId, stopReason: result.stopReason, error: result.error, usage: result.usage, diff });
      this.deliverCodexMailbox(workerId);
    };
    if (result.diff !== null) {
      announce(result.diff);
    } else if (!this.disposed) {
      // Working-tree files can contain Worker credentials; redact before the diff is stored or published.
      const redactDiff = (diff: string) => this.store.redactDispatchCredentials(session?.redactText(diff) ?? diff);
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
    const dispatch = this.store.getDispatchContext(dispatchId);
    if (!dispatch || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return;
    if (failure === 'unknown_acceptance') return; // submitCodexTurn has already parked and archived it.
    const label = this.headlessLabel(dispatch.assigneeHandle);
    this.store.recordCodexDeliveryFailure(dispatchId, failure);
    this.store.failDispatch(dispatchId, `${label} ${failure}`, {
      forceFailTask: true, summary: this.store.redactDispatchCredentials(reason),
    });
    this.cleanupCodexDispatch(dispatch, `${label} delivery ${failure}`);
    this.publishCodexStatus(dispatch, `${label} delivery: ${failure}`, reason, { acceptance: failure });
  }

  private cleanupCodexDispatch(dispatch: OrchestrationDispatchRecord, reason: string): void {
    this.approvals.cancelForDispatch(dispatch.id, reason);
    this.nativeQuestions.cancelForDispatch(dispatch.id, reason);
    this.waiters.cancel(`dispatch:${dispatch.id}`);
    this.waiters.notifyPrefix(`question:${dispatch.id}:`, 'status');
    this.store.cleanupDispatchBrief(dispatch.id);
    if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
      this.store.updateDispatchReviewState(dispatch.id, { reviewStatus: 'rejected' });
      this.review.reconcileAnyReviewBatch(dispatch.id, { overrideVerdict: 'reject', failedReason: reason });
    }
  }

  private handleCodexExit(dispatchId: string, reason: string, exitCode: number | null): boolean {
    const dispatch = this.store.getDispatchContext(dispatchId);
    if (!dispatch?.promptSentAt || dispatch.stage === 'needs_reconciliation' || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return false;
    if (exitCode === 0 && dispatch.stage === 'awaiting_review') return false;
    const label = this.headlessLabel(dispatch.assigneeHandle);
    this.store.failDispatch(dispatch.id, dispatch.assigneeHandle.startsWith('codex-') ? 'Codex app-server exited' : `${label} exited`, {
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
    const timeline = this.workerTimelines.get(dispatch.assigneeHandle);
    timeline?.beginTurn({ dispatchId: dispatch.id, prompt });
    try {
      const controls = this.headlessControls(dispatch);
      const result = await session.startTurn({
        turnKey: dispatch.id, prompt, effort: dispatch.effort ?? null, policy: controls.policy, network: controls.network,
      });
      if (result.status !== 'accepted') timeline?.endActiveTurn('failed', result.reason);
      if (result.status === 'unknown_acceptance') {
        this.store.recordCodexDeliveryFailure(dispatch.id, result.status);
        this.archiveCodexOutput(session, dispatch.id);
        this.archiveWorkerTimeline(dispatch.assigneeHandle, dispatch.id);
        const cwd = dispatch.worktreePath;
        if (cwd) {
          const diff = await runGitCommand(['diff', '--no-ext-diff', '--no-textconv', 'HEAD', '--'], {
            cwd, readOnly: true, timeoutMs: 3000, maxBytes: 128 * 1024,
          }).catch(() => null);
          const files = await runGitCommand(['ls-files', '--others', '--exclude-standard'], {
            cwd, readOnly: true, timeoutMs: 3000, maxBytes: 16 * 1024,
          }).catch(() => null);
          this.store.recordReconciliationDiff(dispatch.id, diff?.exitCode === 0
            ? session.redactText([diff.stdout, files?.stdout].filter(Boolean).join('\n')) : null);
        }
        await this.store.flushDurable();
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

  private queueCodexMail(workerId: string, message?: OrchestrationMessageRecord): void {
    if (message) {
      const firewall = this.review.getReviewFirewallContext(workerId);
      if (firewall && this.review.isPostHiddenByReviewFirewall(message, firewall)) return;
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
      .map((message) => this.store.getMessageById(message.id) ?? message)
      .filter((message) => message.lifecycleRejectedReason === null && message.type !== 'heartbeat');
    const lookups = pending.opaque ? null : boardLookupCommands(messages);
    const notification = {
      prompt: lookups ? pointer + ' Fetch the referenced posts with ' + lookups + '.' : pointer,
      messages,
      inlined: false,
    };
    if (pending.opaque || messages.length === 0 || messages.length > 2) return notification;
    const rendered = this.store.redactDispatchCredentials(messages.map((message) => formatBoardPostForAgent(message)).join('\n\n'));
    if (rendered.length > 1_000) return notification;
    const prompt = `${rendered}\n\n(Full message above from AhaStation; no read_board call is needed for it. Continue the current assignment.)`;
    return { prompt, messages, inlined: true };
  }

  private acknowledgeCodexMail(workerId: string, messages: OrchestrationMessageRecord[]): void {
    this.store.markAsDeliveredForConsumer(messages.map((message) => message.id), workerId);
    const member = this.board.resolveBoardMemberForPane(workerId);
    const maxSeq = Math.max(0, ...messages
      .filter((message) => member && message.runId === member.runId && typeof message.boardSeq === 'number')
      .map((message) => message.boardSeq as number));
    if (member && maxSeq > 0) this.store.advanceMemberCursor(member.runId, member.memberKey, { lastDeliveredSeq: maxSeq });
  }

  private deliverCodexMailbox(workerId: string): void {
    const session = this.codexWorkers.get(workerId);
    const pending = this.codexMailbox.get(workerId);
    if (!session?.alive || session.busy || !pending) return;
    this.codexMailbox.delete(workerId);
    const dispatch = this.store.getActiveDispatchForIdentity(workerId, null);
    if (!dispatch || dispatch.stage === 'needs_reconciliation' || this.codexSubmitting.has(dispatch.id)) {
      if (dispatch) this.codexMailbox.set(workerId, pending);
      return;
    }
    const member = this.board.resolveBoardMemberForPane(workerId);
    const unreadMessages = pending.messages.filter(
      (message) => !(member && message.runId === member.runId && this.store.wasBoardPostRead(message.id, member.memberKey))
    );
    if (!pending.opaque && unreadMessages.length === 0) return;
    const { prompt, messages, inlined } = this.codexMailboxPrompt({
      opaque: pending.opaque,
      messages: unreadMessages,
    });
    if (!pending.opaque && messages.length === 0) return;
    void this.submitCodexTurn(dispatch, session, prompt).then(async (outcome) => {
      if (outcome.status === 'accepted') {
        const member = this.board.resolveBoardMemberForPane(workerId);
        this.acknowledgeCodexMail(workerId, messages);
        if (member && inlined) this.store.recordBoardRead(member.runId, member.memberKey, messages.map(m => m.id));
        if (member && this.store.recordBoardReceipt(messages.map(m => m.id), member.memberKey, inlined ? 'delivered' : 'notified')) {
          this.emitChanged('board:delivery', member.runId);
        }
      } else {
        this.failCodexDispatch(dispatch.id, outcome.status, outcome.reason);
        await session.close();
      }
    }).catch((error) => console.warn(`[orchestration] ${this.headlessLabel(workerId)} mailbox delivery failed:`, error));
  }

  private async followUpSettledWorker(
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
    const run = this.store.requireRun(settledDispatch.runId);
    if (run.status !== 'active') {
      this.store.updateRunStatus(run.id, 'active');
    }
    const prevTask = this.store.getTask(settledDispatch.taskId);
    const followUpInstructions = [
      input.subject,
      ...(input.body?.trim() ? ['', input.body.trim()] : []),
    ].join('\n');

    const existingPaneId = settledDispatch.assigneePaneId ?? settledDispatch.assigneeHandle;
    if (this.retiringPanes.has(existingPaneId)) {
      throw new OrchestrationError('operation_rejected', 'This worker terminal is still closing. Retry once it exits.');
    }
    const isHeadless = settledDispatch.executionMode === 'codex-app-server';
    const session = isHeadless ? this.codexWorkers.get(existingPaneId) : undefined;
    if (isHeadless && (!session?.alive || !await session.waitForIdle(15_000) || !session.alive ||
        this.store.getActiveDispatchForIdentity(existingPaneId, null))) {
      throw new OrchestrationError('dispatch_inactive', `${this.headlessLabel(existingPaneId)} Worker is unavailable or still finishing its previous turn.`);
    }
    const canReuseLivePane =
      Boolean(existingPaneId) &&
      this.isPaneAlive(existingPaneId) &&
      !this.store.getActiveDispatchForIdentity(existingPaneId, existingPaneId);

    const originalDispatchId = this.store.listDispatchAncestorIds(settledDispatch.id).at(-1);
    const originalDispatch = originalDispatchId ? this.store.getDispatchContext(originalDispatchId) : undefined;
    const originalTask = originalDispatch ? this.store.getTask(originalDispatch.taskId) : prevTask;
    const followUpSpec = !canReuseLivePane && originalTask
      ? ['### Follow-up Instructions', followUpInstructions, '### Original Task', originalTask.spec].join('\n\n')
      : followUpInstructions;
    const followUpTask = this.store.createTask({
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
    const controls = session ? this.headlessControls(settledDispatch) : null;
    let nextCtx: OrchestrationDispatchRecord;
    try {
      nextCtx = this.store.createDispatchContext({
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

    const followUpRole = this.resolveRoleNameForDispatch(settledDispatch) || null;
    const followUpFromRole =
      input.fromRole?.trim().replace(/^@+/, '').toLowerCase() ||
      (from === 'user' ? 'user' : 'coordinator');
    const msg =
      input.existingMessage ??
      this.store.insertMessage({
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
    this.store.linkFollowUpMessage(nextCtx.id, msg.id);
    if (!input.existingMessage) {
      this.store.markAsReadAndDelivered([msg.id]);
    }
    const coordinatorHandle = this.resolveActiveParentMailbox(nextCtx);
    const followUpMcpEnabled = nextCtx.cliId
      ? (this.isMcpEnabledForCliDep?.(nextCtx.cliId) ?? false)
      : false;
    const preamble = this.buildWorkerDispatchBrief({
      taskId: followUpTask.id,
      dispatchId: nextCtx.id,
      runId: settledDispatch.runId,
      taskSpec: followUpTask.spec,
      taskContext: reusedPane || session ? null : followUpTask.taskContext,
      coordinatorHandle,
      workerHandle: targetPtyId,
      worktreePath: nextCtx.worktreePath,
      branch: nextCtx.branch,
      canDispatchSubWorkers: (!session || controls?.allowSubWorkers === true) && nextCtx.depth < this.maxDepth,
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
      if (followUpRole) this.store.recordBoardRead(settledDispatch.runId, followUpRole.toLowerCase(), [msg.id]);
      this.emitChanged('worker:follow-up', settledDispatch.runId);
      return {
        message: exposeMessage(msg),
        followUp: {
          reactivated: true, previousDispatchId: settledDispatch.id,
          dispatch: this.store.getDispatchContext(nextCtx.id)!,
          task: this.store.requireTask(followUpTask.id), reusedPane: false,
        },
      };
    }

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

    if (!delivery.promptDeferred && followUpRole) {
      this.store.recordBoardRead(settledDispatch.runId, followUpRole.toLowerCase(), [msg.id]);
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
  } = {}, callerPaneId?: string): {
    workers: OrchestrationWorkerSummary[];
    count: number;
  } {
    const includeSettled = input.includeSettled !== false;
    const firewall = callerPaneId !== undefined ? this.review.getReviewFirewallContext(callerPaneId) : null;
    const dispatches = this.store
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
      this.authorizeRunAccess(dispatch.runId, callerPaneId);
      this.review.assertNotFirewalledReviewRead(callerPaneId, dispatch, 'worker-show');
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
      this.authorizeRunAccess(dispatch.runId, callerPaneId);
      this.review.assertNotFirewalledReviewRead(callerPaneId, dispatch, 'worker-read');
    }
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    const codex = this.codexWorkers.get(dispatch.assigneeHandle);
    const headlessRead = codex?.read(dispatch.id, input.cursor, input.limit, input.screen);
    if (headlessRead) {
      return {
        ...headlessRead, ptyId: dispatch.assigneeHandle, dispatchId: dispatch.id,
        text: this.store.redactDispatchCredentials(headlessRead.text),
        archived: !headlessRead.alive || Boolean(dispatch.releasedAt),
      };
    }

    if (dispatch.executionMode !== 'codex-app-server' && paneId && this.terminalTracker) {
      const liveRead = this.terminalTracker.readOutput(paneId, {
        cursor: input.cursor,
        limit: input.limit,
        screen: input.screen,
      });
      if (liveRead && (liveRead.alive || !dispatch.archivedOutput)) {
        return {
          ...liveRead,
          text: this.store.redactDispatchCredentials(liveRead.text),
          dispatchId: dispatch.id,
          archived: !liveRead.alive || Boolean(dispatch.releasedAt),
        };
      }
    }

    const archived = this.store.redactDispatchCredentials(dispatch.archivedOutput ?? '');
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
    const dispatch = this.store.resolveDispatchLineage(rawTarget.id) ?? rawTarget;
    return this.mutateWorkerResources(dispatch, () => this.releaseWorker(dispatch, input));
  }

  private async releaseWorker(
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

    if (!input.force && !integratedSnapshotOid && this.store.hasUnreadReportFromDispatch(dispatch.id)) {
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
      dispatch.repoRootPath ??
      (dispatch.parentPaneId
        ? this.terminalTracker?.getTerminal(dispatch.parentPaneId)?.cwd ??
          this.sessionCoordinator(dispatch.parentPaneId)?.cwd
        : undefined) ??
      this.getDefaultCwd?.() ??
      null;

    const codex = this.codexWorkers.get(dispatch.assigneeHandle);
    const shouldCloseCodex = codex && !input.keepPane &&
      (!dispatch.retained || Boolean(input.force) || Boolean(integratedSnapshotOid));
    let closedPane = false;
    const shouldClosePane =
      Boolean(dispatch.ownsPane) &&
      Boolean(paneId) &&
      this.isPaneAlive(paneId) &&
      !input.keepPane &&
      (!dispatch.retained || Boolean(input.force) || Boolean(integratedSnapshotOid));
    // A pane explicitly kept open continues to use its worktree.
    const worktreeToRemove = dispatch.ownsWorktree && !input.keepWorktree &&
      (shouldClosePane || shouldCloseCodex || !this.isPaneAlive(paneId)) ? dispatch.worktreePath : null;
    const forceRemoveWorktree = Boolean(input.force || dispatch.isDetachedReviewWorktree);
    if (worktreeToRemove && !forceRemoveWorktree && !integratedSnapshotOid) await assertWorkerWorktreeClean(worktreeToRemove);

    if (shouldCloseCodex) await codex.close(true);

    if (shouldClosePane && paneId) {
      await this.confirmWorkerPaneClosed(paneId);
      this.spawnedWorkerPanes.delete(paneId);
      this.spawnedWorkerMeta.delete(paneId);
      this.markPtyExited(paneId);
      this.store.markDispatchPaneClosed(dispatch.id);
      closedPane = true;
      this.emitPaneClosed({
        ptyId: paneId,
        runId: dispatch.runId,
        taskId: dispatch.taskId,
        dispatchId: dispatch.id,
      });
    }

    if (integratedSnapshotOid && dispatch.ownsWorktree) {
      const verified = worktreeToRemove && !this.isPaneAlive(paneId)
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
        this.emitChanged('worker:release-incomplete', dispatch.runId);
        return {
          dispatch: this.store.getDispatchContext(dispatch.id) ?? dispatch,
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

    for (const id of this.store.listDispatchAncestorIds(dispatch.id)) this.store.cleanupDispatchBrief(id);
    if (worktreeToRemove && !removedWorktree) {
      // Do NOT mark releasedAt when worktree deletion failed so cleanup remains retryable and honest.
      this.emitChanged('worker:release-incomplete', dispatch.runId);
      return {
        dispatch: this.store.getDispatchContext(dispatch.id) ?? dispatch,
        closedPane,
        removedWorktree: false,
        removedBranch,
        worktreeError,
      };
    }

    const released = this.store.markDispatchReleased(dispatch.id, {
      keepPane: !closedPane,
      keepWorktree: !removedWorktree,
    });
    this.emitChanged('worker:released', released.runId);
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

    const lineageIds = new Set(this.store.listDispatchAncestorIds(dispatch.id));

    const stoppedHelperIds: string[] = [];
    const childSeedDispatches = this.store
      .listDispatches({ runId: dispatch.runId })
      .filter((child) => Boolean(child.creatorDispatchId && lineageIds.has(child.creatorDispatchId)));

    for (const seed of childSeedDispatches) {
      const child = this.store.resolveDispatchLineage(seed.id) ?? seed;
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

    this.approvals.cancelForDispatch(dispatch.id, input.reason || 'Worker stopped');
    this.nativeQuestions.cancelForDispatch(dispatch.id, input.reason || 'Worker stopped');
    if (!headless && paneId) {
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
      if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
        this.store.updateDispatchReviewState(dispatch.id, { reviewStatus: 'rejected' });
        this.review.reconcileAnyReviewBatch(dispatch.id, {
          overrideVerdict: 'reject',
          failedReason: 'Reviewer stopped before completing verification',
        });
      }
    } else {
      this.store.updateDispatchStage(dispatch.id, 'stopped');
      settled = this.store.getDispatchContext(dispatch.id) ?? settled;
    }

    if (codex) {
      this.archiveWorkerTimeline(dispatch.assigneeHandle, dispatch.id);
      await codex.close(true);
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
      dispatch.repoRootPath ??
      (dispatch.parentPaneId
        ? this.terminalTracker?.getTerminal(dispatch.parentPaneId)?.cwd ??
          this.sessionCoordinator(dispatch.parentPaneId)?.cwd
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

    for (const id of lineageIds) this.store.cleanupDispatchBrief(id);
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
    const headless = dispatch.executionMode === 'codex-app-server';
    const codex = headless ? this.codexWorkers.get(dispatch.assigneeHandle) : undefined;
    if (codex) this.archiveCodexOutput(codex, dispatch.id);

    this.approvals.cancelForDispatch(dispatch.id, input.reason || 'Worker abandoned');
    this.nativeQuestions.cancelForDispatch(dispatch.id, input.reason || 'Worker abandoned');
    if (codex) this.archiveWorkerTimeline(dispatch.assigneeHandle, dispatch.id);
    if (!headless && paneId) {
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
      if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
        this.store.updateDispatchReviewState(dispatch.id, { reviewStatus: 'rejected' });
        this.review.reconcileAnyReviewBatch(dispatch.id, {
          overrideVerdict: 'reject',
          failedReason: 'Reviewer dispatch abandoned before completing verification',
        });
      }
    }
    if (codex) void codex.close(true);
    const warning = headless
      ? 'Dispatch abandoned; its headless Codex session has been retired.'
      : 'Dispatch abandoned in orchestration state without killing any external process; use worker-stop to terminate the PTY.';
    this.emitChanged('worker:abandoned', settled.runId);
    return {
      dispatch: this.store.getDispatchContext(settled.id) ?? settled,
      task: this.store.requireTask(settled.taskId),
      warning,
    };
  }

  reset(input: {
    historyOnly?: boolean;
    discardRunId?: string;
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
    if (input.historyOnly && scope === 'all') {
      const result = this.store.clearFinishedHistory(input.discardRunId);
      this.emitChanged('history:cleared');
      return result;
    }
    const protectedRuns = this.store.listRuns().map(run => ({ id: run.id, reason: this.store.protectedRunReason(run.id) })).filter(run => run.reason);
    if (protectedRuns.length) throw new OrchestrationError('operation_rejected', protectedRuns.map(run => `${run.id}：${run.reason}`).join('；'), { protectedRuns });
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
        this.nativeQuestions.cancelForDispatch(d.id, 'Orchestration state reset');
        const pty = d.assigneePaneId ?? d.assigneeHandle;
        if (pty) this.turnStopMonitor.cancelForPane(pty);
      }
      for (const codex of this.codexWorkers.values()) void codex.close(true);
      this.proposals.cancelAllPendingProposals('Orchestration state reset');
      this.inFlightObservationDispatches.clear();
    }
    if (scope === 'all' || scope === 'messages') {
      this.waiters.dispose();
      this.peerPingPong.clearAll();
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

  // ==================== Pane Mode, Roster, Proposals & Semantic MCP Delegation ====================

  setPaneOrchestrationMode(ptyId: string, enabled: boolean): { ptyId: string; enabled: boolean } {
    const cleanId = ptyId.trim();
    if (!cleanId) {
      throw new OrchestrationError('invalid_argument', 'Missing ptyId.');
    }
    if (enabled) {
      this.orchestrationModePanes.add(cleanId);
    } else {
      this.orchestrationModePanes.delete(cleanId);
    }
    this.emitChanged('pane-mode:changed');
    return { ptyId: cleanId, enabled };
  }

  isPaneOrchestrationMode(ptyId: string): boolean {
    const cleanId = ptyId.trim();
    if (AGENT_SESSION_ID.test(cleanId)) return this.isActiveSessionCoordinator(cleanId);
    return this.orchestrationModePanes.has(cleanId);
  }

  recordUserPromptTurn(ptyId: string, source: UserTurnSource = 'hook'): number {
    const cleanId = ptyId.trim();
    if (source === 'session' && !AGENT_SESSION_ID.test(cleanId)) return this.proposals.getUserTurn(cleanId);
    if (
      source === 'pty' &&
      this.agentStatusStore.get(cleanId)?.state === 'working' &&
      this.proposals.hasPendingChatProposalForCurrentTurn?.(cleanId)
    ) {
      return this.proposals.getUserTurn(cleanId);
    }
    return this.proposals.recordUserTurn(ptyId, source);
  }

  listCodingAgents(callerPaneId?: string | null): OrchestrationAgentRosterEntry[] {
    if (!this.listCodingAgentsDep) {
      return [];
    }
    const cwd = callerPaneId ? this.sessionCoordinator(callerPaneId)?.cwd ?? this.terminalTracker?.getTerminal(callerPaneId)?.cwd : undefined;
    return this.listCodingAgentsDep({
      callerPaneId: callerPaneId ?? null,
      includeIdlePanes: true,
    }).map(entry => ({ ...entry, idlePanes: entry.idlePanes.filter(pane => !this.paneMismatch(pane.ptyId, cwd, entry.cliId)) }));
  }

  approveDispatchProposal(
    id: string,
    overrides?: DispatchProposalOverrides
  ): { proposal: OrchestrationDispatchProposal } {
    return this.proposals.approveProposal(id, overrides);
  }

  rejectDispatchProposal(
    id: string,
    reason?: string
  ): { proposal: OrchestrationDispatchProposal } {
    return this.proposals.rejectProposal(id, reason);
  }

  private resolveRoleNameForDispatch(dispatch: OrchestrationDispatchRecord): string {
    const visited = new Set<string>();
    let current: OrchestrationDispatchRecord | undefined = dispatch;
    let fallbackName = '';
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const task = this.store.getTask(current.taskId);
      const rawDisplay = task?.displayName?.trim().replace(/^@+/, '') ?? '';
      if (rawDisplay) {
        if (!current.followUpOfDispatchId) {
          return rawDisplay;
        }
        if (!fallbackName && !rawDisplay.startsWith('Follow-up:')) {
          fallbackName = rawDisplay;
        }
      }
      current = current.followUpOfDispatchId
        ? this.store.getDispatchContext(current.followUpOfDispatchId)
        : undefined;
    }
    return fallbackName;
  }

  private listManagedDispatchesForCaller(callerPaneId: string): OrchestrationDispatchRecord[] {
    const cleanCaller = callerPaneId.trim();
    const callerActive = this.store.getActiveDispatchForIdentity(cleanCaller, cleanCaller);
    const callerBoundRun = this.store.getCurrentRunForConsumer(cleanCaller);
    const all = this.store.listDispatches();
    const byHeadId = new Map<string, OrchestrationDispatchRecord>();

    const ownDispatchIds = new Set<string>();
    if (callerActive) {
      let cur: OrchestrationDispatchRecord | undefined = callerActive;
      while (cur && !ownDispatchIds.has(cur.id)) {
        ownDispatchIds.add(cur.id);
        cur = cur.followUpOfDispatchId
          ? this.store.getDispatchContext(cur.followUpOfDispatchId)
          : undefined;
      }
    }

    for (const d of all) {
      const isManaged = callerActive
        ? Boolean(d.creatorDispatchId && ownDispatchIds.has(d.creatorDispatchId))
        : d.parentPaneId === cleanCaller ||
          d.creator === cleanCaller ||
          Boolean(
            callerBoundRun &&
              d.runId === callerBoundRun.id &&
              (callerBoundRun.coordinatorPaneId === cleanCaller ||
                callerBoundRun.coordinatorHandle === cleanCaller)
          );
      if (!isManaged) continue;
      const head = this.store.resolveDispatchLineage(d.id) ?? d;
      if (head.assigneePaneId === cleanCaller || head.assigneeHandle === cleanCaller) continue;
      byHeadId.set(head.id, head);
    }

    return [...byHeadId.values()];
  }

  private resolveDispatchByRoleOrTarget(
    rawTarget: string,
    callerHint?: string,
    runIdHint?: string,
  ): OrchestrationDispatchRecord {
    const cleaned = rawTarget.trim();
    if (!cleaned) {
      throw new OrchestrationError('invalid_argument', 'Missing target worker role or dispatch id.');
    }
    const idCandidate = cleaned.startsWith('dispatch:')
      ? cleaned.slice('dispatch:'.length).trim()
      : cleaned;
    const direct = this.store.resolveDispatchLineage(idCandidate) ?? this.store.getDispatchContext(idCandidate);
    if (direct) return direct;

    const byTask = this.store.getLatestDispatchForTask(idCandidate);
    if (byTask) return this.store.resolveDispatchLineage(byTask.id) ?? byTask;

    const cleanRole = cleaned.replace(/^@+/, '').toLowerCase();
    const scopedRunId =
      runIdHint?.trim() ||
      (callerHint ? this.inferRunIdOptional(callerHint) : undefined);
    const candidates = this.store
      .listDispatches(scopedRunId ? { runId: scopedRunId } : undefined)
      .reverse();
    for (const d of candidates) {
      const role = this.resolveRoleNameForDispatch(d).toLowerCase();
      if (role === cleanRole || d.assigneePaneId === cleaned || d.assigneeHandle === cleaned) {
        return this.store.resolveDispatchLineage(d.id) ?? d;
      }
    }
    throw new OrchestrationError('dispatch_not_found', `Worker not found: ${rawTarget}`);
  }

  async workerDiff(
    input: {
      dispatchId?: string;
      worker?: string;
      taskId?: string;
      files?: string[];
      maxDiffBytes?: number;
    },
    callerPaneId?: string,
  ): Promise<WorkerDiffInspection & {
    dispatchId: string;
    taskId: string;
    role: string;
    reviewStatus: string;
    reviewRound: number;
    integrationStatus: string;
  }> {
    const rawTarget = input.dispatchId?.trim() || input.worker?.trim() || input.taskId?.trim() || '';
    const dispatch = rawTarget
      ? this.resolveDispatchByRoleOrTarget(rawTarget, callerPaneId)
      : this.resolveTargetDispatch(input);
    if (callerPaneId !== undefined) {
      this.authorizeRunAccess(dispatch.runId, callerPaneId);
      this.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
    }
    const worktreePath =
      dispatch.worktreePath ??
      (dispatch.assigneePaneId
        ? this.terminalTracker?.getTerminal(dispatch.assigneePaneId)?.cwd
        : undefined) ??
      this.getDefaultCwd?.() ??
      process.cwd();
    const run = this.store.getRun(dispatch.runId);
    const mainRepoRoot = run
      ? await resolveMainRepoRoot(worktreePath, dispatch.repoRootPath ?? this.getDefaultCwd?.() ?? null).catch(() => null)
      : null;
    const snapForBase = mainRepoRoot
      ? await captureWorkerSnapshotOid(worktreePath, { rejectStagedDivergence: false }).catch(() => null)
      : null;
    const effectiveBaseCommit = run
      ? await this.resolveEffectiveWorkerDiffBase(
          run,
          dispatch,
          worktreePath,
          mainRepoRoot,
          snapForBase?.snapshotOid ?? null,
        )
      : dispatch.baseCommit;
    const inspection = await inspectWorkerDiff({
      worktreePath,
      baseCommit: effectiveBaseCommit,
      files: input.files,
      maxDiffBytes: input.maxDiffBytes,
    });
    return {
      ...inspection,
      dispatchId: dispatch.id,
      taskId: dispatch.taskId,
      role: this.resolveRoleNameForDispatch(dispatch) || dispatch.id,
      reviewStatus: dispatch.reviewStatus ?? 'none',
      reviewRound: dispatch.reviewRound ?? 0,
      integrationStatus: dispatch.integrationStatus ?? 'none',
    };
  }

  async workerIntegrate(
    input: {
      dispatchId?: string;
      worker?: string;
      taskId?: string;
      mode?: WorkerIntegrateMode;
      targetBranch?: WorkerIntegrateTargetBranch;
      expectedSnapshotOid?: string;
      commitMessage?: string;
      releaseAfter?: boolean;
      deleteBranch?: boolean;
      force?: boolean;
    },
    callerPaneId?: string,
  ): Promise<WorkerIntegrationResult & {
    dispatchId: string;
    taskId: string;
    role: string;
    usedRunIntegrationBranch: boolean;
    released: boolean;
    releasedReviews: number;
    releaseSkippedReason?: string;
    cleanupWarnings?: string[];
    recommendedNextStep?: string;
  }> {
    const rawTarget = input.dispatchId?.trim() || input.worker?.trim() || input.taskId?.trim() || '';
    const dispatch = rawTarget
      ? this.resolveDispatchByRoleOrTarget(rawTarget, callerPaneId)
      : this.resolveTargetDispatch(input);
    if (callerPaneId !== undefined) {
      this.authorizeRunAccess(dispatch.runId, callerPaneId);
      this.assertRunCoordinator(dispatch.runId, callerPaneId);
    }
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      throw new OrchestrationError(
        'operation_rejected',
        `Worker ${dispatch.id} is still active (${dispatch.status}). Wait for completion before integrating.`,
      );
    }
    if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
      throw new OrchestrationError(
        'operation_rejected',
        `Dispatch ${dispatch.id} is a read-only adversarial review and cannot be integrated.`,
      );
    }

    const mode: WorkerIntegrateMode = input.mode ?? 'squash';
    const role = this.resolveRoleNameForDispatch(dispatch) || dispatch.id;
    const task = this.store.requireTask(dispatch.taskId);
    this.store.requireRun(dispatch.runId);
    const worktreePath = dispatch.worktreePath;
    if (!worktreePath) {
      return {
        mode,
        checkStatus: 'clean',
        integrated: false,
        noChanges: true,
        clean: true,
        targetRepoPath: '',
        targetBranch: null,
        targetRef: null,
        snapshotOid: '',
        integratedCommit: null,
        conflictFiles: [],
        ignoredCollisionFiles: [],
        changedFiles: [],
        message: 'Worker has no recorded worktree path; nothing to merge.',
        dispatchId: dispatch.id,
        taskId: dispatch.taskId,
        role,
        usedRunIntegrationBranch: false,
        released: false,
        releasedReviews: 0,
      };
    }

    const mainRepoRoot = await resolveMainRepoRoot(
      worktreePath,
      dispatch.repoRootPath ?? this.getDefaultCwd?.() ?? null,
    );
    const normWt = process.platform === 'win32' ? worktreePath.toLowerCase() : worktreePath;
    const normMain = mainRepoRoot
      ? process.platform === 'win32'
        ? mainRepoRoot.toLowerCase()
        : mainRepoRoot
      : null;

    if (!mainRepoRoot || (!dispatch.ownsWorktree && normMain === normWt)) {
      this.store.updateDispatchIntegrationState(dispatch.id, { integrationStatus: 'skipped' });
      return {
        mode,
        checkStatus: 'clean',
        integrated: false,
        noChanges: false,
        clean: true,
        targetRepoPath: mainRepoRoot ?? worktreePath,
        targetBranch: dispatch.branch ?? null,
        targetRef: null,
        snapshotOid: '',
        integratedCommit: null,
        conflictFiles: [],
        ignoredCollisionFiles: [],
        changedFiles: [],
        message: !mainRepoRoot
          ? 'Non-git workspace: no branch merge required. Review files directly and release when ready.'
          : 'Worker ran directly in the main workspace (no isolated branch to merge). Review changes and release when ready.',
        dispatchId: dispatch.id,
        taskId: dispatch.taskId,
        role,
        usedRunIntegrationBranch: false,
        released: false,
        releasedReviews: 0,
      };
    }

    const executeIntegrate = async () => {
      const run = this.store.requireRun(dispatch.runId);
      if (run.integrationIntent) throw new OrchestrationError('operation_rejected', '上一次 Git 交付尚待核对。');
      const latestDispatch = this.store.getDispatchContext(dispatch.id) ?? dispatch;
      const hasActiveRunIntegrationBranch = this.isRunIntegrationBranchLive(run);
      const sameRunRepo = run.integrationRepoRootPath
        ? await isSameGitRepo(mainRepoRoot, run.integrationRepoRootPath)
        : true;

      if (hasActiveRunIntegrationBranch && !sameRunRepo) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} already has an active integration branch (${run.integrationBranch}) in a different Git repository (${run.integrationRepoRootPath}). Finalize it before integrating workers from another repository.`,
          { runId: run.id, integrationBranch: run.integrationBranch },
        );
      }
      if (run.integrationRepoRootPath && !sameRunRepo) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} integration tracking is bound to a different Git repository (${run.integrationRepoRootPath}) and cannot integrate workers from ${mainRepoRoot}. Start a separate Run for the other repository.`,
          {
            runId: run.id,
            integrationRepoRootPath: run.integrationRepoRootPath,
            workerRepoRootPath: mainRepoRoot,
          },
        );
      }
      const effectiveTargetBranch: WorkerIntegrateTargetBranch = input.targetBranch ?? 'auto';
      if (effectiveTargetBranch === 'main' && hasActiveRunIntegrationBranch) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} already has an active integration branch (${run.integrationBranch}). Integrate into targetBranch="integration" or finalize the Run integration branch first to avoid splitting Run changes.`,
          { runId: run.id, integrationBranch: run.integrationBranch },
        );
      }

      let useRunIntegrationBranch = false;
      if (effectiveTargetBranch === 'integration') {
        useRunIntegrationBranch = true;
      } else if (effectiveTargetBranch === 'auto') {
        if (hasActiveRunIntegrationBranch) {
          useRunIntegrationBranch = true;
        } else {
          const mainStatus = await getGitStatus(mainRepoRoot);
          useRunIntegrationBranch = Boolean(
            mainStatus.ok && mainStatus.isGitRepo && mainStatus.entries.length > 0,
          );
        }
      }

      if (
        useRunIntegrationBranch &&
        !hasActiveRunIntegrationBranch &&
        (run.integrationBranch || run.integrationWorktreePath)
      ) {
        const retainedBranchExists = run.integrationBranch
          ? Boolean(await resolveBranchRefOid(mainRepoRoot, run.integrationBranch))
          : false;
        const retainedWorktreeExists = run.integrationWorktreePath
          ? existsSync(run.integrationWorktreePath)
          : false;
        if (retainedBranchExists || retainedWorktreeExists) {
          throw new OrchestrationError(
            'operation_rejected',
            `Run ${run.id} retained a previous integration branch or worktree (${run.integrationBranch ?? run.integrationWorktreePath}). Remove it before starting a new integration branch wave.`,
            {
              runId: run.id,
              integrationBranch: run.integrationBranch,
              integrationWorktreePath: run.integrationWorktreePath,
            },
          );
        }
      }

      // Server-side adversarial review gate for write modes (`squash` / `merge`).
      // Terminal/HTTP callers (`callerPaneId !== undefined`) cannot override review gates with `force`.
      const manualUserOverride = callerPaneId === undefined && input.force === true;
      const callerExpectedOid = input.expectedSnapshotOid?.trim() || undefined;
      let authoritativeExpectedOid: string | undefined = callerExpectedOid;

      if (mode !== 'check') {
        const reviewStatus = latestDispatch.reviewStatus ?? 'none';
        if (reviewStatus === 'passed') {
          const approvedOid = latestDispatch.reviewSnapshotOid?.trim() || '';
          if (!approvedOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Worker ${latestDispatch.id} has reviewStatus=passed but no server-recorded approved snapshot OID. Re-run adversarial review before integrating.`,
            );
          }
          if (callerExpectedOid && callerExpectedOid !== approvedOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Caller expectedSnapshotOid (${callerExpectedOid}) does not match server-approved review snapshot (${approvedOid}).`,
              { callerExpectedOid, approvedSnapshotOid: approvedOid },
            );
          }
          authoritativeExpectedOid = approvedOid;
        } else if (!manualUserOverride) {
          if (reviewStatus === 'pending') {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: adversarial review for ${latestDispatch.id} is still pending. Wait for all reviewers in batch ${latestDispatch.reviewBatchId ?? '(current)'} to report PASS.`,
            );
          }
          if (reviewStatus === 'rejected' || reviewStatus === 'escalated') {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: adversarial review for ${latestDispatch.id} is ${reviewStatus}. Fix blocking findings and pass a new review round before integrating.`,
            );
          }
          // reviewStatus === 'none': only explicit L0 changes are exempt from adversarial review.
          // Evaluate L0 against the exact merge-base(targetHead, snapshotOid)..snapshotOid range
          // that integration will actually merge (never a stale or fallback HEAD~1).
          const l0Snap = await captureWorkerSnapshotOid(worktreePath, { rejectStagedDivergence: true });
          if (!l0Snap.snapshotOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: could not capture worker snapshot for L0 review exemption on ${latestDispatch.id}.`,
            );
          }
          const l0TargetRepo =
            useRunIntegrationBranch && hasActiveRunIntegrationBranch
              ? run.integrationWorktreePath!
              : mainRepoRoot;
          const mergeBase = await resolveIntegrationMergeBase(l0TargetRepo, l0Snap.snapshotOid);
          if (!mergeBase) {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: could not determine common Git merge-base for L0 review exemption on ${latestDispatch.id}.`,
            );
          }
          const diffPreview = await inspectWorkerDiff({
            worktreePath,
            baseCommit: mergeBase,
            maxDiffBytes: 8 * 1024,
          });
          if (!diffPreview.snapshotOid || diffPreview.snapshotOid !== l0Snap.snapshotOid ||
              diffPreview.diffError || diffPreview.stagedDivergentFiles.length > 0 ||
              diffPreview.recommendedReviewTier !== 'L0') {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: ${diffPreview.recommendedReviewTier} change (${diffPreview.diffError || diffPreview.tierReason}) requires a passing adversarial review before ${mode} integration.`,
              {
                recommendedReviewTier: diffPreview.recommendedReviewTier,
                tierReason: diffPreview.tierReason,
                dispatchId: latestDispatch.id,
              },
            );
          }
          if (callerExpectedOid && callerExpectedOid !== diffPreview.snapshotOid) {
            throw new OrchestrationError('operation_rejected', 'Worker snapshot changed since inspection. Inspect it again.');
          }
          authoritativeExpectedOid = diffPreview.snapshotOid;
        }
      }

      const branchOidBeforeIntegrate =
        latestDispatch.ownsBranch && latestDispatch.branch?.startsWith(WORKER_BRANCH_PREFIX)
          ? await resolveBranchRefOid(mainRepoRoot, latestDispatch.branch)
          : null;

      const commitMessage =
        input.commitMessage?.trim() ||
        `chore(orchestration): integrate @${role} (${task.taskTitle.slice(0, 72)})`;

      const targetRepoForBase =
        useRunIntegrationBranch && hasActiveRunIntegrationBranch
          ? run.integrationWorktreePath!
          : mainRepoRoot;
      const currentSnapForBase =
        authoritativeExpectedOid ??
        (await captureWorkerSnapshotOid(worktreePath, { rejectStagedDivergence: false }).catch(() => null))
          ?.snapshotOid ??
        null;
      let effectiveIntegrationBaseCommit: string | null = latestDispatch.baseCommit ?? null;
      if (
        latestDispatch.reviewStatus === 'passed' &&
        latestDispatch.reviewSnapshotOid &&
        latestDispatch.reviewBaseCommit &&
        (mode !== 'check' || latestDispatch.reviewSnapshotOid === currentSnapForBase)
      ) {
        effectiveIntegrationBaseCommit = latestDispatch.reviewBaseCommit;
      } else if (latestDispatch.baseCommit && currentSnapForBase) {
        const stillDescendsFromRecordedBase = await isGitCommitAncestor(
          worktreePath,
          latestDispatch.baseCommit,
          currentSnapForBase,
        );
        if (!stillDescendsFromRecordedBase) {
          effectiveIntegrationBaseCommit = await resolveIntegrationMergeBase(
            targetRepoForBase,
            currentSnapForBase,
          );
        }
      }

      const beforePublish: NonNullable<Parameters<typeof integrateWorkerChanges>[0]['beforePublish']> = async evidence => {
        this.store.updateRunIntegrationState(run.id, { integrationIntent: { ...evidence, repo: mainRepoRoot, dispatchId: latestDispatch.id } });
        await this.store.flushDurable();
      };
      let result: WorkerIntegrationResult;
      let runBranchResult: Awaited<ReturnType<typeof integrateWorkerIntoRunBranch>> | null = null;
      if (useRunIntegrationBranch) {
        runBranchResult = await integrateWorkerIntoRunBranch({
          beforePublish,
          mainRepoRoot,
          runId: run.id,
          existingBranch: hasActiveRunIntegrationBranch ? run.integrationBranch : null,
          existingWorktreePath: hasActiveRunIntegrationBranch ? run.integrationWorktreePath : null,
          existingBaseCommit: run.integrationBaseCommit ?? null,
          existingBaseBranch: run.integrationBaseBranch ?? null,
          worktreePath,
          baseCommit: effectiveIntegrationBaseCommit,
          recordedBaseCommit: latestDispatch.baseCommit,
          expectedSnapshotOid: authoritativeExpectedOid,
          strictReviewedTree: true,
          mode,
          commitMessage,
        });
        result = runBranchResult.result;
      } else {
        const expectedMainRef =
          sameRunRepo && run.integrationBaseBranch?.trim()
            ? `refs/heads/${run.integrationBaseBranch.trim()}`
            : null;
        result = await integrateWorkerChanges({
          beforePublish,
          targetRepoPath: mainRepoRoot,
          worktreePath,
          baseCommit: effectiveIntegrationBaseCommit,
          recordedBaseCommit: latestDispatch.baseCommit,
          expectedSnapshotOid: authoritativeExpectedOid,
          expectedTargetRef: expectedMainRef,
          strictReviewedTree: true,
          mode,
          commitMessage,
        });
      }

      if (mode === 'check') {
        this.store.updateDispatchIntegrationState(latestDispatch.id, {
          integrationStatus: result.clean ? 'checked' : 'conflict',
        });
        this.emitChanged('worker:integration-checked', latestDispatch.runId);
        return {
          ...result,
          dispatchId: latestDispatch.id,
          taskId: latestDispatch.taskId,
          role,
          usedRunIntegrationBranch: useRunIntegrationBranch,
          released: false,
          releasedReviews: 0,
        };
      }

      if (!result.integrated && !result.noChanges) {
        this.store.updateDispatchIntegrationState(latestDispatch.id, { integrationStatus: 'conflict' });
        this.emitChanged('worker:integration-conflict', latestDispatch.runId);
        return {
          ...result,
          dispatchId: latestDispatch.id,
          taskId: latestDispatch.taskId,
          role,
          usedRunIntegrationBranch: useRunIntegrationBranch,
          released: false,
          releasedReviews: 0,
        };
      }

      // If this was a brand-new Run integration branch with zero diff, integrateWorkerIntoRunBranch
      // rolled back the empty branch/worktree so no Run integration branch became active.
      const effectiveUsedRunBranch =
        useRunIntegrationBranch && (hasActiveRunIntegrationBranch || result.integrated);

      this.store.updateDispatchIntegrationState(latestDispatch.id, {
        integrationStatus: 'merged',
        noChanges: result.noChanges,
        integratedCommit: result.integratedCommit,
        integratedTargetBranch: effectiveUsedRunBranch ? result.targetBranch : (useRunIntegrationBranch ? null : result.targetBranch),
      });

      const latestRun = this.store.requireRun(run.id);
      this.store.updateRunIntegrationState(run.id, { integrationIntent: null });
      if (effectiveUsedRunBranch && runBranchResult) {
        this.store.updateRunIntegrationState(run.id, {
          integrationBranch: runBranchResult.integrationBranch,
          integrationWorktreePath: runBranchResult.integrationWorktreePath,
          integrationBaseCommit: latestRun.integrationBaseCommit ?? runBranchResult.integrationBaseCommit,
          integrationBaseBranch: latestRun.integrationBaseBranch ?? runBranchResult.integrationBaseBranch,
          integrationRepoRootPath: mainRepoRoot,
          integrationStatus: 'active',
          integrationHeadCommit: result.integratedCommit,
          finalizedCommit: null,
        });
      } else if (!useRunIntegrationBranch && sameRunRepo) {
        const reopeningAfterFinalized =
          result.integrated && !result.noChanges && latestRun.integrationStatus === 'finalized';
        this.store.updateRunIntegrationState(run.id, {
          integrationBaseCommit: latestRun.integrationBaseCommit ?? result.targetHeadBefore ?? null,
          integrationBaseBranch: latestRun.integrationBaseBranch ?? result.targetBranch ?? null,
          integrationRepoRootPath: latestRun.integrationRepoRootPath ?? mainRepoRoot,
          integrationHeadCommit: result.integratedCommit,
          ...(reopeningAfterFinalized
            ? { integrationStatus: 'none', finalizedCommit: null }
            : {}),
        });
      }

      // Reset Wave 1's completed Run-level review metadata when starting a brand-new
      // integration wave AFTER a prior finalization (whether via aha/run/* or directly on main).
      // Within an active wave, preserve `runReviewStatus === 'passed'` + `runReviewSnapshotOid`
      // so `runFinalizeIntegration` strictly enforces TOCTOU until a fresh Run-level review passes.
      if (
        (effectiveUsedRunBranch || (!useRunIntegrationBranch && sameRunRepo)) &&
        result.integrated &&
        !result.noChanges &&
        latestRun.integrationStatus === 'finalized'
      ) {
        this.store.updateRunReviewState(run.id, {
          runReviewStatus: 'none',
          runReviewRound: 0,
          runReviewBatchId: null,
          runReviewSnapshotOid: null,
          runReviewBaseCommit: null,
          runReviewFindings: [],
        });
      }

      const runDispatches = this.store
        .listDispatches({ runId: latestDispatch.runId })
        .filter((d) => !d.reviewOfDispatchId && !d.reviewOfRunId);
      const latestByTask = new Map<string, OrchestrationDispatchRecord>();
      for (const d of runDispatches) {
        const prev = latestByTask.get(d.taskId);
        if (!prev || (d.processGeneration ?? 0) >= (prev.processGeneration ?? 0)) {
          latestByTask.set(d.taskId, d);
        }
      }
      const implWorkers = [...latestByTask.values()];
      const remainingWorkers = implWorkers.filter(
        (d) =>
          d.id !== latestDispatch.id &&
          d.integrationStatus !== 'merged' &&
          d.integrationStatus !== 'skipped' &&
          d.status !== 'failed' &&
          d.status !== 'circuit_broken' &&
          !d.releasedAt,
      );
      const mergedCount = implWorkers.filter((d) => d.integrationStatus === 'merged').length;
      let recommendedNextStep: string | undefined;
      if (effectiveUsedRunBranch && result.targetBranch) {
        recommendedNextStep =
          remainingWorkers.length === 0
            ? `All active workers are staged on ${result.targetBranch} (main workspace untouched). Next: inspect_run_diff(), optionally delegate_task(reviewRun=true), and call finalize_run_integration() once main is clean.`
            : `Staged on ${result.targetBranch} (${remainingWorkers.length} other worker(s) remaining). Continue integrating remaining workers, then finalize_run_integration().`;
      } else if (remainingWorkers.length === 0 && mergedCount >= 2) {
        recommendedNextStep =
          'All workers integrated into main. You may run inspect_run_diff() / delegate_task(reviewRun=true) for a combined Run-level check before reporting final results.';
      }

      const boardMsg = this.store.insertMessage({
        runId: latestDispatch.runId,
        from: callerPaneId || 'coordinator',
        to: `run:${latestDispatch.runId}`,
        type: 'status',
        subject: `Integrated @${role}${effectiveUsedRunBranch && result.targetBranch ? ` -> ${result.targetBranch}` : ''}`,
        body: result.noChanges
          ? `[@${role}] No diff relative to ${result.targetBranch ?? 'HEAD'}; marked integrated.`
          : `[@${role}] ${result.message}${effectiveUsedRunBranch && result.targetBranch ? ` on ${result.targetBranch}` : ''}`,
        fromRole: 'coordinator',
        mentions: [role.toLowerCase()],
        kind: 'update',
        artifacts: {
          branch: result.targetBranch,
          headCommit: result.integratedCommit?.slice(0, 10) ?? null,
          snapshotOid: result.snapshotOid,
          changedFiles: result.changedFiles.slice(0, 20),
          changedFileCount: result.changedFiles.length,
          ...(recommendedNextStep ? { recommendedNextStep } : {}),
        },
      });
      this.store.markAsReadAndDelivered([boardMsg.id]);

      let released = false;
      let releasedReviews = 0;
      let releaseSkippedReason: string | undefined;
      const cleanupWarnings: string[] = result.cleanupWarning ? [result.cleanupWarning] : [];

      if (input.releaseAfter !== false) {
        // Collect reviews attached to any dispatch in this author's lineage.
        const lineageIds = this.store.listDispatchAncestorIds(latestDispatch.id);
        const seenReviewIds = new Set<string>();
        for (const ancestorId of lineageIds) {
          const reviews = this.store.listReviewDispatchesForTarget(ancestorId);
          for (const rev of reviews) {
            if (seenReviewIds.has(rev.id)) continue;
            seenReviewIds.add(rev.id);
            if ((!rev.releasedAt || rev.ownsWorktree) && !ACTIVE_DISPATCH_STATUSES.has(rev.status)) {
              try {
                const revRel = await this.workerRelease({ dispatchId: rev.id, force: true });
                if (revRel.worktreeError) {
                  cleanupWarnings.push(`Review ${rev.id} worktree cleanup failed: ${revRel.worktreeError}`);
                } else if (revRel.dispatch.releasedAt) {
                  releasedReviews += 1;
                }
              } catch (err) {
                cleanupWarnings.push(
                  `Review ${rev.id} cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
        }

        try {
          const rel = await this.mutateWorkerResources(latestDispatch, async () => {
            const current = this.store.getDispatchContext(latestDispatch.id);
            const head = this.store.resolveDispatchLineage(latestDispatch.id);
            if (!current || head?.id !== latestDispatch.id) {
              throw new OrchestrationError('operation_rejected', 'Worker lineage changed; retained worktree and branch.');
            }
            return this.releaseWorker(current, {
              dispatchId: latestDispatch.id,
              keepBranch: input.deleteBranch === false,
              expectedBranchOid: branchOidBeforeIntegrate,
            }, result.snapshotOid);
          });
          if (rel.worktreeError) {
            releaseSkippedReason = rel.worktreeError;
            cleanupWarnings.push(rel.worktreeError);
          } else {
            released = Boolean(rel.dispatch.releasedAt);
            if (rel.removedWorktree && latestDispatch.ownsBranch && input.deleteBranch !== false && !rel.removedBranch) {
              cleanupWarnings.push('Worker branch was retained because Git could not safely delete it.');
            }
          }
        } catch (error) {
          releaseSkippedReason = 'Worker cleanup deferred: ' + (error instanceof Error ? error.message : String(error));
          cleanupWarnings.push(releaseSkippedReason);
        }
      }

      this.emitChanged('worker:integrated', latestDispatch.runId);
      return {
        ...result,
        dispatchId: latestDispatch.id,
        taskId: latestDispatch.taskId,
        role,
        usedRunIntegrationBranch: effectiveUsedRunBranch,
        released,
        releasedReviews,
        ...(releaseSkippedReason ? { releaseSkippedReason } : {}),
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
        ...(recommendedNextStep ? { recommendedNextStep } : {}),
      };
    };

    return mode === 'check'
      ? executeIntegrate()
      : this.withRunIntegrationLock(dispatch.runId, executeIntegrate);
  }

  async runDiff(
    input: {
      runId?: string;
      files?: string[];
      maxDiffBytes?: number;
    },
    callerPaneId?: string,
  ): Promise<RunCommitRangeDiffInspection & {
    runId: string;
    hasIntegratedChanges: boolean;
    integrationStatus: string;
    integrationBranch: string | null;
    integrationWorktreePath: string | null;
    runReviewStatus: string;
    runReviewRound: number;
    runReviewSnapshotOid: string | null;
    integratedWorkers: Array<{
      dispatchId: string;
      role: string;
      cliId: string | null;
      integratedCommit: string | null;
    }>;
    message?: string;
  }> {
    const run = this.resolveTargetRunForOperation(input.runId, callerPaneId);
    const target = await this.resolveRunCombinedDiffTarget(run);
    const workersSummary = target.integratedWorkers.map((w) => ({
      dispatchId: w.dispatchId,
      role: w.role,
      cliId: w.cliId ?? null,
      integratedCommit: w.integratedCommit ?? null,
    }));

    if (!target.hasChanges || !target.repoPath || !target.baseCommit || !target.targetCommit) {
      return {
        isGitRepo: Boolean(target.mainRepoRoot),
        repoPath: target.repoPath ?? '',
        branch: target.branch,
        baseCommit: target.baseCommit,
        targetCommit: target.targetCommit,
        commitsAhead: 0,
        commits: [],
        changedFiles: [],
        diffStat: '',
        diff: '',
        diffTruncated: false,
        recommendedReviewTier: 'L0',
        tierReason: 'no integrated changes recorded for run',
        runId: run.id,
        hasIntegratedChanges: false,
        integrationStatus: run.integrationStatus ?? 'none',
        integrationBranch: run.integrationBranch ?? null,
        integrationWorktreePath: run.integrationWorktreePath ?? null,
        runReviewStatus: run.runReviewStatus ?? 'none',
        runReviewRound: run.runReviewRound ?? 0,
        runReviewSnapshotOid: run.runReviewSnapshotOid ?? null,
        integratedWorkers: workersSummary,
        message: 'No integrated changes recorded for this run yet.',
      };
    }

    const inspection = await inspectCommitRangeDiff({
      repoPath: target.repoPath,
      baseCommit: target.baseCommit,
      targetCommit: target.targetCommit,
      branch: target.branch,
      files: input.files,
      maxDiffBytes: input.maxDiffBytes,
    });
    return {
      ...inspection,
      runId: run.id,
      hasIntegratedChanges: inspection.changedFiles.length > 0 || inspection.commitsAhead > 0,
      integrationStatus: run.integrationStatus ?? 'none',
      integrationBranch: run.integrationBranch ?? null,
      integrationWorktreePath: run.integrationWorktreePath ?? null,
      runReviewStatus: run.runReviewStatus ?? 'none',
      runReviewRound: run.runReviewRound ?? 0,
      runReviewSnapshotOid: run.runReviewSnapshotOid ?? null,
      integratedWorkers: workersSummary,
    };
  }

  async runFinalizeIntegration(
    input: {
      runId?: string;
      mode?: WorkerIntegrateMode;
      expectedSnapshotOid?: string;
      commitMessage?: string;
      deleteBranch?: boolean;
      keepWorktree?: boolean;
      force?: boolean;
    },
    callerPaneId?: string,
  ): Promise<WorkerIntegrationResult & {
    runId: string;
    integrationBranch: string;
    integrationWorktreePath: string;
    removedWorktree: boolean;
    removedBranch: boolean;
    releasedReviews: number;
    cleanupWarnings?: string[];
  }> {
    const initialRun = this.resolveTargetRunForOperation(input.runId, callerPaneId);
    const mode: WorkerIntegrateMode = input.mode ?? 'squash';
    const executeFinalize = async () => {
      const run = this.store.requireRun(initialRun.id);
      if (run.integrationIntent) throw new OrchestrationError('operation_rejected', '上一次 Git 交付尚待核对。');
      if (
        !this.isRunIntegrationBranchLive(run) ||
        !run.integrationBranch ||
        !run.integrationWorktreePath ||
        !run.integrationRepoRootPath
      ) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} does not have an active integration branch to finalize (status=${run.integrationStatus ?? 'none'}).`,
          { runId: run.id, integrationStatus: run.integrationStatus ?? 'none' },
        );
      }

      const manualUserOverride = callerPaneId === undefined && input.force === true;
      const callerExpectedOid = input.expectedSnapshotOid?.trim() || undefined;
      let authoritativeExpectedOid: string | undefined = callerExpectedOid;

      if (mode !== 'check') {
        const activeDispatches = this.store
          .listDispatches({ runId: run.id })
          .filter((d) => ACTIVE_DISPATCH_STATUSES.has(d.status));
        if (activeDispatches.length > 0) {
          throw new OrchestrationError(
            'operation_rejected',
            `Run ${run.id} still has ${activeDispatches.length} active dispatch(es) (${activeDispatches.map((d) => d.id).join(', ')}). Wait for all workers/reviews to settle before finalizing.`,
            { activeDispatchIds: activeDispatches.map((d) => d.id) },
          );
        }

        const runReviewStatus = run.runReviewStatus ?? 'none';
        if (runReviewStatus === 'passed') {
          const approvedOid = run.runReviewSnapshotOid?.trim() || '';
          if (!approvedOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Run ${run.id} has runReviewStatus=passed without a recorded snapshot OID. Re-run Run-level adversarial review before finalizing.`,
            );
          }
          if (callerExpectedOid && callerExpectedOid !== approvedOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Caller expectedSnapshotOid (${callerExpectedOid}) does not match Run-level approved snapshot (${approvedOid}).`,
              { callerExpectedOid, approvedSnapshotOid: approvedOid },
            );
          }
          authoritativeExpectedOid = approvedOid;
        } else if (!manualUserOverride) {
          if (runReviewStatus === 'pending') {
            throw new OrchestrationError(
              'operation_rejected',
              `Finalization blocked: Run-level adversarial review for ${run.id} is still pending (batch ${run.runReviewBatchId ?? '(current)'}).`,
            );
          }
          if (runReviewStatus === 'rejected' || runReviewStatus === 'escalated') {
            throw new OrchestrationError(
              'operation_rejected',
              `Finalization blocked: Run-level adversarial review for ${run.id} is ${runReviewStatus}. Fix blocking findings and pass a new Run-level review before finalizing.`,
            );
          }
        }
      }

      const expectedBaseBranch = run.integrationBaseBranch?.trim() || '';
      if (!expectedBaseBranch) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} has no recorded target branch (started from detached HEAD); refusing to finalize ${run.integrationBranch} into an arbitrary checked-out branch. Checkout the intended branch and merge ${run.integrationBranch} manually.`,
          { runId: run.id, integrationBranch: run.integrationBranch },
        );
      }
      const expectedTargetRef = `refs/heads/${expectedBaseBranch}`;
      const commitMessage =
        input.commitMessage?.trim() ||
        `chore(orchestration): finalize run ${run.id} (${run.objective.slice(0, 72)})`;

      const members: Record<string, string> = {};
      let sourceHead = '';
      const finalized: RunFinalizeIntegrationResult = await finalizeRunIntegrationBranch({
        beforePublish: async evidence => {
          sourceHead = evidence.sourceHead;
          for (const worker of this.store.listDispatches({ runId: run.id })) {
            if (worker.integrationStatus === 'merged' && worker.integratedTargetBranch === run.integrationBranch &&
                worker.integratedCommit && await isGitCommitAncestor(run.integrationRepoRootPath!, worker.integratedCommit, sourceHead)) {
              members[worker.id] = worker.integratedCommit;
            }
          }
          this.store.updateRunIntegrationState(run.id, { integrationIntent: { ...evidence, repo: run.integrationRepoRootPath!, members } });
          await this.store.flushDurable();
        },
        mainRepoRoot: run.integrationRepoRootPath,
        integrationBranch: run.integrationBranch,
        integrationWorktreePath: run.integrationWorktreePath,
        baseCommit: run.integrationBaseCommit ?? null,
        expectedTargetRef,
        expectedSnapshotOid: authoritativeExpectedOid,
        strictReviewedTree: true,
        mode,
        commitMessage,
        deleteBranch: input.deleteBranch,
        keepWorktree: input.keepWorktree,
      });

      if (mode === 'check') {
        return {
          ...finalized.result,
          runId: run.id,
          integrationBranch: finalized.integrationBranch,
          integrationWorktreePath: finalized.integrationWorktreePath,
          removedWorktree: false,
          removedBranch: false,
          releasedReviews: 0,
        };
      }

      if (!finalized.result.integrated && !finalized.result.noChanges) {
        this.store.updateRunIntegrationState(run.id, { integrationStatus: 'conflict' });
        this.emitChanged('run:integration-conflict', run.id);
        return {
          ...finalized.result,
          runId: run.id,
          integrationBranch: finalized.integrationBranch,
          integrationWorktreePath: finalized.integrationWorktreePath,
          removedWorktree: false,
          removedBranch: false,
          releasedReviews: 0,
          ...(finalized.cleanupWarnings.length > 0 ? { cleanupWarnings: finalized.cleanupWarnings } : {}),
        };
      }

      const cleanupWarnings = [...finalized.cleanupWarnings];
      let releasedReviews = 0;
      for (const rev of this.store.listReviewDispatchesForRun(run.id)) {
        if ((!rev.releasedAt || rev.ownsWorktree) && !ACTIVE_DISPATCH_STATUSES.has(rev.status)) {
          try {
            const revRel = await this.workerRelease({ dispatchId: rev.id, force: true });
            if (revRel.worktreeError) {
              cleanupWarnings.push(`Run review ${rev.id} worktree cleanup failed: ${revRel.worktreeError}`);
            } else if (revRel.dispatch.releasedAt) {
              releasedReviews += 1;
            }
          } catch (err) {
            cleanupWarnings.push(
              `Run review ${rev.id} cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }


      this.store.updateRunIntegrationState(run.id, {
        integrationIntent: null,
        ...(sourceHead && finalized.result.integratedCommit ? { finalizedBatch: {
          sourceHead, targetCommit: finalized.result.integratedCommit, branch: expectedBaseBranch, members,
        } } : {}),
        integrationStatus: 'finalized',
        finalizedCommit: finalized.result.integratedCommit,
        integrationHeadCommit: finalized.result.integratedCommit,
        integrationWorktreePath: finalized.removedWorktree ? null : run.integrationWorktreePath,
        integrationBranch: finalized.removedBranch ? null : run.integrationBranch,
      });

      const boardMsg = this.store.insertMessage({
        runId: run.id,
        from: callerPaneId || 'coordinator',
        to: `run:${run.id}`,
        type: 'status',
        subject: `Finalized ${finalized.integrationBranch} -> ${finalized.result.targetBranch ?? 'main'}`,
        body: finalized.result.noChanges
          ? `[Run ${run.id}] No diff between ${finalized.integrationBranch} and ${finalized.result.targetBranch ?? 'HEAD'}; marked finalized.`
          : `[Run ${run.id}] Promoted ${finalized.integrationBranch} into ${finalized.result.targetBranch ?? 'main'}: ${finalized.result.message}`,
        fromRole: 'coordinator',
        kind: 'update',
        artifacts: {
          branch: finalized.result.targetBranch,
          headCommit: finalized.result.integratedCommit?.slice(0, 10) ?? null,
          snapshotOid: finalized.result.snapshotOid,
          changedFiles: finalized.result.changedFiles.slice(0, 20),
          changedFileCount: finalized.result.changedFiles.length,
        },
      });
      this.store.markAsReadAndDelivered([boardMsg.id]);

      this.emitChanged('run:integration-finalized', run.id);
      return {
        ...finalized.result,
        runId: run.id,
        integrationBranch: finalized.integrationBranch,
        integrationWorktreePath: finalized.integrationWorktreePath,
        removedWorktree: finalized.removedWorktree,
        removedBranch: finalized.removedBranch,
        releasedReviews,
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      };
    };

    return mode === 'check'
      ? executeFinalize()
      : this.withRunIntegrationLock(initialRun.id, executeFinalize);
  }

  setRunAutoReview(input: { runId: string; enabled: boolean }): { run: OrchestrationRunRecord } {
    return this.review.setRunAutoReview(input);
  }

  async delegateTask(
    input: {
      from?: string;
      role?: string;
      task?: string;
      reviewOf?: string;
      reviewRun?: boolean | string;
      reviewFocus?: string;
      authorizeReviews?: boolean;
      taskContext?: OrchestrationTaskContext | null;
      background?: string;
      proposalId?: string;
      callerPaneId?: string;
      context?: string;
      constraints?: string[];
      files?: string[];
      acceptance?: string;
      agent?: string;
      taskKind?: OrchestrationTaskKind;
      deps?: string[];
      codeDeps?: string[];
      baseBranch?: string;
      worktree?: boolean;
      model?: string;
      effort?: string;
      terminal?: string;
      policy?: AgentSessionPolicy;
      network?: boolean;
      allowSubWorkers?: boolean;
      userInitiated?: boolean;
      confirmed?: boolean;
      planSummary?: string;
      runId?: string;
      callerCwd?: string;
    },
    signal?: AbortSignal
  ): Promise<OrchestrationDelegateTaskResult> {
    const reviewOfRaw = input.reviewOf?.trim() || '';
    const isReviewRunRequest =
      input.reviewRun === true ||
      (typeof input.reviewRun === 'string' && input.reviewRun.trim().length > 0);
    const reviewFocus = input.reviewFocus?.trim() || '';
    if (reviewOfRaw && isReviewRunRequest) {
      throw new OrchestrationError(
        'invalid_argument',
        'Cannot combine reviewOf and reviewRun in the same delegate_task call.',
      );
    }
    if ((reviewOfRaw || isReviewRunRequest) && input.terminal?.trim()) {
      throw new OrchestrationError(
        'operation_rejected',
        'Adversarial review cannot reuse an existing terminal. Spawn a fresh reviewer in an isolated detached worktree.',
      );
    }
    const from = input.from?.trim() || 'coordinator';
    const reviewTargetDispatch = reviewOfRaw
      ? this.resolveDispatchByRoleOrTarget(reviewOfRaw, input.callerPaneId ?? from, input.runId)
      : null;
    if (reviewTargetDispatch && input.callerPaneId !== undefined) {
      this.authorizeRunAccess(reviewTargetDispatch.runId, input.callerPaneId);
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
    const reviewRunTarget = isReviewRunRequest
      ? this.resolveTargetRunForOperation(
          typeof input.reviewRun === 'string' ? input.reviewRun.trim() : input.runId,
          input.callerPaneId,
          from,
        )
      : null;
    const isAdversarialReview = Boolean(reviewTargetDispatch || reviewRunTarget);

    const reviewTargetRole = reviewTargetDispatch
      ? this.resolveRoleNameForDispatch(reviewTargetDispatch) || reviewTargetDispatch.id
      : '';
    const fallbackReviewTask = reviewTargetDispatch
      ? `Adversarial review of @${reviewTargetRole}${reviewFocus ? ` (${reviewFocus})` : ''}`
      : reviewRunTarget
        ? `Run-level adversarial review of ${reviewRunTarget.id}${reviewFocus ? ` (${reviewFocus})` : ''}`
        : '';
    const taskText = this.store.redactDispatchCredentials(input.task?.trim() || fallbackReviewTask);
    if (!taskText) {
      throw new OrchestrationError('invalid_argument', 'Missing task specification.');
    }
    let normalizedTaskContext = this.redactTaskContext(normalizeTaskContext(input));

    this.assertCanDelegateFrom(from);
    const defaultReviewRole = reviewTargetDispatch
      ? `review-${reviewTargetRole.replace(/^@+/, '')}`
      : reviewRunTarget
        ? 'review-run'
        : '';
    const role = this.store.redactDispatchCredentials(
      (input.role ?? defaultReviewRole).trim().replace(/^@+/, ''),
    );
    const firstLine =
      taskText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? taskText;
    const displayName = role || undefined;
    const taskTitle = role ? `@${role}: ${firstLine}` : firstLine;

    const effectiveTaskKind = input.taskKind ?? (isAdversarialReview ? 'review' : undefined);
    let workerPolicy: AgentSessionPolicy | undefined = input.policy;
    let workerNetwork: boolean | undefined = input.network;
    let allowSubWorkers = input.allowSubWorkers === true;
    if (effectiveTaskKind === 'review' && ((workerPolicy !== undefined && workerPolicy !== 'read-only') ||
        workerNetwork === true || allowSubWorkers)) {
      throw new OrchestrationError('operation_rejected', 'Review Workers stay read-only, without network access or sub-Workers.');
    }
    if (allowSubWorkers && this.resolveCallerDepth(from) + 1 >= this.maxDepth) {
      throw new OrchestrationError(
        'operation_rejected',
        `A Worker at depth ${this.resolveCallerDepth(from) + 1} cannot start sub-Workers (max depth ${this.maxDepth}).`,
        { maxDepth: this.maxDepth },
      );
    }
    let worktree = isAdversarialReview
      ? false
      : (input.worktree ?? this.getDefaultWorktreeDep?.() ?? true);
    const requestedAgent = input.agent?.trim() || 'auto';
    const roster = this.listCodingAgents(from);
    const coordinatorCliId =
      this.agentStatusStore.get(from)?.agentId ??
      this.terminalTracker?.getTerminal(from)?.cliId ??
      this.sessionCoordinator(from)?.provider ??
      null;
    const authorCliId = reviewTargetDispatch?.cliId ?? null;
    const authorCliIds = reviewRunTarget
      ? [
          ...new Set(
            this.store
              .listIntegratedDispatchesForRun(reviewRunTarget.id)
              .map((d) => d.cliId)
              .filter((c): c is string => Boolean(c)),
          ),
        ]
      : undefined;

    let resolvedAgent: string;
    let selectionReason: string;
    let resolvedModel: string | undefined = input.model?.trim() || undefined;
    let resolvedEffort: string | undefined = input.effort?.trim() || undefined;
    let fallbacks: string[] = [];

    if (this.selectAgentForTaskDep && roster.length > 0) {
      let selection: OrchestrationAgentSelectionResult;
      try {
        selection = this.selectAgentForTaskDep({
          roster,
          requestedAgent,
          taskKind: effectiveTaskKind ?? null,
          coordinatorCliId,
          authorCliId,
          ...(authorCliIds && authorCliIds.length > 0 ? { authorCliIds } : {}),
          preferIdle: Boolean(input.terminal),
        });
      } catch (err) {
        if (err instanceof OrchestrationError) throw err;
        throw new OrchestrationError(
          'invalid_argument',
          err instanceof Error ? err.message : String(err)
        );
      }
      resolvedAgent = selection.cliId;
      selectionReason = selection.reason;
      if (!resolvedModel && selection.model) {
        resolvedModel = selection.model;
      }
      if (!resolvedEffort && resolvedModel && selection.effort) {
        resolvedEffort = selection.effort;
      }
      fallbacks = selection.fallbacks;
    } else if (requestedAgent && requestedAgent.toLowerCase() !== 'auto') {
      resolvedAgent = normalizeWorkerCliId(requestedAgent);
      selectionReason = 'explicit';
    } else {
      const firstAvailable = roster.find((entry) => entry.available);
      resolvedAgent = firstAvailable?.cliId ?? coordinatorCliId ?? 'claude';
      selectionReason = firstAvailable ? 'roster-default' : 'default';
      if (!resolvedModel && firstAvailable?.defaultModel) {
        resolvedModel = firstAvailable.defaultModel;
      }
      if (!resolvedEffort && resolvedModel && firstAvailable?.defaultEffort) {
        resolvedEffort = firstAvailable.defaultEffort;
      }
      fallbacks = roster
        .filter((entry) => entry.available && entry.cliId !== resolvedAgent)
        .map((entry) => entry.cliId);
    }

    if (!resolvedModel) {
      resolvedEffort = undefined;
    }

    const planSummary =
      input.planSummary?.trim() ||
      (role ? `@${role} (${resolvedAgent}): ${firstLine}` : `${resolvedAgent}: ${firstLine}`);
    const explicitRunId = input.runId?.trim();
    const inferredRunId =
      explicitRunId ||
      reviewRunTarget?.id ||
      reviewTargetDispatch?.runId ||
      (input.callerPaneId === undefined
        ? this.inferRunIdOptional(from)
        : this.board.resolveBoardMemberForPane(from)?.runId) ||
      null;
    let dispatchRunId = explicitRunId ?? reviewRunTarget?.id ?? reviewTargetDispatch?.runId;
    if (explicitRunId && input.callerPaneId !== undefined) {
      this.board.resolveBoardCallerContext({ from: input.callerPaneId, runId: explicitRunId });
    }
    const isReviewDispatch = Boolean(reviewTargetDispatch || reviewRunTarget);
    const targetRunForAuth = inferredRunId ? this.store.getRun(inferredRunId) : null;
    const requestedAuthorizeReviews =
      typeof input.authorizeReviews === 'boolean' ? input.authorizeReviews : undefined;
    const proposalInput = {
      coordinatorPaneId: from,
      runId: inferredRunId,
      role,
      task: taskText,
      deps: [...new Set(input.deps ?? [])].sort(),
      codeDeps: [...new Set(input.codeDeps ?? [])].sort(),
      baseBranch: input.baseBranch,
      ...(normalizedTaskContext ? { taskContext: normalizedTaskContext } : {}),
      planSummary: this.store.redactDispatchCredentials(planSummary),
      requestedAgent,
      resolvedAgent,
      taskKind: effectiveTaskKind ?? null,
      worktree,
      model: resolvedModel ?? null,
      effort: resolvedEffort ?? null,
      terminal: input.terminal?.trim() || null,
      ...(workerPolicy !== undefined ? { policy: workerPolicy } : {}),
      ...(workerNetwork !== undefined ? { network: workerNetwork } : {}),
      ...(allowSubWorkers ? { allowSubWorkers: true } : {}),
      ...(requestedAuthorizeReviews !== undefined
        ? { authorizeReviews: requestedAuthorizeReviews }
        : {}),
    };
    // A headless Worker has no chat turn with the person, so chat confirmation becomes a UI card.
    const confirmMode = this.effectiveConfirmMode(from);
    // A Coordinator can ask for full-auto only through a proposal the person approves in the UI.
    if (workerPolicy === 'full-auto' && input.userInitiated !== true && confirmMode !== 'always-ui') {
      throw new OrchestrationError(
        'operation_rejected',
        'A Coordinator cannot start a full-auto Worker on its own. Use workspace-write, or ask the person to start or approve a full-auto Worker in AhaStation.',
      );
    }
    let approvedByPerson = input.userInitiated === true;
    // Review dispatches bypass repeated confirmation ONLY when the user explicitly pre-authorized
    // review execution for this Run (via a prior confirmed proposal or UI toggle).
    const autoReviewBypass = Boolean(isReviewDispatch && targetRunForAuth?.reviewAutoAuthorized);
    const bypassGate =
      input.userInitiated === true ||
      confirmMode === 'auto' ||
      autoReviewBypass;

    let grantRunAutoReview = Boolean(input.userInitiated === true && requestedAuthorizeReviews === true);

    if (!bypassGate) {
      if (confirmMode === 'chat-and-guard') {
        const guard = this.proposals.evaluateChatGuard(
          proposalInput,
          Boolean(input.confirmed),
          input.proposalId,
          explicitRunId,
        );
        if (!guard.allowed) {
          return {
            status: 'confirmation_required',
            proposal: guard.proposal,
            message: guard.changed
              ? '派发内容与待确认方案不一致，请让用户重新确认后再派发。'
              : '尚未经用户确认派发。请先向用户确认拟派角色、Agent、任务、约束与 worktree，待用户回复后带 confirmed=true 和 proposalId 调用 delegate_task。',
          };
        }
        normalizedTaskContext = guard.taskContext;
        dispatchRunId = guard.proposal.runId ?? undefined;
        if (isReviewDispatch || guard.proposal.authorizeReviews === true) {
          grantRunAutoReview = true;
        }
      } else if (confirmMode === 'always-ui') {
        const held = await this.proposals.createHeldProposal(proposalInput, signal);
        if (held.decision !== 'approved') {
          return {
            status: 'rejected',
            proposal: held.proposal,
            message:
              held.reason ||
              (held.decision === 'expired' ? '派发确认已超时。' : '用户已取消本次派发。'),
          };
        }
        if (typeof held.overrides?.authorizeReviews === 'boolean') {
          grantRunAutoReview = held.overrides.authorizeReviews;
        } else if (isReviewDispatch || held.proposal.authorizeReviews === true) {
          grantRunAutoReview = true;
        }
        approvedByPerson = true;
        if (held.overrides) {
          if (held.overrides.policy !== undefined) workerPolicy = held.overrides.policy ?? undefined;
          if (held.overrides.network !== undefined) workerNetwork = held.overrides.network ?? undefined;
          if (typeof held.overrides.allowSubWorkers === 'boolean') allowSubWorkers = held.overrides.allowSubWorkers;
          const prevAgent = resolvedAgent;
          if (held.overrides.agent?.trim()) {
            resolvedAgent = normalizeWorkerCliId(held.overrides.agent);
            selectionReason = 'user-override';
            fallbacks = [];
          }
          if (typeof held.overrides.worktree === 'boolean') {
            worktree = held.overrides.worktree;
          }
          if (held.overrides.model !== undefined) {
            resolvedModel = held.overrides.model?.trim() || undefined;
          } else if (resolvedAgent !== prevAgent) {
            const newProfile = roster.find((entry) => entry.cliId === resolvedAgent);
            resolvedModel = newProfile?.defaultModel ?? undefined;
          }
          if (held.overrides.effort !== undefined) {
            resolvedEffort = held.overrides.effort?.trim() || undefined;
          } else if (resolvedAgent !== prevAgent) {
            const newProfile = roster.find((entry) => entry.cliId === resolvedAgent);
            resolvedEffort = resolvedModel ? (newProfile?.defaultEffort ?? undefined) : undefined;
          }
          if (!resolvedModel) {
            resolvedEffort = undefined;
          }
          if (isHeadlessWorkerDriver(resolvedAgent)) {
            // Switching to a driver without network access drops the Coordinator's request; an explicit override still fails.
            if (workerNetwork === true && held.overrides.network === undefined && !driverCapabilities(resolvedAgent).network) {
              workerNetwork = false;
            }
            const unsupported = headlessWorkerControlsError(resolvedAgent, {
              ...(workerPolicy !== undefined ? { policy: workerPolicy } : {}),
              ...(workerNetwork !== undefined ? { network: workerNetwork } : {}),
            });
            if (unsupported) throw new OrchestrationError('operation_rejected', unsupported, { proposalId: held.proposal.id });
          }
          if (allowSubWorkers && this.resolveCallerDepth(from) + 1 >= this.maxDepth) allowSubWorkers = false;
        }
      }
    }

    if (proposalInput.deps.length || proposalInput.codeDeps.length) {
      const run = this.store.requireRun(dispatchRunId ?? inferredRunId ?? '');
      if (isReviewDispatch) throw new OrchestrationError('invalid_argument', 'Review dispatches already target an immutable snapshot.');
      if (input.callerPaneId) this.assertRunCoordinator(run.id, input.callerPaneId);
      const task = this.store.createTask({
        runId: run.id, spec: taskText, taskTitle, displayName, taskContext: normalizedTaskContext,
        deps: proposalInput.deps, codeDeps: proposalInput.codeDeps, singleShot: true,
        queuedLaunch: {
          from, callerPaneId: input.callerPaneId, callerCwd: input.callerCwd ?? this.sessionCoordinator(from)?.cwd ?? this.terminalTracker?.getTerminal(from)?.cwd ?? this.getDefaultCwd?.(),
          authorizedNetwork: Boolean(this.sessionCoordinator(from)?.network), requiresPaneMode: this.isPaneOrchestrationMode(from),
          coordinatorGeneration: run.consumerGeneration, baseBranch: input.baseBranch, agent: resolvedAgent,
          role, terminal: input.terminal, model: resolvedModel, effort: resolvedEffort, taskKind: effectiveTaskKind,
          ...(workerPolicy !== undefined ? { policy: workerPolicy } : {}),
          ...(workerNetwork !== undefined ? { network: workerNetwork } : {}),
          ...(allowSubWorkers ? { allowSubWorkers: true } : {}),
          ...(approvedByPerson ? { userInitiated: true } : {}),
          worktree, authorizeReviews: grantRunAutoReview, state: 'waiting',
        },
      });
      this.emitChanged('task:queued', run.id);
      return { status: 'queued', task, message: '依赖和派发条件满足后启动。' };
    }

    const candidates = input.terminal?.trim()
      ? [resolvedAgent]
      : [resolvedAgent, ...fallbacks.filter((cli) => cli !== resolvedAgent)];
    let fallbackFrom: string | null = null;
    let reusableTaskId: string | undefined;

    for (let i = 0; i < candidates.length; i += 1) {
      const candidateCli = candidates[i]!;
      const isFallback = i > 0;
      const candidateProfile = isFallback
        ? roster.find((entry) => entry.cliId === candidateCli)
        : undefined;
      const candidateModel = isFallback
        ? (candidateProfile?.defaultModel ?? undefined)
        : resolvedModel;
      const candidateEffort = isFallback
        ? candidateModel
          ? (candidateProfile?.defaultEffort ?? undefined)
          : undefined
        : resolvedEffort;
      const mcpEnabled = this.isMcpEnabledForCliDep?.(candidateCli) ?? false;

      const existingTask = reusableTaskId ? this.store.getTask(reusableTaskId) : null;
      if (existingTask && existingTask.status !== 'ready') {
        this.store.requeueTaskForRetry(reusableTaskId!);
      }

      try {
        const started = await this.workerStart({
          from,
          runId: dispatchRunId,
          callerPaneId: input.callerPaneId,
          ...(reusableTaskId
            ? { taskId: reusableTaskId }
            : isReviewDispatch && !input.task?.trim()
              ? {}
              : { spec: taskText }),
          taskKind: effectiveTaskKind,
          ...(reviewTargetDispatch ? { reviewOf: reviewTargetDispatch.id } : {}),
          ...(reviewRunTarget ? { reviewRun: reviewRunTarget.id } : {}),
          ...(reviewFocus ? { reviewFocus } : {}),
          ...((effectiveTaskKind === 'review' || effectiveTaskKind === 'research') && workerPolicy === undefined
            ? { readOnly: true } : {}),
          ...(workerPolicy !== undefined ? { policy: workerPolicy } : {}),
          ...(workerNetwork !== undefined ? { network: workerNetwork } : {}),
          ...(allowSubWorkers ? { allowSubWorkers: true } : {}),
          userInitiated: approvedByPerson,
          ...(normalizedTaskContext ? { taskContext: normalizedTaskContext } : {}),
          taskTitle,
          displayName,
          name: role || undefined,
          agent: candidateCli,
          model: candidateModel,
          effort: candidateEffort,
          terminal: input.terminal?.trim() || undefined,
          noWorktree: !worktree,
          callerCwd: input.callerCwd,
          baseBranch: input.baseBranch,
          mcpEnabled,
          role: role || undefined,
        });
        if (grantRunAutoReview && !started.run.reviewAutoAuthorized) {
          const updatedRun = this.store.setRunAutoReviewAuthorized(started.run.id, true);
          if (updatedRun) {
            started.run = updatedRun;
            this.emitChanged('run:auto-review-updated', updatedRun.id);
          }
        }
        return {
          status: 'started',
          role,
          agent: started.cliId,
          selectionReason,
          fallbackFrom,
          dispatch: started.dispatch,
          task: started.task,
          run: started.run,
          ptyId: started.ptyId,
          worktreePath: started.worktreePath,
          branch: started.branch,
          ...(started.briefBoardSeq !== undefined ? { briefBoardSeq: started.briefBoardSeq } : {}),
        };
      } catch (err) {
        const canRetryFallback =
          err instanceof OrchestrationError &&
          err.code === 'terminal_unavailable' &&
          !input.terminal?.trim() &&
          i + 1 < candidates.length;
        if (!canRetryFallback) {
          throw err;
        }
        if (fallbackFrom === null) {
          fallbackFrom = resolvedAgent;
        }
        if (!isReviewDispatch && typeof err.data?.taskId === 'string' && err.data.taskId) {
          reusableTaskId = err.data.taskId;
        }
      }
    }

    throw new OrchestrationError(
      'terminal_unavailable',
      `Failed to start worker with any candidate CLI (${candidates.join(', ')}).`
    );
  }

  async workerDoneByPane(
    callerPaneId: string,
    input: {
      outcome?: OrchestrationWorkerReportOutcome | 'succeeded';
      summary: string;
      verdict?: OrchestrationReviewVerdict;
      findings?: OrchestrationReviewFinding[];
    }
  ): Promise<ReturnType<OrchestrationService['workerDone']>> {
    const cleanCaller = callerPaneId.trim();
    if (!cleanCaller) {
      throw new OrchestrationError('invalid_argument', 'Missing caller pane id.');
    }
    const active = this.store.getActiveDispatchForIdentity(cleanCaller, cleanCaller);
    if (!active) {
      throw new OrchestrationError(
        'dispatch_not_found',
        `No active worker dispatch found for pane ${cleanCaller}.`
      );
    }
    const capability = this.store.getDispatchCapability(active.id);
    const fromRole = this.resolveRoleNameForDispatch(active).toLowerCase() || undefined;
    return this.workerDoneWithArtifacts({
      from: cleanCaller,
      dispatchId: active.id,
      taskId: active.taskId,
      outcome: input.outcome ?? 'completed',
      summary: input.summary,
      verdict: input.verdict,
      findings: input.findings,
      capability,
      fromRole,
    });
  }

  askCoordinatorByPane(
    callerPaneId: string,
    input: { question: string; options?: string[]; wait?: boolean; timeoutMs?: number },
    signal?: AbortSignal
  ): ReturnType<OrchestrationService['ask']> {
    const cleanCaller = callerPaneId.trim();
    if (!cleanCaller) {
      throw new OrchestrationError('invalid_argument', 'Missing caller pane id.');
    }
    const active = this.store.getActiveDispatchForIdentity(cleanCaller, cleanCaller);
    if (!active) {
      throw new OrchestrationError(
        'dispatch_inactive',
        `No active worker dispatch found for pane ${cleanCaller}.`
      );
    }
    const capability = this.store.getDispatchCapability(active.id);
    return this.ask(
      {
        from: cleanCaller,
        dispatchId: active.id,
        question: input.question,
        options: input.options,
        wait: input.wait ?? true,
        timeoutMs: input.timeoutMs,
        capability,
      },
      signal
    );
  }

  resolveWorkerByRoleOrId(callerPaneId: string, target: string): OrchestrationDispatchRecord {
    const cleanCaller = callerPaneId.trim();
    const rawTarget = target.trim();
    if (!rawTarget) {
      throw new OrchestrationError('invalid_argument', 'Missing target worker role or dispatch id.');
    }

    if (rawTarget.startsWith('dispatch:')) {
      const id = rawTarget.slice('dispatch:'.length).trim();
      const ctx = this.store.resolveDispatchLineage(id) ?? this.store.getDispatchContext(id);
      if (ctx) {
        this.assertWorkerController({ dispatchId: ctx.id }, cleanCaller);
        return ctx;
      }
    }

    const direct = this.store.getDispatchContext(rawTarget);
    if (direct) {
      const resolved = this.store.resolveDispatchLineage(direct.id) ?? direct;
      this.assertWorkerController({ dispatchId: resolved.id }, cleanCaller);
      return resolved;
    }

    const cleanRole = rawTarget.replace(/^@+/, '').trim().toLowerCase();
    const managed = this.listManagedDispatchesForCaller(callerPaneId);
    const matching = managed.filter((d) => {
      const roleName = this.resolveRoleNameForDispatch(d).toLowerCase();
      if (roleName && roleName === cleanRole) return true;
      const task = this.store.getTask(d.taskId);
      const taskDisplay = task?.displayName?.trim().replace(/^@+/, '').toLowerCase() ?? '';
      if (taskDisplay && taskDisplay === cleanRole) return true;
      return d.assigneePaneId === rawTarget || d.assigneeHandle === rawTarget;
    });

    if (matching.length > 0) {
      matching.sort((a, b) => {
        const aActive = ACTIVE_DISPATCH_STATUSES.has(a.status) ? 1 : 0;
        const bActive = ACTIVE_DISPATCH_STATUSES.has(b.status) ? 1 : 0;
        if (aActive !== bActive) return bActive - aActive;
        return b.createdAt.localeCompare(a.createdAt);
      });
      return matching[0]!;
    }

    throw new OrchestrationError('dispatch_not_found', `Worker not found: ${rawTarget}`);
  }

  async messageWorkerByRole(
    callerPaneId: string,
    input: { role: string; message: string; subject?: string; questionId?: string }
  ): Promise<
    | ({ mode: 'replied'; dispatch: OrchestrationDispatchRecord } & ReturnType<
        OrchestrationService['reply']
      >)
    | ({ mode: 'sent' | 'reactivated'; dispatch: OrchestrationDispatchRecord } & OrchestrationSendResult)
  > {
    const cleanMessage = input.message?.trim() ?? '';
    if (!cleanMessage) {
      throw new OrchestrationError('invalid_argument', 'Missing message body.');
    }
    const dispatch = this.resolveWorkerByRoleOrId(callerPaneId, input.role);
    this.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
    const questionId = input.questionId?.trim();
    if (questionId) {
      const targetQuestion = this.store.getQuestion(questionId);
      if (!targetQuestion || targetQuestion.dispatchId !== dispatch.id) {
        throw new OrchestrationError('invalid_argument', 'The question does not belong to the selected worker.');
      }
      this.assertCanReply(targetQuestion.messageId, callerPaneId);
      const replied = this.reply({
        id: targetQuestion.messageId,
        body: cleanMessage,
        from: callerPaneId,
      });
      return { mode: 'replied', dispatch, ...replied };
    }
    const callerDispatch = this.store.getActiveDispatchForIdentity(callerPaneId, callerPaneId);
    const senderRole = callerDispatch
      ? this.resolveRoleNameForDispatch(callerDispatch).toLowerCase() || 'worker'
      : 'coordinator';
    const targetRole = this.resolveRoleNameForDispatch(dispatch).toLowerCase() || dispatch.id;
    const refs = parseBoardRefs(cleanMessage);
    const sent = await this.send({
      from: callerPaneId,
      to: `dispatch:${dispatch.id}`,
      runId: dispatch.runId,
      subject: input.subject?.trim() || 'Coordinator message',
      body: cleanMessage,
      fromRole: senderRole,
      mentions: [targetRole],
      refs: refs.length > 0 ? refs : undefined,
      kind: 'post',
    });
    if (senderRole === 'coordinator') {
      this.peerPingPong.recordCoordinatorOrUserActivity(dispatch.runId);
    }
    if (typeof sent.message.boardSeq === 'number') {
      this.store.advanceMemberCursor(dispatch.runId, senderRole, {
        lastPostSeq: sent.message.boardSeq,
      });
    }
    return {
      mode: sent.followUp ? 'reactivated' : 'sent',
      dispatch: sent.followUp?.dispatch ?? dispatch,
      ...sent,
    };
  }

  async manageWorkerByRole(
    callerPaneId: string,
    input: {
      role: string;
      action: 'read' | 'approve' | 'deny' | 'release' | 'stop';
      reason?: string;
      force?: boolean;
      screen?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    const dispatch = this.resolveWorkerByRoleOrId(callerPaneId, input.role);
    this.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
    switch (input.action) {
      case 'read': {
        const output = this.workerRead({
          dispatchId: dispatch.id,
          screen: input.screen ?? true,
        });
        return { action: 'read', dispatch, output };
      }
      case 'approve': {
        const open = this.approvals.listOpenApprovals({ dispatchId: dispatch.id });
        if (open.length === 0) {
          throw new OrchestrationError(
            'approval_not_found',
            `No pending permission approval for worker "${input.role}".`
          );
        }
        const res = this.approve(
          {
            id: open[0]!.approvalId,
            dispatchId: dispatch.id,
            from: callerPaneId,
            reason: input.reason,
          },
          callerPaneId
        );
        return { action: 'approve', dispatch, ...res };
      }
      case 'deny': {
        const open = this.approvals.listOpenApprovals({ dispatchId: dispatch.id });
        if (open.length === 0) {
          throw new OrchestrationError(
            'approval_not_found',
            `No pending permission approval for worker "${input.role}".`
          );
        }
        const res = this.deny(
          {
            id: open[0]!.approvalId,
            dispatchId: dispatch.id,
            from: callerPaneId,
            reason: input.reason,
          },
          callerPaneId
        );
        return { action: 'deny', dispatch, ...res };
      }
      case 'release': {
        this.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
        const res = await this.workerRelease({
          dispatchId: dispatch.id,
          force: input.force,
        });
        return { action: 'release', ...res };
      }
      case 'stop': {
        this.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
        const res = await this.workerStop({
          dispatchId: dispatch.id,
          reason: input.reason,
          force: input.force,
        });
        return { action: 'stop', ...res };
      }
    }
  }

  getMcpContextForPane(callerPaneId: string): OrchestrationMcpContext {
    const cleanCaller = callerPaneId.trim();
    const activeDispatch = this.store.getActiveDispatchForIdentity(cleanCaller, cleanCaller) ?? null;
    const role: 'worker' | 'coordinator' = activeDispatch || HEADLESS_WORKER_ID.test(cleanCaller) ? 'worker' : 'coordinator';
    const orchestrationMode = this.isPaneOrchestrationMode(cleanCaller);
    const confirmMode = this.effectiveConfirmMode(cleanCaller);
    const canDelegate = HEADLESS_WORKER_ID.test(cleanCaller)
      ? this.canHeadlessWorkerDelegate(cleanCaller)
      : this.resolveCallerDepth(cleanCaller) < this.maxDepth;
    const roster = this.listCodingAgents(cleanCaller);
    const managed = this.listManagedDispatchesForCaller(cleanCaller);
    const workers: OrchestrationMcpWorkerBrief[] = managed.map((d) => {
      const summary = this.toWorkerSummary(d);
      const roleName =
        this.resolveRoleNameForDispatch(d) ||
        summary.task?.displayName?.trim().replace(/^@+/, '') ||
        d.id;
      return {
        dispatchId: d.id,
        taskId: d.taskId,
        role: roleName,
        cliId: d.cliId ?? null,
        stage: summary.stage,
        status: d.status,
        ptyId: d.assigneePaneId ?? null,
        paneAlive: summary.paneAlive,
        worktreePath: d.worktreePath ?? null,
        branch: d.branch ?? null,
        openApprovalCount: summary.openApprovals.length,
        openQuestionCount: summary.openQuestions.length + summary.openNativeQuestions.length,
      };
    });
    const pendingProposals = this.proposals.listPendingProposals({
      coordinatorPaneId: cleanCaller,
    });
    return {
      ptyId: cleanCaller,
      role,
      orchestrationMode,
      confirmMode,
      activeDispatch,
      canDelegate,
      roster,
      workers,
      pendingProposals,
    };
  }

  // ==================== Shared Message Board & Adaptive Delivery ====================

  private isMcpEnabledForPane(ptyId: string): boolean {
    const clean = ptyId.trim();
    if (HEADLESS_WORKER_ID.test(clean) || AGENT_SESSION_ID.test(clean)) return this.isPaneAlive(clean);
    if (!clean || !this.isMcpEnabledForCliDep) return false;
    const cliId =
      this.agentStatusStore.get(clean)?.agentId ??
      this.terminalTracker?.getTerminal(clean)?.cliId ??
      this.store.getActiveDispatchForIdentity(clean, clean)?.cliId;
    return cliId ? this.isMcpEnabledForCliDep(cliId) : false;
  }

  buildBoardTeamSummary(runId: string): string {
    return this.board.buildBoardTeamSummary(runId);
  }

  boardPost(input: BoardPostInput) {
    return this.board.boardPost(input);
  }

  boardRead(input: {
    runId?: string;
    from: string;
    since?: number;
    seqs?: number[];
    limit?: number;
    markRead?: boolean;
    isUser?: boolean;
  }): {
    runId: string;
    headSeq: number;
    lastReadSeq: number;
    posts: OrchestrationExposedMessage[];
    formatted: string;
    teamSummary: string;
  } {
    return this.board.boardRead(input);
  }

  boardWait(input: {
      runId?: string;
      from: string;
      since?: number;
      mentionsOnly?: boolean;
      peek?: boolean;
      timeoutMs?: number;
    }, signal?: AbortSignal): Promise<{
    runId: string;
    headSeq: number;
    lastReadSeq: number;
    posts: OrchestrationExposedMessage[];
    formatted: string;
    teamSummary: string;
    timedOut: boolean;
    cancelled: boolean;
  }> {
    return this.board.boardWait(input, signal);
  }

  consumeMidTurnBoardInjections(ptyId: string): string | null {
    return this.board.consumeMidTurnBoardInjections(ptyId);
  }

  // ==================== Snapshot & Agent Text Views ====================

  private withHeadlessLive(dispatch: OrchestrationDispatchRecord): OrchestrationDispatchRecord {
    if (dispatch.executionMode !== 'codex-app-server') return dispatch;
    const session = this.codexWorkers.get(dispatch.assigneeHandle);
    const alive = Boolean(session?.alive && !dispatch.releasedAt);
    const busy = alive && (session!.busy || this.codexSubmitting.has(dispatch.id));
    return { ...dispatch, headlessLive: { alive, busy } };
  }

  getSnapshot(runId?: string, callerPaneId?: string): OrchestrationSnapshot {
    const scope = callerPaneId === undefined
      ? runId
      : this.authorizeRunAccess(runId, callerPaneId);
    const base = this.store.getSnapshot(scope);
    base.dispatches = base.dispatches.map((dispatch) => this.withHeadlessLive(dispatch));
    if (callerPaneId !== undefined) {
      base.runs = base.runs.filter((run) => run.id === scope);
      base.currentRunByConsumer = Object.fromEntries(
        Object.entries(base.currentRunByConsumer).filter(([, id]) => id === scope),
      );
      if (base.activeCoordinatorRun?.runId !== scope) base.activeCoordinatorRun = null;
      const firewall = this.review.getReviewFirewallContext(callerPaneId);
      if (firewall) {
        base.messages = base.messages.filter((message) => !this.review.isPostHiddenByReviewFirewall(message, firewall)).map(({ receipts: _receipts, ...message }) => message);
        base.runs = base.runs.map(({ finalizedBatches: _batches, integrationIntent: _intent, ...run }) => run);
        base.dispatches = base.dispatches.filter((dispatch) => !firewall.targetDispatchIds.has(dispatch.id));
        base.tasks = base.tasks.filter((task) => !firewall.targetTaskIds.has(task.id));
        base.questions = base.questions.filter(
          (question) => !question.dispatchId || !firewall.targetDispatchIds.has(question.dispatchId),
        );
        base.gates = base.gates.filter(
          (gate) => !gate.taskId || !firewall.targetTaskIds.has(gate.taskId),
        );
      }
      return {
        ...base,
        openApprovals: this.approvals
          .listOpenApprovals(scope ? { runId: scope } : undefined)
          .filter(
            (approval) =>
              !firewall || !approval.dispatchId || !firewall.targetDispatchIds.has(approval.dispatchId),
          ),
        openNativeQuestions: this.nativeQuestions
          .listOpenQuestions(scope ? { runId: scope } : undefined)
          .filter((question) => !firewall || !firewall.targetDispatchIds.has(question.dispatchId)),
        pendingProposals: firewall
          ? []
          : this.proposals.listPendingProposals(scope ? { runId: scope } : undefined),
        orchestrationModePanes: [...this.orchestrationModePanes].filter((pane) => pane === callerPaneId),
      };
    }
    return {
      ...base,
      openApprovals: this.approvals.listOpenApprovals(scope ? { runId: scope } : undefined),
      openNativeQuestions: this.nativeQuestions.listOpenQuestions(scope ? { runId: scope } : undefined),
      pendingProposals: this.proposals.listPendingProposals(scope ? { runId: scope } : undefined),
      orchestrationModePanes: [...this.orchestrationModePanes],
    };
  }

  formatActionReceiptText(action: string, data: unknown, options: { full?: boolean } = {}): string {
    return formatActionReceiptText(action, data, { ...options, cliCommand: this.cliCommand });
  }

  hasCodexWorkers(): boolean {
    return this.codexWorkers.size > 0;
  }

  async stopCodexWorkers(): Promise<void> {
    this.disposed = true;
    await Promise.all([
      ...[...this.codexWorkers.values()].map((codex) => codex.close(true)),
      ...this.pendingCodexTurnDiffs,
    ]);
  }

  dispose(): void {
    void this.stopCodexWorkers();
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
    this.stallWatchdog.dispose();
    this.peerPingPong.clearAll();
    this.turnStopMonitor.dispose();
    this.approvals.dispose();
    this.nativeQuestions.dispose();
    this.proposals.dispose();
    this.orchestrationModePanes.clear();
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
      void this.store.flushDurable().then(() => {
        const latest = this.store.getDispatchContext(dispatchId);
        if (!latest || !ACTIVE_DISPATCH_STATUSES.has(latest.status)) return null;
        const prompt = this.store.restoreDeferredDispatchPrompt(dispatchId, deferred.prompt);
        return this.deliverAndObserveDispatchTurn(dispatchId, { ...deferred, prompt });
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
            if (latest.reviewOfDispatchId || latest.reviewOfRunId) {
              this.store.updateDispatchReviewState(dispatchId, { reviewStatus: 'rejected' });
              this.review.reconcileAnyReviewBatch(dispatchId, {
                overrideVerdict: 'reject',
                failedReason: 'Deferred reviewer prompt delivery failed',
              });
            }
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
      const trackedTerm = this.terminalTracker?.getTerminal(opts.ptyId);
      const res = await deliverAndObserveAgentTurn({
        ptyId: opts.ptyId,
        prompt: opts.prompt,
        submit: opts.submit ?? true,
        settleDelayMs: this.settleDelayMs,
        writePty: this.writePty,
        agentStatusStore: this.agentStatusStore,
        isPaneAlive: (ptyId) => this.isPaneAlive(ptyId),
        readScreen: trackedTerm
          ? (ptyId) => this.terminalTracker!.captureTail(ptyId, 4_000)
          : undefined,
        getLastOutputAtMs: trackedTerm
          ? (ptyId) => this.terminalTracker!.getLastOutputAtMs(ptyId)
          : undefined,
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
    await this.store.flushDurable();
  }

  private isDispatchDeliberatelyWaiting(dispatch: OrchestrationDispatchRecord): boolean {
    if (dispatch.executionMode === 'codex-app-server' && this.isPaneAlive(dispatch.assigneeHandle)) return true;
    if (this.approvals.hasOpenApprovalForDispatch(dispatch.id) ||
        this.nativeQuestions.hasOpenQuestionForDispatch(dispatch.id)) {
      return true;
    }
    const dispatchMailbox = `dispatch:${dispatch.id}`;
    const paneId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
    return (
      this.waiters.hasActiveWaiterFor(dispatchMailbox) ||
      (paneId ? this.waiters.hasActiveWaiterFor(paneId) : false) ||
      (paneId ? this.waiters.hasActiveWaiterFor(`board-pane:${paneId}`) : false) ||
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
    }
    // Runs before retirement and outside the loop: a run whose only reviewer was already failed
    // elsewhere has no active dispatch left to put it in `runIds`.
    this.review.settleUnreportedReviewDispatches();
    for (const runId of runIds) {
      this.retireFinishedSpawnedWorkers(runId);
    }
    this.retireFinishedCodexWorkers();
  }
}
