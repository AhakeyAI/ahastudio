import { ACTIVE_DISPATCH_STATUSES, assertTaskTransition } from './orchestration-lifecycle-graph.js';
import {
  ORCHESTRATION_DELIVERY_BATCH_LIMIT,
  OrchestrationError,
  UNBOUND_RUN_ID,
  type OrchestrationBoardPostKind,
  type OrchestrationDeliveryRecord,
  type OrchestrationGateRecord,
  type OrchestrationGateStatus,
  type OrchestrationMemberCursor,
  type OrchestrationMessagePriority,
  type OrchestrationMessageRecord,
  type OrchestrationMessageType,
  type OrchestrationQuestionRecord,
  type OrchestrationReportArtifacts,
  type OrchestrationTaskStatus,
} from './orchestration-types.js';
import { cloneMessageRecord, generatePrefixedId } from './orchestration-state-repository.js';
import { OrchestrationStoreSlice } from './orchestration-store-slice.js';

export function isBroadcastMailbox(mailboxHandle: string): boolean {
  return (
    mailboxHandle === '@workers' ||
    mailboxHandle === '@all' ||
    mailboxHandle.startsWith('run:')
  );
}

export class OrchestrationMailboxStore extends OrchestrationStoreSlice {
  private allocateBoardSeq(runId: string): number {
    const next = this.state.nextBoardSeqByRun.get(runId) ?? 1;
    this.state.nextBoardSeqByRun.set(runId, next + 1);
    return next;
  }

  getHeadBoardSeq(runId: string): number {
    const next = this.state.nextBoardSeqByRun.get(runId);
    return next && next > 1 ? next - 1 : 0;
  }

  getMemberCursor(runId: string, memberKey: string): OrchestrationMemberCursor {
    const existing = this.state.memberCursorsByRun.get(runId)?.get(memberKey);
    return existing
      ? { ...existing }
      : { lastReadSeq: 0, lastPostSeq: 0, lastDeliveredSeq: 0 };
  }

  advanceMemberCursor(
    runId: string,
    memberKey: string,
    patch: Partial<OrchestrationMemberCursor>
  ): OrchestrationMemberCursor {
    const cleanRunId = runId.trim();
    const cleanKey = memberKey.trim();
    if (!cleanRunId || !cleanKey) {
      return { lastReadSeq: 0, lastPostSeq: 0, lastDeliveredSeq: 0 };
    }
    let memberMap = this.state.memberCursorsByRun.get(cleanRunId);
    if (!memberMap) {
      memberMap = new Map();
      this.state.memberCursorsByRun.set(cleanRunId, memberMap);
    }
    const existing = memberMap.get(cleanKey) ?? {
      lastReadSeq: 0,
      lastPostSeq: 0,
      lastDeliveredSeq: 0,
    };
    const nextRead =
      typeof patch.lastReadSeq === 'number' && Number.isFinite(patch.lastReadSeq)
        ? Math.max(existing.lastReadSeq, Math.floor(patch.lastReadSeq))
        : existing.lastReadSeq;
    const oldMentionRead = existing.lastMentionReadSeq ?? 0;
    const nextMentionRead = typeof patch.lastMentionReadSeq === 'number' && Number.isFinite(patch.lastMentionReadSeq)
      ? Math.max(oldMentionRead, Math.floor(patch.lastMentionReadSeq))
      : oldMentionRead;
    const nextPost =
      typeof patch.lastPostSeq === 'number' && Number.isFinite(patch.lastPostSeq)
        ? Math.max(existing.lastPostSeq, Math.floor(patch.lastPostSeq))
        : existing.lastPostSeq;
    const nextDelivered =
      typeof patch.lastDeliveredSeq === 'number' && Number.isFinite(patch.lastDeliveredSeq)
        ? Math.max(existing.lastDeliveredSeq, Math.floor(patch.lastDeliveredSeq))
        : existing.lastDeliveredSeq;

    const changed =
      !memberMap.has(cleanKey) ||
      nextRead !== existing.lastReadSeq ||
      nextMentionRead !== oldMentionRead ||
      nextPost !== existing.lastPostSeq ||
      nextDelivered !== existing.lastDeliveredSeq;

    const updated: OrchestrationMemberCursor = {
      lastReadSeq: nextRead,
      ...(nextMentionRead > 0 ? { lastMentionReadSeq: nextMentionRead } : {}),
      lastPostSeq: nextPost,
      lastDeliveredSeq: nextDelivered,
    };
    if (changed) {
      memberMap.set(cleanKey, updated);
      this.persist();
    }
    return { ...updated };
  }

  listBoardPosts(
    runId: string,
    opts?: { since?: number; seqs?: readonly number[]; limit?: number; matches?: (post: OrchestrationMessageRecord) => boolean }
  ): OrchestrationMessageRecord[] {
    const since = opts?.since;
    const useSince = !opts?.seqs?.length && typeof since === 'number' && Number.isFinite(since);
    const after = useSince ? Math.max(0, Math.floor(since)) : undefined;
    const allForRun: OrchestrationMessageRecord[] = [];
    for (const id of this.state.messageOrder) {
      const msg = this.state.messages.get(id);
      if (!msg || msg.runId !== runId || msg.type === 'heartbeat') continue;
      if (msg.lifecycleRejectedReason) continue;
      if (typeof msg.boardSeq !== 'number') continue;
      if (after !== undefined && msg.boardSeq <= after) continue;
      if (opts?.matches && !opts.matches(msg)) continue;
      allForRun.push(msg);
    }
    allForRun.sort((a, b) => (a.boardSeq ?? 0) - (b.boardSeq ?? 0));

    if (opts?.seqs && opts.seqs.length > 0) {
      const seqSet = new Set(opts.seqs);
      return allForRun
        .filter((msg) => msg.boardSeq !== undefined && seqSet.has(msg.boardSeq))
        .map(cloneMessageRecord);
    }

    const limit = Math.max(1, Math.min(500, Math.floor(opts?.limit ?? 50)));
    if (after !== undefined) return allForRun.slice(0, limit).map(cloneMessageRecord);

    return allForRun.slice(-limit).map(cloneMessageRecord);
  }

  hasUnreadReportFromDispatch(dispatchId: string): boolean {
    const lineageIds = new Set<string>();
    let curId: string | null = dispatchId;
    while (curId && !lineageIds.has(curId)) {
      lineageIds.add(curId);
      curId = this.state.dispatches.get(curId)?.followUpOfDispatchId ?? null;
    }
    const fromHandles = new Set<string>([...lineageIds].map((id) => `dispatch:${id}`));
    const ctx = this.state.dispatches.get(dispatchId);
    for (const id of this.state.messageOrder) {
      const msg = this.state.messages.get(id);
      if (!msg || msg.read) continue;
      if (isBroadcastMailbox(msg.toHandle) && (this.state.consumerReadByMessageId.get(msg.id)?.size ?? 0) > 0) {
        continue;
      }
      if (
        fromHandles.has(msg.fromHandle) &&
        (msg.type === 'worker_done' || msg.type === 'escalation' || msg.type === 'question')
      ) {
        return true;
      }
      if (msg.type === 'worker_done' && msg.payload) {
        try {
          const parsed = JSON.parse(msg.payload) as { dispatchId?: unknown };
          if (typeof parsed?.dispatchId === 'string' && lineageIds.has(parsed.dispatchId)) {
            return true;
          }
        } catch {
          /* ignore */
        }
      }
      if (
        ctx &&
        msg.runId === ctx.runId &&
        (msg.fromHandle === ctx.assigneeHandle ||
          (ctx.assigneePaneId !== null && msg.fromHandle === ctx.assigneePaneId)) &&
        (msg.type === 'worker_done' || msg.type === 'escalation' || msg.type === 'question')
      ) {
        return true;
      }
    }
    return false;
  }

  // ==================== Decision Gates ====================

  hasPendingGates(taskId: string): boolean {
    for (const gate of this.state.gates.values()) {
      if (gate.taskId === taskId && gate.status === 'pending') {
        return true;
      }
    }
    return false;
  }

  createGate(input: {
    taskId: string;
    question: string;
    options?: string[];
    requesterDispatchId?: string | null;
    requesterHandle?: string | null;
  }): OrchestrationGateRecord {
    const task = this.state.tasks.get(input.taskId);
    if (!task) {
      throw new OrchestrationError('task_not_found', `Task not found: ${input.taskId}`);
    }
    if (task.status === 'completed' || task.status === 'failed') {
      throw new OrchestrationError(
        'invalid_transition',
        `Cannot open decision gate on ${task.status} task ${task.id}.`
      );
    }

    const requesterDispatch = input.requesterDispatchId
      ? this.state.dispatches.get(input.requesterDispatchId)
      : undefined;
    if (input.requesterDispatchId) {
      if (
        !requesterDispatch ||
        requesterDispatch.taskId !== task.id ||
        !ACTIVE_DISPATCH_STATUSES.has(requesterDispatch.status)
      ) {
        throw new OrchestrationError(
          'dispatch_inactive',
          `Dispatch ${input.requesterDispatchId} is not active for task ${task.id}.`
        );
      }
    }

    const now = this.now();
    if (requesterDispatch && ACTIVE_DISPATCH_STATUSES.has(requesterDispatch.status)) {
      this.lifecycle.promoteDispatchObserved(requesterDispatch, now, true);
    }
    const gate: OrchestrationGateRecord = {
      id: generatePrefixedId('gate'),
      taskId: task.id,
      runId: task.runId,
      requesterDispatchId: input.requesterDispatchId ?? null,
      requesterHandle: input.requesterHandle ?? null,
      question: input.question,
      options: [...(input.options ?? [])],
      status: 'pending',
      resolution: null,
      createdAt: now,
      resolvedAt: null,
    };
    this.state.gates.set(gate.id, gate);

    this.lifecycle.settleActiveDispatchesForTask(task.id, 'completed', 'Paused by decision gate');
    if (task.status !== 'blocked') {
      assertTaskTransition(task.id, task.status, 'blocked');
      task.status = 'blocked';
      task.updatedAt = now;
    }

    this.persist();
    return { ...gate, options: [...gate.options] };
  }

  resolveGate(gateId: string, resolution: string): OrchestrationGateRecord {
    const gate = this.state.gates.get(gateId);
    if (!gate) {
      throw new OrchestrationError('gate_not_found', `Decision gate not found: ${gateId}`);
    }
    if (gate.status !== 'pending') {
      throw new OrchestrationError(
        'gate_already_resolved',
        `Decision gate ${gateId} is already ${gate.status}.`,
        { gateId, status: gate.status }
      );
    }
    const now = this.now();
    gate.status = 'resolved';
    gate.resolution = resolution;
    gate.resolvedAt = now;

    const task = this.state.tasks.get(gate.taskId);
    if (task && task.status === 'blocked' && !this.hasPendingGates(task.id)) {
      const depsDone = task.deps.every((depId) => this.state.tasks.get(depId)?.status === 'completed');
      const nextStatus: OrchestrationTaskStatus = depsDone ? 'ready' : 'pending';
      assertTaskTransition(task.id, task.status, nextStatus);
      task.status = nextStatus;
      task.updatedAt = now;
    }

    this.persist();
    return { ...gate, options: [...gate.options] };
  }

  timeoutGate(gateId: string): OrchestrationGateRecord {
    const gate = this.state.gates.get(gateId);
    if (!gate) {
      throw new OrchestrationError('gate_not_found', `Decision gate not found: ${gateId}`);
    }
    if (gate.status !== 'pending') {
      return { ...gate, options: [...gate.options] };
    }
    gate.status = 'timeout';
    gate.resolvedAt = this.now();
    this.persist();
    return { ...gate, options: [...gate.options] };
  }

  getGate(gateId: string): OrchestrationGateRecord | undefined {
    const gate = this.state.gates.get(gateId);
    return gate ? { ...gate, options: [...gate.options] } : undefined;
  }

  listGates(filter?: {
    runId?: string;
    taskId?: string;
    status?: OrchestrationGateStatus;
  }): OrchestrationGateRecord[] {
    return [...this.state.gates.values()]
      .filter((g) => {
        if (filter?.runId && g.runId !== filter.runId) return false;
        if (filter?.taskId && g.taskId !== filter.taskId) return false;
        if (filter?.status && g.status !== filter.status) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((g) => ({ ...g, options: [...g.options] }));
  }

  // ==================== Messages & Mailbox ====================

  insertMessage(input: {
    id?: string;
    runId?: string | null;
    from: string;
    to: string;
    type?: OrchestrationMessageType;
    priority?: OrchestrationMessagePriority;
    subject: string;
    body?: string;
    payload?: string | null;
    threadId?: string | null;
    fromRole?: string;
    mentions?: readonly string[];
    refs?: readonly number[];
    kind?: OrchestrationBoardPostKind;
    artifacts?: OrchestrationReportArtifacts | null;
  }): OrchestrationMessageRecord {
    let runId = input.runId?.trim();
    if (!runId) {
      if (input.to.startsWith('run:')) {
        runId = input.to.slice('run:'.length);
      } else if (input.to.startsWith('dispatch:')) {
        const d = this.state.dispatches.get(input.to.slice('dispatch:'.length));
        runId = d?.runId;
      } else if (input.from.startsWith('dispatch:')) {
        const d = this.state.dispatches.get(input.from.slice('dispatch:'.length));
        runId = d?.runId;
      }
    }
    if (!runId || runId === UNBOUND_RUN_ID) {
      runId = this.lifecycle.ensureUnboundRun().id;
    } else {
      this.lifecycle.requireRun(runId);
    }

    const now = this.now();
    const type: OrchestrationMessageType = input.type ?? 'status';
    const isHeartbeat = type === 'heartbeat';
    if (isHeartbeat) {
      const staleHeartbeats = new Set<string>();
      for (const existing of this.state.messages.values()) {
        if (existing.type === 'heartbeat' && existing.runId === runId && existing.fromHandle === input.from) {
          staleHeartbeats.add(existing.id);
        }
      }
      if (staleHeartbeats.size > 0) {
        this.security.deleteMessageIds(staleHeartbeats);
      }
    }
    const cleanFromRole = input.fromRole?.trim().replace(/^@+/, '') || undefined;
    const cleanMentions = input.mentions
      ? [...new Set(input.mentions.map((m) => m.trim().replace(/^@+/, '').toLowerCase()).filter(Boolean))]
      : undefined;
    const cleanRefs = input.refs
      ? [...new Set(input.refs.filter((r) => Number.isInteger(r) && r > 0))]
      : undefined;
    const msg: OrchestrationMessageRecord = {
      id: input.id?.trim() || generatePrefixedId('msg'),
      runId,
      seq: this.state.nextSequence++,
      ...(!isHeartbeat ? { boardSeq: this.allocateBoardSeq(runId) } : {}),
      type,
      priority: input.priority ?? 'normal',
      fromHandle: input.from,
      toHandle: input.to,
      ...(cleanFromRole ? { fromRole: cleanFromRole } : {}),
      ...(cleanMentions && cleanMentions.length > 0 ? { mentions: cleanMentions } : {}),
      ...(cleanRefs && cleanRefs.length > 0 ? { refs: cleanRefs } : {}),
      ...(input.kind ? { kind: input.kind } : {}),
      ...(input.artifacts !== undefined ? { artifacts: input.artifacts } : {}),
      subject: this.security.redactDispatchCredentials(input.subject),
      body: this.security.redactDispatchCredentials(input.body ?? ''),
      payload: input.payload ?? null,
      threadId: input.threadId ?? null,
      deliveredAt: isHeartbeat ? now : null,
      read: isHeartbeat,
      createdAt: now,
      lifecycleRejectedReason: null,
    };

    this.state.messages.set(msg.id, msg);
    this.state.messageOrder.push(msg.id);
    this.security.prune();
    this.persist();
    return cloneMessageRecord(msg);
  }

  getMessageById(id: string): OrchestrationMessageRecord | undefined {
    const msg = this.state.messages.get(id);
    return msg ? { ...msg } : undefined;
  }

  markLifecycleRejected(messageId: string, reason: string): OrchestrationMessageRecord | undefined {
    const msg = this.state.messages.get(messageId);
    if (!msg) {
      return undefined;
    }
    msg.lifecycleRejectedReason = reason;
    msg.read = true;
    msg.deliveredAt = msg.deliveredAt ?? this.now();
    this.persist();
    return { ...msg };
  }

  /** Moves unread direct mail sent to a pane/handle into its role mailbox (`run:` or `dispatch:`). */
  routeUnreadDirectMessages(
    directHandle: string,
    targetMailboxHandle: string,
    runId?: string
  ): OrchestrationMessageRecord[] {
    if (!directHandle || directHandle === targetMailboxHandle) {
      return [];
    }
    const routed: OrchestrationMessageRecord[] = [];
    for (const id of this.state.messageOrder) {
      const msg = this.state.messages.get(id);
      if (!msg || msg.read) continue;
      if (msg.toHandle !== directHandle) continue;
      if (runId && msg.runId !== runId && msg.runId !== UNBOUND_RUN_ID) continue;
      msg.toHandle = targetMailboxHandle;
      if (runId && msg.runId === UNBOUND_RUN_ID) {
        msg.runId = runId;
      }
      routed.push({ ...msg });
    }
    if (routed.length > 0) {
      this.persist();
    }
    return routed;
  }

  /** Forward leftover unread mail from a closed dispatch mailbox up to the owning run mailbox. */
  routeUnreadDispatchMailboxToRun(dispatchId: string, runId: string): OrchestrationMessageRecord[] {
    const fromMailbox = `dispatch:${dispatchId}`;
    const toMailbox = `run:${runId}`;
    const routed: OrchestrationMessageRecord[] = [];
    for (const id of this.state.messageOrder) {
      const msg = this.state.messages.get(id);
      if (!msg || msg.read) continue;
      if (msg.toHandle !== fromMailbox) continue;
      msg.toHandle = toMailbox;
      msg.deliveredAt = null;
      routed.push({ ...msg });
    }
    if (routed.length > 0) {
      this.persist();
    }
    return routed;
  }

  private isMessageReadByConsumer(msg: OrchestrationMessageRecord, consumerHandle?: string): boolean {
    if (msg.read) return true;
    if (consumerHandle && isBroadcastMailbox(msg.toHandle)) {
      return this.state.consumerReadByMessageId.get(msg.id)?.has(consumerHandle) ?? false;
    }
    return false;
  }

  private isMessageDeliveredToConsumer(
    msg: OrchestrationMessageRecord,
    consumerHandle?: string
  ): boolean {
    if (consumerHandle && isBroadcastMailbox(msg.toHandle)) {
      return (
        (this.state.consumerDeliveredByMessageId.get(msg.id)?.has(consumerHandle) ?? false) ||
        (this.state.consumerReadByMessageId.get(msg.id)?.has(consumerHandle) ?? false)
      );
    }
    return msg.deliveredAt !== null;
  }

  getUnreadMessages(
    mailboxHandle: string,
    options?: {
      types?: readonly OrchestrationMessageType[];
      excludeTypes?: readonly OrchestrationMessageType[];
      excludeIds?: readonly string[];
      consumerHandle?: string;
      limit?: number;
    }
  ): OrchestrationMessageRecord[] {
    const typeSet = options?.types?.length ? new Set(options.types) : null;
    const excludeTypeSet = options?.excludeTypes?.length ? new Set(options.excludeTypes) : null;
    const excludeIdSet = options?.excludeIds?.length ? new Set(options.excludeIds) : null;
    const limit = options?.limit ?? ORCHESTRATION_DELIVERY_BATCH_LIMIT;

    const results: OrchestrationMessageRecord[] = [];
    for (const id of this.state.messageOrder) {
      const msg = this.state.messages.get(id);
      if (!msg || this.isMessageReadByConsumer(msg, options?.consumerHandle)) continue;
      if (msg.toHandle !== mailboxHandle) continue;
      if (typeSet && !typeSet.has(msg.type)) continue;
      if (excludeTypeSet && excludeTypeSet.has(msg.type)) continue;
      if (excludeIdSet && excludeIdSet.has(msg.id)) continue;
      results.push({ ...msg });
      if (results.length >= limit) break;
    }
    return results;
  }

  getUndeliveredUnreadMessages(
    mailboxHandle: string,
    options?: {
      types?: readonly OrchestrationMessageType[];
      excludeTypes?: readonly OrchestrationMessageType[];
      excludeIds?: readonly string[];
      consumerHandle?: string;
      limit?: number;
    }
  ): OrchestrationMessageRecord[] {
    return this.getUnreadMessages(mailboxHandle, options).filter(
      (m) => !this.isMessageDeliveredToConsumer(m, options?.consumerHandle)
    );
  }

  getAllMessagesForHandle(
    mailboxHandle: string,
    options?: {
      types?: readonly OrchestrationMessageType[];
      limit?: number;
    }
  ): OrchestrationMessageRecord[] {
    const typeSet = options?.types?.length ? new Set(options.types) : null;
    const limit = options?.limit ?? 100;
    const matches: OrchestrationMessageRecord[] = [];
    for (let i = this.state.messageOrder.length - 1; i >= 0; i--) {
      const msg = this.state.messages.get(this.state.messageOrder[i]!);
      if (!msg || msg.toHandle !== mailboxHandle) continue;
      if (typeSet && !typeSet.has(msg.type)) continue;
      matches.push({ ...msg });
      if (matches.length >= limit) break;
    }
    return matches.reverse();
  }

  listMessages(filter?: {
    runId?: string;
    toHandle?: string;
    fromHandle?: string;
    type?: OrchestrationMessageType;
    unreadOnly?: boolean;
    limit?: number;
  }): OrchestrationMessageRecord[] {
    const limit = filter?.limit ?? 200;
    const list: OrchestrationMessageRecord[] = [];
    for (const id of this.state.messageOrder) {
      const msg = this.state.messages.get(id);
      if (!msg) continue;
      if (filter?.runId && msg.runId !== filter.runId) continue;
      if (filter?.toHandle && msg.toHandle !== filter.toHandle) continue;
      if (filter?.fromHandle && msg.fromHandle !== filter.fromHandle) continue;
      if (filter?.type && msg.type !== filter.type) continue;
      if (filter?.unreadOnly && msg.read) continue;
      list.push({ ...msg });
    }
    return list.length > limit ? list.slice(list.length - limit) : list;
  }

  markAsRead(messageIds: readonly string[]): void {
    const now = this.now();
    let changed = false;
    for (const id of messageIds) {
      const msg = this.state.messages.get(id);
      if (msg && !msg.read) {
        msg.read = true;
        msg.deliveredAt = msg.deliveredAt ?? now;
        changed = true;
      }
    }
    if (changed) {
      this.security.prune();
      this.persist();
    }
  }

  markAsDelivered(messageIds: readonly string[]): void {
    const now = this.now();
    let changed = false;
    for (const id of messageIds) {
      const msg = this.state.messages.get(id);
      if (msg && msg.deliveredAt === null) {
        msg.deliveredAt = now;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  markAsUndelivered(messageIds: readonly string[]): void {
    let changed = false;
    for (const id of messageIds) {
      const msg = this.state.messages.get(id);
      if (msg && !msg.read && msg.deliveredAt !== null) {
        msg.deliveredAt = null;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  markAsReadAndDelivered(messageIds: readonly string[]): void {
    const now = this.now();
    let changed = false;
    for (const id of messageIds) {
      const msg = this.state.messages.get(id);
      if (msg && (!msg.read || msg.deliveredAt === null)) {
        msg.read = true;
        msg.deliveredAt = msg.deliveredAt ?? now;
        changed = true;
      }
    }
    if (changed) {
      this.security.prune();
      this.persist();
    }
  }

  /** Exact content reads can arrive out of order. A pointer alone never consumes its posts. */
  recordBoardRead(runId: string, role: string, ids: readonly string[]): void {
    const key = role.trim().replace(/^@+/, '').toLowerCase();
    if (!key) return;
    let changed = false;
    for (const id of ids) {
      const message = this.state.messages.get(id);
      if (message?.runId !== runId || !message.boardSeq) continue;
      const readers = this.state.boardReadersByMessageId.get(id) ?? new Set<string>();
      if (readers.has(key)) continue;
      readers.add(key);
      this.state.boardReadersByMessageId.set(id, readers);
      changed = true;
    }
    if (changed) this.persist();
  }

  wasBoardPostRead(id: string, role: string): boolean {
    const key = role.trim().replace(/^@+/, '').toLowerCase();
    return key ? (this.state.boardReadersByMessageId.get(id)?.has(key) ?? false) : false;
  }

  recordBoardReceipt(ids: readonly string[], role: string, state: 'notified' | 'delivered' | 'replied'): boolean {
    const key = role.replace(/^@+/, '').toLowerCase();
    const rank = { notified: 1, delivered: 2, replied: 3 };
    let changed = false;
    for (const id of ids) {
      const msg = this.state.messages.get(id);
      if (!msg?.mentions?.some(m => m.replace(/^@+/, '').toLowerCase() === key)) continue;
      const current = msg.receipts?.[key];
      if (current && rank[current] >= rank[state]) continue;
      msg.receipts = { ...msg.receipts, [key]: state };
      changed = true;
    }
    if (changed) this.persist();
    return changed;
  }

  markAsDeliveredForConsumer(messageIds: readonly string[], consumerHandle: string): void {
    const now = this.now();
    let changed = false;
    for (const id of messageIds) {
      const msg = this.state.messages.get(id);
      if (!msg) continue;
      if (isBroadcastMailbox(msg.toHandle)) {
        let set = this.state.consumerDeliveredByMessageId.get(id);
        if (!set) {
          set = new Set();
          this.state.consumerDeliveredByMessageId.set(id, set);
        }
        if (!set.has(consumerHandle)) {
          set.add(consumerHandle);
          changed = true;
        }
      } else if (msg.deliveredAt === null) {
        msg.deliveredAt = now;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  markAsUndeliveredForConsumer(messageIds: readonly string[], consumerHandle: string): void {
    let changed = false;
    for (const id of messageIds) {
      const msg = this.state.messages.get(id);
      if (!msg) continue;
      if (isBroadcastMailbox(msg.toHandle)) {
        const set = this.state.consumerDeliveredByMessageId.get(id);
        if (set?.delete(consumerHandle)) {
          if (set.size === 0) {
            this.state.consumerDeliveredByMessageId.delete(id);
          }
          changed = true;
        }
      } else if (!msg.read && msg.deliveredAt !== null) {
        msg.deliveredAt = null;
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }

  markAsReadAndDeliveredForConsumer(messageIds: readonly string[], consumerHandle: string): void {
    const now = this.now();
    let changed = false;
    for (const id of messageIds) {
      const msg = this.state.messages.get(id);
      if (!msg) continue;
      if (isBroadcastMailbox(msg.toHandle)) {
        let readSet = this.state.consumerReadByMessageId.get(id);
        if (!readSet) {
          readSet = new Set();
          this.state.consumerReadByMessageId.set(id, readSet);
        }
        if (!readSet.has(consumerHandle)) {
          readSet.add(consumerHandle);
          changed = true;
        }
        let dlvSet = this.state.consumerDeliveredByMessageId.get(id);
        if (!dlvSet) {
          dlvSet = new Set();
          this.state.consumerDeliveredByMessageId.set(id, dlvSet);
        }
        if (!dlvSet.has(consumerHandle)) {
          dlvSet.add(consumerHandle);
          changed = true;
        }
      } else if (!msg.read || msg.deliveredAt === null) {
        msg.read = true;
        msg.deliveredAt = msg.deliveredAt ?? now;
        changed = true;
      }
    }
    if (changed) {
      this.security.prune();
      this.persist();
    }
  }

  areUnreadMessages(mailboxHandle: string, messageIds: readonly string[]): boolean {
    return messageIds.every((id) => {
      const m = this.state.messages.get(id);
      return m !== undefined && m.toHandle === mailboxHandle && !m.read;
    });
  }

  getOutstandingDelivery(
    mailboxHandle: string,
    consumerHandle?: string
  ): OrchestrationDeliveryRecord | undefined {
    for (const d of this.state.deliveries.values()) {
      if (d.mailboxHandle !== mailboxHandle || d.status !== 'pending') continue;
      if (consumerHandle && d.consumerHandle && d.consumerHandle !== consumerHandle) {
        continue;
      }
      return { ...d, messageIds: [...d.messageIds] };
    }
    return undefined;
  }

  getDelivery(deliveryId: string): OrchestrationDeliveryRecord | undefined {
    const d = this.state.deliveries.get(deliveryId);
    return d ? { ...d, messageIds: [...d.messageIds] } : undefined;
  }

  takeMailboxDelivery(input: {
    runId: string;
    mailboxHandle: string;
    consumerHandle?: string;
    consumerGeneration: number;
    types?: readonly OrchestrationMessageType[];
    holdAck?: boolean;
    limit?: number;
  }): {
    delivery: OrchestrationDeliveryRecord;
    messages: OrchestrationMessageRecord[];
    replayed: boolean;
  } | undefined {
    if (input.mailboxHandle.startsWith('run:')) {
      const run = this.state.runs.get(input.runId);
      if (run && run.consumerGeneration !== input.consumerGeneration) {
        throw new OrchestrationError(
          'consumer_fenced',
          `Consumer generation ${input.consumerGeneration} for ${input.mailboxHandle} is fenced (current: ${run.consumerGeneration}).`
        );
      }
    }

    const perConsumerBroadcast =
      isBroadcastMailbox(input.mailboxHandle) && Boolean(input.consumerHandle);
    const outstanding = this.getOutstandingDelivery(input.mailboxHandle, input.consumerHandle);
    if (outstanding) {
      if (outstanding.consumerGeneration !== input.consumerGeneration) {
        throw new OrchestrationError(
          'consumer_fenced',
          `Outstanding delivery ${outstanding.id} belongs to consumer generation ${outstanding.consumerGeneration}, not ${input.consumerGeneration}.`
        );
      }
      const msgs = outstanding.messageIds
        .map((id) => this.state.messages.get(id))
        .filter((m): m is OrchestrationMessageRecord => m !== undefined)
        .map((m) => ({ ...m }));
      if (!input.holdAck) {
        const stored = this.state.deliveries.get(outstanding.id)!;
        stored.status = 'acknowledged';
        stored.acknowledgedAt = this.now();
        if (perConsumerBroadcast) {
          this.markAsReadAndDeliveredForConsumer(outstanding.messageIds, input.consumerHandle!);
        } else {
          this.markAsReadAndDelivered(outstanding.messageIds);
        }
        this.persist();
        return { delivery: { ...stored, messageIds: [...stored.messageIds] }, messages: msgs, replayed: true };
      }
      return { delivery: outstanding, messages: msgs, replayed: true };
    }

    const unread = this.getUnreadMessages(input.mailboxHandle, {
      types: input.types,
      consumerHandle: input.consumerHandle,
      limit: input.limit ?? ORCHESTRATION_DELIVERY_BATCH_LIMIT,
    });
    if (unread.length === 0) {
      return undefined;
    }

    const now = this.now();
    const messageIds = unread.map((m) => m.id);
    const delivery: OrchestrationDeliveryRecord = {
      id: generatePrefixedId('dlv'),
      runId: input.runId,
      mailboxHandle: input.mailboxHandle,
      ...(input.consumerHandle ? { consumerHandle: input.consumerHandle } : {}),
      messageIds,
      status: input.holdAck ? 'pending' : 'acknowledged',
      consumerGeneration: input.consumerGeneration,
      createdAt: now,
      acknowledgedAt: input.holdAck ? null : now,
    };
    this.state.deliveries.set(delivery.id, delivery);
    if (perConsumerBroadcast) {
      if (input.holdAck) {
        this.markAsDeliveredForConsumer(messageIds, input.consumerHandle!);
      } else {
        this.markAsReadAndDeliveredForConsumer(messageIds, input.consumerHandle!);
      }
    } else if (input.holdAck) {
      this.markAsDelivered(messageIds);
    } else {
      this.markAsReadAndDelivered(messageIds);
    }
    this.persist();
    return {
      delivery: { ...delivery, messageIds: [...delivery.messageIds] },
      messages: unread,
      replayed: false,
    };
  }

  acknowledgeDelivery(
    deliveryId: string,
    expectedMailboxHandle?: string,
    expectedConsumerGeneration?: number,
    expectedConsumerHandle?: string
  ): OrchestrationDeliveryRecord {
    const d = this.state.deliveries.get(deliveryId);
    if (!d) {
      throw new OrchestrationError('delivery_not_found', `Delivery not found: ${deliveryId}`);
    }
    const isSharedBroadcastTarget =
      (d.mailboxHandle === '@workers' || d.mailboxHandle === '@all') && Boolean(d.consumerHandle);
    if (isSharedBroadcastTarget) {
      if (expectedConsumerHandle && d.consumerHandle !== expectedConsumerHandle) {
        throw new OrchestrationError(
          'delivery_not_found',
          `Delivery ${deliveryId} does not belong to consumer ${expectedConsumerHandle}.`
        );
      }
    } else {
      if (expectedMailboxHandle && d.mailboxHandle !== expectedMailboxHandle) {
        throw new OrchestrationError(
          'stale_delivery',
          `Delivery ${deliveryId} belongs to ${d.mailboxHandle}, not ${expectedMailboxHandle}.`
        );
      }
      if (expectedConsumerHandle && d.consumerHandle && d.consumerHandle !== expectedConsumerHandle) {
        throw new OrchestrationError(
          'delivery_not_found',
          `Delivery ${deliveryId} does not belong to consumer ${expectedConsumerHandle}.`
        );
      }
    }
    const activeRun = d.mailboxHandle.startsWith('run:') ? this.state.runs.get(d.runId) : undefined;
    if (
      d.status === 'fenced' ||
      (expectedConsumerGeneration !== undefined &&
        d.consumerGeneration !== expectedConsumerGeneration) ||
      (activeRun && d.consumerGeneration !== activeRun.consumerGeneration)
    ) {
      throw new OrchestrationError(
        'consumer_fenced',
        `Delivery ${deliveryId} belongs to a fenced consumer generation.`
      );
    }
    if (d.status !== 'acknowledged') {
      d.status = 'acknowledged';
      d.acknowledgedAt = this.now();
      if (isBroadcastMailbox(d.mailboxHandle) && d.consumerHandle) {
        this.markAsReadAndDeliveredForConsumer(d.messageIds, d.consumerHandle);
      } else {
        this.markAsReadAndDelivered(d.messageIds);
      }
      this.security.prune();
      this.persist();
    }
    return { ...d, messageIds: [...d.messageIds] };
  }

  acknowledgeDeliveriesForMessages(
    messageIds: readonly string[],
    consumerHandle?: string
  ): number {
    if (messageIds.length === 0) return 0;
    const idSet = new Set(messageIds);
    const now = this.now();
    let count = 0;
    for (const d of this.state.deliveries.values()) {
      if (d.status !== 'pending') continue;
      if (consumerHandle && d.consumerHandle && d.consumerHandle !== consumerHandle) continue;
      if (!d.messageIds.some((id) => idSet.has(id))) continue;
      const allRead = d.messageIds.every((id) => {
        const msg = this.state.messages.get(id);
        return !msg || this.isMessageReadByConsumer(msg, d.consumerHandle);
      });
      if (!allRead) continue;
      d.status = 'acknowledged';
      d.acknowledgedAt = now;
      count += 1;
    }
    if (count > 0) {
      this.security.prune();
      this.persist();
    }
    return count;
  }

  getThreadMessages(threadId: string): OrchestrationMessageRecord[] {
    const result: OrchestrationMessageRecord[] = [];
    for (const id of this.state.messageOrder) {
      const m = this.state.messages.get(id);
      if (m && (m.id === threadId || m.threadId === threadId)) {
        result.push({ ...m });
      }
    }
    return result;
  }

  // ==================== Questions ====================

  createQuestion(input: {
    messageId: string;
    runId: string;
    dispatchId: string;
    fromHandle: string;
    toHandle: string;
    question: string;
    options?: string[];
  }): OrchestrationQuestionRecord {
    const now = this.now();
    const dispatch = this.state.dispatches.get(input.dispatchId);
    if (dispatch && ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      this.lifecycle.promoteDispatchObserved(dispatch, now, true);
    }
    const q: OrchestrationQuestionRecord = {
      messageId: input.messageId,
      runId: input.runId,
      dispatchId: input.dispatchId,
      fromHandle: input.fromHandle,
      toHandle: input.toHandle,
      question: input.question,
      options: [...(input.options ?? [])],
      status: 'pending',
      answerBody: null,
      answerMessageId: null,
      answeredBy: null,
      createdAt: now,
      answeredAt: null,
    };
    this.state.questions.set(q.messageId, q);
    this.persist();
    return { ...q, options: [...q.options] };
  }

  getQuestion(messageId: string): OrchestrationQuestionRecord | undefined {
    const q = this.state.questions.get(messageId);
    return q ? { ...q, options: [...q.options] } : undefined;
  }

  listQuestions(filter?: {
    runId?: string;
    dispatchId?: string;
    status?: OrchestrationQuestionRecord['status'];
  }): OrchestrationQuestionRecord[] {
    return [...this.state.questions.values()]
      .filter((q) => {
        if (filter?.runId && q.runId !== filter.runId) return false;
        if (filter?.dispatchId && q.dispatchId !== filter.dispatchId) return false;
        if (filter?.status && q.status !== filter.status) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((q) => ({ ...q, options: [...q.options] }));
  }

  answerQuestion(input: {
    messageId: string;
    answeredBy: string;
    body: string;
    fromRole?: string;
    mentions?: readonly string[];
    refs?: readonly number[];
  }): {
    question: OrchestrationQuestionRecord;
    message: OrchestrationMessageRecord;
    duplicate: boolean;
  } {
    const q = this.state.questions.get(input.messageId);
    if (!q) {
      throw new OrchestrationError('not_found', `Question not found: ${input.messageId}`);
    }
    if (q.status === 'closed') {
      throw new OrchestrationError(
        'dispatch_inactive',
        `Question ${q.messageId} is closed because dispatch ${q.dispatchId} ended.`
      );
    }
    if (q.status === 'answered') {
      if ((q.answerBody ?? '').trim() === input.body.trim()) {
        const existingMsg = q.answerMessageId
          ? this.getMessageById(q.answerMessageId)
          : undefined;
        return {
          question: { ...q, options: [...q.options] },
          message:
            existingMsg ??
            this.insertMessage({
              runId: q.runId,
              from: input.answeredBy,
              to: `dispatch:${q.dispatchId}`,
              type: 'status',
              subject: `Re: ${q.question.slice(0, 60)}`,
              body: input.body,
              threadId: q.messageId,
              fromRole: input.fromRole,
              mentions: input.mentions,
              refs: input.refs,
              kind: 'answer',
            }),
          duplicate: true,
        };
      }
      throw new OrchestrationError(
        'answer_conflict',
        `Question ${q.messageId} was already answered differently by ${q.answeredBy}.`,
        { messageId: q.messageId, existingAnswer: q.answerBody }
      );
    }

    const answerMsg = this.insertMessage({
      runId: q.runId,
      from: input.answeredBy,
      to: `dispatch:${q.dispatchId}`,
      type: 'status',
      priority: 'high',
      subject: `Answer to question ${q.messageId}`,
      body: input.body,
      threadId: q.messageId,
      fromRole: input.fromRole,
      mentions: input.mentions,
      refs: input.refs,
      kind: 'answer',
    });
    this.markAsRead([q.messageId]);
    this.acknowledgeDeliveriesForMessages([q.messageId]);

    q.status = 'answered';
    q.answerBody = input.body;
    q.answerMessageId = answerMsg.id;
    q.answeredBy = input.answeredBy;
    if (input.fromRole) this.recordBoardReceipt([q.messageId], input.fromRole, 'replied');
    q.answeredAt = this.now();
    this.persist();
    return {
      question: { ...q, options: [...q.options] },
      message: { ...answerMsg },
      duplicate: false,
    };
  }

  closeQuestionsForDispatch(dispatchId: string): void {
    let changed = false;
    for (const q of this.state.questions.values()) {
      if (q.dispatchId === dispatchId && q.status === 'pending') {
        q.status = 'closed';
        changed = true;
      }
    }
    if (changed) {
      this.persist();
    }
  }
}
