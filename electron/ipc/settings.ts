import { ipcMain, webContents } from 'electron';
import { listLocalCliInventory } from '../local-cli.js';
import {
  getSettings,
  updateSettings,
  clearVoicePrint,
  normalizeOrchestrationSettings,
  type OrchestrationAgentProfile,
  type OrchestrationConfirmMode,
  type OrchestrationPeerMessagingMode,
  type OrchestrationSettings,
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

function broadcastOrchestrationSettingsChanged(): void {
  for (const wc of webContents.getAllWebContents()) {
    wc.send('settings:orchestration-changed');
  }
}

export interface OrchestrationSettingsPatch {
  confirmBeforeDispatch?: OrchestrationConfirmMode;
  defaultWorktree?: boolean;
  peerMessagingMode?: OrchestrationPeerMessagingMode;
  agentProfiles?: Record<string, OrchestrationAgentProfile | null>;
}

const ORCHESTRATION_SETTING_KEYS = new Set([
  'confirmBeforeDispatch',
  'defaultWorktree',
  'peerMessagingMode',
  'agentProfiles',
]);

const ORCHESTRATION_PROFILE_KEYS = new Set([
  'enabled',
  'specialty',
  'defaultModel',
  'defaultEffort',
]);

const FORBIDDEN_PROFILE_IDS = new Set(['__proto__', 'constructor', 'prototype']);

export function buildOrchestrationSettingsUpdate(
  patch: unknown,
  current?: Partial<OrchestrationSettings>,
): { ok: true; settings: OrchestrationSettings } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: 'orchestration settings patch must be an object' };
  }
  const patchObj = patch as Record<string, unknown>;
  for (const key of Object.keys(patchObj)) {
    if (!ORCHESTRATION_SETTING_KEYS.has(key)) {
      return { ok: false, error: `unknown orchestration setting: ${key}` };
    }
  }

  const next = normalizeOrchestrationSettings(current);

  if (Object.prototype.hasOwnProperty.call(patchObj, 'confirmBeforeDispatch')) {
    const mode = patchObj.confirmBeforeDispatch;
    if (mode !== 'chat-and-guard' && mode !== 'always-ui' && mode !== 'auto') {
      return { ok: false, error: 'invalid confirmBeforeDispatch' };
    }
    next.confirmBeforeDispatch = mode;
  }

  if (Object.prototype.hasOwnProperty.call(patchObj, 'defaultWorktree')) {
    if (typeof patchObj.defaultWorktree !== 'boolean') {
      return { ok: false, error: 'defaultWorktree must be a boolean' };
    }
    next.defaultWorktree = patchObj.defaultWorktree;
  }

  if (Object.prototype.hasOwnProperty.call(patchObj, 'peerMessagingMode')) {
    const mode = patchObj.peerMessagingMode;
    if (mode !== 'controlled-p2p' && mode !== 'hub-only') {
      return { ok: false, error: 'invalid peerMessagingMode' };
    }
    next.peerMessagingMode = mode;
  }

  if (Object.prototype.hasOwnProperty.call(patchObj, 'agentProfiles')) {
    const rawProfiles = patchObj.agentProfiles;
    if (typeof rawProfiles !== 'object' || rawProfiles === null || Array.isArray(rawProfiles)) {
      return { ok: false, error: 'agentProfiles must be an object' };
    }
    const nextProfiles: Record<string, OrchestrationAgentProfile> = { ...next.agentProfiles };
    for (const [rawCliId, rawProfile] of Object.entries(rawProfiles as Record<string, unknown>)) {
      const cliId = rawCliId.trim();
      if (
        !cliId ||
        cliId.length > 64 ||
        FORBIDDEN_PROFILE_IDS.has(cliId) ||
        !/^[a-zA-Z0-9._-]+$/.test(cliId)
      ) {
        return { ok: false, error: `invalid agent profile id: ${rawCliId}` };
      }
      if (rawProfile === null) {
        delete nextProfiles[cliId];
        continue;
      }
      if (typeof rawProfile !== 'object' || Array.isArray(rawProfile)) {
        return { ok: false, error: `agentProfiles.${cliId} must be an object` };
      }
      const profileObj = rawProfile as Record<string, unknown>;
      for (const field of Object.keys(profileObj)) {
        if (!ORCHESTRATION_PROFILE_KEYS.has(field)) {
          return { ok: false, error: `unknown agent profile field for ${cliId}: ${field}` };
        }
      }
      const mergedProfile: OrchestrationAgentProfile = { ...(nextProfiles[cliId] ?? {}) };
      if (Object.prototype.hasOwnProperty.call(profileObj, 'enabled')) {
        if (profileObj.enabled === undefined) {
          delete mergedProfile.enabled;
        } else if (typeof profileObj.enabled !== 'boolean') {
          return { ok: false, error: `agentProfiles.${cliId}.enabled must be a boolean` };
        } else {
          mergedProfile.enabled = profileObj.enabled;
        }
      }
      for (const field of ['specialty', 'defaultModel', 'defaultEffort'] as const) {
        if (!Object.prototype.hasOwnProperty.call(profileObj, field)) continue;
        const value = profileObj[field];
        if (value === undefined || value === null) {
          delete mergedProfile[field];
        } else if (typeof value !== 'string') {
          return { ok: false, error: `agentProfiles.${cliId}.${field} must be a string` };
        } else if (field === 'specialty') {
          const collapsed = value.replace(/[\r\n]+/g, ' ').trim();
          if (collapsed.length > 300) {
            return { ok: false, error: `agentProfiles.${cliId}.specialty must be at most 300 characters` };
          }
          if (collapsed) mergedProfile.specialty = collapsed;
          else delete mergedProfile.specialty;
        } else if (field === 'defaultModel') {
          const trimmed = value.trim();
          if (trimmed) {
            if (trimmed.length > 128 || trimmed.startsWith('-') || /[\s\r\n\0]/.test(trimmed)) {
              return { ok: false, error: `invalid agentProfiles.${cliId}.defaultModel` };
            }
            mergedProfile.defaultModel = trimmed;
          } else {
            delete mergedProfile.defaultModel;
          }
        } else if (field === 'defaultEffort') {
          const trimmed = value.trim();
          if (trimmed) {
            if (trimmed.length > 32 || /[\s\r\n\0]/.test(trimmed)) {
              return { ok: false, error: `invalid agentProfiles.${cliId}.defaultEffort` };
            }
            mergedProfile.defaultEffort = trimmed;
          } else {
            delete mergedProfile.defaultEffort;
          }
        }
      }
      if (Object.keys(mergedProfile).length > 0) {
        nextProfiles[cliId] = mergedProfile;
      } else {
        delete nextProfiles[cliId];
      }
    }
    next.agentProfiles = nextProfiles;
  }

  return { ok: true, settings: normalizeOrchestrationSettings(next) };
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

  ipcMain.handle('settings:get-orchestration', async () => {
    return normalizeOrchestrationSettings(getSettings().orchestration);
  });

  ipcMain.handle('settings:set-orchestration', async (_event, patch: OrchestrationSettingsPatch) => {
    const current = normalizeOrchestrationSettings(getSettings().orchestration);
    const result = buildOrchestrationSettingsUpdate(patch, current);
    if (!result.ok) return { ok: false, error: result.error };
    try {
      updateSettings({ orchestration: result.settings });
      broadcastOrchestrationSettingsChanged();
      return { ok: true, settings: result.settings };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
