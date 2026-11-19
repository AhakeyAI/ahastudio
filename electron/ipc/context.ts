import type { BrowserWindow } from 'electron';
import type { AgentStatusStore } from '../agent/agent-status-store.js';
import type { PtyWriteFn } from '../agent/agent-prompt-delivery.js';
import type { DaemonSessionConfig } from '../daemon-terminal-sessions.js';
import type { OrchestrationCliId } from '../local-cli.js';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import type { TerminalRuntimeTracker } from '../terminal-runtime-tracker.js';

export interface IpcContext {
  liveWindow: () => BrowserWindow | null;
  getCurrentCwd: () => string | undefined;
  daemon?: DaemonSessionConfig;
  userDataDir?: () => string;
  agentStatusStore?: AgentStatusStore;
  agentHookEnv?: (ptyId: string, cliId?: OrchestrationCliId) => Record<string, string>;
  mcpLaunchArgsForCli?: (cliId: OrchestrationCliId) => string[];
  sendPtyInput?: PtyWriteFn;
  orchestrationService?: OrchestrationService;
  terminalTracker?: TerminalRuntimeTracker;
}
