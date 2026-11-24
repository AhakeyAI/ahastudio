import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';

const [scenario, trace] = process.argv.slice(2);
const history = createInterface({ input: process.stdin, crlfDelay: Infinity });
const threadId = 'mock-thread-id';
let threadCwd = process.cwd();
let turnNumber = 0;
let turnId;
let approvalId;
let activeGoal = null;
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

// Streams every timeline-relevant notification kind; the command output splits a secret across deltas.
const richTimeline = () => {
  const item = (phase, value) => notify('item/' + phase, { turnId, item: value });
  item('started', { id: 'think', type: 'reasoning', summary: [], content: [] });
  notify('item/reasoning/summaryTextDelta', { turnId, itemId: 'think', delta: 'Inspecting the ' });
  notify('item/reasoning/summaryTextDelta', { turnId, itemId: 'think', delta: 'workspace' });
  item('completed', { id: 'think', type: 'reasoning', summary: [], content: [] });
  notify('turn/plan/updated', {
    turnId, explanation: 'Two steps',
    plan: [{ step: 'List files', status: 'completed' }, { step: 'Summarize', status: 'inProgress' }],
  });
  item('started', { id: 'cmd', type: 'commandExecution', command: 'Get-ChildItem', cwd: process.cwd(), status: 'inProgress' });
  notify('item/commandExecution/outputDelta', { turnId, itemId: 'cmd', delta: 'README.md\ntoken=pilot-stderr-' });
  notify('item/commandExecution/outputDelta', { turnId, itemId: 'cmd', delta: 'credential-example\n' });
  item('completed', { id: 'cmd', type: 'commandExecution', command: 'Get-ChildItem', cwd: process.cwd(), status: 'completed', exitCode: 0, durationMs: 120 });
  const changes = [{ path: 'src/demo.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1 +1,2 @@\n-old line\n+new line\n+extra line\n' }];
  item('started', { id: 'patch', type: 'fileChange', status: 'inProgress', changes: [] });
  notify('item/fileChange/patchUpdated', { turnId, itemId: 'patch', changes });
  item('completed', { id: 'patch', type: 'fileChange', status: 'completed', changes });
  item('started', { id: 'mcp', type: 'mcpToolCall', server: 'aha', tool: 'read_board', arguments: { limit: 5 }, status: 'inProgress' });
  notify('item/mcpToolCall/progress', { turnId, itemId: 'mcp', message: 'reading board' });
  item('completed', {
    id: 'mcp', type: 'mcpToolCall', server: 'aha', tool: 'read_board', arguments: { limit: 5 }, status: 'completed',
    result: { content: [{ type: 'text', text: 'board ok' }] }, durationMs: 15,
  });
  completed('completed', 'Rich **timeline** done');
};
for await (const line of history) {
  const { id, method, params, result } = JSON.parse(line);
  if (trace) appendFileSync(trace, JSON.stringify({ id, method, params, result }) + '\n');
  if (method === 'initialize') {
    send(scenario === 'initialize-error'
      ? { id, error: { code: -32602, message: 'mock initialization rejected' } }
      : { id, result: { userAgent: 'mock-codex' } });
  } else if (method === 'thread/start' || method === 'thread/resume') {
    if (method === 'thread/resume') assert.equal(params.threadId, threadId);
    if (typeof params.cwd === 'string' && params.cwd) threadCwd = params.cwd;
    const granted = scenario === 'sandbox-mismatch' ? 'workspace-write' : params.sandbox;
    send({ id, result: {
      thread: { id: threadId },
      sandbox: { type: granted === 'read-only' ? 'readOnly' : 'workspaceWrite' },
      approvalPolicy: params.approvalPolicy,
    } });
  } else if (method === 'mcpServerStatus/list') {
    assert.equal(params.threadId, threadId);
    assert.equal(params.serverName, 'aha');
    if (scenario === 'catalog-wait') await delay(250);
    send({ id, result: { data: [{ name: 'aha', tools: {
      report_done: { name: 'report_done' }, delegate_task: { name: 'delegate_task' },
    } }] } });
  } else if (method === 'model/list') {
    send({ id, result: { nextCursor: params.cursor ? null : 'page-2', data: params.cursor
      ? [{ id: 'mock-mini', model: 'mock-mini', displayName: 'Mock Mini', description: 'Small', hidden: false, isDefault: false,
        supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }], defaultReasoningEffort: 'low', inputModalities: ['text'] }]
      : [
        { id: 'mock-large', model: 'mock-large', displayName: 'Mock Large', description: 'Big', hidden: false, isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }, { reasoningEffort: 'high', description: 'Deep' }],
          defaultReasoningEffort: 'high', inputModalities: ['text', 'image'] },
        { id: 'mock-hidden', model: 'mock-hidden', displayName: 'Hidden', description: '', hidden: true, isDefault: false,
          supportedReasoningEfforts: [], defaultReasoningEffort: 'low', inputModalities: ['text'] },
      ] } });
  } else if (method === 'skills/list') {
    const root = params.cwds?.[0] ?? process.cwd();
    send({ id, result: { data: [{ cwd: root, errors: [], skills: [
      { name: 'mock-skill', description: 'Long description', interface: { shortDescription: 'Does mock things' },
        path: join(root, '.agents', 'skills', 'mock-skill', 'SKILL.md'), scope: 'repo', enabled: true, pluginId: null },
    ] }] } });
  } else if (method === 'skills/config/write' || method === 'plugin/installed' || method === 'fuzzyFileSearch'
    || method === 'thread/name/set') {
    send({ id, result: method === 'plugin/installed'
      ? { marketplaceLoadErrors: [], marketplaces: [{ name: 'mock-market', path: null, interface: null, plugins: [
        { id: 'docs@mock-market', name: 'docs', installed: true, enabled: true,
          interface: { displayName: 'Docs', shortDescription: 'Write docs', developerName: 'Mock', category: 'Productivity',
            capabilities: ['Write'], defaultPrompt: ['Draft a memo'] } },
        { id: 'other@mock-market', name: 'other', installed: false, enabled: false, interface: null },
      ] }] }
      : method === 'fuzzyFileSearch'
        ? { files: [{ root: params.roots[0], path: 'src\\demo.ts', match_type: 'file', file_name: 'demo.ts', score: 1, indices: null }] }
        : {} });
  } else if (method === 'account/rateLimits/read') {
    send({ id, result: { ordinaryUsageAllowed: true, rateLimitsByLimitId: null, rateLimitResetCredits: null, accountId: null, rateLimitUpsell: null,
      rateLimits: { limitId: 'codex', limitName: null, normalModelSlug: null, credits: null, individualLimit: null, spendControlReached: null,
        primary: { usedPercent: 37, windowDurationMins: 300, resetsAt: 1_700_000_000 }, secondary: null, planType: 'plus', rateLimitReachedType: null } } });
  } else if (method === 'thread/list') {
    const thread = (id, extra) => ({ id, cwd: params.cwd, createdAt: 1_700_000_000, updatedAt: 1_700_000_100, recencyAt: 1_700_000_200,
      ephemeral: false, parentThreadId: null, source: 'vscode', name: null, preview: '', model: 'mock-large', reasoningEffort: 'high', ...extra });
    send({ id, result: { nextCursor: params.cursor ? null : 'page-2', data: params.cursor ? [] : [
      thread(threadId, { name: 'Earlier talk', preview: 'Fix the bug\nin detail' }),
      thread('worker-thread', { preview: '[Worker @api] Implement the endpoint' }),
      thread('temp-thread', { preview: 'scratch', ephemeral: true }),
    ] } });
  } else if (method === 'thread/read') {
    send({ id, result: { thread: {
      id: params.threadId, cwd: threadCwd, name: 'Earlier talk', preview: 'Fix the bug', model: 'mock-large', reasoningEffort: 'high',
      turns: params.includeTurns ? [
        { id: 'old-turn-1', status: 'completed', startedAt: 1_700_000_000, completedAt: 1_700_000_010, error: null, items: [
          { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Fix the bug' }] },
          { id: 'a1', type: 'agentMessage', text: 'Fixed it', startedAtMs: 1_700_000_005_000, completedAtMs: 1_700_000_009_000 },
        ] },
        { id: 'old-turn-2', status: 'interrupted', startedAt: 1_700_000_020, completedAt: 1_700_000_030, error: null, items: [
          { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'Run the tests' }] },
          { id: 'c2', type: 'commandExecution', command: 'npm test', cwd: threadCwd, status: 'inProgress' },
        ] },
      ] : [],
    } } });
  } else if (method === 'thread/archive' || method === 'thread/unarchive') {
    send({ id, result: {} });
  } else if (method === 'thread/compact/start') {
    assert.equal(params.threadId, threadId);
    turnId = 'mock-compact-' + ++turnNumber;
    send({ id, result: {} });
    notify('turn/started', { turn: { id: turnId, status: 'inProgress' } });
    notify('item/started', { turnId, item: { id: 'compact-1', type: 'contextCompaction' } });
    notify('item/completed', { turnId, item: { id: 'compact-1', type: 'contextCompaction' } });
    notify('turn/completed', { turn: { id: turnId, status: 'completed', error: null, items: [] } });
  } else if (method === 'feedback/upload') {
    send({ id, result: { threadId: `fb_${params.threadId || threadId}`, promptHash: null } });
  } else if (method === 'thread/goal/get') {
    assert.equal(params.threadId, threadId);
    send({ id, result: { goal: activeGoal } });
  } else if (method === 'thread/goal/set') {
    assert.equal(params.threadId, threadId);
    const nowSec = Math.floor(Date.now() / 1000);
    activeGoal = {
      threadId,
      objective: params.objective ?? activeGoal?.objective ?? '',
      status: params.status ?? activeGoal?.status ?? 'active',
      tokenBudget: null,
      tokensUsed: activeGoal?.tokensUsed ?? 0,
      timeUsedSeconds: activeGoal?.timeUsedSeconds ?? 0,
      createdAt: activeGoal?.createdAt ?? nowSec,
      updatedAt: nowSec,
    };
    send({ id, result: { goal: activeGoal } });
    notify('thread/goal/updated', { goal: activeGoal });
  } else if (method === 'thread/goal/clear') {
    assert.equal(params.threadId, threadId);
    const cleared = activeGoal !== null;
    activeGoal = null;
    send({ id, result: { cleared } });
    if (cleared) notify('thread/goal/cleared', {});
  } else if (method === 'turn/start') {
    assert.equal(params.threadId, threadId);
    const prompt = params.input.find((item) => item.type === 'text')?.text ?? '';
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
    } else if (prompt.includes('RICH_TIMELINE')) {
      richTimeline();
    } else if (prompt.includes('ASK_FOR_MCP_CONFIRMATION')) {
      approvalId = 'mcp-approval-' + turnNumber;
      send({
        id: approvalId, method: 'mcpServer/elicitation/request',
        params: { threadId, turnId, serverName: 'aha', message: 'Approve tool call?',
          mode: 'form', requestedSchema: { type: 'object', properties: {} } },
      });
    } else if (prompt.includes('ASK_A_QUESTION')) {
      approvalId = 'question-' + turnNumber;
      send({
        id: approvalId, method: 'item/tool/requestUserInput',
        params: { threadId, turnId, itemId: 'ask', isBlocking: true, autoResolutionMs: null, questions: [{
          id: 'db', header: 'Database', question: 'Which database?', isOther: false,
          isSecret: prompt.includes('SECRET'),
          options: [{ label: 'SQLite', description: 'Local file' }, { label: 'Postgres', description: 'Server' }],
        }] },
      });
    } else if (prompt.includes('ASK_FOR_APPROVAL')) {
      approvalId = 'approval-' + turnNumber;
      send({
        id: approvalId, method: 'item/commandExecution/requestApproval',
        params: { threadId, turnId, command: 'Get-Location', availableDecisions: ['accept', 'decline'] },
      });
    } else if (prompt.includes('WRITE_FILE')) {
      const match = /WRITE_FILE:([^\s]+)/.exec(prompt);
      const target = basename(match?.[1] ?? 'worker-output.txt') || 'worker-output.txt';
      writeFileSync(join(threadCwd, target), `written by mock headless worker (${target})\n`, 'utf8');
      completed('completed', `Wrote ${target}`);
    } else {
      completed('completed', '模拟输出 ' + turnNumber);
    }
  } else if (method === 'turn/interrupt') {
    assert.equal(params.threadId, threadId);
    assert.equal(params.turnId, turnId);
    send({ id, result: {} });
    completed('interrupted', '');
  } else if (id === approvalId && result) {
    completed('completed', result.answers
      ? 'answer: ' + JSON.stringify(result.answers)
      : 'approval decision: ' + (result.decision ?? result.action));
  } else if (id === approvalId) {
    completed('completed', 'request refused');
  }
}
