import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'aha-orch-board-ui-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function emit(name, rewrite = (s) => s) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, rewrite(output), 'utf8');
  return pathToFileURL(file).href;
}

emit('git-panel-model');
const viewUrl = emit('orchestration-view');
emit('orchestration-crew-model', (s) =>
  s
    .replace("'./git-panel-model'", "'./git-panel-model.mjs'")
    .replace("'./orchestration-view'", "'./orchestration-view.mjs'"),
);
const boardUrl = emit('orchestration-board-model', (s) =>
  s
    .replace("'./orchestration-crew-model'", "'./orchestration-crew-model.mjs'")
    .replace("'./orchestration-view'", "'./orchestration-view.mjs'"),
);

const view = await import(viewUrl);
const board = await import(boardUrl);

const isoAt = (sec) => new Date(Date.UTC(2026, 0, 1, 10, 0, sec)).toISOString();

function makeRun(id, extra = {}) {
  return {
    id,
    objective: `Objective ${id}`,
    status: 'active',
    coordinatorHandle: 'local-coord',
    coordinatorPaneId: 'local-coord',
    consumerGeneration: 1,
    createdAt: isoAt(0),
    updatedAt: isoAt(0),
    endedAt: null,
    ...extra,
  };
}

function makeTask(id, extra = {}) {
  return {
    id,
    runId: 'run_1',
    spec: `spec ${id}`,
    taskTitle: '',
    displayName: '',
    deps: [],
    priority: 'normal',
    status: 'dispatched',
    worktreePath: null,
    createdAt: isoAt(1),
    updatedAt: isoAt(1),
    latestDispatch: null,
    ...extra,
  };
}

function makeDispatch(id, taskId, extra = {}) {
  return {
    id,
    taskId,
    runId: 'run_1',
    creator: 'local-coord',
    creatorRunId: 'run_1',
    parentPaneId: 'local-coord',
    depth: 1,
    assigneeHandle: `local-orch-${id}`,
    assigneePaneId: `local-orch-${id}`,
    processIncarnation: null,
    cliId: 'codex',
    status: 'dispatched',
    startObservation: 'observed',
    failureCount: 0,
    lastFailureReason: null,
    failureSummary: null,
    lastHeartbeatAt: null,
    consumerGeneration: 1,
    createdAt: isoAt(2),
    updatedAt: isoAt(2),
    completedAt: null,
    ...extra,
  };
}

function makeMessage(id, extra = {}) {
  return {
    id,
    runId: 'run_1',
    seq: 1,
    type: 'status',
    priority: 'normal',
    fromHandle: 'local-coord',
    toHandle: '@all',
    subject: '',
    body: '',
    payload: null,
    threadId: null,
    deliveredAt: null,
    read: false,
    createdAt: isoAt(10),
    lifecycleRejectedReason: null,
    ...extra,
  };
}

test('parseInlineBoardTokens parses bold, inline code, @mentions, and #seq while skipping emails and hex colors', () => {
  const tokens = board.parseInlineBoardTokens(
    '@verifier **fixed** `npm test` for #13 (email a@b.com, color #ffffff, heading ## 1, zero #0).',
  );
  assert.deepEqual(
    tokens.filter((t) => t.kind !== 'text'),
    [
      { kind: 'mention', text: '@verifier', value: 'verifier' },
      { kind: 'bold', text: 'fixed', value: 'fixed' },
      { kind: 'code', text: 'npm test', value: 'npm test' },
      { kind: 'ref', text: '#13', value: 13 },
    ],
  );

  // Code spans protect @mentions and #refs inside backticks.
  const codeProtected = board.parseInlineBoardTokens('Run `@api #12 **raw**` then ping @api.');
  assert.deepEqual(
    codeProtected.filter((t) => t.kind !== 'text'),
    [
      { kind: 'code', text: '@api #12 **raw**', value: '@api #12 **raw**' },
      { kind: 'mention', text: '@api', value: 'api' },
    ],
  );

  // CJK delimiters around mentions and numeric refs.
  const cjk = board.parseInlineBoardTokens('请（@ui-trigger，参考#5）确认');
  assert.deepEqual(
    cjk.filter((t) => t.kind !== 'text'),
    [
      { kind: 'mention', text: '@ui-trigger', value: 'ui-trigger' },
      { kind: 'ref', text: '#5', value: 5 },
    ],
  );
});

test('buildBoardViewModel orders posts chronologically, builds coordinator + TEAM cards, latest #seq, and duration', () => {
  const snapshot = {
    ...view.EMPTY_SNAPSHOT,
    runs: [
      makeRun('run_old', { status: 'completed', createdAt: isoAt(0) }),
      makeRun('run_1', { objective: 'Shared Board Upgrade', status: 'active', createdAt: isoAt(10) }),
    ],
    tasks: [
      makeTask('t_api', { displayName: 'api', taskTitle: '@api: Implement board endpoints' }),
      makeTask('t_api_2', { displayName: 'api', taskTitle: '@api: Fix review feedback' }),
      makeTask('t_ver', { displayName: 'verifier', taskTitle: 'Run full test suite' }),
    ],
    dispatches: [
      makeDispatch('d_api_1', 't_api', {
        cliId: 'claude',
        status: 'completed',
        createdAt: isoAt(12),
      }),
      makeDispatch('d_api_2', 't_api_2', {
        followUpOfDispatchId: 'd_api_1',
        cliId: 'claude',
        model: 'claude-sonnet-4-6',
        branch: 'aha/api',
        status: 'dispatched',
        createdAt: isoAt(20),
      }),
      makeDispatch('d_ver', 't_ver', {
        cliId: 'codex',
        status: 'dispatched',
        createdAt: isoAt(15),
      }),
    ],
    messages: [
      makeMessage('m_hb', { seq: 99, type: 'heartbeat', body: 'ping', createdAt: isoAt(30) }),
      makeMessage('m_3', {
        seq: 3,
        boardSeq: 3,
        type: 'worker_done',
        kind: 'report',
        fromHandle: 'local-orch-d_api_2',
        fromRole: 'api',
        mentions: ['coordinator', 'verifier'],
        refs: [1],
        body: '@coordinator @verifier ready per #1',
        artifacts: { branch: 'aha/api', changedFiles: ['a.ts', 'b.ts'], changedFileCount: 2 },
        createdAt: isoAt(135),
      }),
      makeMessage('m_1', {
        seq: 1,
        boardSeq: 1,
        type: 'dispatch',
        kind: 'brief',
        fromHandle: 'local-coord',
        fromRole: 'coordinator',
        mentions: ['api'],
        body: '@api build endpoints',
        createdAt: isoAt(15),
      }),
      makeMessage('m_2', {
        seq: 2,
        boardSeq: 2,
        type: 'status',
        kind: 'post',
        fromHandle: 'local-orch-d_ver',
        fromRole: 'verifier',
        mentions: ['api'],
        body: '@api check edge case',
        createdAt: isoAt(75),
      }),
    ],
  };

  const vm = board.buildBoardViewModel(snapshot, { activePtyId: 'local-coord' });
  assert.equal(vm.run?.id, 'run_1');
  assert.equal(vm.isLive, true);
  assert.equal(vm.headSeq, 3);
  // Heartbeat filtered out; ascending boardSeq 1, 2, 3.
  assert.deepEqual(
    vm.posts.map((p) => p.boardSeq),
    [1, 2, 3],
  );
  assert.equal(vm.posts[2].artifacts?.changedFileCount, 2);

  // Coordinator card reflects latest coordinator post (#1).
  assert.ok(vm.coordinator);
  assert.equal(vm.coordinator.label, '@coordinator');
  assert.equal(vm.coordinator.latestPostSeq, 1);

  // Follow-up lineage d_api_1 -> d_api_2 collapsed into 2 TEAM members.
  assert.equal(vm.members.length, 2);
  const apiMember = vm.members.find((m) => m.role === 'api');
  assert.ok(apiMember);
  assert.equal(apiMember.dispatchId, 'd_api_2');
  assert.equal(apiMember.latestPostSeq, 3);
  assert.equal(apiMember.taskSummary, 'Fix review feedback');
  assert.equal(apiMember.branch, 'aha/api');

  const verMember = vm.members.find((m) => m.role === 'verifier');
  assert.ok(verMember);
  assert.equal(verMember.latestPostSeq, 2);

  // 135s - 15s = 120s = 2m
  assert.equal(vm.durationLabel, '3 posts over 2m');
});

test('buildBoardGraphModel computes weighted edges, timeline replay upToSeq, hideInactive, expandAll, and no-mention halo', () => {
  const coordinator = {
    role: 'coordinator',
    label: '@coordinator',
    ptyId: 'local-coord',
    cliId: 'claude',
    model: null,
    status: 'working',
    stageLabel: '执行中',
    tone: 'accent',
    subtitle: 'Coordinator · claude',
    latestPostSeq: 4,
    latestPostPreview: '@all freeze',
  };
  const members = [
    {
      key: 'd_api',
      role: 'api',
      label: '@api',
      dispatchId: 'd_api',
      taskId: 't_api',
      ptyId: 'local-api',
      cliId: 'codex',
      model: null,
      effort: null,
      stage: 'working',
      stageLabel: '执行中',
      tone: 'accent',
      branch: null,
      worktreePath: null,
      taskSummary: 'api work',
      latestPostSeq: 3,
      latestPostPreview: '',
      isSettled: false,
      retained: false,
      released: false,
      needsAttention: false,
    },
    {
      key: 'd_ver',
      role: 'verifier',
      label: '@verifier',
      dispatchId: 'd_ver',
      taskId: 't_ver',
      ptyId: 'local-ver',
      cliId: 'gemini',
      model: null,
      effort: null,
      stage: 'working',
      stageLabel: '执行中',
      tone: 'accent',
      branch: null,
      worktreePath: null,
      taskSummary: 'verify work',
      latestPostSeq: 2,
      latestPostPreview: '',
      isSettled: false,
      retained: false,
      released: false,
      needsAttention: false,
    },
    {
      key: 'd_idle',
      role: 'docs',
      label: '@docs',
      dispatchId: 'd_idle',
      taskId: 't_docs',
      ptyId: 'local-docs',
      cliId: 'qwen',
      model: null,
      effort: null,
      stage: 'starting',
      stageLabel: '启动中',
      tone: 'accent',
      branch: null,
      worktreePath: null,
      taskSummary: 'docs work',
      latestPostSeq: null,
      latestPostPreview: '',
      isSettled: false,
      retained: false,
      released: false,
      needsAttention: false,
    },
  ];

  const posts = [
    {
      id: 'p1',
      runId: 'run_1',
      seq: 1,
      boardSeq: 1,
      type: 'dispatch',
      kind: 'brief',
      fromHandle: 'local-coord',
      fromRole: 'coordinator',
      fromCliId: 'claude',
      fromPtyId: 'local-coord',
      mentions: ['api'],
      refs: [],
      subject: '',
      body: '@api start',
      artifacts: null,
      createdAt: isoAt(0),
      timeLabel: '10:00',
      threadId: null,
    },
    {
      id: 'p2',
      runId: 'run_1',
      seq: 2,
      boardSeq: 2,
      type: 'status',
      kind: 'handoff',
      fromHandle: 'local-api',
      fromRole: 'api',
      fromCliId: 'codex',
      fromPtyId: 'local-api',
      mentions: ['verifier'],
      refs: [],
      subject: '',
      body: '@verifier please verify',
      artifacts: null,
      createdAt: isoAt(20),
      timeLabel: '10:00',
      threadId: null,
    },
    {
      id: 'p3',
      runId: 'run_1',
      seq: 3,
      boardSeq: 3,
      type: 'status',
      kind: 'handoff',
      fromHandle: 'local-ver',
      fromRole: 'verifier',
      fromCliId: 'gemini',
      fromPtyId: 'local-ver',
      mentions: ['api'],
      refs: [2],
      subject: '',
      body: '@api one bug in #2',
      artifacts: null,
      createdAt: isoAt(40),
      timeLabel: '10:00',
      threadId: null,
    },
    {
      id: 'p4',
      runId: 'run_1',
      seq: 4,
      boardSeq: 4,
      type: 'status',
      kind: 'handoff',
      fromHandle: 'local-api',
      fromRole: 'api',
      fromCliId: 'codex',
      fromPtyId: 'local-api',
      mentions: ['verifier'],
      refs: [3],
      subject: '',
      body: '@verifier fixed #3',
      artifacts: null,
      createdAt: isoAt(60),
      timeLabel: '10:01',
      threadId: null,
    },
    {
      id: 'p5',
      runId: 'run_1',
      seq: 5,
      boardSeq: 5,
      type: 'status',
      kind: 'update',
      fromHandle: 'local-api',
      fromRole: 'api',
      fromCliId: 'codex',
      fromPtyId: 'local-api',
      mentions: [],
      refs: [],
      subject: '',
      body: 'Landed helper cleanup with no mention',
      artifacts: null,
      createdAt: isoAt(70),
      timeLabel: '10:01',
      threadId: null,
    },
    {
      id: 'p6',
      runId: 'run_1',
      seq: 6,
      boardSeq: 6,
      type: 'status',
      kind: 'post',
      fromHandle: 'local-coord',
      fromRole: 'coordinator',
      fromCliId: 'claude',
      fromPtyId: 'local-coord',
      mentions: ['all'],
      refs: [],
      subject: '',
      body: '@all freeze and report',
      artifacts: null,
      createdAt: isoAt(90),
      timeLabel: '10:01',
      threadId: null,
    },
  ];

  // Full graph without expandAll: api -> verifier has count 2 & hasReverse true; docs is inactive.
  const full = board.buildBoardGraphModel(posts, members, coordinator);
  assert.equal(full.visiblePostCount, 6);
  assert.equal(full.allPostCount, 1);
  const apiToVer = full.edges.find((e) => e.from === 'api' && e.to === 'verifier' && !e.viaAll);
  assert.ok(apiToVer);
  assert.equal(apiToVer.count, 2);
  assert.equal(apiToVer.hasReverse, true);
  assert.equal(full.edges.some((e) => e.viaAll), false);

  const apiNode = full.nodes.find((n) => n.id === 'api');
  assert.equal(apiNode?.postedWithNoMention, true);
  const docsNode = full.nodes.find((n) => n.id === 'docs');
  assert.equal(docsNode?.active, false);

  // hideInactive hides docs when expandAll is off.
  const activeOnly = board.buildBoardGraphModel(posts, members, coordinator, {
    hideInactive: true,
  });
  assert.equal(activeOnly.nodes.some((n) => n.id === 'docs'), false);

  // expandAll adds dashed viaAll edges from coordinator to every team member (including docs).
  const expanded = board.buildBoardGraphModel(posts, members, coordinator, {
    expandAll: true,
    hideInactive: true,
  });
  const viaAllEdges = expanded.edges.filter((e) => e.viaAll);
  assert.deepEqual(
    viaAllEdges.map((e) => `${e.from}->${e.to}`).sort(),
    ['coordinator->api', 'coordinator->docs', 'coordinator->verifier'],
  );
  assert.equal(expanded.nodes.some((n) => n.id === 'docs'), true);

  // Timeline replay upToSeq = 2 excludes posts #3..#6 (no reverse edge, no halo, no @all).
  const replay = board.buildBoardGraphModel(posts, members, coordinator, { upToSeq: 2 });
  assert.equal(replay.visiblePostCount, 2);
  assert.equal(replay.allPostCount, 0);
  const replayApiToVer = replay.edges.find((e) => e.from === 'api' && e.to === 'verifier');
  assert.equal(replayApiToVer?.count, 1);
  assert.equal(replayApiToVer?.hasReverse, false);
  assert.equal(replay.nodes.find((n) => n.id === 'api')?.postedWithNoMention, false);
});

test('EMPTY_SNAPSHOT and mergeRunSnapshot preserve memberCursorsByRun across runs', () => {
  assert.deepEqual(view.EMPTY_SNAPSHOT.memberCursorsByRun, {});
  const run1 = makeRun('run_1');
  const run2 = makeRun('run_2');
  const prev = {
    ...view.EMPTY_SNAPSHOT,
    runs: [run1, run2],
    memberCursorsByRun: {
      run_1: { api: { lastReadSeq: 4, lastPostSeq: 3, lastDeliveredSeq: 4 } },
      run_2: { ver: { lastReadSeq: 1, lastPostSeq: 1, lastDeliveredSeq: 1 } },
    },
  };
  const merged = view.mergeRunSnapshot(prev, 'run_2', {
    ...view.EMPTY_SNAPSHOT,
    runs: [run1, run2],
    memberCursorsByRun: {
      run_2: { ver: { lastReadSeq: 5, lastPostSeq: 4, lastDeliveredSeq: 5 } },
    },
  });
  assert.deepEqual(merged.memberCursorsByRun.run_1, prev.memberCursorsByRun.run_1);
  assert.equal(merged.memberCursorsByRun.run_2.ver.lastReadSeq, 5);
});

test('buildBoardViewModel prefers active runs over stale stopped runs and reflects live coordinator/worker activity', () => {
  const stoppedRun = makeRun('run_old', {
    status: 'stopped',
    coordinatorHandle: 'local-old-coord',
    coordinatorPaneId: 'local-old-coord',
    createdAt: isoAt(0),
  });
  const liveRun = makeRun('run_live', {
    status: 'active',
    coordinatorHandle: 'local-live-coord',
    coordinatorPaneId: 'local-live-coord',
    createdAt: isoAt(60),
  });
  const liveTask = makeTask('t_live', {
    runId: 'run_live',
    displayName: 'backend',
    taskTitle: 'Wire sync',
  });
  const liveDispatch = makeDispatch('d_live', 't_live', {
    runId: 'run_live',
    assigneeHandle: 'local-worker-1',
    assigneePaneId: 'local-worker-1',
    cliId: 'codex',
  });

  const statuses = new Map([
    [
      'local-live-coord',
      {
        ptyId: 'local-live-coord',
        agentId: 'claude',
        state: 'working',
        toolName: 'Read',
        toolInput: 'src/app.ts',
        updatedAt: Date.now(),
        unread: false,
      },
    ],
    [
      'local-worker-1',
      {
        ptyId: 'local-worker-1',
        agentId: 'codex',
        state: 'working',
        toolName: 'exec_command',
        toolInput: 'npm test',
        updatedAt: Date.now(),
        unread: false,
      },
    ],
  ]);

  const snapshot = {
    ...view.EMPTY_SNAPSHOT,
    runs: [stoppedRun, liveRun],
    tasks: [liveTask],
    dispatches: [liveDispatch],
    currentRunByConsumer: { 'local-old-coord': 'run_old', 'local-live-coord': 'run_live' },
  };

  // Even when focused on a pane bound to an old stopped run, active run takes precedence.
  const liveVm = board.buildBoardViewModel(snapshot, {
    activePtyId: 'local-old-coord',
    agentStatuses: statuses,
    livePaneIds: new Set(['local-live-coord', 'local-worker-1']),
  });
  assert.equal(liveVm.run?.id, 'run_live');
  assert.equal(liveVm.isLive, true);
  assert.equal(liveVm.runStatusLabel, 'Live');
  assert.equal(liveVm.coordinator?.status, 'working');
  assert.equal(liveVm.coordinator?.stageLabel, '执行中');
  assert.equal(liveVm.coordinator?.liveActivity, 'Read: src/app.ts');
  assert.equal(liveVm.members[0]?.liveActivity, 'exec_command: npm test');

  // Explicitly inspecting the historical stopped run must NOT show coordinator as online.
  const stoppedVm = board.buildBoardViewModel(snapshot, {
    runId: 'run_old',
    agentStatuses: statuses,
  });
  assert.equal(stoppedVm.isLive, false);
  assert.equal(stoppedVm.runStatusLabel, '历史 · 已停止');
  assert.equal(stoppedVm.coordinator?.status, 'stopped');
  assert.equal(stoppedVm.coordinator?.stageLabel, '已结束');
  assert.equal(stoppedVm.coordinator?.liveActivity, null);
});
