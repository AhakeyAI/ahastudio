import { POLICY_LABELS } from '../lib/agent-session-client';
import { proposalControlOptions, type ProposalWorkerControlsDraft } from '../lib/session-capabilities';
import type { AgentSessionPolicy, OrchestrationDispatchProposal, OrchestrationDispatchRecord } from '../types';

export interface ProposalWorkerControlsProps {
  variant: 'board' | 'crew';
  proposal: OrchestrationDispatchProposal;
  agent: string;
  draft: ProposalWorkerControlsDraft;
  dispatches: readonly OrchestrationDispatchRecord[];
  disabled: boolean;
  onChange: (patch: Partial<ProposalWorkerControlsDraft>) => void;
}

/** A proposal card's headless Worker controls: permission tier, network access, and sub-Workers. */
export function ProposalWorkerControls({
  variant, proposal, agent, draft, dispatches, disabled, onChange,
}: ProposalWorkerControlsProps) {
  const options = proposalControlOptions(proposal, agent, dispatches);
  if (!options) return null;
  const roleLabel = proposal.role?.trim().replace(/^@+/, '') || 'worker';
  const selectClass = variant === 'board' ? 'obp-select' : 'aha-crew-select';
  const checkClass = variant === 'board' ? 'wrp-check obp-wt-check' : 'aha-crew-wt-check';
  return (
    <>
      <select
        className={selectClass}
        aria-label={`选择 @${roleLabel} 的权限`}
        title={options.locked ? '审查任务锁定只读' : '无头 Worker 的权限'}
        value={options.locked ? 'read-only' : draft.policy}
        disabled={disabled || options.locked}
        onChange={(event) => onChange({ policy: event.target.value as AgentSessionPolicy })}
      >
        {options.policies.map((value) => (
          <option key={value} value={value}>{POLICY_LABELS[value]}</option>
        ))}
      </select>
      {options.network && (
        <label className={checkClass} title="允许该 Worker 的命令在沙箱内联网">
          <input
            type="checkbox"
            checked={draft.network}
            disabled={disabled}
            onChange={(event) => onChange({ network: event.target.checked })}
          />
          <span>联网</span>
        </label>
      )}
      {options.subWorkers && (
        <label className={checkClass} title="允许该无头 Worker 派发子 Worker（仍受深度上限与派发确认限制）">
          <input
            type="checkbox"
            checked={draft.allowSubWorkers}
            disabled={disabled}
            onChange={(event) => onChange({ allowSubWorkers: event.target.checked })}
          />
          <span>允许子 Worker</span>
        </label>
      )}
    </>
  );
}
