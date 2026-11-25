// Semantic tool-run sentences, clickable file target pills, call outcome counts, lazy details,
// bounded reasoning disclosure, and notice cards adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import { memo, useLayoutEffect, useRef, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import {
  Bot,
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  CircleX,
  Eye,
  FilePenLine,
  Folder,
  Globe,
  Info,
  ListChecks,
  ListTodo,
  Plug,
  Search,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SquareTerminal,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import { useSharedNow } from '../../hooks/useSharedNow';
import {
  describeReasoningHeadline,
  reasoningDisclosureKey,
  reasoningMarkdown,
} from '../../lib/session-turn-model';
import {
  describeWorkItemLine,
  extractInlineDiffFromText,
  formatLazyToolArgs,
  summarizeDisplayPath,
  summarizeWorkRun,
  type WorkIconName,
} from '../../lib/session-work-log-model';
import {
  fileChangeTotals,
  formatDuration,
  formatElapsed,
  unwrapShellCommand,
  type TimelineBlock,
} from '../../lib/worker-timeline-model';
import type { WorkerTimelineFileChange, WorkerTimelineItem } from '../../types';
import { DiffBlock } from './SessionCode';
import { SessionMarkdown } from './SessionMarkdown';
import { SessionReasoningBody } from './SessionTurnChrome';
import { openSessionTarget, useAgentSession } from './session-context';
import { useSessionDisclosure } from './session-disclosure-store';

type Item<K extends WorkerTimelineItem['kind']> = Extract<WorkerTimelineItem, { kind: K }>;

const ICON = { size: 15, strokeWidth: 1.75 } as const;
const LIVE_EDGE_PX = 4;

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';

function WorkGlyph({ name, size = ICON.size }: { name: WorkIconName; size?: number }) {
  const props = { size, strokeWidth: ICON.strokeWidth, 'aria-hidden': true as const };
  switch (name) {
    case 'brain': return <Brain {...props} />;
    case 'eye': return <Eye {...props} />;
    case 'search': return <Search {...props} />;
    case 'folder': return <Folder {...props} />;
    case 'square-terminal': return <SquareTerminal {...props} />;
    case 'pencil': return <FilePenLine {...props} />;
    case 'globe': return <Globe {...props} />;
    case 'plug': return <Plug {...props} />;
    case 'bot': return <Bot {...props} />;
    case 'list-checks': return <ListChecks {...props} />;
    case 'wrench': return <Wrench {...props} />;
  }
}

/** Shared visibility-gated second timer; rows only mount it for work that is still running. */
export function LiveTimer({ startedAt }: { startedAt: number }) {
  const now = useSharedNow(1_000, true);
  return <span className="asv-row-time">{formatElapsed(startedAt, now)}</span>;
}

/** Clickable workspace file pill inside a work-log row; stops propagation so opening does not toggle the row. */
export function SessionToolFileTarget({
  path,
  label,
  openable = true,
}: {
  path: string;
  label?: string;
  openable?: boolean;
}) {
  const session = useAgentSession();
  const shown = label ?? summarizeDisplayPath(path);
  if (!openable) {
    return (
      <span className="asv-file-pill is-static" title={path}>
        {shown}
      </span>
    );
  }
  const open = (event: MouseEvent | KeyboardEvent) => {
    event.stopPropagation();
    void openSessionTarget(path, session);
  };
  return (
    <span
      role="link"
      tabIndex={0}
      className="asv-file-pill"
      title={path}
      aria-label={`打开文件 ${path}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          open(event);
        }
      }}
    >
      {shown}
    </span>
  );
}

function Trailing({
  item,
  bad,
}: {
  item: { status: string; durationMs?: number | null; startedAt: number | null; completedAt: number | null };
  bad?: ReactNode;
}) {
  if (item.status === 'running') return item.startedAt ? <LiveTimer startedAt={item.startedAt} /> : null;
  const duration = item.durationMs ?? (item.startedAt && item.completedAt ? item.completedAt - item.startedAt : null);
  return (
    <>
      {item.status === 'declined' ? <span className="asv-row-bad">已拒绝</span> : bad}
      {duration !== null && duration >= 100 && <span className="asv-row-time">{formatDuration(duration)}</span>}
    </>
  );
}

/** One borderless line of the work log; details mount lazily only when open. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  tone,
  wrap = false,
  defaultOpen = false,
  disclosureKey,
  hasDetail,
  renderDetail,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  tone?: 'bad' | 'warn';
  wrap?: boolean;
  defaultOpen?: boolean;
  disclosureKey?: string;
  hasDetail?: boolean;
  /** Lazily evaluated only when the row is expanded, avoiding work on collapsed rows. */
  renderDetail?: () => ReactNode;
  children?: ReactNode;
}) {
  const { open, setOpen } = useSessionDisclosure(disclosureKey, defaultOpen);
  const expandable = hasDetail ?? Boolean(renderDetail || children);
  const line = (
    <>
      <span className="asv-row-icon">{icon}</span>
      <span className={`asv-row-label${wrap ? ' is-wrap' : ''}`}>{label}</span>
      {trailing && <span className="asv-row-trailing">{trailing}</span>}
      {expandable && <ChevronRight size={13} className="asv-row-chevron" aria-hidden="true" />}
    </>
  );
  return (
    <div className="asv-row" data-asv-row data-open={open || undefined} data-tone={tone}>
      {expandable ? (
        <button type="button" className="asv-row-line" aria-expanded={open} onClick={() => setOpen(!open)}>
          {line}
        </button>
      ) : (
        <div className="asv-row-line">{line}</div>
      )}
      {expandable && open && <div className="asv-row-detail">{renderDetail ? renderDetail() : children}</div>}
    </div>
  );
}

/** Output that keeps its newest line in view while it streams, unless the reader scrolled up. */
function LiveOutput({ text, live }: { text: string; live: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const atEdge = useRef(true);
  useLayoutEffect(() => {
    const el = ref.current;
    if (live && atEdge.current && el) el.scrollTop = el.scrollHeight;
  });
  return (
    <pre
      ref={ref}
      className="asv-output"
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atEdge.current = scrollHeight - scrollTop - clientHeight <= LIVE_EDGE_PX;
      }}
    >
      {text}
    </pre>
  );
}

function ReasoningRow({
  item,
  turnKey,
  turnRunning,
}: {
  item: Item<'reasoning'>;
  turnKey?: string;
  turnRunning: boolean;
}) {
  const live = turnRunning && item.status === 'running';
  const body = reasoningMarkdown(item);
  const preview = firstLine(body).replace(/^[#*\s]+|\*+$/g, '');
  const headline = describeReasoningHeadline(item, { turnRunning });
  const key = turnKey ? reasoningDisclosureKey(turnKey, item.id) : undefined;
  return (
    <WorkLogRow
      icon={<Brain {...ICON} />}
      disclosureKey={key}
      hasDetail={Boolean(body)}
      label={
        <>
          <span className={live ? 'asv-shimmer' : undefined}>{headline}</span>
          {preview && <span className="asv-row-dim">{preview}</span>}
        </>
      }
      trailing={live && item.startedAt ? <LiveTimer startedAt={item.startedAt} /> : undefined}
      renderDetail={() => (
        <SessionReasoningBody markdown={body} disclosureKey={key} streaming={live} />
      )}
    />
  );
}

function CommandDetail({ item, display, live }: { item: Item<'command'>; display: string; live: boolean }) {
  const inlineDiff = !live ? extractInlineDiffFromText(item.output) : null;
  return (
    <>
      {item.cwd && <div className="asv-detail-note is-mono">{item.cwd}</div>}
      {(display !== item.command.trim() || display.includes('\n')) && (
        <pre className="asv-output is-command">{item.command}</pre>
      )}
      {inlineDiff ? (
        <DiffBlock diff={inlineDiff} />
      ) : (
        item.output && <LiveOutput text={item.output} live={live} />
      )}
      {item.outputTruncated && <div className="asv-detail-note">输出较长，已截断</div>}
    </>
  );
}

function CommandRow({ item, turnKey }: { item: Item<'command'>; turnKey?: string }) {
  const live = item.status === 'running';
  const display = unwrapShellCommand(item.command);
  const failed = item.exitCode !== null && item.exitCode !== 0;
  const line = describeWorkItemLine(item);
  const hasDetail = Boolean(item.output || item.cwd || display !== item.command.trim() || display.includes('\n'));
  const disclosureKey = turnKey ? `item:${turnKey}:${item.id}` : undefined;
  return (
    <WorkLogRow
      icon={<WorkGlyph name={line.icon} />}
      tone={failed || item.status === 'failed' ? 'bad' : undefined}
      disclosureKey={disclosureKey}
      hasDetail={hasDetail}
      label={
        <>
          {line.verb && <span className={live ? 'asv-shimmer' : undefined}>{line.verb}</span>}
          {line.fileTarget ? (
            <SessionToolFileTarget
              path={line.fileTarget.path}
              label={line.fileTarget.label}
              openable={line.fileTarget.openable}
            />
          ) : line.codeStyle ? (
            <code className={`asv-row-code${live && !line.verb ? ' asv-shimmer' : ''}`} title={line.targetTitle}>
              {line.target}
            </code>
          ) : (
            <span className="asv-row-dim" title={line.targetTitle}>{line.target}</span>
          )}
        </>
      }
      trailing={<Trailing item={item} bad={failed ? <span className="asv-row-bad">exit {item.exitCode}</span> : null} />}
      renderDetail={() => <CommandDetail item={item} display={display} live={live} />}
    />
  );
}

function ToolDetail({ item, live, filePath }: { item: Item<'tool_call'>; live: boolean; filePath?: string }) {
  const inlineDiff =
    extractInlineDiffFromText(item.args) ?? (!live ? extractInlineDiffFromText(item.output) : null);
  const formattedArgs = item.args ? formatLazyToolArgs(item.args) : '';
  return (
    <>
      {inlineDiff && <DiffBlock diff={inlineDiff} path={filePath} />}
      {!inlineDiff && formattedArgs && <pre className="asv-output is-command">{formattedArgs}</pre>}
      {item.output && (!inlineDiff || extractInlineDiffFromText(item.output) === null) && (
        <LiveOutput text={item.output} live={live} />
      )}
      {item.error && <div className="asv-detail-error">{item.error}</div>}
    </>
  );
}

function ToolRow({ item, turnKey }: { item: Item<'tool_call'>; turnKey?: string }) {
  const live = item.status === 'running';
  const failed = Boolean(item.error) || item.status === 'failed';
  const line = describeWorkItemLine(item);
  const hasDetail = Boolean(item.args || item.output || item.error);
  const disclosureKey = turnKey ? `item:${turnKey}:${item.id}` : undefined;
  return (
    <WorkLogRow
      icon={<WorkGlyph name={line.icon} />}
      tone={failed ? 'bad' : undefined}
      disclosureKey={disclosureKey}
      hasDetail={hasDetail}
      label={
        <>
          <span className={live ? 'asv-shimmer' : undefined}>{line.verb}</span>
          {line.fileTarget ? (
            <SessionToolFileTarget
              path={line.fileTarget.path}
              label={line.fileTarget.label}
              openable={line.fileTarget.openable}
            />
          ) : (
            line.target && <span className="asv-row-dim" title={line.targetTitle}>{line.target}</span>
          )}
        </>
      }
      trailing={<Trailing item={item} bad={failed ? <span className="asv-row-bad">失败</span> : null} />}
      renderDetail={() => <ToolDetail item={item} live={live} filePath={line.fileTarget?.path} />}
    />
  );
}

const CHANGE_VERB = { add: '新增', delete: '删除', update: '编辑' } as const;

function DiffStat({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="asv-diffstat">
      {added > 0 && <span className="is-add">+{added}</span>}
      {removed > 0 && <span className="is-del">-{removed}</span>}
    </span>
  );
}

function FileDiff({ file }: { file: WorkerTimelineFileChange }) {
  const session = useAgentSession();
  return (
    <>
      <div className="asv-file-head">
        {file.movePath && <span className="asv-detail-note is-mono">→ {file.movePath}</span>}
        {file.change !== 'delete' && (
          <button type="button" className="asv-text-btn" onClick={() => void openSessionTarget(file.movePath ?? file.path, session)}>
            打开文件
          </button>
        )}
      </div>
      <DiffBlock diff={file.diff} path={file.movePath ?? file.path} change={file.change} />
      {file.truncated && <div className="asv-detail-note">差异较长，已截断</div>}
    </>
  );
}

export function FileChangeRows({ files, keyPrefix }: { files: readonly WorkerTimelineFileChange[]; keyPrefix?: string }) {
  return (
    <div className="asv-row-list">
      {files.map((file) => {
        const target = file.movePath ?? file.path;
        return (
          <WorkLogRow
            key={file.path}
            disclosureKey={keyPrefix ? `${keyPrefix}:file:${file.path}` : undefined}
            hasDetail={Boolean(file.diff)}
            icon={<FilePenLine {...ICON} />}
            label={
              <>
                <span>{CHANGE_VERB[file.change]}</span>
                <SessionToolFileTarget path={target} label={file.path} openable={file.change !== 'delete'} />
              </>
            }
            trailing={<DiffStat added={file.added} removed={file.removed} />}
            renderDetail={() => <FileDiff file={file} />}
          />
        );
      })}
    </div>
  );
}

/** `inlineDiff` is off once the turn's change card lists the same diffs, so the row stays a one-line note. */
function FileChangeRow({ item, inlineDiff, turnKey }: { item: Item<'file_change'>; inlineDiff: boolean; turnKey?: string }) {
  const live = item.status === 'running';
  const totals = fileChangeTotals(item.files);
  const single = item.files.length === 1 ? item.files[0]! : null;
  const hasDetail = inlineDiff && item.files.length > 0;
  const disclosureKey = turnKey ? `item:${turnKey}:${item.id}` : undefined;
  return (
    <WorkLogRow
      icon={<FilePenLine {...ICON} />}
      tone={item.status === 'failed' ? 'bad' : undefined}
      disclosureKey={disclosureKey}
      hasDetail={hasDetail}
      label={
        <>
          <span className={live ? 'asv-shimmer' : undefined}>
            {single ? CHANGE_VERB[single.change] : `编辑了 ${item.files.length} 个文件`}
          </span>
          {single && (
            <SessionToolFileTarget
              path={single.movePath ?? single.path}
              label={single.path}
              openable={single.change !== 'delete'}
            />
          )}
        </>
      }
      trailing={
        <>
          {item.status === 'declined' && <span className="asv-row-bad">已拒绝</span>}
          <DiffStat added={totals.added} removed={totals.removed} />
        </>
      }
      renderDetail={() =>
        single ? <FileDiff file={single} /> : <FileChangeRows files={item.files} keyPrefix={disclosureKey} />
      }
    />
  );
}

const APPROVAL_STATUS = { pending: '等待授权', approved: '已允许', denied: '已拒绝', expired: '已过期' } as const;

function ApprovalRow({ item, turnKey }: { item: Item<'approval'>; turnKey?: string }) {
  const Icon = item.status === 'approved' ? ShieldCheck : item.status === 'pending' ? ShieldAlert : ShieldX;
  const hasDetail = Boolean(item.input || item.reason || (item.resolution && item.status !== 'pending'));
  return (
    <WorkLogRow
      icon={<Icon {...ICON} />}
      tone={item.status === 'pending' ? 'warn' : item.status === 'approved' ? undefined : 'bad'}
      disclosureKey={turnKey ? `item:${turnKey}:${item.id}` : undefined}
      hasDetail={hasDetail}
      label={
        <>
          <span>授权请求</span>
          <code className="asv-row-code">{item.tool || item.method}</code>
        </>
      }
      trailing={<span className={`asv-row-status is-${item.status}`}>{APPROVAL_STATUS[item.status]}</span>}
      renderDetail={() => (
        <>
          {item.input && <pre className="asv-output is-command">{item.input}</pre>}
          {item.reason && <div className="asv-detail-note">{item.reason}</div>}
          {item.resolution && item.status !== 'pending' && <div className="asv-detail-note">{item.resolution}</div>}
        </>
      )}
    />
  );
}

function PlanBlock({ item }: { item: Item<'plan'> }) {
  const done = item.steps.filter((step) => step.status === 'completed').length;
  return (
    <div className="asv-plan" data-asv-row>
      <div className="asv-row-line">
        <span className="asv-row-icon"><ListTodo {...ICON} /></span>
        <span className="asv-row-label">
          <span>计划</span>
          {item.steps.length > 0 && <span className="asv-row-dim">{done}/{item.steps.length}</span>}
        </span>
      </div>
      <div className="asv-plan-body">
        {item.explanation && <div className="asv-detail-note">{item.explanation}</div>}
        {item.steps.length > 0 && (
          <ul className="asv-plan-steps">
            {item.steps.map((step, i) => (
              <li key={i} className={`is-${step.status}`}>
                {step.status === 'completed' ? <Check size={13} /> : step.status === 'in_progress' ? <CircleDot size={13} /> : <Circle size={13} />}
                <span>{step.step}</span>
              </li>
            ))}
          </ul>
        )}
        {item.text && <SessionMarkdown text={item.text} variant="muted" linkifyFilePaths />}
      </div>
    </div>
  );
}

/** Framed callout for warnings and errors; subtle inline row for informational notices. */
export function SessionNoticeRow({
  level,
  text,
}: {
  level: 'info' | 'warning' | 'error';
  text: string;
}) {
  const Icon = level === 'error' ? CircleX : level === 'warning' ? TriangleAlert : Info;
  if (level === 'info') {
    return (
      <div className="asv-notice is-info" data-asv-row>
        <Icon size={14} className="asv-notice-icon" aria-hidden="true" />
        <span className="asv-notice-text">{text}</span>
      </div>
    );
  }
  return (
    <div
      className={`asv-notice is-${level}`}
      role={level === 'error' ? 'alert' : 'status'}
      data-asv-row
    >
      <Icon size={15} className="asv-notice-icon" aria-hidden="true" />
      <p className="asv-notice-text">{text}</p>
    </div>
  );
}

/** Rows for every item kind that reads as "work" rather than as a message. */
export const WorkItemRow = memo(function WorkItemRow({
  item,
  inlineDiff = true,
  turnKey,
  turnRunning = false,
}: {
  item: WorkerTimelineItem;
  inlineDiff?: boolean;
  turnKey?: string;
  turnRunning?: boolean;
}) {
  switch (item.kind) {
    case 'reasoning': return <ReasoningRow item={item} turnKey={turnKey} turnRunning={turnRunning} />;
    case 'command': return <CommandRow item={item} turnKey={turnKey} />;
    case 'tool_call': return <ToolRow item={item} turnKey={turnKey} />;
    case 'file_change': return <FileChangeRow item={item} inlineDiff={inlineDiff} turnKey={turnKey} />;
    case 'approval': return <ApprovalRow item={item} turnKey={turnKey} />;
    case 'plan': return <PlanBlock item={item} />;
    case 'notice': return <SessionNoticeRow level={item.level} text={item.text} />;
    default: return null;
  }
});

/** Semantic Chinese work-run group with outcome counts, completion check, and lazy-mounted member list. */
export function WorkGroup({
  block,
  turnKey,
  turnRunning = false,
}: {
  block: Extract<TimelineBlock, { type: 'group' }>;
  turnKey?: string;
  turnRunning?: boolean;
}) {
  const disclosureKey = turnKey ? `group:${turnKey}:${block.id}` : undefined;
  const { open, setOpen } = useSessionDisclosure(disclosureKey, false);
  const summary = summarizeWorkRun(block.items, { live: block.running });
  const first = block.items[0]?.startedAt;

  return (
    <div
      className="asv-group"
      data-asv-row
      data-open={open || undefined}
      data-asv-work-run-state={block.running ? 'live' : 'settled'}
    >
      <button
        type="button"
        className="asv-row-line asv-group-head"
        aria-expanded={open}
        aria-live="polite"
        onClick={() => setOpen(!open)}
      >
        <span className="asv-row-icon">
          <WorkGlyph name={summary.icon} size={14} />
        </span>
        <span className="asv-group-summary">
          <span className={`asv-group-sentence${block.running ? ' asv-shimmer' : ''}`}>
            {summary.sentence}
          </span>
          {summary.failedCount > 0 && (
            <span className="asv-run-badge is-bad" aria-label={`${summary.failedCount} 项调用失败`}>
              · {summary.failedCount} 项失败
            </span>
          )}
          {summary.declinedCount > 0 && (
            <span className="asv-run-badge is-warn" aria-label={`${summary.declinedCount} 项调用已拒绝`}>
              · {summary.declinedCount} 项已拒绝
            </span>
          )}
          {!block.running && summary.succeeded && (
            <Check size={12} className="asv-run-ok" aria-hidden="true" />
          )}
          {block.running && summary.latestPreview && !open && (
            <span className="asv-group-preview">{summary.latestPreview}</span>
          )}
        </span>
        <span className="asv-row-trailing">
          {block.running && first ? (
            <LiveTimer startedAt={first} />
          ) : (
            !block.running && block.durationMs !== null && block.durationMs >= 100 && (
              <span className="asv-row-time">{formatDuration(block.durationMs)}</span>
            )
          )}
          <ChevronRight size={13} className="asv-group-chevron" aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div className="asv-group-body">
          {block.items.map((item) => (
            <WorkItemRow key={item.id} item={item} turnKey={turnKey} turnRunning={turnRunning} />
          ))}
        </div>
      )}
    </div>
  );
}
