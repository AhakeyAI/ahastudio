import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'aha-session-title-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const source = readFileSync(new URL('../src/lib/session-title.ts', import.meta.url), 'utf8');
const file = join(dir, 'session-title.mjs');
writeFileSync(file, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const lib = await import(pathToFileURL(file).href);

test('a title edit collapses whitespace and only commits a real change', () => {
  assert.deepEqual(lib.resolveTitleEdit('  拆分\n登录\t\t重构  ', '旧标题'), { action: 'commit', title: '拆分 登录 重构' });
  assert.deepEqual(lib.resolveTitleEdit(' 旧标题 ', '旧标题'), { action: 'noop' });
  assert.deepEqual(lib.resolveTitleEdit(' \n ', '旧标题'), { action: 'reject', error: '标题不能为空' });
});

test('a title edit counts characters, not UTF-16 units, against the limit', () => {
  const emoji = '😀'.repeat(lib.MAX_SESSION_TITLE);
  assert.equal(lib.resolveTitleEdit(emoji, '').action, 'commit');
  assert.deepEqual(lib.resolveTitleEdit(`${emoji}x`, ''), { action: 'reject', error: `标题最多 ${lib.MAX_SESSION_TITLE} 个字` });
});

test('the folder chip shows the last folder of a Windows or POSIX path', () => {
  assert.equal(lib.folderName('C:\\Users\\me\\repo\\'), 'repo');
  assert.equal(lib.folderName('/home/me/project'), 'project');
  assert.equal(lib.folderName('C:\\'), 'C:');
});
