import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { runGitCommand } from '../dist-electron/git/git-exec.js';
import { selectAgentForTask } from '../dist-electron/orchestration/agent-roster.js';
import { evaluateAdversarialVerdict } from '../dist-electron/orchestration/adversarial-review.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';

async function git(cwd, ...args) {
  const res = await runGitCommand(args, { cwd, timeoutMs: 20_000 });
  assert.equal(res.exitCode, 0, `git ${args.join(' ')} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function makeRoster() {
  return [
    {
      cliId: 'claude',
      label: 'Claude Code',
      command: 'claude',
      installed: true,
      enabled: true,
      available: true,
      specialty: 'architecture',
      defaultModel: null,
      defaultEffort: null,
      hooksInstalled: true,
      mcpMode: 'launch-arg',
      mcpReady: true,
      idlePanes: [],
    },
    {
      cliId: 'codex',
      label: 'Codex',
      command: 'codex',
      installed: true,
      enabled: true,
      available: true,
      specialty: 'review & coding',
      defaultModel: null,
      defaultEffort: null,
      hooksInstalled: true,
      mcpMode: 'launch-arg',
      mcpReady: true,
      idlePanes: [],
    },
    {
      cliId: 'grok',
      label: 'Grok',
      command: 'grok',
      installed: true,
      enabled: true,
      available: true,
      specialty: 'adversarial review',
      defaultModel: null,
      defaultEffort: null,
      hooksInstalled: true,
      mcpMode: 'config',
      mcpReady: true,
      idlePanes: [],
    },
  ];
}

test('selectAgentForTask strictly avoids authorCliId before coordinatorCliId for adversarial review', () => {
  const roster = makeRoster();
  // Coordinator is Claude, Author is Codex -> must NOT pick Codex; prefers Grok (avoids both author and coordinator).
  const picked = selectAgentForTask({
    roster,
    requestedAgent: 'auto',
    taskKind: 'review',
    coordinatorCliId: 'claude',
    authorCliId: 'codex',
  });
  assert.equal(picked.cliId, 'grok');

  // With only Claude + Codex available (Coordinator=Claude, Author=Codex), avoids Author (Codex) and picks Claude.
  const twoOnly = roster.filter((a) => a.cliId !== 'grok');
  const pickedTwo = selectAgentForTask({
    roster: twoOnly,
    requestedAgent: 'auto',
    taskKind: 'review',
    coordinatorCliId: 'claude',
    authorCliId: 'codex',
  });
  assert.equal(pickedTwo.cliId, 'claude');
});

test('evaluateAdversarialVerdict enforces blocking P0/P1 findings and ignores advisory-only P2 rejection', () => {
  const forcedReject = evaluateAdversarialVerdict({
    verdict: 'pass',
    findings: [
      {
        severity: 'P1',
        location: 'src/auth.ts:42',
        title: 'Cross-run bypass',
        evidence: 'Missing authorizeRunAccess check',
      },
    ],
  });
  assert.equal(forcedReject.effectiveVerdict, 'reject');
  assert.equal(forcedReject.overriddenByBlockingFindings, true);

  const p2Only = evaluateAdversarialVerdict({
    verdict: 'reject',
    findings: [
      {
        severity: 'P2',
        location: 'src/auth.ts:10',
        title: 'Minor naming nit',
        evidence: 'Could rename variable',
      },
    ],
  });
  assert.equal(p2Only.effectiveVerdict, 'pass');
});

test('full autonomous close-out: worker -> isolated heterogeneous adversarial review (firewall, reject -> rework -> pass) -> squash integrate & cleanup', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aha-adv-e2e-'));
  const repo = join(root, 'repo');
  await git(root, 'init', '-b', 'main', 'repo');
  await git(repo, 'config', 'user.name', 'Test User');
  await git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'feature.ts'), 'export function greet() { return "old"; }\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base commit');
  const baseHead = await git(repo, 'rev-parse', 'HEAD');

  const store = new OrchestrationStore({ resolveFile: () => join(root, 'orchestration-state.json') });
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  const prompts = new Map();
  let spawnCounter = 0;

  const service = new OrchestrationService({
    store,
    agentStatusStore,
    listCodingAgents: () => makeRoster(),
    selectAgentForTask: (opts) => selectAgentForTask(opts),
    writePty: (ptyId, data) => {
      prompts.set(ptyId, (prompts.get(ptyId) ?? '') + data);
      return { ok: true };
    },
    spawnWorkerPty: async ({ cliId, cwd }) => {
      spawnCounter += 1;
      const ptyId = `local-w-${spawnCounter}`;
      agentStatusStore.registerPane(ptyId, { agentId: cliId || 'claude' });
      return { ptyId, cwd };
    },
    closeWorkerPty: async () => ({ ok: true }),
    isPtyAlive: () => true,
    isMcpEnabledForCli: () => true,
    getConfirmMode: () => 'chat-and-guard',
    getDefaultWorktree: () => true,
    getDefaultCwd: () => repo,
  });
  t.after(() => {
    service.dispose();
    store.flushSync();
    rmSync(root, { recursive: true, force: true });
  });

  const run = service.runCreate({
    objective: 'Upgrade greet() safely',
    from: 'local-coord',
    paneId: 'local-coord',
  }).run;

  // 1. Implementation worker (Codex) runs in isolated worktree.
  const impl = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'backend',
    task: 'Update greet() to return "hello"',
    constraints: ['Keep exported signature unchanged'],
    acceptance: 'greet() returns "hello"',
    agent: 'codex',
    worktree: true,
    userInitiated: true,
  });
  assert.equal(impl.status, 'started');
  assert.equal(impl.dispatch.baseCommit, baseHead);
  assert.ok(impl.worktreePath && existsSync(impl.worktreePath));

  // Worker writes buggy v1 and claims everything is perfect in verbal summary.
  writeFileSync(join(impl.worktreePath, 'feature.ts'), 'export function greet() { return "typo"; }\n', 'utf8');
  await service.workerDoneByPane(impl.ptyId, {
    outcome: 'completed',
    summary: 'SECRET_AUTHOR_BOAST: I verified everything and it is 100% flawless.',
  });

  // 2. Coordinator inspects real diff.
  const diffV1 = await dispatchOrchestrationHttpAction(
    service,
    'worker-diff',
    { worker: 'backend' },
    { callerPaneId: 'local-coord', signal: new AbortController().signal },
  );
  assert.equal(diffV1.status, 200);
  assert.match(diffV1.body.result.diff, /return "typo"/);

  // 3. Coordinator launches autonomous heterogeneous adversarial review (no chat-and-guard interruption!).
  const rev1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewOf: 'backend',
    reviewFocus: 'Verify return value and constraints',
  });
  assert.equal(rev1.status, 'started');
  assert.equal(rev1.agent, 'grok', 'must avoid author (codex) and coordinator (claude)');
  assert.notEqual(rev1.worktreePath, impl.worktreePath, 'reviewer runs in isolated detached worktree');
  const rev1Prompt = prompts.get(rev1.ptyId) || '';
  assert.doesNotMatch(rev1Prompt, /SECRET_AUTHOR_BOAST/, 'information firewall must withhold author summary');
  assert.match(rev1Prompt, /Keep exported signature unchanged/);

  // Simulate reviewer accidentally writing a stray file in its detached worktree -> detected, author untouched!
  writeFileSync(join(rev1.worktreePath, 'stray.tmp'), 'oops', 'utf8');
  await service.workerDoneByPane(rev1.ptyId, {
    outcome: 'completed',
    summary: 'Found wrong return value',
    verdict: 'pass', // Intentionally mismatched: P1 finding must override to REJECT!
    findings: [
      {
        severity: 'P1',
        location: 'feature.ts:1',
        title: 'Returns "typo" instead of "hello"',
        evidence: 'feature.ts returns "typo"',
        fix: 'Return "hello"',
      },
    ],
  });
  assert.equal(existsSync(join(impl.worktreePath, 'stray.tmp')), false);
  const afterReject = store.getDispatchContext(impl.dispatch.id);
  assert.equal(afterReject.reviewStatus, 'rejected');
  assert.equal(afterReject.reviewRound, 1);
  assert.equal(store.getDispatchContext(rev1.dispatch.id).reviewMutatedWorkspace, true);

  // 4. Author fixes in its original worktree, then Round 2 L2 parallel multi-perspective reviewers both PASS.
  writeFileSync(join(impl.worktreePath, 'feature.ts'), 'export function greet() { return "hello"; }\n', 'utf8');
  const rev2a = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'review-logic',
    reviewOf: 'backend',
    reviewFocus: 'Logic & acceptance',
  });
  const rev2b = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'review-sec',
    reviewOf: 'backend',
    reviewFocus: 'Security & boundaries',
  });
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewRound, 2, 'parallel perspectives share round 2');

  await service.workerDoneByPane(rev2a.ptyId, { outcome: 'completed', summary: 'Logic verified', verdict: 'pass' });
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'pending', 'waits for sibling L2 reviewer');
  await service.workerDoneByPane(rev2b.ptyId, { outcome: 'completed', summary: 'No issues', verdict: 'pass' });
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'passed');

  // Round 3 would exceed MAX_ADVERSARIAL_REVIEW_ROUNDS=2 if snapshot changes again.
  // Before integrating, verify cross-run caller cannot call worker-diff or worker-integrate.
  agentStatusStore.registerPane('local-other-run', { agentId: 'claude' });
  const runB = service.runCreate({ objective: 'Other Run', from: 'local-other-run', paneId: 'local-other-run' }).run;
  assert.ok(runB.id);
  const crossDiff = await dispatchOrchestrationHttpAction(
    service,
    'worker-diff',
    { dispatchId: impl.dispatch.id },
    { callerPaneId: 'local-other-run', signal: new AbortController().signal },
  );
  assert.equal(crossDiff.body.code, 'operation_rejected');
  const crossInt = await dispatchOrchestrationHttpAction(
    service,
    'worker-integrate',
    { dispatchId: impl.dispatch.id },
    { callerPaneId: 'local-other-run', signal: new AbortController().signal },
  );
  assert.equal(crossInt.body.code, 'operation_rejected');

  // 5. Coordinator squash-integrates with auto-release & branch cleanup!
  const integrated = await dispatchOrchestrationHttpAction(
    service,
    'worker-integrate',
    { worker: 'backend', mode: 'squash', releaseAfter: true },
    { callerPaneId: 'local-coord', signal: new AbortController().signal },
  );
  assert.equal(integrated.status, 200);
  const intRes = integrated.body.result;
  assert.equal(intRes.integrated, true);
  assert.equal(intRes.released, true);
  assert.equal(intRes.releasedReviews, 3);
  assert.equal(readFileSync(join(repo, 'feature.ts'), 'utf8'), 'export function greet() { return "hello"; }\n');
  assert.equal(await git(repo, 'rev-list', '--count', `${baseHead}..HEAD`), '1');
  assert.equal(existsSync(impl.worktreePath), false);
  assert.equal(existsSync(rev1.worktreePath), false);
  assert.equal(existsSync(rev2a.worktreePath), false);
  assert.equal(existsSync(rev2b.worktreePath), false);
  assert.equal(await git(repo, 'branch', '--list', impl.branch), '');
});
