import { app, ipcMain } from 'electron';
import { requestMicrophoneAccess } from '../microphone-access.js';

export function registerDesktopIpc(): void {
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('app:relaunch', () => {
    app.relaunch();
    app.exit(0);
  });

  ipcMain.handle('mic:request-permission', async () => {
    return await requestMicrophoneAccess(true);
  });
}
