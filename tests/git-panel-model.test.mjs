import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const modDir = mkdtempSync(join(tmpdir(), 'aha-phase3-ui-'));
test.after(() => rmSync(modDir, { recursive: true, force: true }));

async function loadModel() {
  const source = await readFile(new URL('../src/lib/git-panel-model.ts', import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const out = join(modDir, 'git-panel-model.mjs');
  writeFileSync(out, js, 'utf8');
  return import(pathToFileURL(out).href);
}

const m = await loadModel();

const entry = (path, x, y, extra = {}) => ({
  path,
  origPath: null,
  indexStatus: x,
  worktreeStatus: y,
  staged: x !== ' ' && x !== '?' && x !== 'U',
  unstaged: y !== ' ' && y !== '?',
  untracked: x === '?' && y === '?',
  conflicted: false,
  ...extra,
});

test('groups porcelain entries into conflict / staged / changes / untracked sections', () => {
  const groups = m.groupGitStatusEntries([
    entry('src/z.ts', ' ', 'M'),
    entry('src/both.ts', 'M', 'M'),
    entry('src/new.ts', 'A', ' '),
    entry('src/b.ts', 'R', ' ', { origPath: 'src/a.ts' }),
    entry('src/c.ts', 'U', 'U', { conflicted: true, staged: false, unstaged: true }),
    entry('notes.txt', '?', '?', { staged: false, unstaged: false }),
    entry('gone.ts', ' ', 'D'),
  ]);
  assert.deepEqual(groups.conflicts.map((i) => [i.entry.path, i.letter]), [['src/c.ts', '!']]);
  assert.deepEqual(groups.staged.map((i) => [i.entry.path, i.letter]), [
    ['src/b.ts', 'R'],
    ['src/both.ts', 'M'],
    ['src/new.ts', 'A'],
  ]);
  assert.deepEqual(groups.changes.map((i) => [i.entry.path, i.letter]), [
    ['gone.ts', 'D'],
    ['src/both.ts', 'M'],
    ['src/z.ts', 'M'],
  ]);
  assert.deepEqual(groups.untracked.map((i) => [i.entry.path, i.letter]), [['notes.txt', 'U']]);
  const keys = Object.values(groups).flat().map((i) => i.key);
  assert.equal(new Set(keys).size, keys.length, 'MM file must have distinct keys per section');
});

test('tree decorations mark files and every ancestor directory', () => {
  const deco = m.buildTreeDecorations([
    entry('src/lib/a.ts', ' ', 'M'),
    entry('docs/new.md', '?', '?', { staged: false, unstaged: false }),
    entry('README.md', 'A', ' '),
  ]);
  assert.equal(deco.files.get('src/lib/a.ts'), 'M');
  assert.equal(deco.files.get('docs/new.md'), 'U');
  assert.equal(deco.files.get('README.md'), 'A');
  assert.deepEqual([...deco.dirs].sort(), ['docs', 'src', 'src/lib']);
});

test('parseUnifiedDiff assigns line numbers and does not confuse +++/--- content with headers', () => {
  const diff = [
    'diff --git a/x.txt b/x.txt',
    'index 111..222 100644',
    '--- a/x.txt',
    '+++ b/x.txt',
    '@@ -1,3 +1,4 @@ heading',
    ' keep',
    '---removed dashes',
    '+++added pluses',
    '+second',
    ' tail',
    '\\ No newline at end of file',
    'diff --git a/y.txt b/y.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/y.txt',
    '@@ -0,0 +1 @@',
    '+only',
    '',
  ].join('\n');
  const rows = m.parseUnifiedDiff(diff);
  const kinds = rows.map((r) => r.kind);
  assert.deepEqual(kinds, [
    'file', 'meta', 'meta', 'meta', 'hunk',
    'context', 'del', 'add', 'add', 'context', 'note',
    'file', 'meta', 'meta', 'meta', 'hunk', 'add',
  ]);
  const body = rows.slice(5, 10).map((r) => [r.kind, r.text, r.oldLine, r.newLine]);
  assert.deepEqual(body, [
    ['context', 'keep', 1, 1],
    ['del', '--removed dashes', 2, null],
    ['add', '++added pluses', null, 2],
    ['add', 'second', null, 3],
    ['context', 'tail', 3, 4],
  ]);
  assert.deepEqual([rows[16].newLine, rows[16].text], [1, 'only']);
  assert.deepEqual(m.countDiffStats(rows), { added: 3, removed: 1 });
});

test('parseUnifiedDiff handles CRLF and empty context lines', () => {
  const rows = m.parseUnifiedDiff('@@ -1,2 +1,2 @@\r\n-a\r\n+b\r\n\r\n');
  assert.deepEqual(rows.map((r) => [r.kind, r.text, r.oldLine, r.newLine]), [
    ['hunk', '@@ -1,2 +1,2 @@', null, null],
    ['del', 'a', 1, null],
    ['add', 'b', null, 1],
    ['context', '', 2, 2],
  ]);
});

test('isPathInside is separator- and case-insensitive on Windows paths only', () => {
  assert.equal(m.isPathInside('C:\\Repo\\wt', 'c:/repo/wt/src'), true);
  assert.equal(m.isPathInside('C:\\Repo\\wt', 'C:\\Repo\\wt'), true);
  assert.equal(m.isPathInside('C:\\Repo\\wt\\', 'C:\\Repo\\wt'), true);
  assert.equal(m.isPathInside('C:\\Repo\\wt', 'C:\\Repo\\wt-other'), false);
  assert.equal(m.isPathInside('C:\\', 'C:\\x'), true);
  assert.equal(m.isPathInside('/home/a/Repo', '/home/a/repo/x'), false);
  assert.equal(m.isPathInside('/home/a/repo', '/home/a/repo/x'), true);
  assert.equal(m.isPathInside('', '/x'), false);
  assert.equal(m.isSamePath('C:\\Repo\\', 'c:/repo'), true);
  assert.equal(m.isSamePath('C:\\Repo', 'C:\\Repo\\sub'), false);
});

test('worktree path suggestion sits next to the repo and sanitizes the branch', () => {
  assert.equal(m.suggestWorktreePath('C:\\code\\app', 'feature/login ui'), 'C:\\code\\app-feature-login-ui');
  assert.equal(m.suggestWorktreePath('/srv/app/', 'fix:1'), '/srv/app-fix-1');
  assert.equal(m.suggestWorktreePath('/srv/app', '...'), '/srv/app-worktree');
  assert.equal(m.joinHostPath('D:\\wt\\', 'x'), 'D:\\wt\\x');
  assert.equal(m.joinHostPath('/tmp', 'x'), '/tmp/x');
});

test('branch name validation mirrors git check-ref-format basics', () => {
  for (const ok of ['main', 'feature/x', 'fix-1.2', '中文分支']) assert.equal(m.validateBranchName(ok), null, ok);
  for (const bad of ['', ' ', '-x', 'a..b', 'a b', 'x.lock', 'a/', '/a', 'a//b', '@', 'a@{1', 'a~1', 'a:b', '.hidden', 'a/.b', 'x.']) {
    assert.notEqual(m.validateBranchName(bad), null, bad);
  }
});

test('chunkPaths respects the 500-path IPC cap', () => {
  const paths = Array.from({ length: 1201 }, (_, i) => `f${i}`);
  const chunks = m.chunkPaths(paths);
  assert.deepEqual(chunks.map((c) => c.length), [500, 500, 201]);
  assert.deepEqual(chunks.flat(), paths);
  assert.deepEqual(m.chunkPaths([]), []);
});

test('splitRepoPath and formatFileSize helpers', () => {
  assert.deepEqual(m.splitRepoPath('src/lib/a.ts'), { name: 'a.ts', dir: 'src/lib' });
  assert.deepEqual(m.splitRepoPath('a.ts'), { name: 'a.ts', dir: '' });
  assert.deepEqual(m.splitRepoPath('dir/sub/'), { name: 'sub', dir: 'dir' });
  assert.equal(m.formatFileSize(512), '512 B');
  assert.equal(m.formatFileSize(2048), '2.0 KB');
  assert.equal(m.formatFileSize(3 * 1024 * 1024), '3.0 MB');
});
