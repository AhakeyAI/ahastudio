import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer.js';
import { cloneTaskContext } from './worker-brief-context.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import { mapTimelineStrings } from './worker-timeline.js';
import { listActiveDeferredPrompts, redactDispatchCredentialText, toDeferredPromptTemplate } from './orchestration-security-store.js';
import type {
  OrchestrationCoordinatorRunRecord,
  OrchestrationDeliveryRecord,
  OrchestrationDispatchRecord,
  OrchestrationDispatchStage,
  OrchestrationGateRecord,
  OrchestrationMemberCursor,
  OrchestrationMessageRecord,
  OrchestrationPersistedState,
  OrchestrationQuestionRecord,
  OrchestrationRunRecord,
  OrchestrationTaskRecord,
} from './orchestration-types.js';

export interface DeferredDispatchPrompt {
  ptyId: string;
  prompt: string;
  submit: boolean;
}

/** In-memory orchestration state shared by every sub-store. */
export class OrchestrationStoreState {
  nextSequence = 1;
  currentRunByConsumer = new Map<string, string>();
  runs = new Map<string, OrchestrationRunRecord>();
  tasks = new Map<string, OrchestrationTaskRecord>();
  dispatches = new Map<string, OrchestrationDispatchRecord>();
  gates = new Map<string, OrchestrationGateRecord>();
  messages = new Map<string, OrchestrationMessageRecord>();
  messageOrder: string[] = [];
  deliveries = new Map<string, OrchestrationDeliveryRecord>();
  readonly boardReadersByMessageId = new Map<string, Set<string>>();
  consumerReadByMessageId = new Map<string, Set<string>>();
  consumerDeliveredByMessageId = new Map<string, Set<string>>();
  questions = new Map<string, OrchestrationQuestionRecord>();
  coordinatorRuns = new Map<string, OrchestrationCoordinatorRunRecord>();
  dispatchCapabilities = new Map<string, string>();
  readonly deferredPrompts = new Map<string, DeferredDispatchPrompt>();
  nextBoardSeqByRun = new Map<string, number>();
  memberCursorsByRun = new Map<string, Map<string, OrchestrationMemberCursor>>();
}

export function emptyPersistedState(): OrchestrationPersistedState {
  return {
    version: 1,
    nextSequence: 1,
    currentRunByConsumer: {},
    runs: [],
    tasks: [],
    dispatches: [],
    gates: [],
    messages: [],
    deliveries: [],
    consumerReadByMessageId: {},
    consumerDeliveredByMessageId: {},
    questions: [],
    coordinatorRuns: [],
    capabilities: {},
    nextBoardSeqByRun: {},
    memberCursorsByRun: {},
  };
}

export function cloneMessageRecord(msg: OrchestrationMessageRecord): OrchestrationMessageRecord {
  return {
    ...msg,
    ...(msg.receipts ? { receipts: { ...msg.receipts } } : {}),
    ...(msg.mentions ? { mentions: [...msg.mentions] } : {}),
    ...(msg.refs ? { refs: [...msg.refs] } : {}),
    ...(msg.artifacts
      ? {
          artifacts: {
            ...msg.artifacts,
            ...(msg.artifacts.changedFiles ? { changedFiles: [...msg.artifacts.changedFiles] } : {}),
          },
        }
      : {}),
  };
}

export function cloneRunRecord(run: OrchestrationRunRecord): OrchestrationRunRecord {
  return {
    ...run,
    ...(run.finalizedBatches ? { finalizedBatches: run.finalizedBatches.map(batch => ({ ...batch, members: { ...batch.members } })) } : {}),
    ...(run.integrationIntent ? { integrationIntent: { ...run.integrationIntent, members: run.integrationIntent.members ? { ...run.integrationIntent.members } : undefined } } : {}),
    ...(run.runReviewFindings
      ? { runReviewFindings: run.runReviewFindings.map((f) => ({ ...f })) }
      : {}),
  };
}

export function cloneTaskRecord(task: OrchestrationTaskRecord): OrchestrationTaskRecord {
  const clonedContext = cloneTaskContext(task.taskContext);
  return {
    ...task,
    deps: [...task.deps],
    ...(task.codeDeps ? { codeDeps: [...task.codeDeps] } : {}),
    ...(task.queuedLaunch ? { queuedLaunch: { ...task.queuedLaunch } } : {}),
    ...(clonedContext ? { taskContext: clonedContext } : {}),
  };
}

export function generatePrefixedId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

export function hydrateOrchestrationState(state: OrchestrationStoreState, parsed: Partial<OrchestrationPersistedState>, now: string): void {
  state.nextSequence = typeof parsed.nextSequence === 'number' && parsed.nextSequence > 0
    ? parsed.nextSequence
    : 1;
  state.currentRunByConsumer.clear();
  if (parsed.currentRunByConsumer && typeof parsed.currentRunByConsumer === 'object') {
    for (const [k, v] of Object.entries(parsed.currentRunByConsumer)) {
      if (typeof v === 'string') {
        state.currentRunByConsumer.set(k, v);
      }
    }
  }

  state.runs.clear();
  for (const run of parsed.runs ?? []) {
    if (run && typeof run.id === 'string') {
      state.runs.set(run.id, cloneRunRecord(run));
    }
  }

  state.tasks.clear();
  for (const task of parsed.tasks ?? []) {
    if (task && typeof task.id === 'string') {
      const normalizedContext = cloneTaskContext(task.taskContext);
      state.tasks.set(task.id, {
        ...task,
        deps: [...(task.deps ?? [])],
        ...(normalizedContext ? { taskContext: normalizedContext } : {}),
      });
    }
  }

  state.dispatches.clear();
  for (const dispatch of parsed.dispatches ?? []) {
    if (dispatch && typeof dispatch.id === 'string') {
      const defaultStage: OrchestrationDispatchStage = dispatch.releasedAt
        ? 'released'
        : dispatch.status === 'completed'
          ? 'done'
          : dispatch.status === 'failed' || dispatch.status === 'circuit_broken'
            ? dispatch.lastFailureReason === 'worker_stopped'
              ? 'stopped'
              : 'failed'
            : dispatch.startObservation === 'permission'
              ? 'waiting_permission'
              : dispatch.startObservation === 'observed'
                ? 'working'
                : 'starting';
      state.dispatches.set(dispatch.id, {
        ...dispatch,
        creatorDispatchId: dispatch.creatorDispatchId ?? null,
        parentPaneId: dispatch.parentPaneId ?? null,
        worktreePath: dispatch.worktreePath ?? null,
        branch: dispatch.branch ?? null,
        ownsWorktree: dispatch.ownsWorktree ?? false,
        ownsPane: dispatch.ownsPane ?? false,
        cliId: dispatch.cliId ?? null,
        model: dispatch.model ?? null,
        effort: dispatch.effort ?? null,
        processGeneration: dispatch.processGeneration ?? 1,
        stage: dispatch.stage ?? defaultStage,
        turnStopReportedGeneration: dispatch.turnStopReportedGeneration ?? null,
        followUpOfDispatchId: dispatch.followUpOfDispatchId ?? null,
        retained: dispatch.retained ?? false,
        releasedAt: dispatch.releasedAt ?? null,
        archivedOutput: dispatch.archivedOutput ?? null,
        startObservation: dispatch.startObservation ?? 'pending',
        startObservationReason: dispatch.startObservationReason ?? null,
        turnStartedAt: dispatch.turnStartedAt ?? null,
        promptSentAt: dispatch.promptSentAt ?? null,
        queuedWorkingBaseline: dispatch.queuedWorkingBaseline ?? null,
        staleWarningAt: dispatch.staleWarningAt ?? null,
      });
    }
  }

  state.gates.clear();
  for (const gate of parsed.gates ?? []) {
    if (gate && typeof gate.id === 'string') {
      state.gates.set(gate.id, { ...gate, options: [...(gate.options ?? [])] });
    }
  }

  state.nextBoardSeqByRun.clear();
  if (parsed.nextBoardSeqByRun && typeof parsed.nextBoardSeqByRun === 'object') {
    for (const [runId, nextSeq] of Object.entries(parsed.nextBoardSeqByRun)) {
      if (typeof nextSeq === 'number' && Number.isInteger(nextSeq) && nextSeq > 0) {
        state.nextBoardSeqByRun.set(runId, nextSeq);
      }
    }
  }

  state.memberCursorsByRun.clear();
  if (parsed.memberCursorsByRun && typeof parsed.memberCursorsByRun === 'object') {
    for (const [runId, byMember] of Object.entries(parsed.memberCursorsByRun)) {
      if (!byMember || typeof byMember !== 'object') continue;
      const memberMap = new Map<string, OrchestrationMemberCursor>();
      for (const [memberKey, rawCursor] of Object.entries(byMember)) {
        if (!rawCursor || typeof rawCursor !== 'object') continue;
        memberMap.set(memberKey, {
          ...(typeof rawCursor.lastMentionReadSeq === 'number' && Number.isSafeInteger(rawCursor.lastMentionReadSeq) && rawCursor.lastMentionReadSeq > 0
            ? { lastMentionReadSeq: rawCursor.lastMentionReadSeq } : {}),
          lastReadSeq:
            typeof rawCursor.lastReadSeq === 'number' && Number.isFinite(rawCursor.lastReadSeq)
              ? Math.max(0, Math.floor(rawCursor.lastReadSeq))
              : 0,
          lastPostSeq:
            typeof rawCursor.lastPostSeq === 'number' && Number.isFinite(rawCursor.lastPostSeq)
              ? Math.max(0, Math.floor(rawCursor.lastPostSeq))
              : 0,
          lastDeliveredSeq:
            typeof rawCursor.lastDeliveredSeq === 'number' &&
            Number.isFinite(rawCursor.lastDeliveredSeq)
              ? Math.max(0, Math.floor(rawCursor.lastDeliveredSeq))
              : 0,
        });
      }
      if (memberMap.size > 0) {
        state.memberCursorsByRun.set(runId, memberMap);
      }
    }
  }

  state.messages.clear();
  state.messageOrder = [];
  const sortedMsgs = [...(parsed.messages ?? [])].sort((a, b) => a.seq - b.seq);
  for (const msg of sortedMsgs) {
    if (msg && typeof msg.id === 'string') {
      const cloned = cloneMessageRecord(msg);
      if (cloned.type !== 'heartbeat') {
        if (
          typeof cloned.boardSeq === 'number' &&
          Number.isInteger(cloned.boardSeq) &&
          cloned.boardSeq > 0
        ) {
          const curNext = state.nextBoardSeqByRun.get(cloned.runId) ?? 1;
          if (cloned.boardSeq >= curNext) {
            state.nextBoardSeqByRun.set(cloned.runId, cloned.boardSeq + 1);
          }
        } else {
          const assigned = state.nextBoardSeqByRun.get(cloned.runId) ?? 1;
          cloned.boardSeq = assigned;
          state.nextBoardSeqByRun.set(cloned.runId, assigned + 1);
        }
      }
      state.messages.set(cloned.id, cloned);
      state.messageOrder.push(cloned.id);
      if (cloned.seq >= state.nextSequence) {
        state.nextSequence = cloned.seq + 1;
      }
    }
  }

  state.deliveries.clear();
  for (const delivery of parsed.deliveries ?? []) {
    if (delivery && typeof delivery.id === 'string') {
      state.deliveries.set(delivery.id, { ...delivery, messageIds: [...(delivery.messageIds ?? [])] });
    }
  }

  state.boardReadersByMessageId.clear();
  for (const [id, roles] of Object.entries(parsed.boardReadersByMessageId ?? {})) {
    if (state.messages.has(id) && Array.isArray(roles)) {
      const normalized = roles
        .filter((role): role is string => typeof role === 'string')
        .map((role) => role.trim().replace(/^@+/, '').toLowerCase())
        .filter(Boolean);
      if (normalized.length > 0) {
        state.boardReadersByMessageId.set(id, new Set(normalized));
      }
    }
  }
  state.consumerReadByMessageId.clear();
  for (const [msgId, consumers] of Object.entries(parsed.consumerReadByMessageId ?? {})) {
    if (Array.isArray(consumers) && consumers.length > 0) {
      state.consumerReadByMessageId.set(
        msgId,
        new Set(consumers.filter((c): c is string => typeof c === 'string' && c.length > 0))
      );
    }
  }

  state.consumerDeliveredByMessageId.clear();
  for (const [msgId, consumers] of Object.entries(parsed.consumerDeliveredByMessageId ?? {})) {
    if (Array.isArray(consumers) && consumers.length > 0) {
      state.consumerDeliveredByMessageId.set(
        msgId,
        new Set(consumers.filter((c): c is string => typeof c === 'string' && c.length > 0))
      );
    }
  }

  state.questions.clear();
  for (const q of parsed.questions ?? []) {
    if (q && typeof q.messageId === 'string') {
      state.questions.set(q.messageId, { ...q, options: [...(q.options ?? [])] });
    }
  }

  state.coordinatorRuns.clear();
  for (const cr of parsed.coordinatorRuns ?? []) {
    if (cr && typeof cr.id === 'string') {
      // After process restart, previously running coordinator loops are no longer executing.
      const recovered = cr.status === 'running' || cr.status === 'paused'
        ? { ...cr, status: 'stopped' as const, endedAt: cr.endedAt ?? now }
        : { ...cr };
      state.coordinatorRuns.set(cr.id, recovered);
    }
  }

  state.dispatchCapabilities.clear();
  for (const [dispatchId, capability] of Object.entries(parsed.capabilities ?? {})) {
    if (typeof capability === 'string' && capability) {
      state.dispatchCapabilities.set(dispatchId, capability);
    }
  }
  for (const dispatch of state.dispatches.values()) {
    if (dispatch.archivedOutput) dispatch.archivedOutput = redactDispatchCredentialText(state.dispatchCapabilities, dispatch.archivedOutput);
    if (dispatch.archivedTimeline) {
      dispatch.archivedTimeline = mapTimelineStrings(dispatch.archivedTimeline, (text) => redactDispatchCredentialText(state.dispatchCapabilities, text));
    }
    delete dispatch.hasArchivedTimeline;
  }
  state.deferredPrompts.clear();
  for (const [id, prompt] of Object.entries(parsed.deferredDispatchPrompts ?? {})) {
    const dispatch = state.dispatches.get(id);
    if (dispatch && ACTIVE_DISPATCH_STATUSES.has(dispatch.status) &&
        prompt && typeof prompt.prompt === 'string' && typeof prompt.submit === 'boolean' &&
        (dispatch.assigneePaneId ?? dispatch.assigneeHandle) === prompt.ptyId) {
      state.deferredPrompts.set(id, { ...prompt, prompt: toDeferredPromptTemplate(state.dispatchCapabilities, id, prompt.prompt) });
    }
  }
}

export function exportOrchestrationState(state: OrchestrationStoreState): OrchestrationPersistedState {
  return {
    version: 1,
    nextSequence: state.nextSequence,
    currentRunByConsumer: Object.fromEntries(state.currentRunByConsumer.entries()),
    runs: [...state.runs.values()],
    tasks: [...state.tasks.values()],
    dispatches: [...state.dispatches.values()],
    gates: [...state.gates.values()],
    messages: state.messageOrder
      .map((id) => state.messages.get(id))
      .filter((m): m is OrchestrationMessageRecord => m !== undefined),
    deliveries: [...state.deliveries.values()],
    boardReadersByMessageId: Object.fromEntries([...state.boardReadersByMessageId].map(([id, roles]) => [id, [...roles]])),
    consumerReadByMessageId: Object.fromEntries(
      [...state.consumerReadByMessageId.entries()].map(([k, v]) => [k, [...v]])
    ),
    consumerDeliveredByMessageId: Object.fromEntries(
      [...state.consumerDeliveredByMessageId.entries()].map(([k, v]) => [k, [...v]])
    ),
    questions: [...state.questions.values()],
    coordinatorRuns: [...state.coordinatorRuns.values()],
    capabilities: Object.fromEntries(state.dispatchCapabilities),
    deferredDispatchPrompts: Object.fromEntries(listActiveDeferredPrompts(state)),
    nextBoardSeqByRun: Object.fromEntries(state.nextBoardSeqByRun.entries()),
    memberCursorsByRun: exportMemberCursorsByRun(state),
  };
}

export function exportMemberCursorsByRun(
  state: OrchestrationStoreState,
  filterRunId?: string
): Record<string, Record<string, OrchestrationMemberCursor>> {
  const out: Record<string, Record<string, OrchestrationMemberCursor>> = {};
  for (const [runId, memberMap] of state.memberCursorsByRun.entries()) {
    if (filterRunId && runId !== filterRunId) continue;
    const entries: Record<string, OrchestrationMemberCursor> = {};
    for (const [memberKey, cursor] of memberMap.entries()) {
      entries[memberKey] = { ...cursor };
    }
    out[runId] = entries;
  }
  return out;
}

function isThenable(value: unknown): boolean {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/**
 * Owns the snapshot writer and the mutation/durability contract. `persist()` only schedules an
 * async coalesced write; `flushDurable()` is the explicit "on disk" confirmation for crash-sensitive
 * boundaries.
 */
export class OrchestrationStateRepository {
  readonly state = new OrchestrationStoreState();
  private readonly writer: AtomicSnapshotWriter | null;
  private mutationDepth = 0;
  private persistRequested = false;
  private observedWrite: Promise<void> | null = null;
  private writeFailed = false;

  constructor(readonly resolveFile?: () => string) {
    this.writer = resolveFile
      ? new AtomicSnapshotWriter(resolveFile, {
          skipUnchanged: true,
          backupSuffix: '.bak',
        })
      : null;
  }

  private readonly serialize = (): string => JSON.stringify(exportOrchestrationState(this.state));

  persist(): void {
    if (!this.writer) return;
    if (this.mutationDepth > 0) {
      this.persistRequested = true;
      return;
    }
    const pending = this.writer.write(this.serialize);
    if (pending === this.observedWrite) return;
    this.observedWrite = pending;
    pending.catch((error) => {
      this.writeFailed = true;
      console.error('[orchestration] failed to persist state:', error);
    });
  }

  /** Runs a synchronous multi-entity change and schedules one write at the outermost exit; no rollback on throw. */
  runMutation<T>(fn: () => T): T {
    this.mutationDepth += 1;
    let result: T;
    try {
      result = fn();
    } finally {
      this.mutationDepth -= 1;
      if (this.mutationDepth === 0 && this.persistRequested) {
        this.persistRequested = false;
        this.persist();
      }
    }
    if (isThenable(result)) {
      throw new Error('runMutation callbacks must be synchronous');
    }
    return result;
  }

  /** Resolves once every committed change is on disk; a failed async write is retried synchronously and its error rethrown. */
  async flushDurable(): Promise<void> {
    if (this.mutationDepth > 0) {
      throw new Error('flushDurable cannot run inside runMutation');
    }
    if (!this.writer) return;
    try {
      await this.writer.waitForPendingWrite();
    } catch {
      this.writeFailed = true;
    }
    if (this.writeFailed) this.flushSync();
  }

  flushSync(): void {
    this.writer?.writeSync(this.serialize);
    this.writeFailed = false;
  }

  close(): void {
    this.flushSync();
    this.writer?.close();
  }

  /** Loads the primary snapshot, falling back to the backup; returns a recovery note when one was needed. */
  load(hydrate: (parsed: Partial<OrchestrationPersistedState>) => void): string | null {
    const filePath = this.resolveFile?.();
    if (!filePath) {
      return null;
    }

    for (const candidate of [filePath, `${filePath}.bak`]) {
      if (!existsSync(candidate)) {
        continue;
      }
      let raw: string;
      try {
        raw = readFileSync(candidate, 'utf8');
      } catch (error) {
        console.warn(`[orchestration] failed to read ${candidate}:`, error);
        continue;
      }
      if (!raw.trim()) {
        continue;
      }
      try {
        const parsed = JSON.parse(raw) as Partial<OrchestrationPersistedState>;
        if (!parsed || parsed.version !== 1) {
          throw new Error('Unsupported orchestration snapshot version');
        }
        hydrate(parsed);
        this.writer?.primeCommittedContent(raw);
        if (candidate === filePath) {
          return null;
        }
        const recovery = `Primary snapshot unreadable; recovered from ${candidate}`;
        console.warn(`[orchestration] ${recovery}`);
        // Republish immediately so the next launch reads a healthy primary snapshot.
        this.quarantineUnreadablePrimary(filePath);
        // The primary no longer matches the backup, so the unchanged-write skip must not apply.
        this.writer?.primeCommittedContent(null);
        this.flushSync();
        return recovery;
      } catch (error) {
        console.warn(`[orchestration] failed to parse ${candidate}:`, error);
      }
    }

    if (existsSync(filePath)) {
      const recovery = 'Orchestration snapshot and backup were both unreadable';
      console.warn(`[orchestration] ${recovery}; state was not loaded`);
      this.quarantineUnreadablePrimary(filePath);
      return recovery;
    }
    return null;
  }

  private quarantineUnreadablePrimary(filePath: string): void {
    if (!existsSync(filePath)) {
      return;
    }
    try {
      renameSync(filePath, `${filePath}.corrupt-${Date.now()}`);
    } catch (error) {
      console.warn('[orchestration] failed to quarantine unreadable snapshot:', error);
    }
  }
}
