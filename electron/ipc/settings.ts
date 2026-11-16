import { ipcMain, webContents } from 'electron';
import { listLocalCliInventory } from '../local-cli.js';
import {
  getSettings,
  updateSettings,
  clearVoicePrint,
  type Settings,
  type VoicePrint,
  type XfyunAsrCredentials,
} from '../store.js';

function broadcastVoiceConfigChanged(excludeWebContentsId?: number): void {
  for (const wc of webContents.getAllWebContents()) {
    if (wc.id === excludeWebContentsId) continue;
    wc.send('voiceconfig:changed');
  }
}

function broadcastVoiceInputChanged(): void {
  for (const wc of webContents.getAllWebContents()) {
    wc.send('settings:voice-input-changed');
  }
}

export interface VoicePrefPatch {
  voicePolishEnabled?: boolean;
  voicePolishApiKey?: string;
  voicePolishBaseUrl?: string;
  voicePolishModel?: string;
  xfyunAsr?: XfyunAsrCredentials;
}

const VOICE_PREF_KEYS = new Set([
  'voicePolishEnabled',
  'voicePolishApiKey',
  'voicePolishBaseUrl',
  'voicePolishModel',
  'xfyunAsr',
]);

export function buildVoicePrefUpdate(
  patch: VoicePrefPatch,
): { ok: true; next: Partial<Settings> } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: 'voice input patch must be an object' };
  }
  for (const key of Object.keys(patch)) {
    if (!VOICE_PREF_KEYS.has(key)) return { ok: false, error: `unknown voice input field: ${key}` };
  }

  const next: Partial<Settings> = {};
  if (Object.prototype.hasOwnProperty.call(patch, 'voicePolishEnabled')) {
    if (typeof patch.voicePolishEnabled !== 'boolean') {
      return { ok: false, error: 'voicePolishEnabled must be a boolean' };
    }
    next.voicePolishEnabled = patch.voicePolishEnabled;
  }

  for (const key of ['voicePolishApiKey', 'voicePolishBaseUrl', 'voicePolishModel'] as const) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = patch[key];
    if (typeof value !== 'string') return { ok: false, error: `${key} must be a string` };
    next[key] = value.trim() || undefined;
  }

  if (Object.prototype.hasOwnProperty.call(patch, 'xfyunAsr')) {
    const credentials = patch.xfyunAsr;
    if (typeof credentials !== 'object' || credentials === null || Array.isArray(credentials)) {
      return { ok: false, error: 'xfyunAsr must be an object' };
    }
    for (const key of Object.keys(credentials)) {
      if (!['appId', 'apiKey', 'apiSecret'].includes(key)) {
        return { ok: false, error: `unknown xfyunAsr field: ${key}` };
      }
    }
    const cleaned: XfyunAsrCredentials = {};
    for (const key of ['appId', 'apiKey', 'apiSecret'] as const) {
      const value = credentials[key];
      if (value !== undefined && typeof value !== 'string') {
        return { ok: false, error: `xfyunAsr.${key} must be a string` };
      }
      if (typeof value === 'string') cleaned[key] = value.trim();
    }
    next.xfyunAsr = cleaned;
  }
  return { ok: true, next };
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get-voice-config', async () => {
    const settings = getSettings();
    return {
      enabled: Boolean(settings.voiceLockEnabled),
      voicePrint: settings.voicePrint ?? null,
    };
  });

  ipcMain.handle('settings:set-voice-lock-enabled', async (event, enabled: boolean) => {
    updateSettings({ voiceLockEnabled: Boolean(enabled) });
    broadcastVoiceConfigChanged(event.sender.id);
    return { ok: true };
  });

  ipcMain.handle('settings:set-voice-print', async (event, voicePrint: VoicePrint | null) => {
    if (voicePrint) updateSettings({ voicePrint });
    else clearVoicePrint();
    broadcastVoiceConfigChanged(event.sender.id);
    return { ok: true };
  });

  ipcMain.handle('voicelock:enroll-start', async () => {
    for (const wc of webContents.getAllWebContents()) wc.send('voicelock:enroll-cmd', 'start');
    return { ok: true };
  });

  ipcMain.handle('voicelock:enroll-cancel', async () => {
    for (const wc of webContents.getAllWebContents()) wc.send('voicelock:enroll-cmd', 'cancel');
    return { ok: true };
  });

  ipcMain.on('voicelock:enroll-state', (event, state: unknown) => {
    for (const wc of webContents.getAllWebContents()) {
      if (wc.id !== event.sender.id) wc.send('voicelock:enroll-state', state);
    }
  });

  ipcMain.on('voiceconfig:changed', (event) => {
    broadcastVoiceConfigChanged(event.sender.id);
  });

  ipcMain.handle('settings:get-voice-input', async () => {
    const settings = getSettings();
    return {
      voicePolishEnabled: Boolean(settings.voicePolishEnabled),
      voicePolishApiKeyConfigured: Boolean(settings.voicePolishApiKey),
      voicePolishBaseUrl: settings.voicePolishBaseUrl ?? '',
      voicePolishModel: settings.voicePolishModel ?? '',
      xfyunAsr: {
        appId: settings.xfyunAsr?.appId ?? '',
        apiKeyConfigured: Boolean(settings.xfyunAsr?.apiKey),
        apiSecretConfigured: Boolean(settings.xfyunAsr?.apiSecret),
      },
    };
  });

  ipcMain.handle('settings:set-voice-input', async (_event, patch: VoicePrefPatch) => {
    const result = buildVoicePrefUpdate(patch);
    if (!result.ok) return { ok: false, error: result.error };
    const next = result.next;
    if (next.xfyunAsr) {
      next.xfyunAsr = { ...(getSettings().xfyunAsr ?? {}), ...next.xfyunAsr };
    }
    try {
      updateSettings(next);
      broadcastVoiceInputChanged();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle('settings:list-cli-inventory', async () => ({ ok: true, clis: listLocalCliInventory() }));
}
