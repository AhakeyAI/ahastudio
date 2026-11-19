import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { ipcMain } from 'electron';

import {
  validateGitRefName,
  validateLocalDirectoryPath,
  validateRepoRelativePath,
} from '../dist-electron/git/git-exec.js';
import {
  parsePorcelainV1Status,
  parseWorktreeListPorcelain,
} from '../dist-electron/git/porcelain-parser.js';
import { registerGitIpc } from '../dist-electron/ipc/git.js';
import { registerWorkspaceFsIpc } from '../dist-electron/ipc/workspace-fs.js';
import { discardGitPaths } from '../dist-electron/git/git-service.js';

test('discard uses the selected path literally even when Git glob characters appear in its name', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'aha-literal-path-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, stdio: 'pipe' });
  git('init');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.test');
  const selected = 'report[1].txt';
  const other = 'report1.txt';
  for (const name of [selected, other]) writeFileSync(join(cwd, name), 'original');
  git('add', '--', selected, other);
  git('-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  for (const name of [selected, other]) writeFileSync(join(cwd, name), 'edited');
  const result = await discardGitPaths({ cwd, paths: [selected] });
  assert.deepEqual(result, { ok: true, restored: [selected], removed: [] });
  assert.equal(readFileSync(join(cwd, selected), 'utf8'), 'original');
  assert.equal(readFileSync(join(cwd, other), 'utf8'), 'edited');
});

function createIpcHarness(t, registerFn) {
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => {
    handlers.set(channel, fn);
  });
  const contents = Object.assign(new EventEmitter(), { id: 42, send() {} });
  registerFn({
    liveWindow: () => ({ webContents: contents }),
    getCurrentCwd: () => undefined,
  });
  return {
    call: (channel, payload, senderId = 42) => {
      const handler = handlers.get(channel);
      assert.ok(handler, `expected handler for ${channel}`);
      return handler({ sender: { id: senderId } }, payload);
    },
  };
}

function runGitSync(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

test('porcelain parsers decode status v1 -z -b (unborn, ahead/behind, rename, conflict) and worktrees', () => {
  const unborn = parsePorcelainV1Status('## No commits yet on main\0?? README.md\0');
  assert.equal(unborn.branch, 'main');
  assert.equal(unborn.upstream, null);
  assert.equal(unborn.ahead, 0);
  assert.equal(unborn.behind, 0);
  assert.equal(unborn.detached, false);
  assert.deepEqual(unborn.entries, [
    {
      path: 'README.md',
      origPath: null,
      indexStatus: '?',
      worktreeStatus: '?',
      staged: false,
      unstaged: false,
      untracked: true,
      conflicted: false,
    },
  ]);

  const mixed = parsePorcelainV1Status(
    [
      '## feat/ui...origin/feat/ui [ahead 3, behind 2]',
      ' M src/app.ts',
      'MM src/both.ts',
      'R  src/new-name.ts',
      'src/old-name.ts',
      'UU src/conflict.ts',
      '?? src/untracked.txt',
      '',
    ].join('\0'),
  );
  assert.equal(mixed.branch, 'feat/ui');
  assert.equal(mixed.upstream, 'origin/feat/ui');
  assert.equal(mixed.ahead, 3);
  assert.equal(mixed.behind, 2);
  assert.equal(mixed.entries.length, 5);
  assert.deepEqual(mixed.entries[2], {
    path: 'src/new-name.ts',
    origPath: 'src/old-name.ts',
    indexStatus: 'R',
    worktreeStatus: ' ',
    staged: true,
    unstaged: false,
    untracked: false,
    conflicted: false,
  });
  assert.equal(mixed.entries[3]?.conflicted, true);
  assert.equal(mixed.entries[3]?.staged, false);
  assert.equal(mixed.entries[1]?.staged, true);
  assert.equal(mixed.entries[1]?.unstaged, true);

  const detached = parsePorcelainV1Status('## HEAD (no branch)\0');
  assert.equal(detached.branch, null);
  assert.equal(detached.detached, true);

  const wtZ = parseWorktreeListPorcelain(
    [
      'worktree /repo/main',
      'HEAD aaaaaaa',
      'branch refs/heads/main',
      '',
      'worktree /repo/wt-1',
      'HEAD bbbbbbb',
      'detached',
      'locked manual lock',
      'prunable gitdir file points to non-existent location',
      '',
    ].join('\0'),
  );
  assert.equal(wtZ.length, 2);
  assert.deepEqual(wtZ[0], {
    path: '/repo/main',
    head: 'aaaaaaa',
    branch: 'main',
    branchRef: 'refs/heads/main',
    isBare: false,
    detached: false,
    locked: false,
    lockReason: null,
    prunable: false,
    prunableReason: null,
    isMainWorktree: true,
  });
  assert.deepEqual(wtZ[1], {
    path: '/repo/wt-1',
    head: 'bbbbbbb',
    branch: null,
    branchRef: null,
    isBare: false,
    detached: true,
    locked: true,
    lockReason: 'manual lock',
    prunable: true,
    prunableReason: 'gitdir file points to non-existent location',
    isMainWorktree: false,
  });

  const wtLine = parseWorktreeListPorcelain(
    'worktree /repo/main\nHEAD 1111111\nbranch refs/heads/main\n\nworktree /repo/wt-2\nHEAD 2222222\nbranch refs/heads/feat/x\n',
  );
  assert.equal(wtLine.length, 2);
  assert.equal(wtLine[1]?.branch, 'feat/x');
  assert.equal(wtLine[1]?.isMainWorktree, false);
});

test('git path and ref validators reject UNC/device, traversal, .git, and option injection', () => {
  assert.equal(validateLocalDirectoryPath('\\\\attacker.example\\share\\repo'), null);
  assert.equal(validateLocalDirectoryPath('\\\\.\\pipe\\test'), null);
  assert.equal(validateLocalDirectoryPath('/??/C:/repo'), null);
  assert.equal(validateLocalDirectoryPath('./relative/repo'), null);
  if (process.platform === 'win32') {
    assert.equal(validateLocalDirectoryPath('C:\\tmp\\CON'), null);
    assert.equal(validateLocalDirectoryPath('C:\\tmp\\repo:ads'), null);
    assert.ok(validateLocalDirectoryPath('C:\\tmp\\repo'));
  }

  const fakeRoot = process.platform === 'win32' ? 'C:\\repo\\root' : '/repo/root';
  assert.equal(validateRepoRelativePath('src/index.ts', fakeRoot), 'src/index.ts');
  assert.equal(validateRepoRelativePath('../outside.ts', fakeRoot), null);
  assert.equal(validateRepoRelativePath('sub/../../outside.ts', fakeRoot), null);
  assert.equal(validateRepoRelativePath('.git/config', fakeRoot), null);
  assert.equal(validateRepoRelativePath('\\\\server\\share\\a.txt', fakeRoot), null);
  if (process.platform === 'win32') {
    assert.equal(validateRepoRelativePath('NUL', fakeRoot), null);
    assert.equal(validateRepoRelativePath('foo.txt:stream', fakeRoot), null);
  }

  assert.equal(validateGitRefName('feat/ui-1.0'), 'feat/ui-1.0');
  assert.equal(validateGitRefName('--upload-pack=evil'), null);
  assert.equal(validateGitRefName('-f'), null);
  assert.equal(validateGitRefName('feat..main'), null);
  assert.equal(validateGitRefName('main@{1}'), null);
  assert.equal(validateGitRefName('bad.lock'), null);
  assert.equal(validateGitRefName('feat/.hidden'), null);
  assert.equal(validateGitRefName('@'), null);
  assert.equal(validateGitRefName('branch with space'), null);
});

test('git IPC degrades cleanly on non-git folder and executes full git & worktree lifecycle', async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'aha-phase3-git-'));
  const nonGitDir = join(baseDir, 'plain-dir');
  const repoDir = join(baseDir, 'repo');
  const wtDir = join(baseDir, 'worktrees', 'wt-feat');

  try {
    mkdirSync(nonGitDir, { recursive: true });
    mkdirSync(repoDir, { recursive: true });

    const { call } = createIpcHarness(t, registerGitIpc);

    // Authorization check rejects wrong sender webContents id.
    const unauth = await call('git:inspect', { cwd: nonGitDir }, 999);
    assert.equal(unauth.ok, false);

    // Non-git folder degrades cleanly.
    const nonGitInspect = await call('git:inspect', { cwd: nonGitDir });
    assert.deepEqual(nonGitInspect, {
      ok: true,
      isGitRepo: false,
      cwd: resolve(nonGitDir),
      rootPath: null,
      commonDir: null,
      gitDir: null,
      head: null,
      branch: null,
    });
    const nonGitStatus = await call('git:status', { cwd: nonGitDir });
    assert.equal(nonGitStatus.ok, true);
    assert.equal(nonGitStatus.isGitRepo, false);
    assert.deepEqual(nonGitStatus.entries, []);

    const nonGitBranches = await call('git:branches', { cwd: nonGitDir });
    assert.deepEqual(nonGitBranches, { ok: true, isGitRepo: false, currentBranch: null, branches: [] });

    const nonGitWts = await call('git:worktree-list', { cwd: nonGitDir });
    assert.deepEqual(nonGitWts, { ok: true, isGitRepo: false, worktrees: [] });

    // Initialize real Git repo.
    runGitSync(['init'], repoDir);
    runGitSync(['config', 'user.name', 'Test Bot'], repoDir);
    runGitSync(['config', 'user.email', 'test@example.com'], repoDir);
    // Avoid autocrlf altering diffs on Windows during assertions.
    runGitSync(['config', 'core.autocrlf', 'false'], repoDir);

    const fileA = join(repoDir, 'hello.txt');
    writeFileSync(fileA, 'line1\nline2\n', 'utf8');

    const status1 = await call('git:status', { cwd: repoDir });
    assert.equal(status1.ok, true);
    assert.equal(status1.isGitRepo, true);
    assert.equal(status1.entries.length, 1);
    assert.equal(status1.entries[0]?.path, 'hello.txt');
    assert.equal(status1.entries[0]?.untracked, true);

    // Diff for untracked file should still produce unified diff via --no-index.
    const untrackedDiff = await call('git:diff', { cwd: repoDir, path: 'hello.txt' });
    assert.equal(untrackedDiff.ok, true);
    assert.match(untrackedDiff.diff, /\+line1/);

    // Stage -> diff(staged) -> unstage -> stage(all) -> commit.
    assert.deepEqual(await call('git:stage', { cwd: repoDir, paths: ['hello.txt'] }), { ok: true });
    const stagedDiff = await call('git:diff', { cwd: repoDir, path: 'hello.txt', staged: true });
    assert.equal(stagedDiff.ok, true);
    assert.match(stagedDiff.diff, /\+line1/);

    assert.deepEqual(await call('git:unstage', { cwd: repoDir, paths: ['hello.txt'] }), { ok: true });
    const statusAfterUnstage = await call('git:status', { cwd: repoDir });
    assert.equal(statusAfterUnstage.entries[0]?.untracked, true);

    assert.deepEqual(await call('git:stage', { cwd: repoDir, all: true }), { ok: true });
    const commitRes = await call('git:commit', { cwd: repoDir, message: 'initial commit' });
    assert.equal(commitRes.ok, true);
    assert.ok(commitRes.commitHash);
    const initialBranch = commitRes.branch;
    assert.ok(initialBranch);

    // Modify tracked file + create untracked file -> verify discard restores tracked and removes untracked.
    writeFileSync(fileA, 'line1\nmodified\n', 'utf8');
    const scratch = join(repoDir, 'scratch.tmp');
    writeFileSync(scratch, 'temp\n', 'utf8');

    const modDiff = await call('git:diff', { cwd: repoDir, path: 'hello.txt' });
    assert.equal(modDiff.ok, true);
    assert.match(modDiff.diff, /-line2\r?\n\+modified/);

    const wholeDiff = await call('git:diff', { cwd: repoDir });
    assert.equal(wholeDiff.ok, true);
    assert.equal(wholeDiff.path, null);
    assert.match(wholeDiff.diff, /hello\.txt/);

    const discardRes = await call('git:discard', { cwd: repoDir, paths: ['hello.txt', 'scratch.tmp'] });
    assert.deepEqual(discardRes, {
      ok: true,
      restored: ['hello.txt'],
      removed: ['scratch.tmp'],
    });
    assert.equal(readFileSync(fileA, 'utf8'), 'line1\nline2\n');
    assert.equal(existsSync(scratch), false);

    // Multiline UTF-8 commit message.
    writeFileSync(fileA, 'line1\nline2\n中文内容\n', 'utf8');
    assert.deepEqual(await call('git:stage', { cwd: repoDir, paths: ['hello.txt'] }), { ok: true });
    const utf8Commit = await call('git:commit', {
      cwd: repoDir,
      message: 'feat: 支持中文提交\n\n第二行详细说明',
    });
    assert.equal(utf8Commit.ok, true);
    assert.match(runGitSync(['log', '-1', '--pretty=%B'], repoDir), /支持中文提交/);

    // Branch creation with startPoint & checkout.
    assert.deepEqual(
      await call('git:checkout', {
        cwd: repoDir,
        branch: 'feat/phase3',
        create: true,
        startPoint: initialBranch,
      }),
      { ok: true },
    );
    const branchesRes = await call('git:branches', { cwd: repoDir });
    assert.equal(branchesRes.ok, true);
    assert.equal(branchesRes.currentBranch, 'feat/phase3');
    assert.ok(branchesRes.branches.some((b) => b.name === 'feat/phase3' && b.current));
    assert.ok(branchesRes.branches.some((b) => b.name === initialBranch && !b.current));

    assert.deepEqual(
      await call('git:checkout', { cwd: repoDir, branch: initialBranch }),
      { ok: true },
    );

    // Worktree add / list / remove (including calling remove while cwd IS the linked worktree).
    const addWtRes = await call('git:worktree-add', {
      cwd: repoDir,
      worktreePath: wtDir,
      newBranch: 'wt-branch',
    });
    assert.equal(addWtRes.ok, true);
    assert.ok(existsSync(join(wtDir, 'hello.txt')));

    const wtListRes = await call('git:worktree-list', { cwd: repoDir });
    assert.equal(wtListRes.ok, true);
    assert.equal(wtListRes.worktrees.length, 2);
    const mainWt = wtListRes.worktrees.find((w) => w.isMainWorktree);
    const linkedWt = wtListRes.worktrees.find((w) => !w.isMainWorktree);
    assert.ok(mainWt);
    assert.ok(linkedWt);
    assert.equal(linkedWt.branch, 'wt-branch');

    // Main worktree removal is forbidden.
    const rmMainRes = await call('git:worktree-remove', {
      cwd: repoDir,
      worktreePath: mainWt.path,
    });
    assert.equal(rmMainRes.ok, false);

    // Linked worktree removal succeeds even when cwd is the linked worktree itself.
    const rmLinkedRes = await call('git:worktree-remove', {
      cwd: wtDir,
      worktreePath: wtDir,
    });
    assert.equal(rmLinkedRes.ok, true);

    const wtListAfter = await call('git:worktree-list', { cwd: repoDir });
    assert.equal(wtListAfter.worktrees.length, 1);

    // Security rejections via IPC.
    assert.equal((await call('git:inspect', { cwd: '\\\\attacker.example\\share' })).ok, false);
    assert.equal((await call('git:stage', { cwd: repoDir, paths: ['../outside.txt'] })).ok, false);
    assert.equal((await call('git:discard', { cwd: repoDir, paths: ['../outside.txt'] })).ok, false);
    assert.equal((await call('git:checkout', { cwd: repoDir, branch: '--track' })).ok, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});

test('workspace-fs IPC lists sorted trees safely, reads/caps files, and blocks traversal/symlinks/UNC', async (t) => {
  const baseDir = mkdtempSync(join(tmpdir(), 'aha-phase3-fs-'));
  const rootDir = join(baseDir, 'workspace');
  const outsideDir = join(baseDir, 'outside');

  try {
    mkdirSync(join(rootDir, '.git'), { recursive: true });
    mkdirSync(join(rootDir, 'src'), { recursive: true });
    mkdirSync(outsideDir, { recursive: true });

    writeFileSync(join(rootDir, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
    writeFileSync(join(rootDir, '.env'), 'SECRET=1\n', 'utf8');
    writeFileSync(join(rootDir, 'src', 'index.ts'), 'export const ok = true;\n', 'utf8');
    writeFileSync(join(rootDir, 'file2.txt'), 'two\n', 'utf8');
    writeFileSync(join(rootDir, 'file10.txt'), 'ten\n', 'utf8');
    writeFileSync(join(rootDir, 'large.txt'), 'a'.repeat(4096), 'utf8');
    writeFileSync(join(rootDir, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    writeFileSync(join(outsideDir, 'secret.txt'), 'top-secret', 'utf8');

    // Junction works without elevated privileges on Windows; use dir symlink on POSIX.
    const linkPath = join(rootDir, 'escape-link');
    symlinkSync(outsideDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');

    const { call } = createIpcHarness(t, registerWorkspaceFsIpc);

    // Root listing: .git always excluded, .env hidden by default, escaping symlink excluded, directories first + numeric sort.
    const treeDefault = await call('workspace-fs:list-tree', { rootPath: rootDir });
    assert.equal(treeDefault.ok, true);
    assert.deepEqual(
      treeDefault.entries.map((e) => `${e.kind}:${e.name}`),
      ['directory:src', 'file:blob.bin', 'file:file2.txt', 'file:file10.txt', 'file:large.txt'],
    );
    assert.equal(treeDefault.truncated, false);

    // showHidden reveals .env, but .git remains excluded.
    const treeHidden = await call('workspace-fs:list-tree', { rootPath: rootDir, showHidden: true });
    assert.equal(treeHidden.ok, true);
    assert.ok(treeHidden.entries.some((e) => e.name === '.env'));
    assert.ok(!treeHidden.entries.some((e) => e.name === '.git'));

    // Relative subdirectory listing.
    const subTree = await call('workspace-fs:list-tree', { rootPath: rootDir, relativePath: 'src' });
    assert.equal(subTree.ok, true);
    assert.equal(subTree.relativePath, 'src');
    assert.deepEqual(subTree.entries.map((e) => e.relativePath), ['src/index.ts']);

    // Read relative and absolute file paths.
    const readRel = await call('workspace-fs:read-file', {
      rootPath: rootDir,
      filePath: 'src/index.ts',
    });
    assert.equal(readRel.ok, true);
    assert.equal(readRel.binary, false);
    assert.equal(readRel.content, 'export const ok = true;\n');
    assert.equal(readRel.truncated, false);

    const readAbs = await call('workspace-fs:read-file', {
      rootPath: rootDir,
      filePath: join(rootDir, 'file2.txt'),
    });
    assert.equal(readAbs.ok, true);
    assert.equal(readAbs.relativePath, 'file2.txt');
    assert.equal(readAbs.content, 'two\n');

    // Binary sniffing and truncation.
    const readBin = await call('workspace-fs:read-file', {
      rootPath: rootDir,
      filePath: 'blob.bin',
    });
    assert.equal(readBin.ok, true);
    assert.equal(readBin.binary, true);
    assert.equal(readBin.content, null);

    const readCapped = await call('workspace-fs:read-file', {
      rootPath: rootDir,
      filePath: 'large.txt',
      maxBytes: 1024,
    });
    assert.equal(readCapped.ok, true);
    assert.equal(readCapped.truncated, true);
    assert.equal(readCapped.content.length, 1024);
    assert.equal(readCapped.size, 4096);

    // Security boundaries: traversal, outside absolute path, symlink escape, UNC/device, directory read.
    assert.equal((await call('workspace-fs:list-tree', { rootPath: rootDir, relativePath: '../outside' })).ok, false);
    assert.equal((await call('workspace-fs:list-tree', { rootPath: rootDir, relativePath: 'escape-link' })).ok, false);
    assert.equal((await call('workspace-fs:read-file', { rootPath: rootDir, filePath: '../outside/secret.txt' })).ok, false);
    assert.equal((await call('workspace-fs:read-file', { rootPath: rootDir, filePath: join(outsideDir, 'secret.txt') })).ok, false);
    assert.equal((await call('workspace-fs:read-file', { rootPath: rootDir, filePath: 'escape-link/secret.txt' })).ok, false);
    assert.equal((await call('workspace-fs:read-file', { rootPath: '\\\\attacker.example\\share', filePath: 'a.txt' })).ok, false);
    assert.equal((await call('workspace-fs:read-file', { rootPath: rootDir, filePath: '\\\\.\\pipe\\test' })).ok, false);
    assert.equal((await call('workspace-fs:read-file', { rootPath: rootDir, filePath: 'src' })).ok, false);
  } finally {
    rmSync(baseDir, { recursive: true, force: true });
  }
});
