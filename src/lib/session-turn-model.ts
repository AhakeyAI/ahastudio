// Adapted from Orca (https://github.com/stablyai/orca),
// native-chat-turn-status.ts, native-chat-turn-fold.ts, native-chat-reasoning-row.ts,
// and native-chat-live-line.ts. Copyright (c) 2026 Lovecast Inc. — MIT License.
// See THIRD_PARTY_NOTICES.md.

import type { WorkerTimelineItem, WorkerTimelineTurn } from '../types';

/** Whole-second turn duration: `0s`, `42s`, `3m 05s`, `1h 02m`. */
export function formatTurnDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const remSeconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${String(remSeconds).padStart(2, '0')}s`;
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${String(remMinutes).padStart(2, '0')}m`;
}

export interface SessionTurnStatusView {
  active: boolean;
  tone: 'running' | 'completed' | 'interrupted' | 'failed';
  label: string;
}

/** Label for the turn working status bar beneath the prompt. */
export function describeTurnStatus(
  turn: Pick<WorkerTimelineTurn, 'status' | 'startedAt' | 'completedAt' | 'commandKind'>,
  elapsedSeconds: number,
): SessionTurnStatusView {
  if (turn.status === 'running') {
    const duration = formatTurnDuration(Math.max(0, elapsedSeconds) * 1000);
    const verb = turn.commandKind === 'compact' ? '正在压缩上下文' : '正在工作';
    return { active: true, tone: 'running', label: `${verb} ${duration}` };
  }
  const durationMs = turn.completedAt !== null ? Math.max(0, turn.completedAt - turn.startedAt) : null;
  const duration = durationMs !== null ? formatTurnDuration(durationMs) : '';
  if (turn.status === 'interrupted') {
    return {
      active: false,
      tone: 'interrupted',
      label: duration ? `已中断 · 用时 ${duration}` : '已中断',
    };
  }
  if (turn.status === 'failed') {
    return {
      active: false,
      tone: 'failed',
      label: duration ? `已失败 · 用时 ${duration}` : '已失败',
    };
  }
  return {
    active: false,
    tone: 'completed',
    label: duration ? `已工作 ${duration}` : '已完成',
  };
}

/** Combine a reasoning item's summary and raw text without duplicating identical strings. */
export function reasoningMarkdown(
  item: Pick<Extract<WorkerTimelineItem, { kind: 'reasoning' }>, 'summary' | 'text'>,
): string {
  const summary = item.summary.trim();
  const text = item.text.trim();
  if (summary && text) {
    return summary === text ? summary : `${summary}\n\n${text}`;
  }
  return summary || text;
}

/** One stable disclosure key per reasoning item, shared by the live activity line and finished row. */
export function reasoningDisclosureKey(turnKey: string, itemId: string): string {
  return `reasoning:${turnKey}:${itemId}`;
}

export function describeReasoningHeadline(
  item: Pick<Extract<WorkerTimelineItem, { kind: 'reasoning' }>, 'status' | 'startedAt' | 'completedAt'>,
  options: { turnRunning: boolean },
): string {
  if (options.turnRunning && item.status === 'running') {
    return '思考中';
  }
  if (item.status === 'completed' && item.startedAt !== null && item.completedAt !== null) {
    const seconds = Math.max(1, Math.round((item.completedAt - item.startedAt) / 1000));
    return `思考了 ${formatTurnDuration(seconds * 1000)}`;
  }
  return '已思考';
}

export interface LiveTurnReasoning {
  item: Extract<WorkerTimelineItem, { kind: 'reasoning' }>;
  markdown: string;
}

/**
 * Newest non-notice item of a running turn when it is an active reasoning block.
 * Owned exclusively by the live activity line so the row never renders twice.
 */
export function selectLiveTurnReasoning(
  turn: Pick<WorkerTimelineTurn, 'status' | 'items'>,
): LiveTurnReasoning | null {
  if (turn.status !== 'running') return null;
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index]!;
    if (item.kind === 'notice') continue;
    if (item.kind !== 'reasoning') return null;
    if (item.status !== 'running') return null;
    return { item, markdown: reasoningMarkdown(item) };
  }
  return null;
}

export interface LiveTurnActivity {
  label: string;
  thinking: boolean;
  stopping: boolean;
  reasoning: LiveTurnReasoning | null;
}

/** Tail live activity line for a running turn; hidden while waiting on a pending approval. */
export function describeTurnActivity(
  turn: Pick<WorkerTimelineTurn, 'status' | 'commandKind' | 'items'>,
  options: { stopping?: boolean } = {},
): LiveTurnActivity | null {
  if (turn.status !== 'running') return null;
  const awaitingApproval = turn.items.some(
    (item) => item.kind === 'approval' && item.status === 'pending',
  );
  if (awaitingApproval) return null;
  if (options.stopping) {
    return { label: '正在停止…', thinking: false, stopping: true, reasoning: null };
  }
  const reasoning = selectLiveTurnReasoning(turn);
  if (reasoning) {
    return { label: '思考中', thinking: true, stopping: false, reasoning };
  }
  for (let index = turn.items.length - 1; index >= 0; index -= 1) {
    const item = turn.items[index]!;
    if (item.kind === 'tool_call' && item.status === 'running' && item.progress?.trim()) {
      return {
        label: item.progress.trim(),
        thinking: false,
        stopping: false,
        reasoning: null,
      };
    }
  }
  return {
    label: turn.commandKind === 'compact' ? '正在压缩上下文…' : '工作中…',
    thinking: false,
    stopping: false,
    reasoning: null,
  };
}

function itemHasFailure(item: WorkerTimelineItem): boolean {
  switch (item.kind) {
    case 'command':
      return item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0);
    case 'tool_call':
      return item.status === 'failed' || Boolean(item.error);
    case 'file_change':
      return item.status === 'failed';
    case 'approval':
      return item.status === 'denied' || item.status === 'expired';
    case 'notice':
      return item.level === 'error';
    default:
      return false;
  }
}

function isAssistantProse(item: WorkerTimelineItem): boolean {
  return item.kind === 'message' && item.role === 'assistant' && item.text.trim().length > 0;
}

/**
 * Identify concluding assistant answer messages in a turn:
 * the last prose reply, any reply right before a mid-turn user steer,
 * and back-to-back replies (including pieces split only by reasoning).
 */
export function selectTurnAnswerItemIds(items: readonly WorkerTimelineItem[]): ReadonlySet<string> {
  const answers = new Set<string>();
  let latestAnswerId: string | null = null;
  let previousVisible: { id: string; index: number; isProse: boolean } | null = null;
  let lastThoughtIndex = -1;
  const splitFrom = new Map<string, string>();

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]!;
    if (item.kind === 'message' && item.role === 'user') {
      if (latestAnswerId !== null) {
        answers.add(latestAnswerId);
        latestAnswerId = null;
      }
      previousVisible = { id: item.id, index, isProse: false };
      continue;
    }
    if (item.kind === 'reasoning') {
      lastThoughtIndex = index;
      continue;
    }
    if (item.kind === 'notice' && item.level === 'info') {
      continue;
    }
    const prose = isAssistantProse(item);
    if (prose && previousVisible?.isProse) {
      if (lastThoughtIndex > previousVisible.index) {
        splitFrom.set(item.id, previousVisible.id);
      } else {
        answers.add(previousVisible.id);
      }
    }
    previousVisible = { id: item.id, index, isProse: prose };
    if (prose) {
      latestAnswerId = item.id;
    }
  }

  if (latestAnswerId !== null) {
    answers.add(latestAnswerId);
  }
  // Keep every piece of a final reply that was split only by thinking.
  for (const id of [...answers]) {
    let prev = splitFrom.get(id);
    while (prev !== undefined && !answers.has(prev)) {
      answers.add(prev);
      prev = splitFrom.get(prev);
    }
  }
  return answers;
}

export interface TurnFoldPlan {
  foldable: boolean;
  foldedItemIds: ReadonlySet<string>;
  foldedItems: readonly WorkerTimelineItem[];
  answerItemIds: ReadonlySet<string>;
}

/**
 * Determine which intermediate items fold behind a settled turn's status bar.
 * Running turns never fold. Pending approvals, final answers, plans, settlements,
 * warnings/errors, and unexplained failures are never hidden.
 */
export function planTurnFold(
  turn: Pick<WorkerTimelineTurn, 'status' | 'items'>,
  options: { hasChangesCard: boolean },
): TurnFoldPlan {
  const answerItemIds = selectTurnAnswerItemIds(turn.items);
  if (turn.status === 'running') {
    return {
      foldable: false,
      foldedItemIds: new Set(),
      foldedItems: [],
      answerItemIds,
    };
  }

  const hasExplanation =
    answerItemIds.size > 0 || turn.items.some((item) => item.kind === 'settlement');
  const foldedItemIds = new Set<string>();
  const foldedItems: WorkerTimelineItem[] = [];

  for (const item of turn.items) {
    // Always keep user steers, final answers, plans, settlements, and pending approvals visible.
    if (item.kind === 'settlement' || item.kind === 'plan') continue;
    if (item.kind === 'message' && item.role === 'user') continue;
    if (item.kind === 'message' && answerItemIds.has(item.id)) continue;
    if (item.kind === 'approval' && item.status === 'pending') continue;
    // Warnings, errors, and compaction markers stay visible outside the fold.
    if (item.kind === 'notice' && (item.level !== 'info' || item.text.includes('上下文已压缩'))) {
      continue;
    }
    // Never hide unexplained failures when the turn produced no prose or settlement explaining them.
    if (!hasExplanation && itemHasFailure(item)) continue;
    // Keep file_change visible if no TurnChangesCard summarizes its diffs.
    if (item.kind === 'file_change' && !options.hasChangesCard && item.files.length > 0) continue;

    foldedItemIds.add(item.id);
    foldedItems.push(item);
  }

  return {
    foldable: foldedItemIds.size > 0,
    foldedItemIds,
    foldedItems,
    answerItemIds,
  };
}
