import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';
import { ipcMain } from 'electron';
import { registerShellPtyIpc } from '../dist-electron/ipc/shell-pty.js';

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
const markdown = await import(emit('safe-markdown'));
const paneTreeUrl = emit('terminal-pane-tree');

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

test('safe Markdown keeps raw HTML as text and only links http(s) URLs', () => {
  const blocks = markdown.parseMarkdown('# Title\n\nSome **bold** and `code` <img src=x onerror=alert(1)>\n\n- one\n- two\n\n```ts\nconst a = 1;\n```\n[ok](https://example.com) [bad](javascript:alert(1))');
  assert.deepEqual(blocks.map((block) => block.type), ['heading', 'paragraph', 'list', 'code', 'paragraph']);
  const inline = blocks[1].children;
  assert.deepEqual(inline.map((node) => node.type), ['text', 'strong', 'text', 'code', 'text']);
  assert.match(inline.at(-1).text, /<img src=x onerror=alert\(1\)>/);
  assert.equal(blocks[3].lang, 'ts');
  assert.equal(blocks[3].text, 'const a = 1;');
  const links = blocks[4].children.filter((node) => node.type === 'link');
  assert.deepEqual(links.map((node) => node.href), ['https://example.com']);
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
