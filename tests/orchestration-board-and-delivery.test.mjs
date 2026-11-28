import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  AgentHookServer,
  formatPostToolContextHookStdout,
  supportsPostToolContextInjection,
} from '../dist-electron/agent/agent-hook-server.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import {
  dispatchOrchestrationHttpAction,
  isLongPollOrchestrationAction,
} from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { TerminalRuntimeTracker } from '../dist-electron/terminal-runtime-tracker.js';

const MCP_SERVER_PATH = resolve('electron/orchestration/aha-mcp-server.cjs');

function makeRoster() {
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
      specialty: 'Verification & tests',
      defaultModel: 'gpt-5.4',
      defaultEffort: 'high',
      hooksInstalled: true,
      mcpMode: 'launch-arg',
      mcpReady: true,
      idlePanes: [],
    },
    {
      cliId: 'grok',
      label: 'Grok CLI',
      command: 'grok',
      installed: true,
      enabled: true,
      available: true,
      specialty: 'Fast exploration',
      defaultModel: null,
      defaultEffort: null,
      hooksInstalled: true,
      mcpMode: 'config',
      mcpReady: true,
      idlePanes: [],
    },
  ];
}

function makeSelector() {
  return ({ roster, requestedAgent }) => {
    const available = roster.filter((a) => a.available);
    const req = (requestedAgent || '').trim().toLowerCase();
    const match =
      (req && req !== 'auto' ? available.find((a) => a.cliId === req) : null) ?? available[0];
    return {
      cliId: match.cliId,
      reason: 'test-selector',
      model: match.defaultModel,
      effort: match.defaultEffort,
      idlePaneId: null,
      fallbacks: available.filter((a) => a.cliId !== match.cliId).map((a) => a.cliId),
    };
  };
}

function createHarness(t, opts = {}) {
  const agentStatusStore = new AgentStatusStore();
  const tracker = new TerminalRuntimeTracker();
  const writtenPty = [];
  let spawnSeq = 0;

  const coordPaneId = opts.coordPaneId ?? 'local-coord';
  agentStatusStore.registerPane(coordPaneId, { agentId: 'claude' });
  tracker.registerPty({
    ptyId: coordPaneId,
    cwd: opts.defaultCwd ?? process.cwd(),
    cliId: 'claude',
  });

  const store = opts.store ?? new OrchestrationStore();
  let peerMode = opts.peerMessagingMode ?? 'controlled-p2p';

  const service = new OrchestrationService({
    store,
    agentStatusStore,
    terminalTracker: tracker,
    writePty: async (ptyId, data) => {
      writtenPty.push({ ptyId, data });
      return { ok: true };
    },
    spawnWorkerPty: async (spawnOpts) => {
      spawnSeq += 1;
      const ptyId = `local-w${spawnSeq}`;
      const cwd = spawnOpts.cwd || opts.defaultCwd || process.cwd();
      agentStatusStore.registerPane(ptyId, { agentId: spawnOpts.cliId || 'claude' });
      tracker.registerPty({ ptyId, cwd, cliId: spawnOpts.cliId || 'claude' });
      return { ptyId, agentId: spawnOpts.cliId || 'claude', cwd };
    },
    closeWorkerPty: async (ptyId) => {
      tracker.markExited(ptyId, 0);
      agentStatusStore.removePane(ptyId);
      return { ok: true };
    },
    isPtyAlive: (ptyId) => tracker.isAlive(ptyId),
    listCodingAgents: () => makeRoster(),
    selectAgentForTask: makeSelector(),
    getConfirmMode: () => 'auto',
    getDefaultWorktree: () => false,
    getPeerMessagingMode: () => peerMode,
    isMcpEnabledForCli: opts.isMcpEnabledForCli ?? (() => true),
    getDefaultCwd: () => opts.defaultCwd ?? process.cwd(),
    now: opts.now,
    stallThresholdMs: opts.stallThresholdMs,
    stallWatchdogIntervalMs: 0,
    codexPilot: opts.codexPilot,
    settleDelayMs: 0,
  });

  t.after(() => service.dispose());

  return {
    coordPaneId,
    store,
    service,
    agentStatusStore,
    tracker,
    writtenPty,
    setPeerMode: (next) => {
      peerMode = next;
    },
  };
}

function spawnMcpClient(t, env) {
  const child = spawn(process.execPath, [MCP_SERVER_PATH], {
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

  child.stdout.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (true) {
      const nl = buf.indexOf(0x0a);
      if (nl === -1) break;
      const line = buf.subarray(0, nl).toString('utf8').replace(/\r$/, '').trim();
      buf = buf.subarray(nl + 1);
      if (!line) continue;
      const msg = JSON.parse(line);
      const handler = pending.get(msg.id);
      if (handler) {
        pending.delete(msg.id);
        handler.resolve(msg);
      }
    }
  });

  child.on('exit', () => {
    for (const [, handler] of pending) {
      handler.reject(new Error('MCP server exited before responding'));
    }
    pending.clear();
  });

  t.after(() => {
    try {
      child.kill();
    } catch {
      /* ignore */
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolveReq, rejectReq) => {
        pending.set(id, { resolve: resolveReq, reject: rejectReq });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
  };
}

test('OrchestrationStore boardSeq, member cursors, seqs lookup, persistence & legacy migration', (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), 'aha-board-store-'));
  t.after(() => rmSync(tempDir, { recursive: true, force: true }));
  const filePath = join(tempDir, 'orchestration-state.json');

  const store1 = new OrchestrationStore({ resolveFile: () => filePath });
  const run = store1.createRun({
    id: 'run_board_1',
    objective: 'Board persistence check',
    coordinatorHandle: 'local-coord',
    coordinatorPaneId: 'local-coord',
  });

  const m1 = store1.insertMessage({
    runId: run.id,
    from: 'local-coord',
    to: `run:${run.id}`,
    type: 'status',
    subject: 'Post 1',
    body: '@api start working',
    fromRole: 'coordinator',
    mentions: ['api'],
    kind: 'post',
  });
  const hb = store1.insertMessage({
    runId: run.id,
    from: 'dispatch:ctx_1',
    to: `run:${run.id}`,
    type: 'heartbeat',
    subject: 'hb',
    body: '',
  });
  const m2 = store1.insertMessage({
    runId: run.id,
    from: 'dispatch:ctx_1',
    to: `run:${run.id}`,
    type: 'handoff',
    subject: 'Post 2',
    body: '@verifier verify #1',
    fromRole: 'api',
    mentions: ['verifier'],
    refs: [1],
    kind: 'handoff',
  });

  assert.equal(m1.boardSeq, 1);
  assert.equal(hb.boardSeq, undefined, 'heartbeats must not allocate boardSeq');
  assert.equal(m2.boardSeq, 2);
  assert.equal(store1.getHeadBoardSeq(run.id), 2);
  assert.deepEqual(m2.mentions, ['verifier']);
  assert.deepEqual(m2.refs, [1]);

  // Cursor advancement is strictly monotonic.
  store1.advanceMemberCursor(run.id, 'api', { lastReadSeq: 2, lastDeliveredSeq: 2, lastPostSeq: 2 });
  store1.advanceMemberCursor(run.id, 'api', { lastReadSeq: 1, lastDeliveredSeq: 1 });
  const cursor = store1.getMemberCursor(run.id, 'api');
  assert.deepEqual(cursor, { lastReadSeq: 2, lastDeliveredSeq: 2, lastPostSeq: 2 });

  // listBoardPosts(since) vs listBoardPosts(seqs)
  assert.deepEqual(
    store1.listBoardPosts(run.id, { since: 1 }).map((m) => m.boardSeq),
    [2]
  );
  assert.deepEqual(
    store1.listBoardPosts(run.id, { seqs: [1, 999] }).map((m) => m.boardSeq),
    [1]
  );

  store1.recordBoardRead(run.id, '@API', [m2.id]);
  store1.advanceMemberCursor(run.id, 'watcher', { lastMentionReadSeq: 2 });
  store1.flushSync();
  store1.close();

  // Reload from disk: boardSeq and cursors survive cleanly.
  const store2 = new OrchestrationStore({ resolveFile: () => filePath });
  store2.load();
  t.after(() => store2.close());
  assert.equal(store2.getHeadBoardSeq(run.id), 2);
  assert.equal(store2.wasBoardPostRead(m2.id, 'api'), true);
  assert.equal(store2.wasBoardPostRead(m2.id, '@API'), true);
  assert.equal(store2.wasBoardPostRead(m1.id, 'api'), false);
  assert.equal(store2.getMemberCursor(run.id, 'watcher').lastMentionReadSeq, 2);
  assert.equal(store2.getMemberCursor(run.id, 'watcher').lastReadSeq, 0);
  assert.deepEqual(store2.getMemberCursor(run.id, 'api'), {
    lastReadSeq: 2,
    lastDeliveredSeq: 2,
    lastPostSeq: 2,
  });
  const m3 = store2.insertMessage({
    runId: run.id,
    from: 'local-coord',
    to: `run:${run.id}`,
    type: 'status',
    subject: 'Post 3',
    body: 'After reload',
    fromRole: 'coordinator',
    kind: 'post',
  });
  assert.equal(m3.boardSeq, 3);
  assert.deepEqual(store2.getSnapshot(run.id).memberCursorsByRun?.[run.id]?.api, {
    lastReadSeq: 2,
    lastDeliveredSeq: 2,
    lastPostSeq: 2,
  });

  // Legacy snapshot without boardSeq / nextBoardSeqByRun / memberCursorsByRun migrates cleanly.
  const legacyFile = join(tempDir, 'legacy-state.json');
  const legacySnapshot = {
    version: 1,
    nextSequence: 4,
    runs: [run],
    tasks: [],
    dispatches: [],
    gates: [],
    messages: [
      {
        id: 'msg_legacy_1',
        seq: 1,
        runId: run.id,
        fromHandle: 'local-coord',
        toHandle: `run:${run.id}`,
        type: 'status',
        priority: 'normal',
        subject: 'Legacy 1',
        body: 'Legacy body 1',
        payload: null,
        threadId: null,
        read: true,
        readBy: [],
        delivered: true,
        deliveredTo: [],
        lifecycleRejectedReason: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'msg_legacy_hb',
        seq: 2,
        runId: run.id,
        fromHandle: 'w1',
        toHandle: `run:${run.id}`,
        type: 'heartbeat',
        priority: 'low',
        subject: 'hb',
        body: '',
        payload: null,
        threadId: null,
        read: true,
        readBy: [],
        delivered: true,
        deliveredTo: [],
        lifecycleRejectedReason: null,
        createdAt: new Date().toISOString(),
      },
      {
        id: 'msg_legacy_2',
        seq: 3,
        runId: run.id,
        fromHandle: 'w1',
        toHandle: `run:${run.id}`,
        type: 'worker_done',
        priority: 'normal',
        subject: 'Legacy done',
        body: 'Done',
        payload: null,
        threadId: null,
        read: false,
        readBy: [],
        delivered: false,
        deliveredTo: [],
        lifecycleRejectedReason: null,
        createdAt: new Date().toISOString(),
      },
    ],
    deliveries: [],
    questions: [],
    coordinatorRuns: [],
    currentRunByConsumer: {},
  };
  writeFileSync(legacyFile, JSON.stringify(legacySnapshot), 'utf8');
  const legacyStore = new OrchestrationStore({ resolveFile: () => legacyFile });
  legacyStore.load();
  t.after(() => legacyStore.close());
  assert.equal(legacyStore.getHeadBoardSeq(run.id), 2);
  assert.deepEqual(
    legacyStore.listBoardPosts(run.id).map((m) => [m.id, m.boardSeq]),
    [
      ['msg_legacy_1', 1],
      ['msg_legacy_2', 2],
    ]
  );
});

test('Controlled P2P guardrails: peer handoff, ping-pong cap escalation, worker @all, hub-only redirect & settled sibling protection', async (t) => {
  const { coordPaneId, service, store, setPeerMode } = createHarness(t);

  const api = await service.delegateTask({
    from: coordPaneId,
    role: 'api',
    task: 'Implement API endpoints',
    agent: 'claude',
    worktree: false,
  });
  const verifier = await service.delegateTask({
    from: coordPaneId,
    role: 'verifier',
    task: 'Verify API endpoints',
    agent: 'codex',
    worktree: false,
  });
  assert.equal(api.status, 'started');
  assert.equal(verifier.status, 'started');
  const runId = api.run.id;

  // Round 1: @api -> @verifier direct handoff succeeds without escalating to coordinator.
  const r1 = await service.boardPost({
    from: api.ptyId,
    text: `@verifier schema landed in #${api.briefBoardSeq}, ready for review`,
  });
  assert.deepEqual(r1.woke, ['verifier']);
  assert.equal(r1.escalatedToCoordinator, false);
  assert.equal(r1.post.kind, 'handoff');
  assert.deepEqual(r1.post.refs, [api.briefBoardSeq]);

  // Round 2: @verifier -> @api direct reply succeeds without escalating.
  const r2 = await service.boardPost({
    from: verifier.ptyId,
    text: `@api found missing validation in #${r1.boardSeq}`,
  });
  assert.deepEqual(r2.woke, ['api']);
  assert.equal(r2.escalatedToCoordinator, false);

  // Round 3 (cap = 3): @api -> @verifier escalates automatically to @coordinator!
  const r3 = await service.boardPost({
    from: api.ptyId,
    text: `@verifier fixed validation from #${r2.boardSeq}, please re-check`,
  });
  assert.equal(r3.escalatedToCoordinator, true);
  assert.equal(r3.woke.includes('verifier'), true);
  assert.equal(r3.woke.includes('coordinator'), true);
  assert.equal(r3.post.mentions.includes('coordinator'), true);

  // Coordinator activity resets the ping-pong counter.
  await service.boardPost({
    from: coordPaneId,
    text: '@api @verifier continue with strict schema checks',
  });
  const afterReset = await service.boardPost({
    from: api.ptyId,
    text: '@verifier fresh round after coordinator check-in',
  });
  assert.equal(afterReset.escalatedToCoordinator, false);
  assert.deepEqual(afterReset.woke, ['verifier']);

  // Worker @all is posted publicly on the board but NEVER wakes peers or coordinator.
  const workerAll = await service.boardPost({
    from: api.ptyId,
    text: '@all FYI API contract v2 is frozen',
  });
  assert.deepEqual(workerAll.woke, []);
  assert.deepEqual(workerAll.post.mentions, ['all']);
  assert.equal(workerAll.escalatedToCoordinator, false);

  // hub-only mode redirects peer handoff to @coordinator instead of waking sibling directly.
  setPeerMode('hub-only');
  const hubOnly = await service.boardPost({
    from: api.ptyId,
    text: '@verifier please check auth header',
  });
  assert.equal(hubOnly.escalatedToCoordinator, true);
  assert.deepEqual(hubOnly.woke, ['coordinator']);
  assert.equal(hubOnly.woke.includes('verifier'), false);
  assert.match(hubOnly.post.body, /Hub-only mode/i);
  setPeerMode('controlled-p2p');

  // Settled sibling cannot be reactivated or woken by another worker.
  await service.workerDoneByPane(verifier.ptyId, {
    outcome: 'completed',
    summary: 'Verification complete',
  });
  const dispatchCountBefore = store.listDispatches({ runId }).length;
  const pokeSettled = await service.boardPost({
    from: api.ptyId,
    text: '@verifier can you run one more check?',
  });
  assert.deepEqual(pokeSettled.woke, []);
  assert.equal(
    store.listDispatches({ runId }).length,
    dispatchCountBefore,
    'worker mention must never reactivate a settled sibling'
  );
});

test('boardWait(since, mentionsOnly), boardRead(seqs), privileged question answer & reactivation, and HTTP anti-spoof', async (t) => {
  const { coordPaneId, service, store } = createHarness(t);

  const api = await service.delegateTask({
    from: coordPaneId,
    role: 'api',
    task: 'Build payments endpoint',
    agent: 'claude',
    worktree: false,
  });
  const runId = api.run.id;
  const coordCursorBefore = store.getMemberCursor(runId, 'coordinator').lastReadSeq;

  // Worker posts while coordinator is busy -> boardWait(since) wakes immediately without sleeping through it!
  const earlyPost = await service.boardPost({
    from: api.ptyId,
    text: '@coordinator payment webhook signature needs confirmation',
  });
  const waitImmediate = await service.boardWait({
    from: coordPaneId,
    since: coordCursorBefore,
    timeoutMs: 2_000,
  });
  assert.equal(waitImmediate.timedOut, false);
  assert.equal(waitImmediate.posts.some((p) => p.boardSeq === earlyPost.boardSeq), true);
  assert.match(waitImmediate.teamSummary, /Board head=#/);
  assert.equal(waitImmediate.lastReadSeq, earlyPost.boardSeq);

  // Named seqs lookup does NOT change lastReadSeq (or advance past other posts).
  const unaddressed = await service.boardPost({
    from: api.ptyId,
    text: 'Internal progress note without mentions',
  });
  const namedLookup = service.boardRead({
    from: coordPaneId,
    seqs: [api.briefBoardSeq],
  });
  assert.equal(namedLookup.posts.length, 1);
  assert.equal(namedLookup.posts[0].boardSeq, api.briefBoardSeq);
  assert.equal(
    store.getMemberCursor(runId, 'coordinator').lastReadSeq,
    coordCursorBefore,
    'read_board(seqs=[...]) must not advance lastReadSeq'
  );

  // Unaddressed worker post does NOT wake coordinator on mentionsOnly: true, DOES wake on mentionsOnly: false!
  const waitMentionsOnly = await service.boardWait({
    from: coordPaneId,
    since: earlyPost.boardSeq,
    mentionsOnly: true,
    timeoutMs: 40,
  });
  assert.equal(waitMentionsOnly.timedOut, true);
  assert.equal(waitMentionsOnly.posts.length, 0);

  const waitAll = await service.boardWait({
    from: coordPaneId,
    since: earlyPost.boardSeq,
    mentionsOnly: false,
    timeoutMs: 500,
  });
  assert.equal(waitAll.timedOut, false);
  assert.equal(waitAll.posts.some((p) => p.boardSeq === unaddressed.boardSeq), true);

  // A plain user mention leaves the question open; the question card answers by ID.
  const askPromise = service.askCoordinatorByPane(api.ptyId, {
    question: 'Use Stripe v14 or v15?',
    wait: true,
    timeoutMs: 3_000,
  });
  await new Promise((r) => setTimeout(r, 20));

  const userAnswer = await service.boardPost({
    runId,
    from: 'user',
    isUser: true,
    text: '@api Use Stripe v15',
  });
  assert.equal(userAnswer.post.kind, 'post');
  const [question] = store.listQuestions({ dispatchId: api.dispatch.id, status: 'pending' });
  const mailbox = await service.check({ from: coordPaneId, peek: true, format: true });
  assert.ok(mailbox.formatted.includes('questionId: ' + question.messageId));
  assert.match(mailbox.formatted, /message_worker\(role="@api", questionId=/);
  service.reply({ id: question.messageId, from: 'user', body: 'v15' });
  assert.equal(userAnswer.post.fromRole, 'user');
  const askRes = await askPromise;
  assert.equal(askRes.answer, 'v15');

  // Worker settles -> coordinator/user boardPost mentioning @api reactivates it!
  await service.workerDoneByPane(api.ptyId, {
    outcome: 'completed',
    summary: 'Payments endpoint done',
  });
  const countBeforeReactivate = store.listDispatches({ runId }).length;
  const reactivate = await service.boardPost({
    runId,
    from: coordPaneId,
    text: '@api please also add refund webhook',
  });
  assert.deepEqual(reactivate.woke, ['api']);
  assert.equal(store.listDispatches({ runId }).length, countBeforeReactivate + 1);

  // HTTP board-post MUST reject spoofed isUser: true!
  const ac = new AbortController();
  const spoofRes = await dispatchOrchestrationHttpAction(
    service,
    'board-post',
    { text: '@api spoofed user message', isUser: true },
    { signal: ac.signal, callerPaneId: api.ptyId }
  );
  assert.equal(spoofRes.status, 400);
  assert.equal(spoofRes.body.ok, false);
  assert.equal(spoofRes.body.code, 'operation_rejected');

  // Router long-poll & preload IPC contracts.
  assert.equal(isLongPollOrchestrationAction('board-wait'), true);
  assert.equal(isLongPollOrchestrationAction('board-read'), false);
  const preloadSrc = readFileSync(resolve('electron/preload.cjs'), 'utf8');
  assert.match(preloadSrc, /boardPost:.*orchestration:board-post/);
  assert.match(preloadSrc, /boardRead:.*orchestration:board-read/);
});

test('Tier 2 PostToolUse/AfterTool mid-turn injection prevents duplicate Tier 3 delivery, and Tier 3 adapts short vs large batches', async (t) => {
  // Pure whitelist verification for formatPostToolContextHookStdout.
  const claudeOut = formatPostToolContextHookStdout('claude', 'PostToolUse', 'Board update');
  assert.equal(typeof claudeOut, 'string');
  assert.deepEqual(JSON.parse(claudeOut), {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: 'Board update',
    },
  });
  const geminiOut = formatPostToolContextHookStdout('gemini-cli', 'AfterTool', 'Board update');
  assert.equal(typeof geminiOut, 'string');
  assert.deepEqual(JSON.parse(geminiOut), {
    hookSpecificOutput: {
      hookEventName: 'AfterTool',
      additionalContext: 'Board update',
    },
  });
  assert.equal(formatPostToolContextHookStdout('codex', 'PostToolUse', 'x'), undefined);
  assert.equal(formatPostToolContextHookStdout('claude', 'PreToolUse', 'x'), undefined);
  assert.equal(formatPostToolContextHookStdout('opencode', 'PostToolUse', 'x'), undefined);

  const { coordPaneId, service, store, agentStatusStore, writtenPty } = createHarness(t);

  const api = await service.delegateTask({
    from: coordPaneId,
    role: 'api',
    task: 'Implement cache layer',
    agent: 'claude',
    worktree: false,
  });

  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setPostToolInterceptor((req) => {
    const text = service.consumeMidTurnBoardInjections(req.ptyId);
    if (!text) return null;
    const hookStdout = formatPostToolContextHookStdout(req.provider, req.eventName, text);
    return hookStdout ? { hookStdout } : null;
  });
  const { port, token } = await hookServer.start();
  t.after(() => hookServer.stop());

  // Mark @api as actively working so Tier 3 does NOT fire yet.
  agentStatusStore.ingestHookEvent({ ptyId: api.ptyId, agentId: 'claude', state: 'working', toolName: 'Read' });
  writtenPty.length = 0;

  const steering = await service.boardPost({
    from: coordPaneId,
    text: '@api use 60s TTL for cache entries',
  });

  // Simulate PostToolUse hook arriving mid-turn on @api -> injects via hookStdout & advances lastDeliveredSeq!
  const hookRes = await fetch(`http://127.0.0.1:${port}/hook/claude?ptyId=${api.ptyId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aha-agent-hook-token': token,
    },
    body: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Read',
    }),
  });
  assert.equal(hookRes.status, 200);
  const hookJson = await hookRes.json();
  assert.equal(typeof hookJson.hookStdout, 'string');
  const injected = JSON.parse(hookJson.hookStdout).hookSpecificOutput.additionalContext;
  assert.match(injected, /use 60s TTL for cache entries/);
  assert.equal(store.getMemberCursor(api.run.id, 'api').lastDeliveredSeq, steering.boardSeq);

  // Now @api goes idle -> Tier 3 flush MUST NOT re-deliver the already-injected message!
  agentStatusStore.ingestHookEvent({ ptyId: api.ptyId, agentId: 'claude', state: 'idle' });
  const flushedDup = await service.pointerDelivery.flushPane(api.ptyId);
  assert.equal(flushedDup, false);
  assert.equal(
    writtenPty.filter((w) => w.ptyId === api.ptyId).length,
    0,
    'Tier 3 must skip posts already injected by Tier 2 PostToolUse'
  );

  // Tier 3 Case A: short post (1 message <= 1000 chars) on idle MCP pane -> direct body written to PTY!
  const shortPost = await service.boardPost({
    from: coordPaneId,
    text: '@api add cache hit counter too',
  });
  const flushedShort = await service.pointerDelivery.flushPane(api.ptyId);
  assert.equal(flushedShort, true);
  const shortWrites = writtenPty
    .filter((w) => w.ptyId === api.ptyId)
    .map((w) => w.data)
    .join('');
  assert.match(shortWrites, /add cache hit counter too/);
  assert.equal(shortWrites.includes('aha orchestration check'), false);
  assert.equal(store.getMemberCursor(api.run.id, 'api').lastDeliveredSeq, shortPost.boardSeq);
  assert.equal((await service.boardWait({ from: api.ptyId, timeoutMs: 0 })).timedOut, true);

  // Tier 3 Case B: large batch (3 messages) -> targeted read_board(seqs=[...]) pointer written to PTY!
  writtenPty.length = 0;
  agentStatusStore.ingestHookEvent({ ptyId: api.ptyId, agentId: 'claude', state: 'working', toolName: 'Edit' });
  await service.boardPost({ from: coordPaneId, text: '@api batch item 1' });
  await service.boardPost({ from: coordPaneId, text: '@api batch item 2' });
  const lastBatch = await service.boardPost({ from: coordPaneId, text: '@api batch item 3' });
  agentStatusStore.ingestHookEvent({ ptyId: api.ptyId, agentId: 'claude', state: 'idle' });
  const flushedBatch = await service.pointerDelivery.flushPane(api.ptyId);
  assert.equal(flushedBatch, true);
  const batchWrites = writtenPty
    .filter((w) => w.ptyId === api.ptyId)
    .map((w) => w.data)
    .join('');
  assert.match(batchWrites, /Board 有 3 条 @你的新消息/);
  assert.match(batchWrites, /read_board\(seqs=\[\d+,\d+,\d+\]\)/);
  assert.equal(store.getMemberCursor(api.run.id, 'api').lastDeliveredSeq, lastBatch.boardSeq);
  const seqs = JSON.parse(/seqs=(\[[\d,]+\])/.exec(batchWrites)[1]);
  assert.equal((await service.boardWait({ from: api.ptyId, peek: true })).posts.length, 3);
  service.boardRead({ from: api.ptyId, seqs });
  assert.equal((await service.boardWait({ from: api.ptyId, timeoutMs: 0 })).timedOut, true);

  // Unaddressed worker post must NEVER trigger Tier 3 idle delivery to coordinator!
  agentStatusStore.ingestHookEvent({ ptyId: coordPaneId, agentId: 'claude', state: 'idle' });
  writtenPty.length = 0;
  await service.boardPost({
    from: api.ptyId,
    text: 'FYI local benchmark finished (no mention)',
  });
  const flushedCoord = await service.pointerDelivery.flushPane(coordPaneId);
  assert.equal(flushedCoord, false);
  assert.equal(writtenPty.filter((w) => w.ptyId === coordPaneId).length, 0);
});

test('workerDoneByPane attaches real git artifacts & BoardStallWatchdog posts one-shot stall escalation', async (t) => {
  const repoDir = mkdtempSync(join(tmpdir(), 'aha-board-git-'));
  t.after(() => rmSync(repoDir, { recursive: true, force: true }));

  execFileSync('git', ['init'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoDir, stdio: 'ignore' });
  writeFileSync(join(repoDir, 'README.md'), '# hello\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoDir, stdio: 'ignore' });

  // Modify an existing file and add an untracked file.
  writeFileSync(join(repoDir, 'README.md'), '# hello updated\n', 'utf8');
  writeFileSync(join(repoDir, 'feature.ts'), 'export const x = 1;\n', 'utf8');

  let fakeNow = Date.parse('2026-01-01T00:00:00.000Z');
  const { coordPaneId, service, store, agentStatusStore } = createHarness(t, {
    defaultCwd: repoDir,
    now: () => fakeNow,
    stallThresholdMs: 25_000,
  });

  const builder = await service.delegateTask({
    from: coordPaneId,
    role: 'builder',
    task: 'Update README and add feature.ts',
    agent: 'claude',
    worktree: false,
  });

  // Settle worker via workerDoneByPane -> automatically inspects git repo and attaches artifacts!
  const doneRes = await service.workerDoneByPane(builder.ptyId, {
    outcome: 'completed',
    summary: 'Added feature.ts and updated README.md',
  });
  assert.equal(doneRes.message.kind, 'report');
  assert.ok(doneRes.message.artifacts, 'report_done should attach git artifacts');
  assert.ok(doneRes.message.artifacts.headCommit, 'artifacts should include short headCommit');
  assert.equal(doneRes.message.artifacts.changedFileCount >= 2, true);
  assert.equal(doneRes.message.artifacts.changedFiles.includes('README.md'), true);
  assert.equal(doneRes.message.artifacts.changedFiles.includes('feature.ts'), true);

  // Process the report first so this still exercises the global quiet fallback.
  await service.boardPost({ from: coordPaneId, text: `Accepted report #${doneRes.message.boardSeq}` });
  service.boardRead({ from: coordPaneId });

  // Coordinator is idle, no waiter, all workers settled; before threshold -> no stall.
  agentStatusStore.ingestHookEvent({ ptyId: coordPaneId, agentId: 'claude', state: 'idle' });
  fakeNow += 10_000;
  assert.deepEqual(service.stallWatchdog.sweep(), []);

  // Advance past threshold -> watchdog posts ONE stall message mentioning @coordinator.
  fakeNow += 20_000;
  const events1 = service.stallWatchdog.sweep();
  assert.equal(events1.length, 1);
  assert.equal(events1[0].runId, builder.run.id);

  const posts = store.listBoardPosts(builder.run.id);
  const stallPosts = posts.filter((p) => p.kind === 'stall');
  assert.equal(stallPosts.length, 1);
  assert.deepEqual(stallPosts[0].mentions, ['coordinator']);
  assert.equal(
    stallPosts[0].body,
    `@coordinator No active workers and board has been quiet for 30s since #${events1[0].headSeq}. Review reports, follow up, or wrap up the run.`
  );

  // Second sweep at same state does NOT emit a duplicate stall post.
  fakeNow += 30_000;
  assert.deepEqual(service.stallWatchdog.sweep(), []);
  assert.equal(store.listBoardPosts(builder.run.id).filter((p) => p.kind === 'stall').length, 1);
});

async function createStallQuestionScenario(t) {
  let fakeNow = Date.parse('2026-01-01T00:00:00.000Z');
  const { coordPaneId, service, store, agentStatusStore } = createHarness(t, {
    now: () => fakeNow,
    stallThresholdMs: 25_000,
  });

  const worker = await service.delegateTask({
    from: coordPaneId,
    role: 'questioner',
    task: 'Implement the API contract',
    agent: 'claude',
    worktree: false,
  });
  const asked = await service.askCoordinatorByPane(worker.ptyId, {
    question: 'Should the API use REST or GraphQL?',
    options: ['REST', 'GraphQL'],
    wait: false,
  });
  assert.equal(asked.pending, true);
  const questionPost = store.getMessageById(asked.messageId);
  assert.ok(questionPost);
  assert.equal(questionPost.kind, 'question');
  assert.equal(questionPost.toHandle, `run:${worker.run.id}`);
  assert.equal(store.getQuestion(asked.messageId)?.status, 'pending');

  agentStatusStore.ingestHookEvent({ ptyId: coordPaneId, agentId: 'claude', state: 'idle' });

  return {
    coordPaneId,
    service,
    store,
    worker,
    asked,
    questionPost,
    advanceMs: (ms) => {
      fakeNow += ms;
    },
    readQuestionAsCoordinator: () => {
      const board = service.boardRead({ from: coordPaneId });
      assert.ok(board.posts.some((post) => post.id === asked.messageId));
      service.boardRead({ from: coordPaneId, seqs: [questionPost.boardSeq] });
      assert.equal(store.wasBoardPostRead(asked.messageId, 'coordinator'), true);
    },
  };
}

test('BoardStallWatchdog surfaces coordinator-read unanswered questions', async (t) => {
  const scenario = await createStallQuestionScenario(t);
  const { service, store, asked, questionPost, worker } = scenario;
  scenario.readQuestionAsCoordinator();

  scenario.advanceMs(30_000);
  const events = service.stallWatchdog.sweep();
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, worker.run.id);

  const stallPosts = store.listBoardPosts(worker.run.id).filter((post) => post.kind === 'stall');
  assert.equal(stallPosts.length, 1);
  assert.equal(stallPosts[0].subject, `Board stall detected at #${events[0].headSeq}`);
  assert.deepEqual(stallPosts[0].mentions, ['coordinator']);
  assert.equal(
    stallPosts[0].body,
    `@coordinator You already read 1 unanswered question(s): #${questionPost.boardSeq} (questionId ${asked.messageId}). Answer each with message_worker using its questionId. No active workers and board quiet for 30s since #${events[0].headSeq} — review reports, follow up, or wrap up the run.`
  );
});

test('BoardStallWatchdog surfaces unanswered questions seen only through a broad board read', async (t) => {
  const scenario = await createStallQuestionScenario(t);
  const { coordPaneId, service, store, worker, asked } = scenario;
  // Broad reads advance the coordinator cursor but never record exact per-post reads.
  const board = service.boardRead({ from: coordPaneId });
  assert.ok(board.posts.some((post) => post.id === asked.messageId));
  assert.equal(store.wasBoardPostRead(asked.messageId, 'coordinator'), false);

  scenario.advanceMs(30_000);
  const events = service.stallWatchdog.sweep();
  assert.equal(events.length, 1);
  assert.equal(events[0].runId, worker.run.id);
  const stallPosts = store.listBoardPosts(worker.run.id).filter((post) => post.kind === 'stall');
  assert.equal(stallPosts.length, 1);
  assert.match(stallPosts[0].body, /questionId/);
});

test('BoardStallWatchdog stays silent while a coordinator question is unread', async (t) => {
  const scenario = await createStallQuestionScenario(t);
  const { service, store, worker, asked } = scenario;
  assert.equal(store.wasBoardPostRead(asked.messageId, 'coordinator'), false);

  scenario.advanceMs(30_000);
  assert.deepEqual(service.stallWatchdog.sweep(), []);
  assert.equal(store.listBoardPosts(worker.run.id).filter((post) => post.kind === 'stall').length, 0);
});

test('BoardStallWatchdog stays silent after a read question is answered by questionId', async (t) => {
  const scenario = await createStallQuestionScenario(t);
  const { coordPaneId, service, store, worker, asked } = scenario;
  scenario.readQuestionAsCoordinator();

  const answer = await service.messageWorkerByRole(coordPaneId, {
    role: 'questioner',
    questionId: asked.messageId,
    message: 'Use REST for the API contract.',
  });
  assert.equal(answer.mode, 'replied');
  assert.equal(store.getQuestion(asked.messageId)?.status, 'answered');

  scenario.advanceMs(30_000);
  assert.deepEqual(service.stallWatchdog.sweep(), []);
  assert.equal(store.listBoardPosts(worker.run.id).filter((post) => post.kind === 'stall').length, 0);
});

async function createSemanticStallScenario(t, opts = {}) {
  let now = Date.parse('2026-02-01T00:00:00Z');
  const harness = createHarness(t, { ...opts, now: () => now });
  const { service, store, coordPaneId, agentStatusStore } = harness;
  if (opts.codexPilot) service.setSessionCoordinators({
    get: (id) => id === coordPaneId ? { cwd: process.cwd(), provider: 'codex', active: true, idle: true } : null,
  });
  const launch = (role) => service.delegateTask({
    from: coordPaneId, role, task: 'Verify the API', agent: opts.codexPilot ? 'codex' : 'claude', worktree: false,
    ...(opts.codexPilot ? { taskKind: 'research' } : {}),
  });
  const worker = await launch('api');
  const dispatchId = worker.dispatch.id;
  const workerHandle = worker.ptyId ?? worker.dispatch.assigneeHandle;
  const quietWorker = () => {
    if (worker.ptyId) agentStatusStore.ingestHookEvent({ ptyId: worker.ptyId, agentId: 'claude', state: 'idle' });
    store.markTurnStopReported(dispatchId, 1, 'finished');
  };
  const runId = worker.run.id;
  const coordinatorPost = (text) => service.boardPost({ from: coordPaneId, runId, text });
  const workerPost = (text, kind) => service.boardPost({ from: workerHandle, runId, text, kind });
  const latestStall = () => store.listBoardPosts(runId, { limit: 500 }).filter(p => p.kind === 'stall').at(-1);
  return { ...harness, worker, workerHandle, runId, launch, quietWorker, coordinatorPost, workerPost, latestStall,
    advance: (ms = 30_000) => { now += ms; },
    sweep: () => service.stallWatchdog.sweep(),
    read: (seqs) => service.boardRead({ from: coordPaneId, runId, seqs }),
  };
}

test('semantic stall merges unhandled report and unread signals in priority order', async (t) => {
  const s = await createSemanticStallScenario(t);
  const done = await s.service.workerDoneByPane(s.worker.ptyId, { summary: 'Verified compatibility' });
  assert.equal(done.message.boardSeq, 2);
  const unread = await s.workerPost('@coordinator One more observation');
  assert.equal(unread.boardSeq, 3);
  s.advance();
  assert.deepEqual(s.sweep(), [{ runId: s.runId, headSeq: 3, idleMs: 30_000 }]);
  const stall = s.latestStall();
  assert.deepEqual(stall.refs, [2, 3]);
  assert.deepEqual(stall.mentions, ['coordinator']);
  assert.equal(stall.fromHandle, 'system');
  assert.equal(stall.body, '@coordinator Unhandled Worker reports: #2. Review or follow up.\n@coordinator Unread board posts: #2, #3. Read the referenced posts.');
  assert.equal(s.store.getDispatchContext(s.worker.dispatch.id).status, 'completed');
  s.advance();
  assert.deepEqual(s.sweep(), [], 'a stall at the head cannot generate another stall');
});

for (const action of ['read only', 'explicit reply', 'coordinator ref', 'coordinator thread', 'review started', 'integrated', 'already integrated']) {
  test(`semantic stall distinguishes point-read reports from handling via ${action}`, async (t) => {
    const s = await createSemanticStallScenario(t);
    let report;
    if (['review started', 'integrated', 'already integrated'].includes(action)) {
      const result = await s.service.workerDoneByPane(s.worker.ptyId, { summary: 'Verified API' });
      report = result.message;
      if (action === 'already integrated') {
        s.store.updateDispatchIntegrationState(s.worker.dispatch.id, { integrationStatus: 'merged' });
        await s.coordinatorPost('Accepted #2');
        s.read();
        s.advance(1);
        report = (await s.workerPost('@coordinator New report after integration', 'report')).post;
      }
    } else {
      report = (await s.workerPost('@coordinator Verified API', 'report')).post;
      s.quietWorker();
    }
    const reportSeq = action === 'already integrated' ? 4 : 2;
    assert.equal(report.boardSeq, reportSeq);
    s.read([reportSeq]);
    assert.equal(s.store.wasBoardPostRead(report.id, 'coordinator'), true);
    if (action !== 'review started') s.advance(1);
    if (action === 'explicit reply') {
      s.service.reply({ id: report.id, from: s.coordPaneId, body: 'Accepted' });
      assert.equal(s.store.getMessageById(report.id).receipts.coordinator, 'replied');
    } else if (action === 'coordinator ref') {
      await s.coordinatorPost('Accepted #2');
      assert.equal(s.store.getMessageById(report.id).receipts.coordinator, 'delivered');
    } else if (action === 'coordinator thread') {
      s.store.insertMessage({ runId: s.runId, from: s.coordPaneId, fromRole: 'coordinator',
        to: `run:${s.runId}`, subject: 'Accepted', threadId: report.id });
    } else if (action === 'review started') {
      // Seed the record written by the review launch; a working reviewer would gate the whole watchdog.
      const review = s.store.createTask({ runId: s.runId, spec: 'Review the API', displayName: 'reviewer' });
      const d = s.store.createDispatchContext({ taskId: review.id, assigneeHandle: 'review-pane', reviewOfDispatchId: s.worker.dispatch.id });
      s.store.insertMessage({ runId: s.runId, from: s.coordPaneId, fromRole: 'coordinator', to: `dispatch:${d.id}`,
        kind: 'brief', type: 'dispatch', mentions: ['reviewer'], subject: 'Review assignment' });
      s.store.markTurnStopReported(d.id, 1, 'finished');
    } else if (action === 'integrated') {
      s.store.updateDispatchIntegrationState(s.worker.dispatch.id, { integrationStatus: 'merged' });
    }
    s.advance();
    assert.equal(s.sweep().length, 1);
    const body = s.latestStall().body;
    if (action === 'read only') {
      assert.equal(body, '@coordinator Unhandled Worker reports: #2. Review or follow up.');
    } else if (action === 'already integrated') {
      assert.equal(body, '@coordinator Unhandled Worker reports: #4. Review or follow up.');
    } else {
      assert.doesNotMatch(body, /Unhandled Worker reports|Unread board posts/);
    }
  });
}

for (const readMode of ['unread', 'broad read', 'mentionsOnly wait']) {
  test(`semantic stall diagnoses coordinator unread messages with ${readMode}`, async (t) => {
    const s = await createSemanticStallScenario(t);
    const post = await s.workerPost('@coordinator Clarified the test plan');
    assert.equal(post.boardSeq, 2);
    s.quietWorker();
    if (readMode === 'broad read') {
      assert.equal(s.read().lastReadSeq, 2);
      assert.equal(s.store.wasBoardPostRead(post.post.id, 'coordinator'), false);
    } else if (readMode === 'mentionsOnly wait') {
      const wait = await s.service.boardWait({ from: s.coordPaneId, mentionsOnly: true, timeoutMs: 0 });
      assert.deepEqual(wait.posts.map(p => p.boardSeq), [2]);
      assert.equal(s.store.getMemberCursor(s.runId, 'coordinator').lastReadSeq, 0);
      assert.equal(s.store.wasBoardPostRead(post.post.id, 'coordinator'), true);
    }
    s.advance();
    assert.equal(s.sweep().length, 1);
    if (readMode === 'unread') {
      assert.equal(s.latestStall().body, '@coordinator Unread board posts: #2. Read the referenced posts.');
    } else {
      assert.equal(s.latestStall().subject, 'Board stall detected at #2 — last posts: @coordinator #1, @api #2');
      assert.deepEqual(s.latestStall().refs, [1, 2]);
      assert.doesNotMatch(s.latestStall().body, /Unread board posts/);
    }
    assert.equal(s.store.getDispatchContext(s.worker.dispatch.id).status, 'dispatched');
  });
}

test('semantic stall never emits diagnostics with a working member or a native question pending', async (t) => {
  const s = await createSemanticStallScenario(t);
  const older = await s.launch('older');
  await s.service.workerDoneByPane(older.ptyId, { summary: 'Report still unhandled' });
  s.agentStatusStore.ingestHookEvent({ ptyId: s.worker.ptyId, agentId: 'claude', state: 'working' });
  s.advance();
  assert.deepEqual(s.sweep(), []);
  s.quietWorker();
  const abort = new AbortController();
  const question = s.service.nativeQuestions.holdQuestion(s.worker.dispatch, {
    provider: 'claude', method: 'AskUserQuestion', signal: abort.signal,
    questions: [{ id: 'scope', header: 'Scope', prompt: 'Which scope?', allowOther: true, options: [] }],
  });
  assert.equal(s.service.nativeQuestions.listOpenQuestions({ runId: s.runId }).length, 1);
  assert.equal(s.service.board.inspectRunsForStallWatchdog()[0].hasActiveWorkers, false);
  assert.deepEqual(s.sweep(), []);
  assert.equal(s.latestStall(), undefined);
  abort.abort();
  await question;
  assert.equal(s.sweep().length, 1);
});

test('semantic stall retries an unanswered mention once, then escalates on the next eligible head', async (t) => {
  const s = await createSemanticStallScenario(t);
  assert.equal((await s.coordinatorPost('@api please acknowledge')).boardSeq, 2);
  s.quietWorker();
  await s.service.pointerDelivery.flushPane(s.worker.ptyId);
  const originalWrites = s.writtenPty.length;
  const mentionWrites = () => s.writtenPty.slice(originalWrites).filter(w => w.data.includes('Unanswered mention')).map(w => w.ptyId);
  s.advance();
  assert.equal(s.sweep().length, 1);
  assert.equal(s.latestStall().body, '@api Unanswered mention at #2. Please respond on the board.');
  assert.deepEqual(s.latestStall().mentions, ['api']);
  assert.equal(s.latestStall().toHandle, `dispatch:${s.worker.dispatch.id}`);
  assert.equal((await s.service.boardWait({ from: s.coordPaneId, mentionsOnly: true, peek: true })).posts.length, 0);
  await s.service.pointerDelivery.flushPane(s.worker.ptyId);
  assert.deepEqual(mentionWrites(), [s.worker.ptyId]);
  s.advance();
  assert.deepEqual(s.sweep(), [], 'the watchdog cannot react to its own retry post');
  assert.equal((await s.coordinatorPost('Checking in without a new mention')).boardSeq, 4);
  s.advance();
  assert.equal(s.sweep().length, 1);
  assert.equal(s.latestStall().body, '@coordinator Unanswered mention for @api at #2: no reply after one re-ping. Follow up or handle it manually.');
  assert.deepEqual(s.latestStall().refs, [2]);
  await s.service.pointerDelivery.flushPane(s.worker.ptyId);
  assert.deepEqual(mentionWrites(), [s.worker.ptyId]);
  assert.equal(s.store.getDispatchContext(s.worker.dispatch.id).status, 'dispatched');
});

for (const problem of ['failed', 'process exited or unavailable']) {
  test(`semantic stall escalates a ${problem} Worker without a retry`, async (t) => {
    const s = await createSemanticStallScenario(t);
    await s.coordinatorPost('@api please acknowledge');
    s.quietWorker();
    if (problem === 'failed') {
      s.agentStatusStore.ingestHookEvent({ ptyId: s.worker.ptyId, agentId: 'claude', state: 'error' });
    } else {
      s.tracker.markExited(s.worker.ptyId, 1);
    }
    s.advance();
    const wakes = [];
    const schedule = s.service.pointerDelivery.scheduleRedriveForPane.bind(s.service.pointerDelivery);
    s.service.pointerDelivery.scheduleRedriveForPane = (pane) => { wakes.push(pane); schedule(pane); };
    const writesBefore = s.writtenPty.filter(w => w.ptyId === s.worker.ptyId).length;
    assert.equal(s.sweep().length, 1);
    assert.equal(s.latestStall().body, `@coordinator Unanswered mention for @api at #2: ${problem}. Consider switching CLIs or handling it manually.`);
    assert.deepEqual(wakes, [s.coordPaneId]);
    const peek = await s.service.boardWait({ from: s.worker.ptyId, since: 2, mentionsOnly: false, peek: true });
    assert.deepEqual(peek.posts, [], 'a full-board Worker wait does not deliver coordinator-only stalls');
    assert.equal(s.writtenPty.filter(w => w.ptyId === s.worker.ptyId).length, writesBefore);
  });
}

test('semantic stall uses the headless goal status and sends no Worker turn on quota exhaustion', async (t) => {
  let events;
  const sent = [];
  const sessionId = 'agent-session-00000000-0000-0000-0000-00000000000b';
  const s = await createSemanticStallScenario(t, {
    coordPaneId: sessionId,
    codexPilot: { enabled: () => true, launch(_id, _cwd, callbacks) {
      events = callbacks;
      return { alive: true, busy: false, latestTurnKey: null, open: async () => 'scout-thread', close: async () => {},
        read: () => null, redactText: text => text,
        async startTurn(input) { sent.push(input); return { status: 'accepted' }; },
      };
    } },
  });
  const workerId = s.worker.dispatch.id;
  assert.equal(s.worker.dispatch.executionMode, 'codex-app-server');
  assert.equal(sent.length, 1);
  const mention = s.store.insertMessage({ runId: s.runId, from: sessionId, fromRole: 'coordinator',
    to: `dispatch:${workerId}`, mentions: ['api'], kind: 'post', subject: 'Please acknowledge' });
  assert.equal(mention.boardSeq, 2);
  s.store.recordCodexTurn(workerId, { turnId: 'worker-turn', stopReason: 'completed', finalText: '', diff: null, error: null, usage: null });
  events.onGoalChanged({ objective: 'Verify API', status: 'usageLimited', tokensUsed: 0, timeUsedSeconds: 0, updatedAt: 1 });
  s.advance();
  assert.equal(s.sweep().length, 1);
  assert.equal(s.latestStall().body, '@coordinator Unanswered mention for @api at #2: limited (usageLimited). Consider switching CLIs or handling it manually.');
  assert.equal(sent.length, 1);
  assert.equal(s.service.workers.codexMailbox.has(s.worker.dispatch.assigneeHandle), false);
  assert.equal(s.store.getDispatchContext(workerId).status, 'dispatched');
});

test('semantic stall spends three actual coordinator wakes; chatter cannot reset the budget', async (t) => {
  const s = await createSemanticStallScenario(t);
  await s.workerPost('Checks are ready');
  s.read();
  s.quietWorker();
  const stallWakes = () => s.writtenPty.filter(w => w.ptyId === s.coordPaneId && w.data.includes('Board stall detected'));
  assert.equal(stallWakes().length, 0);
  for (const expectedHead of [2, 4, 6]) {
    s.advance();
    assert.deepEqual(s.sweep(), [{ runId: s.runId, headSeq: expectedHead, idleMs: 30_000 }]);
    assert.equal(await s.service.pointerDelivery.flushPane(s.coordPaneId), true);
    await s.coordinatorPost('Idle system turn chatter, no task progress');
  }
  for (let i = 0; i < 2; i++) {
    s.advance();
    assert.deepEqual(s.sweep(), []);
    await s.coordinatorPost('Still idle');
  }
  assert.equal(stallWakes().length, 3);
  const next = await s.launch('next');
  s.store.markTurnStopReported(next.dispatch.id, 1, 'finished');
  s.advance();
  assert.deepEqual(s.sweep(), [{ runId: s.runId, headSeq: 11, idleMs: 30_000 }]);
  assert.deepEqual(s.latestStall().mentions, ['coordinator']);
});

for (const author of ['user', 'Worker']) {
  test(`semantic stall replenishes the wake budget after a new ${author} post`, async (t) => {
    const s = await createSemanticStallScenario(t);
    s.quietWorker();
    for (const head of [1, 3, 5]) {
      s.advance();
      assert.deepEqual(s.sweep(), [{ runId: s.runId, headSeq: head, idleMs: 30_000 }]);
      await s.coordinatorPost('Waiting');
    }
    s.advance();
    assert.deepEqual(s.sweep(), []);
    if (author === 'user') {
      await s.service.boardPost({ runId: s.runId, from: s.coordPaneId, text: 'Human guidance', isUser: true });
    } else {
      await s.workerPost('New evidence');
    }
    s.advance();
    assert.deepEqual(s.sweep(), [{ runId: s.runId, headSeq: 8, idleMs: 30_000 }]);
  });
}

test('semantic stall honors coordinator [done] across system posts but not across new Worker posts', async (t) => {
  const s = await createSemanticStallScenario(t);
  assert.equal((await s.workerPost('[done] from the Worker')).boardSeq, 2);
  s.quietWorker();
  s.advance();
  assert.equal(s.sweep().length, 1);
  assert.deepEqual(s.latestStall().refs, [2]);
  assert.equal((await s.coordinatorPost('[DONE] all done')).boardSeq, 4);
  s.store.insertMessage({ runId: s.runId, from: 'system', fromRole: 'system', to: `run:${s.runId}`, subject: 'Audit notice' });
  s.advance();
  assert.deepEqual(s.sweep(), []);
  assert.equal((await s.workerPost('New finding')).boardSeq, 6);
  s.advance();
  assert.equal(s.sweep().length, 1);
  assert.equal(s.latestStall().body, '@coordinator Unread board posts: #2, #5, #6. Read the referenced posts.');
});

test('Stdio MCP server (aha-mcp-server.cjs): end-to-end post_message, read_board & board_wait across coordinator and sibling workers', async (t) => {
  const { coordPaneId, service, agentStatusStore, store } = createHarness(t);

  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setOrchestrationHandler((action, payload, context) =>
    dispatchOrchestrationHttpAction(service, action, payload, context)
  );
  await hookServer.start();
  t.after(() => hookServer.stop());

  const api = await service.delegateTask({
    from: coordPaneId,
    role: 'api',
    task: 'Build REST handler',
    agent: 'claude',
    worktree: false,
  });
  const verifier = await service.delegateTask({
    from: coordPaneId,
    role: 'verifier',
    task: 'Test REST handler',
    agent: 'codex',
    worktree: false,
  });

  const coordClient = spawnMcpClient(t, hookServer.envForPane(coordPaneId));
  const apiClient = spawnMcpClient(t, hookServer.envForPane(api.ptyId));
  const verifierClient = spawnMcpClient(t, hookServer.envForPane(verifier.ptyId));
  await Promise.all([
    coordClient.request('initialize', { protocolVersion: '2024-11-05' }),
    apiClient.request('initialize', { protocolVersion: '2024-11-05' }),
    verifierClient.request('initialize', { protocolVersion: '2024-11-05' }),
  ]);

  // @verifier starts board_wait (with snake_case timeout_ms), @api posts handoff via post_message -> @verifier wakes!
  const waitPromise = verifierClient.request('tools/call', {
    name: 'board_wait',
    arguments: { timeout_ms: 5_000 },
  });
  await new Promise((r) => setTimeout(r, 40));

  const postRes = await apiClient.request('tools/call', {
    name: 'post_message',
    arguments: { text: `@verifier endpoint ready, see #${api.briefBoardSeq}` },
  });
  assert.equal(postRes.result.isError, undefined);
  assert.match(postRes.result.content[0].text, /Posted #\d+/);
  assert.match(postRes.result.content[0].text, /Woke: @verifier/);

  const waitRes = await waitPromise;
  assert.equal(waitRes.result.isError, undefined);
  assert.match(waitRes.result.content[0].text, /endpoint ready/);
  assert.match(waitRes.result.content[0].text, /Board head=#/);

  const seq = Number(/Posted #(\d+)/.exec(postRes.result.content[0].text)[1]);
  const [handoff] = store.listBoardPosts(api.run.id, { seqs: [seq] });
  const answer = await verifierClient.request('tools/call', {
    name: 'post_message', arguments: { text: 'Tested successfully', replyTo: '#' + seq },
  });
  assert.equal(answer.result.isError, undefined);
  assert.match(answer.result.content[0].text, /Woke: @api/);
  assert.equal(store.getMessageById(handoff.id).receipts.verifier, 'replied');
  const [response] = store.listBoardPosts(api.run.id, { limit: 1 });
  assert.equal(response.threadId, handoff.id);
  const denied = await apiClient.request('tools/call', {
    name: 'post_message', arguments: { text: 'Wrong recipient', replyTo: handoff.id },
  });
  assert.equal(denied.result.isError, true);

  // @verifier pulls #1 via read_board(seqs=[1]).
  const readRes = await verifierClient.request('tools/call', {
    name: 'read_board',
    arguments: { seqs: [1] },
  });
  assert.equal(readRes.result.isError, undefined);
  assert.match(readRes.result.content[0].text, /posts=1/);
  assert.match(readRes.result.content[0].text, /#1/);

  // Coordinator broadcasts @all via post_message.
  const broadcastRes = await coordClient.request('tools/call', {
    name: 'post_message',
    arguments: { text: '@all freeze changes for release' },
  });
  assert.equal(broadcastRes.result.isError, undefined);
  assert.match(broadcastRes.result.content[0].text, /Woke: @all/);
});

test('Regression: non-whitelisted PostToolUse providers (grok/antigravity) do not silently consume mid-turn posts before Tier 3 idle delivery', async (t) => {
  assert.equal(supportsPostToolContextInjection('claude', 'PostToolUse'), true);
  assert.equal(supportsPostToolContextInjection('claude-code', 'PostToolUse'), true);
  assert.equal(supportsPostToolContextInjection('qwen', 'PostToolUse'), true);
  assert.equal(supportsPostToolContextInjection('gemini', 'AfterTool'), true);
  assert.equal(supportsPostToolContextInjection('gemini-cli', 'AfterTool'), true);
  assert.equal(supportsPostToolContextInjection('grok', 'PostToolUse'), false);
  assert.equal(supportsPostToolContextInjection('antigravity', 'PostToolUse'), false);
  assert.equal(supportsPostToolContextInjection('codex', 'PostToolUse'), false);
  assert.equal(supportsPostToolContextInjection('claude', 'PreToolUse'), false);

  const { coordPaneId, service, store, agentStatusStore, writtenPty } = createHarness(t);
  const grokWorker = await service.delegateTask({
    from: coordPaneId,
    role: 'grokworker',
    task: 'Analyze logs',
    agent: 'grok',
    worktree: false,
  });

  // Wire postToolInterceptor identically to electron/main.ts (check supportsPostToolContextInjection first).
  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setPostToolInterceptor((req) => {
    if (!supportsPostToolContextInjection(req.provider, req.eventName)) {
      return null;
    }
    const text = service.consumeMidTurnBoardInjections(req.ptyId);
    if (!text) return null;
    const hookStdout = formatPostToolContextHookStdout(req.provider, req.eventName, text);
    return hookStdout ? { hookStdout } : null;
  });
  const { port, token } = await hookServer.start();
  t.after(() => hookServer.stop());

  agentStatusStore.ingestHookEvent({
    ptyId: grokWorker.ptyId,
    agentId: 'grok',
    state: 'working',
    toolName: 'Bash',
  });
  writtenPty.length = 0;

  const posted = await service.boardPost({
    from: coordPaneId,
    text: '@grokworker check error code 503 too',
  });
  const cursorBeforeHook = store.getMemberCursor(grokWorker.run.id, 'grokworker').lastDeliveredSeq;
  assert.equal(cursorBeforeHook < posted.boardSeq, true);

  // Grok PostToolUse arrives mid-turn -> must NOT return hookStdout and must NOT advance lastDeliveredSeq!
  const res = await fetch(`http://127.0.0.1:${port}/hook/grok?ptyId=${grokWorker.ptyId}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-aha-agent-hook-token': token,
    },
    body: JSON.stringify({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.hookStdout, undefined);
  assert.equal(
    store.getMemberCursor(grokWorker.run.id, 'grokworker').lastDeliveredSeq,
    cursorBeforeHook,
    'non-whitelisted provider must not consume lastDeliveredSeq on PostToolUse'
  );

  // Once grok goes idle, Tier 3 delivers the queued board post cleanly without message loss!
  agentStatusStore.ingestHookEvent({ ptyId: grokWorker.ptyId, agentId: 'grok', state: 'idle' });
  const flushed = await service.pointerDelivery.flushPane(grokWorker.ptyId);
  assert.equal(flushed, true);
  const delivered = writtenPty
    .filter((w) => w.ptyId === grokWorker.ptyId)
    .map((w) => w.data)
    .join('');
  assert.match(delivered, /check error code 503 too/);
  assert.equal(
    store.getMemberCursor(grokWorker.run.id, 'grokworker').lastDeliveredSeq,
    posted.boardSeq
  );
});

test('Regression: settled workers & unrelated panes cannot impersonate @coordinator or cross-access another run', async (t) => {
  const { coordPaneId, service, store, agentStatusStore, tracker } = createHarness(t);

  // Create a second independent run owned by coordB.
  const coordB = 'local-coord-b';
  agentStatusStore.registerPane(coordB, { agentId: 'claude' });
  tracker.registerPty({ ptyId: coordB, cwd: process.cwd(), cliId: 'claude' });
  const runB = service.runCreate({ objective: 'Other private run', from: coordB, paneId: coordB }).run;

  const api = await service.delegateTask({
    from: coordPaneId,
    role: 'api',
    task: 'API task',
    agent: 'claude',
    worktree: false,
  });
  const verifier = await service.delegateTask({
    from: coordPaneId,
    role: 'verifier',
    task: 'Verify task',
    agent: 'codex',
    worktree: false,
  });
  const runAId = api.run.id;
  assert.notEqual(
    runAId,
    runB.id,
    'coordPaneId delegating without runId must create its own run rather than attaching to coordB run'
  );

  // Record a peer exchange so we can verify settled worker activity does NOT reset peerPingPong.
  await service.boardPost({ from: api.ptyId, text: '@verifier first ping' });
  assert.equal(service.peerPingPong.getExchangeCount(runAId, 'api', 'verifier'), 1);

  // Settle both @api and @verifier (kept open).
  await service.workerDoneByPane(api.ptyId, { outcome: 'completed', summary: 'API done' });
  await service.workerDoneByPane(verifier.ptyId, { outcome: 'completed', summary: 'Verify done' });

  // Settled @api posting @all MUST post as @api (isPrivileged: false), never wake @all, and never reset ping-pong!
  const settledAll = await service.boardPost({
    from: api.ptyId,
    text: '@all trying to impersonate coordinator',
  });
  assert.equal(settledAll.post.fromRole, 'api');
  assert.deepEqual(settledAll.woke, []);
  assert.equal(service.peerPingPong.getExchangeCount(runAId, 'api', 'verifier'), 1);

  // Settled @api mentioning settled @verifier MUST NOT reactivate @verifier!
  const dispatchesBefore = store.listDispatches({ runId: runAId }).length;
  const settledPoke = await service.boardPost({
    from: api.ptyId,
    text: '@verifier wake up',
  });
  assert.equal(settledPoke.post.fromRole, 'api');
  assert.deepEqual(settledPoke.woke, []);
  assert.equal(store.listDispatches({ runId: runAId }).length, dispatchesBefore);

  // Settled @api MUST NOT access runB via explicit runId!
  await assert.rejects(
    () => service.boardPost({ from: api.ptyId, runId: runB.id, text: 'cross-run write' }),
    (err) => err.code === 'operation_rejected'
  );
  assert.throws(
    () => service.boardRead({ from: api.ptyId, runId: runB.id }),
    (err) => err.code === 'operation_rejected'
  );
  await assert.rejects(
    () => service.boardWait({ from: api.ptyId, runId: runB.id, timeoutMs: 20 }),
    (err) => err.code === 'operation_rejected'
  );

  // Completely unrelated pane MUST NOT hijack runA/runB with or without explicit runId!
  const stranger = 'local-stranger';
  agentStatusStore.registerPane(stranger, { agentId: 'claude' });
  tracker.registerPty({ ptyId: stranger, cwd: process.cwd(), cliId: 'claude' });

  await assert.rejects(
    () => service.boardPost({ from: stranger, runId: runAId, text: '@all hijack' }),
    (err) => err.code === 'operation_rejected'
  );
  assert.throws(
    () => service.boardRead({ from: stranger, runId: runAId }),
    (err) => err.code === 'operation_rejected'
  );
  await assert.rejects(
    () => service.boardPost({ from: stranger, text: '@all hijack default run' }),
    (err) => err.code === 'run_not_found'
  );
  assert.throws(
    () => service.boardRead({ from: stranger }),
    (err) => err.code === 'run_not_found'
  );
});

test('Regression: multi-mention boardPost leaves questions pending and reactivates a settled worker with one post', async (t) => {
  const { coordPaneId, service, store } = createHarness(t);

  const api = await service.delegateTask({
    from: coordPaneId,
    role: 'api',
    task: 'API work',
    agent: 'claude',
    worktree: false,
  });
  await service.delegateTask({
    from: coordPaneId,
    role: 'verifier',
    task: 'Verifier work',
    agent: 'codex',
    worktree: false,
  });
  const builder = await service.delegateTask({
    from: coordPaneId,
    role: 'builder',
    task: 'Builder work',
    agent: 'claude',
    worktree: false,
  });
  const runId = api.run.id;

  // @builder settles; @api opens a pending question; @verifier remains active.
  await service.workerDoneByPane(builder.ptyId, { outcome: 'completed', summary: 'Initial build done' });
  const askPromise = service.askCoordinatorByPane(api.ptyId, {
    question: 'Use v2 schema?',
    wait: true,
    timeoutMs: 3_000,
  });
  await new Promise((r) => setTimeout(r, 20));

  const headBefore = store.getHeadBoardSeq(runId);
  const postsBefore = store.listBoardPosts(runId, { limit: 500 }).length;
  const dispatchesBefore = store.listDispatches({ runId }).length;

  const multiRes = await service.boardPost({
    runId,
    from: coordPaneId,
    text: '@api @verifier @builder align on v2 schema right away',
  });

  // Exactly ONE board post created (zero duplicates from answerQuestion or followUpSettledWorker).
  assert.equal(store.getHeadBoardSeq(runId), headBefore + 1);
  assert.equal(store.listBoardPosts(runId, { limit: 500 }).length, postsBefore + 1);
  assert.equal(multiRes.boardSeq, headBefore + 1);
  assert.equal(multiRes.headSeq, headBefore + 1);

  const [question] = store.listQuestions({ dispatchId: api.dispatch.id, status: 'pending' });
  await assert.rejects(service.messageWorkerByRole(coordPaneId, { role: 'verifier', message: 'yes', questionId: question.messageId }), /does not belong/);
  service.reply({ id: question.messageId, from: coordPaneId, body: 'yes' });
  assert.equal((await askPromise).answer, 'yes');
  assert.equal(store.listDispatches({ runId }).length, dispatchesBefore + 1);
});

test('posting progress preserves unread mail and delivery can find a mention beyond the first page', async (t) => {
  const { service, store, coordPaneId } = createHarness(t);
  const worker = await service.delegateTask({ from: coordPaneId, role: 'api', agent: 'claude', task: 'API work', worktree: false });
  const runId = worker.run.id;
  const from = worker.ptyId;
  const before = store.getMemberCursor(runId, 'api');
  for (let i = 0; i < 200; i++) {
    store.insertMessage({ runId, from: 'other', fromRole: 'other', to: 'run:' + runId, subject: 'FYI', kind: 'post' });
  }
  const mention = await service.boardPost({ from: coordPaneId, text: '@api preserve compatibility', replyTo: '   ' });
  await service.boardPost({ from, text: 'Tests running' });
  assert.equal(store.getMemberCursor(runId, 'api').lastReadSeq, before.lastReadSeq);
  const wait = await service.boardWait({ from, peek: true });
  assert.match(service.consumeMidTurnBoardInjections(from), /preserve compatibility/);
  assert.deepEqual(wait.posts.map(post => post.id), [mention.post.id]);
  assert.equal((await service.boardWait({ from, timeoutMs: 0 })).timedOut, true);
  const general = await service.boardWait({ from, mentionsOnly: false, timeoutMs: 0 });
  assert.equal(general.posts[0].subject, 'FYI');
});

test('only an explicit reply marks a referenced post as replied', async (t) => {
  const { service, store, coordPaneId } = createHarness(t);
  const worker = await service.delegateTask({ from: coordPaneId, role: 'api', agent: 'claude', task: 'API work', worktree: false });
  const from = worker.ptyId;
  const mention = await service.boardPost({ from: coordPaneId, text: '@api preserve compatibility', replyTo: '   ' });
  service.boardRead({ from, seqs: [mention.boardSeq] });
  await service.boardPost({ from, text: 'For background see #' + mention.boardSeq, kind: 'update' });
  assert.equal(store.getMessageById(mention.post.id).receipts.api, 'delivered');
  service.reply({ id: mention.post.id, from, body: 'Compatibility confirmed' });
  assert.equal(store.getMessageById(mention.post.id).receipts.api, 'replied');
});

test('named reads, peeks and follow-up preserve earlier unread mentions and general posts', async t => {
  const { service, store, coordPaneId } = createHarness(t);
  const worker = await service.delegateTask({ from: coordPaneId, role: 'api', agent: 'claude', task: 'Review', worktree: false });
  const from = worker.ptyId;
  const runId = worker.run.id;
  const insert = (body, mentions) => store.insertMessage({
    runId, from: coordPaneId, fromRole: 'coordinator', to: 'run:' + runId, subject: body, body, mentions, kind: 'post',
  });
  const first = insert('first action', ['api']);
  const second = insert('second action', ['api']);
  const fyi = insert('FYI');
  const cursor = store.getMemberCursor(runId, 'api');
  for (let i = 0; i < 2; i++) {
    const preview = await service.boardWait({ from, peek: true });
    assert.deepEqual(preview.posts.map(post => post.id), [first.id, second.id]);
  }
  assert.deepEqual(store.getMemberCursor(runId, 'api'), cursor);
  assert.equal(store.getMessageById(first.id).receipts?.api, undefined);
  service.boardRead({ from, seqs: [second.boardSeq] });
  assert.deepEqual((await service.boardWait({ from, timeoutMs: 0 })).posts.map(post => post.id), [first.id]);
  assert.equal((await service.boardWait({ from, timeoutMs: 0 })).timedOut, true);

  await service.workerDoneByPane(from, { outcome: 'completed', summary: 'finished' });
  const later = insert('Waiting since settlement', ['api']);
  const next = await service.boardPost({ from: coordPaneId, text: '@api follow up' });
  const latest = store.listDispatches({ runId }).find(dispatch => dispatch.followUpOfDispatchId === worker.dispatch.id);
  const resumed = latest.assigneePaneId ?? latest.assigneeHandle;
  const targeted = await service.boardWait({ from: resumed, timeoutMs: 0 });
  assert.ok(targeted.posts.some(post => post.id === later.id));
  assert.ok(!targeted.posts.some(post => post.id === next.post.id));
  assert.ok((await service.boardWait({ from: resumed, mentionsOnly: false, timeoutMs: 0 })).posts.some(post => post.id === fyi.id));
});
