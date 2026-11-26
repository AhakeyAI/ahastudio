import type { AgentDriverCapabilities, AgentDriverId, AgentSessionInfo, AgentSessionPolicy } from '../types';

/** Codex's own set, assumed for sessions a main process reported without capabilities. */
export const CODEX_CAPABILITIES: AgentDriverCapabilities = {
  policies: ['workspace-write', 'read-only', 'full-auto'], policyNeedsRelaunch: false, network: true, models: true,
  efforts: true, images: true, compact: true, goal: true, feedback: true, usageLimits: true, skills: true,
  plugins: true, history: true, orchestration: true, rename: true, resume: true, terminalResume: true,
};

export const SESSION_DRIVER_IDS: readonly AgentDriverId[] = ['codex', 'claude', 'antigravity', 'grok', 'opencode', 'pi'];

export const DRIVER_LABELS: Record<AgentDriverId, string> = {
  codex: 'Codex',
  claude: 'Claude Code',
  antigravity: 'Antigravity',
  grok: 'Grok',
  opencode: 'OpenCode',
  pi: 'Pi',
};

export function sessionCapabilities(info: Pick<AgentSessionInfo, 'capabilities'> | null | undefined): AgentDriverCapabilities {
  return info?.capabilities ?? CODEX_CAPABILITIES;
}

/** The policy picker's choices: only the tiers the driver enforces, in its own order. */
export function policyChoices(capabilities: AgentDriverCapabilities, labels: Record<AgentSessionPolicy, string>) {
  return capabilities.policies.map((value) => ({ value, label: labels[value] }));
}

/** The tier a new session of this driver starts in when the person asked for `wanted`. */
export function initialPolicy(capabilities: AgentDriverCapabilities, wanted: AgentSessionPolicy): AgentSessionPolicy {
  if (capabilities.policies.includes(wanted)) return wanted;
  if (wanted === 'read-only' && capabilities.policies.includes('workspace-write')) return 'workspace-write';
  return capabilities.policies[0] ?? wanted;
}
