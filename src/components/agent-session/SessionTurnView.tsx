// Turn view, assistant message row, user bubble, and settlement cards for AgentSessionView.
// Paced streaming reveal, collapsible settled turn summaries, live reasoning disclosure, and
// restrained assistant controls adapted from Orca (https://github.com/stablyai/orca, MIT).
// FreshSessionDivider adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.).
// See THIRD_PARTY_NOTICES.md.

import { memo, useCallback, useMemo, useRef, useState } from 'react';
import {
  ArrowUp,
  BellRing,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  Eraser,
  FileText,
  Hourglass,
  Image as ImageIcon,
  Minimize2,
  PencilLine,
  Sparkles,
} from 'lucide-react';
import { countDiffStats, parseUnifiedDiff } from '../../lib/git-panel-model';
import { describeTurnActivity, planTurnFold } from '../../lib/session-turn-model';
import { formatWorkRunSentence } from '../../lib/session-work-log-model';
import { summarizeTurnChanges } from '../../lib/turn-changes';
import {
  groupTimelineItems,
  splitDiffByFile,
  splitDispatchPrompt,
  splitSystemWake,
} from '../../lib/worker-timeline-model';
import type {
  WorkerTimelineFileChange,
  WorkerTimelineItem,
  WorkerTimelineTurn,
} from '../../types';
import { CopyButton, DiffBlock } from './SessionCode';
import { SessionMarkdown } from './SessionMarkdown';
import { SessionPacedMarkdown } from './SessionPacedMarkdown';
import { SessionTurnActivityLine, SessionTurnStatusBar } from './SessionTurnChrome';
import { FileChangeRows, SessionNoticeRow, WorkGroup, WorkItemRow } from './SessionWorkLog';
import { TurnChangesCard } from './TurnChangesCard';
import { useAgentSession } from './session-context';
import { useSessionDisclosure } from './session-disclosure-store';

const LONG_PROMPT_CHARS = 1200;
const LONG_PROMPT_LINES = 16;

type Item<K extends WorkerTimelineItem['kind']> = Extract<WorkerTimelineItem, { kind: K }>;

function formatClockTime(timestamp: number | null): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return '';
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatFullTime(timestamp: number | null): string | undefined {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toLocaleString();
}

/** Hover actions under a user message; shown by CSS so rows hold no hover state. */
function MessageActions({ text, onEdit }: { text: string; onEdit?: () => void }) {
  if (!text.trim()) return null;
  return (
    <span className="asv-msg-actions">
      <CopyButton text={text} label="复制" className="asv-act" />
      {onEdit && (
        <button
          type="button"
          className="asv-act"
          aria-label="编辑后重发"
          title="编辑后重发（填回输入框，不会自动发送）"
          onClick={onEdit}
        >
          <PencilLine size={13} />
        </button>
      )}
    </span>
  );
}

function UserBubble({
  text,
  caption,
  attachments,
  editable = false,
}: {
  text: string;
  caption?: string;
  attachments?: WorkerTimelineTurn['attachments'];
  editable?: boolean;
}) {
  const { editMessage } = useAgentSession();
  const parts = useMemo(() => splitDispatchPrompt(text), [text]);
  const long = parts.body.length > LONG_PROMPT_CHARS || parts.body.split('\n').length > LONG_PROMPT_LINES;
  const [expanded, setExpanded] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const origin = parts.system ? (parts.followUp ? '追加派发' : '编排派发') : null;
  return (
    <div className="asv-user" data-asv-row>
      {parts.body && (
        <div className={`asv-bubble${long && !expanded ? ' is-clamped' : ''}`}>
          <SessionMarkdown text={parts.body} variant="bubble" />
        </div>
      )}
      {attachments && attachments.length > 0 && (
        <div className="asv-user-attachments">
          {attachments.map((item, index) => (
            <span key={`${item.kind}:${item.name}:${index}`} className={`asv-attach-pill is-${item.kind}`}>
              {item.kind === 'skill' ? <Sparkles size={11} aria-hidden="true" />
                : item.kind === 'image' ? <ImageIcon size={11} aria-hidden="true" /> : <FileText size={11} aria-hidden="true" />}
              {item.kind === 'skill' ? `$${item.name}` : item.name}
            </span>
          ))}
        </div>
      )}
      {(parts.body || long || parts.system || caption) && (
        <div className="asv-user-meta">
          <MessageActions
            text={parts.body}
            {...(editable && editMessage && !parts.system ? { onEdit: () => editMessage(parts.body) } : {})}
          />
          {long && (
            <button type="button" className="asv-text-btn" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
              {expanded ? '收起' : '展开全部'}
            </button>
          )}
          {parts.system && (
            <button type="button" className="asv-text-btn" aria-expanded={showSystem} onClick={() => setShowSystem((value) => !value)}>
              <ChevronRight size={11} className="asv-text-btn-chevron" aria-hidden="true" />
              编排指令
            </button>
          )}
          {[origin, caption].filter(Boolean).join(' · ')}
        </div>
      )}
      {showSystem && parts.system && <pre className="asv-system">{parts.system}</pre>}
    </div>
  );
}

function SettlementBlock({ item }: { item: Item<'settlement'> }) {
  const [showDiff, setShowDiff] = useState(false);
  const files = useMemo<WorkerTimelineFileChange[]>(
    () =>
      showDiff && item.diff
        ? splitDiffByFile(item.diff).map((file) => ({
            path: file.path,
            change: 'update',
            movePath: null,
            diff: file.diff,
            truncated: false,
            ...countDiffStats(parseUnifiedDiff(file.diff)),
          }))
        : [],
    [showDiff, item.diff],
  );
  if (item.settlement === 'report_done') {
    const ok = item.outcome === 'completed' && item.verdict !== 'reject';
    return (
      <div className={`asv-settle ${ok ? 'is-ok' : 'is-bad'}`} data-asv-row>
        <div className="asv-settle-head">
          {ok ? <CircleCheck size={15} /> : <CircleAlert size={15} />}
          <span className="asv-settle-title">已提交结果</span>
          {item.outcome && <span className="asv-tag">{item.outcome}</span>}
          {item.verdict && <span className="asv-tag">verdict · {item.verdict}</span>}
        </div>
        {item.summary && <SessionMarkdown text={item.summary} linkifyFilePaths />}
        {item.findings.length > 0 && (
          <ul className="asv-findings">
            {item.findings.map((finding, i) => <li key={i}>{finding}</li>)}
          </ul>
        )}
      </div>
    );
  }
  return (
    <div className="asv-settle is-pending" data-asv-row>
      <div className="asv-settle-head">
        <Hourglass size={15} />
        <span className="asv-settle-title">本轮已结束，结果待确认</span>
        {item.stopReason && <span className="asv-tag">{item.stopReason}</span>}
      </div>
      <div className="asv-settle-note">Worker 没有调用 report_done。请先核对输出与差异，再决定下一步。</div>
      {item.diff !== null && (
        <>
          <button type="button" className="asv-text-btn" aria-expanded={showDiff} onClick={() => setShowDiff((value) => !value)}>
            <ChevronRight size={11} className="asv-text-btn-chevron" aria-hidden="true" />
            {item.diffSource === 'git' ? '工作区差异（git diff）' : '工作区差异'}
          </button>
          {showDiff && (
            !item.diff.trim() ? <div className="asv-settle-note">工作区没有差异</div>
              : files.length === 1 && !files[0]!.path ? <DiffBlock diff={item.diff} />
                : <FileChangeRows files={files} />
          )}
        </>
      )}
    </div>
  );
}

/** Restrained assistant message row: paced streaming reveal, action bar hidden while streaming/running. */
const AssistantMessageRow = memo(function AssistantMessageRow({
  item,
  rowKey,
  turnRunning,
  showActions,
  isLatestResponse,
}: {
  item: Extract<WorkerTimelineItem, { kind: 'message' }>;
  rowKey: string;
  turnRunning: boolean;
  showActions: boolean;
  isLatestResponse: boolean;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const streaming = item.status === 'running';
  const canShowControls = !streaming && !turnRunning && showActions && item.text.trim().length > 0;
  const clock = formatClockTime(item.completedAt);
  const scrollToTop = useCallback(() => {
    rowRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }, []);

  return (
    <div
      ref={rowRef}
      className="asv-assistant"
      data-asv-row
      data-asv-assistant-id={canShowControls ? rowKey : undefined}
    >
      <SessionPacedMarkdown
        rowKey={rowKey}
        text={item.text}
        streaming={streaming}
        linkifyFilePaths
      />
      {canShowControls && (
        <div className={`asv-assistant-foot${isLatestResponse ? ' is-latest' : ''}`}>
          <span className={`asv-msg-actions${isLatestResponse ? ' is-visible' : ''}`}>
            <CopyButton text={item.text} label="复制" className="asv-act" />
            <button
              type="button"
              className="asv-act"
              aria-label="滚动到此回复顶部"
              title="滚动到此回复顶部"
              onClick={scrollToTop}
            >
              <ArrowUp size={13} />
            </button>
            {clock && (
              <time
                className="asv-msg-time"
                dateTime={new Date(item.completedAt!).toISOString()}
                title={formatFullTime(item.completedAt)}
              >
                {clock}
              </time>
            )}
          </span>
        </div>
      )}
    </div>
  );
});

const TimelineItem = memo(function TimelineItem({
  item,
  inlineDiff,
  turnKey,
  turnRunning,
  isAnswer,
  latestResponseKey,
}: {
  item: WorkerTimelineItem;
  inlineDiff: boolean;
  turnKey: string;
  turnRunning: boolean;
  isAnswer: boolean;
  latestResponseKey: string | null;
}) {
  if (item.kind === 'settlement') return <SettlementBlock item={item} />;
  if (item.kind !== 'message') {
    return <WorkItemRow item={item} inlineDiff={inlineDiff} turnKey={turnKey} turnRunning={turnRunning} />;
  }
  if (item.role === 'user') return <UserBubble text={item.text} caption="追加指令" />;
  const rowKey = `${turnKey}:${item.id}`;
  return (
    <AssistantMessageRow
      item={item}
      rowKey={rowKey}
      turnRunning={turnRunning}
      showActions={isAnswer}
      isLatestResponse={latestResponseKey === rowKey}
    />
  );
});

/** A turn AhaStation started (Worker news, stall reminder): shown apart from what the person typed. */
function SystemWakeRow({ text, generation }: { text: string; generation: number }) {
  const body = useMemo(() => splitSystemWake(text).body, [text]);
  return (
    <div className="asv-wake" data-asv-row>
      <div className="asv-wake-head">
        <BellRing size={12} aria-hidden="true" />
        <span className="asv-wake-label">系统唤醒</span>
        <span>第 {generation} 轮 · AhaStation 自动发送，不算你的回复</span>
      </div>
      <SessionMarkdown text={body} variant="bubble" />
    </div>
  );
}

/** Marks where `/clear` started a fresh provider thread while keeping earlier turns visible (adapted from T3 Code `FreshSessionRow`, MIT). */
const FreshSessionDivider = memo(function FreshSessionDivider() {
  return (
    <div className="asv-fresh-divider" role="separator" aria-label="新上下文">
      <span className="asv-fresh-divider-line" aria-hidden="true" />
      <span className="asv-fresh-divider-label">
        <Eraser size={11} aria-hidden="true" />
        <span>新上下文</span>
      </span>
      <span className="asv-fresh-divider-line" aria-hidden="true" />
    </div>
  );
});

export const TurnView = memo(function TurnView({
  turn,
  minHeight,
  stopping = false,
  latestResponseKey = null,
}: {
  turn: WorkerTimelineTurn;
  minHeight?: number;
  stopping?: boolean;
  latestResponseKey?: string | null;
}) {
  const { cwd } = useAgentSession();
  const running = turn.status === 'running';
  const changes = useMemo(() => (running ? null : summarizeTurnChanges(turn.items, cwd)), [running, turn.items, cwd]);
  const hasCard = Boolean(changes?.files.length);
  const fold = useMemo(() => planTurnFold(turn, { hasChangesCard: hasCard }), [turn, hasCard]);
  const turnDisclosure = useSessionDisclosure(`turn:${turn.key}`, false);
  const expanded = running || !fold.foldable || turnDisclosure.open;
  const activity = useMemo(() => describeTurnActivity(turn, { stopping: running && stopping }), [turn, running, stopping]);
  const liveReasoningId = activity?.reasoning?.item.id ?? null;
  const visibleItems = useMemo(
    () =>
      turn.items.filter((item) => {
        if (liveReasoningId && item.id === liveReasoningId) return false;
        if (!expanded && fold.foldedItemIds.has(item.id)) return false;
        return true;
      }),
    [turn.items, liveReasoningId, expanded, fold.foldedItemIds],
  );
  const blocks = useMemo(() => groupTimelineItems(visibleItems), [visibleItems]);
  const summaryHint = useMemo(
    () => (fold.foldable ? formatWorkRunSentence(fold.foldedItems, { live: false }) : ''),
    [fold],
  );
  const isCompactTurn = turn.commandKind === 'compact';
  const renderBlock = (block: (typeof blocks)[number]) =>
    block.type === 'group' ? (
      <WorkGroup key={block.id} block={block} turnKey={turn.key} turnRunning={running} />
    ) : (
      <TimelineItem
        key={block.item.id}
        item={block.item}
        inlineDiff={!hasCard}
        turnKey={turn.key}
        turnRunning={running}
        isAnswer={fold.answerItemIds.has(block.item.id)}
        latestResponseKey={latestResponseKey}
      />
    );
  const isSettlement = (block: (typeof blocks)[number]) => block.type === 'item' && block.item.kind === 'settlement';

  return (
    <section className={`asv-turn is-${turn.status}`} aria-label={`第 ${turn.generation} 轮`} style={minHeight ? { minHeight } : undefined}>
      {turn.freshContext && <FreshSessionDivider />}
      {turn.origin === 'system' ? (
        <SystemWakeRow text={turn.prompt} generation={turn.generation} />
      ) : isCompactTurn ? (
        <div className="asv-turn-cmd" data-asv-row>
          <Minimize2 size={12} aria-hidden="true" />
          <span>压缩上下文</span>
          <span className="asv-turn-cmd-meta">第 {turn.generation} 轮 · /compact</span>
        </div>
      ) : (
        <UserBubble text={turn.prompt} caption={`第 ${turn.generation} 轮`} attachments={turn.attachments} editable={turn.commandKind !== 'goal'} />
      )}
      <SessionTurnStatusBar
        turn={turn}
        foldable={fold.foldable}
        expanded={turnDisclosure.open}
        summaryHint={summaryHint}
        onToggleExpanded={fold.foldable ? () => turnDisclosure.setOpen(!turnDisclosure.open) : undefined}
      />
      {turn.itemsTrimmed && <div className="asv-turn-note">部分较早的过程记录已截断</div>}
      {blocks.filter((block) => !isSettlement(block)).map(renderBlock)}
      {hasCard && <TurnChangesCard changes={changes!} />}
      {blocks.filter(isSettlement).map(renderBlock)}
      {!running && turn.error && (
        <SessionNoticeRow level={turn.status === 'failed' ? 'error' : 'warning'} text={turn.error} />
      )}
      {activity && <SessionTurnActivityLine turnKey={turn.key} activity={activity} />}
    </section>
  );
});
