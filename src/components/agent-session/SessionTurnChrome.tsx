// Ported/adapted from Orca (https://github.com/stablyai/orca),
// NativeChatWorkingStatus.tsx, NativeChatTurnActivityLine.tsx, and NativeChatReasoningDisclosure.tsx.
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import { memo, useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useSharedNow } from '../../hooks/useSharedNow';
import {
  describeTurnStatus,
  reasoningDisclosureKey,
  type LiveTurnActivity,
} from '../../lib/session-turn-model';
import type { WorkerTimelineTurn } from '../../types';
import { SessionMarkdown } from './SessionMarkdown';
import { useSessionDisclosure } from './session-disclosure-store';

/** Turn working clock beneath the prompt; once settled with folded steps, toggles turn process details. */
export const SessionTurnStatusBar = memo(function SessionTurnStatusBar({
  status: turnStatus,
  startedAt,
  completedAt,
  commandKind,
  foldable,
  expanded,
  onToggleExpanded,
}: {
  status: WorkerTimelineTurn['status'];
  startedAt: number;
  completedAt: number | null;
  commandKind?: WorkerTimelineTurn['commandKind'];
  foldable: boolean;
  expanded: boolean;
  onToggleExpanded?: () => void;
}) {
  const active = turnStatus === 'running';
  const now = useSharedNow(1_000, active);
  const [fallbackStartedAt] = useState(() => Date.now());
  const elapsedSeconds = active
    ? Math.max(0, Math.floor((now - (startedAt > 0 ? startedAt : fallbackStartedAt)) / 1000))
    : 0;
  const status = describeTurnStatus({ status: turnStatus, startedAt, completedAt, commandKind }, elapsedSeconds);
  const interactive = !active && foldable && Boolean(onToggleExpanded);

  const inner = (
    <>
      {active && <span className="asv-turn-bar-dot" aria-hidden="true" />}
      <span className={`asv-turn-bar-label is-${status.tone}`}>{status.label}</span>
      {interactive && (
        <ChevronRight
          size={13}
          className="asv-turn-bar-chevron"
          aria-hidden="true"
        />
      )}
    </>
  );

  if (interactive) {
    return (
      <div className="asv-turn-bar-wrap" data-asv-row data-open={expanded || undefined}>
        <button
          type="button"
          className={`asv-turn-bar is-interactive is-${status.tone}`}
          data-asv-turn-status="settled"
          aria-expanded={expanded}
          data-asv-disclosure-scope-trigger="true"
          aria-label={`${status.label}，展开或收起本轮过程详情`}
          onClick={onToggleExpanded}
        >
          {inner}
        </button>
      </div>
    );
  }

  return (
    <div
      className={`asv-turn-bar is-${status.tone}`}
      data-asv-turn-status={active ? 'active' : 'settled'}
      aria-label={active ? `正在响应：${status.label}` : undefined}
    >
      {inner}
    </div>
  );
});

/** Bounded scrollable body for streaming and finished reasoning disclosures. */
export function SessionReasoningBody({
  markdown,
  disclosureKey,
  streaming = false,
}: {
  markdown: string;
  disclosureKey?: string;
  streaming?: boolean;
}) {
  return (
    <div className="asv-reasoning-body" data-asv-tone="faint">
      <SessionMarkdown
        text={markdown}
        variant="muted"
        streaming={streaming}
        linkifyFilePaths
        rowKey={disclosureKey}
      />
    </div>
  );
}

/** Tail activity indicator for a running turn, owning the live streaming reasoning disclosure when thinking. */
export const SessionTurnActivityLine = memo(function SessionTurnActivityLine({
  turnKey,
  activity,
}: {
  turnKey: string;
  activity: LiveTurnActivity;
}) {
  const labelId = useId();
  const { reasoning } = activity;
  const hasReasoningBody = Boolean(reasoning && reasoning.markdown.trim().length > 0);
  const disclosureKey = reasoning ? reasoningDisclosureKey(turnKey, reasoning.item.id) : undefined;
  const disclosure = useSessionDisclosure(disclosureKey, false);
  const open = hasReasoningBody && disclosure.open;

  return (
    <div
      className="asv-activity"
      data-asv-row
      data-asv-turn-activity="true"
      data-open={open || undefined}
    >
      <div
        className={`asv-activity-line${hasReasoningBody ? ' is-disclosable' : ''}`}
        aria-live="polite"
        aria-atomic="true"
      >
        <span className="asv-spinner" aria-hidden="true" />
        <span
          id={labelId}
          className={`asv-activity-label${activity.stopping ? ' is-stopping' : ' asv-shimmer'}`}
        >
          {activity.label}
        </span>
        {hasReasoningBody && (
          <>
            <ChevronRight size={13} className="asv-activity-chevron" aria-hidden="true" />
            <button
              type="button"
              className="asv-activity-trigger"
              aria-labelledby={labelId}
              aria-expanded={open}
              onClick={() => disclosure.setOpen(!open)}
            />
          </>
        )}
      </div>
      {open && reasoning && (
        <SessionReasoningBody
          markdown={reasoning.markdown}
          disclosureKey={disclosureKey}
          streaming
        />
      )}
    </div>
  );
});
