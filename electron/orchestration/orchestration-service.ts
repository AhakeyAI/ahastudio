import { realpathSync } from 'node:fs';
import { runGitCommand } from '../git/git-exec.js';
import type {
  AgentSessionDriver,
  AgentSessionEvents,
  AgentSessionPolicy,
  TurnDelivery,
} from './agent-session-driver.js';
import { SESSION_WAKE_HEADER } from './coordinator-prompt.js';
import { AGENT_SESSION_ID } from './agent-session-manager.js';
import {
  HEADLESS_WORKER_ID,
  SESSION_GATED_COORDINATOR_ACTIONS,
  sessionGateDecision,
  type HeadlessWorkerDriver,
} from './headless-workers.js';
import { WorkerNativeQuestionManager } from './worker-native-questions.js';
import { formatActionReceiptText } from './orchestration-text-views.js';
import { OrchestrationBoardService, type BoardPostInput } from './board-service.js';
import { OrchestrationWorkerLifecycleService } from './worker-lifecycle-service.js';
import { OrchestrationDelegationService } from './delegation-service.js';
import { OrchestrationIntegrationService } from './integration-service.js';
import { OrchestrationReviewService } from './review-service.js';
import {
  WorkerTimeline,
  type WorkerTimelineChange,
  type WorkerTimelineSnapshot,
} from './worker-timeline.js';
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
  normalizeTaskContext,
  type SharedRunBoardPostSummary,
  type SharedRunContext,
  type SharedRunPeerSummary,
} from './worker-brief-context.js';
import { normalizeWorkerCliId } from './worker-launch-catalog.js';
import { WorkerTurnStopMonitor } from './worker-turn-stops.js';
import {
  evaluateAdversarialVerdict,
  formatReviewVerdictForBoard,
  MAX_ADVERSARIAL_REVIEW_ROUNDS,
  normalizeReviewFindings,
} from './adversarial-review.js';
import {
  detectReviewWorktreeMutation,
  inspectWorkerDiff,
  isGitCommitAncestor,
  isSameGitRepo,
  resolveBranchRefOid,
  resolveMainRepoRoot,
  type RunCommitRangeDiffInspection,
  type WorkerDiffInspection,
  type WorkerIntegrateMode,
  type WorkerIntegrateTargetBranch,
  type WorkerIntegrationResult,
} from './worker-git-integration.js';
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
export type HeadlessWorkerLaunchOptions = HeadlessWorkerControls & {
  /** Reopens this provider conversation instead of starting one (Claude needs it at launch). */
  resumeSessionId?: string;
};

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
  /**
   * Idle time after which a settled headless Worker's process is closed so it sleeps until a
   * follow-up resumes its conversation; 0 (the default) keeps Workers running.
   */
  headlessWorkerDormancyMs?: number;
  /** How often idle headless Workers are checked for dormancy; 0 leaves it to explicit sweeps. */
  headlessWorkerDormancySweepMs?: number;
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
  private readonly workers: OrchestrationWorkerLifecycleService;
  private readonly delegation: OrchestrationDelegationService;
  private readonly integration: OrchestrationIntegrationService;
  private readonly review: OrchestrationReviewService;

  private readonly agentStatusStore: AgentStatusStore;
  private readonly writePty: PtyWriteFn;
  private readonly spawnWorkerPty?: OrchestrationServiceDependencies['spawnWorkerPty'];
  private readonly codexPilot?: OrchestrationServiceDependencies['codexPilot'];
  private readonly headlessWorkers?: OrchestrationServiceDependencies['headlessWorkers'];
  private sessionCoordinators: OrchestrationSessionCoordinators | null = null;
  private readonly workerTimelines = new Map<string, WorkerTimeline>();
  private readonly timelineListeners = new Set<(change: WorkerTimelineChange) => void>();
  private disposed = false;
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
    this.workers = new OrchestrationWorkerLifecycleService({
      get agentStatusStore() { return svc.agentStatusStore; },
      get approvals() { return svc.approvals; },
      archiveWorkerTimeline: (...args) => this.archiveWorkerTimeline(...args),
      assertCanDelegateFrom: (...args) => this.assertCanDelegateFrom(...args),
      assertWorkerStartControls: (...args) => this.assertWorkerStartControls(...args),
      authorizeRunAccess: (...args) => this.authorizeRunAccess(...args),
      get board() { return svc.board; },
      buildWorkerDispatchBrief: (...args) => this.buildWorkerDispatchBrief(...args),
      canHeadlessWorkerDelegate: (...args) => this.canHeadlessWorkerDelegate(...args),
      get cliCommand() { return svc.cliCommand; },
      clock: () => this.clock(),
      get closeWorkerPty() { return svc.closeWorkerPty; },
      get codexPilot() { return svc.codexPilot; },
      createWorkerTimeline: (...args) => this.createWorkerTimeline(...args),
      get delegation() { return svc.delegation; },
      deliverAndObserveDispatchTurn: (...args) => this.deliverAndObserveDispatchTurn(...args),
      get disposed() { return svc.disposed; },
      emitChanged: (...args) => this.emitChanged(...args),
      emitPaneClosed: (...args) => this.emitPaneClosed(...args),
      emitPaneSpawned: (...args) => this.emitPaneSpawned(...args),
      get exitedPanes() { return svc.exitedPanes; },
      failTaskIfReady: (...args) => this.failTaskIfReady(...args),
      get getDefaultCwd() { return svc.getDefaultCwd; },
      headlessWorkerDormancyMs: Math.max(0, deps.headlessWorkerDormancyMs ?? 0),
      get headlessWorkers() { return svc.headlessWorkers; },
      inferRunIdOptional: (...args) => this.inferRunIdOptional(...args),
      get integration() { return svc.integration; },
      isActiveSessionCoordinator: (...args) => this.isActiveSessionCoordinator(...args),
      get isMcpEnabledForCliDep() { return svc.isMcpEnabledForCliDep; },
      isPaneAlive: (...args) => this.isPaneAlive(...args),
      listCodingAgents: (...args) => this.listCodingAgents(...args),
      get listCodingAgentsDep() { return svc.listCodingAgentsDep; },
      markPtyExited: (...args) => this.markPtyExited(...args),
      get maxDepth() { return svc.maxDepth; },
      get nativeQuestions() { return svc.nativeQuestions; },
      notifyTargetAndAliases: (...args) => this.notifyTargetAndAliases(...args),
      paneMismatch: (...args) => this.paneMismatch(...args),
      redactTaskContext: (...args) => this.redactTaskContext(...args),
      resolveActiveParentMailbox: (...args) => this.resolveActiveParentMailbox(...args),
      resolveCallerDepth: (...args) => this.resolveCallerDepth(...args),
      get retiringPanes() { return svc.retiringPanes; },
      get review() { return svc.review; },
      runCreate: (...args) => this.runCreate(...args),
      sessionCoordinator: (...args) => this.sessionCoordinator(...args),
      get spawnWorkerPty() { return svc.spawnWorkerPty; },
      get spawnedWorkerMeta() { return svc.spawnedWorkerMeta; },
      get spawnedWorkerPanes() { return svc.spawnedWorkerPanes; },
      get store() { return svc.store; },
      get terminalTracker() { return svc.terminalTracker; },
      get turnStopMonitor() { return svc.turnStopMonitor; },
      verifyCodeInputs: (...args) => this.verifyCodeInputs(...args),
      get waiters() { return svc.waiters; },
      get workerTimelines() { return svc.workerTimelines; },
    });
    this.delegation = new OrchestrationDelegationService({
      get agentStatusStore() { return svc.agentStatusStore; },
      get approvals() { return svc.approvals; },
      approve: (...args) => this.approve(...args),
      assertCanDelegateFrom: (...args) => this.assertCanDelegateFrom(...args),
      assertCanReply: (...args) => this.assertCanReply(...args),
      assertRunCoordinator: (...args) => this.assertRunCoordinator(...args),
      assertWorkerController: (...args) => this.assertWorkerController(...args),
      authorizeRunAccess: (...args) => this.authorizeRunAccess(...args),
      get board() { return svc.board; },
      deny: (...args) => this.deny(...args),
      get disposed() { return svc.disposed; },
      effectiveConfirmMode: (...args) => this.effectiveConfirmMode(...args),
      emitChanged: (...args) => this.emitChanged(...args),
      get getDefaultCwd() { return svc.getDefaultCwd; },
      get getDefaultWorktreeDep() { return svc.getDefaultWorktreeDep; },
      inferRunIdOptional: (...args) => this.inferRunIdOptional(...args),
      get integration() { return svc.integration; },
      isCallerSurface: (...args) => this.isCallerSurface(...args),
      get isMcpEnabledForCliDep() { return svc.isMcpEnabledForCliDep; },
      isPaneAlive: (...args) => this.isPaneAlive(...args),
      isPaneOrchestrationMode: (...args) => this.isPaneOrchestrationMode(...args),
      listCodingAgents: (...args) => this.listCodingAgents(...args),
      get maxDepth() { return svc.maxDepth; },
      get peerPingPong() { return svc.peerPingPong; },
      get proposals() { return svc.proposals; },
      redactTaskContext: (...args) => this.redactTaskContext(...args),
      reply: (...args) => this.reply(...args),
      resolveCallerDepth: (...args) => this.resolveCallerDepth(...args),
      get selectAgentForTaskDep() { return svc.selectAgentForTaskDep; },
      send: (...args) => this.send(...args),
      sessionCoordinator: (...args) => this.sessionCoordinator(...args),
      get store() { return svc.store; },
      get terminalTracker() { return svc.terminalTracker; },
      workerRead: (...args) => this.workers.workerRead(...args),
      workerRelease: (...args) => this.workers.workerRelease(...args),
      workerStart: (...args) => this.workers.workerStart(...args),
      workerStop: (...args) => this.workers.workerStop(...args),
    });
    this.integration = new OrchestrationIntegrationService({
      assertRunCoordinator: (...args) => this.assertRunCoordinator(...args),
      assertWorkerController: (...args) => this.assertWorkerController(...args),
      authorizeRunAccess: (...args) => this.authorizeRunAccess(...args),
      emitChanged: (...args) => this.emitChanged(...args),
      get getDefaultCwd() { return svc.getDefaultCwd; },
      inferRunIdOptional: (...args) => this.inferRunIdOptional(...args),
      mutateWorkerResources: (...args) => this.workers.mutateWorkerResources(...args),
      releaseWorker: (...args) => this.workers.releaseWorker(...args),
      resolveDispatchByRoleOrTarget: (...args) => this.delegation.resolveDispatchByRoleOrTarget(...args),
      resolveRoleNameForDispatch: (...args) => this.delegation.resolveRoleNameForDispatch(...args),
      resolveTargetDispatch: (...args) => this.workers.resolveTargetDispatch(...args),
      get store() { return svc.store; },
      get terminalTracker() { return svc.terminalTracker; },
      workerRelease: (...args) => this.workers.workerRelease(...args),
    });
    this.review = new OrchestrationReviewService({
      emitChanged: (...args) => this.emitChanged(...args),
      failTaskIfReady: (...args) => this.failTaskIfReady(...args),
      resolveRoleNameForDispatch: (...args) => this.delegation.resolveRoleNameForDispatch(...args),
      get store() { return svc.store; },
    });
    this.board = new OrchestrationBoardService({
      get agentStatusStore() { return svc.agentStatusStore; },
      get approvals() { return svc.approvals; },
      get clock() { return svc.clock; },
      deliverCodexMailbox: (...args) => this.workers.deliverCodexMailbox(...args),
      deriveLiveStage: (...args) => this.workers.deriveLiveStage(...args),
      emitChanged: (...args) => this.emitChanged(...args),
      followUpSettledWorker: (...args) => this.workers.followUpSettledWorker(...args),
      get getPeerMessagingModeDep() { return svc.getPeerMessagingModeDep; },
      getReviewFirewallContext: (...args) => this.review.getReviewFirewallContext(...args),
      inferRunIdOptional: (...args) => this.inferRunIdOptional(...args),
      isPostHiddenByReviewFirewall: (...args) => this.review.isPostHiddenByReviewFirewall(...args),
      get nativeQuestions() { return svc.nativeQuestions; },
      get peerPingPong() { return svc.peerPingPong; },
      get pointerDelivery() { return svc.pointerDelivery; },
      get proposals() { return svc.proposals; },
      queueCodexMail: (...args) => this.workers.queueCodexMail(...args),
      resolveRoleNameForDispatch: (...args) => this.delegation.resolveRoleNameForDispatch(...args),
      sessionCoordinator: (...args) => this.sessionCoordinator(...args),
      get store() { return svc.store; },
      toWorkerSummary: (...args) => this.workers.toWorkerSummary(...args),
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
      resolveRoleName: (dispatch) => this.delegation.resolveRoleNameForDispatch(dispatch) || null,
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
      resolveRoleName: (dispatch) => this.delegation.resolveRoleNameForDispatch(dispatch) || null,
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
    this.workers.startDormancySweep(deps.headlessWorkerDormancySweepMs ?? 0);

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

    void this.integration.recoverGitPublications().catch(error => console.warn('[orchestration] Git recovery:', error)).finally(() => this.delegation.scheduleQueuedLaunches());
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
    this.delegation.scheduleQueuedLaunches();
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
    this.delegation.scheduleQueuedLaunches();
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
    if (HEADLESS_WORKER_ID.test(ptyId)) return this.workers.codexWorkers.get(ptyId)?.alive ?? false;
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

  workerInterrupt(input: { dispatchId?: string; worker?: string; taskId?: string }): Promise<{
    dispatch: OrchestrationDispatchRecord; interrupted: boolean;
  }> {
    return this.workers.workerInterrupt(input);
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
    return this.workers.workerUpdateControls(input);
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

  reconcilePublication(input: { runId: string; expectedCommit: string; acceptUnpublished?: boolean }): Promise<{ message: string }> {
    return this.integration.reconcilePublication(input);
  }

  private emitChanged(reason: string, runId?: string): void {
    this.delegation.scheduleQueuedLaunches();
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
    this.workers.retireFinishedCodexWorkers(runId);
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
      void this.workers.confirmWorkerPaneClosed(ptyId)
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

  private failTaskIfReady(taskId: string): void {
    // A task created for a worker that never started has nobody to run it; left `ready`, the
    // coordinator loop would later dispatch it as ordinary work (and a review outside its worktree).
    if (this.store.getTask(taskId)?.status === 'ready') {
      this.store.updateTaskStatus(taskId, 'failed');
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
    const rawTarget = this.workers.resolveTargetDispatch(targetInput);
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
      const role = this.delegation.resolveRoleNameForDispatch(d) || d.id;
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
      if (!task.queuedLaunch || task.queuedLaunch.state === 'claimed' || this.delegation.claimedLaunches.has(task.id) ||
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
        await this.workers.workerStart({ runId: run.id, taskId: task.id, agent: cliId, from: run.coordinatorHandle, worktree: true });
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
      if (this.workers.codexWorkers.has(codexTarget)) {
        this.workers.queueCodexMail(codexTarget, message);
        this.workers.deliverCodexMailbox(codexTarget);
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
        const role = this.delegation.resolveRoleNameForDispatch(dispatch).toLowerCase() || dispatch.id;
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
            this.delegation.resolveRoleNameForDispatch(activeDispatch).toLowerCase() || activeDispatch.id;
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
          this.delegation.resolveRoleNameForDispatch(activeDispatch).toLowerCase() || activeDispatch.id;
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
          return this.workers.followUpSettledWorker(latestInLineage, { ...input, to: rawTo });
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
              return this.workers.followUpSettledWorker(latestInLineage, {
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
      this.delegation.resolveRoleNameForDispatch(resolvedDispatch).toLowerCase() ||
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
            ? this.delegation.resolveRoleNameForDispatch(targetDispatch) || targetDispatch.id
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
            reviewNextStep = targetRun && this.integration.isRunIntegrationBranchLive(targetRun)
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
        ? this.delegation.resolveRoleNameForDispatch(reviewedTarget).trim().replace(/^@+/, '').toLowerCase()
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
                ? await this.integration.resolveEffectiveWorkerDiffBase(
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
              const cleanRole = this.delegation.resolveRoleNameForDispatch(resolvedDispatch) || resolvedDispatch.id;
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
          this.delegation.resolveRoleNameForDispatch(activeDispatch).toLowerCase() || undefined;
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
            if (asker) this.store.recordBoardRead(current.runId, this.delegation.resolveRoleNameForDispatch(asker).toLowerCase() || asker.id, [current.answerMessageId]);
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
        ? this.delegation.resolveRoleNameForDispatch(targetDispatch).toLowerCase() || undefined
        : undefined;
      const replierDispatch = this.store.getActiveDispatchForIdentity(answeredBy, answeredBy);
      const replierRole =
        answeredBy === 'user'
          ? 'user'
          : replierDispatch
            ? this.delegation.resolveRoleNameForDispatch(replierDispatch).toLowerCase() || 'worker'
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

  workerStart(input: {
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
    return this.workers.workerStart(input, queueClaim);
  }

  workerList(input: {
    runId?: string;
    status?: OrchestrationDispatchRecord['status'];
    includeSettled?: boolean;
  } = {}, callerPaneId?: string): {
    workers: OrchestrationWorkerSummary[];
    count: number;
  } {
    return this.workers.workerList(input, callerPaneId);
  }

  workerShow(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
  }, callerPaneId?: string): OrchestrationWorkerSummary {
    return this.workers.workerShow(input, callerPaneId);
  }

  workerRead(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    cursor?: number;
    limit?: number;
    screen?: boolean;
  }, callerPaneId?: string): TerminalReadResult & { dispatchId: string; archived: boolean } {
    return this.workers.workerRead(input, callerPaneId);
  }

  workerKeepOpen(input: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    keepOpen?: boolean;
  }): { dispatch: OrchestrationDispatchRecord; retained: boolean } {
    return this.workers.workerKeepOpen(input);
  }

  workerRelease(input: {
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
    return this.workers.workerRelease(input);
  }

  workerStop(input: {
      dispatchId?: string;
      worker?: string;
      taskId?: string;
      reason?: string;
      removeWorktree?: boolean;
      force?: boolean;
    }, visitedDispatchIds = new Set<string>()): Promise<{
    dispatch: OrchestrationDispatchRecord;
    closedPane: boolean;
    removedWorktree: boolean;
    stoppedHelperIds: string[];
  }> {
    return this.workers.workerStop(input, visitedDispatchIds);
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
    return this.workers.workerAbandon(input);
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
      for (const codex of this.workers.codexWorkers.values()) void codex.close(true);
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

  approveDispatchProposal(id: string, overrides?: DispatchProposalOverrides): { proposal: OrchestrationDispatchProposal } {
    return this.delegation.approveDispatchProposal(id, overrides);
  }

  rejectDispatchProposal(id: string, reason?: string): { proposal: OrchestrationDispatchProposal } {
    return this.delegation.rejectDispatchProposal(id, reason);
  }

  workerDiff(input: {
      dispatchId?: string;
      worker?: string;
      taskId?: string;
      files?: string[];
      maxDiffBytes?: number;
    }, callerPaneId?: string): Promise<WorkerDiffInspection & {
    dispatchId: string;
    taskId: string;
    role: string;
    reviewStatus: string;
    reviewRound: number;
    integrationStatus: string;
  }> {
    return this.integration.workerDiff(input, callerPaneId);
  }

  workerIntegrate(input: {
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
    }, callerPaneId?: string): Promise<WorkerIntegrationResult & {
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
    return this.integration.workerIntegrate(input, callerPaneId);
  }

  runDiff(input: {
      runId?: string;
      files?: string[];
      maxDiffBytes?: number;
    }, callerPaneId?: string): Promise<RunCommitRangeDiffInspection & {
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
    return this.integration.runDiff(input, callerPaneId);
  }

  runFinalizeIntegration(input: {
      runId?: string;
      mode?: WorkerIntegrateMode;
      expectedSnapshotOid?: string;
      commitMessage?: string;
      deleteBranch?: boolean;
      keepWorktree?: boolean;
      force?: boolean;
    }, callerPaneId?: string): Promise<WorkerIntegrationResult & {
    runId: string;
    integrationBranch: string;
    integrationWorktreePath: string;
    removedWorktree: boolean;
    removedBranch: boolean;
    releasedReviews: number;
    cleanupWarnings?: string[];
  }> {
    return this.integration.runFinalizeIntegration(input, callerPaneId);
  }

  setRunAutoReview(input: { runId: string; enabled: boolean }): { run: OrchestrationRunRecord } {
    return this.review.setRunAutoReview(input);
  }

  delegateTask(input: {
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
    }, signal?: AbortSignal): Promise<OrchestrationDelegateTaskResult> {
    return this.delegation.delegateTask(input, signal);
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
    const fromRole = this.delegation.resolveRoleNameForDispatch(active).toLowerCase() || undefined;
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
    return this.delegation.resolveWorkerByRoleOrId(callerPaneId, target);
  }

  messageWorkerByRole(callerPaneId: string, input: { role: string; message: string; subject?: string; questionId?: string }): Promise<
    | ({ mode: 'replied'; dispatch: OrchestrationDispatchRecord } & ReturnType<
        OrchestrationService['reply']
      >)
    | ({ mode: 'sent' | 'reactivated'; dispatch: OrchestrationDispatchRecord } & OrchestrationSendResult)
  > {
    return this.delegation.messageWorkerByRole(callerPaneId, input);
  }

  manageWorkerByRole(callerPaneId: string, input: {
      role: string;
      action: 'read' | 'approve' | 'deny' | 'release' | 'stop';
      reason?: string;
      force?: boolean;
      screen?: boolean;
    }): Promise<Record<string, unknown>> {
    return this.delegation.manageWorkerByRole(callerPaneId, input);
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
    const managed = this.delegation.listManagedDispatchesForCaller(cleanCaller);
    const workers: OrchestrationMcpWorkerBrief[] = managed.map((d) => {
      const summary = this.workers.toWorkerSummary(d);
      const roleName =
        this.delegation.resolveRoleNameForDispatch(d) ||
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
    const session = this.workers.codexWorkers.get(dispatch.assigneeHandle);
    const alive = Boolean(session?.alive && !dispatch.releasedAt);
    const busy = alive && (session!.busy || this.workers.codexSubmitting.has(dispatch.id));
    return { ...dispatch, headlessLive: { alive, busy, dormant: !alive && this.workers.isDormant(dispatch) } };
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
    return this.workers.hasCodexWorkers();
  }

  async stopCodexWorkers(): Promise<void> {
    this.disposed = true;
    await this.workers.closeAllCodexWorkers();
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
    this.workers.stopDormancySweep();
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
    this.workers.retireFinishedCodexWorkers();
  }
}
