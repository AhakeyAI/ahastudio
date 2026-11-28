import { cleanupTerminal } from './cleanup-outbox.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import { OrchestrationError, UNBOUND_RUN_ID } from './orchestration-types.js';
import type { OrchestrationStoreState } from './orchestration-state-repository.js';
import { OrchestrationStoreSlice } from './orchestration-store-slice.js';

export const DISPATCH_CREDENTIAL_PREFIX = 'aha_dispatch_';
export const DEFERRED_CREDENTIAL_SLOT = '<aha-dispatch-credential>';
const PREFIXED_CREDENTIAL_RE = /aha_dispatch_[0-9a-f-]{36}\b/gi;
const LABELLED_LEGACY_CREDENTIAL_RE = /(\bDispatch Capability:\s*|--capability(?:=|\s+)["']?)([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\b/gi;

export function redactDispatchCredentialText(capabilities: ReadonlyMap<string, string>, text: string): string {
  let redacted = text;
  for (const capability of capabilities.values()) {
    redacted = redacted.replaceAll(capability, '<redacted>');
  }
  return redacted.replace(PREFIXED_CREDENTIAL_RE, '<redacted>').replace(LABELLED_LEGACY_CREDENTIAL_RE, '$1<redacted>');
}

export function toDeferredPromptTemplate(capabilities: ReadonlyMap<string, string>, id: string, prompt: string): string {
  const capability = capabilities.get(id);
  const template = capability ? prompt.split(capability).join(DEFERRED_CREDENTIAL_SLOT) : prompt;
  return redactDispatchCredentialText(capabilities, template);
}

export function listActiveDeferredPrompts(state: OrchestrationStoreState) {
  return [...state.deferredPrompts.entries()].filter(([id]) => {
    const dispatch = state.dispatches.get(id);
    return dispatch && ACTIVE_DISPATCH_STATUSES.has(dispatch.status);
  });
}

export class OrchestrationSecurityStore extends OrchestrationStoreSlice {
  listDeferredDispatchPrompts() {
    return listActiveDeferredPrompts(this.state);
  }

  storePromptTemplate(id: string, prompt: string): string {
    return toDeferredPromptTemplate(this.state.dispatchCapabilities, id, prompt);
  }

  restoreDeferredDispatchPrompt(id: string, template: string): string {
    return template.replaceAll(DEFERRED_CREDENTIAL_SLOT, this.state.dispatchCapabilities.get(id) ?? '<redacted>');
  }

  saveDeferredDispatchPrompt(id: string, prompt: { ptyId: string; prompt: string; submit: boolean }): void {
    const dispatch = this.state.dispatches.get(id);
    if (!dispatch || !ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return;
    this.state.deferredPrompts.set(id, { ...prompt, prompt: this.storePromptTemplate(id, prompt.prompt) });
    this.lifecycle.updateDispatchObservation(id, 'permission', { refreshHeartbeat: true });
    this.persist();
  }

  deleteDeferredDispatchPrompt(id: string): void {
    if (this.state.deferredPrompts.delete(id)) this.persist();
  }

  /** Token the assignee must present for worker_done/heartbeat/ask; undefined for legacy dispatches. */
  getDispatchCapability(dispatchId: string): string | undefined {
    return this.state.dispatchCapabilities.get(dispatchId);
  }

  redactDispatchCredentials(text: string): string {
    return redactDispatchCredentialText(this.state.dispatchCapabilities, text);
  }

  assertDispatchCapability(dispatchId: string, capability: string | undefined): void {
    const expected = this.state.dispatchCapabilities.get(dispatchId);
    if (expected === undefined) {
      // Dispatches created before capabilities existed keep the legacy handle-based authority.
      return;
    }
    if (!capability || capability !== expected) {
      throw new OrchestrationError(
        'operation_rejected',
        `A valid dispatch capability is required for dispatch ${dispatchId}.`,
        { dispatchId }
      );
    }
  }

  deleteMessageIds(ids: ReadonlySet<string>): void {
    if (ids.size === 0) return;
    for (const id of ids) {
      this.state.messages.delete(id);
      this.state.boardReadersByMessageId.delete(id);
      this.state.consumerReadByMessageId.delete(id);
      this.state.consumerDeliveredByMessageId.delete(id);
    }
    this.state.messageOrder = this.state.messageOrder.filter((id) => !ids.has(id));
  }

  protectedRunReason(runId: string): string | null {
    if (this.state.cleanupOutbox.some(e => e.runId === runId && !cleanupTerminal(e))) return '资源清理尚未完成';
    const run = this.state.runs.get(runId);
    if (run?.integrationIntent) return 'Git 操作中断，交付位置待核对';
    if (run?.integrationStatus === 'active' || run?.integrationStatus === 'conflict') return '集成分支尚未交付';
    if (run?.integrationWorktreePath) return '保留的集成工作树尚未释放';
    for (const task of this.state.tasks.values()) {
      if (task.runId === runId && task.queuedLaunch) return '有尚未处理的排队任务';
    }
    for (const dispatch of this.state.dispatches.values()) {
      if (dispatch.runId !== runId) continue;
      if (dispatch.stage === 'needs_reconciliation' && ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) return '派发结果需核对';
      if (dispatch.ownsWorktree) return '工作树尚未释放';
      if (dispatch.integrationStatus === 'skipped' && !dispatch.noChanges && !dispatch.reviewOfDispatchId &&
          !dispatch.reviewOfRunId && dispatch.taskKind !== 'research' && dispatch.taskKind !== 'review') return '共享工作区改动尚未确认交付';
      if (dispatch.ownsBranch && dispatch.integrationStatus !== 'merged') return '工作分支尚未交付';
    }
    return null;
  }

  prune(): void {
    const protectedMsgIds = new Set<string>();
    for (const d of this.state.deliveries.values()) {
      if (d.status === 'pending') {
        for (const msgId of d.messageIds) {
          protectedMsgIds.add(msgId);
        }
      }
    }
    for (const q of this.state.questions.values()) {
      if (q.status === 'pending') {
        protectedMsgIds.add(q.messageId);
      }
    }
    for (const msg of this.state.messages.values()) {
      if (!msg.read) {
        protectedMsgIds.add(msg.id);
      }
    }

    const toDeleteMsgIds = new Set<string>();
    const runMsgCounts = new Map<string, number>();
    for (const id of this.state.messageOrder) {
      const msg = this.state.messages.get(id);
      if (!msg) continue;
      runMsgCounts.set(msg.runId, (runMsgCounts.get(msg.runId) ?? 0) + 1);
    }

    for (const id of this.state.messageOrder) {
      const msg = this.state.messages.get(id);
      if (!msg || protectedMsgIds.has(id)) continue;
      const count = runMsgCounts.get(msg.runId) ?? 0;
      if (count > this.limits.maxMessagesPerRun) {
        toDeleteMsgIds.add(id);
        runMsgCounts.set(msg.runId, count - 1);
      }
    }

    let remainingCount = this.state.messageOrder.length - toDeleteMsgIds.size;
    if (remainingCount > this.limits.maxMessages) {
      for (const id of this.state.messageOrder) {
        if (remainingCount <= this.limits.maxMessages) break;
        if (toDeleteMsgIds.has(id)) continue;
        const msg = this.state.messages.get(id);
        if (!msg || protectedMsgIds.has(id)) continue;
        toDeleteMsgIds.add(id);
        remainingCount -= 1;
      }
    }

    if (toDeleteMsgIds.size > 0) {
      this.deleteMessageIds(toDeleteMsgIds);
    }

    for (const [id, d] of this.state.deliveries.entries()) {
      if (d.status !== 'pending' && d.messageIds.every((msgId) => !this.state.messages.has(msgId))) {
        this.state.deliveries.delete(id);
      }
    }

    if (this.state.deliveries.size > this.limits.maxDeliveries) {
      const settledDeliveries = [...this.state.deliveries.values()]
        .filter((d) => d.status !== 'pending')
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      let overflow = this.state.deliveries.size - this.limits.maxDeliveries;
      for (const d of settledDeliveries) {
        if (overflow <= 0) break;
        this.state.deliveries.delete(d.id);
        overflow -= 1;
      }
    }

    const nonUnboundRuns = [...this.state.runs.values()].filter((r) => r.id !== UNBOUND_RUN_ID);
    if (nonUnboundRuns.length > this.limits.maxRuns) {
      const boundRunIds = new Set(this.state.currentRunByConsumer.values());
      const activeCoordRunIds = new Set(
        [...this.state.coordinatorRuns.values()]
          .filter((cr) => cr.status === 'running' || cr.status === 'paused')
          .map((cr) => cr.runId)
      );
      const activeDispatchRunIds = new Set(
        [...this.state.dispatches.values()]
          .filter((d) => ACTIVE_DISPATCH_STATUSES.has(d.status))
          .map((d) => d.runId)
      );

      const candidates = nonUnboundRuns
        .filter(
          (r) =>
            (r.status === 'completed' || r.status === 'failed' || r.status === 'stopped') &&
            !this.protectedRunReason(r.id) &&
            !boundRunIds.has(r.id) &&
            !activeCoordRunIds.has(r.id) &&
            !activeDispatchRunIds.has(r.id)
        )
        .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));

      const deleteCount = Math.min(candidates.length, nonUnboundRuns.length - this.limits.maxRuns);
      if (deleteCount > 0) {
        const deletedRunIds = new Set(candidates.slice(0, deleteCount).map((r) => r.id));
        this.deleteRuns(deletedRunIds);
      }
    }
  }

  private deleteRuns(deletedRunIds: Set<string>): void {
    for (const [key, runId] of this.state.currentRunByConsumer) {
      if (deletedRunIds.has(runId)) this.state.currentRunByConsumer.delete(key);
    }
    for (const runId of deletedRunIds) {
      this.state.runs.delete(runId);
      this.state.nextBoardSeqByRun.delete(runId);
      this.state.memberCursorsByRun.delete(runId);
    }
    for (const [id, t] of this.state.tasks.entries()) {
      if (deletedRunIds.has(t.runId)) this.state.tasks.delete(id);
    }
    for (const [id, d] of this.state.dispatches.entries()) {
      if (deletedRunIds.has(d.runId)) {
        this.lifecycle.cleanupDispatchBrief(id);
        this.lifecycle.dropResumeClaimsForWorker(d.assigneeHandle);
        this.state.dispatches.delete(id);
        this.state.dispatchCapabilities.delete(id);
      }
    }
    for (const [id, g] of this.state.gates.entries()) {
      if (deletedRunIds.has(g.runId)) this.state.gates.delete(id);
    }
    for (const [id, q] of this.state.questions.entries()) {
      if (deletedRunIds.has(q.runId)) this.state.questions.delete(id);
    }
    for (const [id, handoff] of this.state.workerHandoffs.entries()) {
      if (deletedRunIds.has(handoff.runId)) this.state.workerHandoffs.delete(id);
    }
    this.state.cleanupOutbox = this.state.cleanupOutbox.filter(e => !deletedRunIds.has(e.runId));
    this.state.observationFacts = this.state.observationFacts.filter((fact) => !deletedRunIds.has(fact.runId));
    for (const [id, d] of this.state.deliveries.entries()) {
      if (deletedRunIds.has(d.runId)) this.state.deliveries.delete(id);
    }
    for (const [id, cr] of this.state.coordinatorRuns.entries()) {
      if (deletedRunIds.has(cr.runId)) this.state.coordinatorRuns.delete(id);
    }
    const runMsgIds = new Set<string>();
    for (const [id, m] of this.state.messages.entries()) {
      if (deletedRunIds.has(m.runId)) runMsgIds.add(id);
    }
    if (runMsgIds.size > 0) {
      this.deleteMessageIds(runMsgIds);
    }
  }

  clearFinishedHistory(discardRunId?: string): ReturnType<OrchestrationSecurityStore['reset']> {
    const ids = new Set<string>();
    const retained: Array<{ id: string; reason: string }> = [];
    for (const run of this.state.runs.values()) {
      if (run.id === UNBOUND_RUN_ID || (discardRunId && run.id !== discardRunId)) continue;
      const live = this.lifecycle.listDispatches({ runId: run.id }).some(d => ACTIVE_DISPATCH_STATUSES.has(d.status));
      const reason = live || run.status === 'active' ? '协作仍在进行' : this.protectedRunReason(run.id);
      if (reason && (!discardRunId || live || run.status === 'active')) retained.push({ id: run.id, reason });
      else ids.add(run.id);
    }
    const count = (items: Iterable<{ runId: string }>) => [...items].filter(item => ids.has(item.runId)).length;
    const removed = { runs: ids.size, tasks: count(this.state.tasks.values()), dispatches: count(this.state.dispatches.values()),
      gates: count(this.state.gates.values()), messages: count(this.state.messages.values()) };
    this.deleteRuns(ids);
    this.persist();
    return { reset: 'all', removed, retained };
  }

  reset(scope: 'all' | 'tasks' | 'messages'): {
    reset: 'all' | 'tasks' | 'messages';
    retained?: Array<{ id: string; reason: string }>;
    removed: {
      runs: number;
      tasks: number;
      dispatches: number;
      gates: number;
      messages: number;
    };
  } {
    const removed = {
      runs: 0,
      tasks: 0,
      dispatches: 0,
      gates: 0,
      messages: 0,
    };

    if (scope !== 'messages') {
      this.state.cleanupOutbox = scope === 'all' ? [] : this.state.cleanupOutbox.filter(e => !e.dispatchId);
      for (const id of this.state.dispatches.keys()) this.lifecycle.cleanupDispatchBrief(id);
    }
    if (scope === 'all') {
      removed.runs = [...this.state.runs.keys()].filter((id) => id !== UNBOUND_RUN_ID).length;
      removed.tasks = this.state.tasks.size;
      removed.dispatches = this.state.dispatches.size;
      removed.gates = this.state.gates.size;
      removed.messages = this.state.messages.size;
      this.state.currentRunByConsumer.clear();
      this.state.runs.clear();
      this.state.tasks.clear();
      this.state.dispatches.clear();
      this.state.dispatchCapabilities.clear();
      this.state.deferredPrompts.clear();
      this.state.gates.clear();
      this.state.boardReadersByMessageId.clear();
      this.state.messages.clear();
      this.state.messageOrder = [];
      this.state.deliveries.clear();
      this.state.consumerReadByMessageId.clear();
      this.state.consumerDeliveredByMessageId.clear();
      this.state.questions.clear();
      this.state.coordinatorRuns.clear();
      this.state.nextSequence = 1;
      this.state.nextBoardSeqByRun.clear();
      this.state.memberCursorsByRun.clear();
      this.state.resumeClaims.clear();
      this.state.workerHandoffs.clear();
      this.state.observationFacts = [];
    } else if (scope === 'tasks') {
      removed.tasks = this.state.tasks.size;
      removed.dispatches = this.state.dispatches.size;
      removed.gates = this.state.gates.size;
      this.state.tasks.clear();
      this.state.dispatches.clear();
      this.state.dispatchCapabilities.clear();
      this.state.deferredPrompts.clear();
      this.state.gates.clear();
      this.state.questions.clear();
      this.state.coordinatorRuns.clear();
      this.state.resumeClaims.clear();
      this.state.workerHandoffs.clear();
      this.state.observationFacts = [];
    } else {
      removed.messages = this.state.messages.size;
      this.state.boardReadersByMessageId.clear();
      this.state.messages.clear();
      this.state.messageOrder = [];
      this.state.deliveries.clear();
      this.state.consumerReadByMessageId.clear();
      this.state.consumerDeliveredByMessageId.clear();
      this.state.questions.clear();
      this.state.nextBoardSeqByRun.clear();
      this.state.memberCursorsByRun.clear();
    }

    if (scope !== 'messages') this.lifecycle.reconcileBriefFiles();
    this.persist();
    return { reset: scope, removed };
  }
}
