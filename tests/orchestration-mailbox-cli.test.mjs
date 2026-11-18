import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ipcMain } from 'electron';

import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import {
  OrchestrationError,
} from '../dist-electron/orchestration/orchestration-types.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { createOrchestrationBinShim } from '../dist-electron/orchestration/orchestration-bin-shim.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { registerOrchestrationIpc } from '../dist-electron/ipc/orchestration.js';

const execFileAsync = promisify(execFile);

test('mailbox routing, peek vs delivery consumption, --ack holdAck, wait & abort, and group send', async () => {
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  agentStatusStore.registerPane('w1', { agentId: 'codex' });
  agentStatusStore.registerPane('w2', { agentId: 'pi' });

  const writes = [];
  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      writes.push({ ptyId, data });
      return { ok: true };
    },
  });

  const { run } = service.runCreate({ id: 'run_mb', objective: 'Mailbox test', from: 'coord', paneId: 'coord' });
  const { task: t1 } = service.taskCreate({ id: 't1', runId: run.id, spec: 'Worker 1 task' });
  const { task: t2 } = service.taskCreate({ id: 't2', runId: run.id, spec: 'Worker 2 task' });
  await service.dispatchTask({ taskId: t1.id, to: 'w1', from: 'coord', inject: false });
  await service.dispatchTask({ taskId: t2.id, to: 'w2', from: 'coord', inject: false });

  // Group @workers broadcast delivers to active workers only, excluding sender.
  const broadcast = service.send({
    from: 'coord',
    to: '@workers',
    type: 'status',
    subject: 'Freeze',
    body: 'Hold deployments',
    runId: run.id,
  });
  assert.equal(broadcast.recipients?.length, 2);

  // Also send direct mail to w1 handle -> must route into w1's dispatch mailbox on check.
  service.send({
    from: 'coord',
    to: 'w1',
    type: 'status',
    subject: 'Direct note',
    body: 'Check foo.ts',
    runId: run.id,
  });

  // Peek must be non-destructive.
  const peeked1 = await service.check({ from: 'w1', peek: true });
  const peeked2 = await service.check({ from: 'w1', peek: true });
  assert.equal(peeked1.count, 2);
  assert.equal(peeked2.count, 2);
  assert.equal(peeked1.deliveryId, null);

  // Consuming check with holdAck leaves delivery pending until explicit --ack.
  const held = await service.check({ from: 'w1', holdAck: true });
  assert.equal(held.count, 2);
  assert.ok(held.deliveryId);

  // Replay unacked delivery returns same deliveryId with replayed=true.
  const replayed = await service.check({ from: 'w1', holdAck: true });
  assert.equal(replayed.deliveryId, held.deliveryId);
  assert.equal(replayed.replayed, true);

  // Wrong mailbox passing w1's deliveryId is rejected as stale_delivery.
  await assert.rejects(
    () => service.check({ from: 'w2', ack: held.deliveryId }),
    (err) => err instanceof OrchestrationError && err.code === 'stale_delivery'
  );

  // Explicit --ack without --wait acknowledges cleanly and returns 0 new messages.
  const acked = await service.check({ from: 'w1', ack: held.deliveryId });
  assert.equal(acked.acknowledged, held.deliveryId);
  assert.equal(acked.count, 0);

  // Waiter wakes cleanly when new mail arrives; AbortSignal cancels waiter immediately.
  const waitPromise = service.check({ from: 'w1', wait: true, timeoutMs: 5000 });
  setTimeout(() => {
    service.send({
      from: 'coord',
      to: 'w1',
      type: 'status',
      subject: 'Wakeup',
      body: 'Go ahead',
      runId: run.id,
    });
  }, 20);
  const woken = await waitPromise;
  assert.equal(woken.count, 1);
  assert.equal(woken.timedOut, false);
  assert.equal(woken.messages[0].subject, 'Wakeup');

  const ac = new AbortController();
  const abortedPromise = service.check({ from: 'w1', wait: true, timeoutMs: 5000 }, ac.signal);
  setTimeout(() => ac.abort(), 15);
  const aborted = await abortedPromise;
  assert.equal(aborted.cancelled, true);
  assert.equal(aborted.connectionLost, true);

  service.dispose();
});

test('ask & reply thread idempotency, conflict refusal, closed-dispatch wakeup, and finished report reply refusal', async () => {
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  agentStatusStore.registerPane('w1', { agentId: 'codex' });

  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async () => ({ ok: true }),
  });

  const { run } = service.runCreate({ id: 'run_ask', objective: 'Ask thread test', from: 'coord', paneId: 'coord' });
  const { task } = service.taskCreate({ id: 't1', runId: run.id, spec: 'Implement API' });
  const { dispatch } = await service.dispatchTask({
    taskId: task.id,
    to: 'w1',
    from: 'coord',
    inject: false,
  });

  // Worker calls ask --wait; coordinator inspects run inbox, sees question, replies.
  const askPromise = service.ask({
    from: 'w1',
    to: 'coordinator',
    question: 'Use REST or GraphQL?',
    options: ['REST', 'GraphQL'],
    wait: true,
    timeoutMs: 5000,
  });

  // Give ask microtask a moment to register message.
  await new Promise((r) => setTimeout(r, 10));
  const coordInbox = await service.check({ from: 'coord' });
  assert.equal(coordInbox.count, 1);
  const qMsg = coordInbox.messages[0];
  assert.equal(qMsg.type, 'question');

  const rep = service.reply({ id: qMsg.id, body: 'Use REST', from: 'coord' });
  assert.equal(rep.duplicate, false);

  const askResult = await askPromise;
  assert.equal(askResult.answer, 'Use REST');
  assert.equal(askResult.pending, false);

  // Answer message was marked read for w1 so w1 does not see duplicate copy.
  const w1Check = await service.check({ from: 'w1' });
  assert.equal(w1Check.count, 0);

  // Duplicate same reply is idempotent; conflicting reply throws answer_conflict.
  const dupRep = service.reply({ id: qMsg.id, body: 'Use REST', from: 'coord' });
  assert.equal(dupRep.duplicate, true);
  assert.throws(
    () => service.reply({ id: qMsg.id, body: 'Use GraphQL', from: 'coord' }),
    (err) => err instanceof OrchestrationError && err.code === 'answer_conflict'
  );

  // Worker completes dispatch -> replying to finished worker_done report must fail with dispatch_inactive.
  const doneRes = service.workerDone({
    capability: service.store.getDispatchCapability(dispatch.id),
    from: 'w1',
    taskId: task.id,
    dispatchId: dispatch.id,
    outcome: 'completed',
    summary: 'REST API ready',
  });
  assert.throws(
    () => service.reply({ id: doneRes.message.id, body: 'Thanks!', from: 'coord' }),
    (err) => err instanceof OrchestrationError && err.code === 'dispatch_inactive'
  );

  service.dispose();
});

test('pointer delivery defers while pane is working, triggers on idle transition, and retries if PTY write fails', async () => {
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('w1', { agentId: 'codex' });
  agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'working' });

  let failNextWrite = true;
  const writes = [];
  const store = new OrchestrationStore();
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      if (failNextWrite) {
        return { ok: false, error: 'PTY busy' };
      }
      writes.push({ ptyId, data });
      return { ok: true };
    },
  });

  service.send({
    from: 'coord',
    to: 'w1',
    type: 'status',
    subject: 'New mail',
    body: 'Please check',
  });

  // Wait past pointer debounce while working -> no injection yet.
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(writes.length, 0);

  // Transition to idle while writePty still fails -> delivery watermark rolls back safely.
  agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'idle' });
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(writes.length, 0);
  const msg = store.listMessages({ toHandle: 'w1' })[0];
  assert.equal(msg.deliveredAt, null);

  // Now recover writePty and emit working -> done transition -> pointer delivered!
  failNextWrite = false;
  agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'working' });
  agentStatusStore.ingestHookEvent({ ptyId: 'w1', state: 'done' });
  await new Promise((r) => setTimeout(r, 250));
  assert.ok(writes.some((w) => w.ptyId === 'w1' && w.data.includes('aha orchestration check')));
  assert.ok(writes.some((w) => w.ptyId === 'w1' && w.data === '\r'));
  assert.ok(store.listMessages({ toHandle: 'w1' })[0].deliveredAt !== null);

  service.dispose();
});

test('AgentHookServer auth, real aha-orchestration-cli execution via injected PTY env, and IPC authorization', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'aha-orch-cli-'));
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  agentStatusStore.registerPane('w1', { agentId: 'codex' });

  const store = new OrchestrationStore({ resolveFile: () => join(tmpDir, 'orch.json') });
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async () => ({ ok: true }),
  });

  const hookServer = new AgentHookServer(agentStatusStore);
  const binShim = createOrchestrationBinShim({
    binDir: join(tmpDir, 'bin'),
    nodeExecPath: process.execPath,
    cliScriptPath: resolve(process.cwd(), 'dist-electron/orchestration/aha-orchestration-cli.cjs'),
  });
  hookServer.setOrchestrationBinShim(binShim);
  hookServer.setOrchestrationHandler((action, payload, ctx) =>
    dispatchOrchestrationHttpAction(service, action, payload, ctx)
  );
  const { port } = await hookServer.start();

  try {
    // Reject unauthorized request to /orchestration/*.
    const unauth = await fetch(`http://127.0.0.1:${port}/orchestration/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(unauth.status, 403);

    const coordEnv = { ...process.env, ...hookServer.envForPane('coord') };
    const workerEnv = { ...process.env, ...hookServer.envForPane('w1') };
    const cliScript = resolve(process.cwd(), 'dist-electron/orchestration/aha-orchestration-cli.cjs');

    // Run real CLI invocations across coord & worker identities.
    const r1 = await execFileAsync(
      process.execPath,
      [cliScript, 'orchestration', 'run', 'create', '--objective', 'CLI E2E Run', '--json'],
      { env: coordEnv }
    );
    const createdRun = JSON.parse(r1.stdout);
    assert.ok(createdRun.run.id);

    const t1Res = await execFileAsync(
      process.execPath,
      [cliScript, 'orchestration', 'task', 'create', '--spec', 'CLI subtask', '--json'],
      { env: coordEnv }
    );
    const createdTask = JSON.parse(t1Res.stdout);

    const dRes = await execFileAsync(
      process.execPath,
      [
        cliScript,
        'orchestration',
        'dispatch',
        '--task',
        createdTask.task.id,
        '--to',
        'w1',
        '--no-inject',
        '--json',
      ],
      { env: coordEnv }
    );
    const dispatched = JSON.parse(dRes.stdout);
    assert.equal(dispatched.dispatch.assigneeHandle, 'w1');
    // The per-dispatch credential is delivered to the worker via its environment.
    workerEnv.AHA_DISPATCH_CAPABILITY = store.getDispatchCapability(dispatched.dispatch.id);

    // Worker sends status message using $AHA_TERMINAL_ID automatically (omits --from!).
    await execFileAsync(
      process.execPath,
      [
        cliScript,
        'orchestration',
        'send',
        '--to',
        'coordinator',
        '--type',
        'status',
        '--subject',
        'Working',
        '--body',
        'Halfway there',
      ],
      { env: workerEnv }
    );

    const coordCheck = await execFileAsync(
      process.execPath,
      [cliScript, 'orchestration', 'check', '--json'],
      { env: coordEnv }
    );
    const checked = JSON.parse(coordCheck.stdout);
    assert.equal(checked.count, 1);
    assert.equal(checked.messages[0].body, 'Halfway there');

    // Worker completes task via worker-done verb.
    const wdRes = await execFileAsync(
      process.execPath,
      [
        cliScript,
        'orchestration',
        'worker-done',
        '--task',
        createdTask.task.id,
        '--dispatch',
        dispatched.dispatch.id,
        '--outcome',
        'completed',
        '--summary',
        'Finished via CLI',
        '--json',
      ],
      { env: workerEnv }
    );
    const donePayload = JSON.parse(wdRes.stdout);
    assert.equal(donePayload.task.status, 'completed');
    assert.equal(donePayload.dispatch.status, 'completed');

    // Also test spawning via injected `aha` shim command directly on PATH!
    const shimCmd = process.platform === 'win32' ? 'aha.cmd' : 'aha';
    const shimRes = await execFileAsync(
      shimCmd,
      ['orchestration', 'run-list', '--json'],
      {
        env: coordEnv,
        shell: process.platform === 'win32',
      }
    );
    const listedRuns = JSON.parse(shimRes.stdout);
    assert.equal(listedRuns.count, 1);

    // IPC registration & unauthorized sender check + push event forwarding.
    const sentEvents = [];
    let mainWebContentsId = 10;
    const { dispose: disposeIpc } = registerOrchestrationIpc({
      liveWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          id: mainWebContentsId,
          send: (channel, data) => sentEvents.push({ channel, data }),
        },
      }),
      getCurrentCwd: () => tmpDir,
      orchestrationService: service,
    });

    try {
      const snapHandler = ipcMain._handlers?.get('orchestration:get-snapshot');
      if (snapHandler) {
        await assert.rejects(
          () => snapHandler({ sender: { id: 999 } }, {}),
          /Sender is not the main window/
        );
        const okSnap = await snapHandler({ sender: { id: 10 } }, {});
        assert.equal(okSnap.ok, true);
        assert.equal(okSnap.snapshot.tasks[0].status, 'completed');
      }

      service.runCreate({ objective: 'Push event verify', from: 'coord' });
      assert.ok(sentEvents.some((e) => e.channel === 'orchestration:event'));
    } finally {
      disposeIpc();
    }
  } finally {
    await hookServer.stop();
    service.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MessageWake sharing, forwarded dispatch mail, ask --resume & close wakeup, and HTTP ask/gate flows', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'aha-orch-edge-'));
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  agentStatusStore.registerPane('w1', { agentId: 'codex' });

  const store = new OrchestrationStore({ resolveFile: () => join(tmpDir, 'orch.json') });
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async () => ({ ok: true }),
  });

  const hookServer = new AgentHookServer(agentStatusStore);
  hookServer.setOrchestrationHandler((action, payload, ctx) =>
    dispatchOrchestrationHttpAction(service, action, payload, ctx)
  );
  const { port } = await hookServer.start();

  try {
    const { run } = service.runCreate({ id: 'run_edge', objective: 'Edge tests', from: 'coord', paneId: 'coord' });
    const { task: t1 } = service.taskCreate({ id: 't1', runId: run.id, spec: 'Task 1' });
    const { task: t2 } = service.taskCreate({ id: 't2', runId: run.id, spec: 'Task 2' });
    const { dispatch: d1 } = await service.dispatchTask({
      taskId: t1.id,
      to: 'w1',
      from: 'coord',
      inject: false,
    });

    // Two concurrent check --wait callers on same mailbox share one MessageWake batch cleanly.
    const wWait1 = service.check({ from: 'w1', wait: true, timeoutMs: 3000 });
    const wWait2 = service.check({ from: 'w1', wait: true, timeoutMs: 3000 });
    setTimeout(() => {
      service.send({
        from: 'coord',
        to: `dispatch:${d1.id}`,
        type: 'status',
        subject: 'Shared wake batch',
        body: 'Shared content',
      });
    }, 20);
    const [res1, res2] = await Promise.all([wWait1, wWait2]);
    assert.equal(res1.count, 1);
    assert.equal(res2.count, 1);
    assert.equal(res1.deliveryId, res2.deliveryId);

    // Unread mail sent to dispatch:<d1.id> right before worker_done forwards to run:<run.id>.
    service.send({
      from: 'peer',
      to: `dispatch:${d1.id}`,
      type: 'handoff',
      subject: 'Leftover context',
      body: 'Need coordinator handoff',
    });
    service.workerDone({
    capability: service.store.getDispatchCapability(d1.id), from: 'w1', taskId: t1.id, dispatchId: d1.id, outcome: 'completed' });
    const coordCheck = await service.check({ from: 'coord', types: ['handoff'] });
    assert.equal(coordCheck.count, 1);
    assert.equal(coordCheck.messages[0].subject, 'Leftover context');

    // Non-blocking ask -> coordinator reply -> ask --resume receives answer immediately.
    const { dispatch: d2 } = await service.dispatchTask({
      taskId: t2.id,
      to: 'w1',
      from: 'coord',
      inject: false,
    });
    const nonBlockAsk = await service.ask({
      from: 'w1',
      to: 'coordinator',
      question: 'Async Q?',
      wait: false,
    });
    assert.equal(nonBlockAsk.pending, true);
    service.reply({ id: nonBlockAsk.messageId, body: 'Async Answer', from: 'coord' });
    const resumed = await service.ask({ from: 'w1', resume: nonBlockAsk.messageId, wait: true });
    assert.equal(resumed.answer, 'Async Answer');
    assert.equal(resumed.pending, false);

    // Waiting ask rejects immediately with dispatch_inactive when dispatch settles concurrently.
    const abortingAsk = service.ask({
      from: 'w1',
      to: 'coordinator',
      question: 'Will close mid-wait?',
      wait: true,
      timeoutMs: 10_000,
    });
    setTimeout(() => {
      service.workerDone({
    capability: service.store.getDispatchCapability(d2.id), from: 'w1', taskId: t2.id, dispatchId: d2.id, outcome: 'abandoned' });
    }, 25);
    await assert.rejects(
      () => abortingAsk,
      (err) => err instanceof OrchestrationError && err.code === 'dispatch_inactive'
    );

    // CLI long-poll ask --wait + gate-create / gate-resolve via HTTP over AgentHookServer.
    const workerEnv = { ...process.env, ...hookServer.envForPane('w1') };
    const coordEnv = { ...process.env, ...hookServer.envForPane('coord') };
    const cliScript = resolve(process.cwd(), 'dist-electron/orchestration/aha-orchestration-cli.cjs');

    const gCreatedOut = await execFileAsync(
      process.execPath,
      [
        cliScript,
        'orchestration',
        'gate',
        'create',
        '--task',
        t2.id,
        '--question',
        'Retry strategy?',
        '--options',
        'backoff,immediate',
        '--json',
      ],
      { env: coordEnv }
    );
    const gCreated = JSON.parse(gCreatedOut.stdout);
    assert.equal(gCreated.gate.status, 'pending');
    assert.equal(service.store.getTask(t2.id)?.status, 'blocked');

    const gResolvedOut = await execFileAsync(
      process.execPath,
      [
        cliScript,
        'orchestration',
        'gate',
        'resolve',
        '--id',
        gCreated.gate.id,
        '--resolution',
        'backoff',
        '--json',
      ],
      { env: coordEnv }
    );
    const gResolved = JSON.parse(gResolvedOut.stdout);
    assert.equal(gResolved.gate.status, 'resolved');
    assert.equal(service.store.getTask(t2.id)?.status, 'ready');

    const { dispatch: d3 } = await service.dispatchTask({
      taskId: t2.id,
      to: 'w1',
      from: 'coord',
      inject: false,
    });
    const askCliPromise = execFileAsync(
      process.execPath,
      [
        cliScript,
        'orchestration',
        'ask',
        '--question',
        'Confirm target port?',
        '--wait',
        '--json',
      ],
      { env: workerEnv }
    );

    // Wait briefly for CLI HTTP POST /orchestration/ask to register pending question, then reply via HTTP.
    let qId = null;
    for (let i = 0; i < 40; i++) {
      const pendingQs = service.store.listQuestions({ dispatchId: d3.id, status: 'pending' });
      if (pendingQs.length > 0) {
        qId = pendingQs[0].messageId;
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.ok(qId);

    const token = coordEnv.AHA_AGENT_HOOK_TOKEN;
    // Worker cannot spoof a reply to its own blocking question.
    const spoofResp = await fetch(`http://127.0.0.1:${port}/orchestration/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aha-agent-hook-token': token,
        'x-aha-pty-id': workerEnv.AHA_TERMINAL_ID,
        'x-aha-pane-token': workerEnv.AHA_ORCHESTRATION_PANE_TOKEN,
      },
      body: JSON.stringify({ id: qId, body: '9999', from: 'coord' }),
    });
    assert.equal(spoofResp.status, 400);

    const replyResp = await fetch(`http://127.0.0.1:${port}/orchestration/reply`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-aha-agent-hook-token': token,
        'x-aha-pty-id': coordEnv.AHA_TERMINAL_ID,
        'x-aha-pane-token': coordEnv.AHA_ORCHESTRATION_PANE_TOKEN,
      },
      body: JSON.stringify({ id: qId, body: '8080', from: 'coord' }),
    });
    assert.equal(replyResp.status, 200);

    const askCliDone = await askCliPromise;
    const askJson = JSON.parse(askCliDone.stdout);
    assert.equal(askJson.answer, '8080');
    assert.equal(askJson.pending, false);

    // Consumer fencing over check --ack via service when runUse rebinds coordinator.
    const { run: fenceRun } = service.runCreate({ id: 'run_cli_fence', objective: 'Fence', from: 'coord', paneId: 'coord' });
    service.send({ from: 'w1', to: `run:${fenceRun.id}`, type: 'status', subject: 'Held msg', body: 'hi', runId: fenceRun.id });
    const heldCheck = await service.check({ from: 'coord', runId: fenceRun.id, holdAck: true });
    assert.ok(heldCheck.deliveryId);
    service.runUse({ id: fenceRun.id, from: 'coord-2', paneId: 'coord' });
    await assert.rejects(
      () => service.check({ from: 'coord', runId: fenceRun.id, ack: heldCheck.deliveryId }),
      (err) => err instanceof OrchestrationError && err.code === 'consumer_fenced'
    );
  } finally {
    await hookServer.stop();
    service.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('MessageWake replay flag & filter isolation, handed-back lower-seq pointer delivery, CLI boolean-flag positional parsing, and Windows Path case handling', async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'aha-orch-regressions-'));
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  agentStatusStore.registerPane('w1', { agentId: 'codex' });

  const writes = [];
  const store = new OrchestrationStore({ resolveFile: () => join(tmpDir, 'orch.json') });
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      writes.push({ ptyId, data });
      return { ok: true };
    },
  });

  const hookServer = new AgentHookServer(agentStatusStore);
  const binShim = createOrchestrationBinShim({
    binDir: join(tmpDir, 'bin'),
    nodeExecPath: process.execPath,
    cliScriptPath: resolve(process.cwd(), 'dist-electron/orchestration/aha-orchestration-cli.cjs'),
  });
  hookServer.setOrchestrationBinShim(binShim);
  hookServer.setOrchestrationHandler((action, payload, ctx) =>
    dispatchOrchestrationHttpAction(service, action, payload, ctx)
  );
  await hookServer.start();

  try {
    // 1. applyToEnv handles pre-existing 'Path' without duplicating 'PATH'.
    const winEnv = binShim.applyToEnv({ Path: 'C:\\Windows\\System32' });
    assert.equal(winEnv.PATH, undefined);
    assert.ok(winEnv.Path.startsWith(join(tmpDir, 'bin')));

    const { run } = service.runCreate({ id: 'run_wake', objective: 'Wake & pointer regressions', from: 'coord', paneId: 'coord' });
    const { task: t1 } = service.taskCreate({ id: 't1', runId: run.id, spec: 'Step 1' });
    const { dispatch: d1 } = await service.dispatchTask({ taskId: t1.id, to: 'w1', from: 'coord', inject: false });

    // 2. Two same-filter check --wait callers: first gets replayed=false, second gets replayed=true;
    //    different-filter waiter does NOT steal/cross-receive wrong type.
    const sameWait1 = service.check({ from: 'w1', wait: true, timeoutMs: 3000 });
    const sameWait2 = service.check({ from: 'w1', wait: true, timeoutMs: 3000 });
    const handoffWait = service.check({ from: 'w1', wait: true, types: ['handoff'], timeoutMs: 80 });
    setTimeout(() => {
      service.send({ from: 'coord', to: `dispatch:${d1.id}`, type: 'status', subject: 'Only status', body: 'hi' });
    }, 20);
    const [sw1, sw2, hw] = await Promise.all([sameWait1, sameWait2, handoffWait]);
    assert.equal(sw1.count, 1);
    assert.equal(sw2.count, 1);
    assert.equal(sw1.replayed, false);
    assert.equal(sw2.replayed, true);
    assert.equal(hw.timedOut, true);
    assert.equal(hw.count, 0);

    // 3. Lower-seq mail sent to dispatch:d1 before higher-seq mail was delivered to coord
    //    still triggers pointer notification on coord after dispatch closes & hands mail back!
    const lowSeqHandback = store.insertMessage({
      runId: run.id,
      from: 'peer',
      to: `dispatch:${d1.id}`,
      type: 'handoff',
      subject: 'Lower seq handoff',
      body: 'Details',
    });
    // Mark as delivered on w1 first to prove hand-back resets deliveredAt for coord.
    store.markAsDelivered([lowSeqHandback.id]);
    service.send({ from: 'w1', to: `run:${run.id}`, type: 'status', subject: 'Higher seq msg', body: 'Later' });
    await new Promise((r) => setTimeout(r, 220));
    const writesBeforeHandback = writes.length;

    service.workerDone({
    capability: service.store.getDispatchCapability(d1.id), from: 'w1', taskId: t1.id, dispatchId: d1.id, outcome: 'completed' });
    await new Promise((r) => setTimeout(r, 250));
    assert.ok(writes.length > writesBeforeHandback, 'handed-back lower-seq message must notify coordinator pane');
    assert.equal(store.getMessageById(lowSeqHandback.id)?.toHandle, `run:${run.id}`);

    // 4. CLI boolean flags before positional arguments must NOT swallow positional args.
    const coordEnv = { ...process.env, ...hookServer.envForPane('coord') };
    const cliScript = resolve(process.cwd(), 'dist-electron/orchestration/aha-orchestration-cli.cjs');
    const { task: t2 } = service.taskCreate({ id: 't2', runId: run.id, spec: 'Positional dry-run task' });
    const dryRes = await execFileAsync(
      process.execPath,
      [cliScript, 'orchestration', 'dispatch', '--dry-run', t2.id, '--json'],
      { env: coordEnv }
    );
    const dryParsed = JSON.parse(dryRes.stdout);
    assert.equal(dryParsed.dryRun, true);
    assert.match(dryParsed.preamble, /Positional dry-run task/);

    const showRes = await execFileAsync(
      process.execPath,
      [cliScript, 'orchestration', 'dispatch-show', '--preamble', t2.id, '--json'],
      { env: coordEnv }
    );
    assert.match(JSON.parse(showRes.stdout).preamble, /Positional dry-run task/);
  } finally {
    await hookServer.stop();
    service.dispose();
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
