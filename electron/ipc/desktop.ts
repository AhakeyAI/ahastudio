import { app, clipboard, ipcMain, nativeTheme, webContents } from 'electron';
import { requestMicrophoneAccess } from '../microphone-access.js';
import { getSettings, updateSettings, type Settings } from '../store.js';

export interface UiPreferencesPatch {
  handheldMode?: 'auto' | 'desktop' | 'handheld';
}

export function buildUiPreferencesUpdate(
  patch: UiPreferencesPatch,
): { ok: true; next: Partial<Settings> } | { ok: false; error: string } {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) {
    return { ok: false, error: 'UI preferences patch must be an object' };
  }
  for (const key of Object.keys(patch)) {
    if (key !== 'handheldMode') return { ok: false, error: `unknown UI preference: ${key}` };
  }
  if (!Object.prototype.hasOwnProperty.call(patch, 'handheldMode')) return { ok: true, next: {} };
  if (patch.handheldMode !== 'auto' && patch.handheldMode !== 'desktop' && patch.handheldMode !== 'handheld') {
    return { ok: false, error: 'invalid handheldMode' };
  }
  return { ok: true, next: { handheldMode: patch.handheldMode } };
}

export function registerDesktopIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('clipboard:read', async () => {
    const [text, hasPng, hasJpeg] = await Promise.all([
      clipboard.readText().catch(() => ''),
      clipboard.has('image/png').catch(() => false),
      clipboard.has('image/jpeg').catch(() => false),
    ]);
    return { text, hasImage: hasPng || hasJpeg };
  });

  ipcMain.handle('clipboard:write-text', async (_event, text: unknown) => {
    if (typeof text === 'string') await clipboard.writeText(text);
  });

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('mic:request-permission', async () => {
    return await requestMicrophoneAccess(true);
  });

  ipcMain.handle('theme:set-source', (_event, source: unknown) => {
    if (source === 'system' || source === 'light' || source === 'dark') {
      nativeTheme.themeSource = source;
    }
    return { shouldUseDarkColors: nativeTheme.shouldUseDarkColors };
  });
  nativeTheme.on('updated', () => {
    for (const wc of webContents.getAllWebContents()) {
      wc.send('theme:changed', { shouldUseDarkColors: nativeTheme.shouldUseDarkColors });
    }
  });

  ipcMain.handle('settings:get-ui-preferences', () => ({
    handheldMode: getSettings().handheldMode ?? 'auto',
  }));

  ipcMain.handle('settings:set-ui-preferences', (_event, patch: UiPreferencesPatch) => {
    const result = buildUiPreferencesUpdate(patch);
    if (!result.ok) return { ok: false, error: result.error };
    try {
      updateSettings(result.next);
      for (const wc of webContents.getAllWebContents()) wc.send('settings:ui-preferences-changed');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
