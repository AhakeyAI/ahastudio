import { cleanupNeedsUser } from './cleanup-outbox.js';
import { join } from 'node:path';
import type { AgentSessionPolicy } from './agent-session-driver.js';
import type { WorkerTimelineSnapshot } from './worker-timeline.js';
import type {
  OrchestrationBoardPostKind,
  OrchestrationCoordinatorRunRecord,
  OrchestrationDeliveryRecord,
  OrchestrationDispatchRecord,
  OrchestrationDispatchStage,
  OrchestrationGateRecord,
  OrchestrationGateStatus,
  OrchestrationIntegrationStatus,
  OrchestrationMemberCursor,
  OrchestrationMessagePriority,
  OrchestrationMessageRecord,
  OrchestrationMessageType,
  OrchestrationQuestionRecord,
  OrchestrationReportArtifacts,
  OrchestrationReviewFinding,
  OrchestrationReviewStatus,
  OrchestrationResumeClaim,
  OrchestrationWorkerHandoff,
  OrchestrationObservationFact,
  OrchestrationRunIntegrationStatus,
  OrchestrationRunRecord,
  OrchestrationSnapshot,
  OrchestrationStartObservation,
  OrchestrationTaskContext,
  OrchestrationTaskRecord,
  OrchestrationTaskStatus,
  OrchestrationTaskWithDispatch,
  OrchestrationWorkerReportOutcome,
  WorkerTurnStopReason,
} from './orchestration-types.js';
import { OrchestrationStateRepository, emptyPersistedState, exportMemberCursorsByRun, hydrateOrchestrationState } from './orchestration-state-repository.js';
import { OrchestrationLifecycleStore } from './orchestration-lifecycle-store.js';
import { OrchestrationMailboxStore, isBroadcastMailbox } from './orchestration-mailbox-store.js';
import { OrchestrationSecurityStore } from './orchestration-security-store.js';
import type { OrchestrationStoreContext, OrchestrationStoreLimits } from './orchestration-store-slice.js';

export const ORCHESTRATION_STATE_FILENAME = 'orchestration-state.json';

export { emptyPersistedState, isBroadcastMailbox };

export interface OrchestrationStoreOptions {
  resolveFile?: () => string;
  briefsDir?: string;
  now?: () => string;
  maxMessagesPerRun?: number;
  maxMessages?: number;
  maxDeliveries?: number;
  maxRuns?: number;
}

const DEFAULT_MAX_MESSAGES_PER_RUN = 200;
const DEFAULT_MAX_MESSAGES = 1000;
const DEFAULT_MAX_DELIVERIES = 500;
const DEFAULT_MAX_RUNS = 50;

export type OrchestrationStoreTx = OrchestrationStore;

/** Mutation boundary and persistence confirmation shared by every store backend. */
export interface OrchestrationUnitOfWork {
  /** Synchronous multi-entity change persisted as one scheduled write; validate before mutating, there is no rollback. */
  runMutation<T>(fn: (tx: OrchestrationStoreTx) => T): T;
  /** Resolves once committed changes are on disk; await it before crash-sensitive side effects. */
  flushDurable(): Promise<void>;
}

/** Facade over the lifecycle, mailbox and security sub-stores, which share one state and repository. */
export class OrchestrationStore implements OrchestrationUnitOfWork {
  private readonly customClock: boolean;
  private now: () => string;
  private readonly repository: OrchestrationStateRepository;
  private readonly lifecycle: OrchestrationLifecycleStore;
  private readonly mailbox: OrchestrationMailboxStore;
  private readonly security: OrchestrationSecurityStore;

  constructor(options: OrchestrationStoreOptions = {}) {
    this.customClock = typeof options.now === 'function';
    this.now = options.now ?? (() => new Date().toISOString());
    this.repository = new OrchestrationStateRepository(options.resolveFile);
    const limits: OrchestrationStoreLimits = {
      maxMessagesPerRun: Math.max(0, Math.floor(options.maxMessagesPerRun ?? DEFAULT_MAX_MESSAGES_PER_RUN)),
      maxMessages: Math.max(0, Math.floor(options.maxMessages ?? DEFAULT_MAX_MESSAGES)),
      maxDeliveries: Math.max(0, Math.floor(options.maxDeliveries ?? DEFAULT_MAX_DELIVERIES)),
      maxRuns: Math.max(0, Math.floor(options.maxRuns ?? DEFAULT_MAX_RUNS)),
    };
    const store = this;
    const ctx: OrchestrationStoreContext = {
      repository: this.repository,
      limits,
      now: () => this.now(),
      get lifecycle() { return store.lifecycle; },
      get mailbox() { return store.mailbox; },
      get security() { return store.security; },
    };
    this.lifecycle = new OrchestrationLifecycleStore(ctx, options.briefsDir);
    this.mailbox = new OrchestrationMailboxStore(ctx);
    this.security = new OrchestrationSecurityStore(ctx);
  }

  hasCustomClock(): boolean {
    return this.customClock;
  }

  getClockMs(): number {
    const parsed = Date.parse(this.now());
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  bindDefaultClock(nowIso: () => string): void {
    if (!this.customClock) {
      this.now = nowIso;
    }
  }

  static forUserDataDir(getUserDataDir: () => string): OrchestrationStore {
    const store = new OrchestrationStore({
      resolveFile: () => join(getUserDataDir(), ORCHESTRATION_STATE_FILENAME),
    });
    store.load();
    return store;
  }

  /** Set when load() had to fall back to the backup or quarantine an unreadable snapshot. */
  lastLoadRecovery: string | null = null;

  load(): void {
    const recovery = this.repository.load((parsed) => {
      const now = this.now();
      hydrateOrchestrationState(this.repository.state, parsed, now);
      this.lifecycle.recoverAfterRestart(now);
      this.security.prune();
    });
    if (recovery) this.lastLoadRecovery = recovery;
    this.lifecycle.reconcileBriefFiles();
  }

  runMutation<T>(fn: (tx: OrchestrationStoreTx) => T): T {
    return this.repository.runMutation(() => fn(this));
  }

  flushDurable(): Promise<void> {
    return this.repository.flushDurable();
  }

  flushSync(): void {
    this.repository.flushSync();
  }

  close(): void {
    this.repository.close();
  }

  listCleanupEntries() { return this.lifecycle.listCleanupEntries(); }

  saveCleanupEntry(entry: Parameters<OrchestrationLifecycleStore['saveCleanupEntry']>[0]) {
    this.lifecycle.saveCleanupEntry(entry);
  }

  getSnapshot(runId?: string): OrchestrationSnapshot {
    const state = this.repository.state;
    const tasks = this.lifecycle.listTasksWithDispatch(runId ? { runId } : undefined);
    const runs = this.lifecycle.listRuns();
    const dispatches = this.lifecycle.listDispatches(runId ? { runId } : undefined).map((dispatch) => {
      if (!dispatch.archivedTimeline) return dispatch;
      const { archivedTimeline: _timeline, ...rest } = dispatch;
      return { ...rest, ...(rest.taskKind === undefined && _timeline.readOnly ? { taskKind: 'research' as const } : {}), hasArchivedTimeline: true };
    });
    const gates = this.mailbox.listGates(runId ? { runId } : undefined);
    const messages = this.mailbox.listMessages(runId ? { runId, limit: 200 } : { limit: 200 });
    const questions = this.mailbox.listQuestions(runId ? { runId } : undefined);
    const coordinatorRuns = [...state.coordinatorRuns.values()]
      .filter((c) => !runId || c.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((c) => ({ ...c }));
    const activeCoordinatorRun = this.lifecycle.getActiveCoordinatorRun() ?? null;
    return {
      runs,
      tasks,
      dispatches,
      gates,
      messages,
      questions,
      cleanupAttention: state.cleanupOutbox.filter(cleanupNeedsUser).filter(e => !runId || e.runId === runId)
        .map(({ id, kind, runId, dispatchId, status, worktreePath, worktreeBranch: branch, attempts, lastError, updatedAt, nextAttemptAt }) =>
          ({ id, kind, runId, dispatchId, status, worktreePath, branch, attempts, lastError, updatedAt, nextAttemptAt })),
      memberCursorsByRun: exportMemberCursorsByRun(state, runId),
      coordinatorRuns,
      activeCoordinatorRun,
      currentRunByConsumer: Object.fromEntries(state.currentRunByConsumer.entries()),
    };
  }

  getBriefsDir(): string | null {
    return this.lifecycle.getBriefsDir();
  }

  configureBriefsDir(directory: string): void {
    return this.lifecycle.configureBriefsDir(directory);
  }

  /** Upper bound on simultaneously active dispatches across every run. */
  configureMaxActiveDispatches(limit: number): void {
    return this.lifecycle.configureMaxActiveDispatches(limit);
  }

  getRemainingDispatchCapacity(): number {
    return this.lifecycle.getRemainingDispatchCapacity();
  }

  assertDispatchCapacity(): void {
    return this.lifecycle.assertDispatchCapacity();
  }

  reconcileBriefFiles(): void {
    return this.lifecycle.reconcileBriefFiles();
  }

  cleanupDispatchBrief(dispatchId: string): void {
    return this.lifecycle.cleanupDispatchBrief(dispatchId);
  }

  getHeadBoardSeq(runId: string): number {
    return this.mailbox.getHeadBoardSeq(runId);
  }

  getMemberCursor(runId: string, memberKey: string): OrchestrationMemberCursor {
    return this.mailbox.getMemberCursor(runId, memberKey);
  }

  advanceMemberCursor(runId: string, memberKey: string, patch: Partial<OrchestrationMemberCursor>): OrchestrationMemberCursor {
    return this.mailbox.advanceMemberCursor(runId, memberKey, patch);
  }

  listBoardPosts(runId: string, opts?: { since?: number; seqs?: readonly number[]; limit?: number; matches?: (post: OrchestrationMessageRecord) => boolean }): OrchestrationMessageRecord[] {
    return this.mailbox.listBoardPosts(runId, opts);
  }

  listDeferredDispatchPrompts() {
    return this.security.listDeferredDispatchPrompts();
  }

  restoreDeferredDispatchPrompt(id: string, template: string): string {
    return this.security.restoreDeferredDispatchPrompt(id, template);
  }

  saveDeferredDispatchPrompt(id: string, prompt: { ptyId: string; prompt: string; submit: boolean }): void {
    return this.security.saveDeferredDispatchPrompt(id, prompt);
  }

  deleteDeferredDispatchPrompt(id: string): void {
    return this.security.deleteDeferredDispatchPrompt(id);
  }

  createRun(input: {
    id?: string;
    objective: string;
    coordinatorHandle: string;
    coordinatorPaneId?: string | null;
  }): OrchestrationRunRecord {
    return this.lifecycle.createRun(input);
  }

  bindRun(input: {
    runId: string;
    coordinatorHandle: string;
    coordinatorPaneId?: string | null;
  }): OrchestrationRunRecord | null {
    return this.lifecycle.bindRun(input);
  }

  getConsumersForRun(runId: string): string[] {
    return this.lifecycle.getConsumersForRun(runId);
  }

  getRun(runId: string): OrchestrationRunRecord | undefined {
    return this.lifecycle.getRun(runId);
  }

  requireRun(runId: string): OrchestrationRunRecord {
    return this.lifecycle.requireRun(runId);
  }

  getCurrentRunForConsumer(handleOrPane: string): OrchestrationRunRecord | undefined {
    return this.lifecycle.getCurrentRunForConsumer(handleOrPane);
  }

  listRuns(filter?: { status?: string }): OrchestrationRunRecord[] {
    return this.lifecycle.listRuns(filter);
  }

  updateRunStatus(runId: string, status: OrchestrationRunRecord['status']): OrchestrationRunRecord {
    return this.lifecycle.updateRunStatus(runId, status);
  }

  updateRunIntegrationState(runId: string, patch: {
      integrationBranch?: string | null;
      integrationWorktreePath?: string | null;
      integrationBaseCommit?: string | null;
      integrationBaseBranch?: string | null;
      integrationRepoRootPath?: string | null;
      integrationStatus?: OrchestrationRunIntegrationStatus;
      integrationHeadCommit?: string | null;
      finalizedCommit?: string | null;
      integrationIntent?: OrchestrationRunRecord['integrationIntent'];
      finalizedBatch?: NonNullable<OrchestrationRunRecord['finalizedBatches']>[number];
    }): OrchestrationRunRecord | null {
    return this.lifecycle.updateRunIntegrationState(runId, patch);
  }

  updateRunReviewState(runId: string, patch: {
      runReviewBatchId?: string | null;
      runReviewSnapshotOid?: string | null;
      runReviewBaseCommit?: string | null;
      runReviewStatus?: OrchestrationReviewStatus;
      runReviewRound?: number;
      runReviewFindings?: OrchestrationReviewFinding[];
    }): OrchestrationRunRecord | null {
    return this.lifecycle.updateRunReviewState(runId, patch);
  }

  setRunAutoReviewAuthorized(runId: string, authorized: boolean): OrchestrationRunRecord | null {
    return this.lifecycle.setRunAutoReviewAuthorized(runId, authorized);
  }

  createTask(input: {
    id?: string;
    runId: string;
    spec: string;
    taskContext?: OrchestrationTaskContext | null;
    taskTitle?: string | null;
    displayName?: string | null;
    deps?: string[];
    codeDeps?: string[];
    queuedLaunch?: OrchestrationTaskRecord['queuedLaunch'];
    priority?: OrchestrationMessagePriority;
    worktreePath?: string | null;
    singleShot?: boolean;
  }): OrchestrationTaskRecord {
    return this.lifecycle.createTask(input);
  }

  codeReady(taskId: string): boolean {
    return this.lifecycle.codeReady(taskId);
  }

  codeDependency(taskId: string): OrchestrationDispatchRecord | undefined {
    return this.lifecycle.codeDependency(taskId);
  }

  hasQueuedWork(): boolean {
    return this.lifecycle.hasQueuedWork();
  }

  setQueuedLaunch(taskId: string, launch?: OrchestrationTaskRecord['queuedLaunch']): void {
    return this.lifecycle.setQueuedLaunch(taskId, launch);
  }

  getTask(taskId: string): OrchestrationTaskRecord | undefined {
    return this.lifecycle.getTask(taskId);
  }

  requireTask(taskId: string): OrchestrationTaskRecord {
    return this.lifecycle.requireTask(taskId);
  }

  listTasks(filter?: {
    runId?: string;
    status?: OrchestrationTaskStatus;
    priority?: OrchestrationMessagePriority;
  }): OrchestrationTaskRecord[] {
    return this.lifecycle.listTasks(filter);
  }

  listTasksWithDispatch(filter?: {
    runId?: string;
    status?: OrchestrationTaskStatus;
  }): OrchestrationTaskWithDispatch[] {
    return this.lifecycle.listTasksWithDispatch(filter);
  }

  /**
   * Moves the DAG forward after any task change: blocks dependents of failed tasks (and unblocks
   * them once the dependency is retried) and promotes pending tasks whose deps completed.
   */
  promoteReadyTasks(runId?: string): OrchestrationTaskRecord[] {
    return this.lifecycle.promoteReadyTasks(runId);
  }

  mergeTaskContext(taskId: string, override: OrchestrationTaskContext): OrchestrationTaskRecord {
    return this.lifecycle.mergeTaskContext(taskId, override);
  }

  updateTaskStatus(taskId: string, status: OrchestrationTaskStatus): OrchestrationTaskRecord {
    return this.lifecycle.updateTaskStatus(taskId, status);
  }

  getDispatchContext(dispatchId: string): OrchestrationDispatchRecord | undefined {
    return this.lifecycle.getDispatchContext(dispatchId);
  }

  getLatestDispatchForTask(taskId: string): OrchestrationDispatchRecord | undefined {
    return this.lifecycle.getLatestDispatchForTask(taskId);
  }

  getActiveDispatchesForTask(taskId: string): OrchestrationDispatchRecord[] {
    return this.lifecycle.getActiveDispatchesForTask(taskId);
  }

  getActiveDispatchForIdentity(handle: string, paneId?: string | null): OrchestrationDispatchRecord | undefined {
    return this.lifecycle.getActiveDispatchForIdentity(handle, paneId);
  }

  acquireResumeClaim(
    ...args: Parameters<OrchestrationLifecycleStore['acquireResumeClaim']>
  ): ReturnType<OrchestrationLifecycleStore['acquireResumeClaim']> {
    return this.lifecycle.acquireResumeClaim(...args);
  }

  activateResumeClaim(claimId: string, pid: number | null): OrchestrationResumeClaim | undefined {
    return this.lifecycle.activateResumeClaim(claimId, pid);
  }

  releaseResumeClaims(workerId: string): void {
    this.lifecycle.releaseResumeClaims(workerId);
  }

  listResumeClaims(): OrchestrationResumeClaim[] {
    return this.lifecycle.listResumeClaims();
  }

  createWorkerHandoff(
    ...args: Parameters<OrchestrationLifecycleStore['createWorkerHandoff']>
  ): OrchestrationWorkerHandoff {
    return this.lifecycle.createWorkerHandoff(...args);
  }

  updateWorkerHandoff(
    ...args: Parameters<OrchestrationLifecycleStore['updateWorkerHandoff']>
  ): OrchestrationWorkerHandoff | undefined {
    return this.lifecycle.updateWorkerHandoff(...args);
  }

  listWorkerHandoffs(
    ...args: Parameters<OrchestrationLifecycleStore['listWorkerHandoffs']>
  ): OrchestrationWorkerHandoff[] {
    return this.lifecycle.listWorkerHandoffs(...args);
  }

  appendObservationFact(
    ...args: Parameters<OrchestrationLifecycleStore['appendObservationFact']>
  ): OrchestrationObservationFact {
    return this.lifecycle.appendObservationFact(...args);
  }

  listObservationFacts(
    ...args: Parameters<OrchestrationLifecycleStore['listObservationFacts']>
  ): OrchestrationObservationFact[] {
    return this.lifecycle.listObservationFacts(...args);
  }

  listDispatches(filter?: {
    runId?: string;
    taskId?: string;
    status?: OrchestrationDispatchRecord['status'];
  }): OrchestrationDispatchRecord[] {
    return this.lifecycle.listDispatches(filter);
  }

  resolveChildDispatchDepth(creatorDispatchId?: string | null): number {
    return this.lifecycle.resolveChildDispatchDepth(creatorDispatchId);
  }

  createDispatchContext(input: {
    taskId: string;
    approvedQueueLaunch?: boolean;
    providerSessionId?: string;
    workerPolicy?: AgentSessionPolicy;
    workerNetwork?: boolean;
    allowSubWorkers?: boolean;
    assigneeHandle: string;
    assigneePaneId?: string | null;
    processIncarnation?: string | null;
    creator?: string;
    creatorRunId?: string | null;
    creatorDispatchId?: string | null;
    parentPaneId?: string | null;
    worktreePath?: string | null;
    branch?: string | null;
    baseCommit?: string | null;
    repoRootPath?: string | null;
    ownsWorktree?: boolean;
    ownsBranch?: boolean;
    taskKind?: import('./orchestration-types.js').OrchestrationTaskKind;
    isDetachedReviewWorktree?: boolean;
    reviewOfDispatchId?: string | null;
    reviewOfRunId?: string | null;
    reviewFocus?: string | null;
    reviewBatchId?: string | null;
    reviewSnapshotOid?: string | null;
    reviewBaseCommit?: string | null;
    reviewRound?: number;
    ownsPane?: boolean;
    cliId?: string | null;
    model?: string | null;
    effort?: string | null;
    processGeneration?: number;
    followUpOfDispatchId?: string | null;
    retained?: boolean;
    maxDepth?: number;
    /** Depth of the caller's own lineage when it is no longer an active dispatch. */
    parentDepth?: number;
    startObservation?: OrchestrationStartObservation;
    startObservationReason?: string | null;
    promptSentAt?: string | null;
    queuedWorkingBaseline?: number | null;
  }): OrchestrationDispatchRecord {
    return this.lifecycle.createDispatchContext(input);
  }

  /** Token the assignee must present for worker_done/heartbeat/ask; undefined for legacy dispatches. */
  getDispatchCapability(dispatchId: string): string | undefined {
    return this.security.getDispatchCapability(dispatchId);
  }

  redactDispatchCredentials(text: string): string {
    return this.security.redactDispatchCredentials(text);
  }

  assertDispatchCapability(dispatchId: string, capability: string | undefined): void {
    return this.security.assertDispatchCapability(dispatchId, capability);
  }

  updateDispatchStage(dispatchId: string, stage: OrchestrationDispatchStage): OrchestrationDispatchRecord | null {
    return this.lifecycle.updateDispatchStage(dispatchId, stage);
  }

  /** Records a headless Worker's permission tier and network access for its next turns. */
  setDispatchResident(
    ...args: Parameters<OrchestrationLifecycleStore['setDispatchResident']>
  ): OrchestrationDispatchRecord | null {
    return this.lifecycle.setDispatchResident(...args);
  }

  updateDispatchWorkerControls(dispatchId: string, patch: { workerPolicy?: AgentSessionPolicy; workerNetwork?: boolean }): OrchestrationDispatchRecord | null {
    return this.lifecycle.updateDispatchWorkerControls(dispatchId, patch);
  }

  markTurnStopReported(dispatchId: string, generation: number, stopReason: WorkerTurnStopReason): OrchestrationDispatchRecord | null {
    return this.lifecycle.markTurnStopReported(dispatchId, generation, stopReason);
  }

  bumpDispatchGenerationForSteering(dispatchId: string): OrchestrationDispatchRecord | null {
    return this.lifecycle.bumpDispatchGenerationForSteering(dispatchId);
  }

  clearWaitingInputTurnStop(dispatchId: string): OrchestrationDispatchRecord | null {
    return this.lifecycle.clearWaitingInputTurnStop(dispatchId);
  }

  hasActiveChildDispatches(parentDispatchId: string): boolean {
    return this.lifecycle.hasActiveChildDispatches(parentDispatchId);
  }

  getFollowUpChildDispatch(dispatchId: string): OrchestrationDispatchRecord | undefined {
    return this.lifecycle.getFollowUpChildDispatch(dispatchId);
  }

  resolveDispatchLineage(dispatchId: string): OrchestrationDispatchRecord | undefined {
    return this.lifecycle.resolveDispatchLineage(dispatchId);
  }

  listDispatchAncestorIds(dispatchId: string): string[] {
    return this.lifecycle.listDispatchAncestorIds(dispatchId);
  }

  transferCustodyToFollowUp(prevDispatchId: string, nextDispatchId: string): void {
    return this.lifecycle.transferCustodyToFollowUp(prevDispatchId, nextDispatchId);
  }

  setDispatchRetained(dispatchId: string, retained: boolean): OrchestrationDispatchRecord {
    return this.lifecycle.setDispatchRetained(dispatchId, retained);
  }

  switchUnacceptedCodexDispatchToPane(dispatchId: string, ptyId: string): OrchestrationDispatchRecord {
    return this.lifecycle.switchUnacceptedCodexDispatchToPane(dispatchId, ptyId);
  }

  recordCodexTurn(dispatchId: string, result: NonNullable<OrchestrationDispatchRecord['codexTurn']>, awaitingReview = true): void {
    return this.lifecycle.recordCodexTurn(dispatchId, result, awaitingReview);
  }

  recordCodexDeliveryFailure(dispatchId: string, failure: NonNullable<OrchestrationDispatchRecord['codexDeliveryFailure']>): void {
    return this.lifecycle.recordCodexDeliveryFailure(dispatchId, failure);
  }

  recordReconciliationDiff(dispatchId: string, diff: string | null): void {
    return this.lifecycle.recordReconciliationDiff(dispatchId, diff);
  }

  archiveDispatchOutput(dispatchId: string, output: string): void {
    return this.lifecycle.archiveDispatchOutput(dispatchId, output);
  }

  archiveDispatchTimeline(dispatchId: string, timeline: WorkerTimelineSnapshot): void {
    return this.lifecycle.archiveDispatchTimeline(dispatchId, timeline);
  }

  getArchivedTimeline(dispatchId: string): WorkerTimelineSnapshot | null {
    return this.lifecycle.getArchivedTimeline(dispatchId);
  }

  markDispatchPaneClosed(dispatchId: string): OrchestrationDispatchRecord | null {
    return this.lifecycle.markDispatchPaneClosed(dispatchId);
  }

  findLatestWorkerDoneMessage(dispatchId: string): OrchestrationMessageRecord | undefined {
    return this.lifecycle.findLatestWorkerDoneMessage(dispatchId);
  }

  markDispatchReleased(dispatchId: string, opts?: { keepPane?: boolean; keepWorktree?: boolean }): OrchestrationDispatchRecord {
    return this.lifecycle.markDispatchReleased(dispatchId, opts);
  }

  hasUnreadReportFromDispatch(dispatchId: string): boolean {
    return this.mailbox.hasUnreadReportFromDispatch(dispatchId);
  }

  requeueTaskForRetry(taskId: string): OrchestrationTaskRecord {
    return this.lifecycle.requeueTaskForRetry(taskId);
  }

  listReviewDispatchesForTarget(targetDispatchId: string): OrchestrationDispatchRecord[] {
    return this.lifecycle.listReviewDispatchesForTarget(targetDispatchId);
  }

  listReviewDispatchesForBatch(targetDispatchId: string, reviewBatchId: string): OrchestrationDispatchRecord[] {
    return this.lifecycle.listReviewDispatchesForBatch(targetDispatchId, reviewBatchId);
  }

  listReviewDispatchesForRun(runId: string): OrchestrationDispatchRecord[] {
    return this.lifecycle.listReviewDispatchesForRun(runId);
  }

  listReviewDispatchesForRunBatch(runId: string, reviewBatchId: string): OrchestrationDispatchRecord[] {
    return this.lifecycle.listReviewDispatchesForRunBatch(runId, reviewBatchId);
  }

  listIntegratedDispatchesForRun(runId: string): OrchestrationDispatchRecord[] {
    return this.lifecycle.listIntegratedDispatchesForRun(runId);
  }

  updateDispatchReviewState(dispatchId: string, patch: {
      reviewStatus?: OrchestrationReviewStatus;
      reviewRound?: number;
      reviewBatchId?: string | null;
      reviewSnapshotOid?: string | null;
      reviewBaseCommit?: string | null;
      reviewFindings?: OrchestrationReviewFinding[];
      reviewMutatedWorkspace?: boolean;
    }): OrchestrationDispatchRecord | null {
    return this.lifecycle.updateDispatchReviewState(dispatchId, patch);
  }

  updateDispatchIntegrationState(dispatchId: string, patch: {
      integrationStatus?: OrchestrationIntegrationStatus;
      integratedCommit?: string | null;
      integratedTargetBranch?: string | null;
      noChanges?: boolean;
    }): OrchestrationDispatchRecord | null {
    return this.lifecycle.updateDispatchIntegrationState(dispatchId, patch);
  }

  setDispatchBriefFilePath(dispatchId: string, briefFilePath: string | null): OrchestrationDispatchRecord | null {
    return this.lifecycle.setDispatchBriefFilePath(dispatchId, briefFilePath);
  }

  updateDispatchObservation(dispatchId: string, observation: OrchestrationStartObservation, options?: {
      reason?: string | null;
      refreshHeartbeat?: boolean;
      minHeartbeatIntervalMs?: number;
      promptSent?: boolean;
      queuedWorkingBaseline?: number | null;
    }): OrchestrationDispatchRecord | null {
    return this.lifecycle.updateDispatchObservation(dispatchId, observation, options);
  }

  recordHeartbeat(dispatchId: string, options?: { minIntervalMs?: number }): OrchestrationDispatchRecord | null {
    return this.lifecycle.recordHeartbeat(dispatchId, options);
  }

  completeDispatch(dispatchId: string): OrchestrationDispatchRecord {
    return this.lifecycle.completeDispatch(dispatchId);
  }

  failDispatch(dispatchId: string, reason: string, options?: { forceFailTask?: boolean; summary?: string }): OrchestrationDispatchRecord {
    return this.lifecycle.failDispatch(dispatchId, reason, options);
  }

  /**
   * Park a dispatch whose worker stopped showing signs of life. Unlike failDispatch this never
   * re-queues the task: the assignee may still be executing it, so re-dispatching would run the
   * task twice. The task is blocked for a human and a late worker_done can still settle it.
   */
  blockUnresponsiveDispatch(dispatchId: string, reason: string): OrchestrationDispatchRecord {
    return this.lifecycle.blockUnresponsiveDispatch(dispatchId, reason);
  }

  /**
   * Emit a one-shot advisory escalation for a dispatch that shows no progress. Unlike
   * blockUnresponsiveDispatch this changes no dispatch/task status; `advisory: true` keeps the
   * coordinator's escalation handler from settling anything.
   */
  markStaleDispatchWarned(dispatchId: string, subject: string, body: string): OrchestrationDispatchRecord | null {
    return this.lifecycle.markStaleDispatchWarned(dispatchId, subject, body);
  }

  /** Live dispatches assigned to a pane, without cloning or sorting (hot PTY activity path). */
  getActiveDispatchesForPane(ptyId: string): OrchestrationDispatchRecord[] {
    return this.lifecycle.getActiveDispatchesForPane(ptyId);
  }

  settleWorkerReport(input: {
    dispatchId: string;
    taskId: string;
    outcome: OrchestrationWorkerReportOutcome;
    summary?: string;
    reportedByHandle?: string;
    reportedByPaneId?: string | null;
  }): {
    action: 'settled' | 'duplicate' | 'rejected';
    reason?: string;
    dispatch?: OrchestrationDispatchRecord;
    task?: OrchestrationTaskRecord;
  } {
    return this.lifecycle.settleWorkerReport(input);
  }

  hasPendingGates(taskId: string): boolean {
    return this.mailbox.hasPendingGates(taskId);
  }

  createGate(input: {
    taskId: string;
    question: string;
    options?: string[];
    requesterDispatchId?: string | null;
    requesterHandle?: string | null;
  }): OrchestrationGateRecord {
    return this.mailbox.createGate(input);
  }

  resolveGate(gateId: string, resolution: string): OrchestrationGateRecord {
    return this.mailbox.resolveGate(gateId, resolution);
  }

  timeoutGate(gateId: string): OrchestrationGateRecord {
    return this.mailbox.timeoutGate(gateId);
  }

  getGate(gateId: string): OrchestrationGateRecord | undefined {
    return this.mailbox.getGate(gateId);
  }

  listGates(filter?: {
    runId?: string;
    taskId?: string;
    status?: OrchestrationGateStatus;
  }): OrchestrationGateRecord[] {
    return this.mailbox.listGates(filter);
  }

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
    return this.mailbox.insertMessage(input);
  }

  getMessageById(id: string): OrchestrationMessageRecord | undefined {
    return this.mailbox.getMessageById(id);
  }

  markLifecycleRejected(messageId: string, reason: string): OrchestrationMessageRecord | undefined {
    return this.mailbox.markLifecycleRejected(messageId, reason);
  }

  /** Moves unread direct mail sent to a pane/handle into its role mailbox (`run:` or `dispatch:`). */
  routeUnreadDirectMessages(directHandle: string, targetMailboxHandle: string, runId?: string): OrchestrationMessageRecord[] {
    return this.mailbox.routeUnreadDirectMessages(directHandle, targetMailboxHandle, runId);
  }

  /** Forward leftover unread mail from a closed dispatch mailbox up to the owning run mailbox. */
  routeUnreadDispatchMailboxToRun(dispatchId: string, runId: string): OrchestrationMessageRecord[] {
    return this.mailbox.routeUnreadDispatchMailboxToRun(dispatchId, runId);
  }

  getUnreadMessages(mailboxHandle: string, options?: {
      types?: readonly OrchestrationMessageType[];
      excludeTypes?: readonly OrchestrationMessageType[];
      excludeIds?: readonly string[];
      consumerHandle?: string;
      limit?: number;
    }): OrchestrationMessageRecord[] {
    return this.mailbox.getUnreadMessages(mailboxHandle, options);
  }

  getUndeliveredUnreadMessages(mailboxHandle: string, options?: {
      types?: readonly OrchestrationMessageType[];
      excludeTypes?: readonly OrchestrationMessageType[];
      excludeIds?: readonly string[];
      consumerHandle?: string;
      limit?: number;
    }): OrchestrationMessageRecord[] {
    return this.mailbox.getUndeliveredUnreadMessages(mailboxHandle, options);
  }

  getAllMessagesForHandle(mailboxHandle: string, options?: {
      types?: readonly OrchestrationMessageType[];
      limit?: number;
    }): OrchestrationMessageRecord[] {
    return this.mailbox.getAllMessagesForHandle(mailboxHandle, options);
  }

  listMessages(filter?: {
    runId?: string;
    toHandle?: string;
    fromHandle?: string;
    type?: OrchestrationMessageType;
    unreadOnly?: boolean;
    limit?: number;
  }): OrchestrationMessageRecord[] {
    return this.mailbox.listMessages(filter);
  }

  markAsRead(messageIds: readonly string[]): void {
    return this.mailbox.markAsRead(messageIds);
  }

  markAsDelivered(messageIds: readonly string[]): void {
    return this.mailbox.markAsDelivered(messageIds);
  }

  markAsUndelivered(messageIds: readonly string[]): void {
    return this.mailbox.markAsUndelivered(messageIds);
  }

  markAsReadAndDelivered(messageIds: readonly string[]): void {
    return this.mailbox.markAsReadAndDelivered(messageIds);
  }

  /** Exact content reads can arrive out of order. A pointer alone never consumes its posts. */
  recordBoardRead(runId: string, role: string, ids: readonly string[]): void {
    return this.mailbox.recordBoardRead(runId, role, ids);
  }

  wasBoardPostRead(id: string, role: string): boolean {
    return this.mailbox.wasBoardPostRead(id, role);
  }

  recordBoardReceipt(ids: readonly string[], role: string, state: 'notified' | 'delivered' | 'replied'): boolean {
    return this.mailbox.recordBoardReceipt(ids, role, state);
  }

  linkFollowUpMessage(dispatchId: string, messageId: string): void {
    return this.lifecycle.linkFollowUpMessage(dispatchId, messageId);
  }

  markAsDeliveredForConsumer(messageIds: readonly string[], consumerHandle: string): void {
    return this.mailbox.markAsDeliveredForConsumer(messageIds, consumerHandle);
  }

  markAsUndeliveredForConsumer(messageIds: readonly string[], consumerHandle: string): void {
    return this.mailbox.markAsUndeliveredForConsumer(messageIds, consumerHandle);
  }

  markAsReadAndDeliveredForConsumer(messageIds: readonly string[], consumerHandle: string): void {
    return this.mailbox.markAsReadAndDeliveredForConsumer(messageIds, consumerHandle);
  }

  areUnreadMessages(mailboxHandle: string, messageIds: readonly string[]): boolean {
    return this.mailbox.areUnreadMessages(mailboxHandle, messageIds);
  }

  getOutstandingDelivery(mailboxHandle: string, consumerHandle?: string): OrchestrationDeliveryRecord | undefined {
    return this.mailbox.getOutstandingDelivery(mailboxHandle, consumerHandle);
  }

  getDelivery(deliveryId: string): OrchestrationDeliveryRecord | undefined {
    return this.mailbox.getDelivery(deliveryId);
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
    return this.mailbox.takeMailboxDelivery(input);
  }

  acknowledgeDelivery(deliveryId: string, expectedMailboxHandle?: string, expectedConsumerGeneration?: number, expectedConsumerHandle?: string): OrchestrationDeliveryRecord {
    return this.mailbox.acknowledgeDelivery(deliveryId, expectedMailboxHandle, expectedConsumerGeneration, expectedConsumerHandle);
  }

  acknowledgeDeliveriesForMessages(messageIds: readonly string[], consumerHandle?: string): number {
    return this.mailbox.acknowledgeDeliveriesForMessages(messageIds, consumerHandle);
  }

  getThreadMessages(threadId: string): OrchestrationMessageRecord[] {
    return this.mailbox.getThreadMessages(threadId);
  }

  createQuestion(input: {
    messageId: string;
    runId: string;
    dispatchId: string;
    fromHandle: string;
    toHandle: string;
    question: string;
    options?: string[];
  }): OrchestrationQuestionRecord {
    return this.mailbox.createQuestion(input);
  }

  getQuestion(messageId: string): OrchestrationQuestionRecord | undefined {
    return this.mailbox.getQuestion(messageId);
  }

  listQuestions(filter?: {
    runId?: string;
    dispatchId?: string;
    status?: OrchestrationQuestionRecord['status'];
  }): OrchestrationQuestionRecord[] {
    return this.mailbox.listQuestions(filter);
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
    return this.mailbox.answerQuestion(input);
  }

  closeQuestionsForDispatch(dispatchId: string): void {
    return this.mailbox.closeQuestionsForDispatch(dispatchId);
  }

  createCoordinatorRun(input: {
    runId: string;
    spec: string;
    coordinatorHandle: string;
    pollIntervalMs: number;
    maxConcurrent: number;
  }): OrchestrationCoordinatorRunRecord {
    return this.lifecycle.createCoordinatorRun(input);
  }

  getCoordinatorRun(id: string): OrchestrationCoordinatorRunRecord | undefined {
    return this.lifecycle.getCoordinatorRun(id);
  }

  getActiveCoordinatorRun(): OrchestrationCoordinatorRunRecord | undefined {
    return this.lifecycle.getActiveCoordinatorRun();
  }

  listCoordinatorRuns(runId?: string): OrchestrationCoordinatorRunRecord[] {
    return this.lifecycle.listCoordinatorRuns(runId);
  }

  updateCoordinatorRun(id: string, patch: Partial<Pick<OrchestrationCoordinatorRunRecord, 'status' | 'endedAt' | 'error'>>): OrchestrationCoordinatorRunRecord {
    return this.lifecycle.updateCoordinatorRun(id, patch);
  }

  protectedRunReason(runId: string): string | null {
    return this.security.protectedRunReason(runId);
  }

  prune(): void {
    return this.security.prune();
  }

  clearFinishedHistory(discardRunId?: string): ReturnType<OrchestrationSecurityStore['reset']> {
    return this.security.clearFinishedHistory(discardRunId);
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
    return this.security.reset(scope);
  }
}
