import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { app, safeStorage } from 'electron';
import { flushSettingsWrites, getSettings } from '../dist-electron/store.js';

test('v1 settings migrate voice polish secrets and remove obsolete broadcast preferences', () => {
  const userData = app.getPath('userData');
  mkdirSync(userData, { recursive: true });
  const file = join(userData, 'settings.json');
  const legacy = {
    authMode: 'apikey',
    anthropicApiKeyEncrypted: safeStorage.encryptString('legacy-secret').toString('base64'),
    anthropicBaseUrl: 'https://legacy.example.test',
    anthropicModel: 'legacy-model',
    voicePolishEnabled: true,
    handheldMode: 'handheld',
    voiceLockEnabled: true,
    xfyunAsr: { appId: 'xf-app', apiKey: 'xf-key', apiSecret: 'xf-secret' },
    selectedVoiceName: 'Tingting',
    voiceGuidanceDismissed: true,
    speechFilterMode: 'off',
    reportModeEnabled: true,
    uiFontScale: 1.2,
  };
  writeFileSync(file, JSON.stringify(legacy), 'utf8');

  const migrated = getSettings();
  assert.equal(migrated.schemaVersion, 2);
  assert.equal(migrated.voicePolishApiKey, 'legacy-secret');
  assert.equal(migrated.voicePolishBaseUrl, 'https://legacy.example.test');
  assert.equal(migrated.voicePolishModel, 'legacy-model');
  assert.equal(migrated.voicePolishEnabled, true);
  assert.equal(migrated.handheldMode, 'handheld');
  assert.equal(migrated.voiceLockEnabled, true);
  assert.deepEqual(migrated.xfyunAsr, legacy.xfyunAsr);
  for (const removed of [
    'authMode', 'anthropicApiKeyEncrypted', 'anthropicBaseUrl', 'anthropicModel',
    'selectedVoiceName', 'voiceGuidanceDismissed', 'speechFilterMode',
    'reportModeEnabled', 'uiFontScale',
  ]) {
    assert.equal(Object.hasOwn(migrated, removed), false, `${removed} must not survive migration`);
  }

  flushSettingsWrites();
  const disk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(disk.schemaVersion, 2);
  assert.equal(disk.voicePolishApiKey, undefined);
  assert.equal(typeof disk.voicePolishApiKeyEncrypted, 'string');
  assert.equal(disk.xfyunAsr, undefined);
  assert.equal(typeof disk.xfyunAsrEncrypted, 'string');
  assert.deepEqual(JSON.parse(readFileSync(join(userData, 'settings.json.v1.bak'), 'utf8')), legacy);
});

test('migration is idempotent when v2 settings are loaded again', () => {
  const migrated = getSettings();
  assert.equal(migrated.schemaVersion, 2);
  flushSettingsWrites();
  assert.equal(existsSync(join(app.getPath('userData'), 'settings.json.v1.bak')), true);
});
