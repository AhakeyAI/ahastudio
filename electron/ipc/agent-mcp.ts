import { existsSync, watch, type FSWatcher } from 'node:fs';
import { basename, dirname } from 'node:path';
import { z } from 'zod';
import { AGENT_MCP_CLI_IDS, AgentMcpInstaller } from '../agent/agent-mcp-installer.js';
import { handleSecure, mainWindowSenderPolicy, type SenderPolicy } from './validators.js';

const cliSchema = z.object({ cliId: z.enum(AGENT_MCP_CLI_IDS) }).strict();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface RegisterAgentMcpIpcOptions {
  authorize?: SenderPolicy;
  /** Optional main window id getter when caller wants main-window-only authorization. */
  getMainWindowId?: () => number | null;
}

// Served to both the main window and the standalone settings window by default
// (like settings:* and agent-hooks:*), with optional sender policy injection.
export function registerAgentMcpIpc(
  installer = new AgentMcpInstaller(),
  opts: RegisterAgentMcpIpcOptions = {},
): { dispose: () => void } {
  installer.refreshServerIfInstalled();

  let watcher: FSWatcher | null = null;
  const sourceDir = dirname(installer.sourcePath);
  const sourceFile = basename(installer.sourcePath);
  if (existsSync(sourceDir)) {
    try {
      watcher = watch(sourceDir, (_eventType, filename) => {
        if (!filename || filename === sourceFile) {
          installer.refreshServerIfInstalled();
        }
      });
      watcher.on('error', () => {
        /* ignore watcher errors when directory is unavailable or inside asar */
      });
      watcher.unref?.();
    } catch {
      /* ignore when source directory cannot be watched */
    }
  }

  const authorize =
    opts.authorize ?? (opts.getMainWindowId ? mainWindowSenderPolicy(opts.getMainWindowId) : undefined);

  handleSecure('agent-mcp:status', {
    authorize,
    handler: () => {
      installer.refreshServerIfInstalled();
      return { ok: true, statuses: installer.listStatus() };
    },
  });

  handleSecure('agent-mcp:install', {
    authorize,
    schema: cliSchema,
    handler: (input) => {
      try {
        return { ok: true, status: installer.install(input.cliId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error), status: installer.status(input.cliId) };
      }
    },
  });

  handleSecure('agent-mcp:uninstall', {
    authorize,
    schema: cliSchema,
    handler: (input) => {
      try {
        return { ok: true, status: installer.uninstall(input.cliId) };
      } catch (error) {
        return { ok: false, error: errorMessage(error), status: installer.status(input.cliId) };
      }
    },
  });

  return {
    dispose: () => {
      watcher?.close();
      watcher = null;
    },
  };
}
