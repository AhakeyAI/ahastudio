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
