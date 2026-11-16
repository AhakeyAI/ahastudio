import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { app, safeStorage } from 'electron';
import { flushSettingsWrites, getSettings, updateSettings } from '../dist-electron/store.js';

test('secret updates fail without safeStorage encryption and never enter the cache as plaintext', (t) => {
  const original = safeStorage.isEncryptionAvailable;
  safeStorage.isEncryptionAvailable = () => false;
  t.after(() => { safeStorage.isEncryptionAvailable = original; });

  assert.throws(
    () => updateSettings({ voicePolishApiKey: 'must-not-be-plaintext' }),
    /encryption/i,
  );
  assert.equal(getSettings().voicePolishApiKey, undefined);

  flushSettingsWrites();
  const file = join(app.getPath('userData'), 'settings.json');
  const raw = readFileSync(file, 'utf8');
  assert.equal(raw.includes('must-not-be-plaintext'), false);
});
