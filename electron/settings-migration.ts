import type { Settings } from './store.js';

export interface LegacySettings extends Omit<Partial<Settings>, 'schemaVersion'> {
  schemaVersion?: number;
  authMode?: 'subscription' | 'apikey';
  anthropicApiKey?: string;
  anthropicApiKeyEncrypted?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
  selectedVoiceName?: string | null;
  voiceGuidanceDismissed?: boolean;
  speechFilterMode?: 'strict' | 'off';
  reportModeEnabled?: boolean;
  uiFontScale?: number;
}

const OBSOLETE_KEYS = [
  'authMode',
  'anthropicApiKey',
  'anthropicApiKeyEncrypted',
  'anthropicBaseUrl',
  'anthropicModel',
  'selectedVoiceName',
  'voiceGuidanceDismissed',
  'speechFilterMode',
  'reportModeEnabled',
  'uiFontScale',
] as const;

export function migrateSettings(raw: LegacySettings): { settings: Settings; changed: boolean } {
  const settings: Settings = { schemaVersion: 2 };
  if (raw.voiceLockEnabled !== undefined) settings.voiceLockEnabled = raw.voiceLockEnabled;
  if (raw.voicePrint !== undefined) settings.voicePrint = raw.voicePrint;
  if (raw.voicePolishEnabled !== undefined) settings.voicePolishEnabled = raw.voicePolishEnabled;
  if (raw.handheldMode !== undefined) settings.handheldMode = raw.handheldMode;
  if (raw.xfyunAsr !== undefined) settings.xfyunAsr = raw.xfyunAsr;
  if (raw.xfyunAsrEncrypted !== undefined) settings.xfyunAsrEncrypted = raw.xfyunAsrEncrypted;

  const polishKey = raw.voicePolishApiKey ?? raw.anthropicApiKey;
  const polishKeyEncrypted = raw.voicePolishApiKeyEncrypted ?? raw.anthropicApiKeyEncrypted;
  if (polishKey !== undefined) settings.voicePolishApiKey = polishKey;
  if (polishKey === undefined && polishKeyEncrypted !== undefined) {
    settings.voicePolishApiKeyEncrypted = polishKeyEncrypted;
  }
  const polishBaseUrl = raw.voicePolishBaseUrl ?? raw.anthropicBaseUrl;
  const polishModel = raw.voicePolishModel ?? raw.anthropicModel;
  if (polishBaseUrl !== undefined) settings.voicePolishBaseUrl = polishBaseUrl;
  if (polishModel !== undefined) settings.voicePolishModel = polishModel;

  const changed = raw.schemaVersion !== 2
    || OBSOLETE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key));
  return { settings, changed };
}
