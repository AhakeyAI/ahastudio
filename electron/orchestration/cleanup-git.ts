import { basename, dirname, join } from 'node:path';
import { runGitCommand, validateGitRefName } from '../git/git-exec.js';
import { getGitStatus, listGitWorktrees, removeGitWorktree } from '../git/git-service.js';
import { assertCleanupKind, CleanupAttention, CleanupBranchRetained, CleanupDeferred, CleanupLocked, pathKey, type CleanupIntent } from './cleanup-outbox.js';
import { ACTIVE_DISPATCH_STATUSES } from './orchestration-lifecycle-graph.js';
import type { OrchestrationStore } from './orchestration-store.js';
import { resolveRunIntegrationWorktreePath } from './worker-git-integration.js';
import { deleteOwnedWorkerBranch, deleteRunIntegrationBranch, formatRunIntegrationBranchName } from './worker-worktree-placement.js';

export function guardCleanup(store: OrchestrationStore, e: CleanupIntent, live: (id: string) => boolean) {
  const path = pathKey(e.worktreePath);
  if (store.listResumeClaims().some(c => pathKey(c.cwd) === path || c.dispatchId === e.dispatchId)) throw new CleanupDeferred('Workspace has an unresolved resume claim');
  if (e.kind === 'run_branch.cleanup') {
    const run = store.getRun(e.runId);
    if (!run || !run.integrationRepoRootPath || pathKey(run.integrationRepoRootPath) !== pathKey(e.repoRootPath) || (run.integrationWorktreePath && pathKey(run.integrationWorktreePath) !== path) || (run.integrationBranch && run.integrationBranch !== e.worktreeBranch)) throw new CleanupAttention('Run no longer owns cleanup repository');
    if (e.worktreeBranch !== formatRunIntegrationBranchName(e.runId) || path !== pathKey(resolveRunIntegrationWorktreePath(e.repoRootPath, e.runId))) throw new CleanupAttention('Run cleanup identity mismatch');
    return;
  }
  const d = e.dispatchId && store.getDispatchContext(e.dispatchId);
  if (!d || d.runId !== e.runId || !d.worktreePath || pathKey(d.worktreePath) !== path || (d.repoRootPath && pathKey(d.repoRootPath) !== pathKey(e.repoRootPath)) || (!d.ownsWorktree && !d.releasedAt)) throw new CleanupAttention('Worker cleanup identity mismatch');
  if (store.listDispatches().some(other => other.id !== d.id && !other.releasedAt && other.ownsWorktree && other.worktreePath && pathKey(other.worktreePath) === path && !store.listDispatchAncestorIds(d.id).includes(other.id))) throw new CleanupDeferred('Workspace owned by another dispatch');
  const current = store.resolveDispatchLineage(d.id) ?? d;
  if (current.id !== d.id || current.residentAfterIntegration || ACTIVE_DISPATCH_STATUSES.has(current.status) || live(current.assigneePaneId ?? current.assigneeHandle)) throw new CleanupDeferred('Workspace may still be in use');
  if (e.kind === 'review_worktree.cleanup') {
    if (!d.isDetachedReviewWorktree || e.worktreeBranch || e.deleteBranch || pathKey(dirname(path)) !== pathKey(join(dirname(e.repoRootPath), `${basename(e.repoRootPath)}.aha-worktrees`)) || !/^_review-.+-[0-9a-f]{8}$/i.test(basename(path))) throw new CleanupAttention('Not an owned review worktree');
  } else if (d.isDetachedReviewWorktree || e.worktreeBranch !== (d.branch ?? null) || (e.deleteBranch && !d.ownsBranch)) throw new CleanupAttention('Worker branch ownership mismatch');
}

/** Distinguish an absent ref (exit 1) from an unreadable repository. */
export async function cleanupBranchOid(repo: string, branch: string) {
  if (!validateGitRefName(branch)) throw new CleanupAttention('Invalid cleanup branch name');
  const ref = await runGitCommand(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: repo, readOnly: true });
  if (ref.exitCode === 1) return undefined;
  if (ref.exitCode !== 0 || !/^[a-f0-9]{40}$/.test(ref.stdout.trim())) throw new Error('Cannot inspect cleanup branch');
  return ref.stdout.trim();
}

export async function executeCleanup(e: CleanupIntent, force: boolean, guard: () => void) {
  assertCleanupKind(e.kind);
  const { repoRootPath: cwd, worktreePath, worktreeBranch: branch } = e;
  const listed = await listGitWorktrees(cwd);
  if (!listed.ok || !listed.isGitRepo) throw new Error('Cannot list cleanup repository worktrees');
  const wt = listed.worktrees.find(w => pathKey(w.path) === pathKey(worktreePath));
  if (branch && (e.deleteBranch || e.expectedBranchOid)) {
    if (e.deleteBranch && !branch.startsWith(e.kind === 'run_branch.cleanup' ? 'aha/run/' : 'aha/worker/')) throw new CleanupAttention('Not an owned cleanup branch');
    const oid = await cleanupBranchOid(cwd, branch);
    if (oid && oid !== e.expectedBranchOid) throw new CleanupAttention('Cleanup branch OID changed; refusing removal');
  }
  if (wt) {
    if (wt.isMainWorktree || wt.isBare || wt.branch !== branch || (!branch && !wt.detached) || (e.expectedReviewHead && wt.head !== e.expectedReviewHead && !force)) throw new CleanupAttention('Worktree identity changed; refusing removal');
    if (!force) {
      if (wt.locked) throw new CleanupLocked('Worktree locked; refusing removal');
      const status = await getGitStatus(worktreePath);
      if (!status.ok || !status.isGitRepo) throw new Error('Cannot verify worktree cleanliness');
      if (status.entries.length) throw new CleanupAttention('Worktree has uncommitted changes; refusing removal');
    }
    guard();
    const removed = await removeGitWorktree({ cwd, worktreePath, force, beforeRemove: current => {
      guard();
      if (current.branch !== wt.branch || current.head !== wt.head || current.locked !== wt.locked) throw new CleanupAttention('Worktree changed during cleanup');
    } });
    if (!removed.ok) throw new Error(removed.error);
  }
  if (!branch || !e.deleteBranch) return { removed: true, removedBranch: false };
  try {
    if (!await cleanupBranchOid(cwd, branch)) return { removed: true, removedBranch: false };
    if (!e.expectedBranchOid) throw new CleanupAttention('Missing branch CAS evidence');
    if (!e.allowUnmerged) {
      const ancestor = await runGitCommand(['merge-base', '--is-ancestor', e.expectedBranchOid, 'HEAD'], { cwd, readOnly: true });
      if (ancestor.exitCode !== 0) throw new CleanupAttention('Branch not safely merged');
    }
    guard();
    const remove = e.kind === 'run_branch.cleanup' ? deleteRunIntegrationBranch : deleteOwnedWorkerBranch;
    const removedBranch = await remove(cwd, branch, e.expectedBranchOid, { allowSquashCasDelete: true, beforeDelete: guard });
    if (!removedBranch && await cleanupBranchOid(cwd, branch)) throw new Error('Git could not safely CAS-delete branch');
    return { removed: true, removedBranch };
  } catch (error) {
    if (error instanceof CleanupDeferred) throw error;
    throw new CleanupBranchRetained(error);
  }
}
