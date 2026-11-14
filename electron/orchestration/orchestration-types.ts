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
  | 'consumer_fenced'
  | 'answer_conflict'
  | 'stale_delivery'
  | 'delivery_not_found'
  | 'gate_not_found'
  | 'gate_already_resolved'
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
}

export interface OrchestrationTaskRecord {
  id: string;
  runId: string;
  spec: string;
  taskTitle: string;
  displayName: string;
  deps: string[];
  priority: OrchestrationMessagePriority;
  status: OrchestrationTaskStatus;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationDispatchRecord {
  id: string;
  taskId: string;
  runId: string;
  creator: string;
  creatorRunId: string | null;
  depth: number;
  assigneeHandle: string;
  assigneePaneId: string | null;
  processIncarnation: string | null;
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
  type: OrchestrationMessageType;
  priority: OrchestrationMessagePriority;
  fromHandle: string;
  toHandle: string;
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
  type: OrchestrationMessageType;
  priority: OrchestrationMessagePriority;
  fromHandle: string;
  toHandle: string;
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
}

export interface OrchestrationSnapshot {
  runs: OrchestrationRunRecord[];
  tasks: OrchestrationTaskWithDispatch[];
  dispatches: OrchestrationDispatchRecord[];
  gates: OrchestrationGateRecord[];
  messages: OrchestrationMessageRecord[];
  questions: OrchestrationQuestionRecord[];
  coordinatorRuns: OrchestrationCoordinatorRunRecord[];
  activeCoordinatorRun: OrchestrationCoordinatorRunRecord | null;
  currentRunByConsumer: Record<string, string>;
}
