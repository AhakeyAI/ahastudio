import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'aha-turn-changes-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const source = readFileSync(new URL('../src/lib/turn-changes.ts', import.meta.url), 'utf8');
const file = join(dir, 'turn-changes.mjs');
writeFileSync(file, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const lib = await import(pathToFileURL(file).href);

const change = (path, kind, added, removed, extra = {}) => ({
  path, change: kind, movePath: null, diff: `@@ ${path} ${kind}`, truncated: false, added, removed, ...extra,
});
const fileItem = (id, files, status = 'completed') => ({ id, kind: 'file_change', status, files, startedAt: 1, completedAt: 2 });

test('a turn summary merges repeated edits per file and keeps each diff', () => {
  const summary = lib.summarizeTurnChanges([
    fileItem('f1', [change('C:\\repo\\src\\a.ts', 'update', 4, 2), change('C:/repo/src/new.ts', 'add', 3, 0)]),
    { id: 'm', kind: 'message', role: 'assistant', status: 'completed', text: 'x' },
    fileItem('f2', [change('c:/REPO/src/a.ts', 'update', 1, 1)]),
    fileItem('f3', [change('C:/repo/src/new.ts', 'update', 2, 0)]),
  ], 'C:/repo');
  assert.deepEqual(summary.files.map((f) => [f.displayPath, f.change, f.added, f.removed, f.parts.length]), [
    ['src/a.ts', 'update', 5, 3, 2],
    ['src/new.ts', 'add', 5, 0, 2],
  ]);
  assert.deepEqual([summary.added, summary.removed], [10, 3]);
  assert.equal(summary.files[0].path, 'C:\\repo\\src\\a.ts', 'the first reported path opens the file');
});

test('declined and failed edits are left out, and a file created then deleted nets out', () => {
  const summary = lib.summarizeTurnChanges([
    fileItem('f1', [change('tmp.txt', 'add', 2, 0)]),
    fileItem('f2', [change('denied.ts', 'update', 9, 9)], 'declined'),
    fileItem('f3', [change('broken.ts', 'update', 9, 9)], 'failed'),
    fileItem('f4', [change('tmp.txt', 'delete', 0, 2), change('old.ts', 'update', 1, 0)]),
    fileItem('f5', [change('old.ts', 'delete', 0, 5)]),
  ], null);
  assert.deepEqual(summary.files.map((f) => [f.displayPath, f.change]), [['old.ts', 'delete']]);
  assert.deepEqual(lib.summarizeTurnChanges([], 'C:/repo'), { files: [], added: 0, removed: 0 });
});

test('a moved file shows under its new path', () => {
  const summary = lib.summarizeTurnChanges([fileItem('f', [change('/w/a.ts', 'update', 1, 0, { movePath: '/w/lib/b.ts' })])], '/w');
  assert.equal(summary.files[0].displayPath, 'lib/b.ts');
  assert.equal(lib.relativeToCwd('/elsewhere/x.ts', '/w'), '/elsewhere/x.ts', 'paths outside the folder stay absolute');
  assert.equal(lib.relativeToCwd('./x.ts', null), 'x.ts');
  assert.equal(lib.relativeToCwd('/w2/x.ts', '/w'), '/w2/x.ts', 'a sibling with a shared prefix is not inside');
});

test('the change tree lists folders first, compacts single-folder chains, and sums stats', () => {
  const { files } = lib.summarizeTurnChanges([fileItem('f', [
    change('src/auth/session.ts', 'update', 4, 2),
    change('src/auth/expiry.ts', 'add', 3, 0),
    change('README.md', 'update', 1, 0),
    change('docs/guide/deep/one.md', 'update', 2, 1),
  ])]);
  const tree = lib.buildChangeTree(files);
  const shape = (nodes) => nodes.map((n) => n.kind === 'directory'
    ? { dir: n.name, stat: `${n.stat.added}/${n.stat.removed}`, children: shape(n.children) }
    : n.name);
  assert.deepEqual(shape(tree), [
    { dir: 'docs/guide/deep', stat: '2/1', children: ['one.md'] },
    { dir: 'src/auth', stat: '7/2', children: ['expiry.ts', 'session.ts'] },
    'README.md',
  ]);
});

test('diff counts are compact', () => {
  assert.equal(lib.formatDiffCount(999), '999');
  assert.equal(lib.formatDiffCount(1_234), '1.2k');
  assert.equal(lib.formatDiffCount(1_000), '1k');
  assert.equal(lib.formatDiffCount(45_600), '46k');
  assert.equal(lib.formatDiffCount(2_500_000), '2.5m');
});
