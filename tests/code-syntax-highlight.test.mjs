import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CODE_HIGHLIGHT_MAX_CHARS,
  CODE_HIGHLIGHT_MAX_LINE_LENGTH,
  detectCodeLanguage,
  ensureCodeLanguageLoaded,
  tokenizeCodeLinesSync,
  tokenizeDiffRowsSync,
} from '../src/lib/code-syntax-highlight.ts';

test('detectCodeLanguage resolves extensions, Windows paths, and special filenames', () => {
  assert.equal(detectCodeLanguage('src\\components\\PanelPreview.tsx'), 'tsx');
  assert.equal(detectCodeLanguage('C:\\repo\\src\\main.rs'), 'rust');
  assert.equal(detectCodeLanguage('scripts/deploy.ps1'), 'powershell');
  assert.equal(detectCodeLanguage('Dockerfile'), 'dockerfile');
  assert.equal(detectCodeLanguage('docker/Dockerfile.prod'), 'dockerfile');
  assert.equal(detectCodeLanguage('tsconfig.electron.json'), 'jsonc');
  assert.equal(detectCodeLanguage('.gitignore'), 'shellscript');
  assert.equal(detectCodeLanguage('.env.local'), 'dotenv');
  assert.equal(detectCodeLanguage('notes.txt'), null);
  assert.equal(detectCodeLanguage('README'), null);
  assert.equal(detectCodeLanguage('binary.unknownext'), null);
  assert.equal(detectCodeLanguage('   '), null);
});

test('tokenizeCodeLinesSync waits for language load then highlights while preserving line text', async () => {
  const sample = [
    '// greeting',
    "export const msg = 'hello';",
    '',
    'const n = 42;',
  ];

  // Python is not loaded yet; should gracefully return null.
  assert.equal(tokenizeCodeLinesSync(['x = 1'], 'python'), null);

  const loaded = await ensureCodeLanguageLoaded('typescript');
  assert.equal(loaded, true);

  const tokens = tokenizeCodeLinesSync(sample, 'typescript');
  assert.ok(tokens);
  assert.equal(tokens.length, sample.length);
  assert.deepEqual(
    tokens.map((line) => line.map((t) => t.text).join('')),
    sample
  );

  // Light+ comment green (#008000), keyword/const blue (#0000FF), string red (#A31515), numeric (#098658)
  assert.equal(tokens[0].find((t) => t.text.includes('greeting'))?.color, '#008000');
  assert.equal(tokens[1].find((t) => t.text === 'const')?.color, '#0000FF');
  assert.equal(tokens[1].find((t) => t.text === "'hello'")?.color, '#A31515');
  assert.equal(tokens[3].find((t) => t.text === '42')?.color, '#098658');
  assert.deepEqual(tokens[2], []);
});

test('tokenizeCodeLinesSync guards oversized lines and char budget without dropping lines', async () => {
  await ensureCodeLanguageLoaded('typescript');
  const hugeLine = 'a'.repeat(CODE_HIGHLIGHT_MAX_LINE_LENGTH + 200);
  const lines = [hugeLine, 'const ok = 1;'];
  const tokens = tokenizeCodeLinesSync(lines, 'typescript');
  assert.ok(tokens);
  assert.equal(tokens.length, 2);
  assert.equal(tokens[0].map((t) => t.text).join(''), hugeLine);
  assert.equal(tokens[1].find((t) => t.text === 'const')?.color, '#0000FF');

  const padLine = 'x'.repeat(1000);
  const count = Math.ceil(CODE_HIGHLIGHT_MAX_CHARS / 1000) + 10;
  const manyLines = ['const head = 1;', ...Array.from({ length: count }, () => padLine), 'const tail = 2;'];
  const budgeted = tokenizeCodeLinesSync(manyLines, 'typescript');
  assert.ok(budgeted);
  assert.equal(budgeted.length, manyLines.length);
  assert.equal(budgeted.at(-1)?.map((t) => t.text).join(''), 'const tail = 2;');
});

test('tokenizeDiffRowsSync skips headers and isolates del/add grammar state inside hunks', async () => {
  await ensureCodeLanguageLoaded('typescript');
  const rows = [
    { kind: 'file', text: 'diff --git a/a.ts b/a.ts' },
    { kind: 'meta', text: 'index 111..222 100644' },
    { kind: 'hunk', text: '@@ -1,2 +1,2 @@' },
    { kind: 'del', text: '/* unclosed block comment in deleted code' },
    { kind: 'add', text: 'const afterAdd = 42;' },
    { kind: 'context', text: 'const keep = true;' },
    { kind: 'note', text: '\\ No newline at end of file' },
  ];

  const tokenRows = tokenizeDiffRowsSync(rows, 'typescript');
  assert.ok(tokenRows);
  assert.equal(tokenRows[0], null);
  assert.equal(tokenRows[1], null);
  assert.equal(tokenRows[2], null);
  assert.equal(tokenRows[6], null);

  assert.equal(tokenRows[3]?.[0]?.color, '#008000');
  assert.equal(tokenRows[4]?.find((t) => t.text === 'const')?.color, '#0000FF');
  assert.equal(tokenRows[5]?.find((t) => t.text === 'const')?.color, '#0000FF');
  assert.equal(tokenRows[4]?.map((t) => t.text).join(''), 'const afterAdd = 42;');
});

test('tokenizeCodeLinesSync and tokenizeDiffRowsSync switch to dark-plus palette in dark mode', async () => {
  await ensureCodeLanguageLoaded('typescript');
  const sample = ['// note', "const msg = 'hi';", 'const num = 7;'];

  const light = tokenizeCodeLinesSync(sample, 'typescript', 'light');
  const dark = tokenizeCodeLinesSync(sample, 'typescript', 'dark');
  assert.ok(light && dark);

  assert.equal(dark[0].find((t) => t.text.includes('note'))?.color, '#6A9955');
  assert.equal(dark[1].find((t) => t.text === 'const')?.color, '#569CD6');
  assert.equal(dark[1].find((t) => t.text === "'hi'")?.color, '#CE9178');
  assert.equal(dark[2].find((t) => t.text === '7')?.color, '#B5CEA8');
  assert.notEqual(
    dark[1].find((t) => t.text === 'const')?.color,
    light[1].find((t) => t.text === 'const')?.color
  );
  // Default dark-plus foreground (#D4D4D4) should be omitted so tokens inherit --wrp-ink.
  assert.equal(dark[2].find((t) => t.text.includes('='))?.color, undefined);

  const diffTokens = tokenizeDiffRowsSync(
    [{ kind: 'add', text: "const greeting = 'ok';" }],
    'typescript',
    'dark'
  );
  assert.ok(diffTokens);
  assert.equal(diffTokens[0]?.find((t) => t.text === 'const')?.color, '#569CD6');
  assert.equal(diffTokens[0]?.find((t) => t.text === "'ok'")?.color, '#CE9178');
});
