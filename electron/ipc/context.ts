import type { BrowserWindow } from 'electron';
import type { AgentStatusStore } from '../agent/agent-status-store.js';
import type { PtyWriteFn } from '../agent/agent-prompt-delivery.js';
import type { DaemonSessionConfig } from '../daemon-terminal-sessions.js';
import type { LocalCliId } from '../local-cli.js';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';

export interface IpcContext {
  liveWindow: () => BrowserWindow | null;
  getCurrentCwd: () => string | undefined;
  daemon?: DaemonSessionConfig;
  userDataDir?: () => string;
  agentStatusStore?: AgentStatusStore;
  agentHookEnv?: (ptyId: string, cliId?: LocalCliId) => Record<string, string>;
  sendPtyInput?: PtyWriteFn;
  orchestrationService?: OrchestrationService;
}
