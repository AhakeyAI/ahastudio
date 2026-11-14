import { useSyncExternalStore } from 'react';
import { AlertCircle, Check, CircleHelp, KeyRound, LoaderCircle, ShieldQuestion } from 'lucide-react';
import { agentStatusClient } from '../lib/agent-status-client';
import { agentStatusLabel, agentStatusTooltip, isAgentStatusVisible } from '../lib/agent-status-view';
import type { AgentPaneStatus } from '../types';

export function useAgentStatuses() {
  useSyncExternalStore(agentStatusClient.subscribe, agentStatusClient.getSnapshot, agentStatusClient.getSnapshot);
  return agentStatusClient;
}

function StatusIcon({ status, size }: { status: AgentPaneStatus; size: number }) {
  switch (status.state) {
    case 'working':
      return <LoaderCircle size={size} className="agent-badge-spin" />;
    case 'waiting':
      return status.waitKind === 'question' ? (
        <CircleHelp size={size} />
      ) : status.waitKind === 'auth' ? (
        <KeyRound size={size} />
      ) : (
        <ShieldQuestion size={size} />
      );
    case 'done':
      return <Check size={size} />;
    case 'error':
      return <AlertCircle size={size} />;
    default:
      return <span className="agent-badge-dot" />;
  }
}

/**
 * Compact agent lifecycle indicator. `variant="icon"` renders only the glyph,
 * `variant="label"` adds the state text.
 */
export function AgentStatusBadge({
  status,
  variant = 'icon',
  size = 12,
}: {
  status: AgentPaneStatus | null | undefined;
  variant?: 'icon' | 'label';
  size?: number;
}) {
  if (!isAgentStatusVisible(status)) return null;
  const label = agentStatusLabel(status);
  return (
    <span
      className={`agent-badge is-${status.state} ${status.unread ? 'is-unread' : ''} is-${variant}`}
      title={agentStatusTooltip(status)}
      role="status"
      aria-label={`${label}${status.unread ? '（未读）' : ''}`}
    >
      <StatusIcon status={status} size={size} />
      {variant === 'label' && <span className="agent-badge-text">{label}</span>}
    </span>
  );
}
