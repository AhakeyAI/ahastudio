import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import { completionReportDispatchId } from './orchestration-messaging.js';
import type { OrchestrationStore } from './orchestration-store.js';
import {
  OrchestrationError,
  type OrchestrationDispatchRecord,
  type OrchestrationMessageRecord,
  type OrchestrationReviewFinding,
  type OrchestrationReviewVerdict,
  type OrchestrationRunRecord,
} from './orchestration-types.js';
import { MAX_ADVERSARIAL_REVIEW_ROUNDS } from './adversarial-review.js';

/** Read-isolation scope of a review Worker: the dispatches, tasks, panes and roles it must not see. */
export interface ReviewFirewallContext {
  reviewDispatch: OrchestrationDispatchRecord;
  targetDispatchIds: Set<string>;
  targetTaskIds: Set<string>;
  targetPaneIds: Set<string>;
  targetRoles: Set<string>;
}

/** Service capabilities the OrchestrationReviewService relies on; supplied by OrchestrationService. */
export interface OrchestrationReviewHost {
  readonly emitChanged: (reason: string, runId?: string) => void;
  readonly failTaskIfReady: (taskId: string) => void;
  readonly resolveRoleNameForDispatch: (dispatch: OrchestrationDispatchRecord) => string;
  readonly store: OrchestrationStore;
}

/** Adversarial review read firewall, review batch reconciliation and review start locks. */
export class OrchestrationReviewService {
  constructor(private readonly host: OrchestrationReviewHost) {}

  private readonly reviewStartLocks = new Map<string, Promise<void>>();
  private readonly inFlightReviewStarts = new Map<string, number>();

  async withReviewStartLock<T>(targetDispatchId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.reviewStartLocks.get(targetDispatchId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const tail = previous.then(() => current);
    this.reviewStartLocks.set(targetDispatchId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.reviewStartLocks.get(targetDispatchId) === tail) {
        this.reviewStartLocks.delete(targetDispatchId);
      }
    }
  }

  getReviewFirewallContext(callerHandle?: string | null): ReviewFirewallContext | null {
    const clean = callerHandle?.trim();
    if (!clean) return null;
    const rawId = clean.startsWith('dispatch:') ? clean.slice('dispatch:'.length).trim() : clean;
    const direct =
      this.host.store.getDispatchContext(rawId) ??
      this.host.store.getActiveDispatchForIdentity(clean, clean);
    if (!direct || (!direct.reviewOfDispatchId && !direct.reviewOfRunId)) return null;

    const targetDispatchIds = new Set<string>();
    const targetTaskIds = new Set<string>();
    const targetPaneIds = new Set<string>();
    const targetRoles = new Set<string>();

    const collectTargetDispatch = (d: OrchestrationDispatchRecord) => {
      targetDispatchIds.add(d.id);
      targetTaskIds.add(d.taskId);
      if (d.assigneePaneId) targetPaneIds.add(d.assigneePaneId);
      if (d.assigneeHandle) targetPaneIds.add(d.assigneeHandle);
      const role = this.host.resolveRoleNameForDispatch(d).toLowerCase();
      if (role) targetRoles.add(role);
    };

    if (direct.reviewOfDispatchId) {
      const lineageHead =
        this.host.store.resolveDispatchLineage(direct.reviewOfDispatchId) ??
        this.host.store.getDispatchContext(direct.reviewOfDispatchId);
      const ids = lineageHead
        ? this.host.store.listDispatchAncestorIds(lineageHead.id)
        : [direct.reviewOfDispatchId];
      for (const id of ids) {
        targetDispatchIds.add(id);
        const d = this.host.store.getDispatchContext(id);
        if (d) collectTargetDispatch(d);
      }
    } else if (direct.reviewOfRunId) {
      for (const d of this.host.store.listDispatches({ runId: direct.reviewOfRunId })) {
        if (d.id === direct.id || d.reviewOfDispatchId || d.reviewOfRunId) continue;
        collectTargetDispatch(d);
      }
    }

    return {
      reviewDispatch: direct,
      targetDispatchIds,
      targetTaskIds,
      targetPaneIds,
      targetRoles,
    };
  }

  isPostHiddenByReviewFirewall(
    post: OrchestrationMessageRecord,
    firewall: ReviewFirewallContext,
  ): boolean {
    const fromRole = post.fromRole?.trim().replace(/^@+/, '').toLowerCase() ?? '';
    const fromDispatchId = post.fromHandle.startsWith('dispatch:')
      ? post.fromHandle.slice('dispatch:'.length)
      : null;
    const payloadDispatchId = completionReportDispatchId(this.host.store, post);
    const isFromTargetAuthor =
      Boolean(fromDispatchId && firewall.targetDispatchIds.has(fromDispatchId)) ||
      Boolean(payloadDispatchId && firewall.targetDispatchIds.has(payloadDispatchId)) ||
      firewall.targetPaneIds.has(post.fromHandle) ||
      Boolean(fromRole && firewall.targetRoles.has(fromRole));
    if (!isFromTargetAuthor) return false;
    // Block the author's completion reports, verbal summaries, and status self-assessments.
    return (
      post.kind === 'report' ||
      post.type === 'worker_done' ||
      post.kind === 'handoff' ||
      post.kind === 'update'
    );
  }

  assertNotFirewalledReviewRead(
    callerPaneId: string | undefined,
    targetDispatch: OrchestrationDispatchRecord,
    operationLabel: string,
  ): void {
    if (!callerPaneId) return;
    const firewall = this.getReviewFirewallContext(callerPaneId);
    if (!firewall) return;
    if (
      firewall.targetDispatchIds.has(targetDispatch.id) ||
      firewall.targetTaskIds.has(targetDispatch.taskId)
    ) {
      throw new OrchestrationError(
        'operation_rejected',
        `Information firewall: adversarial reviewer ${firewall.reviewDispatch.id} cannot call ${operationLabel} on target author ${targetDispatch.id}. Verify directly from the isolated review worktree and original requirements.`,
      );
    }
  }

  /**
   * Reconciles a review target's aggregate status for a specific review batch.
   * - Never lets stale/older batches overwrite a newer active batch on the target.
   * - Uses the batch's own reviewRound (not the target's current round) for escalation checks.
   * - Only marks `passed` when ALL reviewers in the batch completed with explicit `passed`
   *   and intact read-only workspace. Stopped/failed/abandoned reviewers reject the batch.
   */
  private reconcileTargetReviewBatch(
    reviewDispatchId: string,
    opts?: {
      overrideFindings?: OrchestrationReviewFinding[];
      overrideVerdict?: OrchestrationReviewVerdict;
      failedReason?: string;
    },
  ): { escalated: boolean; reviewRound: number; staleBatch: boolean } {
    const reviewDispatch = this.host.store.getDispatchContext(reviewDispatchId);
    if (!reviewDispatch?.reviewOfDispatchId) {
      return { escalated: false, reviewRound: 1, staleBatch: false };
    }
    const targetDispatch = this.host.store.getDispatchContext(reviewDispatch.reviewOfDispatchId);
    const batchRound = reviewDispatch.reviewRound ?? targetDispatch?.reviewRound ?? 1;
    if (!targetDispatch) {
      return { escalated: false, reviewRound: batchRound, staleBatch: false };
    }

    const batchId = reviewDispatch.reviewBatchId ?? null;
    const isCurrentBatch = Boolean(
      batchId
        ? targetDispatch.reviewBatchId === batchId
        : !targetDispatch.reviewBatchId &&
            (!reviewDispatch.reviewSnapshotOid ||
              targetDispatch.reviewSnapshotOid === reviewDispatch.reviewSnapshotOid),
    );
    if (!isCurrentBatch) {
      // Stale batch report: keep reviewer's own record/history without mutating the newer batch on target.
      return { escalated: false, reviewRound: batchRound, staleBatch: true };
    }

    const batchReviews = batchId
      ? this.host.store.listReviewDispatchesForBatch(targetDispatch.id, batchId)
      : this.host.store
          .listReviewDispatchesForTarget(targetDispatch.id)
          .filter(
            (d) =>
              !reviewDispatch.reviewSnapshotOid ||
              d.reviewSnapshotOid === reviewDispatch.reviewSnapshotOid,
          );
    if (batchReviews.length === 0) {
      return { escalated: false, reviewRound: batchRound, staleBatch: false };
    }

    const isEffectiveReject = (d: OrchestrationDispatchRecord): boolean => {
      if (d.id === reviewDispatch.id && opts?.overrideVerdict) {
        return opts.overrideVerdict === 'reject';
      }
      if (d.reviewStatus === 'rejected' || d.reviewMutatedWorkspace) return true;
      if (!ACTIVE_DISPATCH_STATUSES.has(d.status) && (d.status !== 'completed' || d.reviewStatus !== 'passed')) {
        return true;
      }
      return false;
    };

    const isEffectivePass = (d: OrchestrationDispatchRecord): boolean => {
      if (d.id === reviewDispatch.id && opts?.overrideVerdict) {
        return opts.overrideVerdict === 'pass' && !d.reviewMutatedWorkspace;
      }
      return (
        d.status === 'completed' &&
        d.reviewStatus === 'passed' &&
        !d.reviewMutatedWorkspace
      );
    };

    const hasInFlightPeerStart = (this.inFlightReviewStarts.get(`dispatch:${targetDispatch.id}`) ?? 0) > 0;
    const anyRejected = batchReviews.some(isEffectiveReject);
    const allSettled = batchReviews.every((d) =>
      d.id === reviewDispatch.id ? true : !ACTIVE_DISPATCH_STATUSES.has(d.status),
    );
    const allExplicitlyPassed = !hasInFlightPeerStart && allSettled && batchReviews.every(isEffectivePass);
    const mergedFindings = batchReviews.flatMap((d) =>
      d.id === reviewDispatch.id && opts?.overrideFindings
        ? opts.overrideFindings
        : (d.reviewFindings ?? []),
    );
    if (opts?.failedReason && !mergedFindings.some((f) => f.title === opts.failedReason)) {
      mergedFindings.push({
        severity: 'P1',
        location: '(review-lifecycle)',
        title: opts.failedReason,
        evidence: `Reviewer ${reviewDispatch.id} terminated without an explicit PASS verdict.`,
      });
    }

    if (anyRejected) {
      const escalated = batchRound >= MAX_ADVERSARIAL_REVIEW_ROUNDS;
      this.host.store.updateDispatchReviewState(targetDispatch.id, {
        reviewStatus: escalated ? 'escalated' : 'rejected',
        reviewFindings: mergedFindings,
      });
      return { escalated, reviewRound: batchRound, staleBatch: false };
    }

    if (allExplicitlyPassed) {
      this.host.store.updateDispatchReviewState(targetDispatch.id, {
        reviewStatus: 'passed',
        reviewFindings: mergedFindings,
      });
      return { escalated: false, reviewRound: batchRound, staleBatch: false };
    }

    this.host.store.updateDispatchReviewState(targetDispatch.id, {
      reviewStatus: 'pending',
      reviewFindings: mergedFindings,
    });
    return { escalated: false, reviewRound: batchRound, staleBatch: false };
  }

  /**
   * Reconciles a Run-level secondary adversarial review batch.
   * Mirrors `reconcileTargetReviewBatch` for `run.runReviewBatchId` / `run.runReviewStatus`.
   */
  private reconcileRunReviewBatch(
    reviewDispatchId: string,
    opts?: {
      overrideFindings?: OrchestrationReviewFinding[];
      overrideVerdict?: OrchestrationReviewVerdict;
      failedReason?: string;
    },
  ): { escalated: boolean; reviewRound: number; staleBatch: boolean } {
    const reviewDispatch = this.host.store.getDispatchContext(reviewDispatchId);
    if (!reviewDispatch?.reviewOfRunId) {
      return { escalated: false, reviewRound: 1, staleBatch: false };
    }
    const targetRun = this.host.store.getRun(reviewDispatch.reviewOfRunId);
    const batchRound = reviewDispatch.reviewRound ?? targetRun?.runReviewRound ?? 1;
    if (!targetRun) {
      return { escalated: false, reviewRound: batchRound, staleBatch: false };
    }

    const batchId = reviewDispatch.reviewBatchId ?? null;
    const isCurrentBatch = Boolean(
      batchId
        ? targetRun.runReviewBatchId === batchId
        : !targetRun.runReviewBatchId &&
            (!reviewDispatch.reviewSnapshotOid ||
              targetRun.runReviewSnapshotOid === reviewDispatch.reviewSnapshotOid),
    );
    if (!isCurrentBatch) {
      return { escalated: false, reviewRound: batchRound, staleBatch: true };
    }

    const batchReviews = batchId
      ? this.host.store.listReviewDispatchesForRunBatch(targetRun.id, batchId)
      : this.host.store
          .listReviewDispatchesForRun(targetRun.id)
          .filter(
            (d) =>
              !reviewDispatch.reviewSnapshotOid ||
              d.reviewSnapshotOid === reviewDispatch.reviewSnapshotOid,
          );
    if (batchReviews.length === 0) {
      return { escalated: false, reviewRound: batchRound, staleBatch: false };
    }

    const isEffectiveReject = (d: OrchestrationDispatchRecord): boolean => {
      if (d.id === reviewDispatch.id && opts?.overrideVerdict) {
        return opts.overrideVerdict === 'reject';
      }
      if (d.reviewStatus === 'rejected' || d.reviewMutatedWorkspace) return true;
      if (!ACTIVE_DISPATCH_STATUSES.has(d.status) && (d.status !== 'completed' || d.reviewStatus !== 'passed')) {
        return true;
      }
      return false;
    };

    const isEffectivePass = (d: OrchestrationDispatchRecord): boolean => {
      if (d.id === reviewDispatch.id && opts?.overrideVerdict) {
        return opts.overrideVerdict === 'pass' && !d.reviewMutatedWorkspace;
      }
      return (
        d.status === 'completed' &&
        d.reviewStatus === 'passed' &&
        !d.reviewMutatedWorkspace
      );
    };

    const hasInFlightPeerStart = (this.inFlightReviewStarts.get(`run:${targetRun.id}`) ?? 0) > 0;
    const anyRejected = batchReviews.some(isEffectiveReject);
    const allSettled = batchReviews.every((d) =>
      d.id === reviewDispatch.id ? true : !ACTIVE_DISPATCH_STATUSES.has(d.status),
    );
    const allExplicitlyPassed = !hasInFlightPeerStart && allSettled && batchReviews.every(isEffectivePass);
    const mergedFindings = batchReviews.flatMap((d) =>
      d.id === reviewDispatch.id && opts?.overrideFindings
        ? opts.overrideFindings
        : (d.reviewFindings ?? []),
    );
    if (opts?.failedReason && !mergedFindings.some((f) => f.title === opts.failedReason)) {
      mergedFindings.push({
        severity: 'P1',
        location: '(review-lifecycle)',
        title: opts.failedReason,
        evidence: `Run reviewer ${reviewDispatch.id} terminated without an explicit PASS verdict.`,
      });
    }

    if (anyRejected) {
      const escalated = batchRound >= MAX_ADVERSARIAL_REVIEW_ROUNDS;
      this.host.store.updateRunReviewState(targetRun.id, {
        runReviewStatus: escalated ? 'escalated' : 'rejected',
        runReviewFindings: mergedFindings,
      });
      return { escalated, reviewRound: batchRound, staleBatch: false };
    }

    if (allExplicitlyPassed) {
      this.host.store.updateRunReviewState(targetRun.id, {
        runReviewStatus: 'passed',
        runReviewFindings: mergedFindings,
      });
      return { escalated: false, reviewRound: batchRound, staleBatch: false };
    }

    this.host.store.updateRunReviewState(targetRun.id, {
      runReviewStatus: 'pending',
      runReviewFindings: mergedFindings,
    });
    return { escalated: false, reviewRound: batchRound, staleBatch: false };
  }

  async withInFlightReviewStart<T>(
    targetKey: `dispatch:${string}` | `run:${string}`,
    fn: () => Promise<T>,
  ): Promise<T> {
    this.inFlightReviewStarts.set(targetKey, (this.inFlightReviewStarts.get(targetKey) ?? 0) + 1);
    try {
      return await fn();
    } finally {
      const nextCount = (this.inFlightReviewStarts.get(targetKey) ?? 1) - 1;
      if (nextCount <= 0) {
        this.inFlightReviewStarts.delete(targetKey);
      } else {
        this.inFlightReviewStarts.set(targetKey, nextCount);
      }
      if (nextCount <= 0) {
        // Reconcile whenever the last in-flight start exits (whether it failed OR a fast reviewer
        // already submitted a PASS verdict before workerStart returned), so batches never strand in pending.
        if (targetKey.startsWith('dispatch:')) {
          const targetId = targetKey.slice('dispatch:'.length);
          const target = this.host.store.getDispatchContext(targetId);
          if (target?.reviewBatchId && target.reviewStatus === 'pending') {
            const peers = this.host.store.listReviewDispatchesForBatch(targetId, target.reviewBatchId);
            const settledPeer = peers.find((d) => !ACTIVE_DISPATCH_STATUSES.has(d.status));
            if (settledPeer) {
              this.reconcileTargetReviewBatch(settledPeer.id);
              const updated = this.host.store.getDispatchContext(targetId);
              if (updated && updated.reviewStatus !== target.reviewStatus) {
                this.host.emitChanged('worker:review-reconciled', updated.runId);
              }
            }
          }
        } else if (targetKey.startsWith('run:')) {
          const runId = targetKey.slice('run:'.length);
          const run = this.host.store.getRun(runId);
          if (run?.runReviewBatchId && run.runReviewStatus === 'pending') {
            const peers = this.host.store.listReviewDispatchesForRunBatch(runId, run.runReviewBatchId);
            const settledPeer = peers.find((d) => !ACTIVE_DISPATCH_STATUSES.has(d.status));
            if (settledPeer) {
              this.reconcileRunReviewBatch(settledPeer.id);
              const updated = this.host.store.getRun(runId);
              if (updated && updated.runReviewStatus !== run.runReviewStatus) {
                this.host.emitChanged('run:review-reconciled', updated.id);
              }
            }
          }
        }
      }
    }
  }

  reconcileAnyReviewBatch(
    reviewDispatchId: string,
    opts?: {
      overrideFindings?: OrchestrationReviewFinding[];
      overrideVerdict?: OrchestrationReviewVerdict;
      failedReason?: string;
    },
  ): { escalated: boolean; reviewRound: number; staleBatch: boolean } {
    const d = this.host.store.getDispatchContext(reviewDispatchId);
    if (d?.reviewOfRunId) {
      return this.reconcileRunReviewBatch(reviewDispatchId, opts);
    }
    return this.reconcileTargetReviewBatch(reviewDispatchId, opts);
  }

  /**
   * Rejects the batch of every review dispatch that settled without a verdict. Reviewers can be
   * failed straight through the store (pane exit, coordinator loop, restart recovery), so this is
   * the one place that guarantees their target never stays `pending`.
   */
  settleUnreportedReviewDispatches(): void {
    for (const dispatch of this.host.store.listDispatches()) {
      if (!dispatch.reviewOfDispatchId && !dispatch.reviewOfRunId) continue;
      if (ACTIVE_DISPATCH_STATUSES.has(dispatch.status)) continue;
      if (dispatch.reviewStatus && dispatch.reviewStatus !== 'none' && dispatch.reviewStatus !== 'pending') {
        continue;
      }
      this.host.store.updateDispatchReviewState(dispatch.id, { reviewStatus: 'rejected' });
      this.host.failTaskIfReady(dispatch.taskId);
      this.reconcileAnyReviewBatch(dispatch.id, {
        failedReason: `Reviewer exited or timed out (${dispatch.lastFailureReason || dispatch.status})`,
      });
      this.host.emitChanged('worker:review-reconciled', dispatch.runId);
    }
  }

  setRunAutoReview(input: { runId: string; enabled: boolean }): { run: OrchestrationRunRecord } {
    const cleanId = input.runId.trim();
    if (!cleanId) {
      throw new OrchestrationError('invalid_argument', 'runId is required.');
    }
    const updated = this.host.store.setRunAutoReviewAuthorized(cleanId, Boolean(input.enabled));
    if (!updated) {
      throw new OrchestrationError('run_not_found', `Run not found: ${cleanId}`);
    }
    this.host.emitChanged('run:auto-review-updated', updated.id);
    return { run: updated };
  }
}
