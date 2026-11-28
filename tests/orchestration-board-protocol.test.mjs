import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  DEFAULT_ORCHESTRATION_SETTINGS,
  ORCHESTRATION_PEER_MESSAGING_MODES,
  normalizeOrchestrationSettings,
} from '../dist-electron/store.js';
import { buildOrchestrationSettingsUpdate } from '../dist-electron/ipc/settings.js';
import {
  DEFAULT_PEER_PING_PONG_LIMIT,
  PeerPingPongTracker,
  RunWakeBudget,
  collectWorkerReportArtifacts,
  formatBoardPostForAgent,
  formatBoardTeamSummary,
  parseBoardMentions,
  parseBoardRefs,
} from '../dist-electron/orchestration/board-protocol.js';
import { BoardStallWatchdog } from '../dist-electron/orchestration/stall-watchdog.js';

test('peerMessagingMode defaults, normalization, and strict IPC validation', () => {
  assert.deepEqual([...ORCHESTRATION_PEER_MESSAGING_MODES], ['controlled-p2p', 'hub-only']);
  assert.equal(DEFAULT_ORCHESTRATION_SETTINGS.peerMessagingMode, 'controlled-p2p');
  assert.equal(normalizeOrchestrationSettings().peerMessagingMode, 'controlled-p2p');
  assert.equal(
    normalizeOrchestrationSettings({ peerMessagingMode: 'hub-only' }).peerMessagingMode,
    'hub-only',
  );
  assert.equal(
    normalizeOrchestrationSettings({ peerMessagingMode: 'bogus' }).peerMessagingMode,
    'controlled-p2p',
  );

  const okHub = buildOrchestrationSettingsUpdate({ peerMessagingMode: 'hub-only' });
  assert.equal(okHub.ok, true);
  assert.equal(okHub.settings.peerMessagingMode, 'hub-only');

  const okP2p = buildOrchestrationSettingsUpdate({ peerMessagingMode: 'controlled-p2p' }, okHub.settings);
  assert.equal(okP2p.ok, true);
  assert.equal(okP2p.settings.peerMessagingMode, 'controlled-p2p');

  assert.equal(buildOrchestrationSettingsUpdate({ peerMessagingMode: 'broadcast' }).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ peerMessagingMode: 123 }).ok, false);
});

test('parseBoardMentions extracts unique lowercase handles and skips emails', () => {
  assert.deepEqual(
    parseBoardMentions(
      '@Coordinator please check (@verifier), 「@UI-Trigger」, @api. Contact foo@bar.com or test.user@example.org. CC @all and @VERIFIER and @user.',
    ),
    ['coordinator', 'verifier', 'ui-trigger', 'api', 'all', 'user'],
  );
  assert.deepEqual(parseBoardMentions('plain text with no mentions and a@b.co'), []);
  assert.deepEqual(parseBoardMentions('@api,@verifier'), ['api', 'verifier']);
});

test('parseBoardRefs extracts unique positive #seq references and ignores hex colors and headings', () => {
  assert.deepEqual(
    parseBoardRefs('Follow-up on #13, (#4), 「#13」 and 【#2】. Color #ff00aa, #123abc, #0, ## 1, #1000000.'),
    [13, 4, 2],
  );
  assert.deepEqual(parseBoardRefs('## 12 Heading\n#00ff00'), []);
});

test('PeerPingPongTracker escalates at limit (default 3) and resets on coordinator/user activity', () => {
  assert.equal(DEFAULT_PEER_PING_PONG_LIMIT, 3);
  const tracker = new PeerPingPongTracker();

  assert.deepEqual(tracker.recordPeerExchange('run-1', 'api', 'verifier'), { count: 1, exceeded: false });
  assert.deepEqual(tracker.recordPeerExchange('run-1', '@Verifier', '@API'), { count: 2, exceeded: false });
  assert.deepEqual(tracker.recordPeerExchange('run-1', 'api', 'verifier'), { count: 3, exceeded: true });

  // Separate pair in same run is tracked independently.
  assert.deepEqual(tracker.recordPeerExchange('run-1', 'api', 'docs'), { count: 1, exceeded: false });

  // Separate run is tracked independently.
  assert.deepEqual(tracker.recordPeerExchange('run-2', 'api', 'verifier'), { count: 1, exceeded: false });

  // Coordinator/user activity resets all pairs for that run only.
  tracker.recordCoordinatorOrUserActivity('run-1');
  assert.equal(tracker.getExchangeCount('run-1', 'api', 'verifier'), 0);
  assert.equal(tracker.getExchangeCount('run-1', 'api', 'docs'), 0);
  assert.equal(tracker.getExchangeCount('run-2', 'api', 'verifier'), 1);

  assert.deepEqual(tracker.recordPeerExchange('run-1', 'api', 'verifier'), { count: 1, exceeded: false });
  tracker.clearRun('run-2');
  assert.equal(tracker.getExchangeCount('run-2', 'api', 'verifier'), 0);
  tracker.clearAll();
  assert.equal(tracker.getExchangeCount('run-1', 'api', 'verifier'), 0);
});

test('RunWakeBudget caps each run at three, resets on progress, and ignores old input', () => {
  const budget = new RunWakeBudget();
  for (let i = 0; i < 3; i++) {
    assert.equal(budget.observeProgress('run-1', 'waiting', 6), true);
    budget.recordWake('run-1');
  }
  assert.equal(budget.observeProgress('run-1', 'waiting', 6), false);
  assert.equal(budget.observeProgress('run-1', 'waiting', 0), false, 'retention is not progress');
  assert.equal(budget.observeProgress('run-2', 'waiting', 0), true);
  assert.equal(budget.observeProgress('run-1', 'waiting', 7), true, 'new user or Worker input resets');
  for (let i = 0; i < 3; i++) budget.recordWake('run-1');
  assert.equal(budget.observeProgress('run-1', 'settled', 0), true, 'business state resets');
  for (let i = 0; i < 3; i++) budget.recordWake('run-1');
  assert.equal(budget.observeProgress('run-1', 'settled', 7), false, 'high-water mark survives state resets');
  budget.retainRuns(new Set(['run-2']));
  assert.equal(budget.observeProgress('run-1', 'settled', 7), true, 'inactive run is evicted');
});

test('BoardStallWatchdog does not claim a stalled head while its injected budget is exhausted', () => {
  const run = {
    runId: 'run-1', coordinatorIdle: true, coordinatorHasWaiter: false, hasActiveWorkers: false,
    hasSettledOrWaitingWorkers: true, hasPendingAttention: false, headSeq: 9,
    lastPostAtMs: 70_000, lastPostIsDone: false, hasWakeBudget: false,
  };
  const detected = [];
  const watchdog = new BoardStallWatchdog({
    now: () => 100_000, inspectRuns: () => [run], onStallDetected: (...args) => detected.push(args),
  });
  assert.deepEqual(watchdog.sweep(), []);
  run.hasWakeBudget = true;
  assert.deepEqual(watchdog.sweep(), [{ runId: 'run-1', headSeq: 9, idleMs: 30_000 }]);
  assert.deepEqual(detected, [['run-1', 9, 30_000]]);
});

test('collectWorkerReportArtifacts inspects a real temp git repo and never throws on missing paths', async (t) => {
  assert.equal(await collectWorkerReportArtifacts(null, null), null);
  assert.deepEqual(await collectWorkerReportArtifacts(null, 'feat/demo'), {
    branch: 'feat/demo',
    worktreePath: null,
    headCommit: null,
    changedFiles: [],
    changedFileCount: 0,
  });

  const missingPath = join(tmpdir(), `aha-nonexistent-${Date.now()}`);
  const missingResult = await collectWorkerReportArtifacts(missingPath, 'fallback-branch');
  assert.equal(missingResult.branch, 'fallback-branch');
  assert.equal(missingResult.worktreePath, missingPath);
  assert.equal(missingResult.headCommit, null);
  assert.deepEqual(missingResult.changedFiles, []);
  assert.equal(missingResult.changedFileCount, 0);

  const repoDir = mkdtempSync(join(tmpdir(), 'aha-board-artifacts-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));

  execFileSync('git', ['init', '-b', 'feat/board'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  writeFileSync(join(repoDir, 'README.md'), 'init\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

  // Create 22 untracked/modified files to verify cap at 20 with full count preserved.
  for (let i = 1; i <= 22; i += 1) {
    writeFileSync(join(repoDir, `file-${String(i).padStart(2, '0')}.txt`), `v${i}\n`, 'utf8');
  }

  const artifacts = await collectWorkerReportArtifacts(repoDir, null);
  assert.equal(artifacts.branch, 'feat/board');
  assert.equal(artifacts.worktreePath, repoDir);
  assert.ok(artifacts.headCommit && artifacts.headCommit.length >= 7 && artifacts.headCommit.length <= 10);
  assert.equal(artifacts.changedFileCount, 22);
  assert.equal(artifacts.changedFiles.length, 20);
});

test('formatBoardPostForAgent and formatBoardTeamSummary produce compact readable outputs', () => {
  const formatted = formatBoardPostForAgent({
    boardSeq: 12,
    seq: 99,
    fromRole: 'reviewer',
    fromHandle: 'dispatch:ctx_1',
    mentions: ['coordinator', 'api'],
    kind: 'report',
    body: 'Verified #10 and found zero regressions.',
    createdAt: '2026-11-19T12:00:00.000Z',
    artifacts: {
      branch: 'feat/board',
      headCommit: 'abc1234',
      changedFiles: ['a.ts', 'b.ts'],
      changedFileCount: 2,
    },
  });
  assert.ok(formatted.startsWith('[#12 · @reviewer -> @coordinator @api · report]\n'));
  assert.ok(formatted.includes('Verified #10 and found zero regressions.'));
  assert.ok(formatted.includes('Artifacts: branch=feat/board | commit=abc1234 | 2 changed file(s): a.ts, b.ts'));

  const summary = formatBoardTeamSummary({
    headSeq: 12,
    workers: [
      { role: 'tests', cliId: 'codex', stage: 'working', openApprovalCount: 0 },
      { role: 'reviewer', cliId: 'agy', stage: 'awaiting_review', openApprovalCount: 0 },
      { role: 'api', cliId: 'claude', stage: 'done', openApprovalCount: 0 },
    ],
    pendingProposalCount: 0,
  });
  assert.equal(
    summary,
    'Board head=#12 | working: @tests(codex) | waiting: @reviewer(agy) | done: 1 | approvals: 0',
  );
});

test('BoardStallWatchdog fires at most once per (runId, headSeq) and skips non-stalled runs', () => {
  let clock = 100_000;
  let runs = [];
  const fired = [];
  const watchdog = new BoardStallWatchdog({
    stallThresholdMs: 25_000,
    now: () => clock,
    inspectRuns: () => runs,
    onStallDetected: (runId, headSeq, idleMs) => fired.push({ runId, headSeq, idleMs }),
  });

  const baseRun = {
    runId: 'run-1',
    coordinatorPaneId: 'pty-coord',
    coordinatorIdle: true,
    coordinatorHasWaiter: false,
    hasActiveWorkers: false,
    hasSettledOrWaitingWorkers: true,
    hasPendingAttention: false,
    headSeq: 5,
    lastPostAtMs: 70_000, // 30s idle >= 25s
    lastPostIsDone: false,
  };

  // Skipped when active workers exist.
  runs = [{ ...baseRun, hasActiveWorkers: true }];
  assert.equal(watchdog.sweep().length, 0);

  // Skipped when coordinator has an active board_wait waiter.
  runs = [{ ...baseRun, coordinatorHasWaiter: true }];
  assert.equal(watchdog.sweep().length, 0);

  // Skipped when last post is [done].
  runs = [{ ...baseRun, lastPostIsDone: true }];
  assert.equal(watchdog.sweep().length, 0);

  // Skipped when pending attention exists (approval/question/proposal).
  runs = [{ ...baseRun, hasPendingAttention: true }];
  assert.equal(watchdog.sweep().length, 0);

  // Skipped below threshold.
  runs = [{ ...baseRun, lastPostAtMs: 80_000 }]; // 20s < 25s
  assert.equal(watchdog.sweep().length, 0);

  // Fires once for (run-1, headSeq=5).
  runs = [baseRun];
  assert.equal(watchdog.sweep().length, 1);
  assert.deepEqual(fired, [{ runId: 'run-1', headSeq: 5, idleMs: 30_000 }]);

  // Does not re-fire for same (run-1, headSeq=5).
  clock += 30_000;
  assert.equal(watchdog.sweep().length, 0);
  assert.equal(fired.length, 1);

  // Fires once again when headSeq advances and stalls again.
  runs = [{ ...baseRun, headSeq: 6, lastPostAtMs: clock - 26_000 }];
  assert.equal(watchdog.sweep().length, 1);
  assert.equal(fired.length, 2);
  assert.equal(fired[1].headSeq, 6);

  // Run removed -> tracking cleaned up; reappearing at headSeq=6 would fire cleanly if stalled.
  runs = [];
  watchdog.sweep();
  runs = [{ ...baseRun, headSeq: 6, lastPostAtMs: clock - 26_000 }];
  assert.equal(watchdog.sweep().length, 1);

  watchdog.dispose();
  assert.equal(watchdog.sweep().length, 0);
});
