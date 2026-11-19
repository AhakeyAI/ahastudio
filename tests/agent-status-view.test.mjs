import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const modDir = mkdtempSync(join(tmpdir(), 'aha-phase4-ui-'));
test.after(() => rmSync(modDir, { recursive: true, force: true }));

async function load(rel, name) {
  const source = await readFile(new URL(rel, import.meta.url), 'utf8');
  const js = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText;
  const out = join(modDir, name);
  writeFileSync(out, js, 'utf8');
  return import(pathToFileURL(out).href);
}

const view = await load('../src/lib/agent-status-view.ts', 'agent-status-view.mjs');
const git = await load('../src/lib/git-panel-model.ts', 'git-panel-model.mjs');

const status = (over = {}) => ({
  ptyId: 'local-a',
  agentId: 'claude',
  state: 'working',
  source: 'hook',
  subagents: [],
  unread: false,
  stateStartedAt: 1000,
  updatedAt: 1000,
  ...over,
});

test('labels and details describe each lifecycle state', () => {
  assert.equal(view.agentStatusLabel(status()), '运行中');
  assert.equal(
    view.agentStatusLabel(status({ subagents: [{ id: 's', state: 'working', startedAt: 1 }, { id: 't', state: 'idle', startedAt: 1 }] })),
    '运行中 · 1 个子任务',
  );
  assert.equal(view.agentStatusLabel(status({ state: 'waiting', waitKind: 'permission' })), '等待确认');
  assert.equal(view.agentStatusLabel(status({ state: 'waiting', waitKind: 'question' })), '等待回答');
  assert.equal(view.agentStatusLabel(status({ state: 'waiting', waitKind: 'auth' })), '需要登录');
  assert.equal(view.agentStatusLabel(status({ state: 'done' })), '已完成');
  assert.equal(view.agentStatusLabel(status({ state: 'error' })), '出错');
  assert.equal(
    view.agentStatusDetail(status({ toolName: 'Bash', toolInput: 'npm   test\n--watch', progress: 0.42, message: 'ok' })),
    'Bash: npm test --watch · 42% · ok',
  );
  assert.equal(view.agentStatusDetail(status({ progress: 87 })), '87%');
  assert.equal(view.agentDisplayName('codex'), 'Codex');
  assert.equal(view.agentDisplayName('grok'), 'Grok');
  assert.equal(view.agentDisplayName('grok-build'), 'Grok');
  assert.equal(view.agentDisplayName(null), 'Agent');
  assert.match(view.agentStatusTooltip(status({ state: 'done' }), 1000 + 65_000), /已持续 1 分 5 秒/);
});

test('idle panes stay hidden unless unread', () => {
  assert.equal(view.isAgentStatusVisible(status({ state: 'idle' })), false);
  assert.equal(view.isAgentStatusVisible(status({ state: 'idle', unread: true })), true);
  assert.equal(view.isAgentStatusVisible(null), false);
});

test('pickAttentionStatus prefers waiting > error > working > done, then unread, then recency', () => {
  const working = status({ ptyId: 'w', state: 'working', updatedAt: 5 });
  const done = status({ ptyId: 'd', state: 'done', unread: true, updatedAt: 9 });
  const waiting = status({ ptyId: 'q', state: 'waiting', updatedAt: 1 });
  const error = status({ ptyId: 'e', state: 'error', updatedAt: 2 });
  assert.equal(view.pickAttentionStatus([working, done, waiting, error]).ptyId, 'q');
  assert.equal(view.pickAttentionStatus([working, done, error]).ptyId, 'e');
  assert.equal(view.pickAttentionStatus([done, working]).ptyId, 'w');
  assert.equal(
    view.pickAttentionStatus([status({ ptyId: 'old', state: 'done', updatedAt: 1 }), status({ ptyId: 'new', state: 'done', updatedAt: 2 })]).ptyId,
    'new',
  );
  assert.equal(view.pickAttentionStatus([status({ state: 'idle' }), null, undefined]), null);
});

test('attention transitions fire once per new unread waiting/done/error state', () => {
  const waiting = status({ state: 'waiting', waitKind: 'permission', unread: true });
  assert.equal(view.isAttentionTransition(undefined, waiting), true);
  assert.equal(view.isAttentionTransition(waiting, { ...waiting, updatedAt: 2000 }), false);
  assert.equal(view.isAttentionTransition(waiting, { ...waiting, waitKind: 'question' }), true);
  assert.equal(view.isAttentionTransition(status({ state: 'done', unread: false }), status({ state: 'done', unread: true })), true);
  assert.equal(view.isAttentionTransition(undefined, status({ state: 'working', unread: true })), false);
  assert.equal(view.isAttentionTransition(undefined, status({ state: 'done', unread: false })), false);
});

test('buildDiffSnippet keeps diff prefixes and reports new-file line ranges', () => {
  const rows = git.parseUnifiedDiff(
    ['diff --git a/x b/x', '--- a/x', '+++ b/x', '@@ -10,3 +10,3 @@', ' keep', '-old', '+new', ' tail', '@@ -40 +40 @@', '-gone', '+here'].join('\n'),
  );
  const all = view.buildDiffSnippet(rows);
  assert.equal(all.snippet, ['@@ -10,3 +10,3 @@', ' keep', '-old', '+new', ' tail', '@@ -40 +40 @@', '-gone', '+here'].join('\n'));
  assert.equal(all.startLine, undefined);
  const sel = view.buildDiffSnippet(rows, 6, 4);
  assert.deepEqual(sel, { snippet: ' keep\n-old\n+new', startLine: 10, endLine: 11, rowCount: 3 });
  const delOnly = view.buildDiffSnippet(rows, 5, 5);
  assert.deepEqual([delOnly.startLine, delOnly.endLine], [11, 11]);
});

test('fitPromptParts trims the snippet on line boundaries to the PTY byte limit', () => {
  const big = Array.from({ length: 400 }, (_, i) => `+第 ${i} 行内容内容内容`).join('\n');
  const fitted = view.fitPromptParts({ prompt: '请检查', filePath: 'src/a.ts', diffSnippet: big }, 2048);
  assert.equal(fitted.truncated, true);
  assert.equal(fitted.overLimit, false);
  assert.match(fitted.diffSnippet, /… \(已截断\)$/);
  const total = view.utf8Bytes('请检查') + view.utf8Bytes('src/a.ts') + view.utf8Bytes(fitted.diffSnippet) + 96;
  assert.ok(total <= 2048, `framed size ${total}`);
  for (const line of fitted.diffSnippet.split('\n').slice(0, -1)) assert.match(line, /^\+第 \d+ 行内容内容内容$/);
  assert.deepEqual(view.fitPromptParts({ prompt: 'x', diffSnippet: 'small' }), { diffSnippet: 'small', truncated: false, overLimit: false });
  assert.equal(view.fitPromptParts({ prompt: 'x'.repeat(9000) }).overLimit, true);
});

test('fitted prompt really fits after backend framing', async () => {
  const { formatAgentPromptPayload } = await import('../dist-electron/agent/agent-prompt-delivery.js');
  const prompt = '解释这段改动';
  const filePath = 'src/components/很长的路径/Example.tsx';
  const snippet = Array.from({ length: 2000 }, (_, i) => `+const v${i} = "值${i}";`).join('\n');
  const fitted = view.fitPromptParts({ prompt, filePath, diffSnippet: snippet });
  const framed = formatAgentPromptPayload({ prompt, filePath, startLine: 120, endLine: 999, diffSnippet: fitted.diffSnippet });
  assert.ok(Buffer.byteLength(framed, 'utf8') <= 8192, `framed ${Buffer.byteLength(framed, 'utf8')}`);
});

test('relativeFromDir maps targets into the agent cwd', () => {
  assert.equal(view.relativeFromDir('C:\\repo', 'C:\\Repo\\src\\a.ts'), 'src/a.ts');
  assert.equal(view.relativeFromDir('C:\\repo\\src', 'C:\\repo\\src\\a.ts'), 'a.ts');
  assert.equal(view.relativeFromDir('C:\\repo\\src', 'C:\\repo\\README.md'), null);
  assert.equal(view.relativeFromDir('/home/u/repo', '/home/u/repo/x/y.ts'), 'x/y.ts');
  assert.equal(view.relativeFromDir('/home/u/repo', '/home/u/Repo/x.ts'), null);
  assert.equal(view.ptyIdForLeaf('sw-1-2'), 'local-sw-1-2');
});
