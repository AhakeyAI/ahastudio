import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { OrchestrationStore } from '../dist-electron/orchestration/orchestration-store.js';
import { OrchestrationService } from '../dist-electron/orchestration/orchestration-service.js';
import {
  INLINE_SPEC_MAX_BYTES,
  buildDispatchPreamble,
} from '../dist-electron/orchestration/worker-dispatch-preamble.js';

const require = createRequire(import.meta.url);
const cli = require('../dist-electron/orchestration/aha-orchestration-cli.cjs');

function harness(extra = {}) {
  const agentStatusStore = new AgentStatusStore();
  const store = new OrchestrationStore();
  const writes = [];
  const spawned = [];
  const service = new OrchestrationService({
    store,
    agentStatusStore,
    writePty: async (ptyId, data) => {
      writes.push({ ptyId, data });
      return { ok: true };
    },
    spawnWorkerPty: async ({ cliId, cwd }) => {
      const ptyId = `spawned-${spawned.length + 1}`;
      spawned.push({ ptyId, cliId, cwd });
      agentStatusStore.registerPane(ptyId, { agentId: cliId ?? null });
      return { ptyId, cwd };
    },
    ...extra,
  });
  return { agentStatusStore, store, service, writes, spawned };
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('coordinator never dispatches into plain shells and honours an explicit worker pool', async () => {
  const { agentStatusStore, service, store } = harness();
  agentStatusStore.registerPane('user-shell', { agentId: null });
  agentStatusStore.registerPane('user-claude', { agentId: 'claude' });
  agentStatusStore.registerPane('pool-codex', { agentId: 'codex' });
  try {
    const { run } = service.runCreate({ id: 'run_pool', objective: 'Pool' });
    service.taskCreate({ id: 't1', runId: run.id, spec: 'one' });
    service.taskCreate({ id: 't2', runId: run.id, spec: 'two' });

    await service.coordinatorTick(run.id, { workerPaneIds: ['pool-codex'] });
    const assignees = store
      .listDispatches()
      .filter((d) => d.runId === run.id)
      .map((d) => d.assigneePaneId);
    assert.deepEqual(assignees, ['pool-codex']);

    // Without a pool, any idle agent pane qualifies, but still never the shell.
    await service.coordinatorTick(run.id);
    const all = store.listDispatches().map((d) => d.assigneePaneId).sort();
    assert.deepEqual(all, ['pool-codex', 'user-claude']);
  } finally {
    service.dispose();
  }
});

test('mailbox notices are not typed into panes without a detected agent', async () => {
  const { agentStatusStore, service, writes } = harness();
  agentStatusStore.registerPane('plain-shell', { agentId: null });
  agentStatusStore.registerPane('agent-pane', { agentId: 'claude' });
  try {
    service.send({ from: 'coordinator', to: 'plain-shell', subject: 'hello', body: 'x' });
    service.send({ from: 'coordinator', to: '@all', subject: 'broadcast', body: 'y' });
    await delay(250);
    assert.equal(writes.filter((w) => w.ptyId === 'plain-shell').length, 0);
    assert.ok(writes.some((w) => w.ptyId === 'agent-pane'));
  } finally {
    service.dispose();
  }
});

test('coordinatorStart reuses the caller bound run and validates auto-spawn CLI', () => {
  const { service } = harness({ isAgentCliId: (id) => ['claude', 'codex'].includes(id) });
  try {
    const { run } = service.runCreate({ id: 'run_bound', objective: 'Bound run' });
    service.taskCreate({ id: 'tb', runId: run.id, spec: 'work' });

    assert.throws(
      () => service.coordinatorStart({ autoSpawnWorkers: true }),
      (error) => error.code === 'invalid_argument' && /workerCliId/.test(error.message),
    );
    assert.throws(
      () => service.coordinatorStart({ autoSpawnWorkers: true, workerCliId: 'pwsh' }),
      (error) => error.code === 'invalid_argument' && /shell/.test(error.message),
    );

    const started = service.coordinatorStart({ pollIntervalMs: 50 });
    assert.equal(started.runId, 'run_bound');
    service.coordinatorStop();
  } finally {
    service.dispose();
  }
});

test('auto-spawned workers stay eligible even with an empty explicit pool', async () => {
  const { service, store, spawned } = harness();
  try {
    const { run } = service.runCreate({ id: 'run_spawn', objective: 'Spawn' });
    service.taskCreate({ id: 'ts', runId: run.id, spec: 'spawn me' });
    service.coordinatorStart({
      runId: run.id,
      pollIntervalMs: 50,
      autoSpawnWorkers: true,
      workerCliId: 'claude',
      workerPaneIds: [],
    });
    for (let i = 0; i < 40 && !store.getLatestDispatchForTask('ts'); i += 1) await delay(25);
    assert.equal(spawned.length, 1);
    assert.equal(spawned[0].cliId, 'claude');
    assert.equal(store.getLatestDispatchForTask('ts')?.assigneePaneId, spawned[0].ptyId);
    service.coordinatorStop();
  } finally {
    service.dispose();
  }
});

test('long task specs are clipped in the dispatch preamble with a pointer to task-show', () => {
  const spec = '需求'.repeat(5_000);
  const preamble = buildDispatchPreamble({
    taskId: 'task_long',
    dispatchId: 'ctx_1',
    taskSpec: spec,
    coordinatorHandle: 'run:r',
    workerHandle: 'w',
  });
  assert.ok(Buffer.byteLength(preamble, 'utf8') < 8_192);
  assert.match(preamble, /task-show --id task_long/);
  const short = buildDispatchPreamble({
    taskId: 'task_short',
    dispatchId: 'ctx_2',
    taskSpec: 'small spec',
    coordinatorHandle: 'run:r',
    workerHandle: 'w',
  });
  assert.match(short, /small spec/);
  assert.doesNotMatch(short, /truncated/);
  assert.ok(INLINE_SPEC_MAX_BYTES < 8_192);
});

test('CLI rejects value flags without a value instead of sending "true"', () => {
  assert.throws(() => cli.parseCliArgs(['send', '--to', '--subject', 'x']), /Missing value for --to/);
  assert.throws(() => cli.parseCliArgs(['send', '--subject']), /Missing value for --subject/);
  const ok = cli.parseCliArgs(['send', '--to', '@all', '--subject', 'x', '--wait']);
  assert.equal(ok.flags.to, '@all');
  assert.equal(ok.flags.wait, true);
});

test('hook server publishes its live endpoint and the CLI prefers it over stale env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-endpoint-'));
  const file = join(dir, 'agent-hook-endpoint.json');
  const server = new AgentHookServer(new AgentStatusStore());
  server.setEndpointFile(file);
  const saved = { ...process.env };
  try {
    const { port, token } = await server.start();
    const data = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(data.port, port);
    assert.equal(data.token, token);
    assert.equal(server.envForPane('p1').AHA_AGENT_HOOK_ENDPOINT_FILE, file);

    process.env.AHA_ORCHESTRATION_URL = 'http://127.0.0.1:1/orchestration';
    process.env.AHA_AGENT_HOOK_TOKEN = 'stale';
    process.env.AHA_AGENT_HOOK_ENDPOINT_FILE = file;
    assert.deepEqual(cli.resolveEndpoint(), {
      baseUrl: `http://127.0.0.1:${port}/orchestration`,
      token,
    });

    // A corrupt file falls back to the env values.
    writeFileSync(file, 'not json');
    assert.deepEqual(cli.resolveEndpoint(), {
      baseUrl: 'http://127.0.0.1:1/orchestration',
      token: 'stale',
    });

    await server.stop();
    assert.equal(existsSync(file), false);
  } finally {
    for (const key of ['AHA_ORCHESTRATION_URL', 'AHA_AGENT_HOOK_TOKEN', 'AHA_AGENT_HOOK_ENDPOINT_FILE']) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    await server.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
