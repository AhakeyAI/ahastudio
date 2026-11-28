import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { isProcessTreeAlive } from '../agent-drivers/process-tree.js';
import { comparablePath } from './headless-workers.js';
import {
  listWorkerBriefFiles,
  mergeTaskContext,
  normalizeTaskContext,
  removeWorkerBriefFile,
} from './worker-brief-context.js';
import {
  ACTIVE_DISPATCH_STATUSES,
  DEPENDENCY_FAILED_REASON,
  assertDispatchTransition,
  assertTaskTransition,
  isBlockedByFailedDependency,
  isTaskSettled,
  reportCorrectsUnobservedPrompt,
  reportCorrectsUnresponsiveWorker,
} from './orchestration-lifecycle-graph.js';
import { buildOrchestrationTaskDisplayMetadata } from './orchestration-task-display.js';
import type { AgentSessionPolicy } from './agent-session-driver.js';
import {
  mapTimelineStrings,
  trimTimelineSnapshot,
  TIMELINE_LIMITS,
  type WorkerTimelineSnapshot,
} from './worker-timeline.js';
import {
  AGENT_PROMPT_STALLED_ERROR,
  DEFAULT_NESTED_WORKER_MAX_DEPTH,
  DISPATCH_CIRCUIT_BREAK_FAILURES,
  OrchestrationError,
  UNBOUND_RUN_ID,
  type OrchestrationCoordinatorRunRecord,
  type OrchestrationDispatchRecord,
  type OrchestrationDispatchStage,
  type OrchestrationIntegrationStatus,
  type OrchestrationMessagePriority,
  type OrchestrationMessageRecord,
  type OrchestrationReviewFinding,
  type OrchestrationReviewStatus,
  type OrchestrationResumeClaim,
  type OrchestrationWorkerHandoff,
  type OrchestrationObservationFact,
  type OrchestrationRunIntegrationStatus,
  type OrchestrationRunRecord,
  type OrchestrationStartObservation,
  type OrchestrationTaskContext,
  type OrchestrationTaskRecord,
  type OrchestrationTaskStatus,
  type OrchestrationTaskWithDispatch,
  type OrchestrationWorkerReportOutcome,
  type WorkerTurnStopReason,
} from './orchestration-types.js';
import {
  cloneMessageRecord,
  cloneRunRecord,
  cloneTaskRecord,
  generatePrefixedId,
} from './orchestration-state-repository.js';
import { DISPATCH_CREDENTIAL_PREFIX } from './orchestration-security-store.js';
import { type OrchestrationStoreContext, OrchestrationStoreSlice } from './orchestration-store-slice.js';

/** Bounds on the append-only observation log. */
const MAX_FACTS_PER_RUN = 400;
const MAX_FACTS = 4_000;

export class OrchestrationLifecycleStore extends OrchestrationStoreSlice {
  private briefsDirOverride: string | null;
  private maxActiveDispatches = Number.POSITIVE_INFINITY;

  constructor(ctx: OrchestrationStoreContext, briefsDir?: string) {
    super(ctx);
    this.briefsDirOverride = briefsDir?.trim() || null;
  }

  getBriefsDir(): string | null {
    const filePath = this.resolveFile?.();
    return this.briefsDirOverride ?? (filePath ? join(dirname(filePath), 'orchestration-briefs') : null);
  }

  configureBriefsDir(directory: string): void {
    this.briefsDirOverride = directory;
    this.reconcileBriefFiles();
  }

  /** Upper bound on simultaneously active dispatches across every run. */
  configureMaxActiveDispatches(limit: number): void {
    this.maxActiveDispatches = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : Number.POSITIVE_INFINITY;
  }

  getRemainingDispatchCapacity(): number {
    let active = 0;
    for (const d of this.state.dispatches.values()) {
      if (ACTIVE_DISPATCH_STATUSES.has(d.status)) active += 1;
    }
    return Math.max(0, this.maxActiveDispatches - active);
  }

  assertDispatchCapacity(): void {
    if (this.getRemainingDispatchCapacity() <= 0) {
      throw new OrchestrationError(
        'worker_limit_reached',
        `At most ${this.maxActiveDispatches} workers may be active at once. Wait for one to finish or stop one first.`,
        { maxActiveDispatches: this.maxActiveDispatches },
      );
    }
  }

  reconcileBriefFiles(): void {
    const directory = this.getBriefsDir();
    const files = listWorkerBriefFiles(directory);
    if (!files) return;
    const existing = new Map<string, string>();
    const unsafe = new Set<string>();
    const temporary = new Set<string>();
    for (const file of files) {
      if (file.temporary) temporary.add(file.dispatchId);
      else if (file.regularFile) existing.set(file.dispatchId, file.path);
      else unsafe.add(file.dispatchId);
    }
    const failedRemovals = new Set<string>();
    const fileOwners = new Set([...existing.keys(), ...temporary, ...unsafe]);
    for (const id of fileOwners) {
      const dispatch = this.state.dispatches.get(id);
      const keep = dispatch?.briefFilePath && !dispatch.releasedAt && !unsafe.has(id) &&
        dispatch.status !== 'failed' && dispatch.status !== 'circuit_broken';
      if (keep) {
        if (temporary.has(id)) removeWorkerBriefFile(directory, id, true);
      } else {
        if (!removeWorkerBriefFile(directory, id)) failedRemovals.add(id);
        existing.delete(id);
      }
    }
    let changed = false;
    for (const dispatch of this.state.dispatches.values()) {
      if (!dispatch.briefFilePath || failedRemovals.has(dispatch.id)) continue;
      const path = existing.get(dispatch.id) ?? null;
      if (path === dispatch.briefFilePath) continue;
      dispatch.briefFilePath = path;
      changed = true;
    }
    if (changed) this.persist();
  }

  cleanupDispatchBrief(dispatchId: string): void {
    const dispatch = this.state.dispatches.get(dispatchId);
    if (dispatch?.briefFilePath && removeWorkerBriefFile(this.getBriefsDir(), dispatchId)) {
      dispatch.briefFilePath = null;
      this.persist();
    }
  }

  // ==================== Runs ====================

  ensureUnboundRun(): OrchestrationRunRecord {
    const existing = this.state.runs.get(UNBOUND_RUN_ID);
    if (existing) {
      return existing;
    }
    const now = this.now();
    const run: OrchestrationRunRecord = {
      id: UNBOUND_RUN_ID,
      objective: 'Unbound direct orchestration mail',
      status: 'active',
      coordinatorHandle: 'coordinator',
      coordinatorPaneId: null,
      consumerGeneration: 1,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    this.state.runs.set(run.id, run);
    return run;
  }

  createRun(input: {
    id?: string;
    objective: string;
    coordinatorHandle: string;
    coordinatorPaneId?: string | null;
  }): OrchestrationRunRecord {
    const id = input.id?.trim() || generatePrefixedId('run');
    if (this.state.runs.has(id)) {
      throw new OrchestrationError('duplicate_run', `Run already exists: ${id}`);
    }
    const now = this.now();
    const run: OrchestrationRunRecord = {
      id,
      objective: input.objective,
      status: 'active',
      coordinatorHandle: input.coordinatorHandle,
      coordinatorPaneId: input.coordinatorPaneId ?? null,
      consumerGeneration: 1,
      createdAt: now,
      updatedAt: now,
      endedAt: null,
    };
    this.state.runs.set(run.id, run);
    this.bindConsumerToRun(run.id, input.coordinatorHandle, input.coordinatorPaneId ?? null);
    this.security.prune();
    this.persist();
    return { ...run };
  }

  private bindConsumerToRun(runId: string, handle: string, paneId: string | null): void {
    if (paneId) {
      this.state.currentRunByConsumer.set(paneId, runId);
    }
    if (handle) {
      this.state.currentRunByConsumer.set(handle, runId);
    }
  }

  bindRun(input: {
    runId: string;
    coordinatorHandle: string;
    coordinatorPaneId?: string | null;
  }): OrchestrationRunRecord | null {
    const run = this.state.runs.get(input.runId);
    if (!run || run.id === UNBOUND_RUN_ID) {
      return null;
    }
    const now = this.now();
    const prevHandle = run.coordinatorHandle;
    const prevPaneId = run.coordinatorPaneId;
    if (prevHandle && this.state.currentRunByConsumer.get(prevHandle) === run.id) {
      this.state.currentRunByConsumer.delete(prevHandle);
    }
    if (prevPaneId && this.state.currentRunByConsumer.get(prevPaneId) === run.id) {
      this.state.currentRunByConsumer.delete(prevPaneId);
    }

    run.coordinatorHandle = input.coordinatorHandle;
    run.coordinatorPaneId = input.coordinatorPaneId ?? null;
    run.consumerGeneration += 1;
    run.updatedAt = now;
    this.bindConsumerToRun(run.id, input.coordinatorHandle, input.coordinatorPaneId ?? null);

    const runMailbox = `run:${run.id}`;
    for (const d of this.state.deliveries.values()) {
      if (
        d.mailboxHandle === runMailbox &&
        d.status === 'pending' &&
        d.consumerGeneration < run.consumerGeneration
      ) {
        d.status = 'fenced';
        for (const msgId of d.messageIds) {
          const msg = this.state.messages.get(msgId);
          if (msg && !msg.read) {
            if (d.consumerHandle) {
              this.state.consumerDeliveredByMessageId.get(msgId)?.delete(d.consumerHandle);
            }
            if (msg.deliveredAt !== null) {
              msg.deliveredAt = null;
            }
          }
        }
      }
    }

    this.persist();
    return { ...run };
  }

  getConsumersForRun(runId: string): string[] {
    const consumers = new Set<string>();
    const run = this.state.runs.get(runId);
    if (run) {
      if (run.coordinatorPaneId) consumers.add(run.coordinatorPaneId);
      if (run.coordinatorHandle) consumers.add(run.coordinatorHandle);
    }
    for (const [consumer, boundRunId] of this.state.currentRunByConsumer.entries()) {
      if (boundRunId === runId) {
        consumers.add(consumer);
      }
    }
    return [...consumers];
  }

  getRun(runId: string): OrchestrationRunRecord | undefined {
    const run = this.state.runs.get(runId);
    return run ? cloneRunRecord(run) : undefined;
  }

  requireRun(runId: string): OrchestrationRunRecord {
    const run = this.state.runs.get(runId);
    if (!run) {
      throw new OrchestrationError('run_not_found', `Run ${runId} was not found.`);
    }
    return cloneRunRecord(run);
  }

  getCurrentRunForConsumer(handleOrPane: string): OrchestrationRunRecord | undefined {
    const direct = this.state.currentRunByConsumer.get(handleOrPane);
    if (direct) {
      const run = this.state.runs.get(direct);
      if (run && run.id !== UNBOUND_RUN_ID) {
        return cloneRunRecord(run);
      }
    }
    return undefined;
  }

  listRuns(filter?: { status?: string }): OrchestrationRunRecord[] {
    return [...this.state.runs.values()]
      .filter((r) => r.id !== UNBOUND_RUN_ID && (!filter?.status || r.status === filter.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(cloneRunRecord);
  }

  updateRunStatus(
    runId: string,
    status: OrchestrationRunRecord['status']
  ): OrchestrationRunRecord {
    const run = this.state.runs.get(runId);
    if (!run) {
      throw new OrchestrationError('run_not_found', `Run ${runId} was not found.`);
    }
    const now = this.now();
    run.status = status;
    run.updatedAt = now;
    if (status === 'completed' || status === 'failed' || status === 'stopped') {
      run.endedAt = run.endedAt ?? now;
    } else if (status === 'active') {
      run.endedAt = null;
    }
    this.security.prune();
    this.persist();
    return cloneRunRecord(run);
  }

  updateRunIntegrationState(
    runId: string,
    patch: {
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
    },
  ): OrchestrationRunRecord | null {
    const run = this.state.runs.get(runId);
    if (!run) return null;
    if (patch.integrationBranch !== undefined) run.integrationBranch = patch.integrationBranch;
    if (patch.integrationWorktreePath !== undefined) {
      run.integrationWorktreePath = patch.integrationWorktreePath;
    }
    if (patch.integrationBaseCommit !== undefined) {
      run.integrationBaseCommit = patch.integrationBaseCommit;
    }
    if (patch.integrationBaseBranch !== undefined) {
      run.integrationBaseBranch = patch.integrationBaseBranch;
    }
    if (patch.integrationRepoRootPath !== undefined) {
      run.integrationRepoRootPath = patch.integrationRepoRootPath;
    }
    if (patch.integrationStatus !== undefined) run.integrationStatus = patch.integrationStatus;
    if (patch.integrationHeadCommit !== undefined) {
      run.integrationHeadCommit = patch.integrationHeadCommit;
    }
    if (patch.integrationIntent !== undefined) run.integrationIntent = patch.integrationIntent;
    if (patch.finalizedBatch) run.finalizedBatches = [...(run.finalizedBatches ?? []), patch.finalizedBatch];
    if (patch.finalizedCommit !== undefined) run.finalizedCommit = patch.finalizedCommit;
    run.updatedAt = this.now();
    this.persist();
    return cloneRunRecord(run);
  }

  updateRunReviewState(
    runId: string,
    patch: {
      runReviewBatchId?: string | null;
      runReviewSnapshotOid?: string | null;
      runReviewBaseCommit?: string | null;
      runReviewStatus?: OrchestrationReviewStatus;
      runReviewRound?: number;
      runReviewFindings?: OrchestrationReviewFinding[];
    },
  ): OrchestrationRunRecord | null {
    const run = this.state.runs.get(runId);
    if (!run) return null;
    if (patch.runReviewBatchId !== undefined) run.runReviewBatchId = patch.runReviewBatchId;
    if (patch.runReviewSnapshotOid !== undefined) {
      run.runReviewSnapshotOid = patch.runReviewSnapshotOid;
    }
    if (patch.runReviewBaseCommit !== undefined) {
      run.runReviewBaseCommit = patch.runReviewBaseCommit;
    }
    if (patch.runReviewStatus !== undefined) run.runReviewStatus = patch.runReviewStatus;
    if (patch.runReviewRound !== undefined) run.runReviewRound = patch.runReviewRound;
    if (patch.runReviewFindings !== undefined) {
      run.runReviewFindings = patch.runReviewFindings.map((f) => ({ ...f }));
    }
    run.updatedAt = this.now();
    this.persist();
    return cloneRunRecord(run);
  }

  setRunAutoReviewAuthorized(
    runId: string,
    authorized: boolean,
  ): OrchestrationRunRecord | null {
    const run = this.state.runs.get(runId);
    if (!run) return null;
    run.reviewAutoAuthorized = Boolean(authorized);
    run.updatedAt = this.now();
    this.persist();
    return cloneRunRecord(run);
  }

  // ==================== Tasks ====================

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
    const run = this.requireRun(input.runId);
    if (run.id === UNBOUND_RUN_ID) {
      throw new OrchestrationError('invalid_argument', 'Cannot create tasks in the unbound run.');
    }
    const id = input.id?.trim() || generatePrefixedId('task');
    if (this.state.tasks.has(id)) {
      throw new OrchestrationError('duplicate_task', `Task already exists: ${id}`);
    }
    const dedupedDeps = [...new Set((input.deps ?? []).map((d) => d.trim()).filter(Boolean))];
    const codeDeps = [...new Set((input.codeDeps ?? []).map(dep => dep.trim()).filter(Boolean))];
    const allDeps = [...new Set([...dedupedDeps, ...codeDeps])];
    if (allDeps.includes(id)) {
      throw new OrchestrationError('task_cycle', `Task ${id} cannot depend on itself.`);
    }
    for (const depId of allDeps) {
      const depTask = this.state.tasks.get(depId);
      if (!depTask) {
        throw new OrchestrationError('task_not_found', `Dependency task not found: ${depId}`);
      }
      if (depTask.runId !== input.runId) {
        throw new OrchestrationError(
          'invalid_argument',
          `Dependency ${depId} belongs to run ${depTask.runId}, not ${input.runId}.`
        );
      }
    }
    if (this.wouldIntroduceCycle(id, allDeps)) {
      throw new OrchestrationError(
        'cyclic_dependency',
        `Creating task ${id} would introduce a cyclic dependency.`
      );
    }
    const allDepsCompleted = codeDeps.every(dep => this.codeReady(dep)) && dedupedDeps.every(
      (depId) => this.state.tasks.get(depId)?.status === 'completed'
    );
    const display = buildOrchestrationTaskDisplayMetadata({
      spec: input.spec,
      taskTitle: input.taskTitle,
      displayName: input.displayName,
    });
    const normalizedContext = normalizeTaskContext({ taskContext: input.taskContext });
    const now = this.now();
    const task: OrchestrationTaskRecord = {
      id,
      runId: input.runId,
      spec: this.security.redactDispatchCredentials(input.spec),
      ...(normalizedContext ? { taskContext: normalizedContext } : {}),
      taskTitle: display.taskTitle,
      displayName: display.displayName,
      deps: dedupedDeps,
      ...(codeDeps.length ? { codeDeps } : {}),
      ...(input.queuedLaunch ? { queuedLaunch: { ...input.queuedLaunch } } : {}),
      priority: input.priority ?? 'normal',
      status: allDepsCompleted ? 'ready' : 'pending',
      ...(input.singleShot ? { singleShot: true } : {}),
      worktreePath: input.worktreePath ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.state.tasks.set(task.id, task);
    if (input.queuedLaunch && run.status !== 'active') this.updateRunStatus(run.id, 'active');
    this.promoteReadyTasks(run.id);
    this.persist();
    return cloneTaskRecord(task);
  }

  codeReady(taskId: string): boolean {
    const dispatch = this.codeDependency(taskId);
    return dispatch?.status === 'completed' && dispatch.integrationStatus === 'merged' && Boolean(dispatch.integratedCommit);
  }

  codeDependency(taskId: string): OrchestrationDispatchRecord | undefined {
    const latest = this.getLatestDispatchForTask(taskId);
    return latest && this.resolveDispatchLineage(latest.id);
  }

  hasQueuedWork(): boolean {
    for (const task of this.state.tasks.values()) if (task.queuedLaunch?.state === 'waiting') return true;
    return false;
  }

  setQueuedLaunch(taskId: string, launch?: OrchestrationTaskRecord['queuedLaunch']): void {
    const task = this.state.tasks.get(taskId);
    if (!task) return;
    if (launch) task.queuedLaunch = { ...launch };
    else delete task.queuedLaunch;
    this.persist();
  }

  private wouldIntroduceCycle(newTaskId: string, newDeps: readonly string[]): boolean {
    const visiting = new Set<string>([newTaskId]);
    const visited = new Set<string>();
    const dfs = (node: string, depth: number): boolean => {
      const deps = node === newTaskId ? newDeps : [...(this.state.tasks.get(node)?.deps ?? []), ...(this.state.tasks.get(node)?.codeDeps ?? [])];
      for (const dep of deps) {
        if (dep === newTaskId && depth >= 1) {
          return true;
        }
        if (visiting.has(dep)) {
          return true;
        }
        if (visited.has(dep)) {
          continue;
        }
        visiting.add(dep);
        if (dfs(dep, depth + 1)) {
          return true;
        }
        visiting.delete(dep);
        visited.add(dep);
      }
      return false;
    };
    return dfs(newTaskId, 0);
  }

  getTask(taskId: string): OrchestrationTaskRecord | undefined {
    const task = this.state.tasks.get(taskId);
    return task ? cloneTaskRecord(task) : undefined;
  }

  requireTask(taskId: string): OrchestrationTaskRecord {
    const task = this.getTask(taskId);
    if (!task) {
      throw new OrchestrationError('task_not_found', `Task not found: ${taskId}`);
    }
    return task;
  }

  listTasks(filter?: {
    runId?: string;
    status?: OrchestrationTaskStatus;
    priority?: OrchestrationMessagePriority;
  }): OrchestrationTaskRecord[] {
    return [...this.state.tasks.values()]
      .filter((t) => {
        if (filter?.runId && t.runId !== filter.runId) return false;
        if (filter?.status && t.status !== filter.status) return false;
        if (filter?.priority && t.priority !== filter.priority) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((t) => cloneTaskRecord(t));
  }

  listTasksWithDispatch(filter?: {
    runId?: string;
    status?: OrchestrationTaskStatus;
  }): OrchestrationTaskWithDispatch[] {
    return this.listTasks(filter).map((task) => ({
      ...task,
      latestDispatch: this.getLatestDispatchForTask(task.id) ?? null,
    }));
  }

  /**
   * Moves the DAG forward after any task change: blocks dependents of failed tasks (and unblocks
   * them once the dependency is retried) and promotes pending tasks whose deps completed.
   */
  promoteReadyTasks(runId?: string): OrchestrationTaskRecord[] {
    const promoted: OrchestrationTaskRecord[] = [];
    const now = this.now();
    const changed = this.reconcileDependencyBlocks(runId, now);
    for (const task of this.state.tasks.values()) {
      if (runId && task.runId !== runId) continue;
      if (task.status !== 'pending') continue;
      if (this.mailbox.hasPendingGates(task.id)) continue;
      const depsDone = task.deps.every((depId) => this.state.tasks.get(depId)?.status === 'completed');
      if (!depsDone || task.codeDeps?.some(id => !this.codeReady(id))) continue;
      assertTaskTransition(task.id, task.status, 'ready');
      task.status = 'ready';
      task.updatedAt = now;
      promoted.push({ ...task, deps: [...task.deps] });
    }
    if (promoted.length > 0 || changed) {
      this.persist();
    }
    return promoted;
  }

  private reconcileDependencyBlocks(runId: string | undefined, now: string): boolean {
    let changed = false;
    for (let pass = 0, moved = true; moved && pass <= this.state.tasks.size; pass += 1) {
      moved = false;
      for (const task of this.state.tasks.values()) {
        if (runId && task.runId !== runId) continue;
        if (task.status !== 'blocked' && task.blockedReason) {
          task.blockedReason = null;
          changed = true;
        }
        const failedDep = [...task.deps, ...(task.codeDeps ?? [])].find((depId) => {
          const dep = this.state.tasks.get(depId);
          return Boolean(dep && (dep.status === 'failed' || isBlockedByFailedDependency(dep) || (task.codeDeps?.includes(depId) && this.codeDependency(depId)?.status === 'failed')));
        });
        if ((task.status === 'pending' || task.status === 'ready') && failedDep) {
          task.status = 'blocked';
          task.blockedReason = `${DEPENDENCY_FAILED_REASON}:${failedDep}`;
          task.updatedAt = now;
          moved = true;
        } else if (isBlockedByFailedDependency(task) && !failedDep && !this.mailbox.hasPendingGates(task.id)) {
          task.status = 'pending';
          task.blockedReason = null;
          task.updatedAt = now;
          moved = true;
        }
      }
      changed ||= moved;
    }
    return changed;
  }

  mergeTaskContext(taskId: string, override: OrchestrationTaskContext): OrchestrationTaskRecord {
    const task = this.state.tasks.get(taskId);
    if (!task) throw new OrchestrationError('task_not_found', 'Task not found: ' + taskId);
    task.taskContext = mergeTaskContext(task.taskContext, override);
    task.updatedAt = this.now();
    this.persist();
    return cloneTaskRecord(task);
  }

  updateTaskStatus(taskId: string, status: OrchestrationTaskStatus): OrchestrationTaskRecord {
    const task = this.state.tasks.get(taskId);
    if (!task) {
      throw new OrchestrationError('task_not_found', `Task not found: ${taskId}`);
    }
    if (task.status === status) {
      if (status === 'completed') {
        this.promoteReadyTasks(task.runId);
      }
      return { ...task, deps: [...task.deps] };
    }
    if (status === 'ready' && this.mailbox.hasPendingGates(taskId)) {
      throw new OrchestrationError(
        'invalid_transition',
        `Task ${taskId} has pending decision gates and cannot become ready.`
      );
    }
    assertTaskTransition(task.id, task.status, status);
    const now = this.now();
    task.status = status;
    task.blockedReason = null;
    task.updatedAt = now;

    if (status === 'completed' || status === 'failed') {
      this.settleActiveDispatchesForTask(
        taskId,
        status === 'completed' ? 'completed' : 'failed',
        `Task marked ${status}`
      );
    }
    this.promoteReadyTasks(task.runId);
    this.persist();
    return { ...task, deps: [...task.deps] };
  }

  // ==================== Dispatches & Circuit Breaker ====================

  getDispatchContext(dispatchId: string): OrchestrationDispatchRecord | undefined {
    const ctx = this.state.dispatches.get(dispatchId);
    return ctx ? { ...ctx } : undefined;
  }

  getLatestDispatchForTask(taskId: string): OrchestrationDispatchRecord | undefined {
    const matches = [...this.state.dispatches.values()]
      .filter((d) => d.taskId === taskId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const last = matches[matches.length - 1];
    return last ? { ...last } : undefined;
  }

  getActiveDispatchesForTask(taskId: string): OrchestrationDispatchRecord[] {
    return [...this.state.dispatches.values()]
      .filter((d) => d.taskId === taskId && ACTIVE_DISPATCH_STATUSES.has(d.status))
      .map((d) => ({ ...d }));
  }

  /**
   * Takes the single-writer claim for resuming `workerId` in `cwd`. Refuses while another claim
   * holds the Worker or the directory; a stale claim from an earlier app run is cleared once its
   * recorded process is gone. Callers `flushDurable()` before starting the agent process.
   */
  acquireResumeClaim(
    input: {
      workerId: string; runId: string; dispatchId: string; cwd: string; driver: string; providerSessionId: string;
      actor?: OrchestrationResumeClaim['actor'];
    },
    isAlive: (pid: number) => boolean = isProcessTreeAlive,
  ): OrchestrationResumeClaim {
    const cwd = comparablePath(input.cwd);
    for (const claim of [...this.state.resumeClaims.values()]) {
      if (claim.workerId !== input.workerId && comparablePath(claim.cwd) !== cwd) continue;
      if (claim.status === 'stale' && (claim.pid === null || !isAlive(claim.pid))) {
        this.state.resumeClaims.delete(claim.id);
        continue;
      }
      throw new OrchestrationError(
        'operation_rejected',
        claim.status === 'stale'
          ? `A Worker process (pid ${claim.pid}) from an earlier AhaStation run may still be writing ${claim.cwd}. Stop it before resuming.`
          : `Worker ${claim.workerId} already holds ${claim.cwd}; wait for it to finish or stop it first.`,
        { claimId: claim.id, workerId: claim.workerId },
      );
    }
    const now = this.now();
    const claim: OrchestrationResumeClaim = {
      id: `resume-${randomUUID()}`,
      workerId: input.workerId,
      runId: input.runId,
      dispatchId: input.dispatchId,
      cwd: input.cwd,
      driver: input.driver,
      providerSessionId: input.providerSessionId,
      status: 'pending',
      pid: null,
      hostId: 'local',
      actor: input.actor ?? 'orchestrator',
      createdAt: now,
      updatedAt: now,
    };
    this.state.resumeClaims.set(claim.id, claim);
    this.persist();
    return { ...claim };
  }

  /** Records the started agent process on a pending claim. */
  activateResumeClaim(claimId: string, pid: number | null): OrchestrationResumeClaim | undefined {
    const claim = this.state.resumeClaims.get(claimId);
    if (!claim || claim.status === 'stale') return undefined;
    claim.status = 'active';
    claim.pid = pid !== null && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
    claim.updatedAt = this.now();
    this.persist();
    return { ...claim };
  }

  /** Drops the live claims for `workerId` once its process is gone; stale ones stay until verified. */
  releaseResumeClaims(workerId: string): void {
    let changed = false;
    for (const [id, claim] of this.state.resumeClaims) {
      if (claim.workerId === workerId && claim.status !== 'stale') {
        this.state.resumeClaims.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  /** Forgets every claim for `workerId`, e.g. when its run is pruned. */
  dropResumeClaimsForWorker(workerId: string): void {
    for (const [id, claim] of this.state.resumeClaims) {
      if (claim.workerId === workerId) this.state.resumeClaims.delete(id);
    }
  }

  createWorkerHandoff(
    input: Pick<OrchestrationWorkerHandoff,
      'runId' | 'sourceDispatchId' | 'sourceWorkerId' | 'fromCli' | 'toCli' | 'cwd' | 'targetWorkerId' | 'snapshotOid' | 'context'>
      & { actor?: OrchestrationWorkerHandoff['actor'] },
  ): OrchestrationWorkerHandoff {
    const now = this.now();
    const handoff: OrchestrationWorkerHandoff = {
      id: `handoff-${randomUUID()}`,
      ...input,
      status: 'pending',
      targetDispatchId: null,
      providerSessionId: null,
      reason: null,
      announcedAt: null,
      hostId: 'local',
      actor: input.actor ?? 'orchestrator',
      createdAt: now,
      updatedAt: now,
    };
    this.state.workerHandoffs.set(handoff.id, handoff);
    this.recordHandoffFact(handoff);
    this.persist();
    return { ...handoff };
  }

  private recordHandoffFact(handoff: OrchestrationWorkerHandoff): void {
    this.appendObservationFact({
      runId: handoff.runId, dispatchId: handoff.targetDispatchId ?? handoff.sourceDispatchId, workerId: handoff.targetWorkerId,
      kind: 'handoff',
      data: {
        handoffId: handoff.id, status: handoff.status, fromCli: handoff.fromCli, toCli: handoff.toCli,
        snapshotOid: handoff.snapshotOid, sourceDispatchId: handoff.sourceDispatchId,
      },
    });
  }

  /**
   * Appends a fact; facts are never changed afterwards. Each run keeps its newest
   * `MAX_FACTS_PER_RUN`, and the whole log its newest `MAX_FACTS`.
   */
  appendObservationFact(input: Omit<OrchestrationObservationFact, 'seq' | 'at'>): OrchestrationObservationFact {
    const fact: OrchestrationObservationFact = {
      ...input,
      data: Object.fromEntries(Object.entries(input.data).map(([key, value]) => [
        key, typeof value === 'string' ? this.security.redactDispatchCredentials(value).slice(0, 500) : value,
      ])),
      seq: this.state.nextObservationFactSeq++,
      at: this.now(),
    };
    const facts = this.state.observationFacts;
    facts.push(fact);
    const forRun = facts.filter((entry) => entry.runId === fact.runId);
    if (forRun.length > MAX_FACTS_PER_RUN) {
      const drop = new Set(forRun.slice(0, forRun.length - MAX_FACTS_PER_RUN).map((entry) => entry.seq));
      this.state.observationFacts = facts.filter((entry) => !drop.has(entry.seq));
    }
    if (this.state.observationFacts.length > MAX_FACTS) this.state.observationFacts.splice(0, this.state.observationFacts.length - MAX_FACTS);
    this.persist();
    return { ...fact, data: { ...fact.data } };
  }

  listObservationFacts(filter: { runId?: string; dispatchId?: string; workerId?: string; afterSeq?: number; limit?: number } = {}): OrchestrationObservationFact[] {
    const matched = this.state.observationFacts.filter((fact) =>
      (!filter.runId || fact.runId === filter.runId) &&
      (!filter.dispatchId || fact.dispatchId === filter.dispatchId) &&
      (!filter.workerId || fact.workerId === filter.workerId) &&
      (filter.afterSeq === undefined || fact.seq > filter.afterSeq));
    const limit = Math.max(1, Math.min(filter.limit ?? 200, 1_000));
    return matched.slice(-limit).map((fact) => ({ ...fact, data: { ...fact.data } }));
  }

  updateWorkerHandoff(
    id: string,
    patch: Partial<Pick<OrchestrationWorkerHandoff, 'status' | 'targetDispatchId' | 'providerSessionId' | 'reason' | 'announcedAt'>>,
  ): OrchestrationWorkerHandoff | undefined {
    const handoff = this.state.workerHandoffs.get(id);
    if (!handoff) return undefined;
    const statusChanged = patch.status !== undefined && patch.status !== handoff.status;
    Object.assign(handoff, patch, { updatedAt: this.now() });
    if (statusChanged) this.recordHandoffFact(handoff);
    this.persist();
    return { ...handoff };
  }

  listWorkerHandoffs(filter: { runId?: string; status?: OrchestrationWorkerHandoff['status'] } = {}): OrchestrationWorkerHandoff[] {
    return [...this.state.workerHandoffs.values()]
      .filter((handoff) => (!filter.runId || handoff.runId === filter.runId) && (!filter.status || handoff.status === filter.status))
      .map((handoff) => ({ ...handoff }));
  }

  listResumeClaims(): OrchestrationResumeClaim[] {
    return [...this.state.resumeClaims.values()].map((claim) => ({ ...claim }));
  }

  getActiveDispatchForIdentity(
    handle: string,
    paneId?: string | null
  ): OrchestrationDispatchRecord | undefined {
    for (const d of this.state.dispatches.values()) {
      if (!ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
      if (paneId && d.assigneePaneId === paneId) {
        return { ...d };
      }
      if (d.assigneeHandle === handle || (d.assigneePaneId && d.assigneePaneId === handle)) {
        return { ...d };
      }
    }
    return undefined;
  }

  listDispatches(filter?: {
    runId?: string;
    taskId?: string;
    status?: OrchestrationDispatchRecord['status'];
  }): OrchestrationDispatchRecord[] {
    return [...this.state.dispatches.values()]
      .filter((d) => {
        if (filter?.runId && d.runId !== filter.runId) return false;
        if (filter?.taskId && d.taskId !== filter.taskId) return false;
        if (filter?.status && d.status !== filter.status) return false;
        return true;
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => ({ ...d }));
  }

  resolveChildDispatchDepth(creatorDispatchId?: string | null): number {
    if (!creatorDispatchId) {
      return 1;
    }
    const clean = creatorDispatchId.startsWith('dispatch:')
      ? creatorDispatchId.slice('dispatch:'.length)
      : creatorDispatchId;
    const parent = this.state.dispatches.get(clean);
    return parent ? parent.depth + 1 : 1;
  }

  createDispatchContext(input: {
    taskId: string;
    approvedQueueLaunch?: boolean;
    providerSessionId?: string;
    providerCwd?: string;
    authorCliIds?: readonly string[];
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
    const task = this.state.tasks.get(input.taskId);
    if (!task) {
      throw new OrchestrationError('task_not_found', `Task not found: ${input.taskId}`);
    }
    if (task.status !== 'ready') {
      throw new OrchestrationError(
        'task_not_ready',
        `Task ${task.id} is ${task.status}; only ready tasks can be dispatched.`,
        { taskId: task.id, status: task.status }
      );
    }
    if (task.queuedLaunch && !(input.approvedQueueLaunch && task.queuedLaunch.state === 'claimed')) {
      throw new OrchestrationError('task_not_ready', '排队任务需要由已批准的派发领取。');
    }
    if (task.codeDeps?.some(dep => !this.codeReady(dep))) {
      throw new OrchestrationError('task_not_ready', '等待上游代码合入共享分支。');
    }
    if (this.mailbox.hasPendingGates(task.id)) {
      throw new OrchestrationError(
        'task_not_ready',
        `Task ${task.id} has pending decision gates.`
      );
    }

    const maxDepth = input.maxDepth ?? DEFAULT_NESTED_WORKER_MAX_DEPTH;
    const cleanCreatorDispatchId = input.creatorDispatchId
      ? input.creatorDispatchId.startsWith('dispatch:')
        ? input.creatorDispatchId.slice('dispatch:'.length)
        : input.creatorDispatchId
      : null;
    const depth = Math.max(this.resolveChildDispatchDepth(cleanCreatorDispatchId), (input.parentDepth ?? 0) + 1);
    if (depth > maxDepth) {
      throw new OrchestrationError(
        'operation_rejected',
        `Nested worker dispatch depth ${depth} exceeds max depth ${maxDepth}.`,
        { depth, maxDepth }
      );
    }

    const priorMaxFailureCount = [...this.state.dispatches.values()]
      .filter((d) => d.taskId === task.id)
      .reduce((max, d) => Math.max(max, d.failureCount), 0);

    if (priorMaxFailureCount >= DISPATCH_CIRCUIT_BREAK_FAILURES) {
      assertTaskTransition(task.id, task.status, 'failed');
      task.status = 'failed';
      task.updatedAt = this.now();
      this.promoteReadyTasks(task.runId);
      this.persist();
      throw new OrchestrationError(
        'circuit_broken',
        `Task ${task.id} exceeded ${DISPATCH_CIRCUIT_BREAK_FAILURES} failed dispatches and is circuit-broken.`,
        { taskId: task.id, failureCount: priorMaxFailureCount }
      );
    }

    const activeForAssignee = this.getActiveDispatchForIdentity(
      input.assigneeHandle,
      input.assigneePaneId
    );
    if (activeForAssignee) {
      throw new OrchestrationError(
        'worker_busy',
        `Worker ${input.assigneeHandle} already holds active dispatch ${activeForAssignee.id}.`,
        { activeDispatchId: activeForAssignee.id, assigneeHandle: input.assigneeHandle }
      );
    }
    this.assertDispatchCapacity();

    const now = this.now();
    // New work reopens a run that had already settled.
    const run = this.state.runs.get(task.runId);
    if (run && run.id !== UNBOUND_RUN_ID && run.status !== 'active') {
      run.status = 'active';
      run.endedAt = null;
      run.updatedAt = now;
    }
    const resolvedWorktreePath = input.worktreePath ?? task.worktreePath ?? null;
    if (resolvedWorktreePath && !task.worktreePath) {
      task.worktreePath = resolvedWorktreePath;
    }
    const initialObservation = input.startObservation ?? 'pending';
    const initialStage: OrchestrationDispatchStage =
      initialObservation === 'permission'
        ? 'waiting_permission'
        : initialObservation === 'observed'
          ? 'working'
          : 'starting';

    const ctx: OrchestrationDispatchRecord = {
      id: generatePrefixedId('ctx'),
      taskId: task.id,
      runId: task.runId,
      creator: input.creator ?? 'coordinator',
      creatorRunId: input.creatorRunId ?? task.runId,
      creatorDispatchId: cleanCreatorDispatchId,
      parentPaneId: input.parentPaneId ?? null,
      depth,
      assigneeHandle: input.assigneeHandle,
      ...(input.providerSessionId ? {
        executionMode: 'codex-app-server' as const,
        providerSessionId: input.providerSessionId,
        ...(input.providerCwd ? { providerCwd: input.providerCwd } : {}),
        ...(input.authorCliIds && input.authorCliIds.length > 0 ? { authorCliIds: [...new Set(input.authorCliIds)] } : {}),
        ...(input.workerPolicy !== undefined ? { workerPolicy: input.workerPolicy } : {}),
        ...(typeof input.workerNetwork === 'boolean' ? { workerNetwork: input.workerNetwork } : {}),
        ...(input.allowSubWorkers ? { allowSubWorkers: true } : {}),
      } : {}),
      assigneePaneId: input.assigneePaneId ?? null,
      processIncarnation: input.processIncarnation ?? null,
      worktreePath: resolvedWorktreePath,
      branch: input.branch ?? null,
      ...(input.baseCommit ? { baseCommit: input.baseCommit } : {}),
      ...(input.repoRootPath ? { repoRootPath: input.repoRootPath } : {}),
      ownsWorktree: input.ownsWorktree ?? false,
      ...(input.ownsBranch ? { ownsBranch: true } : {}),
      ...(input.isDetachedReviewWorktree ? { isDetachedReviewWorktree: true } : {}),
      ...(input.reviewOfDispatchId ? { reviewOfDispatchId: input.reviewOfDispatchId } : {}),
      ...(input.reviewOfRunId ? { reviewOfRunId: input.reviewOfRunId } : {}),
      ...(input.reviewFocus ? { reviewFocus: input.reviewFocus } : {}),
      ...(input.reviewBatchId ? { reviewBatchId: input.reviewBatchId } : {}),
      ...(input.reviewSnapshotOid ? { reviewSnapshotOid: input.reviewSnapshotOid } : {}),
      ...(input.reviewBaseCommit ? { reviewBaseCommit: input.reviewBaseCommit } : {}),
      ...(typeof input.reviewRound === 'number' && input.reviewRound > 0 ? { reviewRound: input.reviewRound } : {}),
      taskKind: input.taskKind,
      ownsPane: input.ownsPane ?? false,
      cliId: input.cliId ?? null,
      model: input.model ?? null,
      effort: input.effort ?? null,
      processGeneration: input.processGeneration ?? 1,
      stage: initialStage,
      turnStopReportedGeneration: null,
      followUpOfDispatchId: input.followUpOfDispatchId ?? null,
      retained: input.retained ?? false,
      releasedAt: null,
      archivedOutput: null,
      status: 'dispatched',
      failureCount: priorMaxFailureCount,
      lastFailureReason: null,
      failureSummary: null,
      lastHeartbeatAt: now,
      consumerGeneration: 1,
      createdAt: now,
      updatedAt: now,
      completedAt: null,
      startObservation: initialObservation,
      startObservationReason: input.startObservationReason ?? null,
      turnStartedAt: initialObservation === 'observed' ? now : null,
      promptSentAt: input.promptSentAt ?? null,
      queuedWorkingBaseline: input.queuedWorkingBaseline ?? null,
      staleWarningAt: null,
    };

    assertTaskTransition(task.id, task.status, 'dispatched');
    task.status = 'dispatched';
    task.updatedAt = now;
    this.state.dispatches.set(ctx.id, ctx);
    this.state.dispatchCapabilities.set(ctx.id, DISPATCH_CREDENTIAL_PREFIX + randomUUID());
    this.persist();
    return { ...ctx };
  }

  promoteDispatchObserved(
    dispatch: OrchestrationDispatchRecord,
    now: string,
    refreshHeartbeat = false
  ): void {
    dispatch.startObservation = 'observed';
    dispatch.startObservationReason = null;
    dispatch.staleWarningAt = null;
    dispatch.turnStartedAt = dispatch.turnStartedAt ?? now;
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status) && !dispatch.releasedAt) {
      dispatch.stage = 'working';
    }
    if (refreshHeartbeat) {
      dispatch.lastHeartbeatAt = now;
    }
    dispatch.updatedAt = now;
  }

  updateDispatchStage(
    dispatchId: string,
    stage: OrchestrationDispatchStage
  ): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx) return null;
    if (ctx.stage === stage) return { ...ctx };
    ctx.stage = stage;
    ctx.updatedAt = this.now();
    this.persist();
    return { ...ctx };
  }

  /** Keeps an integrated Worker resident for a next wave, or clears that once the wave starts. */
  setDispatchResident(
    dispatchId: string,
    resident: NonNullable<OrchestrationDispatchRecord['residentAfterIntegration']> | null,
  ): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx) return null;
    if (resident) ctx.residentAfterIntegration = { ...resident };
    else delete ctx.residentAfterIntegration;
    ctx.updatedAt = this.now();
    this.persist();
    return { ...ctx };
  }

  /** Records a headless Worker's permission tier and network access for its next turns. */
  updateDispatchWorkerControls(
    dispatchId: string,
    patch: { workerPolicy?: AgentSessionPolicy; workerNetwork?: boolean },
  ): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || ctx.executionMode !== 'codex-app-server') return null;
    let changed = false;
    if (patch.workerPolicy !== undefined && ctx.workerPolicy !== patch.workerPolicy) {
      ctx.workerPolicy = patch.workerPolicy;
      changed = true;
    }
    if (patch.workerNetwork !== undefined && ctx.workerNetwork !== patch.workerNetwork) {
      ctx.workerNetwork = patch.workerNetwork;
      changed = true;
    }
    if (!changed) return { ...ctx };
    ctx.updatedAt = this.now();
    this.persist();
    return { ...ctx };
  }

  markTurnStopReported(
    dispatchId: string,
    generation: number,
    stopReason: WorkerTurnStopReason
  ): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || !ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      return null;
    }
    ctx.turnStopReportedGeneration = generation;
    ctx.stage =
      stopReason === 'needs-input'
        ? 'waiting_input'
        : stopReason === 'errored' || stopReason === 'exited'
          ? 'failed'
          : 'awaiting_review';
    ctx.updatedAt = this.now();
    this.persist();
    return { ...ctx };
  }

  bumpDispatchGenerationForSteering(dispatchId: string): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || !ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      return null;
    }
    const currentGen = ctx.processGeneration ?? 1;
    if (ctx.turnStopReportedGeneration === currentGen) {
      ctx.processGeneration = currentGen + 1;
      ctx.stage = 'working';
      ctx.updatedAt = this.now();
      this.persist();
    }
    return { ...ctx };
  }

  clearWaitingInputTurnStop(dispatchId: string): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || !ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      return null;
    }
    const currentGen = ctx.processGeneration ?? 1;
    if (ctx.stage === 'waiting_input' && ctx.turnStopReportedGeneration === currentGen) {
      ctx.processGeneration = currentGen + 1;
      ctx.stage = 'working';
      ctx.updatedAt = this.now();
      this.persist();
    }
    return { ...ctx };
  }

  hasActiveChildDispatches(parentDispatchId: string): boolean {
    const lineageIds = new Set<string>([parentDispatchId]);
    let prevId = this.state.dispatches.get(parentDispatchId)?.followUpOfDispatchId ?? null;
    while (prevId && !lineageIds.has(prevId)) {
      lineageIds.add(prevId);
      prevId = this.state.dispatches.get(prevId)?.followUpOfDispatchId ?? null;
    }
    for (const d of this.state.dispatches.values()) {
      if (d.creatorDispatchId && lineageIds.has(d.creatorDispatchId) && ACTIVE_DISPATCH_STATUSES.has(d.status)) {
        return true;
      }
    }
    return false;
  }

  getFollowUpChildDispatch(dispatchId: string): OrchestrationDispatchRecord | undefined {
    const matches = [...this.state.dispatches.values()]
      .filter((d) => d.followUpOfDispatchId === dispatchId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const latest = matches[matches.length - 1];
    return latest ? { ...latest } : undefined;
  }

  resolveDispatchLineage(dispatchId: string): OrchestrationDispatchRecord | undefined {
    let current = this.state.dispatches.get(dispatchId);
    if (!current) return undefined;
    const visited = new Set<string>([current.id]);
    while (true) {
      const next = this.getFollowUpChildDispatch(current.id);
      if (!next || visited.has(next.id)) break;
      visited.add(next.id);
      current = this.state.dispatches.get(next.id) ?? current;
    }
    return { ...current };
  }

  listDispatchAncestorIds(dispatchId: string): string[] {
    const ids = new Set<string>();
    let cursor: string | null = dispatchId;
    while (cursor && !ids.has(cursor)) {
      ids.add(cursor);
      cursor = this.state.dispatches.get(cursor)?.followUpOfDispatchId ?? null;
    }
    return [...ids];
  }

  transferCustodyToFollowUp(prevDispatchId: string, nextDispatchId: string): void {
    const prev = this.state.dispatches.get(prevDispatchId);
    const next = this.state.dispatches.get(nextDispatchId);
    if (!prev || !next) return;
    const now = this.now();
    if (prev.ownsWorktree) {
      next.ownsWorktree = true;
      prev.ownsWorktree = false;
    }
    if (prev.ownsBranch) {
      next.ownsBranch = true;
      prev.ownsBranch = false;
    }
    if (prev.baseCommit && !next.baseCommit) {
      next.baseCommit = prev.baseCommit;
    }
    if (prev.repoRootPath && !next.repoRootPath) {
      next.repoRootPath = prev.repoRootPath;
    }
    if (prev.ownsPane) {
      if (prev.assigneePaneId && prev.assigneePaneId === next.assigneePaneId) {
        next.ownsPane = true;
      }
      prev.ownsPane = false;
    }
    prev.updatedAt = now;
    next.updatedAt = now;
    this.persist();
  }

  setDispatchRetained(dispatchId: string, retained: boolean): OrchestrationDispatchRecord {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch not found: ${dispatchId}`);
    }
    ctx.retained = retained;
    ctx.updatedAt = this.now();
    this.persist();
    return { ...ctx };
  }

  switchUnacceptedCodexDispatchToPane(dispatchId: string, ptyId: string): OrchestrationDispatchRecord {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || ctx.executionMode !== 'codex-app-server' || ctx.startObservation !== 'pending' ||
        !ACTIVE_DISPATCH_STATUSES.has(ctx.status) || this.getActiveDispatchForIdentity(ptyId, ptyId)) {
      throw new OrchestrationError('operation_rejected', 'Cannot rebind this Codex dispatch to a terminal.');
    }
    ctx.assigneeHandle = ptyId;
    ctx.assigneePaneId = ptyId;
    ctx.ownsPane = true;
    delete ctx.executionMode;
    delete ctx.providerSessionId;
    delete ctx.providerCwd;
    delete ctx.workerPolicy;
    delete ctx.workerNetwork;
    delete ctx.allowSubWorkers;
    ctx.updatedAt = this.now();
    this.persist();
    return { ...ctx };
  }

  recordCodexTurn(
    dispatchId: string,
    result: NonNullable<OrchestrationDispatchRecord['codexTurn']>,
    awaitingReview = true,
  ): void {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || ctx.executionMode !== 'codex-app-server') return;
    ctx.codexTurn = {
      ...result,
      finalText: this.security.redactDispatchCredentials(result.finalText),
      diff: result.diff === null ? null : this.security.redactDispatchCredentials(result.diff),
      error: result.error === null ? null : this.security.redactDispatchCredentials(result.error),
    };
    if (awaitingReview && ctx.stage !== 'needs_reconciliation' && ACTIVE_DISPATCH_STATUSES.has(ctx.status)) ctx.stage = 'awaiting_review';
    ctx.updatedAt = this.now();
    this.persist();
  }

  recordCodexDeliveryFailure(dispatchId: string, failure: NonNullable<OrchestrationDispatchRecord['codexDeliveryFailure']>): void {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || !ACTIVE_DISPATCH_STATUSES.has(ctx.status)) return;
    ctx.codexDeliveryFailure = failure;
    if (failure === 'unknown_acceptance') ctx.stage = 'needs_reconciliation';
    ctx.updatedAt = this.now();
    this.persist();
  }

  recordReconciliationDiff(dispatchId: string, diff: string | null): void {
    const dispatch = this.state.dispatches.get(dispatchId);
    if (!dispatch) return;
    dispatch.reconciliationDiff = diff === null ? null : this.security.redactDispatchCredentials(diff);
    this.persist();
  }

  archiveDispatchOutput(dispatchId: string, output: string): void {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || !output) return;
    ctx.archivedOutput = this.security.redactDispatchCredentials(output);
    ctx.updatedAt = this.now();
    this.persist();
  }

  archiveDispatchTimeline(dispatchId: string, timeline: WorkerTimelineSnapshot): void {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || ctx.executionMode !== 'codex-app-server') return;
    const redacted = mapTimelineStrings(timeline, (text) => this.security.redactDispatchCredentials(text));
    ctx.archivedTimeline = trimTimelineSnapshot(redacted, TIMELINE_LIMITS.archiveBytes);
    ctx.updatedAt = this.now();
    this.persist();
  }

  getArchivedTimeline(dispatchId: string): WorkerTimelineSnapshot | null {
    const timeline = this.state.dispatches.get(dispatchId)?.archivedTimeline;
    return timeline ? structuredClone(timeline) : null;
  }

  markDispatchPaneClosed(dispatchId: string): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx) return null;
    if (!ctx.ownsPane) return { ...ctx };
    ctx.ownsPane = false;
    ctx.updatedAt = this.now();
    this.persist();
    return { ...ctx };
  }

  findLatestWorkerDoneMessage(dispatchId: string): OrchestrationMessageRecord | undefined {
    for (let i = this.state.messageOrder.length - 1; i >= 0; i -= 1) {
      const msg = this.state.messages.get(this.state.messageOrder[i]!);
      if (!msg || msg.type !== 'worker_done' || msg.lifecycleRejectedReason) continue;
      if (msg.fromHandle === `dispatch:${dispatchId}`) return cloneMessageRecord(msg);
      if (msg.payload) {
        try {
          const parsed = JSON.parse(msg.payload) as { dispatchId?: unknown };
          if (parsed?.dispatchId === dispatchId) return cloneMessageRecord(msg);
        } catch {
          /* ignore */
        }
      }
    }
    return undefined;
  }

  markDispatchReleased(
    dispatchId: string,
    opts?: { keepPane?: boolean; keepWorktree?: boolean }
  ): OrchestrationDispatchRecord {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch not found: ${dispatchId}`);
    }
    const now = this.now();
    ctx.releasedAt = ctx.releasedAt ?? now;
    ctx.stage = 'released';
    if (!opts?.keepPane) {
      ctx.ownsPane = false;
    }
    if (!opts?.keepWorktree) {
      ctx.ownsWorktree = false;
    }
    ctx.retained = false;
    ctx.updatedAt = now;
    this.persist();
    return { ...ctx };
  }

  requeueTaskForRetry(taskId: string): OrchestrationTaskRecord {
    const task = this.state.tasks.get(taskId);
    if (!task) {
      throw new OrchestrationError('task_not_found', `Task not found: ${taskId}`);
    }
    if (task.status === 'ready') {
      return { ...task, deps: [...task.deps] };
    }
    if (task.status === 'dispatched') {
      throw new OrchestrationError(
        'worker_busy',
        `Task ${task.id} already has an active dispatch.`
      );
    }
    const now = this.now();
    task.status = 'ready';
    task.blockedReason = null;
    task.updatedAt = now;
    this.promoteReadyTasks(task.runId);
    this.persist();
    return { ...task, deps: [...task.deps] };
  }

  listReviewDispatchesForTarget(targetDispatchId: string): OrchestrationDispatchRecord[] {
    return [...this.state.dispatches.values()]
      .filter((d) => d.reviewOfDispatchId === targetDispatchId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => ({ ...d }));
  }

  listReviewDispatchesForBatch(
    targetDispatchId: string,
    reviewBatchId: string,
  ): OrchestrationDispatchRecord[] {
    return [...this.state.dispatches.values()]
      .filter(
        (d) =>
          d.reviewOfDispatchId === targetDispatchId &&
          d.reviewBatchId === reviewBatchId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => ({ ...d }));
  }

  listReviewDispatchesForRun(runId: string): OrchestrationDispatchRecord[] {
    return [...this.state.dispatches.values()]
      .filter((d) => d.reviewOfRunId === runId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => ({ ...d }));
  }

  listReviewDispatchesForRunBatch(
    runId: string,
    reviewBatchId: string,
  ): OrchestrationDispatchRecord[] {
    return [...this.state.dispatches.values()]
      .filter(
        (d) =>
          d.reviewOfRunId === runId &&
          d.reviewBatchId === reviewBatchId,
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((d) => ({ ...d }));
  }

  listIntegratedDispatchesForRun(runId: string): OrchestrationDispatchRecord[] {
    return [...this.state.dispatches.values()]
      .filter(
        (d) =>
          d.runId === runId &&
          !d.reviewOfDispatchId &&
          !d.reviewOfRunId &&
          d.integrationStatus === 'merged',
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .map((d) => ({ ...d }));
  }

  updateDispatchReviewState(
    dispatchId: string,
    patch: {
      reviewStatus?: OrchestrationReviewStatus;
      reviewRound?: number;
      reviewBatchId?: string | null;
      reviewSnapshotOid?: string | null;
      reviewBaseCommit?: string | null;
      reviewFindings?: OrchestrationReviewFinding[];
      reviewMutatedWorkspace?: boolean;
    },
  ): OrchestrationDispatchRecord | null {
    const dispatch = this.state.dispatches.get(dispatchId);
    if (!dispatch) return null;
    if (patch.reviewStatus !== undefined) dispatch.reviewStatus = patch.reviewStatus;
    if (patch.reviewRound !== undefined) dispatch.reviewRound = patch.reviewRound;
    if (patch.reviewBatchId !== undefined) dispatch.reviewBatchId = patch.reviewBatchId;
    if (patch.reviewSnapshotOid !== undefined) dispatch.reviewSnapshotOid = patch.reviewSnapshotOid;
    if (patch.reviewBaseCommit !== undefined) dispatch.reviewBaseCommit = patch.reviewBaseCommit;
    if (patch.reviewFindings !== undefined) {
      dispatch.reviewFindings = patch.reviewFindings.map((f) => ({ ...f }));
    }
    if (patch.reviewMutatedWorkspace !== undefined) {
      dispatch.reviewMutatedWorkspace = patch.reviewMutatedWorkspace;
    }
    dispatch.updatedAt = this.now();
    this.persist();
    return { ...dispatch };
  }

  updateDispatchIntegrationState(
    dispatchId: string,
    patch: {
      integrationStatus?: OrchestrationIntegrationStatus;
      integratedCommit?: string | null;
      integratedTargetBranch?: string | null;
      noChanges?: boolean;
    },
  ): OrchestrationDispatchRecord | null {
    const dispatch = this.state.dispatches.get(dispatchId);
    if (!dispatch) return null;
    if (patch.integrationStatus !== undefined) dispatch.integrationStatus = patch.integrationStatus;
    if (patch.noChanges !== undefined) dispatch.noChanges = patch.noChanges;
    if (patch.integratedCommit !== undefined) dispatch.integratedCommit = patch.integratedCommit;
    if (patch.integratedTargetBranch !== undefined) {
      dispatch.integratedTargetBranch = patch.integratedTargetBranch;
    }
    dispatch.updatedAt = this.now();
    this.persist();
    return { ...dispatch };
  }

  setDispatchBriefFilePath(dispatchId: string, briefFilePath: string | null): OrchestrationDispatchRecord | null {
    const dispatch = this.state.dispatches.get(dispatchId);
    if (!dispatch) return null;
    dispatch.briefFilePath = briefFilePath;
    dispatch.updatedAt = this.now();
    this.persist();
    return { ...dispatch };
  }

  updateDispatchObservation(
    dispatchId: string,
    observation: OrchestrationStartObservation,
    options?: {
      reason?: string | null;
      refreshHeartbeat?: boolean;
      minHeartbeatIntervalMs?: number;
      promptSent?: boolean;
      queuedWorkingBaseline?: number | null;
    }
  ): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || !ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      return null;
    }

    const currentObservation: OrchestrationStartObservation = ctx.startObservation ?? 'pending';
    const now = this.now();
    let changed = false;

    if (options?.promptSent === true) {
      ctx.promptSentAt = now;
      changed = true;
    }
    if (options?.queuedWorkingBaseline !== undefined) {
      ctx.queuedWorkingBaseline = options.queuedWorkingBaseline;
      changed = true;
    }

    const isBlockedDowngrade =
      (currentObservation === 'observed' || currentObservation === 'permission') &&
      observation !== 'observed' &&
      observation !== 'permission';
    if (isBlockedDowngrade) {
      if (changed) {
        ctx.updatedAt = now;
        this.persist();
      }
      return { ...ctx };
    }

    if (ctx.startObservation !== observation) {
      ctx.startObservation = observation;
      ctx.staleWarningAt = null;
      if (observation === 'permission') {
        ctx.stage = 'waiting_permission';
      } else if (observation === 'observed') {
        ctx.stage = 'working';
      }
      changed = true;
    }

    if (options?.reason !== undefined) {
      if ((ctx.startObservationReason ?? null) !== options.reason) {
        ctx.startObservationReason = options.reason;
        changed = true;
      }
    } else if (observation === 'observed' && ctx.startObservationReason !== null) {
      ctx.startObservationReason = null;
      changed = true;
    }

    if (observation === 'observed' && ctx.turnStartedAt == null) {
      ctx.turnStartedAt = now;
      changed = true;
    }

    if (
      options?.refreshHeartbeat !== false &&
      (observation === 'observed' || observation === 'permission' || observation === 'queued')
    ) {
      const nowMs = Date.parse(now);
      const lastHbMs = ctx.lastHeartbeatAt ? Date.parse(ctx.lastHeartbeatAt) : Number.NaN;
      const throttled =
        options?.minHeartbeatIntervalMs !== undefined &&
        currentObservation === observation &&
        Number.isFinite(nowMs) &&
        Number.isFinite(lastHbMs) &&
        nowMs - lastHbMs < options.minHeartbeatIntervalMs;
      if (!throttled && ctx.lastHeartbeatAt !== now) {
        ctx.lastHeartbeatAt = now;
        changed = true;
      }
    }

    if (changed) {
      ctx.updatedAt = now;
      this.persist();
    }
    return { ...ctx };
  }

  recordHeartbeat(
    dispatchId: string,
    options?: { minIntervalMs?: number }
  ): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || !ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      return null;
    }
    const now = this.now();
    if (
      options?.minIntervalMs !== undefined &&
      ctx.startObservation === 'observed' &&
      ctx.lastHeartbeatAt
    ) {
      const elapsedMs = Date.parse(now) - Date.parse(ctx.lastHeartbeatAt);
      if (Number.isFinite(elapsedMs) && elapsedMs < options.minIntervalMs) {
        return { ...ctx };
      }
    }
    this.promoteDispatchObserved(ctx, now, true);
    this.persist();
    return { ...ctx };
  }

  private refreshParentDispatchHeartbeat(child: OrchestrationDispatchRecord, now: string): void {
    if (!child.creatorDispatchId) return;
    const resolved = this.resolveDispatchLineage(child.creatorDispatchId);
    const parent = resolved
      ? this.state.dispatches.get(resolved.id)
      : this.state.dispatches.get(child.creatorDispatchId);
    if (parent && ACTIVE_DISPATCH_STATUSES.has(parent.status)) {
      parent.lastHeartbeatAt = now;
      parent.updatedAt = now;
    }
  }

  completeDispatch(dispatchId: string): OrchestrationDispatchRecord {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch not found: ${dispatchId}`);
    }
    if (ctx.status === 'completed') {
      return { ...ctx };
    }
    assertDispatchTransition(ctx.id, ctx.status, 'completed');
    const now = this.now();
    ctx.status = 'completed';
    ctx.stage = 'done';
    ctx.completedAt = now;
    ctx.updatedAt = now;
    this.refreshParentDispatchHeartbeat(ctx, now);
    this.mailbox.closeQuestionsForDispatch(ctx.id);
    this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);
    this.persist();
    return { ...ctx };
  }

  settleActiveDispatchesForTask(
    taskId: string,
    targetStatus: 'completed' | 'failed',
    reason: string
  ): void {
    const now = this.now();
    for (const d of this.state.dispatches.values()) {
      if (d.taskId !== taskId || !ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
      assertDispatchTransition(d.id, d.status, targetStatus);
      d.status = targetStatus;
      d.stage = targetStatus === 'completed' ? 'done' : 'failed';
      d.completedAt = now;
      d.updatedAt = now;
      if (targetStatus === 'failed') {
        this.cleanupDispatchBrief(d.id);
        d.lastFailureReason = reason;
        d.failureSummary = reason;
      }
      this.refreshParentDispatchHeartbeat(d, now);
      this.mailbox.closeQuestionsForDispatch(d.id);
      this.mailbox.routeUnreadDispatchMailboxToRun(d.id, d.runId);
    }
  }

  failDispatch(
    dispatchId: string,
    reason: string,
    options?: { forceFailTask?: boolean; summary?: string }
  ): OrchestrationDispatchRecord {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch not found: ${dispatchId}`);
    }
    if (!ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      return { ...ctx };
    }

    const now = this.now();
    const nextFailureCount = ctx.failureCount + 1;
    const circuitBroken = nextFailureCount >= DISPATCH_CIRCUIT_BREAK_FAILURES;
    const targetDispatchStatus = circuitBroken ? 'circuit_broken' : 'failed';
    assertDispatchTransition(ctx.id, ctx.status, targetDispatchStatus);

    ctx.failureCount = nextFailureCount;
    ctx.lastFailureReason = reason;
    ctx.failureSummary = options?.summary ?? reason;
    ctx.status = targetDispatchStatus;
    ctx.stage = reason === 'worker_stopped' ? 'stopped' : 'failed';
    this.cleanupDispatchBrief(ctx.id);
    ctx.completedAt = now;
    ctx.updatedAt = now;
    this.refreshParentDispatchHeartbeat(ctx, now);

    this.mailbox.closeQuestionsForDispatch(ctx.id);
    this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);

    const task = this.state.tasks.get(ctx.taskId);
    if (task && task.status !== 'completed' && task.status !== 'failed') {
      // `ready` invites another dispatch; a task made for one specific worker never gets one.
      const nextTaskStatus: OrchestrationTaskStatus = this.mailbox.hasPendingGates(task.id)
        ? 'blocked'
        : circuitBroken || options?.forceFailTask || task.singleShot
          ? 'failed'
          : 'ready';
      if (task.status !== nextTaskStatus) {
        assertTaskTransition(task.id, task.status, nextTaskStatus);
        task.status = nextTaskStatus;
        task.blockedReason = null;
        task.updatedAt = now;
      }
    }

    this.promoteReadyTasks(ctx.runId);
    this.persist();
    return { ...ctx };
  }

  /**
   * Park a dispatch whose worker stopped showing signs of life. Unlike failDispatch this never
   * re-queues the task: the assignee may still be executing it, so re-dispatching would run the
   * task twice. The task is blocked for a human and a late worker_done can still settle it.
   */
  blockUnresponsiveDispatch(dispatchId: string, reason: string): OrchestrationDispatchRecord {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx) {
      throw new OrchestrationError('dispatch_not_found', `Dispatch not found: ${dispatchId}`);
    }
    if (!ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      return { ...ctx };
    }

    const now = this.now();
    assertDispatchTransition(ctx.id, ctx.status, 'failed');
    ctx.status = 'failed';
    ctx.stage = 'failed';
    ctx.lastFailureReason = reason;
    ctx.failureSummary = reason;
    ctx.completedAt = now;
    ctx.updatedAt = now;
    this.refreshParentDispatchHeartbeat(ctx, now);

    this.mailbox.closeQuestionsForDispatch(ctx.id);
    this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);

    const task = this.state.tasks.get(ctx.taskId);
    if (task && task.status !== 'completed' && task.status !== 'failed' && task.status !== 'blocked') {
      assertTaskTransition(task.id, task.status, 'blocked');
      task.status = 'blocked';
      task.updatedAt = now;
    }

    this.mailbox.insertMessage({
      runId: ctx.runId,
      from: `dispatch:${ctx.id}`,
      to: `run:${ctx.runId}`,
      type: 'escalation',
      priority: 'high',
      subject: `Worker unresponsive for task ${ctx.taskId}`,
      body: reason,
      payload: JSON.stringify({ dispatchId: ctx.id, taskId: ctx.taskId }),
    });

    this.persist();
    return { ...ctx };
  }

  /**
   * Emit a one-shot advisory escalation for a dispatch that shows no progress. Unlike
   * blockUnresponsiveDispatch this changes no dispatch/task status; `advisory: true` keeps the
   * coordinator's escalation handler from settling anything.
   */
  markStaleDispatchWarned(
    dispatchId: string,
    subject: string,
    body: string
  ): OrchestrationDispatchRecord | null {
    const ctx = this.state.dispatches.get(dispatchId);
    if (!ctx || !ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      return null;
    }
    if (ctx.staleWarningAt) {
      return { ...ctx };
    }

    const now = this.now();
    ctx.staleWarningAt = now;
    ctx.updatedAt = now;
    this.mailbox.insertMessage({
      runId: ctx.runId,
      from: `dispatch:${ctx.id}`,
      to: `run:${ctx.runId}`,
      type: 'escalation',
      priority: 'normal',
      subject,
      body,
      payload: JSON.stringify({ dispatchId: ctx.id, taskId: ctx.taskId, advisory: true }),
    });
    this.persist();
    return { ...ctx };
  }

  /** Live dispatches assigned to a pane, without cloning or sorting (hot PTY activity path). */
  getActiveDispatchesForPane(ptyId: string): OrchestrationDispatchRecord[] {
    const matches: OrchestrationDispatchRecord[] = [];
    for (const d of this.state.dispatches.values()) {
      if (!ACTIVE_DISPATCH_STATUSES.has(d.status)) continue;
      if (d.assigneePaneId === ptyId || d.assigneeHandle === ptyId) matches.push(d);
    }
    return matches;
  }

  private recoverUnobservedPromptReport(
    ctx: OrchestrationDispatchRecord,
    task: OrchestrationTaskRecord,
    outcome: OrchestrationWorkerReportOutcome,
    summary?: string
  ): {
    action: 'settled';
    dispatch: OrchestrationDispatchRecord;
    task: OrchestrationTaskRecord;
  } {
    const now = this.now();
    this.promoteDispatchObserved(ctx, now);

    if (outcome === 'completed') {
      ctx.status = 'completed';
      ctx.stage = 'done';
      ctx.lastFailureReason = null;
      ctx.failureSummary = null;
      ctx.completedAt = now;
      ctx.updatedAt = now;
      task.status = 'completed';
      task.updatedAt = now;
      this.mailbox.closeQuestionsForDispatch(ctx.id);
      this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);
      this.promoteReadyTasks(ctx.runId);
    } else if (outcome === 'blocked') {
      ctx.status = 'completed';
      ctx.stage = 'done';
      ctx.lastFailureReason = null;
      ctx.failureSummary = null;
      ctx.completedAt = now;
      ctx.updatedAt = now;
      task.status = 'blocked';
      task.updatedAt = now;
      this.mailbox.closeQuestionsForDispatch(ctx.id);
      this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);
    } else if (outcome === 'escalated') {
      ctx.status = 'failed';
      ctx.stage = 'failed';
      ctx.lastFailureReason = 'escalated';
      ctx.failureSummary = summary ?? 'Worker escalated task';
      ctx.completedAt = now;
      ctx.updatedAt = now;
      task.status = 'blocked';
      task.updatedAt = now;
      this.mailbox.closeQuestionsForDispatch(ctx.id);
      this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);
    } else {
      const rawReason = summary || `Worker reported ${outcome}`;
      const failureText = rawReason.startsWith(AGENT_PROMPT_STALLED_ERROR)
        ? `Worker reported ${outcome}: ${rawReason}`
        : rawReason;
      ctx.status = 'failed';
      ctx.stage = 'failed';
      ctx.lastFailureReason = failureText;
      ctx.failureSummary = failureText;
      ctx.completedAt = now;
      ctx.updatedAt = now;
      task.status = 'failed';
      task.updatedAt = now;
      this.mailbox.closeQuestionsForDispatch(ctx.id);
      this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);
    }

    this.promoteReadyTasks(ctx.runId);
    this.persist();
    return {
      action: 'settled',
      dispatch: { ...ctx },
      task: { ...task, deps: [...task.deps] },
    };
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
    const ctx = this.state.dispatches.get(input.dispatchId);
    if (!ctx) {
      return { action: 'rejected', reason: `Unknown dispatch ${input.dispatchId}` };
    }
    const task = this.state.tasks.get(input.taskId);
    if (!task || ctx.taskId !== input.taskId) {
      return {
        action: 'rejected',
        reason: `Dispatch ${input.dispatchId} does not match task ${input.taskId}`,
      };
    }

    // Verify lifecycle authority against assignee if caller identity provided.
    if (
      input.reportedByHandle &&
      input.reportedByHandle !== ctx.assigneeHandle &&
      input.reportedByHandle !== `dispatch:${ctx.id}` &&
      (!input.reportedByPaneId || input.reportedByPaneId !== ctx.assigneePaneId)
    ) {
      return {
        action: 'rejected',
        reason: `Sender ${input.reportedByHandle} is not authorized to settle dispatch ${ctx.id}`,
      };
    }

    // Idempotent duplicate handling and unobserved-prompt late report recovery.
    if (!ACTIVE_DISPATCH_STATUSES.has(ctx.status)) {
      if (
        (reportCorrectsUnobservedPrompt(ctx, task) || reportCorrectsUnresponsiveWorker(ctx, task)) &&
        this.getLatestDispatchForTask(task.id)?.id === ctx.id &&
        this.getActiveDispatchesForTask(task.id).length === 0
      ) {
        return this.recoverUnobservedPromptReport(ctx, task, input.outcome, input.summary);
      }

      const expectedDone =
        (input.outcome === 'completed' &&
          ctx.status === 'completed' &&
          task.status === 'completed') ||
        (input.outcome === 'blocked' && task.status === 'blocked') ||
        ((input.outcome === 'failed' ||
          input.outcome === 'abandoned' ||
          input.outcome === 'escalated') &&
          (ctx.status === 'failed' || ctx.status === 'circuit_broken'));
      if (expectedDone) {
        return {
          action: 'duplicate',
          dispatch: { ...ctx },
          task: { ...task, deps: [...task.deps] },
        };
      }
      return {
        action: 'rejected',
        reason: `Dispatch ${ctx.id} is already ${ctx.status}`,
      };
    }

    const now = this.now();
    if (input.outcome === 'completed') {
      assertDispatchTransition(ctx.id, ctx.status, 'completed');
      assertTaskTransition(task.id, task.status, 'completed');
      this.promoteDispatchObserved(ctx, now);
      ctx.status = 'completed';
      ctx.stage = 'done';
      ctx.completedAt = now;
      ctx.updatedAt = now;
      this.refreshParentDispatchHeartbeat(ctx, now);
      this.mailbox.closeQuestionsForDispatch(ctx.id);
      this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);

      task.status = 'completed';
      task.updatedAt = now;

      this.settleActiveDispatchesForTask(task.id, 'completed', 'Sibling dispatch superseded');
      this.promoteReadyTasks(task.runId);
      this.persist();
      return {
        action: 'settled',
        dispatch: { ...ctx },
        task: { ...task, deps: [...task.deps] },
      };
    }

    if (input.outcome === 'blocked') {
      assertDispatchTransition(ctx.id, ctx.status, 'completed');
      if (task.status !== 'blocked') {
        assertTaskTransition(task.id, task.status, 'blocked');
      }
      this.promoteDispatchObserved(ctx, now);
      ctx.status = 'completed';
      ctx.stage = 'done';
      ctx.completedAt = now;
      ctx.updatedAt = now;
      this.refreshParentDispatchHeartbeat(ctx, now);
      this.mailbox.closeQuestionsForDispatch(ctx.id);
      this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);

      if (task.status !== 'blocked') {
        task.status = 'blocked';
        task.updatedAt = now;
      }
      this.persist();
      return {
        action: 'settled',
        dispatch: { ...ctx },
        task: { ...task, deps: [...task.deps] },
      };
    }

    if (input.outcome === 'escalated') {
      assertDispatchTransition(ctx.id, ctx.status, 'failed');
      if (task.status !== 'blocked') {
        assertTaskTransition(task.id, task.status, 'blocked');
      }
      this.promoteDispatchObserved(ctx, now);
      ctx.status = 'failed';
      ctx.stage = 'failed';
      ctx.lastFailureReason = 'escalated';
      ctx.failureSummary = input.summary ?? 'Worker escalated task';
      ctx.completedAt = now;
      ctx.updatedAt = now;
      this.refreshParentDispatchHeartbeat(ctx, now);
      this.mailbox.closeQuestionsForDispatch(ctx.id);
      this.mailbox.routeUnreadDispatchMailboxToRun(ctx.id, ctx.runId);

      if (task.status !== 'blocked') {
        task.status = 'blocked';
        task.updatedAt = now;
      }
      this.persist();
      return {
        action: 'settled',
        dispatch: { ...ctx },
        task: { ...task, deps: [...task.deps] },
      };
    }

    // 'failed' or 'abandoned' -> failDispatch (retries up to circuit break).
    this.promoteDispatchObserved(ctx, now);
    const failedDispatch = this.failDispatch(
      ctx.id,
      input.summary || `Worker reported ${input.outcome}`,
      { summary: input.summary }
    );
    const updatedTask = this.requireTask(task.id);
    return {
      action: 'settled',
      dispatch: failedDispatch,
      task: updatedTask,
    };
  }

  linkFollowUpMessage(dispatchId: string, messageId: string): void {
    const dispatch = this.state.dispatches.get(dispatchId);
    if (!dispatch) return;
    dispatch.followUpMessageId = messageId;
    this.persist();
  }

  // ==================== Coordinator Runs ====================

  createCoordinatorRun(input: {
    runId: string;
    spec: string;
    coordinatorHandle: string;
    pollIntervalMs: number;
    maxConcurrent: number;
  }): OrchestrationCoordinatorRunRecord {
    const existing = this.getActiveCoordinatorRun();
    if (existing) {
      throw new OrchestrationError(
        'coordinator_already_running',
        `Coordinator already running: ${existing.id}`
      );
    }
    this.requireRun(input.runId);
    const cr: OrchestrationCoordinatorRunRecord = {
      id: generatePrefixedId('coord'),
      runId: input.runId,
      spec: input.spec,
      status: 'running',
      coordinatorHandle: input.coordinatorHandle,
      pollIntervalMs: input.pollIntervalMs,
      maxConcurrent: input.maxConcurrent,
      startedAt: this.now(),
      endedAt: null,
      error: null,
    };
    this.state.coordinatorRuns.set(cr.id, cr);
    this.persist();
    return { ...cr };
  }

  getCoordinatorRun(id: string): OrchestrationCoordinatorRunRecord | undefined {
    const cr = this.state.coordinatorRuns.get(id);
    return cr ? { ...cr } : undefined;
  }

  getActiveCoordinatorRun(): OrchestrationCoordinatorRunRecord | undefined {
    for (const cr of this.state.coordinatorRuns.values()) {
      if (cr.status === 'running' || cr.status === 'paused') {
        return { ...cr };
      }
    }
    return undefined;
  }

  listCoordinatorRuns(runId?: string): OrchestrationCoordinatorRunRecord[] {
    return [...this.state.coordinatorRuns.values()]
      .filter((c) => !runId || c.runId === runId)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt))
      .map((c) => ({ ...c }));
  }

  updateCoordinatorRun(
    id: string,
    patch: Partial<Pick<OrchestrationCoordinatorRunRecord, 'status' | 'endedAt' | 'error'>>
  ): OrchestrationCoordinatorRunRecord {
    const cr = this.state.coordinatorRuns.get(id);
    if (!cr) {
      throw new OrchestrationError('not_found', `Coordinator run not found: ${id}`);
    }
    if (patch.status !== undefined) cr.status = patch.status;
    if (patch.endedAt !== undefined) cr.endedAt = patch.endedAt;
    if (patch.error !== undefined) cr.error = patch.error;
    this.persist();
    return { ...cr };
  }

  /** Settles state that cannot survive a restart: undeliverable deferred prompts, idle runs, interrupted queue claims. */
  recoverAfterRestart(now: string): void {
    for (const dispatch of this.state.dispatches.values()) {
      if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status) &&
          dispatch.startObservation === 'permission' && !dispatch.promptSentAt &&
          !this.state.deferredPrompts.has(dispatch.id)) {
        this.failDispatch(dispatch.id, 'Deferred prompt delivery could not be recovered after restart', {
          forceFailTask: true,
          summary: 'Check the worker terminal before retrying delivery.',
        });
      }
    }

    for (const run of this.state.runs.values()) {
      if (run.id === UNBOUND_RUN_ID || run.status !== 'active') continue;
      // Workers live in the terminal daemon or their own processes and can outlast the app; their
      // runs stay open so late reports land, and exit reconciliation settles them otherwise.
      const hasLiveWork = [...this.state.dispatches.values()].some(
        (d) => d.runId === run.id && ACTIVE_DISPATCH_STATUSES.has(d.status),
      );
      if (hasLiveWork || [...this.state.tasks.values()].some(t => t.runId === run.id && t.queuedLaunch)) continue;
      const runTasks = [...this.state.tasks.values()].filter((t) => t.runId === run.id);
      if (runTasks.length > 0 && runTasks.every(isTaskSettled)) {
        run.status = runTasks.some((t) => t.status === 'failed' || isBlockedByFailedDependency(t)) ? 'failed' : 'completed';
      } else {
        run.status = 'stopped';
      }
      run.endedAt = run.endedAt ?? now;
    }

    for (const task of this.state.tasks.values()) {
      if (task.queuedLaunch?.state !== 'claimed') continue;
      const attempt = this.getLatestDispatchForTask(task.id);
      if (attempt) {
        if (ACTIVE_DISPATCH_STATUSES.has(attempt.status) && !attempt.promptSentAt && attempt.startObservation !== 'observed') {
          this.updateDispatchStage(attempt.id, 'needs_reconciliation');
        }
        delete task.queuedLaunch;
      }
      else task.queuedLaunch = { ...task.queuedLaunch, state: 'needs_reconciliation', reason: '上次启动被中断，请先核对执行现场。' };
    }
  }
}
