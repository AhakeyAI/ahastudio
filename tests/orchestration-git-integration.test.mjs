import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { runGitCommand } from '../dist-electron/git/git-exec.js';
import { collectWorkerReportArtifacts } from '../dist-electron/orchestration/board-protocol.js';
import {
  captureWorkerSnapshotOid,
  checkWorkerIntegration,
  inspectWorkerDiff,
  integrateWorkerChanges,
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

  // collectWorkerReportArtifacts now sees both committed and uncommitted files!
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

  // Releasing worktree with deleteBranch removes both the directory and the aha/worker/* branch.
  const removed = await removeOwnedWorkerWorktree({
    worktreePath: placement.worktreePath,
    repoRootPath: repo,
    force: true,
    deleteBranch: placement.branch,
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.removedBranch, true);
  assert.equal(existsSync(placement.worktreePath), false);
  const branches = await git(repo, 'branch', '--list', placement.branch);
  assert.equal(branches, '');
});

test('integration check detects real conflicts and squash merge aborts cleanly restoring main repo', async (t) => {
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

  const check = await checkWorkerIntegration({
    targetRepoPath: repo,
    worktreePath: placement.worktreePath,
    baseCommit: placement.baseCommit,
  });
  assert.equal(check.clean, false);
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
  // Main repo remains completely clean and untouched.
  assert.equal(await git(repo, 'status', '--porcelain'), '');
  assert.equal(readFileSync(join(repo, 'app.ts'), 'utf8'), 'export const version = 100;\n');
});
