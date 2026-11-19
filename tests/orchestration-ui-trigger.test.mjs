import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'aha-orch-ui-trigger-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function emit(name, rewrite = (s) => s) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = join(dir, `${name}.mjs`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, rewrite(output), 'utf8');
  return pathToFileURL(file).href;
}

emit('git-panel-model');
const viewUrl = emit('orchestration-view');
const crewUrl = emit('orchestration-crew-model', (s) =>
  s
    .replace("'./git-panel-model'", "'./git-panel-model.mjs'")
    .replace("'./orchestration-view'", "'./orchestration-view.mjs'"),
);
const clientUrl = emit('orchestration-client', (s) =>
  s.replace("'./orchestration-view'", "'./orchestration-view.mjs'"),
);
const linksUrl = emit('terminal-links/orchestration-terminal-links', (s) =>
  s.replace("'../orchestration-crew-model'", "'../orchestration-crew-model.mjs'"),
);

const view = await import(viewUrl);
const crew = await import(crewUrl);
const links = await import(linksUrl);

const iso = (n) => new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString();

function makeSnapshot(extra = {}) {
  return { ...view.EMPTY_SNAPSHOT, ...extra };
}

function makeTask(id, extra = {}) {
  return {
    id,
    runId: 'run_1',
    spec: `spec for ${id}`,
    taskTitle: '',
    displayName: '',
    deps: [],
    priority: 'normal',
    status: 'dispatched',
    worktreePath: null,
    createdAt: iso(1),
    updatedAt: iso(1),
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
    createdAt: iso(2),
    updatedAt: iso(2),
    completedAt: null,
    ...extra,
  };
}

function makeProposal(id, extra = {}) {
  return {
    id,
    coordinatorPaneId: 'local-coord',
    runId: null,
    role: 'reviewer',
    task: '检查鉴权改动并补齐测试',
    planSummary: '拉起 @reviewer 检查鉴权 diff',
    requestedAgent: 'auto',
    resolvedAgent: 'codex',
    taskKind: 'review',
    worktree: true,
    model: null,
    effort: null,
    terminal: null,
    status: 'pending',
    createdAt: iso(3),
    resolvedAt: null,
    ...extra,
  };
}

test('buildCrewViewForPane visibility, orchestration mode, and idle pill states', () => {
  const empty = makeSnapshot();

  // Plain shell pane stays hidden when idle.
  const shellView = crew.buildCrewViewForPane(empty, 'local-shell');
  assert.equal(shellView.isVisible, false);
  assert.equal(shellView.isOrchestrationMode, false);
  assert.deepEqual(shellView.pendingProposals, []);

  // Agent pane always exposes the compact trigger pill.
  const agentView = crew.buildCrewViewForPane(empty, 'local-claude', undefined, {
    isAgentPane: true,
  });
  assert.equal(agentView.isVisible, true);
  assert.equal(agentView.isOrchestrationMode, false);
  assert.equal(agentView.pillLabel, '编排');
  assert.equal(agentView.pillTone, 'neutral');
  assert.equal(agentView.attentionCount, 0);

  // Turning on orchestration mode highlights the pill even without active workers.
  const modeSnap = makeSnapshot({ orchestrationModePanes: ['local-claude'] });
  const modeView = crew.buildCrewViewForPane(modeSnap, 'local-claude', undefined, {
    isAgentPane: true,
  });
  assert.equal(modeView.isVisible, true);
  assert.equal(modeView.isOrchestrationMode, true);
  assert.equal(modeView.pillLabel, '编排中');
  assert.equal(modeView.pillTone, 'accent');
});

test('buildCrewViewForPane surfaces pendingProposals in attentionCount and warn pill', () => {
  const proposal = makeProposal('prop_1', { coordinatorPaneId: 'local-coord' });
  const resolvedProposal = makeProposal('prop_done', {
    coordinatorPaneId: 'local-coord',
    status: 'approved',
  });
  const otherPaneProposal = makeProposal('prop_other', {
    coordinatorPaneId: 'local-someone-else',
  });

  const snap = makeSnapshot({
    pendingProposals: [proposal, resolvedProposal, otherPaneProposal],
  });

  const coordView = crew.buildCrewViewForPane(snap, 'local-coord');
  assert.equal(coordView.isVisible, true);
  assert.deepEqual(
    coordView.pendingProposals.map((p) => p.id),
    ['prop_1'],
  );
  assert.equal(coordView.attentionCount, 1);
  assert.equal(coordView.pillTone, 'warn');
  assert.equal(coordView.pillLabel, '待确认 (1)');

  // Combined with an active working worker: still warn tone and mentions both counts.
  const combinedSnap = makeSnapshot({
    tasks: [makeTask('t1', { displayName: 'tester', taskTitle: '补全鉴权单测' })],
    dispatches: [makeDispatch('ctx_1', 't1', { cliId: 'codex' })],
    pendingProposals: [proposal],
  });
  const combinedView = crew.buildCrewViewForPane(combinedSnap, 'local-coord');
  assert.equal(combinedView.workingCount, 1);
  assert.equal(combinedView.attentionCount, 1);
  assert.equal(combinedView.pillTone, 'warn');
  assert.equal(combinedView.pillLabel, '待确认 (1) · 1 执行中');
});

test('buildCrewViewForPane formats semantic @role labels, mentions, and clean subtitles', () => {
  const snap = makeSnapshot({
    runs: [
      {
        id: 'run_1',
        objective: 'Auth refactor',
        status: 'active',
        coordinatorHandle: 'local-coord',
        coordinatorPaneId: 'local-coord',
        consumerGeneration: 1,
        createdAt: iso(1),
        updatedAt: iso(1),
        endedAt: null,
      },
    ],
    tasks: [
      makeTask('task_role', {
        displayName: '@reviewer',
        taskTitle: '@reviewer: 检查鉴权 diff',
      }),
      makeTask('task_plain', {
        displayName: '',
        taskTitle: '修复重连逻辑',
      }),
    ],
    dispatches: [
      makeDispatch('ctx_role', 'task_role', { cliId: 'codex', createdAt: iso(4) }),
      makeDispatch('ctx_plain', 'task_plain', { cliId: 'claude', createdAt: iso(2) }),
    ],
  });

  const viewModel = crew.buildCrewViewForPane(snap, 'local-coord');
  assert.equal(viewModel.managing.length, 2);

  const roleMember = viewModel.managing.find((m) => m.dispatch?.id === 'ctx_role');
  assert.ok(roleMember);
  assert.equal(roleMember.roleName, 'reviewer');
  assert.equal(roleMember.label, '@reviewer');
  assert.equal(roleMember.mentionToken, '@reviewer');
  assert.equal(roleMember.subtitle, 'codex · 检查鉴权 diff');
  assert.equal(roleMember.subtitle.includes('#task_role'), false);

  const plainMember = viewModel.managing.find((m) => m.dispatch?.id === 'ctx_plain');
  assert.ok(plainMember);
  assert.equal(plainMember.roleName, null);
  assert.equal(plainMember.label, '修复重连逻辑');
  assert.equal(plainMember.mentionToken, '@dispatch:ctx_plain');
  assert.equal(plainMember.subtitle, '#task_plain · ctx_plai');

  // Worker's own pill also shows semantic @role.
  const workerSelfView = crew.buildCrewViewForPane(snap, 'local-orch-ctx_role');
  assert.equal(workerSelfView.pillLabel, '@reviewer');
});

test('parseQuickDispatchInput handles @cli, @alias:role, @auto, plain text, and empty inputs', () => {
  assert.deepEqual(crew.parseQuickDispatchInput('@codex 把鉴权单测补全'), {
    agent: 'codex',
    task: '把鉴权单测补全',
  });
  assert.deepEqual(crew.parseQuickDispatchInput('@agy:reviewer 检查 diff'), {
    agent: 'antigravity',
    role: 'reviewer',
    task: '检查 diff',
  });
  assert.deepEqual(crew.parseQuickDispatchInput('@claude-code:arch 设计状态机'), {
    agent: 'claude',
    role: 'arch',
    task: '设计状态机',
  });
  assert.deepEqual(crew.parseQuickDispatchInput('@gemini-cli 调研路由实现'), {
    agent: 'gemini',
    task: '调研路由实现',
  });
  assert.deepEqual(crew.parseQuickDispatchInput('@auto 查一下重连超时'), {
    agent: 'auto',
    task: '查一下重连超时',
  });
  assert.deepEqual(crew.parseQuickDispatchInput('  查一下重连超时  '), {
    agent: 'auto',
    task: '查一下重连超时',
  });
  assert.equal(crew.parseQuickDispatchInput(''), null);
  assert.equal(crew.parseQuickDispatchInput('   '), null);
  assert.equal(crew.parseQuickDispatchInput('@codex'), null);
  assert.equal(crew.parseQuickDispatchInput('@agy:reviewer   '), null);
});

test('workerTabTitle formats @role when displayName exists and falls back to taskTitle', () => {
  assert.equal(
    view.workerTabTitle(makeTask('t1', { displayName: 'reviewer', taskTitle: 'Check diff' })),
    'Worker · @reviewer',
  );
  assert.equal(
    view.workerTabTitle(makeTask('t1', { displayName: '@tester', taskTitle: 'Add tests' })),
    'Worker · @tester',
  );
  assert.equal(
    view.workerTabTitle(makeTask('t2', { displayName: '', taskTitle: '修复重连超时' })),
    'Worker · 修复重连超时',
  );
  assert.equal(
    view.workerTabTitle(makeTask('t3', { displayName: '  ', taskTitle: '', spec: 'Run e2e suite\nmore' })),
    'Worker · Run e2e suite',
  );
  assert.equal(view.workerTabTitle(undefined, 'task_9'), 'Worker · task_9');
});

test('default snapshots, newPendingProposals, and mergeRunSnapshot preserve trigger fields', async () => {
  assert.deepEqual(view.EMPTY_SNAPSHOT.pendingProposals, []);
  assert.deepEqual(view.EMPTY_SNAPSHOT.orchestrationModePanes, []);

  const { orchestrationClient } = await import(`${clientUrl}?trigger=${Date.now()}`);
  assert.deepEqual(orchestrationClient.getSnapshot().pendingProposals, []);
  assert.deepEqual(orchestrationClient.getSnapshot().orchestrationModePanes, []);

  const pNull = makeProposal('p_null', { runId: null, createdAt: iso(1) });
  const p1 = makeProposal('p1', { runId: 'run_1', createdAt: iso(2) });
  const p2 = makeProposal('p2', { runId: 'run_2', createdAt: iso(3) });
  const prev = makeSnapshot({
    runs: [
      { id: 'run_1', objective: 'A', status: 'active', createdAt: iso(1) },
      { id: 'run_2', objective: 'B', status: 'active', createdAt: iso(2) },
    ],
    pendingProposals: [pNull, p1],
    orchestrationModePanes: ['local-coord'],
  });
  const next = makeSnapshot({
    runs: prev.runs,
    pendingProposals: [pNull, p1, p2],
    orchestrationModePanes: ['local-coord'],
  });

  assert.deepEqual(view.newPendingProposals(null, next), []);
  assert.deepEqual(
    view.newPendingProposals(prev, next).map((p) => p.id),
    ['p2'],
  );

  const merged = view.mergeRunSnapshot(
    prev,
    'run_2',
    makeSnapshot({
      runs: prev.runs,
      pendingProposals: [p2],
      orchestrationModePanes: ['local-coord', 'local-b'],
    }),
  );
  assert.deepEqual(
    merged.pendingProposals.map((p) => p.id),
    ['p_null', 'p1', 'p2'],
  );
  assert.deepEqual(merged.orchestrationModePanes, ['local-coord', 'local-b']);
});

test('resolveOrchestrationLinkTarget resolves semantic @role tokens to active or latest worker dispatch', () => {
  const snap = makeSnapshot({
    tasks: [
      makeTask('task_rev', {
        displayName: 'reviewer',
        taskTitle: '检查鉴权 diff',
        worktreePath: '/tmp/wt-rev',
      }),
      makeTask('task_tests', {
        displayName: '@tests',
        taskTitle: '补全单测',
      }),
    ],
    dispatches: [
      makeDispatch('ctx_rev_old', 'task_rev', {
        assigneeHandle: 'local-orch-rev-1',
        assigneePaneId: 'local-orch-rev-1',
        cliId: 'codex',
        status: 'completed',
        worktreePath: '/tmp/wt-rev-old',
        createdAt: iso(1),
      }),
      makeDispatch('ctx_rev_active', 'task_rev', {
        assigneeHandle: 'local-orch-rev-2',
        assigneePaneId: 'local-orch-rev-2',
        cliId: 'codex',
        status: 'dispatched',
        worktreePath: '/tmp/wt-rev',
        createdAt: iso(2),
      }),
      makeDispatch('ctx_tests', 'task_tests', {
        assigneeHandle: 'local-orch-tests',
        assigneePaneId: 'local-orch-tests',
        cliId: 'claude',
        status: 'completed',
        worktreePath: '/tmp/wt-tests',
        createdAt: iso(3),
      }),
    ],
  });

  const tokens = links.extractOrchestrationTerminalLinks('请查看 @reviewer 和 @TESTS 的反馈，忽略 @unknown');
  assert.deepEqual(
    tokens.map((t) => ({ kind: t.kind, id: t.id, rawText: t.rawText })),
    [
      { kind: 'handle', id: 'reviewer', rawText: '@reviewer' },
      { kind: 'handle', id: 'TESTS', rawText: '@TESTS' },
      { kind: 'handle', id: 'unknown', rawText: '@unknown' },
    ],
  );

  const resolvedReviewer = links.resolveOrchestrationLinkTarget(tokens[0], snap, 'local-coord');
  assert.deepEqual(resolvedReviewer, {
    kind: 'dispatch',
    label: '@reviewer',
    ptyId: 'local-orch-rev-2',
    dispatchId: 'ctx_rev_active',
    taskId: 'task_rev',
    cwd: '/tmp/wt-rev',
    cliId: 'codex',
  });

  const resolvedTests = links.resolveOrchestrationLinkTarget(tokens[1], snap, 'local-coord');
  assert.deepEqual(resolvedTests, {
    kind: 'dispatch',
    label: '@tests',
    ptyId: 'local-orch-tests',
    dispatchId: 'ctx_tests',
    taskId: 'task_tests',
    cwd: '/tmp/wt-tests',
    cliId: 'claude',
  });

  assert.equal(links.resolveOrchestrationLinkTarget(tokens[2], snap, 'local-coord'), null);
});
