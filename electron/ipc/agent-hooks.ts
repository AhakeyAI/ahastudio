import { ipcMain } from 'electron';
import { z } from 'zod';
import { AGENT_HOOK_CLI_IDS, AgentHookInstaller } from '../agent/agent-hook-installer.js';

const cliSchema = z.object({ cliId: z.enum(AGENT_HOOK_CLI_IDS) }).strict();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Served to both the main window and the standalone settings window, like the
// other settings:* channels.
export function registerAgentHooksIpc(installer = new AgentHookInstaller()): void {
  installer.refreshRelayIfInstalled();

  ipcMain.handle('agent-hooks:status', () => {
    try {
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
}
