import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WorkspaceStateStore } from '../dist-electron/persistence/workspace-state-store.js';
import { HeadlessEmulator } from '../dist-electron/terminal-daemon/emulation/headless-emulator.js';
import { TerminalSessions } from '../dist-electron/terminal-sessions.js';
import { DaemonTerminalSessions, toDaemonUuid } from '../dist-electron/daemon-terminal-sessions.js';
import { ensureTerminalDaemon } from '../dist-electron/terminal-daemon/launcher.js';

const runtimePath = resolve(process.env.AHA_D1_TEST_RUNTIME ?? 'node_modules/electron/dist/electron.exe');
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('WorkspaceStateStore persists atomically via AtomicSnapshotWriter and flushes synchronously', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'aha-ws-store-'));
  const file = join(dir, 'workspace-state.json');
  const store = new WorkspaceStateStore(() => file);

  const sample = {
    version: 1,
    windows: [
      { id: 'activity-default', type: 'activity', title: '工作区' },
      { id: 'sw-1', type: 'terminal', title: 'bash', shellId: 'bash', cwd: dir },
    ],
    activeWindowId: 'sw-1',
  };
  await store.write(sample);

  const raw = await readFile(file, 'utf8');
  assert.deepEqual(JSON.parse(raw), sample);
  assert.deepEqual(store.read(), sample);

  const files = await readdir(dir);
  assert.deepEqual(files, ['workspace-state.json']);

  const updated = { ...sample, activeWindowId: 'activity-default' };
  const writePromise = store.write(updated);
  store.flushSync();
  await writePromise;
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), updated);
});

test('HeadlessEmulator and TerminalSessions capture ANSI screen snapshots and keep list() minimal', async () => {
  const emulator = new HeadlessEmulator({ cols: 80, rows: 24 });
  await emulator.write('\x1b]2;aha-title\x07\x1b[32mGREEN_OK\x1b[0m\r\nline2');
  const snap = emulator.getSnapshot();
  assert.match(snap.snapshotAnsi, /GREEN_OK/);
  assert.match(snap.snapshotAnsi, /line2/);
  assert.equal(snap.lastTitle, 'aha-title');
  assert.equal(snap.cols, 80);
  assert.equal(snap.rows, 24);
  emulator.dispose();

  const dataCallbacks = new Map();
  const exitCallbacks = new Map();
  const host = {
    spawn() { return 4242; },
    onData(id, cb) { dataCallbacks.set(id, cb); return () => dataCallbacks.delete(id); },
    onExit(id, cb) { exitCallbacks.set(id, cb); return () => exitCallbacks.delete(id); },
    replayBuffer() { return Buffer.from(''); },
    resize() { return true; },
    kill() {},
    async terminateTree() {},
    async readyPid() { return 4242; },
  };
  const sessions = new TerminalSessions(host, { data() {}, exit() {} });
  sessions.create('p1', { cwd: process.cwd(), cols: 80, rows: 24 }, 'shell');
  dataCallbacks.get('p1')('PROMPT> hello_snapshot\r\n');
  await delay(30);

  const snapshot = sessions.get('p1');
  assert(snapshot.screenSnapshot, 'screenSnapshot should be populated on get()');
  assert.match(snapshot.screenSnapshot.snapshotAnsi, /hello_snapshot/);
  const listed = sessions.list();
  assert.equal(listed.length, 1);
  assert.equal('screenSnapshot' in listed[0], false);
  sessions.close('p1');
});

test('DaemonTerminalSessions survives client detach and restores screenSnapshot for non-UUID terminalId', {
  skip: process.platform !== 'win32',
  timeout: 25_000,
}, async (t) => {
  assert.match(toDaemonUuid('sw-phase1-reattach'), UUID_RE);
  assert.equal(toDaemonUuid('sw-phase1-reattach'), toDaemonUuid('sw-phase1-reattach'));

  const dataDir = await mkdtemp(join(tmpdir(), 'aha-phase1-daemon-'));
  let daemonPid = 0;

  t.after(async () => {
    try {
      const client = await ensureTerminalDaemon({ dataDir, runtimePath });
      daemonPid = client.descriptor.pid;
      for (const s of await client.inventory().catch(() => [])) {
        await client.attach(s.terminalId);
        await client.terminate(s.terminalId);
      }
      client.disconnect();
    } catch {
      /* daemon already stopped */
    }
    if (daemonPid) {
      for (let i = 0; i < 50 && alive(daemonPid); i++) await delay(100);
      assert.equal(alive(daemonPid), false);
    }
  });

  const eventsA = [];
  const svcA = new DaemonTerminalSessions(
    { dataDir, runtimePath },
    {
      data: (ev) => eventsA.push(ev),
      exit: () => {},
    },
    () => dataDir
  );

  const first = await svcA.create({
    terminalId: 'phase1-reattach',
    cols: 80,
    rows: 24,
    cwd: dataDir,
  });
  assert.equal(first.ok, true);
  assert.equal(first.ptyId, 'local-phase1-reattach');
  assert(first.pid > 0);

  const clientCheck = await ensureTerminalDaemon({ dataDir, runtimePath });
  daemonPid = clientCheck.descriptor.pid;
  clientCheck.disconnect();

  await svcA.input('local-phase1-reattach', 'echo PHASE1_SURVIVES\r');
  for (let i = 0; i < 40; i++) {
    const joined = eventsA.map((e) => Buffer.from(e.data, 'base64').toString('utf8')).join('');
    if (joined.includes('PHASE1_SURVIVES')) break;
    await delay(100);
  }
  const streamedA = eventsA.map((e) => Buffer.from(e.data, 'base64').toString('utf8')).join('');
  assert.match(streamedA, /PHASE1_SURVIVES/);

  // Simulate renderer/window reload: detach WITHOUT terminating daemon PTY.
  svcA.detachAll();

  const eventsB = [];
  const svcB = new DaemonTerminalSessions(
    { dataDir, runtimePath },
    {
      data: (ev) => eventsB.push(ev),
      exit: () => {},
    },
    () => dataDir
  );

  const reattached = await svcB.create({
    terminalId: 'phase1-reattach',
    cols: 80,
    rows: 24,
    cwd: dataDir,
  });
  assert.equal(reattached.ok, true);
  assert.equal(reattached.pid, first.pid);
  assert.equal(reattached.ptyId, 'local-phase1-reattach');
  assert(reattached.screenSnapshot, 'reattached session includes screenSnapshot');
  assert.match(reattached.screenSnapshot.snapshotAnsi, /PHASE1_SURVIVES/);

  await svcB.close('local-phase1-reattach');
  svcB.detachAll();
});

test('screen snapshot stays under the daemon frame limit for a busy terminal and replaces raw replay', async () => {
  const dataCallbacks = new Map();
  const host = {
    spawn() { return 1; },
    onData(id, cb) { dataCallbacks.set(id, cb); return () => dataCallbacks.delete(id); },
    onExit() { return () => {}; },
    replayBuffer() { return Buffer.alloc(200 * 1024, 'x'); },
    resize() { return true; },
    kill() {},
    async terminateTree() {},
    async readyPid() { return 1; },
  };
  const sessions = new TerminalSessions(host, { data() {}, exit() {} });
  sessions.create('busy', { cwd: process.cwd(), cols: 200, rows: 30 }, 'shell');
  let out = '';
  for (let i = 0; i < 8000; i++) out += `\x1b[32mline ${i}\x1b[0m \x1b[1;34m${'abcdefghij'.repeat(15)}\x1b[0m\r\n`;
  dataCallbacks.get('busy')(out);
  await delay(50);

  const snapshot = sessions.get('busy');
  assert.equal(snapshot.replay, '');
  assert(snapshot.screenSnapshot);
  const frame = Buffer.byteLength(JSON.stringify({ id: 'x', ok: true, result: snapshot }));
  assert(frame < 1024 * 1024, `attach frame ${frame} must stay under 1 MiB`);
  assert.match(snapshot.screenSnapshot.snapshotAnsi, /line 7999/);
  sessions.close('busy');
});

test('DaemonTerminalSessions re-attaches every terminal after a dropped connection and keeps exit ids', {
  skip: process.platform !== 'win32',
  timeout: 40_000,
}, async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'aha-phase1-reconnect-'));
  let daemonPid = 0;
  t.after(async () => {
    try {
      const client = await ensureTerminalDaemon({ dataDir, runtimePath });
      daemonPid = client.descriptor.pid;
      for (const s of await client.inventory().catch(() => [])) {
        await client.attach(s.terminalId);
        await client.terminate(s.terminalId).catch(() => {});
      }
      client.disconnect();
    } catch { /* daemon already stopped */ }
    if (daemonPid) for (let i = 0; i < 50 && alive(daemonPid); i++) await delay(100);
  });

  const events = [];
  const exits = [];
  const restores = [];
  const svc = new DaemonTerminalSessions(
    { dataDir, runtimePath },
    { data: (ev) => events.push(ev), exit: (ev) => exits.push(ev), restore: (s) => restores.push(s) },
    () => dataDir,
  );
  const base = { cols: 80, rows: 24, cwd: dataDir };
  await svc.create({ terminalId: 'rc-a', ...base });
  await svc.create({ terminalId: 'rc-b', ...base });
  const text = (id) => events.filter((e) => e.ptyId === id)
    .map((e) => Buffer.from(e.data, 'base64').toString('utf8')).join('');

  // A dropped socket restores both attached terminals without needing application input.
  svc.activeClient.disconnect();
  for (let i = 0; i < 50 && restores.length < 2; i++) await delay(100);
  assert.deepEqual(restores.map((s) => s.ptyId).sort(), ['local-rc-a', 'local-rc-b']);
  assert.equal((await svc.input('local-rc-a', 'echo A_AFTER_DROP\r')).ok, true);

  // Terminal B was never touched through svc after the drop, so it only streams if re-attached.
  const other = await ensureTerminalDaemon({ dataDir, runtimePath });
  const bId = toDaemonUuid('local-rc-b');
  await other.attach(bId, true);
  await other.input(bId, 'echo B_AFTER_DROP\r');
  for (let i = 0; i < 50 && !text('local-rc-b').includes('B_AFTER_DROP'); i++) await delay(100);
  other.disconnect();
  assert.match(text('local-rc-b'), /B_AFTER_DROP/);

  await svc.close('local-rc-a');
  assert(exits.some((e) => e.ptyId === 'local-rc-a'), 'exit must be reported under the original ptyId');
  // Pause the client while a separate controller produces the final screen and exit.
  svc.resetClientConnection();
  const gapClient = await ensureTerminalDaemon({ dataDir, runtimePath });
  await gapClient.attach(bId, true);
  await gapClient.input(bId, 'echo B_DURING_GAP\r');
  for (let i = 0; i < 50; i++) {
    const snapshot = await gapClient.attach(bId, false);
    if (JSON.stringify(snapshot.screenSnapshot).includes('B_DURING_GAP')) break;
    await delay(100);
  }
  await gapClient.terminate(bId);
  gapClient.disconnect();
  await svc.close('local-rc-b');
  const restoredExit = restores.find((s) => s.ptyId === 'local-rc-b' && s.exited);
  assert.match(restoredExit?.screenSnapshot?.snapshotAnsi ?? '', /B_DURING_GAP/);
  assert(exits.some((e) => e.ptyId === 'local-rc-b'), 'exit during the gap must reach the original pane');
  svc.detachAll();
});
