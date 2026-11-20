import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { runGitCommand, validateRepoRelativePath } from '../git/git-exec.js';
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
const DEFAULT_MAX_DIFF_BYTES = 32 * 1024;
const MAX_DIFF_CAP_BYTES = 128 * 1024;
const HIGH_RISK_PATH_RE =
  /(^|\/)(auth|security|permission|approval|ipc|router|store|state|orchestration|daemon|preload|main\.ts|package\.json|tsconfig|electron-builder)/i;

export type RecommendedReviewTier = 'L0' | 'L1' | 'L2';
export type WorkerIntegrateMode = 'check' | 'squash' | 'merge';

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
  commitsAhead: number;
  commits: WorkerCommitSummary[];
  uncommittedFiles: string[];
  changedFiles: string[];
  diffStat: string;
  diff: string;
  diffTruncated: boolean;
  recommendedReviewTier: RecommendedReviewTier;
  tierReason: string;
}

export interface WorkerIntegrationCheckResult {
  clean: boolean;
  noChanges: boolean;
  targetRepoPath: string;
  targetBranch: string | null;
  targetHead: string | null;
  snapshotOid: string;
  targetDirty: boolean;
  targetDirtyFiles: string[];
  conflictFiles: string[];
  behindCommits: number;
  aheadCommits: number;
  message: string;
}

export interface WorkerIntegrationResult {
  mode: WorkerIntegrateMode;
  integrated: boolean;
  noChanges: boolean;
  clean: boolean;
  targetRepoPath: string;
  targetBranch: string | null;
  snapshotOid: string;
  integratedCommit: string | null;
  conflictFiles: string[];
  changedFiles: string[];
  message: string;
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
 * Generates an immutable commit OID capturing HEAD + staged + unstaged + untracked changes
 * using a temporary GIT_INDEX_FILE, leaving the author's working tree, index, and stash untouched.
 */
export async function captureWorkerSnapshotOid(
  worktreePath: string,
): Promise<{ headCommit: string | null; snapshotOid: string | null; dirtyFiles: string[] }> {
  const status = await getGitStatus(worktreePath);
  if (!status.ok || !status.isGitRepo || !status.head) {
    return { headCommit: null, snapshotOid: null, dirtyFiles: [] };
  }
  const fullHeadRes = await runGitCommand(['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: worktreePath,
    readOnly: true,
  }).catch(() => null);
  const headCommit =
    (fullHeadRes && fullHeadRes.exitCode === 0 ? fullHeadRes.stdout.trim() : '') || status.head;
  const dirtyFiles = status.entries
    .map((entry) => entry.path)
    .filter((p): p is string => Boolean(p));
  if (dirtyFiles.length === 0) {
    return { headCommit, snapshotOid: headCommit, dirtyFiles: [] };
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
  const head = await runGitCommand(['rev-parse', '--verify', 'HEAD^{commit}'], {
    cwd: worktreePath,
    readOnly: true,
  });
  return head.exitCode === 0 && head.stdout.trim() ? head.stdout.trim() : null;
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
  const { headCommit, snapshotOid, dirtyFiles } = await captureWorkerSnapshotOid(opts.worktreePath);
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
    if (namesRes.exitCode === 0) changedFiles = parseLines(namesRes.stdout);
    if (statRes.exitCode === 0) diffStat = statRes.stdout.trim();
    if (diffRes.exitCode === 0) {
      const rawDiff = diffRes.stdout;
      if (diffRes.truncated || Buffer.byteLength(rawDiff, 'utf8') > maxDiffBytes) {
        diff = `${clipUtf8Bytes(rawDiff, maxDiffBytes).trimEnd()}\n\n[Diff truncated at ${maxDiffBytes} bytes. Pass files:[...] to inspect specific files.]`;
        diffTruncated = true;
      } else {
        diff = rawDiff;
      }
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
    commitsAhead: commits.length,
    commits,
    uncommittedFiles: dirtyFiles,
    changedFiles: allChanged,
    diffStat,
    diff,
    diffTruncated,
    recommendedReviewTier: tier,
    tierReason: reason,
  };
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

async function detectMergeTreeConflicts(
  targetRepoPath: string,
  targetHead: string,
  snapshotOid: string,
  baseCommit?: string | null,
): Promise<{ supported: boolean; clean: boolean; conflictFiles: string[]; treeOid: string | null }> {
  const args = baseCommit
    ? ['merge-tree', '--write-tree', '--name-only', `--merge-base=${baseCommit}`, targetHead, snapshotOid]
    : ['merge-tree', '--write-tree', '--name-only', targetHead, snapshotOid];
  const res = await runGitCommand(args, { cwd: targetRepoPath, readOnly: true });
  if (res.exitCode === 0) {
    const firstLine = res.stdout.split(/\r?\n/)[0]?.trim() || null;
    return { supported: true, clean: true, conflictFiles: [], treeOid: firstLine };
  }
  if (/unknown option|usage: git merge-tree/i.test(res.stderr)) {
    return { supported: false, clean: false, conflictFiles: [], treeOid: null };
  }
  const conflictFiles = new Set<string>();
  const lines = res.stdout.split(/\r?\n/);
  // With --write-tree --name-only, line 0 is tree OID, lines until blank line are conflicted paths.
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i]!.trim();
    if (!line) break;
    conflictFiles.add(line);
  }
  for (const line of lines) {
    const m = /CONFLICT \([^)]+\):.* in (.+)$/.exec(line);
    if (m?.[1]) conflictFiles.add(m[1].trim());
  }
  return {
    supported: true,
    clean: false,
    conflictFiles: [...conflictFiles],
    treeOid: null,
  };
}

export async function checkWorkerIntegration(opts: {
  targetRepoPath: string;
  worktreePath: string;
  baseCommit?: string | null;
  expectedSnapshotOid?: string | null;
}): Promise<WorkerIntegrationCheckResult> {
  const targetStatus = await getGitStatus(opts.targetRepoPath);
  if (!targetStatus.ok || !targetStatus.isGitRepo || !targetStatus.head) {
    throw new OrchestrationError('worktree_failed', 'Target repository is not a valid Git repository.');
  }
  const targetDirtyFiles = targetStatus.entries
    .map((e) => e.path)
    .filter((p): p is string => Boolean(p));

  const snap = await captureWorkerSnapshotOid(opts.worktreePath);
  if (!snap.snapshotOid) {
    throw new OrchestrationError('worktree_failed', 'Could not capture worker Git snapshot.');
  }
  if (opts.expectedSnapshotOid && snap.snapshotOid !== opts.expectedSnapshotOid) {
    throw new OrchestrationError(
      'operation_rejected',
      `Worker snapshot changed since review (expected ${opts.expectedSnapshotOid.slice(0, 10)}, actual ${snap.snapshotOid.slice(0, 10)}). Re-review before integrating.`,
      { expectedSnapshotOid: opts.expectedSnapshotOid, actualSnapshotOid: snap.snapshotOid },
    );
  }

  const baseCommit = await resolveEffectiveBaseCommit(opts.worktreePath, opts.baseCommit);
  const diffCheck = await runGitCommand(
    ['diff', '--quiet', targetStatus.head, snap.snapshotOid],
    { cwd: opts.targetRepoPath, readOnly: true },
  );
  if (diffCheck.exitCode === 0) {
    return {
      clean: true,
      noChanges: true,
      targetRepoPath: opts.targetRepoPath,
      targetBranch: targetStatus.branch,
      targetHead: targetStatus.head,
      snapshotOid: snap.snapshotOid,
      targetDirty: targetDirtyFiles.length > 0,
      targetDirtyFiles,
      conflictFiles: [],
      behindCommits: 0,
      aheadCommits: 0,
      message: 'Worker snapshot has no changes relative to target HEAD.',
    };
  }

  const revCount = await runGitCommand(
    ['rev-list', '--left-right', '--count', `${targetStatus.head}...${snap.snapshotOid}`],
    { cwd: opts.targetRepoPath, readOnly: true },
  );
  let behindCommits = 0;
  let aheadCommits = 0;
  if (revCount.exitCode === 0) {
    const [left, right] = revCount.stdout.trim().split(/\s+/);
    behindCommits = Number.parseInt(left || '0', 10) || 0;
    aheadCommits = Number.parseInt(right || '0', 10) || 0;
  }

  const mergeBase =
    baseCommit && baseCommit !== snap.snapshotOid ? baseCommit : null;
  const mt = await detectMergeTreeConflicts(
    opts.targetRepoPath,
    targetStatus.head,
    snap.snapshotOid,
    mergeBase,
  );

  return {
    clean: mt.supported ? mt.clean && targetDirtyFiles.length === 0 : targetDirtyFiles.length === 0,
    noChanges: false,
    targetRepoPath: opts.targetRepoPath,
    targetBranch: targetStatus.branch,
    targetHead: targetStatus.head,
    snapshotOid: snap.snapshotOid,
    targetDirty: targetDirtyFiles.length > 0,
    targetDirtyFiles,
    conflictFiles: mt.conflictFiles,
    behindCommits,
    aheadCommits,
    message:
      targetDirtyFiles.length > 0
        ? `Target workspace has ${targetDirtyFiles.length} uncommitted file(s); clean or commit target workspace before integrating.`
        : mt.supported && !mt.clean
          ? `Merge conflicts detected in ${mt.conflictFiles.length} file(s): ${mt.conflictFiles.join(', ')}`
          : 'Clean integration check passed.',
  };
}

async function abortAndRestoreTargetRepo(targetRepoPath: string): Promise<void> {
  await runGitCommand(['merge', '--abort'], { cwd: targetRepoPath }).catch(() => null);
  await runGitCommand(['reset', '--merge', 'HEAD'], { cwd: targetRepoPath }).catch(() => null);
  await runGitCommand(['clean', '-fd'], { cwd: targetRepoPath }).catch(() => null);
}

export async function integrateWorkerChanges(opts: {
  targetRepoPath: string;
  worktreePath: string;
  baseCommit?: string | null;
  expectedSnapshotOid?: string | null;
  mode?: WorkerIntegrateMode;
  commitMessage: string;
}): Promise<WorkerIntegrationResult> {
  const mode: WorkerIntegrateMode = opts.mode ?? 'squash';
  const check = await checkWorkerIntegration({
    targetRepoPath: opts.targetRepoPath,
    worktreePath: opts.worktreePath,
    baseCommit: opts.baseCommit,
    expectedSnapshotOid: opts.expectedSnapshotOid,
  });

  if (mode === 'check') {
    return {
      mode,
      integrated: false,
      noChanges: check.noChanges,
      clean: check.clean,
      targetRepoPath: check.targetRepoPath,
      targetBranch: check.targetBranch,
      snapshotOid: check.snapshotOid,
      integratedCommit: null,
      conflictFiles: check.conflictFiles,
      changedFiles: [],
      message: check.message,
    };
  }

  if (check.noChanges) {
    return {
      mode,
      integrated: false,
      noChanges: true,
      clean: true,
      targetRepoPath: check.targetRepoPath,
      targetBranch: check.targetBranch,
      snapshotOid: check.snapshotOid,
      integratedCommit: check.targetHead,
      conflictFiles: [],
      changedFiles: [],
      message: check.message,
    };
  }

  if (check.targetDirty) {
    throw new OrchestrationError('operation_rejected', check.message, {
      targetDirtyFiles: check.targetDirtyFiles,
    });
  }

  if (check.conflictFiles.length > 0) {
    return {
      mode,
      integrated: false,
      noChanges: false,
      clean: false,
      targetRepoPath: check.targetRepoPath,
      targetBranch: check.targetBranch,
      snapshotOid: check.snapshotOid,
      integratedCommit: null,
      conflictFiles: check.conflictFiles,
      changedFiles: [],
      message: check.message,
    };
  }

  const mergeArgs =
    mode === 'squash'
      ? ['merge', '--squash', check.snapshotOid]
      : ['merge', '--no-ff', '--no-edit', '-m', opts.commitMessage, check.snapshotOid];

  const mergeRes = await runGitCommand(mergeArgs, {
    cwd: opts.targetRepoPath,
    timeoutMs: 60_000,
  });
  if (mergeRes.exitCode !== 0) {
    const unmerged = await runGitCommand(['diff', '--name-only', '--diff-filter=U'], {
      cwd: opts.targetRepoPath,
      readOnly: true,
    });
    const conflictFiles = parseLines(unmerged.stdout);
    await abortAndRestoreTargetRepo(opts.targetRepoPath);
    return {
      mode,
      integrated: false,
      noChanges: false,
      clean: false,
      targetRepoPath: check.targetRepoPath,
      targetBranch: check.targetBranch,
      snapshotOid: check.snapshotOid,
      integratedCommit: null,
      conflictFiles,
      changedFiles: [],
      message:
        conflictFiles.length > 0
          ? `Merge conflict aborted cleanly. Conflicting files: ${conflictFiles.join(', ')}`
          : mergeRes.stderr.trim() || mergeRes.stdout.trim() || 'Git merge failed and was aborted.',
    };
  }

  if (mode === 'squash') {
    const commitRes = await runGitCommand(['commit', '-m', opts.commitMessage], {
      cwd: opts.targetRepoPath,
      timeoutMs: 30_000,
    });
    if (commitRes.exitCode !== 0) {
      await abortAndRestoreTargetRepo(opts.targetRepoPath);
      throw new OrchestrationError(
        'worktree_failed',
        commitRes.stderr.trim() || commitRes.stdout.trim() || 'Failed to commit squashed worker changes.',
      );
    }
  }

  const headRes = await runGitCommand(['rev-parse', 'HEAD'], {
    cwd: opts.targetRepoPath,
    readOnly: true,
  });
  const integratedCommit = headRes.exitCode === 0 ? headRes.stdout.trim() : null;
  const changedRes =
    integratedCommit && check.targetHead
      ? await runGitCommand(['diff', '--name-only', check.targetHead, integratedCommit], {
          cwd: opts.targetRepoPath,
          readOnly: true,
        })
      : null;
  const changedFiles = changedRes && changedRes.exitCode === 0 ? parseLines(changedRes.stdout) : [];

  return {
    mode,
    integrated: true,
    noChanges: false,
    clean: true,
    targetRepoPath: check.targetRepoPath,
    targetBranch: check.targetBranch,
    snapshotOid: check.snapshotOid,
    integratedCommit,
    conflictFiles: [],
    changedFiles,
    message: `Integrated via ${mode} as ${integratedCommit?.slice(0, 10) ?? 'HEAD'} (${changedFiles.length} file(s)).`,
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

export async function detectReviewWorktreeMutation(
  reviewWorktreePath: string,
  expectedSnapshotOid?: string | null,
): Promise<{ mutated: boolean; dirtyFiles: string[] }> {
  const status = await getGitStatus(reviewWorktreePath).catch(() => null);
  if (!status || !status.ok || !status.isGitRepo) {
    return { mutated: false, dirtyFiles: [] };
  }
  const dirtyFiles = status.entries.map((e) => e.path).filter((p): p is string => Boolean(p));
  const headChanged = Boolean(expectedSnapshotOid && status.head && status.head !== expectedSnapshotOid);
  return {
    mutated: dirtyFiles.length > 0 || headChanged,
    dirtyFiles,
  };
}

export async function removeDetachedReviewWorktree(
  mainRepoRoot: string,
  reviewWorktreePath: string,
): Promise<boolean> {
  const removed = await removeGitWorktree({
    cwd: mainRepoRoot,
    worktreePath: reviewWorktreePath,
    force: true,
  }).catch(() => null);
  return Boolean(removed && removed.ok);
}

export { deleteOwnedWorkerBranch };
