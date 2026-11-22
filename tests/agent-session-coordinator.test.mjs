import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { AgentSessionManager } from '../dist-electron/orchestration/agent-session-manager.js';
import {
  COORDINATOR_APPROVED_MCP_TOOLS, CodexAppServerPilot, codexMcpConfigArgs,
} from '../dist-electron/orchestration/codex-app-server-pilot.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';

const cwd = process.cwd();
const SESSION_A = 'agent-session-00000000-0000-0000-0000-00000000000a';
const SESSION_B = 'agent-session-00000000-0000-0000-0000-00000000000b';
const WORKER = 'codex-worker-00000000-0000-0000-0000-000000000001';

async function mcpRequest(env, method, params, spawnCwd = cwd) {
  const child = spawn(process.execPath, [join(cwd, 'electron/orchestration/aha-mcp-server.cjs')], {
    cwd: spawnCwd, env: { ...process.env, AHA_TERMINAL_ID: '', AHA_WORKER_ID: '', ...env }, stdio: 'pipe', windowsHide: true,
  });
  const closed = new Promise((resolve) => child.once('close', resolve));
  const lines = createInterface({ input: child.stdout });
  try {
    const answer = new Promise((resolve, reject) => {
      child.once('error', reject);
      lines.on('line', (line) => {
        const message = JSON.parse(line);
        if (message.id === 1) resolve(message.result);
      });
      child.once('close', () => reject(new Error('MCP server exited before responding')));
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) + '\n');
    return await answer;
  } finally {
    child.stdin.end();
    child.kill();
    await closed;
  }
}

async function setup(t, { confirmMode = 'auto', stallThresholdMs, pilotEnabled = true } = {}) {
  const dir = mkdtempSync(join(cwd, '.session-coordinator-test-'));
  const agentStatusStore = new AgentStatusStore();
  const store = new OrchestrationStore({ resolveFile: () => join(dir, 'state.json') });
  const hook = new AgentHookServer(agentStatusStore);
  const launches = [];
  const sessions = new Map();
  const service = new OrchestrationService({
    store, agentStatusStore, getDefaultCwd: () => cwd,
    settleDelayMs: 0, turnStartObserveTimeoutMs: 250, turnStopSettleMs: 10_000,
    getConfirmMode: () => confirmMode,
    ...(stallThresholdMs ? { stallThresholdMs } : {}),
    writePty: async () => ({ ok: true }),
    spawnWorkerPty: async () => { throw new Error('Session Coordinator tests expect headless Workers'); },
    isPtyAlive: (id) => id === 'coordinator-pane',
    codexPilot: {
      enabled: () => pilotEnabled,
      launch(workerId, workdir, events) {
        launches.push({ workerId, workdir });
        const child = spawn(process.execPath, [join(cwd, 'tests/fixtures/mock-codex-app-server.mjs'), 'normal'], {
          cwd: workdir, stdio: 'pipe', windowsHide: true,
        });
        return new CodexAppServerPilot(child, events, 850, []);
      },
    },
  });
  service.setSessionCoordinators({ get: (id) => sessions.get(id) ?? null });
  hook.setOrchestrationHandler((action, payload, context) => dispatchOrchestrationHttpAction(service, action, payload, context));
  await hook.start();
  agentStatusStore.registerPane('coordinator-pane', { agentId: 'codex' });
  t.after(async () => {
    await hook.stop();
    await service.stopCodexWorkers();
    service.dispose();
    await service.waitForPendingWrites();
    rmSync(dir, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
  });
  const call = (caller, action, payload = {}) =>
    dispatchOrchestrationHttpAction(service, action, payload, { signal: new AbortController().signal, callerPaneId: caller })
      .then((reply) => reply.body);
  return { dir, hook, service, store, sessions, launches, call };
}

test('session MCP launch carries session credentials and keeps destructive Coordinator tools behind a prompt', async (t) => {
  const hook = new AgentHookServer(new AgentStatusStore());
  await hook.start();
  t.after(() => hook.stop());
  const env = hook.envForSession(SESSION_A);
  const args = codexMcpConfigArgs('node', {
    serverPath: 'aha-mcp-server.cjs', env, approvedTools: COORDINATOR_APPROVED_MCP_TOOLS,
  }).filter((arg) => arg !== '-c');
  const envArg = args.find((arg) => arg.startsWith('mcp_servers.aha.env='));
  assert.match(envArg, new RegExp('AHA_SESSION_ID = "' + SESSION_A + '"'));
  assert.doesNotMatch(envArg, /AHA_WORKER_ID|AHA_TERMINAL_ID/);
  const approved = args.filter((arg) => arg.endsWith('.approval_mode="approve"'))
    .map((arg) => arg.split('.')[3]);
  assert.ok(approved.includes('delegate_task'));
  for (const tool of ['manage_worker', 'integrate_worker', 'finalize_run_integration', 'report_done']) {
    assert.ok(!approved.includes(tool), tool);
  }
  const worker = codexMcpConfigArgs('node', { serverPath: 'x', env: {} }).filter((arg) => arg.endsWith('"approve"'));
  assert.deepEqual(worker.map((arg) => arg.split('.')[3]), ['report_done', 'read_board']);
});

test('session credentials authenticate only as that session and only on orchestration routes', async (t) => {
  const hook = new AgentHookServer(new AgentStatusStore());
  const seen = [];
  hook.setOrchestrationHandler(async (_action, _payload, context) => {
    seen.push(context.callerPaneId);
    return { status: 200, body: { ok: true } };
  });
  hook.setCompanionHandler(async () => ({ status: 200, body: { ok: true } }));
  assert.throws(() => hook.envForSession(SESSION_A), /Cannot configure/);
  await hook.start();
  t.after(() => hook.stop());
  assert.throws(() => hook.envForSession('not-a-session'), /Cannot configure/);
  const a = hook.envForSession(SESSION_A);
  const b = hook.envForSession(SESSION_B);
  const worker = hook.envForWorker(WORKER);
  assert.deepEqual(Object.keys(a).sort(), ['AHA_AGENT_HOOK_TOKEN', 'AHA_ORCHESTRATION_URL', 'AHA_SESSION_ID', 'AHA_SESSION_TOKEN']);
  assert.notEqual(a.AHA_SESSION_TOKEN, b.AHA_SESSION_TOKEN);
  assert.notEqual(a.AHA_AGENT_HOOK_TOKEN, hook.authToken);
  const origin = new URL(a.AHA_ORCHESTRATION_URL).origin;
  const post = async (path, headers) => {
    const response = await fetch(origin + path, { method: 'POST', headers, body: '{}' });
    await response.text();
    return response.status;
  };
  const asSession = (env, id = env.AHA_SESSION_ID, token = env.AHA_SESSION_TOKEN) => ({
    'x-aha-agent-hook-token': env.AHA_AGENT_HOOK_TOKEN, 'x-aha-session-id': id, 'x-aha-session-token': token,
  });

  assert.equal(await post('/orchestration/mcp-context', asSession(a)), 200);
  assert.deepEqual(seen, [SESSION_A]);
  // Not on companion routes, not with another session's identity, and never mixed with Worker credentials.
  assert.equal(await post('/terminal/send', asSession(a)), 403);
  assert.equal(await post('/orchestration/mcp-context', asSession(a, SESSION_B)), 403);
  assert.equal(await post('/orchestration/mcp-context', asSession(a, SESSION_A, b.AHA_SESSION_TOKEN)), 403);
  assert.equal(await post('/orchestration/mcp-context', { ...asSession(a), 'x-aha-agent-hook-token': b.AHA_AGENT_HOOK_TOKEN }), 403);
  assert.equal(await post('/orchestration/mcp-context', {
    ...asSession(a), 'x-aha-worker-id': WORKER, 'x-aha-worker-token': worker.AHA_WORKER_TOKEN,
  }), 403);
  // Worker credentials cannot be replayed as a session, nor session credentials as a Worker.
  assert.equal(await post('/orchestration/mcp-context', asSession(worker, SESSION_A, worker.AHA_WORKER_TOKEN)), 403);
  assert.equal(await post('/orchestration/mcp-context', {
    'x-aha-agent-hook-token': a.AHA_AGENT_HOOK_TOKEN, 'x-aha-worker-id': WORKER, 'x-aha-worker-token': a.AHA_SESSION_TOKEN,
  }), 403);
  assert.equal(await post('/orchestration/mcp-context', { 'x-aha-agent-hook-token': a.AHA_AGENT_HOOK_TOKEN }), 403);
  // A pane credential minted for a session id does not make the session id a pane caller.
  const pane = hook.envForPane(SESSION_A);
  assert.equal(await post('/orchestration/mcp-context', {
    'x-aha-agent-hook-token': pane.AHA_AGENT_HOOK_TOKEN, 'x-aha-pty-id': SESSION_A, 'x-aha-pane-token': pane.AHA_ORCHESTRATION_PANE_TOKEN,
  }), 200);
  assert.deepEqual(seen, [SESSION_A, null]);
});

test('an orchestrating session gets Coordinator actions only, and only while orchestration mode is on', async (t) => {
  const app = await setup(t);
  const sessionCwd = mkdtempSync(join(app.dir, 'session-cwd-'));
  assert.equal((await app.call(SESSION_A, 'mcp-context')).code, 'operation_rejected');
  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'codex', active: false });
  const off = await app.call(SESSION_A, 'mcp-context');
  assert.equal(off.code, 'operation_rejected');
  assert.match(off.error, /not in orchestration mode/);

  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'codex', active: true });
  const context = await app.call(SESSION_A, 'mcp-context');
  assert.equal(context.ok, true);
  assert.equal(context.result.role, 'coordinator');
  assert.equal(context.result.orchestrationMode, true);
  assert.equal(context.result.canDelegate, true);

  for (const action of [
    'worker-start', 'dispatch', 'run-create', 'run-use', 'task-create', 'task-update', 'approve', 'deny', 'reset',
    'pane-mode-set', 'worker-done-self', 'ask-self', 'ask', 'reply', 'gate-create', 'gate-resolve', 'coordinator-start',
    'coordinator-stop', 'coordinator-tick', 'send', 'worker-stop', 'worker-release', 'worker-abandon',
    'proposal-approve', 'proposal-reject', 'snapshot', 'worker-done',
  ]) {
    assert.equal((await app.call(SESSION_A, action, {})).code, 'operation_rejected', action);
  }

  const started = await app.call(SESSION_A, 'delegate-task', {
    role: 'scout', task: 'Survey the repository', agent: 'codex', taskKind: 'research', worktree: false,
  });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.result.status, 'started');
  const dispatch = app.store.getDispatchContext(started.result.dispatch.id);
  assert.equal(dispatch.parentPaneId, SESSION_A);
  assert.equal(dispatch.creator, SESSION_A);
  const run = app.store.getRun(dispatch.runId);
  assert.equal(run.coordinatorPaneId, SESSION_A);
  assert.equal(app.launches.at(-1).workdir, sessionCwd);
  assert.equal(app.service.isCoordinatorTerminal(SESSION_A), true);

  const team = await app.call(SESSION_A, 'mcp-context');
  assert.deepEqual(team.result.workers.map((w) => w.role), ['scout']);
  const inbox = await app.call(SESSION_A, 'inbox', { from: 'coordinator-pane' });
  assert.equal(inbox.ok, true);
  assert.notEqual(inbox.result.mailbox, 'coordinator-pane');

  // A session is never a Worker terminal: not for another session, not for a terminal Coordinator.
  app.sessions.set(SESSION_B, { cwd: sessionCwd, provider: 'codex', active: true });
  const hijack = await app.call(SESSION_B, 'delegate-task', {
    role: 'hijack', task: 'Use the other session', agent: 'codex', terminal: SESSION_A,
  });
  assert.equal(hijack.code, 'terminal_is_coordinator', hijack.error);
  assert.equal((await app.call(SESSION_B, 'delegate-task', {
    role: 'self', task: 'Use myself', agent: 'codex', terminal: SESSION_B,
  })).code, 'terminal_is_coordinator');
  const paneRun = app.service.runCreate({ objective: 'Pane run', from: 'coordinator-pane', paneId: 'coordinator-pane' }).run;
  const task = app.service.taskCreate({ runId: paneRun.id, spec: 'Direct dispatch' }).task;
  const direct = await app.call('coordinator-pane', 'dispatch', { taskId: task.id, to: SESSION_B });
  assert.equal(direct.code, 'terminal_is_coordinator', direct.error);

  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'codex', active: false });
  assert.equal((await app.call(SESSION_A, 'team-status')).code, 'operation_rejected');
  assert.equal((await app.call(SESSION_A, 'board-read')).code, 'operation_rejected');
  assert.equal(app.service.isPaneAlive(SESSION_A), false);
});

test('a session Coordinator sends read-only Codex tasks to the headless pilot even when the pilot setting is off', async (t) => {
  const app = await setup(t, { pilotEnabled: false });
  const sessionCwd = mkdtempSync(join(app.dir, 'session-cwd-'));
  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'codex', active: true });

  const started = await app.call(SESSION_A, 'delegate-task', {
    role: 'scout', task: 'Survey the repository', agent: 'codex', taskKind: 'research', worktree: false,
  });
  assert.equal(started.ok, true, started.error);
  assert.equal(started.result.status, 'started');
  assert.equal(started.result.dispatch.executionMode, 'codex-app-server');
  assert.equal(app.launches.length, 1);
  assert.equal(app.launches[0].workdir, sessionCwd);

  // A terminal Coordinator without the pilot setting still gets a PTY Worker; spawning fails here
  // because these tests never create real terminals.
  const pty = await app.call('coordinator-pane', 'delegate-task', {
    role: 'reader', task: 'Read the README', agent: 'codex', taskKind: 'research', worktree: false,
  });
  assert.equal(pty.code, 'terminal_unavailable', pty.error);
  assert.equal(app.launches.length, 1, 'the terminal Coordinator never reaches the pilot');
});

test('Aha MCP server exposes Coordinator tools to a session and delegates through its identity', async (t) => {
  const app = await setup(t);
  const sessionCwd = mkdtempSync(join(app.dir, 'session-cwd-'));
  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'codex', active: true });
  const env = app.hook.envForSession(SESSION_A);
  const listed = await mcpRequest(env, 'tools/list', {});
  const names = listed.tools.map((tool) => tool.name);
  assert.ok(names.includes('delegate_task'), names.join(','));
  assert.ok(names.includes('team_status'));
  assert.ok(!names.includes('report_done'));

  const result = await mcpRequest(env, 'tools/call', {
    name: 'delegate_task',
    arguments: { role: 'reader', task: 'Read the README', agent: 'codex', taskKind: 'research', worktree: false },
  }, sessionCwd);
  assert.notEqual(result.isError, true, result.content?.[0]?.text);
  const [dispatch] = app.store.listDispatches();
  assert.equal(dispatch.parentPaneId, SESSION_A);
  assert.equal(app.store.getRun(dispatch.runId).coordinatorPaneId, SESSION_A);

  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'codex', active: false });
  assert.deepEqual((await mcpRequest(env, 'tools/list', {})).tools, []);
});

function sessionSetup(t, {
  dir = mkdtempSync(join(cwd, '.session-coordinator-test-')), failOrchestration = false, owner = true, onUserTurn,
  onCoordinatorIdle,
} = {}) {
  const trace = join(dir, 'rpc.jsonl');
  const launches = [];
  const ended = [];
  const manager = new AgentSessionManager({
    launch: (id, workdir, events, { orchestration }) => {
      launches.push({ id, orchestration });
      if (orchestration && failOrchestration) throw new Error('Aha MCP Server is unavailable');
      return new CodexAppServerPilot(
        spawn(process.execPath, [join(cwd, 'tests/fixtures/mock-codex-app-server.mjs'), 'normal', trace], {
          cwd: workdir, stdio: 'pipe', windowsHide: true,
        }),
        events, 850, [], orchestration ? 'delegate_task' : null,
      );
    },
    coordinatorInstructions: (id) => `[AhaStation Orchestration Mode Active — Coordinator] for ${id}`,
    onCoordinatorEnded: (id) => ended.push(id),
    onUserTurn,
    onCoordinatorIdle,
    storageFile: () => join(dir, 'agent-sessions.json'),
  });
  if (owner) {
    t.after(async () => {
      await manager.dispose();
      rmSync(dir, { force: true, recursive: true, maxRetries: 20, retryDelay: 100 });
    });
  }
  const sent = (method) => {
    try {
      return readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
        .filter((message) => message.method === method).map((message) => message.params);
    } catch {
      return [];
    }
  };
  const info = (id) => manager.list().find((session) => session.id === id);
  return { dir, manager, launches, ended, sent, info };
}

async function settle(read, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (read()) return;
    await delay(20);
  }
  assert.fail('Expected session state did not appear');
}

test('orchestration mode switches only between turns and resumes the same thread with Coordinator rules', async (t) => {
  const app = sessionSetup(t);
  const session = await app.manager.create({ cwd, policy: 'workspace-write' });
  assert.equal(session.orchestration, false);
  assert.equal(app.manager.coordinatorState(session.id).active, false);

  await app.manager.send(session.id, { text: 'WAIT_FOR_INTERRUPT' });
  const busy = await app.manager.setOrchestration(session.id, true);
  assert.equal(busy.ok, false);
  assert.equal(app.info(session.id).orchestration, false);
  await app.manager.interrupt(session.id);
  await settle(() => app.info(session.id).status === 'idle');

  assert.deepEqual(await app.manager.setOrchestration(session.id, true), { ok: true });
  const on = app.info(session.id);
  assert.deepEqual([on.status, on.orchestration, on.providerSessionId], ['idle', true, 'mock-thread-id']);
  assert.deepEqual(app.launches.map((launch) => launch.orchestration), [false, true]);
  const resumed = app.sent('thread/resume');
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0].threadId, 'mock-thread-id');
  assert.match(resumed[0].developerInstructions, /Orchestration Mode Active/);
  assert.equal(app.sent('thread/start')[0].developerInstructions, undefined);
  assert.equal(app.sent('mcpServerStatus/list').length, 1, 'an orchestrating thread must expose delegate_task');
  assert.deepEqual(app.manager.coordinatorState(session.id), { cwd, provider: 'codex', active: true, idle: true });
  // The replaced process must not close the session or leave a failed turn behind.
  assert.equal(app.manager.getTimeline(session.id).turns.at(-1).status, 'interrupted');
  assert.equal((await app.manager.send(session.id, { text: 'Plan the work' })).status, 'accepted');
  await settle(() => app.info(session.id).status === 'idle');

  assert.deepEqual(await app.manager.setOrchestration(session.id, false), { ok: true });
  assert.deepEqual(app.ended, [session.id]);
  assert.equal(app.sent('thread/resume')[1].developerInstructions, undefined);
  assert.deepEqual(app.launches.map((launch) => launch.orchestration), [false, true, false]);
  assert.equal(app.manager.coordinatorState(session.id).active, false);
});

test('orchestration mode survives a restart and applies when the conversation resumes', async (t) => {
  const dir = mkdtempSync(join(cwd, '.session-coordinator-test-'));
  const first = sessionSetup(t, { dir, owner: false });
  const session = await first.manager.create({ cwd, policy: 'read-only' });
  assert.equal((await first.manager.send(session.id, { text: 'Plan the work' })).status, 'accepted');
  await settle(() => first.info(session.id).status === 'idle');
  await first.manager.setOrchestration(session.id, true);
  await first.manager.dispose();

  const second = sessionSetup(t, { dir });
  const restored = second.info(session.id);
  assert.deepEqual([restored.status, restored.orchestration], ['suspended', true]);
  assert.equal(second.manager.coordinatorState(session.id).active, false, 'no process, no Coordinator calls');
  assert.equal((await second.manager.send(session.id, { text: 'Continue coordinating' })).status, 'accepted');
  assert.deepEqual(second.launches.map((launch) => launch.orchestration), [true]);
  assert.match(second.sent('thread/resume').at(-1).developerInstructions, /Orchestration Mode Active/);
  assert.equal(second.manager.coordinatorState(session.id).active, true);
});

test('a session that never took a turn switches by opening a new thread, since Codex has nothing saved to resume', async (t) => {
  const app = sessionSetup(t);
  const session = await app.manager.create({ cwd, policy: 'read-only' });
  assert.deepEqual(await app.manager.setOrchestration(session.id, true), { ok: true });
  assert.equal(app.sent('thread/resume').length, 0);
  const started = app.sent('thread/start');
  assert.equal(started.length, 2);
  assert.match(started[1].developerInstructions, /Orchestration Mode Active/);
  assert.deepEqual([app.info(session.id).status, app.info(session.id).orchestration], ['idle', true]);
  assert.equal((await app.manager.send(session.id, { text: 'Plan the work' })).status, 'accepted');
  await settle(() => app.info(session.id).status === 'idle');
  assert.deepEqual(await app.manager.setOrchestration(session.id, false), { ok: true });
  assert.equal(app.sent('thread/resume').length, 1, 'once a turn ran, the thread is resumed');
});

test('a failed switch keeps the previous mode so the next message resumes the plain conversation', async (t) => {
  const app = sessionSetup(t, { failOrchestration: true });
  const session = await app.manager.create({ cwd, policy: 'read-only' });
  const result = await app.manager.setOrchestration(session.id, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /Aha MCP Server is unavailable/);
  assert.deepEqual([app.info(session.id).orchestration, app.info(session.id).status], [false, 'failed']);
  assert.deepEqual(app.ended, [session.id]);
  assert.equal((await app.manager.send(session.id, { text: 'Still here?' })).status, 'accepted');
  assert.deepEqual(app.launches.map((launch) => launch.orchestration), [false, true, false]);
});

test('only a message the person sent confirms a session Coordinator\'s dispatch', async (t) => {
  const app = await setup(t, { confirmMode: 'chat-and-guard' });
  const sessions = sessionSetup(t, { onUserTurn: (id) => app.service.recordUserPromptTurn(id, 'session') });
  app.service.setSessionCoordinators({ get: (id) => sessions.manager.coordinatorState(id) });
  // Inside the session harness's folder, which is removed only after the session process stops.
  const session = await sessions.manager.create({ cwd: mkdtempSync(join(sessions.dir, 'session-cwd-')), policy: 'read-only' });
  assert.deepEqual(await sessions.manager.setOrchestration(session.id, true), { ok: true });
  const delegate = (extra = {}) => app.call(session.id, 'delegate-task', {
    role: 'scout', task: 'Survey the repository', agent: 'codex', taskKind: 'research', worktree: false, ...extra,
  });

  assert.equal((await sessions.manager.send(session.id, { text: 'Plan the survey' })).status, 'accepted');
  await settle(() => sessions.info(session.id).status === 'idle');
  const proposed = await delegate();
  assert.equal(proposed.result.status, 'confirmation_required', proposed.error);
  const proposalId = proposed.result.proposal.id;
  assert.equal((await delegate({ confirmed: true, proposalId })).result.status, 'confirmation_required',
    'the Coordinator cannot confirm its own proposal without a new message from the person');

  // Neither a message that never started a turn nor the pane-side sources count for a session.
  assert.equal((await sessions.manager.send(session.id, { text: '   ' })).status, 'not_accepted');
  app.service.recordUserPromptTurn(session.id, 'hook');
  app.service.recordUserPromptTurn('coordinator-pane', 'session');
  const stillHeld = await delegate({ confirmed: true, proposalId });
  assert.equal(stillHeld.result.status, 'confirmation_required');

  assert.equal((await sessions.manager.send(session.id, { text: 'Yes, go ahead' })).status, 'accepted');
  await settle(() => sessions.info(session.id).status === 'idle');
  const started = await delegate({ confirmed: true, proposalId: stillHeld.result.proposal.id });
  assert.equal(started.result?.status, 'started', started.error ?? JSON.stringify(started.result));
  assert.equal(app.store.getDispatchContext(started.result.dispatch.id).parentPaneId, session.id);
});

test('Worker news and stall reminders wake an idle session Coordinator with a system turn, after any running turn', async (t) => {
  const app = await setup(t, { stallThresholdMs: 50 });
  const sessions = sessionSetup(t, {
    onUserTurn: (id) => app.service.recordUserPromptTurn(id, 'session'),
    onCoordinatorIdle: (id) => app.service.sessionCoordinatorIdle(id),
  });
  app.service.setSessionCoordinators({
    get: (id) => sessions.manager.coordinatorState(id),
    wake: (id, prompt) => sessions.manager.wake(id, prompt),
  });
  const session = await sessions.manager.create({ cwd: mkdtempSync(join(sessions.dir, 'session-cwd-')), policy: 'read-only' });
  assert.deepEqual(await sessions.manager.setOrchestration(session.id, true), { ok: true });
  const turns = () => sessions.manager.getTimeline(session.id).turns;
  const systemTurns = () => turns().filter((turn) => turn.origin === 'system');

  // The person's turn is still running when the Worker's turn ends.
  assert.equal((await sessions.manager.send(session.id, { text: 'WAIT_FOR_INTERRUPT' })).status, 'accepted');
  const userTurn = app.service.recordUserPromptTurn(session.id, 'hook');
  const started = await app.call(session.id, 'delegate-task', {
    role: 'scout', task: 'Survey the repository', agent: 'codex', taskKind: 'research', worktree: false,
  });
  assert.equal(started.result?.status, 'started', started.error);
  const runId = started.result.run.id;
  await settle(() => app.store.listBoardPosts(runId).some((post) => post.subject?.startsWith('Codex turn ended')), 8_000);
  await delay(300);
  assert.equal(systemTurns().length, 0, 'a running turn is never interrupted or overlapped');
  assert.equal(sessions.info(session.id).status, 'running');
  assert.deepEqual(app.service.stallWatchdog.sweep(), [], 'a working session Coordinator is not stalled');

  await sessions.manager.interrupt(session.id);
  await settle(() => systemTurns().length === 1);
  const wake = systemTurns()[0];
  assert.match(wake.prompt, /AhaStation/);
  assert.match(wake.prompt, /not a message from the user/);
  assert.match(wake.prompt, /Codex turn ended|read_board/);
  assert.equal(turns().at(-1).key, wake.key);
  await settle(() => sessions.info(session.id).status === 'idle');
  assert.equal(app.service.recordUserPromptTurn(session.id, 'hook'), userTurn, 'a system turn is not the person answering');

  await delay(100);
  assert.equal(app.service.stallWatchdog.sweep().length, 1);
  await settle(() => systemTurns().length === 2);
  assert.match(systemTurns()[1].prompt, /Board stall detected|read_board/);
  await settle(() => sessions.info(session.id).status === 'idle');

  // Out of orchestration mode nothing wakes the session.
  assert.deepEqual(await sessions.manager.setOrchestration(session.id, false), { ok: true });
  assert.equal((await sessions.manager.wake(session.id, 'News')).status, 'not_accepted');
  assert.equal(systemTurns().length, 2);
});
