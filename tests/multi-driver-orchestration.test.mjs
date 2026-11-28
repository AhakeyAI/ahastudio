// Offline tests for Claude Code and Grok as session Coordinators and headless Workers.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { agentEnvironment } from '../dist-electron/agent-drivers/agent-process.js';
import { AcpSessionDriver, acpPromptWithInstructions } from '../dist-electron/agent-drivers/acp/acp-session-driver.js';
import { ACP_LAUNCH_SPECS } from '../dist-electron/agent-drivers/acp/acp-dialects.js';
import {
  CLAUDE_AHA_MCP_HOOK_ID, CLAUDE_AHA_MCP_HOOK_MATCHER, claudeAhaMcpConfig, claudeLaunchArgs,
} from '../dist-electron/agent-drivers/claude/claude-protocol.js';
import { ClaudeSessionDriver } from '../dist-electron/agent-drivers/claude/claude-session-driver.js';
import { AGENT_DRIVER_CAPABILITIES } from '../dist-electron/agent-drivers/driver-capabilities.js';
import { headlessWorkerCommand } from '../dist-electron/agent-drivers/driver-registry.js';
import { ahaMcpSecrets, redactSecrets, redactTimelineEvent } from '../dist-electron/agent-drivers/secret-redaction.js';
import { createRequire } from 'node:module';
import { AgentSessionManager } from '../dist-electron/orchestration/agent-session-manager.js';
import { ORCHESTRATION_ENDED_INSTRUCTIONS } from '../dist-electron/orchestration/coordinator-prompt.js';
import {
  AHA_TOOL_DENIED, HEADLESS_WORKER_ID, ahaToolDecision, approvalToolName, headlessWorkerDriver, headlessWorkerSupports,
  parseAhaMcpToolName, sessionGateDecision,
} from '../dist-electron/orchestration/headless-workers.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { dispatchOrchestrationHttpAction, isLongPollOrchestrationAction } from '../dist-electron/orchestration/orchestration-http-router.js';

const require = createRequire(import.meta.url);
const { runMcpServer } = require('../electron/orchestration/aha-mcp-server.cjs');

const cwd = process.cwd();
const SESSION_A = 'agent-session-00000000-0000-0000-0000-00000000000a';
const UUID = '0123abcd-0000-4000-8000-00000000beef';
const SECRET = 'f'.repeat(48);

const until = async (read, ms = 5_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > end) throw new Error('timed out waiting');
    await delay(10);
  }
};

function fakeChild() {
  const child = new EventEmitter();
  Object.assign(child, {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    exitCode: null, signalCode: null, pid: 2_000_000_000, // never a live process, so write-quiescence checks see the fake as gone
  });
  child.exit = (code = 0) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.stdout.end();
    setImmediate(() => child.emit('close', code, null));
  };
  child.kill = () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.signalCode = 'SIGKILL';
      child.stdout.end();
      setImmediate(() => child.emit('close', null, 'SIGKILL'));
    }
    return true;
  };
  return child;
}

function wire(child, onMessage) {
  const seen = [];
  const backlog = [];
  const waiters = [];
  createInterface({ input: child.stdin }).on('line', (line) => {
    const message = JSON.parse(line);
    seen.push(message);
    const waiter = waiters.find((entry) => entry.match(message));
    if (waiter) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
      return;
    }
    backlog.push(message);
    onMessage(message);
  });
  return {
    seen,
    send: (message) => child.stdout.write(JSON.stringify(message) + '\n'),
    waitFor: (match) => {
      const early = backlog.findIndex(match);
      if (early >= 0) return Promise.resolve(backlog.splice(early, 1)[0]);
      return new Promise((resolve) => waiters.push({ match, resolve }));
    },
  };
}

function recorder(onRequest = async () => ({ decision: 'decline' })) {
  const timeline = [];
  const requests = [];
  const completed = [];
  const exits = [];
  return {
    timeline, requests, completed, exits,
    events: {
      onTurnStarted() {},
      onTimeline: (_key, event) => timeline.push(event),
      onRequest: (_key, request) => {
        requests.push(request);
        return onRequest(request);
      },
      onTurnCompleted: (_key, result) => completed.push(result),
      onExit: (reason) => exits.push(reason),
    },
  };
}

// --- Policy tables ---

test('capabilities and policy tables: which drivers coordinate, which run headless Workers, and how Aha tools are gated', () => {
  for (const [id, on] of Object.entries({ codex: true, claude: true, antigravity: true, grok: true, opencode: false, pi: false })) {
    assert.equal(AGENT_DRIVER_CAPABILITIES[id].orchestration, on, id);
  }
  assert.equal(headlessWorkerSupports('codex', 'read-only'), true);
  assert.equal(headlessWorkerSupports('claude', 'read-only'), true);
  assert.equal(headlessWorkerSupports('claude', 'workspace-write'), true);
  assert.equal(headlessWorkerSupports('antigravity', 'workspace-write'), true);
  assert.equal(headlessWorkerSupports('antigravity', 'read-only'), false, 'Antigravity has no read-only tier, so read-only tasks keep a terminal');
  assert.equal(headlessWorkerSupports('grok', 'workspace-write'), true);
  assert.equal(headlessWorkerSupports('grok', 'read-only'), false, 'Grok has no read-only tier, so read-only tasks keep a terminal');
  for (const id of ['opencode', 'pi', 'gemini', null]) assert.equal(headlessWorkerSupports(id, 'workspace-write'), false, String(id));
  assert.equal(headlessWorkerCommand('antigravity'), 'agy');
  assert.equal(headlessWorkerCommand('claude'), 'claude');
  assert.equal(headlessWorkerCommand('grok'), 'grok');

  assert.ok(HEADLESS_WORKER_ID.test(`claude-worker-${UUID}`));
  assert.ok(HEADLESS_WORKER_ID.test(`antigravity-worker-${UUID}`));
  assert.ok(HEADLESS_WORKER_ID.test(`grok-worker-${UUID}`));
  assert.ok(HEADLESS_WORKER_ID.test(`codex-worker-${UUID}`));
  assert.equal(headlessWorkerDriver(`antigravity-worker-${UUID}`), 'antigravity');
  assert.equal(headlessWorkerDriver(`grok-worker-${UUID}`), 'grok');
  assert.equal(headlessWorkerDriver(SESSION_A), null);

  // Workers: the dispatch contract runs unprompted in every tier; anything else asks, or is refused in full-auto.
  for (const policy of ['read-only', 'workspace-write', 'full-auto']) {
    for (const tool of ['report_done', 'read_board', 'ask_coordinator', 'post_message']) {
      assert.equal(ahaToolDecision('worker', tool, policy), 'allow', `${tool} ${policy}`);
    }
    assert.equal(ahaToolDecision('coordinator', 'integrate_worker', policy), 'allow', 'the service gates Coordinators');
  }
  assert.equal(ahaToolDecision('worker', 'delegate_task', 'workspace-write'), 'ask');
  assert.equal(ahaToolDecision('worker', 'delegate_task', 'read-only'), 'ask');
  assert.equal(ahaToolDecision('worker', 'delegate_task', 'full-auto'), 'deny');

  // Session Coordinators: the Codex approval rules.
  assert.equal(sessionGateDecision('role-manage', 'full-auto'), 'allow');
  assert.equal(sessionGateDecision('worker-integrate', 'full-auto'), 'deny');
  assert.equal(sessionGateDecision('run-finalize', 'full-auto'), 'deny');
  for (const policy of ['read-only', 'workspace-write']) {
    for (const action of ['role-manage', 'worker-integrate', 'run-finalize']) assert.equal(sessionGateDecision(action, policy), 'ask', `${action} ${policy}`);
  }
  assert.equal(sessionGateDecision('delegate-task', 'workspace-write'), 'allow');

  for (const name of [
    'mcp__aha__report_done', 'aha__report_done', 'aha/report_done', 'aha.report_done', 'aha: report_done',
    'mcp__aha_orchestration__report_done', 'mcp_aha_orchestration_report_done', 'aha_orchestration__report_done',
    'aha_orchestration/report_done', 'aha_orchestration: report_done',
  ]) {
    assert.equal(parseAhaMcpToolName(name), 'report_done', name);
  }
  assert.equal(parseAhaMcpToolName('aha_helper'), null);
  assert.equal(parseAhaMcpToolName('mcp__github__list_prs'), null);
  assert.equal(parseAhaMcpToolName('Bash'), null);
});

test('secrets: redaction covers text and nested timeline events; agent processes never inherit host AHA_* variables', () => {
  assert.equal(redactSecrets(`token=${SECRET}; again ${SECRET}`, [SECRET]), 'token=<redacted>; again <redacted>');
  const event = { type: 'item', item: { kind: 'command', output: `x ${SECRET}`, files: [{ diff: `+${SECRET}` }], exitCode: 0 } };
  assert.doesNotMatch(JSON.stringify(redactTimelineEvent(event, [SECRET])), new RegExp(SECRET));
  assert.equal(redactTimelineEvent(event, []), event);
  assert.deepEqual(ahaMcpSecrets({ AHA_WORKER_ID: 'w', AHA_WORKER_TOKEN: 'a', AHA_AGENT_HOOK_TOKEN: 'b', AHA_SESSION_TOKEN: '' }), ['a', 'b']);

  const saved = { ...process.env };
  try {
    process.env.AHA_SESSION_TOKEN = 'host-session';
    process.env.aha_worker_token = 'host-worker';
    const env = agentEnvironment({ XAI_EXTRA: '1' });
    assert.ok(!Object.keys(env).some((key) => key.toUpperCase().startsWith('AHA_')), Object.keys(env).join(','));
    assert.equal(env.XAI_EXTRA, '1');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
  }
});

test('Claude launch: the Aha server comes from an inline --mcp-config and Coordinator rules from --append-system-prompt', () => {
  const env = { AHA_SESSION_ID: SESSION_A, AHA_SESSION_TOKEN: SECRET, AHA_ORCHESTRATION_URL: 'http://127.0.0.1:1/orchestration' };
  const config = claudeAhaMcpConfig({ command: 'node', args: ['aha-mcp-server.cjs'], env });
  assert.deepEqual(JSON.parse(config), { mcpServers: { aha: { type: 'stdio', command: 'node', args: ['aha-mcp-server.cjs'], env } } });
  const args = claudeLaunchArgs({ policy: 'workspace-write', sessionId: 'sid', mcpConfig: config, appendSystemPrompt: 'RULES' });
  assert.deepEqual(args.slice(-4), ['--mcp-config', config, '--append-system-prompt', 'RULES']);
  assert.ok(!args.includes('--strict-mcp-config'), 'the person\u2019s own MCP servers stay available');
  assert.ok(!claudeLaunchArgs({ policy: 'workspace-write', sessionId: 'sid' }).includes('--mcp-config'), 'a plain session has no Aha server');
});

// --- Claude Code driver ---

const controlSuccess = (requestId, response = {}) => ({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } });

function claudeAgent(child, { mcpStatuses, onUser }) {
  let statusCalls = 0;
  const io = wire(child, (msg) => {
    if (msg.type === 'control_request') {
      const sub = msg.request?.subtype;
      if (sub === 'initialize') io.send(controlSuccess(msg.request_id, { models: [], current_permission_mode: 'default' }));
      else if (sub === 'mcp_status') io.send(controlSuccess(msg.request_id, mcpStatuses[Math.min(statusCalls++, mcpStatuses.length - 1)]));
      else if (sub === 'set_permission_mode') io.send(controlSuccess(msg.request_id, { mode: msg.request.mode }));
      else io.send(controlSuccess(msg.request_id, {}));
    } else if (msg.type === 'user') {
      void onUser(msg, io);
    }
  });
  return io;
}

const ahaConnected = (tool) => ({ mcpServers: [{ name: 'aha', status: 'connected', tools: [{ name: `mcp__aha__${tool}` }] }] });

async function claudeToolCall(io, id, subtype, tool, input = {}) {
  const request = subtype === 'hook_callback'
    ? { subtype, callback_id: CLAUDE_AHA_MCP_HOOK_ID, tool_use_id: `tu_${id}`, input: { tool_name: `mcp__aha__${tool}`, tool_input: input } }
    : { subtype, tool_name: `mcp__aha__${tool}`, tool_use_id: `tu_${id}`, input };
  io.send({ type: 'control_request', request_id: id, request });
  return (await io.waitFor((sent) => sent.type === 'control_response' && sent.response?.request_id === id)).response.response;
}

test('Claude Worker: report_done runs even read-only, other Aha tools ask the person, and secrets never leave the driver', async () => {
  const child = fakeChild();
  const replies = {};
  const io = claudeAgent(child, {
    mcpStatuses: [{ mcpServers: [{ name: 'aha', status: 'pending', tools: [] }] }, ahaConnected('report_done')],
    onUser: async (msg) => {
      replies.hook = await claudeToolCall(io, 'h1', 'hook_callback', 'report_done');
      replies.report = await claudeToolCall(io, 'p1', 'can_use_tool', 'report_done', { summary: `done ${SECRET}` });
      replies.delegate = await claudeToolCall(io, 'p2', 'can_use_tool', 'delegate_task', { task: `use ${SECRET}` });
      replies.otherHook = await claudeToolCall(io, 'h2', 'hook_callback', 'delegate_task');
      io.send({ type: 'assistant', session_id: msg.session_id, parent_tool_use_id: null,
        message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: `Reported with ${SECRET}` }] } });
      io.send({ type: 'result', subtype: 'success', is_error: false, result: `Reported with ${SECRET}` });
    },
  });
  const rec = recorder();
  const driver = new ClaudeSessionDriver(child, rec.events, {
    sessionId: 'sid-w', policy: 'read-only', ahaMcp: { role: 'worker', requiredTool: 'report_done' }, secrets: [SECRET],
  });
  assert.equal(await driver.open({ cwd: tmpdir(), model: null, policy: 'read-only' }), 'sid-w');
  const init = io.seen.find((m) => m.request?.subtype === 'initialize');
  assert.ok(JSON.stringify(init.request.hooks.PreToolUse).includes(CLAUDE_AHA_MCP_HOOK_MATCHER));
  assert.ok(JSON.stringify(init.request.hooks.PreToolUse).includes(CLAUDE_AHA_MCP_HOOK_ID));
  assert.equal(io.seen.filter((m) => m.request?.subtype === 'mcp_status').length, 2, 'polled until Aha listed report_done');

  assert.equal((await driver.startTurn({ turnKey: 'k1', prompt: 'work' })).status, 'accepted');
  await until(() => rec.completed.length === 1);
  assert.equal(replies.hook.hookSpecificOutput.permissionDecision, 'allow');
  assert.equal(replies.report.behavior, 'allow', 'report_done is allowed in read-only');
  assert.deepEqual(replies.otherHook, {}, 'a tool that needs the person falls through to can_use_tool');
  assert.equal(replies.delegate.behavior, 'deny', 'the person declined');
  assert.equal(rec.requests.length, 1);
  assert.equal(rec.requests[0].method, 'claude/mcp__aha__delegate_task');
  assert.doesNotMatch(rec.requests[0].toolInput, new RegExp(SECRET));
  assert.equal(rec.completed[0].finalText, 'Reported with <redacted>');
  assert.doesNotMatch(JSON.stringify(rec.timeline), new RegExp(SECRET));
  assert.doesNotMatch(driver.read('k1', 0, undefined, true)?.text ?? '', new RegExp(SECRET));
  assert.equal(driver.redactText(`x${SECRET}`), 'x<redacted>');
  await driver.close();
});

test('Claude: full-auto refuses a Worker\u2019s person-only Aha tool, a Coordinator runs Aha tools unprompted, and a missing Aha tool fails open', async () => {
  const child = fakeChild();
  const replies = {};
  const io = claudeAgent(child, {
    mcpStatuses: [ahaConnected('report_done')],
    onUser: async () => {
      replies.hook = await claudeToolCall(io, 'h1', 'hook_callback', 'delegate_task');
      replies.perm = await claudeToolCall(io, 'p1', 'can_use_tool', 'delegate_task');
      io.send({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    },
  });
  const rec = recorder(async () => assert.fail('full-auto must not ask'));
  const worker = new ClaudeSessionDriver(child, rec.events, { sessionId: 's', policy: 'full-auto', ahaMcp: { role: 'worker', requiredTool: 'report_done' } });
  await worker.open({ cwd: tmpdir(), model: null, policy: 'full-auto' });
  await worker.startTurn({ turnKey: 'k', prompt: 'x' });
  await until(() => rec.completed.length === 1);
  assert.equal(replies.hook.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(replies.hook.hookSpecificOutput.permissionDecisionReason, AHA_TOOL_DENIED);
  assert.equal(replies.perm.behavior, 'deny');
  await worker.close();

  const coordChild = fakeChild();
  const coordReplies = {};
  const coordIo = claudeAgent(coordChild, {
    mcpStatuses: [ahaConnected('delegate_task')],
    onUser: async () => {
      coordReplies.integrate = await claudeToolCall(coordIo, 'p1', 'can_use_tool', 'integrate_worker');
      coordIo.send({ type: 'result', subtype: 'success', is_error: false, result: 'ok' });
    },
  });
  const coordRec = recorder(async () => assert.fail('the driver never prompts for a Coordinator tool'));
  const coordinator = new ClaudeSessionDriver(coordChild, coordRec.events, {
    sessionId: 'c', policy: 'workspace-write', ahaMcp: { role: 'coordinator', requiredTool: 'delegate_task' },
  });
  await coordinator.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  await coordinator.startTurn({ turnKey: 'k', prompt: 'x' });
  await until(() => coordRec.completed.length === 1);
  assert.equal(coordReplies.integrate.behavior, 'allow', 'the orchestration service gates it instead');
  await coordinator.close();

  const failedChild = fakeChild();
  claudeAgent(failedChild, { mcpStatuses: [{ mcpServers: [{ name: 'aha', status: 'failed', tools: [] }] }], onUser: async () => {} });
  const failed = new ClaudeSessionDriver(failedChild, recorder().events, { sessionId: 'f', policy: 'workspace-write', ahaMcp: { role: 'worker', requiredTool: 'report_done' } });
  await assert.rejects(failed.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' }), /Aha MCP did not expose report_done to Claude Code \(failed\)/);
  await failed.close();
});

// --- ACP (Grok) driver ---

const ACP_INIT = { protocolVersion: 1, agentCapabilities: { loadSession: true, promptCapabilities: { image: false } }, authMethods: [] };
const promptText = (message) => message.params.prompt.filter((block) => block.type === 'text').map((block) => block.text).join('');
const PERMISSION_OPTIONS = [
  { optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

function grokAgent(child, onPrompt = (message, io) => io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })) {
  const io = wire(child, (message) => {
    if (message.method === 'initialize') io.send({ jsonrpc: '2.0', id: message.id, result: ACP_INIT });
    else if (message.method === 'session/new') io.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'grok-1' } });
    else if (message.method === 'session/prompt') void onPrompt(message, io);
    else if (message.method && message.id !== undefined) io.send({ jsonrpc: '2.0', id: message.id, result: {} });
  });
  return io;
}

const chunk = (io, text) => io.send({ jsonrpc: '2.0', method: 'session/update', params: {
  sessionId: 'grok-1', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
} });

async function acpPermission(io, id, toolCall) {
  io.send({ jsonrpc: '2.0', id, method: 'session/request_permission', params: { sessionId: 'grok-1', toolCall, options: PERMISSION_OPTIONS } });
  return (await io.waitFor((sent) => sent.id === id && !sent.method)).result;
}

const MCP_SERVERS = [{ name: 'aha', command: 'node', args: ['aha-mcp-server.cjs'], env: [{ name: 'AHA_SESSION_TOKEN', value: SECRET }] }];

test('Grok Coordinator: mcpServers on every session/new|load, rules lead only the first prompt of each process, never /compact', async () => {
  const child = fakeChild();
  const io = grokAgent(child);
  const rec = recorder();
  const driver = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.grok, rec.events, { mcpServers: MCP_SERVERS, ahaMcp: { role: 'coordinator' }, secrets: [SECRET] });
  assert.equal(await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write', developerInstructions: 'RULES' }), 'grok-1');
  assert.deepEqual(io.seen.find((m) => m.method === 'session/new').params.mcpServers, MCP_SERVERS);

  assert.equal((await driver.compactThread('c0')).status, 'accepted');
  await until(() => rec.completed.length === 1);
  assert.equal((await driver.startTurn({ turnKey: 'k1', prompt: 'first' })).status, 'accepted');
  await until(() => rec.completed.length === 2);
  assert.equal((await driver.startTurn({ turnKey: 'k2', prompt: 'second' })).status, 'accepted');
  await until(() => rec.completed.length === 3);
  const prompts = io.seen.filter((m) => m.method === 'session/prompt').map(promptText);
  assert.deepEqual(prompts, ['/compact', acpPromptWithInstructions('RULES', 'first'), 'second']);
  await driver.close();

  // A relaunched process resumes the same conversation and gets the rules once more.
  const next = fakeChild();
  const nextIo = grokAgent(next);
  const nextRec = recorder();
  const resumed = new AcpSessionDriver(next, ACP_LAUNCH_SPECS.grok, nextRec.events, { mcpServers: MCP_SERVERS, ahaMcp: { role: 'coordinator' } });
  assert.equal(await resumed.open({ cwd: tmpdir(), model: null, policy: 'workspace-write', resumeSessionId: 'grok-1', developerInstructions: 'RULES' }), 'grok-1');
  const load = nextIo.seen.find((m) => m.method === 'session/load' || m.method === 'session/resume');
  assert.equal(load.params.sessionId, 'grok-1');
  assert.deepEqual(load.params.mcpServers, MCP_SERVERS);
  await resumed.startTurn({ turnKey: 'k3', prompt: 'third' });
  await until(() => nextRec.completed.length === 1);
  assert.equal(promptText(nextIo.seen.find((m) => m.method === 'session/prompt')), acpPromptWithInstructions('RULES', 'third'));
  await resumed.close();
});

test('Grok Worker: Aha permissions by role and tier, recognized by x.ai tool meta or title, with secrets redacted', async () => {
  const replies = [];
  const child = fakeChild();
  grokAgent(child, async (message, io) => {
    replies.push(await acpPermission(io, 901, { toolCallId: 'c1', title: 'report_done', _meta: { 'x.ai/tool': { name: 'report_done', server: 'aha' } } }));
    replies.push(await acpPermission(io, 902, { toolCallId: 'c2', title: 'aha__delegate_task', rawInput: { command: `delegate ${SECRET}` } }));
    chunk(io, `Done ${SECRET}`);
    io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  });
  const rec = recorder();
  const driver = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.grok, rec.events, { mcpServers: MCP_SERVERS, ahaMcp: { role: 'worker' }, secrets: [SECRET] });
  await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  await driver.startTurn({ turnKey: 'k', prompt: 'work' });
  await until(() => rec.completed.length === 1);
  assert.deepEqual(replies[0], { outcome: { outcome: 'selected', optionId: 'allow' } }, 'report_done runs unprompted');
  assert.deepEqual(replies[1], { outcome: { outcome: 'selected', optionId: 'reject' } }, 'the person declined');
  assert.equal(rec.requests.length, 1);
  assert.doesNotMatch(rec.requests[0].toolInput, new RegExp(SECRET));
  assert.equal(rec.completed[0].finalText, 'Done <redacted>');
  assert.doesNotMatch(JSON.stringify(rec.timeline), new RegExp(SECRET));
  assert.doesNotMatch(driver.read('k', 0, undefined, true)?.text ?? '', new RegExp(SECRET));
  await driver.close();

  const autoReplies = [];
  const autoChild = fakeChild();
  grokAgent(autoChild, async (message, io) => {
    autoReplies.push(await acpPermission(io, 903, { toolCallId: 'c3', title: 'aha__delegate_task' }));
    autoReplies.push(await acpPermission(io, 904, { toolCallId: 'c4', title: 'Run shell', rawInput: { command: 'ls' } }));
    io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
  });
  const autoRec = recorder(async () => assert.fail('full-auto must not ask'));
  const auto = new AcpSessionDriver(autoChild, ACP_LAUNCH_SPECS.grok, autoRec.events, { mcpServers: MCP_SERVERS, ahaMcp: { role: 'worker' } });
  await auto.open({ cwd: tmpdir(), model: null, policy: 'full-auto' });
  await auto.startTurn({ turnKey: 'k', prompt: 'work' });
  await until(() => autoRec.completed.length === 1);
  assert.deepEqual(autoReplies.map((reply) => reply.outcome.optionId), ['reject', 'allow'], 'person-only Aha tool refused; ordinary tool approved');
  assert.ok(autoRec.timeline.some((event) => event.type === 'notice' && /完全自动模式/.test(event.text)));
  await auto.close();
});

// --- AgentSessionManager lifecycle for Claude and Grok Coordinators ---

function holdingLaunch() {
  const log = [];
  const held = [];
  const launch = (sessionId, _cwd, events, options) => {
    log.push(options);
    const driver = {
      provider: options.provider, capabilities: { resume: true, steer: false, policies: [] },
      alive: true, busy: false, closing: false, sessionId: null, latestTurnKey: null,
      async open({ resumeSessionId }) { driver.sessionId = resumeSessionId ?? `prov-${log.length}`; return driver.sessionId; },
      async startTurn({ turnKey, prompt }) {
        driver.busy = true;
        driver.latestTurnKey = turnKey;
        const finish = () => {
          driver.busy = false;
          events.onTurnCompleted(turnKey, { turnId: 't', stopReason: 'completed', finalText: '', diff: null, usage: null, error: null });
        };
        if (prompt.includes('HOLD')) held.push({ finish, events, turnKey });
        else setImmediate(finish);
        return { status: 'accepted' };
      },
      async interrupt() { return false; }, async waitForIdle() { return true; }, read() { return null; },
      redactText: (text) => text,
      async close() { driver.alive = false; driver.closing = true; },
    };
    return driver;
  };
  return { log, held, launch };
}

for (const provider of ['claude', 'antigravity', 'grok']) {
  test(`manager: a ${provider} Coordinator switches between turns, resumes the same conversation, and keeps a single writer`, async () => {
    const fake = holdingLaunch();
    const userTurns = [];
    const manager = new AgentSessionManager({
      launch: fake.launch, coordinatorInstructions: (id, { policy }) => `rules for ${id} (${policy})`,
      onUserTurn: (id) => userTurns.push(id),
    });
    const info = (id) => manager.list().find((session) => session.id === id);
    const session = await manager.create({ cwd: tmpdir(), policy: 'workspace-write', provider });
    assert.equal((await manager.send(session.id, { text: 'hello' })).status, 'accepted');
    await until(() => info(session.id).status === 'idle');

    assert.equal((await manager.send(session.id, { text: 'HOLD' })).status, 'accepted');
    assert.equal((await manager.setOrchestration(session.id, true)).ok, false, 'never mid-turn');
    fake.held.shift().finish();
    await until(() => info(session.id).status === 'idle');

    assert.deepEqual(await manager.setOrchestration(session.id, true), { ok: true });
    assert.equal((await manager.send(session.id, { text: 'plan the work' })).status, 'accepted');
    await until(() => info(session.id).status === 'idle');
    const coordinatorLaunch = fake.log.find((options) => options.orchestration);
    assert.equal(coordinatorLaunch.provider, provider);
    assert.equal(coordinatorLaunch.resumeSessionId, 'prov-1', 'the same conversation');
    assert.equal(coordinatorLaunch.developerInstructions, `rules for ${session.id} (workspace-write)`);
    assert.deepEqual(userTurns, [session.id], 'only turns in orchestration mode count');
    assert.equal(manager.coordinatorState(session.id).policy, 'workspace-write');
    assert.equal(manager.coordinatorState(session.id).active, true);

    // Crossing the full-auto boundary relaunches onto the same conversation; staying on one side does not.
    const before = fake.log.length;
    assert.equal((await manager.send(session.id, { text: 'go', policy: 'full-auto' })).status, 'accepted');
    await until(() => info(session.id).status === 'idle');
    assert.equal(fake.log.length, before + 1);
    assert.deepEqual([fake.log.at(-1).policy, fake.log.at(-1).orchestration, fake.log.at(-1).resumeSessionId], ['full-auto', true, 'prov-1']);
    assert.equal(manager.coordinatorState(session.id).policy, 'full-auto');
    assert.equal((await manager.send(session.id, { text: 'back', policy: 'workspace-write' })).status, 'accepted');
    await until(() => info(session.id).status === 'idle');
    assert.equal(fake.log.length, before + 2);

    // Coordinator approvals appear in the running turn and resolve with the person's answer.
    assert.equal((await manager.send(session.id, { text: 'HOLD integrate' })).status, 'accepted');
    const approval = manager.requestCoordinatorApproval(session.id, {
      method: 'aha/integrate_worker', toolInput: '{"dispatchId":"d"}', message: '协调者请求执行 integrate_worker',
    }, new AbortController().signal);
    const pending = await until(() => manager.getTimeline(session.id).turns.at(-1).items
      .find((item) => item.kind === 'approval' && item.status === 'pending'));
    assert.equal(pending.method, 'aha/integrate_worker');
    assert.equal(manager.respond(session.id, pending.approvalId, true), true);
    assert.equal(await approval, true);
    const declined = manager.requestCoordinatorApproval(session.id, { method: 'aha/manage_worker', toolInput: '{}' }, new AbortController().signal);
    const second = await until(() => manager.getTimeline(session.id).turns.at(-1).items
      .find((item) => item.kind === 'approval' && item.status === 'pending'));
    manager.respond(session.id, second.approvalId, false);
    assert.equal(await declined, false);
    fake.held.shift().finish();
    await until(() => info(session.id).status === 'idle');
    assert.equal(await manager.requestCoordinatorApproval(session.id, { method: 'aha/x', toolInput: '{}' }, new AbortController().signal), false,
      'no running turn to ask in');

    // A system wake is never the person's message.
    const turnsBefore = userTurns.length;
    assert.equal((await manager.wake(session.id, 'Worker news')).status, 'accepted');
    await until(() => info(session.id).status === 'idle');
    assert.equal(userTurns.length, turnsBefore);
    assert.equal(manager.getTimeline(session.id).turns.at(-1).origin, 'system');

    // Terminal handoff needs orchestration off, then nothing else writes until the terminal exits.
    assert.equal((await manager.handoffToTerminal(session.id)).ok, false);
    assert.deepEqual(await manager.setOrchestration(session.id, false), { ok: true });
    assert.equal((await manager.wake(session.id, 'News')).status, 'not_accepted');
    const handoff = await manager.handoffToTerminal(session.id);
    assert.equal(handoff.ok, true, handoff.error);
    assert.equal(handoff.cliId, provider);
    assert.equal((await manager.send(session.id, { text: 'meanwhile' })).status, 'not_accepted');
    assert.equal(manager.bindHandoff(session.id, 'pty-1'), true);
    assert.equal(manager.reclaim(session.id, () => true).ok, false);
    assert.deepEqual(manager.reclaim(session.id, () => false), { ok: true });
    await manager.dispose();
  });
}

// --- Orchestration service: approval gate and multi-driver headless Workers ---

async function serviceSetup(t, { allowPtySpawn = false, available = () => true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aha-multi-driver-'));
  const agentStatusStore = new AgentStatusStore();
  const store = new OrchestrationStore({ resolveFile: () => join(dir, 'state.json') });
  const hook = new AgentHookServer(agentStatusStore);
  const sessions = new Map();
  const approvals = [];
  const launches = [];
  const spawnCalls = [];
  const app = { scenario: 'normal', approve: true };
  const service = new OrchestrationService({
    store, agentStatusStore, getDefaultCwd: () => cwd,
    settleDelayMs: 0, turnStartObserveTimeoutMs: 250, turnStopSettleMs: 10_000, handoffQuiescenceMs: 150,
    getConfirmMode: () => 'auto',
    writePty: async (id) => {
      agentStatusStore.ingestHookEvent({ ptyId: id, agentId: 'grok', state: 'working' });
      return { ok: true };
    },
    spawnWorkerPty: async (opts) => {
      spawnCalls.push(opts);
      if (!allowPtySpawn) throw new Error('no terminals in this test');
      const ptyId = `fallback-pane-${spawnCalls.length}`;
      agentStatusStore.registerPane(ptyId, { agentId: opts.cliId ?? 'grok' });
      return { ptyId };
    },
    isPtyAlive: (id) => id.startsWith('fallback-pane-'),
    headlessWorkers: {
      available,
      launch(cliId, workerId, workdir, events, { policy }) {
        const env = hook.envForWorker(workerId);
        const child = fakeChild();
        const scenario = app.scenario;
        const io = grokAgent(child, async (message, agent) => {
          if (scenario === 'refuse') {
            agent.send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `refused ${env.AHA_WORKER_TOKEN}` } });
            return;
          }
          if (scenario === 'lost') {
            child.exit(1);
            return;
          }
          if (scenario === 'permission') {
            launch.permReply = await acpPermission(agent, 991, {
              toolCallId: 'c-perm', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' },
            });
          }
          if (scenario === 'secret-file') {
            writeFileSync(join(workdir, `note-${env.AHA_WORKER_TOKEN}.txt`), 'x\n');
          }
          chunk(agent, `Worker finished; token ${env.AHA_WORKER_TOKEN}`);
          if (scenario === 'edit-report') {
            writeFileSync(join(workdir, `wave-${launches.indexOf(launch)}-${Date.now()}.txt`), 'work\n');
          }
          if (scenario === 'report' || scenario === 'edit-report') {
            launch.report = await workerHttp(workerId, 'worker-done-self', { summary: 'Reported by report_done' });
            launch.reports = (launch.reports ?? 0) + 1;
          }
          agent.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
        });
        const launch = { cliId, workerId, cwd: workdir, policy, env, io, child };
        launches.push(launch);
        const driver = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.grok, events, {
          acceptanceWindowMs: 500,
          mcpServers: [{ name: 'aha', command: 'node', args: ['aha-mcp-server.cjs'], env: Object.entries(env).map(([name, value]) => ({ name, value })) }],
          ahaMcp: { role: 'worker' }, secrets: ahaMcpSecrets(env),
        });
        // The fake Grok agent stands in for every CLI, but Grok itself has no read-only mode.
        const open = driver.open.bind(driver);
        driver.open = (options) => open({ ...options, policy: options.policy === 'read-only' ? 'workspace-write' : options.policy });
        const startTurn = driver.startTurn.bind(driver);
        driver.startTurn = (turn) => startTurn({ ...turn, policy: turn.policy === 'read-only' ? 'workspace-write' : turn.policy });
        return driver;
      },
    },
  });
  service.setSessionCoordinators({
    get: (id) => sessions.get(id) ?? null,
    requestApproval: async (id, request) => {
      approvals.push({ id, ...request });
      return app.approve;
    },
  });
  hook.setOrchestrationHandler((action, payload, context) => dispatchOrchestrationHttpAction(service, action, payload, context));
  await hook.start();
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
  const workerHttp = async (id, action, body) => {
    const env = launches.find((entry) => entry.workerId === id).env;
    const response = await fetch(env.AHA_ORCHESTRATION_URL + '/' + action, {
      method: 'POST',
      headers: {
        'content-type': 'application/json', 'x-aha-agent-hook-token': env.AHA_AGENT_HOOK_TOKEN,
        'x-aha-worker-id': id, 'x-aha-worker-token': env.AHA_WORKER_TOKEN,
      },
      body: JSON.stringify(body),
    });
    return response.json();
  };
  return Object.assign(app, { dir, service, store, hook, sessions, approvals, launches, spawnCalls, call, workerHttp });
}

/** A sparse clone of this repository, so the fallback diff runs against a real HEAD. */
function sparseRepo(dir) {
  const repo = join(dir, 'repo');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', windowsHide: true });
  git('clone', '--quiet', '--shared', '--no-checkout', cwd, repo);
  git('-C', repo, 'sparse-checkout', 'set', '--no-cone', '/README.md');
  git('-C', repo, 'checkout', '--quiet');
  return repo;
}

/** A one-commit repository the handoff can snapshot (sparse checkouts refuse files outside their cone). */
function plainRepo(dir) {
  const repo = join(dir, 'plain-repo');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  execFileSync('git', ['init', '--quiet', '-b', 'main', repo], { windowsHide: true });
  writeFileSync(join(repo, 'README.md'), 'handoff\n');
  git('add', 'README.md');
  git('-c', 'user.name=Aha', '-c', 'user.email=aha@example.invalid', 'commit', '--quiet', '-m', 'init');
  return repo;
}

test('cross-CLI handoff keeps the worktree, starts the new agent from redacted context, and records both authors', async (t) => {
  const app = await serviceSetup(t);
  const repo = plainRepo(app.dir);
  app.sessions.set(SESSION_A, { cwd: repo, provider: 'claude', active: true, idle: true, network: false, policy: 'full-auto' });
  app.scenario = 'report';
  const started = await app.call(SESSION_A, 'delegate-task', { role: 'builder', task: 'Implement it', agent: 'grok', worktree: false });
  assert.equal(started.ok, true, started.error);
  const source = started.result.dispatch;
  await until(() => app.store.getDispatchContext(source.id).status === 'completed');
  writeFileSync(join(repo, 'wip.txt'), 'half done\n');

  const refusedPi = await app.call(SESSION_A, 'role-manage', { role: 'builder', action: 'handoff', agent: 'pi' });
  assert.equal(refusedPi.ok, false);
  assert.equal(refusedPi.data.code, 'driver_not_headless');
  const sameCli = await app.call(SESSION_A, 'role-manage', { role: 'builder', action: 'handoff', agent: 'grok' });
  assert.match(sameCli.error, /follow-up instead/);
  assert.equal(app.launches.length, 1, 'refused handoffs start nothing');

  const handed = await app.call(SESSION_A, 'role-manage', {
    role: 'builder', action: 'handoff', agent: 'claude', reason: 'Grok hit its usage limit; finish wip.txt',
  });
  assert.equal(handed.ok, true, handed.error);
  const next = handed.result.dispatch;
  assert.match(next.assigneeHandle, /^claude-worker-[a-f0-9-]{36}$/);
  assert.equal(next.cliId, 'claude');
  assert.equal(next.followUpOfDispatchId, source.id);
  assert.deepEqual(next.authorCliIds, ['grok', 'claude']);
  assert.equal(next.providerCwd, repo);
  assert.ok(existsSync(join(repo, 'wip.txt')), 'uncommitted work stays in the worktree');
  const launch = app.launches.at(-1);
  assert.deepEqual([launch.cliId, launch.cwd, launch.workerId], ['claude', repo, next.assigneeHandle]);
  const prompt = launch.io.seen.find((m) => m.method === 'session/prompt').params.prompt.map((block) => block.text ?? '').join('');
  assert.match(prompt, /### Handoff Context/);
  assert.match(prompt, /taking over this task from Grok/);
  assert.match(prompt, /Grok hit its usage limit/);
  assert.match(prompt, /### Original Task/);
  assert.doesNotMatch(prompt, new RegExp(app.launches[0].env.AHA_WORKER_TOKEN));

  const [record] = app.store.listWorkerHandoffs({ runId: source.runId });
  assert.equal(record.status, 'completed');
  assert.equal(record.targetDispatchId, next.id);
  assert.match(record.snapshotOid, /^[0-9a-f]{40}$/);
  assert.equal(app.store.listResumeClaims().find((c) => c.workerId === next.assigneeHandle)?.status, 'active');
  await until(() => app.store.getDispatchContext(next.id).status === 'completed');
  // The report's HTTP reply is sent after the state is durable; let it land before teardown.
  await until(() => launch.report);
});

function gitOut(cwdPath, ...args) {
  return execFileSync('git', args, { cwd: cwdPath, encoding: 'utf8', windowsHide: true }).trim();
}

async function residentBuilder(t) {
  const app = await serviceSetup(t);
  const repo = plainRepo(app.dir);
  app.sessions.set(SESSION_A, { cwd: repo, provider: 'claude', active: true, idle: true, network: false, policy: 'workspace-write' });
  app.scenario = 'edit-report';
  const started = await app.call(SESSION_A, 'delegate-task', { role: 'builder', task: 'Build wave one', agent: 'grok' });
  assert.equal(started.ok, true, started.error);
  const first = started.result.dispatch;
  assert.ok(first.ownsWorktree && first.worktreePath !== repo);
  await until(() => app.store.getDispatchContext(first.id).status === 'completed');
  await until(() => app.launches[0].report);
  const integrated = await app.call(SESSION_A, 'worker-integrate', { worker: 'builder', targetBranch: 'main', keepResident: true });
  assert.equal(integrated.ok, true, integrated.error);
  return { app, repo, first, integrated: integrated.result };
}

test('a resident Worker keeps its worktree after integration and starts its next wave on a fresh branch in place', async (t) => {
  const { app, repo, first, integrated } = await residentBuilder(t);
  assert.equal(integrated.resident, true);
  assert.equal(integrated.released, false);
  const kept = app.store.getDispatchContext(first.id);
  assert.equal(kept.releasedAt ?? null, null);
  assert.equal(kept.residentAfterIntegration.targetBranch, 'main');
  assert.ok(existsSync(first.worktreePath), 'the worktree stays for the next wave');

  // Work written after integration is never thrown away by the next wave.
  const stray = join(first.worktreePath, 'not-integrated.txt');
  writeFileSync(stray, 'keep me');
  const refused = await app.call(SESSION_A, 'role-message', { role: 'builder', message: 'Too early' });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /changed after it was integrated/);
  assert.ok(existsSync(stray));
  rmSync(stray);

  const mainHead = gitOut(repo, 'rev-parse', 'main');
  const wave = await app.call(SESSION_A, 'role-message', { role: 'builder', message: 'Wave two: add the next feature' });
  assert.equal(wave.ok, true, wave.error);
  const next = app.store.listDispatches({ runId: first.runId }).find((d) => d.followUpOfDispatchId === first.id);
  assert.equal(next.worktreePath, first.worktreePath, 'same directory, so the conversation resumes natively');
  assert.equal(next.assigneeHandle, first.assigneeHandle);
  assert.notEqual(next.branch, first.branch);
  assert.equal(next.baseCommit, mainHead);
  assert.deepEqual(next.authorCliIds, ['grok'], 'a new wave starts its own author set');
  assert.equal(gitOut(first.worktreePath, 'branch', '--show-current'), next.branch);
  assert.equal(gitOut(repo, 'branch', '--list', first.branch), '', 'the integrated wave-one branch is gone');
  assert.equal(app.store.getDispatchContext(first.id).residentAfterIntegration, undefined);
  await until(() => app.store.getDispatchContext(next.id).status === 'completed');
  // The same process reports both waves; let the second reply land before teardown.
  await until(() => app.launches.at(-1).reports >= 2);
});

test('a resident Worker whose worktree is gone continues in a new worktree from portable context', async (t) => {
  const { app, repo, first } = await residentBuilder(t);
  await app.service.workers.codexWorkers.get(first.assigneeHandle)?.close(true);
  await until(() => !app.service.workers.codexWorkers.has(first.assigneeHandle));
  gitOut(repo, 'worktree', 'remove', '--force', first.worktreePath);
  const launchesBefore = app.launches.length;
  const wave = await app.call(SESSION_A, 'role-message', { role: 'builder', message: 'Wave two after cleanup' });
  assert.equal(wave.ok, true, wave.error);
  const next = app.store.listDispatches({ runId: first.runId }).find((d) => d.followUpOfDispatchId === first.id);
  assert.notEqual(next.worktreePath, first.worktreePath);
  assert.ok(existsSync(next.worktreePath));
  assert.notEqual(next.assigneeHandle, first.assigneeHandle, 'a new conversation, since the old one is tied to the old directory');
  assert.equal(next.baseCommit, gitOut(repo, 'rev-parse', 'main'));
  assert.equal(app.launches.length, launchesBefore + 1);
  const prompt = app.launches.at(-1).io.seen.find((m) => m.method === 'session/prompt').params.prompt.map((b) => b.text ?? '').join('');
  assert.match(prompt, /### Handoff Context/);
  assert.match(prompt, /previous worktree is gone/);
  await until(() => app.store.getDispatchContext(next.id).status === 'completed');
  await until(() => app.launches.at(-1).report);
});

test('a handoff is refused and starts nothing while the worktree keeps changing', async (t) => {
  const app = await serviceSetup(t);
  const repo = plainRepo(app.dir);
  app.sessions.set(SESSION_A, { cwd: repo, provider: 'claude', active: true, idle: true, network: false, policy: 'full-auto' });
  app.scenario = 'report';
  const started = await app.call(SESSION_A, 'delegate-task', { role: 'builder', task: 'Implement it', agent: 'grok', worktree: false });
  assert.equal(started.ok, true, started.error);
  await until(() => app.store.getDispatchContext(started.result.dispatch.id).status === 'completed');
  // A leftover background process the old agent started, still writing.
  const writer = spawn(process.execPath, ['-e',
    `const fs = require('fs'); let i = 0; setInterval(() => fs.writeFileSync(${JSON.stringify(join(repo, 'bg.txt'))}, String(i++)), 15);`,
  ], { stdio: 'ignore', windowsHide: true });
  t.after(() => writer.kill());
  await delay(100);
  const refused = await app.call(SESSION_A, 'role-manage', { role: 'builder', action: 'handoff', agent: 'claude' });
  assert.equal(refused.ok, false);
  assert.equal(refused.data.code, 'worktree_still_changing');
  assert.match(refused.error, /left as it is/);
  assert.equal(app.launches.length, 1);
  assert.deepEqual(app.store.listWorkerHandoffs(), []);
  assert.ok(existsSync(join(repo, 'bg.txt')));
});

test('a handoff interrupted by a restart needs a person and is announced once, never resumed', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-handoff-recovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const statePath = join(dir, 'state.json');
  const store = new OrchestrationStore({ resolveFile: () => statePath });
  const run = store.createRun({ objective: 'Recover', coordinatorHandle: 'coordinator-pane' });
  store.createWorkerHandoff({
    runId: run.id, sourceDispatchId: 'd-1', sourceWorkerId: 'grok-worker-1', fromCli: 'grok', toCli: 'claude',
    cwd: dir, targetWorkerId: 'claude-worker-1', snapshotOid: null, context: 'ctx',
  });
  await store.flushDurable();

  const restarted = new OrchestrationStore({ resolveFile: () => statePath });
  restarted.load();
  const [handoff] = restarted.listWorkerHandoffs();
  assert.equal(handoff.status, 'needs_attention');
  const launches = [];
  const service = new OrchestrationService({
    store: restarted, agentStatusStore: new AgentStatusStore(), getDefaultCwd: () => dir,
    headlessWorkers: { launch: (...args) => { launches.push(args); throw new Error('must not launch'); } },
  });
  t.after(() => service.dispose());
  const announced = restarted.listMessages({ runId: run.id }).filter((m) => m.subject === 'Handoff grok -> claude needs attention');
  assert.equal(announced.length, 1);
  assert.match(announced[0].body, /Nothing was restarted/);
  service.announceInterruptedHandoffs();
  assert.equal(restarted.listMessages({ runId: run.id }).filter((m) => m.subject.startsWith('Handoff grok')).length, 1);
  assert.deepEqual(launches, []);
});

test('service gate: non-Codex session Coordinators follow the Codex approval tiers for manage, integrate, and finalize', async (t) => {
  const app = await serviceSetup(t);
  const sessionCwd = mkdtempSync(join(app.dir, 'session-'));
  const gated = { 'role-manage': 'manage_worker', 'worker-integrate': 'integrate_worker', 'run-finalize': 'finalize_run_integration' };
  const payload = { dispatchId: 'missing-dispatch', runId: 'missing-run', role: 'nobody', action: 'release' };

  for (const provider of ['claude', 'antigravity', 'grok']) {
    for (const policy of ['workspace-write', 'read-only']) {
      app.sessions.set(SESSION_A, { cwd: sessionCwd, provider, active: true, policy });
      for (const [action, tool] of Object.entries(gated)) {
        app.approvals.length = 0;
        app.approve = false;
        const declined = await app.call(SESSION_A, action, payload);
        assert.equal(declined.code, 'operation_rejected', `${provider} ${policy} ${action}`);
        assert.match(declined.error, new RegExp(`declined ${tool}`));
        assert.equal(app.approvals.length, 1);
        assert.equal(app.approvals[0].method, `aha/${tool}`);
        assert.equal(app.approvals[0].id, SESSION_A);

        app.approve = true;
        const approved = await app.call(SESSION_A, action, payload);
        assert.equal(app.approvals.length, 2, 'asked again: one approval covers one call');
        assert.doesNotMatch(approved.error ?? '', /declined|full-auto cannot ask/, `${action} passed the gate`);
      }
    }

    app.sessions.set(SESSION_A, { cwd: sessionCwd, provider, active: true, policy: 'full-auto' });
    app.approvals.length = 0;
    assert.doesNotMatch((await app.call(SESSION_A, 'role-manage', payload)).error ?? '', /declined|full-auto cannot ask/);
    for (const action of ['worker-integrate', 'run-finalize']) {
      const denied = await app.call(SESSION_A, action, payload);
      assert.equal(denied.code, 'operation_rejected');
      assert.match(denied.error, /full-auto cannot ask/);
    }
    assert.equal(app.approvals.length, 0, 'full-auto never prompts');
  }

  // A Codex session prompts inside its own app-server, so the service does not ask again.
  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'codex', active: true, policy: 'workspace-write' });
  app.approvals.length = 0;
  app.approve = false;
  assert.doesNotMatch((await app.call(SESSION_A, 'worker-integrate', payload)).error ?? '', /declined/);
  assert.equal(app.approvals.length, 0);
});

test('headless Grok Worker: own credentials, no pane, provider session id, workspace-write under a full-auto Coordinator, and a pending-confirmation turn with a redacted diff', async (t) => {
  const app = await serviceSetup(t);
  const repo = sparseRepo(app.dir);
  app.sessions.set(SESSION_A, { cwd: repo, provider: 'claude', active: true, idle: true, network: false, policy: 'full-auto' });
  app.scenario = 'secret-file';

  const started = await app.call(SESSION_A, 'delegate-task', { role: 'builder', task: 'Implement it', agent: 'grok', worktree: false });
  assert.equal(started.ok, true, started.error);
  const { dispatch } = started.result;
  assert.match(dispatch.assigneeHandle, /^grok-worker-[a-f0-9-]{36}$/);
  assert.equal(dispatch.executionMode, 'codex-app-server');
  assert.equal(dispatch.assigneePaneId, null);
  assert.equal(dispatch.ownsPane, false);
  assert.equal(app.spawnCalls.length, 0);

  const [launch] = app.launches;
  assert.deepEqual([launch.cliId, launch.policy, launch.cwd], ['grok', 'workspace-write', repo], 'never full-auto, rooted at the task directory');
  assert.equal(launch.workerId, dispatch.assigneeHandle);
  assert.equal(launch.env.AHA_WORKER_ID, dispatch.assigneeHandle);
  assert.ok(launch.env.AHA_WORKER_TOKEN);
  assert.ok(!Object.keys(launch.env).some((key) => key.startsWith('AHA_SESSION')), 'a Worker never carries the Coordinator\u2019s session credentials');
  const mcpEnv = launch.io.seen.find((m) => m.method === 'session/new').params.mcpServers[0].env;
  assert.ok(mcpEnv.some(({ name, value }) => name === 'AHA_WORKER_ID' && value === dispatch.assigneeHandle));

  // The Worker wrote an untracked file whose name holds its token before ending the turn.
  const timeline = () => app.service.getWorkerTimeline({ dispatchId: dispatch.id });
  assert.equal(timeline().cliId, 'grok');
  assert.equal(timeline().readOnly, false);
  assert.equal(timeline().providerSessionId, 'grok-1');
  const settlement = await until(() => timeline()?.turns[0]?.items.find((item) => item.kind === 'settlement'));
  assert.equal(settlement.settlement, 'turn_pending_confirmation');
  assert.match(settlement.summary, /Worker finished; token <redacted>/);
  assert.equal(settlement.diffSource, 'git');
  assert.match(settlement.diff, /note-<redacted>\.txt/);
  const token = new RegExp(launch.env.AHA_WORKER_TOKEN);
  assert.doesNotMatch(JSON.stringify(timeline()), token);
  assert.equal(app.store.getDispatchContext(dispatch.id).status, 'dispatched', 'a finished turn never settles the dispatch');
  const post = app.store.listBoardPosts(started.result.run.id).find((p) => p.subject?.startsWith('Grok turn ended'));
  assert.ok(post, 'the Coordinator hears about it under the Grok label');
  assert.doesNotMatch(post.body, token);
  assert.doesNotMatch(app.service.workerRead({ dispatchId: dispatch.id, limit: 10_000 }).text, token);
});

test('headless Claude Worker: read-only tasks run read-only, and report_done settles the dispatch', async (t) => {
  const app = await serviceSetup(t);
  const sessionCwd = mkdtempSync(join(app.dir, 'session-'));
  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'grok', active: true, idle: true, network: false, policy: 'workspace-write' });
  app.scenario = 'report';
  const started = await app.call(SESSION_A, 'delegate-task', { role: 'scout', task: 'Read it', agent: 'claude', taskKind: 'research', worktree: false });
  assert.equal(started.ok, true, started.error);
  const { dispatch } = started.result;
  assert.match(dispatch.assigneeHandle, /^claude-worker-/);
  assert.deepEqual([app.launches[0].cliId, app.launches[0].policy, app.launches[0].cwd], ['claude', 'read-only', sessionCwd]);
  assert.equal(app.service.getWorkerTimeline({ dispatchId: dispatch.id }).cliId, 'claude');
  assert.equal(app.service.getWorkerTimeline({ dispatchId: dispatch.id }).readOnly, true);
  await until(() => app.launches[0].report);
  assert.equal(app.launches[0].report.ok, true, JSON.stringify(app.launches[0].report));
  await until(() => app.store.getDispatchContext(dispatch.id).status !== 'dispatched');
  assert.notEqual(app.store.getDispatchContext(dispatch.id).status, 'failed');
  await delay(300);
  const items = app.service.getWorkerTimeline({ dispatchId: dispatch.id })?.turns.flatMap((turn) => turn.items) ?? [];
  assert.ok(!items.some((item) => item.kind === 'settlement' && item.settlement === 'turn_pending_confirmation'), 'report_done, not the turn end, settled it');
});

test('terminal fallback: read-only Grok, drivers without headless support, and unavailable CLIs keep a PTY without Codex sandbox flags', async (t) => {
  const app = await serviceSetup(t, { allowPtySpawn: true, available: (cliId) => cliId !== 'claude' });
  const sessionCwd = mkdtempSync(join(app.dir, 'session-'));
  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'claude', active: true, idle: true, policy: 'workspace-write' });
  const cases = [
    ['grok', { taskKind: 'research' }],
    ['antigravity', { taskKind: 'research' }],
    ['pi', {}],
    ['claude', {}],
  ];
  for (const [agent, extra] of cases) {
    const started = await app.call(SESSION_A, 'delegate-task', { role: `r-${agent}`, task: 'Do it', agent, worktree: false, ...extra });
    assert.equal(started.ok, true, `${agent}: ${started.error}`);
    assert.equal(started.result.dispatch.executionMode, undefined, agent);
    const spawned = app.spawnCalls.at(-1);
    assert.equal(spawned.cliId, agent);
    assert.ok(!spawned.extraArgs.includes('--sandbox'), JSON.stringify(spawned.extraArgs));
  }
  assert.equal(app.launches.length, 0);
});

test('delivery: not_accepted falls back to one PTY; unknown_acceptance fails without resending to a terminal', async (t) => {
  const app = await serviceSetup(t, { allowPtySpawn: true });
  const sessionCwd = mkdtempSync(join(app.dir, 'session-'));
  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'claude', active: true, idle: true, policy: 'workspace-write' });

  app.scenario = 'refuse';
  const refused = await app.call(SESSION_A, 'delegate-task', { role: 'builder', task: 'Write', agent: 'grok', worktree: false });
  assert.equal(refused.ok, true, refused.error);
  assert.equal(app.launches.length, 1);
  assert.equal(refused.result.dispatch.executionMode, undefined, 'moved to a terminal');
  assert.equal(app.spawnCalls.length, 1);
  assert.equal(app.spawnCalls[0].cliId, 'grok');
  assert.ok(!app.spawnCalls[0].extraArgs.includes('--sandbox'));

  app.scenario = 'lost';
  const lost = await app.call(SESSION_A, 'delegate-task', { role: 'editor', task: 'Edit', agent: 'grok', worktree: false });
  assert.equal(lost.code, 'prompt_delivery_failed', JSON.stringify(lost));
  assert.match(lost.error, /Grok turn acceptance is unknown/);
  assert.equal(app.spawnCalls.length, 1, 'never resent to a PTY');
  const token = app.launches[1].env.AHA_WORKER_TOKEN;
  assert.doesNotMatch(JSON.stringify(lost), new RegExp(token));
});

test('ACP turn interrupt aborts open permission requests and answers cancelled per ACP spec', async () => {
  assert.equal(approvalToolName('item/commandExecution/requestApproval'), 'commandExecution');
  assert.equal(approvalToolName('claude/Bash'), 'Bash');
  assert.equal(approvalToolName('aha/integrate_worker'), 'integrate_worker');
  assert.equal(approvalToolName('session/request_permission/execute'), 'execute');
  assert.equal(isLongPollOrchestrationAction('worker-integrate'), true);
  assert.equal(isLongPollOrchestrationAction('run-finalize'), true);
  assert.equal(isLongPollOrchestrationAction('role-manage'), true);

  let permReply = null;
  const child = fakeChild();
  grokAgent(child, async (message, io) => {
    permReply = await acpPermission(io, 950, { toolCallId: 'c-int', kind: 'execute', title: 'Run npm test', rawInput: { command: 'npm test' } });
    io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'cancelled' } });
  });
  let requestSignal = null;
  const rec = recorder((req) => {
    requestSignal = req.signal;
    return new Promise((resolve) => {
      req.signal.addEventListener('abort', () => resolve({ decision: 'decline' }), { once: true });
    });
  });
  const driver = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.grok, rec.events);
  await driver.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  assert.equal((await driver.startTurn({ turnKey: 'k-int', prompt: 'run tests' })).status, 'accepted');
  await until(() => requestSignal !== null);
  assert.equal(await driver.interrupt(), true);
  await until(() => permReply !== null && rec.completed.length === 1);
  assert.equal(requestSignal.aborted, true, 'turn abort cancels the held approval signal');
  assert.deepEqual(permReply, { outcome: { outcome: 'cancelled' } }, 'interrupted turn answers cancelled, never reject');
  assert.equal(rec.completed[0].stopReason, 'interrupted');
  await driver.close();
});

test('manager policy sync and Grok orchestration-exit instructions stay accurate across non-relaunch switches', async () => {
  const fake = holdingLaunch();
  const manager = new AgentSessionManager({
    launch: fake.launch,
    coordinatorInstructions: (id, { policy }) => `rules for ${id} (${policy})`,
  });
  const info = (id) => manager.list().find((s) => s.id === id);

  // Claude Coordinator switching workspace-write -> read-only without relaunch updates coordinatorState().policy.
  const claude = await manager.create({ cwd: tmpdir(), policy: 'workspace-write', provider: 'claude' });
  assert.deepEqual(await manager.setOrchestration(claude.id, true), { ok: true });
  const launchesBefore = fake.log.length;
  assert.equal((await manager.send(claude.id, { text: 'HOLD read', policy: 'read-only' })).status, 'accepted');
  assert.equal(fake.log.length, launchesBefore, 'no relaunch across non-full-auto tiers');
  assert.equal(manager.coordinatorState(claude.id).policy, 'read-only', 'active turn reflects read-only immediately');
  fake.held.shift().finish();
  await until(() => info(claude.id).status === 'idle');
  assert.equal(manager.coordinatorState(claude.id).policy, 'read-only');
  assert.deepEqual(await manager.setOrchestration(claude.id, false), { ok: true });
  assert.equal(fake.log.at(-1).developerInstructions, undefined, 'Claude system prompt needs no exit banner');

  // Grok Coordinator turning orchestration off after an orchestrated turn gets the one-time exit notice.
  const grok = await manager.create({ cwd: tmpdir(), policy: 'workspace-write', provider: 'grok' });
  assert.deepEqual(await manager.setOrchestration(grok.id, true), { ok: true });
  assert.equal((await manager.send(grok.id, { text: 'delegate' })).status, 'accepted');
  await until(() => info(grok.id).status === 'idle');
  assert.deepEqual(await manager.setOrchestration(grok.id, false), { ok: true });
  assert.equal(fake.log.at(-1).developerInstructions, ORCHESTRATION_ENDED_INSTRUCTIONS);

  // Once a normal non-orchestrated turn runs, future resumes do not repeat the exit notice.
  assert.equal((await manager.send(grok.id, { text: 'direct work' })).status, 'accepted');
  await until(() => info(grok.id).status === 'idle');
  await fake.log.length;
  await manager.handoffToTerminal(grok.id);
  manager.reclaim(grok.id, () => false);
  assert.equal((await manager.send(grok.id, { text: 'direct again' })).status, 'accepted');
  await until(() => info(grok.id).status === 'idle');
  assert.equal(fake.log.at(-1).developerInstructions, undefined);

  await manager.dispose();
});

test('headless Worker approvals record real provider/toolName, follow-up errors name the real driver, and MCP cancellation expires Coordinator approvals', async (t) => {
  const app = await serviceSetup(t);
  const sessionCwd = mkdtempSync(join(app.dir, 'session-'));

  const fake = holdingLaunch();
  const manager = new AgentSessionManager({
    launch: fake.launch,
    coordinatorInstructions: (id, { policy }) => `rules for ${id} (${policy})`,
  });
  t.after(() => manager.dispose());
  const coord = await manager.create({ cwd: sessionCwd, policy: 'workspace-write', provider: 'claude' });
  assert.deepEqual(await manager.setOrchestration(coord.id, true), { ok: true });
  app.service.setSessionCoordinators({
    get: (id) => manager.coordinatorState(id),
    requestApproval: (id, req, signal) => manager.requestCoordinatorApproval(id, req, signal),
  });

  // 1. End-to-end headless Grok Worker permission escalation carries provider="grok" and toolName="execute".
  app.scenario = 'permission';
  const permRun = await app.call(coord.id, 'delegate-task', { role: 'runner', task: 'Run command', agent: 'grok', worktree: false });
  assert.equal(permRun.ok, true, permRun.error);
  const permDispatch = permRun.result.dispatch;
  const escalation = await until(() => app.store.listMessages({ runId: permRun.result.run.id })
    .find((m) => m.kind === 'approval' && m.fromHandle === `dispatch:${permDispatch.id}`));
  const parsedPayload = JSON.parse(escalation.payload);
  assert.equal(parsedPayload.provider, 'grok');
  assert.equal(parsedPayload.toolName, 'execute');
  assert.equal((await manager.send(coord.id, { text: 'HOLD approve' })).status, 'accepted');
  const approvePending = app.call(coord.id, 'role-manage', { role: 'runner', action: 'approve' });
  const manageCard = await until(() => manager.getTimeline(coord.id).turns.at(-1).items
    .find((item) => item.kind === 'approval' && item.status === 'pending'));
  assert.equal(manageCard.tool, 'manage_worker');
  assert.equal(manager.respond(coord.id, manageCard.approvalId, true), true);
  assert.equal((await approvePending).ok, true);
  fake.held.shift().finish();
  await until(() => app.launches[0].permReply);
  assert.deepEqual(app.launches[0].permReply, { outcome: { outcome: 'selected', optionId: 'allow' } });

  // 2. An exited settled Grok Worker is woken in place: same identity, its ACP session loaded again.
  app.scenario = 'report';
  const started = await app.call(coord.id, 'delegate-task', { role: 'fixer', task: 'Fix it', agent: 'grok', worktree: false });
  assert.equal(started.ok, true, started.error);
  await until(() => app.store.getDispatchContext(started.result.dispatch.id).status === 'completed');
  app.launches[1].child.exit(0);
  await delay(50);
  const followUp = await app.call(coord.id, 'role-message', { role: 'fixer', message: 'One more change' });
  assert.equal(followUp.ok, true, followUp.error);
  assert.equal(app.launches.length, 3);
  assert.equal(app.launches[2].workerId, started.result.dispatch.assigneeHandle);
  const reloaded = app.launches[2].io.seen.find((m) => m.method === 'session/load' || m.method === 'session/resume');
  assert.equal(reloaded?.params.sessionId, started.result.dispatch.providerSessionId);
  await until(() => app.store.listDispatches({ runId: started.result.run.id })
    .some((d) => d.followUpOfDispatchId === started.result.dispatch.id && d.status === 'completed'));

  // 3. Real aha-mcp-server.cjs notifications/cancelled aborts in-flight HTTP gate and expires the Coordinator approval card.
  assert.equal((await manager.send(coord.id, { text: 'HOLD integrate' })).status, 'accepted');
  const mcpIn = new PassThrough();
  const mcpOut = new PassThrough();
  const mcpOutLines = [];
  createInterface({ input: mcpOut }).on('line', (line) => {
    if (line.trim()) mcpOutLines.push(JSON.parse(line));
  });

  const savedEnv = {};
  const realSessionEnv = app.hook.envForSession(coord.id);
  for (const key of Object.keys(realSessionEnv)) {
    savedEnv[key] = process.env[key];
    process.env[key] = realSessionEnv[key];
  }
  const serverDone = runMcpServer({ input: mcpIn, output: mcpOut });
  try {
    mcpIn.write(JSON.stringify({
      jsonrpc: '2.0', id: 77, method: 'tools/call',
      params: { name: 'integrate_worker', arguments: { role: 'fixer' } },
    }) + '\n');

    const pending = await until(() => manager.getTimeline(coord.id).turns.at(-1).items
      .find((item) => item.kind === 'approval' && item.status === 'pending'));
    assert.equal(pending.tool, 'integrate_worker');

    // Simulate MCP client timing out tools/call and sending notifications/cancelled while the turn continues.
    mcpIn.write(JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 77 },
    }) + '\n');

    await until(() => manager.getTimeline(coord.id).turns.at(-1).items
      .find((item) => item.kind === 'approval' && item.approvalId === pending.approvalId)?.status === 'expired');

    // Late human click on "Allow" is rejected and cannot trigger integration.
    assert.equal(manager.respond(coord.id, pending.approvalId, true), false);
    assert.equal(mcpOutLines.some((msg) => msg.id === 77), false, 'cancelled RPC emits no late response');
  } finally {
    mcpIn.end();
    await serverDone;
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) delete process.env[key];
      else process.env[key] = val;
    }
    fake.held.shift()?.finish();
  }
});

test('Antigravity Coordinator & Worker: systemPrompt _meta, call_mcp_tool permissions, and headless Antigravity Worker', async (t) => {
  const AGY_INIT = {
    protocolVersion: 1,
    agentCapabilities: {
      loadSession: true,
      sessionCapabilities: { resume: {} },
      promptCapabilities: { image: true },
      _meta: { antigravity: { systemPrompt: { append: true } } },
    },
    authMethods: [],
  };
  const agyAgent = (child, onPrompt = (message, io) => io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } })) =>
    wire(child, (message) => {
      if (message.method === 'initialize') io.send({ jsonrpc: '2.0', id: message.id, result: AGY_INIT });
      else if (message.method === 'session/new') io.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'agy-1' } });
      else if (message.method === 'session/prompt') void onPrompt(message, io);
      else if (message.method && message.id !== undefined) io.send({ jsonrpc: '2.0', id: message.id, result: {} });
    });

  // 1. Coordinator sends _meta.antigravity.systemPrompt.append on new & resume without polluting user prompts.
  const child = fakeChild();
  const io = wire(child, (message) => {
    if (message.method === 'initialize') io.send({ jsonrpc: '2.0', id: message.id, result: AGY_INIT });
    else if (message.method === 'session/new') io.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'agy-1' } });
    else if (message.method === 'session/prompt') io.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    else if (message.method && message.id !== undefined) io.send({ jsonrpc: '2.0', id: message.id, result: {} });
  });
  const agyServers = [{ name: 'aha_orchestration', command: 'node', args: ['aha-mcp-server.cjs'], env: [{ name: 'AHA_SESSION_TOKEN', value: SECRET }] }];
  const rec = recorder();
  const coord = new AcpSessionDriver(child, ACP_LAUNCH_SPECS.antigravity, rec.events, {
    mcpServers: agyServers, ahaMcp: { role: 'coordinator', serverName: 'aha_orchestration' }, secrets: [SECRET],
  });
  assert.equal(await coord.open({ cwd: tmpdir(), model: null, policy: 'workspace-write', developerInstructions: 'AGY RULES' }), 'agy-1');
  const newReq = io.seen.find((m) => m.method === 'session/new');
  assert.deepEqual(newReq.params.mcpServers, agyServers);
  assert.deepEqual(newReq.params._meta, { antigravity: { systemPrompt: { append: 'AGY RULES' } } });
  await coord.startTurn({ turnKey: 'a1', prompt: 'hello' });
  await until(() => rec.completed.length === 1);
  assert.equal(promptText(io.seen.find((m) => m.method === 'session/prompt')), 'hello', 'native _meta leaves user prompt untouched');
  await coord.close();

  // 2. Antigravity Worker recognizes call_mcp_tool rawInput (ServerName/ToolName) for aha_orchestration.
  const workerReplies = [];
  const workerChild = fakeChild();
  const wIo = wire(workerChild, async (message) => {
    if (message.method === 'initialize') wIo.send({ jsonrpc: '2.0', id: message.id, result: AGY_INIT });
    else if (message.method === 'session/new') wIo.send({ jsonrpc: '2.0', id: message.id, result: { sessionId: 'agy-w1' } });
    else if (message.method === 'session/prompt') {
      wIo.send({ jsonrpc: '2.0', id: 971, method: 'session/request_permission', params: {
        sessionId: 'agy-w1', options: PERMISSION_OPTIONS,
        toolCall: { toolCallId: 't1', title: 'call_mcp_tool', rawInput: { ServerName: 'aha_orchestration', ToolName: 'report_done' } },
      } });
      workerReplies.push((await wIo.waitFor((sent) => sent.id === 971 && !sent.method)).result);
      wIo.send({ jsonrpc: '2.0', id: 972, method: 'session/request_permission', params: {
        sessionId: 'agy-w1', options: PERMISSION_OPTIONS,
        toolCall: { toolCallId: 't2', title: 'call_mcp_tool', rawInput: { ServerName: 'aha_orchestration', ToolName: 'delegate_task' } },
      } });
      workerReplies.push((await wIo.waitFor((sent) => sent.id === 972 && !sent.method)).result);
      wIo.send({ jsonrpc: '2.0', id: message.id, result: { stopReason: 'end_turn' } });
    } else if (message.method && message.id !== undefined) wIo.send({ jsonrpc: '2.0', id: message.id, result: {} });
  });
  const wRec = recorder();
  const worker = new AcpSessionDriver(workerChild, ACP_LAUNCH_SPECS.antigravity, wRec.events, {
    mcpServers: agyServers, ahaMcp: { role: 'worker', serverName: 'aha_orchestration' }, secrets: [SECRET],
  });
  await worker.open({ cwd: tmpdir(), model: null, policy: 'workspace-write' });
  await worker.startTurn({ turnKey: 'w1', prompt: 'work' });
  await until(() => wRec.completed.length === 1);
  assert.deepEqual(workerReplies[0], { outcome: { outcome: 'selected', optionId: 'allow' } }, 'report_done runs unprompted');
  assert.deepEqual(workerReplies[1], { outcome: { outcome: 'selected', optionId: 'reject' } }, 'person-only Aha tool asks and declines');
  assert.equal(wRec.requests.length, 1);
  await worker.close();

  // 3. End-to-end headless Antigravity Worker spawned by an Antigravity Coordinator.
  const app = await serviceSetup(t);
  const sessionCwd = mkdtempSync(join(app.dir, 'agy-session-'));
  app.sessions.set(SESSION_A, { cwd: sessionCwd, provider: 'antigravity', active: true, idle: true, network: false, policy: 'workspace-write' });
  const started = await app.call(SESSION_A, 'delegate-task', { role: 'builder', task: 'Build it', agent: 'antigravity', worktree: false });
  assert.equal(started.ok, true, started.error);
  const { dispatch } = started.result;
  assert.match(dispatch.assigneeHandle, /^antigravity-worker-[a-f0-9-]{36}$/);
  assert.equal(dispatch.executionMode, 'codex-app-server');
  assert.equal(dispatch.assigneePaneId, null);
  assert.equal(app.launches[0].cliId, 'antigravity');
  assert.equal(app.launches[0].policy, 'workspace-write');
  const post = await until(() => app.store.listBoardPosts(started.result.run.id).find((p) => p.subject?.startsWith('Antigravity turn ended')));
  assert.ok(post, 'Coordinator hears about pending turn under the Antigravity label');
  void agyAgent;
});
