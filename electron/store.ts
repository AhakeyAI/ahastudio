import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

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
  authMode?: 'subscription' | 'apikey';
  anthropicApiKey?: string;
  anthropicApiKeyEncrypted?: string;
  anthropicBaseUrl?: string;
  anthropicModel?: string;
  voiceLockEnabled?: boolean;
  voicePrint?: VoicePrint;
  selectedVoiceName?: string | null;
  voiceGuidanceDismissed?: boolean;
  speechFilterMode?: 'strict' | 'off';
  voicePolishEnabled?: boolean;
  reportModeEnabled?: boolean;
  handheldMode?: 'auto' | 'desktop' | 'handheld';
  xfyunAsr?: XfyunAsrCredentials;
  xfyunAsrEncrypted?: string;
  uiFontScale?: number;
}

let cachedSettings: Settings | null = null;
let writeTimer: ReturnType<typeof setTimeout> | null = null;

function settingsFilePath(): string {
  return join(app.getPath('userData'), 'settings.json');
}

function decryptString(b64: string): string | undefined {
  if (!b64 || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(b64, 'base64'));
  } catch {
    return undefined;
  }
}

function encryptString(plain: string): string | undefined {
  if (!plain || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.encryptString(plain).toString('base64');
  } catch {
    return undefined;
  }
}

function decodeLoadedSettings(raw: Settings): Settings {
  const out: Settings = { ...raw };
  if (raw.anthropicApiKeyEncrypted) {
    const decrypted = decryptString(raw.anthropicApiKeyEncrypted);
    if (decrypted !== undefined) {
      out.anthropicApiKey = decrypted;
    }
  }
  if (raw.xfyunAsrEncrypted) {
    const decrypted = decryptString(raw.xfyunAsrEncrypted);
    if (decrypted) {
      try {
        out.xfyunAsr = JSON.parse(decrypted) as XfyunAsrCredentials;
      } catch { /* ignore malformed encrypted payload */ }
    }
  }
  return out;
}

function encodeSettingsForDisk(settings: Settings): Settings {
  const disk: Settings = { ...settings };
  if (disk.anthropicApiKey) {
    const enc = encryptString(disk.anthropicApiKey);
    if (enc) {
      disk.anthropicApiKeyEncrypted = enc;
      delete disk.anthropicApiKey;
    }
  } else {
    delete disk.anthropicApiKeyEncrypted;
  }
  if (disk.xfyunAsr && (disk.xfyunAsr.appId || disk.xfyunAsr.apiKey || disk.xfyunAsr.apiSecret)) {
    const enc = encryptString(JSON.stringify(disk.xfyunAsr));
    if (enc) {
      disk.xfyunAsrEncrypted = enc;
      delete disk.xfyunAsr;
    }
  } else {
    delete disk.xfyunAsrEncrypted;
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

function scheduleSettingsWrite(): void {
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (cachedSettings) {
      try {
        writeSettingsNow(cachedSettings);
      } catch { /* non-fatal on background flush */ }
    }
  }, 50);
  writeTimer.unref();
}

export function getSettings(): Settings {
  if (cachedSettings) return cachedSettings;
  const file = settingsFilePath();
  if (!existsSync(file)) {
    cachedSettings = {};
    return cachedSettings;
  }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Settings;
    cachedSettings = decodeLoadedSettings(raw ?? {});
  } catch {
    cachedSettings = {};
  }
  return cachedSettings;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...getSettings(), ...patch };
  for (const key of Object.keys(patch) as (keyof Settings)[]) {
    if (patch[key] === undefined) {
      delete next[key];
    }
  }
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
  if (cachedSettings) {
    try {
      writeSettingsNow(cachedSettings);
    } catch { /* best-effort on quit */ }
  }
}
