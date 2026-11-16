import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVoicePrefUpdate } from '../dist-electron/ipc/settings.js';

test('maps ASR credentials and dedicated voice polish settings', () => {
  const result = buildVoicePrefUpdate({
    voicePolishEnabled: true,
    voicePolishApiKey: ' polish-key ',
    voicePolishBaseUrl: ' https://polish.example.test ',
    voicePolishModel: ' polish-model ',
    xfyunAsr: { appId: ' test-appid ', apiKey: ' test-key ', apiSecret: ' test-secret ' },
  });
  assert.deepEqual(result, {
    ok: true,
    next: {
      voicePolishEnabled: true,
      voicePolishApiKey: 'polish-key',
      voicePolishBaseUrl: 'https://polish.example.test',
      voicePolishModel: 'polish-model',
      xfyunAsr: { appId: 'test-appid', apiKey: 'test-key', apiSecret: 'test-secret' },
    },
  });
});

test('blank voice polish fields clear their stored values', () => {
  const result = buildVoicePrefUpdate({ voicePolishApiKey: '', voicePolishBaseUrl: '', voicePolishModel: '' });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(result.next, 'voicePolishApiKey'), true);
  assert.equal(result.next.voicePolishApiKey, undefined);
  assert.equal(result.next.voicePolishBaseUrl, undefined);
  assert.equal(result.next.voicePolishModel, undefined);
});

test('obsolete broadcast and UI preferences are rejected by the voice input API', () => {
  for (const patch of [
    { selectedVoiceName: null },
    { guidanceDismissed: true },
    { speechFilterMode: 'off' },
    { reportModeEnabled: false },
    { handheldMode: 'handheld' },
  ]) {
    assert.equal(buildVoicePrefUpdate(patch).ok, false, `expected rejection for ${JSON.stringify(patch)}`);
  }
});

test('rejects malformed voice input patches', () => {
  for (const patch of [
    null,
    42,
    { voicePolishEnabled: 1 },
    { voicePolishApiKey: 42 },
    { voicePolishBaseUrl: null },
    { voicePolishModel: true },
    { xfyunAsr: 'remote' },
    { xfyunAsr: { apiKey: 42 } },
  ]) {
    assert.equal(buildVoicePrefUpdate(patch).ok, false, `expected rejection for ${JSON.stringify(patch)}`);
  }
});

test('omitted voice input keys produce no settings writes', () => {
  assert.deepEqual(buildVoicePrefUpdate({}), { ok: true, next: {} });
});
