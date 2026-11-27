import assert from 'node:assert/strict';
import test from 'node:test';
import { resolve, join, delimiter } from 'node:path';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { inspectCodexRuntime, missingHookExecutables, runtimeFailure } from '../dist-electron/orchestration/codex-runtime-diagnostics.js';
import { launchCodexPilot } from '../dist-electron/orchestration/codex-app-server-pilot.js';

const home = resolve('example-profile');
const options = { cli: '/example/codex', env: { HOME: home }, systemHome: home, verifyOfficial: () => true };
function fixture({ config = {}, result = { content: [{ type: 'text', text: 'private application list' }] }, pluginEnabled = true } = {}) {
  const calls = [];
  const connection = {
    async query(method, params) {
      calls.push({ method, params });
      if (method === 'config/read') return { config: { api_key: 'PRIVATE_SENTINEL', ...config } };
      if (method === 'plugin/installed') return { marketplaces: [{ name: 'test', plugins: [{ name: 'computer-use', installed: true, enabled: pluginEnabled }] }] };
      if (method === 'mcpServerStatus/list') return { data: [{ name: 'computer-use', serverInfo: { name: 'Computer Use' }, tools: { list_apps: { name: 'list_apps' } } }] };
      throw Error('Unexpected call');
    },
    async probeComputerUse() { calls.push({ method: 'probe' }); return result; },
    async close() { calls.push({ method: 'close' }); },
  };
  return { calls, launch: () => connection };
}

test('native configuration discovery delegates project cwd and trust to Codex, with no secret import', async () => {
  const f = fixture();
  const report = await inspectCodexRuntime(home, false, f.launch, options);
  assert.deepEqual(f.calls[0], { method: 'config/read', params: { cwd: home, includeLayers: true } });
  assert.equal(report.separateProfile, false);
  assert.equal(report.configFile, join(home, '.codex/config.toml'));
  assert.equal(JSON.stringify(report).includes('PRIVATE_SENTINEL'), false);
  assert.equal(report.findings.some(x => x.state === 'verified'), false);
  assert.equal(f.calls.some(x => x.method === 'probe'), false);
  assert.equal(f.calls.at(-1).method, 'close');
});

test('explicit tool profile remains separate; no fallback or copying global identity', async () => {
  const f = fixture({ pluginEnabled: false });
  const report = await inspectCodexRuntime(home, false, f.launch, { ...options, env: { HOME: home, CODEX_HOME: join(home, 'isolated-tools') } });
  assert.equal(report.separateProfile, true);
  assert.equal(report.findings.find(x => x.name === 'computer-use').state, 'not-enabled');
});

test('missing CLI is distinct and does not start diagnostics', async () => {
  const report = await inspectCodexRuntime(home, false, () => { throw Error('must not launch'); }, { ...options, cli: null });
  assert.equal(report.findings[0].state, 'not-installed');
});

test('tools/list success is insufficient; only a successful explicit read-only call is verified', async () => {
  const f = fixture({ config: { mcp_servers: { 'computer-use': { command: 'official-client' } } } });
  const report = await inspectCodexRuntime(home, true, f.launch, options);
  assert.equal(report.findings.at(-1).state, 'verified');
  assert.equal(f.calls.filter(x => x.method === 'probe').length, 1);
  assert.equal(JSON.stringify(report).includes('private application list'), false);
});

test('unknown service identity never receives the probe, even if its tools are named correctly', async () => {
  const f = fixture();
  const report = await inspectCodexRuntime(home, true, f.launch, { ...options, verifyOfficial: () => false });
  assert.equal(report.findings.at(-1).state, 'unverified');
  assert.equal(f.calls.some(x => x.method === 'probe'), false);
});

test('read-only service errors are classified without forwarding sensitive error text', async () => {
  for (const [message, state] of [['Sender process is not authenticated', 'authentication-required'], ['Screen Recording permission denied', 'permission-required'], ['runtime app is missing', 'dependency-missing'], ['Method not found -32601', 'host-unsupported']]) {
    const f = fixture({ result: { isError: true, content: [{ type: 'text', text: message + ' PRIVATE_SENTINEL' }] } });
    const report = await inspectCodexRuntime(home, true, f.launch, options);
    assert.equal(report.findings.at(-1).state, state);
    assert.equal(JSON.stringify(report).includes('PRIVATE_SENTINEL'), false);
    assert.equal(f.calls.at(-1).method, 'close');
  }
  assert.equal(runtimeFailure('hook exited with code 127').state, 'error');
});

test('hooks check literal quoted executable paths, never run shell syntax or infer from exit127', () => {
  const hooks = { PreToolUse: [{ hooks: [{ command: '"/Applications/Example App.app/Contents/MacOS/hook" --token secret' }, { command: 'echo ignored; /missing/second' }, { command: '"$VAR/hook"' }, { command: "'/missing/中文 hook' argument" }] }] };
  const checked = [];
  assert.equal(missingHookExecutables(hooks, path => { checked.push(path); return false; }), 2);
  assert.deepEqual(checked, ['/Applications/Example App.app/Contents/MacOS/hook', '/missing/中文 hook']);
});

test('native launch preserves identity and cwd while removing Electron process switches', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'aha-runtime-env-'));
  const trace = join(dir, 'environment.json');
  writeFileSync(join(dir, 'codex'), `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(trace)},JSON.stringify({cwd:process.cwd(),home:process.env.HOME,codexHome:process.env.CODEX_HOME,electron:process.env.ELECTRON_RUN_AS_NODE,asar:process.env.ELECTRON_NO_ASAR}));require('node:readline').createInterface({input:process.stdin}).on('line',s=>{const m=JSON.parse(s);if(m.id)console.log(JSON.stringify({id:m.id,result:{}}))});\n`, { mode: 0o700 });
  const keys = ['HOME', 'CODEX_HOME', 'PATH', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ASAR'];
  const before = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  Object.assign(process.env, { HOME: dir, CODEX_HOME: join(dir, 'tools'), PATH: dir + delimiter + process.env.PATH, ELECTRON_RUN_AS_NODE: '1', ELECTRON_NO_ASAR: '1' });
  let pilot;
  t.after(async () => {
    await pilot?.close();
    for (const key of keys) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key]; }
    rmSync(dir, { recursive: true, force: true });
  });
  pilot = launchCodexPilot({ cwd: dir, events: { onTurnStarted() {}, onTurnCompleted() {}, onExit() {}, onRequest: async () => ({ decision: 'decline' }) } });
  await pilot.query('config/read', { cwd: dir });
  const actual = JSON.parse(readFileSync(trace, 'utf8'));
  assert.equal(actual.home, dir);
  assert.equal(actual.codexHome, join(dir, 'tools'));
  assert.equal(actual.electron, undefined);
  assert.equal(actual.asar, undefined);
  // macOS may canonicalize /var to /private/var; compare the filesystem identity.
  assert.equal(actual.cwd.endsWith(dir.split(/[\\/]/).at(-1)), true);
});
