import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { dispatchOrchestrationHttpAction } from '../dist-electron/orchestration/orchestration-http-router.js';
import { OrchestrationError } from '../dist-electron/orchestration/orchestration-types.js';

function makeHarness() {
  const dir = mkdtempSync(join(tmpdir(), 'aha-p0-'));
  const file = join(dir, 'orchestration-state.json');
  const store = new OrchestrationStore({ resolveFile: () => file });
  const agentStatusStore = new AgentStatusStore();
  agentStatusStore.registerPane('coord', { agentId: 'claude' });
  const writes = [];
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      writes.push({ ptyId, data });
      return { ok: true };
    },
  });
  return {
    dir,
    file,
    store,
    writes,
    service,
    dispose: () => {
      service.dispose();
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

function expectCode(fn, code) {
  assert.throws(fn, (err) => err instanceof OrchestrationError && err.code === code);
}

async function expectRejects(promise, code) {
  await assert.rejects(promise, (err) => err instanceof OrchestrationError && err.code === code);
}

test('mutating HTTP actions return only after the snapshot is durable, and corrupt snapshots recover from .bak', async () => {
  const h = makeHarness();
  try {
    const signal = new AbortController().signal;
    const created = await dispatchOrchestrationHttpAction(
      h.service,
      'run-create',
      { id: 'run_durable', objective: 'Durability barrier' },
      { signal }
    );
    assert.equal(created.status, 200);

    // The response already implies a durable snapshot: no extra waiting or flushing here.
    const onDisk = JSON.parse(readFileSync(h.file, 'utf8'));
    assert.ok(onDisk.runs.some((r) => r.id === 'run_durable'));
    const backup = JSON.parse(readFileSync(`${h.file}.bak`, 'utf8'));
    assert.ok(backup.runs.some((r) => r.id === 'run_durable'));

    await dispatchOrchestrationHttpAction(
      h.service,
      'task-create',
      { id: 't_durable', runId: 'run_durable', spec: 'Persisted task' },
      { signal }
    );
    const afterTask = JSON.parse(readFileSync(h.file, 'utf8'));
    assert.ok(afterTask.tasks.some((t) => t.id === 't_durable'));
    h.store.flushSync();

    // A truncated primary must fall back to the backup instead of silently starting empty.
    writeFileSync(h.file, '{"version":1,"runs":', 'utf8');
    const recovered = new OrchestrationStore({ resolveFile: () => h.file });
    recovered.load();
    assert.ok(recovered.lastLoadRecovery);
    assert.ok(recovered.getRun('run_durable'));
    assert.ok(recovered.getTask('t_durable'));
    assert.ok(JSON.parse(readFileSync(h.file, 'utf8')).runs.some((r) => r.id === 'run_durable'));
    recovered.close();

    // When both copies are unreadable the state is not loaded and the primary is quarantined.
    writeFileSync(h.file, 'not json', 'utf8');
    writeFileSync(`${h.file}.bak`, 'also not json', 'utf8');
    const lost = new OrchestrationStore({ resolveFile: () => h.file });
    lost.load();
    assert.ok(lost.lastLoadRecovery);
    assert.equal(lost.getRun('run_durable'), undefined);
    assert.ok(readdirSync(h.dir).some((name) => name.includes('.corrupt-')));
    lost.close();
  } finally {
    h.dispose();
  }
});

test('workerDone/ask/heartbeat require identity and the per-dispatch capability', async () => {
  const h = makeHarness();
  try {
    h.service.runCreate({ id: 'run_cap', objective: 'Capability checks', from: 'coord', paneId: 'coord' });
    h.service.taskCreate({ id: 'ta', runId: 'run_cap', spec: 'Task A' });
    h.service.taskCreate({ id: 'tb', runId: 'run_cap', spec: 'Task B' });
    const a = await h.service.dispatchTask({ taskId: 'ta', to: 'w1', from: 'coord', inject: false });
    await h.service.dispatchTask({ taskId: 'tb', to: 'w2', from: 'coord', inject: false });
    const capability = h.store.getDispatchCapability(a.dispatch.id);
    assert.ok(capability);

    // Identity may no longer be defaulted to the assignee.
    expectCode(
      () => h.service.workerDone({ taskId: 'ta', dispatchId: a.dispatch.id, outcome: 'completed' }),
      'invalid_argument'
    );
    // A wrong or missing credential is rejected even with a plausible handle.
    expectCode(
      () =>
        h.service.workerDone({
          from: 'w1',
          taskId: 'ta',
          dispatchId: a.dispatch.id,
          outcome: 'completed',
          capability: 'wrong',
        }),
      'operation_rejected'
    );
    // Naming someone else's dispatch in ask is rejected, and so is a bad credential.
    await expectRejects(
      h.service.ask({ from: 'w2', dispatchId: a.dispatch.id, question: 'not yours' }),
      'operation_rejected'
    );
    await expectRejects(
      h.service.ask({
        from: 'w1',
        dispatchId: a.dispatch.id,
        question: 'bad credential',
        capability: 'nope',
      }),
      'operation_rejected'
    );
    const asked = await h.service.ask({
      from: 'w1',
      dispatchId: a.dispatch.id,
      question: 'legitimate question',
      capability,
    });
    assert.ok(asked.messageId);
    assert.equal(h.store.getQuestion(asked.messageId)?.status, 'pending');

    expectCode(
      () =>
        h.service.send({
          from: 'w1',
          to: 'run:run_cap',
          type: 'heartbeat',
          subject: 'hb',
          payload: { dispatchId: a.dispatch.id },
        }),
      'operation_rejected'
    );
    h.service.send({
      from: `dispatch:${a.dispatch.id}`,
      to: 'run:run_cap',
      type: 'heartbeat',
      subject: 'hb',
      payload: { dispatchId: a.dispatch.id },
      capability,
    });

    // The capability is never exposed through the UI snapshot (including audit message bodies).
    assert.equal(JSON.stringify(h.service.getSnapshot()).includes(capability), false);

    // The PTY receives the clear-text credential, while stored messages stay redacted.
    h.service.taskCreate({ id: 'tc', runId: 'run_cap', spec: 'Delivered task' });
    const delivered = await h.service.dispatchTask({ taskId: 'tc', to: 'coord', from: 'human' });
    const deliveredCapability = h.store.getDispatchCapability(delivered.dispatch.id);
    assert.ok(deliveredCapability);
    assert.ok(h.writes.some((w) => w.data.includes(deliveredCapability)));
    assert.equal(delivered.preamble.includes(deliveredCapability), false);
    assert.equal(JSON.stringify(h.service.getSnapshot()).includes(deliveredCapability), false);

    const done = h.service.workerDone({
      from: 'w1',
      taskId: 'ta',
      dispatchId: a.dispatch.id,
      outcome: 'completed',
      capability,
    });
    assert.equal(done.lifecycle.action, 'settled');
    assert.equal(done.task.status, 'completed');
  } finally {
    h.dispose();
  }
});

test('workers can only gate their own task and can never resolve a gate', async () => {
  const h = makeHarness();
  try {
    h.service.runCreate({ id: 'run_gate', objective: 'Gate ownership', from: 'coord', paneId: 'coord' });
    h.service.taskCreate({ id: 'ta', runId: 'run_gate', spec: 'Task A' });
    h.service.taskCreate({ id: 'tb', runId: 'run_gate', spec: 'Task B' });
    const a = await h.service.dispatchTask({ taskId: 'ta', to: 'w1', from: 'coord', inject: false });
    await h.service.dispatchTask({ taskId: 'tb', to: 'w2', from: 'coord', inject: false });

    expectCode(
      () => h.service.gateCreate({ taskId: 'tb', question: 'Not your task', from: 'w1' }),
      'operation_rejected'
    );

    const own = h.service.gateCreate({ taskId: 'ta', question: 'My own task', from: 'w1' });
    assert.equal(own.gate.status, 'pending');

    // Opening a gate settles that task's dispatch, so w1 no longer holds an active dispatch.
    // w2 is still an active worker on another task and must not resolve anyone's gate.
    expectCode(
      () => h.service.gateResolve({ id: own.gate.id, resolution: 'self approve', from: 'w2' }),
      'operation_rejected'
    );

    const resolved = h.service.gateResolve({ id: own.gate.id, resolution: 'approved', from: 'coord' });
    assert.equal(resolved.gate.status, 'resolved');

    // A human operator (no worker dispatch) may still gate any task.
    const human = h.service.gateCreate({ taskId: 'tb', question: 'Operator gate' });
    assert.equal(human.gate.status, 'pending');
    assert.equal(h.store.getTask('ta')?.status, 'ready');
  } finally {
    h.dispose();
  }
});
