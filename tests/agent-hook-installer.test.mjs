import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentHookInstaller, RELAY_FILE_NAME } from '../dist-electron/agent/agent-hook-installer.js';
import { AgentStatusStore } from '../dist-electron/agent/agent-status-store.js';
import { AgentHookServer } from '../dist-electron/agent/agent-hook-server.js';
import { registerAgentHooksIpc } from '../dist-electron/ipc/agent-hooks.js';
import { ipcMain } from 'electron';

const RELAY_SOURCE = join(process.cwd(), 'dist-electron', 'agent', 'agent-hook-relay.cjs');

function makeHome(t) {
  const home = mkdtempSync(join(tmpdir(), 'aha-hooks-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const installer = new AgentHookInstaller({ homeDir: home, env: {}, relaySourcePath: RELAY_SOURCE });
  return { home, installer };
}

function writeFile(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function runRelay(args, { env = {}, stdin, shellCommand, keepStdinOpen = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = shellCommand
      ? spawn(shellCommand, { shell: true, env: { ...process.env, ...env } })
      : spawn(process.execPath, args, { env: { ...process.env, ...env } });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout }));
    if (stdin !== undefined) {
      if (keepStdinOpen) child.stdin.write(stdin);
      else child.stdin.end(stdin);
    } else if (!keepStdinOpen) {
      child.stdin.end();
    }
  });
}

test('Claude hooks install next to user hooks, are idempotent, and uninstall restores the original settings', (t) => {
  const { home, installer } = makeHome(t);
  const path = join(home, '.claude', 'settings.json');
  const original = {
    model: 'opus',
    permissions: { allow: ['Bash(ls:*)'] },
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo user-hook' }] }],
    },
  };
  writeFile(path, JSON.stringify(original, null, 2));
  assert.equal(installer.status('claude').state, 'not-installed');

  const status = installer.install('claude');
  assert.equal(status.state, 'installed');
  assert.ok(existsSync(installer.relayPath), 'relay script copied');
  assert.ok(existsSync(`${path}.ahastation.bak`), 'original backed up');

  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.model, 'opus');
  assert.deepEqual(after.permissions, original.permissions);
  assert.deepEqual(after.hooks.PreToolUse[0], original.hooks.PreToolUse[0], 'user hook kept first');
  for (const event of ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop']) {
    const ours = after.hooks[event].flatMap((g) => g.hooks).filter((h) => h.command.includes(RELAY_FILE_NAME));
    assert.equal(ours.length, 1, `${event} has exactly one AhaStation hook`);
    assert.equal(ours[0].timeout, 5);
    assert.match(ours[0].command, /^node ".+aha-agent-hook\.cjs" claude$/);
    assert.ok(!ours[0].command.includes('\\'), 'forward slashes only');
  }

  const once = readFileSync(path, 'utf8');
  installer.install('claude');
  assert.equal(readFileSync(path, 'utf8'), once, 'second install is a no-op');

  assert.equal(installer.uninstall('claude').state, 'not-installed');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), original);
});

test('Claude install creates settings when missing; uninstall drops an empty hooks key', (t) => {
  const { home, installer } = makeHome(t);
  const path = join(home, '.claude', 'settings.json');
  assert.equal(installer.status('claude').configExists, false);
  assert.equal(installer.install('claude').state, 'installed');
  installer.uninstall('claude');
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), {});
});

test('CLAUDE_CONFIG_DIR, CODEX_HOME, and GROK_HOME overrides are respected', (t) => {
  const { home } = makeHome(t);
  const installer = new AgentHookInstaller({
    homeDir: home,
    env: { CLAUDE_CONFIG_DIR: join(home, 'cc'), CODEX_HOME: join(home, 'cx'), GROK_HOME: join(home, 'gk') },
    relaySourcePath: RELAY_SOURCE,
  });
  assert.equal(installer.configPath('claude'), join(home, 'cc', 'settings.json'));
  assert.equal(installer.configPath('codex'), join(home, 'cx', 'config.toml'));
  assert.equal(installer.configPath('grok'), join(home, 'gk', 'hooks', 'ahastation-agent-status.json'));
});

test('Grok Build installs drop-in hooks file preserving user hook files and removes empty file on uninstall', (t) => {
  const { home, installer } = makeHome(t);
  const userHookFile = join(home, '.grok', 'hooks', 'user-hooks.json');
  const grokPath = installer.configPath('grok');
  const userHooks = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
  writeFile(userHookFile, JSON.stringify(userHooks, null, 2));
  assert.equal(installer.status('grok').state, 'not-installed');

  assert.equal(installer.install('grok').state, 'installed');
  assert.equal(existsSync(grokPath), true);
  const installed = JSON.parse(readFileSync(grokPath, 'utf8'));
  for (const event of ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopCancelled', 'StopFailure', 'SessionEnd', 'Notification']) {
    assert.equal(installed.hooks[event].length, 1);
    assert.equal(installed.hooks[event][0].matcher, undefined);
    assert.equal(installed.hooks[event][0].hooks[0].timeout, 5);
    assert.match(installed.hooks[event][0].hooks[0].command, / grok$/);
  }
  for (const event of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    assert.equal(installed.hooks[event].length, 1);
    assert.equal(installed.hooks[event][0].matcher, '.*');
    assert.equal(installed.hooks[event][0].hooks[0].timeout, 5);
    assert.match(installed.hooks[event][0].hooks[0].command, / grok$/);
  }

  const once = readFileSync(grokPath, 'utf8');
  installer.install('grok');
  assert.equal(readFileSync(grokPath, 'utf8'), once, 'second install is a no-op');

  // Outdated tool matcher is detected and repaired cleanly on reinstall.
  installed.hooks.PreToolUse[0].matcher = 'Bash';
  writeFile(grokPath, JSON.stringify(installed, null, 2));
  assert.equal(installer.status('grok').state, 'outdated');
  assert.equal(installer.install('grok').state, 'installed');

  assert.equal(installer.uninstall('grok').state, 'not-installed');
  assert.equal(existsSync(grokPath), false, 'empty drop-in hook file removed on uninstall');
  assert.deepEqual(JSON.parse(readFileSync(userHookFile, 'utf8')), userHooks, 'unrelated user hook files preserved');
});

test('Antigravity installs bundle into hooks.json preserving sibling bundles and Qwen uses seconds with named hooks', (t) => {
  const { home, installer } = makeHome(t);
  const antigravityPath = join(home, '.gemini', 'config', 'hooks.json');
  const sibling = {
    'orca-status': {
      Stop: [{ type: 'command', command: 'orca-stop.cmd', timeout: 10 }],
    },
  };
  writeFile(antigravityPath, JSON.stringify(sibling, null, 2));
  assert.equal(installer.status('antigravity').state, 'not-installed');

  assert.equal(installer.install('antigravity').state, 'installed');
  installer.install('qwen');
  const hooksJson = JSON.parse(readFileSync(antigravityPath, 'utf8'));
  const qwen = JSON.parse(readFileSync(join(home, '.qwen', 'settings.json'), 'utf8'));
  assert.deepEqual(hooksJson['orca-status'], sibling['orca-status'], 'preserves unrelated bundles');
  const bundle = hooksJson['ahastation-agent-status'];
  assert.deepEqual(Object.keys(bundle).sort(), ['PostInvocation', 'PostToolUse', 'PreInvocation', 'PreToolUse', 'Stop']);
  for (const event of ['PreInvocation', 'PostInvocation', 'Stop']) {
    assert.equal(bundle[event].length, 1);
    assert.equal(bundle[event][0].timeout, 10);
    assert.match(bundle[event][0].command, new RegExp(` antigravity ${event}$`));
  }
  for (const event of ['PreToolUse', 'PostToolUse']) {
    assert.equal(bundle[event].length, 1);
    assert.equal(bundle[event][0].matcher, '*');
    assert.equal(bundle[event][0].hooks[0].timeout, 10);
    assert.match(bundle[event][0].hooks[0].command, new RegExp(` antigravity ${event}$`));
  }

  const once = readFileSync(antigravityPath, 'utf8');
  installer.install('antigravity');
  assert.equal(readFileSync(antigravityPath, 'utf8'), once, 'second install is a no-op');

  assert.equal(qwen.hooks.PermissionRequest[0].hooks[0].timeout, 5);
  assert.equal(qwen.hooks.PermissionRequest[0].hooks[0].name, 'ahastation-agent-status');
  assert.equal(installer.status('qwen').state, 'installed');

  assert.equal(installer.uninstall('antigravity').state, 'not-installed');
  assert.deepEqual(JSON.parse(readFileSync(antigravityPath, 'utf8')), sibling);
});

test('Settings with comments are reported as errors and never rewritten', (t) => {
  const { home, installer } = makeHome(t);
  const path = join(home, '.gemini', 'config', 'hooks.json');
  const raw = '{\n  // theme\n  "theme": "dark"\n}\n';
  writeFile(path, raw);
  assert.equal(installer.status('antigravity').state, 'error');
  assert.throws(() => installer.install('antigravity'), /不是标准 JSON/);
  assert.equal(readFileSync(path, 'utf8'), raw);
});

test('Hooks pointing at an older relay location are reported outdated and fixed by reinstall', (t) => {
  const { home, installer } = makeHome(t);
  const path = join(home, '.claude', 'settings.json');
  writeFile(path, JSON.stringify({
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node "/old/aha-agent-hook.cjs" claude' }] }] },
  }));
  assert.equal(installer.status('claude').state, 'outdated');
  installer.install('claude');
  const after = JSON.parse(readFileSync(path, 'utf8'));
  assert.equal(after.hooks.Stop.length, 1, 'stale entry replaced, not duplicated');
  assert.equal(installer.status('claude').state, 'installed');
});

test('Codex notify is added at top level, keeps CRLF and tables, and uninstall restores the exact file', (t) => {
  const { home, installer } = makeHome(t);
  const path = join(home, '.codex', 'config.toml');
  const original = '# my config\r\nmodel = "gpt-5"\r\n\r\n[mcp_servers.demo]\r\ncommand = "npx"\r\nnotify = "not-top-level"\r\n';
  writeFile(path, original);
  assert.equal(installer.status('codex').state, 'not-installed');
  assert.equal(installer.install('codex').state, 'installed');
  const text = readFileSync(path, 'utf8');
  const first = text.split('\r\n')[0];
  assert.match(first, /^notify = \["node", ".+aha-agent-hook\.cjs", "codex"\] # managed by AhaStation/);
  assert.ok(text.endsWith('command = "npx"\r\nnotify = "not-top-level"\r\n'));
  installer.install('codex');
  assert.equal(readFileSync(path, 'utf8'), text, 'idempotent');
  assert.equal(installer.uninstall('codex').state, 'not-installed');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('Codex with a foreign notify command is a conflict and is left untouched', (t) => {
  const { home, installer } = makeHome(t);
  const path = join(home, '.codex', 'config.toml');
  const original = 'notify = ["terminal-notifier", "-title", "Codex"]\nmodel = "o3"\n';
  writeFile(path, original);
  assert.equal(installer.status('codex').state, 'conflict');
  assert.throws(() => installer.install('codex'), /其他 notify/);
  installer.uninstall('codex');
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('Relay is silent outside AhaStation terminals and returns required Antigravity JSON replies', async () => {
  const env = { AHA_AGENT_HOOK_URL: '', AHA_AGENT_HOOK_TOKEN: '', AHA_TERMINAL_ID: '' };
  const claude = await runRelay([RELAY_SOURCE, 'claude'], { env, stdin: '{"hook_event_name":"Stop"}' });
  assert.deepEqual(claude, { code: 0, stdout: '' });
  const preInv = await runRelay([RELAY_SOURCE, 'antigravity', 'PreInvocation'], { env, stdin: '{}' });
  assert.deepEqual(preInv, { code: 0, stdout: '{}\n' });
  const preTool = await runRelay([RELAY_SOURCE, 'antigravity', 'PreToolUse'], { env, stdin: '{}' });
  assert.deepEqual(preTool, { code: 0, stdout: '{"decision":"ask"}\n' });
  const stop = await runRelay([RELAY_SOURCE, 'antigravity', 'Stop'], { env, stdin: '{}' });
  assert.deepEqual(stop, { code: 0, stdout: '{"decision":""}\n' });
  // A non-loopback URL is refused even with a token present.
  const remote = await runRelay([RELAY_SOURCE, 'claude'], {
    env: { AHA_AGENT_HOOK_URL: 'http://example.com/hook', AHA_AGENT_HOOK_TOKEN: 'x', AHA_TERMINAL_ID: 'local-1' },
    stdin: '{"hook_event_name":"Stop"}',
  });
  assert.equal(remote.code, 0);
});

test('Installed hook commands reach the loopback server end to end (Claude stdin, Antigravity open stdin pipe, Codex argv, dead port)', async (t) => {
  const { installer } = makeHome(t);
  installer.install('claude');
  installer.install('antigravity');
  const store = new AgentStatusStore();
  const server = new AgentHookServer(store);
  await server.start();
  t.after(() => server.stop());

  const ptyId = 'local-leaf-e2e';
  store.registerPane(ptyId, { agentId: 'claude' });
  const env = server.envForPane(ptyId);

  const big = 'x'.repeat(200_000);
  const pre = await runRelay([], {
    env,
    shellCommand: installer.commandFor('claude'),
    stdin: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: { file_path: 'a.txt', content: big } }),
  });
  assert.deepEqual(pre, { code: 0, stdout: '' });
  let status = store.get(ptyId);
  assert.equal(status.state, 'working');
  assert.equal(status.toolName, 'Write');
  assert.equal(status.toolInput, 'a.txt');

  // Simulate agy's real non-shell whitespace argv tokenizer (with cwd = ~/.gemini/config)
  // AND keeping stdin open after sending JSON containing braces in strings.
  const agyPty = 'local-agy-e2e';
  store.registerPane(agyPty);
  const agyEnv = server.envForPane(agyPty);
  const agyConfigDir = join(installer.configPath('antigravity'), '..');
  mkdirSync(agyConfigDir, { recursive: true });
  const agyTokens = installer.commandFor('antigravity', 'PreToolUse').trim().split(/\s+/);
  const agyPre = await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(agyTokens[0], agyTokens.slice(1), {
      cwd: agyConfigDir,
      env: { ...process.env, ...agyEnv },
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', rejectPromise);
    child.on('close', (code) => resolvePromise({ code, stdout }));
    child.stdin.write(
      JSON.stringify({
        hookEventName: 'PreToolUse',
        toolCall: { id: 'tc1', name: 'run_command', args: { CommandLine: 'echo }' } },
      }),
    );
  });
  assert.deepEqual(agyPre, { code: 0, stdout: '{"decision":"ask"}\n' });
  const agyStatus = store.get(agyPty);
  assert.equal(agyStatus.agentId, 'antigravity');
  assert.equal(agyStatus.state, 'working');
  assert.equal(agyStatus.toolName, 'run_command');
  assert.equal(agyStatus.toolInput, 'echo }');

  // Simulate Grok Build keeping stdin open with split UTF-8 JSON and snake_case hookEventName.
  installer.install('grok');
  const grokPty = 'local-grok-e2e';
  store.registerPane(grokPty);
  const grokEnv = server.envForPane(grokPty);
  const grokPre = await runRelay([], {
    env: grokEnv,
    shellCommand: installer.commandFor('grok'),
    stdin: Buffer.from(
      JSON.stringify({
        hookEventName: 'pre_tool_use',
        toolName: 'run_terminal_command',
        toolInput: { command: 'echo 汉字 🚀' },
      }),
      'utf8',
    ),
    keepStdinOpen: true,
  });
  assert.deepEqual(grokPre, { code: 0, stdout: '' });
  const grokStatus = store.get(grokPty);
  assert.equal(grokStatus.agentId, 'grok');
  assert.equal(grokStatus.state, 'working');
  assert.equal(grokStatus.toolName, 'run_terminal_command');
  assert.equal(grokStatus.toolInput, 'echo 汉字 🚀');

  const codex = await runRelay([installer.relayPath, 'codex', JSON.stringify({ type: 'agent-turn-complete', 'last-assistant-message': '完成了' })], { env });
  assert.equal(codex.code, 0);
  status = store.get(ptyId);
  assert.equal(status.state, 'done');
  assert.equal(status.message, '完成了');

  const port = server.port;
  await server.stop();
  const started = Date.now();
  const dead = await runRelay([installer.relayPath, 'claude'], {
    env: { ...env, AHA_AGENT_HOOK_URL: `http://127.0.0.1:${port}/hook` },
    stdin: '{"hook_event_name":"Stop"}',
  });
  assert.equal(dead.code, 0);
  assert.ok(Date.now() - started < 4000, 'dead server does not stall the CLI');
});

test('Relay content drift marks status outdated and refreshRelayIfInstalled/IPC syncs automatically', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'aha-hooks-sync-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'aha-hooks-src-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });

  const srcRelay = join(srcDir, 'agent-hook-relay.cjs');
  writeFileSync(srcRelay, '// relay v1\n', 'utf8');
  const installer = new AgentHookInstaller({ homeDir: home, env: {}, relaySourcePath: srcRelay });

  assert.equal(installer.install('claude').state, 'installed');
  assert.equal(installer.isRelayUpToDate(), true);

  // Updating the relay source marks status outdated until refreshed.
  writeFileSync(srcRelay, '// relay v2\n', 'utf8');
  assert.equal(installer.isRelayUpToDate(), false);
  const outdated = installer.status('claude');
  assert.equal(outdated.state, 'outdated');
  assert.match(outdated.detail, /重新安装/);

  // Registering IPC refreshes immediately and on agent-hooks:status even if relay file was deleted.
  rmSync(installer.relayPath, { force: true });
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
  const hooksIpc = registerAgentHooksIpc(installer);
  t.after(() => hooksIpc.dispose());

  assert.equal(installer.isRelayUpToDate(), true);
  assert.equal(readFileSync(installer.relayPath, 'utf8'), '// relay v2\n');

  writeFileSync(srcRelay, '// relay v3\n', 'utf8');
  const statusRes = await handlers.get('agent-hooks:status')();
  assert.equal(statusRes.ok, true);
  assert.equal(statusRes.statuses.find((s) => s.cliId === 'claude')?.state, 'installed');
  assert.equal(readFileSync(installer.relayPath, 'utf8'), '// relay v3\n');
});
