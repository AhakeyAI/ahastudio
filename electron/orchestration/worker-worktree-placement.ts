import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  addGitWorktree,
  getGitStatus,
  inspectGitRepo,
  listGitWorktrees,
  removeGitWorktree,
} from '../git/git-service.js';
import { runGitCommand, validateGitRefName } from '../git/git-exec.js';
import { OrchestrationError } from './orchestration-types.js';

export const WORKER_BRANCH_PREFIX = 'aha/worker/';
export const RUN_INTEGRATION_BRANCH_PREFIX = 'aha/run/';

export function formatRunIntegrationBranchName(runId: string): string {
  const cleaned = runId
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  const slug = cleaned || 'run';
  const candidate = `${RUN_INTEGRATION_BRANCH_PREFIX}${slug}`;
  const valid = validateGitRefName(candidate);
  if (!valid || !valid.startsWith(RUN_INTEGRATION_BRANCH_PREFIX)) {
    throw new OrchestrationError(
      'invalid_argument',
      `Could not derive a valid Git branch name for run "${runId}".`,
    );
  }
  return valid;
}

export interface WorkerWorktreePlacementInput {
  baseCwd: string;
  taskId: string;
  taskTitle?: string;
  name?: string;
  worktree?: string | boolean;
  noWorktree?: boolean;
  branch?: string;
  baseBranch?: string;
  reusingTerminalCwd?: string;
}

export interface WorkerWorktreePlacementResult {
  cwd: string;
  worktreePath: string | null;
  branch: string | null;
  baseCommit: string | null;
  ownsWorktree: boolean;
  ownsBranch: boolean;
  repoRootPath: string | null;
}

function slugifySegment(raw: string, fallback: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 40);
  return cleaned || fallback;
}

async function resolveFullHeadCommit(cwd: string, fallback?: string | null): Promise<string | null> {
  const res = await runGitCommand(['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd,
    readOnly: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (res && res.exitCode === 0 && res.stdout.trim()) {
    return res.stdout.trim();
  }
  return fallback?.trim() || null;
}

export async function prepareWorkerWorktreePlacement(
  input: WorkerWorktreePlacementInput
): Promise<WorkerWorktreePlacementResult> {
  if (input.reusingTerminalCwd) {
    const inspected = await inspectGitRepo(input.reusingTerminalCwd).catch(() => null);
    const repo = inspected && inspected.ok && inspected.isGitRepo ? inspected : null;
    return {
      cwd: input.reusingTerminalCwd,
      worktreePath: input.reusingTerminalCwd,
      branch: repo ? repo.branch : null,
      baseCommit: repo ? await resolveFullHeadCommit(input.reusingTerminalCwd, repo.head) : null,
      ownsWorktree: false,
      ownsBranch: false,
      repoRootPath: repo ? repo.rootPath : null,
    };
  }

  const rawWt = typeof input.worktree === 'string' ? input.worktree.trim() : input.worktree;
  const skipWorktree =
    input.noWorktree === true ||
    rawWt === false ||
    rawWt === 'current' ||
    rawWt === 'none';

  if (skipWorktree) {
    if (input.branch?.trim()) {
      throw new OrchestrationError(
        'invalid_argument',
        '--branch cannot be combined with --no-worktree / --worktree current.'
      );
    }
    const inspected = await inspectGitRepo(input.baseCwd);
    const repo = inspected.ok && inspected.isGitRepo ? inspected : null;
    return {
      cwd: input.baseCwd,
      worktreePath: input.baseCwd,
      branch: repo ? repo.branch : null,
      baseCommit: repo ? await resolveFullHeadCommit(input.baseCwd, repo.head) : null,
      ownsWorktree: false,
      ownsBranch: false,
      repoRootPath: repo ? repo.rootPath : null,
    };
  }

  const explicitWorktreeRequested =
    rawWt === true ||
    rawWt === 'new-child' ||
    rawWt === 'new-top-level' ||
    (typeof rawWt === 'string' && rawWt.length > 0) ||
    Boolean(input.branch?.trim()) ||
    Boolean(input.baseBranch?.trim());

  const inspected = await inspectGitRepo(input.baseCwd);
  if (!inspected.ok || !inspected.isGitRepo || !inspected.rootPath || !inspected.head) {
    if (explicitWorktreeRequested) {
      const detail = !inspected.ok
        ? inspected.error
        : !inspected.isGitRepo
          ? 'Current directory is not a Git repository.'
          : 'Git repository has no commits yet (HEAD does not resolve).';
      throw new OrchestrationError(
        'worktree_failed',
        `${detail} Pass --no-worktree to run the worker directly in ${input.baseCwd}.`
      );
    }
    return {
      cwd: input.baseCwd,
      worktreePath: input.baseCwd,
      branch: null,
      baseCommit: null,
      ownsWorktree: false,
      ownsBranch: false,
      repoRootPath: null,
    };
  }

  const listed = await listGitWorktrees(inspected.rootPath);
  const mainWorktreeRoot =
    (listed.ok ? listed.worktrees.find((wt) => wt.isMainWorktree)?.path : null) ??
    inspected.rootPath;

  const uniqueSuffix = `${Date.now().toString(36).slice(-4)}-${Math.random().toString(36).slice(2, 6)}`;
  const baseLabel = input.name?.trim() || input.branch?.trim() || input.taskTitle || input.taskId;
  const slug = `${slugifySegment(baseLabel, slugifySegment(input.taskId, 'worker'))}-${uniqueSuffix}`;

  const isCustomPath =
    typeof rawWt === 'string' &&
    rawWt.length > 0 &&
    rawWt !== 'new-child' &&
    rawWt !== 'new-top-level' &&
    rawWt !== 'true';

  const targetWorktreePath = isCustomPath
    ? isAbsolute(rawWt)
      ? resolve(rawWt)
      : resolve(mainWorktreeRoot, rawWt)
    : join(dirname(mainWorktreeRoot), `${basename(mainWorktreeRoot)}.aha-worktrees`, slug);

  const autoBranch = !input.branch?.trim();
  const desiredBranch = input.branch?.trim() || `${WORKER_BRANCH_PREFIX}${slug}`;
  const startPoint = input.baseBranch?.trim() ||
    (rawWt === 'new-top-level' ? undefined : inspected.head);

  let created = await addGitWorktree({
    cwd: mainWorktreeRoot,
    worktreePath: targetWorktreePath,
    newBranch: desiredBranch,
    startPoint,
  });

  let createdNewBranch = created.ok;
  if (!created.ok && input.branch?.trim() && /already exists/i.test(created.error)) {
    created = await addGitWorktree({
      cwd: mainWorktreeRoot,
      worktreePath: targetWorktreePath,
      branch: desiredBranch,
    });
    createdNewBranch = false;
  }

  if (!created.ok) {
    throw new OrchestrationError('worktree_failed', created.error);
  }

  const resolvedBaseCommit = await resolveFullHeadCommit(created.path, inspected.head);

  return {
    cwd: created.path,
    worktreePath: created.path,
    branch: desiredBranch,
    baseCommit: resolvedBaseCommit,
    ownsWorktree: true,
    ownsBranch: autoBranch && createdNewBranch,
    repoRootPath: mainWorktreeRoot,
  };
}

export function inferSiblingMainRepoPath(worktreePath: string): string | null {
  const resolvedWt = resolve(worktreePath);
  const parentDir = dirname(resolvedWt);
  const parentBase = basename(parentDir);
  const suffix = '.aha-worktrees';
  if (parentBase.toLowerCase().endsWith(suffix) && parentBase.length > suffix.length) {
    return join(dirname(parentDir), parentBase.slice(0, -suffix.length));
  }
  return null;
}

export async function removeOwnedWorkerWorktree(opts: {
  worktreePath: string;
  repoRootPath?: string | null;
  force?: boolean;
  deleteBranch?: string | null;
  expectedBranchOid?: string | null;
  allowSquashCasDelete?: boolean;
}): Promise<{ removed: boolean; removedBranch: boolean; path: string }> {
  if (!opts.force) await assertWorkerWorktreeClean(opts.worktreePath);

  let listed = await listGitWorktrees(opts.worktreePath);
  if ((!listed.ok || !listed.isGitRepo) && opts.repoRootPath) {
    listed = await listGitWorktrees(opts.repoRootPath);
  }
  if (!listed.ok || !listed.isGitRepo) {
    const inferredMain = inferSiblingMainRepoPath(opts.worktreePath);
    if (inferredMain) {
      listed = await listGitWorktrees(inferredMain);
    }
  }
  if (!listed.ok || !listed.isGitRepo) {
    return { removed: false, removedBranch: false, path: opts.worktreePath };
  }
  const normTarget =
    process.platform === 'win32'
      ? resolve(opts.worktreePath).toLowerCase()
      : resolve(opts.worktreePath);
  const matched = listed.worktrees.find((wt) => {
    const normWt = process.platform === 'win32' ? resolve(wt.path).toLowerCase() : resolve(wt.path);
    return normWt === normTarget;
  });
  const mainRoot = listed.worktrees.find((wt) => wt.isMainWorktree)?.path;
  if (!matched) {
    const removedBranch = mainRoot
      ? await deleteOwnedWorkerBranch(mainRoot, opts.deleteBranch, opts.expectedBranchOid, {
          allowSquashCasDelete: opts.allowSquashCasDelete,
        })
      : false;
    return { removed: false, removedBranch, path: opts.worktreePath };
  }
  if (!opts.force && matched.locked) {
    throw new OrchestrationError(
      'operation_rejected',
      `Worker worktree ${opts.worktreePath} is locked${matched.lockReason ? ` (${matched.lockReason})` : ''}. Unlock it with \`git worktree unlock\` or pass --force.`,
      { worktreePath: opts.worktreePath, locked: true }
    );
  }
  if (!mainRoot) {
    return { removed: false, removedBranch: false, path: opts.worktreePath };
  }

  const removed = await removeGitWorktree({
    cwd: mainRoot,
    worktreePath: opts.worktreePath,
    force: Boolean(opts.force),
  });
  if (!removed.ok) {
    throw new OrchestrationError('worktree_failed', removed.error);
  }
  const removedBranch = await deleteOwnedWorkerBranch(mainRoot, opts.deleteBranch, opts.expectedBranchOid, {
    allowSquashCasDelete: opts.allowSquashCasDelete,
  });
  return { removed: true, removedBranch, path: removed.path };
}

async function deletePrefixedOwnedBranch(
  repoRootPath: string,
  allowedPrefix: string,
  branchName?: string | null,
  expectedOid?: string | null,
  opts?: { allowSquashCasDelete?: boolean },
): Promise<boolean> {
  const trimmed = branchName?.trim();
  if (!trimmed || !trimmed.startsWith(allowedPrefix)) return false;
  const valid = validateGitRefName(trimmed);
  if (!valid || !valid.startsWith(allowedPrefix)) return false;
  const cleanExpectedOid = expectedOid?.trim();

  // Never delete a branch still checked out by any active worktree.
  const listed = await listGitWorktrees(repoRootPath).catch(() => null);
  if (!listed || !listed.ok || !listed.isGitRepo) return false;
  const checkedOut = listed.worktrees.some((wt) => wt.branch === valid);
  if (checkedOut) return false;

  if (cleanExpectedOid) {
    if (!/^[0-9a-f]{40}$/i.test(cleanExpectedOid)) return false;
    if (opts?.allowSquashCasDelete) {
      // Atomic CAS delete for verified squash-integrated owned branches:
      // refuses deletion if the branch moved concurrently after integration.
      const cas = await runGitCommand(['update-ref', '-d', `refs/heads/${valid}`, cleanExpectedOid], {
        cwd: repoRootPath,
        timeoutMs: 15_000,
      });
      return cas.exitCode === 0;
    }
    const current = await runGitCommand(['rev-parse', '--verify', 'refs/heads/' + valid], {
      cwd: repoRootPath,
      readOnly: true,
    });
    if (current.exitCode !== 0 || current.stdout.trim() !== cleanExpectedOid) return false;
  }
  const res = await runGitCommand(['branch', cleanExpectedOid ? '-d' : '-D', '--', valid], {
    cwd: repoRootPath,
    timeoutMs: 15_000,
  });
  return res.exitCode === 0;
}

export async function deleteOwnedWorkerBranch(
  repoRootPath: string,
  branchName?: string | null,
  expectedOid?: string | null,
  opts?: { allowSquashCasDelete?: boolean },
): Promise<boolean> {
  return deletePrefixedOwnedBranch(
    repoRootPath,
    WORKER_BRANCH_PREFIX,
    branchName,
    expectedOid,
    opts,
  );
}

export async function deleteRunIntegrationBranch(
  repoRootPath: string,
  branchName?: string | null,
  expectedOid?: string | null,
  opts?: { allowSquashCasDelete?: boolean },
): Promise<boolean> {
  return deletePrefixedOwnedBranch(
    repoRootPath,
    RUN_INTEGRATION_BRANCH_PREFIX,
    branchName,
    expectedOid,
    opts,
  );
}

export async function assertWorkerWorktreeClean(worktreePath: string): Promise<void> {
  const status = await getGitStatus(worktreePath);
  if (status.ok && status.isGitRepo && status.entries.length > 0) {
    throw new OrchestrationError(
      'operation_rejected',
      `Worker worktree ${worktreePath} has ${status.entries.length} uncommitted change(s). Preserve the changes or pass --force.`,
      { worktreePath, dirtyEntries: status.entries.length }
    );
  }
}
