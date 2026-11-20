import assert from 'node:assert/strict';
import test from 'node:test';
import * as desktopIpc from '../dist-electron/ipc/desktop.js';
import * as settingsIpc from '../dist-electron/ipc/settings.js';
import * as settingsWindow from '../dist-electron/ipc/settings-window.js';
import * as settingsMigration from '../dist-electron/settings-migration.js';
import * as localCli from '../dist-electron/local-cli.js';

test('UI preference validation keeps handheld mode out of voice preferences', () => {
  assert.equal(typeof desktopIpc.buildUiPreferencesUpdate, 'function');
  assert.deepEqual(
    desktopIpc.buildUiPreferencesUpdate({ handheldMode: 'desktop' }),
    { ok: true, next: { handheldMode: 'desktop' } },
  );
  assert.equal(desktopIpc.buildUiPreferencesUpdate({ handheldMode: 'tablet' }).ok, false);
  assert.equal(desktopIpc.buildUiPreferencesUpdate(null).ok, false);
});

test('settings deep links accept only real sections', () => {
  assert.equal(typeof settingsWindow.normalizeSettingsSection, 'function');
  for (const section of ['appearance', 'terminal', 'voice-input', 'cli-agents']) {
    assert.equal(settingsWindow.normalizeSettingsSection(section), section);
  }
  for (const section of ['backends-unconfigured', 'voice', '', null, 42]) {
    assert.equal(settingsWindow.normalizeSettingsSection(section), null);
  }
});

test('CLI inventory includes unsupported or uninstalled entries with detection state', () => {
  assert.equal(typeof localCli.listLocalCliInventory, 'function');
  const inventory = localCli.listLocalCliInventory();
  assert.deepEqual(
    inventory.map(entry => entry.id),
    ['codex', 'claude', 'opencode', 'qoder', 'kimi', 'qwen', 'pi', 'antigravity', 'grok', 'gemini'],
  );
  for (const entry of inventory) {
    assert.equal(typeof entry.label, 'string');
    assert.equal(typeof entry.command, 'string');
    assert.equal(entry.installed, entry.binaryPath !== null);
    if (!entry.installed) assert.equal(entry.binaryPath, null);
  }
});

test('orchestration settings validation and v2 migration preserve valid preferences', () => {
  assert.equal(typeof settingsIpc.buildOrchestrationSettingsUpdate, 'function');
  const updated = settingsIpc.buildOrchestrationSettingsUpdate({
    confirmBeforeDispatch: 'always-ui',
    defaultWorktree: false,
    peerMessagingMode: 'hub-only',
    agentProfiles: { gemini: { enabled: true, specialty: '调研与文档' } },
  });
  assert.equal(updated.ok, true);
  assert.deepEqual(updated.settings, {
    confirmBeforeDispatch: 'always-ui',
    defaultWorktree: false,
    peerMessagingMode: 'hub-only',
    agentProfiles: { gemini: { enabled: true, specialty: '调研与文档' } },
  });
  assert.equal(settingsIpc.buildOrchestrationSettingsUpdate({ confirmBeforeDispatch: 'invalid' }).ok, false);
  assert.equal(settingsIpc.buildOrchestrationSettingsUpdate({ peerMessagingMode: 'invalid' }).ok, false);
  assert.equal(settingsIpc.buildOrchestrationSettingsUpdate({ unknownField: 1 }).ok, false);

  const migrated = settingsMigration.migrateSettings({
    schemaVersion: 2,
    orchestration: updated.settings,
  });
  assert.equal(migrated.changed, false);
  assert.deepEqual(migrated.settings.orchestration, updated.settings);
});
