import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';

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
