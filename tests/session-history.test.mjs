import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

import { codexThreadSummary, codexThreadTimeline } from '../dist-electron/orchestration/codex-thread-history.js';
import { SESSION_WAKE_HEADER } from '../dist-electron/orchestration/coordinator-prompt.js';

const dir = mkdtempSync(join(tmpdir(), 'aha-session-history-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));
const source = readFileSync(new URL('../src/lib/session-history.ts', import.meta.url), 'utf8');
const file = join(dir, 'session-history.mjs');
writeFileSync(file, ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText);
const lib = await import(pathToFileURL(file).href);

const base = { id: 't1', cwd: 'C:/repo', createdAt: 100, updatedAt: 200, recencyAt: 300, ephemeral: false, parentThreadId: null, source: 'vscode' };

test('a thread summary is titled by its name or first line, in milliseconds, and skips Worker and helper threads', () => {
  assert.deepEqual(codexThreadSummary({ ...base, name: null, preview: '\n  Fix login  \nmore', model: 'm', reasoningEffort: 'low' }), {
    id: 't1', title: 'Fix login', preview: 'Fix login', cwd: 'C:/repo', createdAt: 100_000, updatedAt: 300_000, model: 'm', effort: 'low',
  });
  assert.equal(codexThreadSummary({ ...base, name: 'Named', preview: 'x' }).title, 'Named');
  assert.equal(codexThreadSummary({ ...base, recencyAt: null, preview: 'x' }).updatedAt, 200_000);
  assert.equal(codexThreadSummary({ ...base, preview: '' }).title, '未命名会话');
  assert.equal(codexThreadSummary({ ...base, preview: '[Worker @api] do it' }), null);
  assert.equal(codexThreadSummary({ ...base, preview: 'x', ephemeral: true }), null);
  assert.equal(codexThreadSummary({ ...base, preview: 'x', parentThreadId: 'p' }), null);
  assert.equal(codexThreadSummary({ ...base, preview: 'x', source: { subagent: 'review' } }), null);
  assert.equal(codexThreadSummary({ preview: 'x' }), null);
});

test('a stored thread replays as finished turns, with later messages and system wake-ups kept apart', () => {
  const snapshot = codexThreadTimeline('agent-session-x', {
    id: 'thread-9',
    turns: [
      { id: 'turn-1', status: 'completed', startedAt: 10, completedAt: 20, items: [
        { id: 'u', type: 'userMessage', content: [{ type: 'text', text: 'Hello' }, { type: 'skill', name: 'pdf', path: 'p' }] },
        { id: 'u2', type: 'userMessage', content: [{ type: 'text', text: 'Also this' }] },
        { id: 'a', type: 'agentMessage', text: 'Hi', startedAtMs: 12_000, completedAtMs: 13_000 },
      ] },
      { id: 'turn-2', status: 'failed', startedAt: 30, completedAt: 40, error: { message: 'boom' }, items: [
        { id: 'w', type: 'userMessage', content: [{ type: 'text', text: `${SESSION_WAKE_HEADER}\n\nnews` }] },
      ] },
    ],
  }, { model: 'm', readOnly: false });
  assert.equal(snapshot.providerSessionId, 'thread-9');
  assert.equal(snapshot.alive, false);
  const [first, second] = snapshot.turns;
  assert.equal(first.prompt, 'Hello');
  assert.deepEqual(first.attachments, [{ kind: 'skill', name: 'pdf' }]);
  assert.equal(first.startedAt, 10_000);
  assert.equal(first.completedAt, 20_000);
  assert.deepEqual(first.items.map((item) => [item.kind, item.role ?? null, item.text]), [['message', 'user', 'Also this'], ['message', 'assistant', 'Hi']]);
  assert.equal(second.origin, 'system');
  assert.equal(second.status, 'failed');
  assert.equal(second.error, 'boom');
  assert.deepEqual(snapshot.turns.map((turn) => turn.dispatchId), ['agent-session-x:1', 'agent-session-x:2']);
});

test('history rows group into today, yesterday, and earlier and show short times', () => {
  const now = new Date(2025, 5, 10, 15, 0).getTime();
  const at = (day, hour, minute = 0) => new Date(2025, 5, day, hour, minute).getTime();
  const thread = (id, updatedAt) => ({ id, title: id, preview: '', cwd: 'C:/r', createdAt: updatedAt, updatedAt, model: null, effort: null });
  const groups = lib.groupThreadsByDay([thread('a', at(10, 9)), thread('b', at(9, 23)), thread('c', at(2, 8))], now);
  assert.deepEqual(groups.map((group) => [group.label, group.threads.map((t) => t.id)]), [['今天', ['a']], ['昨天', ['b']], ['更早', ['c']]]);
  assert.deepEqual(lib.groupThreadsByDay([thread('c', at(2, 8))], now).map((group) => group.label), ['更早']);
  assert.equal(lib.formatThreadTime(at(10, 9, 5), now), '09:05');
  assert.equal(lib.formatThreadTime(at(9, 18, 3), now), '昨天 18:03');
  assert.equal(lib.formatThreadTime(at(2, 8), now), '6月2日');
  assert.equal(lib.formatThreadTime(new Date(2024, 11, 31).getTime(), now), '2024/12/31');
  assert.deepEqual(lib.mergeThreadPages([thread('a', 1), thread('b', 2)], [thread('b', 2), thread('c', 3)]).map((t) => t.id), ['a', 'b', 'c']);
});
