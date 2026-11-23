import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { build } from 'esbuild';
import { ipcMain } from 'electron';
import { registerShellPtyIpc } from '../dist-electron/ipc/shell-pty.js';
import { buildDispatchPreamble } from '../dist-electron/orchestration/worker-dispatch-preamble.js';

const dir = mkdtempSync(join(tmpdir(), 'aha-agent-session-ui-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

let emitted = 0;
function emit(name, rewrite = (s) => s) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = join(dir, `${name}-${emitted++}.mjs`);
  writeFileSync(file, rewrite(output), 'utf8');
  return pathToFileURL(file).href;
}

const model = await import(emit('worker-timeline-model'));
const anchoring = await import(emit('timeline-scroll-anchoring'));
const paneTreeUrl = emit('terminal-pane-tree');

/** Bundles the real Markdown component with React's server renderer and returns its HTML. */
async function loadMarkdownRenderer() {
  const outfile = join(dir, 'session-markdown.cjs');
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { SessionMarkdown } from './src/components/agent-session/SessionMarkdown.tsx';
        export const render = (text) => renderToStaticMarkup(createElement(SessionMarkdown, { text }));`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'js',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return (mod.default ?? mod).render;
}

/** Bundles SessionComposer with React's server renderer so static chips can be verified. */
async function loadComposerRenderer() {
  const outfile = join(dir, 'session-composer.cjs');
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { SessionComposer } from './src/components/agent-session/SessionComposer.tsx';
        export const render = (props) => renderToStaticMarkup(createElement(SessionComposer, props));`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'js',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  return (mod.default ?? mod).render;
}

/** Loads a fresh stage store whose persistence goes to `disk` instead of the Electron bridge. */
async function loadStageStore(disk) {
  globalThis.__stageTest = {
    browserStore: { setVisible: async () => {}, openTab: async () => null, setActiveTab: async () => {}, closeTab: async () => {}, subscribe: () => () => {}, getSnapshot: () => ({ tabs: [] }) },
    terminalSessionStore: { close: async () => {}, getState: () => ({}) },
  };
  globalThis.window = {
    vibeMeet: {
      workspaceState: {
        get: async () => ({ ok: true, state: disk.state }),
        set: async (state) => { disk.state = structuredClone(state); disk.saves += 1; return { ok: true }; },
      },
    },
  };
  const url = emit('stage-window-store', (s) => s
    .replace("import { browserStore } from './browser-store';", 'const { browserStore } = globalThis.__stageTest;')
    .replace("import { terminalSessionStore } from './terminal-session-store';", 'const { terminalSessionStore } = globalThis.__stageTest;')
    .replace("'./terminal-pane-tree'", JSON.stringify(paneTreeUrl)));
  const { stageWindowStore } = await import(url);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return stageWindowStore;
}

const header = (seq, extra = {}) => ({
  workerHandle: 'codex-worker-1', providerSessionId: 'thread-1', cliId: 'codex', model: 'gpt-5', readOnly: true,
  alive: true, seq, ...extra,
});
const turnHeader = (key, generation, extra = {}) => ({
  key, dispatchId: key.split('#')[0], turnId: null, generation, prompt: 'Do the thing', startedAt: 1_000 * generation,
  completedAt: null, status: 'running', stopReason: null, usage: null, error: null, ...extra,
});
const command = (id, startedAt, completedAt, extra = {}) => ({
  id, kind: 'command', status: completedAt ? 'completed' : 'running', command: 'ls', cwd: null, output: '',
  outputTruncated: false, exitCode: completedAt ? 0 : null, durationMs: null, startedAt, completedAt, ...extra,
});
const message = (id, text, extra = {}) => ({
  id, kind: 'message', status: 'running', role: 'assistant', text, startedAt: 5_000, completedAt: null, ...extra,
});

test('patch merge updates items in place, appends new turns, and ignores stale or foreign patches', () => {
  let snapshot = model.applyWorkerTimelinePatch(null, {
    workerHandle: 'codex-worker-1', seq: 3, header: header(3),
    turns: [{ ...turnHeader('d1#1', 1), items: [message('m', 'Hel')] }],
  });
  assert.equal(snapshot.turns.length, 1);
  assert.equal(snapshot.turns[0].items[0].text, 'Hel');

  snapshot = model.applyWorkerTimelinePatch(snapshot, {
    workerHandle: 'codex-worker-1', seq: 5, header: header(5),
    turns: [{ ...turnHeader('d1#1', 1, { turnId: 't1' }), items: [message('m', 'Hello'), command('c', 1_100, null)] }],
  });
  assert.deepEqual(snapshot.turns[0].items.map((item) => item.id), ['m', 'c'], 'existing items keep their position');
  assert.equal(snapshot.turns[0].items[0].text, 'Hello');
  assert.equal(snapshot.turns[0].turnId, 't1');

  const stale = model.applyWorkerTimelinePatch(snapshot, {
    workerHandle: 'codex-worker-1', seq: 4, header: header(4),
    turns: [{ ...turnHeader('d1#1', 1), items: [message('m', 'old')] }],
  });
  assert.equal(stale, snapshot, 'an older patch than the fetched snapshot is ignored');
  const foreign = model.applyWorkerTimelinePatch(snapshot, {
    workerHandle: 'other', seq: 99, header: header(99, { workerHandle: 'other' }), turns: [],
  });
  assert.equal(foreign, snapshot);

  snapshot = model.applyWorkerTimelinePatch(snapshot, {
    workerHandle: 'codex-worker-1', seq: 8, header: header(8, { alive: false }),
    turns: [
      { ...turnHeader('d2#2', 2), items: [message('m', 'second turn reuses an id')] },
      { ...turnHeader('d1#1', 1, { status: 'completed', completedAt: 1_900 }), items: [] },
    ],
  });
  assert.deepEqual(snapshot.turns.map((turn) => turn.key), ['d1#1', 'd2#2'], 'turns stay in generation order');
  assert.equal(snapshot.turns[0].status, 'completed');
  assert.equal(snapshot.turns[0].items.length, 2, 'a header-only patch keeps the turn items');
  assert.equal(snapshot.turns[0].items[0].text, 'Hello');
  assert.equal(snapshot.turns[1].items[0].text, 'second turn reuses an id');
  assert.equal(snapshot.alive, false);
  assert.equal(model.activeTimelineTurn(snapshot).key, 'd2#2');
});

test('replaying the same patches onto a fetched snapshot converges on the live state', () => {
  const patches = [];
  for (let seq = 1; seq <= 6; seq++) {
    patches.push({
      workerHandle: 'codex-worker-1', seq, header: header(seq),
      turns: [{ ...turnHeader('d1#1', 1), items: [message('m', 'x'.repeat(seq))] }],
    });
  }
  const live = patches.reduce((state, patch) => model.applyWorkerTimelinePatch(state, patch), null);
  const fetched = patches.slice(0, 3).reduce((state, patch) => model.applyWorkerTimelinePatch(state, patch), null);
  const replayed = patches.reduce((state, patch) => model.applyWorkerTimelinePatch(state, patch), fetched);
  assert.deepEqual(replayed, live);
  assert.equal(replayed.turns[0].items[0].text, 'xxxxxx');
});

test('exploration steps group with step count and duration; other items break groups', () => {
  const items = [
    { id: 'r', kind: 'reasoning', status: 'completed', summary: 's', text: '', startedAt: 1_000, completedAt: 1_200 },
    command('c1', 1_300, 2_000),
    { id: 't', kind: 'tool_call', status: 'completed', toolType: 'mcp', server: 'aha', tool: 'read_board', args: '', progress: null, output: '', error: null, durationMs: 5, startedAt: 2_100, completedAt: 3_500 },
    message('m', 'answer'),
    command('c2', 6_000, null),
    { id: 'f', kind: 'file_change', status: 'completed', files: [], startedAt: 6_500, completedAt: 6_600 },
    command('c3', 7_000, 7_100),
    command('c4', 7_200, null),
  ];
  const blocks = model.groupTimelineItems(items);
  assert.deepEqual(blocks.map((block) => block.type), ['group', 'item', 'item', 'item', 'group']);
  assert.deepEqual(blocks[0].items.map((item) => item.id), ['r', 'c1', 't']);
  assert.equal(blocks[0].durationMs, 2_500);
  assert.equal(model.groupSummary(blocks[0]), '已执行 3 步 · 耗时 2.5s');
  assert.equal(blocks[2].item.id, 'c2', 'a lone step is not wrapped in a group');
  assert.equal(blocks[4].running, true);
  assert.equal(model.groupSummary(blocks[4]), '已执行 2 步 · 进行中');
});

test('timeline formatting helpers', () => {
  assert.equal(model.formatSeconds(1_234), '1.2s');
  assert.equal(model.formatSeconds(null), '');
  assert.equal(model.formatTokenCount(950), '950');
  assert.equal(model.formatTokenCount(12_345), '12.3k');
  assert.equal(model.formatTokenCount(2_500_000), '2.5M');
  assert.deepEqual(model.fileChangeTotals([{ added: 2, removed: 1 }, { added: 3, removed: 0 }]), { added: 5, removed: 1 });
  assert.deepEqual(model.totalTokenUsage({ turns: [
    { usage: { inputTokens: 10, outputTokens: 2 } }, { usage: null }, { usage: { inputTokens: 5, outputTokens: 1, totalTokens: 7 } },
  ] }), { input: 15, output: 3, total: 19 });
  assert.equal(model.totalTokenUsage({ turns: [{ usage: null }] }), null);
  assert.deepEqual(model.classifyDiffLines('--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n same').map((line) => line.kind),
    ['meta', 'meta', 'hunk', 'del', 'add', 'ctx']);
  assert.equal(model.isNearBottom({ scrollTop: 560, scrollHeight: 1_000, clientHeight: 400 }), true);
  assert.equal(model.isNearBottom({ scrollTop: 100, scrollHeight: 1_000, clientHeight: 400 }), false);
  const snapshot = { turns: [{ items: [
    { id: 'a1', kind: 'approval', status: 'pending' }, { id: 'a2', kind: 'approval', status: 'denied' },
  ] }] };
  assert.deepEqual(model.pendingApprovals(snapshot).map((item) => item.id), ['a1']);
});

test('session Markdown keeps raw HTML as text, never emits hrefs or images, and renders GFM', async () => {
  const render = await loadMarkdownRenderer();
  const html = render([
    '# Title',
    '',
    'Some **bold** and `code` <img src=x onerror=alert(1)> <script>alert(2)</script>',
    '',
    '<div onclick="alert(3)">block html</div>',
    '',
    '| File | Lines |',
    '| --- | --- |',
    '| a.ts | 12 |',
    '',
    '- [x] done',
    '',
    '```ts',
    'const a = "<b>";',
    '```',
    '',
    '[ok](https://example.com) [file](src/app.ts:12) [bad](javascript:alert(1)) [data](data:text/html,x) ![pic](https://example.com/a.png)',
  ].join('\n'));

  assert.doesNotMatch(html, /<(img|script|div onclick|iframe)\b/i, 'raw HTML and images never become elements');
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(html, /&lt;div onclick=/);
  assert.doesNotMatch(html, /\shref=/, 'links are opened through IPC, so no anchor can navigate');
  assert.doesNotMatch(html, /javascript:|data:text/);
  assert.match(html, /<a class="asv-md-link"[^>]*title="https:\/\/example\.com"[^>]*>ok<\/a>/);
  assert.match(html, /<a class="asv-md-link"[^>]*title="src\/app\.ts:12"[^>]*>file<\/a>/);
  assert.match(html, /<span class="asv-md-deadlink">bad<\/span>/);
  assert.match(html, /<a class="asv-md-link"[^>]*title="https:\/\/example\.com\/a\.png"[^>]*>pic<\/a>/);
  assert.match(html, /<div class="asv-md-table"><table>/);
  assert.match(html, /<td>a\.ts<\/td>/);
  assert.match(html, /<input type="checkbox" disabled="" checked=""\/>/);
  assert.match(html, /<div class="asv-code" data-lang="ts">/);
  assert.match(html, /<div class="asv-code-head">[\s\S]*?<button type="button" class="asv-copy" aria-label="复制代码"/, 'code blocks carry a copy button');
  assert.match(html, /const a = &quot;&lt;b&gt;&quot;;/);
});

test('dispatch prompts split into the task body and the orchestration wrapper', () => {
  const base = { taskId: 'task_1', dispatchId: 'ctx_1', coordinatorHandle: 'run:r1', workerHandle: 'codex-worker-1', runId: 'r1' };
  const spec = 'Review the diff.\n\n### Constraints\n- read only\n- When finished early, say so';

  const mcp = model.splitDispatchPrompt(buildDispatchPreamble({
    ...base, taskSpec: spec, mcpEnabled: true, headless: true, role: 'reviewer',
    worktreePath: 'C:/repo/wt', branch: 'aha/worker/x', canDispatchSubWorkers: true,
  }));
  assert.equal(mcp.body, spec);
  assert.equal(mcp.followUp, false);
  assert.match(mcp.system, /^\[Worker @reviewer\]\nWorkspace: C:\/repo\/wt\nBranch: aha\/worker\/x\n\n- Need clarification/);
  assert.match(mcp.system, /report_done/);
  assert.match(mcp.system, /delegate_task/);

  const writable = model.splitDispatchPrompt(buildDispatchPreamble({
    ...base, taskSpec: spec, mcpEnabled: true, headless: true, leaveUncommitted: true, role: 'builder',
    worktreePath: 'C:/repo/wt', branch: 'aha/worker/x',
  }));
  assert.equal(writable.body, spec);
  assert.match(writable.system, /Do not run `git commit`/);

  const followUp = model.splitDispatchPrompt(buildDispatchPreamble({
    ...base, taskSpec: 'Also check tests', mcpEnabled: true, headless: true, role: 'reviewer', isFollowUp: true,
  }));
  assert.deepEqual({ body: followUp.body, followUp: followUp.followUp }, { body: 'Also check tests', followUp: true });

  const cli = model.splitDispatchPrompt(buildDispatchPreamble({ ...base, taskSpec: spec, dispatchCapability: 'aha_dispatch_secret' }));
  assert.equal(cli.body, spec);
  assert.match(cli.system, /^\[ORCHESTRATION DISPATCH ctx_1\]/);
  assert.match(cli.system, /=== ORCHESTRATION PROTOCOL ===/);
  assert.doesNotMatch(cli.system, /Review the diff/);

  const plain = model.splitDispatchPrompt('Just do it\r\n- When finished, stop');
  assert.deepEqual(plain, { body: 'Just do it\n- When finished, stop', system: null, followUp: false });
  const truncated = model.splitDispatchPrompt('[ORCHESTRATION DISPATCH ctx_1]\nTask: t\n\n=== TASK SPECIFICATION ===\nhalf a spec');
  assert.equal(truncated.system, null, 'an unterminated wrapper is shown whole rather than guessed at');
  assert.match(truncated.body, /half a spec/);
});

test('work log helpers unwrap shell commands and format durations, fences, and multi-file diffs', () => {
  assert.equal(model.unwrapShellCommand('bash -lc "npm test"'), 'npm test');
  assert.equal(model.unwrapShellCommand('bash -lc "rg -n \\"expiresAt\\" src"'), 'rg -n "expiresAt" src');
  assert.equal(model.unwrapShellCommand('/bin/zsh -lc \'git status --short\''), 'git status --short');
  assert.equal(
    model.unwrapShellCommand('"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "Get-Content a.ts"'),
    'Get-Content a.ts',
  );
  assert.equal(model.unwrapShellCommand('node -c "x"'), 'node -c "x"', 'only shells are unwrapped');
  assert.equal(model.unwrapShellCommand('  rg -n foo src  '), 'rg -n foo src');

  assert.equal(model.formatDuration(1_234), '1.2s');
  assert.equal(model.formatDuration(42_900), '42s');
  assert.equal(model.formatDuration(185_000), '3m 05s');
  assert.equal(model.formatDuration(3_725_000), '1h 02m');
  assert.equal(model.formatDuration(null), '');
  assert.equal(model.formatElapsed(1_000, 9_999), '8s');
  assert.equal(model.formatElapsed(1_000, 66_000), '1m 05s');
  assert.equal(model.formatElapsed(5_000, 1_000), '0s');

  assert.equal(model.fenceLanguage('TS title="a.ts"'), 'ts');
  assert.equal(model.fenceLanguage('c++'), 'c++');
  assert.equal(model.fenceLanguage('text'), null);
  assert.equal(model.fenceLanguage(''), null);
  assert.equal(model.fenceLanguage('<script>'), null);

  const diff = [
    'diff --git a/src/a.ts b/src/a.ts', 'index 1..2 100644', '--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new',
    'diff --git a/old.md b/docs/new.md', 'similarity index 90%', '--- a/old.md', '+++ b/docs/new.md', '@@ -1 +1 @@', '-+++ b/fake.md', '+text',
  ].join('\n');
  const files = model.splitDiffByFile(diff);
  assert.deepEqual(files.map((file) => file.path), ['src/a.ts', 'docs/new.md']);
  assert.match(files[0].diff, /^diff --git a\/src\/a\.ts/);
  assert.doesNotMatch(files[0].diff, /new\.md/);
  assert.deepEqual(model.splitDiffByFile('@@ -1 +1 @@\n-a\n+b').map((file) => file.path), ['']);
  assert.deepEqual(model.splitDiffByFile('  \n'), []);

  const group = model.groupTimelineItems([command('c1', 1_000, 2_000), command('c2', 2_100, null), command('c3', 2_200, 2_300)])[0];
  assert.equal(model.liveGroupItem(group).id, 'c2');
  assert.equal(model.turnHasLiveItem({ items: [command('c1', 1, 2), message('m', 'x', { status: 'completed' })] }), false);
  assert.equal(model.turnHasLiveItem({ items: [command('c1', 1, null)] }), true);
});

test('timeline scroll follows the end, releases on an upward move, and reveals opened rows', () => {
  const view = (scrollTop, scrollHeight = 2_000, clientHeight = 600) => ({ scrollTop, scrollHeight, clientHeight });
  assert.equal(anchoring.distanceFromEnd(view(1_400)), 0);
  assert.equal(anchoring.modeAfterScroll('following-end', 1_400, view(1_000)), 'free-scrolling', 'scrolling up lets go');
  assert.equal(
    anchoring.modeAfterScroll('following-end', 1_400, view(1_400, 2_600)), 'following-end',
    'content growing under a pinned view is not the reader leaving',
  );
  assert.equal(anchoring.modeAfterScroll('free-scrolling', 900, view(1_100)), 'free-scrolling', 'scrolling down part way stays free');
  assert.equal(anchoring.modeAfterScroll('free-scrolling', 900, view(1_360)), 'following-end', 'reaching the end resumes following');

  assert.equal(anchoring.anchoredTurnMinHeight({ viewportHeight: 800, composerInset: 150 }), 626);
  assert.equal(anchoring.anchoredTurnMinHeight({ viewportHeight: 100, composerInset: 150 }), 0);

  const viewport = { viewportTop: 0, viewportBottom: 800, composerOverlayHeight: 150, anchorOffset: 24 };
  assert.equal(anchoring.resolveDisclosureRevealScrollDelta({ ...viewport, rowTop: 300, rowBottom: 600 }), 0, 'already visible');
  assert.equal(anchoring.resolveDisclosureRevealScrollDelta({ ...viewport, rowTop: 300, rowBottom: 750 }), 100, 'hidden by the composer');
  assert.equal(
    anchoring.resolveDisclosureRevealScrollDelta({ ...viewport, rowTop: 100, rowBottom: 1_400 }), 76,
    'a tall row scrolls only until its header reaches the anchor offset',
  );
  assert.equal(anchoring.resolveDisclosureRevealScrollDelta({ ...viewport, rowTop: 10, rowBottom: 1_400 }), 0);
});

test('stage store creates, dedupes, switches, persists, and restores agent-session windows', async () => {
  const disk = { state: null, saves: 0 };
  const store = await loadStageStore(disk);
  await store.createWindow('agent-session', { workerId: 'codex-worker-1', dispatchId: 'd1', title: '@reviewer' });
  let snap = store.getSnapshot();
  const session = snap.windows.find((win) => win.type === 'agent-session');
  assert.ok(session);
  assert.equal(snap.activeWindowId, session.id);
  assert.equal(session.workerId, 'codex-worker-1');
  assert.equal(session.dispatchId, 'd1');
  assert.deepEqual(store.getWindowLeafIds(session.id), [], 'sessions have no terminal leaves');

  await store.createWindow('activity');
  assert.equal(store.getSnapshot().activeWindowId, 'activity-default');
  await store.createWindow('agent-session', { workerId: 'codex-worker-1', dispatchId: 'd2' });
  snap = store.getSnapshot();
  assert.equal(snap.windows.filter((win) => win.type === 'agent-session').length, 1, 'same Worker reuses its tab');
  assert.equal(snap.activeWindowId, session.id);
  assert.equal(store.findAgentSession(undefined, 'd2').id, session.id, 'a follow-up dispatch retargets the tab');
  await store.createWindow('agent-session', { workerId: 'codex-worker-2', activate: false });
  assert.equal(store.getSnapshot().activeWindowId, session.id);
  await store.createWindow('agent-session', {});
  assert.equal(store.getSnapshot().windows.filter((win) => win.type === 'agent-session').length, 2);

  assert.ok(disk.saves > 0);
  const saved = disk.state.windows.find((win) => win.id === session.id);
  assert.deepEqual({ type: saved.type, workerId: saved.workerId, dispatchId: saved.dispatchId, title: saved.title },
    { type: 'agent-session', workerId: 'codex-worker-1', dispatchId: 'd2', title: '@reviewer' });
  assert.equal(disk.state.activeWindowId, session.id);

  const restored = await loadStageStore(disk);
  const after = restored.getSnapshot();
  assert.equal(after.activeWindowId, session.id);
  assert.deepEqual(after.windows.map((win) => win.type), ['activity', 'agent-session', 'agent-session']);
  assert.equal(after.windows[1].dispatchId, 'd2');
  await restored.closeWindow(session.id);
  assert.equal(restored.getSnapshot().windows.some((win) => win.id === session.id), false);
  assert.equal(disk.state.windows.some((win) => win.id === session.id), false);
  delete globalThis.window;
});

test('workspace state schema accepts persisted agent-session windows', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'aha-ws-agent-session-'));
  t.after(() => rmSync(userData, { recursive: true, force: true }));
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
  const contents = Object.assign(new EventEmitter(), { id: 9, send() {} });
  registerShellPtyIpc({
    liveWindow: () => ({ webContents: contents }),
    getCurrentCwd: () => undefined,
    userDataDir: () => userData,
  });
  const call = (name, payload) => handlers.get(`workspace-state:${name}`)({ sender: { id: 9 } }, payload);
  const state = {
    version: 1,
    windows: [
      { id: 'activity-default', type: 'activity', title: '工作区' },
      { id: 'sw-1-2', type: 'agent-session', title: '@reviewer', workerId: 'codex-worker-1', dispatchId: 'dispatch_abc', localCliId: 'codex' },
    ],
    activeWindowId: 'sw-1-2',
  };
  assert.deepEqual(await call('set', state), { ok: true });
  assert.deepEqual(JSON.parse(await readFile(join(userData, 'workspace-state.json'), 'utf8')), state);
  assert.deepEqual(await call('get', {}), { ok: true, state });
  const rejected = await call('set', { ...state, windows: [{ ...state.windows[1], type: 'agent-session-x' }] });
  assert.equal(rejected.ok, false);
});

test('a system wake-up turn shows its messages without the header that tells the agent it is not the user', async () => {
  const { SESSION_WAKE_HEADER } = await import('../dist-electron/orchestration/coordinator-prompt.js');
  assert.deepEqual(model.splitSystemWake(`${SESSION_WAKE_HEADER}\r\n\n@api 已完成\n下一步？`), {
    body: '@api 已完成\n下一步？', header: SESSION_WAKE_HEADER,
  });
  assert.deepEqual(model.splitSystemWake('[AhaStation system] note'), { body: '[AhaStation system] note', header: null });
  assert.deepEqual(model.splitSystemWake(SESSION_WAKE_HEADER), { body: SESSION_WAKE_HEADER, header: null });
});

test('SessionComposer shows non-switchable read-only and writable labels for Workers', async () => {
  const render = await loadComposerRenderer();
  const baseProps = {
    alive: true, running: false, sending: false, interrupting: false,
    approvals: [], questions: [], cwd: 'C:/repo/wt', branch: 'aha/worker/x', model: 'gpt-5',
    usage: null, onSend: async () => true, onInterrupt: () => {},
  };

  const readOnlyHtml = render({ ...baseProps, direct: false, readOnly: true });
  assert.match(readOnlyHtml, /<span class="asv-chip">[\s\S]*<span>只读<\/span><\/span>/);
  assert.doesNotMatch(readOnlyHtml, /<select\b/);

  const writableHtml = render({ ...baseProps, direct: false, readOnly: false });
  assert.match(writableHtml, /<span class="asv-chip">[\s\S]*<span>可写 · 需确认<\/span><\/span>/);
  assert.doesNotMatch(writableHtml, /<select\b/);

  const directHtml = render({
    ...baseProps, direct: true, readOnly: false, policy: 'workspace-write', onPolicyChange: () => {},
  });
  assert.match(directHtml, /<select\b/);
});

test('SessionComposer renders the direct-session queue and its paused state, but none for Workers', async () => {
  const render = await loadComposerRenderer();
  const baseProps = {
    alive: true, running: true, sending: false, interrupting: false,
    approvals: [], questions: [], branch: null, usage: null,
    onSend: async () => true, onInterrupt: () => {},
  };
  const items = [
    { id: 'q1', text: '下一条消息\n第二行', attachments: [], queuedAt: 1 },
    { id: 'q2', text: '', attachments: [{ type: 'file', path: 'C:/repo/note.txt', name: 'note.txt' }], queuedAt: 2 },
  ];
  const queue = { items, paused: false, take: async () => null, resume: () => {} };
  const html = render({ ...baseProps, direct: true, queue });
  assert.match(html, /<section class="asv-queue" aria-label="排队的消息">/);
  assert.match(html, /排队中 2 条 · 本轮结束后依次发送/);
  assert.match(html, /下一条消息/);
  assert.match(html, /（仅附件）/);
  assert.match(html, /aria-label="取回编辑"/);
  assert.match(html, /aria-label="移出队列"/);
  assert.match(html, /aria-label="加入队列"/);

  const paused = render({ ...baseProps, direct: true, queue: { ...queue, paused: true } });
  assert.match(paused, /class="asv-queue is-paused"/);
  assert.match(paused, /已暂停 · 上一轮没有正常结束，2 条消息等你确认后再发/);
  assert.match(paused, /> 继续发送<\/button>/);

  const worker = render({ ...baseProps, direct: false, readOnly: true });
  assert.doesNotMatch(worker, /asv-queue|加入队列|继续发送/);
});
test('header, empty-state, and usage pieces render their static parts', async () => {
  const outfile = join(dir, 'session-pieces.cjs');
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { SessionEmptyState } from './src/components/agent-session/SessionEmptyState.tsx';
        import { SessionTitle } from './src/components/agent-session/SessionTitle.tsx';
        import { UsageLimitChip } from './src/components/agent-session/UsageLimitChip.tsx';
        export const empty = (props) => renderToStaticMarkup(createElement(SessionEmptyState, props));
        export const title = (props) => renderToStaticMarkup(createElement(SessionTitle, props));
        export const usage = (summary) => renderToStaticMarkup(createElement(UsageLimitChip, { summary }));`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'js',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  });
  const mod = await import(pathToFileURL(outfile).href);
  const { empty, title, usage } = mod.default ?? mod;

  const start = empty({ folder: 'repo', policy: 'read-only', onPick: () => {} });
  assert.match(start, /要在 <span class="asv-start-folder">repo<\/span> 里做点什么？/);
  assert.match(start, /当前为只读/);
  assert.equal(start.match(/class="asv-start-example"/g).length, 3);
  assert.match(start, /title="填入输入框，不会自动发送"/);

  assert.equal(title({ title: 'Worker 任务' }), '<span class="asv-title">Worker 任务</span>', 'no rename without a handler');
  assert.match(title({ title: '会话', onRename: async () => true }), /class="asv-title is-editable" role="button" tabindex="0" title="双击改名"/);

  const chip = usage({ text: '每周额度 92%', level: 'bad', planType: 'plus', windows: [] });
  assert.match(chip, /class="asv-chip asv-usage is-bad"/);
  assert.match(chip, /aria-label="Codex 额度：每周额度 92%"/);
  assert.doesNotMatch(chip, /asv-usage-pop/, 'the window list opens on hover or focus only');
});

test('slash trigger detection ignores paths, supports mid-prompt /model and /skill, and ranks matches', async () => {
  const tokensUrl = emit('composer-tokens');
  const rankingUrl = emit('search-ranking');
  const slashUrl = emit('composer-slash-commands', (s) => s.replace("'./search-ranking'", JSON.stringify(rankingUrl)));
  const tokens = await import(tokensUrl);
  const slash = await import(slashUrl);

  assert.deepEqual(tokens.detectTrigger('/mo', 3), { kind: 'slash', query: 'mo', start: 0, end: 3 });
  assert.deepEqual(tokens.detectTrigger('请帮我 /sk', 7), { kind: 'slash', query: 'sk', start: 4, end: 7 });
  assert.equal(tokens.detectTrigger('/src/auth/session.ts', 4), null, 'paths with a second slash never trigger commands');
  assert.equal(tokens.detectTrigger('/foo\\bar', 3), null, 'backslash paths never trigger commands');
  assert.equal(tokens.detectTrigger('a/b', 3), null, 'slashes inside a word never trigger commands');
  assert.deepEqual(tokens.removeTriggerRange('请 /model 看看', { kind: 'slash', query: 'model', start: 2, end: 8 }), { text: '请 看看', caret: 2 });

  const skills = [
    { name: 'pdf', description: '读取、创建和校验 PDF', path: 'C:/s/pdf/SKILL.md', scope: 'system', enabled: true, pluginId: null },
    { name: 'code-reviewer', description: '审查补丁的正确性与安全问题', path: 'C:/s/.codex/plugins/cr/SKILL.md', scope: 'user', enabled: true, pluginId: 'cr@openai' },
    { name: 'disabled-skill', description: 'hidden', path: 'C:/s/off/SKILL.md', scope: 'user', enabled: false, pluginId: null },
  ];
  assert.equal(slash.resolveSkillSourceKind(skills[0]), 'system');
  assert.equal(slash.resolveSkillSourceKind(skills[1]), 'app');

  const atStart = slash.buildSlashCommandItems({
    isAtPromptStart: true, hasTurns: true, canCompact: true, hasUsageLimits: true,
    canHistory: true, canRename: true, canOrchestration: true, orchestrationOn: false, skills,
  });
  const names = atStart.map((item) => item.label);
  for (const expected of ['/model', '/clear', '/history', '/rename', '/orchestration', '/compact', '/usage-limits', '/goal', '/feedback', '/skill:pdf', '/skill:code-reviewer']) {
    assert.ok(names.includes(expected), `expected ${expected} in slash menu`);
  }
  assert.ok(!names.includes('/skill:disabled-skill'), 'disabled skills stay hidden');

  const midPrompt = slash.buildSlashCommandItems({
    isAtPromptStart: false, hasTurns: true, canCompact: false, hasUsageLimits: true,
    canHistory: true, canRename: true, canOrchestration: true, orchestrationOn: false, skills,
  });
  assert.deepEqual(midPrompt.map((item) => item.label), ['/model', '/skill:pdf', '/skill:code-reviewer']);

  assert.equal(slash.searchSlashCommandItems(atStart, 'comp')[0].label, '/compact');
  assert.equal(slash.searchSlashCommandItems(atStart, '额度')[0].label, '/usage-limits');
  assert.equal(slash.searchSlashCommandItems(atStart, 'skill:pdf')[0].label, '/skill:pdf');
  assert.equal(slash.searchSlashCommandItems(atStart, 'rev')[0].label, '/skill:code-reviewer');
  assert.equal(slash.searchSlashCommandItems(atStart, 'skill:cr')[0].label, '/skill:code-reviewer');

  assert.equal(slash.resolveMenuActiveItemId({
    items: [{ id: 'a' }, { id: 'b' }], highlightedItemId: 'b', currentSearchKey: 'slash:m', highlightedSearchKey: 'slash:m',
  }), 'b');
  assert.equal(slash.resolveMenuActiveItemId({
    items: [{ id: 'a' }, { id: 'b' }], highlightedItemId: 'b', currentSearchKey: 'slash:mo', highlightedSearchKey: 'slash:m',
  }), 'a');

  assert.equal(slash.isClearCommand('/clear'), true);
  assert.equal(slash.isCompactCommand(' /compact '), true);
  assert.equal(slash.isUsageLimitsCommand('/usage'), true);
  assert.equal(slash.isUsageLimitsCommand('/usage-limits'), true);
  assert.deepEqual(slash.parseRenameCommand('/rename 新标题'), { title: '新标题' });
  assert.deepEqual(slash.parseOrchestrationCommand('/orchestration'), { mode: 'toggle' });
  assert.deepEqual(slash.parseOrchestrationCommand('/orchestration on'), { mode: 'on' });
  assert.deepEqual(slash.parseOrchestrationCommand('/orchestration 关闭'), { mode: 'off' });
  assert.deepEqual(slash.parseFeedbackCommand('/feedback 按钮错位'), { reason: '按钮错位' });
  assert.deepEqual(slash.parseGoalCommand('/goal'), { type: 'show' });
  assert.deepEqual(slash.parseGoalCommand('/goal pause'), { type: 'pause' });
  assert.deepEqual(slash.parseGoalCommand('/goal resume'), { type: 'resume' });
  assert.deepEqual(slash.parseGoalCommand('/goal clear'), { type: 'clear' });
  assert.deepEqual(slash.parseGoalCommand('/goal 修完所有测试'), { type: 'set', objective: '修完所有测试' });
  assert.equal(slash.parseGoalCommand('/goal 修完所有测试', 1), null, 'messages with attachments are ordinary prompts');
  assert.equal(slash.runsSlashCommandLocally({
    text: '/clear', holdsOnlyText: true, hasTurns: true, hasUsageLimits: true, canHistory: true, canRename: true, canOrchestration: true,
  }), true);
  assert.equal(slash.runsSlashCommandLocally({
    text: '/compact', holdsOnlyText: true, hasTurns: true, hasUsageLimits: true, canHistory: true, canRename: true, canOrchestration: true,
  }), false, '/compact runs as a Codex turn, not locally');
});

test('ComposerCommandMenu and ComposerBanners render slash items/banners and never leak to Workers', async () => {
  const outfile = join(dir, 'session-slash-ui.cjs');
  await build({
    stdin: {
      contents: `
        import { createElement } from 'react';
        import { renderToStaticMarkup } from 'react-dom/server';
        import { ComposerCommandMenu } from './src/components/agent-session/ComposerCommandMenu.tsx';
        import { FeedbackBanner, FreshSessionBanner, GoalBanner, UsageLimitsBanner } from './src/components/agent-session/ComposerBanners.tsx';
        import { SessionComposer } from './src/components/agent-session/SessionComposer.tsx';
        export const menu = (props) => renderToStaticMarkup(createElement(ComposerCommandMenu, props));
        export const fresh = () => renderToStaticMarkup(createElement(FreshSessionBanner, { onDismiss: () => {} }));
        export const usageBanner = (props) => renderToStaticMarkup(createElement(UsageLimitsBanner, props));
        export const goalBanner = (props) => renderToStaticMarkup(createElement(GoalBanner, props));
        export const feedbackBanner = (props) => renderToStaticMarkup(createElement(FeedbackBanner, props));
        export const composer = (props) => renderToStaticMarkup(createElement(SessionComposer, props));`,
      resolveDir: fileURLToPath(new URL('..', import.meta.url)),
      loader: 'js',
    },
    outfile, bundle: true, platform: 'node', format: 'cjs', jsx: 'automatic', logLevel: 'silent',
  });
  const ui = (await import(pathToFileURL(outfile).href)).default ?? await import(pathToFileURL(outfile).href);

  const menuHtml = ui.menu({
    triggerKind: 'slash',
    activeItemId: 'slash:model',
    loading: false,
    onHighlight: () => {},
    onSelect: () => {},
    items: [
      { kind: 'slash', id: 'slash:model', item: { type: 'builtin', id: 'slash:model', command: 'model', label: '/model', description: '切换模型', promptStartOnly: false } },
      { kind: 'slash', id: 'provider:goal', item: { type: 'provider', id: 'provider:goal', command: 'goal', label: '/goal', description: '设定目标', hint: '目标', promptStartOnly: true } },
      { kind: 'slash', id: 'skill:pdf', item: { type: 'skill', id: 'skill:pdf', skill: { name: 'pdf', description: '处理 PDF', path: 'C:/s/pdf/SKILL.md', scope: 'system', enabled: true, pluginId: null }, label: '/skill:pdf', description: '处理 PDF', sourceKind: 'system', promptStartOnly: false } },
    ],
  });
  assert.match(menuHtml, /aria-label="斜杠命令"/);
  assert.match(menuHtml, /\/model/);
  assert.match(menuHtml, /asv-suggest-hint">目标<\/span>/);
  assert.match(menuHtml, /asv-suggest-prefix">\/skill:<\/span>pdf/);
  assert.match(menuHtml, /asv-suggest-badge[\s\S]*内置/);

  const emptyMenu = ui.menu({ triggerKind: 'slash', items: [], activeItemId: null, loading: false, onHighlight: () => {}, onSelect: () => {} });
  assert.match(emptyMenu, /没有匹配的命令/);

  assert.match(ui.fresh(), /下一条消息将开启全新上下文/);
  assert.match(ui.fresh(), /保留当前上下文/);
  assert.match(ui.usageBanner({
    summary: { text: '额度 37%', level: 'ok', planType: 'pro', windows: [{ label: '5 小时', percent: 37, level: 'ok', used: '已用 37%', reset: '2 小时后重置' }] },
    refreshing: false, onRefresh: () => {}, onClose: () => {},
  }), /Codex 额度 · pro[\s\S]*5 小时[\s\S]*已用 37%/);
  assert.match(ui.goalBanner({
    goal: { objective: '修完所有测试', status: 'active', tokensUsed: 0, timeUsedSeconds: 0, updatedAt: 1 },
    running: false, busy: false, onPause: () => {}, onResume: () => {}, onClear: () => {},
  }), /会话目标[\s\S]*进行中[\s\S]*修完所有测试[\s\S]*暂停/);
  assert.match(ui.feedbackBanner({ state: { status: 'sent', feedbackId: 'fb_123' }, onDismiss: () => {} }), /反馈已发送至 OpenAI[\s\S]*fb_123/);

  const workerHtml = ui.composer({
    alive: true, running: false, sending: false, interrupting: false,
    approvals: [], questions: [], branch: null, readOnly: true, direct: false, usage: null,
    onSend: async () => true, onInterrupt: () => {},
  });
  assert.doesNotMatch(workerHtml, /斜杠命令|asv-slash-banner|新上下文|会话目标/);
});
