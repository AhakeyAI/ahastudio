import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { AGENT_SESSION_ID, AgentSessionManager } from '../dist-electron/orchestration/agent-session-manager.js';
import { CodexAppServerPilot, coordinatorApprovedMcpTools } from '../dist-electron/orchestration/codex-app-server-pilot.js';

const cwd = process.cwd();

async function until(read, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  assert.fail('Expected session state did not appear');
}

function setup(t, scenario = 'normal', { dir = mkdtempSync(join(cwd, '.agent-session-test-')), persist = false } = {}) {
  const trace = join(dir, 'rpc.jsonl');
  const manager = new AgentSessionManager({
    launch: (_id, workdir, events) => new CodexAppServerPilot(
      spawn(process.execPath, [join(cwd, 'tests/fixtures/mock-codex-app-server.mjs'), scenario, trace], {
        cwd: workdir, stdio: 'pipe', windowsHide: true,
      }),
      events, 850, [], null,
    ),
    ...(persist ? { storageFile: () => join(dir, 'agent-sessions.json') } : {}),
  });
  t.after(async () => {
    await manager.dispose();
    rmSync(dir, { force: true, recursive: true });
  });
  const sent = (method) => readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
    .filter((message) => message.method === method).map((message) => message.params);
  const turns = (id) => manager.getTimeline(id).turns;
  const status = (id) => manager.list().find((session) => session.id === id)?.status;
  return { manager, sent, turns, status };
}

function orchSetup(t, { dir = mkdtempSync(join(cwd, '.agent-session-test-')), failPolicy } = {}) {
  const trace = join(dir, 'rpc.jsonl');
  const launches = [];
  const manager = new AgentSessionManager({
    launch: (_id, workdir, events, options) => {
      launches.push({ ...options });
      if (options.orchestration && options.policy === failPolicy) {
        throw new Error(`launch unavailable for ${failPolicy}`);
      }
      return new CodexAppServerPilot(
        spawn(process.execPath, [join(cwd, 'tests/fixtures/mock-codex-app-server.mjs'), 'normal', trace], {
          cwd: workdir, stdio: 'pipe', windowsHide: true,
        }),
        events, 850, [], options.orchestration ? 'delegate_task' : null,
      );
    },
    coordinatorInstructions: (_id, options) => `[Coordinator] policy=${options.policy}`,
    storageFile: () => join(dir, 'agent-sessions.json'),
  });
  t.after(async () => {
    await manager.dispose();
    rmSync(dir, { force: true, recursive: true });
  });
  const sent = (method) => {
    try {
      return readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
        .filter((message) => message.method === method).map((message) => message.params);
    } catch {
      return [];
    }
  };
  const status = (id) => manager.list().find((session) => session.id === id)?.status;
  const info = (id) => manager.list().find((session) => session.id === id);
  return { manager, launches, sent, status, info };
}

test('an orchestrating session relaunches when the turn policy crosses the full-auto tier', async (t) => {
  const { manager, launches, sent, status, info } = orchSetup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  assert.equal((await manager.setOrchestration(session.id, true)).ok, true);
  assert.deepEqual(
    launches.map((launch) => [launch.orchestration, launch.policy]),
    [[false, 'workspace-write'], [true, 'workspace-write']],
  );

  // A thread with no accepted turns cannot be rejoined, so the relaunch test needs one first.
  assert.equal((await manager.send(session.id, { text: 'seed the thread' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');

  assert.equal((await manager.send(session.id, { text: 'run free', policy: 'full-auto' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');
  assert.equal(launches.length, 3, 'full-auto approvals are baked into the process arguments');
  assert.deepEqual([launches[2].orchestration, launches[2].policy], [true, 'full-auto']);
  assert.equal(sent('thread/resume').length, 1, 'the same thread resumes under the new process');
  assert.equal(info(session.id).policy, 'full-auto');
  assert.equal(sent('turn/start').at(-1).approvalPolicy, 'never');

  assert.equal((await manager.send(session.id, { text: 'back to asking', policy: 'read-only' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');
  assert.equal(launches.length, 4, 'leaving full-auto relaunches too');
  assert.deepEqual([launches[3].orchestration, launches[3].policy], [true, 'read-only']);
  assert.equal(sent('thread/resume').length, 2, 'the same thread resumes again');
  assert.equal(info(session.id).policy, 'read-only');
});

test('an orchestrating session changes the sandbox tier per turn without relaunching', async (t) => {
  const { manager, launches, sent, status, info } = orchSetup(t);
  const session = await manager.create({ cwd, policy: 'read-only' });
  assert.equal((await manager.setOrchestration(session.id, true)).ok, true);
  assert.equal(launches.length, 2);

  assert.equal((await manager.send(session.id, { text: 'write this time', policy: 'workspace-write' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');
  assert.equal(launches.length, 2, 'the same approval tier stays on the same process');
  assert.equal(info(session.id).policy, 'workspace-write');
  assert.equal(sent('turn/start').at(-1).sandboxPolicy.type, 'workspaceWrite');
});

test('a failed policy relaunch keeps the session policy and sends nothing', async (t) => {
  const { manager, launches, sent, info } = orchSetup(t, { failPolicy: 'full-auto' });
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  assert.equal((await manager.setOrchestration(session.id, true)).ok, true);
  const turnsSent = sent('turn/start').length;
  const delivery = await manager.send(session.id, { text: 'go auto', policy: 'full-auto' });
  assert.equal(delivery.status, 'not_accepted');
  assert.match(delivery.reason, /launch unavailable for full-auto/);
  assert.equal(info(session.id).policy, 'workspace-write');
  assert.equal(sent('turn/start').length, turnsSent, 'nothing was sent');
  assert.equal(launches.length, 3, 'the relaunch was attempted once');
});

test('a plain session changes policy per turn without relaunching', async (t) => {
  const { manager, launches, status, info } = orchSetup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  assert.equal((await manager.send(session.id, { text: 'go', policy: 'full-auto' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');
  assert.equal(launches.length, 1);
  assert.equal(info(session.id).policy, 'full-auto');
});

test('coordinatorApprovedMcpTools pre-approves manage_worker only under full-auto', () => {
  const base = coordinatorApprovedMcpTools('workspace-write');
  assert.ok(base.includes('delegate_task'));
  assert.ok(!base.includes('manage_worker'));
  assert.deepEqual(coordinatorApprovedMcpTools('read-only'), base);
  const full = coordinatorApprovedMcpTools('full-auto');
  assert.deepEqual(full, [...base, 'manage_worker']);
  assert.ok(!full.includes('integrate_worker'));
  assert.ok(!full.includes('finalize_run_integration'));
});

test('a session opens without Aha MCP and runs turns one at a time with the chosen settings', async (t) => {
  const { manager, sent, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write', model: 'gpt-a' });
  assert.match(session.id, AGENT_SESSION_ID);
  assert.equal(session.status, 'idle');
  assert.equal(session.providerSessionId, 'mock-thread-id');
  assert.equal(sent('mcpServerStatus/list').length, 0, 'a plain session does not require report_done');

  assert.equal((await manager.send(session.id, { text: 'Add a README\nwith a title' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');
  const [turn] = turns(session.id);
  assert.equal(turn.prompt, 'Add a README\nwith a title');
  assert.equal(turn.status, 'completed');
  assert.equal(turn.items.find((item) => item.kind === 'message').text, '模拟输出 1');
  assert.equal(manager.list()[0].title, 'Add a README');

  await manager.send(session.id, { text: 'now without asking', policy: 'full-auto', model: 'gpt-b' });
  await until(() => status(session.id) === 'idle');
  await manager.send(session.id, { text: 'WAIT_FOR_INTERRUPT' });
  assert.equal((await manager.send(session.id, { text: 'too early' })).status, 'not_accepted');
  await manager.interrupt(session.id);
  await until(() => status(session.id) === 'idle');
  const second = sent('turn/start')[1];
  assert.deepEqual([second.approvalPolicy, second.model], ['never', 'gpt-b']);
  const info = manager.list()[0];
  assert.deepEqual([info.policy, info.model], ['full-auto', 'gpt-b']);
  assert.equal(manager.getTimeline(session.id).readOnly, false);
});

test('an approval waits in the timeline for the person and is delivered once', async (t) => {
  const { manager, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  await manager.send(session.id, { text: 'ASK_FOR_APPROVAL' });
  const approval = await until(() => turns(session.id)[0].items.find((item) => item.kind === 'approval'));
  assert.deepEqual([approval.status, approval.tool, approval.input], ['pending', 'commandExecution', 'Get-Location']);
  assert.equal(status(session.id), 'running');

  assert.equal(manager.respond(session.id, approval.approvalId, true), true);
  assert.equal(manager.respond(session.id, approval.approvalId, false), false, 'a decision cannot be changed');
  await until(() => status(session.id) === 'idle');
  const [turn] = turns(session.id);
  assert.equal(turn.items.find((item) => item.kind === 'approval').status, 'approved');
  assert.equal(turn.items.find((item) => item.kind === 'message').text, 'approval decision: accept');
});

test('interrupt ends the turn and keeps the session; an unanswered approval expires with it', async (t) => {
  const { manager, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  await manager.send(session.id, { text: 'ASK_FOR_APPROVAL' });
  await until(() => turns(session.id)[0].items.some((item) => item.kind === 'approval'));
  assert.equal(await manager.interrupt(session.id), true);
  await until(() => status(session.id) === 'idle');
  assert.equal(turns(session.id)[0].status, 'interrupted');
  assert.equal(turns(session.id)[0].items.find((item) => item.kind === 'approval').status, 'expired');

  assert.equal((await manager.send(session.id, { text: 'carry on' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');
  assert.equal(turns(session.id)[1].status, 'completed');
});

test('a crash or unknown delivery fails the session; the next message resumes the thread in a new process', async (t) => {
  const crashing = setup(t);
  const crashed = await crashing.manager.create({ cwd, policy: 'read-only' });
  await crashing.manager.send(crashed.id, { text: 'CRASH_LATER' });
  await until(() => crashing.status(crashed.id) === 'failed');
  assert.equal(crashing.turns(crashed.id)[0].status, 'failed');
  assert.equal(crashing.manager.getTimeline(crashed.id).alive, false);
  assert.equal((await crashing.manager.send(crashed.id, { text: 'again' })).status, 'accepted');
  await until(() => crashing.status(crashed.id) === 'idle');
  assert.deepEqual(crashing.sent('thread/resume').map((params) => params.threadId), ['mock-thread-id']);
  assert.equal(crashing.turns(crashed.id)[1].status, 'completed');

  const hanging = setup(t, 'timeout');
  const hung = await hanging.manager.create({ cwd, policy: 'read-only' });
  assert.equal((await hanging.manager.send(hung.id, { text: 'never acknowledged' })).status, 'unknown_acceptance');
  await until(() => hanging.status(hung.id) === 'failed');
  assert.equal(hanging.sent('turn/start').length, 1, 'the message is not sent a second time');
});

test('a session that cannot start reports why and closing forgets it', async (t) => {
  const { manager } = setup(t, 'initialize-error');
  const session = await manager.create({ cwd, policy: 'read-only' });
  assert.equal(session.status, 'failed');
  assert.match(session.error, /mock initialization rejected/);
  await manager.close(session.id);
  assert.deepEqual(manager.list(), []);
});

test('sessions survive a restart with their history and resume the same thread on the next message', async (t) => {
  const dir = mkdtempSync(join(cwd, '.agent-session-test-'));
  const before = new AgentSessionManager({
    launch: (_id, workdir, events) => new CodexAppServerPilot(
      spawn(process.execPath, [join(cwd, 'tests/fixtures/mock-codex-app-server.mjs'), 'normal', join(dir, 'before.jsonl')], {
        cwd: workdir, stdio: 'pipe', windowsHide: true,
      }), events, 850, [], null),
    storageFile: () => join(dir, 'agent-sessions.json'),
  });
  const session = await before.create({ cwd, policy: 'workspace-write', network: true });
  await before.send(session.id, { text: 'first question' });
  await until(() => before.list()[0].status === 'idle');
  const gone = await before.create({ cwd, policy: 'read-only' });
  await before.close(gone.id);
  await before.dispose();

  const after = setup(t, 'normal', { dir, persist: true });
  const [restored] = after.manager.list();
  assert.equal(after.manager.list().length, 1, 'a closed session is forgotten');
  assert.deepEqual(
    [restored.id, restored.status, restored.title, restored.policy, restored.network],
    [session.id, 'suspended', 'first question', 'workspace-write', true],
  );
  const history = after.manager.getTimeline(session.id);
  assert.equal(history.alive, false);
  assert.equal(history.turns[0].items.find((item) => item.kind === 'message').text, '模拟输出 1');

  assert.equal((await after.manager.send(session.id, { text: 'second question' })).status, 'accepted');
  await until(() => after.status(session.id) === 'idle');
  assert.deepEqual(after.sent('thread/resume').map((params) => params.threadId), ['mock-thread-id']);
  assert.equal(after.sent('thread/start').length, 0);
  assert.equal(after.sent('turn/start')[0].sandboxPolicy.networkAccess, true);
  const turns = after.turns(session.id);
  assert.deepEqual(turns.map((turn) => [turn.generation, turn.prompt]), [[1, 'first question'], [2, 'second question']]);
  assert.equal(after.manager.getTimeline(session.id).alive, true);
});

test('network access is off by default and can be switched on for later turns', async (t) => {
  const { manager, sent, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  await manager.send(session.id, { text: 'one' });
  await until(() => status(session.id) === 'idle');
  await manager.send(session.id, { text: 'two', network: true });
  await until(() => status(session.id) === 'idle');
  await manager.send(session.id, { text: 'three' });
  await until(() => status(session.id) === 'idle');
  assert.deepEqual(sent('turn/start').map((params) => params.sandboxPolicy.networkAccess), [false, true, true]);
  assert.equal(manager.list()[0].network, true);
});

test('a question waits for an answer to every part, is recorded, and can be skipped', async (t) => {
  const { manager, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  await manager.send(session.id, { text: 'ASK_A_QUESTION' });
  const [pending] = await until(() => manager.list()[0].pendingQuestions.length && manager.list()[0].pendingQuestions);
  assert.deepEqual(pending.questions.map((question) => [question.id, question.allowOther, question.options.length]), [['db', false, 2]]);
  assert.equal(manager.answer(session.id, pending.requestId, { other: ['x'] }), false, 'every question needs an answer');
  assert.equal(manager.answer(session.id, pending.requestId, { db: ['SQLite'] }), true);
  await until(() => status(session.id) === 'idle');
  assert.deepEqual(manager.list()[0].pendingQuestions, []);
  const items = turns(session.id)[0].items;
  assert.match(items.find((item) => item.kind === 'notice').text, /Database：SQLite/);
  assert.equal(items.find((item) => item.kind === 'message').text, 'answer: {"db":{"answers":["SQLite"]}}');

  await manager.send(session.id, { text: 'ASK_A_QUESTION' });
  const [second] = await until(() => manager.list()[0].pendingQuestions.length && manager.list()[0].pendingQuestions);
  assert.equal(manager.respond(session.id, second.requestId, true), false, 'a question is not an approval');
  assert.equal(manager.answer(session.id, second.requestId, null), true);
  await until(() => status(session.id) === 'idle');
  assert.equal(turns(session.id)[1].items.find((item) => item.kind === 'message').text, 'request refused');
});
