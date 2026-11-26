import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import ts from 'typescript';

function compile(file) {
  return ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React },
  }).outputText.replace(/^import .*;$/gm, '').replaceAll('export function ', 'function ');
}
const KimiIcon = new Function('React', compile('../src/components/TerminalBrandIcons.tsx') + '\nreturn KimiIcon;')(React);
const unusedIcon = () => React.createElement('svg', { 'data-fallback': true });
const TerminalProfileIcon = new Function(
  'React', 'KimiIcon', 'BackendAvatar', 'Terminal', 'GitBranch',
  'ClaudeIcon', 'GeminiIcon', 'OpenAIIcon', 'OpenCodeIcon', 'PiIcon', 'QwenIcon',
  compile('../src/components/TerminalProfileIcon.tsx') + '\nreturn TerminalProfileIcon;',
)(React, KimiIcon, unusedIcon, ...Array(8).fill(unusedIcon));

test('Kimi CLI uses the native striped moon at every requested CLI icon size', () => {
  for (const size of [12, 13, 14, 16, 24, 56]) {
    const html = renderToStaticMarkup(React.createElement(TerminalProfileIcon, { id: 'kimi', size }));
    assert.match(html, /class="kimi-icon"/);
    assert.match(html, new RegExp(`height="${size}" width="${size}"`));
    assert.match(html, /viewBox="0 0 28 28"/);
    assert.match(html, /fill-rule="evenodd"/);
    assert.match(html, /aria-hidden="true"/);
    assert.match(html, /focusable="false"/);
    assert.doesNotMatch(html, /<img|data-fallback|kimi\.jpeg/);
  }
});

test('the decorative Kimi CLI icon preserves its visible accessible menu label', () => {
  const html = renderToStaticMarkup(React.createElement('button', { role: 'menuitem' },
    React.createElement(TerminalProfileIcon, { id: 'kimi' }), React.createElement('span', null, 'Kimi CLI')));
  assert.match(html, /<span>Kimi CLI<\/span>/);
  assert.doesNotMatch(html, /alt=|aria-label=/);
});
