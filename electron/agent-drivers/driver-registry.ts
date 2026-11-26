import type { AgentSessionDriver, AgentSessionEvents, AgentSessionPolicy } from '../orchestration/agent-session-driver.js';
import { AcpSessionDriver } from './acp/acp-session-driver.js';
import { ACP_LAUNCH_SPECS } from './acp/acp-dialects.js';
import { resolveAgentCommand, spawnAgentProcess } from './agent-process.js';
import {
  AGENT_DRIVER_IDS, driverCapabilities, normalizeDriverId, type AgentDriverCapabilities, type AgentDriverId,
} from './driver-capabilities.js';
import { PiSessionDriver, piRpcArgs } from './pi/pi-session-driver.js';

export interface DriverLaunchOptions {
  orchestration: boolean;
  policy: AgentSessionPolicy;
  /** The conversation the process is started to rejoin (Pi takes its session file at launch). */
  resumeSessionId?: string;
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

/** ACP and Pi drivers, launched as the person's own installed CLIs. */
export function nativeDriverEntries(): AgentDriverEntry[] {
  const acp = Object.values(ACP_LAUNCH_SPECS).map((spec): AgentDriverEntry => ({
    id: spec.driver, label: spec.label, command: spec.command, capabilities: driverCapabilities(spec.driver),
    launch: (_sessionId, cwd, events) =>
      new AcpSessionDriver(spawnAgentProcess({ command: spec.command, args: spec.args, cwd, env: spec.env }), spec, events),
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
  return [...acp, pi];
}
