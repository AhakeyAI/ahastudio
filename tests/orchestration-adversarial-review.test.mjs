import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { createRequire, syncBuiltinESMExports } from 'node:module';

const require = createRequire(import.meta.url);
const cliModule = require('../electron/orchestration/aha-orchestration-cli.cjs');

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

async function createRepoHarness(t, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'aha-adv-e2e-'));
  const repo = join(root, 'repo');
  await git(root, 'init', '-b', 'main', 'repo');
  await git(repo, 'config', 'user.name', 'Test User');
  await git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'feature.ts'), 'export function greet() { return "old"; }\n', 'utf8');
  writeFileSync(join(repo, 'extra.ts'), 'export const extra = 0;\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base commit');
  const baseHead = await git(repo, 'rev-parse', 'HEAD');

  const store = new OrchestrationStore({ resolveFile: () => join(root, 'orchestration-state.json') });
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  const prompts = new Map();
  let spawnCounter = 0;
  let coordAlive = true;

  const service = new OrchestrationService({
    store,
    agentStatusStore,
    listCodingAgents: () => makeRoster(),
    selectAgentForTask: (selOpts) => selectAgentForTask(selOpts),
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
    closeWorkerPty: async (id) => {
      await opts.onCloseWorker?.(id);
      return { ok: true };
    },
    isPtyAlive: (id) => (id === 'local-coord' ? coordAlive : true),
    isMcpEnabledForCli: () => true,
    getConfirmMode: () => opts.confirmMode ?? 'chat-and-guard',
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

  return {
    root,
    repo,
    baseHead,
    store,
    agentStatusStore,
    prompts,
    service,
    run,
    setCoordAlive: (v) => {
      coordAlive = v;
    },
  };
}

test('selectAgentForTask strictly avoids authorCliId before coordinatorCliId for adversarial review', () => {
  const roster = makeRoster();
  const picked = selectAgentForTask({
    roster,
    requestedAgent: 'auto',
    taskKind: 'review',
    coordinatorCliId: 'claude',
    authorCliId: 'codex',
  });
  assert.equal(picked.cliId, 'grok');

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

test('evaluateAdversarialVerdict fails closed on missing verdict, preserves explicit reject, overrides pass with P0/P1, and blocks mutated workspace', () => {
  // P1 forces reject even when reviewer wrote pass.
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

  // Missing verdict fails closed to reject (never auto-passes incomplete reports like "Tests could not run.").
  const missingVerdict = evaluateAdversarialVerdict({
    summary: 'Tests could not run.',
  });
  assert.equal(missingVerdict.effectiveVerdict, 'reject');

  // Explicit reject with P2-only findings MUST remain reject (never downgraded to pass).
  const explicitRejectWithP2 = evaluateAdversarialVerdict({
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
  assert.equal(explicitRejectWithP2.effectiveVerdict, 'reject');

  // Explicit pass with P2-only findings passes without blocking.
  const explicitPassWithP2 = evaluateAdversarialVerdict({
    verdict: 'pass',
    findings: [
      {
        severity: 'P2',
        location: 'src/auth.ts:10',
        title: 'Minor naming nit',
        evidence: 'Could rename variable',
      },
    ],
  });
  assert.equal(explicitPassWithP2.effectiveVerdict, 'pass');

  // Mutated or unverifiable read-only workspace forces reject even with verdict=pass.
  const mutatedPass = evaluateAdversarialVerdict({
    verdict: 'pass',
    mutatedWorkspace: true,
  });
  assert.equal(mutatedPass.effectiveVerdict, 'reject');
  assert.equal(mutatedPass.overriddenByWorkspaceIntegrity, true);

  const unverifiedPass = evaluateAdversarialVerdict({
    verdict: 'pass',
    verificationFailed: true,
  });
  assert.equal(unverifiedPass.effectiveVerdict, 'reject');
  assert.equal(unverifiedPass.overriddenByWorkspaceIntegrity, true);
});

test('full autonomous close-out: server review gate, chat-and-guard non-bypass, same-run firewall, real messageWorker rework, L2 parallel review, squash integrate & cleanup', async (t) => {
  const { root, repo, baseHead, store, agentStatusStore, prompts, service, run } =
    await createRepoHarness(t, { confirmMode: 'chat-and-guard' });

  // 1. Implementation worker (Codex) runs in isolated worktree.
  const impl = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'backend',
    task: 'Update greet() to return "hello" and bump extra',
    constraints: ['Keep exported signature unchanged'],
    acceptance: 'greet() returns "hello" and extra === 1',
    agent: 'codex',
    worktree: true,
    userInitiated: true,
  });
  assert.equal(impl.status, 'started');
  assert.equal(impl.dispatch.baseCommit, baseHead);
  assert.ok(impl.worktreePath && existsSync(impl.worktreePath));

  // Worker edits 2 code files (L1 tier -> requires passing adversarial review before integration).
  writeFileSync(join(impl.worktreePath, 'feature.ts'), 'export function greet() { return "typo"; }\n', 'utf8');
  writeFileSync(join(impl.worktreePath, 'extra.ts'), 'export const extra = 1;\n', 'utf8');
  store.archiveDispatchOutput(impl.dispatch.id, 'SECRET_AUTHOR_TRANSCRIPT: private debug output');
  await service.workerDoneByPane(impl.ptyId, {
    outcome: 'completed',
    summary: 'SECRET_AUTHOR_BOAST: I verified everything and it is 100% flawless.',
  });

  // Server gate MUST block unreviewed L1 integration even if coordinator passes force:true over HTTP!
  const unreviewedInt = await dispatchOrchestrationHttpAction(
    service,
    'worker-integrate',
    { worker: 'backend', mode: 'squash', force: true },
    { callerPaneId: 'local-coord', signal: new AbortController().signal },
  );
  assert.equal(unreviewedInt.body.code, 'operation_rejected');
  assert.match(unreviewedInt.body.error, /requires a passing adversarial review/i);

  // Non-git target cannot start reviewOf (never falls back to author directory).
  const nonGitDir = join(root, 'plain-folder');
  mkdirSync(nonGitDir, { recursive: true });
  const plainWorker = await service.workerStart({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'plain',
    spec: 'Do work in non-git folder',
    cwd: nonGitDir,
    noWorktree: true,
    agent: 'codex',
  });
  await service.workerDoneByPane(plainWorker.ptyId, { outcome: 'completed', summary: 'done' });
  await assert.rejects(
    () =>
      service.workerStart({
        from: 'local-coord',
        callerPaneId: 'local-coord',
        runId: run.id,
        reviewOf: plainWorker.dispatch.id,
      }),
    /requires a valid Git snapshot/i,
  );

  // reviewOf MUST reject reusing an existing terminal.
  agentStatusStore.registerPane('existing-term', { agentId: 'grok' });
  await assert.rejects(
    () =>
      service.delegateTask({
        from: 'local-coord',
        callerPaneId: 'local-coord',
        runId: run.id,
        reviewOf: 'backend',
        terminal: 'existing-term',
        userInitiated: true,
      }),
    /cannot reuse an existing terminal/i,
  );

  // 2. chat-and-guard MUST require confirmation for reviewOf (no silent bypass).
  const rev1Proposal = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewOf: 'backend',
    reviewFocus: 'Verify return value and constraints',
  });
  assert.equal(rev1Proposal.status, 'confirmation_required');

  // After a real user reply turn + explicit confirmation, reviewer starts in isolated detached worktree.
  service.recordUserPromptTurn('local-coord', 'hook');
  const rev1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewOf: 'backend',
    reviewFocus: 'Verify return value and constraints',
    confirmed: true,
    proposalId: rev1Proposal.proposal.id,
  });
  assert.equal(rev1.status, 'started');
  assert.equal(rev1.agent, 'grok', 'must avoid author (codex) and coordinator (claude)');
  assert.notEqual(rev1.worktreePath, impl.worktreePath, 'reviewer runs in isolated detached worktree');

  // Information firewall: initial prompt AND same-run boardRead AND workerRead/workerDiff hide author report!
  const rev1Prompt = prompts.get(rev1.ptyId) || '';
  assert.doesNotMatch(rev1Prompt, /SECRET_AUTHOR_BOAST/);
  assert.match(rev1Prompt, /Keep exported signature unchanged/);
  const boardAsReviewer = service.boardRead({ runId: run.id, from: rev1.ptyId });
  assert.doesNotMatch(boardAsReviewer.formatted, /SECRET_AUTHOR_BOAST/);
  const reviewerDiffAttempt = await dispatchOrchestrationHttpAction(
    service,
    'worker-diff',
    { worker: 'backend' },
    { callerPaneId: rev1.ptyId, signal: new AbortController().signal },
  );
  assert.equal(reviewerDiffAttempt.body.code, 'operation_rejected');
  const reviewerReadAttempt = await dispatchOrchestrationHttpAction(
    service,
    'worker-read',
    { dispatchId: impl.dispatch.id },
    { callerPaneId: rev1.ptyId, signal: new AbortController().signal },
  );
  assert.equal(reviewerReadAttempt.body.code, 'operation_rejected');
  assert.match(reviewerReadAttempt.body.error, /information firewall/i);
  for (const [action, payload] of [
    ['snapshot', { runId: run.id }],
    ['check', { runId: run.id, from: 'local-coord', all: true }],
    ['inbox', { runId: run.id, from: 'local-coord', all: true }],
    ['worker-list', { runId: run.id }],
    ['task-list', { runId: run.id }],
    ['run-show', { id: run.id }],
  ]) {
    const response = await dispatchOrchestrationHttpAction(service, action, payload, { callerPaneId: rev1.ptyId });
    assert.equal(response.status, 200, `${action} failed`);
    const serialized = JSON.stringify(response.body.result);
    assert.doesNotMatch(serialized, /SECRET_AUTHOR_BOAST/, `${action} leaked author summary`);
    assert.doesNotMatch(serialized, /SECRET_AUTHOR_TRANSCRIPT/, `${action} leaked author archivedOutput`);
  }
  assert.match(JSON.stringify(service.getSnapshot(run.id).messages), /SECRET_AUTHOR_BOAST/);
  assert.match(JSON.stringify(service.getSnapshot(run.id).dispatches), /SECRET_AUTHOR_TRANSCRIPT/);

  // While review is pending, integration MUST be blocked.
  const pendingInt = await dispatchOrchestrationHttpAction(
    service,
    'worker-integrate',
    { worker: 'backend', mode: 'squash' },
    { callerPaneId: 'local-coord', signal: new AbortController().signal },
  );
  assert.equal(pendingInt.body.code, 'operation_rejected');
  assert.match(pendingInt.body.error, /still pending/i);

  // Omitting verdict on review completion MUST be rejected with invalid_argument.
  await assert.rejects(
    () =>
      service.workerDoneByPane(rev1.ptyId, {
        outcome: 'completed',
        summary: 'Tests could not run.',
      }),
    /explicit verdict/i,
  );

  // Reviewer mutates its detached worktree and reports verdict='pass' with a P1 -> forced REJECT + mutated flag.
  writeFileSync(join(rev1.worktreePath, 'stray.tmp'), 'oops', 'utf8');
  await service.workerDoneByPane(rev1.ptyId, {
    outcome: 'completed',
    summary: 'Found wrong return value',
    verdict: 'pass',
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
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'rejected');
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewRound, 1);
  assert.equal(store.getDispatchContext(rev1.dispatch.id).reviewMutatedWorkspace, true);
  const boardCountBeforeDup = service.boardRead({ runId: run.id, from: 'local-coord' }).posts.length;
  const duplicate = service.workerDone({
    from: rev1.ptyId,
    dispatchId: rev1.dispatch.id,
    capability: store.getDispatchCapability(rev1.dispatch.id),
    outcome: 'completed',
    verdict: 'pass',
    summary: 'FORGED_DUPLICATE_PASS',
  });
  assert.equal(duplicate.lifecycle.action, 'duplicate');
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'rejected');
  assert.equal(store.getDispatchContext(rev1.dispatch.id).reviewStatus, 'rejected');
  const boardAfterDup = service.boardRead({ runId: run.id, from: 'local-coord' });
  assert.equal(boardAfterDup.posts.length, boardCountBeforeDup, 'duplicate review report must not post to Board');
  assert.doesNotMatch(boardAfterDup.formatted, /FORGED_DUPLICATE_PASS/);

  // Unauthorized sender attempting to report verdict for a review dispatch must be rejected before writing Board.
  assert.throws(
    () =>
      service.workerDone({
        from: 'local-coord',
        dispatchId: rev1.dispatch.id,
        capability: store.getDispatchCapability(rev1.dispatch.id),
        outcome: 'completed',
        verdict: 'pass',
        summary: 'FORGED_UNAUTH_PASS',
      }),
    /lacks lifecycle authority/i,
  );
  assert.doesNotMatch(service.boardRead({ runId: run.id, from: 'local-coord' }).formatted, /FORGED_UNAUTH_PASS/);

  // Rejected worker MUST be blocked from integration!
  const rejectedInt = await dispatchOrchestrationHttpAction(
    service,
    'worker-integrate',
    { worker: 'backend', mode: 'squash' },
    { callerPaneId: 'local-coord', signal: new AbortController().signal },
  );
  assert.equal(rejectedInt.body.code, 'operation_rejected');
  assert.match(rejectedInt.body.error, /is rejected/i);

  // 3. REAL rework via messageWorkerByRole -> verify baseCommit, repoRootPath, ownsBranch, and reviewRound inherit!
  const rework = await service.messageWorkerByRole('local-coord', {
    role: 'backend',
    message: 'Fix greet() to return "hello" per P1 finding.',
  });
  const reworkDispatch = rework.dispatch;
  assert.notEqual(reworkDispatch.id, impl.dispatch.id);
  assert.equal(reworkDispatch.baseCommit, baseHead, 'follow-up dispatch must preserve original baseCommit');
  assert.equal(reworkDispatch.ownsBranch, true, 'follow-up dispatch must inherit ownsBranch');
  assert.equal(reworkDispatch.reviewRound, 1, 'follow-up dispatch must preserve prior reviewRound');

  writeFileSync(join(reworkDispatch.worktreePath, 'feature.ts'), 'export function greet() { return "hello"; }\n', 'utf8');
  await service.workerDoneByPane(reworkDispatch.assigneePaneId, {
    outcome: 'completed',
    summary: 'Fixed greet()',
  });

  // 4. Round 2: truly concurrent L2 parallel reviewers on the same snapshot share reviewBatchId and round 2!
  const [rev2a, rev2b] = await Promise.all([
    service.delegateTask({
      from: 'local-coord',
      callerPaneId: 'local-coord',
      runId: run.id,
      role: 'review-logic',
      reviewOf: 'backend',
      reviewFocus: 'Logic & acceptance',
      userInitiated: true,
    }),
    service.delegateTask({
      from: 'local-coord',
      callerPaneId: 'local-coord',
      runId: run.id,
      role: 'review-sec',
      reviewOf: 'backend',
      reviewFocus: 'Security & boundaries',
      userInitiated: true,
    }),
  ]);
  const updatedTarget = store.getDispatchContext(reworkDispatch.id);
  assert.equal(updatedTarget.reviewRound, 2);
  assert.equal(rev2a.dispatch.reviewBatchId, rev2b.dispatch.reviewBatchId);
  assert.equal(rev2a.dispatch.reviewRound, 2);
  assert.equal(rev2b.dispatch.reviewRound, 2);

  await service.workerDoneByPane(rev2a.ptyId, { outcome: 'completed', summary: 'Logic verified', verdict: 'pass' });
  assert.equal(store.getDispatchContext(reworkDispatch.id).reviewStatus, 'pending');
  assert.equal(store.getDispatchContext(rev2a.dispatch.id).reviewMutatedWorkspace, undefined, 'clean detached worktree must not false-positive');
  await service.workerDoneByPane(rev2b.ptyId, { outcome: 'completed', summary: 'No issues', verdict: 'pass' });
  assert.equal(store.getDispatchContext(reworkDispatch.id).reviewStatus, 'passed');

  // Caller passing a different expectedSnapshotOid MUST NOT override server-approved snapshot OID.
  const mismatchOidInt = await dispatchOrchestrationHttpAction(
    service,
    'worker-integrate',
    {
      worker: 'backend',
      mode: 'squash',
      expectedSnapshotOid: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    },
    { callerPaneId: 'local-coord', signal: new AbortController().signal },
  );
  assert.equal(mismatchOidInt.body.code, 'operation_rejected');
  assert.match(mismatchOidInt.body.error, /does not match server-approved review snapshot/i);

  // 5. Coordinator squash-integrates with auto-release & cleans up worker + ALL 3 lineage reviews + branch!
  const integrated = await dispatchOrchestrationHttpAction(
    service,
    'worker-integrate',
    { worker: 'backend', mode: 'squash', releaseAfter: true },
    { callerPaneId: 'local-coord', signal: new AbortController().signal },
  );
  assert.equal(integrated.status, 200);
  const intRes = integrated.body.result;
  assert.equal(intRes.integrated, true);
  assert.equal(intRes.released, true, 'verified squash integration must cleanly release worker worktree and branch');
  assert.equal(intRes.releasedReviews, 3);
  assert.equal(readFileSync(join(repo, 'feature.ts'), 'utf8'), 'export function greet() { return "hello"; }\n');
  assert.equal(readFileSync(join(repo, 'extra.ts'), 'utf8'), 'export const extra = 1;\n');
  assert.equal(await git(repo, 'rev-list', '--count', `${baseHead}..HEAD`), '1');
  assert.equal(existsSync(reworkDispatch.worktreePath), false);
  assert.equal(existsSync(rev1.worktreePath), false);
  assert.equal(existsSync(rev2a.worktreePath), false);
  assert.equal(existsSync(rev2b.worktreePath), false);
  assert.equal(await git(repo, 'branch', '--list', impl.branch), '');
});

test('review batch aggregation: stopped reviewer rejects batch in both orders, stale R1 report cannot overwrite R2, round 3 escalates, and former worker cannot hijack run-use', async (t) => {
  const { store, service, run, setCoordAlive } = await createRepoHarness(t, { confirmMode: 'auto' });

  const impl = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'backend',
    task: 'Implement feature',
    agent: 'codex',
    worktree: true,
    userInitiated: true,
  });
  writeFileSync(join(impl.worktreePath, 'feature.ts'), 'export function greet() { return "v1"; }\n', 'utf8');
  writeFileSync(join(impl.worktreePath, 'extra.ts'), 'export const extra = 1;\n', 'utf8');
  await service.workerDoneByPane(impl.ptyId, { outcome: 'completed', summary: 'v1 done' });

  // Former worker of this run MUST NOT hijack run-use even after original coordinator exits!
  setCoordAlive(false);
  const hijack = await dispatchOrchestrationHttpAction(
    service,
    'run-use',
    { id: run.id },
    { callerPaneId: impl.ptyId, signal: new AbortController().signal },
  );
  assert.equal(hijack.body.code, 'operation_rejected');
  setCoordAlive(true);

  // Order A (Round 1): 2 parallel reviewers -> revA stopped first, revB reports PASS second -> target MUST be rejected (NOT passed!).
  const [r1a, r1b] = await Promise.all([
    service.workerStart({ from: 'local-coord', callerPaneId: 'local-coord', runId: run.id, role: 'r1a', reviewOf: 'backend' }),
    service.workerStart({ from: 'local-coord', callerPaneId: 'local-coord', runId: run.id, role: 'r1b', reviewOf: 'backend' }),
  ]);
  await service.workerStop({ dispatchId: r1a.dispatch.id, reason: 'cancelled' });
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'rejected');

  // Now author modifies snapshot and starts Round 2 BEFORE r1b reports late!
  writeFileSync(join(impl.worktreePath, 'feature.ts'), 'export function greet() { return "v2"; }\n', 'utf8');
  const [r2a, r2b] = await Promise.all([
    service.workerStart({ from: 'local-coord', callerPaneId: 'local-coord', runId: run.id, role: 'r2a', reviewOf: 'backend' }),
    service.workerStart({ from: 'local-coord', callerPaneId: 'local-coord', runId: run.id, role: 'r2b', reviewOf: 'backend' }),
  ]);
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewRound, 2);
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'pending');

  // Late report from R1's r1b MUST NOT overwrite active Round 2 batch status!
  await service.workerDoneByPane(r1b.ptyId, { outcome: 'completed', summary: 'late R1 pass', verdict: 'pass' });
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'pending');
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewRound, 2);

  // Order B (Round 2): r2a reports PASS first, then r2b is stopped -> target MUST settle to escalated (round 2 limit reached), never stuck pending!
  await service.workerDoneByPane(r2a.ptyId, { outcome: 'completed', summary: 'looks ok', verdict: 'pass' });
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'pending');
  await service.workerStop({ dispatchId: r2b.dispatch.id, reason: 'timed out' });
  assert.equal(store.getDispatchContext(impl.dispatch.id).reviewStatus, 'escalated');

  // Round 3 attempt MUST be rejected with review limit reached.
  writeFileSync(join(impl.worktreePath, 'feature.ts'), 'export function greet() { return "v3"; }\n', 'utf8');
  await assert.rejects(
    () =>
      service.workerStart({
        from: 'local-coord',
        callerPaneId: 'local-coord',
        runId: run.id,
        role: 'r3',
        reviewOf: 'backend',
      }),
    /limit reached/i,
  );
});

test('post-integration new author changes preserve worktree and branch instead of auto-deleting them', async (t) => {
  const { repo, service, run } = await createRepoHarness(t, { confirmMode: 'auto' });

  // Single tiny edit (L0) so we can exercise integration -> post-merge guard directly.
  const impl = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'docs',
    task: 'Add short note',
    agent: 'codex',
    worktree: true,
    userInitiated: true,
  });
  writeFileSync(join(impl.worktreePath, 'note.md'), '# Short note\n', 'utf8');
  await service.workerDoneByPane(impl.ptyId, { outcome: 'completed', summary: 'added note' });

  // Simulate author sneaking in an extra edit right after integration completes by intercepting workerRelease?
  // Better: test with releaseAfter:false, then modify, and also verify staged-divergence after merge protects retention.
  const rev = await service.workerStart({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'rev-docs',
    reviewOf: 'docs',
  });
  await service.workerDoneByPane(rev.ptyId, { outcome: 'completed', summary: 'ok', verdict: 'pass' });

  // Hook into store.insertMessage right before releaseAfter executes (during boardMsg recording) to write a new file into worker worktree.
  const origInsert = service.store.insertMessage.bind(service.store);
  let injectedNewEdit = false;
  service.store.insertMessage = (msgInput) => {
    const out = origInsert(msgInput);
    if (!injectedNewEdit && msgInput.subject === 'Integrated @docs') {
      injectedNewEdit = true;
      writeFileSync(join(impl.worktreePath, 'late-author-work.md'), 'DO NOT DELETE ME\n', 'utf8');
    }
    return out;
  };

  const intRes = await service.workerIntegrate(
    { worker: 'docs', mode: 'squash', releaseAfter: true },
    'local-coord',
  );
  assert.equal(intRes.integrated, true);
  assert.equal(intRes.released, false, 'must NOT delete worktree when author wrote new changes after merge');
  assert.match(intRes.releaseSkippedReason || '', /retained worktree and branch/i);
  assert.equal(existsSync(join(impl.worktreePath, 'late-author-work.md')), true);
  assert.equal(readFileSync(join(impl.worktreePath, 'late-author-work.md'), 'utf8'), 'DO NOT DELETE ME\n');
  assert.ok((await git(repo, 'branch', '--list', impl.branch)).includes(impl.branch));
});

test('failed detached review worktree cleanup does not mark releasedAt and remains retryable', async (t) => {
  const { root, store, service, run } = await createRepoHarness(t, { confirmMode: 'auto' });
  const impl = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-clean',
    task: 'Simple edit',
    agent: 'codex',
    worktree: true,
    userInitiated: true,
  });
  writeFileSync(join(impl.worktreePath, 'note.md'), '# hi\n', 'utf8');
  await service.workerDoneByPane(impl.ptyId, { outcome: 'completed', summary: 'done' });

  const rev = await service.workerStart({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'rev-clean',
    reviewOf: 'w-clean',
  });
  await service.workerDoneByPane(rev.ptyId, { outcome: 'completed', summary: 'ok', verdict: 'pass' });

  // Point review dispatch's repoRootPath temporarily to a non-repo dir so detached removal fails.
  const badRoot = join(root, 'not-a-repo');
  mkdirSync(badRoot, { recursive: true });
  const revRecord = store.dispatches.get(rev.dispatch.id);
  const origRepoRoot = revRecord.repoRootPath;
  revRecord.repoRootPath = badRoot;

  const firstAttempt = await service.workerRelease({ dispatchId: rev.dispatch.id, force: true });
  assert.equal(firstAttempt.removedWorktree, false);
  assert.ok(firstAttempt.worktreeError);
  assert.equal(firstAttempt.dispatch.releasedAt, null, 'must NOT mark releasedAt when worktree removal failed');

  // Restore valid repoRootPath and retry release -> succeeds cleanly now!
  revRecord.repoRootPath = origRepoRoot;
  const retryAttempt = await service.workerRelease({ dispatchId: rev.dispatch.id, force: true });
  assert.equal(retryAttempt.removedWorktree, true);
  assert.ok(retryAttempt.dispatch.releasedAt);
  assert.equal(existsSync(rev.worktreePath), false);
});

test('L0 auto-approval pins the inspected snapshot through the actual Git merge', async (t) => {
  const { repo, service, run, baseHead } = await createRepoHarness(t, { confirmMode: 'auto' });
  const impl = await service.delegateTask({
    from: 'local-coord', runId: run.id, role: 'docs-pinned', task: 'Add a note', worktree: true,
  });
  writeFileSync(join(impl.worktreePath, 'note.md'), '# Note\n');
  await service.workerDoneByPane(impl.ptyId, { outcome: 'completed', summary: 'done' });
  const spawn = childProcess.spawn;
  let changed = false;
  t.mock.method(childProcess, 'spawn', (command, args, options) => {
    if (!changed && args?.includes('refs/heads/' + impl.branch + '^{commit}')) {
      changed = true;
      writeFileSync(join(impl.worktreePath, 'extra.ts'), 'export const extra = 900;\n');
    }
    return spawn(command, args, options);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      service.workerIntegrate({ dispatchId: impl.dispatch.id, releaseAfter: false }, 'local-coord'),
      /snapshot changed/i,
    );
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.equal(changed, true);
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), baseHead);
  assert.equal(existsSync(join(repo, 'note.md')), false);
});

test('auto-release checks for local data written during terminal shutdown', async (t) => {
  let worktree;
  let workerPane;
  let closing = false;
  const { repo, store, service, run } = await createRepoHarness(t, {
    confirmMode: 'auto',
    onCloseWorker: (id) => {
      if (closing && id === workerPane) writeFileSync(join(worktree, 'late-local.txt'), 'Retain this edit\n');
    },
  });
  const impl = await service.delegateTask({
    from: 'local-coord', runId: run.id, role: 'cleanup-window', task: 'Small documentation edit', worktree: true,
  });
  worktree = impl.worktreePath;
  workerPane = impl.ptyId;
  service.workerKeepOpen({ dispatchId: impl.dispatch.id, keepOpen: true });
  writeFileSync(join(worktree, 'note.md'), '# Note\n');
  await git(worktree, 'add', '--', 'note.md');
  await git(worktree, 'commit', '-m', 'Documentation');
  await service.workerDoneByPane(workerPane, { outcome: 'completed', summary: 'done' });
  closing = true;
  const result = await service.workerIntegrate({ dispatchId: impl.dispatch.id }, 'local-coord');
  assert.equal(result.integrated, true);
  assert.equal(result.released, false);
  assert.match(result.releaseSkippedReason, /after shutdown/);
  assert.equal(readFileSync(join(worktree, 'late-local.txt'), 'utf8'), 'Retain this edit\n');
  assert.equal(store.getDispatchContext(impl.dispatch.id).releasedAt, null);
  assert.equal(store.getDispatchContext(impl.dispatch.id).ownsPane, false, 'closed pane must persist ownsPane=false even when worktree is retained');
  assert.ok((await git(repo, 'branch', '--list', impl.branch)).includes(impl.branch));
});

test('L0 exemption evaluates the full merge-base..snapshot range even when dispatch.baseCommit is missing', async (t) => {
  const { repo, store, service, run, baseHead } = await createRepoHarness(t, { confirmMode: 'auto' });
  const impl = await service.delegateTask({
    from: 'local-coord',
    runId: run.id,
    role: 'sneaky-l0',
    task: 'Two commits where only the last is a doc edit',
    worktree: true,
  });

  // Commit 1: substantial code change in security/auth path.
  writeFileSync(
    join(impl.worktreePath, 'auth.ts'),
    Array.from({ length: 25 }, (_, i) => `export const rule${i} = true;`).join('\n') + '\n',
    'utf8',
  );
  await git(impl.worktreePath, 'add', 'auth.ts');
  await git(impl.worktreePath, 'commit', '-m', 'add auth rules');

  // Commit 2: tiny single-line doc change (if baseCommit fell back to HEAD~1, this would look like L0!).
  writeFileSync(join(impl.worktreePath, 'readme.md'), '# Tiny note\n', 'utf8');
  await git(impl.worktreePath, 'add', 'readme.md');
  await git(impl.worktreePath, 'commit', '-m', 'update readme');

  await service.workerDoneByPane(impl.ptyId, { outcome: 'completed', summary: 'done' });
  // Simulate a legacy dispatch record lacking baseCommit.
  store.dispatches.get(impl.dispatch.id).baseCommit = null;

  await assert.rejects(
    () => service.workerIntegrate({ dispatchId: impl.dispatch.id, mode: 'squash' }, 'local-coord'),
    /requires a passing adversarial review/i,
  );
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), baseHead);
  assert.equal(existsSync(join(repo, 'auth.ts')), false);
});

test('Phase 2: selectAgentForTask avoids all integrated authorCliIds for Run-level secondary adversarial review', () => {
  const roster = makeRoster();
  const picked = selectAgentForTask({
    roster,
    requestedAgent: 'auto',
    taskKind: 'review',
    coordinatorCliId: 'claude',
    authorCliIds: ['codex', 'claude'],
  });
  assert.equal(picked.cliId, 'grok');
  assert.match(picked.reason, /codex|claude/);
});

test('Phase 2 E2E: dirty main -> aha/run/<runId> multi-worker integration -> Run-level secondary adversarial review -> rework -> finalize & cleanup', async (t) => {
  const { repo, baseHead, store, prompts, service, run } = await createRepoHarness(t, {
    confirmMode: 'auto',
  });

  // Main workspace has dirty uncommitted user WIP.
  writeFileSync(join(repo, 'user-wip.txt'), 'keep me untouched\n', 'utf8');

  // 1. Worker 1 (codex) edits 2 files -> passes per-worker review -> integrates via targetBranch='auto' into aha/run/<runId>.
  const w1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'backend',
    task: 'Add api module and update greet()',
    constraints: ['Export greet() returning hello'],
    acceptance: 'api.ts exports endpoint and greet returns hello',
    agent: 'codex',
    worktree: true,
  });
  assert.equal(w1.status, 'started');
  writeFileSync(join(w1.worktreePath, 'api.ts'), 'export const endpoint = "/v1";\n', 'utf8');
  writeFileSync(join(w1.worktreePath, 'feature.ts'), 'export function greet() { return "hello"; }\n', 'utf8');
  await service.workerDoneByPane(w1.ptyId, {
    outcome: 'completed',
    summary: 'SECRET_W1_SUMMARY: backend is 100% perfect',
  });

  // Per-worker review for w1 passes.
  const rev1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewOf: '@backend',
  });
  assert.equal(rev1.status, 'started');
  assert.notEqual(rev1.agent, 'codex');
  await service.workerDoneByPane(rev1.ptyId, {
    outcome: 'completed',
    verdict: 'pass',
    summary: 'Backend verified.',
  });

  // Explicit targetBranch='main' refuses because main has dirty uncommitted files.
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@backend', mode: 'squash', targetBranch: 'main' }, 'local-coord'),
    /uncommitted file/i,
  );

  // Default (omitted targetBranch -> 'auto') detects dirty main and automatically creates aha/run/<runId>!
  const int1 = await service.workerIntegrate(
    { worker: '@backend', mode: 'squash' },
    'local-coord',
  );
  assert.equal(int1.integrated, true);
  assert.equal(int1.usedRunIntegrationBranch, true);
  assert.equal(int1.targetBranch, `aha/run/${run.id}`);
  assert.equal(int1.released, true);
  assert.equal(readFileSync(join(repo, 'user-wip.txt'), 'utf8'), 'keep me untouched\n');

  const runAfterW1 = store.requireRun(run.id);
  assert.equal(runAfterW1.integrationStatus, 'active');
  assert.equal(runAfterW1.integrationBranch, `aha/run/${run.id}`);
  assert.equal(runAfterW1.integrationBaseCommit, baseHead);
  assert.ok(runAfterW1.integrationWorktreePath && existsSync(runAfterW1.integrationWorktreePath));

  // 2. Worker 2 (claude) spawned while aha/run/<runId> is active automatically bases off aha/run/<runId> (sees api.ts!).
  const w2 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'frontend',
    task: 'Wire ui.ts to api endpoint and bump extra',
    constraints: ['Use endpoint from api.ts'],
    acceptance: 'ui.ts imports api.ts and extra === 2',
    agent: 'claude',
    worktree: true,
  });
  assert.equal(w2.status, 'started');
  assert.equal(
    existsSync(join(w2.worktreePath, 'api.ts')),
    true,
    'new worker in run with active aha/run/<runId> must base off integration branch',
  );
  writeFileSync(join(w2.worktreePath, 'ui.ts'), 'import { endpoint } from "./api";\nexport const url = endpoint + "/bug";\n', 'utf8');
  writeFileSync(join(w2.worktreePath, 'extra.ts'), 'export const extra = 2;\n', 'utf8');
  await service.workerDoneByPane(w2.ptyId, {
    outcome: 'completed',
    summary: 'SECRET_W2_SUMMARY: frontend wired flawlessly',
  });

  const rev2 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewOf: '@frontend',
  });
  await service.workerDoneByPane(rev2.ptyId, {
    outcome: 'completed',
    verdict: 'pass',
    summary: 'Frontend verified.',
  });

  // Explicit targetBranch='main' while aha/run/<runId> is active must be rejected to prevent split-brain.
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@frontend', mode: 'squash', targetBranch: 'main' }, 'local-coord'),
    /already has an active integration branch/i,
  );

  // Omitting targetBranch automatically continues onto active aha/run/<runId>.
  const int2 = await service.workerIntegrate({ worker: '@frontend', mode: 'squash' }, 'local-coord');
  assert.equal(int2.integrated, true);
  assert.equal(int2.usedRunIntegrationBranch, true);
  assert.equal(int2.targetBranch, `aha/run/${run.id}`);

  // 3. inspect_run_diff shows combined changes across BOTH workers!
  const diffRes = await dispatchOrchestrationHttpAction(
    service,
    'run-diff',
    { runId: run.id },
    { signal: new AbortController().signal, callerPaneId: 'local-coord' },
  );
  assert.equal(diffRes.status, 200);
  assert.equal(diffRes.body.result.hasIntegratedChanges, true);
  assert.equal(diffRes.body.result.commitsAhead, 2);
  assert.deepEqual(diffRes.body.result.changedFiles.sort(), ['api.ts', 'extra.ts', 'feature.ts', 'ui.ts']);
  assert.equal(diffRes.body.result.integratedWorkers.length, 2);

  // 4. Launch Post-Integration Run-level overall secondary adversarial review!
  // Authors were codex + claude -> must pick grok!
  const runRev1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
    reviewFocus: 'cross-worker API/UI wiring & contracts',
  });
  assert.equal(runRev1.status, 'started');
  assert.equal(runRev1.agent, 'grok', 'Run-level review must avoid both codex and claude authors');
  assert.equal(runRev1.dispatch.reviewOfRunId, run.id);
  assert.equal(runRev1.dispatch.isDetachedReviewWorktree, true);
  assert.ok(runRev1.worktreePath && existsSync(runRev1.worktreePath));

  // Verify information firewall: neither worker's verbal self-summary appears in Run reviewer's prompt or board!
  const revPrompt = prompts.get(runRev1.ptyId) ?? '';
  assert.doesNotMatch(revPrompt, /SECRET_W1_SUMMARY/);
  assert.doesNotMatch(revPrompt, /SECRET_W2_SUMMARY/);
  assert.match(revPrompt, /cross-worker API\/UI wiring/);
  const boardAsRunRev = service.boardRead({ runId: run.id, from: runRev1.ptyId, markRead: false });
  for (const post of boardAsRunRev.posts) {
    assert.doesNotMatch(post.body, /SECRET_W1_SUMMARY/);
    assert.doesNotMatch(post.body, /SECRET_W2_SUMMARY/);
  }
  assert.throws(
    () => service.workerRead({ dispatchId: w1.dispatch.id }, runRev1.ptyId),
    /Information firewall/i,
  );
  // Run reviewer cannot call run-diff or run-finalize either!
  const revDiffDenied = await dispatchOrchestrationHttpAction(
    service,
    'run-diff',
    { runId: run.id },
    { signal: new AbortController().signal, callerPaneId: runRev1.ptyId },
  );
  assert.equal(revDiffDenied.status, 400);
  assert.equal(revDiffDenied.body.code, 'operation_rejected');

  // While Run-level review is pending, runFinalizeIntegration MUST be blocked!
  await assert.rejects(
    () => service.runFinalizeIntegration({ runId: run.id, mode: 'squash' }, 'local-coord'),
    /active dispatch|still pending/i,
  );

  // Round 1 Run-level reviewer reports REJECT with a P1 cross-worker bug!
  await service.workerDoneByPane(runRev1.ptyId, {
    outcome: 'completed',
    verdict: 'reject',
    summary: 'Found cross-worker URL suffix bug in ui.ts.',
    findings: [
      {
        severity: 'P1',
        location: 'ui.ts:2',
        title: 'Wrong endpoint suffix',
        evidence: 'ui.ts appends "/bug" to endpoint from api.ts',
        fix: 'Remove "/bug" suffix',
      },
    ],
  });
  assert.equal(store.requireRun(run.id).runReviewStatus, 'rejected');

  // Finalization MUST remain blocked after REJECT (even with force: true from terminal caller!).
  await assert.rejects(
    () => service.runFinalizeIntegration({ runId: run.id, mode: 'squash', force: true }, 'local-coord'),
    /Run-level adversarial review.*rejected/i,
  );

  // 5. Spawn fix worker (automatically based off aha/run/<runId>), fix ui.ts (L0 small 1-file edit), integrate into aha/run/<runId>.
  const fixer = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'fixer',
    task: 'Remove "/bug" suffix from ui.ts',
    agent: 'codex',
    worktree: true,
  });
  assert.equal(fixer.status, 'started');
  writeFileSync(join(fixer.worktreePath, 'ui.ts'), 'import { endpoint } from "./api";\nexport const url = endpoint;\n', 'utf8');
  await service.workerDoneByPane(fixer.ptyId, { outcome: 'completed', summary: 'Fixed ui.ts' });
  const intFix = await service.workerIntegrate({ worker: '@fixer', mode: 'squash' }, 'local-coord');
  assert.equal(intFix.integrated, true);
  assert.equal(intFix.usedRunIntegrationBranch, true);

  // 6. Round 2 Run-level secondary adversarial review on updated aha/run/<runId> HEAD -> PASS!
  const runRev2 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
  });
  assert.equal(runRev2.status, 'started');
  assert.equal(runRev2.dispatch.reviewRound, 2);
  await service.workerDoneByPane(runRev2.ptyId, {
    outcome: 'completed',
    verdict: 'pass',
    summary: 'Combined changes look solid.',
  });
  const approvedRun = store.requireRun(run.id);
  assert.equal(approvedRun.runReviewStatus, 'passed');
  assert.equal(approvedRun.runReviewSnapshotOid, intFix.integratedCommit);

  // TOCTOU check: mismatched expectedSnapshotOid is rejected.
  await assert.rejects(
    () =>
      service.runFinalizeIntegration(
        {
          runId: run.id,
          mode: 'squash',
          expectedSnapshotOid: '0123456789abcdef0123456789abcdef01234567',
        },
        'local-coord',
      ),
    /does not match Run-level approved snapshot/i,
  );

  // User commits dirty WIP on main so main is now clean.
  await git(repo, 'add', 'user-wip.txt');
  await git(repo, 'commit', '-m', 'save user wip');

  // 7. Finalize via HTTP router!
  const finRes = await dispatchOrchestrationHttpAction(
    service,
    'run-finalize',
    { runId: run.id, mode: 'squash' },
    { signal: new AbortController().signal, callerPaneId: 'local-coord' },
  );
  assert.equal(finRes.status, 200);
  assert.equal(finRes.body.result.integrated, true);
  assert.equal(finRes.body.result.removedWorktree, true);
  assert.equal(finRes.body.result.removedBranch, true);
  assert.equal(finRes.body.result.releasedReviews, 2);

  const finalRun = store.requireRun(run.id);
  assert.equal(finalRun.integrationStatus, 'finalized');
  assert.ok(finalRun.finalizedCommit);
  assert.equal(finalRun.integrationWorktreePath, null);
  assert.equal(finalRun.integrationBranch, null);
  assert.equal(existsSync(runAfterW1.integrationWorktreePath), false);
  assert.equal(existsSync(runRev1.worktreePath), false);
  assert.equal(existsSync(runRev2.worktreePath), false);
  assert.equal(await git(repo, 'branch', '--list', `aha/run/${run.id}`), '');
  assert.equal(readFileSync(join(repo, 'user-wip.txt'), 'utf8'), 'keep me untouched\n');
  assert.equal(readFileSync(join(repo, 'ui.ts'), 'utf8'), 'import { endpoint } from "./api";\nexport const url = endpoint;\n');
  assert.equal(readFileSync(join(repo, 'api.ts'), 'utf8'), 'export const endpoint = "/v1";\n');
});

test('Phase 2: direct-to-main Run supports post-integration Run-level review even when main later gets dirty, enforces workspace mutation rejection, 2-round escalation, and cross-run auth', async (t) => {
  const { repo, baseHead, store, service, run } = await createRepoHarness(t, {
    confirmMode: 'auto',
  });

  // Create a second run owned by another coordinator to test cross-run auth.
  const otherRun = service.runCreate({
    objective: 'Other run',
    from: 'other-coord',
    paneId: 'other-coord',
  }).run;

  // Before any integration, reviewRun MUST reject cleanly.
  await assert.rejects(
    () => service.delegateTask({ from: 'local-coord', callerPaneId: 'local-coord', reviewRun: true }),
    /No integrated changes found/i,
  );

  // Integrate a small L0 change directly into clean main.
  const w1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'docs',
    task: 'Add notes.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(w1.worktreePath, 'notes.md'), '# Notes\n', 'utf8');
  await service.workerDoneByPane(w1.ptyId, { outcome: 'completed', summary: 'Added notes.md' });
  const int1 = await service.workerIntegrate({ worker: '@docs', mode: 'squash' }, 'local-coord');
  assert.equal(int1.integrated, true);
  assert.equal(int1.usedRunIntegrationBranch, false);

  // Even if main later has dirty uncommitted files, runDiff & reviewRun inspect exact baseCommit..integrationHeadCommit!
  writeFileSync(join(repo, 'later-dirty.txt'), 'not part of run\n', 'utf8');

  const diff = await service.runDiff({ runId: run.id }, 'local-coord');
  assert.equal(diff.hasIntegratedChanges, true);
  assert.equal(diff.baseCommit, baseHead);
  assert.equal(diff.targetCommit, int1.integratedCommit);
  assert.deepEqual(diff.changedFiles, ['notes.md']);

  // Cross-run authorization MUST reject other-coord calling run-diff / run-finalize / reviewRun on run.id!
  const crossDiff = await dispatchOrchestrationHttpAction(
    service,
    'run-diff',
    { runId: run.id },
    { signal: new AbortController().signal, callerPaneId: 'other-coord' },
  );
  assert.equal(crossDiff.status, 400);
  const crossReview = await dispatchOrchestrationHttpAction(
    service,
    'delegate-task',
    { reviewRun: run.id },
    { signal: new AbortController().signal, callerPaneId: 'other-coord' },
  );
  assert.equal(crossReview.status, 400);
  assert.notEqual(otherRun.id, run.id);

  // Round 1 Run-level reviewer mutates its detached review worktree -> forced REJECT even if verdict='pass'!
  const r1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
  });
  writeFileSync(join(r1.worktreePath, 'illegal-edit.txt'), 'mutated\n', 'utf8');
  await service.workerDoneByPane(r1.ptyId, {
    outcome: 'completed',
    verdict: 'pass',
    summary: 'Tried to sneak a pass after mutating workspace',
  });
  assert.equal(store.requireRun(run.id).runReviewStatus, 'rejected');

  // Round 2 Run-level reviewer explicitly rejects -> escalated after reaching max 2 rounds!
  const r2 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
  });
  assert.equal(r2.dispatch.reviewRound, 2);
  await service.workerDoneByPane(r2.ptyId, {
    outcome: 'completed',
    verdict: 'reject',
    summary: 'Still missing details',
    findings: [
      {
        severity: 'P1',
        location: 'notes.md:1',
        title: 'Incomplete docs',
        evidence: 'Only heading present',
      },
    ],
  });
  assert.equal(store.requireRun(run.id).runReviewStatus, 'escalated');

  // Round 3 MUST be blocked by escalation limit!
  await assert.rejects(
    () => service.delegateTask({ from: 'local-coord', callerPaneId: 'local-coord', reviewRun: true }),
    /Run-level adversarial review limit reached/i,
  );
});

test('Phase 2: parallel Run-level review batch rejects when one reviewer stops, TOCTOU blocks finalize after post-pass commit, chat-and-guard is enforced, and CLI parses Phase 2 flags', async (t) => {
  // 1. CLI parser verification for Phase 2 commands/flags.
  const diffParsed = cliModule.parseCliArgs(['orchestration', 'run', 'diff', '--run', 'run_1', '--file', 'a.ts', '--max-diff-bytes', '4096']);
  const diffBuilt = cliModule.buildPayload(diffParsed.verb, diffParsed.flags, diffParsed.positional, diffParsed.namespace);
  assert.equal(diffBuilt.action, 'run-diff');
  assert.deepEqual(diffBuilt.payload, { runId: 'run_1', files: ['a.ts'], maxDiffBytes: 4096 });

  const finParsed = cliModule.parseCliArgs(['run', 'finalize', '--mode', 'squash', '--no-delete-branch', '--keep-worktree']);
  const finBuilt = cliModule.buildPayload(finParsed.verb, finParsed.flags, finParsed.positional, finParsed.namespace);
  assert.equal(finBuilt.action, 'run-finalize');
  assert.equal(finBuilt.payload.mode, 'squash');
  assert.equal(finBuilt.payload.deleteBranch, false);
  assert.equal(finBuilt.payload.keepWorktree, true);

  const intParsed = cliModule.parseCliArgs(['worker', 'integrate', '@backend', '--target-branch', 'integration']);
  const intBuilt = cliModule.buildPayload(intParsed.verb, intParsed.flags, intParsed.positional, intParsed.namespace);
  assert.equal(intBuilt.action, 'worker-integrate');
  assert.equal(intBuilt.payload.worker, '@backend');
  assert.equal(intBuilt.payload.targetBranch, 'integration');

  const revRunParsed = cliModule.parseCliArgs(['worker', 'start', '--review-run', '--review-focus', 'security', '--run', 'run_1']);
  const revRunBuilt = cliModule.buildPayload(revRunParsed.verb, revRunParsed.flags, revRunParsed.positional, revRunParsed.namespace);
  assert.equal(revRunBuilt.action, 'worker-start');
  assert.equal(revRunBuilt.payload.reviewRun, true);
  assert.equal(revRunBuilt.payload.reviewFocus, 'security');
  assert.equal(revRunBuilt.payload.runId, 'run_1');

  // 2. Service tests with chat-and-guard enabled.
  const { repo, store, service, run } = await createRepoHarness(t, {
    confirmMode: 'chat-and-guard',
  });

  // Integrate Worker 1 (L0) into aha/run/<runId> while main is dirty.
  writeFileSync(join(repo, 'wip.txt'), 'wip\n', 'utf8');
  const w1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w1',
    task: 'Add doc1.md',
    agent: 'codex',
    worktree: true,
    userInitiated: true,
  });
  writeFileSync(join(w1.worktreePath, 'doc1.md'), '# Doc 1\n', 'utf8');
  await service.workerDoneByPane(w1.ptyId, { outcome: 'completed', summary: 'done' });
  const int1 = await service.workerIntegrate(
    { worker: '@w1', mode: 'squash', targetBranch: 'integration' },
    'local-coord',
  );
  assert.equal(int1.integrated, true);

  // reviewRun MUST NOT bypass chat-and-guard!
  const unconfirmed = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
  });
  assert.equal(unconfirmed.status, 'confirmation_required');

  // Launch 2 parallel Run-level reviewers (same batch, Round 1).
  const rrA = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
    reviewFocus: 'angle A',
    userInitiated: true,
  });
  const rrB = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
    reviewFocus: 'angle B',
    userInitiated: true,
  });
  assert.equal(rrA.dispatch.reviewBatchId, rrB.dispatch.reviewBatchId);
  assert.equal(rrA.dispatch.reviewRound, 1);
  assert.equal(rrB.dispatch.reviewRound, 1);

  // Reviewer A passes, Reviewer B is stopped -> batch MUST become rejected!
  await service.workerDoneByPane(rrA.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'A passed' });
  assert.equal(store.requireRun(run.id).runReviewStatus, 'pending');
  await service.workerStop({ dispatchId: rrB.dispatch.id, reason: 'timed out' });
  assert.equal(store.requireRun(run.id).runReviewStatus, 'rejected');

  // Round 2 Run-level review passes on current aha/run/<runId> HEAD (int1.integratedCommit).
  const rr2 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
    userInitiated: true,
  });
  assert.equal(rr2.dispatch.reviewRound, 2);
  await service.workerDoneByPane(rr2.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'R2 passed' });
  assert.equal(store.requireRun(run.id).runReviewStatus, 'passed');
  assert.equal(store.requireRun(run.id).runReviewSnapshotOid, int1.integratedCommit);

  // Integrate another worker into aha/run/<runId> AFTER Round 2 passed -> advances aha/run/<runId> HEAD!
  const w2 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w2',
    task: 'Add doc2.md',
    agent: 'codex',
    worktree: true,
    userInitiated: true,
  });
  writeFileSync(join(w2.worktreePath, 'doc2.md'), '# Doc 2\n', 'utf8');
  await service.workerDoneByPane(w2.ptyId, { outcome: 'completed', summary: 'done' });
  const int2 = await service.workerIntegrate({ worker: '@w2', mode: 'squash' }, 'local-coord');
  assert.equal(int2.integrated, true);
  assert.notEqual(int2.integratedCommit, int1.integratedCommit);

  // Clean main, then attempt runFinalizeIntegration WITHOUT passing expectedSnapshotOid:
  // Server-enforced TOCTOU guard MUST reject because aha/run/<runId> moved past runReviewSnapshotOid!
  rmSync(join(repo, 'wip.txt'));
  await assert.rejects(
    () => service.runFinalizeIntegration({ runId: run.id, mode: 'squash' }, 'local-coord'),
    /snapshot changed since review/i,
  );

  // Post-PASS re-review MUST NOT deadlock at Round 3 (maxRounds=2): fresh post-PASS snapshot restarts at Round 1!
  const rr3 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewRun: true,
    userInitiated: true,
  });
  assert.equal(rr3.status, 'started');
  assert.equal(rr3.dispatch.reviewRound, 1, 'post-PASS new snapshot must restart Run review at Round 1/2');
  assert.equal(rr3.dispatch.reviewSnapshotOid, int2.integratedCommit);
  await service.workerDoneByPane(rr3.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'Post-pass re-review passed' });
  assert.equal(store.requireRun(run.id).runReviewStatus, 'passed');
  assert.equal(store.requireRun(run.id).runReviewSnapshotOid, int2.integratedCommit);

  const fin1 = await service.runFinalizeIntegration({ runId: run.id, mode: 'squash' }, 'local-coord');
  assert.equal(fin1.integrated, true);
  assert.equal(fin1.removedWorktree, true);
  assert.equal(fin1.removedBranch, true);
  assert.equal(store.requireRun(run.id).integrationStatus, 'finalized');

  // Wave 2 after finalization: main gets dirty again, new worker integrates into a fresh aha/run/<runId>,
  // Wave 1's completed review state is reset, and Wave 2 finalizes cleanly once main is clean!
  writeFileSync(join(repo, 'wip2.txt'), 'wave 2 wip\n', 'utf8');
  const w3 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w3',
    task: 'Add doc3.md',
    agent: 'codex',
    worktree: true,
    userInitiated: true,
  });
  writeFileSync(join(w3.worktreePath, 'doc3.md'), '# Doc 3\n', 'utf8');
  await service.workerDoneByPane(w3.ptyId, { outcome: 'completed', summary: 'done w3' });
  const int3 = await service.workerIntegrate({ worker: '@w3', mode: 'squash', targetBranch: 'auto' }, 'local-coord');
  assert.equal(int3.integrated, true);
  assert.equal(int3.usedRunIntegrationBranch, true);
  assert.equal(store.requireRun(run.id).integrationStatus, 'active');
  assert.equal(store.requireRun(run.id).finalizedCommit, null);
  assert.equal(store.requireRun(run.id).runReviewStatus, 'none');

  rmSync(join(repo, 'wip2.txt'));
  const fin2 = await service.runFinalizeIntegration({ runId: run.id, mode: 'squash' }, 'local-coord');
  assert.equal(fin2.integrated, true);
  assert.equal(existsSync(join(repo, 'doc3.md')), true);
  assert.equal(store.requireRun(run.id).integrationStatus, 'finalized');

  // CLI --review-run=<runId> preserves explicit run ID string.
  const revRunIdParsed = cliModule.parseCliArgs(['worker-start', '--review-run=run_explicit_9']);
  const revRunIdBuilt = cliModule.buildPayload(
    revRunIdParsed.verb,
    revRunIdParsed.flags,
    revRunIdParsed.positional,
    revRunIdParsed.namespace,
  );
  assert.equal(revRunIdBuilt.payload.reviewRun, 'run_explicit_9');
});

test('Phase 2: finalize conflict sets integrationStatus="conflict" and allows recovery; concurrent finalize/integrate serializes; store persists Phase 2 fields; guards reject conflicting runId/reviewRun and wrong _run branch', async (t) => {
  const { repo, store, service, run } = await createRepoHarness(t, { confirmMode: 'auto' });

  // Conflicting runId vs reviewRun must be rejected.
  await assert.rejects(
    () =>
      service.delegateTask({
        from: 'local-coord',
        callerPaneId: 'local-coord',
        runId: run.id,
        reviewRun: 'run_other_conflict',
      }),
    /Conflicting runId/i,
  );

  // Worker 1 edits README.md -> integrates into aha/run/<runId> while main is dirty.
  writeFileSync(join(repo, 'dirty.txt'), 'dirty\n', 'utf8');
  const w1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w1',
    task: 'Edit README.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(w1.worktreePath, 'README.md'), '# From Worker 1\n', 'utf8');
  await service.workerDoneByPane(w1.ptyId, { outcome: 'completed', summary: 'updated readme' });
  const int1 = await service.workerIntegrate(
    { worker: '@w1', mode: 'squash', targetBranch: 'auto' },
    'local-coord',
  );
  assert.equal(int1.integrated, true);
  assert.equal(int1.usedRunIntegrationBranch, true);

  // Store persistence/hydration round-trip preserves Phase 2 Run & Dispatch fields.
  store.flushSync();
  const stateFilePath = join(repo, '..', 'orchestration-state.json');
  const reloadedStore = new OrchestrationStore({ resolveFile: () => stateFilePath });
  reloadedStore.load();
  const reloadedRun = reloadedStore.requireRun(run.id);
  assert.equal(reloadedRun.integrationStatus, 'active');
  assert.equal(reloadedRun.integrationBranch, `aha/run/${run.id}`);
  assert.equal(reloadedRun.integrationHeadCommit, int1.integratedCommit);
  assert.equal(reloadedStore.getDispatchContext(w1.dispatch.id)?.integratedTargetBranch, `aha/run/${run.id}`);

  // If _run-* is switched to another branch, delegateTask(reviewRun) MUST reject!
  const runWt = store.requireRun(run.id).integrationWorktreePath;
  await git(runWt, 'checkout', '--detach', 'HEAD');
  await assert.rejects(
    () => service.delegateTask({ from: 'local-coord', callerPaneId: 'local-coord', reviewRun: true }),
    /detached HEAD.*instead of refs\/heads\/aha\/run\//i,
  );
  await git(runWt, 'checkout', `aha/run/${run.id}`);

  // Clean dirty file, then create a conflicting commit on main -> runFinalizeIntegration sets integrationStatus='conflict'.
  rmSync(join(repo, 'dirty.txt'));
  const preConflictMainHead = await git(repo, 'rev-parse', 'HEAD');
  writeFileSync(join(repo, 'README.md'), '# Conflicting Main Edit\n', 'utf8');
  await git(repo, 'add', 'README.md');
  await git(repo, 'commit', '-m', 'main conflicting edit');

  const conflictFin = await service.runFinalizeIntegration({ runId: run.id, mode: 'squash' }, 'local-coord');
  assert.equal(conflictFin.integrated, false);
  assert.equal(conflictFin.checkStatus, 'conflict');
  assert.equal(store.requireRun(run.id).integrationStatus, 'conflict');

  // runDiff still works while integrationStatus === 'conflict'.
  const conflictDiff = await service.runDiff({ runId: run.id }, 'local-coord');
  assert.equal(conflictDiff.integrationStatus, 'conflict');
  assert.equal(conflictDiff.hasIntegratedChanges, true);

  // Reset main back to preConflictMainHead, spawn w2 (L0) and race workerIntegrate + runFinalizeIntegration!
  await git(repo, 'reset', '--hard', preConflictMainHead);
  const w2 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w2',
    task: 'Add extra.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(w2.worktreePath, 'extra.md'), '# Extra\n', 'utf8');
  await service.workerDoneByPane(w2.ptyId, { outcome: 'completed', summary: 'done extra' });

  // Pass adversarial review on w2 (since w2 branched off aha/run/<runId> and therefore differs from
  // main by both README.md and extra.md -> L1 once aha/run/<runId> is squashed into main).
  const w2Rev = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewOf: '@w2',
  });
  await service.workerDoneByPane(w2Rev.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'w2 verified' });

  // Concurrent runFinalizeIntegration + workerIntegrate on the same Run MUST serialize cleanly:
  // finalize completes first (status='finalized', deletes aha/run/*), then workerIntegrate sees finalized
  // state and integrates cleanly into main (NOT resurrecting a stale aha/run/* branch!).
  const [finRes, int2Res] = await Promise.all([
    service.runFinalizeIntegration({ runId: run.id, mode: 'squash' }, 'local-coord'),
    service.workerIntegrate({ worker: '@w2', mode: 'squash' }, 'local-coord'),
  ]);
  assert.equal(finRes.integrated, true);
  assert.equal(int2Res.integrated, true);
  assert.equal(int2Res.usedRunIntegrationBranch, false, 'queued workerIntegrate after finalize must not resurrect deleted aha/run/*');
  assert.equal(store.requireRun(run.id).integrationStatus, 'none');
  assert.equal(store.requireRun(run.id).finalizedCommit, null);
  assert.equal(existsSync(join(repo, 'README.md')), true);
  assert.equal(existsSync(join(repo, 'extra.md')), true);
  const combinedAfterW2 = await service.runDiff({ runId: run.id }, 'local-coord');
  assert.equal(combinedAfterW2.targetCommit, int2Res.integratedCommit);
  assert.ok(combinedAfterW2.changedFiles.includes('extra.md'), 'runDiff must include worker integrated after finalization');
});

test('Phase 2 review fixes: base branch switch guard, reviewRun-vs-finalize lock, post-finalize direct runDiff/review, and auto cross-repo guard', async (t) => {
  // 1) Base branch switch guard (P1 #1) + post-finalize direct integration runDiff/review (P1 #3) + auto cross-repo guard (P2 #4)
  const { root, repo, store, service, run } = await createRepoHarness(t, { confirmMode: 'auto' });

  // Worker 1 integrates directly into `main` -> Run binds integrationBaseBranch='main' and integrationRepoRootPath=repo.
  const w1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w1-main',
    task: 'Add w1.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(w1.worktreePath, 'w1.md'), '# W1\n', 'utf8');
  await service.workerDoneByPane(w1.ptyId, { outcome: 'completed', summary: 'w1 done' });
  const int1 = await service.workerIntegrate({ worker: '@w1-main', mode: 'squash' }, 'local-coord');
  assert.equal(int1.integrated, true);
  assert.equal(store.requireRun(run.id).integrationBaseBranch, 'main');

  // Switch main repo to an unrelated branch with unrelated commit.
  await git(repo, 'checkout', '-b', 'unrelated-branch');
  writeFileSync(join(repo, 'unrelated.txt'), 'DO NOT MERGE INTO MAIN\n', 'utf8');
  await git(repo, 'add', 'unrelated.txt');
  await git(repo, 'commit', '-m', 'unrelated commit on another branch');

  // Attempt to create aha/run/<runId> while main repo is checked out on unrelated-branch MUST be rejected!
  const wBranch = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-branch',
    task: 'Add wb.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wBranch.worktreePath, 'wb.md'), '# WB\n', 'utf8');
  await service.workerDoneByPane(wBranch.ptyId, { outcome: 'completed', summary: 'wb done' });
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-branch', mode: 'squash', targetBranch: 'integration' }, 'local-coord'),
    /bound to base branch "main"/i,
  );
  // Switch back to main -> unrelated.txt is NOT on main.
  await git(repo, 'checkout', 'main');
  assert.equal(existsSync(join(repo, 'unrelated.txt')), false);

  // P2 #4: Worker in a second dirty Git repo B with targetBranch='auto' MUST NOT hijack Run's integrationRepoRootPath!
  const repoB = join(root, 'repo-b');
  await git(root, 'init', '-b', 'main', 'repo-b');
  await git(repoB, 'config', 'user.name', 'Test User');
  await git(repoB, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repoB, 'b.txt'), 'base b\n', 'utf8');
  await git(repoB, 'add', '.');
  await git(repoB, 'commit', '-m', 'init repo B');
  writeFileSync(join(repoB, 'dirty-b.txt'), 'dirty in repo B\n', 'utf8');

  const wRepoB = await service.workerStart({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    displayName: 'w-repob',
    spec: 'Add b-note.md in repo B',
    cwd: repoB,
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wRepoB.worktreePath, 'b-note.md'), '# Repo B\n', 'utf8');
  await service.workerDoneByPane(wRepoB.ptyId, { outcome: 'completed', summary: 'b done' });
  await assert.rejects(
    () => service.workerIntegrate({ dispatchId: wRepoB.dispatch.id, mode: 'squash', targetBranch: 'auto' }, 'local-coord'),
    /bound to a different Git repository/i,
  );
  // Run's integrationRepoRootPath still points to repo A and runDiff still works cleanly!
  const diffStillValid = await service.runDiff({ runId: run.id }, 'local-coord');
  assert.equal(diffStillValid.hasIntegratedChanges, true);
  assert.ok(diffStillValid.changedFiles.includes('w1.md'));

  // P1 #3: After finalizing an aha/run/* wave, integrating another worker directly into main MUST update runDiff & reviewRun!
  writeFileSync(join(repo, 'user-wip.txt'), 'wip\n', 'utf8');
  const wWave1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-wave1',
    task: 'Add wave1.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wWave1.worktreePath, 'wave1.md'), '# Wave 1\n', 'utf8');
  await service.workerDoneByPane(wWave1.ptyId, { outcome: 'completed', summary: 'wave1 done' });
  const intWave1 = await service.workerIntegrate({ worker: '@w-wave1', mode: 'squash', targetBranch: 'auto' }, 'local-coord');
  assert.equal(intWave1.usedRunIntegrationBranch, true);
  rmSync(join(repo, 'user-wip.txt'));
  const finWave1 = await service.runFinalizeIntegration({ runId: run.id, mode: 'squash' }, 'local-coord');
  assert.equal(finWave1.integrated, true);

  const wAfterFin = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-after-fin',
    task: 'Add after-fin.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wAfterFin.worktreePath, 'after-fin.md'), '# After Finalize\n', 'utf8');
  await service.workerDoneByPane(wAfterFin.ptyId, { outcome: 'completed', summary: 'after-fin done' });
  const intAfterFin = await service.workerIntegrate({ worker: '@w-after-fin', mode: 'squash' }, 'local-coord');
  assert.equal(intAfterFin.integrated, true);
  assert.equal(intAfterFin.usedRunIntegrationBranch, false);

  const diffAfterFin = await service.runDiff({ runId: run.id }, 'local-coord');
  assert.equal(diffAfterFin.targetCommit, intAfterFin.integratedCommit);
  assert.ok(diffAfterFin.changedFiles.includes('after-fin.md'), 'runDiff must include post-finalize direct commit');

  const postFinRev = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewRun: true,
    reviewFocus: 'verify post-finalize commit included',
  });
  assert.equal(postFinRev.status, 'started');
  assert.equal(existsSync(join(postFinRev.worktreePath, 'after-fin.md')), true, 'Run review worktree must contain post-finalize file');
  await service.workerDoneByPane(postFinRev.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'ok' });
});

test('Phase 2 review fix (P1 #2): runFinalizeIntegration cannot race ahead while reviewRun terminal is still spawning', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'aha-p2-race-'));
  const repo = join(root, 'repo');
  await git(root, 'init', '-b', 'main', 'repo');
  await git(repo, 'config', 'user.name', 'Test User');
  await git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'base.ts'), 'export const base = 1;\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'base');
  const baseHead = await git(repo, 'rev-parse', 'HEAD');

  const store = new OrchestrationStore({ resolveFile: () => join(root, 'state.json') });
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  let spawnCount = 0;
  let releaseReviewSpawn;
  let reviewSpawnStarted;
  const reviewSpawnStartedPromise = new Promise((res) => {
    reviewSpawnStarted = res;
  });
  const reviewSpawnGate = new Promise((res) => {
    releaseReviewSpawn = res;
  });

  const service = new OrchestrationService({
    store,
    agentStatusStore,
    listCodingAgents: () => makeRoster(),
    selectAgentForTask: (selOpts) => selectAgentForTask(selOpts),
    writePty: () => ({ ok: true }),
    spawnWorkerPty: async ({ cliId, cwd, task }) => {
      spawnCount += 1;
      const ptyId = `local-race-w-${spawnCount}`;
      if (task?.displayName === 'review-run') {
        reviewSpawnStarted();
        await reviewSpawnGate;
      }
      agentStatusStore.registerPane(ptyId, { agentId: cliId || 'claude' });
      return { ptyId, cwd };
    },
    closeWorkerPty: async () => ({ ok: true }),
    isPtyAlive: () => true,
    isMcpEnabledForCli: () => true,
    getConfirmMode: () => 'auto',
    getDefaultWorktree: () => true,
    getDefaultCwd: () => repo,
  });
  t.after(() => {
    service.dispose();
    store.flushSync();
    rmSync(root, { recursive: true, force: true });
  });

  const run = service.runCreate({ objective: 'Race guard', from: 'local-coord', paneId: 'local-coord' }).run;
  const w = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-race',
    task: 'Add race.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(w.worktreePath, 'race.md'), '# Race\n', 'utf8');
  await service.workerDoneByPane(w.ptyId, { outcome: 'completed', summary: 'done' });
  const intRes = await service.workerIntegrate(
    { worker: '@w-race', mode: 'squash', targetBranch: 'integration' },
    'local-coord',
  );
  assert.equal(intRes.usedRunIntegrationBranch, true);

  // Start Run-level review (pauses inside spawnWorkerPty before runReviewStatus='pending' is written),
  // then immediately call runFinalizeIntegration concurrently!
  const reviewPromise = service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewRun: true,
  });
  await reviewSpawnStartedPromise;

  const finalizePromise = assert.rejects(
    () => service.runFinalizeIntegration({ runId: run.id, mode: 'squash' }, 'local-coord'),
    /still has \d+ active dispatch|still pending/i,
  );
  releaseReviewSpawn();

  const [revRes] = await Promise.all([reviewPromise, finalizePromise]);
  assert.equal(revRes.status, 'started');
  assert.equal(store.requireRun(run.id).runReviewStatus, 'pending');
  assert.equal(await git(repo, 'rev-parse', 'HEAD'), baseHead, 'main must NOT have been merged while review was starting');
});

test('Phase 2 re-review fixes: foreign-branch baseCommit guard, retained keepWorktree reuse guard, clean repo-B auto guard, and check-vs-write branch parity', async (t) => {
  const { root, repo, store, service, run } = await createRepoHarness(t, { confirmMode: 'auto' });

  // Bind Run to repo A on branch `main`.
  const w1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w1-bind',
    task: 'Add w1-bind.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(w1.worktreePath, 'w1-bind.md'), '# W1\n', 'utf8');
  await service.workerDoneByPane(w1.ptyId, { outcome: 'completed', summary: 'w1 done' });
  const int1 = await service.workerIntegrate({ worker: '@w1-bind', mode: 'squash' }, 'local-coord');
  assert.equal(int1.integrated, true);

  // Switch main repo to `unrelated-branch` with an unrelated commit.
  await git(repo, 'checkout', '-b', 'unrelated-branch');
  writeFileSync(join(repo, 'unrelated.txt'), 'DO NOT MERGE INTO MAIN\n', 'utf8');
  await git(repo, 'add', 'unrelated.txt');
  await git(repo, 'commit', '-m', 'unrelated commit on feature branch');

  // Spawn worker while on unrelated-branch; worker adds its own task file and passes single-worker review.
  const wForeign = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-foreign',
    task: 'Add task-only.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wForeign.worktreePath, 'task-only.md'), '# Task\n', 'utf8');
  await service.workerDoneByPane(wForeign.ptyId, { outcome: 'completed', summary: 'task done' });
  const revForeign = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewOf: '@w-foreign',
  });
  await service.workerDoneByPane(revForeign.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'looks ok' });

  // P2 #4: mode='check' on wrong branch MUST reject identically to mode='squash' (never return clean=true).
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-foreign', mode: 'check', targetBranch: 'integration' }, 'local-coord'),
    /bound to base branch "main"/i,
  );
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-foreign', mode: 'squash', targetBranch: 'integration' }, 'local-coord'),
    /bound to base branch "main"/i,
  );

  // P1 #1: Switching back to `main` and retrying MUST STILL reject because w-foreign's baseCommit
  // contains unrelated.txt outside the worker's reviewed diff (baseCommit..snapshot).
  await git(repo, 'checkout', 'main');
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-foreign', mode: 'check' }, 'local-coord'),
    /contains changes not present in/i,
  );
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-foreign', mode: 'squash' }, 'local-coord'),
    /contains changes not present in/i,
  );
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-foreign', mode: 'check', targetBranch: 'integration' }, 'local-coord'),
    /contains changes not present in/i,
  );
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-foreign', mode: 'squash', targetBranch: 'integration' }, 'local-coord'),
    /contains changes not present in/i,
  );
  assert.equal(existsSync(join(repo, 'unrelated.txt')), false, 'unrelated.txt MUST NOT be merged into main');
  assert.equal(existsSync(join(repo, 'task-only.md')), false);
  assert.equal(await git(repo, 'branch', '--list', 'aha/run/*'), '', 'failed integration branch creation must roll back cleanly');

  // P2 #3: Clean second Git repo B MUST also be rejected under targetBranch='auto' (and check/main).
  const repoB = join(root, 'repo-b-clean');
  await git(root, 'init', '-b', 'main', 'repo-b-clean');
  await git(repoB, 'config', 'user.name', 'Test User');
  await git(repoB, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repoB, 'b.txt'), 'base b\n', 'utf8');
  await git(repoB, 'add', '.');
  await git(repoB, 'commit', '-m', 'init clean repo B');
  const repoBHeadBefore = await git(repoB, 'rev-parse', 'HEAD');

  const wRepoB = await service.workerStart({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    displayName: 'w-repob-clean',
    spec: 'Add clean-b.md in repo B',
    cwd: repoB,
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wRepoB.worktreePath, 'clean-b.md'), '# Clean Repo B\n', 'utf8');
  await service.workerDoneByPane(wRepoB.ptyId, { outcome: 'completed', summary: 'clean b done' });
  await assert.rejects(
    () => service.workerIntegrate({ dispatchId: wRepoB.dispatch.id, mode: 'check', targetBranch: 'auto' }, 'local-coord'),
    /bound to a different Git repository/i,
  );
  await assert.rejects(
    () => service.workerIntegrate({ dispatchId: wRepoB.dispatch.id, mode: 'squash', targetBranch: 'auto' }, 'local-coord'),
    /bound to a different Git repository/i,
  );
  assert.equal(await git(repoB, 'rev-parse', 'HEAD'), repoBHeadBefore, 'clean repo B HEAD must remain untouched');
  assert.equal(existsSync(join(repoB, 'clean-b.md')), false);

  // P1 #2: Finalize Wave 1 with keepWorktree=true, add an experimental commit to the retained worktree,
  // directly integrate another worker into main (resetting integrationStatus='none'), then attempt Wave 2 -> MUST REJECT!
  const wWave1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-keep-1',
    task: 'Add keep1.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wWave1.worktreePath, 'keep1.md'), '# Keep 1\n', 'utf8');
  await service.workerDoneByPane(wWave1.ptyId, { outcome: 'completed', summary: 'keep1 done' });
  const intKeep1 = await service.workerIntegrate(
    { worker: '@w-keep-1', mode: 'squash', targetBranch: 'integration' },
    'local-coord',
  );
  assert.equal(intKeep1.usedRunIntegrationBranch, true);
  const finKeep1 = await service.runFinalizeIntegration(
    { runId: run.id, mode: 'squash', keepWorktree: true },
    'local-coord',
  );
  assert.equal(finKeep1.integrated, true);
  assert.equal(finKeep1.removedWorktree, false);
  assert.equal(finKeep1.removedBranch, false);

  // Add a local experimental commit directly inside the retained _run-* worktree.
  writeFileSync(join(finKeep1.integrationWorktreePath, 'local-exp.txt'), 'EXPERIMENTAL DO NOT SHIP\n', 'utf8');
  await git(finKeep1.integrationWorktreePath, 'add', 'local-exp.txt');
  await git(finKeep1.integrationWorktreePath, 'commit', '-m', 'local experimental commit');

  // Directly integrate another worker into main (triggers reopeningAfterFinalized -> integrationStatus='none').
  const wDirect = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-direct-between',
    task: 'Add direct-between.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wDirect.worktreePath, 'direct-between.md'), '# Direct\n', 'utf8');
  await service.workerDoneByPane(wDirect.ptyId, { outcome: 'completed', summary: 'direct done' });
  const intDirect = await service.workerIntegrate({ worker: '@w-direct-between', mode: 'squash' }, 'local-coord');
  assert.equal(intDirect.integrated, true);
  assert.equal(store.requireRun(run.id).integrationStatus, 'none');

  // Now attempt to open Wave 2 on targetBranch='integration' (and 'auto' with dirty main): MUST REJECT in both check & squash!
  const wWave2 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-wave2-after-keep',
    task: 'Add wave2.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wWave2.worktreePath, 'wave2.md'), '# Wave 2\n', 'utf8');
  await service.workerDoneByPane(wWave2.ptyId, { outcome: 'completed', summary: 'wave2 done' });

  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-wave2-after-keep', mode: 'check', targetBranch: 'integration' }, 'local-coord'),
    /retained a previous integration branch or worktree|already exists on disk/i,
  );
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-wave2-after-keep', mode: 'squash', targetBranch: 'integration' }, 'local-coord'),
    /retained a previous integration branch or worktree|already exists on disk/i,
  );
  writeFileSync(join(repo, 'dirty-wave2.txt'), 'dirty\n', 'utf8');
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-wave2-after-keep', mode: 'squash', targetBranch: 'auto' }, 'local-coord'),
    /retained a previous integration branch or worktree|already exists on disk/i,
  );
  rmSync(join(repo, 'dirty-wave2.txt'));
  assert.equal(existsSync(join(repo, 'local-exp.txt')), false, 'local experimental commit from retained worktree MUST NEVER reach main');
});

test('Phase 2 round-3 review fixes: evil-merge revert visibility & block, mode="merge" add+revert history block, and rebase-then-re-review recovery', async (t) => {
  const { repo, store, service, run } = await createRepoHarness(t, { confirmMode: 'auto' });

  // P1 #1: Evil merge reverting a newer main fix MUST be exposed by workerDiff/reviewOf AND blocked at integration even if reviewed against stale C0.
  const wEvil = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-evil-merge',
    task: 'Add evil-task.md',
    agent: 'codex',
    worktree: true,
  });
  // Main lands a security fix on base.ts.
  writeFileSync(join(repo, 'base.ts'), 'export const base = 999; // hotfix\n', 'utf8');
  await git(repo, 'add', 'base.ts');
  await git(repo, 'commit', '-m', 'fix: hotfix on main');

  // Worker adds task file, merges main, and silently restores old base.ts.
  writeFileSync(join(wEvil.worktreePath, 'evil-task.md'), '# Evil task\n', 'utf8');
  await git(wEvil.worktreePath, 'add', 'evil-task.md');
  await git(wEvil.worktreePath, 'commit', '-m', 'docs: add evil-task.md');
  await git(wEvil.worktreePath, 'merge', '--no-commit', '--no-ff', 'main');
  writeFileSync(join(wEvil.worktreePath, 'base.ts'), 'export const base = 1;\n', 'utf8');
  await git(wEvil.worktreePath, 'add', 'base.ts');
  await git(wEvil.worktreePath, 'commit', '-m', 'merge main keeping old base.ts');
  await service.workerDoneByPane(wEvil.ptyId, { outcome: 'completed', summary: 'done' });

  // workerDiff MUST compute live merge-base (hotfix main) and expose the revert of base.ts!
  const evilDiff = await service.workerDiff({ worker: '@w-evil-merge' }, 'local-coord');
  assert.ok(evilDiff.changedFiles.includes('base.ts'), 'workerDiff must expose reverted base.ts instead of hiding it behind stale baseCommit');
  assert.ok(evilDiff.changedFiles.includes('evil-task.md'));

  // Simulate a stale review recorded against the worker's original baseCommit (C0): integration MUST STILL reject!
  store.updateDispatchReviewState(wEvil.dispatch.id, {
    reviewStatus: 'passed',
    reviewRound: 1,
    reviewBatchId: 'rbat_stale_base',
    reviewSnapshotOid: evilDiff.snapshotOid,
    reviewBaseCommit: wEvil.dispatch.baseCommit,
  });
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-evil-merge', mode: 'squash' }, 'local-coord'),
    /outside the reviewed diff/i,
  );
  assert.equal(readFileSync(join(repo, 'base.ts'), 'utf8'), 'export const base = 999; // hotfix\n');

  // P2 #2: Branch with add+delete temp commits has identical tree to main, yet mode='merge' MUST reject even after re-review on main.
  await git(repo, 'checkout', '-b', 'churn-branch');
  writeFileSync(join(repo, 'ephemeral.txt'), 'temp\n', 'utf8');
  await git(repo, 'add', 'ephemeral.txt');
  await git(repo, 'commit', '-m', 'add ephemeral');
  const churnF1 = await git(repo, 'rev-parse', 'HEAD');
  rmSync(join(repo, 'ephemeral.txt'));
  await git(repo, 'add', '-A');
  await git(repo, 'commit', '-m', 'delete ephemeral');
  const churnF2 = await git(repo, 'rev-parse', 'HEAD');

  const wChurn = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-churn',
    task: 'Add churn-task.md',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wChurn.worktreePath, 'churn-task.md'), '# Churn\n', 'utf8');
  await git(wChurn.worktreePath, 'add', 'churn-task.md');
  await git(wChurn.worktreePath, 'commit', '-m', 'docs: add churn-task.md');
  await service.workerDoneByPane(wChurn.ptyId, { outcome: 'completed', summary: 'done' });

  await git(repo, 'checkout', 'main');
  const revChurn = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewOf: '@w-churn',
  });
  await service.workerDoneByPane(revChurn.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'ok' });
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-churn', mode: 'merge' }, 'local-coord'),
    /Cannot use mode="merge".*not an ancestor/i,
  );
  const mainLogAfterChurn = await git(repo, 'rev-list', 'main');
  assert.equal(mainLogAfterChurn.includes(churnF1), false);
  assert.equal(mainLogAfterChurn.includes(churnF2), false);

  // P2 #3: Following the rebase instruction (rebase task commit onto main + re-review) MUST succeed cleanly!
  await git(repo, 'checkout', '-b', 'foreign-rebase-src');
  writeFileSync(join(repo, 'foreign-only.txt'), 'DO NOT MERGE\n', 'utf8');
  await git(repo, 'add', 'foreign-only.txt');
  await git(repo, 'commit', '-m', 'foreign commit');
  const foreignSha = await git(repo, 'rev-parse', 'HEAD');

  const wRebase = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'w-rebase',
    task: 'Add rebased-feature.ts',
    agent: 'codex',
    worktree: true,
  });
  writeFileSync(join(wRebase.worktreePath, 'rebased-feature.ts'), 'export const rebased = true;\n', 'utf8');
  await git(wRebase.worktreePath, 'add', 'rebased-feature.ts');
  await git(wRebase.worktreePath, 'commit', '-m', 'feat: add rebased-feature.ts');
  await service.workerDoneByPane(wRebase.ptyId, { outcome: 'completed', summary: 'done' });

  // Pass initial review while still on foreign branch, then switch back to main -> rejected with rebase hint.
  const revBeforeRebase = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewOf: '@w-rebase',
  });
  await service.workerDoneByPane(revBeforeRebase.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'ok' });
  await git(repo, 'checkout', 'main');
  await assert.rejects(
    () => service.workerIntegrate({ worker: '@w-rebase', mode: 'squash' }, 'local-coord'),
    /contains changes not present in "main".*rebase/i,
  );

  // Rebase the worker's task commit cleanly onto main, verify workerDiff only shows rebased-feature.ts, re-review, and integrate!
  await git(wRebase.worktreePath, 'rebase', '--onto', 'main', 'foreign-rebase-src');
  const diffAfterRebase = await service.workerDiff({ worker: '@w-rebase' }, 'local-coord');
  assert.deepEqual(diffAfterRebase.changedFiles, ['rebased-feature.ts']);

  const revAfterRebase = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    reviewOf: '@w-rebase',
  });
  await service.workerDoneByPane(revAfterRebase.ptyId, { outcome: 'completed', verdict: 'pass', summary: 'clean after rebase' });

  const checkAfterRebase = await service.workerIntegrate({ worker: '@w-rebase', mode: 'check' }, 'local-coord');
  assert.equal(checkAfterRebase.clean, true);

  const mergedAfterRebase = await service.workerIntegrate({ worker: '@w-rebase', mode: 'merge' }, 'local-coord');
  assert.equal(mergedAfterRebase.integrated, true);
  assert.equal(readFileSync(join(repo, 'rebased-feature.ts'), 'utf8'), 'export const rebased = true;\n');
  assert.equal(existsSync(join(repo, 'foreign-only.txt')), false, 'foreign-only.txt must NOT enter main');
  const mainLogFinal = await git(repo, 'rev-list', 'main');
  assert.equal(mainLogFinal.includes(foreignSha), false, 'foreign branch commit must NOT enter main history');
});

test('Natural workflow UX: confirm-once Run review pre-authorization, Coordinator-driven tier/next-step guidance, and default targetBranch="auto"', async (t) => {
  const { repo, store, service, run } = await createRepoHarness(t, { confirmMode: 'chat-and-guard' });

  // 1. Coordinator cannot sneak authorizeReviews=true on confirmed=true if it was absent in the proposed plan!
  const sneakProposal = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'backend',
    task: 'Implement helper.ts',
    agent: 'codex',
    worktree: true,
    confirmed: false,
  });
  assert.equal(sneakProposal.status, 'confirmation_required');
  service.recordUserPromptTurn('local-coord', 'hook');
  const sneakAttempt = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'backend',
    task: 'Implement helper.ts',
    agent: 'codex',
    worktree: true,
    authorizeReviews: true,
    confirmed: true,
    proposalId: sneakProposal.proposal.id,
  });
  assert.equal(sneakAttempt.status, 'confirmation_required', 'sneaking authorizeReviews on confirm MUST fail samePlan');
  assert.equal(store.requireRun(run.id).reviewAutoAuthorized ?? false, false);

  // 2. Legitimate confirm-once flow: propose with authorizeReviews=true -> user replies -> confirm starts worker & authorizes Run reviews.
  const prop1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'backend',
    task: 'Implement helper.ts',
    agent: 'codex',
    worktree: true,
    authorizeReviews: true,
    confirmed: false,
  });
  assert.equal(prop1.status, 'confirmation_required');
  assert.equal(prop1.proposal.authorizeReviews, true);
  service.recordUserPromptTurn('local-coord', 'hook');
  const impl = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'backend',
    task: 'Implement helper.ts',
    agent: 'codex',
    worktree: true,
    authorizeReviews: true,
    confirmed: true,
    proposalId: prop1.proposal.id,
  });
  assert.equal(impl.status, 'started');
  assert.equal(store.requireRun(run.id).reviewAutoAuthorized, true);

  // 3. Implementation worker finishes (L1: 2 code files) -> worker_done artifacts automatically carry reviewTier + recommendedNextStep!
  writeFileSync(join(impl.worktreePath, 'helper.ts'), 'export const answer = 42;\n', 'utf8');
  writeFileSync(join(impl.worktreePath, 'service.ts'), 'export function runHelper() { return 42; }\n', 'utf8');
  const doneRes = await service.workerDoneByPane(impl.ptyId, { outcome: 'completed', summary: 'implemented helper' });
  assert.equal(doneRes.message.artifacts?.reviewTier, 'L1');
  assert.ok(doneRes.message.artifacts?.snapshotOid && doneRes.message.artifacts.snapshotOid.length === 40);
  assert.match(doneRes.message.artifacts?.recommendedNextStep ?? '', /delegate_task\(reviewOf="@backend"\)/);
  assert.match(doneRes.message.artifacts?.recommendedNextStep ?? '', /pre-authorized/i);

  // 4. Subsequent reviewOf starts WITHOUT another chat-and-guard prompt!
  const rev1 = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewOf: '@backend',
  });
  assert.equal(rev1.status, 'started', 'pre-authorized Run reviewOf must start without re-prompting user');

  // 5. Yet a NEW implementation worker in the same Run STILL requires chat-and-guard confirmation!
  const newImplBlocked = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    role: 'extra',
    task: 'Do unrelated work',
    agent: 'codex',
    worktree: true,
  });
  assert.equal(newImplBlocked.status, 'confirmation_required', 'reviewAutoAuthorized must NEVER bypass confirmation for implementation workers');

  // 6. Reviewer PASS automatically attaches integrate_worker next step; default workerIntegrate auto-routes dirty main to aha/run/<runId>!
  const revDone = await service.workerDoneByPane(rev1.ptyId, {
    outcome: 'completed',
    verdict: 'pass',
    summary: 'Looks solid.',
  });
  assert.match(revDone.message.artifacts?.recommendedNextStep ?? '', /integrate_worker\(role="@backend"\)/);

  writeFileSync(join(repo, 'user-draft.txt'), 'local wip\n', 'utf8');
  const intRes = await service.workerIntegrate({ worker: '@backend', mode: 'squash' }, 'local-coord');
  assert.equal(intRes.integrated, true);
  assert.equal(intRes.usedRunIntegrationBranch, true, 'omitted targetBranch defaults to auto and routes dirty main to aha/run/<runId>');
  assert.match(intRes.recommendedNextStep ?? '', /finalize_run_integration/);

  // 7. Subsequent reviewRun also starts WITHOUT re-prompting while reviewAutoAuthorized=true!
  const runRev = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewRun: true,
  });
  assert.equal(runRev.status, 'started');
  const runRevDone = await service.workerDoneByPane(runRev.ptyId, {
    outcome: 'completed',
    verdict: 'pass',
    summary: 'Combined changes clean.',
  });
  assert.match(runRevDone.message.artifacts?.recommendedNextStep ?? '', /finalize_run_integration/);

  // 8. Disabling Run auto-review via setRunAutoReview immediately restores chat-and-guard confirmation on reviews!
  const toggled = service.setRunAutoReview({ runId: run.id, enabled: false });
  assert.equal(toggled.run.reviewAutoAuthorized, false);
  const blockedAgain = await service.delegateTask({
    from: 'local-coord',
    callerPaneId: 'local-coord',
    runId: run.id,
    reviewRun: true,
  });
  assert.equal(blockedAgain.status, 'confirmation_required');
  rmSync(join(repo, 'user-draft.txt'));
});
