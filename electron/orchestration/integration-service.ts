import { existsSync } from 'node:fs';
import { resolve as resolveFsPath } from 'node:path';
import { getGitStatus } from '../git/git-service.js';
import type { TerminalRuntimeTracker } from '../terminal-runtime-tracker.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import type { OrchestrationStore } from './orchestration-store.js';
import type { OrchestrationService } from './orchestration-service.js';
import {
  OrchestrationError,
  type OrchestrationDispatchRecord,
  type OrchestrationRunRecord,
} from './orchestration-types.js';
import type { RunIntegratedWorkerSummaryForReview } from './adversarial-review.js';
import {
  captureWorkerSnapshotOid,
  finalizeRunIntegrationBranch,
  inspectCommitRangeDiff,
  inspectWorkerDiff,
  integrateWorkerChanges,
  integrateWorkerIntoRunBranch,
  isGitCommitAncestor,
  isSameGitRepo,
  resolveBranchRefOid,
  resolveIntegrationMergeBase,
  resolveMainRepoRoot,
  resolveTargetSymbolicRef,
  type RunCommitRangeDiffInspection,
  type RunFinalizeIntegrationResult,
  type WorkerDiffInspection,
  type WorkerIntegrateMode,
  type WorkerIntegrateTargetBranch,
  type WorkerIntegrationResult,
} from './worker-git-integration.js';
import { WORKER_BRANCH_PREFIX } from './worker-worktree-placement.js';

/** Service capabilities the OrchestrationIntegrationService relies on; supplied by OrchestrationService. */
export interface OrchestrationIntegrationHost {
  readonly assertRunCoordinator: (runId: string, callerPaneId: string) => void;
  readonly assertWorkerController: (targetInput: { dispatchId?: string; worker?: string; taskId?: string; }, callerPaneId: string) => void;
  readonly authorizeRunAccess: (runId: string | undefined, callerPaneId: string) => string;
  readonly emitChanged: (reason: string, runId?: string) => void;
  readonly getDefaultCwd: (() => string | undefined) | undefined;
  readonly inferRunIdOptional: (from?: string) => string | undefined;
  readonly mutateWorkerResources: <T>(dispatch: OrchestrationDispatchRecord, mutation: () => Promise<T>) => Promise<T>;
  readonly releaseWorker: (
    dispatch: OrchestrationDispatchRecord,
    input: Parameters<OrchestrationService['workerRelease']>[0],
    integratedSnapshotOid?: string,
  ) => ReturnType<OrchestrationService['workerRelease']>;
  readonly resolveDispatchByRoleOrTarget: (rawTarget: string, callerHint?: string, runIdHint?: string) => OrchestrationDispatchRecord;
  readonly resolveRoleNameForDispatch: (dispatch: OrchestrationDispatchRecord) => string;
  readonly resolveTargetDispatch: (input: { dispatchId?: string; worker?: string; taskId?: string; }) => OrchestrationDispatchRecord;
  readonly store: OrchestrationStore;
  readonly terminalTracker: TerminalRuntimeTracker | undefined;
  readonly workerRelease: OrchestrationService['workerRelease'];
}

/** Worker and Run integration: diffs, publication recovery, finalize, integration locks and branch guards. */
export class OrchestrationIntegrationService {
  constructor(private readonly host: OrchestrationIntegrationHost) {}

  private readonly runIntegrationLocks = new Map<string, Promise<void>>();

  async recoverGitPublications(onlyRunId?: string): Promise<void> {
    for (const run of this.host.store.listRuns()) {
      if (onlyRunId && run.id !== onlyRunId) continue;
      const intent = run.integrationIntent;
      if (!intent) continue;
      await this.withRunIntegrationLock(run.id, async () => {
        const current = this.host.store.requireRun(run.id).integrationIntent;
        if (current?.commit !== intent.commit) return;
        const head = await resolveBranchRefOid(intent.repo, intent.target);
        if (!head || !await isGitCommitAncestor(intent.repo, intent.commit, head)) return;
        if (intent.dispatchId) {
          this.host.store.updateDispatchIntegrationState(intent.dispatchId, { integrationStatus: 'merged',
            integratedCommit: intent.commit, integratedTargetBranch: intent.target, noChanges: intent.commit === intent.before });
          this.host.store.updateRunIntegrationState(run.id, {
            ...(intent.baseBranch ? { integrationStatus: 'active', integrationBranch: intent.target,
              integrationWorktreePath: intent.worktree, integrationBaseBranch: intent.baseBranch,
              integrationBaseCommit: intent.baseCommit, integrationRepoRootPath: intent.repo } : {}),
            integrationHeadCommit: intent.commit, integrationIntent: null,
          });
        } else if (intent.members) {
          this.host.store.updateRunIntegrationState(run.id, { integrationStatus: 'finalized', finalizedCommit: intent.commit,
            integrationHeadCommit: intent.commit, integrationIntent: null, finalizedBatch: {
              branch: intent.target, sourceHead: intent.sourceHead, targetCommit: intent.commit, members: intent.members,
            },
            integrationBranch: await resolveBranchRefOid(intent.repo, run.integrationBranch) ? run.integrationBranch : null,
            integrationWorktreePath: run.integrationWorktreePath && existsSync(run.integrationWorktreePath) ? run.integrationWorktreePath : null,
          });
        }
        this.host.emitChanged('run:integration-recovered', run.id);
      });
    }
  }

  async reconcilePublication(input: { runId: string; expectedCommit: string; acceptUnpublished?: boolean }): Promise<{ message: string }> {
    await this.recoverGitPublications(input.runId);
    return this.withRunIntegrationLock(input.runId, async () => {
      const run = this.host.store.requireRun(input.runId);
      const intent = run.integrationIntent;
      if (!intent) return { message: '已核对 Git 交付位置。' };
      if (intent.commit !== input.expectedCommit) throw new OrchestrationError('operation_rejected', '交付记录已更新，请重新查看。');
      const head = await resolveBranchRefOid(intent.repo, intent.target);
      if (input.acceptUnpublished && head === intent.before) {
        this.host.store.updateRunIntegrationState(run.id, { integrationIntent: null });
        this.host.emitChanged('run:publication-unapplied', run.id);
        return { message: '已确认目标分支仍在原提交；本次操作未标记为合入。' };
      }
      throw new OrchestrationError('operation_rejected', `需核对 ${intent.target}：当前 ${head ?? '无此分支'}，预期 ${intent.commit}，写入前 ${intent.before}。`);
    });
  }

  async withRunIntegrationLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.runIntegrationLocks.get(runId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const tail = previous.then(() => current);
    this.runIntegrationLocks.set(runId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.runIntegrationLocks.get(runId) === tail) {
        this.runIntegrationLocks.delete(runId);
      }
    }
  }

  isRunIntegrationBranchLive(run: OrchestrationRunRecord): boolean {
    return Boolean(
      (run.integrationStatus === 'active' || run.integrationStatus === 'conflict') &&
      run.integrationBranch &&
      run.integrationWorktreePath,
    );
  }

  private async resolveLiveTargetRepoForDispatch(
    run: OrchestrationRunRecord,
    mainRepoRoot: string,
  ): Promise<string> {
    if (
      this.isRunIntegrationBranchLive(run) &&
      run.integrationWorktreePath &&
      run.integrationRepoRootPath &&
      (await isSameGitRepo(mainRepoRoot, run.integrationRepoRootPath))
    ) {
      return run.integrationWorktreePath;
    }
    return mainRepoRoot;
  }

  async resolveEffectiveWorkerDiffBase(
    run: OrchestrationRunRecord,
    dispatch: OrchestrationDispatchRecord,
    worktreePath: string,
    mainRepoRoot: string | null,
    snapshotOid: string | null,
  ): Promise<string | null> {
    const recordedBase = dispatch.baseCommit?.trim() || null;
    if (!mainRepoRoot || !snapshotOid) return recordedBase;
    const targetRepo = await this.resolveLiveTargetRepoForDispatch(run, mainRepoRoot);
    const normPath = (p: string) => {
      const r = resolveFsPath(p);
      return process.platform === 'win32' ? r.toLowerCase() : r;
    };
    const isIsolatedWorktree =
      Boolean(dispatch.ownsWorktree) || normPath(worktreePath) !== normPath(targetRepo);
    if (!isIsolatedWorktree) return recordedBase;
    const liveMergeBase = await resolveIntegrationMergeBase(targetRepo, snapshotOid);
    return liveMergeBase ?? recordedBase;
  }

  resolveTargetRunForOperation(
    explicitRunId?: string | null,
    callerPaneId?: string,
    fallbackFrom?: string,
  ): OrchestrationRunRecord {
    const cleanRunId = explicitRunId?.trim() || undefined;
    if (callerPaneId !== undefined) {
      const runId = this.host.authorizeRunAccess(cleanRunId, callerPaneId);
      this.host.assertRunCoordinator(runId, callerPaneId);
      return this.host.store.requireRun(runId);
    }
    if (cleanRunId) {
      return this.host.store.requireRun(cleanRunId);
    }
    const inferred = this.host.inferRunIdOptional(fallbackFrom || 'coordinator');
    if (inferred) {
      return this.host.store.requireRun(inferred);
    }
    const activeRuns = this.host.store.listRuns({ status: 'active' });
    if (activeRuns.length === 1) {
      return activeRuns[0]!;
    }
    throw new OrchestrationError(
      'run_not_found',
      'No active run could be resolved. Specify runId explicitly.',
    );
  }

  async resolveRunCombinedDiffTarget(
    run: OrchestrationRunRecord,
    opts?: { requireCleanIntegrationWorktree?: boolean },
  ): Promise<{
    hasChanges: boolean;
    mainRepoRoot: string | null;
    repoPath: string | null;
    branch: string | null;
    baseCommit: string | null;
    targetCommit: string | null;
    isActiveIntegrationBranch: boolean;
    integratedWorkers: RunIntegratedWorkerSummaryForReview[];
  }> {
    const integratedDispatches = this.host.store.listIntegratedDispatchesForRun(run.id);
    const integratedWorkers: RunIntegratedWorkerSummaryForReview[] = integratedDispatches.map((d) => {
      const t = this.host.store.getTask(d.taskId);
      return {
        dispatchId: d.id,
        role: this.host.resolveRoleNameForDispatch(d) || d.id,
        cliId: d.cliId ?? null,
        ...(d.authorCliIds?.length ? { authorCliIds: d.authorCliIds } : {}),
        taskSpec: t?.spec ?? '',
        taskContext: t?.taskContext ?? null,
        integratedCommit: d.integratedCommit ?? null,
      };
    });

    const isActiveIntegrationBranch = this.isRunIntegrationBranchLive(run);

    if (isActiveIntegrationBranch) {
      const wtPath = run.integrationWorktreePath!;
      const branch = run.integrationBranch!;
      const mainRepoRoot =
        run.integrationRepoRootPath ??
        (await resolveMainRepoRoot(wtPath, this.host.getDefaultCwd?.() ?? null));
      if (opts?.requireCleanIntegrationWorktree) {
        const [status, ref] = await Promise.all([
          getGitStatus(wtPath),
          resolveTargetSymbolicRef(wtPath),
        ]);
        if (!status.ok || !status.isGitRepo) {
          throw new OrchestrationError(
            'worktree_failed',
            `Run integration worktree at ${wtPath} is missing or invalid.`,
          );
        }
        if (ref !== `refs/heads/${branch}`) {
          throw new OrchestrationError(
            'operation_rejected',
            `Run integration worktree is on ${ref ?? 'detached HEAD'} instead of refs/heads/${branch}.`,
          );
        }
        const dirty = status.entries.map((e) => e.path).filter((p): p is string => Boolean(p));
        if (dirty.length > 0) {
          throw new OrchestrationError(
            'operation_rejected',
            `Run integration worktree has ${dirty.length} uncommitted file(s): ${dirty.join(', ')}. Clean or commit them before reviewing.`,
            { dirtyFiles: dirty },
          );
        }
      }
      const headOid =
        (mainRepoRoot ? await resolveBranchRefOid(mainRepoRoot, branch) : null) ??
        run.integrationHeadCommit ??
        null;
      const baseCommit = run.integrationBaseCommit ?? null;
      return {
        hasChanges: Boolean(baseCommit && headOid && baseCommit !== headOid),
        mainRepoRoot,
        repoPath: mainRepoRoot ?? wtPath,
        branch,
        baseCommit,
        targetCommit: headOid,
        isActiveIntegrationBranch: true,
        integratedWorkers,
      };
    }

    const fallbackRepoCandidate =
      run.integrationRepoRootPath ??
      integratedDispatches[0]?.repoRootPath ??
      integratedDispatches[0]?.worktreePath ??
      this.host.getDefaultCwd?.() ??
      null;
    const mainRepoRoot = fallbackRepoCandidate
      ? await resolveMainRepoRoot(fallbackRepoCandidate, run.integrationRepoRootPath ?? this.host.getDefaultCwd?.() ?? null)
      : null;
    const baseCommit = run.integrationBaseCommit ?? null;
    const targetCommit =
      run.integrationHeadCommit ??
      (run.integrationStatus === 'finalized' ? run.finalizedCommit : null) ??
      null;
    return {
      hasChanges: Boolean(mainRepoRoot && baseCommit && targetCommit && baseCommit !== targetCommit),
      mainRepoRoot,
      repoPath: mainRepoRoot,
      branch: run.integrationBaseBranch ?? null,
      baseCommit,
      targetCommit,
      isActiveIntegrationBranch: false,
      integratedWorkers,
    };
  }

  async workerDiff(
    input: {
      dispatchId?: string;
      worker?: string;
      taskId?: string;
      files?: string[];
      maxDiffBytes?: number;
    },
    callerPaneId?: string,
  ): Promise<WorkerDiffInspection & {
    dispatchId: string;
    taskId: string;
    role: string;
    reviewStatus: string;
    reviewRound: number;
    integrationStatus: string;
  }> {
    const rawTarget = input.dispatchId?.trim() || input.worker?.trim() || input.taskId?.trim() || '';
    const dispatch = rawTarget
      ? this.host.resolveDispatchByRoleOrTarget(rawTarget, callerPaneId)
      : this.host.resolveTargetDispatch(input);
    if (callerPaneId !== undefined) {
      this.host.authorizeRunAccess(dispatch.runId, callerPaneId);
      this.host.assertWorkerController({ dispatchId: dispatch.id }, callerPaneId);
    }
    const worktreePath =
      dispatch.worktreePath ??
      (dispatch.assigneePaneId
        ? this.host.terminalTracker?.getTerminal(dispatch.assigneePaneId)?.cwd
        : undefined) ??
      this.host.getDefaultCwd?.() ??
      process.cwd();
    const run = this.host.store.getRun(dispatch.runId);
    const mainRepoRoot = run
      ? await resolveMainRepoRoot(worktreePath, dispatch.repoRootPath ?? this.host.getDefaultCwd?.() ?? null).catch(() => null)
      : null;
    const snapForBase = mainRepoRoot
      ? await captureWorkerSnapshotOid(worktreePath, { rejectStagedDivergence: false }).catch(() => null)
      : null;
    const effectiveBaseCommit = run
      ? await this.resolveEffectiveWorkerDiffBase(
          run,
          dispatch,
          worktreePath,
          mainRepoRoot,
          snapForBase?.snapshotOid ?? null,
        )
      : dispatch.baseCommit;
    const inspection = await inspectWorkerDiff({
      worktreePath,
      baseCommit: effectiveBaseCommit,
      files: input.files,
      maxDiffBytes: input.maxDiffBytes,
    });
    return {
      ...inspection,
      dispatchId: dispatch.id,
      taskId: dispatch.taskId,
      role: this.host.resolveRoleNameForDispatch(dispatch) || dispatch.id,
      reviewStatus: dispatch.reviewStatus ?? 'none',
      reviewRound: dispatch.reviewRound ?? 0,
      integrationStatus: dispatch.integrationStatus ?? 'none',
    };
  }

  private recordIntegratedFact(dispatch: OrchestrationDispatchRecord, result: WorkerIntegrationResult, resident: boolean): void {
    this.host.store.appendObservationFact({
      runId: dispatch.runId, dispatchId: dispatch.id, workerId: dispatch.assigneeHandle, kind: 'integrated',
      data: {
        mode: result.mode, integrated: result.integrated, snapshotOid: result.snapshotOid || null,
        integratedCommit: result.integratedCommit, targetBranch: result.targetBranch, resident,
      },
    });
  }

  async workerIntegrate(
    input: {
      dispatchId?: string;
      worker?: string;
      taskId?: string;
      mode?: WorkerIntegrateMode;
      targetBranch?: WorkerIntegrateTargetBranch;
      expectedSnapshotOid?: string;
      commitMessage?: string;
      releaseAfter?: boolean;
      deleteBranch?: boolean;
      force?: boolean;
      /** Keep a headless Worker and its worktree for a next wave instead of releasing them. */
      keepResident?: boolean;
    },
    callerPaneId?: string,
  ): Promise<WorkerIntegrationResult & {
    dispatchId: string;
    taskId: string;
    role: string;
    usedRunIntegrationBranch: boolean;
    released: boolean;
    resident?: boolean;
    releasedReviews: number;
    releaseSkippedReason?: string;
    cleanupWarnings?: string[];
    recommendedNextStep?: string;
  }> {
    const rawTarget = input.dispatchId?.trim() || input.worker?.trim() || input.taskId?.trim() || '';
    const dispatch = rawTarget
      ? this.host.resolveDispatchByRoleOrTarget(rawTarget, callerPaneId)
      : this.host.resolveTargetDispatch(input);
    if (callerPaneId !== undefined) {
      this.host.authorizeRunAccess(dispatch.runId, callerPaneId);
      this.host.assertRunCoordinator(dispatch.runId, callerPaneId);
    }
    if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) {
      throw new OrchestrationError(
        'operation_rejected',
        `Worker ${dispatch.id} is still active (${dispatch.status}). Wait for completion before integrating.`,
      );
    }
    if (dispatch.reviewOfDispatchId || dispatch.reviewOfRunId) {
      throw new OrchestrationError(
        'operation_rejected',
        `Dispatch ${dispatch.id} is a read-only adversarial review and cannot be integrated.`,
      );
    }
    if (input.keepResident && (dispatch.executionMode !== 'codex-app-server' || !dispatch.ownsWorktree ||
        !dispatch.worktreePath || !dispatch.ownsBranch || input.releaseAfter === false)) {
      throw new OrchestrationError(
        'invalid_argument',
        'keepResident needs a headless Worker in its own worktree and branch, and cannot be combined with releaseAfter=false.',
      );
    }

    const mode: WorkerIntegrateMode = input.mode ?? 'squash';
    const role = this.host.resolveRoleNameForDispatch(dispatch) || dispatch.id;
    const task = this.host.store.requireTask(dispatch.taskId);
    this.host.store.requireRun(dispatch.runId);
    const worktreePath = dispatch.worktreePath;
    if (!worktreePath) {
      return {
        mode,
        checkStatus: 'clean',
        integrated: false,
        noChanges: true,
        clean: true,
        targetRepoPath: '',
        targetBranch: null,
        targetRef: null,
        snapshotOid: '',
        integratedCommit: null,
        conflictFiles: [],
        ignoredCollisionFiles: [],
        changedFiles: [],
        message: 'Worker has no recorded worktree path; nothing to merge.',
        dispatchId: dispatch.id,
        taskId: dispatch.taskId,
        role,
        usedRunIntegrationBranch: false,
        released: false,
        releasedReviews: 0,
      };
    }

    const mainRepoRoot = await resolveMainRepoRoot(
      worktreePath,
      dispatch.repoRootPath ?? this.host.getDefaultCwd?.() ?? null,
    );
    const normWt = process.platform === 'win32' ? worktreePath.toLowerCase() : worktreePath;
    const normMain = mainRepoRoot
      ? process.platform === 'win32'
        ? mainRepoRoot.toLowerCase()
        : mainRepoRoot
      : null;

    if (!mainRepoRoot || (!dispatch.ownsWorktree && normMain === normWt)) {
      this.host.store.updateDispatchIntegrationState(dispatch.id, { integrationStatus: 'skipped' });
      return {
        mode,
        checkStatus: 'clean',
        integrated: false,
        noChanges: false,
        clean: true,
        targetRepoPath: mainRepoRoot ?? worktreePath,
        targetBranch: dispatch.branch ?? null,
        targetRef: null,
        snapshotOid: '',
        integratedCommit: null,
        conflictFiles: [],
        ignoredCollisionFiles: [],
        changedFiles: [],
        message: !mainRepoRoot
          ? 'Non-git workspace: no branch merge required. Review files directly and release when ready.'
          : 'Worker ran directly in the main workspace (no isolated branch to merge). Review changes and release when ready.',
        dispatchId: dispatch.id,
        taskId: dispatch.taskId,
        role,
        usedRunIntegrationBranch: false,
        released: false,
        releasedReviews: 0,
      };
    }

    const executeIntegrate = async () => {
      const run = this.host.store.requireRun(dispatch.runId);
      if (run.integrationIntent) throw new OrchestrationError('operation_rejected', '上一次 Git 交付尚待核对。');
      const latestDispatch = this.host.store.getDispatchContext(dispatch.id) ?? dispatch;
      const hasActiveRunIntegrationBranch = this.isRunIntegrationBranchLive(run);
      const sameRunRepo = run.integrationRepoRootPath
        ? await isSameGitRepo(mainRepoRoot, run.integrationRepoRootPath)
        : true;

      if (hasActiveRunIntegrationBranch && !sameRunRepo) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} already has an active integration branch (${run.integrationBranch}) in a different Git repository (${run.integrationRepoRootPath}). Finalize it before integrating workers from another repository.`,
          { runId: run.id, integrationBranch: run.integrationBranch },
        );
      }
      if (run.integrationRepoRootPath && !sameRunRepo) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} integration tracking is bound to a different Git repository (${run.integrationRepoRootPath}) and cannot integrate workers from ${mainRepoRoot}. Start a separate Run for the other repository.`,
          {
            runId: run.id,
            integrationRepoRootPath: run.integrationRepoRootPath,
            workerRepoRootPath: mainRepoRoot,
          },
        );
      }
      const effectiveTargetBranch: WorkerIntegrateTargetBranch = input.targetBranch ?? 'auto';
      if (effectiveTargetBranch === 'main' && hasActiveRunIntegrationBranch) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} already has an active integration branch (${run.integrationBranch}). Integrate into targetBranch="integration" or finalize the Run integration branch first to avoid splitting Run changes.`,
          { runId: run.id, integrationBranch: run.integrationBranch },
        );
      }

      let useRunIntegrationBranch = false;
      if (effectiveTargetBranch === 'integration') {
        useRunIntegrationBranch = true;
      } else if (effectiveTargetBranch === 'auto') {
        if (hasActiveRunIntegrationBranch) {
          useRunIntegrationBranch = true;
        } else {
          const mainStatus = await getGitStatus(mainRepoRoot);
          useRunIntegrationBranch = Boolean(
            mainStatus.ok && mainStatus.isGitRepo && mainStatus.entries.length > 0,
          );
        }
      }

      if (
        useRunIntegrationBranch &&
        !hasActiveRunIntegrationBranch &&
        (run.integrationBranch || run.integrationWorktreePath)
      ) {
        const retainedBranchExists = run.integrationBranch
          ? Boolean(await resolveBranchRefOid(mainRepoRoot, run.integrationBranch))
          : false;
        const retainedWorktreeExists = run.integrationWorktreePath
          ? existsSync(run.integrationWorktreePath)
          : false;
        if (retainedBranchExists || retainedWorktreeExists) {
          throw new OrchestrationError(
            'operation_rejected',
            `Run ${run.id} retained a previous integration branch or worktree (${run.integrationBranch ?? run.integrationWorktreePath}). Remove it before starting a new integration branch wave.`,
            {
              runId: run.id,
              integrationBranch: run.integrationBranch,
              integrationWorktreePath: run.integrationWorktreePath,
            },
          );
        }
      }

      // Server-side adversarial review gate for write modes (`squash` / `merge`).
      // Terminal/HTTP callers (`callerPaneId !== undefined`) cannot override review gates with `force`.
      const manualUserOverride = callerPaneId === undefined && input.force === true;
      const callerExpectedOid = input.expectedSnapshotOid?.trim() || undefined;
      let authoritativeExpectedOid: string | undefined = callerExpectedOid;

      if (mode !== 'check') {
        const reviewStatus = latestDispatch.reviewStatus ?? 'none';
        if (reviewStatus === 'passed') {
          const approvedOid = latestDispatch.reviewSnapshotOid?.trim() || '';
          if (!approvedOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Worker ${latestDispatch.id} has reviewStatus=passed but no server-recorded approved snapshot OID. Re-run adversarial review before integrating.`,
            );
          }
          if (callerExpectedOid && callerExpectedOid !== approvedOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Caller expectedSnapshotOid (${callerExpectedOid}) does not match server-approved review snapshot (${approvedOid}).`,
              { callerExpectedOid, approvedSnapshotOid: approvedOid },
            );
          }
          authoritativeExpectedOid = approvedOid;
        } else if (!manualUserOverride) {
          if (reviewStatus === 'pending') {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: adversarial review for ${latestDispatch.id} is still pending. Wait for all reviewers in batch ${latestDispatch.reviewBatchId ?? '(current)'} to report PASS.`,
            );
          }
          if (reviewStatus === 'rejected' || reviewStatus === 'escalated') {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: adversarial review for ${latestDispatch.id} is ${reviewStatus}. Fix blocking findings and pass a new review round before integrating.`,
            );
          }
          // reviewStatus === 'none': only explicit L0 changes are exempt from adversarial review.
          // Evaluate L0 against the exact merge-base(targetHead, snapshotOid)..snapshotOid range
          // that integration will actually merge (never a stale or fallback HEAD~1).
          const l0Snap = await captureWorkerSnapshotOid(worktreePath, { rejectStagedDivergence: true });
          if (!l0Snap.snapshotOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: could not capture worker snapshot for L0 review exemption on ${latestDispatch.id}.`,
            );
          }
          const l0TargetRepo =
            useRunIntegrationBranch && hasActiveRunIntegrationBranch
              ? run.integrationWorktreePath!
              : mainRepoRoot;
          const mergeBase = await resolveIntegrationMergeBase(l0TargetRepo, l0Snap.snapshotOid);
          if (!mergeBase) {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: could not determine common Git merge-base for L0 review exemption on ${latestDispatch.id}.`,
            );
          }
          const diffPreview = await inspectWorkerDiff({
            worktreePath,
            baseCommit: mergeBase,
            maxDiffBytes: 8 * 1024,
          });
          if (!diffPreview.snapshotOid || diffPreview.snapshotOid !== l0Snap.snapshotOid ||
              diffPreview.diffError || diffPreview.stagedDivergentFiles.length > 0 ||
              diffPreview.recommendedReviewTier !== 'L0') {
            throw new OrchestrationError(
              'operation_rejected',
              `Integration blocked: ${diffPreview.recommendedReviewTier} change (${diffPreview.diffError || diffPreview.tierReason}) requires a passing adversarial review before ${mode} integration.`,
              {
                recommendedReviewTier: diffPreview.recommendedReviewTier,
                tierReason: diffPreview.tierReason,
                dispatchId: latestDispatch.id,
              },
            );
          }
          if (callerExpectedOid && callerExpectedOid !== diffPreview.snapshotOid) {
            throw new OrchestrationError('operation_rejected', 'Worker snapshot changed since inspection. Inspect it again.');
          }
          authoritativeExpectedOid = diffPreview.snapshotOid;
        }
      }

      const branchOidBeforeIntegrate =
        latestDispatch.ownsBranch && latestDispatch.branch?.startsWith(WORKER_BRANCH_PREFIX)
          ? await resolveBranchRefOid(mainRepoRoot, latestDispatch.branch)
          : null;

      const commitMessage =
        input.commitMessage?.trim() ||
        `chore(orchestration): integrate @${role} (${task.taskTitle.slice(0, 72)})`;

      const targetRepoForBase =
        useRunIntegrationBranch && hasActiveRunIntegrationBranch
          ? run.integrationWorktreePath!
          : mainRepoRoot;
      const currentSnapForBase =
        authoritativeExpectedOid ??
        (await captureWorkerSnapshotOid(worktreePath, { rejectStagedDivergence: false }).catch(() => null))
          ?.snapshotOid ??
        null;
      let effectiveIntegrationBaseCommit: string | null = latestDispatch.baseCommit ?? null;
      if (
        latestDispatch.reviewStatus === 'passed' &&
        latestDispatch.reviewSnapshotOid &&
        latestDispatch.reviewBaseCommit &&
        (mode !== 'check' || latestDispatch.reviewSnapshotOid === currentSnapForBase)
      ) {
        effectiveIntegrationBaseCommit = latestDispatch.reviewBaseCommit;
      } else if (latestDispatch.baseCommit && currentSnapForBase) {
        const stillDescendsFromRecordedBase = await isGitCommitAncestor(
          worktreePath,
          latestDispatch.baseCommit,
          currentSnapForBase,
        );
        if (!stillDescendsFromRecordedBase) {
          effectiveIntegrationBaseCommit = await resolveIntegrationMergeBase(
            targetRepoForBase,
            currentSnapForBase,
          );
        }
      }

      const beforePublish: NonNullable<Parameters<typeof integrateWorkerChanges>[0]['beforePublish']> = async evidence => {
        this.host.store.updateRunIntegrationState(run.id, { integrationIntent: { ...evidence, repo: mainRepoRoot, dispatchId: latestDispatch.id } });
        await this.host.store.flushDurable();
      };
      let result: WorkerIntegrationResult;
      let runBranchResult: Awaited<ReturnType<typeof integrateWorkerIntoRunBranch>> | null = null;
      if (useRunIntegrationBranch) {
        runBranchResult = await integrateWorkerIntoRunBranch({
          beforePublish,
          mainRepoRoot,
          runId: run.id,
          existingBranch: hasActiveRunIntegrationBranch ? run.integrationBranch : null,
          existingWorktreePath: hasActiveRunIntegrationBranch ? run.integrationWorktreePath : null,
          existingBaseCommit: run.integrationBaseCommit ?? null,
          existingBaseBranch: run.integrationBaseBranch ?? null,
          worktreePath,
          baseCommit: effectiveIntegrationBaseCommit,
          recordedBaseCommit: latestDispatch.baseCommit,
          expectedSnapshotOid: authoritativeExpectedOid,
          strictReviewedTree: true,
          mode,
          commitMessage,
        });
        result = runBranchResult.result;
      } else {
        const expectedMainRef =
          sameRunRepo && run.integrationBaseBranch?.trim()
            ? `refs/heads/${run.integrationBaseBranch.trim()}`
            : null;
        result = await integrateWorkerChanges({
          beforePublish,
          targetRepoPath: mainRepoRoot,
          worktreePath,
          baseCommit: effectiveIntegrationBaseCommit,
          recordedBaseCommit: latestDispatch.baseCommit,
          expectedSnapshotOid: authoritativeExpectedOid,
          expectedTargetRef: expectedMainRef,
          strictReviewedTree: true,
          mode,
          commitMessage,
        });
      }

      if (mode === 'check') {
        this.host.store.updateDispatchIntegrationState(latestDispatch.id, {
          integrationStatus: result.clean ? 'checked' : 'conflict',
        });
        this.host.emitChanged('worker:integration-checked', latestDispatch.runId);
        return {
          ...result,
          dispatchId: latestDispatch.id,
          taskId: latestDispatch.taskId,
          role,
          usedRunIntegrationBranch: useRunIntegrationBranch,
          released: false,
          releasedReviews: 0,
        };
      }

      if (!result.integrated && !result.noChanges) {
        this.host.store.updateDispatchIntegrationState(latestDispatch.id, { integrationStatus: 'conflict' });
        this.host.emitChanged('worker:integration-conflict', latestDispatch.runId);
        return {
          ...result,
          dispatchId: latestDispatch.id,
          taskId: latestDispatch.taskId,
          role,
          usedRunIntegrationBranch: useRunIntegrationBranch,
          released: false,
          releasedReviews: 0,
        };
      }

      // If this was a brand-new Run integration branch with zero diff, integrateWorkerIntoRunBranch
      // rolled back the empty branch/worktree so no Run integration branch became active.
      const effectiveUsedRunBranch =
        useRunIntegrationBranch && (hasActiveRunIntegrationBranch || result.integrated);

      this.host.store.updateDispatchIntegrationState(latestDispatch.id, {
        integrationStatus: 'merged',
        noChanges: result.noChanges,
        integratedCommit: result.integratedCommit,
        integratedTargetBranch: effectiveUsedRunBranch ? result.targetBranch : (useRunIntegrationBranch ? null : result.targetBranch),
      });

      const latestRun = this.host.store.requireRun(run.id);
      this.host.store.updateRunIntegrationState(run.id, { integrationIntent: null });
      if (effectiveUsedRunBranch && runBranchResult) {
        this.host.store.updateRunIntegrationState(run.id, {
          integrationBranch: runBranchResult.integrationBranch,
          integrationWorktreePath: runBranchResult.integrationWorktreePath,
          integrationBaseCommit: latestRun.integrationBaseCommit ?? runBranchResult.integrationBaseCommit,
          integrationBaseBranch: latestRun.integrationBaseBranch ?? runBranchResult.integrationBaseBranch,
          integrationRepoRootPath: mainRepoRoot,
          integrationStatus: 'active',
          integrationHeadCommit: result.integratedCommit,
          finalizedCommit: null,
        });
      } else if (!useRunIntegrationBranch && sameRunRepo) {
        const reopeningAfterFinalized =
          result.integrated && !result.noChanges && latestRun.integrationStatus === 'finalized';
        this.host.store.updateRunIntegrationState(run.id, {
          integrationBaseCommit: latestRun.integrationBaseCommit ?? result.targetHeadBefore ?? null,
          integrationBaseBranch: latestRun.integrationBaseBranch ?? result.targetBranch ?? null,
          integrationRepoRootPath: latestRun.integrationRepoRootPath ?? mainRepoRoot,
          integrationHeadCommit: result.integratedCommit,
          ...(reopeningAfterFinalized
            ? { integrationStatus: 'none', finalizedCommit: null }
            : {}),
        });
      }

      // Reset Wave 1's completed Run-level review metadata when starting a brand-new
      // integration wave AFTER a prior finalization (whether via aha/run/* or directly on main).
      // Within an active wave, preserve `runReviewStatus === 'passed'` + `runReviewSnapshotOid`
      // so `runFinalizeIntegration` strictly enforces TOCTOU until a fresh Run-level review passes.
      if (
        (effectiveUsedRunBranch || (!useRunIntegrationBranch && sameRunRepo)) &&
        result.integrated &&
        !result.noChanges &&
        latestRun.integrationStatus === 'finalized'
      ) {
        this.host.store.updateRunReviewState(run.id, {
          runReviewStatus: 'none',
          runReviewRound: 0,
          runReviewBatchId: null,
          runReviewSnapshotOid: null,
          runReviewBaseCommit: null,
          runReviewFindings: [],
        });
      }

      const runDispatches = this.host.store
        .listDispatches({ runId: latestDispatch.runId })
        .filter((d) => !d.reviewOfDispatchId && !d.reviewOfRunId);
      const latestByTask = new Map<string, OrchestrationDispatchRecord>();
      for (const d of runDispatches) {
        const prev = latestByTask.get(d.taskId);
        if (!prev || (d.processGeneration ?? 0) >= (prev.processGeneration ?? 0)) {
          latestByTask.set(d.taskId, d);
        }
      }
      const implWorkers = [...latestByTask.values()];
      const remainingWorkers = implWorkers.filter(
        (d) =>
          d.id !== latestDispatch.id &&
          d.integrationStatus !== 'merged' &&
          d.integrationStatus !== 'skipped' &&
          d.status !== 'failed' &&
          d.status !== 'circuit_broken' &&
          !d.releasedAt,
      );
      const mergedCount = implWorkers.filter((d) => d.integrationStatus === 'merged').length;
      let recommendedNextStep: string | undefined;
      if (effectiveUsedRunBranch && result.targetBranch) {
        recommendedNextStep =
          remainingWorkers.length === 0
            ? `All active workers are staged on ${result.targetBranch} (main workspace untouched). Next: inspect_run_diff(), optionally delegate_task(reviewRun=true), and call finalize_run_integration() once main is clean.`
            : `Staged on ${result.targetBranch} (${remainingWorkers.length} other worker(s) remaining). Continue integrating remaining workers, then finalize_run_integration().`;
      } else if (remainingWorkers.length === 0 && mergedCount >= 2) {
        recommendedNextStep =
          'All workers integrated into main. You may run inspect_run_diff() / delegate_task(reviewRun=true) for a combined Run-level check before reporting final results.';
      }

      const boardMsg = this.host.store.insertMessage({
        runId: latestDispatch.runId,
        from: callerPaneId || 'coordinator',
        to: `run:${latestDispatch.runId}`,
        type: 'status',
        subject: `Integrated @${role}${effectiveUsedRunBranch && result.targetBranch ? ` -> ${result.targetBranch}` : ''}`,
        body: result.noChanges
          ? `[@${role}] No diff relative to ${result.targetBranch ?? 'HEAD'}; marked integrated.`
          : `[@${role}] ${result.message}${effectiveUsedRunBranch && result.targetBranch ? ` on ${result.targetBranch}` : ''}`,
        fromRole: 'coordinator',
        mentions: [role.toLowerCase()],
        kind: 'update',
        artifacts: {
          branch: result.targetBranch,
          headCommit: result.integratedCommit?.slice(0, 10) ?? null,
          snapshotOid: result.snapshotOid,
          changedFiles: result.changedFiles.slice(0, 20),
          changedFileCount: result.changedFiles.length,
          ...(recommendedNextStep ? { recommendedNextStep } : {}),
        },
      });
      this.host.store.markAsReadAndDelivered([boardMsg.id]);

      let released = false;
      let releasedReviews = 0;
      let releaseSkippedReason: string | undefined;
      const cleanupWarnings: string[] = result.cleanupWarning ? [result.cleanupWarning] : [];

      if (input.releaseAfter !== false) {
        // Collect reviews attached to any dispatch in this author's lineage.
        const lineageIds = this.host.store.listDispatchAncestorIds(latestDispatch.id);
        const seenReviewIds = new Set<string>();
        for (const ancestorId of lineageIds) {
          const reviews = this.host.store.listReviewDispatchesForTarget(ancestorId);
          for (const rev of reviews) {
            if (seenReviewIds.has(rev.id)) continue;
            seenReviewIds.add(rev.id);
            if ((!rev.releasedAt || rev.ownsWorktree) && !ACTIVE_DISPATCH_STATUSES.has(rev.status)) {
              try {
                const revRel = await this.host.workerRelease({ dispatchId: rev.id, force: true });
                if (revRel.worktreeError) {
                  cleanupWarnings.push(`Review ${rev.id} worktree cleanup failed: ${revRel.worktreeError}`);
                } else if (revRel.dispatch.releasedAt) {
                  releasedReviews += 1;
                }
              } catch (err) {
                cleanupWarnings.push(
                  `Review ${rev.id} cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
        }

        if (input.keepResident && result.integrated && result.targetBranch) {
          this.host.store.setDispatchResident(latestDispatch.id, {
            targetBranch: result.targetBranch, integratedBranchOid: branchOidBeforeIntegrate, integratedSnapshotOid: result.snapshotOid,
          });
          this.recordIntegratedFact(latestDispatch, result, true);
          this.host.emitChanged('worker:integrated', latestDispatch.runId);
          return {
            ...result, dispatchId: latestDispatch.id, taskId: latestDispatch.taskId, role,
            usedRunIntegrationBranch: effectiveUsedRunBranch, released: false, resident: true, releasedReviews,
            ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
            recommendedNextStep: `@${role} stays resident in ${latestDispatch.worktreePath}; its next follow-up starts a new wave on a fresh branch from ${result.targetBranch}.`,
          };
        }
        try {
          const rel = await this.host.mutateWorkerResources(latestDispatch, async () => {
            const current = this.host.store.getDispatchContext(latestDispatch.id);
            const head = this.host.store.resolveDispatchLineage(latestDispatch.id);
            if (!current || head?.id !== latestDispatch.id) {
              throw new OrchestrationError('operation_rejected', 'Worker lineage changed; retained worktree and branch.');
            }
            return this.host.releaseWorker(current, {
              dispatchId: latestDispatch.id,
              keepBranch: input.deleteBranch === false,
              expectedBranchOid: branchOidBeforeIntegrate,
            }, result.snapshotOid);
          });
          if (rel.worktreeError) {
            releaseSkippedReason = rel.worktreeError;
            cleanupWarnings.push(rel.worktreeError);
          } else {
            released = Boolean(rel.dispatch.releasedAt);
            if (rel.removedWorktree && latestDispatch.ownsBranch && input.deleteBranch !== false && !rel.removedBranch) {
              cleanupWarnings.push('Worker branch was retained because Git could not safely delete it.');
            }
          }
        } catch (error) {
          releaseSkippedReason = 'Worker cleanup deferred: ' + (error instanceof Error ? error.message : String(error));
          cleanupWarnings.push(releaseSkippedReason);
        }
      }

      this.recordIntegratedFact(latestDispatch, result, false);
      this.host.emitChanged('worker:integrated', latestDispatch.runId);
      return {
        ...result,
        dispatchId: latestDispatch.id,
        taskId: latestDispatch.taskId,
        role,
        usedRunIntegrationBranch: effectiveUsedRunBranch,
        released,
        releasedReviews,
        ...(releaseSkippedReason ? { releaseSkippedReason } : {}),
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
        ...(recommendedNextStep ? { recommendedNextStep } : {}),
      };
    };

    return mode === 'check'
      ? executeIntegrate()
      : this.withRunIntegrationLock(dispatch.runId, executeIntegrate);
  }

  async runDiff(
    input: {
      runId?: string;
      files?: string[];
      maxDiffBytes?: number;
    },
    callerPaneId?: string,
  ): Promise<RunCommitRangeDiffInspection & {
    runId: string;
    hasIntegratedChanges: boolean;
    integrationStatus: string;
    integrationBranch: string | null;
    integrationWorktreePath: string | null;
    runReviewStatus: string;
    runReviewRound: number;
    runReviewSnapshotOid: string | null;
    integratedWorkers: Array<{
      dispatchId: string;
      role: string;
      cliId: string | null;
      integratedCommit: string | null;
    }>;
    message?: string;
  }> {
    const run = this.resolveTargetRunForOperation(input.runId, callerPaneId);
    const target = await this.resolveRunCombinedDiffTarget(run);
    const workersSummary = target.integratedWorkers.map((w) => ({
      dispatchId: w.dispatchId,
      role: w.role,
      cliId: w.cliId ?? null,
      integratedCommit: w.integratedCommit ?? null,
    }));

    if (!target.hasChanges || !target.repoPath || !target.baseCommit || !target.targetCommit) {
      return {
        isGitRepo: Boolean(target.mainRepoRoot),
        repoPath: target.repoPath ?? '',
        branch: target.branch,
        baseCommit: target.baseCommit,
        targetCommit: target.targetCommit,
        commitsAhead: 0,
        commits: [],
        changedFiles: [],
        diffStat: '',
        diff: '',
        diffTruncated: false,
        recommendedReviewTier: 'L0',
        tierReason: 'no integrated changes recorded for run',
        runId: run.id,
        hasIntegratedChanges: false,
        integrationStatus: run.integrationStatus ?? 'none',
        integrationBranch: run.integrationBranch ?? null,
        integrationWorktreePath: run.integrationWorktreePath ?? null,
        runReviewStatus: run.runReviewStatus ?? 'none',
        runReviewRound: run.runReviewRound ?? 0,
        runReviewSnapshotOid: run.runReviewSnapshotOid ?? null,
        integratedWorkers: workersSummary,
        message: 'No integrated changes recorded for this run yet.',
      };
    }

    const inspection = await inspectCommitRangeDiff({
      repoPath: target.repoPath,
      baseCommit: target.baseCommit,
      targetCommit: target.targetCommit,
      branch: target.branch,
      files: input.files,
      maxDiffBytes: input.maxDiffBytes,
    });
    return {
      ...inspection,
      runId: run.id,
      hasIntegratedChanges: inspection.changedFiles.length > 0 || inspection.commitsAhead > 0,
      integrationStatus: run.integrationStatus ?? 'none',
      integrationBranch: run.integrationBranch ?? null,
      integrationWorktreePath: run.integrationWorktreePath ?? null,
      runReviewStatus: run.runReviewStatus ?? 'none',
      runReviewRound: run.runReviewRound ?? 0,
      runReviewSnapshotOid: run.runReviewSnapshotOid ?? null,
      integratedWorkers: workersSummary,
    };
  }

  async runFinalizeIntegration(
    input: {
      runId?: string;
      mode?: WorkerIntegrateMode;
      expectedSnapshotOid?: string;
      commitMessage?: string;
      deleteBranch?: boolean;
      keepWorktree?: boolean;
      force?: boolean;
    },
    callerPaneId?: string,
  ): Promise<WorkerIntegrationResult & {
    runId: string;
    integrationBranch: string;
    integrationWorktreePath: string;
    removedWorktree: boolean;
    removedBranch: boolean;
    releasedReviews: number;
    cleanupWarnings?: string[];
  }> {
    const initialRun = this.resolveTargetRunForOperation(input.runId, callerPaneId);
    const mode: WorkerIntegrateMode = input.mode ?? 'squash';
    const executeFinalize = async () => {
      const run = this.host.store.requireRun(initialRun.id);
      if (run.integrationIntent) throw new OrchestrationError('operation_rejected', '上一次 Git 交付尚待核对。');
      if (
        !this.isRunIntegrationBranchLive(run) ||
        !run.integrationBranch ||
        !run.integrationWorktreePath ||
        !run.integrationRepoRootPath
      ) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} does not have an active integration branch to finalize (status=${run.integrationStatus ?? 'none'}).`,
          { runId: run.id, integrationStatus: run.integrationStatus ?? 'none' },
        );
      }

      const manualUserOverride = callerPaneId === undefined && input.force === true;
      const callerExpectedOid = input.expectedSnapshotOid?.trim() || undefined;
      let authoritativeExpectedOid: string | undefined = callerExpectedOid;

      if (mode !== 'check') {
        const activeDispatches = this.host.store
          .listDispatches({ runId: run.id })
          .filter((d) => ACTIVE_DISPATCH_STATUSES.has(d.status));
        if (activeDispatches.length > 0) {
          throw new OrchestrationError(
            'operation_rejected',
            `Run ${run.id} still has ${activeDispatches.length} active dispatch(es) (${activeDispatches.map((d) => d.id).join(', ')}). Wait for all workers/reviews to settle before finalizing.`,
            { activeDispatchIds: activeDispatches.map((d) => d.id) },
          );
        }

        const runReviewStatus = run.runReviewStatus ?? 'none';
        if (runReviewStatus === 'passed') {
          const approvedOid = run.runReviewSnapshotOid?.trim() || '';
          if (!approvedOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Run ${run.id} has runReviewStatus=passed without a recorded snapshot OID. Re-run Run-level adversarial review before finalizing.`,
            );
          }
          if (callerExpectedOid && callerExpectedOid !== approvedOid) {
            throw new OrchestrationError(
              'operation_rejected',
              `Caller expectedSnapshotOid (${callerExpectedOid}) does not match Run-level approved snapshot (${approvedOid}).`,
              { callerExpectedOid, approvedSnapshotOid: approvedOid },
            );
          }
          authoritativeExpectedOid = approvedOid;
        } else if (!manualUserOverride) {
          if (runReviewStatus === 'pending') {
            throw new OrchestrationError(
              'operation_rejected',
              `Finalization blocked: Run-level adversarial review for ${run.id} is still pending (batch ${run.runReviewBatchId ?? '(current)'}).`,
            );
          }
          if (runReviewStatus === 'rejected' || runReviewStatus === 'escalated') {
            throw new OrchestrationError(
              'operation_rejected',
              `Finalization blocked: Run-level adversarial review for ${run.id} is ${runReviewStatus}. Fix blocking findings and pass a new Run-level review before finalizing.`,
            );
          }
        }
      }

      const expectedBaseBranch = run.integrationBaseBranch?.trim() || '';
      if (!expectedBaseBranch) {
        throw new OrchestrationError(
          'operation_rejected',
          `Run ${run.id} has no recorded target branch (started from detached HEAD); refusing to finalize ${run.integrationBranch} into an arbitrary checked-out branch. Checkout the intended branch and merge ${run.integrationBranch} manually.`,
          { runId: run.id, integrationBranch: run.integrationBranch },
        );
      }
      const expectedTargetRef = `refs/heads/${expectedBaseBranch}`;
      const commitMessage =
        input.commitMessage?.trim() ||
        `chore(orchestration): finalize run ${run.id} (${run.objective.slice(0, 72)})`;

      const members: Record<string, string> = {};
      let sourceHead = '';
      const finalized: RunFinalizeIntegrationResult = await finalizeRunIntegrationBranch({
        beforePublish: async evidence => {
          sourceHead = evidence.sourceHead;
          for (const worker of this.host.store.listDispatches({ runId: run.id })) {
            if (worker.integrationStatus === 'merged' && worker.integratedTargetBranch === run.integrationBranch &&
                worker.integratedCommit && await isGitCommitAncestor(run.integrationRepoRootPath!, worker.integratedCommit, sourceHead)) {
              members[worker.id] = worker.integratedCommit;
            }
          }
          this.host.store.updateRunIntegrationState(run.id, { integrationIntent: { ...evidence, repo: run.integrationRepoRootPath!, members } });
          await this.host.store.flushDurable();
        },
        mainRepoRoot: run.integrationRepoRootPath,
        integrationBranch: run.integrationBranch,
        integrationWorktreePath: run.integrationWorktreePath,
        baseCommit: run.integrationBaseCommit ?? null,
        expectedTargetRef,
        expectedSnapshotOid: authoritativeExpectedOid,
        strictReviewedTree: true,
        mode,
        commitMessage,
        deleteBranch: input.deleteBranch,
        keepWorktree: input.keepWorktree,
      });

      if (mode === 'check') {
        return {
          ...finalized.result,
          runId: run.id,
          integrationBranch: finalized.integrationBranch,
          integrationWorktreePath: finalized.integrationWorktreePath,
          removedWorktree: false,
          removedBranch: false,
          releasedReviews: 0,
        };
      }

      if (!finalized.result.integrated && !finalized.result.noChanges) {
        this.host.store.updateRunIntegrationState(run.id, { integrationStatus: 'conflict' });
        this.host.emitChanged('run:integration-conflict', run.id);
        return {
          ...finalized.result,
          runId: run.id,
          integrationBranch: finalized.integrationBranch,
          integrationWorktreePath: finalized.integrationWorktreePath,
          removedWorktree: false,
          removedBranch: false,
          releasedReviews: 0,
          ...(finalized.cleanupWarnings.length > 0 ? { cleanupWarnings: finalized.cleanupWarnings } : {}),
        };
      }

      const cleanupWarnings = [...finalized.cleanupWarnings];
      let releasedReviews = 0;
      for (const resident of this.host.store.listDispatches({ runId: run.id })) {
        if (!resident.residentAfterIntegration || resident.releasedAt || ACTIVE_DISPATCH_STATUSES.has(resident.status)) continue;
        try {
          const rel = await this.host.workerRelease({ dispatchId: resident.id });
          if (rel.worktreeError) cleanupWarnings.push(`Resident worker ${resident.id} worktree cleanup failed: ${rel.worktreeError}`);
        } catch (err) {
          cleanupWarnings.push(`Resident worker ${resident.id} kept: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      for (const rev of this.host.store.listReviewDispatchesForRun(run.id)) {
        if ((!rev.releasedAt || rev.ownsWorktree) && !ACTIVE_DISPATCH_STATUSES.has(rev.status)) {
          try {
            const revRel = await this.host.workerRelease({ dispatchId: rev.id, force: true });
            if (revRel.worktreeError) {
              cleanupWarnings.push(`Run review ${rev.id} worktree cleanup failed: ${revRel.worktreeError}`);
            } else if (revRel.dispatch.releasedAt) {
              releasedReviews += 1;
            }
          } catch (err) {
            cleanupWarnings.push(
              `Run review ${rev.id} cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      }


      this.host.store.updateRunIntegrationState(run.id, {
        integrationIntent: null,
        ...(sourceHead && finalized.result.integratedCommit ? { finalizedBatch: {
          sourceHead, targetCommit: finalized.result.integratedCommit, branch: expectedBaseBranch, members,
        } } : {}),
        integrationStatus: 'finalized',
        finalizedCommit: finalized.result.integratedCommit,
        integrationHeadCommit: finalized.result.integratedCommit,
        integrationWorktreePath: finalized.removedWorktree ? null : run.integrationWorktreePath,
        integrationBranch: finalized.removedBranch ? null : run.integrationBranch,
      });

      const boardMsg = this.host.store.insertMessage({
        runId: run.id,
        from: callerPaneId || 'coordinator',
        to: `run:${run.id}`,
        type: 'status',
        subject: `Finalized ${finalized.integrationBranch} -> ${finalized.result.targetBranch ?? 'main'}`,
        body: finalized.result.noChanges
          ? `[Run ${run.id}] No diff between ${finalized.integrationBranch} and ${finalized.result.targetBranch ?? 'HEAD'}; marked finalized.`
          : `[Run ${run.id}] Promoted ${finalized.integrationBranch} into ${finalized.result.targetBranch ?? 'main'}: ${finalized.result.message}`,
        fromRole: 'coordinator',
        kind: 'update',
        artifacts: {
          branch: finalized.result.targetBranch,
          headCommit: finalized.result.integratedCommit?.slice(0, 10) ?? null,
          snapshotOid: finalized.result.snapshotOid,
          changedFiles: finalized.result.changedFiles.slice(0, 20),
          changedFileCount: finalized.result.changedFiles.length,
        },
      });
      this.host.store.markAsReadAndDelivered([boardMsg.id]);

      this.host.emitChanged('run:integration-finalized', run.id);
      return {
        ...finalized.result,
        runId: run.id,
        integrationBranch: finalized.integrationBranch,
        integrationWorktreePath: finalized.integrationWorktreePath,
        removedWorktree: finalized.removedWorktree,
        removedBranch: finalized.removedBranch,
        releasedReviews,
        ...(cleanupWarnings.length > 0 ? { cleanupWarnings } : {}),
      };
    };

    return mode === 'check'
      ? executeFinalize()
      : this.withRunIntegrationLock(initialRun.id, executeFinalize);
  }
}
