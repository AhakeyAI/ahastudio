import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from '@lydell/node-pty';
import { DaemonTerminalSessions } from '../dist-electron/daemon-terminal-sessions.js';
import { PtyInputLimiter } from '../dist-electron/pty-input-limiter.js';
import { PtyInputQueue, PTY_INPUT_PENDING_BYTES } from '../dist-electron/pty-input-queue.js';
import { shellPtyInputSchema } from '../dist-electron/ipc/shell-pty.js';

function fastQueue() {
  let now = 0;
  return { queue: new PtyInputQueue(() => now, async ms => { now += ms; }), now: () => now };
}

test('daemon input preserves a large UTF-8 paste through the actual byte limiter', async () => {
  const service = new DaemonTerminalSessions({ dataDir: '/unused' }, { data() {}, exit() {} }, () => '/unused');
  const limiter = new PtyInputLimiter();
  const delivered = [];
  const client = { input: async (_id, chunk) => {
    if (!limiter.allow(Buffer.byteLength(chunk))) throw new Error('PTY input rate/size limit exceeded');
    delivered.push(chunk);
    return { ok: true };
  } };
  service.getClient = async () => client;
  const text = '\x1b[200~' + '中文🙂'.repeat(3000) + '\x1b[201~';
  assert.equal((await service.input('test-id', text)).ok, true);
  assert.equal(delivered.join(''), text);
  assert.ok(delivered.every(s => Buffer.byteLength(s) <= 8192));
});

test('IPC accepts a large paste but rejects oversize UTF-8 before delivery', () => {
  assert.equal(shellPtyInputSchema.safeParse({ ptyId: 'local-test', data: '中文🙂'.repeat(3000) }).success, true);
  assert.equal(shellPtyInputSchema.safeParse({ ptyId: 'local-test', data: '中'.repeat(PTY_INPUT_PENDING_BYTES / 3 + 1) }).success, false);
});

test('event storm preserves per-terminal order through the real 60-event limiter', async () => {
  const { queue, now } = fastQueue();
  const limiter = new PtyInputLimiter();
  const accepted = [];
  await Promise.all(Array.from({ length: 181 }, (_, n) => queue.enqueue('one', `${n},`, async chunk => {
    assert.equal(limiter.allow(Buffer.byteLength(chunk), now()), true);
    accepted.push(chunk);
  })));
  assert.equal(accepted.join(''), Array.from({ length: 181 }, (_, n) => `${n},`).join(''));
  assert.equal(limiter.dropped, 0);
});

test('simultaneous pastes keep Unicode and bracketed paste, OSC, cursor replies and Ctrl-C intact', async () => {
  const { queue } = fastQueue();
  const inputs = ['\x1b[200~' + '中🙂'.repeat(6000) + '\x1b[201~', '\x1b[1;23R\x03\x1b]10;rgb:ff/ff/ff\x07', 'tail\r'];
  const writes = [];
  await Promise.all(inputs.map(input => queue.enqueue('one', input, async chunk => {
    assert.ok(Buffer.byteLength(chunk) <= 8192);
    writes.push(chunk);
  })));
  assert.equal(writes.join(''), inputs.join(''));
  assert.equal(Buffer.from(writes.join('')).compare(Buffer.from(inputs.join(''))), 0);
});

test('lost ACK after applying bytes is never replayed and cancels the queued tail', async () => {
  const service = new DaemonTerminalSessions({ dataDir: '/unused' }, { data() {}, exit() {} }, () => '/unused');
  service.inputQueue = fastQueue().queue;
  const writes = [];
  service.getClient = async () => ({ input: async (_id, chunk) => {
    writes.push(chunk); // The PTY accepted it, but its ACK was lost.
    throw new Error('Terminal disconnected; operation outcome may be unknown');
  } });
  const results = await Promise.all([service.input('one', 'a'.repeat(9000)), service.input('one', 'DO_NOT_SEND')]);
  assert.ok(results.every(result => !result.ok));
  assert.equal(writes.length, 1);
  assert.equal(writes[0].length, 8192);
  assert.equal((await service.input('one', 'NO_RETRY')).ok, false);
  assert.equal(writes.length, 1);
});

test('explicit negative ACK is not mistaken for success or automatically retried', async () => {
  const service = new DaemonTerminalSessions({ dataDir: '/unused' }, { data() {}, exit() {} }, () => '/unused');
  let attempts = 0;
  service.getClient = async () => ({ input: async () => { attempts++; return { ok: false }; } });
  assert.equal((await service.input('one', 'abc')).ok, false);
  assert.equal(attempts, 1);
});

test('generic disconnect after an acknowledged prefix neither reconnects nor resends it', async () => {
  const service = new DaemonTerminalSessions({ dataDir: '/unused' }, { data() {}, exit() {} }, () => '/unused');
  service.inputQueue = fastQueue().queue;
  const writes = [];
  let connections = 0;
  const client = { input: async (_id, chunk) => {
    writes.push(chunk);
    if (writes.length === 2) throw new Error('Terminal disconnected');
    return { ok: true };
  } };
  service.getClient = async () => { connections++; return client; };
  assert.equal((await service.input('one', 'a'.repeat(20000))).ok, false);
  assert.equal(writes.length, 2);
  assert.equal(connections, 2);
  assert.equal((await service.input('one', 'NO')).ok, false);
  assert.equal(writes.length, 2);
});

test('session close cancels buffered input before requesting daemon termination', async () => {
  const service = new DaemonTerminalSessions({ dataDir: '/unused' }, { data() {}, exit() {} }, () => '/unused');
  let release;
  const writes = [];
  service.getClient = async () => ({ input: async (_id, chunk) => {
    writes.push(chunk);
    await new Promise(resolve => { release = resolve; });
    return { ok: true };
  } });
  service.withClient = async () => ({ ok: true });
  const pending = service.input('one', 'a'.repeat(20000));
  while (!release) await new Promise(resolve => setImmediate(resolve));
  assert.equal((await service.close('one')).ok, true);
  release();
  assert.equal((await pending).ok, false);
  assert.equal(writes.length, 1);
});

test('close while acquiring a client cannot send after termination', async () => {
  const service = new DaemonTerminalSessions({ dataDir: '/unused' }, { data() {}, exit() {} }, () => '/unused');
  let release;
  let writes = 0;
  service.getClient = () => new Promise(resolve => { release = () => resolve({ input: async () => { writes++; return { ok: true }; } }); });
  service.withClient = async () => ({ ok: true });
  const pending = service.input('one', 'NO');
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await service.close('one');
  release();
  assert.equal((await pending).ok, false);
  assert.equal(writes, 0);
});

test('tiny-event queue is bounded independently of byte size', async () => {
  const { queue } = fastQueue();
  let release;
  const send = async () => { if (!release) await new Promise(resolve => { release = resolve; }); };
  const pending = Array.from({ length: 1024 }, () => queue.enqueue('one', 'x', send));
  await assert.rejects(queue.enqueue('one', 'x', async () => assert.fail()), /未排队/);
  while (!release) await new Promise(resolve => setImmediate(resolve));
  release();
  await Promise.all(pending);
});

test('slow client/ACK cannot produce an immediate following write', async () => {
  let now = 0;
  const writes = [];
  const queue = new PtyInputQueue(() => now, async ms => { now += ms; });
  await queue.enqueue('one', 'a'.repeat(9000), async () => {
    writes.push(now);
    if (writes.length === 1) now += 1000;
  });
  assert.deepEqual(writes, [0, 1020]);
});

test('timer boundary never schedules a negative delay', async () => {
  const times = [0, 1, 20.999, 21.001, 22];
  const queue = new PtyInputQueue(() => times.shift() ?? 22, async ms => {
    assert.ok(ms > 0, 'a second clock read must not turn a positive wait negative');
  });
  await queue.enqueue('one', 'a'.repeat(9000), async () => {});
});

test('confirmed terminal retirement permits the same identity to be created again', async () => {
  const { queue } = fastQueue();
  queue.cancel('one');
  await assert.rejects(queue.enqueue('one', 'NO', async () => assert.fail()), /关闭/);
  queue.release('one');
  let received = '';
  await queue.enqueue('one', 'new-process', async chunk => { received += chunk; });
  assert.equal(received, 'new-process');
});

test('closing aborts a paced write and all pending inputs, without a delayed tail', async () => {
  let waiting;
  const queue = new PtyInputQueue(() => 0, (_ms, signal) => new Promise((_, reject) => {
    waiting = true;
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  const writes = [];
  const first = queue.enqueue('one', 'a'.repeat(9000), async chunk => writes.push(chunk));
  const second = queue.enqueue('one', 'NEVER', async chunk => writes.push(chunk));
  const settled = Promise.allSettled([first, second]);
  while (!waiting) await new Promise(resolve => setImmediate(resolve));
  queue.cancel('one');
  assert.ok((await settled).every(result => result.status === 'rejected'));
  assert.equal(writes.length, 1);
  await assert.rejects(queue.enqueue('one', 'NO', async () => assert.fail()), /关闭/);
});

test('queue memory bound rejects a whole unaccepted input and terminals stay independent', async () => {
  const { queue } = fastQueue();
  let release;
  const first = queue.enqueue('one', 'a'.repeat(PTY_INPUT_PENDING_BYTES), async () => {
    if (!release) await new Promise(resolve => { release = resolve; });
  });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(queue.enqueue('one', 'OVERFLOW', async () => assert.fail()), /未排队/);
  let other = false;
  await queue.enqueue('other', 'ok', async () => { other = true; });
  assert.equal(other, true);
  release();
  await first;
  queue.cancelAll();
  await assert.rejects(queue.enqueue('new', 'NO', async () => assert.fail()), /关闭/);
});

test('native macOS PTY receives the exact UTF-8/control byte stream', { skip: process.platform !== 'darwin', timeout: 10000 }, async () => {
  const text = '\x1b[200~' + '中文🙂'.repeat(10000) + '\x1b[201~\x1b[1;23R\x03';
  const bytes = Buffer.byteLength(text);
  const digest = createHash('sha256').update(text).digest('hex');
  const code = `import os, tty, hashlib
tty.setraw(0)
os.write(1, b'READY')
data = b''
while len(data) < ${bytes}:
    data += os.read(0, ${bytes} - len(data))
os.write(1, ('SHA256:' + hashlib.sha256(data).hexdigest()).encode())
`;
  const pty = spawn('/usr/bin/python3', ['-u', '-c', code], {
    cwd: process.cwd(), env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color' }, cols: 100, rows: 30,
  });
  let output = '';
  let exited = false;
  pty.onData(chunk => { output += chunk; });
  const exit = new Promise(resolve => pty.onExit(event => { exited = true; resolve(event); }));
  const until = async predicate => {
    const deadline = Date.now() + 4000;
    while (!predicate() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(predicate(), 'isolated PTY handshake timed out');
  };
  try {
    await until(() => output.includes('READY'));
    const queue = new PtyInputQueue();
    const limiter = new PtyInputLimiter();
    await queue.enqueue('owned-native-test', text, async chunk => {
      assert.equal(limiter.allow(Buffer.byteLength(chunk)), true);
      pty.write(chunk);
    });
    await until(() => output.includes('SHA256:' + digest));
    await until(() => exited);
    assert.equal((await exit).exitCode, 0);
  } finally {
    if (!exited) pty.kill(); // Only the process created by this test.
  }
});
