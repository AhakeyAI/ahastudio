import { ipcMain } from 'electron';
import { watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { AGENT_HOOK_CLI_IDS, AgentHookInstaller } from '../agent/agent-hook-installer.js';

const cliSchema = z.object({ cliId: z.enum(AGENT_HOOK_CLI_IDS) }).strict();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Served to both the main window and the standalone settings window, like the
// other settings:* channels.
export function registerAgentHooksIpc(installer = new AgentHookInstaller()): { dispose: () => void } {
  installer.refreshRelayIfInstalled();

  let watcher: FSWatcher | null = null;
  const sourceFile = basename(installer.sourcePath);
  try {
    watcher = watch(dirname(installer.sourcePath), (_eventType, filename) => {
      if (!filename || filename === sourceFile) {
        installer.refreshRelayIfInstalled();
      }
    });
    watcher.on('error', () => {
      /* ignore watcher errors when directory is unavailable or inside asar */
    });
    watcher.unref?.();
  } catch {
    /* ignore when source directory cannot be watched */
  }

  ipcMain.handle('agent-hooks:status', () => {
    try {
      installer.refreshRelayIfInstalled();
      return { ok: true, statuses: installer.listStatus() };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  });

  ipcMain.handle('agent-hooks:install', (_e, raw: unknown) => {
    const parsed = cliSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Invalid IPC payload' };
    try {
      return { ok: true, status: installer.install(parsed.data.cliId) };
    } catch (error) {
      return { ok: false, error: errorMessage(error), status: installer.status(parsed.data.cliId) };
    }
  });

  ipcMain.handle('agent-hooks:uninstall', (_e, raw: unknown) => {
    const parsed = cliSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, error: 'Invalid IPC payload' };
    try {
      return { ok: true, status: installer.uninstall(parsed.data.cliId) };
    } catch (error) {
      return { ok: false, error: errorMessage(error), status: installer.status(parsed.data.cliId) };
    }
  });

  return {
    dispose: () => {
      watcher?.close();
      watcher = null;
    },
  };
}
