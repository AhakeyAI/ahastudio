import { app, safeStorage } from 'electron';
import {
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { migrateSettings, type LegacySettings } from './settings-migration.js';

export interface VoicePrint {
  embedding: number[];
  model: string;
  secondsCaptured: number;
  enrolledAt: number;
}

export interface XfyunAsrCredentials {
  appId?: string;
  apiKey?: string;
  apiSecret?: string;
}

export interface Settings {
  schemaVersion?: 2;
  voiceLockEnabled?: boolean;
  voicePrint?: VoicePrint;
  voicePolishEnabled?: boolean;
  voicePolishApiKey?: string;
  voicePolishApiKeyEncrypted?: string;
  voicePolishBaseUrl?: string;
  voicePolishModel?: string;
  handheldMode?: 'auto' | 'desktop' | 'handheld';
  xfyunAsr?: XfyunAsrCredentials;
  xfyunAsrEncrypted?: string;
}

let cachedSettings: Settings | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function settingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function decryptString(b64: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Settings encryption is unavailable');
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    throw new Error('Failed to decrypt settings');
  }
}

function encryptString(plain: string): string {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('Settings encryption is unavailable');
  try {
    return safeStorage.encryptString(plain).toString('base64');
  } catch {
    throw new Error('Failed to encrypt settings');
  }
}

function decodeLoadedSettings(raw: Settings): Settings {
  const out: Settings = { ...raw };
  if (raw.voicePolishApiKeyEncrypted) {
    out.voicePolishApiKey = decryptString(raw.voicePolishApiKeyEncrypted);
  }
  if (raw.xfyunAsrEncrypted) {
    out.xfyunAsr = JSON.parse(decryptString(raw.xfyunAsrEncrypted)) as XfyunAsrCredentials;
  }
  return out;
}

function encodeSettingsForDisk(settings: Settings): Settings {
  const disk: Settings = { ...settings };
  if (disk.voicePolishApiKey) {
    disk.voicePolishApiKeyEncrypted = encryptString(disk.voicePolishApiKey);
    delete disk.voicePolishApiKey;
  } else if (!disk.voicePolishApiKeyEncrypted) {
    delete disk.voicePolishApiKey;
  }
  const xfyun = disk.xfyunAsr;
  if (xfyun && (xfyun.appId || xfyun.apiKey || xfyun.apiSecret)) {
    disk.xfyunAsrEncrypted = encryptString(JSON.stringify(xfyun));
    delete disk.xfyunAsr;
  } else if (!disk.xfyunAsrEncrypted) {
    delete disk.xfyunAsr;
  }
  return disk;
}

function writeSettingsNow(settings: Settings): void {
  const file = settingsFilePath();
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(encodeSettingsForDisk(settings), null, 2), 'utf8');
  renameSync(tmp, file);
}

function backupV1Settings(): void {
  const file = settingsFilePath();
  const backup = `${file}.v1.bak`;
  if (!existsSync(file) || existsSync(backup)) return;
  copyFileSync(file, backup, constants.COPYFILE_EXCL);
}

function scheduleSettingsWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (cachedSettings) writeSettingsNow(cachedSettings);
  }, 50);
  writeTimer.unref();
}

export function getSettings(): Settings {
  if (cachedSettings) return cachedSettings;
  const file = settingsFilePath();
  if (!existsSync(file)) {
    cachedSettings = { schemaVersion: 2 };
    return cachedSettings;
  }

  const raw = JSON.parse(readFileSync(file, 'utf8')) as LegacySettings;
  const migration = migrateSettings(raw ?? {});
  if (migration.changed) {
    backupV1Settings();
    writeSettingsNow(migration.settings);
  }
  cachedSettings = decodeLoadedSettings(migration.settings);
  return cachedSettings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch, schemaVersion: 2 };
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    if (patch[key] === undefined) delete next[key];
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'voicePolishApiKey')) {
    delete next.voicePolishApiKeyEncrypted;
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'xfyunAsr')) {
    delete next.xfyunAsrEncrypted;
  }
  encodeSettingsForDisk(next);
  cachedSettings = next;
  scheduleSettingsWrite();
  return cachedSettings;
}

export function clearVoicePrint(): Settings {
  return updateSettings({ voicePrint: undefined, voiceLockEnabled: false });
}

export function flushSettingsWrites(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  if (cachedSettings) writeSettingsNow(cachedSettings);
}
