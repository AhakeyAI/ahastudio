import type {
  AgentDriverCapabilities, AgentDriverId, AgentSessionInfo, AgentSessionPolicy, OrchestrationDispatchProposal,
  OrchestrationDispatchRecord,
} from '../types';

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

/** What a headless Worker of each driver can switch: its permission tiers and per-turn network access. */
export interface HeadlessWorkerControlCapabilities {
  policies: readonly AgentSessionPolicy[];
  network: boolean;
}

// Mirrors the main process's driver capabilities for HEADLESS_WORKER_DRIVERS; a test keeps them equal.
const HEADLESS_WORKER_CONTROLS: Partial<Record<AgentDriverId, HeadlessWorkerControlCapabilities>> = {
  codex: { policies: ['workspace-write', 'read-only', 'full-auto'], network: true },
  claude: { policies: ['workspace-write', 'read-only', 'full-auto'], network: false },
  antigravity: { policies: ['workspace-write', 'full-auto'], network: false },
  grok: { policies: ['workspace-write', 'full-auto'], network: false },
};

/** A driver's headless Worker controls, or null when its Workers run in a terminal. */
export function headlessWorkerControls(cliId: string | null | undefined): HeadlessWorkerControlCapabilities | null {
  return cliId ? HEADLESS_WORKER_CONTROLS[cliId as AgentDriverId] ?? null : null;
}

/** What the person picked on a dispatch proposal for a headless Worker. */
export interface ProposalWorkerControlsDraft {
  policy: AgentSessionPolicy;
  network: boolean;
  allowSubWorkers: boolean;
}

type ProposalControlsSource = Pick<
  OrchestrationDispatchProposal, 'taskKind' | 'policy' | 'network' | 'allowSubWorkers' | 'coordinatorPaneId'
>;

/** What the proposal asked for; read-only for review and research tasks unless it named a tier. */
export function proposalControlsDefault(proposal: ProposalControlsSource): ProposalWorkerControlsDraft {
  return {
    policy: proposal.policy ??
      (proposal.taskKind === 'review' || proposal.taskKind === 'research' ? 'read-only' : 'workspace-write'),
    network: proposal.network === true,
    allowSubWorkers: proposal.allowSubWorkers === true,
  };
}

/**
 * Which Worker controls a proposal card offers for `agent`: none for terminal-only drivers, the
 * driver's own tiers, network only where the driver sandboxes it, and sub-Workers only when the
 * Worker would still have depth left (its proposer is not itself a Worker) and it is not a review.
 */
export function proposalControlOptions(
  proposal: ProposalControlsSource, agent: string, dispatches: readonly Pick<OrchestrationDispatchRecord, 'assigneeHandle' | 'assigneePaneId'>[],
): { policies: readonly AgentSessionPolicy[]; network: boolean; subWorkers: boolean; locked: boolean } | null {
  const caps = headlessWorkerControls(agent);
  if (!caps) return null;
  if (proposal.taskKind === 'review') return { policies: ['read-only'], network: false, subWorkers: false, locked: true };
  const fromWorker = dispatches.some((d) =>
    d.assigneeHandle === proposal.coordinatorPaneId || d.assigneePaneId === proposal.coordinatorPaneId);
  const initial = proposalControlsDefault(proposal).policy;
  // An implied tier the driver lacks (read-only on Antigravity) stays listed: left alone, the task keeps a
  // terminal. A tier the Coordinator named explicitly is not, since the driver would refuse it.
  const policies = caps.policies.includes(initial) || proposal.policy != null ? caps.policies : [initial, ...caps.policies];
  return { policies, network: caps.network, subWorkers: !fromWorker, locked: false };
}

/**
 * The draft as `agent` can run it: a tier, network access, or sub-Worker opt-in the driver (or this
 * proposal) cannot take falls back to what it can, so switching the agent never leaves a stale choice.
 */
export function proposalDraftForAgent(
  proposal: ProposalControlsSource, agent: string, draft: ProposalWorkerControlsDraft,
  dispatches: readonly Pick<OrchestrationDispatchRecord, 'assigneeHandle' | 'assigneePaneId'>[],
): ProposalWorkerControlsDraft {
  const options = proposalControlOptions(proposal, agent, dispatches);
  if (!options) return draft;
  return {
    policy: options.policies.includes(draft.policy) ? draft.policy : options.policies[0]!,
    network: options.network && draft.network,
    allowSubWorkers: options.subWorkers && draft.allowSubWorkers,
  };
}

/** The overrides to approve with: only what the person changed, and only what the driver supports. */
export function proposalControlOverrides(
  proposal: ProposalControlsSource, agent: string, rawDraft: ProposalWorkerControlsDraft,
  dispatches: readonly Pick<OrchestrationDispatchRecord, 'assigneeHandle' | 'assigneePaneId'>[],
): { policy?: AgentSessionPolicy; network?: boolean; allowSubWorkers?: boolean } {
  const options = proposalControlOptions(proposal, agent, dispatches);
  if (!options || options.locked) return {};
  const draft = proposalDraftForAgent(proposal, agent, rawDraft, dispatches);
  const initial = proposalControlsDefault(proposal);
  return {
    ...(draft.policy !== initial.policy && headlessWorkerControls(agent)!.policies.includes(draft.policy)
      ? { policy: draft.policy } : {}),
    ...(options.network
      ? draft.network !== initial.network ? { network: draft.network } : {}
      // A driver without per-turn network access drops what the Coordinator asked for.
      : initial.network ? { network: false } : {}),
    ...(options.subWorkers && draft.allowSubWorkers !== initial.allowSubWorkers
      ? { allowSubWorkers: draft.allowSubWorkers } : {}),
  };
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
