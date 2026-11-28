// Single-writer resume claims and agent process-tree reaping.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { isProcessTreeAlive, killProcessTree, SPAWN_AGENT_PROCESS_GROUP } from '../dist-electron/agent-drivers/process-tree.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';

function claimInput(overrides = {}) {
  return {
    workerId: 'codex-worker-00000000-0000-0000-0000-000000000001', runId: 'run-1', dispatchId: 'd-1',
    cwd: process.cwd(), driver: 'codex', providerSessionId: 'thread-1', ...overrides,
  };
}

test('a resume claim fences its Worker and directory until released', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-claims-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new OrchestrationStore({ resolveFile: () => join(dir, 'state.json') });
  const claim = store.acquireResumeClaim(claimInput());
  assert.equal(claim.status, 'pending');
  assert.equal(claim.hostId, 'local');
  assert.throws(() => store.acquireResumeClaim(claimInput()), /already holds/);
  const otherWorker = claimInput({ workerId: 'claude-worker-00000000-0000-0000-0000-000000000002' });
  assert.throws(() => store.acquireResumeClaim(otherWorker), /already holds/);
  if (process.platform === 'win32') {
    assert.throws(() => store.acquireResumeClaim({ ...otherWorker, cwd: process.cwd().toUpperCase() }), /already holds/);
  }
  assert.equal(store.activateResumeClaim(claim.id, 4242).status, 'active');
  store.releaseResumeClaims(claim.workerId);
  assert.deepEqual(store.listResumeClaims(), []);
  assert.equal(store.acquireResumeClaim(otherWorker).workerId, otherWorker.workerId);
});

test('claims from an earlier app run stay stale until their process is gone', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-claims-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  const store = new OrchestrationStore({ resolveFile: () => statePath });
  const claim = store.acquireResumeClaim(claimInput());
  store.activateResumeClaim(claim.id, 4242);
  await store.flushDurable();

  const restarted = new OrchestrationStore({ resolveFile: () => statePath });
  restarted.load();
  const [stale] = restarted.listResumeClaims();
  assert.equal(stale.status, 'stale');
  assert.equal(stale.pid, 4242);
  restarted.releaseResumeClaims(stale.workerId);
  assert.equal(restarted.listResumeClaims().length, 1, 'releasing live claims keeps unverified stale ones');
  assert.throws(() => restarted.acquireResumeClaim(claimInput(), () => true), /earlier AhaStation run/);
  const next = restarted.acquireResumeClaim(claimInput(), () => false);
  assert.equal(next.status, 'pending');
  assert.deepEqual(restarted.listResumeClaims().map((c) => c.id), [next.id]);
});

test('killing an agent process tree stops the process and its liveness check follows', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', detached: SPAWN_AGENT_PROCESS_GROUP, windowsHide: true,
  });
  await new Promise((resolve) => child.once('spawn', resolve));
  assert.equal(isProcessTreeAlive(child.pid), true);
  const closed = new Promise((resolve) => child.once('exit', resolve));
  killProcessTree(child);
  await closed;
  for (let i = 0; i < 50 && isProcessTreeAlive(child.pid); i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(isProcessTreeAlive(child.pid), false);
  assert.equal(isProcessTreeAlive(-1), false);
});
