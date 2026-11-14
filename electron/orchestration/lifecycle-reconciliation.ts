import type { OrchestrationStore } from './orchestration-store.js';
import type {
  OrchestrationMessageRecord,
  OrchestrationWorkerReportOutcome,
} from './orchestration-types.js';

const VALID_OUTCOMES = new Set<OrchestrationWorkerReportOutcome>([
  'completed',
  'failed',
  'blocked',
  'escalated',
  'abandoned',
]);

export interface ReconcileLifecycleResult {
  action: 'ignored' | 'settled' | 'duplicate' | 'rejected' | 'heartbeat';
  reason?: string;
}

export function hasLifecycleAuthority(
  dispatch: { id: string; assigneeHandle: string; assigneePaneId: string | null },
  fromHandle: string
): boolean {
  if (fromHandle === `dispatch:${dispatch.id}`) {
    return true;
  }
  if (fromHandle === dispatch.assigneeHandle) {
    return true;
  }
  if (dispatch.assigneePaneId && fromHandle === dispatch.assigneePaneId) {
    return true;
  }
  return false;
}

function parseJsonObject(raw: string | null): Record<string, unknown> | null {
  if (!raw || !raw.trim()) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function reconcileLifecycleMessage(
  store: OrchestrationStore,
  message: OrchestrationMessageRecord
): ReconcileLifecycleResult {
  if (message.lifecycleRejectedReason) {
    return { action: 'ignored' };
  }

  if (message.type === 'heartbeat') {
    const payload = parseJsonObject(message.payload);
    const dispatchId =
      typeof payload?.dispatchId === 'string' && payload.dispatchId.trim()
        ? payload.dispatchId.trim()
        : message.fromHandle.startsWith('dispatch:')
          ? message.fromHandle.slice('dispatch:'.length)
          : '';
    if (!dispatchId) {
      return { action: 'ignored' };
    }
    const dispatch = store.getDispatchContext(dispatchId);
    if (!dispatch || !hasLifecycleAuthority(dispatch, message.fromHandle)) {
      return { action: 'ignored' };
    }
    store.recordHeartbeat(dispatchId);
    return { action: 'heartbeat' };
  }

  if (message.type !== 'worker_done') {
    return { action: 'ignored' };
  }

  const payload = parseJsonObject(message.payload);
  if (!payload) {
    const reason = 'worker_done message is missing valid JSON payload';
    store.markLifecycleRejected(message.id, reason);
    return { action: 'rejected', reason };
  }

  const taskId = typeof payload.taskId === 'string' ? payload.taskId.trim() : '';
  const dispatchId = typeof payload.dispatchId === 'string' ? payload.dispatchId.trim() : '';
  const outcomeRaw = typeof payload.outcome === 'string' ? payload.outcome.trim() : 'completed';
  const summary = typeof payload.summary === 'string' ? payload.summary : message.body;

  if (!taskId || !dispatchId) {
    const reason = 'worker_done payload must include taskId and dispatchId';
    store.markLifecycleRejected(message.id, reason);
    return { action: 'rejected', reason };
  }

  if (!VALID_OUTCOMES.has(outcomeRaw as OrchestrationWorkerReportOutcome)) {
    const reason = `Invalid worker_done outcome: ${outcomeRaw}`;
    store.markLifecycleRejected(message.id, reason);
    return { action: 'rejected', reason };
  }

  const dispatch = store.getDispatchContext(dispatchId);
  if (!dispatch) {
    const reason = `Unknown dispatch ${dispatchId}`;
    store.markLifecycleRejected(message.id, reason);
    return { action: 'rejected', reason };
  }

  if (!hasLifecycleAuthority(dispatch, message.fromHandle)) {
    const reason = `Sender ${message.fromHandle} lacks authority over dispatch ${dispatchId}`;
    store.markLifecycleRejected(message.id, reason);
    return { action: 'rejected', reason };
  }

  const settled = store.settleWorkerReport({
    dispatchId,
    taskId,
    outcome: outcomeRaw as OrchestrationWorkerReportOutcome,
    summary,
    reportedByHandle: message.fromHandle,
  });

  if (settled.action === 'rejected') {
    store.markLifecycleRejected(message.id, settled.reason ?? 'Rejected by lifecycle reconciliation');
    return { action: 'rejected', reason: settled.reason };
  }

  return { action: settled.action };
}
