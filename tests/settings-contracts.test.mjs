import assert from 'node:assert/strict';
import test from 'node:test';
import * as desktopIpc from '../dist-electron/ipc/desktop.js';
import * as settingsWindow from '../dist-electron/ipc/settings-window.js';
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
    ['codex', 'claude', 'opencode', 'qoder', 'kimi', 'qwen', 'pi', 'antigravity', 'grok'],
  );
  for (const entry of inventory) {
    assert.equal(typeof entry.label, 'string');
    assert.equal(typeof entry.command, 'string');
    assert.equal(entry.installed, entry.binaryPath !== null);
    if (!entry.installed) assert.equal(entry.binaryPath, null);
  }
});
