import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { AGENT_SESSION_ID, AgentSessionManager, MAX_QUEUED_MESSAGES } from '../dist-electron/orchestration/agent-session-manager.js';
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

test('a rename keeps the title here and names the Codex thread, now or once it resumes', async (t) => {
  const dir = mkdtempSync(join(cwd, '.agent-session-test-'));
  const { manager, sent, status } = setup(t, 'normal', { dir, persist: true });
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  assert.deepEqual(await manager.rename(session.id, '  拆分\n登录   重构 '), { ok: true, synced: true });
  assert.equal(manager.list()[0].title, '拆分 登录 重构');
  assert.deepEqual(sent('thread/name/set'), [{ threadId: 'mock-thread-id', name: '拆分 登录 重构' }]);

  assert.equal((await manager.send(session.id, { text: 'first message' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');
  assert.equal(manager.list()[0].title, '拆分 登录 重构', 'the first message does not replace a chosen title');
  assert.deepEqual(await manager.rename(session.id, '   '), { ok: false, error: '标题不能为空' });
  assert.deepEqual(await manager.rename('agent-session-00000000-0000-0000-0000-000000000000', 'x'), { ok: false, error: '会话不存在' });
  assert.match(readFileSync(join(dir, 'agent-sessions.json'), 'utf8'), /拆分 登录 重构/);
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

  assert.deepEqual(await after.manager.rename(session.id, '改过的标题'), { ok: true, synced: false }, 'no process is up to rename');
  assert.equal(after.status(session.id), 'suspended', 'renaming does not resume the session');

  assert.equal((await after.manager.send(session.id, { text: 'second question' })).status, 'accepted');
  await until(() => after.status(session.id) === 'idle');
  assert.deepEqual(after.sent('thread/resume').map((params) => params.threadId), ['mock-thread-id']);
  await until(() => after.sent('thread/name/set').length);
  assert.deepEqual(after.sent('thread/name/set'), [{ threadId: 'mock-thread-id', name: '改过的标题' }], 'named once it resumed');
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

test('enqueue sends immediately when the session is idle and rejects an empty message', async (t) => {
  const { manager, sent, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  assert.deepEqual(await manager.enqueue(session.id, { text: '  send now  ' }), { ok: true, queued: false });
  await until(() => status(session.id) === 'idle');
  assert.deepEqual(manager.list()[0].queued, []);
  assert.equal(sent('turn/start')[0].input.find((item) => item.type === 'text').text, 'send now');
  assert.deepEqual(await manager.enqueue(session.id, { text: '   ' }), { ok: false, error: '消息是空的' });
  assert.deepEqual(
    await manager.enqueue('agent-session-00000000-0000-0000-0000-000000000000', { text: 'missing' }),
    { ok: false, error: '会话不存在' },
  );
});

test('messages queued during a turn go out in order after it completes', async (t) => {
  const { manager, sent, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  await manager.send(session.id, { text: 'ASK_FOR_APPROVAL' });
  const approval = await until(() => turns(session.id)[0].items.find((item) => item.kind === 'approval'));

  assert.deepEqual(await manager.enqueue(session.id, { text: 'second message' }), { ok: true, queued: true });
  assert.deepEqual(await manager.enqueue(session.id, { text: 'third message' }), { ok: true, queued: true });
  assert.equal(sent('turn/start').length, 1, 'neither message overtakes the running turn');
  assert.deepEqual(manager.list()[0].queued.map((message) => message.text), ['second message', 'third message']);

  assert.equal(manager.respond(session.id, approval.approvalId, true), true);
  await until(() => sent('turn/start').length === 3 && status(session.id) === 'idle' && manager.list()[0].queued.length === 0);
  assert.deepEqual(
    sent('turn/start').map((params) => params.input.find((item) => item.type === 'text').text),
    ['ASK_FOR_APPROVAL', 'second message', 'third message'],
  );
  assert.deepEqual(turns(session.id).map((turn) => turn.status), ['completed', 'completed', 'completed']);
  assert.equal(manager.list()[0].queuePaused, false);
});

test('an interrupted turn pauses the queue until the person resumes it', async (t) => {
  const { manager, sent, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  await manager.send(session.id, { text: 'WAIT_FOR_INTERRUPT' });
  await manager.enqueue(session.id, { text: 'after interruption' });
  await manager.enqueue(session.id, { text: 'last message' });

  assert.equal(await manager.interrupt(session.id), true);
  await until(() => status(session.id) === 'idle' && manager.list()[0].queuePaused);
  assert.equal(turns(session.id)[0].status, 'interrupted');
  assert.deepEqual(manager.list()[0].queued.map((message) => message.text), ['after interruption', 'last message']);
  await delay(60);
  assert.equal(sent('turn/start').length, 1, 'an interruption never sends the next message on its own');

  assert.equal(manager.resumeQueue(session.id), true);
  await until(() => sent('turn/start').length === 3 && status(session.id) === 'idle' && manager.list()[0].queued.length === 0);
  assert.deepEqual(turns(session.id).map((turn) => turn.prompt), ['WAIT_FOR_INTERRUPT', 'after interruption', 'last message']);
  assert.equal(manager.list()[0].queuePaused, false);
  assert.equal(manager.resumeQueue('agent-session-00000000-0000-0000-0000-000000000000'), false);
});

test('queued messages can be removed, are capped, and never send after the session closes', async (t) => {
  const { manager, sent } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });
  await manager.send(session.id, { text: 'WAIT_FOR_INTERRUPT' });
  for (let index = 0; index < MAX_QUEUED_MESSAGES; index++) {
    assert.deepEqual(await manager.enqueue(session.id, { text: `queued ${index}` }), { ok: true, queued: true });
  }
  assert.deepEqual(
    await manager.enqueue(session.id, { text: 'one too many' }),
    { ok: false, error: `最多排队 ${MAX_QUEUED_MESSAGES} 条消息` },
  );

  const first = manager.list()[0].queued[0];
  assert.equal(manager.unqueue(session.id, first.id).text, 'queued 0');
  assert.equal(manager.unqueue(session.id, 'missing'), null);
  assert.equal(manager.list()[0].queued.length, MAX_QUEUED_MESSAGES - 1);
  assert.deepEqual(await manager.enqueue(session.id, { text: 'replacement' }), { ok: true, queued: true });

  await manager.close(session.id);
  assert.deepEqual(manager.list(), []);
  assert.equal(sent('turn/start').length, 1, 'closing forgets every message that was still queued');
  assert.equal(manager.resumeQueue(session.id), false);
});

test('queued messages are process-local and are empty after a restart', async (t) => {
  const dir = mkdtempSync(join(cwd, '.agent-session-test-'));
  const before = setup(t, 'normal', { dir, persist: true });
  const session = await before.manager.create({ cwd, policy: 'workspace-write' });
  await before.manager.send(session.id, { text: 'WAIT_FOR_INTERRUPT' });
  await before.manager.enqueue(session.id, { text: 'do not restore me' });
  await before.manager.dispose();

  const saved = JSON.parse(readFileSync(join(dir, 'agent-sessions.json'), 'utf8'));
  assert.equal(saved.sessions.length, 1);
  assert.equal('queued' in saved.sessions[0], false);
  assert.equal('queuePaused' in saved.sessions[0], false);
  assert.doesNotMatch(JSON.stringify(saved), /do not restore me/);

  const after = setup(t, 'normal', { dir, persist: true });
  const [restored] = after.manager.list();
  assert.equal(restored.status, 'suspended');
  assert.deepEqual(restored.queued, []);
  assert.equal(restored.queuePaused, false);
});

test('/clear freshContext starts a brand new thread while preserving prior timeline turns', async (t) => {
  const { manager, sent, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write', title: '保留标题' });
  assert.equal((await manager.send(session.id, { text: 'first turn' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');
  assert.equal(sent('thread/start').length, 1);
  assert.equal(sent('thread/resume').length, 0);

  assert.equal((await manager.send(session.id, { text: 'after clear', freshContext: true })).status, 'accepted');
  await until(() => status(session.id) === 'idle' && turns(session.id).length === 2);
  assert.equal(sent('thread/start').length, 2, 'freshContext opens a new thread instead of resuming');
  assert.equal(sent('thread/resume').length, 0);
  assert.equal(turns(session.id)[0].prompt, 'first turn');
  assert.equal(turns(session.id)[1].prompt, 'after clear');
  assert.equal(turns(session.id)[1].freshContext, true);
  assert.equal(manager.list()[0].title, '保留标题');
  assert.equal(sent('thread/name/set').at(-1).name, '保留标题');
});

test('/compact runs Codex thread/compact/start and rejects before any conversation turn', async (t) => {
  const { manager, sent, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });

  const early = await manager.send(session.id, { text: '/compact' });
  assert.equal(early.status, 'not_accepted');
  assert.match(early.reason, /还没有可压缩的对话记录/);

  assert.equal((await manager.send(session.id, { text: 'seed turn' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');

  assert.equal((await manager.send(session.id, { text: '/compact' })).status, 'accepted');
  await until(() => status(session.id) === 'idle' && turns(session.id).length === 2);
  assert.equal(sent('thread/compact/start').length, 1);
  assert.equal(sent('turn/start').length, 1, '/compact does not go through turn/start');
  const compactTurn = turns(session.id)[1];
  assert.equal(compactTurn.commandKind, 'compact');
  assert.equal(compactTurn.status, 'completed');
  assert.ok(compactTurn.items.some((item) => item.kind === 'notice' && item.text === '上下文已压缩'));
});

test('/goal sets, pauses, resumes, shows, and clears a Codex thread goal', async (t) => {
  const { manager, sent, turns, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });

  const empty = await manager.runGoal(session.id, { type: 'show' });
  assert.equal(empty.ok, true);
  assert.equal(empty.goal, null);

  const tooLong = await manager.runGoal(session.id, { type: 'set', objective: 'x'.repeat(2_001) });
  assert.equal(tooLong.ok, false);

  const setRes = await manager.runGoal(session.id, { type: 'set', objective: '补齐所有斜杠命令测试' });
  assert.equal(setRes.ok, true);
  await until(() => status(session.id) === 'idle' && turns(session.id).length === 1);
  assert.equal(manager.list()[0].goal?.objective, '补齐所有斜杠命令测试');
  assert.equal(manager.list()[0].goal?.status, 'active');
  assert.equal(turns(session.id)[0].commandKind, 'goal');
  assert.equal(turns(session.id)[0].prompt, '/goal 补齐所有斜杠命令测试');

  const paused = await manager.runGoal(session.id, { type: 'pause' });
  assert.equal(paused.ok, true);
  assert.equal(manager.list()[0].goal?.status, 'paused');

  const resumed = await manager.runGoal(session.id, { type: 'resume' });
  assert.equal(resumed.ok, true);
  await until(() => status(session.id) === 'idle' && turns(session.id).length === 2);
  assert.equal(manager.list()[0].goal?.status, 'active');
  assert.equal(turns(session.id)[1].prompt, '/goal resume');

  const cleared = await manager.runGoal(session.id, { type: 'clear' });
  assert.equal(cleared.ok, true);
  assert.equal(manager.list()[0].goal, null);
  assert.equal(sent('thread/goal/clear').length, 1);
});

test('/feedback requires a turn and uploads thread logs with an optional reason', async (t) => {
  const { manager, sent, status } = setup(t);
  const session = await manager.create({ cwd, policy: 'workspace-write' });

  const early = await manager.uploadFeedback(session.id, 'too early');
  assert.equal(early.ok, false);
  assert.match(early.error, /请先发送至少一条消息/);

  assert.equal((await manager.send(session.id, { text: 'hello' })).status, 'accepted');
  await until(() => status(session.id) === 'idle');

  const res = await manager.uploadFeedback(session.id, 'slash menu check');
  assert.equal(res.ok, true);
  assert.equal(res.feedbackId, 'fb_mock-thread-id');
  const [req] = sent('feedback/upload');
  assert.equal(req.classification, 'bug');
  assert.equal(req.includeLogs, true);
  assert.equal(req.reason, 'slash menu check');
  assert.equal(req.threadId, 'mock-thread-id');
});
