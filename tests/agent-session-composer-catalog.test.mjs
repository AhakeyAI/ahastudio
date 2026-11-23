import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { ipcMain } from 'electron';

import { registerAgentSessionsIpc } from '../dist-electron/ipc/agent-sessions.js';
import { AgentSessionManager } from '../dist-electron/orchestration/agent-session-manager.js';
import { CodexAppServerPilot } from '../dist-electron/orchestration/codex-app-server-pilot.js';
import { CodexCatalog } from '../dist-electron/orchestration/codex-catalog.js';

const cwd = process.cwd();
const NO_EVENTS = {
  onTurnStarted: () => {}, onTurnCompleted: () => {}, onExit: () => {}, onRequest: async () => ({ decision: 'decline' }),
};

function mockPilot(trace, events = NO_EVENTS, workdir = cwd) {
  return new CodexAppServerPilot(
    spawn(process.execPath, [join(cwd, 'tests/fixtures/mock-codex-app-server.mjs'), 'normal', trace], {
      cwd: workdir, stdio: 'pipe', windowsHide: true,
    }),
    events, 850, [], null,
  );
}

const readTrace = (trace, method) => {
  try {
    return readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse)
      .filter((message) => message.method === method).map((message) => message.params);
  } catch {
    return [];
  }
};

async function until(read, timeout = 4_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = read();
    if (value) return value;
    await delay(20);
  }
  assert.fail('Expected state did not appear');
}

test('the catalog lists visible models across pages, skills, installed plugins, and files from one quiet process', async (t) => {
  const dir = mkdtempSync(join(cwd, '.composer-catalog-test-'));
  const trace = join(dir, 'rpc.jsonl');
  let launches = 0;
  const catalog = new CodexCatalog(() => {
    launches++;
    return mockPilot(trace);
  }, 60_000);
  t.after(async () => {
    await catalog.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  const models = await catalog.listModels();
  assert.deepEqual(models.map((model) => model.id), ['mock-large', 'mock-mini'], 'hidden models are left out, pages are followed');
  assert.deepEqual(models[0].efforts.map((effort) => effort.value), ['low', 'high']);
  assert.equal(models[0].defaultEffort, 'high');
  assert.equal(models[0].images, true);
  assert.equal(models[1].images, false);
  await catalog.listModels();
  assert.equal(readTrace(trace, 'model/list').length, 2, 'models are cached after the first full listing');

  const skills = await catalog.listSkills(cwd);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].description, 'Does mock things', 'the short interface description is preferred');
  assert.ok(await catalog.findSkill(cwd, skills[0].path));
  assert.equal(await catalog.findSkill(cwd, join(cwd, 'not-a-skill', 'SKILL.md')), null);
  await catalog.setSkillEnabled(cwd, skills[0].path, false);
  assert.deepEqual(readTrace(trace, 'skills/config/write').at(-1), { path: skills[0].path, enabled: false });
  await assert.rejects(catalog.setSkillEnabled(cwd, join(cwd, 'x', 'SKILL.md'), true), /没有列出/);

  const plugins = await catalog.listPlugins(cwd);
  assert.deepEqual(plugins.map((plugin) => plugin.id), ['docs@mock-market'], 'only installed plugins are listed');
  assert.equal(plugins[0].displayName, 'Docs');
  assert.deepEqual(plugins[0].defaultPrompts, ['Draft a memo']);

  assert.deepEqual(await catalog.searchFiles(cwd, 'demo'), [{ path: 'src/demo.ts', fileName: 'demo.ts' }]);
  assert.equal(launches, 1, 'every query shares one app-server');
  assert.equal(readTrace(trace, 'initialize').length, 1, 'the process is initialized once');
  assert.equal(readTrace(trace, 'thread/start').length, 0, 'catalog queries never open a conversation');
});

test('the catalog closes its process after a quiet period and starts a new one when asked again', async (t) => {
  const dir = mkdtempSync(join(cwd, '.composer-catalog-test-'));
  const pilots = [];
  const catalog = new CodexCatalog(() => {
    const pilot = mockPilot(join(dir, `rpc-${pilots.length}.jsonl`));
    pilots.push(pilot);
    return pilot;
  }, 80);
  t.after(async () => {
    await catalog.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  await Promise.all([catalog.listModels(), catalog.searchFiles(cwd, 'demo')]);
  assert.equal(pilots.length, 1, 'concurrent queries share the process');
  await until(() => !pilots[0].alive);
  await catalog.searchFiles(cwd, 'demo');
  assert.equal(pilots.length, 2);
});

test('a pilot query only accepts catalog methods', async (t) => {
  const dir = mkdtempSync(join(cwd, '.composer-catalog-test-'));
  const pilot = mockPilot(join(dir, 'rpc.jsonl'));
  t.after(async () => {
    await pilot.close();
    rmSync(dir, { recursive: true, force: true });
  });
  await assert.rejects(pilot.query('thread/start', { cwd }), /not allowed/);
  await assert.rejects(pilot.query('config/value/write', {}), /not allowed/);
  assert.ok(await pilot.query('fuzzyFileSearch', { query: 'demo', roots: [cwd], cancellationToken: null }));
  assert.equal((await pilot.query('account/rateLimits/read', {})).rateLimits.primary.usedPercent, 37);
  await assert.rejects(pilot.query('account/rateLimitResetCredit/consume', {}), /not allowed/, 'spending a reset credit is not a query');
});

test('usage limits come from the Codex bucket, in milliseconds, and are read fresh each time', async (t) => {
  const window = (usedPercent, windowDurationMins, resetsAt) => ({ usedPercent, windowDurationMins, resetsAt });
  const replies = [
    {
      ordinaryUsageAllowed: true,
      rateLimits: { limitId: 'other', primary: window(99, 60, 1) },
      rateLimitsByLimitId: {
        codex: { limitId: 'codex', limitName: 'Codex', primary: window(37.5, 300, 1_700_000_000), secondary: window(120, 10080, null),
          planType: 'pro', rateLimitReachedType: null },
      },
    },
    { ordinaryUsageAllowed: null, rateLimits: { primary: window(100, 300, 1_700_000_000), secondary: { usedPercent: 'x' },
      planType: null, rateLimitReachedType: 'rate_limit_reached' }, rateLimitsByLimitId: null },
    { ordinaryUsageAllowed: false, rateLimits: { primary: null, secondary: null }, rateLimitsByLimitId: null },
  ];
  const calls = [];
  const catalog = new CodexCatalog(() => ({
    alive: true,
    query: async (method, params) => {
      calls.push([method, params]);
      return replies[calls.length - 1];
    },
    close: async () => {},
  }), 60_000);
  t.after(() => catalog.dispose());

  assert.deepEqual(await catalog.readRateLimits(), {
    name: 'Codex', planType: 'pro', reached: false,
    primary: { usedPercent: 37.5, windowMinutes: 300, resetsAt: 1_700_000_000_000 },
    secondary: { usedPercent: 100, windowMinutes: 10080, resetsAt: null },
  });
  assert.deepEqual(calls[0], ['account/rateLimits/read', { excludeResetCreditDetails: true }]);
  const legacy = await catalog.readRateLimits();
  assert.deepEqual([legacy.primary.usedPercent, legacy.secondary, legacy.reached], [100, null, true], 'older servers send one snapshot');
  assert.equal((await catalog.readRateLimits()).reached, true, 'blocked ordinary usage counts as reached');
  assert.equal(calls.length, 3);
});

function ipcSetup(t) {
  const dir = mkdtempSync(join(cwd, '.composer-ipc-test-'));
  const trace = join(dir, 'rpc.jsonl');
  const attachments = join(dir, 'attachments');
  const orphan = join(attachments, 'agent-session-00000000-0000-0000-0000-000000000000');
  mkdirSync(orphan, { recursive: true });
  writeFileSync(join(orphan, 'old.png'), 'x');
  const manager = new AgentSessionManager({ launch: (_id, workdir, events) => mockPilot(trace, events, workdir) });
  const catalog = new CodexCatalog(() => mockPilot(join(dir, 'catalog.jsonl')), 60_000);
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
  const contents = Object.assign(new EventEmitter(), { id: 7, send() {}, isDestroyed: () => false });
  const ipc = registerAgentSessionsIpc({
    liveWindow: () => ({ webContents: contents, isDestroyed: () => false }),
    getCurrentCwd: () => cwd,
  }, manager, { catalog, attachmentsDir: () => attachments });
  t.after(async () => {
    ipc.dispose();
    await manager.dispose();
    await catalog.dispose();
    rmSync(dir, { recursive: true, force: true });
  });
  const call = (name, payload) => handlers.get(`agent-sessions:${name}`)({ sender: { id: 7 } }, payload);
  return { manager, call, trace, attachments, orphan };
}

test('a message carries only listed skills and images saved for its session, and closing removes them', async (t) => {
  const { manager, call, trace, attachments, orphan } = ipcSetup(t);
  assert.equal(existsSync(orphan), false, 'images of sessions that no longer exist are removed at start');
  const created = await call('create', { cwd, policy: 'read-only' });
  assert.equal(created.ok, true);
  const id = created.session.id;
  const idle = () => manager.list().find((session) => session.id === id)?.status === 'idle';

  const { skills } = await call('skills', { id });
  const skill = { type: 'skill', name: skills[0].name, path: skills[0].path };
  const forged = await call('send', { id, text: 'use it', attachments: [{ type: 'skill', name: 'x', path: join(cwd, 'x', 'SKILL.md') }] });
  assert.equal(forged.ok, false, 'a skill Codex did not list is refused');
  assert.equal(readTrace(trace, 'turn/start').length, 0, 'nothing is sent for a refused message');

  const image = await call('attach-image', { id, name: 'shot.png', mime: 'image/png', data: Buffer.from('png-bytes').toString('base64') });
  assert.equal(image.ok, true);
  assert.ok(image.attachment.path.startsWith(join(attachments, id)), 'the image is saved in the session folder');
  assert.equal(readFileSync(image.attachment.path, 'utf8'), 'png-bytes');
  const outside = join(cwd, 'package.json');
  assert.equal((await call('send', { id, text: 'look', attachments: [{ type: 'localImage', path: outside }] })).ok, false,
    'an image path outside the session folder is refused');
  assert.equal((await call('attach-image', { id, name: 'a.svg', mime: 'image/svg+xml', data: 'eA==' })).ok, false);

  assert.equal((await call('send', { id, text: '  ', attachments: [] })).ok, false, 'an empty message is refused');
  const sent = await call('send', { id, text: 'Describe this', attachments: [skill, image.attachment] });
  assert.equal(sent.ok, true, sent.error);
  const input = readTrace(trace, 'turn/start').at(-1).input;
  assert.deepEqual(input, [
    { type: 'text', text: `Describe this\n\n[Attached image "shot.png" is saved at: ${image.attachment.path}]`, text_elements: [] },
    { type: 'skill', name: skill.name, path: skill.path },
    { type: 'localImage', path: image.attachment.path },
  ], 'the image is sent as an image and its saved path is named in the text');
  await until(idle);
  assert.deepEqual(manager.getTimeline(id).turns.at(-1).attachments, [
    { kind: 'skill', name: skill.name }, { kind: 'image', name: 'shot.png' },
  ]);

  // An attachment alone is a message too; the text is just the saved path.
  const only = await call('attach-image', { id, name: 'b.jpg', mime: 'image/jpeg', data: Buffer.from('jpg').toString('base64') });
  assert.equal((await call('send', { id, text: '', attachments: [only.attachment] })).ok, true);
  assert.deepEqual(readTrace(trace, 'turn/start').at(-1).input, [
    { type: 'text', text: `[Attached image "b.jpg" is saved at: ${only.attachment.path}]`, text_elements: [] },
    { type: 'localImage', path: only.attachment.path },
  ]);
  await until(idle);

  // Any other file keeps a safe version of its own name and reaches the agent only by path.
  const doc = await call('attach-file', { id, name: '../报告 "v2".md', data: Buffer.from('# notes').toString('base64') });
  assert.equal(doc.ok, true, doc.error);
  assert.equal(doc.attachment.name, '报告 _v2_.md', 'path parts and reserved characters are stripped from the name');
  assert.ok(doc.attachment.path.startsWith(join(attachments, id)));
  assert.equal(readFileSync(doc.attachment.path, 'utf8'), '# notes');
  assert.equal((await call('attach-file', { id, name: 'empty.txt', data: '' })).ok, false, 'an empty file is refused');
  assert.equal((await call('send', { id, text: 'read it', attachments: [doc.attachment] })).ok, true);
  assert.deepEqual(readTrace(trace, 'turn/start').at(-1).input, [
    { type: 'text', text: `read it\n\n[Attached file "报告 _v2_.md" is saved at: ${doc.attachment.path}]`, text_elements: [] },
  ]);
  await until(idle);
  assert.deepEqual(manager.getTimeline(id).turns.at(-1).attachments, [{ kind: 'file', name: '报告 _v2_.md' }]);
  assert.equal((await call('send', { id, text: 'x', attachments: [{ type: 'file', path: join(cwd, 'package.json') }] })).ok, false,
    'a file outside the session folder is refused');

  assert.deepEqual((await call('search-files', { id, query: 'demo' })).files, [{ path: 'src/demo.ts', fileName: 'demo.ts' }]);
  assert.deepEqual((await call('search-files', { id, query: '  ' })).files, []);
  assert.deepEqual((await call('plugins', { id })).plugins.map((plugin) => plugin.id), ['docs@mock-market']);
  assert.deepEqual((await call('models', {})).models.map((model) => model.id), ['mock-large', 'mock-mini']);

  assert.equal((await call('close', { id })).ok, true);
  assert.equal(existsSync(join(attachments, id)), false, 'closing a session removes its images');
  assert.deepEqual(readdirSync(attachments), []);
});
