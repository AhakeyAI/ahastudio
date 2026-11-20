import type { AgentPaneStatus, AgentStatusStore } from '../agent/agent-status-store.js';
import type { RuntimeMessageWaiters } from './mailbox-waiters.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import type { OrchestrationStore } from './orchestration-store.js';
import type {
  OrchestrationDispatchRecord,
  OrchestrationMessageType,
  WorkerTurnStopReason,
} from './orchestration-types.js';
import { redactDispatchCapability } from './worker-dispatch-preamble.js';

export const DEFAULT_TURN_STOP_SETTLE_MS = 400;
const MAX_TAIL_CHARS = 2_000;

export interface WorkerTurnStopMonitorDependencies {
  store: OrchestrationStore;
  agentStatusStore: AgentStatusStore;
  waiters: RuntimeMessageWaiters;
  isPaneAlive: (ptyId: string) => boolean;
  hasPaneExited: (ptyId: string) => boolean;
  capturePaneTail?: (ptyId: string, maxChars: number) => string;
  hasOpenApprovalForDispatch?: (dispatchId: string) => boolean;
  isDeliveryInFlight?: (dispatchId: string) => boolean;
  resolveRoleName?: (dispatch: OrchestrationDispatchRecord) => string | null;
  notifyMailbox: (mailboxHandle: string, type: OrchestrationMessageType) => void;
  onTurnStopEscalated?: (dispatchId: string, runId: string, stopReason: WorkerTurnStopReason) => void;
  cliCommand?: string;
  settleMs?: number;
}

export class WorkerTurnStopMonitor {
  private readonly settleMs: number;
  private readonly cliCommand: string;
  private readonly timersByPty = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingExitByPty = new Set<string>();
  private readonly pendingExitDispatchesByPty = new Map<string, Set<string>>();
  private readonly unsubscribeStatus: () => void;
  private disposed = false;

  constructor(private readonly deps: WorkerTurnStopMonitorDependencies) {
    this.settleMs = Math.max(0, Math.floor(deps.settleMs ?? DEFAULT_TURN_STOP_SETTLE_MS));
    this.cliCommand = deps.cliCommand ?? 'aha';

    this.unsubscribeStatus = deps.agentStatusStore.onChange((status) => {
      this.handleStatusChange(status);
    });
  }

  notifyPaneExited(ptyId: string): void {
    if (this.disposed) return;
    const engaged = this.deps.store
      .getActiveDispatchesForPane(ptyId)
      .filter(
        (d) => (Boolean(d.promptSentAt) || Boolean(d.ownsPane)) && !this.deps.isDeliveryInFlight?.(d.id)
      );
    if (engaged.length === 0) {
      return;
    }
    let tracked = this.pendingExitDispatchesByPty.get(ptyId);
    if (!tracked) {
      tracked = new Set<string>();
      this.pendingExitDispatchesByPty.set(ptyId, tracked);
    }
    for (const d of engaged) {
      tracked.add(d.id);
    }
    this.pendingExitByPty.add(ptyId);
    this.scheduleCheck(ptyId);
  }

  cancelForPane(ptyId: string): void {
    const timer = this.timersByPty.get(ptyId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timersByPty.delete(ptyId);
    }
    this.pendingExitByPty.delete(ptyId);
    this.pendingExitDispatchesByPty.delete(ptyId);
  }

  dispose(): void {
    this.disposed = true;
    this.unsubscribeStatus();
    for (const timer of this.timersByPty.values()) {
      clearTimeout(timer);
    }
    this.timersByPty.clear();
    this.pendingExitByPty.clear();
    this.pendingExitDispatchesByPty.clear();
  }

  private handleStatusChange(status: AgentPaneStatus): void {
    if (this.disposed) return;
    const ptyId = status.ptyId;
    if (status.state === 'working') {
      this.cancelForPane(ptyId);
      for (const active of this.deps.store.getActiveDispatchesForPane(ptyId)) {
        if (active.turnStopReportedGeneration === (active.processGeneration ?? 1)) {
          this.deps.store.bumpDispatchGenerationForSteering(active.id);
        }
      }
      return;
    }

    if (status.state !== 'done' && status.state !== 'error' && status.state !== 'waiting') {
      return;
    }

    if (this.deps.store.getActiveDispatchesForPane(ptyId).length === 0) {
      return;
    }

    this.scheduleCheck(ptyId);
  }

  private scheduleCheck(ptyId: string): void {
    const existing = this.timersByPty.get(ptyId);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.timersByPty.delete(ptyId);
      this.evaluatePane(ptyId);
    }, this.settleMs);
    timer.unref?.();
    this.timersByPty.set(ptyId, timer);
  }

  private evaluatePane(ptyId: string): void {
    if (this.disposed) return;
    const hasExited =
      this.pendingExitByPty.delete(ptyId) ||
      this.deps.hasPaneExited(ptyId) ||
      !this.deps.isPaneAlive(ptyId);
    const status = this.deps.agentStatusStore.get(ptyId);

    if (!hasExited) {
      if (!status) return;
      if (status.state === 'working') return;
      if (status.subagents.some((sub) => sub.state === 'working')) return;
      if (status.state !== 'done' && status.state !== 'error' && status.state !== 'waiting') {
        return;
      }
    }

    const capturedExitIds = this.pendingExitDispatchesByPty.get(ptyId);
    this.pendingExitDispatchesByPty.delete(ptyId);

    const candidateById = new Map<string, OrchestrationDispatchRecord>();
    for (const dispatch of this.deps.store.getActiveDispatchesForPane(ptyId)) {
      candidateById.set(dispatch.id, dispatch);
    }
    if (hasExited && capturedExitIds) {
      for (const id of capturedExitIds) {
        if (!candidateById.has(id)) {
          const ctx = this.deps.store.getDispatchContext(id);
          if (ctx) candidateById.set(id, ctx);
        }
      }
    }

    for (const dispatch of candidateById.values()) {
      this.evaluateDispatch(dispatch, ptyId, status, hasExited);
    }
  }

  private evaluateDispatch(
    dispatch: OrchestrationDispatchRecord,
    ptyId: string,
    status: AgentPaneStatus | null,
    hasExited: boolean
  ): void {
    const fresh = this.deps.store.getDispatchContext(dispatch.id);
    if (!fresh) {
      return;
    }
    if (!fresh.promptSentAt && !fresh.ownsPane) {
      return;
    }
    if (this.deps.isDeliveryInFlight?.(fresh.id)) {
      return;
    }
    const isActive = ACTIVE_DISPATCH_STATUSES.has(fresh.status);
    const reconciledExitDuringSettle =
      hasExited &&
      fresh.status === 'failed' &&
      Boolean(fresh.lastFailureReason?.includes('exited before worker_done'));
    if (!isActive && !reconciledExitDuringSettle) {
      return;
    }

    const generation = fresh.processGeneration ?? 1;
    if (!hasExited && fresh.turnStopReportedGeneration === generation) {
      return;
    }

    if (!hasExited && !fresh.turnStartedAt && status?.state !== 'error' && status?.state !== 'waiting') {
      // Never synthesize a completion escalation before the worker has even started a turn.
      return;
    }

    // Suppress when held permission approval already owns this wait state.
    if (
      !hasExited &&
      status?.state === 'waiting' &&
      this.deps.hasOpenApprovalForDispatch?.(fresh.id)
    ) {
      return;
    }

    if (!hasExited && this.isDeliberatelyWaiting(fresh, ptyId)) {
      return;
    }

    let stopReason: WorkerTurnStopReason;
    if (hasExited) {
      stopReason = 'exited';
    } else if (status?.state === 'error') {
      stopReason = 'errored';
    } else if (status?.state === 'waiting') {
      stopReason = 'needs-input';
    } else {
      stopReason = 'finished';
    }

    const deterministicMsgId = hasExited
      ? `msg_stop_${fresh.id}_exited`
      : `msg_stop_${fresh.id}_g${generation}`;
    if (this.deps.store.getMessageById(deterministicMsgId)) {
      this.deps.store.markTurnStopReported(fresh.id, generation, stopReason);
      return;
    }

    const rawTail = this.deps.capturePaneTail?.(ptyId, MAX_TAIL_CHARS) ?? '';
    const capability = this.deps.store.getDispatchCapability(fresh.id);
    const tail = redactDispatchCapability(rawTail, capability).trim();

    const parentMailbox = this.resolveParentMailbox(fresh);
    this.deps.store.markTurnStopReported(fresh.id, generation, stopReason);
    if (hasExited) {
      try {
        this.deps.store.failDispatch(
          fresh.id,
          `Worker pane ${ptyId} exited before worker_done`
        );
      } catch {
        // Ignore if settled concurrently.
      }
    }

    const roleName =
      this.deps.resolveRoleName?.(fresh)?.trim().replace(/^@+/, '') || null;
    const subject = this.buildSubject(fresh, stopReason, roleName);
    const body = this.buildBody(fresh, ptyId, stopReason, status, tail, roleName);
    const payload = JSON.stringify({
      syntheticTurnStop: true,
      advisory: stopReason !== 'exited',
      stopReason,
      dispatchId: fresh.id,
      taskId: fresh.taskId,
      runId: fresh.runId,
      processGeneration: generation,
      workerHandle: fresh.assigneeHandle,
      ...(roleName ? { role: roleName } : {}),
      ptyId,
      ...(tail ? { terminalTail: tail } : {}),
    });

    this.deps.store.insertMessage({
      id: deterministicMsgId,
      runId: fresh.runId,
      from: `dispatch:${fresh.id}`,
      to: parentMailbox,
      type: 'escalation',
      priority: stopReason === 'errored' || stopReason === 'exited' ? 'high' : 'normal',
      subject,
      body,
      payload,
      fromRole: roleName ?? undefined,
      mentions: ['coordinator'],
      kind: 'stall',
    });

    this.deps.notifyMailbox(parentMailbox, 'escalation');
    this.deps.onTurnStopEscalated?.(fresh.id, fresh.runId, stopReason);
  }

  private isDeliberatelyWaiting(dispatch: OrchestrationDispatchRecord, ptyId: string): boolean {
    const dispatchMailbox = `dispatch:${dispatch.id}`;
    if (
      this.deps.waiters.hasActiveWaiterFor(dispatchMailbox) ||
      this.deps.waiters.hasActiveWaiterFor(ptyId) ||
      this.deps.waiters.hasActiveWaiterFor(dispatch.assigneeHandle)
    ) {
      return true;
    }

    const pendingQuestions = this.deps.store.listQuestions({
      dispatchId: dispatch.id,
      status: 'pending',
    });
    if (pendingQuestions.length > 0) {
      return true;
    }

    if (this.deps.store.hasActiveChildDispatches(dispatch.id)) {
      return true;
    }

    return false;
  }

  private resolveParentMailbox(dispatch: OrchestrationDispatchRecord): string {
    if (dispatch.creatorDispatchId) {
      const parent =
        this.deps.store.resolveDispatchLineage(dispatch.creatorDispatchId) ??
        this.deps.store.getDispatchContext(dispatch.creatorDispatchId);
      if (parent && ACTIVE_DISPATCH_STATUSES.has(parent.status)) {
        return `dispatch:${parent.id}`;
      }
    }
    return `run:${dispatch.runId}`;
  }

  private buildSubject(
    dispatch: OrchestrationDispatchRecord,
    stopReason: WorkerTurnStopReason,
    roleName: string | null = null
  ): string {
    const label = roleName ? `@${roleName} (${dispatch.id})` : `${dispatch.taskId} (${dispatch.id})`;
    switch (stopReason) {
      case 'errored':
        return `Worker turn errored on ${label}`;
      case 'needs-input':
        return `Worker waiting for input on ${label}`;
      case 'exited':
        return `Worker terminal exited without reporting on ${label}`;
      case 'finished':
      default:
        return `Worker turn stopped without task-done on ${label}`;
    }
  }

  private buildBody(
    dispatch: OrchestrationDispatchRecord,
    _ptyId: string,
    stopReason: WorkerTurnStopReason,
    status: AgentPaneStatus | null,
    tail: string,
    roleName: string | null = null
  ): string {
    const workerTag = roleName
      ? `@${roleName} (${dispatch.assigneeHandle}, dispatch ${dispatch.id}, generation ${dispatch.processGeneration ?? 1})`
      : `${dispatch.assigneeHandle} (dispatch ${dispatch.id}, generation ${dispatch.processGeneration ?? 1})`;
    const lines: string[] = [
      `Worker ${workerTag} stopped (${stopReason}) without calling task-done/worker-done.`,
    ];
    if (status?.message) {
      lines.push(`Last status: ${status.message}`);
    }
    if (tail) {
      lines.push('', '--- Terminal Screen Tail ---', tail, '--- End Terminal Tail ---');
    }
    lines.push(
      '',
      'Coordinator actions:',
      ...(roleName
        ? [
            `- MCP: manage_worker(role="${roleName}", action="read") or post_message(text="@${roleName} ...")`,
          ]
        : []),
      `- Read output: ${this.cliCommand} orchestration worker-read --dispatch ${dispatch.id} --screen`,
      `- Steer / follow up: ${this.cliCommand} orchestration send --to dispatch:${dispatch.id} --subject "Follow-up" --body "..."`,
      `- Mark task done: ${this.cliCommand} orchestration task-update --id ${dispatch.taskId} --status completed`
    );
    return lines.join('\n');
  }
}
