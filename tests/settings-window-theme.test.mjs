import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('../electron/ipc/settings-window.ts', import.meta.url);
const compiled = ts.transpileModule(readFileSync(sourceUrl, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(/^import .*;$/gm, '')
  .replaceAll('import.meta.url', JSON.stringify(sourceUrl.href))
  .replaceAll('export function ', 'function ')
  .replaceAll('export const ', 'const ');

function fixture(packaged) {
  const handlers = new Map();
  const windows = [];
  const nativeTheme = Object.assign(new EventEmitter(), { shouldUseDarkColors: false });
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.options = options; windows.push(this);
      this.webContents = { id: 1, session: { webRequest: { onHeadersReceived() {} } },
        setWindowOpenHandler() {}, on() {}, send() {} };
    }
    loadURL(url) { this.url = url; return Promise.resolve(); }
    loadFile(path, opts) { this.url = new URL('file://' + path).href + '?' + new URLSearchParams(opts.query); return Promise.resolve(); }
    setBackgroundColor(value) { this.background = value; }
    isDestroyed() { return false; }
    focus() {}
    close() { this.emit('closed'); }
  }
  const api = new Function('ipcMain', 'BrowserWindow', 'app', 'shell', 'nativeTheme', 'join', 'dirname', 'fileURLToPath',
    compiled + '\nreturn { registerSettingsWindowIpc, closeSettingsWindow };')(
    { handle: (name, handler) => handlers.set(name, handler) }, Window, { isPackaged: packaged }, {}, nativeTheme, join, dirname, fileURLToPath,
  );
  api.registerSettingsWindowIpc();
  return { windows, nativeTheme, api, open: focus => handlers.get('settings:open-window')({}, { focus }) };
}

test('packaged settings shares the main app origin so theme persistence and storage events cross windows', () => {
  const f = fixture(true);
  f.open('appearance');
  assert.equal(f.windows[0].url, 'app://bundle/index.html?view=settings&focus=appearance');
  assert.equal(new URL(f.windows[0].url).host, new URL('app://bundle/index.html').host);
  assert.equal(f.windows[0].options.webPreferences.contextIsolation, true);
  assert.equal(f.windows[0].options.webPreferences.sandbox, true);
});

test('development settings keeps the Vite origin and focus route', () => {
  const previous = process.env.VITE_DEV_SERVER_URL;
  process.env.VITE_DEV_SERVER_URL = 'http://localhost:5173/?preview=1';
  try {
    const f = fixture(false); f.open('terminal');
    assert.equal(f.windows[0].url, 'http://localhost:5173/?preview=1&view=settings&focus=terminal');
  } finally {
    if (previous === undefined) delete process.env.VITE_DEV_SERVER_URL;
    else process.env.VITE_DEV_SERVER_URL = previous;
  }
});

test('the native settings background follows theme updates and removes the listener on close', () => {
  const f = fixture(true); f.open('appearance');
  assert.equal(f.windows[0].options.backgroundColor, '#f2f2f7');
  f.nativeTheme.shouldUseDarkColors = true; f.nativeTheme.emit('updated');
  assert.equal(f.windows[0].background, '#1c1c1e');
  f.nativeTheme.shouldUseDarkColors = false; f.nativeTheme.emit('updated');
  assert.equal(f.windows[0].background, '#f2f2f7');
  f.api.closeSettingsWindow();
  assert.equal(f.nativeTheme.listenerCount('updated'), 0);
});
