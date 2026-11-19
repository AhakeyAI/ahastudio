import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';

import { AgentHookInstaller } from '../dist-electron/agent/agent-hook-installer.js';
import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { mergeTerminalProcessEnv } from '../dist-electron/local-cli.js';
import { dispatchCompanionHttpAction } from '../dist-electron/orchestration/companion-cli-router.js';
import { createOrchestrationBinShim } from '../dist-electron/orchestration/orchestration-bin-shim.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import {
  ORCHESTRATION_SKILL_REFERENCES,
  syncBundledOrchestrationSkills,
} from '../dist-electron/orchestration/orchestration-skill-sync.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { OrchestrationError } from '../dist-electron/orchestration/orchestration-types.js';
import { resolveWorkerLaunchConfig } from '../dist-electron/orchestration/worker-launch-catalog.js';
import { TerminalRuntimeTracker } from '../dist-electron/terminal-runtime-tracker.js';

const execFileAsync = promisify(execFile);
const CLI_PATH = resolve('electron/orchestration/aha-orchestration-cli.cjs');
const RELAY_PATH = resolve('electron/agent/agent-hook-relay.cjs');

async function createTempGitRepo(prefix = 'aha-p6-repo-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  await execFileAsync('git', ['init'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), '# Test Repo\n', 'utf8');
  await execFileAsync('git', ['add', 'README.md'], { cwd: dir });
  await execFileAsync('git', ['commit', '-m', 'Initial commit'], { cwd: dir });
  return dir;
}

function runNodeScript(scriptPath, args, opts = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = execFile(
      process.execPath,
      [scriptPath, ...args],
      {
        cwd: opts.cwd ?? process.cwd(),
        env: { ...process.env, ...(opts.env ?? {}) },
        timeout: opts.timeoutMs ?? 15_000,
      },
      (err, stdout, stderr) => {
        resolvePromise({
          code: err && typeof err.code === 'number' ? err.code : err ? 1 : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? ''),
        });
      },
    );
    child.on('error', rejectPromise);
    if (opts.stdin !== undefined && child.stdin) {
      child.stdin.end(opts.stdin);
    }
  });
}

test('Phase 6: expanded dispatch lifecycle persistence, synthetic turn-stop escalation, dedup, and deliberate-wait suppressions', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'aha-phase6-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const stateFile = join(tmpDir, 'orch-state.json');
  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  agentStatusStore.registerPane('local-w1', { agentId: 'codex' });
  tracker.registerPty({ ptyId: 'local-w1', cwd: tmpDir, cliId: 'codex' });

  const store = new OrchestrationStore({ resolveFile: () => stateFile });
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async () => ({ ok: true }),
    settleDelayMs: 0,
    turnStopSettleMs: 35,
  });
  t.after(() => service.dispose());

  const { run } = service.runCreate({
    id: 'run_p6',
    objective: 'Test Phase 6 turn stops',
    from: 'local-coord',
    paneId: 'local-coord',
  });
  const { task } = service.taskCreate({
    id: 'task_p6',
    runId: run.id,
    spec: 'Implement widget',
  });

  const dispatched = await service.dispatchTask({
    taskId: task.id,
    to: 'local-w1',
    from: 'local-coord',
  });
  const ctxId = dispatched.dispatch.id;
  const cap = store.getDispatchCapability(ctxId);
  assert.ok(cap);
  assert.equal(dispatched.dispatch.parentPaneId, 'local-coord');
  assert.equal(dispatched.dispatch.processGeneration, 1);

  // Worker starts working and prints output containing its secret capability (must be redacted in tail!).
  agentStatusStore.ingestHookEvent({ ptyId: 'local-w1', state: 'working' });
  tracker.ingestUtf8Data(
    'local-w1',
    `Running build...\r\nSecret cap=${cap}\r\nAll 42 unit tests passed, awaiting review.\r\n`,
  );

  // 1. Deliberate wait suppression: if worker has an open pending `ask` question, turn stop must NOT escalate.
  const askPromise = service.ask({
    from: 'local-w1',
    question: 'Use strict mode?',
    wait: true,
    timeoutMs: 5_000,
    capability: cap,
  });
  await new Promise((r) => setTimeout(r, 15));
  agentStatusStore.ingestHookEvent({ ptyId: 'local-w1', state: 'done' });
  await new Promise((r) => setTimeout(r, 70));

  // Drain coordinator inbox: should ONLY have the question, NOT a synthetic turn-stop escalation!
  const inboxDuringAsk = await service.check({ from: 'local-coord' });
  assert.equal(inboxDuringAsk.messages.length, 1);
  assert.equal(inboxDuringAsk.messages[0].type, 'question');
  service.reply({ id: inboxDuringAsk.messages[0].id, body: 'Yes', from: 'local-coord' });
  await askPromise;

  // 2. Worker resumes working, then stops WITHOUT calling task-done/worker-done -> wakes coordinator check --wait!
  agentStatusStore.ingestHookEvent({ ptyId: 'local-w1', state: 'working' });
  const waitCheckPromise = service.check({
    from: 'local-coord',
    wait: true,
    timeoutMs: 3_000,
  });
  await new Promise((r) => setTimeout(r, 15));
  agentStatusStore.ingestHookEvent({ ptyId: 'local-w1', state: 'done', message: 'Finished edits' });

  const woke = await waitCheckPromise;
  assert.equal(woke.timedOut, false);
  assert.equal(woke.messages.length, 1);
  const esc = woke.messages[0];
  assert.equal(esc.type, 'escalation');
  assert.match(esc.body, /All 42 unit tests passed/);
  assert.equal(esc.body.includes(cap), false, 'dispatch capability must be redacted from terminal tail');
  const escPayload = JSON.parse(esc.payload);
  assert.equal(escPayload.syntheticTurnStop, true);
  assert.equal(escPayload.stopReason, 'finished');

  // Coordinator tick must NOT settle/fail the active dispatch on a non-exit synthetic turn-stop escalation.
  await service.coordinatorTick(run.id, { workerPaneIds: [] });
  const afterStopCtx = store.getDispatchContext(ctxId);
  assert.equal(afterStopCtx.status, 'dispatched');
  assert.equal(afterStopCtx.turnStopReportedGeneration, 1);
  assert.equal(afterStopCtx.stage, 'awaiting_review');

  // 3. Deduplication within same generation: another done signal does NOT emit a second escalation.
  agentStatusStore.ingestHookEvent({ ptyId: 'local-w1', state: 'idle' });
  agentStatusStore.ingestHookEvent({ ptyId: 'local-w1', state: 'done' });
  await new Promise((r) => setTimeout(r, 70));
  const dupCheck = await service.check({ from: 'local-coord' });
  assert.equal(dupCheck.count, 0);

  // 4. Steering bumps generation to 2, allowing a subsequent turn stop to escalate again.
  service.send({
    from: 'local-coord',
    to: `dispatch:${ctxId}`,
    subject: 'Please call task-done',
    body: 'Wrap up and call task-done.',
  });
  assert.equal(store.getDispatchContext(ctxId).processGeneration, 2);

  // Persist & reload into a brand-new store instance to verify Phase 6 field hydration.
  store.flushSync();
  const reloadedStore = new OrchestrationStore({ resolveFile: () => stateFile });
  reloadedStore.load();
  const hydrated = reloadedStore.getDispatchContext(ctxId);
  assert.equal(hydrated.parentPaneId, 'local-coord');
  assert.equal(hydrated.processGeneration, 2);
  assert.equal(hydrated.turnStopReportedGeneration, 1);

  // Settle via task-done alias.
  const settled = service.taskDone({
    from: 'local-w1',
    dispatchId: ctxId,
    summary: 'Widget complete',
    capability: cap,
  });
  assert.equal(settled.dispatch.status, 'completed');
  assert.equal(settled.dispatch.stage, 'done');
  assert.equal(settled.task.status, 'completed');
});

test('Phase 7: 6-CLI launch catalog validation, worker-start isolated Git worktrees, --no-worktree, rollback, and depth guard', async (t) => {
  // 1. Verify all 6 integrated CLIs in resolveWorkerLaunchConfig
  assert.deepEqual(
    resolveWorkerLaunchConfig({ cliId: 'claude', model: 'claude-opus-4-7', effort: 'max' }).extraArgs,
    ['--model', 'claude-opus-4-7', '--effort', 'max'],
  );
  assert.throws(
    () => resolveWorkerLaunchConfig({ cliId: 'claude', model: 'claude-haiku-4-5', effort: 'low' }),
    (e) => e instanceof OrchestrationError && e.code === 'invalid_argument',
  );

  assert.deepEqual(
    resolveWorkerLaunchConfig({ cliId: 'codex', model: 'gpt-5.4', effort: 'xhigh' }).extraArgs,
    ['-m', 'gpt-5.4', '-c', 'model_reasoning_effort="xhigh"'],
  );
  assert.throws(
    () => resolveWorkerLaunchConfig({ cliId: 'codex', model: 'gpt-5.5', effort: 'ultra' }),
    (e) => e instanceof OrchestrationError && e.code === 'invalid_argument',
  );

  assert.deepEqual(
    resolveWorkerLaunchConfig({ cliId: 'gemini', model: 'gemini-2.5-pro' }).extraArgs,
    ['-m', 'gemini-2.5-pro'],
  );
  assert.throws(
    () => resolveWorkerLaunchConfig({ cliId: 'gemini', model: 'gemini-2.5-pro', effort: 'high' }),
    (e) => e instanceof OrchestrationError && e.code === 'invalid_argument',
  );

  assert.deepEqual(
    resolveWorkerLaunchConfig({ cliId: 'opencode', model: 'openai/gpt-5.4' }).extraArgs,
    ['--model', 'openai/gpt-5.4'],
  );
  assert.throws(
    () => resolveWorkerLaunchConfig({ cliId: 'opencode', model: 'openai/gpt-5.4', effort: 'low' }),
    (e) => e instanceof OrchestrationError && e.code === 'invalid_argument',
  );

  assert.deepEqual(
    resolveWorkerLaunchConfig({ cliId: 'agy', model: 'gemini-3.1-pro', effort: 'high' }),
    {
      cliId: 'antigravity',
      model: 'gemini-3.1-pro',
      effort: 'high',
      extraArgs: ['--model', 'gemini-3.1-pro', '--effort', 'high'],
    },
  );
  assert.throws(
    () => resolveWorkerLaunchConfig({ cliId: 'antigravity', model: 'gemini-3.1-pro', effort: 'xhigh' }),
    (e) => e instanceof OrchestrationError && e.code === 'invalid_argument',
  );

  assert.deepEqual(
    resolveWorkerLaunchConfig({ cliId: 'grok', model: 'grok-4.6-beta', effort: 'xhigh' }).extraArgs,
    ['-m', 'grok-4.6-beta', '--reasoning-effort', 'xhigh'],
  );
  assert.throws(
    () => resolveWorkerLaunchConfig({ cliId: 'grok', model: 'grok-4.5', effort: 'xhigh' }),
    (e) => e instanceof OrchestrationError && e.code === 'invalid_argument',
  );
  assert.throws(
    () => resolveWorkerLaunchConfig({ cliId: 'claude', effort: 'high' }),
    (e) => e instanceof OrchestrationError && e.code === 'invalid_argument',
  );
  assert.throws(
    () => resolveWorkerLaunchConfig({ cliId: 'claude', model: 'sonnet', reusingTerminal: true }),
    (e) => e instanceof OrchestrationError && e.code === 'invalid_argument',
  );

  // 2. Real Git worktree creation, rollback on spawn failure, --no-worktree, and nested worker depth guard
  const repoDir = await createTempGitRepo('aha-p7-git-');
  const worktreesSiblingDir = `${repoDir}.aha-worktrees`;
  t.after(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesSiblingDir, { recursive: true, force: true });
  });

  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: repoDir, cliId: 'claude' });

  let spawnCounter = 0;
  let failNextSpawn = false;
  const spawnedCalls = [];
  const spawnedEvents = [];

  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    getDefaultCwd: () => repoDir,
    maxDepth: 2,
    settleDelayMs: 0,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async (opts) => {
      if (failNextSpawn) {
        failNextSpawn = false;
        throw new Error('Simulated PTY spawn failure');
      }
      spawnCounter += 1;
      const ptyId = `local-orch-w${spawnCounter}`;
      spawnedCalls.push({ ...opts, ptyId });
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId });
      tracker.registerPty({ ptyId, cwd: opts.cwd, cliId: opts.cliId });
      return { ptyId, agentId: opts.cliId, cwd: opts.cwd };
    },
    closeWorkerPty: async (ptyId) => {
      tracker.markExited(ptyId, 0);
      agentStatusStore.removePane(ptyId);
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
  });
  service.onPaneSpawned((ev) => spawnedEvents.push(ev));
  t.after(() => service.dispose());

  // Spawn failure must roll back the newly created Git worktree cleanly.
  failNextSpawn = true;
  await assert.rejects(
    () =>
      service.workerStart({
        from: 'local-coord',
        spec: 'Should rollback worktree',
        agent: 'claude',
        cwd: repoDir,
      }),
    (err) => err instanceof OrchestrationError && err.code === 'terminal_unavailable',
  );
  const { stdout: wtListAfterRollback } = await execFileAsync(
    'git',
    ['worktree', 'list', '--porcelain'],
    { cwd: repoDir },
  );
  assert.equal(
    wtListAfterRollback.split(/\r?\n/).filter((l) => l.startsWith('worktree ')).length,
    1,
    'failed spawn must remove its temporary git worktree',
  );

  // Successful autonomous worker-start with isolated Git worktree + model/effort flags.
  const w1 = await service.workerStart({
    from: 'local-coord',
    spec: 'Build auth module',
    taskTitle: 'Auth Module',
    agent: 'codex',
    model: 'gpt-5.4',
    effort: 'high',
    cwd: repoDir,
  });
  assert.equal(w1.ownsWorktree, true);
  assert.equal(w1.ownsPane, true);
  assert.ok(w1.worktreePath && existsSync(w1.worktreePath));
  assert.notEqual(resolve(w1.worktreePath), resolve(repoDir));
  assert.match(w1.branch, /^aha\/worker\//);
  assert.deepEqual(spawnedCalls[0].extraArgs, ['-m', 'gpt-5.4', '-c', 'model_reasoning_effort="high"']);
  assert.equal(spawnedEvents[0].parentPaneId, 'local-coord');
  assert.equal(spawnedEvents[0].dispatchId, w1.dispatch.id);

  // Depth 2 child worker launched by w1 (--no-worktree) succeeds.
  const w2 = await service.workerStart({
    from: w1.ptyId,
    spec: 'Write unit tests for auth',
    agent: 'gemini',
    model: 'gemini-2.5-pro',
    noWorktree: true,
  });
  assert.equal(w2.dispatch.depth, 2);
  assert.equal(w2.dispatch.creatorDispatchId, w1.dispatch.id);
  assert.equal(w2.dispatch.parentPaneId, w1.ptyId);
  assert.equal(w2.ownsWorktree, false);
  assert.equal(resolve(w2.worktreePath), resolve(w1.worktreePath));

  // Depth 3 grandchild worker launched by w2 must be rejected BEFORE spawning PTY or worktree!
  const spawnsBeforeDepthReject = spawnCounter;
  await assert.rejects(
    () =>
      service.workerStart({
        from: w2.ptyId,
        spec: 'Exceed maxDepth=2',
        agent: 'claude',
      }),
    (err) => err instanceof OrchestrationError && err.code === 'operation_rejected',
  );
  assert.equal(spawnCounter, spawnsBeforeDepthReject, 'depth guard must reject before spawning PTY');

  // Clean up w1's worktree via workerStop.
  await service.workerStop({ dispatchId: w2.dispatch.id, force: true });
  await service.workerStop({ dispatchId: w1.dispatch.id, removeWorktree: true, force: true });
  assert.equal(existsSync(w1.worktreePath), false);
});

test('Phase 8: worker-show, worker-read, send follow-up reactivation (live & respawned), and worker-release safety guards', async (t) => {
  const repoDir = await createTempGitRepo('aha-p8-git-');
  const worktreesSiblingDir = `${repoDir}.aha-worktrees`;
  t.after(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesSiblingDir, { recursive: true, force: true });
  });

  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: repoDir, cliId: 'claude' });

  let seq = 0;
  const closedPtys = [];
  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    getDefaultCwd: () => repoDir,
    settleDelayMs: 0,
    turnStopSettleMs: 5_000,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async (opts) => {
      seq += 1;
      const ptyId = `local-orch-p8-${seq}`;
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId });
      tracker.registerPty({ ptyId, cwd: opts.cwd, cliId: opts.cliId });
      return { ptyId, agentId: opts.cliId, cwd: opts.cwd };
    },
    closeWorkerPty: async (ptyId) => {
      closedPtys.push(ptyId);
      tracker.markExited(ptyId, 0);
      agentStatusStore.removePane(ptyId);
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
  });
  t.after(() => service.dispose());

  const started = await service.workerStart({
    from: 'local-coord',
    spec: 'Initial implementation',
    agent: 'claude',
    model: 'claude-sonnet-4-6',
    effort: 'medium',
    cwd: repoDir,
  });
  const d1 = started.dispatch;
  tracker.ingestUtf8Data(started.ptyId, 'Step 1 output line\r\nStep 2 output line\r\n');

  const shown = service.workerShow({ dispatchId: d1.id });
  assert.equal(shown.dispatch.id, d1.id);
  assert.equal(shown.paneAlive, true);

  const screenRead = service.workerRead({ dispatchId: d1.id, screen: true });
  assert.match(screenRead.text, /Step 2 output line/);

  // Settle d1 via taskDone.
  const cap1 = store.getDispatchCapability(d1.id);
  service.taskDone({
    from: started.ptyId,
    dispatchId: d1.id,
    summary: 'Initial pass done',
    capability: cap1,
  });

  // workerRelease must refuse while unread worker_done report mail is still unacknowledged!
  await assert.rejects(
    () => service.workerRelease({ dispatchId: d1.id }),
    (err) => err instanceof OrchestrationError && err.code === 'operation_rejected',
  );

  // Coordinator reads mail via check.
  const checked = await service.check({ from: 'local-coord' });
  assert.equal(checked.count, 1);

  // Phase 8 `send` follow-up reactivation on live pane!
  const followUp1 = await service.send({
    from: 'local-coord',
    to: `dispatch:${d1.id}`,
    subject: 'Handle null input',
    body: 'Add guard for null input.',
  });
  assert.ok(followUp1.followUp?.reactivated);
  assert.equal(followUp1.followUp.reusedPane, true);
  const d2 = followUp1.followUp.dispatch;
  assert.equal(d2.followUpOfDispatchId, d1.id);
  assert.equal(d2.processGeneration, 2);
  assert.equal(d2.ownsWorktree, true);
  assert.equal(store.getDispatchContext(d1.id).ownsWorktree, false, 'worktree custody transferred to d2');

  // Settle d2 and simulate its pane exiting, then send another follow-up to original d1.id -> must follow lineage & respawn PTY!
  const cap2 = store.getDispatchCapability(d2.id);
  service.taskDone({
    from: d2.assigneePaneId,
    dispatchId: d2.id,
    summary: 'Null guard added',
    capability: cap2,
  });
  await service.check({ from: 'local-coord' });
  tracker.markExited(d2.assigneePaneId, 0);
  service.markPtyExited(d2.assigneePaneId);

  const followUp2 = await service.send({
    from: 'local-coord',
    to: `dispatch:${d1.id}`,
    subject: 'One more tweak',
    body: 'Update changelog too.',
  });
  assert.ok(followUp2.followUp?.reactivated);
  assert.equal(followUp2.followUp.reusedPane, false, 'exited worker pane respawns in same worktree');
  const d3 = followUp2.followUp.dispatch;
  assert.equal(d3.followUpOfDispatchId, d2.id);
  assert.equal(d3.processGeneration, 3);
  assert.equal(resolve(d3.worktreePath), resolve(started.worktreePath));

  // Settle d3 and read report.
  const cap3 = store.getDispatchCapability(d3.id);
  tracker.ingestUtf8Data(d3.assigneePaneId, 'Final archived transcript line\r\n');
  service.taskDone({
    from: d3.assigneePaneId,
    dispatchId: d3.id,
    summary: 'Changelog updated',
    capability: cap3,
  });
  await service.check({ from: 'local-coord' });

  // Dirty worktree guard: uncommitted file blocks non-force workerRelease.
  const dirtyFile = join(d3.worktreePath, 'uncommitted.txt');
  writeFileSync(dirtyFile, 'dirty\n', 'utf8');
  await assert.rejects(
    () => service.workerRelease({ dispatchId: d1.id }),
    (err) => err instanceof OrchestrationError && err.code === 'operation_rejected',
  );

  // Remove dirty file -> clean workerRelease removes worktree, closes PTY, and preserves archived output!
  rmSync(dirtyFile, { force: true });
  const released = await service.workerRelease({ dispatchId: d1.id });
  assert.equal(released.closedPane, true);
  assert.equal(released.removedWorktree, true);
  assert.equal(released.dispatch.stage, 'released');
  assert.equal(existsSync(d3.worktreePath), false);

  const archivedRead = service.workerRead({ dispatchId: d3.id });
  assert.equal(archivedRead.archived, true);
  assert.match(archivedRead.text, /Final archived transcript line/);
});

test('Phase 9 & Phase 10: end-to-end held permission approvals (approve/deny) + 6-CLI skill sync + aha terminal/worktree/skills CLI', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'aha-p9-home-'));
  const repoDir = await createTempGitRepo('aha-p10-repo-');
  const worktreesSiblingDir = `${repoDir}.aha-worktrees`;
  t.after(() => {
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesSiblingDir, { recursive: true, force: true });
  });

  // Phase 10a: Verify 6-CLI skill sync (including ~/.config/opencode when present & CODEX_HOME) + idempotency.
  mkdirSync(join(tmpHome, '.config', 'opencode'), { recursive: true });
  const codexCustom = join(tmpHome, '.codex-custom');
  const firstSync = syncBundledOrchestrationSkills({
    homeDir: tmpHome,
    env: { CODEX_HOME: codexCustom },
  });
  const expectedSkillDirs = [
    join(tmpHome, '.agents', 'skills', 'orchestration'),
    join(codexCustom, 'skills', 'orchestration'),
    join(tmpHome, '.config', 'opencode', 'skills', 'orchestration'),
    join(tmpHome, '.claude', 'skills', 'orchestration'),
    join(tmpHome, '.gemini', 'skills', 'orchestration'),
    join(tmpHome, '.gemini', 'config', 'skills', 'orchestration'),
    join(tmpHome, '.grok', 'skills', 'orchestration'),
  ];
  for (const dir of expectedSkillDirs) {
    assert.equal(existsSync(join(dir, 'SKILL.md')), true, `missing SKILL.md in ${dir}`);
    for (const refFile of Object.keys(ORCHESTRATION_SKILL_REFERENCES)) {
      assert.equal(existsSync(join(dir, 'references', refFile)), true, `missing ${refFile} in ${dir}`);
    }
  }
  assert.ok(firstSync.updatedFiles.length >= expectedSkillDirs.length * 6);
  const secondSync = syncBundledOrchestrationSkills({
    homeDir: tmpHome,
    env: { CODEX_HOME: codexCustom },
  });
  assert.equal(secondSync.updatedFiles.length, 0, 'second skill sync must be idempotent');

  // Spin up real AgentHookServer + OrchestrationService + Companion CLI router.
  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  const writes = [];
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  agentStatusStore.registerPane('local-worker', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: repoDir, cliId: 'claude' });
  tracker.registerPty({ ptyId: 'local-worker', cwd: repoDir, cliId: 'claude' });
  tracker.ingestUtf8Data('local-worker', 'Worker boot ready\r\n');

  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    getDefaultCwd: () => repoDir,
    settleDelayMs: 0,
    turnStopSettleMs: 10_000,
    writePty: async (ptyId, data) => {
      writes.push({ ptyId, data });
      return { ok: true };
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
  });

  const hookServer = new AgentHookServer(agentStatusStore);
  const binShim = createOrchestrationBinShim({ binDir: join(tmpHome, 'bin') });
  hookServer.setOrchestrationBinShim(binShim);
  hookServer.setOrchestrationHandler((action, payload, context) =>
    dispatchOrchestrationHttpAction(service, action, payload, context),
  );
  hookServer.setPermissionHookInterceptor((req) => service.handlePermissionHookRequest(req));
  hookServer.setCompanionHandler((namespace, action, payload, context) =>
    dispatchCompanionHttpAction(
      {
        terminalTracker: tracker,
        agentStatusStore,
        writePty: async (ptyId, data) => {
          writes.push({ ptyId, data });
          return { ok: true };
        },
        getDefaultCwd: () => repoDir,
        orchestrationService: () => service,
      },
      namespace,
      action,
      payload,
      context,
    ),
  );

  await hookServer.start();
  t.after(async () => {
    service.dispose();
    await hookServer.stop();
  });

  const coordEnv = hookServer.envForPane('local-coord');
  const workerEnv = hookServer.envForPane('local-worker');

  // Create run & dispatch task to local-worker.
  const { run } = service.runCreate({
    id: 'run_p9',
    objective: 'Permission approval E2E',
    from: 'local-coord',
    paneId: 'local-coord',
  });
  const { task } = service.taskCreate({
    id: 'task_p9',
    runId: run.id,
    spec: 'Run migrations safely',
  });
  const { dispatch } = await service.dispatchTask({
    taskId: task.id,
    to: 'local-worker',
    from: 'local-coord',
  });

  // Phase 9a: Launch real agent-hook-relay.cjs with Claude PermissionRequest -> request is HELD!
  const coordWait = service.check({ from: 'local-coord', wait: true, timeoutMs: 5_000 });
  const claudeRelayPromise = runNodeScript(RELAY_PATH, ['claude', 'PermissionRequest'], {
    env: workerEnv,
    stdin: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'npm run db:migrate' },
    }),
  });

  const approvalMail = await coordWait;
  assert.equal(approvalMail.messages.length, 1);
  const approvalPayload = JSON.parse(approvalMail.messages[0].payload);
  assert.equal(approvalPayload.permissionApproval, true);
  const approvalId = approvalPayload.approvalId;
  assert.match(approvalId, /^perm_/);
  assert.equal(service.getSnapshot().openApprovals.length, 1);

  // Approve via real CLI (`aha orchestration approve --id <perm_id> --json`).
  const approveCli = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'approve', '--id', approvalId, '--json'],
    { env: coordEnv },
  );
  assert.equal(approveCli.code, 0, approveCli.stderr);

  const claudeRelayRes = await claudeRelayPromise;
  assert.equal(claudeRelayRes.code, 0);
  const claudeHookOut = JSON.parse(claudeRelayRes.stdout.trim());
  assert.equal(claudeHookOut.hookSpecificOutput.decision.behavior, 'allow');

  // Duplicate approve returns exit code 1 with approval_already_resolved.
  const dupApprove = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'approve', '--id', approvalId, '--json'],
    { env: coordEnv },
  );
  assert.equal(dupApprove.code, 1);
  assert.match(dupApprove.stderr, /approval_already_resolved/);

  // Phase 9b: Antigravity PreToolUse (ask_permission) -> deny via real CLI!
  const coordWait2 = service.check({ from: 'local-coord', wait: true, timeoutMs: 5_000 });
  const agyRelayPromise = runNodeScript(RELAY_PATH, ['antigravity', 'PreToolUse'], {
    env: workerEnv,
    stdin: JSON.stringify({
      hook_event_name: 'PreToolUse',
      tool_name: 'ask_permission',
      tool_input: { command: 'rm -rf dist' },
    }),
  });
  const denyMail = await coordWait2;
  const denyApprovalId = JSON.parse(denyMail.messages[0].payload).approvalId;

  const denyCli = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'deny', '--id', denyApprovalId, '--reason', 'Keep dist directory', '--json'],
    { env: coordEnv },
  );
  assert.equal(denyCli.code, 0, denyCli.stderr);

  const agyRelayRes = await agyRelayPromise;
  assert.equal(agyRelayRes.code, 0);
  const agyHookOut = JSON.parse(agyRelayRes.stdout.trim());
  assert.equal(agyHookOut.decision, 'deny');
  assert.equal(agyHookOut.reason, 'Keep dist directory');

  // Phase 10b: Test `aha terminal`, `aha worktree`, and `aha skills` via real CLI!
  const termList = await runNodeScript(CLI_PATH, ['terminal', 'list', '--json'], { env: coordEnv });
  assert.equal(termList.code, 0, termList.stderr);
  assert.equal(JSON.parse(termList.stdout).count, 2);

  const termRead = await runNodeScript(
    CLI_PATH,
    ['terminal', 'read', '--id', 'local-worker', '--screen', '--json'],
    { env: coordEnv },
  );
  assert.equal(termRead.code, 0, termRead.stderr);
  assert.match(JSON.parse(termRead.stdout).text, /Worker boot ready/);

  const termSend = await runNodeScript(
    CLI_PATH,
    ['terminal', 'send', '--id', 'local-worker', '--text', 'echo hello', '--json'],
    { env: coordEnv },
  );
  assert.equal(termSend.code, 0, termSend.stderr);
  assert.ok(writes.some((w) => w.ptyId === 'local-worker' && w.data.includes('echo hello')));

  // Worker completes its turn after tool denial before waiting for TUI idle.
  agentStatusStore.ingestHookEvent({ ptyId: 'local-worker', state: 'done' });

  const termWait = await runNodeScript(
    CLI_PATH,
    ['terminal', 'wait', '--id', 'local-worker', '--for', 'tui-idle', '--idle-ms', '100', '--timeout-ms', '2000', '--json'],
    { env: coordEnv },
  );
  assert.equal(termWait.code, 0, termWait.stderr);
  assert.equal(JSON.parse(termWait.stdout).satisfied, true);

  const wtCreate = await runNodeScript(
    CLI_PATH,
    ['worktree', 'create', '--cwd', repoDir, '--branch', 'feat/cli-wt', '--json'],
    { env: coordEnv },
  );
  assert.equal(wtCreate.code, 0, wtCreate.stderr);
  const createdWtPath = JSON.parse(wtCreate.stdout).path;
  assert.equal(existsSync(createdWtPath), true);

  const wtList = await runNodeScript(
    CLI_PATH,
    ['worktree', 'list', '--cwd', repoDir, '--json'],
    { env: coordEnv },
  );
  assert.equal(wtList.code, 0, wtList.stderr);
  assert.equal(JSON.parse(wtList.stdout).count, 2);

  const wtRemove = await runNodeScript(
    CLI_PATH,
    ['worktree', 'remove', '--cwd', repoDir, '--path', createdWtPath, '--json'],
    { env: coordEnv },
  );
  assert.equal(wtRemove.code, 0, wtRemove.stderr);
  assert.equal(existsSync(createdWtPath), false);

  const skillsGet = await runNodeScript(
    CLI_PATH,
    ['skills', 'get', '--name', 'orchestration', '--reference', 'workers.md', '--json'],
    { env: coordEnv },
  );
  assert.equal(skillsGet.code, 0, skillsGet.stderr);
  assert.match(JSON.parse(skillsGet.stdout).content, /worker-start/);
  assert.ok(dispatch.id);
});

test('Phase 11: Crew read-model (managedBy/managing/talkingWith), sidebar lineage indentation, and terminal #task/@handle links', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-p11-ui-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const compileModule = (relPath, outName, rewrites = []) => {
    const src = ts.sys.readFile(resolve(relPath), 'utf8');
    let code = ts.transpileModule(src, {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    for (const [from, to] of rewrites) {
      code = code.replaceAll(from, to);
    }
    const outFile = join(dir, outName);
    writeFileSync(outFile, code, 'utf8');
    return pathToFileURL(outFile).href;
  };

  compileModule('src/lib/git-panel-model.ts', 'git-panel-model.mjs');
  compileModule('src/lib/orchestration-view.ts', 'orchestration-view.mjs');
  const crewUrl = compileModule('src/lib/orchestration-crew-model.ts', 'orchestration-crew-model.mjs', [
    ["'./git-panel-model'", "'./git-panel-model.mjs'"],
    ["'./orchestration-view'", "'./orchestration-view.mjs'"],
  ]);
  const linksUrl = compileModule(
    'src/lib/terminal-links/orchestration-terminal-links.ts',
    'orchestration-terminal-links.mjs',
    [["'../orchestration-crew-model'", "'./orchestration-crew-model.mjs'"]],
  );

  const crewMod = await import(crewUrl);
  const linksMod = await import(linksUrl);

  const snapshot = {
    runs: [
      {
        id: 'run_1',
        objective: 'Ship Phase 11 UI',
        status: 'active',
        coordinatorHandle: 'local-root',
        coordinatorPaneId: 'local-root',
        consumerGeneration: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        endedAt: null,
      },
    ],
    tasks: [
      {
        id: 'task_a',
        runId: 'run_1',
        spec: 'Backend API',
        taskTitle: 'Backend API',
        displayName: 'Backend API',
        deps: [],
        priority: 'normal',
        status: 'completed',
        worktreePath: 'C:/proj.aha-worktrees/wt-a',
        createdAt: '2026-01-01T00:00:01.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        latestDispatch: null,
      },
      {
        id: 'task_a_followup',
        runId: 'run_1',
        spec: 'Backend API follow-up',
        taskTitle: 'Backend API v2',
        displayName: 'Backend API v2',
        deps: [],
        priority: 'normal',
        status: 'dispatched',
        worktreePath: 'C:/proj.aha-worktrees/wt-a',
        createdAt: '2026-01-01T00:00:03.000Z',
        updatedAt: '2026-01-01T00:00:03.000Z',
        latestDispatch: null,
      },
      {
        id: 'task_sub',
        runId: 'run_1',
        spec: 'Sub-worker helper',
        taskTitle: 'Sub-worker helper',
        displayName: 'Sub-worker helper',
        deps: [],
        priority: 'normal',
        status: 'dispatched',
        worktreePath: 'C:/proj.aha-worktrees/wt-a',
        createdAt: '2026-01-01T00:00:04.000Z',
        updatedAt: '2026-01-01T00:00:04.000Z',
        latestDispatch: null,
      },
    ],
    dispatches: [
      {
        id: 'ctx_1',
        taskId: 'task_a',
        runId: 'run_1',
        creator: 'local-root',
        creatorRunId: 'run_1',
        parentPaneId: 'local-root',
        depth: 1,
        assigneeHandle: 'local-orch-a',
        assigneePaneId: 'local-orch-a',
        processIncarnation: null,
        worktreePath: 'C:/proj.aha-worktrees/wt-a',
        branch: 'aha/worker/wt-a',
        ownsWorktree: false,
        ownsPane: false,
        cliId: 'claude',
        status: 'completed',
        failureCount: 0,
        lastFailureReason: null,
        failureSummary: null,
        lastHeartbeatAt: null,
        consumerGeneration: 1,
        createdAt: '2026-01-01T00:00:01.000Z',
        updatedAt: '2026-01-01T00:00:02.000Z',
        completedAt: '2026-01-01T00:00:02.000Z',
      },
      {
        id: 'ctx_2',
        taskId: 'task_a_followup',
        runId: 'run_1',
        creator: 'local-root',
        creatorRunId: 'run_1',
        parentPaneId: 'local-root',
        followUpOfDispatchId: 'ctx_1',
        depth: 1,
        assigneeHandle: 'local-orch-a',
        assigneePaneId: 'local-orch-a',
        processIncarnation: null,
        worktreePath: 'C:/proj.aha-worktrees/wt-a',
        branch: 'aha/worker/wt-a',
        ownsWorktree: true,
        ownsPane: true,
        cliId: 'claude',
        model: 'claude-sonnet-4-6',
        effort: 'high',
        processGeneration: 2,
        status: 'dispatched',
        startObservation: 'observed',
        failureCount: 0,
        lastFailureReason: null,
        failureSummary: null,
        lastHeartbeatAt: null,
        consumerGeneration: 1,
        createdAt: '2026-01-01T00:00:03.000Z',
        updatedAt: '2026-01-01T00:00:03.000Z',
        completedAt: null,
      },
      {
        id: 'ctx_sub',
        taskId: 'task_sub',
        runId: 'run_1',
        creator: 'local-orch-a',
        creatorRunId: 'run_1',
        creatorDispatchId: 'ctx_2',
        parentPaneId: 'local-orch-a',
        depth: 2,
        assigneeHandle: 'local-orch-sub',
        assigneePaneId: 'local-orch-sub',
        processIncarnation: null,
        worktreePath: 'C:/proj.aha-worktrees/wt-a',
        cliId: 'gemini',
        status: 'dispatched',
        startObservation: 'observed',
        failureCount: 0,
        lastFailureReason: null,
        failureSummary: null,
        lastHeartbeatAt: null,
        consumerGeneration: 1,
        createdAt: '2026-01-01T00:00:04.000Z',
        updatedAt: '2026-01-01T00:00:04.000Z',
        completedAt: null,
      },
    ],
    gates: [],
    messages: [
      {
        id: 'msg_peer',
        runId: 'run_1',
        seq: 1,
        type: 'status',
        priority: 'normal',
        fromHandle: 'local-peer-reviewer',
        toHandle: 'local-root',
        subject: 'LGTM on schema',
        body: 'Looks good',
        payload: null,
        threadId: null,
        deliveredAt: null,
        read: false,
        createdAt: '2026-01-01T00:00:05.000Z',
        lifecycleRejectedReason: null,
      },
    ],
    questions: [],
    openApprovals: [
      {
        approvalId: 'perm_abc123',
        dispatchId: 'ctx_2',
        taskId: 'task_a_followup',
        runId: 'run_1',
        workerHandle: 'local-orch-a',
        ptyId: 'local-orch-a',
        provider: 'claude',
        eventName: 'PermissionRequest',
        toolName: 'Bash',
        toolInput: 'npm test',
        status: 'pending',
        createdAt: '2026-01-01T00:00:06.000Z',
      },
    ],
    coordinatorRuns: [],
    activeCoordinatorRun: null,
    currentRunByConsumer: { 'local-root': 'run_1' },
  };

  // Coordinator crew view collapses ctx_1 -> ctx_2 into a single Managing row, surfaces openApproval, and tracks Talking with peer.
  const rootCrew = crewMod.buildCrewViewForPane(snapshot, 'local-root');
  assert.equal(rootCrew.isVisible, true);
  assert.equal(rootCrew.managedBy, null);
  assert.equal(rootCrew.managing.length, 1);
  assert.equal(rootCrew.managing[0].dispatch.id, 'ctx_2');
  assert.equal(rootCrew.managing[0].stage, 'waiting_permission');
  assert.equal(rootCrew.openApprovals.length, 1);
  assert.equal(rootCrew.talkingWith.length, 1);
  assert.equal(rootCrew.talkingWith[0].handle, 'local-peer-reviewer');

  // Worker `local-orch-a` has `managedBy` = Coordinator and `managing` = `ctx_sub`!
  const workerCrew = crewMod.buildCrewViewForPane(snapshot, 'local-orch-a');
  assert.equal(workerCrew.managedBy.role, 'coordinator');
  assert.equal(workerCrew.managedBy.ptyId, 'local-root');
  assert.equal(workerCrew.managing.length, 1);
  assert.equal(workerCrew.managing[0].dispatch.id, 'ctx_sub');

  // Sidebar lineage: sub-worker (depth 2) nested under worker (depth 1) nested under root (depth 0), all mapped to C:/proj!
  const windows = [
    { id: 'orch-sub', cwd: 'C:/proj.aha-worktrees/wt-a' },
    { id: 'root', cwd: 'C:/proj' },
    { id: 'orch-a', cwd: 'C:/proj.aha-worktrees/wt-a' },
  ];
  const lineage = crewMod.buildSidebarWindowLineage(windows, snapshot, (id) => [id], 'C:/proj');
  assert.deepEqual(
    lineage.map((x) => ({ id: x.win.id, depth: x.depth, folder: x.effectiveFolder })),
    [
      { id: 'root', depth: 0, folder: 'C:/proj' },
      { id: 'orch-a', depth: 1, folder: 'C:/proj' },
      { id: 'orch-sub', depth: 2, folder: 'C:/proj' },
    ],
  );

  // Terminal links: matches #task_a_followup, dispatch:ctx_2, @local-orch-a; ignores dev@example.com and @unknown_tag!
  const line =
    'See #task_a_followup and dispatch:ctx_2 or ping @local-orch-a (contact dev@example.com, @param foo).';
  const extracted = linksMod.extractOrchestrationTerminalLinks(line);
  const resolved = extracted
    .map((tok) => linksMod.resolveOrchestrationLinkTarget(tok, snapshot))
    .filter(Boolean);
  assert.equal(resolved.length, 3);
  assert.equal(resolved[0].taskId, 'task_a_followup');
  assert.equal(resolved[0].ptyId, 'local-orch-a');
  assert.equal(resolved[1].dispatchId, 'ctx_2');
  assert.equal(resolved[2].ptyId, 'local-orch-a');

  // Lineage-chasing after respawn onto a new pane (`ctx_1` -> `ctx_2` -> `ctx_3` on `local-orch-a-v2`):
  const respawnedSnapshot = {
    ...snapshot,
    dispatches: [
      ...snapshot.dispatches.map((d) =>
        d.id === 'ctx_2' ? { ...d, status: 'completed', ownsPane: false, ownsWorktree: false } : d,
      ),
      {
        ...snapshot.dispatches[1],
        id: 'ctx_3',
        followUpOfDispatchId: 'ctx_2',
        assigneeHandle: 'local-orch-a-v2',
        assigneePaneId: 'local-orch-a-v2',
        processGeneration: 3,
        status: 'dispatched',
      },
    ],
  };

  const oldLinkTokens = linksMod.extractOrchestrationTerminalLinks(
    'Jump to #task_a or dispatch:ctx_1 or @local-orch-a',
  );
  const chasedLinks = oldLinkTokens
    .map((tok) => linksMod.resolveOrchestrationLinkTarget(tok, respawnedSnapshot))
    .filter(Boolean);
  assert.equal(chasedLinks.length, 3);
  for (const link of chasedLinks) {
    assert.equal(link.dispatchId, 'ctx_3');
    assert.equal(link.ptyId, 'local-orch-a-v2');
  }

  // Child helper `local-orch-sub` (`creatorDispatchId: 'ctx_2'`) chases lineage to respawned parent `local-orch-a-v2`!
  const subCrew = crewMod.buildCrewViewForPane(respawnedSnapshot, 'local-orch-sub');
  assert.equal(subCrew.managedBy.dispatch.id, 'ctx_3');
  assert.equal(subCrew.managedBy.ptyId, 'local-orch-a-v2');

  // Respawned parent `local-orch-a-v2` still sees `ctx_sub` under `managing`!
  const respawnedParentCrew = crewMod.buildCrewViewForPane(respawnedSnapshot, 'local-orch-a-v2');
  assert.equal(respawnedParentCrew.managing.length, 1);
  assert.equal(respawnedParentCrew.managing[0].dispatch.id, 'ctx_sub');

  const otherRun = {
    ...snapshot.runs[0],
    id: 'run_other',
    coordinatorPaneId: 'local-other-coordinator',
  };
  const multiRun = {
    ...snapshot,
    runs: [otherRun, ...snapshot.runs],
    currentRunByConsumer: { ...snapshot.currentRunByConsumer, 'local-root': 'run_1' },
    tasks: [...snapshot.tasks, { ...snapshot.tasks[0], id: 'build-api' }],
  };
  const [coordLink, customTaskLink] = linksMod.extractOrchestrationTerminalLinks('@coordinator #build-api');
  assert.equal(linksMod.resolveOrchestrationLinkTarget(coordLink, multiRun, 'local-root').ptyId, 'local-root');
  assert.equal(linksMod.resolveOrchestrationLinkTarget(customTaskLink, multiRun).taskId, 'build-api');
});

test('Regression: Windows PATH/Path case-insensitive env merge, Claude PermissionRequest + Gemini BeforeTool hook installation, and Gemini JSON stdout', async (t) => {
  const tmpHome = mkdtempSync(join(tmpdir(), 'aha-reg-hooks-'));
  t.after(() => rmSync(tmpHome, { recursive: true, force: true }));

  // 1. mergeTerminalProcessEnv must collapse Path/PATH into a single canonical key and preserve both entries!
  const shim = createOrchestrationBinShim({ binDir: join(tmpHome, 'orch-bin') });
  const merged = mergeTerminalProcessEnv(
    { Path: `C:\\AugmentedTooling${delimiter}C:\\Windows\\System32`, FOO: '1' },
    { PATH: `${shim.binDir}${delimiter}C:\\OldPath`, BAR: '2' },
  );
  const pathKeys = Object.keys(merged).filter((k) => k.toUpperCase() === 'PATH');
  assert.equal(pathKeys.length, 1, `expected single PATH key, got ${JSON.stringify(pathKeys)}`);
  const mergedPathVal = merged[pathKeys[0]];
  assert.ok(mergedPathVal.startsWith(`${shim.binDir}${delimiter}`));
  assert.ok(mergedPathVal.includes('C:\\AugmentedTooling'));

  // 2. AgentHookInstaller installs Claude PermissionRequest (timeout: 130) & Gemini hooks (BeforeTool timeout: 130000ms).
  const geminiHome = join(tmpHome, '.gemini-custom');
  const installer = new AgentHookInstaller({
    homeDir: tmpHome,
    env: { GEMINI_CLI_HOME: geminiHome },
    nodeCommand: process.execPath,
    relaySourcePath: RELAY_PATH,
  });

  const claudeStatus = installer.install('claude');
  assert.equal(claudeStatus.state, 'installed');
  const claudeCfg = JSON.parse(readFileSync(join(tmpHome, '.claude', 'settings.json'), 'utf8'));
  assert.equal(claudeCfg.hooks.PreToolUse[0].hooks[0].timeout, 5);
  assert.equal(claudeCfg.hooks.PermissionRequest[0].matcher, '*');
  assert.equal(claudeCfg.hooks.PermissionRequest[0].hooks[0].timeout, 130);

  const geminiStatus = installer.install('gemini');
  assert.equal(geminiStatus.state, 'installed');
  const geminiCfg = JSON.parse(readFileSync(join(geminiHome, 'settings.json'), 'utf8'));
  assert.equal(geminiCfg.hooks.BeforeTool[0].hooks[0].timeout, 130_000);
  assert.equal(geminiCfg.hooks.AfterTool[0].hooks[0].timeout, 5_000);
  assert.equal(installer.uninstall('gemini').state, 'not-installed');

  // 3. Gemini non-held hook relay always emits valid JSON (`{}`) on stdout!
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('local-gem', { agentId: 'gemini' });
  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setOrchestrationBinShim(shim);
  await hookServer.start();
  t.after(() => hookServer.stop());

  const gemRelay = await runNodeScript(RELAY_PATH, ['gemini', 'AfterTool'], {
    env: hookServer.envForPane('local-gem'),
    stdin: JSON.stringify({ tool_name: 'run_shell_command' }),
  });
  assert.equal(gemRelay.code, 0);
  assert.deepEqual(JSON.parse(gemRelay.stdout.trim()), {});

  const childEnv = mergeTerminalProcessEnv(
    { ...process.env, PATH: `${resolve(process.execPath, '..')}${delimiter}${process.env.Path ?? process.env.PATH ?? ''}` },
    hookServer.envForPane('local-gem'),
  );
  const shellCmd = process.platform === 'win32' ? 'cmd.exe' : 'sh';
  const shellArgs = process.platform === 'win32' ? ['/d', '/s', '/c', 'aha --help'] : ['-c', 'aha --help'];
  const { stdout: ahaHelpOut } = await execFileAsync(shellCmd, shellArgs, { env: childEnv });
  assert.match(ahaHelpOut, /worker-start/);
});

test('Regression: turn-stop exit after waiting_input settles dispatch before waking check --wait, approval redaction/deny-working/--prompt, locked worktrees, send --to <ptyId>, and recursive workerStop', async (t) => {
  const repoDir = await createTempGitRepo('aha-reg-e2e-');
  const worktreesSiblingDir = `${repoDir}.aha-worktrees`;
  t.after(() => {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(worktreesSiblingDir, { recursive: true, force: true });
  });

  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  const closedPtys = [];
  let seq = 0;

  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: repoDir, cliId: 'claude' });

  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    getDefaultCwd: () => repoDir,
    settleDelayMs: 0,
    turnStopSettleMs: 25,
    writePty: async () => ({ ok: true }),
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    spawnWorkerPty: async (req) => {
      seq += 1;
      const ptyId = `local-reg-w${seq}`;
      agentStatusStore.registerPane(ptyId, { agentId: req.cliId });
      tracker.registerPty({ ptyId, cwd: req.cwd ?? repoDir, cliId: req.cliId });
      return { ptyId };
    },
    closeWorkerPty: async (ptyId) => {
      closedPtys.push(ptyId);
      tracker.markExited(ptyId, 0);
    },
  });

  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setOrchestrationHandler((action, payload, context) =>
    dispatchOrchestrationHttpAction(service, action, payload, context),
  );
  hookServer.setPermissionHookInterceptor((req) => service.handlePermissionHookRequest(req));
  hookServer.setCompanionHandler((namespace, action, payload, context) =>
    dispatchCompanionHttpAction(
      {
        terminalTracker: tracker,
        agentStatusStore,
        writePty: async () => ({ ok: true }),
        getDefaultCwd: () => repoDir,
        orchestrationService: () => service,
      },
      namespace,
      action,
      payload,
      context,
    ),
  );
  await hookServer.start();
  t.after(async () => {
    service.dispose();
    await hookServer.stop();
  });

  const coordEnv = hookServer.envForPane('local-coord');

  // 1. Start worker 1; test waiting_input -> working -> exited escalation & immediate settlement!
  const w1 = await service.workerStart({
    from: 'local-coord',
    paneId: 'local-coord',
    title: 'Crash recovery task',
    spec: 'Test turn-stop exit after waiting',
    cliId: 'claude',
  });
  agentStatusStore.ingestHookEvent({ ptyId: w1.ptyId, state: 'working' });

  const waitNeedsInput = service.check({ from: 'local-coord', wait: true, timeoutMs: 3_000 });
  agentStatusStore.ingestHookEvent({ ptyId: w1.ptyId, state: 'waiting', waitKind: 'question' });
  const needsInputBatch = await waitNeedsInput;
  assert.equal(JSON.parse(needsInputBatch.messages[0].payload).stopReason, 'needs-input');

  // User answers in TUI -> worker resumes working -> process crashes/exits!
  agentStatusStore.ingestHookEvent({ ptyId: w1.ptyId, state: 'working' });
  const waitExited = service.check({ from: 'local-coord', wait: true, timeoutMs: 3_000 });
  tracker.markExited(w1.ptyId, 1);
  service.markPtyExited(w1.ptyId);

  const exitedBatch = await waitExited;
  assert.equal(exitedBatch.messages.length, 1);
  assert.equal(JSON.parse(exitedBatch.messages[0].payload).stopReason, 'exited');
  // At the exact moment check --wait resolves, dispatch must ALREADY be settled!
  assert.equal(store.getDispatchContext(w1.dispatch.id).status, 'failed');

  // 2. `send --to <worker_ptyId>` on settled `worker-start` worker reactivates & respawns in same worktree!
  const reactivated = await service.send({
    from: 'local-coord',
    to: w1.ptyId,
    subject: 'Resume after crash',
    body: 'Continue in preserved worktree.',
  });
  assert.equal(reactivated.followUp?.reactivated, true);
  const d2 = reactivated.followUp.dispatch;
  const worker2Env = hookServer.envForPane(d2.assigneePaneId);
  const secretCap = store.getDispatchCapability(d2.id);

  // 3. Queue two held permissions on d2 with secret capability & long toolInput (>400 chars); test redaction, `--prompt`, and `deny()` keeping state `working`!
  const longCmd = `echo ${'x'.repeat(420)} --capability ${secretCap}`;
  const waitPerm1 = service.check({ from: 'local-coord', wait: true, timeoutMs: 3_000 });
  const perm1Relay = runNodeScript(RELAY_PATH, ['claude', 'PermissionRequest'], {
    env: worker2Env,
    stdin: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: longCmd },
    }),
  });
  const perm1Mail = await waitPerm1;
  const perm1Id = JSON.parse(perm1Mail.messages[0].payload).approvalId;

  // Non-gated BeforeTool returns `{}` immediately without holding!
  const nonHeldBeforeTool = await runNodeScript(RELAY_PATH, ['gemini', 'BeforeTool'], {
    env: worker2Env,
    stdin: JSON.stringify({
      tool_name: 'read_file',
      tool_input: { path: 'README.md' },
    }),
  });
  assert.deepEqual(JSON.parse(nonHeldBeforeTool.stdout.trim()), {});

  const waitPerm2 = service.check({ from: 'local-coord', wait: true, timeoutMs: 3_000 });
  const perm2Relay = runNodeScript(RELAY_PATH, ['gemini', 'BeforeTool'], {
    env: worker2Env,
    stdin: JSON.stringify({
      tool_name: 'write_file',
      requiresApproval: true,
      tool_input: { path: 'safe.txt' },
    }),
  });
  const perm2Mail = await waitPerm2;
  const perm2Id = JSON.parse(perm2Mail.messages[0].payload).approvalId;

  const openApps = service.getSnapshot().openApprovals;
  assert.equal(openApps.length, 2);
  const app1 = openApps.find((a) => a.approvalId === perm1Id);
  assert.ok(!app1.toolInput.includes(secretCap), 'capability must be redacted from openApprovals');
  assert.ok(app1.toolInput.includes('<redacted>'));
  assert.ok(app1.toolInput.length > 400, 'toolInput must not be truncated at 160 chars');
  assert.ok(!perm1Mail.messages[0].body.includes(secretCap), 'capability must be redacted from mail');

  // Select perm2 specifically via `--dispatch <d2.id> --prompt <perm2Id>`!
  const approvePerm2Cli = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'approve', '--dispatch', d2.id, '--prompt', perm2Id, '--json'],
    { env: coordEnv },
  );
  assert.equal(approvePerm2Cli.code, 0, approvePerm2Cli.stderr);
  const perm2Out = JSON.parse((await perm2Relay).stdout.trim());
  assert.equal(perm2Out.decision, 'allow');

  // Deny perm1 and verify pane state returns to `working` (NOT `idle`!).
  const denyPerm1Cli = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'deny', '--prompt', perm1Id, '--reason', 'Unsafe secret echo', '--json'],
    { env: coordEnv },
  );
  assert.equal(denyPerm1Cli.code, 0, denyPerm1Cli.stderr);
  await perm1Relay;
  assert.equal(agentStatusStore.get(d2.assigneePaneId).state, 'working');

  // 4. Spawn depth-2 child helper from d2, then call workerStop on d2 -> child helper must also be stopped!
  const helper = await service.workerStart({
    from: d2.assigneePaneId,
    paneId: d2.assigneePaneId,
    title: 'Depth-2 helper',
    spec: 'Assist parent worker',
    cliId: 'gemini',
    noWorktree: true,
  });
  assert.equal(helper.dispatch.depth, 2);

  const stopParent = await service.workerStop({ dispatchId: d2.id });
  assert.ok(stopParent.stoppedHelperIds.includes(helper.dispatch.id));
  assert.equal(store.getDispatchContext(helper.dispatch.id).status, 'failed');
  assert.ok(closedPtys.includes(helper.ptyId));

  // 5. Locked Git worktree (`git worktree lock`) must block non-force workerRelease and succeed with `--force`!
  await execFileAsync('git', ['worktree', 'lock', d2.worktreePath], { cwd: repoDir });
  await assert.rejects(
    () => service.workerRelease({ dispatchId: d2.id }),
    (err) => err instanceof OrchestrationError && err.code === 'operation_rejected',
  );
  const forcedRelease = await service.workerRelease({ dispatchId: d2.id, force: true });
  assert.equal(forcedRelease.removedWorktree, true);
  assert.equal(existsSync(d2.worktreePath), false);

  // 6. Companion CLI parity: `aha worktree rm` alias and `aha skills get orchestration --full`!
  const wt2 = await runNodeScript(
    CLI_PATH,
    ['worktree', 'create', '--cwd', repoDir, '--branch', 'feat/rm-alias', '--json'],
    { env: coordEnv },
  );
  const wt2Path = JSON.parse(wt2.stdout).path;
  const wtRm = await runNodeScript(
    CLI_PATH,
    ['worktree', 'rm', wt2Path, '--cwd', repoDir, '--json'],
    { env: coordEnv },
  );
  assert.equal(wtRm.code, 0, wtRm.stderr);
  assert.equal(existsSync(wt2Path), false);

  const fullSkill = await runNodeScript(
    CLI_PATH,
    ['skills', 'get', 'orchestration', '--full', '--json'],
    { env: coordEnv },
  );
  assert.equal(fullSkill.code, 0, fullSkill.stderr);
  const fullContent = JSON.parse(fullSkill.stdout).content;
  assert.match(fullContent, /<!-- reference: workers\.md -->/);
  assert.match(fullContent, /<!-- reference: approvals\.md -->/);
});

test('Parity & Hardening: Aha structured worker_done CLI, nested child ask/done across parent follow-up, @idle/@cli/@mention routing, multi-approval state, gate authority, worker-abandon/reset, and standalone worktree sidebar folder', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'aha-parity-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  let seq = 0;

  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: tmpDir, cliId: 'claude' });

  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    getDefaultCwd: () => tmpDir,
    settleDelayMs: 0,
    turnStopSettleMs: 30,
    writePty: async () => ({ ok: true }),
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    spawnWorkerPty: async (req) => {
      seq += 1;
      const ptyId = `local-par-w${seq}`;
      agentStatusStore.registerPane(ptyId, { agentId: req.cliId });
      tracker.registerPty({ ptyId, cwd: req.cwd ?? tmpDir, cliId: req.cliId });
      return { ptyId, agentId: req.cliId, cwd: req.cwd ?? tmpDir };
    },
    closeWorkerPty: async (ptyId) => {
      tracker.markExited(ptyId, 0);
      agentStatusStore.removePane(ptyId);
    },
  });

  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setOrchestrationHandler((action, payload, context) =>
    dispatchOrchestrationHttpAction(service, action, payload, context),
  );
  hookServer.setPermissionHookInterceptor((req) => service.handlePermissionHookRequest(req));
  await hookServer.start();
  t.after(async () => {
    service.dispose();
    await hookServer.stop();
  });

  const coordEnv = hookServer.envForPane('local-coord');

  // 1. task-create with Aha's `--task-title` & `--display-name` + gate-create with JSON `--options '["yes","no"]'`.
  await runNodeScript(CLI_PATH, ['orchestration', 'run-create', '--objective', 'Aha CLI Parity', '--json'], {
    env: coordEnv,
  });
  const createdTaskCli = await runNodeScript(
    CLI_PATH,
    [
      'orchestration',
      'task-create',
      '--spec',
      'Audit billing layout',
      '--task-title',
      'Billing audit',
      '--display-name',
      'Billing UI Audit',
      '--json',
    ],
    { env: coordEnv },
  );
  assert.equal(createdTaskCli.code, 0, createdTaskCli.stderr);
  const billingTask = JSON.parse(createdTaskCli.stdout).task;
  assert.equal(billingTask.taskTitle, 'Billing audit');
  assert.equal(billingTask.displayName, 'Billing UI Audit');

  // 2. Start codex worker & gemini worker (--no-worktree in non-git dir).
  const codexStart = await service.workerStart({
    from: 'local-coord',
    taskId: billingTask.id,
    agent: 'codex',
    noWorktree: true,
  });
  const gemStart = await service.workerStart({
    from: 'local-coord',
    spec: 'Secondary helper',
    agent: 'gemini',
    noWorktree: true,
  });
  const codexEnv = hookServer.envForPane(codexStart.ptyId);
  const gemEnv = hookServer.envForPane(gemStart.ptyId);

  // Mark codex working, gemini idle -> test `@idle` and `@codex` group addresses!
  agentStatusStore.ingestHookEvent({ ptyId: codexStart.ptyId, state: 'working' });
  agentStatusStore.ingestHookEvent({ ptyId: gemStart.ptyId, state: 'idle' });

  const idleSend = await service.send({
    from: 'local-coord',
    to: '@idle',
    subject: 'Idle ping',
    body: 'Only idle workers get this',
  });
  assert.deepEqual(idleSend.recipients, [`dispatch:${gemStart.dispatch.id}`]);

  const codexGroupSend = await service.send({
    from: 'local-coord',
    to: '@codex',
    subject: 'Codex ping',
    body: 'Only codex workers get this',
  });
  assert.deepEqual(codexGroupSend.recipients, [`dispatch:${codexStart.dispatch.id}`]);
  await service.check({ from: codexStart.ptyId });

  // 3. Worker cannot resolve a decision gate via CLI (`gate-resolve` forwards `from` from AHA_TERMINAL_ID)!
  const gateCli = await runNodeScript(
    CLI_PATH,
    [
      'orchestration',
      'gate-create',
      '--task',
      gemStart.task.id,
      '--question',
      'Ship it?',
      '--options',
      '["yes","no"]',
      '--json',
    ],
    { env: coordEnv },
  );
  assert.equal(gateCli.code, 0, gateCli.stderr);
  const createdGate = JSON.parse(gateCli.stdout).gate;
  assert.deepEqual(createdGate.options, ['yes', 'no']);

  const workerResolveAttempt = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'gate-resolve', '--id', createdGate.id, '--resolution', 'yes', '--json'],
    { env: codexEnv },
  );
  assert.equal(workerResolveAttempt.code, 1, 'active worker must be blocked from gate-resolve');
  assert.match(workerResolveAttempt.stderr, /operation_rejected/);

  const coordResolveGate = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'gate-resolve', '--id', createdGate.id, '--resolution', 'yes', '--json'],
    { env: coordEnv },
  );
  assert.equal(coordResolveGate.code, 0, coordResolveGate.stderr);

  // 4. Depth-1 codex worker spawns depth-2 child helper, then codex settles via Aha's documented
  //    `send --type worker_done --outcome succeeded` (without `--to`), and Coordinator reactivates codex via `@dispatch:<id>`!
  const childWorker = await service.workerStart({
    from: codexStart.ptyId,
    spec: 'Nested depth-2 helper task',
    agent: 'claude',
    noWorktree: true,
  });
  assert.equal(childWorker.dispatch.creatorDispatchId, codexStart.dispatch.id);

  // Reject invalid/mismatched `send --type worker_done` with non-zero CLI exit code!
  const codexCap = store.getDispatchCapability(codexStart.dispatch.id);
  const badWorkerDoneCli = await runNodeScript(
    CLI_PATH,
    [
      'orchestration',
      'send',
      '--type',
      'worker_done',
      '--subject',
      'Wrong task id',
      '--task-id',
      'task_nonexistent',
      '--dispatch-id',
      codexStart.dispatch.id,
      '--outcome',
      'succeeded',
      '--dispatch-capability',
      codexCap,
      '--json',
    ],
    { env: codexEnv },
  );
  assert.equal(badWorkerDoneCli.code, 1, 'rejected worker_done must exit non-zero');
  assert.match(badWorkerDoneCli.stderr, /lifecycle_rejected/);

  // Valid Aha `send --type worker_done --outcome succeeded --files-modified ...` without `--to`!
  const okWorkerDoneCli = await runNodeScript(
    CLI_PATH,
    [
      'orchestration',
      'send',
      '--type',
      'worker_done',
      '--subject',
      'Completed billing audit',
      '--body',
      'Fixed layout.',
      '--task-id',
      billingTask.id,
      '--dispatch-id',
      codexStart.dispatch.id,
      '--outcome',
      'succeeded',
      '--files-modified',
      'src/Billing.tsx,src/Billing.css',
      '--dispatch-capability',
      codexCap,
      '--json',
    ],
    { env: codexEnv },
  );
  assert.equal(okWorkerDoneCli.code, 0, okWorkerDoneCli.stderr);
  assert.equal(store.getDispatchContext(codexStart.dispatch.id).status, 'completed');
  assert.equal(store.getTask(billingTask.id).status, 'completed');
  await service.check({ from: 'local-coord' });

  // Reactivate settled codex worker using Crew mention token `@dispatch:<id>`!
  const reactivatedViaMention = await service.send({
    from: 'local-coord',
    to: `@dispatch:${codexStart.dispatch.id}`,
    subject: 'Await child helper result',
    body: 'Wait for your child helper and integrate.',
  });
  assert.equal(reactivatedViaMention.followUp?.reactivated, true);
  const codexV2 = reactivatedViaMention.followUp.dispatch;

  // Turn-stop on reactivated parent `codexV2` must be suppressed because `childWorker` (`creatorDispatchId: codexStart.dispatch.id`) is still active!
  agentStatusStore.ingestHookEvent({ ptyId: codexV2.assigneePaneId, state: 'working' });
  agentStatusStore.ingestHookEvent({ ptyId: codexV2.assigneePaneId, state: 'done' });
  await new Promise((r) => setTimeout(r, 70));
  const prematureCheck = await service.check({ from: 'local-coord' });
  assert.equal(prematureCheck.count, 0, 'parent with active child across follow-up lineage must not emit turn-stop escalation');

  // Depth-2 `childWorker` calls `ask` (without `--to`) -> must wake reactivated parent `codexV2` (`dispatch:<codexV2.id>`)!
  const childCap = store.getDispatchCapability(childWorker.dispatch.id);
  const parentWaitForAsk = service.check({
    from: codexV2.assigneePaneId,
    wait: true,
    timeoutMs: 3_000,
  });
  const childAskPromise = service.ask({
    from: childWorker.ptyId,
    question: 'Return array or map?',
    wait: true,
    timeoutMs: 3_000,
    capability: childCap,
  });
  const parentInbox = await parentWaitForAsk;
  assert.equal(parentInbox.messages.length, 1);
  assert.equal(parentInbox.messages[0].type, 'question');
  service.reply({
    id: parentInbox.messages[0].id,
    body: 'Return map',
    from: codexV2.assigneePaneId,
  });
  const childAskRes = await childAskPromise;
  assert.equal(childAskRes.answer, 'Return map');

  // Depth-2 `childWorker` calls `workerDone` -> `lifecycle.action` must be `'settled'` (not `'duplicate'`) and delivered to `codexV2`!
  const parentWaitForDone = service.check({
    from: codexV2.assigneePaneId,
    wait: true,
    timeoutMs: 3_000,
  });
  const childDone = service.workerDone({
    from: childWorker.ptyId,
    dispatchId: childWorker.dispatch.id,
    outcome: 'succeeded',
    summary: 'Helper finished',
    capability: childCap,
  });
  assert.equal(childDone.lifecycle.action, 'settled');
  const parentDoneInbox = await parentWaitForDone;
  assert.equal(parentDoneInbox.messages.length, 1);
  assert.equal(parentDoneInbox.messages[0].type, 'worker_done');

  // 5. Concurrent held approvals on `codexV2`: resolving one keeps stage `waiting_permission` & pane `waiting` until the second resolves; cross-dispatch `--dispatch` rejects!
  const p1Relay = runNodeScript(RELAY_PATH, ['claude', 'PermissionRequest'], {
    env: codexEnv,
    stdin: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: 'cmd-1' },
    }),
  });
  const p2Relay = runNodeScript(RELAY_PATH, ['claude', 'PermissionRequest'], {
    env: codexEnv,
    stdin: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Write',
      tool_input: { file_path: 'out.txt' },
    }),
  });
  for (let i = 0; i < 200 && service.approvals.listOpenApprovals({ dispatchId: codexV2.id }).length < 2; i++) {
    await new Promise((r) => setTimeout(r, 15));
  }
  const openRequests = service.approvals.listOpenApprovals({ dispatchId: codexV2.id });
  const openA = openRequests.find(request => request.toolName === 'Bash');
  const openB = openRequests.find(request => request.toolName === 'Write');
  assert.ok(openA && openB, 'both hook subprocesses must have registered approvals');

  // Cross-dispatch mismatch rejected!
  const wrongDispatchApprove = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'approve', '--dispatch', childWorker.dispatch.id, '--prompt', openA.approvalId, '--json'],
    { env: coordEnv },
  );
  assert.equal(wrongDispatchApprove.code, 1);
  assert.match(wrongDispatchApprove.stderr, /invalid_argument/);

  // Approve openA while openB is still pending -> pane stays `waiting` and stage stays `waiting_permission`!
  service.approve({ id: openA.approvalId, dispatchId: codexV2.id, from: 'local-coord' });
  assert.equal((await p1Relay).code, 0);
  assert.equal(agentStatusStore.get(codexV2.assigneePaneId).state, 'waiting');
  assert.equal(store.getDispatchContext(codexV2.id).stage, 'waiting_permission');

  // Approve openB -> now transitions to `working`!
  service.approve({ id: openB.approvalId, dispatchId: codexV2.id, from: 'local-coord' });
  assert.equal((await p2Relay).code, 0);
  assert.equal(agentStatusStore.get(codexV2.assigneePaneId).state, 'working');
  assert.equal(store.getDispatchContext(codexV2.id).stage, 'working');

  // 6. Test `worker-abandon` and `reset` via CLI!
  const abandonCli = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'worker-abandon', '--dispatch', codexV2.id, '--reason', 'Superseded', '--json'],
    { env: coordEnv },
  );
  assert.equal(abandonCli.code, 0, abandonCli.stderr);
  assert.equal(store.getDispatchContext(codexV2.id).status, 'failed');

  const resetAllCli = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'reset', '--all', '--json'],
    { env: coordEnv },
  );
  assert.equal(resetAllCli.code, 0, resetAllCli.stderr);
  assert.equal(store.listRuns().length, 0);
  assert.equal(store.listTasks().length, 0);

  // 7. Standalone auto-worktree window (`C:/proj.aha-worktrees/feat-x`, depth 0) maps effectiveFolder to `C:/proj`!
  const compileCrew = () => {
    const outDir = join(tmpDir, 'ui-compile');
    mkdirSync(outDir, { recursive: true });
    const writeTranspiled = (rel, out, rewrites = []) => {
      let code = ts.transpileModule(ts.sys.readFile(resolve(rel), 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      }).outputText;
      for (const [f, r] of rewrites) code = code.replaceAll(f, r);
      const p = join(outDir, out);
      writeFileSync(p, code, 'utf8');
      return pathToFileURL(p).href;
    };
    writeTranspiled('src/lib/git-panel-model.ts', 'git-panel-model.mjs');
    writeTranspiled('src/lib/orchestration-view.ts', 'orchestration-view.mjs');
    return import(
      writeTranspiled('src/lib/orchestration-crew-model.ts', 'orchestration-crew-model.mjs', [
        ["'./git-panel-model'", "'./git-panel-model.mjs'"],
        ["'./orchestration-view'", "'./orchestration-view.mjs'"],
      ])
    );
  };
  const crewMod = await compileCrew();
  assert.equal(
    crewMod.inferMainRepoFromAutoWorktree('C:/Users/dev/my-app.aha-worktrees/feat-login'),
    'C:/Users/dev/my-app',
  );
  const standaloneLineage = crewMod.buildSidebarWindowLineage(
    [
      { id: 'main-win', cwd: 'C:/Users/dev/my-app' },
      { id: 'wt-win', cwd: 'C:/Users/dev/my-app.aha-worktrees/feat-login' },
    ],
    service.getSnapshot(),
    (id) => [id],
    'C:/Users/dev/my-app',
  );
  assert.deepEqual(
    standaloneLineage.map((x) => ({ id: x.win.id, depth: x.depth, folder: x.effectiveFolder })),
    [
      { id: 'main-win', depth: 0, folder: 'C:/Users/dev/my-app' },
      { id: 'wt-win', depth: 0, folder: 'C:/Users/dev/my-app' },
    ],
  );
});

test('Phase 6–9 Hardening: stale sweeps spare deliberate waits, never-injected claims survive turn-stop exit, and reconciled exits still wake check --wait', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'aha-hardening-sweeps-'));
  t.after(() => rmSync(tmpDir, { recursive: true, force: true }));

  let nowMs = Date.UTC(2026, 10, 18, 12, 0, 0);
  const agentStatusStore = new AgentStatusStore({ now: () => nowMs });
  const tracker = new TerminalRuntimeTracker();
  for (const id of ['local-coord', 'local-review', 'local-ask', 'local-parent', 'local-child', 'local-stalled', 'local-dead']) {
    agentStatusStore.registerPane(id, { agentId: 'claude' });
    tracker.registerPty({ ptyId: id, cwd: tmpDir, cliId: 'claude' });
  }

  const store = new OrchestrationStore({
    resolveFile: () => join(tmpDir, 'orch.json'),
    now: () => new Date(nowMs).toISOString(),
  });
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async () => ({ ok: true }),
    settleDelayMs: 0,
    turnStopSettleMs: 35,
    startConfirmationTimeoutMs: 10_000,
    heartbeatTimeoutMs: 20_000,
    now: () => nowMs,
  });
  t.after(() => service.dispose());

  const { run } = service.runCreate({
    id: 'run_hard_sweep',
    objective: 'Verify wait-state exemptions and turn-stop exit races',
    from: 'local-coord',
    paneId: 'local-coord',
  });

  // 1. Worker in `awaiting_review`, worker waiting on `ask`, and parent worker with active child all survive past heartbeatTimeoutMs.
  service.taskCreate({ id: 't_review', runId: run.id, spec: 'Review wait' });
  service.taskCreate({ id: 't_ask', runId: run.id, spec: 'Question wait' });
  service.taskCreate({ id: 't_parent', runId: run.id, spec: 'Parent wait' });
  service.taskCreate({ id: 't_stalled', runId: run.id, spec: 'Unresponsive worker' });

  const dReview = (await service.dispatchTask({ taskId: 't_review', to: 'local-review', from: 'local-coord' })).dispatch;
  const dAsk = (await service.dispatchTask({ taskId: 't_ask', to: 'local-ask', from: 'local-coord' })).dispatch;
  const dParent = (await service.dispatchTask({ taskId: 't_parent', to: 'local-parent', from: 'local-coord' })).dispatch;
  const dStalled = (await service.dispatchTask({ taskId: 't_stalled', to: 'local-stalled', from: 'local-coord' })).dispatch;

  for (const id of ['local-review', 'local-ask', 'local-parent', 'local-stalled']) {
    agentStatusStore.ingestHookEvent({ ptyId: id, state: 'working' });
  }

  // Put dReview into `awaiting_review` via synthetic turn stop.
  agentStatusStore.ingestHookEvent({ ptyId: 'local-review', state: 'done' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(store.getDispatchContext(dReview.id).stage, 'awaiting_review');

  // Put dAsk into pending `ask --wait`.
  const askCap = store.getDispatchCapability(dAsk.id);
  const askWait = service.ask({
    from: 'local-ask',
    question: 'Approve schema?',
    wait: true,
    timeoutMs: 5_000,
    capability: askCap,
  });
  await new Promise((r) => setTimeout(r, 15));

  // Give dParent an active depth-2 child dispatch in `awaiting_review`.
  const childStarted = await service.workerStart({
    from: 'local-parent',
    runId: run.id,
    spec: 'Child helper work',
    terminal: 'local-child',
    noWorktree: true,
  });
  agentStatusStore.ingestHookEvent({ ptyId: 'local-child', state: 'working' });
  agentStatusStore.ingestHookEvent({ ptyId: 'local-child', state: 'done' });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(store.hasActiveChildDispatches(dParent.id), true);

  // Advance 60s (3x heartbeatTimeoutMs) and run stale sweep + coordinatorTick!
  nowMs += 60_000;
  service.reconcileStaleDispatches();
  await service.coordinatorTick(run.id, { workerPaneIds: [] });

  assert.equal(store.getDispatchContext(dReview.id).status, 'dispatched');
  assert.equal(store.getDispatchContext(dAsk.id).status, 'dispatched');
  assert.equal(store.getDispatchContext(dParent.id).status, 'dispatched');

  // Settling the child after 60s refreshes dParent's heartbeat so dParent isn't immediately swept as stale!
  service.workerDone({
    from: 'local-child',
    taskId: childStarted.task.id,
    dispatchId: childStarted.dispatch.id,
    outcome: 'completed',
    summary: 'Child finished',
    capability: store.getDispatchCapability(childStarted.dispatch.id),
  });
  nowMs += 1_000;
  service.reconcileStaleDispatches();
  assert.equal(store.getDispatchContext(dParent.id).status, 'dispatched');

  // Meanwhile genuinely stalled `dStalled` IS parked with `stage: 'failed'`, and late worker_done recovers with `stage: 'done'`.
  assert.equal(store.getDispatchContext(dStalled.id).status, 'failed');
  assert.equal(store.getDispatchContext(dStalled.id).stage, 'failed');
  const stalledCap = store.getDispatchCapability(dStalled.id);
  const lateDone = service.workerDone({
    from: 'local-stalled',
    taskId: 't_stalled',
    dispatchId: dStalled.id,
    outcome: 'completed',
    summary: 'Finished after long silent build',
    capability: stalledCap,
  });
  assert.equal(lateDone.dispatch.status, 'completed');
  assert.equal(lateDone.dispatch.stage, 'done');

  // Answering dAsk after 60s refreshes its heartbeat so an immediate sweep right after `reply` does NOT kill dAsk!
  const pendingQ = store.listQuestions({ dispatchId: dAsk.id, status: 'pending' })[0];
  service.reply({ id: pendingQ.messageId, body: 'Approved', from: 'local-coord' });
  const askRes = await askWait;
  assert.equal(askRes.answer, 'Approved');
  nowMs += 1_000;
  service.reconcileStaleDispatches();
  assert.equal(store.getDispatchContext(dAsk.id).status, 'dispatched');

  // 2. Drain coordinator mailbox, then test never-injected claim vs reconciled worker exit waking `check --wait`.
  await service.check({ from: 'local-coord' });

  service.taskCreate({ id: 't_claim_only', runId: run.id, spec: 'Preview claim' });
  service.taskCreate({ id: 't_exit_race', runId: run.id, spec: 'Crash race' });
  const claimOnly = (
    await service.dispatchTask({ taskId: 't_claim_only', to: 'local-claim-ghost', from: 'local-coord', inject: false })
  ).dispatch;
  const exitRace = (
    await service.dispatchTask({ taskId: 't_exit_race', to: 'local-dead', from: 'local-coord' })
  ).dispatch;

  const waitExitEscalation = service.check({ from: 'local-coord', wait: true, timeoutMs: 3_000 });
  await new Promise((r) => setTimeout(r, 15));

  // Both panes exit AND reconcileStaleDispatches runs IMMEDIATELY before the 35ms settle timer fires!
  service.markPtyExited('local-claim-ghost');
  service.markPtyExited('local-dead');
  service.reconcileStaleDispatches();

  const exitWake = await waitExitEscalation;
  assert.equal(exitWake.timedOut, false, 'check --wait must wake on worker exit even if reconcileExitedDispatches ran first');
  assert.ok(
    exitWake.messages.some((m) => m.id === `msg_stop_${exitRace.id}_exited`),
    'expected deterministic exited turn-stop message',
  );

  await new Promise((r) => setTimeout(r, 60));
  assert.equal(store.getDispatchContext(claimOnly.id).status, 'dispatched');
});

test('Phase 7–10 CLI Hardening: dash-prefixed values, --spec-file, --terminal check/inbox, --wait stderr keepalive, callerCwd, and worktree handoff/nesting/remove', async (t) => {
  const repoDir = await createTempGitRepo('aha-cli-hard-repo-');
  const tmpDir = mkdtempSync(join(tmpdir(), 'aha-cli-hard-state-'));
  t.after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(`${repoDir}.aha-worktrees`, { recursive: true, force: true });
  });

  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  const ptyInputs = new Map();
  let nextPtySeq = 1;

  const spawnPty = async ({ cliId, cwd, extraArgs }) => {
    const ptyId = `local-hard-${nextPtySeq++}`;
    agentStatusStore.registerPane(ptyId, { agentId: cliId || 'claude' });
    tracker.registerPty({ ptyId, cwd, cliId: cliId || 'claude' });
    ptyInputs.set(ptyId, { cwd, cliId, extraArgs: extraArgs ?? [], writes: [] });
    return { ptyId, cwd };
  };

  const store = new OrchestrationStore({ resolveFile: () => join(tmpDir, 'orch.json') });
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async (ptyId, data) => {
      const rec = ptyInputs.get(ptyId);
      if (rec) rec.writes.push(data);
      return { ok: true, bytesWritten: Buffer.byteLength(data) };
    },
    spawnWorkerPty: spawnPty,
    closeWorkerPty: async (ptyId) => {
      tracker.markExited(ptyId, 0);
      return { ok: true };
    },
    isPtyAlive: (ptyId) => Boolean(tracker.getTerminal(ptyId)?.alive),
    settleDelayMs: 0,
    turnStopSettleMs: 30,
  });
  t.after(() => service.dispose());

  const server = new AgentHookServer(agentStatusStore);
  server.setEndpointFile(join(tmpDir, 'endpoint.json'));
  server.setOrchestrationHandler((action, payload, ctx) =>
    dispatchOrchestrationHttpAction(service, action, payload, ctx),
  );
  server.setCompanionHandler((ns, action, payload, ctx) =>
    dispatchCompanionHttpAction(
      {
        terminalTracker: tracker,
        agentStatusStore,
        writePty: async (ptyId, data) => {
          const rec = ptyInputs.get(ptyId);
          if (rec) rec.writes.push(data);
          return { ok: true, bytesWritten: Buffer.byteLength(data) };
        },
        createPty: spawnPty,
        closePty: async (ptyId) => {
          tracker.markExited(ptyId, 0);
          return { ok: true };
        },
        orchestrationService: () => service,
      },
      ns,
      action,
      payload,
      ctx,
    ),
  );
  await server.start();
  t.after(async () => {
    await server.stop();
  });

  // Notice `plain-shell` is NOT registered in tracker or agentStatusStore — `callerCwd` from CLI must resolve `repoDir`!
  const shellEnv = server.envForPane('local-plain-shell');

  // PowerShell `@all` splatting protection on `--to` must STILL reject missing recipient!
  const splattedSend = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'send', '--to', '--subject', 'Accidentally splatted'],
    { env: shellEnv, cwd: repoDir },
  );
  assert.equal(splattedSend.code, 1);
  assert.match(splattedSend.stderr, /Missing value for --to/);

  // 1. `--spec` with dash-prefixed value AND `callerCwd` fallback on `worker-start`!
  const dashWorkerRes = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'worker-start', '--spec', '--no-worktree parser support', '--agent', 'claude', '--name', 'dash-spec', '--json'],
    { env: shellEnv, cwd: repoDir },
  );
  assert.equal(dashWorkerRes.code, 0, dashWorkerRes.stderr);
  const dashWorker = JSON.parse(dashWorkerRes.stdout);
  assert.equal(dashWorker.task.spec, '--no-worktree parser support');
  assert.ok(dashWorker.worktreePath.includes('.aha-worktrees'), 'callerCwd must allow auto-worktree creation from plain shell');

  // 2. `--spec-file` from file AND from stdin (`-`), plus `terminal send --text "--help"`!
  const specFile = join(tmpDir, 'spec.md');
  writeFileSync(specFile, '# Spec from file\nImplement --strict mode', 'utf8');
  const fileTaskRes = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'task-create', '--run', dashWorker.run.id, '--spec-file', specFile, '--json'],
    { env: shellEnv, cwd: repoDir },
  );
  assert.equal(fileTaskRes.code, 0, fileTaskRes.stderr);
  assert.equal(JSON.parse(fileTaskRes.stdout).task.spec, '# Spec from file\nImplement --strict mode');

  const stdinTaskRes = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'task-create', '--run', dashWorker.run.id, '--spec-file', '-', '--json'],
    { env: shellEnv, cwd: repoDir, stdin: 'Stdin spec with --flags' },
  );
  assert.equal(stdinTaskRes.code, 0, stdinTaskRes.stderr);
  assert.equal(JSON.parse(stdinTaskRes.stdout).task.spec, 'Stdin spec with --flags');

  const termSendDash = await runNodeScript(
    CLI_PATH,
    ['terminal', 'send', '--id', dashWorker.ptyId, '--text', '--help', '--json'],
    { env: shellEnv, cwd: repoDir },
  );
  assert.equal(termSendDash.code, 0, termSendDash.stderr);
  assert.ok(ptyInputs.get(dashWorker.ptyId).writes.join('').includes('--help'));

  // 3. `--terminal` on `inbox` / `check` targeting `run:<id>` and `dispatch:<id>`, plus `--wait` stderr keepalive!
  await runNodeScript(
    CLI_PATH,
    ['orchestration', 'send', '--to', `dispatch:${dashWorker.dispatch.id}`, '--subject', '--status update', '--body', '--verbose details'],
    { env: shellEnv, cwd: repoDir },
  );
  const dispatchInbox = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'inbox', '--terminal', `dispatch:${dashWorker.dispatch.id}`],
    { env: shellEnv, cwd: repoDir },
  );
  assert.equal(dispatchInbox.code, 0, dispatchInbox.stderr);
  assert.match(dispatchInbox.stdout, /Mailbox: dispatch:/);
  assert.match(dispatchInbox.stdout, /--status update/);

  const waitWithKeepalive = await runNodeScript(
    CLI_PATH,
    ['orchestration', 'check', '--terminal', `run:${dashWorker.run.id}`, '--wait', '--timeout-ms', '140', '--json'],
    { env: { ...shellEnv, AHA_CLI_KEEPALIVE_MS: '40' }, cwd: repoDir },
  );
  assert.equal(waitWithKeepalive.code, 0, waitWithKeepalive.stderr);
  const checkJson = JSON.parse(waitWithKeepalive.stdout);
  assert.equal(checkJson.mailbox, `run:${dashWorker.run.id}`);
  assert.equal(checkJson.timedOut, true);
  assert.match(waitWithKeepalive.stderr, /"_keepalive":true/);

  // 4. `aha worktree create` from INSIDE an existing worktree (`dashWorker.worktreePath`) with `--agent` + `--prompt`!
  const nestedWtRes = await runNodeScript(
    CLI_PATH,
    [
      'worktree',
      'create',
      '--name',
      'handoff-wt',
      '--agent',
      'codex',
      '--prompt',
      '--fix handoff login',
      '--json',
    ],
    { env: shellEnv, cwd: dashWorker.worktreePath },
  );
  assert.equal(nestedWtRes.code, 0, nestedWtRes.stderr);
  const nestedWt = JSON.parse(nestedWtRes.stdout);
  assert.equal(
    nestedWt.path.includes('.aha-worktrees\\dash-spec') || nestedWt.path.includes('.aha-worktrees/dash-spec'),
    false,
    `worktree created from inside linked worktree must NOT nest .aha-worktrees: ${nestedWt.path}`,
  );
  assert.equal(nestedWt.promptDelivered, true);
  assert.ok(ptyInputs.get(nestedWt.ptyId).writes.join('').includes('--fix handoff login'));

  // 5. `aha worktree remove` from outside the repo (`tmpDir`, no `--cwd` repo hint) resolves main repo via `.aha-worktrees` sibling!
  const rmWtRes = await runNodeScript(
    CLI_PATH,
    ['worktree', 'remove', '--path', nestedWt.path, '--force', '--json'],
    { env: shellEnv, cwd: tmpDir },
  );
  assert.equal(rmWtRes.code, 0, rmWtRes.stderr);
  assert.equal(JSON.parse(rmWtRes.stdout).removed, true);
  assert.equal(existsSync(nestedWt.path), false);
});
