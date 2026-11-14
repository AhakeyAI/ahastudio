import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import ts from 'typescript';

const dir = mkdtempSync(join(tmpdir(), 'aha-orch-ui-'));
test.after(() => rmSync(dir, { recursive: true, force: true }));

function emit(name, rewrite = (s) => s) {
  const source = readFileSync(new URL(`../src/lib/${name}.ts`, import.meta.url), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const file = join(dir, `${name}.mjs`);
  writeFileSync(file, rewrite(output));
  return pathToFileURL(file).href;
}

const viewUrl = emit('orchestration-view');
const clientUrl = emit('orchestration-client', (s) => s.replace("'./orchestration-view'", "'./orchestration-view.mjs'"));
const view = await import(viewUrl);

const iso = (n) => new Date(Date.UTC(2025, 0, 1, 0, 0, n)).toISOString();

function task(id, extra = {}) {
  return {
    id,
    runId: 'r1',
    spec: `spec ${id}`,
    taskTitle: '',
    displayName: '',
    deps: [],
    priority: 'normal',
    status: 'ready',
    worktreePath: null,
    createdAt: iso(Number(id.replace(/\D/g, '')) || 0),
    updatedAt: iso(0),
    latestDispatch: null,
    ...extra,
  };
}

function snapshot(extra = {}) {
  return { ...view.EMPTY_SNAPSHOT, ...extra };
}

test('pickRunId prefers explicit choice, then coordinator run, then UI binding, then newest active', () => {
  const runs = [
    { id: 'old', status: 'completed', createdAt: iso(1) },
    { id: 'a1', status: 'active', createdAt: iso(2) },
    { id: 'a2', status: 'active', createdAt: iso(3) },
  ];
  assert.equal(view.pickRunId(snapshot({ runs }), null), 'a2');
  assert.equal(view.pickRunId(snapshot({ runs, currentRunByConsumer: { coordinator: 'old' } }), null), 'old');
  assert.equal(
    view.pickRunId(snapshot({ runs, activeCoordinatorRun: { runId: 'a1' }, currentRunByConsumer: { coordinator: 'old' } }), null),
    'a1',
  );
  assert.equal(view.pickRunId(snapshot({ runs }), 'old'), 'old');
  assert.equal(view.pickRunId(snapshot({ runs }), 'deleted'), 'a2');
  assert.equal(view.pickRunId(snapshot(), null), null);
});

test('buildTaskRows layers the DAG, reports unmet and missing deps, and survives cycles', () => {
  const tasks = [
    task('t3', { deps: ['t2'], status: 'pending' }),
    task('t1', { status: 'completed' }),
    task('t2', { deps: ['t1', 'ghost'], status: 'ready' }),
    task('c1', { deps: ['c2'] }),
    task('c2', { deps: ['c1'] }),
  ];
  const rows = view.buildTaskRows(tasks, [
    { id: 'g1', taskId: 't3', status: 'pending' },
    { id: 'g2', taskId: 't3', status: 'resolved' },
  ]);
  const byId = Object.fromEntries(rows.map((row) => [row.task.id, row]));
  assert.equal(byId.t1.level, 0);
  assert.equal(byId.t2.level, 1);
  assert.equal(byId.t3.level, 2);
  assert.deepEqual(byId.t2.waitingOn, []);
  assert.deepEqual(byId.t2.missingDeps, ['ghost']);
  assert.deepEqual(byId.t3.waitingOn, ['t2']);
  assert.equal(byId.t3.pendingGates, 1);
  assert.ok(rows.findIndex((r) => r.task.id === 't1') < rows.findIndex((r) => r.task.id === 't3'));
  assert.equal(rows.length, 5);
});

test('attention and toasts only report newly pending gates, questions, and escalations', () => {
  const gate = { id: 'g1', taskId: 't1', runId: 'r1', status: 'pending', question: 'Ship?' };
  const question = { messageId: 'm1', runId: 'r1', status: 'pending', question: 'Which DB?', toHandle: 'run:r1' };
  const before = snapshot({ gates: [], questions: [] });
  const after = snapshot({
    gates: [gate, { ...gate, id: 'g0', status: 'resolved' }],
    questions: [question, { ...question, messageId: 'm2', runId: 'r2' }],
    messages: [
      { id: 'x1', runId: 'r1', seq: 1, type: 'escalation', priority: 'high', subject: 'Blocked', toHandle: 'run:r1' },
      { id: 'x2', runId: 'r1', seq: 2, type: 'status', priority: 'normal', subject: 'fine', toHandle: 'run:r1' },
    ],
  });
  assert.equal(view.attentionCount(after), 3);
  assert.equal(view.attentionItems(after, 'r1').questions.length, 1);
  const fresh = view.newAttention(before, after);
  assert.deepEqual(fresh.gates.map((g) => g.id), ['g1']);
  assert.equal(fresh.questions.length, 2);
  assert.deepEqual(view.newAttention(after, after), { gates: [], questions: [] });
  // The first load is not "new": no toast flood on startup.
  assert.deepEqual(view.newAttention(null, after), { gates: [], questions: [] });
  assert.deepEqual(view.newUrgentMessages(before, after).map((m) => m.id), ['x1']);
  assert.deepEqual(view.newUrgentMessages(null, after), []);
});

test('messagesForRun hides heartbeats and sorts newest first', () => {
  const messages = [
    { id: 'a', runId: 'r1', seq: 1, type: 'status', createdAt: iso(1) },
    { id: 'b', runId: 'r1', seq: 3, type: 'heartbeat', createdAt: iso(3) },
    { id: 'c', runId: 'r1', seq: 2, type: 'worker_done', createdAt: iso(2) },
    { id: 'd', runId: 'r2', seq: 4, type: 'status', createdAt: iso(4) },
  ];
  const s = snapshot({ messages });
  assert.deepEqual(view.messagesForRun(s, 'r1').map((m) => m.id), ['c', 'a']);
  assert.deepEqual(view.messagesForRun(s, 'r1', { includeHeartbeats: true, limit: 2 }).map((m) => m.id), ['b', 'c']);
});

test('spawned worker PTYs map to a renderer leaf and a launch target that re-attaches', () => {
  assert.equal(view.leafIdForSpawnedPty('local-orch-abc-123'), 'orch-abc-123');
  assert.equal(view.leafIdForSpawnedPty('shell-123'), null);
  assert.equal(view.leafIdForSpawnedPty('local-bad/id'), null);
  assert.deepEqual(view.workerWindowTarget('claude'), { localCliId: 'claude' });
  assert.deepEqual(view.workerWindowTarget('pwsh'), { localCliId: 'shell', shellId: 'pwsh' });
  assert.deepEqual(view.workerWindowTarget(undefined), { localCliId: 'shell', shellId: 'default' });
  assert.equal(view.taskTitle(task('t9', { spec: '\n  First line\nsecond' })), 'First line');
  assert.equal(view.taskTitle(task('t9', { taskTitle: 'Named' })), 'Named');
});

test('orchestration client keeps pushed snapshots over a slower initial fetch and buffers spawn events', async () => {
  let resolveFetch;
  let pushEvent;
  let pushSpawn;
  globalThis.window = {
    vibeMeet: {
      orchestration: {
        getSnapshot: () => new Promise((resolve) => (resolveFetch = resolve)),
        onEvent: (cb) => ((pushEvent = cb), () => {}),
        onPaneSpawned: (cb) => ((pushSpawn = cb), () => {}),
      },
    },
  };
  try {
    const { orchestrationClient } = await import(clientUrl);
    const changes = [];
    orchestrationClient.onChange((prev, next) => changes.push({ prev, next }));
    assert.equal(orchestrationClient.isLoaded(), false);

    const pushed = snapshot({ runs: [{ id: 'pushed', status: 'active', createdAt: iso(1) }] });
    pushEvent({ reason: 'run:created', updatedAt: iso(5), snapshot: pushed });
    resolveFetch({ ok: true, snapshot: snapshot() });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(orchestrationClient.getSnapshot(), pushed);
    assert.equal(changes.length, 1);
    assert.equal(changes[0].prev, null);

    pushSpawn({ ptyId: 'local-orch-1', runId: 'r', taskId: 't' });
    const seen = [];
    orchestrationClient.onPaneSpawned((event) => seen.push(event.ptyId));
    pushSpawn({ ptyId: 'local-orch-2', runId: 'r', taskId: 't' });
    assert.deepEqual(seen, ['local-orch-1', 'local-orch-2']);
  } finally {
    delete globalThis.window;
  }
});
