import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { CleanupOutbox } from '../dist-electron/orchestration/cleanup-outbox.js';
import { executeCleanup, guardCleanup } from '../dist-electron/orchestration/cleanup-git.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function plainRepo(dir) {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-b', 'main');
  git(repo, 'config', 'user.name', 'test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  git(repo, 'commit', '--allow-empty', '-m', 'initial');
  return repo;
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'aha-cleanup-'));
  const repo = plainRepo(dir);
  const resolveFile = () => join(dir, 'state.json');
  const store = new OrchestrationStore({ resolveFile });
  const runId = store.createRun({ id: 'cleanup', objective: 'cleanup', coordinatorHandle: 'coord' }).id;
  const worktreePath = join(dir, 'repo.aha-worktrees', '_run-cleanup');
  const branch = 'aha/run/cleanup';
  git(repo, 'worktree', 'add', '-b', branch, worktreePath);
  const intent = { kind: 'run_branch.cleanup', runId, repoRootPath: repo, worktreePath, worktreeBranch: branch, expectedBranchOid: git(repo, 'rev-parse', branch), deleteBranch: true, allowUnmerged: true };
  store.updateRunIntegrationState(runId, { integrationRepoRootPath: repo, integrationWorktreePath: worktreePath, integrationBranch: branch, integrationStatus: 'finalized' });
  const host = { store, now: Date.now, disposed: () => false, guard: e => guardCleanup(store, e, () => false), execute: executeCleanup, lock: (_, fn) => fn() };
  let service, restarted;
  t.after(async () => {
    service?.dispose(); await restarted?.flushDurable(); restarted?.close(); store.close(); rmSync(dir, { recursive: true, force: true });
  });
  const seed = async () => {
    store.saveCleanupEntry({ ...intent, id: 'entry', createdAt: 1, updatedAt: 1, attempts: 0, status: 'pending' });
    await store.flushDurable();
  };
  const restart = async (expected = 'done') => {
    store.close(); restarted = new OrchestrationStore({ resolveFile }); restarted.load();
    service = new OrchestrationService({ store: restarted, agentStatusStore: new AgentStatusStore() });
    for (let i = 0; i < 400 && restarted.listCleanupEntries()[0]?.status !== expected; i++) await sleep(50);
    const entry = restarted.listCleanupEntries()[0]; assert.equal(entry.status, expected, entry.lastError);
    await restarted.flushDurable(); return restarted;
  };
  return { intent, store, repo, branch, host, seed, restart };
}

test('transient worktree remove failure persists one immutable intent and service startup completes it', async t => {
  const { host, intent, restart, repo, branch } = fixture(t);
  host.execute = async () => { throw Error('git worktree remove failed'); };
  const outbox = new CleanupOutbox(host);
  await assert.rejects(outbox.submit(intent), /remove failed/);
  await assert.rejects(outbox.submit(intent), /remove failed/);
  const [pending] = host.store.listCleanupEntries();
  assert.equal(host.store.listCleanupEntries().length, 1);
  assert.equal(pending.status, 'pending'); assert.equal(pending.attempts, 2); assert.ok(pending.nextAttemptAt > pending.updatedAt);
  await restart(); assert.ok(!existsSync(intent.worktreePath)); assert.equal(git(repo, 'branch', '--list', branch), '');
});
for (const scenario of ['crash after flush', 'resources already gone', 'dirty workspace', 'branch moved']) {
  test(`replay: ${scenario}`, async t => {
    const { seed, restart, intent, repo, branch } = fixture(t); await seed();
    if (scenario === 'dirty workspace') writeFileSync(join(intent.worktreePath, 'mine'), 'keep');
    if (scenario === 'branch moved') git(intent.worktreePath, 'commit', '--allow-empty', '-m', 'new');
    if (scenario === 'resources already gone') { git(repo, 'worktree', 'remove', intent.worktreePath); git(repo, 'branch', '-d', branch); }
    const refused = ['dirty workspace', 'branch moved'].includes(scenario);
    const store = await restart(refused ? 'needs_attention' : 'done');
    assert.equal(existsSync(intent.worktreePath), refused); assert.equal(Boolean(git(repo, 'branch', '--list', branch)), refused);
    if (refused) assert.equal(store.getSnapshot(intent.runId).cleanupAttention.length, 1);
    if (scenario === 'dirty workspace') assert.ok(existsSync(join(intent.worktreePath, 'mine')));
  });
}
test('resident ownership and stale claims fence cleanup without starting a process', async t => {
  const { host, intent, store } = fixture(t);
  const task = store.createTask({ runId: intent.runId, spec: 'worker' });
  const dispatch = store.createDispatchContext({ taskId: task.id, assigneeHandle: 'worker', ownsWorktree: true, worktreePath: intent.worktreePath, repoRootPath: intent.repoRootPath, branch: intent.worktreeBranch });
  store.completeDispatch(dispatch.id); store.setDispatchResident(dispatch.id, { targetBranch: 'main' });
  const worker = { ...intent, kind: 'worker.release', dispatchId: dispatch.id, deleteBranch: false };
  const outbox = new CleanupOutbox(host);
  await assert.rejects(outbox.submit(worker), /still be in use/); assert.equal(store.listCleanupEntries().length, 0);
  store.saveCleanupEntry({ ...worker, id: 'r', status: 'pending', updatedAt: 0, attempts: 0 });
  await outbox.recover(); assert.ok(existsSync(intent.worktreePath));
  store.setDispatchResident(dispatch.id, null);
  store.acquireResumeClaim({ workerId: 'worker', dispatchId: dispatch.id, cwd: intent.worktreePath, runId: intent.runId, driver: 'codex', providerSessionId: 'thread' });
  await outbox.recover(); assert.equal(store.listCleanupEntries()[0].attempts, 0); assert.ok(existsSync(intent.worktreePath));
});
test('recheck never forces dirty worktrees or adopts a changed branch OID', async t => {
  const { host, intent, repo, branch } = fixture(t);
  const outbox = new CleanupOutbox(host);
  const path = join(intent.worktreePath, 'mine'); writeFileSync(path, 'keep');
  await assert.rejects(outbox.submit(intent), /uncommitted/);
  const [{ id }] = host.store.listCleanupEntries();
  assert.equal((await outbox.resolve(id, 'recheck')).status, 'needs_attention');
  rmSync(path); git(intent.worktreePath, 'commit', '--allow-empty', '-m', 'moved');
  assert.match((await outbox.resolve(id, 'recheck')).lastError, /OID changed/);
  assert.equal(host.store.listCleanupEntries()[0].expectedBranchOid, intent.expectedBranchOid);
  assert.notEqual(git(repo, 'rev-parse', branch), intent.expectedBranchOid);
  git(intent.worktreePath, 'reset', '--hard', intent.expectedBranchOid);
  assert.equal((await outbox.resolve(id, 'recheck')).status, 'done');
  assert.ok(!existsSync(intent.worktreePath));
  await assert.rejects(outbox.resolve(id, 'dismiss'), { code: 'operation_rejected' });
});

test('dismiss leaves resources and integration state alone, records a fact and permits fresh intent', async t => {
  const { host, store, intent, repo, branch } = fixture(t); const outbox = new CleanupOutbox(host);
  const originalProtection = store.protectedRunReason(intent.runId);
  const path = join(intent.worktreePath, 'mine'); writeFileSync(path, 'keep');
  await assert.rejects(outbox.submit(intent), /uncommitted/);
  const [{ id }] = store.listCleanupEntries();
  assert.equal(store.protectedRunReason(intent.runId), '资源清理尚未完成');
  assert.equal((await outbox.resolve(id, 'dismiss')).status, 'dismissed');
  assert.ok(existsSync(path)); assert.equal(git(repo, 'rev-parse', branch), intent.expectedBranchOid);
  assert.equal(store.getRun(intent.runId).integrationWorktreePath, intent.worktreePath);
  assert.equal(store.protectedRunReason(intent.runId), originalProtection);
  assert.deepEqual(store.listObservationFacts().find(f => f.kind === 'cleanup_dismissed').data,
    { entryId: id, cleanupKind: intent.kind, worktreePath: intent.worktreePath, branch });
  await assert.rejects(outbox.resolve(id, 'recheck'), { code: 'operation_rejected' });
  rmSync(path); assert.ok((await outbox.submit(intent)).removed);
});

test('transient failures stay pending with capped backoff and disappear from attention upon recovery', async t => {
  const { host, store, intent } = fixture(t); const outbox = new CleanupOutbox(host);
  let now = 100; host.now = () => now; host.execute = async () => { throw Error('file busy'); };
  await assert.rejects(outbox.submit(intent), /file busy/);
  const [{ id }] = store.listCleanupEntries();
  await assert.rejects(outbox.resolve(id, 'dismiss'), { code: 'operation_rejected' });
  for (let attempts = 1; attempts <= 14; attempts++) {
    const [e] = store.listCleanupEntries(); assert.equal(e.status, 'pending'); assert.equal(e.attempts, attempts);
    assert.equal(e.nextAttemptAt - now, Math.min(1000 * 2 ** (attempts - 1), 600_000));
    const list = store.getSnapshot(intent.runId).cleanupAttention;
    if (attempts < 6) assert.deepEqual(list, []);
    else assert.deepEqual(list, [{ id, runId: intent.runId, kind: intent.kind, dispatchId: undefined, attempts,
      lastError: e.lastError, worktreePath: intent.worktreePath, branch: intent.worktreeBranch, status: 'pending', updatedAt: now, nextAttemptAt: e.nextAttemptAt }]);
    now = e.nextAttemptAt;
    if (attempts === 14) host.execute = executeCleanup;
    await outbox.recover();
  }
  assert.equal(store.listCleanupEntries()[0].status, 'done'); assert.deepEqual(store.getSnapshot().cleanupAttention, []);
});

test('resolve rejects in-flight entries and revalidates eligibility after locking', async t => {
  const { store, intent, host } = fixture(t); const outbox = new CleanupOutbox(host);
  const entry = { ...intent, id: 'slow', status: 'pending', attempts: 6, createdAt: 1, updatedAt: 1 };
  store.saveCleanupEntry(entry);
  let unblock, started;
  const running = new Promise(resolve => { started = resolve; });
  const finish = new Promise(resolve => { unblock = resolve; });
  host.execute = async (_, force) => { assert.equal(force, false); started(); await finish; throw Error('file busy'); };
  const recovery = outbox.recover(); await running;
  try { await assert.rejects(outbox.resolve(entry.id, 'dismiss'), { code: 'operation_rejected' }); }
  finally { unblock(); await recovery; }
  assert.equal((await outbox.resolve(entry.id, 'recheck')).status, 'pending');
  assert.equal(store.listCleanupEntries()[0].attempts, 1);
  store.saveCleanupEntry(entry);
  host.lock = async (_, fn) => { store.saveCleanupEntry({ ...entry, status: 'done' }); return fn(); };
  await assert.rejects(outbox.resolve(entry.id, 'dismiss'), { code: 'operation_rejected' });
  assert.equal(store.listCleanupEntries()[0].status, 'done');
});

test('retire requires an idle resident and preserves post-integration edits', async t => {
  const { store, intent } = fixture(t);
  const task = store.createTask({ runId: intent.runId, spec: 'worker' });
  const d = store.createDispatchContext({ taskId: task.id, assigneeHandle: 'worker', ownsWorktree: true,
    worktreePath: intent.worktreePath, repoRootPath: intent.repoRootPath, branch: intent.worktreeBranch });
  store.completeDispatch(d.id);
  const service = new OrchestrationService({ store, agentStatusStore: new AgentStatusStore() });
  try {
    const retire = () => service.workerRetire({ dispatchId: d.id });
    await assert.rejects(retire(), { code: 'operation_rejected' });
    store.setDispatchResident(d.id, { targetBranch: 'main', integratedBranchOid: intent.expectedBranchOid, integratedSnapshotOid: intent.expectedBranchOid });
    const path = join(intent.worktreePath, 'mine'); writeFileSync(path, 'keep');
    await assert.rejects(retire(), /uncommitted|dirty/i);
    assert.equal(readFileSync(path, 'utf8'), 'keep'); assert.ok(store.getDispatchContext(d.id).residentAfterIntegration);
    rmSync(path); assert.ok((await retire()).removedWorktree);
    assert.ok(store.getDispatchContext(d.id).releasedAt); assert.ok(!store.getDispatchContext(d.id).residentAfterIntegration);
    assert.ok(!existsSync(intent.worktreePath));
  } finally { service.dispose(); await store.flushDurable(); }
});

test('human cleanup decisions are not HTTP actions', () => {
  const router = readFileSync(new URL('../dist-electron/orchestration/orchestration-http-router.js', import.meta.url), 'utf8');
  assert.match(router, /worker-release/); assert.doesNotMatch(router, /cleanup-resolve|worker-retire/);
});

test('unknown kinds rejected at ingress AND on replay before any executor call', async t => {
  const { host, intent } = fixture(t); let calls = 0; host.execute = async () => { calls++; };
  const outbox = new CleanupOutbox(host);
  for (const kind of ['codex.start_turn', 'pty.deliver_prompt', 'anything']) {
    await assert.rejects(outbox.submit({ ...intent, kind }), /Unknown cleanup kind/);
    await assert.rejects(executeCleanup({ ...intent, kind }, true, () => {}), /Unknown cleanup kind/);
  }
  host.store.saveCleanupEntry({ ...intent, kind: 'unknown', id: 'bad', attempts: 0, updatedAt: 0, status: 'pending' });
  await outbox.recover(); assert.equal(calls, 0); assert.equal(host.store.listCleanupEntries()[0].status, 'needs_attention');
});
