import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runGitCommand } from '../dist-electron/git/git-exec.js';
import { collectWorkerReportArtifacts } from '../dist-electron/orchestration/board-protocol.js';
import {
  captureWorkerSnapshotOid,
  checkWorkerIntegration,
  createDetachedReviewWorktree,
  deleteOwnedWorkerBranch,
  detectReviewWorktreeMutation,
  inspectWorkerDiff,
  integrateWorkerChanges,
  removeDetachedReviewWorktree,
} from '../dist-electron/orchestration/worker-git-integration.js';
import {
  prepareWorkerWorktreePlacement,
  removeOwnedWorkerWorktree,
} from '../dist-electron/orchestration/worker-worktree-placement.js';

async function git(cwd, ...args) {
  const res = await runGitCommand(args, { cwd, timeoutMs: 20_000 });
  assert.equal(res.exitCode, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

async function initTempRepo(t) {
  const root = mkdtempSync(join(tmpdir(), 'aha-git-int-'));
  const repo = join(root, 'repo');
  rmSync(repo, { recursive: true, force: true });
  await git(root, 'init', '-b', 'main', 'repo');
  await git(repo, 'config', 'user.name', 'Test User');
  await git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, '.gitignore'), 'local.env\n*.local.log\n', 'utf8');
  writeFileSync(join(repo, 'app.ts'), 'export const version = 1;\n', 'utf8');
  writeFileSync(join(repo, 'readme.md'), '# Demo\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'initial commit');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repo };
}

test('immutable snapshot captures committed + uncommitted + untracked changes without mutating author worktree and squash-integrates into one clean commit', async (t) => {
  const { repo } = await initTempRepo(t);
  const baseHead = await git(repo, 'rev-parse', 'HEAD');

  const placement = await prepareWorkerWorktreePlacement({
    baseCwd: repo,
    taskId: 'task_int_1',
    name: 'backend',
  });
  assert.equal(placement.ownsWorktree, true);
  assert.equal(placement.ownsBranch, true);
  assert.equal(placement.baseCommit, baseHead);
  assert.ok(placement.branch.startsWith('aha/worker/'));

  // 1 committed change + 1 uncommitted edit + 1 untracked file.
  writeFileSync(join(placement.worktreePath, 'app.ts'), 'export const version = 2;\n', 'utf8');
  await git(placement.worktreePath, 'add', 'app.ts');
  await git(placement.worktreePath, 'commit', '-m', 'bump version');
  writeFileSync(join(placement.worktreePath, 'readme.md'), '# Demo v2\n', 'utf8');
  writeFileSync(join(placement.worktreePath, 'helper.ts'), 'export const ok = true;\n', 'utf8');

  const statusBefore = await git(placement.worktreePath, 'status', '--porcelain');
  const stashBefore = await git(placement.worktreePath, 'stash', 'list');

  const snap = await captureWorkerSnapshotOid(placement.worktreePath);
  assert.ok(snap.snapshotOid && snap.snapshotOid !== snap.headCommit);
  assert.equal(await git(placement.worktreePath, 'status', '--porcelain'), statusBefore);
  assert.equal(await git(placement.worktreePath, 'stash', 'list'), stashBefore);

  const artifacts = await collectWorkerReportArtifacts(
    placement.worktreePath,
    placement.branch,
    undefined,
    placement.baseCommit,
  );
  assert.equal(artifacts.commitsAhead, 1);
  assert.equal(artifacts.uncommittedCount, 2);
  assert.deepEqual(artifacts.changedFiles.sort(), ['app.ts', 'helper.ts', 'readme.md']);

  const diff = await inspectWorkerDiff({
    worktreePath: placement.worktreePath,
    baseCommit: placement.baseCommit,
    files: ['helper.ts'],
  });
  assert.equal(diff.commitsAhead, 1);
  assert.match(diff.diff, /export const ok = true;/);
  assert.doesNotMatch(diff.diff, /Demo v2/);

  // TOCTOU guard: mismatched expectedSnapshotOid is rejected.
  await assert.rejects(
    () =>
      integrateWorkerChanges({
        targetRepoPath: repo,
        worktreePath: placement.worktreePath,
        baseCommit: placement.baseCommit,
        expectedSnapshotOid: '0123456789abcdef0123456789abcdef01234567',
        mode: 'squash',
        commitMessage: 'should fail',
      }),
    /snapshot changed since review/i,
  );

  // Dirty main repo protection: refuses to overwrite uncommitted user edits.
  writeFileSync(join(repo, 'user-wip.txt'), 'unsaved work\n', 'utf8');
  await assert.rejects(
    () =>
      integrateWorkerChanges({
        targetRepoPath: repo,
        worktreePath: placement.worktreePath,
        baseCommit: placement.baseCommit,
        mode: 'squash',
        commitMessage: 'should fail on dirty main',
      }),
    /uncommitted file/i,
  );
  rmSync(join(repo, 'user-wip.txt'));

  // Squash integration produces exactly 1 clean commit on main with all 3 files.
  const integrated = await integrateWorkerChanges({
    targetRepoPath: repo,
    worktreePath: placement.worktreePath,
    baseCommit: placement.baseCommit,
    expectedSnapshotOid: snap.snapshotOid,
    mode: 'squash',
    commitMessage: 'feat: integrate backend worker',
  });
  assert.equal(integrated.integrated, true);
  assert.equal(integrated.mode, 'squash');
  assert.ok(integrated.integratedCommit);
  assert.equal(await git(repo, 'rev-list', '--count', `${baseHead}..HEAD`), '1');
  assert.equal(readFileSync(join(repo, 'app.ts'), 'utf8'), 'export const version = 2;\n');
  assert.equal(readFileSync(join(repo, 'readme.md'), 'utf8'), '# Demo v2\n');
  assert.equal(readFileSync(join(repo, 'helper.ts'), 'utf8'), 'export const ok = true;\n');

  // An expected tip permits safe cleanup, while squash-only branch history is retained.
  const branchOid = await git(repo, 'rev-parse', `refs/heads/${placement.branch}`);
  const removed = await removeOwnedWorkerWorktree({
    worktreePath: placement.worktreePath,
    repoRootPath: repo,
    force: true,
    deleteBranch: placement.branch,
    expectedBranchOid: branchOid,
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.removedBranch, false, 'safe delete retains a squash-only source branch');
  assert.equal(existsSync(placement.worktreePath), false);
  assert.equal(await git(repo, 'branch', '--list', placement.branch), placement.branch);
});

test('P0: integration pre-check and squash merge refuse to overwrite ignored local files in main repo', async (t) => {
  const { repo } = await initTempRepo(t);
  const originalIgnoredBytes = Buffer.from('LOCAL_API_KEY=do_not_overwrite_12345\n', 'utf8');
  writeFileSync(join(repo, 'local.env'), originalIgnoredBytes);

  const placement = await prepareWorkerWorktreePlacement({
    baseCwd: repo,
    taskId: 'task_ignored',
    name: 'worker-ignored',
  });
  writeFileSync(join(placement.worktreePath, 'local.env'), 'OVERWRITTEN_BY_WORKER=evil\n', 'utf8');
  await git(placement.worktreePath, 'add', '-f', 'local.env');
  await git(placement.worktreePath, 'commit', '-m', 'force-add ignored file');

  const check = await checkWorkerIntegration({
    targetRepoPath: repo,
    worktreePath: placement.worktreePath,
    baseCommit: placement.baseCommit,
  });
  assert.equal(check.clean, false);
  assert.equal(check.checkStatus, 'conflict');
  assert.ok(check.ignoredCollisionFiles.includes('local.env'));

  const res = await integrateWorkerChanges({
    targetRepoPath: repo,
    worktreePath: placement.worktreePath,
    baseCommit: placement.baseCommit,
    mode: 'squash',
    commitMessage: 'must not overwrite ignored file',
  });
  assert.equal(res.integrated, false);
  assert.equal(res.clean, false);
  assert.ok(res.ignoredCollisionFiles.includes('local.env'));
  assert.deepEqual(readFileSync(join(repo, 'local.env')), originalIgnoredBytes);
});

test('P1: concurrent squash integrations into the same repo serialize cleanly under common-dir lock', async (t) => {
  const { repo } = await initTempRepo(t);
  const baseHead = await git(repo, 'rev-parse', 'HEAD');

  const w1 = await prepareWorkerWorktreePlacement({ baseCwd: repo, taskId: 'task_c1', name: 'w1' });
  const w2 = await prepareWorkerWorktreePlacement({ baseCwd: repo, taskId: 'task_c2', name: 'w2' });

  writeFileSync(join(w1.worktreePath, 'alpha.ts'), 'export const alpha = 1;\n', 'utf8');
  writeFileSync(join(w2.worktreePath, 'beta.ts'), 'export const beta = 2;\n', 'utf8');

  const [r1, r2] = await Promise.all([
    integrateWorkerChanges({
      targetRepoPath: repo,
      worktreePath: w1.worktreePath,
      baseCommit: w1.baseCommit,
      mode: 'squash',
      commitMessage: 'feat: integrate alpha',
    }),
    integrateWorkerChanges({
      targetRepoPath: repo,
      worktreePath: w2.worktreePath,
      baseCommit: w2.baseCommit,
      mode: 'squash',
      commitMessage: 'feat: integrate beta',
    }),
  ]);

  assert.equal(r1.integrated, true);
  assert.equal(r2.integrated, true);
  assert.equal(await git(repo, 'rev-list', '--count', `${baseHead}..HEAD`), '2');
  assert.equal(readFileSync(join(repo, 'alpha.ts'), 'utf8'), 'export const alpha = 1;\n');
  assert.equal(readFileSync(join(repo, 'beta.ts'), 'utf8'), 'export const beta = 2;\n');
  assert.equal(await git(repo, 'status', '--porcelain'), '');
});

test('P1: staged-vs-working-tree divergence is rejected by snapshot capture and branch CAS protects moved refs', async (t) => {
  const { repo } = await initTempRepo(t);
  const w = await prepareWorkerWorktreePlacement({ baseCwd: repo, taskId: 'task_div', name: 'div' });

  // Stage v2, then revert working tree copy back to HEAD (v1) -> index != HEAD and worktree != index!
  writeFileSync(join(w.worktreePath, 'app.ts'), 'export const version = 999;\n', 'utf8');
  await git(w.worktreePath, 'add', 'app.ts');
  writeFileSync(join(w.worktreePath, 'app.ts'), 'export const version = 1;\n', 'utf8');

  await assert.rejects(
    () => captureWorkerSnapshotOid(w.worktreePath),
    /staged vs working-tree divergence/i,
  );
  const diff = await inspectWorkerDiff({ worktreePath: w.worktreePath, baseCommit: w.baseCommit });
  assert.deepEqual(diff.stagedDivergentFiles, ['app.ts']);

  // Branch CAS deletion must refuse when branch advanced after expectedOid was captured.
  const oldBranchOid = await git(repo, 'rev-parse', `refs/heads/${w.branch}`);
  await git(w.worktreePath, 'commit', '-m', 'commit staged v999');
  const checkedOutOid = await git(w.worktreePath, 'rev-parse', 'HEAD');
  assert.equal(await deleteOwnedWorkerBranch(repo, w.branch, checkedOutOid), false);
  assert.equal(await git(w.worktreePath, 'symbolic-ref', 'HEAD'), `refs/heads/${w.branch}`);
  assert.equal(await git(repo, 'rev-parse', `refs/heads/${w.branch}`), checkedOutOid);
  const deleted = await deleteOwnedWorkerBranch(repo, w.branch, oldBranchOid);
  assert.equal(deleted, false);
  assert.ok((await git(repo, 'branch', '--list', w.branch)).includes(w.branch));
});

test('failed squash preserves target edits made during commit; unrelated history is unverifiable', async (t) => {
  const { root, repo } = await initTempRepo(t);
  const baseHead = await git(repo, 'rev-parse', 'HEAD');
  const ignoredBytes = Buffer.from('KEEP_IGNORED_LOG\n', 'utf8');
  writeFileSync(join(repo, 'keep.local.log'), ignoredBytes);

  const w = await prepareWorkerWorktreePlacement({ baseCwd: repo, taskId: 'task_hook', name: 'hook-fail' });
  writeFileSync(join(w.worktreePath, 'new-from-worker.ts'), 'export const x = 1;\n', 'utf8');

  writeFileSync(join(w.worktreePath, 'app.ts'), 'Worker edit\n');
  // Pause a failing commit while a user edits the target independently.
  const hooksDir = join(root, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  const started = join(root, 'hook-start');
  const resume = join(root, 'hook-resume');
  const shPath = (path) => "'" + path.replaceAll('\\', '/').replaceAll("'", "'\\''") + "'";
  writeFileSync(hookPath, [
    '#!/bin/sh',
    'touch ' + shPath(started),
    'n=0',
    'while [ ! -f ' + shPath(resume) + ' ] && [ "$n" -lt 10 ]; do sleep 1; n=$((n+1)); done',
    'echo "blocked by hook" >&2',
    'exit 1',
    '',
  ].join('\n'), 'utf8');
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* windows */
  }
  await git(repo, 'config', 'core.hooksPath', hooksDir);

  const failed = assert.rejects(integrateWorkerChanges({
    targetRepoPath: repo,
    worktreePath: w.worktreePath,
    baseCommit: w.baseCommit,
    mode: 'squash',
    commitMessage: 'commit will fail in hook',
  }), /blocked by hook|failed to commit/i);
  try {
    for (let elapsed = 0; !existsSync(started) && elapsed < 7000; elapsed += 25) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
    }
    assert.equal(existsSync(started), true);
    writeFileSync(join(repo, 'app.ts'), 'User edit during commit\n');
    writeFileSync(join(repo, 'notes.txt'), 'New user data\n');
  } finally {
    writeFileSync(resume, '');
    await failed;
  }

  assert.equal(await git(repo, 'rev-parse', 'HEAD'), baseHead);
  assert.equal(await git(repo, 'diff', '--cached', '--name-only'), '');
  assert.equal(readFileSync(join(repo, 'app.ts'), 'utf8'), 'User edit during commit\n');
  assert.equal(readFileSync(join(repo, 'notes.txt'), 'utf8'), 'New user data\n');
  assert.equal(existsSync(join(repo, 'new-from-worker.ts')), false);
  assert.equal(existsSync(join(repo, '.git', 'SQUASH_MSG')), false);
  assert.deepEqual(readFileSync(join(repo, 'keep.local.log')), ignoredBytes);

  writeFileSync(join(repo, 'app.ts'), 'export const version = 1;\n');
  rmSync(join(repo, 'notes.txt'));
  await git(repo, 'config', '--unset', 'core.hooksPath');
  const orphanWt = await prepareWorkerWorktreePlacement({ baseCwd: repo, taskId: 'task_orphan', name: 'orphan' });
  await git(orphanWt.worktreePath, 'checkout', '--orphan', 'aha/worker/orphan-branch');
  await git(orphanWt.worktreePath, 'rm', '-rf', '.');
  writeFileSync(join(orphanWt.worktreePath, 'orphan.txt'), 'no common ancestor\n', 'utf8');
  await git(orphanWt.worktreePath, 'add', 'orphan.txt');
  await git(orphanWt.worktreePath, 'commit', '-m', 'orphan root');

  const orphanCheck = await checkWorkerIntegration({
    targetRepoPath: repo,
    worktreePath: orphanWt.worktreePath,
  });
  assert.equal(orphanCheck.clean, false);
  assert.equal(orphanCheck.checkStatus, 'unverifiable');
  await assert.rejects(
    () =>
      integrateWorkerChanges({
        targetRepoPath: repo,
        worktreePath: orphanWt.worktreePath,
        mode: 'squash',
        commitMessage: 'must reject unverifiable merge',
      }),
    /could not verify merge safety|no common git ancestor/i,
  );
});

test('P1/P2: real conflict check, large diff truncation preserves captured content, and review worktree mutation uses full 40-char OID + fail-closed', async (t) => {
  const { repo } = await initTempRepo(t);
  const placement = await prepareWorkerWorktreePlacement({
    baseCwd: repo,
    taskId: 'task_conflict',
    name: 'worker-conflict',
  });

  // Conflicting edits to app.ts on both main and worker worktree.
  writeFileSync(join(repo, 'app.ts'), 'export const version = 100;\n', 'utf8');
  await git(repo, 'add', 'app.ts');
  await git(repo, 'commit', '-m', 'main diverges');

  writeFileSync(join(placement.worktreePath, 'app.ts'), 'export const version = 200;\n', 'utf8');
  // Large file to trigger diff truncation (> 2048 bytes).
  writeFileSync(
    join(placement.worktreePath, 'large.txt'),
    Array.from({ length: 400 }, (_, i) => `line-${i}-${'x'.repeat(80)}`).join('\n'),
    'utf8',
  );

  const largeDiff = await inspectWorkerDiff({
    worktreePath: placement.worktreePath,
    baseCommit: placement.baseCommit,
    maxDiffBytes: 2048,
  });
  assert.equal(largeDiff.diffTruncated, true);
  assert.ok(largeDiff.diff.length > 0, 'truncated diff must preserve captured prefix instead of empty string');
  assert.match(largeDiff.diff, /Diff truncated at 2048 bytes/);
  assert.equal(largeDiff.snapshotOid?.length, 40);

  // Clean detached review worktree must NOT false-positive on 7-char vs 40-char SHA comparison!
  const detached = await createDetachedReviewWorktree({
    mainRepoRoot: repo,
    snapshotOid: largeDiff.snapshotOid,
    reviewSlug: 'clean-check',
  });
  const cleanCheck = await detectReviewWorktreeMutation(detached.worktreePath, largeDiff.snapshotOid);
  assert.equal(cleanCheck.mutated, false);
  assert.equal(cleanCheck.verificationFailed, false);

  // Dirty detached review worktree is detected; unreadable/missing path fails closed.
  writeFileSync(join(detached.worktreePath, 'tampered.txt'), 'oops\n', 'utf8');
  const dirtyCheck = await detectReviewWorktreeMutation(detached.worktreePath, largeDiff.snapshotOid);
  assert.equal(dirtyCheck.mutated, true);
  assert.equal(dirtyCheck.verificationFailed, false);

  const missingCheck = await detectReviewWorktreeMutation(join(repo, '__does_not_exist__'), largeDiff.snapshotOid);
  assert.equal(missingCheck.mutated, true);
  assert.equal(missingCheck.verificationFailed, true);

  const removedReview = await removeDetachedReviewWorktree(repo, detached.worktreePath);
  assert.equal(removedReview.removed, true);

  const check = await checkWorkerIntegration({
    targetRepoPath: repo,
    worktreePath: placement.worktreePath,
    baseCommit: placement.baseCommit,
  });
  assert.equal(check.clean, false);
  assert.equal(check.checkStatus, 'conflict');
  assert.ok(check.conflictFiles.includes('app.ts'));

  const res = await integrateWorkerChanges({
    targetRepoPath: repo,
    worktreePath: placement.worktreePath,
    baseCommit: placement.baseCommit,
    mode: 'squash',
    commitMessage: 'conflict attempt',
  });
  assert.equal(res.integrated, false);
  assert.equal(res.clean, false);
  assert.ok(res.conflictFiles.includes('app.ts'));
  assert.equal(await git(repo, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(repo, 'app.ts'), 'utf8'), 'export const version = 100;\n');
});

test('merge mode publishes the prepared two-parent commit and removes its temporary worktree', async (t) => {
  const { repo } = await initTempRepo(t);
  const base = await git(repo, 'rev-parse', 'HEAD');
  const worker = await prepareWorkerWorktreePlacement({ baseCwd: repo, taskId: 'merge-parents' });
  writeFileSync(join(worker.worktreePath, 'merge-note.txt'), 'Merge mode\n');
  await git(worker.worktreePath, 'add', '--', 'merge-note.txt');
  await git(worker.worktreePath, 'commit', '-m', 'worker edit');
  const workerHead = await git(worker.worktreePath, 'rev-parse', 'HEAD');
  const listWorktreePaths = async () => (await git(repo, 'worktree', 'list', '--porcelain'))
    .split(/\r?\n/).filter((line) => line.startsWith('worktree '));
  const before = await listWorktreePaths();

  const result = await integrateWorkerChanges({
    targetRepoPath: repo, worktreePath: worker.worktreePath, baseCommit: base,
    expectedSnapshotOid: workerHead, mode: 'merge', commitMessage: 'Merge verified worker',
  });
  assert.equal(result.integrated, true);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), result.integratedCommit);
  assert.equal(await git(repo, 'show', '-s', '--format=%P', 'HEAD'), base + ' ' + workerHead);
  assert.deepEqual(await listWorktreePaths(), before);
  assert.equal(await git(repo, 'status', '--porcelain'), '');
});

test('squash integration supports auto-formatting pre-commit hooks and allowSquashCasDelete cleans up squash branches safely', async (t) => {
  const { root, repo } = await initTempRepo(t);
  const hooksDir = join(root, 'fmt-hooks');
  mkdirSync(hooksDir, { recursive: true });
  const hookPath = join(hooksDir, 'pre-commit');
  writeFileSync(
    hookPath,
    '#!/bin/sh\nif [ -f formatted.ts ]; then\n  printf "export const formatted = true;\\n" > formatted.ts\n  git add formatted.ts\nfi\nexit 0\n',
    'utf8',
  );
  try {
    chmodSync(hookPath, 0o755);
  } catch {
    /* windows */
  }
  await git(repo, 'config', 'core.hooksPath', hooksDir);

  const worker = await prepareWorkerWorktreePlacement({ baseCwd: repo, taskId: 'fmt-hook', name: 'fmt' });
  writeFileSync(join(worker.worktreePath, 'formatted.ts'), 'export const formatted=false;\n', 'utf8');
  await git(worker.worktreePath, 'add', 'formatted.ts');
  await git(worker.worktreePath, 'commit', '-m', 'unformatted commit');
  const branchOid = await git(repo, 'rev-parse', `refs/heads/${worker.branch}`);

  const result = await integrateWorkerChanges({
    targetRepoPath: repo,
    worktreePath: worker.worktreePath,
    baseCommit: worker.baseCommit,
    mode: 'squash',
    commitMessage: 'feat: formatted via pre-commit hook',
  });
  assert.equal(result.integrated, true);
  assert.equal(readFileSync(join(repo, 'formatted.ts'), 'utf8'), 'export const formatted = true;\n');

  // allowSquashCasDelete still refuses while checked out, then succeeds atomically after worktree removal.
  assert.equal(
    await deleteOwnedWorkerBranch(repo, worker.branch, branchOid, { allowSquashCasDelete: true }),
    false,
  );
  const removed = await removeOwnedWorkerWorktree({
    worktreePath: worker.worktreePath,
    repoRootPath: repo,
    force: true,
    deleteBranch: worker.branch,
    expectedBranchOid: branchOid,
    allowSquashCasDelete: true,
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.removedBranch, true);
  assert.equal(await git(repo, 'branch', '--list', worker.branch), '');
});
