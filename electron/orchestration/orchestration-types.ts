import type { AgentQuestion, AgentSessionPolicy } from './agent-session-driver.js';
import type { WorkerTimelineSnapshot } from './worker-timeline.js';

export const ORCHESTRATION_MESSAGE_TYPES = [
  'status',
  'dispatch',
  'worker_done',
  'merge_ready',
  'escalation',
  'handoff',
  'decision_gate',
  'question',
  'heartbeat',
] as const;

export type OrchestrationMessageType = (typeof ORCHESTRATION_MESSAGE_TYPES)[number];

export type OrchestrationMessagePriority = 'low' | 'normal' | 'high' | 'urgent';

export type OrchestrationTaskStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'blocked';

export type OrchestrationDispatchStatus =
  | 'pending'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'circuit_broken';

export type OrchestrationWorkerReportOutcome =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'escalated'
  | 'abandoned';

export type OrchestrationGateStatus = 'pending' | 'resolved' | 'timeout';

export type OrchestrationRunStatus = 'active' | 'completed' | 'failed' | 'stopped';

export type OrchestrationCoordinatorStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped';

export type OrchestrationQuestionStatus = 'pending' | 'answered' | 'closed';

export type OrchestrationDeliveryStatus = 'pending' | 'acknowledged' | 'fenced';

export const DISPATCH_CIRCUIT_BREAK_FAILURES = 3;
export const DEFAULT_NESTED_WORKER_MAX_DEPTH = 2;
export const DEFAULT_MAX_ACTIVE_WORKERS = 8;
export const UNBOUND_RUN_ID = 'run_unbound';
export const ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS = 120_000;
export const ORCHESTRATION_DELIVERY_BATCH_LIMIT = 50;
export const AGENT_PROMPT_STALLED_ERROR = 'agent_prompt_stalled';
export const DISPATCH_HEARTBEAT_TIMEOUT_ERROR = 'heartbeat_timeout';

export type OrchestrationStartObservation =
  | 'pending'
  | 'observed'
  | 'queued'
  | 'permission'
  | 'unobserved'
  | 'unsupported';

export type OrchestrationDispatchStage =
  | 'starting'
  | 'working'
  | 'waiting_permission'
  | 'waiting_input'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | 'released'
  | 'stopped';

export type WorkerTurnStopReason = 'finished' | 'errored' | 'needs-input' | 'exited' | 'lost';

export type WorkerApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface WorkerApprovalPayload {
  approvalId: string;
  dispatchId: string;
  taskId: string;
  runId: string;
  workerHandle: string;
  ptyId: string;
  provider: string;
  eventName: string;
  toolName: string;
  toolInput?: string;
  message?: string;
  status: WorkerApprovalStatus;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  reason?: string | null;
}

export type WorkerNativeQuestionStatus = 'pending' | 'answered' | 'skipped' | 'expired';

/** A structured question a headless Worker's own agent asked through its native protocol. */
export interface WorkerNativeQuestionPayload {
  requestId: string;
  dispatchId: string;
  taskId: string;
  runId: string;
  workerHandle: string;
  /** The driver that asked (codex, claude, antigravity, grok). */
  provider: string;
  method: string;
  questions: AgentQuestion[];
  status: WorkerNativeQuestionStatus;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  answers?: Record<string, string[]> | null;
  reason?: string | null;
}

export type OrchestrationConfirmMode = 'chat-and-guard' | 'always-ui' | 'auto';

export const ORCHESTRATION_PEER_MESSAGING_MODES = ['controlled-p2p', 'hub-only'] as const;
export type OrchestrationPeerMessagingMode = (typeof ORCHESTRATION_PEER_MESSAGING_MODES)[number];

export const ORCHESTRATION_BOARD_POST_KINDS = [
  'brief',
  'post',
  'update',
  'handoff',
  'question',
  'answer',
  'report',
  'approval',
  'stall',
  'system',
] as const;
export type OrchestrationBoardPostKind = (typeof ORCHESTRATION_BOARD_POST_KINDS)[number];

export interface OrchestrationMemberCursor {
  lastReadSeq: number;
  lastPostSeq: number;
  lastDeliveredSeq: number;
}

export type OrchestrationReviewSeverity = 'P0' | 'P1' | 'P2';
export type OrchestrationReviewVerdict = 'pass' | 'reject';
export type OrchestrationReviewStatus = 'none' | 'pending' | 'passed' | 'rejected' | 'escalated';
export type OrchestrationIntegrationStatus = 'none' | 'checked' | 'merged' | 'conflict' | 'skipped';
export type OrchestrationRunIntegrationStatus = 'none' | 'active' | 'finalized' | 'conflict';

export interface OrchestrationReviewFinding {
  severity: OrchestrationReviewSeverity;
  location: string;
  title: string;
  evidence: string;
  fix?: string;
}

export interface OrchestrationReportArtifacts {
  branch?: string | null;
  worktreePath?: string | null;
  baseCommit?: string | null;
  headCommit?: string | null;
  snapshotOid?: string | null;
  commitsAhead?: number;
  uncommittedCount?: number;
  changedFiles?: string[];
  changedFileCount?: number;
  reviewTier?: 'L0' | 'L1' | 'L2';
  reviewTierReason?: string;
  recommendedNextStep?: string;
  reviewVerdict?: OrchestrationReviewVerdict;
  reviewFindings?: OrchestrationReviewFinding[];
}

export const ORCHESTRATION_TASK_KINDS = [
  'architecture',
  'implementation',
  'debug',
  'tests',
  'review',
  'research',
  'docs',
] as const;

export type OrchestrationTaskKind = (typeof ORCHESTRATION_TASK_KINDS)[number];

export interface OrchestrationIdlePaneInfo {
  ptyId: string;
  cliId: string;
  cwd: string | null;
}

export interface OrchestrationAgentRosterEntry {
  cliId: string;
  label: string;
  command: string;
  installed: boolean;
  enabled: boolean;
  available: boolean;
  specialty: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  hooksInstalled: boolean;
  mcpMode: 'launch-arg' | 'config' | 'cli-fallback';
  mcpReady: boolean;
  idlePanes: OrchestrationIdlePaneInfo[];
}

export interface OrchestrationTaskContext {
  background?: string;
  constraints?: string[];
  files?: string[];
  acceptance?: string;
}

export type OrchestrationDispatchProposalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

export interface OrchestrationDispatchProposal {
  id: string;
  coordinatorPaneId: string;
  runId: string | null;
  role: string;
  task: string;
  taskContext?: OrchestrationTaskContext | null;
  planSummary: string;
  requestedAgent: string;
  resolvedAgent: string;
  taskKind: OrchestrationTaskKind | null;
  worktree: boolean;
  model: string | null;
  effort: string | null;
  terminal: string | null;
  /** Headless Worker permission tier, network access, and sub-Worker opt-in; the person may change them on approval. */
  policy?: AgentSessionPolicy | null;
  network?: boolean | null;
  allowSubWorkers?: boolean;
  authorizeReviews?: boolean;
  status: OrchestrationDispatchProposalStatus;
  createdAt: string;
  resolvedAt: string | null;
  reason?: string | null;
}

export type OrchestrationErrorCode =
  | 'invalid_argument'
  | 'not_found'
  | 'run_not_found'
  | 'duplicate_run'
  | 'task_not_found'
  | 'duplicate_task'
  | 'task_not_ready'
  | 'task_cycle'
  | 'cyclic_dependency'
  | 'dispatch_not_found'
  | 'dispatch_inactive'
  | 'dispatch_fenced'
  | 'circuit_broken'
  | 'worker_busy'
  | 'worker_limit_reached'
  | 'consumer_fenced'
  | 'answer_conflict'
  | 'stale_delivery'
  | 'delivery_not_found'
  | 'gate_not_found'
  | 'gate_already_resolved'
  | 'approval_not_found'
  | 'approval_already_resolved'
  | 'proposal_not_found'
  | 'proposal_already_resolved'
  | 'worktree_failed'
  | 'coordinator_already_running'
  | 'no_agent_detected'
  | 'terminal_is_coordinator'
  | 'terminal_unavailable'
  | 'prompt_delivery_failed'
  | 'invalid_transition'
  | 'request_aborted'
  | 'operation_rejected';

export class OrchestrationError extends Error {
  readonly code: OrchestrationErrorCode;
  readonly data?: Record<string, unknown>;

  constructor(code: OrchestrationErrorCode, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'OrchestrationError';
    this.code = code;
    this.data = data;
  }
}

export interface OrchestrationRunRecord {
  id: string;
  objective: string;
  status: OrchestrationRunStatus;
  coordinatorHandle: string;
  coordinatorPaneId: string | null;
  consumerGeneration: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
  integrationBranch?: string | null;
  integrationWorktreePath?: string | null;
  integrationBaseCommit?: string | null;
  integrationBaseBranch?: string | null;
  integrationRepoRootPath?: string | null;
  integrationStatus?: OrchestrationRunIntegrationStatus;
  integrationHeadCommit?: string | null;
  finalizedCommit?: string | null;
  runReviewBatchId?: string | null;
  runReviewSnapshotOid?: string | null;
  runReviewBaseCommit?: string | null;
  runReviewStatus?: OrchestrationReviewStatus;
  runReviewRound?: number;
  runReviewFindings?: OrchestrationReviewFinding[];
  reviewAutoAuthorized?: boolean;
}

export interface OrchestrationTaskRecord {
  id: string;
  runId: string;
  spec: string;
  taskContext?: OrchestrationTaskContext | null;
  taskTitle: string;
  displayName: string;
  deps: string[];
  priority: OrchestrationMessagePriority;
  status: OrchestrationTaskStatus;
  /** Set while `blocked` for a reason the store resolves on its own, e.g. `dependency_failed:<taskId>`. */
  blockedReason?: string | null;
  /** Created together with its worker; nothing re-dispatches it, so a failed dispatch fails it. */
  singleShot?: boolean;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CodexPilotTurnRecord {
  turnId: string;
  stopReason: string;
  finalText: string;
  diff: string | null;
  usage: Record<string, number> | null;
  error: string | null;
}

export interface OrchestrationDispatchRecord {
  executionMode?: 'codex-app-server';
  providerSessionId?: string;
  /** Headless Workers only. Records without them are read-only exactly when the timeline says so, with network off. */
  workerPolicy?: AgentSessionPolicy;
  workerNetwork?: boolean;
  allowSubWorkers?: boolean;
  codexTurn?: CodexPilotTurnRecord;
  codexDeliveryFailure?: 'unknown_acceptance' | 'not_accepted';
  id: string;
  taskId: string;
  runId: string;
  creator: string;
  creatorRunId: string | null;
  creatorDispatchId?: string | null;
  parentPaneId?: string | null;
  depth: number;
  assigneeHandle: string;
  assigneePaneId: string | null;
  processIncarnation: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  baseCommit?: string | null;
  repoRootPath?: string | null;
  briefFilePath?: string | null;
  ownsWorktree?: boolean;
  ownsBranch?: boolean;
  isDetachedReviewWorktree?: boolean;
  reviewOfDispatchId?: string | null;
  reviewOfRunId?: string | null;
  reviewFocus?: string | null;
  reviewBatchId?: string | null;
  reviewSnapshotOid?: string | null;
  reviewBaseCommit?: string | null;
  reviewStatus?: OrchestrationReviewStatus;
  reviewRound?: number;
  reviewFindings?: OrchestrationReviewFinding[];
  reviewMutatedWorkspace?: boolean;
  integrationStatus?: OrchestrationIntegrationStatus;
  integratedCommit?: string | null;
  integratedTargetBranch?: string | null;
  ownsPane?: boolean;
  cliId?: string | null;
  model?: string | null;
  effort?: string | null;
  processGeneration?: number;
  stage?: OrchestrationDispatchStage;
  turnStopReportedGeneration?: number | null;
  followUpOfDispatchId?: string | null;
  retained?: boolean;
  releasedAt?: string | null;
  archivedOutput?: string | null;
  /** Redacted, size-capped process timeline of a headless Worker; omitted from renderer snapshots. */
  archivedTimeline?: WorkerTimelineSnapshot | null;
  /** Renderer snapshots carry this flag instead of the archived timeline itself. */
  hasArchivedTimeline?: boolean;
  status: OrchestrationDispatchStatus;
  failureCount: number;
  lastFailureReason: string | null;
  failureSummary: string | null;
  lastHeartbeatAt: string | null;
  consumerGeneration: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startObservation?: OrchestrationStartObservation;
  startObservationReason?: string | null;
  turnStartedAt?: string | null;
  /** Last time a prompt was actually written to the assignee; null when never delivered. */
  promptSentAt?: string | null;
  /** workingSequence captured when the turn was queued behind an already-working pane. */
  queuedWorkingBaseline?: number | null;
  /** When the one-shot "no progress" advisory was emitted; prevents repeated warnings. */
  staleWarningAt?: string | null;
}

export interface OrchestrationTaskWithDispatch extends OrchestrationTaskRecord {
  latestDispatch: OrchestrationDispatchRecord | null;
}

export interface OrchestrationGateRecord {
  id: string;
  taskId: string;
  runId: string;
  requesterDispatchId: string | null;
  requesterHandle: string | null;
  question: string;
  options: string[];
  status: OrchestrationGateStatus;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface OrchestrationMessageRecord {
  id: string;
  runId: string;
  seq: number;
  boardSeq?: number;
  type: OrchestrationMessageType;
  priority: OrchestrationMessagePriority;
  fromHandle: string;
  toHandle: string;
  fromRole?: string;
  mentions?: string[];
  refs?: number[];
  kind?: OrchestrationBoardPostKind;
  artifacts?: OrchestrationReportArtifacts | null;
  subject: string;
  body: string;
  payload: string | null;
  threadId: string | null;
  deliveredAt: string | null;
  read: boolean;
  createdAt: string;
  lifecycleRejectedReason: string | null;
}

export interface OrchestrationReportFollowUp {
  kind: 'send' | 'worker_start';
  dispatchId?: string;
  active?: boolean;
}

export interface OrchestrationExposedMessage {
  id: string;
  runId: string;
  boardSeq?: number;
  type: OrchestrationMessageType;
  priority: OrchestrationMessagePriority;
  fromHandle: string;
  toHandle: string;
  fromRole?: string;
  mentions?: string[];
  refs?: number[];
  kind?: OrchestrationBoardPostKind;
  artifacts?: OrchestrationReportArtifacts | null;
  subject: string;
  body: string;
  payload: string | null;
  threadId: string | null;
  deliveredAt: string | null;
  createdAt: string;
  lifecycleRejectedReason: string | null;
  followUp?: OrchestrationReportFollowUp;
}

export interface OrchestrationDeliveryRecord {
  id: string;
  runId: string;
  mailboxHandle: string;
  consumerHandle?: string;
  messageIds: string[];
  status: OrchestrationDeliveryStatus;
  consumerGeneration: number;
  createdAt: string;
  acknowledgedAt: string | null;
}

export interface OrchestrationQuestionRecord {
  messageId: string;
  runId: string;
  dispatchId: string;
  fromHandle: string;
  toHandle: string;
  question: string;
  options: string[];
  status: OrchestrationQuestionStatus;
  answerBody: string | null;
  answerMessageId: string | null;
  answeredBy: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface OrchestrationCoordinatorRunRecord {
  id: string;
  runId: string;
  spec: string;
  status: OrchestrationCoordinatorStatus;
  coordinatorHandle: string;
  pollIntervalMs: number;
  maxConcurrent: number;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export type OrchestrationTaskShowResult = {
  task: OrchestrationTaskRecord;
  latestDispatch: OrchestrationDispatchRecord | null;
  dispatches: OrchestrationDispatchRecord[];
  gates: OrchestrationGateRecord[];
};

export type OrchestrationCoordinatorStatusResult = {
  running: boolean;
  runId: string | null;
  coordinatorRun: OrchestrationCoordinatorRunRecord | null;
  activeCoordinatorRun: OrchestrationCoordinatorRunRecord | null;
  run: OrchestrationRunRecord | null;
  taskCounts: {
    total: number;
    pending: number;
    ready: number;
    dispatched: number;
    blocked: number;
    completed: number;
    failed: number;
  };
  activeDispatches: number;
  pendingGates: number;
};

export interface OrchestrationPersistedState {
  version: 1;
  nextSequence: number;
  currentRunByConsumer: Record<string, string>;
  runs: OrchestrationRunRecord[];
  tasks: OrchestrationTaskRecord[];
  dispatches: OrchestrationDispatchRecord[];
  gates: OrchestrationGateRecord[];
  messages: OrchestrationMessageRecord[];
  deliveries: OrchestrationDeliveryRecord[];
  consumerReadByMessageId?: Record<string, string[]>;
  consumerDeliveredByMessageId?: Record<string, string[]>;
  questions: OrchestrationQuestionRecord[];
  coordinatorRuns: OrchestrationCoordinatorRunRecord[];
  /** Per-dispatch worker credentials, keyed by dispatch id. Never part of the UI snapshot. */
  capabilities?: Record<string, string>;
  deferredDispatchPrompts?: Record<string, { ptyId: string; prompt: string; submit: boolean }>;
  nextBoardSeqByRun?: Record<string, number>;
  memberCursorsByRun?: Record<string, Record<string, OrchestrationMemberCursor>>;
}

export interface OrchestrationSnapshot {
  runs: OrchestrationRunRecord[];
  tasks: OrchestrationTaskWithDispatch[];
  dispatches: OrchestrationDispatchRecord[];
  gates: OrchestrationGateRecord[];
  messages: OrchestrationMessageRecord[];
  questions: OrchestrationQuestionRecord[];
  openApprovals?: WorkerApprovalPayload[];
  openNativeQuestions?: WorkerNativeQuestionPayload[];
  pendingProposals?: OrchestrationDispatchProposal[];
  orchestrationModePanes?: string[];
  memberCursorsByRun?: Record<string, Record<string, OrchestrationMemberCursor>>;
  coordinatorRuns: OrchestrationCoordinatorRunRecord[];
  activeCoordinatorRun: OrchestrationCoordinatorRunRecord | null;
  currentRunByConsumer: Record<string, string>;
}
