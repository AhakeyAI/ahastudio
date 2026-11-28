import type { AgentStatusStore } from '../agent/agent-status-store.js';
import { HEADLESS_WORKER_ID } from './headless-workers.js';
import type { WorkerNativeQuestionManager } from './worker-native-questions.js';
import type { MailboxPointerDelivery } from './mailbox-pointer-delivery.js';
import type { MessageWake, RuntimeMessageWaiters } from './mailbox-waiters.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import { exposeMessage, exposeMessages } from './orchestration-messaging.js';
import type { OrchestrationStore } from './orchestration-store.js';
import {
  ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS,
  OrchestrationError,
  type OrchestrationBoardPostKind,
  type OrchestrationDispatchRecord,
  type OrchestrationDispatchStage,
  type OrchestrationExposedMessage,
  type OrchestrationMessageRecord,
  type OrchestrationPeerMessagingMode,
  type OrchestrationQuestionRecord,
  type OrchestrationMemberCursor,
  type OrchestrationRunRecord,
} from './orchestration-types.js';
import {
  DEFAULT_PEER_PING_PONG_LIMIT,
  PeerPingPongTracker,
  formatBoardPostForAgent,
  boardLookupCommands,
  formatBoardTeamSummary,
  parseBoardMentions,
  parseBoardRefs,
} from './board-protocol.js';
import type { BoardStallRunState } from './stall-watchdog.js';
import type { ReviewFirewallContext } from './review-service.js';
import type { DispatchProposalManager } from './dispatch-proposals.js';
import type { PermissionApprovalManager } from './permission-approvals.js';
import type {
  OrchestrationSendResult,
  OrchestrationWorkerSummary,
  OrchestrationSessionCoordinators,
  SettledWorkerFollowUpInput,
} from './orchestration-service.js';

export interface BoardPostInput {
  runId?: string;
  from: string;
  fromRole?: string;
  text: string;
  kind?: OrchestrationBoardPostKind;
  subject?: string;
  isUser?: boolean;
  replyTo?: string | number;
}

/** Service capabilities the OrchestrationBoardService relies on; supplied by OrchestrationService. */
export interface OrchestrationBoardHost {
  readonly agentStatusStore: AgentStatusStore;
  readonly approvals: PermissionApprovalManager;
  readonly clock: () => number;
  readonly deliverCodexMailbox: (workerId: string) => void;
  readonly deriveLiveStage: (dispatch: OrchestrationDispatchRecord) => OrchestrationDispatchStage;
  readonly emitChanged: (reason: string, runId?: string) => void;
  readonly followUpSettledWorker: (settledDispatch: OrchestrationDispatchRecord, input: SettledWorkerFollowUpInput) => Promise<OrchestrationSendResult>;
  readonly getPeerMessagingModeDep: (() => OrchestrationPeerMessagingMode) | undefined;
  readonly getReviewFirewallContext: (callerHandle?: string | null) => ReviewFirewallContext | null;
  readonly inferRunIdOptional: (from?: string) => string | undefined;
  readonly isPostHiddenByReviewFirewall: (post: OrchestrationMessageRecord, firewall: ReviewFirewallContext) => boolean;
  readonly nativeQuestions: WorkerNativeQuestionManager;
  readonly peerPingPong: PeerPingPongTracker;
  readonly pointerDelivery: MailboxPointerDelivery;
  readonly proposals: DispatchProposalManager;
  readonly queueCodexMail: (workerId: string, message?: OrchestrationMessageRecord) => void;
  readonly resolveRoleNameForDispatch: (dispatch: OrchestrationDispatchRecord) => string;
  readonly sessionCoordinator: (id: string) => ReturnType<OrchestrationSessionCoordinators["get"]>;
  readonly store: OrchestrationStore;
  readonly toWorkerSummary: (dispatch: OrchestrationDispatchRecord) => OrchestrationWorkerSummary;
  readonly waiters: RuntimeMessageWaiters;
}

/** Board posts, cursors, exact reads, board_wait, mid-turn injection and stall detection. */
export class OrchestrationBoardService {
  constructor(private readonly host: OrchestrationBoardHost) {}


  resolveBoardMemberForPane(
    ptyId: string
  ): { runId: string; memberKey: string; role: string; dispatchId?: string } | null {
    const clean = ptyId.trim();
    if (!clean) return null;
    const active = this.host.store.getActiveDispatchForIdentity(clean, clean);
    if (active) {
      const role = this.host.resolveRoleNameForDispatch(active).toLowerCase() || active.id;
      return { runId: active.runId, memberKey: role, role, dispatchId: active.id };
    }
    const bound = this.host.store.getCurrentRunForConsumer(clean);
    if (bound && (bound.coordinatorPaneId === clean || bound.coordinatorHandle === clean)) {
      return { runId: bound.id, memberKey: 'coordinator', role: 'coordinator' };
    }
    for (const run of this.host.store.listRuns({ status: 'active' })) {
      if (run.coordinatorPaneId === clean || run.coordinatorHandle === clean) {
        return { runId: run.id, memberKey: 'coordinator', role: 'coordinator' };
      }
    }
    return null;
  }

  private findRunWorkerByRole(
    runId: string,
    targetRole: string
  ): OrchestrationDispatchRecord | undefined {
    const cleanRole = targetRole.trim().replace(/^@+/, '').toLowerCase();
    if (!cleanRole) return undefined;
    const byHeadId = new Map<string, OrchestrationDispatchRecord>();
    for (const d of this.host.store.listDispatches({ runId })) {
      const head = this.host.store.resolveDispatchLineage(d.id) ?? d;
      byHeadId.set(head.id, head);
    }
    const matches = [...byHeadId.values()].filter((d) => {
      const roleName = this.host.resolveRoleNameForDispatch(d).toLowerCase();
      if (roleName && roleName === cleanRole) return true;
      const task = this.host.store.getTask(d.taskId);
      const taskDisplay = task?.displayName?.trim().replace(/^@+/, '').toLowerCase() ?? '';
      if (taskDisplay && taskDisplay === cleanRole) return true;
      return d.id.toLowerCase() === cleanRole;
    });
    if (matches.length === 0) return undefined;
    matches.sort((a, b) => {
      const aActive = ACTIVE_DISPATCH_STATUSES.has(a.status) ? 1 : 0;
      const bActive = ACTIVE_DISPATCH_STATUSES.has(b.status) ? 1 : 0;
      if (aActive !== bActive) return bActive - aActive;
      return b.createdAt.localeCompare(a.createdAt);
    });
    return matches[0];
  }

  doesBoardPostWakeMember(
    msg: OrchestrationMessageRecord,
    memberRole: string,
    memberHandle: string,
    runId: string,
    activeDispatchId?: string
  ): boolean {
    if (msg.runId !== runId || msg.type === 'heartbeat' || msg.lifecycleRejectedReason !== null) {
      return false;
    }
    const normMember = memberRole.toLowerCase();
    const normFromRole = msg.fromRole?.trim().replace(/^@+/, '').toLowerCase() ?? '';
    if (normFromRole && normFromRole === normMember) return false;
    if (msg.fromHandle === memberHandle) return false;
    if (activeDispatchId && msg.fromHandle === `dispatch:${activeDispatchId}`) return false;

    const mentions = msg.mentions ?? [];
    if (mentions.includes(normMember)) {
      return true;
    }
    if (
      mentions.includes('all') &&
      (normFromRole === 'coordinator' || normFromRole === 'user' || normFromRole === 'system')
    ) {
      return true;
    }

    if (normMember === 'coordinator') {
      if (
        msg.kind === 'report' ||
        msg.kind === 'approval' ||
        msg.kind === 'question' ||
        msg.kind === 'stall' ||
        msg.type === 'worker_done' ||
        msg.type === 'decision_gate'
      ) {
        return true;
      }
      if (
        msg.kind === 'post' ||
        msg.kind === 'handoff' ||
        msg.kind === 'answer' ||
        msg.kind === 'brief'
      ) {
        return normFromRole === 'user' && mentions.length === 0;
      }
      if (msg.toHandle === `run:${runId}` || msg.toHandle === memberHandle) {
        return true;
      }
      return false;
    }

    if (activeDispatchId && msg.toHandle === `dispatch:${activeDispatchId}`) {
      return msg.kind !== 'brief';
    }
    if (msg.toHandle === memberHandle) {
      return true;
    }
    return false;
  }

  findUndeliveredBoardPostsForPane(ptyId: string): OrchestrationMessageRecord[] {
    const member = this.resolveBoardMemberForPane(ptyId);
    if (!member) return [];
    const cursor = this.host.store.getMemberCursor(member.runId, member.memberKey);
    const firewall = this.host.getReviewFirewallContext(ptyId);
    return this.host.store.listBoardPosts(member.runId, {
      since: cursor.lastDeliveredSeq,
      limit: 50,
      matches: (post) =>
        !this.host.store.wasBoardPostRead(post.id, member.memberKey) &&
        !(firewall && this.host.isPostHiddenByReviewFirewall(post, firewall)) &&
        this.doesBoardPostWakeMember(post, member.role, ptyId, member.runId, member.dispatchId),
    });
  }

  buildBoardTeamSummary(runId: string): string {
    const headSeq = this.host.store.getHeadBoardSeq(runId);
    const byHeadId = new Map<string, OrchestrationDispatchRecord>();
    for (const d of this.host.store.listDispatches({ runId })) {
      const head = this.host.store.resolveDispatchLineage(d.id) ?? d;
      byHeadId.set(head.id, head);
    }
    const workers = [...byHeadId.values()].map((d) => {
      const summary = this.host.toWorkerSummary(d);
      const role =
        this.host.resolveRoleNameForDispatch(d) ||
        summary.task?.displayName?.trim().replace(/^@+/, '') ||
        d.id;
      return {
        role,
        cliId: d.cliId ?? null,
        stage: summary.stage,
        openApprovalCount: summary.openApprovals.length,
        openQuestionCount: summary.openQuestions.length + summary.openNativeQuestions.length,
      };
    });
    const pendingProposalCount = this.host.proposals.listPendingProposals({ runId }).length;
    return formatBoardTeamSummary({ headSeq, workers, pendingProposalCount });
  }

  private notifyBoardPost(
    runId: string,
    msg: OrchestrationMessageRecord,
    woke: readonly string[],
    senderPaneId?: string
  ): void {
    this.host.waiters.notify(`board:${runId}:all`, msg.type);
    const run = this.host.store.getRun(runId);

    const schedulePane = (paneId: string | null | undefined) => {
      if (!paneId || paneId === senderPaneId) return;
      this.host.waiters.notify(paneId, msg.type);
      this.host.waiters.notify(`board-pane:${paneId}`, msg.type);
      if (HEADLESS_WORKER_ID.test(paneId)) {
        const member = this.resolveBoardMemberForPane(paneId);
        if (member?.runId === runId && this.host.store.wasBoardPostRead(msg.id, member.memberKey)) return;
        this.host.queueCodexMail(paneId, msg);
        this.host.deliverCodexMailbox(paneId);
      } else {
        this.host.pointerDelivery.scheduleRedriveForPane(paneId);
      }
    };

    const wokeSet = new Set(woke);
    if (wokeSet.has('all')) {
      this.host.waiters.notifyPrefix(`board:${runId}:role:`, msg.type);
      this.host.waiters.notify(`run:${runId}`, msg.type);
      if (run?.coordinatorPaneId && run.coordinatorPaneId !== senderPaneId) {
        schedulePane(run.coordinatorPaneId);
      }
      for (const d of this.host.store.listDispatches({ runId })) {
        if (!ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
        this.host.waiters.notify(`dispatch:${d.id}`, msg.type);
        schedulePane(d.assigneePaneId ?? d.assigneeHandle);
      }
      return;
    }

    if (wokeSet.has('coordinator')) {
      this.host.waiters.notify(`board:${runId}:role:coordinator`, msg.type);
      this.host.waiters.notify(`run:${runId}`, msg.type);
      schedulePane(run?.coordinatorPaneId ?? run?.coordinatorHandle);
    }

    for (const targetRole of wokeSet) {
      if (targetRole === 'coordinator' || targetRole === 'all' || targetRole === 'user') continue;
      this.host.waiters.notify(`board:${runId}:role:${targetRole}`, msg.type);
      const targetDispatch = this.findRunWorkerByRole(runId, targetRole);
      if (targetDispatch && ACTIVE_DISPATCH_STATUSES.has(targetDispatch.status)) {
        this.host.waiters.notify(`dispatch:${targetDispatch.id}`, msg.type);
        schedulePane(targetDispatch.assigneePaneId ?? targetDispatch.assigneeHandle);
      }
    }
  }

  resolveBoardCallerContext(input: {
    from: string;
    runId?: string;
    isUser?: boolean;
  }): {
    runId: string;
    fromHandle: string;
    callerRole: string;
    memberKey: string;
    isPrivileged: boolean;
    activeDispatch?: OrchestrationDispatchRecord;
  } {
    const isUser = input.isUser === true;
    if (isUser) {
      const explicitRunId = input.runId?.trim();
      const resolvedRunId =
        explicitRunId ||
        this.host.inferRunIdOptional(input.from) ||
        this.host.store.listRuns({ status: 'active' }).at(-1)?.id ||
        this.host.store.listRuns().at(-1)?.id;
      if (!resolvedRunId) {
        throw new OrchestrationError(
          'run_not_found',
          'No orchestration run found for board access.'
        );
      }
      this.host.store.requireRun(resolvedRunId);
      return {
        runId: resolvedRunId,
        fromHandle: 'user',
        callerRole: 'user',
        memberKey: 'user',
        isPrivileged: true,
      };
    }

    const fromHandle = input.from?.trim() || 'coordinator';
    const explicitRunId = input.runId?.trim();
    const activeDispatch = this.host.store.getActiveDispatchForIdentity(fromHandle, fromHandle);
    if (activeDispatch) {
      if (explicitRunId && explicitRunId !== activeDispatch.runId) {
        throw new OrchestrationError(
          'operation_rejected',
          'Workers may only access their own run board.'
        );
      }
      const workerRole =
        this.host.resolveRoleNameForDispatch(activeDispatch).toLowerCase() || activeDispatch.id;
      return {
        runId: activeDispatch.runId,
        fromHandle,
        callerRole: workerRole,
        memberKey: workerRole,
        isPrivileged: false,
        activeDispatch,
      };
    }

    const isCoordinatorForRun = (run: OrchestrationRunRecord, handle: string): boolean => {
      if (handle === 'coordinator') return true;
      if (run.coordinatorPaneId === handle || run.coordinatorHandle === handle) return true;
      return this.host.store.getCurrentRunForConsumer(handle)?.id === run.id;
    };

    // Check if caller coordinates an explicit or bound run before falling back to settled worker history.
    if (fromHandle === 'coordinator') {
      const resolvedRunId =
        explicitRunId ||
        this.host.inferRunIdOptional(fromHandle) ||
        this.host.store.listRuns({ status: 'active' }).at(-1)?.id ||
        this.host.store.listRuns().at(-1)?.id;
      if (!resolvedRunId) {
        throw new OrchestrationError(
          'run_not_found',
          'No active run specified or bound to caller. Start a worker or create a run first.'
        );
      }
      this.host.store.requireRun(resolvedRunId);
      return {
        runId: resolvedRunId,
        fromHandle,
        callerRole: 'coordinator',
        memberKey: 'coordinator',
        isPrivileged: true,
      };
    }

    const boundRun = this.host.store.getCurrentRunForConsumer(fromHandle);
    const ownedRuns = this.host.store
      .listRuns()
      .filter((r) => isCoordinatorForRun(r, fromHandle));
    const coordinatedExplicitRun = explicitRunId
      ? ownedRuns.find((r) => r.id === explicitRunId)
      : undefined;

    if (coordinatedExplicitRun) {
      return {
        runId: coordinatedExplicitRun.id,
        fromHandle,
        callerRole: 'coordinator',
        memberKey: 'coordinator',
        isPrivileged: true,
      };
    }

    // Keep settled/kept-open worker panes strictly scoped to their own run as non-privileged workers.
    const latestSettledDispatch = this.host.store
      .listDispatches()
      .filter((d) => d.assigneePaneId === fromHandle || d.assigneeHandle === fromHandle)
      .at(-1);
    if (latestSettledDispatch) {
      const isCoordOfSettledRun = ownedRuns.some((r) => r.id === latestSettledDispatch.runId);
      if (!isCoordOfSettledRun) {
        if (explicitRunId && explicitRunId !== latestSettledDispatch.runId) {
          throw new OrchestrationError(
            'operation_rejected',
            'Workers may only access their own run board.'
          );
        }
        const workerRole =
          this.host.resolveRoleNameForDispatch(latestSettledDispatch).toLowerCase() ||
          latestSettledDispatch.id;
        return {
          runId: latestSettledDispatch.runId,
          fromHandle,
          callerRole: workerRole,
          memberKey: workerRole,
          isPrivileged: false,
        };
      }
    }

    if (explicitRunId) {
      const targetRun = this.host.store.requireRun(explicitRunId);
      if (!isCoordinatorForRun(targetRun, fromHandle)) {
        throw new OrchestrationError(
          'operation_rejected',
          `Caller ${fromHandle} is not the coordinator of run ${targetRun.id}.`
        );
      }
      return {
        runId: targetRun.id,
        fromHandle,
        callerRole: 'coordinator',
        memberKey: 'coordinator',
        isPrivileged: true,
      };
    }

    const resolvedRun =
      (boundRun && isCoordinatorForRun(boundRun, fromHandle) ? boundRun : undefined) ??
      ownedRuns.filter((r) => r.status === 'active').at(-1) ??
      ownedRuns.at(-1);
    if (!resolvedRun) {
      throw new OrchestrationError(
        'run_not_found',
        'No active run specified or bound to caller. Start a worker or create a run first.'
      );
    }
    return {
      runId: resolvedRun.id,
      fromHandle,
      callerRole: 'coordinator',
      memberKey: 'coordinator',
      isPrivileged: true,
    };
  }

  async boardPost(input: BoardPostInput) {
    const reference = input.replyTo === undefined || input.replyTo === null ? '' : String(input.replyTo).trim();
    if (!reference) return this.publishBoardPost(input);
    const caller = this.resolveBoardCallerContext(input);
    const seq = /^#?(\d+)$/.exec(reference);
    const original = seq
      ? this.host.store.listBoardPosts(caller.runId, { seqs: [Number(seq[1])] })[0]
      : this.host.store.getMessageById(reference);
    const firewall = this.host.getReviewFirewallContext(input.from);
    if (!original?.fromRole || !original.boardSeq || original.runId !== caller.runId ||
        original.lifecycleRejectedReason ||
        !original.mentions?.some((m) => m.replace(/^@+/, '').toLowerCase() === caller.memberKey) ||
        (firewall && this.host.isPostHiddenByReviewFirewall(original, firewall))) {
      throw new OrchestrationError('invalid_argument', 'replyTo must identify a visible post addressed to your role in this Run.');
    }
    if (original.type === 'question' || original.type === 'worker_done' || original.kind === 'approval') {
      throw new OrchestrationError('invalid_argument', 'Use the dedicated question, completion or approval action for this post.');
    }
    const result = await this.publishBoardPost(input, original);
    this.host.store.recordBoardRead(caller.runId, caller.memberKey, [original.id]);
    if (this.host.store.recordBoardReceipt([original.id], caller.memberKey, 'replied')) this.host.emitChanged('board:delivery', caller.runId);
    return result;
  }

  private async publishBoardPost(input: BoardPostInput, original?: OrchestrationMessageRecord): Promise<{
    post: OrchestrationExposedMessage;
    boardSeq: number;
    headSeq: number;
    woke: string[];
    escalatedToCoordinator: boolean;
  }> {
    const text = input.text?.trim() ?? '';
    if (!text) {
      throw new OrchestrationError('invalid_argument', 'Board post text cannot be empty.');
    }

    const caller = this.resolveBoardCallerContext({
      from: input.from,
      runId: input.runId,
      isUser: input.isUser,
    });
    const runId = caller.runId;
    const callerRole = original || caller.isPrivileged
      ? caller.callerRole
      : input.fromRole?.trim().replace(/^@+/, '').toLowerCase() || caller.callerRole;
    const mentions = parseBoardMentions(text);
    const refs = parseBoardRefs(text);
    const replyAuthorRole = original?.fromRole?.trim().replace(/^@+/, '').toLowerCase();
    if (replyAuthorRole && !mentions.includes(replyAuthorRole)) mentions.push(replyAuthorRole);
    if (original?.boardSeq && !refs.includes(original.boardSeq)) refs.push(original.boardSeq);
    const threadId = original?.threadId ?? original?.id;
    const woke = new Set<string>();
    let escalatedToCoordinator = false;
    const senderPaneId = input.isUser ? undefined : caller.fromHandle;

    if (caller.isPrivileged) {
      this.host.peerPingPong.recordCoordinatorOrUserActivity(runId);

      // A single settled target reuses the follow-up message as its board post.
      if (mentions.length === 1 && mentions[0] !== 'all' && mentions[0] !== 'coordinator' && mentions[0] !== 'user') {
        const targetRole = mentions[0]!;
        const targetDispatch = this.findRunWorkerByRole(runId, targetRole);
        if (targetDispatch) {
          // Settled (and not released) worker mentioned by coordinator/user -> reactivate!
          if (!ACTIVE_DISPATCH_STATUSES.has(targetDispatch.status) && !targetDispatch.releasedAt) {
            const sent = await this.host.followUpSettledWorker(targetDispatch, {
              from: caller.fromHandle,
              to: `dispatch:${targetDispatch.id}`,
              threadId,
              subject: input.subject?.trim() || `Board follow-up from @${callerRole}`,
              body: text,
              fromRole: callerRole,
              mentions: [targetRole],
              refs: refs.length > 0 ? refs : undefined,
              kind: input.kind ?? 'post',
            });
            const boardSeq = sent.message.boardSeq ?? this.host.store.getHeadBoardSeq(runId);
            this.host.store.advanceMemberCursor(runId, callerRole, {
              lastPostSeq: boardSeq,
            });
            const storedMsg = this.host.store.getMessageById(sent.message.id);
            if (storedMsg) {
              this.notifyBoardPost(runId, storedMsg, [targetRole], senderPaneId);
            }
            this.host.emitChanged('board:posted', runId);
            return {
              post: sent.message,
              boardSeq,
              headSeq: this.host.store.getHeadBoardSeq(runId),
              woke: [targetRole],
              escalatedToCoordinator: false,
            };
          }
        }
      }

      // Multi-mention or active worker / @all / general coordinator or user board post.
      const settledToReactivate: Array<{
        dispatch: OrchestrationDispatchRecord;
        role: string;
      }> = [];
      let singleActiveWorkerDispatch: OrchestrationDispatchRecord | null = null;

      for (const mention of mentions) {
        if (mention === 'all') {
          woke.add('all');
        } else if (mention === 'coordinator') {
          if (input.isUser) woke.add('coordinator');
        } else if (mention === 'user') {
          // Visible to human user in Board UI.
        } else {
          const targetDispatch = this.findRunWorkerByRole(runId, mention);
          if (!targetDispatch) continue;
          if (!ACTIVE_DISPATCH_STATUSES.has(targetDispatch.status) && !targetDispatch.releasedAt) {
            settledToReactivate.push({ dispatch: targetDispatch, role: mention });
            woke.add(mention);
          } else if (ACTIVE_DISPATCH_STATUSES.has(targetDispatch.status)) {
            woke.add(mention);
            if (mentions.length === 1) {
              singleActiveWorkerDispatch = targetDispatch;
            }
          }
        }
      }

      // Human user posting without explicit @mention still wakes coordinator so human guidance is noticed.
      if (input.isUser && mentions.length === 0) {
        woke.add('coordinator');
      }

      const toHandle = woke.has('all')
        ? '@all'
        : singleActiveWorkerDispatch
          ? `dispatch:${singleActiveWorkerDispatch.id}`
          : `run:${runId}`;

      const msg = this.host.store.insertMessage({
        runId,
        from: caller.fromHandle,
        to: toHandle,
        threadId,
        type: 'status',
        priority: input.isUser ? 'high' : 'normal',
        subject: input.subject?.trim() || text.split(/\r?\n/)[0]!.slice(0, 80),
        body: text,
        fromRole: callerRole,
        mentions: mentions.length > 0 ? mentions : undefined,
        refs: refs.length > 0 ? refs : undefined,
        kind: input.kind ?? 'post',
      });

      const boardSeq = msg.boardSeq ?? this.host.store.getHeadBoardSeq(runId);
      this.host.store.advanceMemberCursor(runId, callerRole, {
        lastPostSeq: boardSeq,
      });

      for (const item of settledToReactivate) {
        await this.host.followUpSettledWorker(item.dispatch, {
          from: caller.fromHandle,
          to: `dispatch:${item.dispatch.id}`,
          subject: input.subject?.trim() || `Board follow-up from @${callerRole}`,
          body: text,
          fromRole: callerRole,
          mentions: [item.role],
          refs: refs.length > 0 ? refs : undefined,
          kind: input.kind ?? 'post',
          existingMessage: msg,
        });
      }

      this.notifyBoardPost(runId, msg, [...woke], senderPaneId);
      this.host.emitChanged('board:posted', runId);
      return {
        post: exposeMessage(msg),
        boardSeq,
        headSeq: this.host.store.getHeadBoardSeq(runId),
        woke: [...woke],
        escalatedToCoordinator: false,
      };
    }

    // Worker posting on board: enforce Controlled P2P Guardrails.
    const peerMode: OrchestrationPeerMessagingMode =
      this.host.getPeerMessagingModeDep?.() ?? 'controlled-p2p';
    const effectiveMentions = new Set<string>();
    let hasPeerMention = false;
    let singleDirectPeerDispatch: OrchestrationDispatchRecord | null = null;
    const redirectedRoles: string[] = [];

    for (const mention of mentions) {
      if (mention === callerRole) continue;
      if (mention === 'all') {
        // Worker @all is posted publicly on the board, but NEVER wakes peers.
        effectiveMentions.add('all');
        continue;
      }
      if (mention === 'coordinator') {
        effectiveMentions.add('coordinator');
        woke.add('coordinator');
        continue;
      }
      if (mention === 'user') {
        effectiveMentions.add('user');
        continue;
      }

      const targetDispatch = this.findRunWorkerByRole(runId, mention);
      // Workers may ONLY wake active sibling workers (never reactivate settled/released siblings).
      if (!targetDispatch || !ACTIVE_DISPATCH_STATUSES.has(targetDispatch.status)) {
        effectiveMentions.add(mention);
        continue;
      }

      hasPeerMention = true;
      if (peerMode === 'hub-only') {
        escalatedToCoordinator = true;
        redirectedRoles.push(mention);
        woke.add('coordinator');
        effectiveMentions.add('coordinator');
      } else {
        const exchange = this.host.peerPingPong.recordPeerExchange(
          runId,
          callerRole,
          mention,
          DEFAULT_PEER_PING_PONG_LIMIT
        );
        effectiveMentions.add(mention);
        woke.add(mention);
        if (woke.size === 1 && !exchange.exceeded) {
          singleDirectPeerDispatch = targetDispatch;
        }
        if (exchange.exceeded) {
          escalatedToCoordinator = true;
          woke.add('coordinator');
          effectiveMentions.add('coordinator');
          singleDirectPeerDispatch = null;
        }
      }
    }

    const postKind: OrchestrationBoardPostKind =
      input.kind ?? (hasPeerMention ? 'handoff' : 'post');
    const finalBody =
      redirectedRoles.length > 0
        ? `${text}\n[Hub-only mode: peer handoff to ${redirectedRoles.map((r) => `@${r}`).join(', ')} redirected to @coordinator]`
        : text;
    const toHandle =
      singleDirectPeerDispatch && woke.size === 1
        ? `dispatch:${singleDirectPeerDispatch.id}`
        : `run:${runId}`;

    const msg = this.host.store.insertMessage({
      runId,
      from: caller.activeDispatch ? `dispatch:${caller.activeDispatch.id}` : caller.fromHandle,
      to: toHandle,
      threadId,
      type: postKind === 'handoff' ? 'handoff' : 'status',
      priority: escalatedToCoordinator ? 'high' : 'normal',
      subject: input.subject?.trim() || text.split(/\r?\n/)[0]!.slice(0, 80),
      body: finalBody,
      fromRole: callerRole,
      mentions: effectiveMentions.size > 0 ? [...effectiveMentions] : undefined,
      refs: refs.length > 0 ? refs : undefined,
      kind: postKind,
    });

    const boardSeq = msg.boardSeq ?? this.host.store.getHeadBoardSeq(runId);
    this.host.store.advanceMemberCursor(runId, callerRole, {
      lastPostSeq: boardSeq,
    });
    if (caller.activeDispatch) {
      this.host.store.recordHeartbeat(caller.activeDispatch.id);
    }

    this.notifyBoardPost(runId, msg, [...woke], senderPaneId);
    this.host.emitChanged('board:posted', runId);
    return {
      post: exposeMessage(msg),
      boardSeq,
      headSeq: this.host.store.getHeadBoardSeq(runId),
      woke: [...woke],
      escalatedToCoordinator,
    };
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
    const caller = this.resolveBoardCallerContext({
      from: input.from,
      runId: input.runId,
      isUser: input.isUser,
    });
    const firewall = input.isUser ? null : this.host.getReviewFirewallContext(input.from);
    const posts = this.host.store.listBoardPosts(caller.runId, {
      since: input.since,
      seqs: input.seqs,
      limit: input.limit,
      matches: firewall ? post => !this.host.isPostHiddenByReviewFirewall(post, firewall) : undefined,
    });
    const headSeq = this.host.store.getHeadBoardSeq(caller.runId);
    const isNamedSeqLookup = Boolean(input.seqs && input.seqs.length > 0);
    if (input.markRead !== false && !input.isUser) {
      const ids = posts.map(post => post.id);
      if (isNamedSeqLookup) this.host.store.recordBoardRead(caller.runId, caller.memberKey, ids);
      if (this.host.store.recordBoardReceipt(ids, caller.memberKey, 'delivered')) this.host.emitChanged('board:delivery', caller.runId);
    }
    if (input.markRead !== false && posts.length > 0 && !isNamedSeqLookup) {
      const maxSeq = Math.max(...posts.map((p) => p.boardSeq ?? 0));
      if (maxSeq > 0) {
        this.host.store.advanceMemberCursor(caller.runId, caller.memberKey, {
          lastReadSeq: maxSeq,
          lastDeliveredSeq: maxSeq,
        });
      }
      this.host.store.markAsReadAndDeliveredForConsumer(
        posts.map((p) => p.id),
        caller.fromHandle
      );
    }
    const cursor = this.host.store.getMemberCursor(caller.runId, caller.memberKey);
    const formatted =
      posts.length > 0
        ? posts.map((post) => formatBoardPostForAgent(post)).join('\n\n')
        : '(no board posts)';
    const teamSummary = this.buildBoardTeamSummary(caller.runId);
    return {
      runId: caller.runId,
      headSeq,
      lastReadSeq: cursor.lastReadSeq,
      posts: exposeMessages(this.host.store, posts),
      formatted,
      teamSummary,
    };
  }

  async boardWait(
    input: {
      runId?: string;
      from: string;
      since?: number;
      mentionsOnly?: boolean;
      peek?: boolean;
      timeoutMs?: number;
    },
    signal?: AbortSignal
  ): Promise<{
    runId: string;
    headSeq: number;
    lastReadSeq: number;
    posts: OrchestrationExposedMessage[];
    formatted: string;
    teamSummary: string;
    timedOut: boolean;
    cancelled: boolean;
  }> {
    const caller = this.resolveBoardCallerContext({
      from: input.from,
      runId: input.runId,
    });
    const runId = caller.runId;
    const mentionsOnly = input.mentionsOnly !== false;
    // A targeted wait can skip general posts that a later full-board wait still needs.
    const readPosition = (position: OrchestrationMemberCursor) => mentionsOnly
      ? Math.max(position.lastReadSeq, position.lastMentionReadSeq ?? 0)
      : position.lastReadSeq;
    const explicitSince =
      typeof input.since === 'number' && Number.isFinite(input.since)
        ? Math.max(0, Math.floor(input.since))
        : undefined;
    const timeoutMs = input.timeoutMs ?? ORCHESTRATION_MESSAGE_WAIT_DEFAULT_TIMEOUT_MS;

    const firewall = this.host.getReviewFirewallContext(input.from);
    const findMatchingBatch = () => this.host.store.listBoardPosts(runId, {
      since: explicitSince ?? readPosition(this.host.store.getMemberCursor(runId, caller.memberKey)),
      limit: 200,
      matches: (post) => {
        if (firewall && this.host.isPostHiddenByReviewFirewall(post, firewall)) return false;
        if (mentionsOnly && explicitSince === undefined && this.host.store.wasBoardPostRead(post.id, caller.memberKey)) return false;
        if (!mentionsOnly) {
          const fromRole = post.fromRole?.trim().replace(/^@+/, '').toLowerCase() ?? '';
          if (fromRole === caller.callerRole || post.fromHandle === caller.fromHandle) {
            return false;
          }
          if (caller.activeDispatch && post.fromHandle === `dispatch:${caller.activeDispatch.id}`) {
            return false;
          }
          return true;
        }
        return this.doesBoardPostWakeMember(
          post,
          caller.callerRole,
          caller.fromHandle,
          runId,
          caller.activeDispatch?.id
        );
      },
    });

    const buildReturn = (
      posts: OrchestrationMessageRecord[],
      flags: { timedOut: boolean; cancelled: boolean }
    ) => {
      if (!input.peek && posts.length > 0) {
        const maxSeq = Math.max(...posts.map((p) => p.boardSeq ?? 0));
        if (maxSeq > 0) {
          this.host.store.advanceMemberCursor(runId, caller.memberKey, {
            ...(mentionsOnly ? { lastMentionReadSeq: maxSeq } : { lastReadSeq: maxSeq }),
            lastDeliveredSeq: maxSeq,
          });
        }
        this.host.store.recordBoardReceipt(posts.map(p => p.id), caller.memberKey, 'delivered');
        this.host.store.markAsReadAndDeliveredForConsumer(
          posts.map((p) => p.id),
          caller.fromHandle
        );
        this.host.emitChanged('board:read', runId);
      }
      const nextCursor = this.host.store.getMemberCursor(runId, caller.memberKey);
      const formatted =
        posts.length > 0
          ? posts.map((post) => formatBoardPostForAgent(post)).join('\n\n')
          : '';
      return {
        runId,
        headSeq: this.host.store.getHeadBoardSeq(runId),
        lastReadSeq: readPosition(nextCursor),
        posts: exposeMessages(this.host.store, posts),
        formatted,
        teamSummary: this.buildBoardTeamSummary(runId),
        timedOut: flags.timedOut,
        cancelled: flags.cancelled,
      };
    };

    const deadline = Date.now() + timeoutMs;
    while (true) {
      const ready = findMatchingBatch();
      if (ready.length || input.peek) {
        return buildReturn(ready, { timedOut: false, cancelled: false });
      }
      if (signal?.aborted) {
        return buildReturn([], { timedOut: false, cancelled: true });
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        return buildReturn([], { timedOut: true, cancelled: false });
      }

      const internalAbort = new AbortController();
      const onExternalAbort = () => internalAbort.abort();
      signal?.addEventListener('abort', onExternalAbort, { once: true });

      const handles = [
        `board:${runId}:role:${caller.callerRole}`,
        `board-pane:${caller.fromHandle}`,
      ];
      if (!mentionsOnly) {
        handles.push(`board:${runId}:all`);
      }

      let outcome: MessageWake | 'timed_out' | 'cancelled';
      try {
        outcome = await Promise.race(
          handles.map((handle) =>
            this.host.waiters.wait(handle, {
              timeoutMs: remaining,
              signal: internalAbort.signal,
              consumerHandle: caller.fromHandle,
            })
          )
        );
      } finally {
        signal?.removeEventListener('abort', onExternalAbort);
        internalAbort.abort();
      }

      if (outcome === 'cancelled') {
        return buildReturn([], { timedOut: false, cancelled: true });
      }
      if (outcome === 'timed_out') {
        const lastCheck = findMatchingBatch();
        if (lastCheck.length) {
          return buildReturn(lastCheck, { timedOut: false, cancelled: false });
        }
        return buildReturn([], { timedOut: true, cancelled: false });
      }
    }
  }

  consumeMidTurnBoardInjections(ptyId: string): string | null {
    const member = this.resolveBoardMemberForPane(ptyId);
    if (!member) return null;
    const matched = this.findUndeliveredBoardPostsForPane(ptyId);
    if (matched.length === 0) return null;

    const maxDelivered = Math.max(...matched.map((p) => p.boardSeq ?? 0));
    if (maxDelivered > 0) {
      this.host.store.advanceMemberCursor(member.runId, member.memberKey, {
        lastDeliveredSeq: maxDelivered,
      });
    }
    this.host.store.markAsDeliveredForConsumer(
      matched.map((p) => p.id),
      ptyId
    );

    const MAX_CHARS = 1_200;
    const header = `[AhaStation Board Update — @${member.role}]`;
    const body = matched.map((p) => formatBoardPostForAgent(p)).join('\n\n');
    const full = `${header}\n${body}`;
    if (full.length <= MAX_CHARS) {
      const ids = matched.map(post => post.id);
      this.host.store.recordBoardRead(member.runId, member.memberKey, ids);
      this.host.store.recordBoardReceipt(ids, member.memberKey, 'delivered');
      return full;
    }
    const suffix = `\n… (call ${boardLookupCommands(matched) ?? 'read_board'} for full details)`;
    const budget = Math.max(0, MAX_CHARS - suffix.length);
    return `${full.slice(0, budget).trimEnd()}${suffix}`;
  }

  private listCoordinatorReadUnansweredQuestions(
    runId: string,
    pendingQuestions?: readonly OrchestrationQuestionRecord[]
  ): OrchestrationQuestionRecord[] {
    const pending = pendingQuestions ?? this.host.store.listQuestions({ runId, status: 'pending' });
    const runMailbox = `run:${runId}`;
    // Broad read_board calls advance the cursor without recording exact reads, so a post counts
    // as seen when it was either read exactly or lies within the coordinator's broad-read cursor.
    const coordinatorCursor = this.host.store.getMemberCursor(runId, 'coordinator');
    return pending.filter((question) => {
      if (question.toHandle !== runMailbox) return false;
      if (this.host.store.wasBoardPostRead(question.messageId, 'coordinator')) return true;
      const boardSeq = this.host.store.getMessageById(question.messageId)?.boardSeq;
      return typeof boardSeq === 'number' && boardSeq <= coordinatorCursor.lastReadSeq;
    });
  }

  inspectRunsForStallWatchdog(): BoardStallRunState[] {
    const states: BoardStallRunState[] = [];
    for (const run of this.host.store.listRuns({ status: 'active' })) {
      const dispatches = this.host.store.listDispatches({ runId: run.id });
      const headDispatches = new Map<string, OrchestrationDispatchRecord>();
      for (const d of dispatches) {
        const head = this.host.store.resolveDispatchLineage(d.id) ?? d;
        headDispatches.set(head.id, head);
      }
      const heads = [...headDispatches.values()];
      let hasActiveWorkers = false;
      let hasSettledOrWaitingWorkers = false;
      for (const d of heads) {
        const stage = this.host.deriveLiveStage(d);
        if (ACTIVE_DISPATCH_STATUSES.has(d.status) && (stage === 'starting' || stage === 'working')) {
          hasActiveWorkers = true;
        } else {
          hasSettledOrWaitingWorkers = true;
        }
      }

      const pendingQuestions = this.host.store.listQuestions({ runId: run.id, status: 'pending' });
      const coordinatorReadUnanswered = new Set(
        this.listCoordinatorReadUnansweredQuestions(run.id, pendingQuestions).map((question) => question.messageId)
      );
      const hasPendingStoreQuestion = pendingQuestions.some(
        (question) => !coordinatorReadUnanswered.has(question.messageId)
      );
      const hasPendingAttention =
        this.host.approvals.listOpenApprovals({ runId: run.id }).length > 0 ||
        this.host.nativeQuestions.listOpenQuestions({ runId: run.id }).length > 0 ||
        hasPendingStoreQuestion ||
        this.host.store.listGates({ runId: run.id, status: 'pending' }).length > 0 ||
        this.host.proposals.listPendingProposals({ runId: run.id }).length > 0;

      const coordPaneId = run.coordinatorPaneId;
      const coordStatus = coordPaneId ? this.host.agentStatusStore.get(coordPaneId) : null;
      const coordSession = coordPaneId ? this.host.sessionCoordinator(coordPaneId) : null;
      const coordinatorIdle = coordSession?.active
        ? coordSession.idle === true
        : !coordStatus || coordStatus.state === 'idle' || coordStatus.state === 'done';
      const coordinatorHasWaiter = Boolean(
        (coordPaneId &&
          (this.host.waiters.hasActiveWaiterFor(coordPaneId) ||
            this.host.waiters.hasActiveWaiterFor(`board-pane:${coordPaneId}`))) ||
          this.host.waiters.hasActiveWaiterFor(`run:${run.id}`) ||
          this.host.waiters.hasActiveWaiterFor(`board:${run.id}:role:coordinator`)
      );

      const latestPosts = this.host.store.listBoardPosts(run.id, { limit: 1 });
      const lastPost = latestPosts[latestPosts.length - 1];
      const headSeq = this.host.store.getHeadBoardSeq(run.id);
      const lastPostAtMs = lastPost ? Date.parse(lastPost.createdAt) : Date.parse(run.updatedAt);
      const lastPostIsDone = Boolean(
        lastPost &&
          (/\[\s*done\s*\]/i.test(lastPost.body) ||
            lastPost.kind === 'stall')
      );

      states.push({
        runId: run.id,
        coordinatorPaneId: coordPaneId,
        coordinatorIdle,
        coordinatorHasWaiter,
        hasActiveWorkers,
        hasSettledOrWaitingWorkers,
        hasPendingAttention,
        headSeq,
        lastPostAtMs: Number.isFinite(lastPostAtMs) ? lastPostAtMs : this.host.clock(),
        lastPostIsDone,
      });
    }
    return states;
  }

  handleBoardStallDetected(runId: string, headSeq: number, idleMs: number): void {
    const run = this.host.store.getRun(runId);
    if (!run || run.status !== 'active') return;
    const secs = Math.max(1, Math.round(idleMs / 1000));
    const readUnansweredQuestions = this.listCoordinatorReadUnansweredQuestions(runId);
    const readUnansweredSummary = readUnansweredQuestions
      .map((question) => {
        const boardSeq = this.host.store.getMessageById(question.messageId)?.boardSeq;
        const seqLabel = typeof boardSeq === 'number' ? `#${boardSeq}` : '#?';
        return `${seqLabel} (questionId ${question.messageId})`;
      })
      .join(', ');
    const body = readUnansweredQuestions.length > 0
      ? `@coordinator You already read ${readUnansweredQuestions.length} unanswered question(s): ${readUnansweredSummary}. Answer each with message_worker using its questionId. No active workers and board quiet for ${secs}s since #${headSeq} — review reports, follow up, or wrap up the run.`
      : `@coordinator No active workers and board has been quiet for ${secs}s since #${headSeq}. Review reports, follow up, or wrap up the run.`;
    const msg = this.host.store.insertMessage({
      runId,
      from: 'system',
      to: `run:${runId}`,
      type: 'escalation',
      priority: 'normal',
      subject: `Board stall detected at #${headSeq}`,
      body,
      fromRole: 'system',
      mentions: ['coordinator'],
      refs: headSeq > 0 ? [headSeq] : undefined,
      kind: 'stall',
    });
    this.notifyBoardPost(runId, msg, ['coordinator']);
    this.host.emitChanged('board:stalled', runId);
  }
}
