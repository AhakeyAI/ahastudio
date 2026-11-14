import {
  AGENT_PROMPT_STALLED_ERROR,
  DISPATCH_HEARTBEAT_TIMEOUT_ERROR,
  OrchestrationError,
  type OrchestrationDispatchStatus,
  type OrchestrationTaskStatus,
} from './orchestration-types.js';

const TASK_TRANSITIONS: Record<OrchestrationTaskStatus, ReadonlySet<OrchestrationTaskStatus>> = {
  pending: new Set(['ready', 'blocked', 'failed']),
  ready: new Set(['dispatched', 'blocked', 'failed', 'completed']),
  dispatched: new Set(['completed', 'failed', 'ready', 'blocked']),
  blocked: new Set(['ready', 'pending', 'failed', 'completed']),
  completed: new Set([]),
  failed: new Set(['ready']),
};

const DISPATCH_TRANSITIONS: Record<
  OrchestrationDispatchStatus,
  ReadonlySet<OrchestrationDispatchStatus>
> = {
  pending: new Set(['dispatched', 'completed', 'failed', 'circuit_broken']),
  dispatched: new Set(['completed', 'failed', 'circuit_broken']),
  completed: new Set([]),
  failed: new Set([]),
  circuit_broken: new Set([]),
};

export const TERMINAL_TASK_STATUSES: ReadonlySet<OrchestrationTaskStatus> = new Set([
  'completed',
  'failed',
]);

export const ACTIVE_DISPATCH_STATUSES: ReadonlySet<OrchestrationDispatchStatus> = new Set([
  'pending',
  'dispatched',
]);

export function canTransitionTask(
  from: OrchestrationTaskStatus,
  to: OrchestrationTaskStatus
): boolean {
  if (from === to) {
    return true;
  }
  return TASK_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertTaskTransition(
  taskId: string,
  from: OrchestrationTaskStatus,
  to: OrchestrationTaskStatus
): void {
  if (!canTransitionTask(from, to)) {
    throw new OrchestrationError(
      'invalid_transition',
      `Illegal task transition for ${taskId}: ${from} -> ${to}`,
      { taskId, from, to }
    );
  }
}

export function canTransitionDispatch(
  from: OrchestrationDispatchStatus,
  to: OrchestrationDispatchStatus
): boolean {
  if (from === to) {
    return true;
  }
  return DISPATCH_TRANSITIONS[from]?.has(to) ?? false;
}

export function assertDispatchTransition(
  dispatchId: string,
  from: OrchestrationDispatchStatus,
  to: OrchestrationDispatchStatus
): void {
  if (!canTransitionDispatch(from, to)) {
    throw new OrchestrationError(
      'invalid_transition',
      `Illegal dispatch transition for ${dispatchId}: ${from} -> ${to}`,
      { dispatchId, from, to }
    );
  }
}

export function reportCorrectsUnobservedPrompt(
  dispatch: { status: OrchestrationDispatchStatus; lastFailureReason: string | null },
  task: { status: OrchestrationTaskStatus }
): boolean {
  return (
    (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') &&
    typeof dispatch.lastFailureReason === 'string' &&
    dispatch.lastFailureReason.startsWith(AGENT_PROMPT_STALLED_ERROR) &&
    task.status === 'failed'
  );
}

/**
 * A heartbeat-timed-out worker was parked (task blocked) rather than retried, so a late report
 * from the still-running assignee is the authoritative outcome and must be allowed to settle.
 */
export function reportCorrectsUnresponsiveWorker(
  dispatch: { status: OrchestrationDispatchStatus; lastFailureReason: string | null },
  task: { status: OrchestrationTaskStatus }
): boolean {
  return (
    dispatch.status === 'failed' &&
    typeof dispatch.lastFailureReason === 'string' &&
    dispatch.lastFailureReason.startsWith(DISPATCH_HEARTBEAT_TIMEOUT_ERROR) &&
    (task.status === 'blocked' || task.status === 'failed')
  );
}
