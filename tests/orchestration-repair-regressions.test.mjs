import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { atNextDelivery, createTrackedTestService } from './fixtures/tracked-orchestration-service.mjs';
import { setTimeout as delay } from 'node:timers/promises';

import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { syncBundledOrchestrationSkills } from '../dist-electron/orchestration/orchestration-skill-sync.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { prepareWorkerWorktreePlacement } from '../dist-electron/orchestration/worker-worktree-placement.js';

function fixtureDir(t) {
  const path = mkdtempSync(join(tmpdir(), 'aha-orchestration-repair-'));
  t.after(() => rmSync(path, { recursive: true, force: true }));
  return path;
}

function createService(t, { store = new OrchestrationStore(), ...options } = {}) {
  const agents = new AgentStatusStore();
  agents.registerPane('coordinator', { agentId: 'claude' });
  agents.registerPane('worker', { agentId: 'claude' });
  const service = createTrackedTestService({
    store,
    agentStatusStore: agents,
    settleDelayMs: 0,
    writePty: async () => ({ ok: true }),
    ...options,
  });
  t.after(() => service.dispose());
  return { service, store, agents };
}

function assignTask({ service, store }, options = {}) {
  const { run } = service.runCreate({ objective: 'fixture', from: 'coordinator' });
  const { task } = service.taskCreate({ runId: run.id, spec: 'fixture' });
  return store.createDispatchContext({
    taskId: task.id,
    assigneeHandle: 'worker',
    assigneePaneId: 'worker',
    cliId: 'claude',
    ...options,
  });
}

test('worker stop preserves uncommitted work and refuses cleanup when PTY closure fails', async (t) => {
  const root = fixtureDir(t);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(repo, 'init');
  git(repo, 'config', 'user.name', 'Fixture');
  git(repo, 'config', 'user.email', 'fixture@example.test');
  git(repo, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'base');
  const parent = await prepareWorkerWorktreePlacement({ baseCwd: repo, taskId: 'parent' });
  git(parent.cwd, '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'parent');
  const child = await prepareWorkerWorktreePlacement({ baseCwd: parent.cwd, taskId: 'child', worktree: 'new-child' });
  assert.equal(git(child.cwd, 'rev-parse', 'HEAD'), git(parent.cwd, 'rev-parse', 'HEAD'));
  let closed = 0;
  const fixture = createService(t, { closeWorkerPty: async () => { closed += 1; return { ok: false }; } });
  const dispatch = assignTask(fixture, { worktreePath: child.cwd, ownsWorktree: true, ownsPane: true });
  const pending = join(child.cwd, 'pending.txt');
  writeFileSync(pending, 'keep this');
  await assert.rejects(() => fixture.service.workerStop({ dispatchId: dispatch.id, removeWorktree: true }), /uncommitted/);
  assert.equal(closed, 0);
  await assert.rejects(() => fixture.service.workerStop({ dispatchId: dispatch.id, removeWorktree: true, force: true }), /Could not close/);
  assert.equal(readFileSync(pending, 'utf8'), 'keep this');
  assert.equal(fixture.store.getDispatchContext(dispatch.id).status, 'dispatched');
});

test('a concurrent follow-up cannot start a second worker for the same lineage', async (t) => {
  let finishSpawn;
  const pendingSpawn = new Promise(resolve => { finishSpawn = resolve; });
  const fixture = createService(t, {
    isPtyAlive: id => id !== 'worker',
    spawnWorkerPty: () => pendingSpawn,
  });
  const dispatch = assignTask(fixture, { ownsWorktree: true });
  fixture.service.workerDone({
    dispatchId: dispatch.id,
    from: 'worker',
    outcome: 'completed',
    capability: fixture.store.getDispatchCapability(dispatch.id),
  });
  const send = subject => fixture.service.send({ from: 'coordinator', to: `dispatch:${dispatch.id}`, subject });
  const first = send('first');
  try {
    await assert.rejects(() => send('second'), /Another operation/);
  } finally {
    finishSpawn({ ptyId: 'replacement' });
  }
  await first;
  const children = fixture.store.listDispatches().filter(d => d.followUpOfDispatchId === dispatch.id);
  assert.equal(children.length, 1);
  assert.equal(children[0].ownsWorktree, true);
});

test('a deferred dispatch survives store reload and is delivered when the worker confirms trust', async (t) => {
  const file = join(fixtureDir(t), 'orchestration.json');
  const initial = createService(t, { store: new OrchestrationStore({ resolveFile: () => file }) });
  const { run } = initial.service.runCreate({ objective: 'fixture', from: 'coordinator' });
  const { task } = initial.service.taskCreate({ runId: run.id, spec: 'recover this prompt' });
  const trustPrompt = 'Do you trust the files in this folder?\nYes, proceed';
  atNextDelivery(initial.service, () => initial.agents.ingestPtyData('worker', trustPrompt));
  const { dispatch } = await initial.service.dispatchTask({ taskId: task.id, to: 'worker', from: 'coordinator' });
  assert.equal(dispatch.promptSentAt, null);
  await initial.service.waitForPendingWrites();
  const store = new OrchestrationStore({ resolveFile: () => file });
  store.load();
  const writes = [];
  const restored = createService(t, { store, writePty: async (_, text) => { writes.push(text); return { ok: true }; } });
  restored.agents.seedStartupScreen('worker', trustPrompt);
  restored.agents.notifyUserInput('worker', '\r');
  for (let i = 0; i < 100 && !store.getDispatchContext(dispatch.id).promptSentAt; i++) await delay(10);
  assert.equal(writes.filter(text => text.includes('recover this prompt')).length, 1);
  assert.ok(store.getDispatchContext(dispatch.id).promptSentAt);
});

test('only the authenticated coordinator may approve a worker permission request', async (t) => {
  const fixture = createService(t);
  const dispatch = assignTask(fixture);
  const held = fixture.service.handlePermissionHookRequest({
    ptyId: 'worker',
    providerHint: 'claude',
    eventName: 'PermissionRequest',
    rawPayload: {},
    signal: new AbortController().signal,
  });
  const [approval] = fixture.service.getSnapshot(dispatch.runId).openApprovals;
  const approve = (callerPaneId) => dispatchOrchestrationHttpAction(
    fixture.service, 'approve', { id: approval.approvalId },
    { signal: new AbortController().signal, callerPaneId },
  );
  assert.equal((await approve('worker')).body.code, 'operation_rejected');
  assert.equal((await approve(null)).body.code, 'operation_rejected');
  assert.equal((await approve('coordinator')).body.ok, true);
  assert.match((await held).hookStdout, /"behavior":"allow"/);
});

test('approval timeout returns a denial and clears the permission wait', async (t) => {
  const fixture = createService(t, { approvalHoldTimeoutMs: 500 });
  const dispatch = assignTask(fixture);
  fixture.agents.ingestHookEvent({ ptyId: 'worker', state: 'waiting', waitKind: 'permission' });
  const keepAlive = delay(550);
  const reply = await fixture.service.handlePermissionHookRequest({
    ptyId: 'worker',
    providerHint: 'claude',
    eventName: 'PermissionRequest',
    rawPayload: {},
    signal: new AbortController().signal,
  });
  assert.match(reply.hookStdout, /"behavior":"deny"/);
  assert.equal(fixture.service.getSnapshot(dispatch.runId).openApprovals.length, 0);
  assert.equal(fixture.agents.get('worker').state, 'working');
  assert.equal(fixture.store.getDispatchContext(dispatch.id).startObservation, 'observed');
  await keepAlive;
});

test('skill sync preserves a user-owned orchestration skill and publishes aha-orchestration fallback', (t) => {
  const homeDir = fixtureDir(t);
  const directory = join(homeDir, '.agents', 'skills', 'orchestration');
  mkdirSync(directory, { recursive: true });
  const skill = join(directory, 'SKILL.md');
  writeFileSync(skill, '# Aha Custom Orchestration\nRun custom aha orchestration...');
  const result = syncBundledOrchestrationSkills({ homeDir, env: {} });
  assert.equal(readFileSync(skill, 'utf8'), '# Aha Custom Orchestration\nRun custom aha orchestration...');
  assert.ok(result.skippedFiles.includes(skill));
  const fallbackSkill = join(homeDir, '.agents', 'skills', 'aha-orchestration', 'SKILL.md');
  assert.match(readFileSync(fallbackSkill, 'utf8'), /^---\nname: aha-orchestration\n/);
});

test('electron-builder.json unpacks every runtime script loaded outside app.asar', () => {
  const builderCfg = JSON.parse(readFileSync(join(process.cwd(), 'electron-builder.json'), 'utf8'));
  assert.ok(builderCfg.asarUnpack.includes('dist-electron/orchestration/aha-orchestration-cli.cjs'));
  assert.ok(builderCfg.asarUnpack.includes('dist-electron/terminal-daemon/windows-pipe-acl.ps1'));
  assert.ok(builderCfg.asarUnpack.includes('dist-electron/agent/agent-hook-relay.cjs'));
});

test('permission relay falls back cleanly on ECONNREFUSED for interactive sessions while failing closed for managed workers', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  const relayPath = join(process.cwd(), 'electron', 'agent', 'agent-hook-relay.cjs');
  const runDeadRelay = (extraEnv) =>
    new Promise((resolvePromise, rejectPromise) => {
      const child = execFile(
        process.execPath,
        [relayPath, 'claude', 'PermissionRequest'],
        {
          env: {
            ...process.env,
            AHA_AGENT_HOOK_URL: 'http://127.0.0.1:1/hook',
            AHA_AGENT_HOOK_TOKEN: 'a'.repeat(32),
            AHA_TERMINAL_ID: 'local-standalone',
            ...extraEnv,
          },
          timeout: 8_000,
        },
        (err, stdout) => {
          if (err) rejectPromise(err);
          else resolvePromise(String(stdout));
        },
      );
      child.stdin.end(JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }));
    });

  // Unmanaged interactive session after Aha window closes -> silent exit so Claude prompts locally.
  const standaloneOut = await runDeadRelay({});
  assert.equal(standaloneOut, '');

  // Orchestration-managed worker (`AHA_DISPATCH_CAPABILITY` present) -> fail closed (`deny`).
  const workerOut = await runDeadRelay({ AHA_DISPATCH_CAPABILITY: 'cap_secret_123' });
  assert.match(workerOut, /"behavior":"deny"/);
});

test('run-use allows coordinator takeover after prior coordinator exits while blocking worker privilege escalation', async (t) => {
  let coordAlive = true;
  const fixture = createService(t, { isPtyAlive: (id) => (id === 'coordinator' ? coordAlive : true) });
  fixture.agents.registerPane('coordinator-2', { agentId: 'claude' });
  const dispatch = assignTask(fixture);
  const callHttp = (action, payload, callerPaneId) =>
    dispatchOrchestrationHttpAction(fixture.service, action, payload, {
      signal: new AbortController().signal,
      callerPaneId,
    });

  // Active worker cannot hijack run-use, task-update, worker-stop, reply, or reset.
  assert.equal((await callHttp('run-use', { id: dispatch.runId }, 'worker')).body.code, 'operation_rejected');
  assert.equal(
    (await callHttp('task-update', { id: dispatch.taskId, status: 'completed' }, 'worker')).body.code,
    'operation_rejected',
  );
  assert.equal(
    (await callHttp('worker-stop', { dispatchId: dispatch.id }, 'worker')).body.code,
    'operation_rejected',
  );
  assert.equal((await callHttp('reset', { tasks: true }, 'worker')).body.code, 'operation_rejected');

  // Another terminal cannot hijack run-use while original coordinator is still alive.
  assert.equal(
    (await callHttp('run-use', { id: dispatch.runId }, 'coordinator-2')).body.code,
    'operation_rejected',
  );

  // Once original coordinator exits, coordinator-2 can adopt the run via run-use.
  coordAlive = false;
  assert.equal((await callHttp('run-use', { id: dispatch.runId }, 'coordinator-2')).body.ok, true);
  assert.equal(fixture.store.requireRun(dispatch.runId).coordinatorPaneId, 'coordinator-2');
});

test('turn-stop bumps generation again when user manually resumes an awaiting_review worker', async (t) => {
  const fixture = createService(t, { turnStopSettleMs: 25 });
  const dispatch = assignTask(fixture, { ownsPane: true });
  fixture.agents.ingestHookEvent({ ptyId: 'worker', state: 'working' });
  fixture.agents.ingestHookEvent({ ptyId: 'worker', state: 'done', message: 'First pass complete' });
  await delay(60);
  assert.equal(fixture.store.getDispatchContext(dispatch.id).stage, 'awaiting_review');
  assert.equal(fixture.store.getDispatchContext(dispatch.id).turnStopReportedGeneration, 1);

  // Manual prompt in terminal resumes working -> bumps generation to 2 so next stop also escalates.
  fixture.agents.ingestHookEvent({ ptyId: 'worker', state: 'working' });
  assert.equal(fixture.store.getDispatchContext(dispatch.id).processGeneration, 2);
  fixture.agents.ingestHookEvent({ ptyId: 'worker', state: 'done', message: 'Second pass complete' });
  await delay(60);
  assert.equal(fixture.store.getDispatchContext(dispatch.id).turnStopReportedGeneration, 2);
});
