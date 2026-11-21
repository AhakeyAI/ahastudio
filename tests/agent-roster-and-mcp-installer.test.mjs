import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { ipcMain, webContents } from 'electron';

import {
  LOCAL_CLI_IDS,
  ORCHESTRATION_CLI_IDS,
  listLocalCliInventory,
  resolveMcpLaunchArgs,
} from '../dist-electron/local-cli.js';
import {
  DEFAULT_ORCHESTRATION_SETTINGS,
  getSettings,
  normalizeOrchestrationSettings,
} from '../dist-electron/store.js';
import {
  buildOrchestrationSettingsUpdate,
  registerSettingsIpc,
} from '../dist-electron/ipc/settings.js';
import {
  DEFAULT_AGENT_SPECIALTIES,
  buildAgentRoster,
  selectAgentForTask,
} from '../dist-electron/orchestration/agent-roster.js';
import {
  AGENT_MCP_CLI_IDS,
  AgentMcpInstaller,
  MCP_SERVER_FILE_NAME,
} from '../dist-electron/agent/agent-mcp-installer.js';
import { registerAgentMcpIpc } from '../dist-electron/ipc/agent-mcp.js';

function writeFile(path, content) {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function makeMcpFixture(t, { createSource = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'aha-mcp-home-'));
  const srcDir = mkdtempSync(join(tmpdir(), 'aha-mcp-src-'));
  t.after(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(srcDir, { recursive: true, force: true });
  });
  const srcServer = join(srcDir, MCP_SERVER_FILE_NAME);
  if (createSource) {
    writeFileSync(srcServer, '// mock aha mcp server v1\n', 'utf8');
  }
  const installer = new AgentMcpInstaller({
    homeDir: home,
    env: {},
    serverSourcePath: srcServer,
  });
  return { home, srcServer, installer };
}

test('LOCAL_CLI_IDS includes gemini, ORCHESTRATION_CLI_IDS is deduplicated, and resolveMcpLaunchArgs formats CLI flags', () => {
  assert.ok(LOCAL_CLI_IDS.includes('gemini'), 'gemini must be in LOCAL_CLI_IDS');
  assert.equal(new Set(ORCHESTRATION_CLI_IDS).size, ORCHESTRATION_CLI_IDS.length, 'no duplicate CLI ids');
  const inventory = listLocalCliInventory();
  assert.ok(inventory.some((item) => item.id === 'gemini' && item.command === 'gemini'));

  assert.deepEqual(
    resolveMcpLaunchArgs('claude', { claudeMcpConfigPath: 'C:/tmp/claude-mcp.json' }),
    ['--mcp-config', 'C:/tmp/claude-mcp.json'],
  );
  assert.deepEqual(resolveMcpLaunchArgs('claude', {}), []);
  assert.deepEqual(
    resolveMcpLaunchArgs('claude', { claudeMcpConfigPath: 'C:/tmp/claude-mcp.json', enabled: false }),
    [],
  );

  assert.deepEqual(
    resolveMcpLaunchArgs('codex', {
      mcpServerPath: 'C:\\Users\\demo\\.ahastation\\agent-hooks\\aha-mcp-server.cjs',
      nodeCommand: 'node',
    }),
    [
      '-c',
      'mcp_servers.aha.command="node"',
      '-c',
      'mcp_servers.aha.args=["C:/Users/demo/.ahastation/agent-hooks/aha-mcp-server.cjs"]',
      '-c',
      'mcp_servers.aha.env_vars=["AHA_TERMINAL_ID","AHA_ORCHESTRATION_PANE_TOKEN","AHA_AGENT_HOOK_PORT","AHA_AGENT_HOOK_TOKEN","AHA_AGENT_HOOK_URL","AHA_ORCHESTRATION_URL","AHA_AGENT_HOOK_ENDPOINT_FILE"]',
    ],
  );
  assert.deepEqual(
    resolveMcpLaunchArgs('codex', { mcpServerPath: '/opt/aha-mcp-server.cjs', enabled: false }),
    [],
  );
  assert.deepEqual(resolveMcpLaunchArgs('codex', {}), []);

  for (const cliId of ['gemini', 'antigravity', 'grok', 'opencode', 'qwen']) {
    assert.deepEqual(
      resolveMcpLaunchArgs(cliId, {
        mcpServerPath: '/opt/aha-mcp-server.cjs',
        claudeMcpConfigPath: '/opt/claude-mcp.json',
      }),
      [],
    );
  }
});

test('normalizeOrchestrationSettings and buildOrchestrationSettingsUpdate enforce strict validation and clean merging', () => {
  assert.deepEqual(normalizeOrchestrationSettings(), DEFAULT_ORCHESTRATION_SETTINGS);
  assert.deepEqual(
    normalizeOrchestrationSettings({
      confirmBeforeDispatch: 'invalid-mode',
      defaultWorktree: 'yes',
      agentProfiles: {
        codex: { enabled: false, specialty: '  测试与评审  ', defaultModel: '  o3  ', defaultEffort: '  ' },
        empty: { specialty: '   ' },
        __proto__: { enabled: false },
      },
    }),
    {
      confirmBeforeDispatch: 'chat-and-guard',
      defaultWorktree: true,
      peerMessagingMode: 'controlled-p2p',
      agentProfiles: {
        codex: { enabled: false, specialty: '测试与评审', defaultModel: 'o3' },
      },
    },
  );

  const step1 = buildOrchestrationSettingsUpdate(
    {
      confirmBeforeDispatch: 'always-ui',
      defaultWorktree: false,
      agentProfiles: {
        codex: { enabled: true, specialty: '  代码审查  ', defaultModel: 'gpt-5-codex', defaultEffort: 'high' },
      },
    },
    DEFAULT_ORCHESTRATION_SETTINGS,
  );
  assert.equal(step1.ok, true);
  assert.deepEqual(step1.settings, {
    confirmBeforeDispatch: 'always-ui',
    defaultWorktree: false,
    peerMessagingMode: 'controlled-p2p',
    agentProfiles: {
      codex: { enabled: true, specialty: '代码审查', defaultModel: 'gpt-5-codex', defaultEffort: 'high' },
    },
  });

  // Partial patch preserves other profiles and clears empty string fields.
  const step2 = buildOrchestrationSettingsUpdate(
    {
      agentProfiles: {
        codex: { defaultModel: '   ' },
        claude: { specialty: '架构重构' },
      },
    },
    step1.settings,
  );
  assert.equal(step2.ok, true);
  assert.deepEqual(step2.settings.agentProfiles, {
    codex: { enabled: true, specialty: '代码审查', defaultEffort: 'high' },
    claude: { specialty: '架构重构' },
  });

  // Strict rejection of invalid inputs.
  assert.equal(buildOrchestrationSettingsUpdate(null).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate([]).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ unknownKey: true }).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ confirmBeforeDispatch: 'prompt' }).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ defaultWorktree: 1 }).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ agentProfiles: [] }).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ agentProfiles: { codex: { unknownField: 1 } } }).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ agentProfiles: { codex: { enabled: 'no' } } }).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ agentProfiles: { codex: { specialty: 123 } } }).ok, false);
  assert.equal(buildOrchestrationSettingsUpdate({ agentProfiles: { 'bad id': { enabled: true } } }).ok, false);
  assert.equal(
    buildOrchestrationSettingsUpdate({ agentProfiles: { codex: { specialty: 'x'.repeat(301) } } }).ok,
    false,
  );
  assert.equal(
    buildOrchestrationSettingsUpdate({ agentProfiles: { codex: { defaultModel: '-- evil' } } }).ok,
    false,
  );
  assert.equal(
    buildOrchestrationSettingsUpdate({ agentProfiles: { codex: { defaultEffort: 'high\ninjected' } } }).ok,
    false,
  );

  // Multiline specialty is collapsed to single line in both update & normalize.
  const multilineSpecialty = buildOrchestrationSettingsUpdate({
    agentProfiles: { codex: { specialty: 'line1\r\nline2\nline3' } },
  });
  assert.equal(multilineSpecialty.ok, true);
  assert.equal(multilineSpecialty.settings.agentProfiles.codex.specialty, 'line1 line2 line3');
});

test('settings orchestration IPC reads, validates, persists, and broadcasts changes', async (t) => {
  const handlers = new Map();
  const broadcasts = [];
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));
  t.mock.method(ipcMain, 'on', () => {});
  const hadGetAll = Object.prototype.hasOwnProperty.call(webContents, 'getAllWebContents');
  const prevGetAll = webContents.getAllWebContents;
  webContents.getAllWebContents = () => [{ id: 1, send: (ch) => broadcasts.push(ch) }];
  t.after(() => {
    if (hadGetAll) webContents.getAllWebContents = prevGetAll;
    else delete webContents.getAllWebContents;
  });

  registerSettingsIpc();
  const initial = await handlers.get('settings:get-orchestration')();
  assert.equal(initial.confirmBeforeDispatch, 'chat-and-guard');
  assert.equal(initial.defaultWorktree, true);

  const bad = await handlers.get('settings:set-orchestration')({}, { extra: 1 });
  assert.equal(bad.ok, false);

  const updated = await handlers.get('settings:set-orchestration')(
    {},
    { confirmBeforeDispatch: 'auto', agentProfiles: { gemini: { specialty: '文档调研' } } },
  );
  assert.equal(updated.ok, true);
  assert.equal(updated.settings.confirmBeforeDispatch, 'auto');
  assert.equal(updated.settings.agentProfiles.gemini.specialty, '文档调研');
  assert.ok(broadcasts.includes('settings:orchestration-changed'));
  assert.equal(getSettings().orchestration?.confirmBeforeDispatch, 'auto');

  // Restore defaults so shared electron stub state stays clean.
  await handlers.get('settings:set-orchestration')({}, {
    confirmBeforeDispatch: 'chat-and-guard',
    defaultWorktree: true,
    agentProfiles: { gemini: null },
  });
});

test('buildAgentRoster combines inventory, settings, hooks, MCP, and idle panes', () => {
  for (const id of ORCHESTRATION_CLI_IDS) {
    assert.ok(DEFAULT_AGENT_SPECIALTIES[id], `missing default specialty for ${id}`);
  }

  const inventory = [
    { id: 'claude', label: 'Claude Code', command: 'claude', binaryPath: '/bin/claude', installed: true },
    { id: 'codex', label: 'Codex', command: 'codex', binaryPath: '/bin/codex', installed: true },
    { id: 'gemini', label: 'Gemini CLI', command: 'gemini', binaryPath: '/bin/gemini', installed: true },
    { id: 'grok', label: 'Grok', command: 'grok', binaryPath: null, installed: false },
    { id: 'kimi', label: 'Kimi', command: 'kimi', binaryPath: '/bin/kimi', installed: true },
  ];

  const roster = buildAgentRoster({
    inventory,
    settings: {
      agentProfiles: {
        codex: { specialty: '自定义评审专家', defaultModel: 'o3', defaultEffort: 'high' },
        gemini: { enabled: false },
      },
    },
    hookStatuses: [
      { cliId: 'claude', state: 'installed' },
      { cliId: 'codex', state: 'not-installed' },
    ],
    mcpStatuses: [
      { cliId: 'claude', mode: 'launch-arg', state: 'launch-managed' },
      { cliId: 'codex', mode: 'launch-arg', state: 'launch-managed' },
      { cliId: 'gemini', mode: 'config', state: 'installed' },
      { cliId: 'grok', mode: 'config', state: 'not-installed' },
    ],
    idlePanes: [
      { ptyId: 'pty-codex-1', cliId: 'codex', cwd: '/repo' },
      { ptyId: 'pty-claude-1', cliId: 'claude-code', cwd: '/repo' },
    ],
  });

  const byId = Object.fromEntries(roster.map((entry) => [entry.cliId, entry]));
  assert.equal(byId.claude.available, true);
  assert.equal(byId.claude.hooksInstalled, true);
  assert.equal(byId.claude.mcpMode, 'launch-arg');
  assert.equal(byId.claude.mcpReady, true);
  assert.equal(byId.claude.idlePanes.length, 1);
  assert.equal(byId.claude.idlePanes[0].ptyId, 'pty-claude-1');

  assert.equal(byId.codex.specialty, '自定义评审专家');
  assert.equal(byId.codex.defaultModel, 'o3');
  assert.equal(byId.codex.defaultEffort, 'high');
  assert.equal(byId.codex.hooksInstalled, false);

  assert.equal(byId.gemini.installed, true);
  assert.equal(byId.gemini.enabled, false);
  assert.equal(byId.gemini.available, false);
  assert.equal(byId.gemini.mcpMode, 'config');
  assert.equal(byId.gemini.mcpReady, true);

  assert.equal(byId.grok.installed, false);
  assert.equal(byId.grok.available, false);
  assert.equal(byId.grok.mcpReady, false);

  assert.equal(byId.kimi.mcpMode, 'cli-fallback');
  assert.equal(byId.kimi.mcpReady, false);
});

test('selectAgentForTask handles explicit aliases, auto taskKind affinity, heterogeneous review, idle boost, and errors', () => {
  const roster = buildAgentRoster({
    inventory: [
      { id: 'claude', label: 'Claude Code', command: 'claude', binaryPath: '/bin/claude', installed: true },
      { id: 'codex', label: 'Codex', command: 'codex', binaryPath: '/bin/codex', installed: true },
      { id: 'gemini', label: 'Gemini CLI', command: 'gemini', binaryPath: '/bin/gemini', installed: true },
      { id: 'antigravity', label: 'Antigravity', command: 'agy', binaryPath: '/bin/agy', installed: true },
      { id: 'grok', label: 'Grok', command: 'grok', binaryPath: '/bin/grok', installed: true },
      { id: 'qwen', label: 'Qwen Code', command: 'qwen', binaryPath: null, installed: false },
      { id: 'opencode', label: 'OpenCode', command: 'opencode', binaryPath: '/bin/opencode', installed: true },
    ],
    settings: {
      agentProfiles: {
        codex: { defaultModel: 'gpt-5-codex', defaultEffort: 'medium' },
        opencode: { enabled: false },
      },
    },
    idlePanes: [{ ptyId: 'pty-grok-idle', cliId: 'grok', cwd: '/repo' }],
  });

  // Explicit alias resolution.
  const explicitAgy = selectAgentForTask({ roster, requestedAgent: '@agy', taskKind: 'implementation' });
  assert.equal(explicitAgy.cliId, 'antigravity');
  assert.ok(explicitAgy.fallbacks.includes('claude'));
  assert.ok(!explicitAgy.fallbacks.includes('antigravity'));
  assert.equal(selectAgentForTask({ roster, requestedAgent: 'claude-code' }).cliId, 'claude');
  assert.equal(selectAgentForTask({ roster, requestedAgent: 'gemini-cli' }).cliId, 'gemini');

  // Auto taskKind affinity.
  const reviewFromClaude = selectAgentForTask({
    roster,
    requestedAgent: 'auto',
    taskKind: 'review',
    coordinatorCliId: 'claude',
  });
  assert.equal(reviewFromClaude.cliId, 'codex');
  assert.equal(reviewFromClaude.model, 'gpt-5-codex');
  assert.equal(reviewFromClaude.effort, 'medium');

  // Heterogeneous review: when coordinator is codex, strongly prefer another CLI (grok).
  const reviewFromCodex = selectAgentForTask({
    roster,
    taskKind: 'review',
    coordinatorCliId: 'codex',
  });
  assert.equal(reviewFromCodex.cliId, 'grok');
  assert.ok(reviewFromCodex.fallbacks.includes('codex'));

  // Research/docs prefer gemini.
  assert.equal(selectAgentForTask({ roster, taskKind: 'research' }).cliId, 'gemini');
  assert.equal(selectAgentForTask({ roster, taskKind: 'docs' }).cliId, 'gemini');

  // Architecture/implementation prefer claude.
  assert.equal(selectAgentForTask({ roster, taskKind: 'architecture' }).cliId, 'claude');
  assert.equal(selectAgentForTask({ roster, taskKind: 'implementation' }).cliId, 'claude');

  // preferIdle boosts idle grok over codex for tests and returns idlePaneId.
  const idlePick = selectAgentForTask({
    roster,
    taskKind: 'tests',
    preferIdle: true,
  });
  assert.equal(idlePick.cliId, 'grok');
  assert.equal(idlePick.idlePaneId, 'pty-grok-idle');

  // Without preferIdle, idlePaneId is null and codex wins tests affinity.
  const noIdlePick = selectAgentForTask({ roster, taskKind: 'tests' });
  assert.equal(noIdlePick.cliId, 'codex');
  assert.equal(noIdlePick.idlePaneId, null);

  // Explicit unavailable errors.
  assert.throws(() => selectAgentForTask({ roster, requestedAgent: 'qwen' }), /未安装/);
  assert.throws(() => selectAgentForTask({ roster, requestedAgent: 'opencode' }), /禁用/);
  assert.throws(() => selectAgentForTask({ roster, requestedAgent: 'nonexistent' }), /未识别/);

  // Zero available agents throws descriptive error.
  const allDisabled = roster.map((entry) => ({ ...entry, enabled: false, available: false }));
  assert.throws(() => selectAgentForTask({ roster: allDisabled }), /禁用/);
  const noneInstalled = roster.map((entry) => ({ ...entry, installed: false, available: false }));
  assert.throws(() => selectAgentForTask({ roster: noneInstalled }), /未检测到已安装/);
});

test('AgentMcpInstaller handles launch-managed Claude/Codex and refreshes bridge server', (t) => {
  const { srcServer, installer } = makeMcpFixture(t);

  assert.equal(installer.status('claude').mode, 'launch-arg');
  assert.equal(installer.status('claude').state, 'launch-managed');
  assert.equal(installer.status('codex').mode, 'launch-arg');
  assert.equal(installer.status('codex').state, 'launch-managed');

  const configPath = installer.ensureClaudeMcpConfigFile();
  assert.ok(existsSync(configPath));
  assert.ok(existsSync(installer.serverPath));
  const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
  assert.equal(parsed.mcpServers.aha.command, 'node');
  assert.deepEqual(parsed.mcpServers.aha.args, [installer.serverPath.replace(/\\/g, '/')]);

  // Drift in source script is synced by refreshServerIfInstalled.
  writeFileSync(srcServer, '// mock aha mcp server v2\n', 'utf8');
  assert.equal(installer.isServerUpToDate(), false);
  installer.refreshServerIfInstalled();
  assert.equal(installer.isServerUpToDate(), true);
  assert.equal(readFileSync(installer.serverPath, 'utf8'), '// mock aha mcp server v2\n');
});

test('AgentMcpInstaller manages JSON configs (Antigravity, Gemini, Qwen, OpenCode) with conflict detection', (t) => {
  const { home, srcServer, installer } = makeMcpFixture(t);

  // Antigravity: preserves sibling mcpServers, idempotent, uninstall restores original.
  const agyPath = join(home, '.gemini', 'config', 'mcp_config.json');
  const agyOrig = { mcpServers: { github: { command: 'npx', args: ['-y', 'gh-mcp'] } }, theme: 'dark' };
  writeFile(agyPath, JSON.stringify(agyOrig, null, 2));
  assert.equal(installer.status('antigravity').state, 'not-installed');
  assert.equal(installer.install('antigravity').state, 'installed');
  const agyAfter = JSON.parse(readFileSync(agyPath, 'utf8'));
  assert.deepEqual(agyAfter.mcpServers.github, agyOrig.mcpServers.github);
  assert.equal(agyAfter.mcpServers.aha.command, 'node');
  assert.deepEqual(agyAfter.mcpServers.aha.args, [installer.serverPath.replace(/\\/g, '/')]);
  const agySnapshot = readFileSync(agyPath, 'utf8');
  installer.install('antigravity');
  assert.equal(readFileSync(agyPath, 'utf8'), agySnapshot, 'second install is idempotent');
  assert.equal(installer.uninstall('antigravity').state, 'not-installed');
  assert.deepEqual(JSON.parse(readFileSync(agyPath, 'utf8')), agyOrig);

  // Gemini & Qwen: install creates config, drift marks outdated, uninstall removes empty mcpServers.
  assert.equal(installer.install('gemini').state, 'installed');
  assert.equal(installer.install('qwen').state, 'installed');
  writeFileSync(srcServer, '// mock aha mcp server v2\n', 'utf8');
  assert.equal(installer.status('gemini').state, 'outdated');
  assert.equal(installer.install('gemini').state, 'installed');
  assert.equal(installer.uninstall('qwen').state, 'not-installed');
  assert.deepEqual(JSON.parse(readFileSync(join(home, '.qwen', 'settings.json'), 'utf8')), {});

  // Conflict on foreign `aha` entry in Gemini settings.
  const geminiPath = join(home, '.gemini', 'settings.json');
  const foreignGemini = { mcpServers: { aha: { command: 'custom-aha', args: ['serve'] } } };
  writeFile(geminiPath, JSON.stringify(foreignGemini, null, 2));
  assert.equal(installer.status('gemini').state, 'conflict');
  assert.throws(() => installer.install('gemini'), /其他 aha MCP/);
  installer.uninstall('gemini');
  assert.deepEqual(JSON.parse(readFileSync(geminiPath, 'utf8')), foreignGemini);

  // OpenCode uses `mcp.aha` local schema and detects conflicts.
  const ocPath = join(home, '.config', 'opencode', 'opencode.json');
  const ocOrig = { mcp: { other: { type: 'local', command: ['echo'], enabled: true } } };
  writeFile(ocPath, JSON.stringify(ocOrig, null, 2));
  assert.equal(installer.install('opencode').state, 'installed');
  const ocAfter = JSON.parse(readFileSync(ocPath, 'utf8'));
  assert.deepEqual(ocAfter.mcp.aha, {
    type: 'local',
    command: ['node', installer.serverPath.replace(/\\/g, '/')],
    enabled: true,
  });
  assert.deepEqual(ocAfter.mcp.other, ocOrig.mcp.other);
  assert.equal(installer.uninstall('opencode').state, 'not-installed');
  assert.deepEqual(JSON.parse(readFileSync(ocPath, 'utf8')), ocOrig);

  const foreignOc = { mcp: { aha: { type: 'local', command: ['other-bin'], enabled: true } } };
  writeFile(ocPath, JSON.stringify(foreignOc, null, 2));
  assert.equal(installer.status('opencode').state, 'conflict');
  assert.throws(() => installer.install('opencode'), /其他 aha MCP/);

  // Malformed JSON with comments is reported as error and never overwritten.
  const rawComments = '{\n  // user comment\n  "theme": "dark"\n}\n';
  writeFile(agyPath, rawComments);
  assert.equal(installer.status('antigravity').state, 'error');
  assert.throws(() => installer.install('antigravity'), /不是标准 JSON/);
  assert.equal(readFileSync(agyPath, 'utf8'), rawComments);
});

test('AgentMcpInstaller manages Grok TOML block with CRLF preservation, conflict detection, and tolerates missing source', (t) => {
  const { home, installer } = makeMcpFixture(t, { createSource: false });
  const grokPath = join(home, '.grok', 'config.toml');
  const original = 'model = "grok-code"\r\n\r\n[mcp_servers.other]\r\ncommand = "npx"\r\n';
  writeFile(grokPath, original);

  assert.equal(installer.status('grok').state, 'not-installed');
  assert.equal(installer.install('grok').state, 'installed');
  const installedText = readFileSync(grokPath, 'utf8');
  assert.ok(installedText.includes('# managed by AhaStation (orchestration MCP)'));
  assert.ok(installedText.includes('[mcp_servers.aha]'));
  assert.ok(installedText.includes('\r\n'));

  // Idempotent reinstall.
  installer.install('grok');
  assert.equal(readFileSync(grokPath, 'utf8'), installedText);

  // Uninstall restores exact original file.
  assert.equal(installer.uninstall('grok').state, 'not-installed');
  assert.equal(readFileSync(grokPath, 'utf8'), original);

  // Foreign [mcp_servers.aha] block is a conflict and left untouched.
  const conflictToml = 'model = "grok-code"\n\n[mcp_servers.aha]\ncommand = "custom-mcp"\n';
  writeFile(grokPath, conflictToml);
  assert.equal(installer.status('grok').state, 'conflict');
  assert.throws(() => installer.install('grok'), /其他 mcp_servers\.aha/);
  installer.uninstall('grok');
  assert.equal(readFileSync(grokPath, 'utf8'), conflictToml);

  // Trailing [mcp_servers.aha.env] sub-table is also detected as conflict.
  const subTableConflict =
    '# managed by AhaStation (orchestration MCP)\n[mcp_servers.aha]\ncommand = "node"\nargs = [\n  "/path/to/aha-mcp-server.cjs"\n]\n\n[mcp_servers.aha.env]\nFOO = "BAR"\n';
  writeFile(grokPath, subTableConflict);
  assert.equal(installer.status('grok').state, 'conflict');
});

test('registerAgentMcpIpc validates payloads and enforces optional sender authorization', async (t) => {
  const { installer } = makeMcpFixture(t);
  const handlers = new Map();
  t.mock.method(ipcMain, 'handle', (channel, fn) => handlers.set(channel, fn));

  const reg = registerAgentMcpIpc(installer, { getMainWindowId: () => 42 });
  t.after(() => reg.dispose());

  const unauthorized = await handlers.get('agent-mcp:status')({ sender: { id: 99 } });
  assert.equal(unauthorized.ok, false);

  const statusRes = await handlers.get('agent-mcp:status')({ sender: { id: 42 } });
  assert.equal(statusRes.ok, true);
  assert.deepEqual(
    statusRes.statuses.map((s) => s.cliId),
    [...AGENT_MCP_CLI_IDS],
  );

  const badPayload = await handlers.get('agent-mcp:install')({ sender: { id: 42 } }, { cliId: 'unknown' });
  assert.equal(badPayload.ok, false);

  const installed = await handlers.get('agent-mcp:install')({ sender: { id: 42 } }, { cliId: 'gemini' });
  assert.equal(installed.ok, true);
  assert.equal(installed.status.state, 'installed');

  const uninstalled = await handlers.get('agent-mcp:uninstall')({ sender: { id: 42 } }, { cliId: 'gemini' });
  assert.equal(uninstalled.ok, true);
  assert.equal(uninstalled.status.state, 'not-installed');
});
