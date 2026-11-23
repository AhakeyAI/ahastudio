import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'aha-composer-tokens-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const source = readFileSync(new URL('../src/lib/composer-tokens.ts', import.meta.url), 'utf8');
const file = join(dir, 'composer-tokens.mjs');
writeFileSync(file, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const tokens = await import(pathToFileURL(file).href);

test('a $ or @ token at the caret opens a trigger only where a word starts', () => {
  assert.deepEqual(tokens.detectTrigger('use $pdf', 8), { kind: 'skill', query: 'pdf', start: 4, end: 8 });
  assert.deepEqual(tokens.detectTrigger('$', 1), { kind: 'skill', query: '', start: 0, end: 1 });
  assert.deepEqual(tokens.detectTrigger('see @src/ma please', 11), { kind: 'file', query: 'src/ma', start: 4, end: 11 });
  // The caret in the middle of a token still covers the whole token for replacement.
  assert.deepEqual(tokens.detectTrigger('@src/main.ts x', 4), { kind: 'file', query: 'src', start: 0, end: 12 });
  assert.equal(tokens.detectTrigger('price is US$5', 13), null, 'a $ inside a word is not a trigger');
  assert.equal(tokens.detectTrigger('mail me@host', 12), null, 'an @ inside a word is not a trigger');
  assert.equal(tokens.detectTrigger('$a b', 4), null, 'the caret after whitespace has no trigger');
  assert.equal(tokens.detectTrigger('$(rm -rf)', 3), null, 'shell-like $ text is not a skill query');
});

test('a completion replaces the token, adds one space, and puts the caret after it', () => {
  const trigger = tokens.detectTrigger('ask $pd now', 7);
  assert.deepEqual(tokens.applyCompletion('ask $pd now', trigger, '$pdf'), { text: 'ask $pdf now', caret: 9 });
  const end = tokens.detectTrigger('open @ma', 8);
  assert.deepEqual(tokens.applyCompletion('open @ma', end, tokens.fileMention('src/main.ts')), {
    text: 'open @src/main.ts ', caret: 18,
  });
  assert.equal(tokens.fileMention('docs/My Notes.md'), '@"docs/My Notes.md"');
});

test('only skills still named as $name in the text are sent', () => {
  const skills = [{ name: 'pdf' }, { name: 'doc-writer' }, { name: 'app:Search' }];
  assert.deepEqual(tokens.skillsInText('use $pdf and $app:Search.', skills).map((s) => s.name), ['pdf', 'app:Search']);
  assert.deepEqual(tokens.skillsInText('$pdfx is not $pdf', skills).map((s) => s.name), ['pdf']);
  assert.deepEqual(tokens.skillsInText('no skills here', skills), []);
  assert.deepEqual(tokens.skillsInText('写一份$doc-writer', skills), [], 'the token must start a word');
});

test('skill suggestions list enabled skills, name prefix matches first', () => {
  const skill = (name, description = '', enabled = true) => ({ name, description, enabled, path: `/s/${name}`, scope: 'user', pluginId: null });
  const list = [skill('spreadsheets'), skill('pdf', 'Read PDFs'), skill('docs', 'Write pdf reports'), skill('pdf-off', '', false), skill('mypdf')];
  assert.deepEqual(tokens.filterSkills(list, 'pdf').map((s) => s.name), ['pdf', 'mypdf', 'docs']);
  assert.deepEqual(tokens.filterSkills(list, '').map((s) => s.name), ['docs', 'mypdf', 'pdf', 'spreadsheets']);
  assert.equal(tokens.filterSkills(list, '', 2).length, 2);
});

test('the model choice falls back to the default model and to an effort the model supports', () => {
  const models = [
    { id: 'small', model: 'small', isDefault: false, efforts: [{ value: 'low' }], defaultEffort: 'low' },
    { id: 'big', model: 'big', isDefault: true, efforts: [{ value: 'low' }, { value: 'high' }], defaultEffort: 'high' },
  ];
  assert.deepEqual(tokens.resolveModelChoice(models, null, null), { model: models[1], effort: 'high' });
  assert.deepEqual(tokens.resolveModelChoice(models, 'small', 'high'), { model: models[0], effort: 'low' });
  assert.deepEqual(tokens.resolveModelChoice(models, 'big', 'low'), { model: models[1], effort: 'low' });
  assert.deepEqual(tokens.resolveModelChoice(models, 'hidden-from-config', 'high'), { model: null, effort: 'high' },
    'a model the catalog does not list is not replaced by the default');
  assert.deepEqual(tokens.resolveModelChoice([], 'x', 'low'), { model: null, effort: 'low' });
  assert.equal(tokens.effortLabel('xhigh'), '很高');
  assert.equal(tokens.effortLabel(null), '默认');
  assert.equal(tokens.effortLabel('turbo'), 'turbo');
});
