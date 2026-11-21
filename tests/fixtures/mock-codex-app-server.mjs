import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const [scenario, trace] = process.argv.slice(2);
const history = createInterface({ input: process.stdin, crlfDelay: Infinity });
const threadId = 'mock-thread-id';
let turnNumber = 0;
let turnId;
let approvalId;
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
const notify = (method, params) => send({ method, params: { threadId, ...params } });
const completed = (status, text) => {
  if (text) {
    notify('item/agentMessage/delta', { turnId, itemId: 'answer', delta: text });
    notify('item/completed', { turnId, item: { id: 'answer', type: 'agentMessage', text } });
  }
  notify('thread/tokenUsage/updated', {
    turnId, tokenUsage: {
      total: { inputTokens: 23 * turnNumber, outputTokens: 7 * turnNumber },
      last: { inputTokens: 11, outputTokens: 3 },
    },
  });
  notify('turn/completed', { turn: { id: turnId, status, error: null, items: [] } });
};

for await (const line of history) {
  const { id, method, params, result } = JSON.parse(line);
  if (trace) appendFileSync(trace, JSON.stringify({ id, method, params, result }) + '\n');
  if (method === 'initialize') {
    send(scenario === 'initialize-error'
      ? { id, error: { code: -32602, message: 'mock initialization rejected' } }
      : { id, result: { userAgent: 'mock-codex' } });
  } else if (method === 'thread/start') {
    assert.equal(params.sandbox, 'read-only');
    assert.equal(params.approvalPolicy, 'on-request');
    send({ id, result: { thread: { id: threadId }, sandbox: { type: 'readOnly' }, approvalPolicy: 'on-request' } });
  } else if (method === 'mcpServerStatus/list') {
    assert.equal(params.threadId, threadId);
    assert.equal(params.serverName, 'aha');
    if (scenario === 'catalog-wait') await delay(250);
    send({ id, result: { data: [{ name: 'aha', tools: { report_done: { name: 'report_done' } } }] } });
  } else if (method === 'turn/start') {
    assert.equal(params.threadId, threadId);
    assert.deepEqual(params.sandboxPolicy, { type: 'readOnly', networkAccess: false });
    assert.equal(params.approvalPolicy, 'on-request');
    const prompt = params.input[0].text;
    if (scenario === 'timeout') continue;
    if (scenario === 'rejected') {
      send({ id, error: { code: -32602, message: 'mock rejected turn before start' } });
      continue;
    }
    turnId = 'mock-turn-' + ++turnNumber;
    notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
    if (scenario === 'started-then-error') {
      send({ id, error: { code: -32603, message: 'mock error after start' } });
      continue;
    }
    if (scenario === 'disconnect') process.exit(17);
    send({ id, result: { turn: { id: turnId, status: 'inProgress' } } });
    if (prompt.includes('CRASH_LATER')) {
      notify('item/agentMessage/delta', { turnId, itemId: 'answer', delta: 'output before process crash' });
      setTimeout(() => process.exit(19), 120);
    } else if (prompt.includes('WAIT_FOR_INTERRUPT')) {
      notify('item/agentMessage/delta', { turnId, itemId: 'answer', delta: 'output before cancel' });
    } else if (prompt.includes('ASK_FOR_MCP_CONFIRMATION')) {
      approvalId = 'mcp-approval-' + turnNumber;
      send({
        id: approvalId, method: 'mcpServer/elicitation/request',
        params: { threadId, turnId, serverName: 'aha', message: 'Approve tool call?',
          mode: 'form', requestedSchema: { type: 'object', properties: {} } },
      });
    } else if (prompt.includes('ASK_FOR_APPROVAL')) {
      approvalId = 'approval-' + turnNumber;
      send({
        id: approvalId, method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, command: 'Get-Location', availableDecisions: ['accept', 'decline'] },
      });
    } else {
      completed('completed', '模拟输出 ' + turnNumber);
    }
  } else if (method === 'turn/interrupt') {
    assert.equal(params.threadId, threadId);
    assert.equal(params.turnId, turnId);
    send({ id, result: {} });
    completed('interrupted', '');
  } else if (id === approvalId && result) {
    completed('completed', 'approval decision: ' + (result.decision ?? result.action));
  }
}
