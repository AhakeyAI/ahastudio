import { randomUUID } from 'node:crypto';
import type { AgentSessionDriver, AgentSessionEvents, AgentSessionPolicy } from '../orchestration/agent-session-driver.js';
import { AcpSessionDriver } from './acp/acp-session-driver.js';
import { ACP_LAUNCH_SPECS, type AcpLaunchSpec } from './acp/acp-dialects.js';
import { resolveAgentCommand, spawnAgentProcess } from './agent-process.js';
import {
  CLAUDE_PARENT_SESSION_ENV_KEYS, CLAUDE_SESSION_ENV, claudeAhaMcpConfig, claudeLaunchArgs,
} from './claude/claude-protocol.js';
import { ClaudeSessionDriver } from './claude/claude-session-driver.js';
import {
  AGENT_DRIVER_IDS, driverCapabilities, normalizeDriverId, type AgentDriverCapabilities, type AgentDriverId,
} from './driver-capabilities.js';
import { PiSessionDriver, piRpcArgs } from './pi/pi-session-driver.js';
import { ahaMcpSecrets } from './secret-redaction.js';

export interface DriverLaunchOptions {
  orchestration: boolean;
  policy: AgentSessionPolicy;
  /** The conversation the process is started to rejoin (Pi takes its session file at launch). */
  resumeSessionId?: string;
  /** Coordinator rules for an orchestrating session; Claude Code takes them at launch. */
  developerInstructions?: string;
}

/** How to start the Aha MCP server over stdio, with the caller's own credentials in `env`. */
export interface AhaMcpServerSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface NativeDriverOptions {
  /**
   * The Aha MCP server for an orchestrating session's process; throws when it cannot start. Without
   * it, a driver's orchestration capability is unused (the manager refuses to switch it on).
   */
  coordinatorMcp?: (sessionId: string) => AhaMcpServerSpec;
}

const AHA_ACP_SERVER_NAME: Readonly<Record<AcpLaunchSpec['driver'], string>> = {
  // Antigravity lets a global terminal `aha` MCP entry shadow a same-named ACP server; a distinct name avoids the collision.
  antigravity: 'aha_orchestration',
  grok: 'aha',
  opencode: 'aha',
};

function acpMcpServers(mcp: AhaMcpServerSpec, name: string) {
  return [{ name, command: mcp.command, args: [...mcp.args], env: Object.entries(mcp.env).map(([k, value]) => ({ name: k, value })) }];
}

function launchClaude(cwd: string, events: AgentSessionEvents, options: {
  policy: AgentSessionPolicy; resumeSessionId?: string; mcp?: AhaMcpServerSpec; role?: 'coordinator' | 'worker'; instructions?: string;
}): ClaudeSessionDriver {
  const { policy, resumeSessionId, mcp, role, instructions } = options;
  const sessionId = resumeSessionId ?? randomUUID();
  return new ClaudeSessionDriver(
    spawnAgentProcess({
      command: 'claude', cwd,
      args: claudeLaunchArgs({
        policy,
        ...(resumeSessionId ? { resumeSessionId } : { sessionId }),
        ...(mcp ? { mcpConfig: claudeAhaMcpConfig(mcp) } : {}),
        ...(instructions ? { appendSystemPrompt: instructions } : {}),
      }),
      env: CLAUDE_SESSION_ENV,
      envToDelete: CLAUDE_PARENT_SESSION_ENV_KEYS,
    }),
    events, {
      sessionId, policy,
      ...(mcp && role ? { ahaMcp: { role, requiredTool: role === 'coordinator' ? 'delegate_task' : 'report_done' }, secrets: ahaMcpSecrets(mcp.env) } : {}),
    },
  );
}

function launchAcp(spec: AcpLaunchSpec, cwd: string, events: AgentSessionEvents, options: {
  mcp?: AhaMcpServerSpec; role?: 'coordinator' | 'worker';
}): AcpSessionDriver {
  const { mcp, role } = options;
  const serverName = AHA_ACP_SERVER_NAME[spec.driver];
  return new AcpSessionDriver(
    spawnAgentProcess({ command: spec.command, args: spec.args, cwd, env: spec.env }), spec, events,
    mcp && role ? { mcpServers: acpMcpServers(mcp, serverName), ahaMcp: { role, serverName }, secrets: ahaMcpSecrets(mcp.env) } : {},
  );
}

/** CLI executable name for a non-Codex headless Worker driver (`antigravity` runs `agy`). */
export function headlessWorkerCommand(cliId: 'claude' | 'antigravity' | 'grok'): string {
  return cliId === 'claude' ? 'claude' : ACP_LAUNCH_SPECS[cliId].command;
}

/**
 * A headless orchestration Worker on Claude Code, Antigravity, or Grok, with the Worker's own Aha
 * MCP credentials in `mcp.env`. Codex Workers use the Codex app-server pilot instead.
 */
export function launchHeadlessWorkerDriver(
  cliId: 'claude' | 'antigravity' | 'grok', cwd: string, events: AgentSessionEvents,
  options: { policy: AgentSessionPolicy; mcp: AhaMcpServerSpec },
): AgentSessionDriver {
  if (cliId === 'claude') return launchClaude(cwd, events, { policy: options.policy, mcp: options.mcp, role: 'worker' });
  return launchAcp(ACP_LAUNCH_SPECS[cliId], cwd, events, { mcp: options.mcp, role: 'worker' });
}

export type DriverLaunch = (sessionId: string, cwd: string, events: AgentSessionEvents, options: DriverLaunchOptions) => AgentSessionDriver;

export interface AgentDriverEntry {
  id: AgentDriverId;
  label: string;
  /** The CLI the driver runs, and the one a terminal continues the conversation in. */
  command: string;
  capabilities: AgentDriverCapabilities;
  launch: DriverLaunch;
}

export interface AgentDriverSummary {
  id: AgentDriverId;
  label: string;
  command: string;
  installed: boolean;
  capabilities: AgentDriverCapabilities;
}

/** Native session drivers by id. Codex stays the default for sessions saved before there were others. */
export class DriverRegistry {
  private readonly entries = new Map<AgentDriverId, AgentDriverEntry>();

  constructor(entries: readonly AgentDriverEntry[], private readonly resolve: (command: string) => string | null = resolveAgentCommand) {
    for (const entry of entries) this.entries.set(entry.id, entry);
  }

  get(id: unknown): AgentDriverEntry {
    const entry = this.entries.get(normalizeDriverId(id));
    if (!entry) throw new Error(`没有可用的会话驱动：${String(id)}`);
    return entry;
  }

  has(id: AgentDriverId): boolean {
    return this.entries.has(id);
  }

  launch(sessionId: string, cwd: string, events: AgentSessionEvents, options: DriverLaunchOptions & { provider: unknown }): AgentSessionDriver {
    return this.get(options.provider).launch(sessionId, cwd, events, options);
  }

  list(): AgentDriverSummary[] {
    return AGENT_DRIVER_IDS.flatMap((id) => {
      const entry = this.entries.get(id);
      if (!entry) return [];
      return [{ id, label: entry.label, command: entry.command, installed: Boolean(this.resolve(entry.command)), capabilities: entry.capabilities }];
    });
  }
}

/** Claude Code, ACP, and Pi drivers, launched as the person's own installed CLIs. */
export function nativeDriverEntries(native: NativeDriverOptions = {}): AgentDriverEntry[] {
  const coordinatorMcp = (sessionId: string, orchestration: boolean): AhaMcpServerSpec | undefined => {
    if (!orchestration) return undefined;
    if (!native.coordinatorMcp) throw new Error('Aha MCP Server is unavailable');
    return native.coordinatorMcp(sessionId);
  };
  const claude: AgentDriverEntry = {
    id: 'claude', label: 'Claude Code', command: 'claude', capabilities: driverCapabilities('claude'),
    launch: (sessionId, cwd, events, { orchestration, policy, resumeSessionId, developerInstructions }) => {
      const mcp = coordinatorMcp(sessionId, orchestration);
      return launchClaude(cwd, events, {
        policy, ...(resumeSessionId ? { resumeSessionId } : {}),
        ...(mcp ? { mcp, role: 'coordinator' as const, ...(developerInstructions ? { instructions: developerInstructions } : {}) } : {}),
      });
    },
  };
  const acp = Object.values(ACP_LAUNCH_SPECS).map((spec): AgentDriverEntry => ({
    id: spec.driver, label: spec.label, command: spec.command, capabilities: driverCapabilities(spec.driver),
    launch: (sessionId, cwd, events, { orchestration }) => {
      const mcp = coordinatorMcp(sessionId, orchestration && driverCapabilities(spec.driver).orchestration);
      return launchAcp(spec, cwd, events, mcp ? { mcp, role: 'coordinator' } : {});
    },
  }));
  const pi: AgentDriverEntry = {
    id: 'pi', label: 'Pi', command: 'pi', capabilities: driverCapabilities('pi'),
    launch: (_sessionId, cwd, events, { policy, resumeSessionId }) => new PiSessionDriver(
      spawnAgentProcess({
        command: 'pi', cwd,
        args: piRpcArgs({ policy, ...(resumeSessionId ? { sessionFile: resumeSessionId } : {}) }),
      }),
      events, { policy },
    ),
  };
  return [claude, ...acp, pi];
}
