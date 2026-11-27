import { driverCapabilities, type AgentDriverId } from '../agent-drivers/driver-capabilities.js';
import type { AgentSessionPolicy } from './agent-session-driver.js';
import { coordinatorApprovedMcpTools, workerApprovedMcpTools } from './codex-app-server-pilot.js';

/**
 * Drivers that run session-coordinated Workers headless, over their native protocol, with the Aha
 * MCP server injected per process. OpenCode and Pi are not verified, so their Workers keep the
 * terminal path.
 */
export const HEADLESS_WORKER_DRIVERS = ['codex', 'claude', 'antigravity', 'grok'] as const satisfies readonly AgentDriverId[];
export type HeadlessWorkerDriver = (typeof HEADLESS_WORKER_DRIVERS)[number];

/** A headless Worker's identity: `<driver>-worker-<uuid>`. Codex Workers keep their original prefix. */
export const HEADLESS_WORKER_ID = /^(?:codex|claude|antigravity|grok)-worker-[a-f0-9-]{36}$/;

export function isHeadlessWorkerDriver(cliId: string | null | undefined): cliId is HeadlessWorkerDriver {
  return typeof cliId === 'string' && (HEADLESS_WORKER_DRIVERS as readonly string[]).includes(cliId);
}

/** Whether `cliId` can run a headless Worker that enforces `policy` itself; otherwise the task keeps a terminal. */
export function headlessWorkerSupports(cliId: string | null | undefined, policy: AgentSessionPolicy): boolean {
  return isHeadlessWorkerDriver(cliId) && driverCapabilities(cliId).policies.includes(policy);
}

export function headlessWorkerDriver(workerId: string): HeadlessWorkerDriver | null {
  if (!HEADLESS_WORKER_ID.test(workerId)) return null;
  return workerId.slice(0, workerId.indexOf('-worker-')) as HeadlessWorkerDriver;
}

export const HEADLESS_DRIVER_LABELS: Readonly<Record<HeadlessWorkerDriver, string>> = {
  codex: 'Codex', claude: 'Claude Code', antigravity: 'Antigravity', grok: 'Grok',
};

/**
 * How a non-Codex session answers its own Aha tool call. A Worker runs its dispatch contract without
 * a prompt; any other Aha tool asks the person, except under `full-auto`, which refuses it. A
 * Coordinator runs every Aha tool without a driver prompt, because agents differ in whether they
 * ask at all; the orchestration service gates the ones that change Workers or Git history instead
 * (`sessionGateDecision`), so every driver gets the same rules.
 */
export const AHA_TOOL_DENIED = 'Full-auto cannot ask the person, and this AhaStation tool needs their approval. Ask them to run it, or to switch the session to another permission tier.';

export function ahaToolDecision(
  role: 'coordinator' | 'worker', tool: string, policy: AgentSessionPolicy,
  options: { allowSubWorkers?: boolean } = {},
): 'allow' | 'ask' | 'deny' {
  if (role === 'coordinator') return 'allow';
  if (workerApprovedMcpTools({ policy, allowSubWorkers: options.allowSubWorkers }).includes(tool)) return 'allow';
  return policy === 'full-auto' ? 'deny' : 'ask';
}

/**
 * Coordinator actions a headless Worker may call over HTTP once the person allowed it to start
 * sub-Workers (`allowSubWorkers`); every other Worker keeps the narrow Worker action set.
 */
export const HEADLESS_SUB_WORKER_ACTIONS: ReadonlySet<string> = new Set([
  'agents', 'delegate-task', 'role-message', 'role-manage',
]);

/**
 * Why `driver` cannot run a headless Worker with these controls, or null when it can. Policies
 * come from the driver's own tiers and network access only from drivers that sandbox it per turn.
 */
export function headlessWorkerControlsError(
  driver: HeadlessWorkerDriver, controls: { policy?: AgentSessionPolicy; network?: boolean },
): string | null {
  const caps = driverCapabilities(driver);
  if (controls.policy !== undefined && !caps.policies.includes(controls.policy)) {
    return `${HEADLESS_DRIVER_LABELS[driver]} headless Workers do not support the ${controls.policy} policy.`;
  }
  if (controls.network === true && !caps.network) {
    return `${HEADLESS_DRIVER_LABELS[driver]} headless Workers cannot enable network access.`;
  }
  return null;
}

/** Coordinator actions that change Workers or Git history, by the Aha tool that calls them. */
export const SESSION_GATED_COORDINATOR_ACTIONS: Readonly<Record<string, string>> = {
  'role-manage': 'manage_worker',
  'worker-integrate': 'integrate_worker',
  'run-finalize': 'finalize_run_integration',
};

/**
 * What a non-Codex session Coordinator's policy allows for an action, matching the Codex approval
 * rules (`coordinatorApprovedMcpTools`): `full-auto` pre-approves manage_worker and never the
 * Git-history tools (Codex's `never` approval policy fails them outright); the other tiers ask
 * the person each time.
 */
export function sessionGateDecision(action: string, policy: AgentSessionPolicy): 'allow' | 'ask' | 'deny' {
  const tool = SESSION_GATED_COORDINATOR_ACTIONS[action];
  if (!tool || coordinatorApprovedMcpTools(policy).includes(tool)) return 'allow';
  return policy === 'full-auto' ? 'deny' : 'ask';
}

/**
 * The Aha tool a provider names, if any: Claude says `mcp__aha__<tool>`, ACP agents may use
 * `aha__<tool>`, `aha/<tool>`, `aha.<tool>`, `aha: <tool>`, or the `aha_orchestration` server name
 * (including Antigravity's `mcp_<server>_<tool>` form).
 */
export function parseAhaMcpToolName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const match = /^\s*(?:mcp__(?:aha_orchestration|aha)__|mcp_(?:aha_orchestration|aha)_|(?:aha_orchestration|aha)(?:__|\/|\.|\s*:\s*))([a-z][a-z0-9_]*)\s*$/iu.exec(name);
  return match ? match[1]!.toLowerCase() : null;
}

/** Extracts the human-facing tool or capability name from a driver's approval request method. */
export function approvalToolName(method: string): string {
  if (method.startsWith('session/request_permission/')) {
    return method.slice('session/request_permission/'.length) || method;
  }
  return method.split('/')[1] || method;
}
