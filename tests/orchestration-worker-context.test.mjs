import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import {
  buildDispatchPreambleWithBrief,
  INLINE_SPEC_MAX_BYTES,
} from '../dist-electron/orchestration/worker-dispatch-preamble.js';
import {
  normalizeTaskContext,
  SHARED_RUN_CONTEXT_MAX_BYTES,
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
  const service = new OrchestrationService({
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
      context: longBg,
      constraints: ['Keep legacy --spec compatible'],
      files: ['electron/orchestration/orchestration-service.ts'],
      acceptance: 'npm test',
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
});
