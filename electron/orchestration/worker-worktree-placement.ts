import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import {
  addGitWorktree,
  getGitStatus,
  inspectGitRepo,
  listGitWorktrees,
  removeGitWorktree,
} from '../git/git-service.js';
import { OrchestrationError } from './orchestration-types.js';

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
  ownsWorktree: boolean;
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

export async function prepareWorkerWorktreePlacement(
  input: WorkerWorktreePlacementInput
): Promise<WorkerWorktreePlacementResult> {
  if (input.reusingTerminalCwd) {
    return {
      cwd: input.reusingTerminalCwd,
      worktreePath: input.reusingTerminalCwd,
      branch: null,
      ownsWorktree: false,
      repoRootPath: null,
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
    return {
      cwd: input.baseCwd,
      worktreePath: input.baseCwd,
      branch: inspected.ok && inspected.isGitRepo ? inspected.branch : null,
      ownsWorktree: false,
      repoRootPath: inspected.ok && inspected.isGitRepo ? inspected.rootPath : null,
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
      ownsWorktree: false,
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

  const desiredBranch = input.branch?.trim() || `orca/worker/${slug}`;
  const startPoint = input.baseBranch?.trim() ||
    (rawWt === 'new-top-level' ? undefined : inspected.head);

  let created = await addGitWorktree({
    cwd: mainWorktreeRoot,
    worktreePath: targetWorktreePath,
    newBranch: desiredBranch,
    startPoint,
  });

  if (!created.ok && input.branch?.trim() && /already exists/i.test(created.error)) {
    created = await addGitWorktree({
      cwd: mainWorktreeRoot,
      worktreePath: targetWorktreePath,
      branch: desiredBranch,
    });
  }

  if (!created.ok) {
    throw new OrchestrationError('worktree_failed', created.error);
  }

  return {
    cwd: created.path,
    worktreePath: created.path,
    branch: desiredBranch,
    ownsWorktree: true,
    repoRootPath: mainWorktreeRoot,
  };
}

export function inferSiblingMainRepoPath(worktreePath: string): string | null {
  const resolvedWt = resolve(worktreePath);
  const parentDir = dirname(resolvedWt);
  const parentBase = basename(parentDir);
  for (const suffix of ['.aha-worktrees', '.orca-worktrees']) {
    if (parentBase.toLowerCase().endsWith(suffix) && parentBase.length > suffix.length) {
      return join(dirname(parentDir), parentBase.slice(0, -suffix.length));
    }
  }
  return null;
}

export async function removeOwnedWorkerWorktree(opts: {
  worktreePath: string;
  repoRootPath?: string | null;
  force?: boolean;
}): Promise<{ removed: boolean; path: string }> {
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
    return { removed: false, path: opts.worktreePath };
  }
  const normTarget =
    process.platform === 'win32'
      ? resolve(opts.worktreePath).toLowerCase()
      : resolve(opts.worktreePath);
  const matched = listed.worktrees.find((wt) => {
    const normWt = process.platform === 'win32' ? resolve(wt.path).toLowerCase() : resolve(wt.path);
    return normWt === normTarget;
  });
  if (!matched) {
    return { removed: false, path: opts.worktreePath };
  }
  if (!opts.force && matched.locked) {
    throw new OrchestrationError(
      'operation_rejected',
      `Worker worktree ${opts.worktreePath} is locked${matched.lockReason ? ` (${matched.lockReason})` : ''}. Unlock it with \`git worktree unlock\` or pass --force.`,
      { worktreePath: opts.worktreePath, locked: true }
    );
  }
  const mainRoot = listed.worktrees.find((wt) => wt.isMainWorktree)?.path;
  if (!mainRoot) {
    return { removed: false, path: opts.worktreePath };
  }

  const removed = await removeGitWorktree({
    cwd: mainRoot,
    worktreePath: opts.worktreePath,
    force: Boolean(opts.force),
  });
  if (!removed.ok) {
    throw new OrchestrationError('worktree_failed', removed.error);
  }
  return { removed: true, path: removed.path };
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
