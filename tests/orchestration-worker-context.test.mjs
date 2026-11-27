import assert from 'node:assert/strict';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { ipcMain } from 'electron';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { atNextDelivery, createTrackedTestService } from './fixtures/tracked-orchestration-service.mjs';
import { createRequire } from 'node:module';

import { deliverPromptToPty } from '../dist-electron/agent/agent-prompt-delivery.js';
import { registerOrchestrationIpc } from '../dist-electron/ipc/orchestration.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import {
  buildDispatchPreambleWithBrief,
  INLINE_SPEC_MAX_BYTES,
} from '../dist-electron/orchestration/worker-dispatch-preamble.js';
import {
  BRIEF_FILE_MAX_BYTES,
  clipMarkdown,
  normalizeTaskContext,
  removeWorkerBriefFile,
  SHARED_RUN_CONTEXT_MAX_BYTES,
  writeWorkerBriefFile,
} from '../dist-electron/orchestration/worker-brief-context.js';

const require = createRequire(import.meta.url);
const cliModule = require(resolve('electron/orchestration/aha-orchestration-cli.cjs'));
const mcpModule = require(resolve('electron/orchestration/aha-mcp-server.cjs'));

test('buildDispatchPreambleWithBrief renders structured context, shared run context, and skips shared context on follow-up', () => {
  const { preamble, briefFilePath } = buildDispatchPreambleWithBrief({
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    runId: 'run_1',
    taskSpec: 'Implement OAuth PKCE refresh handling',
    taskContext: {
      background: 'User chose PKCE over implicit flow; legacy token endpoint is deprecated.',
      constraints: ['Do not break existing session cookie fallback', 'Keep Windows paths normalized'],
      files: ['electron/auth/oauth.ts', 'docs/auth-design.md'],
      acceptance: 'Run npm run typecheck and tests/oauth.test.mjs',
    },
    sharedContext: {
      runObjective: 'Ship v2 authentication overhaul',
      activePeers: [{ role: 'frontend', taskTitle: 'Login modal PKCE callback UI' }],
      recentBoardPosts: [
        { boardSeq: 4, kind: 'handoff', fromRole: 'architect', summary: 'Use /oauth/callback?code=...' },
      ],
      latestBoardSeq: 5,
    },
    coordinatorHandle: 'run:run_1',
    workerHandle: 'local-w1',
    mcpEnabled: true,
    role: 'backend',
  });

  assert.equal(briefFilePath, null);
  assert.match(preamble, /### Background & Decisions\nUser chose PKCE/);
  assert.match(preamble, /### Constraints\n- Do not break existing session cookie fallback/);
  assert.match(preamble, /### Relevant Files\n- electron\/auth\/oauth\.ts/);
  assert.match(preamble, /### Acceptance Criteria\nRun npm run typecheck/);
  assert.match(preamble, /### Shared Run Context/);
  assert.match(preamble, /Run Objective: Ship v2 authentication overhaul/);
  assert.match(preamble, /Active Peers: @frontend \(Login modal PKCE callback UI\)/);
  assert.match(preamble, /#4 \[handoff\] @architect: Use \/oauth\/callback/);
  assert.match(preamble, /Call `read_board` \(current head #5\)/);

  const followUp = buildDispatchPreambleWithBrief({
    taskId: 'task_1',
    dispatchId: 'ctx_2',
    runId: 'run_1',
    taskSpec: 'Also handle 401 retry once',
    sharedContext: {
      runObjective: 'Ship v2 authentication overhaul',
      activePeers: [{ role: 'frontend', taskTitle: 'Login modal PKCE callback UI' }],
      latestBoardSeq: 6,
    },
    coordinatorHandle: 'run:run_1',
    workerHandle: 'local-w1',
    mcpEnabled: true,
    role: 'backend',
    isFollowUp: true,
  });
  assert.doesNotMatch(followUp.preamble, /### Shared Run Context/);
});

test('overflowing brief persists atomically to briefsDir without dispatchCapability and links path in PTY preamble', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-brief-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const longBackground = 'Detailed architectural decision. '.repeat(220);
  assert.ok(Buffer.byteLength(longBackground, 'utf8') > INLINE_SPEC_MAX_BYTES);

  const secretCap = 'cap_super_secret_token_1234567890';
  const { preamble, briefFilePath } = buildDispatchPreambleWithBrief({
    taskId: 'task_big',
    dispatchId: 'ctx_big_1',
    runId: 'run_big',
    taskSpec: 'Refactor streaming parser',
    taskContext: {
      background: longBackground,
      constraints: ['Zero breaking changes'],
      files: ['src/parser.ts'],
      acceptance: 'npm test passes',
    },
    briefsDir: dir,
    coordinatorHandle: 'run:run_big',
    workerHandle: 'local-w2',
    dispatchCapability: secretCap,
    mcpEnabled: false,
    role: 'parser',
  });

  assert.ok(briefFilePath);
  assert.ok(existsSync(briefFilePath));
  const diskContent = readFileSync(briefFilePath, 'utf8');
  assert.ok(diskContent.includes(longBackground.trim()));
  assert.ok(diskContent.includes('Zero breaking changes'));
  assert.ok(!diskContent.includes(secretCap), 'brief file must never leak dispatchCapability');
  assert.ok(preamble.includes(`Full Brief File: ${briefFilePath}`));
  assert.ok(preamble.includes('Read full context file first'));
});

test('OrchestrationService delegateTask passes taskContext through proposals, auto-injects shared run context, and cleans brief files on release', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-orch-ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const stateFile = join(dir, 'orchestration-state.json');
  const store = new OrchestrationStore({ resolveFile: () => stateFile });
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  agentStatusStore.registerPane('local-peer', { agentId: 'codex' });
  agentStatusStore.registerPane('local-worker', { agentId: 'grok' });

  const writtenPrompts = [];
  let spawnIdx = 0;
  const service = createTrackedTestService({
    store,
    agentStatusStore,
    writePty: (ptyId, data) => {
      writtenPrompts.push({ ptyId, data });
      return { ok: true };
    },
    spawnWorkerPty: async () => {
      spawnIdx += 1;
      return { ptyId: spawnIdx === 1 ? 'local-peer' : 'local-worker', cwd: dir };
    },
    closeWorkerPty: async () => ({ ok: true }),
    isPtyAlive: () => true,
    isMcpEnabledForCli: () => true,
    getConfirmMode: () => 'chat-and-guard',
    getDefaultWorktree: () => false,
    getDefaultCwd: () => dir,
  });

  const run = service.runCreate({
    objective: 'Build non-blocking theme sync & brief delivery',
    from: 'local-coord',
    paneId: 'local-coord',
  }).run;

  // First peer worker (userInitiated bypasses gate) + a handoff post on board.
  await service.delegateTask({
    from: 'local-coord',
    runId: run.id,
    role: 'frontend',
    task: 'Update Board UI proposal card',
    agent: 'codex',
    worktree: false,
    userInitiated: true,
  });
  service.boardPost({
    from: 'local-peer',
    runId: run.id,
    kind: 'handoff',
    text: 'Proposal card expects taskContext.{background,constraints,files,acceptance}',
  });

  // Step 1 of chat-and-guard preserves taskContext in proposal.
  const longBg = 'Shared architectural rationale. '.repeat(180);
  const firstHttp = await dispatchOrchestrationHttpAction(
    service,
    'delegate-task',
    {
      role: 'backend',
      task: 'Wire structured context into dispatch pipeline',
      context: longBg,
      constraints: ['Keep legacy --spec compatible'],
      files: ['electron/orchestration/orchestration-service.ts'],
      acceptance: 'npm test',
      agent: 'grok',
      worktree: false,
      confirmed: false,
    },
    { callerPaneId: 'local-coord' },
  );
  assert.equal(firstHttp.status, 200);
  const firstAttempt = firstHttp.body.result;
  assert.equal(firstAttempt.status, 'confirmation_required');
  assert.equal(firstAttempt.proposal.taskContext.constraints[0], 'Keep legacy --spec compatible');
  assert.deepEqual(firstAttempt.proposal.taskContext.files, [
    'electron/orchestration/orchestration-service.ts',
  ]);

  // Simulate user reply turn, then confirm delegate-task.
  service.proposals.recordUserTurn('local-coord', 'pty');
  const startedHttp = await dispatchOrchestrationHttpAction(
    service,
    'delegate-task',
    {
      role: 'backend',
      task: 'Wire structured context into dispatch pipeline',
      proposalId: firstAttempt.proposal.id,
      agent: 'grok',
      worktree: false,
      confirmed: true,
    },
    { callerPaneId: 'local-coord' },
  );
  assert.equal(startedHttp.status, 200);
  const started = startedHttp.body.result;
  assert.equal(started.status, 'started');
  assert.ok(started.dispatch.briefFilePath);
  assert.ok(existsSync(started.dispatch.briefFilePath));

  const briefDisk = readFileSync(started.dispatch.briefFilePath, 'utf8');
  assert.match(briefDisk, /Run Objective: Build non-blocking theme sync/);
  assert.match(briefDisk, /Active Peers: @frontend/);
  assert.match(briefDisk, /Proposal card expects taskContext/);
  assert.match(briefDisk, /Keep legacy --spec compatible/);

  const workerPrompt = writtenPrompts.find((p) => p.ptyId === 'local-worker')?.data ?? '';
  assert.ok(workerPrompt.includes(`Full Brief File: ${started.dispatch.briefFilePath}`));

  // Settle & release cleans up the brief file.
  await service.workerDoneByPane('local-worker', { outcome: 'completed', summary: 'Done' });
  await service.workerRelease({ dispatchId: started.dispatch.id, force: true });
  assert.equal(existsSync(started.dispatch.briefFilePath), false);
  service.dispose();
  store.flushSync();
});

test('CLI worker-start and MCP delegate_task accept structured context flags and fields', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-cli-ctx-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const ctxFile = join(dir, 'ctx.md');
  writeFileSync(ctxFile, 'Loaded from context file', 'utf8');

  const parsed = cliModule.parseCliArgs([
    'orchestration',
    'worker-start',
    '--spec',
    'Fix bug',
    '--context-file',
    ctxFile,
    '--constraint',
    'No breaking changes',
    '--constraint',
    'Windows safe',
    '--file',
    'src/a.ts',
    '--file',
    'src/b.ts',
    '--acceptance',
    'npm test',
  ]);
  const built = cliModule.buildPayload(parsed.verb, parsed.flags, parsed.positional, parsed.namespace);
  assert.equal(built.action, 'worker-start');
  assert.equal(built.payload.context, 'Loaded from context file');
  assert.deepEqual(built.payload.constraints, ['No breaking changes', 'Windows safe']);
  assert.deepEqual(built.payload.files, ['src/a.ts', 'src/b.ts']);
  assert.equal(built.payload.acceptance, 'npm test');

  const tools = mcpModule.buildToolsForContext({
    ptyId: 'local-coord',
    role: 'coordinator',
    canDelegate: true,
    roster: [{ cliId: 'claude', label: 'Claude', available: true, specialty: 'general' }],
    workers: [],
    pendingProposals: [],
  });
  const delegateTool = tools.find((tool) => tool.name === 'delegate_task');
  assert.ok(delegateTool);
  for (const field of ['context', 'constraints', 'files', 'acceptance']) {
    assert.ok(field in delegateTool.inputSchema.properties, `delegate_task missing ${field}`);
  }

  const normalized = normalizeTaskContext({
    context: '  bg  ',
    constraints: ['a', 'a', '  '],
    files: ['x.ts'],
    acceptance: 'ok',
  });
  assert.deepEqual(normalized, {
    background: 'bg',
    constraints: ['a'],
    files: ['x.ts'],
    acceptance: 'ok',
  });
  assert.ok(SHARED_RUN_CONTEXT_MAX_BYTES >= 1000);
  const fields = delegateTool.inputSchema.properties;
  assert.equal(fields.context.maxLength, 16000);
  assert.equal(fields.background.maxLength, fields.context.maxLength);
  assert.equal(fields.constraints.maxItems, 20);
  assert.equal(fields.files.maxItems, 30);
  assert.equal(fields.files.items.maxLength, 400);
  assert.equal(fields.acceptance.maxLength, 4000);
  assert.deepEqual(fields.taskContext.properties.constraints, fields.constraints && {
    type: fields.constraints.type,
    maxItems: fields.constraints.maxItems,
    items: fields.constraints.items,
  });
});

function createContextHarness(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aha-context-regression-'));
  const stateFile = join(dir, 'orchestration-state.json');
  const store = new OrchestrationStore({ resolveFile: () => stateFile, ...options.store });
  const agentStatusStore = new AgentStatusStore();
  const writes = [];
  const alive = new Set();
  let spawned = 0;
  const register = (id) => {
    alive.add(id);
    agentStatusStore.registerPane(id, { agentId: 'claude' });
    return id;
  };
  const from = register('local-ctx-coordinator');
  const service = createTrackedTestService({
    store,
    agentStatusStore,
    getDefaultCwd: () => dir,
    getDefaultWorktree: () => false,
    settleDelayMs: 0,
    isPtyAlive: (id) => alive.has(id),
    spawnWorkerPty: async () => ({ ptyId: register('local-ctx-worker-' + ++spawned), cwd: dir }),
    closeWorkerPty: async (id) => { alive.delete(id); return { ok: true }; },
    writePty: (id, data) => {
      writes.push({ id, data });
      return options.writePty?.(id, data) ?? { ok: true };
    },
    ...options.service,
  });
  t.after(() => {
    service.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const run = service.runCreate({ id: options.runId, from, paneId: from, objective: 'Ship reliable orchestration' }).run;
  const start = (input) => service.workerStart({ from, noWorktree: true, ...input });
  const finish = (dispatch, outcome = 'completed') => service.workerDone({
    from: dispatch.assigneePaneId,
    dispatchId: dispatch.id,
    capability: store.getDispatchCapability(dispatch.id),
    outcome,
    summary: 'Test worker report',
  });
  const promptFor = (id) => writes.findLast((entry) => entry.id === id && entry.data.length > 1)?.data ?? '';
  return { dir, stateFile, store, service, agentStatusStore, run, from, register, start, finish, promptFor };
}

test('HTTP scopes previews and snapshots to the caller Run while main-window IPC reads the global board', async (t) => {
  const { service, store, run, register, start } = createContextHarness(t, {
    service: { getConfirmMode: () => 'always-ui' },
  });
  const worker = await start({ spec: 'Work in run A' });
  const coordinatorB = register('local-ctx-coordinator-b');
  const runB = service.runCreate({ from: coordinatorB, objective: 'Project B', paneId: coordinatorB }).run;
  const taskB = service.taskCreate({ runId: runB.id, spec: 'Work in run B', background: 'private task context' }).task;
  store.insertMessage({ runId: runB.id, from: coordinatorB, to: 'run:' + runB.id, kind: 'handoff', subject: 'B', body: 'private handoff' });
  const hold = service.delegateTask({ from: coordinatorB, runId: runB.id, task: 'Proposed B', context: 'private proposal' });
  const pending = service.proposals.listPendingProposals({ runId: runB.id })[0];
  t.after(() => service.proposals.cancelAllPendingProposals());
  const context = { callerPaneId: worker.ptyId };
  for (const [action, payload] of [
    ['dispatch-show', { taskId: taskB.id, preamble: true }],
    ['dispatch', { taskId: taskB.id, dryRun: true }],
    ['dispatch', { taskId: taskB.id, to: worker.ptyId, inject: false }],
    ['snapshot', { runId: runB.id }],
    ['run-show', { id: runB.id }],
    ['task-show', { id: taskB.id }],
    ['task-create', { runId: runB.id, spec: 'Cross-run task' }],
    ['task-list', { runId: runB.id }],
    ['worker-list', { runId: runB.id }],
    ['worker-start', { taskId: taskB.id, noWorktree: true }],
    ['delegate-task', { runId: runB.id, task: 'Cross-run helper' }],
  ]) {
    const response = await dispatchOrchestrationHttpAction(service, action, payload, context);
    assert.equal(response.body.code, 'operation_rejected', action);
    assert.doesNotMatch(JSON.stringify(response.body), /private (handoff|proposal|task context)/);
  }
  const denied = await dispatchOrchestrationHttpAction(service, 'snapshot', {}, { callerPaneId: null });
  assert.equal(denied.body.code, 'operation_rejected');
  const scoped = await dispatchOrchestrationHttpAction(service, 'snapshot', {}, context);
  assert.equal(scoped.status, 200);
  assert.deepEqual(scoped.body.result.runs.map(({ id }) => id), [run.id]);
  assert.equal(scoped.body.result.pendingProposals.length, 0);
  const sameRun = await dispatchOrchestrationHttpAction(service, 'dispatch-show', { taskId: worker.task.id, preamble: true }, context);
  assert.equal(sameRun.status, 200);

  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, callback) => handlers.set(channel, callback));
  const sender = { id: 605, send() {} };
  const ipc = registerOrchestrationIpc({ liveWindow: () => ({ webContents: sender }), orchestrationService: service });
  t.after(ipc.dispose);
  const global = await handlers.get('orchestration:get-snapshot')({ sender }, {});
  assert.equal(global.ok, true);
  assert.ok(global.snapshot.runs.some(({ id }) => id === runB.id));
  assert.equal(global.snapshot.pendingProposals[0].taskContext.background, 'private proposal');
  const created = await handlers.get('orchestration:task-create')({ sender }, {
    runId: runB.id, spec: 'IPC task', background: 'IPC alias', taskContext: { acceptance: 'test' },
  });
  assert.equal(created.ok, true);
  assert.deepEqual(created.task.taskContext, { background: 'IPC alias', acceptance: 'test' });
  service.rejectDispatchProposal(pending.id, 'Test finished');
  assert.equal((await hold).status, 'rejected');
});

test('chat-and-guard requires a fresh matching plan for changed tasks or constraints and preserves the approved batch', async (t) => {
  const { service, from, run } = createContextHarness(t);
  const delegate = (input) => service.delegateTask({ from, runId: run.id, worktree: false, ...input });
  const plans = [
    { role: 'reader', task: 'Audit proposal', constraints: ['Do not edit'], acceptance: 'Send findings' },
    { role: 'tester', task: 'Run snapshot tests', constraints: ['Keep fixtures'], files: ['tests/a.mjs'] },
    { role: 'builder', task: 'Verify build', context: 'Use existing config' },
  ];
  const [first, second] = await Promise.all(plans.map((plan) => delegate(plan)));
  service.proposals.recordUserTurn(from, 'pty');
  const [changed, roleMatched, third] = await Promise.all([
    delegate({ role: 'reader', task: plans[0].task, constraints: ['Edit files'], proposalId: first.proposal.id, confirmed: true }),
    delegate({ role: 'tester', task: plans[1].task, confirmed: true }),
    delegate({ role: 'builder', task: plans[2].task, confirmed: true }),
  ]);
  assert.equal(changed.status, 'confirmation_required');
  assert.match(changed.message, /重新确认/);
  assert.deepEqual(roleMatched.task.taskContext, { constraints: ['Keep fixtures'], files: ['tests/a.mjs'] });
  assert.deepEqual(third.task.taskContext, { background: 'Use existing config' });
  const changedTask = await delegate({ role: 'tester', task: 'Run production changes', proposalId: second.proposal.id, confirmed: true });
  assert.equal(changedTask.status, 'confirmation_required');
  assert.match(changedTask.message, /重新确认/);
  service.proposals.recordUserTurn(from, 'pty');
  const approved = await delegate({ role: 'reader', task: plans[0].task, proposalId: changed.proposal.id, confirmed: true });
  assert.deepEqual(approved.task.taskContext, { constraints: ['Edit files'], acceptance: 'Send findings' });
});

test('--task and failed/completed --retry-of persist the same field-level merge', async (t) => {
  const { service, store, run, start, finish, promptFor } = createContextHarness(t);
  const original = service.taskCreate({
    runId: run.id, spec: 'Review protocol', context: 'Old background', constraints: ['Read only'],
    files: ['old.ts'], acceptance: 'Old acceptance',
  }).task;
  const first = await start({ taskId: original.id, acceptance: 'New acceptance', files: ['new.ts', 'new.ts'] });
  assert.deepEqual(first.task.taskContext, {
    background: 'Old background', constraints: ['Read only'], files: ['new.ts'], acceptance: 'New acceptance',
  });
  assert.match(promptFor(first.ptyId), /New acceptance/);
  assert.match(service.dispatchShow({ taskId: original.id, preamble: true }).preamble, /New acceptance/);
  finish(first.dispatch, 'failed');
  const cli = cliModule.parseCliArgs(['orchestration', 'worker-start', '--retry-of', first.dispatch.id, '--background', 'Retry background']);
  const built = cliModule.buildPayload(cli.verb, cli.flags, cli.positional, cli.namespace);
  const second = await start(built.payload);
  assert.equal(second.task.id, original.id);
  assert.deepEqual(second.task.taskContext, { ...first.task.taskContext, background: 'Retry background' });
  finish(second.dispatch);
  const third = await start({ retryOfDispatchId: second.dispatch.id, acceptance: 'Final acceptance' });
  assert.notEqual(third.task.id, original.id);
  assert.deepEqual(third.task.taskContext, { ...second.task.taskContext, acceptance: 'Final acceptance' });
  assert.deepEqual(store.getTask(original.id).taskContext, second.task.taskContext);
});

test('automatic Coordinator shares useful Board highlights and follow-up respawn restores the original brief', async (t) => {
  const { service, store, run, from, register, start, finish, promptFor } = createContextHarness(t);
  const auto = register('local-auto');
  store.insertMessage({
    runId: run.id, from, to: 'run:' + run.id, kind: 'brief', subject: 'noise',
    body: '[ORCHESTRATION DISPATCH abc]\nWorkspace CWD: fake-path\nGit Branch: fake-branch\n=== TASK SPECIFICATION ===\nActual task headline',
  });
  const handoff = store.insertMessage({ runId: run.id, from, to: 'run:' + run.id, kind: 'handoff', subject: 'Handoff', body: 'Relevant handoff' });
  const head = store.insertMessage({ runId: run.id, from, to: 'run:' + run.id, kind: 'post', subject: 'Not a highlight', body: 'General discussion' });
  const automaticTask = service.taskCreate({
    runId: run.id, spec: 'Automatic worker specification', context: 'Inline background '.repeat(330),
    constraints: ['Preserve coordinator setup'], acceptance: 'Run test suite',
  }).task;
  await service.coordinatorTick(run.id, { workerPaneIds: [auto] });
  const automatic = store.getLatestDispatchForTask(automaticTask.id);
  assert.ok(automatic.briefFilePath);
  const autoBrief = readFileSync(automatic.briefFilePath, 'utf8');
  assert.match(autoBrief, /Preserve coordinator setup/);
  assert.match(autoBrief, /Ship reliable orchestration/);
  assert.match(autoBrief, /Actual task headline[\s\S]*Relevant handoff/);
  assert.match(autoBrief, new RegExp('current head #' + head.boardSeq));
  assert.notEqual(handoff.boardSeq, head.boardSeq);
  assert.doesNotMatch(autoBrief, /fake-path|fake-branch|General discussion/);
  assert.match(promptFor(auto), /Full Brief File:/);

  const initial = await start({ spec: 'Original task body', context: 'Original background '.repeat(300), constraints: ['Original guardrail'], keepOpen: true });
  finish(initial.dispatch);
  const live = await service.send({ from, to: 'dispatch:' + initial.dispatch.id, subject: 'Live follow-up', body: 'Change only this detail.' });
  const liveDispatch = live.followUp.dispatch;
  assert.equal(live.followUp.reusedPane, true);
  assert.match(promptFor(initial.ptyId), /Change only this detail/);
  assert.doesNotMatch(promptFor(initial.ptyId), /Original task body|Original guardrail|Shared Run Context/);
  finish(liveDispatch);
  service.markPtyExited(initial.ptyId);
  const respawn = await service.send({ from, to: 'dispatch:' + initial.dispatch.id, subject: 'Respawn follow-up', body: 'Also update documentation.' });
  assert.equal(respawn.followUp.reusedPane, false);
  const latest = respawn.followUp.dispatch;
  const content = readFileSync(latest.briefFilePath, 'utf8');
  assert.match(content, /Original task body/);
  assert.match(content, /Original guardrail/);
  assert.match(content, /Also update documentation/);
  assert.match(content, /Shared Run Context/);
  finish(latest);
  await service.workerRelease({ dispatchId: initial.dispatch.id, force: true });
  assert.equal(existsSync(initial.dispatch.briefFilePath), false);
  assert.equal(existsSync(latest.briefFilePath), false);
  assert.equal(store.getDispatchContext(initial.dispatch.id).briefFilePath, null);
  assert.equal(store.getDispatchContext(latest.id).briefFilePath, null);
});

test('full framed PTY payload fits and the 64 KiB brief keeps guardrails and closes a clipped Markdown fence', async (t) => {
  const { start, promptFor } = createContextHarness(t, { runId: 'run_' + 'r'.repeat(2200) });
  const worker = await start({
    spec: 'Task text '.repeat(2500), context: '# Rationale\n\x60\x60\x60text\n' + '中文'.repeat(7000) + '\n\x60\x60\x60',
    constraints: ['Keep compatibility marker'], acceptance: 'Acceptance marker', files: ['src/important.ts'],
  });
  const frame = promptFor(worker.ptyId);
  assert.ok(Buffer.byteLength(frame, 'utf8') < 8192);
  assert.equal(frame.match(/Full Brief File:/g)?.length, 1);
  const content = readFileSync(worker.dispatch.briefFilePath, 'utf8');
  assert.ok(Buffer.byteLength(content, 'utf8') <= BRIEF_FILE_MAX_BYTES);
  assert.match(content, /Keep compatibility marker/);
  assert.match(content, /Acceptance marker/);
  assert.match(content, /src\/important.ts/);
  assert.match(content, /\n\x60{3}\n\n\[Section truncated\.\]/);
  const withoutPath = buildDispatchPreambleWithBrief({
    taskId: 'task_' + 't'.repeat(3700), dispatchId: 'ctx_limit', taskSpec: 'Long spec '.repeat(1000),
    workerHandle: 'w', coordinatorHandle: 'run_' + 'r'.repeat(3000),
  });
  const result = await deliverPromptToPty({ ptyId: 'w', prompt: withoutPath.preamble }, () => ({ ok: true }));
  assert.equal(result.ok, true);
  assert.ok(result.bytesWritten < 8192);
  assert.match(clipMarkdown('x\n\x60\x60\x60lang\n' + '\u{1F642}'.repeat(80) + '\n\x60\x60\x60', 80), /\n\x60{3}\n\n\[Section truncated\.\]/);
});

test('brief filesystem operations clean failed renames and reject directory junctions/symlinks', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-brief-fs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const destination = join(dir, 'ctx_rename_failure.md');
  mkdirSync(destination);
  assert.throws(() => writeWorkerBriefFile(dir, 'ctx_rename_failure', 'Cannot replace directory'));
  assert.deepEqual(readdirSync(dir), ['ctx_rename_failure.md']);
  const outside = join(dir, 'outside');
  mkdirSync(outside);
  const outsideFile = join(outside, 'ctx_outside.md');
  writeFileSync(outsideFile, 'untouched');
  const linked = join(dir, 'linked');
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(writeWorkerBriefFile(linked, 'ctx_outside', 'overwritten'), null);
  assert.equal(removeWorkerBriefFile(linked, 'ctx_outside'), false);
  assert.equal(removeWorkerBriefFile(dir, '../outside/ctx_outside'), false);
  assert.equal(readFileSync(outsideFile, 'utf8'), 'untouched');
});

test('brief files are removed on delivery failure, worker stop, Run eviction, reset, and startup reconciliation', async (t) => {
  let failWrite = true;
  const harness = createContextHarness(t, {
    store: { maxRuns: 1 },
    writePty: () => failWrite ? { ok: false, error: 'Test delivery failure' } : { ok: true },
  });
  const { service, store, run, from, register, start, finish, stateFile } = harness;
  const target = register('local-manual-worker');
  const task = service.taskCreate({ runId: run.id, spec: 'Manual task', context: 'Large background '.repeat(400) }).task;
  await assert.rejects(service.dispatchTask({ taskId: task.id, from, to: target }), { code: 'prompt_delivery_failed' });
  const failed = store.getLatestDispatchForTask(task.id);
  assert.equal(failed.briefFilePath, null);
  assert.deepEqual(readdirSync(store.getBriefsDir()), []);
  failWrite = false;
  const stopped = await start({ taskId: task.id });
  await service.workerStop({ dispatchId: stopped.dispatch.id, force: true });
  assert.equal(existsSync(stopped.dispatch.briefFilePath), false);
  assert.equal(store.getDispatchContext(stopped.dispatch.id).briefFilePath, null);

  const evicted = await start({ spec: 'Evict this worker', context: 'Old data '.repeat(650), keepOpen: true });
  finish(evicted.dispatch);
  store.updateRunStatus(run.id, 'completed');
  const replacement = service.runCreate({ from, objective: 'Replacement run' }).run;
  assert.equal(store.getRun(run.id), undefined);
  assert.equal(existsSync(evicted.dispatch.briefFilePath), false);
  const active = await start({ runId: replacement.id, spec: 'Preserve a referenced brief', context: 'Active data '.repeat(600) });
  const orphan = writeWorkerBriefFile(store.getBriefsDir(), 'ctx_orphan', 'Stale orphan');
  const temporary = active.dispatch.briefFilePath + '.123.456.tmp';
  writeFileSync(temporary, 'Stale temporary write');
  finish(active.dispatch);
  await service.waitForPendingWrites();

  const recovered = new OrchestrationStore({ resolveFile: () => stateFile });
  try {
    recovered.load();
    assert.equal(existsSync(orphan), false);
    assert.equal(existsSync(temporary), false);
    assert.equal(recovered.getDispatchContext(active.dispatch.id).briefFilePath, active.dispatch.briefFilePath);
    recovered.reset('tasks');
    assert.equal(existsSync(active.dispatch.briefFilePath), false);
    assert.deepEqual(readdirSync(store.getBriefsDir()), []);
  } finally {
    recovered.close();
  }
});

test('known and labelled legacy credentials are redacted from Proposal, brief, Board, and archived transcript', async (t) => {
  const { service, store, run, from, start, promptFor } = createContextHarness(t);
  const older = await start({ spec: 'Previous dispatch' });
  const oldCapability = store.getDispatchCapability(older.dispatch.id);
  const legacy = 'c8ee5b63-c7b1-4707-bd01-beae3581268d';
  const text = 'Copied: ' + oldCapability + '\nDispatch Capability: ' + legacy;
  const splitToken = oldCapability.slice(0, 15) + '\x00' + oldCapability.slice(15);
  const submitted = await service.delegateTask({
    from, runId: run.id, task: 'Handle copied transcript', planSummary: text,
    context: text + '\n' + splitToken + '\n' + 'Background '.repeat(560), constraints: [text], worktree: false,
  });
  const privateToken = new RegExp(oldCapability + '|' + legacy);
  assert.doesNotMatch(JSON.stringify(submitted.proposal), privateToken);
  service.proposals.recordUserTurn(from, 'pty');
  const next = await service.delegateTask({
    from, runId: run.id, task: 'Handle copied transcript', proposalId: submitted.proposal.id,
    worktree: false, confirmed: true,
  });
  assert.equal(next.status, 'started');
  assert.doesNotMatch(readFileSync(next.dispatch.briefFilePath, 'utf8'), privateToken);
  assert.doesNotMatch(promptFor(next.ptyId), privateToken);
  assert.ok(promptFor(next.ptyId).includes(store.getDispatchCapability(next.dispatch.id)));
  assert.doesNotMatch(JSON.stringify(service.getSnapshot(run.id).messages), privateToken);
  store.archiveDispatchOutput(next.dispatch.id, text + '\n' + promptFor(next.ptyId));
  const archived = store.getDispatchContext(next.dispatch.id).archivedOutput;
  assert.doesNotMatch(archived, privateToken);
  assert.ok(!archived.includes(store.getDispatchCapability(next.dispatch.id)));
});

test('CLI requires explicit values before flags and bounds context files and stdin', (t) => {
  for (const flag of ['--context', '--acceptance', '--constraint']) {
    assert.throws(() => cliModule.parseCliArgs(['orchestration', 'worker-start', '--spec', 'task', flag, '--no-worktree']), /Missing value.*=value/);
  }
  const valid = cliModule.parseCliArgs(['orchestration', 'worker-start', '--spec', 'task', '--context=--literal', '--no-worktree']);
  const payload = cliModule.buildPayload(valid.verb, valid.flags, valid.positional, valid.namespace).payload;
  assert.equal(payload.context, '--literal');
  assert.equal(payload.noWorktree, true);
  const dir = mkdtempSync(join(tmpdir(), 'aha-context-limit-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const oversized = join(dir, 'too-long.md');
  const bytes = Buffer.alloc(64 * 1024 + 1, 'a');
  writeFileSync(oversized, bytes);
  const cli = resolve('electron/orchestration/aha-orchestration-cli.cjs');
  const args = ['orchestration', 'worker-start', '--spec', 'task', '--context-file'];
  const parsed = cliModule.parseCliArgs([...args, oversized]);
  assert.throws(() => cliModule.buildPayload(parsed.verb, parsed.flags, parsed.positional, parsed.namespace), /64 KiB read limit/);
  const input = openSync(oversized, 'r');
  try {
    const code = 'const cli = require(process.argv[1]); const p = cli.parseCliArgs(process.argv.slice(2)); cli.buildPayload(p.verb, p.flags, p.positional, p.namespace);';
    assert.throws(() => execFileSync(process.execPath, ['-e', code, '--', cli, ...args, '-'], {
      stdio: [input, 'pipe', 'pipe'],
    }), (error) => /64 KiB read limit/.test(error.stderr.toString()));
  } finally {
    closeSync(input);
  }
});

test('deferred delivery stores a token-free template and cleans its brief when PTY delivery fails', async (t) => {
  let attempted = '';
  const { service, store, stateFile, register, start, agentStatusStore } = createContextHarness(t, {
    writePty: (_id, data) => {
      attempted = data;
      return { ok: false, error: 'Deferred paste rejected' };
    },
  });
  const target = register('local-ctx-waiting');
  atNextDelivery(service, () => agentStatusStore.ingestHookEvent({ ptyId: target, agentId: 'claude', state: 'waiting' }));
  const worker = await start({
    terminal: target, spec: 'Wait on trusted input', context: 'Deferred brief '.repeat(460),
  });
  assert.equal(worker.dispatch.startObservation, 'permission');
  const token = store.getDispatchCapability(worker.dispatch.id);
  await service.waitForPendingWrites();
  const persisted = JSON.parse(readFileSync(stateFile, 'utf8'));
  assert.ok(persisted.deferredDispatchPrompts[worker.dispatch.id]);
  assert.ok(!persisted.deferredDispatchPrompts[worker.dispatch.id].prompt.includes(token));
  assert.equal(attempted, '');

  let unsubscribe;
  const failed = new Promise((resolve) => {
    unsubscribe = service.onEvent((event) => {
      if (event.reason === 'dispatch:failed') resolve();
    });
  });
  t.after(() => unsubscribe?.());
  agentStatusStore.ingestHookEvent({ ptyId: target, agentId: 'claude', state: 'idle' });
  await failed;
  assert.ok(attempted.includes(token));
  assert.equal(store.getDispatchContext(worker.dispatch.id).briefFilePath, null);
  assert.ok(!existsSync(worker.dispatch.briefFilePath));
  assert.ok(!store.listDeferredDispatchPrompts().length);
  assert.ok(service.getSnapshot().messages.every((message) => !message.body.includes(token)));
});
