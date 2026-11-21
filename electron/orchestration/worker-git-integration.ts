import { randomUUID } from 'node:crypto';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { runGitCommand, validateGitRefName, validateRepoRelativePath } from '../git/git-exec.js';
import {
  addGitWorktree,
  getGitStatus,
  inspectGitRepo,
  listGitWorktrees,
  removeGitWorktree,
} from '../git/git-service.js';
import { OrchestrationError } from './orchestration-types.js';
import { clipUtf8Bytes } from './worker-brief-context.js';
import { deleteOwnedWorkerBranch, inferSiblingMainRepoPath } from './worker-worktree-placement.js';

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_MAX_DIFF_BYTES = 32 * 1024;
const MAX_DIFF_CAP_BYTES = 128 * 1024;
const HIGH_RISK_PATH_RE =
  /(^|\/)(auth|security|permission|approval|ipc|router|store|state|orchestration|daemon|preload|main\.ts|package\.json|tsconfig|electron-builder)/i;

const repoIntegrationLocks = new Map<string, Promise<void>>();

export type RecommendedReviewTier = 'L0' | 'L1' | 'L2';
export type WorkerIntegrateMode = 'check' | 'squash' | 'merge';
export type WorkerIntegrationCheckStatus = 'clean' | 'conflict' | 'unverifiable';

export interface WorkerCommitSummary {
  sha: string;
  subject: string;
}

export interface WorkerDiffInspection {
  isGitRepo: boolean;
  worktreePath: string;
  branch: string | null;
  baseCommit: string | null;
  headCommit: string | null;
  snapshotOid: string | null;
  stagedDivergentFiles: string[];
  commitsAhead: number;
  commits: WorkerCommitSummary[];
  uncommittedFiles: string[];
  changedFiles: string[];
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
  diffError?: string;
  recommendedReviewTier: RecommendedReviewTier;
  tierReason: string;
}

export interface WorkerIntegrationCheckResult {
  checkStatus: WorkerIntegrationCheckStatus;
  clean: boolean;
  noChanges: boolean;
  targetRepoPath: string;
  targetBranch: string | null;
  targetRef: string | null;
  targetHead: string | null;
  snapshotOid: string;
  mergedTreeOid?: string;
  targetDirty: boolean;
  targetDirtyFiles: string[];
  conflictFiles: string[];
  ignoredCollisionFiles: string[];
  behindCommits: number;
  aheadCommits: number;
  message: string;
}

export interface WorkerIntegrationResult {
  mode: WorkerIntegrateMode;
  checkStatus: WorkerIntegrationCheckStatus;
  integrated: boolean;
  noChanges: boolean;
  clean: boolean;
  targetRepoPath: string;
  targetBranch: string | null;
  targetRef: string | null;
  snapshotOid: string;
  integratedCommit: string | null;
  conflictFiles: string[];
  ignoredCollisionFiles: string[];
  changedFiles: string[];
  message: string;
  cleanupWarning?: string;
}

export interface ReviewWorktreeMutationResult {
  mutated: boolean;
  verificationFailed: boolean;
  dirtyFiles: string[];
  reason?: string;
}

function normalizeSha(raw?: string | null): string | null {
  const trimmed = raw?.trim() ?? '';
  return GIT_SHA_RE.test(trimmed) ? trimmed : null;
}

function parseLines(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function parseNullDelimitedPaths(raw: string): string[] {
  return raw
    .split('\0')
    .map((entry) => entry.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
    .filter(Boolean);
}

function normalizePathKey(pathStr: string): string {
  const normalized = pathStr.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathsCollide(a: string, b: string): boolean {
  const ka = normalizePathKey(a);
  const kb = normalizePathKey(b);
  if (!ka || !kb) return false;
  return ka === kb || ka.startsWith(`${kb}/`) || kb.startsWith(`${ka}/`);
}

async function resolveFullHeadCommit(cwd: string): Promise<string | null> {
  const res = await runGitCommand(['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd,
    readOnly: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  const sha = res && res.exitCode === 0 ? res.stdout.trim() : '';
  return FULL_GIT_SHA_RE.test(sha) ? sha : null;
}

async function resolveTargetSymbolicRef(cwd: string): Promise<string | null> {
  const res = await runGitCommand(['symbolic-ref', '-q', 'HEAD'], {
    cwd,
    readOnly: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  return res && res.exitCode === 0 && res.stdout.trim() ? res.stdout.trim() : null;
}

export async function resolveBranchRefOid(
  repoRootPath: string,
  branchName?: string | null,
): Promise<string | null> {
  const trimmed = branchName?.trim();
  if (!trimmed) return null;
  const valid = validateGitRefName(trimmed);
  if (!valid) return null;
  const res = await runGitCommand(['rev-parse', '--verify', `refs/heads/${valid}^{commit}`], {
    cwd: repoRootPath,
    readOnly: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  const sha = res && res.exitCode === 0 ? res.stdout.trim() : '';
  return FULL_GIT_SHA_RE.test(sha) ? sha : null;
}

async function resolveCanonicalGitCommonDir(repoPath: string): Promise<string> {
  let rawDir = '';
  const absRes = await runGitCommand(['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: repoPath,
    readOnly: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  if (absRes && absRes.exitCode === 0 && absRes.stdout.trim()) {
    rawDir = absRes.stdout.trim();
  } else {
    const relRes = await runGitCommand(['rev-parse', '--git-common-dir'], {
      cwd: repoPath,
      readOnly: true,
      timeoutMs: 10_000,
    }).catch(() => null);
    if (relRes && relRes.exitCode === 0 && relRes.stdout.trim()) {
      const candidate = relRes.stdout.trim();
      rawDir = isAbsolute(candidate) ? candidate : resolve(repoPath, candidate);
    }
  }
  const resolved = rawDir ? resolve(rawDir) : resolve(repoPath);
  let canonical = resolved;
  try {
    canonical = realpathSync(resolved);
  } catch {
    canonical = resolved;
  }
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function withRepoIntegrationLock<T>(targetRepoPath: string, fn: () => Promise<T>): Promise<T> {
  const key = await resolveCanonicalGitCommonDir(targetRepoPath);
  const previous = repoIntegrationLocks.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveLock) => {
    releaseCurrent = resolveLock;
  });
  const tail = previous.then(() => current);
  repoIntegrationLocks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    releaseCurrent();
    if (repoIntegrationLocks.get(key) === tail) {
      repoIntegrationLocks.delete(key);
    }
  }
}

export async function listIgnoredPaths(repoPath: string): Promise<string[]> {
  const res = await runGitCommand(
    ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'],
    {
      cwd: repoPath,
      readOnly: true,
      timeoutMs: 15_000,
    },
  );
  if (res.exitCode !== 0) {
    throw new Error(res.stderr.trim() || 'git ls-files --ignored failed');
  }
  return parseNullDelimitedPaths(res.stdout);
}

/**
 * Detects paths where staged index content differs from working tree content
 * (e.g. modified-then-staged-then-edited-again, or staged deletion recreated on disk).
 */
export async function detectStagedWorktreeDivergence(worktreePath: string): Promise<string[]> {
  const [stagedRes, unstagedRes, stagedDeletedRes, untrackedRes] = await Promise.all([
    runGitCommand(['diff', '--cached', '--name-only', '-z'], {
      cwd: worktreePath,
      readOnly: true,
      timeoutMs: 15_000,
    }),
    runGitCommand(['diff', '--name-only', '-z'], {
      cwd: worktreePath,
      readOnly: true,
      timeoutMs: 15_000,
    }),
    runGitCommand(['diff', '--cached', '--name-only', '--diff-filter=D', '-z'], {
      cwd: worktreePath,
      readOnly: true,
      timeoutMs: 15_000,
    }),
    runGitCommand(['ls-files', '--others', '--exclude-standard', '-z'], {
      cwd: worktreePath,
      readOnly: true,
      timeoutMs: 15_000,
    }),
  ]);
  if (stagedRes.exitCode !== 0 || unstagedRes.exitCode !== 0) {
    throw new OrchestrationError(
      'worktree_failed',
      'Could not inspect staged vs working-tree state in worker worktree.',
    );
  }
  const staged = parseNullDelimitedPaths(stagedRes.stdout);
  const unstagedSet = new Set(parseNullDelimitedPaths(unstagedRes.stdout).map(normalizePathKey));
  const untrackedSet = new Set(
    (untrackedRes.exitCode === 0 ? parseNullDelimitedPaths(untrackedRes.stdout) : []).map(normalizePathKey),
  );
  const divergent = new Set<string>();
  for (const pathStr of staged) {
    if (unstagedSet.has(normalizePathKey(pathStr))) {
      divergent.add(pathStr);
    }
  }
  if (stagedDeletedRes.exitCode === 0) {
    for (const delPath of parseNullDelimitedPaths(stagedDeletedRes.stdout)) {
      if (untrackedSet.has(normalizePathKey(delPath))) {
        divergent.add(delPath);
      }
    }
  }
  return [...divergent];
}

export function classifyReviewTier(input: {
  changedFiles: readonly string[];
  diffStat: string;
}): { tier: RecommendedReviewTier; reason: string } {
  const files = input.changedFiles;
  if (files.length === 0) {
    return { tier: 'L0', reason: 'no file changes detected' };
  }
  const allDocsOrStyles = files.every((f) => /\.(md|txt|css|scss|less|svg|png|jpg)$/i.test(f));
  if (files.length <= 1 && allDocsOrStyles) {
    return { tier: 'L0', reason: 'single doc/style file change' };
  }
  const summaryMatch = /(\d+)\s+insertion.*?(\d+)\s+deletion|(\d+)\s+insertion|(\d+)\s+deletion/.exec(
    input.diffStat,
  );
  const churn = summaryMatch
    ? (Number(summaryMatch[1] || summaryMatch[3] || 0) + Number(summaryMatch[2] || summaryMatch[4] || 0))
    : 0;
  const touchesHighRisk = files.some((f) => HIGH_RISK_PATH_RE.test(f.replace(/\\/g, '/')));
  if (files.length >= 6 || churn >= 300 || (touchesHighRisk && files.length >= 2)) {
    return {
      tier: 'L2',
      reason: touchesHighRisk
        ? 'multi-file change touching core/security/orchestration paths'
        : `${files.length} files / ~${churn} changed lines`,
    };
  }
  if (files.length === 1 && churn > 0 && churn <= 15 && !touchesHighRisk) {
    return { tier: 'L0', reason: `small single-file edit (${churn} lines)` };
  }
  return { tier: 'L1', reason: `${files.length} changed file(s)` };
}

/**
 * Generates an immutable commit OID capturing HEAD + working tree changes using a temporary
 * GIT_INDEX_FILE, leaving the author's working tree, index, and stash untouched.
 * Refuses ambiguous staged-vs-unstaged divergence by default so staged-only changes are never dropped.
 */
export async function captureWorkerSnapshotOid(
  worktreePath: string,
  opts?: { rejectStagedDivergence?: boolean },
): Promise<{
  headCommit: string | null;
  snapshotOid: string | null;
  dirtyFiles: string[];
  stagedDivergentFiles: string[];
}> {
  const status = await getGitStatus(worktreePath);
  if (!status.ok || !status.isGitRepo || !status.head) {
    return { headCommit: null, snapshotOid: null, dirtyFiles: [], stagedDivergentFiles: [] };
  }
  const headCommit = await resolveFullHeadCommit(worktreePath);
  if (!headCommit) {
    return { headCommit: null, snapshotOid: null, dirtyFiles: [], stagedDivergentFiles: [] };
  }
  const stagedDivergentFiles = await detectStagedWorktreeDivergence(worktreePath);
  if (stagedDivergentFiles.length > 0 && opts?.rejectStagedDivergence !== false) {
    throw new OrchestrationError(
      'operation_rejected',
      `Worker worktree has staged vs working-tree divergence on ${stagedDivergentFiles.length} file(s): ${stagedDivergentFiles.join(', ')}. Commit or reconcile staged changes before snapshotting or integrating.`,
      { stagedDivergentFiles },
    );
  }
  const dirtyFiles = status.entries
    .map((entry) => entry.path)
    .filter((p): p is string => Boolean(p));
  if (dirtyFiles.length === 0) {
    return { headCommit, snapshotOid: headCommit, dirtyFiles: [], stagedDivergentFiles };
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'aha-git-snap-'));
  const tempIndex = join(tempDir, 'index');
  const env = {
    GIT_INDEX_FILE: tempIndex,
    GIT_AUTHOR_NAME: 'AhaStation Snapshot',
    GIT_AUTHOR_EMAIL: 'snapshot@ahastation.local',
    GIT_AUTHOR_DATE: '1970-01-01T00:00:00Z',
    GIT_COMMITTER_NAME: 'AhaStation Snapshot',
    GIT_COMMITTER_EMAIL: 'snapshot@ahastation.local',
    GIT_COMMITTER_DATE: '1970-01-01T00:00:00Z',
  };
  try {
    const readTree = await runGitCommand(['read-tree', 'HEAD'], { cwd: worktreePath, env });
    if (readTree.exitCode !== 0) {
      throw new Error(readTree.stderr.trim() || 'git read-tree HEAD failed');
    }
    const addAll = await runGitCommand(['add', '-A'], { cwd: worktreePath, env });
    if (addAll.exitCode !== 0) {
      throw new Error(addAll.stderr.trim() || 'git add -A failed on temp index');
    }
    const writeTree = await runGitCommand(['write-tree'], { cwd: worktreePath, env });
    if (writeTree.exitCode !== 0 || !writeTree.stdout.trim()) {
      throw new Error(writeTree.stderr.trim() || 'git write-tree failed');
    }
    const treeOid = writeTree.stdout.trim();
    const commitTree = await runGitCommand(
      ['commit-tree', treeOid, '-p', headCommit, '-m', 'AhaStation immutable worker snapshot'],
      { cwd: worktreePath, env },
    );
    if (commitTree.exitCode !== 0 || !commitTree.stdout.trim()) {
      throw new Error(commitTree.stderr.trim() || 'git commit-tree failed');
    }
    return {
      headCommit,
      snapshotOid: commitTree.stdout.trim(),
      dirtyFiles,
      stagedDivergentFiles,
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

export async function resolveEffectiveBaseCommit(
  worktreePath: string,
  recordedBase?: string | null,
): Promise<string | null> {
  const valid = normalizeSha(recordedBase);
  if (valid) {
    const verify = await runGitCommand(['rev-parse', '--verify', `${valid}^{commit}`], {
      cwd: worktreePath,
      readOnly: true,
    });
    if (verify.exitCode === 0 && verify.stdout.trim()) {
      return verify.stdout.trim();
    }
  }
  const parent = await runGitCommand(['rev-parse', '--verify', 'HEAD~1^{commit}'], {
    cwd: worktreePath,
    readOnly: true,
  });
  if (parent.exitCode === 0 && parent.stdout.trim()) {
    return parent.stdout.trim();
  }
  return resolveFullHeadCommit(worktreePath);
}

export async function inspectWorkerDiff(opts: {
  worktreePath: string;
  baseCommit?: string | null;
  files?: readonly string[];
  maxDiffBytes?: number;
}): Promise<WorkerDiffInspection> {
  const inspected = await inspectGitRepo(opts.worktreePath);
  if (!inspected.ok || !inspected.isGitRepo || !inspected.head) {
    return {
      isGitRepo: false,
      worktreePath: opts.worktreePath,
      branch: null,
      baseCommit: null,
      headCommit: null,
      snapshotOid: null,
      stagedDivergentFiles: [],
      commitsAhead: 0,
      commits: [],
      uncommittedFiles: [],
      changedFiles: [],
      diffStat: '',
      diff: '',
      diffTruncated: false,
      recommendedReviewTier: 'L0',
      tierReason: 'non-git workspace',
    };
  }

  const baseCommit = await resolveEffectiveBaseCommit(opts.worktreePath, opts.baseCommit);
  const { headCommit, snapshotOid, dirtyFiles, stagedDivergentFiles } =
    await captureWorkerSnapshotOid(opts.worktreePath, { rejectStagedDivergence: false });
  const rangeBase = baseCommit ?? headCommit;
  const targetOid = snapshotOid ?? headCommit;

  const validFiles: string[] = [];
  for (const f of opts.files ?? []) {
    const validated = validateRepoRelativePath(f, inspected.rootPath ?? opts.worktreePath);
    if (validated) validFiles.push(validated);
  }
  const pathArgs = validFiles.length > 0 ? ['--', ...validFiles] : [];

  const maxDiffBytes = Math.min(
    MAX_DIFF_CAP_BYTES,
    Math.max(1024, Math.floor(opts.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES)),
  );

  let commits: WorkerCommitSummary[] = [];
  if (rangeBase && headCommit && rangeBase !== headCommit) {
    const logRes = await runGitCommand(
      ['log', '--format=%h%x09%s', '--max-count=30', `${rangeBase}..${headCommit}`],
      { cwd: opts.worktreePath, readOnly: true },
    );
    if (logRes.exitCode === 0) {
      commits = parseLines(logRes.stdout).map((line) => {
        const tab = line.indexOf('\t');
        return tab === -1
          ? { sha: line, subject: '' }
          : { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
      });
    }
  }

  let changedFiles: string[] = [];
  let diffStat = '';
  let diff = '';
  let diffTruncated = false;
  let diffError: string | undefined;

  if (rangeBase && targetOid && rangeBase !== targetOid) {
    const [namesRes, statRes, diffRes] = await Promise.all([
      runGitCommand(['diff', '--name-only', rangeBase, targetOid, ...pathArgs], {
        cwd: opts.worktreePath,
        readOnly: true,
      }),
      runGitCommand(['diff', '--stat', rangeBase, targetOid, ...pathArgs], {
        cwd: opts.worktreePath,
        readOnly: true,
      }),
      runGitCommand(['diff', '--no-color', rangeBase, targetOid, ...pathArgs], {
        cwd: opts.worktreePath,
        readOnly: true,
        maxBytes: maxDiffBytes + 4096,
      }),
    ]);
    if (namesRes.exitCode === 0 && !namesRes.truncated) {
      changedFiles = parseLines(namesRes.stdout);
    } else {
      diffError =
        namesRes.stderr.trim() ||
        `git diff --name-only failed (${namesRes.truncated ? 'truncated' : `exit ${namesRes.exitCode ?? 'unknown'}`})`;
    }
    if (statRes.exitCode === 0 && !statRes.truncated) {
      diffStat = statRes.stdout.trim();
    } else if (!diffError) {
      diffError =
        statRes.stderr.trim() ||
        `git diff --stat failed (${statRes.truncated ? 'truncated' : `exit ${statRes.exitCode ?? 'unknown'}`})`;
    }
    if (diffRes.exitCode === 0 || diffRes.truncated) {
      const rawDiff = diffRes.stdout;
      if (diffRes.truncated || Buffer.byteLength(rawDiff, 'utf8') > maxDiffBytes) {
        const clipped = clipUtf8Bytes(rawDiff, maxDiffBytes).trimEnd();
        diff = `${clipped}\n\n[Diff truncated at ${maxDiffBytes} bytes. Pass files:[...] to inspect specific files.]`;
        diffTruncated = true;
      } else {
        diff = rawDiff;
      }
    } else if (!diffError) {
      diffError = diffRes.stderr.trim() || `git diff failed with exit code ${diffRes.exitCode ?? 'unknown'}`;
    }
  }

  const allChanged = [...new Set([...changedFiles, ...(validFiles.length === 0 ? dirtyFiles : [])])];
  const { tier, reason } = classifyReviewTier({ changedFiles: allChanged, diffStat });

  return {
    isGitRepo: true,
    worktreePath: opts.worktreePath,
    branch: inspected.branch,
    baseCommit,
    headCommit,
    snapshotOid,
    stagedDivergentFiles,
    commitsAhead: commits.length,
    commits,
    uncommittedFiles: dirtyFiles,
    changedFiles: allChanged,
    diffStat,
    diff,
    diffTruncated,
    ...(diffError ? { diffError } : {}),
    recommendedReviewTier: tier,
    tierReason: reason,
  };
}

export async function resolveIntegrationMergeBase(
  targetRepoPath: string,
  snapshotOid: string,
): Promise<string | null> {
  const targetHead = await resolveFullHeadCommit(targetRepoPath);
  if (!targetHead || !FULL_GIT_SHA_RE.test(snapshotOid.trim())) return null;
  const res = await runGitCommand(['merge-base', targetHead, snapshotOid.trim()], {
    cwd: targetRepoPath,
    readOnly: true,
    timeoutMs: 15_000,
  }).catch(() => null);
  const base = res && res.exitCode === 0 ? res.stdout.trim() : '';
  return FULL_GIT_SHA_RE.test(base) ? base : null;
}

export async function resolveMainRepoRoot(
  worktreePath: string,
  repoRootPath?: string | null,
): Promise<string | null> {
  for (const candidate of [repoRootPath, worktreePath, inferSiblingMainRepoPath(worktreePath)]) {
    if (!candidate) continue;
    const listed = await listGitWorktrees(candidate).catch(() => null);
    if (listed && listed.ok && listed.isGitRepo) {
      const mainWt = listed.worktrees.find((wt) => wt.isMainWorktree);
      if (mainWt?.path) return mainWt.path;
    }
  }
  return null;
}

async function detectIgnoredFileCollisions(
  targetRepoPath: string,
  targetHead: string,
  snapshotOid: string,
  mergedTreeOid?: string | null,
): Promise<string[]> {
  const ignoredFiles = await listIgnoredPaths(targetRepoPath);
  if (ignoredFiles.length === 0) return [];

  const targetDiffRef = mergedTreeOid || snapshotOid;
  const incomingRes = await runGitCommand(
    ['diff', '--name-only', '--diff-filter=ACMRT', '-z', targetHead, targetDiffRef],
    { cwd: targetRepoPath, readOnly: true, timeoutMs: 15_000 },
  );
  if (incomingRes.exitCode !== 0) {
    throw new OrchestrationError(
      'worktree_failed',
      incomingRes.stderr.trim() || 'Could not compute incoming paths for ignored-file collision check.',
    );
  }
  const incomingPaths = parseNullDelimitedPaths(incomingRes.stdout);
  if (incomingPaths.length === 0) return [];

  const collisions = new Set<string>();
  for (const ignored of ignoredFiles) {
    for (const incoming of incomingPaths) {
      if (pathsCollide(ignored, incoming)) {
        collisions.add(ignored);
        break;
      }
    }
  }
  return [...collisions];
}

async function detectMergeTreeConflicts(
  targetRepoPath: string,
  targetHead: string,
  snapshotOid: string,
): Promise<{
  status: WorkerIntegrationCheckStatus;
  conflictFiles: string[];
  treeOid: string | null;
  reason?: string;
}> {
  // Use the exact same merge-base semantics as real `git merge` (no forced --merge-base override).
  const mergeBaseRes = await runGitCommand(['merge-base', targetHead, snapshotOid], {
    cwd: targetRepoPath,
    readOnly: true,
    timeoutMs: 15_000,
  });
  if (mergeBaseRes.exitCode !== 0 || !mergeBaseRes.stdout.trim()) {
    return {
      status: 'unverifiable',
      conflictFiles: [],
      treeOid: null,
      reason: 'Target HEAD and worker snapshot share no common Git ancestor.',
    };
  }

  const res = await runGitCommand(
    ['merge-tree', '--write-tree', '--name-only', targetHead, snapshotOid],
    { cwd: targetRepoPath, readOnly: true, timeoutMs: 30_000 },
  );
  if (res.exitCode === 0) {
    const firstLine = res.stdout.split(/\r?\n/)[0]?.trim() || null;
    if (!firstLine || !FULL_GIT_SHA_RE.test(firstLine)) {
      return {
        status: 'unverifiable',
        conflictFiles: [],
        treeOid: null,
        reason: 'git merge-tree returned an unexpected tree output.',
      };
    }
    return { status: 'clean', conflictFiles: [], treeOid: firstLine };
  }
  if (/unknown option|usage: git merge-tree/i.test(res.stderr)) {
    return {
      status: 'unverifiable',
      conflictFiles: [],
      treeOid: null,
      reason: 'Installed Git does not support `git merge-tree --write-tree` pre-check.',
    };
  }
  const conflictFiles = new Set<string>();
  const lines = res.stdout.split(/\r?\n/);
  // With --write-tree --name-only, line 0 is tree OID, lines until blank line are conflicted paths.
  if (lines.length > 1 && FULL_GIT_SHA_RE.test(lines[0]?.trim() ?? '')) {
    for (let i = 1; i < lines.length; i += 1) {
      const line = lines[i]!.trim();
      if (!line) break;
      conflictFiles.add(line);
    }
  }
  for (const line of lines) {
    const m = /CONFLICT \([^)]+\):.* in (.+)$/.exec(line);
    if (m?.[1]) conflictFiles.add(m[1].trim());
  }
  if (res.exitCode === 1 && conflictFiles.size > 0) {
    return {
      status: 'conflict',
      conflictFiles: [...conflictFiles],
      treeOid: null,
    };
  }
  return {
    status: 'unverifiable',
    conflictFiles: [],
    treeOid: null,
    reason: res.stderr.trim() || res.stdout.trim() || `git merge-tree exited with code ${res.exitCode ?? 'unknown'}`,
  };
}

export async function checkWorkerIntegration(opts: {
  targetRepoPath: string;
  worktreePath: string;
  baseCommit?: string | null;
  expectedSnapshotOid?: string | null;
  expectedTargetRef?: string | null;
}): Promise<WorkerIntegrationCheckResult> {
  const targetStatus = await getGitStatus(opts.targetRepoPath);
  if (!targetStatus.ok || !targetStatus.isGitRepo || !targetStatus.head) {
    throw new OrchestrationError('worktree_failed', 'Target repository is not a valid Git repository.');
  }
  const [targetHead, targetRef] = await Promise.all([
    resolveFullHeadCommit(opts.targetRepoPath),
    resolveTargetSymbolicRef(opts.targetRepoPath),
  ]);
  if (!targetHead) {
    throw new OrchestrationError('worktree_failed', 'Could not resolve full target repository HEAD commit.');
  }
  if (opts.expectedTargetRef && targetRef !== opts.expectedTargetRef) {
    throw new OrchestrationError(
      'operation_rejected',
      `Target repository branch changed (expected ${opts.expectedTargetRef}, actual ${targetRef ?? 'detached HEAD'}).`,
      { expectedTargetRef: opts.expectedTargetRef, actualTargetRef: targetRef },
    );
  }
  const targetDirtyFiles = targetStatus.entries
    .map((e) => e.path)
    .filter((p): p is string => Boolean(p));

  const snap = await captureWorkerSnapshotOid(opts.worktreePath, { rejectStagedDivergence: true });
  if (!snap.snapshotOid) {
    throw new OrchestrationError('worktree_failed', 'Could not capture worker Git snapshot.');
  }
  if (opts.expectedSnapshotOid && snap.snapshotOid !== opts.expectedSnapshotOid) {
    throw new OrchestrationError(
      'operation_rejected',
      `Worker snapshot changed since review (expected ${opts.expectedSnapshotOid}, actual ${snap.snapshotOid}). Re-review before integrating.`,
      { expectedSnapshotOid: opts.expectedSnapshotOid, actualSnapshotOid: snap.snapshotOid },
    );
  }

  const diffCheck = await runGitCommand(
    ['diff', '--quiet', targetHead, snap.snapshotOid],
    { cwd: opts.targetRepoPath, readOnly: true },
  );
  if (diffCheck.exitCode === 0) {
    return {
      checkStatus: 'clean',
      clean: targetDirtyFiles.length === 0,
      noChanges: true,
      targetRepoPath: opts.targetRepoPath,
      targetBranch: targetStatus.branch,
      targetRef,
      targetHead,
      snapshotOid: snap.snapshotOid,
      targetDirty: targetDirtyFiles.length > 0,
      targetDirtyFiles,
      conflictFiles: [],
      ignoredCollisionFiles: [],
      behindCommits: 0,
      aheadCommits: 0,
      message: 'Worker snapshot has no changes relative to target HEAD.',
    };
  }

  const revCount = await runGitCommand(
    ['rev-list', '--left-right', '--count', `${targetHead}...${snap.snapshotOid}`],
    { cwd: opts.targetRepoPath, readOnly: true },
  );
  let behindCommits = 0;
  let aheadCommits = 0;
  if (revCount.exitCode === 0) {
    const [left, right] = revCount.stdout.trim().split(/\s+/);
    behindCommits = Number.parseInt(left || '0', 10) || 0;
    aheadCommits = Number.parseInt(right || '0', 10) || 0;
  }

  const mt = await detectMergeTreeConflicts(
    opts.targetRepoPath,
    targetHead,
    snap.snapshotOid,
  );

  let ignoredCollisionFiles: string[] = [];
  if (mt.status === 'clean') {
    ignoredCollisionFiles = await detectIgnoredFileCollisions(
      opts.targetRepoPath,
      targetHead,
      snap.snapshotOid,
      mt.treeOid,
    );
  }

  const checkStatus: WorkerIntegrationCheckStatus =
    ignoredCollisionFiles.length > 0 ? 'conflict' : mt.status;
  const clean =
    checkStatus === 'clean' &&
    targetDirtyFiles.length === 0 &&
    ignoredCollisionFiles.length === 0;

  let message = 'Clean integration check passed.';
  if (targetDirtyFiles.length > 0) {
    message = `Target workspace has ${targetDirtyFiles.length} uncommitted file(s); clean or commit target workspace before integrating.`;
  } else if (ignoredCollisionFiles.length > 0) {
    message = `Integration blocked: incoming changes would overwrite ${ignoredCollisionFiles.length} ignored local file(s) in target workspace: ${ignoredCollisionFiles.join(', ')}`;
  } else if (mt.status === 'conflict') {
    message = `Merge conflicts detected in ${mt.conflictFiles.length} file(s): ${mt.conflictFiles.join(', ')}`;
  } else if (mt.status === 'unverifiable') {
    message = `Integration pre-check could not verify merge safety: ${mt.reason || 'unknown merge-tree error'}`;
  }

  return {
    checkStatus,
    clean,
    noChanges: false,
    targetRepoPath: opts.targetRepoPath,
    targetBranch: targetStatus.branch,
    targetRef,
    targetHead,
    snapshotOid: snap.snapshotOid,
    ...(mt.treeOid && mt.status === 'clean' ? { mergedTreeOid: mt.treeOid } : {}),
    targetDirty: targetDirtyFiles.length > 0,
    targetDirtyFiles,
    conflictFiles: mt.conflictFiles,
    ignoredCollisionFiles,
    behindCommits,
    aheadCommits,
    message,
  };
}

function gitFailure(result: { stdout: string; stderr: string }, fallback: string): OrchestrationError {
  return new OrchestrationError('worktree_failed', result.stderr.trim() || result.stdout.trim() || fallback);
}

async function assertTargetUnchanged(check: WorkerIntegrationCheckResult): Promise<void> {
  const [head, ref, status] = await Promise.all([
    resolveFullHeadCommit(check.targetRepoPath),
    resolveTargetSymbolicRef(check.targetRepoPath),
    getGitStatus(check.targetRepoPath),
  ]);
  if (head !== check.targetHead || ref !== check.targetRef ||
      !status.ok || !status.isGitRepo || status.entries.length > 0) {
    throw new OrchestrationError(
      'operation_rejected',
      'Target branch, HEAD, or workspace changed during integration. Inspect the workspace before retrying.',
    );
  }
}

async function prepareIntegrationCommit(
  check: WorkerIntegrationCheckResult,
  mode: 'squash' | 'merge',
  commitMessage: string,
): Promise<{ commit: string; changedFiles: string[]; cleanupWarning?: string }> {
  const root = mkdtempSync(join(tmpdir(), 'aha-integration-'));
  const workspace = join(root, 'worktree');
  let registered = false;
  let prepared: { commit: string; changedFiles: string[]; cleanupWarning?: string } | undefined;
  try {
    const created = await addGitWorktree({
      cwd: check.targetRepoPath,
      worktreePath: workspace,
      detach: true,
      startPoint: check.targetHead!,
    });
    if (!created.ok) throw new OrchestrationError('worktree_failed', created.error);
    registered = true;

    const merge = await runGitCommand(
      mode === 'squash'
        ? ['merge', '--squash', '--no-overwrite-ignore', check.snapshotOid]
        : ['merge', '--no-ff', '--no-edit', '--no-overwrite-ignore', '-m', commitMessage, check.snapshotOid],
      { cwd: workspace, timeoutMs: 60_000 },
    );
    if (merge.exitCode !== 0) throw gitFailure(merge, 'Failed to merge in the integration worktree.');
    if (mode === 'squash') {
      const staged = await runGitCommand(['diff', '--cached', '--quiet'], { cwd: workspace, readOnly: true });
      if (staged.exitCode === 1) {
        const result = await runGitCommand(['commit', '-m', commitMessage], { cwd: workspace, timeoutMs: 30_000 });
        if (result.exitCode !== 0) throw gitFailure(result, 'Failed to commit squashed worker changes.');
      } else if (staged.exitCode !== 0) {
        throw gitFailure(staged, 'Could not verify staged integration changes.');
      }
    }

    const commit = await resolveFullHeadCommit(workspace);
    if (!commit) throw new OrchestrationError('worktree_failed', 'Could not resolve the prepared integration commit.');
    if (commit !== check.targetHead) {
      const firstParent = await runGitCommand(['rev-parse', '--verify', `${commit}^1`], {
        cwd: workspace,
        readOnly: true,
      });
      if (firstParent.exitCode !== 0 || firstParent.stdout.trim() !== check.targetHead) {
        throw new OrchestrationError(
          'worktree_failed',
          'Prepared integration commit is not based on the expected target HEAD. The target was left untouched.',
        );
      }
    }
    const tree = await runGitCommand(['rev-parse', '--verify', commit + '^{tree}'], { cwd: workspace, readOnly: true });
    if (tree.exitCode !== 0 || !FULL_GIT_SHA_RE.test(tree.stdout.trim())) {
      throw new OrchestrationError('worktree_failed', 'Could not resolve the prepared integration tree. The target was left untouched.');
    }
    const preparedTreeOid = tree.stdout.trim();
    if (preparedTreeOid !== check.mergedTreeOid) {
      // Allow legitimate auto-formatting pre-commit hooks, but re-verify no ignored files would be overwritten.
      const hookIgnoredCollisions = await detectIgnoredFileCollisions(
        check.targetRepoPath,
        check.targetHead!,
        check.snapshotOid,
        preparedTreeOid,
      );
      if (hookIgnoredCollisions.length > 0) {
        throw new OrchestrationError(
          'operation_rejected',
          `Integration blocked: pre-commit hook output would overwrite ignored local file(s) in target workspace: ${hookIgnoredCollisions.join(', ')}`,
          { ignoredCollisionFiles: hookIgnoredCollisions },
        );
      }
    }
    const changes = await runGitCommand(['diff', '--name-only', '-z', check.targetHead!, commit], {
      cwd: workspace,
      readOnly: true,
    });
    if (changes.exitCode !== 0 || changes.truncated) {
      throw gitFailure(changes, 'Could not enumerate the prepared integration changes.');
    }
    prepared = { commit, changedFiles: parseNullDelimitedPaths(changes.stdout) };
    return prepared;
  } finally {
    try {
      if (registered) {
        const removed = await removeGitWorktree({ cwd: check.targetRepoPath, worktreePath: workspace, force: true });
        if (!removed.ok) throw new Error(removed.error);
      }
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      const warning = 'Integration worktree could not be cleaned up at ' + workspace + ': ' + String(error);
      if (prepared) prepared.cleanupWarning = warning;
      else console.warn(warning);
    }
  }
}

async function publishIntegrationCommit(
  check: WorkerIntegrationCheckResult,
  commit: string,
): Promise<void> {
  // Hooks ran while preparing the commit. Publication advances the checkout with Git's
  // --ff-only and --no-overwrite-ignore collision checks without running hooks again.
  // Any narrow concurrent modification between assertTargetUnchanged and merge relies on Git path collision checks.
  const noHooks = mkdtempSync(join(tmpdir(), 'aha-no-hooks-'));
  try {
    await assertTargetUnchanged(check);
    const result = await runGitCommand(
      ['-c', 'core.hooksPath=' + noHooks, 'merge', '--ff-only', '--no-overwrite-ignore', commit],
      { cwd: check.targetRepoPath, timeoutMs: 60_000 },
    );
    if (result.exitCode !== 0) throw gitFailure(result, 'Could not publish the prepared integration commit.');
    const [head, ref] = await Promise.all([
      resolveFullHeadCommit(check.targetRepoPath),
      resolveTargetSymbolicRef(check.targetRepoPath),
    ]);
    if (head !== commit || ref !== check.targetRef) {
      throw new OrchestrationError('worktree_failed', 'The target changed during publication. Check its current branch and HEAD.');
    }
  } finally {
    rmSync(noHooks, { recursive: true, force: true });
  }
}

export async function integrateWorkerChanges(opts: {
  targetRepoPath: string;
  worktreePath: string;
  baseCommit?: string | null;
  expectedSnapshotOid?: string | null;
  expectedTargetRef?: string | null;
  mode?: WorkerIntegrateMode;
  commitMessage: string;
}): Promise<WorkerIntegrationResult> {
  const mode: WorkerIntegrateMode = opts.mode ?? 'squash';

  if (mode === 'check') {
    const check = await checkWorkerIntegration({
      targetRepoPath: opts.targetRepoPath,
      worktreePath: opts.worktreePath,
      baseCommit: opts.baseCommit,
      expectedSnapshotOid: opts.expectedSnapshotOid,
      expectedTargetRef: opts.expectedTargetRef,
    });
    return {
      mode,
      checkStatus: check.checkStatus,
      integrated: false,
      noChanges: check.noChanges,
      clean: check.clean,
      targetRepoPath: check.targetRepoPath,
      targetBranch: check.targetBranch,
      targetRef: check.targetRef,
      snapshotOid: check.snapshotOid,
      integratedCommit: null,
      conflictFiles: check.conflictFiles,
      ignoredCollisionFiles: check.ignoredCollisionFiles,
      changedFiles: [],
      message: check.message,
    };
  }

  return withRepoIntegrationLock(opts.targetRepoPath, async () => {
    const check = await checkWorkerIntegration({
      targetRepoPath: opts.targetRepoPath,
      worktreePath: opts.worktreePath,
      baseCommit: opts.baseCommit,
      expectedSnapshotOid: opts.expectedSnapshotOid,
      expectedTargetRef: opts.expectedTargetRef,
    });

    if (check.targetDirty) {
      throw new OrchestrationError('operation_rejected', check.message, {
        targetDirtyFiles: check.targetDirtyFiles,
      });
    }

    if (check.noChanges) {
      await assertTargetUnchanged(check);
      return {
        mode,
        checkStatus: check.checkStatus,
        integrated: false,
        noChanges: true,
        clean: true,
        targetRepoPath: check.targetRepoPath,
        targetBranch: check.targetBranch,
        targetRef: check.targetRef,
        snapshotOid: check.snapshotOid,
        integratedCommit: check.targetHead,
        conflictFiles: [],
        ignoredCollisionFiles: [],
        changedFiles: [],
        message: check.message,
      };
    }

    if (check.ignoredCollisionFiles.length > 0 || check.checkStatus === 'conflict') {
      return {
        mode,
        checkStatus: 'conflict',
        integrated: false,
        noChanges: false,
        clean: false,
        targetRepoPath: check.targetRepoPath,
        targetBranch: check.targetBranch,
        targetRef: check.targetRef,
        snapshotOid: check.snapshotOid,
        integratedCommit: null,
        conflictFiles: check.conflictFiles,
        ignoredCollisionFiles: check.ignoredCollisionFiles,
        changedFiles: [],
        message: check.message,
      };
    }

    if (check.checkStatus !== 'clean' || !check.clean || !check.targetHead) {
      throw new OrchestrationError('operation_rejected', check.message, {
        checkStatus: check.checkStatus,
      });
    }

    const { commit, changedFiles, cleanupWarning } = await prepareIntegrationCommit(check, mode, opts.commitMessage);
    const noChanges = commit === check.targetHead;
    if (!noChanges) await publishIntegrationCommit(check, commit);
    else await assertTargetUnchanged(check);

    return {
      mode,
      checkStatus: 'clean',
      integrated: !noChanges,
      noChanges,
      clean: true,
      targetRepoPath: check.targetRepoPath,
      targetBranch: check.targetBranch,
      targetRef: check.targetRef,
      snapshotOid: check.snapshotOid,
      integratedCommit: commit,
      ...(cleanupWarning ? { cleanupWarning } : {}),
      conflictFiles: [],
      ignoredCollisionFiles: [],
      changedFiles,
      message: noChanges ? 'Worker changes are already in the target.' : `Integrated via ${mode} as ${commit.slice(0, 10)} (${changedFiles.length} file(s)).`,
    };
  });
}

export async function createDetachedReviewWorktree(opts: {
  mainRepoRoot: string;
  snapshotOid: string;
  reviewSlug: string;
}): Promise<{ worktreePath: string }> {
  const safeSlug = opts.reviewSlug.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 48) || 'review';
  const suffix = randomUUID().replace(/-/g, '').slice(0, 8);
  const targetPath = join(
    dirname(opts.mainRepoRoot),
    `${basename(opts.mainRepoRoot)}.aha-worktrees`,
    `_review-${safeSlug}-${suffix}`,
  );
  const created = await addGitWorktree({
    cwd: opts.mainRepoRoot,
    worktreePath: targetPath,
    detach: true,
    startPoint: opts.snapshotOid,
  });
  if (!created.ok) {
    throw new OrchestrationError('worktree_failed', created.error);
  }
  return { worktreePath: created.path };
}

/**
 * Verifies read-only integrity of a detached review worktree using full 40-char commit OIDs.
 * Fails closed (`mutated: true, verificationFailed: true`) if status or HEAD cannot be read.
 */
export async function detectReviewWorktreeMutation(
  reviewWorktreePath: string,
  expectedSnapshotOid?: string | null,
): Promise<ReviewWorktreeMutationResult> {
  const [status, fullHead] = await Promise.all([
    getGitStatus(reviewWorktreePath).catch(() => null),
    resolveFullHeadCommit(reviewWorktreePath),
  ]);
  if (!status || !status.ok || !status.isGitRepo || !fullHead) {
    return {
      mutated: true,
      verificationFailed: true,
      dirtyFiles: [],
      reason: 'Could not verify review worktree Git status or full HEAD commit.',
    };
  }
  const dirtyFiles = status.entries.map((e) => e.path).filter((p): p is string => Boolean(p));
  const cleanExpected = expectedSnapshotOid?.trim() ?? '';
  const headChanged = Boolean(cleanExpected && fullHead !== cleanExpected);
  return {
    mutated: dirtyFiles.length > 0 || headChanged,
    verificationFailed: false,
    dirtyFiles,
    ...(headChanged
      ? { reason: `Review worktree HEAD changed (${fullHead.slice(0, 10)} != ${cleanExpected.slice(0, 10)})` }
      : dirtyFiles.length > 0
        ? { reason: `Review worktree modified ${dirtyFiles.length} file(s): ${dirtyFiles.join(', ')}` }
        : {}),
  };
}

export async function removeDetachedReviewWorktree(
  mainRepoRoot: string,
  reviewWorktreePath: string,
): Promise<{ removed: boolean; error?: string }> {
  try {
    const removed = await removeGitWorktree({
      cwd: mainRepoRoot,
      worktreePath: reviewWorktreePath,
      force: true,
    });
    if (removed.ok) {
      return { removed: true };
    }
    return { removed: false, error: removed.error };
  } catch (error) {
    return {
      removed: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export { deleteOwnedWorkerBranch };
