import { driverCapabilities } from '../agent-drivers/driver-capabilities.js';
import type { AgentStatusStore } from '../agent/agent-status-store.js';
import type { TerminalRuntimeTracker } from '../terminal-runtime-tracker.js';
import type { AgentSessionPolicy } from './agent-session-driver.js';
import {
  headlessWorkerControlsError,
  isHeadlessWorkerDriver,
} from './headless-workers.js';
import { OrchestrationBoardService } from './board-service.js';
import { OrchestrationIntegrationService } from './integration-service.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import { OrchestrationStore } from './orchestration-store.js';
import {
  OrchestrationError,
  type OrchestrationConfirmMode,
  type OrchestrationDispatchProposal,
  type OrchestrationDispatchRecord,
  type OrchestrationTaskContext,
  type OrchestrationTaskKind,
  type OrchestrationTaskRecord,
} from './orchestration-types.js';
import { PeerPingPongTracker, parseBoardRefs } from './board-protocol.js';
import { DispatchProposalManager, type DispatchProposalOverrides } from './dispatch-proposals.js';
import { PermissionApprovalManager } from './permission-approvals.js';
import { normalizeTaskContext } from './worker-brief-context.js';
import { normalizeWorkerCliId } from './worker-launch-catalog.js';
import type {
  OrchestrationSendResult,
  OrchestrationAgentSelectionResult,
  OrchestrationDelegateTaskResult,
  OrchestrationSessionCoordinators,
  OrchestrationServiceDependencies,
  OrchestrationService,
} from './orchestration-service.js';

/** Service capabilities the OrchestrationDelegationService relies on; supplied by OrchestrationService. */
export interface OrchestrationDelegationHost {
  readonly agentStatusStore: AgentStatusStore;
  readonly approvals: PermissionApprovalManager;
  readonly approve: OrchestrationService['approve'];
  readonly assertCanDelegateFrom: (callerPaneId: string) => void;
  readonly assertCanReply: OrchestrationService['assertCanReply'];
  readonly assertRunCoordinator: OrchestrationService['assertRunCoordinator'];
  readonly assertWorkerController: OrchestrationService['assertWorkerController'];
  readonly authorizeRunAccess: OrchestrationService['authorizeRunAccess'];
  readonly board: OrchestrationBoardService;
  readonly deny: OrchestrationService['deny'];
  readonly disposed: boolean;
  readonly effectiveConfirmMode: (caller: string) => OrchestrationConfirmMode;
  readonly emitChanged: (reason: string, runId?: string) => void;
  readonly getDefaultCwd: (() => string | undefined) | undefined;
  readonly getDefaultWorktreeDep: (() => boolean) | undefined;
  readonly inferRunIdOptional: (from?: string) => string | undefined;
  readonly integration: OrchestrationIntegrationService;
  readonly isCallerSurface: (id: string) => boolean;
  readonly isMcpEnabledForCliDep: ((cliId: string) => boolean) | undefined;
  readonly isPaneAlive: OrchestrationService['isPaneAlive'];
  readonly isPaneOrchestrationMode: OrchestrationService['isPaneOrchestrationMode'];
  readonly listCodingAgents: OrchestrationService['listCodingAgents'];
  readonly maxDepth: number;
  readonly peerPingPong: PeerPingPongTracker;
  readonly proposals: DispatchProposalManager;
  readonly redactTaskContext: (context: OrchestrationTaskContext | null) => OrchestrationTaskContext | null;
  readonly reply: OrchestrationService['reply'];
  readonly resolveCallerDepth: (callerPaneId: string) => number;
  readonly selectAgentForTaskDep: OrchestrationServiceDependencies['selectAgentForTask'] | undefined;
  readonly send: OrchestrationService['send'];
  readonly sessionCoordinator: (id: string) => ReturnType<OrchestrationSessionCoordinators["get"]>;
  readonly store: OrchestrationStore;
  readonly terminalTracker: TerminalRuntimeTracker | undefined;
  readonly workerRead: OrchestrationService['workerRead'];
  readonly workerRelease: OrchestrationService['workerRelease'];
  readonly workerStart: OrchestrationService['workerStart'];
  readonly workerStop: OrchestrationService['workerStop'];
  readonly handoffWorker: OrchestrationService['handoffWorker'];
}

/** Dispatch proposals, semantic delegate_task, queued launches and role-based Worker routing. */
export class OrchestrationDelegationService {
  constructor(private readonly host: OrchestrationDelegationHost) {}

  private queueSweepScheduled = false;
  readonly claimedLaunches = new Map<string, symbol>();

  scheduleQueuedLaunches(): void {
    if (this.host.disposed || this.queueSweepScheduled || !this.host.store.hasQueuedWork()) return;
    this.queueSweepScheduled = true;
    queueMicrotask(() => {
      this.queueSweepScheduled = false;
      if (this.host.disposed) return;
      for (const task of this.host.store.listTasks()) {
        if (!task.queuedLaunch || task.queuedLaunch.state !== 'waiting' || this.claimedLaunches.has(task.id)) continue;
        this.host.store.promoteReadyTasks(task.runId);
        if (this.host.store.getTask(task.id)?.status !== 'ready' || this.host.store.hasPendingGates(task.id) || task.codeDeps?.some(dep => !this.host.store.codeReady(dep))) continue;
        this.claimedLaunches.set(task.id, Symbol(task.id));
        void this.launchQueuedTask(task).catch(error => console.warn('[orchestration] queued launch:', error))
          .finally(() => this.claimedLaunches.delete(task.id));
      }
    });
  }

  private async launchQueuedTask(task: OrchestrationTaskRecord): Promise<void> {
    const q = task.queuedLaunch!;
    const run = this.host.store.requireRun(task.runId);
    if (run.integrationIntent || run.status !== 'active' || run.consumerGeneration !== q.coordinatorGeneration ||
        !this.host.isCallerSurface(q.from) || !this.host.isPaneAlive(q.from) || (run.coordinatorPaneId ?? run.coordinatorHandle) !== q.from ||
        this.host.store.getRemainingDispatchCapacity() < 1) return;
    this.host.store.setQueuedLaunch(task.id, { ...q, state: 'claimed' });
    try {
      await this.host.store.flushDurable();
      if (this.host.disposed || !this.host.isCallerSurface(q.from) || !this.host.isPaneAlive(q.from) ||
          this.host.store.requireRun(run.id).consumerGeneration !== q.coordinatorGeneration) {
        this.host.store.setQueuedLaunch(task.id, q);
        return;
      }
      this.host.assertRunCoordinator(run.id, q.from);
      if ((q.requiresPaneMode && !this.host.isPaneOrchestrationMode(q.from)) ||
          (q.authorizedNetwork !== undefined && q.authorizedNetwork !== Boolean(this.host.sessionCoordinator(q.from)?.network))) {
        throw new OrchestrationError('operation_rejected', '原协调者的编排或联网权限已改变，请恢复原设置再核对派发。');
      }
      await this.host.workerStart({
        taskId: task.id, runId: run.id, from: q.from, callerPaneId: q.callerPaneId,
        callerCwd: q.callerCwd, baseBranch: q.baseBranch, agent: q.agent, role: q.role, name: q.role,
        terminal: q.terminal, model: q.model, effort: q.effort, noWorktree: !q.worktree,
        taskKind: q.taskKind, mcpEnabled: this.host.isMcpEnabledForCliDep?.(q.agent),
        ...((q.taskKind === 'review' || q.taskKind === 'research') && q.policy === undefined ? { readOnly: true } : {}),
        ...(q.policy !== undefined ? { policy: q.policy } : {}),
        ...(q.network !== undefined ? { network: q.network } : {}),
        ...(q.allowSubWorkers ? { allowSubWorkers: true } : {}),
        ...(q.userInitiated ? { userInitiated: true } : {}),
      }, this.claimedLaunches.get(task.id));
      if (q.authorizeReviews) this.host.store.setRunAutoReviewAuthorized(run.id, true);
      this.host.store.setQueuedLaunch(task.id);
    } catch (error) {
      if (this.host.store.getLatestDispatchForTask(task.id)) this.host.store.setQueuedLaunch(task.id);
      else if (error instanceof OrchestrationError && error.code === 'worker_limit_reached') this.host.store.setQueuedLaunch(task.id, q);
      else this.host.store.setQueuedLaunch(task.id, { ...q, state: 'needs_reconciliation',
        reason: this.host.store.redactDispatchCredentials(error instanceof Error ? error.message : String(error)) });
    }
    this.host.emitChanged('task:queue-updated', run.id);
  }

  approveDispatchProposal(
    id: string,
    overrides?: DispatchProposalOverrides
  ): { proposal: OrchestrationDispatchProposal } {
    return this.host.proposals.approveProposal(id, overrides);
  }

  rejectDispatchProposal(
    id: string,
    reason?: string
  ): { proposal: OrchestrationDispatchProposal } {
    return this.host.proposals.rejectProposal(id, reason);
  }

  resolveRoleNameForDispatch(dispatch: OrchestrationDispatchRecord): string {
    const visited = new Set<string>();
    let current: OrchestrationDispatchRecord | undefined = dispatch;
    let fallbackName = '';
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const task = this.host.store.getTask(current.taskId);
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
        ? this.host.store.getDispatchContext(current.followUpOfDispatchId)
        : undefined;
    }
    return fallbackName;
  }

  listManagedDispatchesForCaller(callerPaneId: string): OrchestrationDispatchRecord[] {
    const cleanCaller = callerPaneId.trim();
    const callerActive = this.host.store.getActiveDispatchForIdentity(cleanCaller, cleanCaller);
    const callerBoundRun = this.host.store.getCurrentRunForConsumer(cleanCaller);
    const all = this.host.store.listDispatches();
    const byHeadId = new Map<string, OrchestrationDispatchRecord>();

    const ownDispatchIds = new Set<string>();
    if (callerActive) {
      let cur: OrchestrationDispatchRecord | undefined = callerActive;
      while (cur && !ownDispatchIds.has(cur.id)) {
        ownDispatchIds.add(cur.id);
        cur = cur.followUpOfDispatchId
          ? this.host.store.getDispatchContext(cur.followUpOfDispatchId)
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
      const head = this.host.store.resolveDispatchLineage(d.id) ?? d;
      if (head.assigneePaneId === cleanCaller || head.assigneeHandle === cleanCaller) continue;
      byHeadId.set(head.id, head);
    }

    return [...byHeadId.values()];
  }

  resolveDispatchByRoleOrTarget(
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
    const direct = this.host.store.resolveDispatchLineage(idCandidate) ?? this.host.store.getDispatchContext(idCandidate);
    if (direct) return direct;

    const byTask = this.host.store.getLatestDispatchForTask(idCandidate);
    if (byTask) return this.host.store.resolveDispatchLineage(byTask.id) ?? byTask;

    const cleanRole = cleaned.replace(/^@+/, '').toLowerCase();
    const scopedRunId =
      runIdHint?.trim() ||
      (callerHint ? this.host.inferRunIdOptional(callerHint) : undefined);
    const candidates = this.host.store
      .listDispatches(scopedRunId ? { runId: scopedRunId } : undefined)
      .reverse();
    for (const d of candidates) {
      const role = this.resolveRoleNameForDispatch(d).toLowerCase();
      if (role === cleanRole || d.assigneePaneId === cleaned || d.assigneeHandle === cleaned) {
        return this.host.store.resolveDispatchLineage(d.id) ?? d;
      }
    }
    throw new OrchestrationError('dispatch_not_found', `Worker not found: ${rawTarget}`);
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
      this.host.authorizeRunAccess(reviewTargetDispatch.runId, input.callerPaneId);
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
      ? this.host.integration.resolveTargetRunForOperation(
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
    const taskText = this.host.store.redactDispatchCredentials(input.task?.trim() || fallbackReviewTask);
    if (!taskText) {
      throw new OrchestrationError('invalid_argument', 'Missing task specification.');
    }
    let normalizedTaskContext = this.host.redactTaskContext(normalizeTaskContext(input));

    this.host.assertCanDelegateFrom(from);
    const defaultReviewRole = reviewTargetDispatch
      ? `review-${reviewTargetRole.replace(/^@+/, '')}`
      : reviewRunTarget
        ? 'review-run'
        : '';
    const role = this.host.store.redactDispatchCredentials(
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
    if (allowSubWorkers && this.host.resolveCallerDepth(from) + 1 >= this.host.maxDepth) {
      throw new OrchestrationError(
        'operation_rejected',
        `A Worker at depth ${this.host.resolveCallerDepth(from) + 1} cannot start sub-Workers (max depth ${this.host.maxDepth}).`,
        { maxDepth: this.host.maxDepth },
      );
    }
    let worktree = isAdversarialReview
      ? false
      : (input.worktree ?? this.host.getDefaultWorktreeDep?.() ?? true);
    const requestedAgent = input.agent?.trim() || 'auto';
    const roster = this.host.listCodingAgents(from);
    const coordinatorCliId =
      this.host.agentStatusStore.get(from)?.agentId ??
      this.host.terminalTracker?.getTerminal(from)?.cliId ??
      this.host.sessionCoordinator(from)?.provider ??
      null;
    const authorCliId = reviewTargetDispatch?.cliId ?? null;
    const authorCliIds = reviewRunTarget
      ? [
          ...new Set(
            this.host.store
              .listIntegratedDispatchesForRun(reviewRunTarget.id)
              .flatMap((d) => d.authorCliIds ?? (d.cliId ? [d.cliId] : [])),
          ),
        ]
      : reviewTargetDispatch?.authorCliIds;

    let resolvedAgent: string;
    let selectionReason: string;
    let resolvedModel: string | undefined = input.model?.trim() || undefined;
    let resolvedEffort: string | undefined = input.effort?.trim() || undefined;
    let fallbacks: string[] = [];

    if (this.host.selectAgentForTaskDep && roster.length > 0) {
      let selection: OrchestrationAgentSelectionResult;
      try {
        selection = this.host.selectAgentForTaskDep({
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
        ? this.host.inferRunIdOptional(from)
        : this.host.board.resolveBoardMemberForPane(from)?.runId) ||
      null;
    let dispatchRunId = explicitRunId ?? reviewRunTarget?.id ?? reviewTargetDispatch?.runId;
    if (explicitRunId && input.callerPaneId !== undefined) {
      this.host.board.resolveBoardCallerContext({ from: input.callerPaneId, runId: explicitRunId });
    }
    const isReviewDispatch = Boolean(reviewTargetDispatch || reviewRunTarget);
    const targetRunForAuth = inferredRunId ? this.host.store.getRun(inferredRunId) : null;
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
      planSummary: this.host.store.redactDispatchCredentials(planSummary),
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
    const confirmMode = this.host.effectiveConfirmMode(from);
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
        const guard = this.host.proposals.evaluateChatGuard(
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
        const held = await this.host.proposals.createHeldProposal(proposalInput, signal);
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
          if (allowSubWorkers && this.host.resolveCallerDepth(from) + 1 >= this.host.maxDepth) allowSubWorkers = false;
        }
      }
    }

    if (proposalInput.deps.length || proposalInput.codeDeps.length) {
      const run = this.host.store.requireRun(dispatchRunId ?? inferredRunId ?? '');
      if (isReviewDispatch) throw new OrchestrationError('invalid_argument', 'Review dispatches already target an immutable snapshot.');
      if (input.callerPaneId) this.host.assertRunCoordinator(run.id, input.callerPaneId);
      const task = this.host.store.createTask({
        runId: run.id, spec: taskText, taskTitle, displayName, taskContext: normalizedTaskContext,
        deps: proposalInput.deps, codeDeps: proposalInput.codeDeps, singleShot: true,
        queuedLaunch: {
          from, callerPaneId: input.callerPaneId, callerCwd: input.callerCwd ?? this.host.sessionCoordinator(from)?.cwd ?? this.host.terminalTracker?.getTerminal(from)?.cwd ?? this.host.getDefaultCwd?.(),
          authorizedNetwork: Boolean(this.host.sessionCoordinator(from)?.network), requiresPaneMode: this.host.isPaneOrchestrationMode(from),
          coordinatorGeneration: run.consumerGeneration, baseBranch: input.baseBranch, agent: resolvedAgent,
          role, terminal: input.terminal, model: resolvedModel, effort: resolvedEffort, taskKind: effectiveTaskKind,
          ...(workerPolicy !== undefined ? { policy: workerPolicy } : {}),
          ...(workerNetwork !== undefined ? { network: workerNetwork } : {}),
          ...(allowSubWorkers ? { allowSubWorkers: true } : {}),
          ...(approvedByPerson ? { userInitiated: true } : {}),
          worktree, authorizeReviews: grantRunAutoReview, state: 'waiting',
        },
      });
      this.host.emitChanged('task:queued', run.id);
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
      const mcpEnabled = this.host.isMcpEnabledForCliDep?.(candidateCli) ?? false;

      const existingTask = reusableTaskId ? this.host.store.getTask(reusableTaskId) : null;
      if (existingTask && existingTask.status !== 'ready') {
        this.host.store.requeueTaskForRetry(reusableTaskId!);
      }

      try {
        const started = await this.host.workerStart({
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
          const updatedRun = this.host.store.setRunAutoReviewAuthorized(started.run.id, true);
          if (updatedRun) {
            started.run = updatedRun;
            this.host.emitChanged('run:auto-review-updated', updatedRun.id);
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

  resolveWorkerByRoleOrId(callerPaneId: string, target: string): OrchestrationDispatchRecord {
    const cleanCaller = callerPaneId.trim();
    const rawTarget = target.trim();
    if (!rawTarget) {
      throw new OrchestrationError('invalid_argument', 'Missing target worker role or dispatch id.');
    }

    if (rawTarget.startsWith('dispatch:')) {
      const id = rawTarget.slice('dispatch:'.length).trim();
      const ctx = this.host.store.resolveDispatchLineage(id) ?? this.host.store.getDispatchContext(id);
      if (ctx) {
        this.host.assertWorkerController({ dispatchId: ctx.id }, cleanCaller);
        return ctx;
      }
    }

    const direct = this.host.store.getDispatchContext(rawTarget);
    if (direct) {
      const resolved = this.host.store.resolveDispatchLineage(direct.id) ?? direct;
      this.host.assertWorkerController({ dispatchId: resolved.id }, cleanCaller);
      return resolved;
    }

    const cleanRole = rawTarget.replace(/^@+/, '').trim().toLowerCase();
    const managed = this.listManagedDispatchesForCaller(callerPaneId);
    const matching = managed.filter((d) => {
      const roleName = this.resolveRoleNameForDispatch(d).toLowerCase();
      if (roleName && roleName === cleanRole) return true;
      const task = this.host.store.getTask(d.taskId);
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
    this.host.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
    const questionId = input.questionId?.trim();
    if (questionId) {
      const targetQuestion = this.host.store.getQuestion(questionId);
      if (!targetQuestion || targetQuestion.dispatchId !== dispatch.id) {
        throw new OrchestrationError('invalid_argument', 'The question does not belong to the selected worker.');
      }
      this.host.assertCanReply(targetQuestion.messageId, callerPaneId);
      const replied = this.host.reply({
        id: targetQuestion.messageId,
        body: cleanMessage,
        from: callerPaneId,
      });
      return { mode: 'replied', dispatch, ...replied };
    }
    const callerDispatch = this.host.store.getActiveDispatchForIdentity(callerPaneId, callerPaneId);
    const senderRole = callerDispatch
      ? this.resolveRoleNameForDispatch(callerDispatch).toLowerCase() || 'worker'
      : 'coordinator';
    const targetRole = this.resolveRoleNameForDispatch(dispatch).toLowerCase() || dispatch.id;
    const refs = parseBoardRefs(cleanMessage);
    const sent = await this.host.send({
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
      this.host.peerPingPong.recordCoordinatorOrUserActivity(dispatch.runId);
    }
    if (typeof sent.message.boardSeq === 'number') {
      this.host.store.advanceMemberCursor(dispatch.runId, senderRole, {
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
      action: 'read' | 'approve' | 'deny' | 'release' | 'stop' | 'handoff';
      reason?: string;
      /** For `handoff`: the Coding Agent that continues the task. */
      agent?: string;
      force?: boolean;
      screen?: boolean;
    }
  ): Promise<Record<string, unknown>> {
    const dispatch = this.resolveWorkerByRoleOrId(callerPaneId, input.role);
    this.host.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
    switch (input.action) {
      case 'read': {
        const output = this.host.workerRead({
          dispatchId: dispatch.id,
          screen: input.screen ?? true,
        });
        return { action: 'read', dispatch, output };
      }
      case 'approve': {
        const open = this.host.approvals.listOpenApprovals({ dispatchId: dispatch.id });
        if (open.length === 0) {
          throw new OrchestrationError(
            'approval_not_found',
            `No pending permission approval for worker "${input.role}".`
          );
        }
        const res = this.host.approve(
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
        const open = this.host.approvals.listOpenApprovals({ dispatchId: dispatch.id });
        if (open.length === 0) {
          throw new OrchestrationError(
            'approval_not_found',
            `No pending permission approval for worker "${input.role}".`
          );
        }
        const res = this.host.deny(
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
        this.host.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
        const res = await this.host.workerRelease({
          dispatchId: dispatch.id,
          force: input.force,
        });
        return { action: 'release', ...res };
      }
      case 'stop': {
        this.host.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
        const res = await this.host.workerStop({
          dispatchId: dispatch.id,
          reason: input.reason,
          force: input.force,
        });
        return { action: 'stop', ...res };
      }
      case 'handoff': {
        if (!input.agent?.trim()) {
          throw new OrchestrationError('invalid_argument', 'action="handoff" needs agent, the Coding Agent that continues the task.');
        }
        const res = await this.host.handoffWorker(dispatch, { toCli: input.agent, from: callerPaneId, instructions: input.reason });
        return { action: 'handoff', handoffId: res.handoffId, dispatch: res.followUp?.dispatch ?? dispatch, previousDispatchId: dispatch.id };
      }
    }
  }
}
