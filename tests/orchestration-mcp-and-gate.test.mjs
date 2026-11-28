import assert from 'node:assert/strict';
import { execFile as execFileCb, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

import {
  AgentHookServer,
  formatAdditionalContextHookStdout,
} from '../dist-electron/agent/agent-hook-server.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { mergeCliLaunchArgs } from '../dist-electron/local-terminal-sessions.js';
import { selectAgentForTask } from '../dist-electron/orchestration/agent-roster.js';
import { DispatchProposalManager } from '../dist-electron/orchestration/dispatch-proposals.js';
import {
  dispatchOrchestrationHttpAction,
  isLongPollOrchestrationAction,
} from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { buildDispatchPreamble } from '../dist-electron/orchestration/worker-dispatch-preamble.js';
import { TerminalRuntimeTracker } from '../dist-electron/terminal-runtime-tracker.js';

const MCP_SERVER_PATH = resolve('electron/orchestration/aha-mcp-server.cjs');

function makeSampleRoster() {
  return [
    {
      cliId: 'claude',
      label: 'Claude Code',
      command: 'claude',
      installed: true,
      enabled: true,
      available: true,
      specialty: 'Architecture & implementation',
      defaultModel: null,
      defaultEffort: null,
      hooksInstalled: true,
      mcpMode: 'launch-arg',
      mcpReady: true,
      idlePanes: [],
    },
    {
      cliId: 'codex',
      label: 'Codex CLI',
      command: 'codex',
      installed: true,
      enabled: true,
      available: true,
      specialty: 'Code review, tests & debugging',
      defaultModel: 'gpt-5.4',
      defaultEffort: 'high',
      hooksInstalled: true,
      mcpMode: 'launch-arg',
      mcpReady: true,
      idlePanes: [{ ptyId: 'local-idle-codex', cliId: 'codex', cwd: '/repo' }],
    },
    {
      cliId: 'grok',
      label: 'Grok CLI',
      command: 'grok',
      installed: true,
      enabled: true,
      available: true,
      specialty: 'Fast verification & fallback',
      defaultModel: null,
      defaultEffort: null,
      hooksInstalled: false,
      mcpMode: 'config',
      mcpReady: true,
      idlePanes: [],
    },
    {
      cliId: 'gemini',
      label: 'Gemini CLI',
      command: 'gemini',
      installed: false,
      enabled: true,
      available: false,
      specialty: 'Research & docs',
      defaultModel: null,
      defaultEffort: null,
      hooksInstalled: false,
      mcpMode: 'config',
      mcpReady: false,
      idlePanes: [],
    },
  ];
}

function createMockSelector() {
  return ({ roster, requestedAgent, taskKind }) => {
    const available = roster.filter((a) => a.available);
    if (available.length === 0) {
      throw new Error('No coding agents available');
    }
    const requested = (requestedAgent || '').trim().toLowerCase();
    if (requested && requested !== 'auto') {
      const exact = available.find((a) => a.cliId === requested);
      if (!exact) throw new Error(`Requested agent ${requested} is unavailable`);
      return {
        cliId: exact.cliId,
        reason: 'explicit',
        model: exact.defaultModel,
        effort: exact.defaultEffort,
        idlePaneId: exact.idlePanes[0]?.ptyId ?? null,
        fallbacks: available.filter((a) => a.cliId !== exact.cliId).map((a) => a.cliId),
      };
    }
    const preferred =
      taskKind === 'review' || taskKind === 'tests'
        ? available.find((a) => a.cliId === 'codex') ?? available[0]
        : available[0];
    return {
      cliId: preferred.cliId,
      reason: taskKind ? `taskKind:${taskKind}` : 'default',
      model: preferred.defaultModel,
      effort: preferred.defaultEffort,
      idlePaneId: preferred.idlePanes[0]?.ptyId ?? null,
      fallbacks: available.filter((a) => a.cliId !== preferred.cliId).map((a) => a.cliId),
    };
  };
}

function spawnMcpClient(t, env, framing = 'newline', cwd = undefined) {
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
    ...(cwd ? { cwd } : {}),
    env: {
      PATH: process.env.PATH || '',
      SystemRoot: process.env.SystemRoot || '',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();
  let buf = Buffer.alloc(0);
  let nextId = 1;
  let stderrText = '';

  child.stderr.on('data', (chunk) => {
    stderrText += chunk.toString('utf8');
  });

  const handleMessage = (raw) => {
    const msg = JSON.parse(raw);
    if (msg && Object.prototype.hasOwnProperty.call(msg, 'id') && pending.has(msg.id)) {
      const entry = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(entry.timer);
      entry.resolve(msg);
    }
  };

  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length > 0) {
      let off = 0;
      while (off < buf.length && (buf[off] === 0x0d || buf[off] === 0x0a)) off += 1;
      if (off > 0) buf = buf.subarray(off);
      if (buf.length === 0) break;

      if (framing === 'content-length') {
        const sep = buf.indexOf('\r\n\r\n');
        if (sep === -1) break;
        const header = buf.subarray(0, sep).toString('ascii');
        const m = /content-length\s*:\s*(\d+)/i.exec(header);
        assert.ok(m, `expected Content-Length header, got: ${header}`);
        const len = Number(m[1]);
        const start = sep + 4;
        if (buf.length < start + len) break;
        const body = buf.subarray(start, start + len).toString('utf8');
        buf = buf.subarray(start + len);
        handleMessage(body);
      } else {
        const nl = buf.indexOf(0x0a);
        if (nl === -1) break;
        const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '').trim();
        buf = buf.subarray(nl + 1);
        if (line) handleMessage(line);
      }
    }
  });

  t.after(async () => {
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('MCP client torn down'));
    }
    pending.clear();
    if (!child.killed && child.exitCode === null) {
      child.stdin.end();
      await new Promise((res) => {
        const killTimer = setTimeout(() => {
          try {
            child.kill();
          } catch {}
          res();
        }, 1_500);
        child.once('exit', () => {
          clearTimeout(killTimer);
          res();
        });
      });
    }
  });

  const sendRaw = (obj) => {
    const json = JSON.stringify(obj);
    if (framing === 'content-length') {
      child.stdin.write(`Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`);
    } else {
      child.stdin.write(`${json}\n`);
    }
  };

  const request = (method, params = {}, timeoutMs = 8_000) => {
    const id = nextId++;
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`MCP request ${method} timed out (stderr=${stderrText})`));
      }, timeoutMs);
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer });
      sendRaw({ jsonrpc: '2.0', id, method, params });
    });
  };

  const notify = (method, params = {}) => {
    sendRaw({ jsonrpc: '2.0', method, params });
  };

  return { child, request, notify, getStderr: () => stderrText };
}

test('DispatchProposalManager counts only keystroke turns and enforces chat-and-guard batch lease', async (t) => {
  let clock = 10_000;
  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: process.cwd(), cliId: 'claude' });

  let spawnCount = 0;
  const spawned = [];
  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async (opts) => {
      spawnCount += 1;
      const ptyId = `local-w-${spawnCount}`;
      spawned.push({ ptyId, cliId: opts.cliId, extraArgs: opts.extraArgs });
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId });
      tracker.registerPty({ ptyId, cwd: opts.cwd || process.cwd(), cliId: opts.cliId });
      return { ptyId, agentId: opts.cliId, cwd: opts.cwd };
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    listCodingAgents: () => makeSampleRoster(),
    selectAgentForTask: createMockSelector(),
    getConfirmMode: () => 'chat-and-guard',
    getDefaultWorktree: () => false,
    isMcpEnabledForCli: () => true,
    settleDelayMs: 0,
    now: () => clock,
  });
  t.after(() => service.dispose());

  // Advance to Turn 10 with PTY Enter + hook pairs; the hook never advances the turn on its own.
  for (let i = 0; i < 10; i += 1) {
    clock += 5_000;
    const tPty = service.recordUserPromptTurn('local-coord', 'pty');
    clock += 200;
    const tHook = service.recordUserPromptTurn('local-coord', 'hook');
    assert.equal(tPty, i + 1);
    assert.equal(tHook, i + 1, 'the hook that follows a keystroke must not advance the turn again');
  }
  assert.equal(service.proposals.getUserTurn('local-coord'), 10);

  // Turn 10 runaway: even with confirmed=true, first call without prior proposal must be blocked!
  const blocked1 = await service.delegateTask({
    from: 'local-coord',
    role: '@reviewer',
    task: 'Audit auth module',
    agent: 'codex',
    taskKind: 'review',
    worktree: false,
    confirmed: true,
  });
  assert.equal(blocked1.status, 'confirmation_required');
  assert.match(blocked1.message, /尚未经用户确认派发/);
  assert.equal(blocked1.proposal.role, 'reviewer');
  assert.equal(blocked1.proposal.resolvedAgent, 'codex');
  assert.equal(spawnCount, 0, 'blocked dispatch must not spawn any PTY');
  assert.equal(store.listTasks().length, 0, 'blocked dispatch must not create any task');

  // Same Turn 10 retry with confirmed=true must STILL be blocked.
  const blocked2 = await service.delegateTask({
    from: 'local-coord',
    role: 'reviewer',
    task: 'Audit auth module',
    agent: 'codex',
    worktree: false,
    confirmed: true,
  });
  assert.equal(blocked2.status, 'confirmation_required');
  assert.equal(spawnCount, 0);

  // Register both plans in the same turn before seeking batch confirmation.
  for (const plan of [
    { role: 'reviewer', task: 'Review diff A', agent: 'codex' },
    { role: 'tester', task: 'Run tests B', agent: 'grok' },
  ]) {
    const result = await service.delegateTask({ ...plan, from: 'local-coord', worktree: false, confirmed: false });
    assert.equal(result.status, 'confirmation_required');
  }

  // User replies on Turn 11 (pty Enter advances, the following hook does not).
  clock += 3_000;
  service.recordUserPromptTurn('local-coord', 'pty');
  clock += 150;
  service.recordUserPromptTurn('local-coord', 'hook');
  assert.equal(service.proposals.getUserTurn('local-coord'), 11);

  // Batch of 2 parallel delegate_task(..., confirmed: true) on Turn 11 must BOTH pass with zero double-confirm!
  const [res1, res2] = await Promise.all([
    service.delegateTask({
      from: 'local-coord',
      role: 'reviewer',
      task: 'Review diff A',
      agent: 'codex',
      worktree: false,
      confirmed: true,
    }),
    service.delegateTask({
      from: 'local-coord',
      role: 'tester',
      task: 'Run tests B',
      agent: 'grok',
      worktree: false,
      confirmed: true,
    }),
  ]);
  assert.equal(res1.status, 'started');
  assert.equal(res2.status, 'started');
  assert.equal(res1.role, 'reviewer');
  assert.equal(res1.agent, 'codex');
  assert.equal(res2.role, 'tester');
  assert.equal(res2.agent, 'grok');
  assert.equal(res1.task.displayName, 'reviewer');
  assert.equal(res1.task.taskTitle, '@reviewer: Review diff A');
  assert.equal(spawnCount, 2);

  // A hook with no keystroke (text AhaStation typed in) is not a user turn.
  clock += 5_000;
  assert.equal(service.recordUserPromptTurn('local-coord', 'hook'), 11);
  // Next user turn (Turn 12) clears the Turn 11 lease and requires fresh confirmation.
  service.recordUserPromptTurn('local-coord', 'pty');
  assert.equal(service.proposals.getUserTurn('local-coord'), 12);
  const blockedTurn12 = await service.delegateTask({
    from: 'local-coord',
    role: 'docs',
    task: 'Update README',
    agent: 'claude',
    worktree: false,
    confirmed: true,
  });
  assert.equal(blockedTurn12.status, 'confirmation_required');
  assert.equal(spawnCount, 2);

  // Mid-generation accidental PTY Enter while pane is 'working' on a turn with a pending proposal is ignored.
  agentStatusStore.ingestHookEvent({ ptyId: 'local-coord', agentId: 'claude', state: 'working' });
  assert.equal(agentStatusStore.get('local-coord')?.state, 'working');
  assert.equal(service.proposals.hasPendingChatProposalForCurrentTurn('local-coord'), true);
  assert.equal(service.recordUserPromptTurn('local-coord', 'pty'), 12, 'mid-generation pty Enter must be ignored');

  // Once the agent finishes its turn (idle/waiting), the confirmation Enter advances the turn.
  agentStatusStore.ingestHookEvent({ ptyId: 'local-coord', agentId: 'claude', state: 'done' });
  clock += 400; // still within 1500ms of Turn 12 hook!
  assert.equal(
    service.recordUserPromptTurn('local-coord', 'pty'),
    13,
    'confirmation Enter after evaluateChatGuard must advance the turn'
  );
  const confirmedTurn13 = await service.delegateTask({
    from: 'local-coord',
    role: 'docs',
    task: 'Update README',
    agent: 'claude',
    worktree: false,
    confirmed: true,
  });
  assert.equal(confirmedTurn13.status, 'started');
  assert.equal(spawnCount, 3);
});

test('always-ui mode holds proposals, supports CLI override & reject, and auto/userInitiated bypass gate', async (t) => {
  let mode = 'always-ui';
  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: process.cwd(), cliId: 'claude' });

  let spawnCount = 0;
  const spawnedClis = [];
  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async (opts) => {
      spawnCount += 1;
      spawnedClis.push(opts.cliId);
      const ptyId = `local-ui-w${spawnCount}`;
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId });
      tracker.registerPty({ ptyId, cwd: opts.cwd || process.cwd(), cliId: opts.cliId });
      return { ptyId, agentId: opts.cliId, cwd: opts.cwd };
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    listCodingAgents: () => makeSampleRoster(),
    selectAgentForTask: createMockSelector(),
    getConfirmMode: () => mode,
    getDefaultWorktree: () => false,
    isMcpEnabledForCli: () => true,
    proposalHoldTimeoutMs: 10_000,
    settleDelayMs: 0,
  });
  t.after(() => service.dispose());

  // 1. Hold proposal in always-ui, inspect snapshot, approve with CLI override codex -> grok.
  const heldApprovePromise = service.delegateTask({
    from: 'local-coord',
    role: 'auditor',
    task: 'Inspect security headers',
    agent: 'codex',
    worktree: false,
  });
  await new Promise((r) => setTimeout(r, 15));
  const snapPending = service.getSnapshot();
  assert.equal(snapPending.pendingProposals.length, 1);
  const propId = snapPending.pendingProposals[0].id;
  assert.equal(snapPending.pendingProposals[0].resolvedAgent, 'codex');

  const approved = service.approveDispatchProposal(propId, { agent: 'grok' });
  assert.equal(approved.proposal.status, 'approved');
  assert.equal(approved.proposal.resolvedAgent, 'grok');

  const startedRes = await heldApprovePromise;
  assert.equal(startedRes.status, 'started');
  assert.equal(startedRes.agent, 'grok');
  assert.equal(spawnedClis.at(-1), 'grok');
  assert.equal(service.getSnapshot().pendingProposals.length, 0);

  // 2. Reject held proposal -> clean rejection without spawning.
  const heldRejectPromise = service.delegateTask({
    from: 'local-coord',
    role: 'refactor',
    task: 'Rewrite router',
    agent: 'claude',
    worktree: false,
  });
  await new Promise((r) => setTimeout(r, 15));
  const prop2Id = service.getSnapshot().pendingProposals[0].id;
  service.rejectDispatchProposal(prop2Id, 'Not needed right now');
  const rejectedRes = await heldRejectPromise;
  assert.equal(rejectedRes.status, 'rejected');
  assert.equal(rejectedRes.proposal.status, 'rejected');
  assert.match(rejectedRes.message, /Not needed right now/);
  assert.equal(spawnCount, 1);

  // 3. userInitiated: true bypasses always-ui gate immediately.
  const directRes = await service.delegateTask({
    from: 'local-coord',
    role: 'quick',
    task: 'Quick lint check',
    agent: 'claude',
    worktree: false,
    userInitiated: true,
  });
  assert.equal(directRes.status, 'started');
  assert.equal(spawnCount, 2);

  // 4. auto mode bypasses gate immediately without confirmed or userInitiated.
  mode = 'auto';
  const autoRes = await service.delegateTask({
    from: 'local-coord',
    role: 'auto-worker',
    task: 'Auto task',
    agent: 'claude',
    worktree: false,
  });
  assert.equal(autoRes.status, 'started');
  assert.equal(spawnCount, 3);

  // 5. HTTP proposal-approve / proposal-reject rejected whenever callerPaneId is present; userInitiated ignored over HTTP.
  mode = 'always-ui';
  const abortCtrl = new AbortController();
  const approveHttpRes = await dispatchOrchestrationHttpAction(
    service,
    'proposal-approve',
    { id: 'prop_any' },
    { signal: abortCtrl.signal, callerPaneId: 'local-coord' }
  );
  assert.equal(approveHttpRes.status, 400);
  assert.equal(approveHttpRes.body.code, 'operation_rejected');
  const rejectHttpRes = await dispatchOrchestrationHttpAction(
    service,
    'proposal-reject',
    { id: 'prop_any', reason: 'bypass' },
    { signal: abortCtrl.signal, callerPaneId: 'local-ui-w1' }
  );
  assert.equal(rejectHttpRes.status, 400);
  assert.equal(rejectHttpRes.body.code, 'operation_rejected');

  // 6. Worker at maxDepth rejected by delegateTask before creating proposals, and sibling isolation enforced.
  const subService = new OrchestrationService({
    store: new OrchestrationStore(),
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async (opts) => {
      spawnCount += 1;
      const ptyId = `local-iso-w${spawnCount}`;
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId });
      tracker.registerPty({ ptyId, cwd: opts.cwd || process.cwd(), cliId: opts.cliId });
      return { ptyId, agentId: opts.cliId, cwd: opts.cwd };
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    listCodingAgents: () => makeSampleRoster(),
    selectAgentForTask: createMockSelector(),
    getConfirmMode: () => 'always-ui',
    getDefaultWorktree: () => false,
    isMcpEnabledForCli: () => true,
    maxDepth: 1,
    settleDelayMs: 0,
  });
  t.after(() => subService.dispose());

  const wA = await subService.delegateTask({
    from: 'local-coord',
    role: 'alpha',
    task: 'Alpha task',
    agent: 'claude',
    worktree: false,
    userInitiated: true,
  });
  const wB = await subService.delegateTask({
    from: 'local-coord',
    role: 'beta',
    task: 'Beta task',
    agent: 'codex',
    worktree: false,
    userInitiated: true,
  });

  // Worker wA is at depth 1 === maxDepth: delegateTask must throw operation_rejected before creating any held proposal!
  await assert.rejects(
    () =>
      subService.delegateTask({
        from: wA.ptyId,
        role: 'sub',
        task: 'Nested task beyond maxDepth',
        agent: 'claude',
        worktree: false,
      }),
    (err) => err.code === 'operation_rejected' && /exceeds max depth/i.test(err.message)
  );
  assert.equal(subService.getSnapshot().pendingProposals.length, 0);

  // Worker wA cannot read or message sibling worker wB by role or by raw dispatch ID.
  await assert.rejects(
    () => subService.manageWorkerByRole(wA.ptyId, { role: '@beta', action: 'read' }),
    (err) => err.code === 'dispatch_not_found' || err.code === 'operation_rejected'
  );
  await assert.rejects(
    () => subService.manageWorkerByRole(wA.ptyId, { role: wB.dispatch.id, action: 'read' }),
    (err) => err.code === 'operation_rejected'
  );
  await assert.rejects(
    () => subService.messageWorkerByRole(wA.ptyId, { role: wB.dispatch.id, message: 'hi sibling' }),
    (err) => err.code === 'operation_rejected'
  );
});

test('Slim MCP preamble omits capability & CLI manual; workerDoneByPane, askCoordinatorByPane, fallback & pane mode work', async (t) => {
  // Pure preamble check: MCP slim vs legacy CLI
  const slim = buildDispatchPreamble({
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    taskSpec: 'Implement feature Y',
    coordinatorHandle: 'run:run_1',
    workerHandle: 'local-w1',
    worktreePath: '/tmp/wt-1',
    branch: 'aha/worker/feature-y',
    dispatchCapability: 'secret_cap_12345',
    mcpEnabled: true,
    role: '@builder',
  });
  assert.match(slim, /^\[Worker @builder\]/);
  assert.match(slim, /Workspace: \/tmp\/wt-1/);
  assert.match(slim, /Branch: aha\/worker\/feature-y/);
  assert.match(slim, /ask_coordinator/);
  assert.match(slim, /report_done/);
  assert.equal(slim.includes('--capability'), false, 'slim MCP preamble must omit --capability');
  assert.equal(slim.includes('secret_cap_12345'), false, 'slim MCP preamble must omit capability token');
  assert.equal(slim.includes('=== ORCHESTRATION PROTOCOL ==='), false);

  const legacy = buildDispatchPreamble({
    taskId: 'task_1',
    dispatchId: 'ctx_1',
    taskSpec: 'Implement feature Y',
    coordinatorHandle: 'run:run_1',
    workerHandle: 'local-w1',
    dispatchCapability: 'secret_cap_12345',
  });
  assert.match(legacy, /--capability secret_cap_12345/);

  // Service integration: fallback on terminal_unavailable + workerDoneByPane + askCoordinatorByPane + pane mode
  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  const writtenPrompts = [];
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: process.cwd(), cliId: 'claude' });

  const store = new OrchestrationStore();
  let failCodexOnce = true;
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async (ptyId, data) => {
      writtenPrompts.push({ ptyId, data });
      return { ok: true };
    },
    spawnWorkerPty: async (opts) => {
      if (opts.cliId === 'codex' && failCodexOnce) {
        failCodexOnce = false;
        throw new Error('codex binary unavailable');
      }
      const ptyId = `local-fb-${opts.cliId}`;
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId });
      tracker.registerPty({ ptyId, cwd: opts.cwd || process.cwd(), cliId: opts.cliId });
      return { ptyId, agentId: opts.cliId, cwd: opts.cwd };
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    listCodingAgents: () => makeSampleRoster(),
    selectAgentForTask: createMockSelector(),
    getConfirmMode: () => 'auto',
    getDefaultWorktree: () => false,
    isMcpEnabledForCli: () => true,
    settleDelayMs: 0,
  });
  t.after(() => service.dispose());

  // Pane orchestration mode toggle reflected in snapshot.
  assert.equal(service.isPaneOrchestrationMode('local-coord'), false);
  service.setPaneOrchestrationMode('local-coord', true);
  assert.equal(service.isPaneOrchestrationMode('local-coord'), true);
  assert.deepEqual(service.getSnapshot().orchestrationModePanes, ['local-coord']);

  // delegateTask requests codex (fails spawn) -> automatically falls back to next candidate (claude)!
  const delegated = await service.delegateTask({
    from: 'local-coord',
    role: 'debugger',
    task: 'Trace memory leak',
    agent: 'codex',
    worktree: false,
  });
  assert.equal(delegated.status, 'started');
  assert.equal(delegated.fallbackFrom, 'codex');
  assert.equal(delegated.agent, 'claude');
  assert.equal(store.listTasks().length, 1, 'fallback must reuse task without creating orphans');

  const cap = store.getDispatchCapability(delegated.dispatch.id);
  const deliveredText = writtenPrompts.map((w) => w.data).join('\n');
  assert.equal(deliveredText.includes(cap), false, 'MCP worker PTY must not receive plain-text capability');
  assert.match(deliveredText, /\[Worker @debugger\]/);

  // Worker calls askCoordinatorByPane (server attaches capability automatically).
  const askPromise = service.askCoordinatorByPane(delegated.ptyId, {
    question: 'Keep legacy API?',
    wait: true,
    timeoutMs: 3_000,
  });
  await new Promise((r) => setTimeout(r, 15));

  // Coordinator replies by semantic @role via messageWorkerByRole.
  const replyRes = await service.messageWorkerByRole('local-coord', {
    role: '@debugger',
    questionId: store.listQuestions({ dispatchId: delegated.dispatch.id, status: 'pending' })[0].messageId,
    message: 'Yes, preserve v1',
  });
  assert.equal(replyRes.mode, 'replied');
  const askRes = await askPromise;
  assert.equal(askRes.answer, 'Yes, preserve v1');

  // Worker completes via workerDoneByPane (no capability arg needed!).
  const doneRes = await service.workerDoneByPane(delegated.ptyId, {
    outcome: 'completed',
    summary: 'Leak fixed and verified',
  });
  assert.equal(doneRes.dispatch.status, 'completed');
  assert.equal(doneRes.task.status, 'completed');
});

test('Stdio MCP server (aha-mcp-server.cjs): outside AhaStation returns [], inside AhaStation serves coordinator & worker tools end-to-end', async (t) => {
  // 1. Without AHA_TERMINAL_ID: initialize succeeds, tools/list returns [] (test both newline & Content-Length framing).
  for (const framing of ['newline', 'content-length']) {
    const client = spawnMcpClient(t, {}, framing);
    const initRes = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0.1.0' },
    });
    assert.equal(initRes.result.protocolVersion, '2024-11-05');
    assert.equal(initRes.result.serverInfo.name, 'aha-orchestration');
    client.notify('notifications/initialized', {});

    const listRes = await client.request('tools/list', {});
    assert.deepEqual(listRes.result.tools, [], `tools/list without AHA_TERMINAL_ID (${framing}) must be []`);
  }

  // 2. Live AgentHookServer + OrchestrationService (maxDepth: 1 so worker gets exactly 2 tools).
  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: process.cwd(), cliId: 'claude' });

  agentStatusStore.registerPane('local-idle-codex', { agentId: 'codex' });
  tracker.registerPty({ ptyId: 'local-idle-codex', cwd: process.cwd(), cliId: 'codex' });
  let spawnSeq = 0;
  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async (opts) => {
      spawnSeq += 1;
      const ptyId = `local-mcp-w${spawnSeq}`;
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId });
      tracker.registerPty({ ptyId, cwd: opts.cwd || process.cwd(), cliId: opts.cliId });
      tracker.ingestUtf8Data(ptyId, `Worker ${ptyId} booted\r\n`);
      return { ptyId, agentId: opts.cliId, cwd: opts.cwd };
    },
    closeWorkerPty: async (ptyId) => {
      tracker.markExited(ptyId, 0);
      agentStatusStore.removePane(ptyId);
      return { ok: true };
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    listCodingAgents: () => makeSampleRoster(),
    selectAgentForTask: createMockSelector(),
    getConfirmMode: () => 'chat-and-guard',
    getDefaultWorktree: () => false,
    isMcpEnabledForCli: () => true,
    maxDepth: 1,
    settleDelayMs: 0,
  });
  t.after(() => service.dispose());

  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setOrchestrationHandler((action, payload, context) =>
    dispatchOrchestrationHttpAction(service, action, payload, context)
  );
  await hookServer.start();
  t.after(() => hookServer.stop());

  const coordEnv = hookServer.envForPane('local-coord');
  const coordClient = spawnMcpClient(t, coordEnv, 'newline');
  await coordClient.request('initialize', { protocolVersion: '2024-11-05' });

  // Coordinator gets 13 tools (including shared board + diff/integrate + Phase 2 run diff/finalize tools) with dynamic agent enum.
  const coordToolsRes = await coordClient.request('tools/list', {});
  const coordToolNames = coordToolsRes.result.tools.map((tool) => tool.name);
  assert.deepEqual(coordToolNames, [
    'list_coding_agents',
    'delegate_task',
    'team_status',
    'post_message',
    'read_board',
    'board_wait',
    'team_wait',
    'message_worker',
    'manage_worker',
    'inspect_worker_diff',
    'integrate_worker',
    'inspect_run_diff',
    'finalize_run_integration',
  ]);
  const delegateTool = coordToolsRes.result.tools.find((tool) => tool.name === 'delegate_task');
  assert.equal(delegateTool.inputSchema.properties.reviewRun?.type, 'boolean', 'reviewRun uses flat boolean JSON Schema for Gemini/Codex MCP compatibility');
  assert.equal(delegateTool.inputSchema.properties.reviewRun?.oneOf, undefined, 'reviewRun must not use oneOf');
  const integrateTool = coordToolsRes.result.tools.find((tool) => tool.name === 'integrate_worker');
  assert.deepEqual(integrateTool.inputSchema.properties.targetBranch.enum, [
    'main',
    'integration',
    'auto',
  ]);
  assert.deepEqual(delegateTool.inputSchema.properties.agent.enum, [
    'auto',
    'claude',
    'codex',
    'grok',
  ]);
  assert.match(delegateTool.description, /codex/i);
  assert.match(delegateTool.description, /idle pane/i);
  assert.match(delegateTool.description, /confirmed=false/);
  assert.match(delegateTool.description, /confirmed=true/);

  // tools/call: list_coding_agents
  const agentsCall = await coordClient.request('tools/call', {
    name: 'list_coding_agents',
    arguments: {},
  });
  assert.equal(agentsCall.result.isError, undefined);
  assert.match(agentsCall.result.content[0].text, /codex/);
  assert.match(agentsCall.result.content[0].text, /not-installed/);

  // tools/call: inspect_run_diff & finalize_run_integration before any run/integration return clean responses.
  const emptyRunDiffCall = await coordClient.request('tools/call', {
    name: 'inspect_run_diff',
    arguments: {},
  });
  assert.equal(emptyRunDiffCall.result.isError, true);
  assert.match(emptyRunDiffCall.result.content[0].text, /run_not_found|not part of any/i);

  const emptyFinalizeCall = await coordClient.request('tools/call', {
    name: 'finalize_run_integration',
    arguments: { mode: 'check' },
  });
  assert.equal(emptyFinalizeCall.result.isError, true);
  assert.match(emptyFinalizeCall.result.content[0].text, /run_not_found|not part of any/i);

  // tools/call: delegate_task on Turn 1 -> blocked by chat-and-guard even with empty optional strings & snake_case aliases!
  service.recordUserPromptTurn('local-coord', 'pty');
  const blockedCall = await coordClient.request('tools/call', {
    name: 'delegate_task',
    arguments: {
      role: 'reviewer',
      task: 'Review auth middleware',
      agent: '',
      task_kind: 'review',
      plan_summary: 'Codex reviews auth middleware',
      background: 'Review the existing middleware contract',
      taskContext: { constraints: ['Read-only audit'] },
      model: '',
      effort: '   ',
      terminal: '',
      worktree: false,
      confirmed: true,
    },
  });
  assert.equal(blockedCall.result.isError, undefined);
  assert.match(blockedCall.result.content[0].text, /尚未经用户确认派发/);
  assert.match(blockedCall.result.content[0].text, /Agent: codex/);

  // User confirms (Turn 2) -> delegate_task succeeds with snake_case aliases & blank optional strings stripped!
  service.recordUserPromptTurn('local-coord', 'pty');
  const startedCall = await coordClient.request('tools/call', {
    name: 'delegate_task',
    arguments: {
      role: 'reviewer',
      task: 'Review auth middleware',
      agent: 'codex',
      task_kind: 'review',
      model: '',
      effort: '',
      terminal: '',
      worktree: false,
      confirmed: true,
    },
  });
  assert.equal(startedCall.result.isError, undefined);
  assert.match(startedCall.result.content[0].text, /Dispatch sent; start unconfirmed \(@reviewer\)/);
  const workerPtyId = 'local-mcp-w1';
  const firstWorker = service.store.getActiveDispatchForIdentity(workerPtyId, workerPtyId);
  assert.deepEqual(service.store.getTask(firstWorker.taskId).taskContext, {
    background: 'Review the existing middleware contract',
    constraints: ['Read-only audit'],
  });

  // Coordinator team_status lists @reviewer (including snake_case include_settled).
  const statusCall = await coordClient.request('tools/call', {
    name: 'team_status',
    arguments: { include_settled: false },
  });
  assert.match(statusCall.result.content[0].text, /@reviewer/);

  // Spawn worker MCP client for local-mcp-w1 -> gets worker tools (report_done, ask_coordinator + shared board tools).
  const workerEnv = hookServer.envForPane(workerPtyId);
  const workerClient = spawnMcpClient(t, workerEnv, 'newline');
  await workerClient.request('initialize', { protocolVersion: '2024-11-05' });
  const workerToolsRes = await workerClient.request('tools/list', {});
  assert.deepEqual(
    workerToolsRes.result.tools.map((tool) => tool.name),
    ['report_done', 'ask_coordinator', 'post_message', 'read_board', 'board_wait']
  );

  // Worker calls ask_coordinator -> Coordinator replies via message_worker -> Worker gets answer!
  const first = await workerClient.request('tools/call', {
    name: 'ask_coordinator', arguments: { question: 'Keep v1 API?', wait: false },
  });
  assert.equal(first.result.isError, undefined);
  const firstBoard = await coordClient.request('tools/call', { name: 'read_board', arguments: {} });
  const peek = await coordClient.request('tools/call', { name: 'team_wait', arguments: { peek: true } });
  assert.doesNotMatch(peek.result.content[0].text, /Keep v1 API\?/);
  const sinceFirstQuestion = Number(/head=#(\d+)/.exec(firstBoard.result.content[0].text)[1]);
  const workerAskPromise = workerClient.request('tools/call', {
    name: 'ask_coordinator',
    arguments: {
      question: 'Should I check token expiry too?',
      wait: true,
      timeoutMs: 5_000,
    },
  });
  const questionPost = await coordClient.request('tools/call', {
    name: 'board_wait', arguments: { since: sinceFirstQuestion, timeoutMs: 2000 },
  });
  const questionId = /questionId: (\S+)\s+Should I check token expiry too\?/.exec(questionPost.result.content[0].text)?.[1];
  assert.ok(questionId, questionPost.result.content[0].text);
  const steering = await coordClient.request('tools/call', {
    name: 'message_worker', arguments: { role: '@reviewer', message: 'Please post progress later.', questionId: '   ' },
  });
  assert.equal(steering.result.isError, undefined);
  const steeringSeq = Number(/#(\d+)/.exec(steering.result.content[0].text)?.[1]);
  assert.ok(steeringSeq, steering.result.content[0].text);
  const [steeringPost] = service.store.listBoardPosts(firstWorker.runId, { seqs: [steeringSeq] });
  assert.ok(steeringPost);

  const plainProgress = await workerClient.request('tools/call', {
    name: 'post_message',
    arguments: { text: 'Halfway through auth checks', replyTo: '   ', reply_to: null },
  });
  assert.equal(plainProgress.result.isError, undefined);

  const steeringReply = await workerClient.request('tools/call', {
    name: 'post_message',
    arguments: { text: 'Will post final summary shortly.', reply_to: ' #' + steeringSeq + ' ' },
  });
  assert.equal(steeringReply.result.isError, undefined);
  assert.match(steeringReply.result.content[0].text, /Woke: @coordinator/);
  assert.equal(service.store.getMessageById(steeringPost.id).receipts.reviewer, 'replied');
  const consumeReply = await coordClient.request('tools/call', {
    name: 'board_wait', arguments: { timeoutMs: 2_000 },
  });
  assert.match(consumeReply.result.content[0].text, /Will post final summary shortly\./);

  const coordReplyCall = await coordClient.request('tools/call', {
    name: 'message_worker',
    arguments: {
      role: '@reviewer',
      question_id: ' ' + questionId + ' ',
      message: 'Yes, include expiry checks.',
      subject: '   ',
    },
  });
  assert.equal(coordReplyCall.result.isError, undefined);
  assert.match(coordReplyCall.result.content[0].text, /Answered pending question/);

  const workerAskRes = await workerAskPromise;
  assert.match(workerAskRes.result.content[0].text, /Yes, include expiry checks\./);
  const remaining = await coordClient.request('tools/call', {
    name: 'team_status', arguments: {},
  });
  assert.match(remaining.result.content[0].text, /1 pending question/);

  // Coordinator starts team_wait (with snake_case timeout_ms), worker calls report_done -> coordinator wakes!
  const waitPromise = coordClient.request('tools/call', {
    name: 'team_wait',
    arguments: { timeout_ms: 5_000 },
  });
  await new Promise((r) => setTimeout(r, 40));

  const doneCall = await workerClient.request('tools/call', {
    name: 'report_done',
    arguments: { outcome: 'completed', summary: 'Auth review passed with 0 issues' },
  });
  assert.equal(doneCall.result.isError, undefined);
  assert.match(doneCall.result.content[0].text, /Completion report recorded/);

  const waitRes = await waitPromise;
  assert.match(waitRes.result.content[0].text, /Auth review passed with 0 issues/);

  // Coordinator reads & releases @reviewer via manage_worker.
  const readCall = await coordClient.request('tools/call', {
    name: 'manage_worker',
    arguments: { role: '@reviewer', action: 'read' },
  });
  assert.match(readCall.result.content[0].text, /Worker local-mcp-w1 booted/);

  const releaseCall = await coordClient.request('tools/call', {
    name: 'manage_worker',
    arguments: { role: '@reviewer', action: 'release' },
  });
  assert.match(releaseCall.result.content[0].text, /Released worker/);
});

test('AgentHookServer userPromptInterceptor returns hookStdout JSON on UserPromptSubmit, and router/preload contracts hold', async (t) => {
  const statusStore = new AgentStatusStore();
  const server = new AgentHookServer(statusStore);
  const seen = [];
  server.setUserPromptInterceptor((req) => {
    seen.push(req);
    return {
      hookStdout: formatAdditionalContextHookStdout(
        req.provider,
        req.eventName,
        'Orchestration mode active: use MCP delegate_task.'
      ),
    };
  });
  const { port, token } = await server.start();
  t.after(() => server.stop());

  statusStore.registerPane('pane-hook', { agentId: 'claude' });
  const res = await fetch(`http://127.0.0.1:${port}/hook/claude?ptyId=pane-hook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aha-agent-hook-token': token,
    },
    body: JSON.stringify({
      hook_event_name: 'UserPromptSubmit',
      prompt: 'Split this into frontend and backend workers',
    }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(typeof body.hookStdout, 'string');
  const parsedStdout = JSON.parse(body.hookStdout);
  assert.equal(parsedStdout.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(
    parsedStdout.hookSpecificOutput.additionalContext,
    /Orchestration mode active/
  );
  const codexHookStdout = JSON.parse(
    formatAdditionalContextHookStdout('codex', 'UserPromptSubmit', 'Use MCP delegate_task.')
  );
  assert.deepEqual(codexHookStdout, {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: 'Use MCP delegate_task.',
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ptyId, 'pane-hook');
  assert.equal(seen[0].provider, 'claude');
  assert.equal(seen[0].eventName, 'UserPromptSubmit');
  assert.equal(seen[0].promptText, 'Split this into frontend and backend workers');

  // Verify HTTP long-poll helper & preload bridge surface.
  assert.equal(isLongPollOrchestrationAction('delegate-task'), true);
  assert.equal(isLongPollOrchestrationAction('ask-self'), true);
  assert.equal(isLongPollOrchestrationAction('agents'), false);

  const preloadSrc = readFileSync(resolve('electron/preload.cjs'), 'utf8');
  assert.match(preloadSrc, /orchestrationSettings:\s*\{/);
  assert.match(preloadSrc, /settings:get-orchestration/);
  assert.match(preloadSrc, /settings:set-orchestration/);
  assert.match(preloadSrc, /settings:orchestration-changed/);
  assert.match(preloadSrc, /agentMcp:\s*\{/);
  assert.match(preloadSrc, /agent-mcp:status/);
  assert.match(preloadSrc, /agent-mcp:install/);
  assert.match(preloadSrc, /agent-mcp:uninstall/);
  assert.match(preloadSrc, /setPaneMode:.*orchestration:set-pane-mode/);
  assert.match(preloadSrc, /listAgents:.*orchestration:list-agents/);
  assert.match(preloadSrc, /delegateTask:.*orchestration:delegate-task/);
  assert.match(preloadSrc, /proposalApprove:.*orchestration:proposal-approve/);
  assert.match(preloadSrc, /proposalReject:.*orchestration:proposal-reject/);

  // Verify DispatchProposalManager standalone expiry works cleanly.
  const mgr = new DispatchProposalManager({ holdTimeoutMs: 250 });
  const expRes = await mgr.createHeldProposal({
    coordinatorPaneId: 'p1',
    runId: null,
    role: 'exp',
    task: 'Timeout test',
    planSummary: 'Timeout test',
    requestedAgent: 'auto',
    resolvedAgent: 'claude',
    taskKind: null,
    worktree: false,
    model: null,
    effort: null,
    terminal: null,
  });
  assert.equal(expRes.decision, 'expired');
  assert.equal(expRes.proposal.status, 'expired');
  mgr.dispose();

  // Verify mergeCliLaunchArgs prepends MCP args and avoids duplicating explicit --mcp-config / mcp_servers.aha.
  assert.deepEqual(
    mergeCliLaunchArgs(['--mcp-config', '/tmp/claude.json'], ['--model', 'opus']),
    ['--mcp-config', '/tmp/claude.json', '--model', 'opus']
  );
  assert.deepEqual(
    mergeCliLaunchArgs(['--mcp-config', '/tmp/claude.json'], ['--mcp-config', '/custom.json']),
    ['--mcp-config', '/custom.json']
  );
  assert.deepEqual(
    mergeCliLaunchArgs(
      ['-c', 'mcp_servers.aha.command="node"', '-c', 'mcp_servers.aha.args=["/a.cjs"]'],
      ['-m', 'gpt-5.4']
    ),
    ['-c', 'mcp_servers.aha.command="node"', '-c', 'mcp_servers.aha.args=["/a.cjs"]', '-m', 'gpt-5.4']
  );
});

test('Stdio MCP server Phase 2 happy path: integrate_worker(targetBranch="integration") -> inspect_run_diff -> delegate_task(reviewRun=true) -> finalize_run_integration', async (t) => {
  const execFile = promisify(execFileCb);
  const git = async (cwd, ...args) => {
    const { stdout } = await execFile('git', args, { cwd, windowsHide: true });
    return stdout.trim();
  };
  const root = mkdtempSync(join(tmpdir(), 'aha-mcp-phase2-'));
  const repo = join(root, 'repo');
  mkdirSync(repo, { recursive: true });
  let mcpChildToClose = null;
  t.after(async () => {
    if (mcpChildToClose && mcpChildToClose.exitCode === null) {
      await new Promise((resolveExit) => {
        mcpChildToClose.once('exit', resolveExit);
        mcpChildToClose.kill();
        setTimeout(resolveExit, 1000).unref();
      });
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  await git(repo, 'init', '-b', 'main');
  await git(repo, 'config', 'user.name', 'Test User');
  await git(repo, 'config', 'user.email', 'test@example.com');
  writeFileSync(join(repo, 'README.md'), '# MCP Phase 2\n', 'utf8');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-m', 'init');

  // Dirty main workspace forces Run integration branch usage.
  writeFileSync(join(repo, 'user-wip.txt'), 'uncommitted user work\n', 'utf8');

  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  agentStatusStore.registerPane('local-coord', { agentId: 'claude' });
  tracker.registerPty({ ptyId: 'local-coord', cwd: repo, cliId: 'claude' });

  let spawnSeq = 0;
  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async (opts) => {
      spawnSeq += 1;
      const ptyId = `local-mcp-p2-w${spawnSeq}`;
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId });
      tracker.registerPty({ ptyId, cwd: opts.cwd || repo, cliId: opts.cliId });
      tracker.ingestUtf8Data(ptyId, `Worker ${ptyId} booted\r\n`);
      return { ptyId, agentId: opts.cliId, cwd: opts.cwd };
    },
    closeWorkerPty: async (ptyId) => {
      tracker.markExited(ptyId, 0);
      agentStatusStore.removePane(ptyId);
      return { ok: true };
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    listCodingAgents: () => makeSampleRoster(),
    selectAgentForTask,
    getConfirmMode: () => 'auto',
    getDefaultWorktree: () => true,
    getDefaultCwd: () => repo,
    isMcpEnabledForCli: () => true,
    maxDepth: 1,
    settleDelayMs: 0,
  });
  t.after(() => service.dispose());

  const run = store.createRun({
    objective: 'MCP Phase 2 E2E',
    coordinatorHandle: 'local-coord',
    coordinatorPaneId: 'local-coord',
  });

  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setOrchestrationHandler((action, payload, context) =>
    dispatchOrchestrationHttpAction(service, action, payload, context)
  );
  await hookServer.start();
  t.after(() => hookServer.stop());

  const coordClient = spawnMcpClient(t, hookServer.envForPane('local-coord'), 'newline', repo);
  mcpChildToClose = coordClient.child;
  await coordClient.request('initialize', { protocolVersion: '2024-11-05' });

  // 1. Delegate L0 docs worker via MCP and complete it.
  const delRes = await coordClient.request(
    'tools/call',
    {
      name: 'delegate_task',
      arguments: {
        role: 'docs',
        task: 'Add guide.md',
        agent: 'codex',
        worktree: true,
      },
    },
    30_000,
  );
  assert.equal(delRes.result.isError, undefined, delRes.result.content[0].text);
  const wDispatch = store.listDispatches({ runId: run.id }).find((d) => d.assigneePaneId === 'local-mcp-p2-w1');
  assert.ok(wDispatch?.worktreePath);
  writeFileSync(join(wDispatch.worktreePath, 'guide.md'), '# Guide\n', 'utf8');
  await service.workerDoneByPane(wDispatch.assigneePaneId, { outcome: 'completed', summary: 'Added guide.md' });

  // 2. Integrate via MCP with targetBranch="integration" -> aha/run/<runId> created, dirty main untouched.
  const intCall = await coordClient.request(
    'tools/call',
    {
      name: 'integrate_worker',
      arguments: {
        role: 'docs',
        mode: 'squash',
        targetBranch: 'integration',
      },
    },
    30_000,
  );
  assert.equal(intCall.result.isError, undefined, intCall.result.content[0].text);
  assert.match(intCall.result.content[0].text, new RegExp(`aha/run/${run.id}`));
  assert.match(intCall.result.content[0].text, /finalize_run_integration/);
  assert.equal(readFileSync(join(repo, 'user-wip.txt'), 'utf8'), 'uncommitted user work\n');

  // 3. Inspect combined Run diff via MCP.
  const diffCall = await coordClient.request(
    'tools/call',
    {
      name: 'inspect_run_diff',
      arguments: {},
    },
    30_000,
  );
  assert.equal(diffCall.result.isError, undefined, diffCall.result.content[0].text);
  assert.match(diffCall.result.content[0].text, /integration=active/);
  assert.match(diffCall.result.content[0].text, /guide\.md/);

  // 4. Launch Run-level adversarial review via MCP delegate_task(reviewRun=true) -> heterogeneous avoidance of codex.
  const revCall = await coordClient.request(
    'tools/call',
    {
      name: 'delegate_task',
      arguments: {
        reviewRun: true,
        reviewFocus: 'docs & completeness',
      },
    },
    30_000,
  );
  assert.equal(revCall.result.isError, undefined, revCall.result.content[0].text);
  const revDispatch = store.listReviewDispatchesForRun(run.id)[0];
  assert.ok(revDispatch);
  assert.notEqual(revDispatch.cliId, 'codex', 'Run reviewer must avoid codex author CLI');
  await service.workerDoneByPane(revDispatch.assigneePaneId, {
    outcome: 'completed',
    verdict: 'pass',
    summary: 'Combined Run changes verified clean.',
  });

  // 5. Clean dirty main and finalize via MCP finalize_run_integration(mode="squash").
  rmSync(join(repo, 'user-wip.txt'));
  const finCall = await coordClient.request(
    'tools/call',
    {
      name: 'finalize_run_integration',
      arguments: { mode: 'squash' },
    },
    30_000,
  );
  assert.equal(finCall.result.isError, undefined, finCall.result.content[0].text);
  assert.match(finCall.result.content[0].text, /Cleaned up run integration worktree/);
  assert.equal(existsSync(join(repo, 'guide.md')), true);
  assert.equal(store.requireRun(run.id).integrationStatus, 'finalized');
});
