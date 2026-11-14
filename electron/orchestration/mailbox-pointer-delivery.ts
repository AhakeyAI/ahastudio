import {
  deliverPromptToPty,
  type PtyWriteFn,
} from '../agent/agent-prompt-delivery.js';
import type { AgentPaneStatus, AgentStatusStore } from '../agent/agent-status-store.js';
import { formatMessagePointer } from './orchestration-messaging.js';
import type { RuntimeMessageWaiters } from './mailbox-waiters.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import { isBroadcastMailbox, type OrchestrationStore } from './orchestration-store.js';
import type { OrchestrationMessageRecord } from './orchestration-types.js';
import { ORCHESTRATION_DELIVERY_BATCH_LIMIT } from './orchestration-types.js';

export interface MailboxPointerDeliveryDependencies {
  store: OrchestrationStore;
  waiters: RuntimeMessageWaiters;
  agentStatusStore: AgentStatusStore;
  writePty: PtyWriteFn;
  isPaneAlive?: (ptyId: string) => boolean;
  cliCommand?: string;
  debounceMs?: number;
  settleDelayMs?: number;
}

interface PaneDeliveryState {
  inFlight: boolean;
  deferredUntilIdle: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export class MailboxPointerDelivery {
  private readonly paneStates = new Map<string, PaneDeliveryState>();
  private readonly debounceMs: number;
  private readonly settleDelayMs: number;
  private readonly cliCommand: string;
  private readonly disposeStatusListener: () => void;
  private disposed = false;

  constructor(private readonly deps: MailboxPointerDeliveryDependencies) {
    this.debounceMs = deps.debounceMs ?? 50;
    this.settleDelayMs = deps.settleDelayMs ?? 120;
    this.cliCommand = deps.cliCommand ?? 'aha';

    this.disposeStatusListener = deps.agentStatusStore.onChange((status) => {
      this.handlePaneStatusChange(status);
    });
  }

  private getOrCreateState(ptyId: string): PaneDeliveryState {
    let state = this.paneStates.get(ptyId);
    if (!state) {
      state = {
        inFlight: false,
        deferredUntilIdle: false,
        timer: null,
      };
      this.paneStates.set(ptyId, state);
    }
    return state;
  }

  private handlePaneStatusChange(paneStatus: AgentPaneStatus): void {
    if (this.disposed) return;

    const state = this.paneStates.get(paneStatus.ptyId);
    if (!this.isPaneAlive(paneStatus.ptyId)) {
      this.retirePane(paneStatus.ptyId);
      return;
    }

    if (paneStatus.state === 'idle' || paneStatus.state === 'done') {
      if (state?.deferredUntilIdle) {
        state.deferredUntilIdle = false;
      }
      this.scheduleRedriveForPane(paneStatus.ptyId);
    } else if (state) {
      // Agent is working or waiting on input prompt; defer pointer notification until settled.
      state.deferredUntilIdle = true;
    }
  }

  retirePane(ptyId: string): void {
    const state = this.paneStates.get(ptyId);
    if (!state) return;
    if (state.timer !== null) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    this.paneStates.delete(ptyId);
  }

  private isCoordinatorPane(ptyId: string): boolean {
    const currentRun = this.deps.store.getCurrentRunForConsumer(ptyId);
    if (
      currentRun &&
      currentRun.status === 'active' &&
      (currentRun.coordinatorPaneId === ptyId || currentRun.coordinatorHandle === ptyId)
    ) {
      return true;
    }
    return this.deps.store
      .listRuns({ status: 'active' })
      .some((run) => run.coordinatorPaneId === ptyId || run.coordinatorHandle === ptyId);
  }

  /**
   * Resolves all mailbox addresses belonging to a pane right now, in ownership order:
   * - coordinator/bound runs (`run:<id>`)
   * - active dispatches (`dispatch:<id>`)
   * - direct pane handle (`<ptyId>`)
   * - broadcast mailboxes (`@workers` for non-coordinator/worker panes, `@all` for all live panes)
   */
  resolveOwnedMailboxesForPane(ptyId: string): Array<{ mailboxHandle: string; runId?: string }> {
    const owned: Array<{ mailboxHandle: string; runId?: string }> = [];
    const seen = new Set<string>();
    const add = (mailboxHandle: string, runId?: string) => {
      if (seen.has(mailboxHandle)) return;
      seen.add(mailboxHandle);
      owned.push(runId !== undefined ? { mailboxHandle, runId } : { mailboxHandle });
    };

    const currentRun = this.deps.store.getCurrentRunForConsumer(ptyId);
    if (
      currentRun &&
      (currentRun.coordinatorPaneId === ptyId ||
        currentRun.coordinatorHandle === ptyId ||
        this.deps.store.getConsumersForRun(currentRun.id).includes(ptyId))
    ) {
      add(`run:${currentRun.id}`, currentRun.id);
    }
    for (const run of this.deps.store.listRuns({ status: 'active' })) {
      if (
        run.coordinatorPaneId === ptyId ||
        run.coordinatorHandle === ptyId ||
        this.deps.store.getConsumersForRun(run.id).includes(ptyId)
      ) {
        add(`run:${run.id}`, run.id);
      }
    }

    let hasActiveDispatch = false;
    const activeDispatch = this.deps.store.getActiveDispatchForIdentity(ptyId, ptyId);
    if (activeDispatch) {
      hasActiveDispatch = true;
      add(`dispatch:${activeDispatch.id}`, activeDispatch.runId);
    }
    for (const d of this.deps.store.listDispatches()) {
      if (
        ACTIVE_DISPATCH_STATUSES.has(d.status) &&
        (d.assigneePaneId === ptyId || d.assigneeHandle === ptyId)
      ) {
        hasActiveDispatch = true;
        add(`dispatch:${d.id}`, d.runId);
      }
    }

    add(ptyId);
    if (hasActiveDispatch) {
      add('@workers');
    }
    add('@all');
    return owned;
  }

  resolvePanesForMailbox(mailboxHandle: string): string[] {
    const panes = new Set<string>();
    const addIfAlive = (candidate: string | null | undefined) => {
      if (candidate && this.isPaneAlive(candidate)) {
        panes.add(candidate);
      }
    };

    if (mailboxHandle === '@workers') {
      for (const d of this.deps.store.listDispatches()) {
        if (!ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
        addIfAlive(d.assigneePaneId ?? d.assigneeHandle);
      }
      return [...panes];
    }

    if (mailboxHandle === '@all') {
      for (const pane of this.deps.agentStatusStore.list()) {
        addIfAlive(pane.ptyId);
      }
      for (const d of this.deps.store.listDispatches()) {
        if (!ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
        addIfAlive(d.assigneePaneId ?? d.assigneeHandle);
      }
      for (const run of this.deps.store.listRuns({ status: 'active' })) {
        addIfAlive(run.coordinatorPaneId);
        addIfAlive(run.coordinatorHandle);
        for (const consumer of this.deps.store.getConsumersForRun(run.id)) {
          addIfAlive(consumer);
        }
      }
      return [...panes];
    }

    if (mailboxHandle.startsWith('run:')) {
      const runId = mailboxHandle.slice('run:'.length);
      const run = this.deps.store.getRun(runId);
      if (!run) return [];
      addIfAlive(run.coordinatorPaneId);
      addIfAlive(run.coordinatorHandle);
      for (const consumer of this.deps.store.getConsumersForRun(runId)) {
        addIfAlive(consumer);
      }
      return [...panes];
    }

    if (mailboxHandle.startsWith('dispatch:')) {
      const dispatchId = mailboxHandle.slice('dispatch:'.length);
      const dispatch = this.deps.store.getDispatchContext(dispatchId);
      if (!dispatch) return [];
      addIfAlive(dispatch.assigneePaneId ?? dispatch.assigneeHandle);
      return [...panes];
    }

    addIfAlive(mailboxHandle);
    return [...panes];
  }

  resolvePaneForMailbox(mailboxHandle: string): string | null {
    return this.resolvePanesForMailbox(mailboxHandle)[0] ?? null;
  }

  private isPaneAlive(ptyId: string): boolean {
    if (this.deps.isPaneAlive) {
      return this.deps.isPaneAlive(ptyId);
    }
    return this.deps.agentStatusStore.get(ptyId) !== null;
  }

  private isPaneSettledForPointer(ptyId: string): boolean {
    if (!this.isPaneAlive(ptyId)) return false;
    const pane = this.deps.agentStatusStore.get(ptyId);
    if (!pane) return false;
    // Notices end with Enter; a plain shell would try to run them as a command.
    if (!pane.agentId) return false;
    return pane.state === 'idle' || pane.state === 'done';
  }

  notifyMessageArrived(mailboxHandle: string): void {
    if (this.disposed) return;
    for (const ptyId of this.resolvePanesForMailbox(mailboxHandle)) {
      this.scheduleRedriveForPane(ptyId);
    }
  }

  scheduleRedriveForPane(ptyId: string): void {
    if (this.disposed) return;
    const state = this.getOrCreateState(ptyId);
    if (state.timer !== null) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(() => {
      state.timer = null;
      void this.flushPane(ptyId);
    }, this.debounceMs);
    state.timer.unref?.();
  }

  private pickEligibleMailbox(
    ptyId: string
  ): { mailboxHandle: string; eligible: OrchestrationMessageRecord[] } | null {
    const ownedMailboxes = this.resolveOwnedMailboxesForPane(ptyId);
    const ownedHandles = new Set(ownedMailboxes.map((o) => o.mailboxHandle));
    for (const owner of ownedMailboxes) {
      if (this.deps.waiters.hasUnfilteredWaiter(owner.mailboxHandle)) {
        continue;
      }
      const isBroadcast = isBroadcastMailbox(owner.mailboxHandle);
      const held = this.deps.store.getOutstandingDelivery(owner.mailboxHandle, ptyId);
      const excludeIds = held?.messageIds ?? [];
      const candidates = this.deps.store
        .getUndeliveredUnreadMessages(owner.mailboxHandle, {
          excludeTypes: ['heartbeat'],
          excludeIds,
          consumerHandle: ptyId,
          limit: ORCHESTRATION_DELIVERY_BATCH_LIMIT,
        })
        .filter((msg) => {
          if (msg.lifecycleRejectedReason !== null) return false;
          if (isBroadcast && (msg.fromHandle === ptyId || ownedHandles.has(msg.fromHandle))) {
            return false;
          }
          if (this.deps.waiters.hasMatchingWaiter(owner.mailboxHandle, msg.type)) {
            return false;
          }
          if (
            (owner.mailboxHandle === '@workers' || owner.mailboxHandle === '@all') &&
            [...ownedHandles].some(
              (h) => !isBroadcastMailbox(h) && this.deps.waiters.hasMatchingWaiter(h, msg.type)
            )
          ) {
            return false;
          }
          return true;
        });
      if (candidates.length > 0) {
        return { mailboxHandle: owner.mailboxHandle, eligible: candidates };
      }
    }
    return null;
  }

  async flushPane(ptyId: string): Promise<boolean> {
    if (this.disposed) return false;
    const state = this.getOrCreateState(ptyId);
    if (state.inFlight) return false;

    if (!this.isPaneSettledForPointer(ptyId)) {
      if (this.isPaneAlive(ptyId)) {
        state.deferredUntilIdle = true;
      }
      return false;
    }

    const picked = this.pickEligibleMailbox(ptyId);
    if (!picked) {
      return false;
    }

    const { mailboxHandle: targetMailbox, eligible } = picked;
    const ids = eligible.map((m) => m.id);
    const held = this.deps.store.getOutstandingDelivery(targetMailbox, ptyId);

    state.inFlight = true;
    this.deps.store.markAsDeliveredForConsumer(ids, ptyId);
    let wroteOk = false;

    try {
      const pointerText = formatMessagePointer(
        eligible.length,
        targetMailbox,
        this.cliCommand,
        held?.id
      );
      const res = await deliverPromptToPty(
        {
          ptyId,
          prompt: pointerText.trim(),
          submit: true,
          settleDelayMs: this.settleDelayMs,
        },
        this.deps.writePty
      );
      if (!res.ok) {
        this.deps.store.markAsUndeliveredForConsumer(ids, ptyId);
        state.deferredUntilIdle = true;
        return false;
      }
      wroteOk = true;
      return true;
    } catch {
      this.deps.store.markAsUndeliveredForConsumer(ids, ptyId);
      state.deferredUntilIdle = true;
      return false;
    } finally {
      state.inFlight = false;
      if (wroteOk && !this.disposed && this.isPaneSettledForPointer(ptyId) && this.pickEligibleMailbox(ptyId)) {
        this.scheduleRedriveForPane(ptyId);
      }
    }
  }

  stop(): void {
    this.dispose();
  }

  dispose(): void {
    this.disposed = true;
    this.disposeStatusListener();
    for (const state of this.paneStates.values()) {
      if (state.timer !== null) {
        clearTimeout(state.timer);
      }
    }
    this.paneStates.clear();
  }
}
