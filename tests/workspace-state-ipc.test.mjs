import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ipcMain } from 'electron';
import { registerShellPtyIpc } from '../dist-electron/ipc/shell-pty.js';

test('workspace state IPC hands the renderer only a schema-valid state and reports rejected saves', async (t) => {
  const userData = await mkdtemp(join(tmpdir(), 'aha-ws-ipc-'));
  const file = join(userData, 'workspace-state.json');
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
  const warn = t.mock.method(console, 'warn', () => {});
  const contents = Object.assign(new EventEmitter(), { id: 7, send() {} });
  registerShellPtyIpc({
    liveWindow: () => ({ webContents: contents }),
    getCurrentCwd: () => undefined,
    userDataDir: () => userData,
  });
  const call = (name, payload) => handlers.get(`workspace-state:${name}`)({ sender: { id: 7 } }, payload);

  // A hand-edited or older file must not reach the renderer as if it were valid.
  await writeFile(file, JSON.stringify({ version: 1, windows: 'not-an-array', activeWindowId: null }));
  assert.deepEqual(await call('get', {}), { ok: true, state: null });
  assert.equal(warn.mock.callCount(), 1, 'the ignored state is logged');

  const valid = {
    version: 1,
    windows: [{ id: 'activity-default', type: 'activity', title: '工作区' }],
    activeWindowId: 'activity-default',
  };
  assert.deepEqual(await call('set', valid), { ok: true });
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), valid);
  assert.deepEqual(await call('get', {}), { ok: true, state: valid });

  const rejected = await call('set', { ...valid, windows: [{ ...valid.windows[0], unknownField: 1 }] });
  assert.equal(rejected.ok, false, 'a payload outside the schema is reported, not silently accepted');
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), valid, 'a rejected save leaves the stored state intact');
});
