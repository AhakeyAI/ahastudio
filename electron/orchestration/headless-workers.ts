import { resolve } from 'node:path';
import {
  driverCapabilities, type AgentDriverCapabilities, type AgentDriverId,
} from '../agent-drivers/driver-capabilities.js';
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

/** Why a driver cannot take a headless Worker turn, for callers that report or branch on it. */
export interface HeadlessWorkerRefusal {
  code: 'driver_not_headless' | 'policy_unsupported' | 'resume_unsupported' | 'no_provider_session' | 'cwd_bound_session';
  message: string;
}

function driverLabel(cliId: string): string {
  return isHeadlessWorkerDriver(cliId) ? HEADLESS_DRIVER_LABELS[cliId] : cliId;
}

/** Why `cliId` cannot run a headless Worker that enforces `policy` itself, or null when it can. */
export function headlessWorkerSupportError(
  cliId: string | null | undefined, policy: AgentSessionPolicy,
): HeadlessWorkerRefusal | null {
  if (!isHeadlessWorkerDriver(cliId)) {
    return { code: 'driver_not_headless', message: `${cliId || 'This agent'} has no headless Worker support.` };
  }
  if (!driverCapabilities(cliId).policies.includes(policy)) {
    return { code: 'policy_unsupported', message: `${driverLabel(cliId)} headless Workers do not enforce the ${policy} policy.` };
  }
  return null;
}

/** Whether `cliId` can run a headless Worker that enforces `policy` itself; otherwise the task keeps a terminal. */
export function headlessWorkerSupports(cliId: string | null | undefined, policy: AgentSessionPolicy): boolean {
  return headlessWorkerSupportError(cliId, policy) === null;
}

/** `path` in a form two spellings of the same directory compare equal in (case-insensitive on Windows). */
export function comparablePath(path: string): string {
  const resolved = resolve(path);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sameCwd(a: string, b: string): boolean {
  return comparablePath(a) === comparablePath(b);
}

/**
 * Why a headless Worker's provider conversation cannot be resumed natively in `cwd`, or null when
 * it can. Drivers that key sessions by directory (`resumeAcrossCwd: false`) only resume where the
 * conversation started; callers fall back to a portable context handoff instead.
 */
export function headlessResumeError(
  cliId: string | null | undefined,
  input: { providerSessionId: string | null | undefined; sessionCwd: string; cwd: string },
): HeadlessWorkerRefusal | null {
  if (!isHeadlessWorkerDriver(cliId)) {
    return { code: 'driver_not_headless', message: `${cliId || 'This agent'} has no headless Worker support.` };
  }
  const caps = driverCapabilities(cliId);
  if (!caps.resume || caps.nativeThreadIds === 'none') {
    return { code: 'resume_unsupported', message: `${driverLabel(cliId)} cannot rejoin a conversation after its process ends.` };
  }
  if (!input.providerSessionId?.trim()) {
    return { code: 'no_provider_session', message: `This ${driverLabel(cliId)} Worker has no provider conversation to resume.` };
  }
  if (!caps.resumeAcrossCwd && !sameCwd(input.sessionCwd, input.cwd)) {
    return {
      code: 'cwd_bound_session',
      message: `${driverLabel(cliId)} keys conversations by working directory, so it cannot resume this one from another worktree.`,
    };
  }
  return null;
}

/**
 * The provider's ids for an AhaStation-owned conversation. AhaStation ids stay the identity;
 * these are evidence for resuming or reconciling, never keys.
 */
export interface ProviderRefs {
  driver: AgentDriverId;
  /** How far `sessionId` can be trusted to name the same conversation later. */
  idStrength: AgentDriverCapabilities['nativeThreadIds'];
  sessionId: string | null;
  turnId?: string;
  requestId?: string;
}

export function providerRefs(
  driver: AgentDriverId,
  ids: { sessionId?: string | null; turnId?: string | null; requestId?: string | null },
): ProviderRefs {
  return {
    driver,
    idStrength: driverCapabilities(driver).nativeThreadIds,
    sessionId: ids.sessionId?.trim() || null,
    ...(ids.turnId?.trim() ? { turnId: ids.turnId.trim() } : {}),
    ...(ids.requestId?.trim() ? { requestId: ids.requestId.trim() } : {}),
  };
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
 * sub-Workers (`allowSubWorkers`); every other Worker keeps the narrow Worker action set. Stopping,
 * releasing, and approving (`role-manage`) stay with the Coordinator, where the person gates them.
 */
export const HEADLESS_SUB_WORKER_ACTIONS: ReadonlySet<string> = new Set([
  'agents', 'delegate-task', 'role-message',
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
