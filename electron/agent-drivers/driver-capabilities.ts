import type { AgentSessionPolicy } from '../orchestration/agent-session-driver.js';

export const AGENT_DRIVER_IDS = ['codex', 'claude', 'antigravity', 'grok', 'opencode', 'pi'] as const;
export type AgentDriverId = (typeof AGENT_DRIVER_IDS)[number];

/**
 * What a session's driver can actually do. The composer and slash menu show a control only when
 * its flag is on, so no driver offers a button it would refuse.
 */
export interface AgentDriverCapabilities {
  /** Permission tiers the driver enforces; the first is the default. */
  policies: readonly AgentSessionPolicy[];
  /** A policy change restarts the agent process (and resumes its conversation). */
  policyNeedsRelaunch: boolean;
  /** Sandboxed commands may be allowed onto the network per turn. */
  network: boolean;
  models: boolean;
  efforts: boolean;
  /** Images go to the model as images; otherwise saved images are named by path like any file. */
  images: boolean;
  compact: boolean;
  goal: boolean;
  feedback: boolean;
  usageLimits: boolean;
  skills: boolean;
  plugins: boolean;
  /** Past conversations of this folder can be listed and reopened from the provider's store. */
  history: boolean;
  /** Runs as an orchestration Coordinator through Aha MCP. */
  orchestration: boolean;
  /** The provider stores the session's title. */
  rename: boolean;
  /** The conversation can be rejoined after its process ends. */
  resume: boolean;
  /** The CLI can continue the same conversation in a terminal pane. */
  terminalResume: boolean;
}

const NONE: Omit<AgentDriverCapabilities, 'policies'> = {
  policyNeedsRelaunch: false, network: false, models: false, efforts: false, images: false, compact: false,
  goal: false, feedback: false, usageLimits: false, skills: false, plugins: false, history: false,
  orchestration: false, rename: false, resume: false, terminalResume: false,
};

export const AGENT_DRIVER_CAPABILITIES: Readonly<Record<AgentDriverId, AgentDriverCapabilities>> = {
  codex: {
    policies: ['workspace-write', 'read-only', 'full-auto'], policyNeedsRelaunch: false, network: true, models: true,
    efforts: true, images: true, compact: true, goal: true, feedback: true, usageLimits: true, skills: true,
    plugins: true, history: true, orchestration: true, rename: true, resume: true, terminalResume: true,
  },
  // Claude Code runs over bidirectional stream-json stdio with live permission modes and can_use_tool prompts.
  // Orchestration: Aha MCP per process via `--mcp-config`, Coordinator rules via `--append-system-prompt`.
  claude: {
    ...NONE, policies: ['workspace-write', 'read-only', 'full-auto'], models: true, efforts: true, images: true,
    compact: true, orchestration: true, rename: true, resume: true, terminalResume: true,
  },
  // ACP agents ask through session/request_permission; AhaStation answers by policy or asks the person.
  // No orchestration: Antigravity accepts ACP `mcpServers` but never starts them.
  antigravity: {
    ...NONE, policies: ['workspace-write', 'full-auto'], models: true, efforts: true, images: true, resume: true,
    terminalResume: true,
  },
  // Effort is each agent's `thought_level` session option. Orchestration: Grok starts the ACP
  // `mcpServers` it is given on session/new|load|resume; ACP has no system prompt, so the
  // Coordinator rules lead the first message of each process.
  grok: {
    ...NONE, policies: ['workspace-write', 'full-auto'], models: true, efforts: true, images: true, compact: true,
    orchestration: true, resume: true, terminalResume: true,
  },
  // OpenCode's read-only tier is its own `plan` mode, with every permission request refused as well.
  // No orchestration until its ACP `mcpServers` support is verified.
  opencode: {
    ...NONE, policies: ['workspace-write', 'read-only', 'full-auto'], models: true, compact: true, resume: true,
    terminalResume: true,
  },
  // Pi never asks before using a tool, so its only tiers are its read-only tool set or all tools.
  // No orchestration: its RPC mode has no per-process MCP configuration.
  pi: {
    ...NONE, policies: ['full-auto', 'read-only'], policyNeedsRelaunch: true, models: true, efforts: true,
    images: true, compact: true, rename: true, resume: true, terminalResume: true,
  },
};

/** Stored sessions from before multiple drivers had no provider (or the `acp` placeholder): they are Codex. */
export function normalizeDriverId(value: unknown): AgentDriverId {
  return typeof value === 'string' && (AGENT_DRIVER_IDS as readonly string[]).includes(value)
    ? value as AgentDriverId
    : 'codex';
}

export function driverCapabilities(id: AgentDriverId): AgentDriverCapabilities {
  return AGENT_DRIVER_CAPABILITIES[id];
}

/** The tier a driver runs when asked for one it does not enforce. */
export function supportedPolicy(id: AgentDriverId, wanted: AgentSessionPolicy): AgentSessionPolicy {
  const { policies } = AGENT_DRIVER_CAPABILITIES[id];
  if (policies.includes(wanted)) return wanted;
  // Never widen: a refused read-only falls back to asking, never to running unasked.
  if (wanted === 'read-only' && policies.includes('workspace-write')) return 'workspace-write';
  return policies[0]!;
}

/** The command that continues `providerSessionId` in a terminal, or null when the CLI cannot. */
export function terminalResumeArgs(id: AgentDriverId, providerSessionId: string): string[] | null {
  if (!providerSessionId.trim() || providerSessionId.startsWith('-')) return null;
  switch (id) {
    case 'codex': return ['resume', providerSessionId];
    case 'claude': return ['--resume', providerSessionId];
    case 'antigravity': return ['--conversation', providerSessionId];
    case 'grok': return ['--resume', providerSessionId];
    case 'opencode': return ['--session', providerSessionId];
    // Pi resumes from the session file it reported, not an id.
    case 'pi': return ['--session', providerSessionId];
  }
}
