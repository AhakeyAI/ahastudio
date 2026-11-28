import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
