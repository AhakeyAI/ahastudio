import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ipcMain } from 'electron';
import { listLocalClis, listLocalShells, resolveLocalTerminal } from '../dist-electron/local-cli.js';
import { registerShellPtyIpc } from '../dist-electron/ipc/shell-pty.js';
import { getPtyHost } from '../dist-electron/pty-host.js';

test('local CLI detection uses PATH and preserves native color preferences', async (t) => {
  // Windows CI TEMP may use RUNNER~1 while where.exe returns the long path.
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aha-local-cli-')));
  const filename = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const binary = join(root, filename);
  await writeFile(binary, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', { mode: 0o755 });
  const previous = Object.fromEntries(['PATH', 'ELECTRON_RUN_AS_NODE', 'NO_COLOR', 'COLORFGBG', 'FORCE_COLOR', 'CLICOLOR']
    .map((key) => [key, process.env[key]]));
  process.env.PATH = `${root}${process.platform === 'win32' ? ';' : ':'}${previous.PATH ?? ''}`;
  process.env.ELECTRON_RUN_AS_NODE = '1';
  process.env.NO_COLOR = '1';
  process.env.COLORFGBG = '15;0';
  process.env.FORCE_COLOR = '0';
  process.env.CLICOLOR = '0';
  t.after(async () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  const entry = listLocalClis().find((cli) => cli.id === 'codex');
  assert.equal(entry.binaryPath, binary);
  const target = resolveLocalTerminal('codex');
  assert.equal(target.file, binary);
  assert.deepEqual(target.args, [], 'manual launch must not send a task or model prompt');
  assert.equal(target.env.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(target.env.TERM, 'xterm-256color');
  assert.equal(target.env.COLORTERM, 'truecolor');
  for (const key of ['NO_COLOR', 'COLORFGBG', 'FORCE_COLOR', 'CLICOLOR']) {
    assert.equal(target.env[key], process.env[key], `${key} must remain the user's preference`);
  }
});

test('Grok Build resolves from GROK_HOME/bin and disables interactive autoupdater', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aha-grok-cli-')));
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const filename = process.platform === 'win32' ? 'grok.exe' : 'grok';
  const binary = join(binDir, filename);
  await writeFile(binary, process.platform === 'win32' ? '' : '#!/bin/sh\n', { mode: 0o755 });
  const prevGrokHome = process.env.GROK_HOME;
  const prevPath = process.env.PATH;
  const prevUpdater = process.env.GROK_DISABLE_AUTOUPDATER;
  process.env.GROK_HOME = root;
  process.env.PATH = '';
  delete process.env.GROK_DISABLE_AUTOUPDATER;
  t.after(async () => {
    if (prevGrokHome === undefined) delete process.env.GROK_HOME; else process.env.GROK_HOME = prevGrokHome;
    if (prevPath === undefined) delete process.env.PATH; else process.env.PATH = prevPath;
    if (prevUpdater === undefined) delete process.env.GROK_DISABLE_AUTOUPDATER; else process.env.GROK_DISABLE_AUTOUPDATER = prevUpdater;
    await rm(root, { recursive: true, force: true });
  });

  const entry = listLocalClis().find((cli) => cli.id === 'grok');
  assert.equal(entry.binaryPath, binary);
  const target = resolveLocalTerminal('grok');
  assert.equal(target.file, binary);
  assert.equal(target.env.GROK_DISABLE_AUTOUPDATER, '1');
});

test('resolveLocalTerminal propagates light/dark appearance via COLORFGBG and Grok theme defaults', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aha-grok-theme-')));
  const binDir = join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  const filename = process.platform === 'win32' ? 'grok.exe' : 'grok';
  const binary = join(binDir, filename);
  await writeFile(binary, process.platform === 'win32' ? '' : '#!/bin/sh\n', { mode: 0o755 });
  const keys = ['GROK_HOME', 'PATH', 'COLORFGBG', 'GROK_THEME', 'LC_GROK_THEME', 'GROK_APPEARANCE', 'LC_GROK_APPEARANCE'];
  const prev = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  process.env.GROK_HOME = root;
  process.env.PATH = '';
  for (const k of ['COLORFGBG', 'GROK_THEME', 'LC_GROK_THEME', 'GROK_APPEARANCE', 'LC_GROK_APPEARANCE']) {
    delete process.env[k];
  }
  t.after(async () => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    await rm(root, { recursive: true, force: true });
  });

  // Default (no theme in config.toml) follows app appearance.
  const light = resolveLocalTerminal('grok', 'default', undefined, { appearance: 'light' });
  assert.equal(light.env.COLORFGBG, '0;15');
  assert.equal(light.env.GROK_APPEARANCE, 'light');
  assert.equal(light.env.GROK_THEME, 'grokday');

  const dark = resolveLocalTerminal('grok', 'default', undefined, { appearance: 'dark' });
  assert.equal(dark.env.COLORFGBG, '15;0');
  assert.equal(dark.env.GROK_APPEARANCE, 'dark');
  assert.equal(dark.env.GROK_THEME, 'groknight');

  // Auto mode with custom auto_light_theme uses the user's configured light theme.
  await writeFile(join(root, 'config.toml'), '[ui]\ntheme = "auto"\nauto_light_theme = "custom-day"\n');
  const autoCustom = resolveLocalTerminal('grok', 'default', undefined, { appearance: 'light' });
  assert.equal(autoCustom.env.GROK_THEME, 'custom-day');

  // Explicit fixed theme in config.toml is preserved untouched.
  await writeFile(join(root, 'config.toml'), '[ui]\ntheme = "tokyonight"\n');
  const fixed = resolveLocalTerminal('grok', 'default', undefined, { appearance: 'light' });
  assert.equal(fixed.env.GROK_THEME, undefined);
  assert.equal(fixed.env.COLORFGBG, '0;15');

  // Explicit env vars are never overridden.
  await writeFile(join(root, 'config.toml'), '[ui]\n');
  process.env.GROK_THEME = 'rose-pine';
  process.env.COLORFGBG = '7;0';
  const envOverride = resolveLocalTerminal('grok', 'default', undefined, { appearance: 'light' });
  assert.equal(envOverride.env.GROK_THEME, 'rose-pine');
  assert.equal(envOverride.env.COLORFGBG, '7;0');
});

test('manual terminal IPC retains the same PTY across reattach and closes only its tab', async (t) => {
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
  const contents = Object.assign(new EventEmitter(), { id: 7, send() {} });
  const host = getPtyHost();
  const live = new Map();
  let spawnCount = 0;
  t.mock.method(host, 'spawn', (id, opts) => { live.set(id, { opts, output: '', onExit() {} }); spawnCount++; return 123; });
  t.mock.method(host, 'onData', () => () => {});
  t.mock.method(host, 'onExit', (id, cb) => { live.get(id).onExit = cb; return () => {}; });
  t.mock.method(host, 'replayBuffer', (id) => Buffer.from(live.get(id)?.output ?? ''));
  t.mock.method(host, 'kill', (id) => live.delete(id));
  let mainWindow = null;
  registerShellPtyIpc({ liveWindow: () => mainWindow, getCurrentCwd: () => undefined });
  mainWindow = { webContents: contents };
  const call = (name, payload, sender = 7) => handlers.get(`shell-pty:${name}`)({ sender: { id: sender } }, payload);
  assert.equal((await call('create', { terminalId: 'a' }, 8)).ok, false);
  assert.equal((await call('create', { cliId: 'unknown' })).ok, false);
  assert.equal((await call('create', { cliId: 'codex', shellId: 'cmd' })).ok, false);
  const shellList = await call('list-shells', {});
  assert.equal(shellList.ok, true);
  assert.ok(shellList.defaultCwd);
  const selected = shellList.shells.find(shell => shell.id !== 'default') ?? shellList.shells[0];
  const a = await call('create', { terminalId: 'a', shellId: selected.id, cwd: shellList.defaultCwd });
  assert.equal(live.get(a.ptyId).opts.file, selected.binaryPath);
  assert.equal(live.get(a.ptyId).opts.cwd, shellList.defaultCwd);
  const b = await call('create', { terminalId: 'b' });
  assert.equal(a.ok, true);
  assert.notEqual(a.ptyId, b.ptyId);
  live.get(a.ptyId).output = 'first terminal history';
  const reattached = await call('create', { terminalId: 'a' });
  assert.equal(reattached.ptyId, a.ptyId);
  assert.equal(Buffer.from(reattached.replay, 'base64').toString(), 'first terminal history');
  assert.equal(spawnCount, 2);
  live.get(a.ptyId).onExit(0);
  const ended = await call('create', { terminalId: 'a' });
  assert.equal(ended.exited, true);
  assert.equal(ended.exitCode, 0);
  assert.equal(spawnCount, 2, 'an exited tab must not automatically restart its CLI');
  const originalKill = host.kill;
  t.mock.method(host, 'kill', () => { throw new Error('termination failed'); });
  assert.equal((await call('kill', { ptyId: b.ptyId })).ok, false);
  assert.equal((await call('create', { terminalId: 'b' })).ptyId, b.ptyId);
  assert.equal(spawnCount, 2, 'failed close keeps ownership for a retry');
  t.mock.method(host, 'kill', originalKill);
  await call('kill', { ptyId: a.ptyId });
  assert.equal(live.has(a.ptyId), false);
  assert.equal(live.has(b.ptyId), true);
  contents.emit('destroyed');
  assert.equal(live.size, 0);
});

test('each available shell resolves its detected executable without a model task', () => {
  for (const shell of listLocalShells()) {
    const target = resolveLocalTerminal(undefined, shell.id);
    assert.equal(target.file, shell.binaryPath);
    assert.deepEqual(target.args, shell.id === 'git-bash' ? ['--login', '-i'] : []);
  }
});
