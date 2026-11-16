// Minimal stub of the parts of `electron` that the orchestrator's transitive
// imports touch at module load time. Tests that write settings receive an
// isolated userData directory rather than racing on a shared /tmp/settings.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let userData;
function testUserData() {
  if (!userData) {
    userData = mkdtempSync(join(tmpdir(), 'aha-test-userdata-'));
    process.once('exit', () => rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  }
  return userData;
}

export const app = {
  getPath: name => name === 'userData' ? testUserData() : '/tmp',
  isPackaged: false,
};
export const ipcMain = { handle: () => {}, on: () => {} };
export const desktopCapturer = {};
export const systemPreferences = {
  getMediaAccessStatus: () => 'granted',
  askForMediaAccess: async () => true,
};
export const shell = {
  openExternal: async () => {},
  openPath: async () => '',
  showItemInFolder: () => {},
};
export const dialog = { showMessageBox: async () => ({ response: 1 }) };
export const BrowserWindow = class {
  static getFocusedWindow() { return null; }
};
export const safeStorage = {
  isEncryptionAvailable: () => true,
  encryptString: value => Buffer.from(`encrypted:${value}`, 'utf8'),
  decryptString: value => {
    const text = value.toString('utf8');
    if (!text.startsWith('encrypted:')) throw new Error('invalid encrypted test value');
    return text.slice('encrypted:'.length);
  },
};
export const screen = { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1080 } }) };
export const nativeTheme = { shouldUseDarkColors: false, themeSource: 'system', on: () => {}, removeListener: () => {} };
export const webContents = { fromId: () => null };

export default { app, ipcMain, dialog, desktopCapturer, systemPreferences, shell, BrowserWindow, safeStorage, screen, nativeTheme, webContents };
