import { randomUUID } from 'node:crypto';
import {
  OrchestrationError,
  type OrchestrationDispatchProposal,
  type OrchestrationTaskContext,
  type OrchestrationTaskKind,
} from './orchestration-types.js';
import { cloneTaskContext, mergeTaskContext } from './worker-brief-context.js';
import { normalizeWorkerCliId } from './worker-launch-catalog.js';

export const DEFAULT_PROPOSAL_HOLD_TIMEOUT_MS = 120_000;
export const DEFAULT_PROPOSAL_TTL_MS = 10 * 60_000;

/** `session`: a message the person sent from an Agent session's input box started a turn. */
export type UserTurnSource = 'hook' | 'pty' | 'session';

export interface DispatchProposalOverrides {
  agent?: string;
  worktree?: boolean;
  model?: string | null;
  effort?: string | null;
  authorizeReviews?: boolean;
}

export interface CreateHeldProposalInput {
  coordinatorPaneId: string;
  runId: string | null;
  role: string;
  task: string;
  deps?: string[];
  codeDeps?: string[];
  baseBranch?: string;
  taskContext?: OrchestrationTaskContext | null;
  planSummary: string;
  requestedAgent: string;
  resolvedAgent: string;
  taskKind: OrchestrationTaskKind | null;
  worktree: boolean;
  model: string | null;
  effort: string | null;
  terminal: string | null;
  authorizeReviews?: boolean;
}

export interface HeldProposalResolution {
  decision: 'approved' | 'rejected' | 'expired';
  proposal: OrchestrationDispatchProposal;
  overrides?: DispatchProposalOverrides;
  reason?: string;
}

export type ChatGuardEvaluation =
  | { allowed: true; proposal: OrchestrationDispatchProposal; taskContext: OrchestrationTaskContext | null }
  | { allowed: false; proposal: OrchestrationDispatchProposal; changed: boolean };

export interface DispatchProposalManagerOptions {
  onChanged?: (reason: string, runId?: string) => void;
  holdTimeoutMs?: number;
  proposalTtlMs?: number;
  now?: () => number;
}

interface PaneTurnState {
  userTurn: number;
  lastTurnAt: number;
  chatProposals: Map<string, ChatProposal>;
}

interface ChatProposal {
  proposal: OrchestrationDispatchProposal;
  turn: number;
  createdAt: number;
}

interface HeldProposalEntry {
  proposal: OrchestrationDispatchProposal;
  resolve: (resolution: HeldProposalResolution) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanupSignal?: () => void;
}

function generateProposalId(): string {
  return `prop_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export class DispatchProposalManager {
  private readonly paneStates = new Map<string, PaneTurnState>();
  private readonly openById = new Map<string, HeldProposalEntry>();
  private readonly historyById = new Map<string, OrchestrationDispatchProposal>();
  private readonly onChanged?: (reason: string, runId?: string) => void;
  private readonly holdTimeoutMs: number;
  private readonly proposalTtlMs: number;
  private readonly clock: () => number;

  constructor(options: DispatchProposalManagerOptions = {}) {
    this.onChanged = options.onChanged;
    this.holdTimeoutMs = Math.max(
      200,
      Math.floor(options.holdTimeoutMs ?? DEFAULT_PROPOSAL_HOLD_TIMEOUT_MS)
    );
    this.proposalTtlMs = Math.max(
      1_000,
      Math.floor(options.proposalTtlMs ?? DEFAULT_PROPOSAL_TTL_MS)
    );
    this.clock = options.now ?? (() => Date.now());
  }

  private getOrCreatePaneState(ptyId: string): PaneTurnState {
    let state = this.paneStates.get(ptyId);
    if (!state) {
      state = {
        userTurn: 0,
        lastTurnAt: Number.NEGATIVE_INFINITY,
        chatProposals: new Map(),
      };
      this.paneStates.set(ptyId, state);
    }
    return state;
  }

  getUserTurn(ptyId: string): number {
    return this.paneStates.get(ptyId)?.userTurn ?? 0;
  }

  hasPendingChatProposalForCurrentTurn(ptyId: string): boolean {
    const state = this.paneStates.get(ptyId.trim());
    return Boolean(state && [...state.chatProposals.values()].some((entry) => (
      entry.turn === state.userTurn && this.clock() - entry.createdAt <= this.proposalTtlMs
    )));
  }

  /**
   * Advance the user-turn counter for a pane. Only Enter typed in the renderer ('pty') or a
   * person's message that started an Agent session turn ('session') counts: prompt-submit hooks
   * also fire for text AhaStation itself types into the terminal (mailbox pointers, stall nudges,
   * `aha terminal send`), so a hook alone never proves a person answered.
   */
  recordUserTurn(ptyId: string, source: UserTurnSource = 'hook'): number {
    const cleanId = ptyId.trim();
    if (!cleanId) return 0;
    const state = this.getOrCreatePaneState(cleanId);
    if (source !== 'pty' && source !== 'session') return state.userTurn;

    state.userTurn += 1;
    for (const [id, entry] of state.chatProposals) {
      if (entry.turn < state.userTurn - 1) state.chatProposals.delete(id);
    }
    state.lastTurnAt = this.clock();
    return state.userTurn;
  }

  evaluateChatGuard(
    input: CreateHeldProposalInput,
    confirmed: boolean,
    proposalId?: string,
    explicitRunId?: string,
  ): ChatGuardEvaluation {
    const state = this.getOrCreatePaneState(input.coordinatorPaneId);
    const now = this.clock();
    for (const [id, entry] of state.chatProposals) {
      if (now - entry.createdAt > this.proposalTtlMs) state.chatProposals.delete(id);
    }
    const sameRole = (proposal: OrchestrationDispatchProposal) => (
      proposal.role.toLowerCase() === input.role.toLowerCase()
    );
    const eligible = [...state.chatProposals.values()].filter((entry) => entry.turn === state.userTurn - 1);
    const match = proposalId
      ? eligible.find((entry) => entry.proposal.id === proposalId)
      : eligible.find((entry) => sameRole(entry.proposal) && entry.proposal.task === input.task);
    const prior = match?.proposal;
    const merged = mergeTaskContext(prior?.taskContext, input.taskContext);
    const samePlan = prior && sameRole(prior) && prior.task === input.task &&
      (!explicitRunId || explicitRunId === prior.runId) &&
      prior.resolvedAgent === input.resolvedAgent &&
      prior.taskKind === input.taskKind &&
      prior.worktree === input.worktree &&
      prior.model === input.model &&
      prior.effort === input.effort &&
      prior.terminal === input.terminal &&
      prior.baseBranch === input.baseBranch &&
      JSON.stringify(prior.deps ?? []) === JSON.stringify(input.deps ?? []) &&
      JSON.stringify(prior.codeDeps ?? []) === JSON.stringify(input.codeDeps ?? []) &&
      Boolean(prior.authorizeReviews) === Boolean(input.authorizeReviews) &&
      JSON.stringify(cloneTaskContext(prior.taskContext)) === JSON.stringify(merged);
    if (confirmed && prior && samePlan && state.lastTurnAt >= match.createdAt) {
      state.chatProposals.delete(prior.id);
      return { allowed: true, proposal: prior, taskContext: merged };
    }

    const proposal: OrchestrationDispatchProposal = {
      ...input,
      taskContext: confirmed && prior ? merged : cloneTaskContext(input.taskContext),
      id: generateProposalId(),
      status: 'pending',
      createdAt: new Date(now).toISOString(),
      resolvedAt: null,
      reason: null,
    };
    for (const [id, entry] of state.chatProposals) {
      if (entry.turn === state.userTurn && sameRole(entry.proposal) && entry.proposal.task === input.task) {
        state.chatProposals.delete(id);
      }
    }
    state.chatProposals.set(proposal.id, { proposal, turn: state.userTurn, createdAt: now });
    return { allowed: false, proposal, changed: confirmed && Boolean(prior || proposalId || eligible.some((entry) => sameRole(entry.proposal))) };
  }

  listPendingProposals(filter?: {
    runId?: string;
    coordinatorPaneId?: string;
  }): OrchestrationDispatchProposal[] {
    return [...this.openById.values()]
      .map((entry) => ({ ...entry.proposal }))
      .filter((proposal) => {
        if (filter?.runId && proposal.runId !== filter.runId) return false;
        if (filter?.coordinatorPaneId && proposal.coordinatorPaneId !== filter.coordinatorPaneId) {
          return false;
        }
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getProposal(id: string): OrchestrationDispatchProposal | undefined {
    const entry = this.openById.get(id)?.proposal ?? this.historyById.get(id);
    return entry ? { ...entry } : undefined;
  }

  async createHeldProposal(
    input: CreateHeldProposalInput,
    signal?: AbortSignal
  ): Promise<HeldProposalResolution> {
    const id = generateProposalId();
    const nowIso = new Date(this.clock()).toISOString();
    const normalizedContext = cloneTaskContext(input.taskContext);
    const proposal: OrchestrationDispatchProposal = {
      id,
      coordinatorPaneId: input.coordinatorPaneId,
      runId: input.runId,
      role: input.role,
      task: input.task,
      deps: input.deps,
      codeDeps: input.codeDeps,
      baseBranch: input.baseBranch,
      ...(normalizedContext ? { taskContext: normalizedContext } : {}),
      planSummary: input.planSummary,
      requestedAgent: input.requestedAgent,
      resolvedAgent: input.resolvedAgent,
      taskKind: input.taskKind,
      worktree: input.worktree,
      model: input.model,
      effort: input.effort,
      terminal: input.terminal,
      ...(typeof input.authorizeReviews === 'boolean'
        ? { authorizeReviews: input.authorizeReviews }
        : {}),
      status: 'pending',
      createdAt: nowIso,
      resolvedAt: null,
      reason: null,
    };

    if (signal?.aborted) {
      const expired: OrchestrationDispatchProposal = {
        ...proposal,
        status: 'expired',
        resolvedAt: nowIso,
        reason: 'Request aborted',
      };
      this.historyById.set(id, expired);
      return { decision: 'expired', proposal: { ...expired }, reason: 'Request aborted' };
    }

    const promise = new Promise<HeldProposalResolution>((resolve) => {
      const timer = setTimeout(() => {
        this.expireProposal(id, 'Dispatch confirmation timed out');
      }, this.holdTimeoutMs);
      timer.unref?.();

      const onAbort = () => {
        this.expireProposal(id, 'Caller connection closed before dispatch confirmation');
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const entry: HeldProposalEntry = {
        proposal,
        resolve,
        timer,
        cleanupSignal: signal ? () => signal.removeEventListener('abort', onAbort) : undefined,
      };
      this.openById.set(id, entry);
      this.historyById.set(id, { ...proposal });
    });

    this.onChanged?.('proposal:created', proposal.runId ?? undefined);
    return promise;
  }

  approveProposal(
    id: string,
    overrides?: DispatchProposalOverrides
  ): { proposal: OrchestrationDispatchProposal } {
    const cleanId = id.trim();
    const entry = this.requireOpenEntry(cleanId);
    this.removeOpenEntry(entry);

    const nowIso = new Date(this.clock()).toISOString();
    entry.proposal.status = 'approved';
    entry.proposal.resolvedAt = nowIso;
    if (overrides?.agent?.trim()) {
      entry.proposal.resolvedAgent = normalizeWorkerCliId(overrides.agent);
    }
    if (typeof overrides?.worktree === 'boolean') {
      entry.proposal.worktree = overrides.worktree;
    }
    if (overrides?.model !== undefined) {
      entry.proposal.model = overrides.model?.trim() || null;
    }
    if (overrides?.effort !== undefined) {
      entry.proposal.effort = overrides.effort?.trim() || null;
    }
    if (typeof overrides?.authorizeReviews === 'boolean') {
      entry.proposal.authorizeReviews = overrides.authorizeReviews;
    }

    const snapshot = { ...entry.proposal };
    this.historyById.set(cleanId, snapshot);
    entry.resolve({
      decision: 'approved',
      proposal: { ...snapshot },
      ...(overrides ? { overrides } : {}),
    });
    this.onChanged?.('proposal:approved', snapshot.runId ?? undefined);
    return { proposal: { ...snapshot } };
  }

  rejectProposal(
    id: string,
    reason?: string
  ): { proposal: OrchestrationDispatchProposal } {
    const cleanId = id.trim();
    const entry = this.requireOpenEntry(cleanId);
    this.removeOpenEntry(entry);

    const nowIso = new Date(this.clock()).toISOString();
    const cleanReason = reason?.trim() || 'Rejected by user';
    entry.proposal.status = 'rejected';
    entry.proposal.resolvedAt = nowIso;
    entry.proposal.reason = cleanReason;

    const snapshot = { ...entry.proposal };
    this.historyById.set(cleanId, snapshot);
    entry.resolve({
      decision: 'rejected',
      proposal: { ...snapshot },
      reason: cleanReason,
    });
    this.onChanged?.('proposal:rejected', snapshot.runId ?? undefined);
    return { proposal: { ...snapshot } };
  }

  cancelForPane(ptyId: string, reason = 'Terminal exited'): number {
    this.paneStates.delete(ptyId);
    let count = 0;
    for (const entry of [...this.openById.values()]) {
      if (entry.proposal.coordinatorPaneId !== ptyId) continue;
      this.expireProposal(entry.proposal.id, reason);
      count += 1;
    }
    return count;
  }

  cancelAllPendingProposals(reason = 'Orchestration state reset'): number {
    for (const state of this.paneStates.values()) state.chatProposals.clear();
    let count = 0;
    for (const entry of [...this.openById.values()]) {
      this.expireProposal(entry.proposal.id, reason);
      count += 1;
    }
    return count;
  }

  dispose(): void {
    this.cancelAllPendingProposals('Application stopped');
    this.openById.clear();
    this.paneStates.clear();
  }

  private requireOpenEntry(id: string): HeldProposalEntry {
    const open = this.openById.get(id);
    if (open) return open;
    const historical = this.historyById.get(id);
    if (historical && historical.status !== 'pending') {
      throw new OrchestrationError(
        'proposal_already_resolved',
        `Dispatch proposal ${id} is already ${historical.status}.`,
        { proposalId: id, status: historical.status }
      );
    }
    throw new OrchestrationError('proposal_not_found', `Dispatch proposal not found: ${id}`);
  }

  private expireProposal(id: string, reason: string): void {
    const entry = this.openById.get(id);
    if (!entry) return;
    this.removeOpenEntry(entry);
    entry.proposal.status = 'expired';
    entry.proposal.resolvedAt = new Date(this.clock()).toISOString();
    entry.proposal.reason = reason;
    const snapshot = { ...entry.proposal };
    this.historyById.set(id, snapshot);
    entry.resolve({
      decision: 'expired',
      proposal: { ...snapshot },
      reason,
    });
    this.onChanged?.('proposal:expired', snapshot.runId ?? undefined);
  }

  private removeOpenEntry(entry: HeldProposalEntry): void {
    clearTimeout(entry.timer);
    entry.cleanupSignal?.();
    this.openById.delete(entry.proposal.id);
  }
}
