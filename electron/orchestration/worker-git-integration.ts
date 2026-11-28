import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
import {
  deleteOwnedWorkerBranch,
  deleteRunIntegrationBranch,
  formatRunIntegrationBranchName,
  inferSiblingMainRepoPath,
  RUN_INTEGRATION_BRANCH_PREFIX,
} from './worker-worktree-placement.js';

const GIT_SHA_RE = /^[0-9a-f]{7,40}$/i;
const FULL_GIT_SHA_RE = /^[0-9a-f]{40}$/i;
const DEFAULT_MAX_DIFF_BYTES = 32 * 1024;
const MAX_DIFF_CAP_BYTES = 128 * 1024;
const HIGH_RISK_PATH_RE =
  /(^|\/)(auth|security|permission|approval|ipc|router|store|state|orchestration|daemon|preload|main\.ts|package\.json|tsconfig|electron-builder)/i;

const repoIntegrationLocks = new Map<string, Promise<void>>();

export type RecommendedReviewTier = 'L0' | 'L1' | 'L2';
export type WorkerIntegrateMode = 'check' | 'squash' | 'merge';
export type WorkerIntegrateTargetBranch = 'main' | 'integration' | 'auto';
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
  willCreateIntegrationBranch?: boolean;
  message: string;
}

interface Publication {
  target: string;
  commit: string;
  before: string;
  sourceHead: string;
  worktree: string;
  baseBranch?: string | null;
  baseCommit?: string | null;
}
type BeforePublish = (publication: Publication) => Promise<void>;

export interface WorkerIntegrationResult {
  mode: WorkerIntegrateMode;
  checkStatus: WorkerIntegrationCheckStatus;
  integrated: boolean;
  noChanges: boolean;
  clean: boolean;
  targetRepoPath: string;
  targetBranch: string | null;
  targetRef: string | null;
  targetHeadBefore?: string | null;
  snapshotOid: string;
  integratedCommit: string | null;
  conflictFiles: string[];
  ignoredCollisionFiles: string[];
  changedFiles: string[];
  willCreateIntegrationBranch?: boolean;
  message: string;
  cleanupWarning?: string;
}

export interface RunCommitRangeDiffInspection {
  isGitRepo: boolean;
  repoPath: string;
  branch: string | null;
  baseCommit: string | null;
  targetCommit: string | null;
  commitsAhead: number;
  commits: WorkerCommitSummary[];
  changedFiles: string[];
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
  diffError?: string;
  recommendedReviewTier: RecommendedReviewTier;
  tierReason: string;
}

export interface RunBranchIntegrationResult {
  result: WorkerIntegrationResult;
  integrationBranch: string;
  integrationWorktreePath: string;
  integrationBaseCommit: string;
  integrationBaseBranch: string | null;
  createdRunBranch: boolean;
}

export interface RunFinalizeIntegrationResult {
  result: WorkerIntegrationResult;
  integrationBranch: string;
  integrationWorktreePath: string;
  removedWorktree: boolean;
  removedBranch: boolean;
  cleanupWarnings: string[];
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

export async function resolveTargetSymbolicRef(cwd: string): Promise<string | null> {
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

export async function isSameGitRepo(pathA: string, pathB: string): Promise<boolean> {
  try {
    const [inspA, inspB] = await Promise.all([
      inspectGitRepo(pathA).catch(() => null),
      inspectGitRepo(pathB).catch(() => null),
    ]);
    if (!inspA?.ok || !inspA.isGitRepo || !inspB?.ok || !inspB.isGitRepo) return false;
    const [dirA, dirB] = await Promise.all([
      resolveCanonicalGitCommonDir(pathA),
      resolveCanonicalGitCommonDir(pathB),
    ]);
    return Boolean(dirA && dirB && dirA === dirB);
  } catch {
    return false;
  }
}

export function resolveRunIntegrationWorktreePath(mainRepoRoot: string, runId: string): string {
  const branchName = formatRunIntegrationBranchName(runId);
  const slug = branchName.slice(RUN_INTEGRATION_BRANCH_PREFIX.length);
  return join(
    dirname(mainRepoRoot),
    `${basename(mainRepoRoot)}.aha-worktrees`,
    `_run-${slug}`,
  );
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
  pinnedSnapshot?: {
    headCommit: string | null;
    snapshotOid: string;
    dirtyFiles: string[];
    stagedDivergentFiles: string[];
  } | null;
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
    opts.pinnedSnapshot ??
    (await captureWorkerSnapshotOid(opts.worktreePath, { rejectStagedDivergence: false }));
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

export async function isGitCommitAncestor(
  repoPath: string,
  ancestorSha: string,
  descendantSha: string,
): Promise<boolean> {
  const cleanAnc = normalizeSha(ancestorSha);
  const cleanDesc = normalizeSha(descendantSha);
  if (!cleanAnc || !cleanDesc) return false;
  if (cleanAnc === cleanDesc) return true;
  const res = await runGitCommand(
    ['merge-base', '--is-ancestor', cleanAnc, cleanDesc],
    { cwd: repoPath, readOnly: true, timeoutMs: 10_000 },
  ).catch(() => null);
  return Boolean(res && res.exitCode === 0);
}

async function resolveVerifiedCommit(repoPath: string, rawSha: string): Promise<string | null> {
  const clean = normalizeSha(rawSha);
  if (!clean) return null;
  const verifyRes = await runGitCommand(['rev-parse', '--verify', `${clean}^{commit}`], {
    cwd: repoPath,
    readOnly: true,
    timeoutMs: 10_000,
  }).catch(() => null);
  const out = verifyRes && verifyRes.exitCode === 0 ? verifyRes.stdout.trim() : '';
  return FULL_GIT_SHA_RE.test(out) ? out : null;
}

async function assertWorkerBaseCompatibleWithTarget(opts: {
  targetRepoPath: string;
  targetHead: string;
  snapshotOid: string;
  baseCommit?: string | null;
  recordedBaseCommit?: string | null;
  targetBranchLabel?: string | null;
  mergeMode?: WorkerIntegrateMode;
}): Promise<{ resolvedBase: string | null; isBaseAncestorOfTarget: boolean }> {
  const label = opts.targetBranchLabel || 'target HEAD';
  const rawBase = opts.baseCommit?.trim();
  let resolvedBase: string | null = null;
  let isBaseAncestorOfTarget = true;

  if (rawBase) {
    const cleanBase = normalizeSha(rawBase);
    if (!cleanBase) {
      throw new OrchestrationError(
        'operation_rejected',
        `Invalid worker baseCommit "${rawBase}"; cannot verify branch ancestry before integration.`,
        { baseCommit: rawBase, targetHead: opts.targetHead },
      );
    }
    resolvedBase = await resolveVerifiedCommit(opts.targetRepoPath, cleanBase);
    if (!resolvedBase) {
      throw new OrchestrationError(
        'operation_rejected',
        `Worker baseCommit ${cleanBase} could not be resolved in target repository; cannot safely merge.`,
        { baseCommit: cleanBase, targetHead: opts.targetHead },
      );
    }
    if (resolvedBase !== opts.targetHead) {
      isBaseAncestorOfTarget = await isGitCommitAncestor(
        opts.targetRepoPath,
        resolvedBase,
        opts.targetHead,
      );
      if (!isBaseAncestorOfTarget) {
        if (opts.mergeMode === 'merge') {
          throw new OrchestrationError(
            'operation_rejected',
            `Cannot use mode="merge": worker base commit ${resolvedBase.slice(0, 10)} is not an ancestor of "${label}", so a 2-parent merge commit would import unrelated branch commit history into "${label}". Rebase or cherry-pick the task changes onto "${label}" before merging, or use mode="squash".`,
            {
              baseCommit: resolvedBase,
              targetHead: opts.targetHead,
              targetBranch: opts.targetBranchLabel ?? null,
              mode: 'merge',
            },
          );
        }

        // For non-merge modes (`squash` / `check`), allow a non-ancestor baseCommit ONLY when
        // merging baseCommit into targetHead leaves targetHead's tree 100% unchanged (e.g., a
        // worker branched off an `aha/run/*` branch that was just squash-finalized into main).
        const targetTreeRes = await runGitCommand(
          ['rev-parse', '--verify', `${opts.targetHead}^{tree}`],
          { cwd: opts.targetRepoPath, readOnly: true, timeoutMs: 10_000 },
        );
        const targetTreeOid = targetTreeRes.exitCode === 0 ? targetTreeRes.stdout.trim() : '';
        const mergeBaseTreeRes = await runGitCommand(
          ['merge-tree', '--write-tree', opts.targetHead, resolvedBase],
          { cwd: opts.targetRepoPath, readOnly: true, timeoutMs: 15_000 },
        );
        const mergedBaseTreeOid =
          mergeBaseTreeRes.exitCode === 0
            ? (mergeBaseTreeRes.stdout.split(/\r?\n/)[0]?.trim() ?? '')
            : '';
        if (
          !targetTreeOid ||
          !FULL_GIT_SHA_RE.test(targetTreeOid) ||
          !mergedBaseTreeOid ||
          mergedBaseTreeOid !== targetTreeOid
        ) {
          throw new OrchestrationError(
            'operation_rejected',
            `Worker base commit ${resolvedBase.slice(0, 10)} contains changes not present in "${label}" (outside the worker's reviewed diff baseCommit..snapshot). Merging would pull in unrelated branch commits; rebase or cherry-pick the task changes onto "${label}" or recreate the worker from "${label}" before integrating.`,
            {
              baseCommit: resolvedBase,
              targetHead: opts.targetHead,
              targetBranch: opts.targetBranchLabel ?? null,
            },
          );
        }
      }
    }
  }

  // For mode="merge", even if review ran on targetBranch (making effective base an older merge-base),
  // reject if the worker still descends from an un-rebased foreign recordedBaseCommit not in targetHead.
  if (opts.mergeMode === 'merge' && opts.recordedBaseCommit?.trim()) {
    const resolvedRecorded = await resolveVerifiedCommit(
      opts.targetRepoPath,
      opts.recordedBaseCommit.trim(),
    );
    if (resolvedRecorded && resolvedRecorded !== resolvedBase && resolvedRecorded !== opts.targetHead) {
      const stillDescends = await isGitCommitAncestor(
        opts.targetRepoPath,
        resolvedRecorded,
        opts.snapshotOid,
      );
      if (stillDescends) {
        const recordedInTarget = await isGitCommitAncestor(
          opts.targetRepoPath,
          resolvedRecorded,
          opts.targetHead,
        );
        if (!recordedInTarget) {
          throw new OrchestrationError(
            'operation_rejected',
            `Cannot use mode="merge": worker snapshot still descends from unrelated base commit ${resolvedRecorded.slice(0, 10)} which is not an ancestor of "${label}". Rebase or cherry-pick the task changes onto "${label}" before using mode="merge".`,
            {
              recordedBaseCommit: resolvedRecorded,
              targetHead: opts.targetHead,
              targetBranch: opts.targetBranchLabel ?? null,
              mode: 'merge',
            },
          );
        }
      }
    }
  }

  return { resolvedBase, isBaseAncestorOfTarget };
}

async function assertMergedResultMatchesReviewedScope(opts: {
  targetRepoPath: string;
  targetHead: string;
  snapshotOid: string;
  resolvedBase: string;
  isBaseAncestorOfTarget: boolean;
  actualMergedTreeOid: string;
  targetBranchLabel?: string | null;
}): Promise<void> {
  const mergeBasesRes = await runGitCommand(
    ['merge-base', '--all', opts.targetHead, opts.snapshotOid],
    { cwd: opts.targetRepoPath, readOnly: true, timeoutMs: 15_000 },
  );
  const mergeBases = mergeBasesRes.exitCode === 0 ? parseLines(mergeBasesRes.stdout) : [];
  if (mergeBases.length === 1 && mergeBases[0] === opts.resolvedBase) {
    return;
  }

  const label = opts.targetBranchLabel || 'target HEAD';
  if (opts.isBaseAncestorOfTarget && mergeBases.length === 1) {
    const actualMergeBase = mergeBases[0]!;
    const basePrecedesMergeBase = await isGitCommitAncestor(
      opts.targetRepoPath,
      opts.resolvedBase,
      actualMergeBase,
    );
    if (basePrecedesMergeBase) {
      // Worker snapshot merged newer target commits (e.g., merged main into worker branch).
      // Verify applying reviewed diff (resolvedBase..snapshotOid) onto actualMergeBase reproduces
      // snapshotOid's exact tree, blocking evil-merge reverts or hidden edits to target fixes.
      const snapTreeRes = await runGitCommand(
        ['rev-parse', '--verify', `${opts.snapshotOid}^{tree}`],
        { cwd: opts.targetRepoPath, readOnly: true, timeoutMs: 10_000 },
      );
      const snapTreeOid = snapTreeRes.exitCode === 0 ? snapTreeRes.stdout.trim() : '';
      const expectedSnapRes = await runGitCommand(
        ['merge-tree', '--write-tree', `--merge-base=${opts.resolvedBase}`, actualMergeBase, opts.snapshotOid],
        { cwd: opts.targetRepoPath, readOnly: true, timeoutMs: 15_000 },
      );
      const expectedSnapTreeOid =
        expectedSnapRes.exitCode === 0
          ? (expectedSnapRes.stdout.split(/\r?\n/)[0]?.trim() ?? '')
          : '';
      if (
        snapTreeOid &&
        FULL_GIT_SHA_RE.test(snapTreeOid) &&
        expectedSnapTreeOid &&
        expectedSnapTreeOid === snapTreeOid
      ) {
        return;
      }
      throw new OrchestrationError(
        'operation_rejected',
        `Integration blocked: merging worker snapshot into "${label}" (merge-base ${actualMergeBase.slice(0, 10)}) would apply changes outside the reviewed diff (${opts.resolvedBase.slice(0, 10)}..${opts.snapshotOid.slice(0, 10)}), such as reverting or altering newer commits on "${label}". Re-review against "${label}" before integrating.`,
        {
          baseCommit: opts.resolvedBase,
          actualMergeBase,
          targetHead: opts.targetHead,
          snapshotOid: opts.snapshotOid,
        },
      );
    }
  }

  // Non-ancestor base (e.g. squashed aha/run/* descendant), criss-cross merge-bases, or reset history:
  // require that applying the reviewed diff (resolvedBase..snapshotOid) onto targetHead produces the
  // exact same merged tree as actual Git merge.
  const reviewedMergeRes = await runGitCommand(
    ['merge-tree', '--write-tree', `--merge-base=${opts.resolvedBase}`, opts.targetHead, opts.snapshotOid],
    { cwd: opts.targetRepoPath, readOnly: true, timeoutMs: 15_000 },
  );
  const reviewedTreeOid =
    reviewedMergeRes.exitCode === 0
      ? (reviewedMergeRes.stdout.split(/\r?\n/)[0]?.trim() ?? '')
      : '';
  if (reviewedTreeOid && reviewedTreeOid === opts.actualMergedTreeOid) {
    return;
  }
  throw new OrchestrationError(
    'operation_rejected',
    `Integration blocked: Git's actual merge result into "${label}" differs from the reviewed diff (${opts.resolvedBase.slice(0, 10)}..${opts.snapshotOid.slice(0, 10)}). Re-review or rebase onto "${label}" before integrating.`,
    {
      baseCommit: opts.resolvedBase,
      targetHead: opts.targetHead,
      snapshotOid: opts.snapshotOid,
    },
  );
}

export async function checkWorkerIntegration(opts: {
  targetRepoPath: string;
  worktreePath: string;
  baseCommit?: string | null;
  recordedBaseCommit?: string | null;
  expectedSnapshotOid?: string | null;
  expectedTargetRef?: string | null;
  ignoreTargetDirty?: boolean;
  overrideTargetBranchLabel?: string | null;
  targetCommitOverride?: string | null;
  mergeMode?: WorkerIntegrateMode;
}): Promise<WorkerIntegrationCheckResult> {
  const targetStatus = await getGitStatus(opts.targetRepoPath);
  if (!targetStatus.ok || !targetStatus.isGitRepo || !targetStatus.head) {
    throw new OrchestrationError('worktree_failed', 'Target repository is not a valid Git repository.');
  }
  const [resolvedTargetHead, targetRef] = await Promise.all([
    resolveFullHeadCommit(opts.targetRepoPath),
    resolveTargetSymbolicRef(opts.targetRepoPath),
  ]);
  const overrideHead =
    opts.targetCommitOverride && FULL_GIT_SHA_RE.test(opts.targetCommitOverride.trim())
      ? opts.targetCommitOverride.trim()
      : null;
  const targetHead = overrideHead ?? resolvedTargetHead;
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
  const rawTargetDirtyFiles = targetStatus.entries
    .map((e) => e.path)
    .filter((p): p is string => Boolean(p));
  const targetDirtyFiles = opts.ignoreTargetDirty ? [] : rawTargetDirtyFiles;
  const effectiveTargetBranch = opts.overrideTargetBranchLabel ?? targetStatus.branch;
  const effectiveTargetRef = opts.overrideTargetBranchLabel
    ? `refs/heads/${opts.overrideTargetBranchLabel}`
    : targetRef;

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

  const { resolvedBase, isBaseAncestorOfTarget } = await assertWorkerBaseCompatibleWithTarget({
    targetRepoPath: opts.targetRepoPath,
    targetHead,
    snapshotOid: snap.snapshotOid,
    baseCommit: opts.baseCommit,
    recordedBaseCommit: opts.recordedBaseCommit,
    targetBranchLabel: effectiveTargetBranch,
    mergeMode: opts.mergeMode,
  });

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
      targetBranch: effectiveTargetBranch,
      targetRef: effectiveTargetRef,
      targetHead,
      snapshotOid: snap.snapshotOid,
      targetDirty: targetDirtyFiles.length > 0,
      targetDirtyFiles,
      conflictFiles: [],
      ignoredCollisionFiles: [],
      behindCommits: 0,
      aheadCommits: 0,
      ...(opts.ignoreTargetDirty ? { willCreateIntegrationBranch: true } : {}),
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

  if (mt.status === 'clean' && mt.treeOid && resolvedBase) {
    await assertMergedResultMatchesReviewedScope({
      targetRepoPath: opts.targetRepoPath,
      targetHead,
      snapshotOid: snap.snapshotOid,
      resolvedBase,
      isBaseAncestorOfTarget,
      actualMergedTreeOid: mt.treeOid,
      targetBranchLabel: effectiveTargetBranch,
    });
  }

  let ignoredCollisionFiles: string[] = [];
  if (mt.status === 'clean' && !opts.ignoreTargetDirty) {
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

  let message = opts.ignoreTargetDirty
    ? `Clean integration check passed (will create Run integration branch ${effectiveTargetBranch ?? 'aha/run/*'} from target HEAD).`
    : 'Clean integration check passed.';
  if (targetDirtyFiles.length > 0) {
    message = `Target workspace has ${targetDirtyFiles.length} uncommitted file(s); clean or commit target workspace before integrating (or pass targetBranch="integration" to integrate into aha/run/<runId>).`;
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
    targetBranch: effectiveTargetBranch,
    targetRef: effectiveTargetRef,
    targetHead,
    snapshotOid: snap.snapshotOid,
    ...(mt.treeOid && mt.status === 'clean' ? { mergedTreeOid: mt.treeOid } : {}),
    targetDirty: targetDirtyFiles.length > 0,
    targetDirtyFiles,
    conflictFiles: mt.conflictFiles,
    ignoredCollisionFiles,
    behindCommits,
    aheadCommits,
    ...(opts.ignoreTargetDirty ? { willCreateIntegrationBranch: true } : {}),
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
  options?: { strictReviewedTree?: boolean },
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
      const hookDiffRes = check.mergedTreeOid
        ? await runGitCommand(['diff', '--name-only', '-z', check.mergedTreeOid, preparedTreeOid], {
            cwd: workspace,
            readOnly: true,
          })
        : null;
      const hookTouchedFiles =
        hookDiffRes && hookDiffRes.exitCode === 0 && !hookDiffRes.truncated
          ? parseNullDelimitedPaths(hookDiffRes.stdout)
          : null;

      if (options?.strictReviewedTree) {
        const fileDetail = hookTouchedFiles?.length
          ? ` (${hookTouchedFiles.slice(0, 10).join(', ')})`
          : '';
        throw new OrchestrationError(
          'operation_rejected',
          `Integration blocked: a Git hook modified the commit tree outside the approved review snapshot${fileDetail}. Apply hook/formatter changes inside the worker worktree and re-review before integrating.`,
          {
            expectedTreeOid: check.mergedTreeOid ?? null,
            actualTreeOid: preparedTreeOid,
            hookTouchedFiles: hookTouchedFiles ?? [],
          },
        );
      }

      // Even for unpinned direct calls, a pre-commit hook may only reformat files already in the
      // incoming diff and must never introduce or modify unrelated files outside the merge diff.
      const incomingDiffRes = check.mergedTreeOid
        ? await runGitCommand(['diff', '--name-only', '-z', check.targetHead!, check.mergedTreeOid], {
            cwd: workspace,
            readOnly: true,
          })
        : null;
      const incomingFiles =
        incomingDiffRes && incomingDiffRes.exitCode === 0 && !incomingDiffRes.truncated
          ? new Set(parseNullDelimitedPaths(incomingDiffRes.stdout))
          : null;
      if (!hookTouchedFiles || !incomingFiles) {
        throw new OrchestrationError(
          'operation_rejected',
          'Integration blocked: a Git hook altered the commit tree and its modified file list could not be verified.',
        );
      }
      const outOfScopeHookFiles = hookTouchedFiles.filter((file) => !incomingFiles.has(file));
      if (outOfScopeHookFiles.length > 0) {
        throw new OrchestrationError(
          'operation_rejected',
          `Integration blocked: a Git hook modified file(s) outside the integration diff: ${outOfScopeHookFiles.slice(0, 10).join(', ')}.`,
          { outOfScopeHookFiles },
        );
      }

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

async function integrateWorkerChangesUnlocked(opts: {
  beforePublish?: BeforePublish;
  targetRepoPath: string;
  worktreePath: string;
  baseCommit?: string | null;
  recordedBaseCommit?: string | null;
  expectedSnapshotOid?: string | null;
  expectedTargetRef?: string | null;
  strictReviewedTree?: boolean;
  mode: 'squash' | 'merge';
  commitMessage: string;
}): Promise<WorkerIntegrationResult> {
  const mode = opts.mode;
  const check = await checkWorkerIntegration({
    targetRepoPath: opts.targetRepoPath,
    worktreePath: opts.worktreePath,
    baseCommit: opts.baseCommit,
    recordedBaseCommit: opts.recordedBaseCommit,
    expectedSnapshotOid: opts.expectedSnapshotOid,
    expectedTargetRef: opts.expectedTargetRef,
    mergeMode: mode,
  });

  if (check.targetDirty) {
    throw new OrchestrationError('operation_rejected', check.message, {
      targetDirtyFiles: check.targetDirtyFiles,
    });
  }

  const publishIntent = async (commit: string | null) => {
    if (commit && check.targetHead && check.targetBranch) await opts.beforePublish?.({
      target: check.targetBranch, commit, before: check.targetHead, sourceHead: check.snapshotOid,
      worktree: opts.targetRepoPath,
    });
  };
  if (check.noChanges) {
    await assertTargetUnchanged(check);
    await publishIntent(check.targetHead);
    return {
      mode,
      checkStatus: check.checkStatus,
      integrated: false,
      noChanges: true,
      clean: true,
      targetRepoPath: check.targetRepoPath,
      targetBranch: check.targetBranch,
      targetRef: check.targetRef,
      targetHeadBefore: check.targetHead,
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
      targetHeadBefore: check.targetHead,
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

  const { commit, changedFiles, cleanupWarning } = await prepareIntegrationCommit(
    check,
    mode,
    opts.commitMessage,
    { strictReviewedTree: opts.strictReviewedTree ?? Boolean(opts.expectedSnapshotOid) },
  );
  const noChanges = commit === check.targetHead;
  await publishIntent(commit);
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
    targetHeadBefore: check.targetHead,
    snapshotOid: check.snapshotOid,
    integratedCommit: commit,
    ...(cleanupWarning ? { cleanupWarning } : {}),
    conflictFiles: [],
    ignoredCollisionFiles: [],
    changedFiles,
    message: noChanges ? 'Worker changes are already in the target.' : `Integrated via ${mode} as ${commit.slice(0, 10)} (${changedFiles.length} file(s)).`,
  };
}

export async function integrateWorkerChanges(opts: {
  beforePublish?: BeforePublish;
  targetRepoPath: string;
  worktreePath: string;
  baseCommit?: string | null;
  recordedBaseCommit?: string | null;
  expectedSnapshotOid?: string | null;
  expectedTargetRef?: string | null;
  strictReviewedTree?: boolean;
  mode?: WorkerIntegrateMode;
  commitMessage: string;
}): Promise<WorkerIntegrationResult> {
  const mode: WorkerIntegrateMode = opts.mode ?? 'squash';

  if (mode === 'check') {
    const check = await checkWorkerIntegration({
      targetRepoPath: opts.targetRepoPath,
      worktreePath: opts.worktreePath,
      baseCommit: opts.baseCommit,
      recordedBaseCommit: opts.recordedBaseCommit,
      expectedSnapshotOid: opts.expectedSnapshotOid,
      expectedTargetRef: opts.expectedTargetRef,
      mergeMode: mode,
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
      targetHeadBefore: check.targetHead,
      snapshotOid: check.snapshotOid,
      integratedCommit: null,
      conflictFiles: check.conflictFiles,
      ignoredCollisionFiles: check.ignoredCollisionFiles,
      changedFiles: [],
      message: check.message,
    };
  }

  return withRepoIntegrationLock(opts.targetRepoPath, () =>
    integrateWorkerChangesUnlocked({
      beforePublish: opts.beforePublish,
      targetRepoPath: opts.targetRepoPath,
      worktreePath: opts.worktreePath,
      baseCommit: opts.baseCommit,
      recordedBaseCommit: opts.recordedBaseCommit,
      expectedSnapshotOid: opts.expectedSnapshotOid,
      expectedTargetRef: opts.expectedTargetRef,
      strictReviewedTree: opts.strictReviewedTree,
      mode,
      commitMessage: opts.commitMessage,
    }),
  );
}

function normFsPath(p: string): string {
  const resolved = resolve(p);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

async function inspectAndValidateRunBranchTarget(opts: {
  mainRepoRoot: string;
  branchName: string;
  integrationWorktreePath: string;
  existingBranch?: string | null;
  existingWorktreePath?: string | null;
  existingBaseBranch?: string | null;
}) {
  const inspectedMain = await inspectGitRepo(opts.mainRepoRoot);
  const mainHead = await resolveFullHeadCommit(opts.mainRepoRoot);
  if (!inspectedMain.ok || !inspectedMain.isGitRepo || !mainHead) {
    throw new OrchestrationError('worktree_failed', 'Main repository is not a valid Git repository.');
  }

  const listed = await listGitWorktrees(opts.mainRepoRoot);
  if (!listed.ok || !listed.isGitRepo) {
    throw new OrchestrationError('worktree_failed', 'Could not list Git worktrees for main repository.');
  }

  const expectedWtNorm = normFsPath(opts.integrationWorktreePath);
  const matchedWt = listed.worktrees.find((wt) => normFsPath(wt.path) === expectedWtNorm);
  const branchHolder = listed.worktrees.find((wt) => wt.branch === opts.branchName);
  if (branchHolder && normFsPath(branchHolder.path) !== expectedWtNorm) {
    throw new OrchestrationError(
      'operation_rejected',
      `Run integration branch ${opts.branchName} is already checked out in another worktree (${branchHolder.path}).`,
    );
  }

  const existingBranchOid = await resolveBranchRefOid(opts.mainRepoRoot, opts.branchName);
  const expectNewRunBranch = !opts.existingBranch?.trim() && !opts.existingWorktreePath?.trim();
  if (expectNewRunBranch && (matchedWt || existingBranchOid || existsSync(opts.integrationWorktreePath))) {
    throw new OrchestrationError(
      'operation_rejected',
      `Run integration branch or worktree (${opts.branchName} / ${opts.integrationWorktreePath}) already exists on disk from a previous wave. Remove it before starting a new integration branch wave.`,
      {
        integrationBranch: opts.branchName,
        integrationWorktreePath: opts.integrationWorktreePath,
        existingBranchOid,
      },
    );
  }

  const expectedBaseBranch = opts.existingBaseBranch?.trim() || null;
  if (!matchedWt && !existingBranchOid && !inspectedMain.branch) {
    throw new OrchestrationError(
      'operation_rejected',
      `Main repository is on detached HEAD; checkout a named target branch (such as "main") before creating Run integration branch ${opts.branchName}.`,
      { integrationBranch: opts.branchName },
    );
  }
  if (!matchedWt && expectedBaseBranch && inspectedMain.branch !== expectedBaseBranch) {
    throw new OrchestrationError(
      'operation_rejected',
      `Run integration is bound to base branch "${expectedBaseBranch}", but the main repository is currently checked out on "${inspectedMain.branch ?? '(detached HEAD)'}". Switch back to "${expectedBaseBranch}" before creating ${opts.branchName}.`,
      { expectedBaseBranch, actualBranch: inspectedMain.branch },
    );
  }

  if (matchedWt && matchedWt.branch !== opts.branchName) {
    throw new OrchestrationError(
      'operation_rejected',
      `Run integration worktree at ${opts.integrationWorktreePath} is on branch ${matchedWt.branch ?? '(detached)'} instead of ${opts.branchName}.`,
    );
  }

  return {
    inspectedMain,
    mainHead,
    matchedWt,
    existingBranchOid,
    expectedBaseBranch,
  };
}

/**
 * Ensures the Run's dedicated `aha/run/<runId>` branch and sibling worktree exist, then
 * integrates the worker snapshot into that worktree under a single repo lock.
 * Never copies or touches uncommitted files in the main workspace.
 */
export async function integrateWorkerIntoRunBranch(opts: {
  beforePublish?: BeforePublish;
  mainRepoRoot: string;
  runId: string;
  existingBranch?: string | null;
  existingWorktreePath?: string | null;
  existingBaseCommit?: string | null;
  existingBaseBranch?: string | null;
  worktreePath: string;
  baseCommit?: string | null;
  recordedBaseCommit?: string | null;
  expectedSnapshotOid?: string | null;
  strictReviewedTree?: boolean;
  mode?: WorkerIntegrateMode;
  commitMessage: string;
}): Promise<RunBranchIntegrationResult> {
  const mode: WorkerIntegrateMode = opts.mode ?? 'squash';
  const branchName = opts.existingBranch?.trim() || formatRunIntegrationBranchName(opts.runId);
  if (!branchName.startsWith(RUN_INTEGRATION_BRANCH_PREFIX) || !validateGitRefName(branchName)) {
    throw new OrchestrationError('invalid_argument', `Invalid Run integration branch name: ${branchName}`);
  }
  const integrationWorktreePath =
    opts.existingWorktreePath?.trim() || resolveRunIntegrationWorktreePath(opts.mainRepoRoot, opts.runId);

  if (mode === 'check') {
    const { inspectedMain, mainHead, matchedWt, existingBranchOid, expectedBaseBranch } =
      await inspectAndValidateRunBranchTarget({
        mainRepoRoot: opts.mainRepoRoot,
        branchName,
        integrationWorktreePath,
        existingBranch: opts.existingBranch,
        existingWorktreePath: opts.existingWorktreePath,
        existingBaseBranch: opts.existingBaseBranch,
      });

    if (matchedWt) {
      const check = await checkWorkerIntegration({
        targetRepoPath: integrationWorktreePath,
        worktreePath: opts.worktreePath,
        baseCommit: opts.baseCommit,
        recordedBaseCommit: opts.recordedBaseCommit,
        expectedSnapshotOid: opts.expectedSnapshotOid,
        expectedTargetRef: `refs/heads/${branchName}`,
        mergeMode: mode,
      });
      return {
        result: {
          mode,
          checkStatus: check.checkStatus,
          integrated: false,
          noChanges: check.noChanges,
          clean: check.clean,
          targetRepoPath: check.targetRepoPath,
          targetBranch: check.targetBranch,
          targetRef: check.targetRef,
          targetHeadBefore: check.targetHead,
          snapshotOid: check.snapshotOid,
          integratedCommit: null,
          conflictFiles: check.conflictFiles,
          ignoredCollisionFiles: check.ignoredCollisionFiles,
          changedFiles: [],
          message: check.message,
        },
        integrationBranch: branchName,
        integrationWorktreePath,
        integrationBaseCommit: opts.existingBaseCommit?.trim() || mainHead,
        integrationBaseBranch: expectedBaseBranch ?? inspectedMain.branch,
        createdRunBranch: false,
      };
    }

    // Read-only check when `_run-*` worktree has not yet been attached: check merge safety
    // against existing branch tip (if any) or main HEAD without creating any branch or worktree on disk.
    const check = await checkWorkerIntegration({
      targetRepoPath: opts.mainRepoRoot,
      worktreePath: opts.worktreePath,
      baseCommit: opts.baseCommit,
      recordedBaseCommit: opts.recordedBaseCommit,
      expectedSnapshotOid: opts.expectedSnapshotOid,
      ignoreTargetDirty: true,
      overrideTargetBranchLabel: branchName,
      targetCommitOverride: existingBranchOid,
      mergeMode: mode,
    });
    return {
      result: {
        mode,
        checkStatus: check.checkStatus,
        integrated: false,
        noChanges: check.noChanges,
        clean: check.clean,
        targetRepoPath: integrationWorktreePath,
        targetBranch: branchName,
        targetRef: `refs/heads/${branchName}`,
        targetHeadBefore: check.targetHead,
        snapshotOid: check.snapshotOid,
        integratedCommit: null,
        conflictFiles: check.conflictFiles,
        ignoredCollisionFiles: check.ignoredCollisionFiles,
        changedFiles: [],
        willCreateIntegrationBranch: !existingBranchOid,
        message: check.message,
      },
      integrationBranch: branchName,
      integrationWorktreePath,
      integrationBaseCommit: opts.existingBaseCommit?.trim() || mainHead,
      integrationBaseBranch: expectedBaseBranch ?? inspectedMain.branch,
      createdRunBranch: false,
    };
  }

  return withRepoIntegrationLock(opts.mainRepoRoot, async () => {
    const { inspectedMain, mainHead, matchedWt, existingBranchOid, expectedBaseBranch } =
      await inspectAndValidateRunBranchTarget({
        mainRepoRoot: opts.mainRepoRoot,
        branchName,
        integrationWorktreePath,
        existingBranch: opts.existingBranch,
        existingWorktreePath: opts.existingWorktreePath,
        existingBaseBranch: opts.existingBaseBranch,
      });

    let createdRunBranch = false;
    let createdWorktree = false;
    const integrationBaseCommit = opts.existingBaseCommit?.trim() || mainHead;
    const integrationBaseBranch = expectedBaseBranch ?? inspectedMain.branch;

    if (!matchedWt) {
      const created = existingBranchOid
        ? await addGitWorktree({
            cwd: opts.mainRepoRoot,
            worktreePath: integrationWorktreePath,
            branch: branchName,
          })
        : await addGitWorktree({
            cwd: opts.mainRepoRoot,
            worktreePath: integrationWorktreePath,
            newBranch: branchName,
            startPoint: mainHead,
          });
      if (!created.ok) {
        throw new OrchestrationError('worktree_failed', created.error);
      }
      createdWorktree = true;
      createdRunBranch = !existingBranchOid;
    }

    const rollbackNewRunBranch = async () => {
      if (!createdWorktree) return;
      await removeGitWorktree({
        cwd: opts.mainRepoRoot,
        worktreePath: integrationWorktreePath,
        force: true,
      }).catch(() => undefined);
      if (createdRunBranch) {
        await deleteRunIntegrationBranch(opts.mainRepoRoot, branchName, mainHead, {
          allowSquashCasDelete: true,
        }).catch(() => false);
      }
    };

    let result: WorkerIntegrationResult;
    try {
      result = await integrateWorkerChangesUnlocked({
        beforePublish: p => opts.beforePublish?.({ ...p, baseBranch: integrationBaseBranch, baseCommit: integrationBaseCommit }) ?? Promise.resolve(),
        targetRepoPath: integrationWorktreePath,
        worktreePath: opts.worktreePath,
        baseCommit: opts.baseCommit,
        recordedBaseCommit: opts.recordedBaseCommit,
        expectedSnapshotOid: opts.expectedSnapshotOid,
        expectedTargetRef: `refs/heads/${branchName}`,
        strictReviewedTree: opts.strictReviewedTree,
        mode,
        commitMessage: opts.commitMessage,
      });
    } catch (err) {
      await rollbackNewRunBranch();
      throw err;
    }

    if (!result.integrated && (!result.noChanges || createdRunBranch)) {
      await rollbackNewRunBranch();
    }

    return {
      result,
      integrationBranch: branchName,
      integrationWorktreePath,
      integrationBaseCommit,
      integrationBaseBranch,
      createdRunBranch: createdRunBranch && result.integrated,
    };
  });
}

async function assertCleanRunIntegrationWorktree(
  integrationWorktreePath: string,
  integrationBranch: string,
): Promise<{ headCommit: string }> {
  const [status, ref, headCommit] = await Promise.all([
    getGitStatus(integrationWorktreePath),
    resolveTargetSymbolicRef(integrationWorktreePath),
    resolveFullHeadCommit(integrationWorktreePath),
  ]);
  if (!status.ok || !status.isGitRepo || !headCommit) {
    throw new OrchestrationError(
      'worktree_failed',
      `Run integration worktree at ${integrationWorktreePath} is missing or invalid.`,
    );
  }
  if (ref !== `refs/heads/${integrationBranch}`) {
    throw new OrchestrationError(
      'operation_rejected',
      `Run integration worktree is on ${ref ?? 'detached HEAD'} instead of refs/heads/${integrationBranch}.`,
    );
  }
  const dirtyFiles = status.entries.map((e) => e.path).filter((p): p is string => Boolean(p));
  if (dirtyFiles.length > 0) {
    throw new OrchestrationError(
      'operation_rejected',
      `Run integration worktree has ${dirtyFiles.length} uncommitted file(s): ${dirtyFiles.join(', ')}. Clean or commit them before finalizing.`,
      { dirtyFiles },
    );
  }
  return { headCommit };
}

/**
 * Checks or promotes an active `aha/run/<runId>` integration branch back into the main workspace.
 * Enforces clean main workspace, optional expectedTargetRef / expectedSnapshotOid guards,
 * merge-tree & ignored-file collision checks, and atomic CAS branch cleanup after promotion.
 */
export async function finalizeRunIntegrationBranch(opts: {
  cleanup?: (expectedBranchOid: string) => Promise<{ removed: boolean; removedBranch: boolean }>;
  beforePublish?: BeforePublish;
  mainRepoRoot: string;
  integrationBranch: string;
  integrationWorktreePath: string;
  baseCommit?: string | null;
  expectedTargetRef?: string | null;
  expectedSnapshotOid?: string | null;
  strictReviewedTree?: boolean;
  mode?: WorkerIntegrateMode;
  commitMessage: string;
  deleteBranch?: boolean;
  keepWorktree?: boolean;
}): Promise<RunFinalizeIntegrationResult> {
  const mode: WorkerIntegrateMode = opts.mode ?? 'squash';
  const branchName = opts.integrationBranch.trim();
  if (!branchName.startsWith(RUN_INTEGRATION_BRANCH_PREFIX) || !validateGitRefName(branchName)) {
    throw new OrchestrationError('invalid_argument', `Invalid Run integration branch: ${branchName}`);
  }

  if (mode === 'check') {
    await assertCleanRunIntegrationWorktree(opts.integrationWorktreePath, branchName);
    const check = await checkWorkerIntegration({
      targetRepoPath: opts.mainRepoRoot,
      worktreePath: opts.integrationWorktreePath,
      baseCommit: opts.baseCommit,
      expectedSnapshotOid: opts.expectedSnapshotOid,
      expectedTargetRef: opts.expectedTargetRef,
    });
    return {
      result: {
        mode,
        checkStatus: check.checkStatus,
        integrated: false,
        noChanges: check.noChanges,
        clean: check.clean,
        targetRepoPath: check.targetRepoPath,
        targetBranch: check.targetBranch,
        targetRef: check.targetRef,
        targetHeadBefore: check.targetHead,
        snapshotOid: check.snapshotOid,
        integratedCommit: null,
        conflictFiles: check.conflictFiles,
        ignoredCollisionFiles: check.ignoredCollisionFiles,
        changedFiles: [],
        message: check.message,
      },
      integrationBranch: branchName,
      integrationWorktreePath: opts.integrationWorktreePath,
      removedWorktree: false,
      removedBranch: false,
      cleanupWarnings: [],
    };
  }

  return withRepoIntegrationLock(opts.mainRepoRoot, async () => {
    const { headCommit: runBranchOidBefore } = await assertCleanRunIntegrationWorktree(
      opts.integrationWorktreePath,
      branchName,
    );

    const result = await integrateWorkerChangesUnlocked({
      beforePublish: p => opts.beforePublish?.({ ...p, sourceHead: runBranchOidBefore }) ?? Promise.resolve(),
      targetRepoPath: opts.mainRepoRoot,
      worktreePath: opts.integrationWorktreePath,
      baseCommit: opts.baseCommit,
      expectedSnapshotOid: opts.expectedSnapshotOid,
      expectedTargetRef: opts.expectedTargetRef,
      strictReviewedTree: opts.strictReviewedTree ?? true,
      mode,
      commitMessage: opts.commitMessage,
    });

    const cleanupWarnings: string[] = result.cleanupWarning ? [result.cleanupWarning] : [];
    if (!result.integrated && !result.noChanges) {
      return {
        result,
        integrationBranch: branchName,
        integrationWorktreePath: opts.integrationWorktreePath,
        removedWorktree: false,
        removedBranch: false,
        cleanupWarnings,
      };
    }

    let removedWorktree = false;
    let removedBranch = false;
    if (!opts.keepWorktree && opts.cleanup) {
      try {
        const cleaned = await opts.cleanup(runBranchOidBefore);
        removedWorktree = cleaned.removed;
        removedBranch = cleaned.removedBranch;
      } catch (error) { cleanupWarnings.push(`Run cleanup incomplete: ${String(error)}`); }
    } else if (!opts.keepWorktree) {
      const removed = await removeGitWorktree({
        cwd: opts.mainRepoRoot,
        worktreePath: opts.integrationWorktreePath,
        force: false,
      });
      if (removed.ok) {
        removedWorktree = true;
        if (opts.deleteBranch !== false) {
          removedBranch = await deleteRunIntegrationBranch(
            opts.mainRepoRoot,
            branchName,
            runBranchOidBefore,
            { allowSquashCasDelete: true },
          );
          if (!removedBranch) {
            cleanupWarnings.push(
              `Run integration branch ${branchName} was retained because Git could not safely CAS-delete it.`,
            );
          }
        }
      } else {
        cleanupWarnings.push(
          `Run integration worktree could not be removed at ${opts.integrationWorktreePath}: ${removed.error}`,
        );
      }
    }

    return {
      result,
      integrationBranch: branchName,
      integrationWorktreePath: opts.integrationWorktreePath,
      removedWorktree,
      removedBranch,
      cleanupWarnings,
    };
  });
}

/**
 * Pure read-only diff inspection between two exact commit OIDs (`baseCommit..targetCommit`).
 * Works safely even if the repository working tree has unrelated dirty files.
 */
export async function inspectCommitRangeDiff(opts: {
  repoPath: string;
  baseCommit: string;
  targetCommit: string;
  branch?: string | null;
  files?: readonly string[];
  maxDiffBytes?: number;
}): Promise<RunCommitRangeDiffInspection> {
  const inspected = await inspectGitRepo(opts.repoPath);
  if (!inspected.ok || !inspected.isGitRepo) {
    return {
      isGitRepo: false,
      repoPath: opts.repoPath,
      branch: null,
      baseCommit: null,
      targetCommit: null,
      commitsAhead: 0,
      commits: [],
      changedFiles: [],
      diffStat: '',
      diff: '',
      diffTruncated: false,
      recommendedReviewTier: 'L0',
      tierReason: 'non-git workspace',
    };
  }

  const verifyCommit = async (sha: string): Promise<string | null> => {
    const clean = normalizeSha(sha);
    if (!clean) return null;
    const res = await runGitCommand(['rev-parse', '--verify', `${clean}^{commit}`], {
      cwd: opts.repoPath,
      readOnly: true,
      timeoutMs: 10_000,
    }).catch(() => null);
    const out = res && res.exitCode === 0 ? res.stdout.trim() : '';
    return FULL_GIT_SHA_RE.test(out) ? out : null;
  };

  const [baseCommit, targetCommit] = await Promise.all([
    verifyCommit(opts.baseCommit),
    verifyCommit(opts.targetCommit),
  ]);
  if (!baseCommit || !targetCommit) {
    throw new OrchestrationError(
      'worktree_failed',
      'Could not verify baseCommit or targetCommit in Git repository.',
    );
  }

  const validFiles: string[] = [];
  for (const f of opts.files ?? []) {
    const validated = validateRepoRelativePath(f, inspected.rootPath ?? opts.repoPath);
    if (validated) validFiles.push(validated);
  }
  const pathArgs = validFiles.length > 0 ? ['--', ...validFiles] : [];
  const maxDiffBytes = Math.min(
    MAX_DIFF_CAP_BYTES,
    Math.max(1024, Math.floor(opts.maxDiffBytes ?? DEFAULT_MAX_DIFF_BYTES)),
  );

  let commits: WorkerCommitSummary[] = [];
  if (baseCommit !== targetCommit) {
    const logRes = await runGitCommand(
      ['log', '--format=%h%x09%s', '--max-count=50', `${baseCommit}..${targetCommit}`],
      { cwd: opts.repoPath, readOnly: true },
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

  if (baseCommit !== targetCommit) {
    const [namesRes, statRes, diffRes] = await Promise.all([
      runGitCommand(['diff', '--name-only', baseCommit, targetCommit, ...pathArgs], {
        cwd: opts.repoPath,
        readOnly: true,
      }),
      runGitCommand(['diff', '--stat', baseCommit, targetCommit, ...pathArgs], {
        cwd: opts.repoPath,
        readOnly: true,
      }),
      runGitCommand(['diff', '--no-color', baseCommit, targetCommit, ...pathArgs], {
        cwd: opts.repoPath,
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

  const { tier, reason } = classifyReviewTier({ changedFiles, diffStat });
  return {
    isGitRepo: true,
    repoPath: opts.repoPath,
    branch: opts.branch ?? inspected.branch,
    baseCommit,
    targetCommit,
    commitsAhead: commits.length,
    commits,
    changedFiles,
    diffStat,
    diff,
    diffTruncated,
    ...(diffError ? { diffError } : {}),
    recommendedReviewTier: tier,
    tierReason: reason,
  };
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

export {
  deleteOwnedWorkerBranch,
  deleteRunIntegrationBranch,
  formatRunIntegrationBranchName,
  RUN_INTEGRATION_BRANCH_PREFIX,
};
