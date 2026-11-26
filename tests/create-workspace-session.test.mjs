import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('../src/lib/create-workspace-session.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const load = new Function('agentSessionClient', 'stageWindowStore', compiled
  .replace(/^import .*;$/gm, '')
  .replace('export async function', 'async function') + '\nreturn createWorkspaceSession;');

function fixture(create = async (opts) => ({ ok: true, session: { id: 'session-b', cwd: opts.cwd } })) {
  const windows = [], sessions = [], errors = [];
  const run = load({ create: async (opts) => { sessions.push(opts); return create(opts); } }, {
    createWindow: async (type, opts) => { windows.push({ type, ...opts }); },
  });
  return { windows, sessions, errors, run: (type, opts, cwd) => run(type, opts, cwd, (error) => errors.push(error)) };
}

test('Shell and Agent CLI selections retain the clicked project, overriding the menu default cwd', async () => {
  const f = fixture();
  for (const opts of [
    { localCliId: 'shell', shellId: 'zsh', title: 'Zsh' },
    { localCliId: 'codex', title: 'Codex' },
    { localCliId: 'claude', title: 'Claude Code' },
  ]) {
    await f.run('terminal', { ...opts, cwd: '/home/default' }, '/projects/b');
    assert.deepEqual(f.windows.at(-1), { type: 'terminal', ...opts, cwd: '/projects/b' });
  }
  assert.equal(f.sessions.length, 0);
});

test('all desktop session providers receive the clicked project and keep their returned session cwd', async () => {
  const f = fixture(async () => ({ ok: true, session: { id: 'session-b', cwd: '/canonical/projects/b' } }));
  for (const provider of ['codex', 'antigravity', 'grok', 'opencode', 'pi']) {
    await f.run('agent-session', { localCliId: provider, cwd: '/home/default', title: provider }, '/projects/b');
    assert.deepEqual(f.sessions.at(-1), { cwd: '/projects/b', provider, policy: 'workspace-write' });
    assert.deepEqual(f.windows.at(-1), {
      type: 'agent-session', localCliId: provider, title: provider,
      cwd: '/canonical/projects/b', workerId: 'session-b',
    });
  }
});

test('an in-flight session keeps its original target when another project is selected', async () => {
  let finish;
  const f = fixture((opts) => new Promise((resolve) => { finish = () => resolve({ ok: true, session: { id: 'b', cwd: opts.cwd } }); }));
  const pending = f.run('agent-session', { localCliId: 'codex' }, '/projects/b');
  await f.run('terminal', { localCliId: 'shell' }, '/projects/a');
  finish();
  await pending;
  assert.equal(f.windows.at(-1).cwd, '/projects/b');
});

test('without a project the Tab menu default is preserved; session failures report errors without creating a tab', async () => {
  const f = fixture(async () => ({ ok: false, error: 'unavailable' }));
  await f.run('terminal', { cwd: '/home/default' });
  assert.equal(f.windows[0].cwd, '/home/default');
  await f.run('agent-session', { localCliId: 'codex' }, '/projects/b');
  assert.deepEqual(f.errors, ['unavailable']);
  assert.equal(f.windows.length, 1);
  const rejected = fixture(async () => { throw new Error('disconnected'); });
  await rejected.run('agent-session', {}, '/projects/b');
  assert.deepEqual(rejected.errors, ['disconnected']);
  assert.equal(rejected.windows.length, 0);
});
