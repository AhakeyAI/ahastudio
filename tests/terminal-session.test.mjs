import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

// Exercise the renderer owner with deterministic create/terminate promises.
// Real xterm/ConPTY rendering is validated separately in the browser smoke.
class TestTerminal {
  constructor(opts = {}) {
    this.options = { ...opts };
    this._oscHandlers = new Map();
    this._csiHandlers = [];
    this.parser = {
      registerOscHandler: (ident, cb) => {
        const list = this._oscHandlers.get(ident) ?? [];
        list.push(cb);
        this._oscHandlers.set(ident, list);
        return { dispose: () => { const cur = this._oscHandlers.get(ident); if (cur) this._oscHandlers.set(ident, cur.filter((x) => x !== cb)); } };
      },
      registerCsiHandler: (id, cb) => {
        const entry = { id, cb };
        this._csiHandlers.push(entry);
        return { dispose: () => { this._csiHandlers = this._csiHandlers.filter((x) => x !== entry); } };
      },
    };
  }
  unicode = {};
  rows = 24;
  cols = 80;
  writes = [];
  disposed = false;
  loadAddon() {}
  open() {}
  focus() {}
  blur() {}
  refresh() {}
  onData(cb) { this.send = cb; return { dispose() {} }; }
  onTitleChange() { return { dispose() {} }; }
  write(data, cb) {
    const value = typeof data === 'string' ? data : new TextDecoder().decode(data);
    this.writes.push(value);
    if (value.includes('\x1b[5n')) this.send('\x1b[0n');
    for (const m of value.matchAll(/\x1b\](\d+);([^\x07\x1b]*)(?:\x07|\x1b\\)/g)) {
      const ident = Number(m[1]);
      for (const h of this._oscHandlers.get(ident) ?? []) h(m[2]);
    }
    for (const m of value.matchAll(/\x1b\[(\??)([0-9;]*)([a-zA-Z])/g)) {
      const prefix = m[1] || undefined;
      const params = m[2] ? m[2].split(';').map((n) => Number(n)) : [];
      const final = m[3];
      for (const { id, cb: h } of this._csiHandlers) {
        if ((id.prefix || undefined) === prefix && id.final === final) h(params);
      }
    }
    cb?.();
  }
  dispose() { this.disposed = true; }
}
globalThis.__terminalTest = { Terminal: TestTerminal, FitAddon: class { fit() {} }, Unicode11Addon: class {} };
globalThis.document = { createElement: () => ({ remove() {} }) };
globalThis.ResizeObserver = class { observe() {} disconnect() {} };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.localStorage = { getItem: () => null, setItem() {} };

const moduleUrl = (source) => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText).toString('base64')}`;
const loadPureTs = async (relPath, rewrites = {}) => {
  let src = await readFile(new URL(relPath, import.meta.url), 'utf8');
  for (const [from, toUrl] of Object.entries(rewrites)) {
    src = src.replaceAll(JSON.stringify(from), JSON.stringify(toUrl)).replaceAll(`'${from}'`, JSON.stringify(toUrl));
  }
  return moduleUrl(src);
};
const ownedUtf16Url = await loadPureTs('../src/lib/shared/owned-utf16-suffix.ts');
const ownRetainedUrl = await loadPureTs('../src/lib/shared/own-retained-string.ts', {
  './owned-utf16-suffix': ownedUtf16Url,
});
const osc133Url = await loadPureTs('../src/lib/shared/terminal/output/terminal-osc133-command-finished.ts', {
  '../../own-retained-string': ownRetainedUrl,
});
const oscTrackerUrl = await loadPureTs('../src/lib/terminal-osc-tracker.ts', {
  './shared/own-retained-string': ownRetainedUrl,
  './shared/terminal/output/terminal-osc133-command-finished': osc133Url,
});
const paneTreeUrl = await loadPureTs('../src/lib/terminal-pane-tree.ts');

const sessionSource = await readFile(new URL('../src/lib/terminal-session.ts', import.meta.url), 'utf8');
const sessionUrl = moduleUrl('const {Terminal, FitAddon, Unicode11Addon} = globalThis.__terminalTest;\n'
  + `import { createTerminalOscTracker } from ${JSON.stringify(oscTrackerUrl)};\n`
  + sessionSource.replace(/^import .*;\r?\n/gm, ''));
const { TerminalSession } = await import(sessionUrl);
const storeSource = await readFile(new URL('../src/lib/terminal-session-store.ts', import.meta.url), 'utf8');
const appearanceUrl = moduleUrl(await readFile(new URL('../src/lib/terminal-appearance.ts', import.meta.url), 'utf8'));
const storeUrl = moduleUrl(storeSource.replace("'./terminal-session'", JSON.stringify(sessionUrl))
  .replace("'./terminal-appearance'", JSON.stringify(appearanceUrl)));
const { terminalSessionStore } = await import(storeUrl);
globalThis.__browserTest = { setVisible: async () => {} };
const stageSource = await readFile(new URL('../src/lib/stage-window-store.ts', import.meta.url), 'utf8');
const { stageWindowStore } = await import(moduleUrl(stageSource
  .replace("import { browserStore } from './browser-store';", 'const browserStore = globalThis.__browserTest;')
  .replace("'./terminal-session-store'", JSON.stringify(storeUrl))
  .replace("'./terminal-pane-tree'", JSON.stringify(paneTreeUrl))));

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { resolve, promise }; };
const encoded = (value) => Buffer.from(value).toString('base64');
const host = { appendChild() {}, isConnected: true, clientWidth: 800, clientHeight: 600 };
function fixture() {
  const create = deferred();
  const data = new Set();
  const exit = new Set();
  const calls = { attach: 0, input: [], kill: 0 };
  const transport = {
    expectedPtyId: 'local-a',
    attach: () => { calls.attach++; return create.promise; },
    input: (_id, value) => { calls.input.push(value); }, resize() {},
    dispose: async () => { calls.kill++; },
    onData: (cb) => { data.add(cb); return () => data.delete(cb); },
    onExit: (cb) => { exit.add(cb); return () => exit.delete(cb); },
  };
  const session = new TerminalSession(transport, 14, () => {});
  const emit = (value, sequence) => { for (const cb of data) cb({ ptyId: 'local-a', data: encoded(value), sequence }); };
  const ready = async (extra = {}) => { create.resolve({ ok: true, ptyId: 'local-a', replay: '', ...extra }); await session.connection; };
  return { session, create, data, exit, calls, transport, emit, ready };
}

test('closing during create never reopens input and terminates exactly once', async () => {
  const f = fixture();
  f.session.mount(host);
  f.emit('early', 1);
  const termination = deferred();
  f.transport.dispose = async () => { f.calls.kill++; await termination.promise; };
  const close = f.session.close();
  assert.equal(f.session.close(), close);
  await f.ready({ replay: encoded('\x1b[5n') });
  assert.equal(f.session.getSnapshot().phase, 'closing');
  f.session.terminal.send('must not send');
  for (const cb of f.exit) cb({ ptyId: 'local-a', exitCode: 0 });
  assert.equal(f.session.getSnapshot().phase, 'closing');
  assert.deepEqual(f.calls.input, []);
  termination.resolve();
  await close;
  assert.equal(f.calls.kill, 1);
  assert.equal(f.data.size + f.exit.size, 0);
  assert.equal(f.session.pending.length, 0);
  assert.equal(f.session.terminal.disposed, true);
});

test('failed create releases stream subscriptions and queued output', async () => {
  for (const result of [{ ok: false, error: 'offline failure' }, new Error('rejected create')]) {
    const f = fixture();
    f.session.mount(host);
    f.emit('pending', 1);
    if (result instanceof Error) f.create.resolve(Promise.reject(result)); else f.create.resolve(result);
    await f.session.connection;
    assert.equal(f.session.getSnapshot().phase, 'error');
    assert.equal(f.data.size + f.exit.size, 0);
    assert.equal(f.session.pendingSize, 0);
    await f.session.close();
    assert.equal(f.calls.kill, 0);
  }
});

test('startup device replies use input transport and sequence handoff writes only once', async () => {
  const f = fixture();
  f.session.mount(host);
  f.emit('snapshot-covered', 1);
  f.emit('live-after-snapshot', 2);
  await f.ready({ replay: encoded('\x1b[5n'), sequence: 1 });
  await Promise.resolve();
  assert.deepEqual(f.calls.input, ['\x1b[0n']);
  assert.deepEqual(f.session.terminal.writes, ['\x1b[5n', 'live-after-snapshot']);
  await f.session.close();
});

test('pending bytes and event count are bounded and overflow is visible', async () => {
  for (const flood of [f => f.emit('x'.repeat(800_000), 1), f => { for (let i = 0; i < 4097; i++) f.emit('x', i); }]) {
    const f = fixture();
    f.session.mount(host);
    flood(f);
    assert.equal(f.session.pendingSize, 0);
    assert.equal(f.session.pending.length, 0);
    assert.match(f.session.getSnapshot().error, /缓冲上限/);
    await f.ready();
    assert.equal(f.session.getSnapshot().phase, 'error');
    assert.equal(f.data.size + f.exit.size, 0);
    await f.session.close();
    assert.equal(f.calls.kill, 1);
  }
});

test('mounting again retains the same terminal and exited tabs never create again', async () => {
  const f = fixture();
  const terminal = f.session.terminal;
  f.session.mount(host);
  await f.ready({ exited: true, exitCode: 7 });
  f.session.unmount(host);
  f.session.mount(host);
  assert.equal(f.session.terminal, terminal);
  assert.equal(f.calls.attach, 1);
  assert.equal(f.session.getSnapshot().phase, 'exited');
  await f.session.close();
  f.session.mount(host);
  assert.equal(f.calls.attach, 1);
});

test('stage close has one owner, preserves failed-close tab and blocks input until retry', async () => {
  const f = fixture();
  await stageWindowStore.createWindow('terminal', { localCliId: 'shell', shellId: 'cmd', cwd: 'C:/snapshot' });
  const tab = stageWindowStore.getSnapshot().windows.at(-1);
  const session = terminalSessionStore.acquire(tab.id, f.transport);
  session.mount(host);
  f.create.resolve({ ok: true, ptyId: 'local-a', replay: '' });
  await session.connection;
  let fail = true;
  f.transport.dispose = async () => { f.calls.kill++; if (fail) throw new Error('access denied'); };
  await stageWindowStore.closeWindow(tab.id);
  assert.ok(stageWindowStore.getSnapshot().windows.some(win => win.id === tab.id));
  assert.match(session.getSnapshot().error, /关闭失败/);
  session.unmount(host);
  session.mount(host);
  assert.equal(session.host, host, 'failed-close screen can be shown again without reopening input');
  assert.equal(session.terminal.options.disableStdin, true);
  session.terminal.send('blocked');
  assert.deepEqual(f.calls.input, []);
  fail = false;
  await Promise.all([stageWindowStore.closeWindow(tab.id), stageWindowStore.closeWindow(tab.id)]);
  assert.equal(f.calls.kill, 2, 'one failed attempt and one successful retry, no stage-level kill');
  assert.equal(stageWindowStore.getSnapshot().windows.some(win => win.id === tab.id), false);
  await f.session.close();
});

test('a tab closed before its first mount creates no process', async () => {
  const f = fixture();
  await f.session.close();
  f.session.mount(host);
  assert.equal(f.calls.attach, 0);
  assert.equal(f.calls.kill, 0);
});


test('a non-empty screen snapshot is replayed instead of the raw tail, then live output resumes after its sequence', async () => {
  const f = fixture();
  f.session.mount(host);
  f.emit('covered-by-snapshot', 1);
  f.emit('live-after-snapshot', 2);
  await f.ready({
    sequence: 1,
    replay: encoded('RAW_TAIL'),
    screenSnapshot: {
      snapshotAnsi: 'SNAP_SCREEN', scrollbackAnsi: '', rehydrateSequences: 'REHYDRATE',
      pendingEscapeTailAnsi: '\x1b[3', modes: { alternateScreen: false }, lastTitle: 'restored title',
    },
  });
  const [restore, ...rest] = f.session.terminal.writes;
  assert.ok(restore.startsWith('\x18'), 'restore starts by cancelling any half-written escape');
  assert.ok(restore.indexOf('SNAP_SCREEN') < restore.indexOf('REHYDRATE'));
  assert.ok(restore.endsWith('\x1b[3'), 'an incomplete escape is left for the next live chunk to finish');
  assert.ok(!f.session.terminal.writes.join('').includes('RAW_TAIL'));
  assert.deepEqual(rest, ['live-after-snapshot']);
  assert.equal(f.session.getSnapshot().title, 'restored title');
  await f.session.close();
});

test('an alternate-screen snapshot restores scrollback before entering the alternate buffer', async () => {
  const f = fixture();
  f.session.mount(host);
  await f.ready({
    screenSnapshot: {
      snapshotAnsi: 'TUI_FRAME', scrollbackAnsi: 'OLD_HISTORY', modes: { alternateScreen: true },
    },
  });
  const restore = f.session.terminal.writes[0];
  const enterAlt = restore.indexOf('\x1b[?1049h');
  assert.ok(restore.indexOf('OLD_HISTORY') < enterAlt);
  assert.ok(enterAlt < restore.indexOf('TUI_FRAME'));
  await f.session.close();
});

test('an empty screen snapshot falls back to the raw replay', async () => {
  const f = fixture();
  f.session.mount(host);
  await f.ready({
    replay: encoded('RAW_TAIL'),
    screenSnapshot: { snapshotAnsi: '', scrollbackAnsi: '', modes: { alternateScreen: false } },
  });
  assert.deepEqual(f.session.terminal.writes, ['RAW_TAIL']);
  await f.session.close();
});

const loadFreshStageStore = async (tag) => (await import(moduleUrl(stageSource
  .replace("import { browserStore } from './browser-store';", 'const browserStore = globalThis.__browserTest;')
  .replace("'./terminal-session-store'", JSON.stringify(storeUrl))
  .replace("'./terminal-pane-tree'", JSON.stringify(paneTreeUrl)) + `\n// ${tag}`))).stageWindowStore;
const savedWorkspace = {
  version: 1,
  windows: [
    { id: 'activity-default', type: 'activity', title: '工作区' },
    { id: 'sw-old', type: 'terminal', title: 'old tab', localCliId: 'shell', shellId: 'default' },
  ],
  activeWindowId: 'sw-old',
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test('saved tabs are restored without rewriting the file', async () => {
  const get = deferred();
  const sets = [];
  globalThis.window = { vibeMeet: { workspaceState: { get: () => get.promise, set: async (s) => { sets.push(s); return { ok: true }; } } } };
  try {
    const store = await loadFreshStageStore('restore-only');
    get.resolve({ ok: true, state: savedWorkspace });
    await tick();
    assert.deepEqual(store.getSnapshot().windows.map((w) => w.id), ['activity-default', 'sw-old']);
    assert.equal(store.getSnapshot().activeWindowId, 'sw-old');
    assert.equal(sets.length, 0);
  } finally { delete globalThis.window; }
});

test('tabs changed before the saved state loads neither lose the saved tabs nor overwrite the file early', async () => {
  const get = deferred();
  const sets = [];
  globalThis.window = { vibeMeet: { workspaceState: { get: () => get.promise, set: async (s) => { sets.push(s); return { ok: true }; } } } };
  try {
    const store = await loadFreshStageStore('hydrate-race');
    await store.createWindow('terminal', { localCliId: 'shell', title: 'new tab' });
    const newId = store.getSnapshot().activeWindowId;
    assert.equal(sets.length, 0, 'nothing may be saved while the stored state is still unread');
    get.resolve({ ok: true, state: savedWorkspace });
    await tick();
    const ids = store.getSnapshot().windows.map((w) => w.id);
    assert.ok(ids.includes('sw-old') && ids.includes(newId));
    assert.equal(store.getSnapshot().activeWindowId, newId);
    assert.equal(sets.length, 1);
    assert.ok(sets[0].windows.some((w) => w.id === 'sw-old') && sets[0].windows.some((w) => w.id === newId));
  } finally { delete globalThis.window; }
});

test('a failed restore does not block later saves', async () => {
  const sets = [];
  const warn = console.warn;
  console.warn = () => {};
  globalThis.window = { vibeMeet: { workspaceState: { get: async () => { throw new Error('ipc down'); }, set: async (s) => { sets.push(s); return { ok: true }; } } } };
  try {
    const store = await loadFreshStageStore('restore-failure');
    await tick();
    await store.createWindow('terminal', { localCliId: 'shell', title: 'after failure' });
    assert.equal(sets.length, 1);
  } finally { delete globalThis.window; console.warn = warn; }
});

test('terminal appearance defaults to system, tracks OS color-scheme changes, and supports light/dark/system switching', async () => {
  const origStorage = globalThis.localStorage;
  const saved = new Map();
  let osDark = true;
  const mediaListeners = new Set();
  const themeSourceCalls = [];
  globalThis.localStorage = {
    getItem: (k) => saved.get(k) ?? null,
    setItem: (k, v) => saved.set(k, String(v)),
  };
  globalThis.window = {
    matchMedia: () => ({
      get matches() { return osDark; },
      addEventListener: (_type, fn) => mediaListeners.add(fn),
      removeEventListener: (_type, fn) => mediaListeners.delete(fn),
    }),
    addEventListener() {},
    vibeMeet: {
      setThemeSource: async (source) => {
        themeSourceCalls.push(source);
        return { shouldUseDarkColors: source === 'system' ? osDark : source === 'dark' };
      },
    },
  };
  try {
    const freshStoreUrl = `${storeUrl}#appearance-system`;
    const { terminalSessionStore: store } = await import(freshStoreUrl);
    const f = fixture();
    const session = store.acquire('term-appearance', f.transport);

    assert.equal(store.getAppearancePreference(), 'system');
    assert.equal(store.getAppearance(), 'dark');
    assert.equal(session.terminal.options.theme.background, '#1e1e1e');
    assert.equal(session.terminal.options.minimumContrastRatio, 3);

    // OS switches to light while in system mode -> updates session automatically.
    osDark = false;
    for (const fn of mediaListeners) fn({ matches: false });
    assert.equal(store.getAppearance(), 'light');
    assert.equal(session.terminal.options.theme.background, '#ffffff');
    assert.equal(session.terminal.options.minimumContrastRatio, 4.5);

    // Explicit override ignores OS changes.
    store.setAppearance('dark');
    assert.equal(store.getAppearancePreference(), 'dark');
    assert.equal(store.getAppearance(), 'dark');
    assert.equal(saved.get('aha.terminal.appearance'), 'dark');
    for (const fn of mediaListeners) fn({ matches: false });
    assert.equal(store.getAppearance(), 'dark');

    // Switching back to system re-syncs with real OS state via IPC.
    osDark = true;
    store.setAppearance('system');
    await tick();
    assert.equal(store.getAppearancePreference(), 'system');
    assert.equal(store.getAppearance(), 'dark');
    assert.equal(saved.get('aha.terminal.appearance'), 'system');
    assert.deepEqual(themeSourceCalls.slice(-2), ['dark', 'system']);
  } finally {
    delete globalThis.window;
    globalThis.localStorage = origStorage;
  }
});

test('terminal responds to OSC 10/11/12 and CSI ?996n, suppresses snapshot replay queries, and pushes Mode 2031 updates on theme switch', async () => {
  const f = fixture();
  const lightTheme = { background: '#ffffff', foreground: '#1f2328', cursor: '#0969da' };
  const darkTheme = { background: '#1e1e1e', foreground: '#d4d4d4', cursor: '#ffffff' };
  const session = new TerminalSession(f.transport, 14, () => {}, lightTheme);
  session.mount(host);
  await f.ready({
    sequence: 1,
    screenSnapshot: {
      snapshotAnsi: 'OLD\x1b]11;?\x07\x1b[?996n',
      scrollbackAnsi: '',
      modes: { alternateScreen: false },
    },
  });
  await tick();
  assert.deepEqual(f.calls.input, [], 'replayed screen snapshots must not emit color-scheme replies');

  // Live OSC 10/11/12 queries (including chained 10;?;?) and CSI ?996n.
  f.emit('\x1b]10;?;?\x07\x1b]12;?\x07\x1b[?996n', 2);
  await tick();
  assert.deepEqual(f.calls.input, [
    '\x1b]10;rgb:1f1f/2323/2828\x1b\\',
    '\x1b]11;rgb:ffff/ffff/ffff\x1b\\',
    '\x1b]12;rgb:0909/6969/dada\x1b\\',
    '\x1b[?997;2n',
  ]);
  f.calls.input.length = 0;

  // Enable Mode 2031 (?2031h) -> theme polarity switch pushes unsolicited ?997 report.
  f.emit('\x1b[?2031h', 3);
  session.setTheme(darkTheme);
  await tick();
  assert.deepEqual(f.calls.input, ['\x1b[?997;1n']);
  f.calls.input.length = 0;

  // Same polarity does not emit duplicate notification.
  session.setTheme({ ...darkTheme, background: '#141414' });
  await tick();
  assert.deepEqual(f.calls.input, []);

  // Switching back to light emits light report.
  session.setTheme(lightTheme);
  await tick();
  assert.deepEqual(f.calls.input, ['\x1b[?997;2n']);
  f.calls.input.length = 0;

  // Disabling Mode 2031 (?2031l) stops unsolicited updates.
  f.emit('\x1b[?2031l', 4);
  session.setTheme(darkTheme);
  await tick();
  assert.deepEqual(f.calls.input, []);

  await session.close();
  await f.session.close();
});
