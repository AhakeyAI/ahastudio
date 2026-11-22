import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  Brain,
  Check,
  ChevronRight,
  Circle,
  CircleDot,
  CircleX,
  FilePenLine,
  Globe,
  Info,
  ListTodo,
  Plug,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  SquareTerminal,
  TriangleAlert,
  Wrench,
} from 'lucide-react';
import {
  fileChangeTotals,
  formatDuration,
  formatElapsed,
  groupSummary,
  liveGroupItem,
  unwrapShellCommand,
  type TimelineBlock,
} from '../../lib/worker-timeline-model';
import type { WorkerTimelineFileChange, WorkerTimelineItem } from '../../types';
import { DiffBlock } from './SessionCode';
import { SessionMarkdown } from './SessionMarkdown';
import { openSessionTarget, useAgentSession } from './session-context';

type Item<K extends WorkerTimelineItem['kind']> = Extract<WorkerTimelineItem, { kind: K }>;

const ICON = { size: 15, strokeWidth: 1.75 } as const;
const LIVE_EDGE_PX = 4;

const firstLine = (text: string) => text.split('\n').find((line) => line.trim())?.trim() ?? '';

/** Ticks once a second while mounted; rows only mount it for work that is still running. */
export function LiveTimer({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="asv-row-time">{formatElapsed(startedAt, now)}</span>;
}

function Trailing({ item, bad }: { item: { status: string; durationMs?: number | null; startedAt: number | null; completedAt: number | null }; bad?: ReactNode }) {
  if (item.status === 'running') return item.startedAt ? <LiveTimer startedAt={item.startedAt} /> : null;
  const duration = item.durationMs ?? (item.startedAt && item.completedAt ? item.completedAt - item.startedAt : null);
  return (
    <>
      {item.status === 'declined' ? <span className="asv-row-bad">已拒绝</span> : bad}
      {duration !== null && duration >= 100 && <span className="asv-row-time">{formatDuration(duration)}</span>}
    </>
  );
}

/** One borderless line of the work log; when it has detail the whole line toggles it in place. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  tone,
  wrap = false,
  defaultOpen = false,
  children,
}: {
  icon: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  tone?: 'bad' | 'warn';
  wrap?: boolean;
  defaultOpen?: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const line = (
    <>
      <span className="asv-row-icon">{icon}</span>
      <span className={`asv-row-label${wrap ? ' is-wrap' : ''}`}>{label}</span>
      {trailing && <span className="asv-row-trailing">{trailing}</span>}
      {children && <ChevronRight size={13} className="asv-row-chevron" aria-hidden="true" />}
    </>
  );
  return (
    <div className="asv-row" data-asv-row data-open={open || undefined} data-tone={tone}>
      {children ? (
        <button type="button" className="asv-row-line" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
          {line}
        </button>
      ) : (
        <div className="asv-row-line">{line}</div>
      )}
      {children && open && <div className="asv-row-detail">{children}</div>}
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

function ReasoningRow({ item }: { item: Item<'reasoning'> }) {
  const live = item.status === 'running';
  const body = item.summary && item.text ? `${item.summary}\n\n${item.text}` : item.summary || item.text;
  const preview = firstLine(body).replace(/^[#*\s]+|\*+$/g, '');
  return (
    <WorkLogRow
      icon={<Brain {...ICON} />}
      label={
        <>
          <span className={live ? 'asv-shimmer' : undefined}>{live ? '思考中' : '思考'}</span>
          {preview && <span className="asv-row-dim">{preview}</span>}
        </>
      }
      trailing={<Trailing item={item} />}
    >
      {body ? <SessionMarkdown text={body} variant="muted" streaming={live} /> : null}
    </WorkLogRow>
  );
}

function CommandRow({ item }: { item: Item<'command'> }) {
  const live = item.status === 'running';
  const display = unwrapShellCommand(item.command);
  const failed = item.exitCode !== null && item.exitCode !== 0;
  const hasDetail = Boolean(item.output || item.cwd || display !== item.command.trim() || display.includes('\n'));
  return (
    <WorkLogRow
      icon={<SquareTerminal {...ICON} />}
      tone={failed || item.status === 'failed' ? 'bad' : undefined}
      label={<code className={`asv-row-code${live ? ' asv-shimmer' : ''}`}>{firstLine(display)}</code>}
      trailing={<Trailing item={item} bad={failed ? <span className="asv-row-bad">exit {item.exitCode}</span> : null} />}
    >
      {hasDetail ? (
        <>
          {item.cwd && <div className="asv-detail-note is-mono">{item.cwd}</div>}
          {(display !== item.command.trim() || display.includes('\n')) && <pre className="asv-output is-command">{item.command}</pre>}
          {item.output && <LiveOutput text={item.output} live={live} />}
          {item.outputTruncated && <div className="asv-detail-note">输出较长，已截断</div>}
        </>
      ) : null}
    </WorkLogRow>
  );
}

const toolName = (item: Item<'tool_call'>) =>
  item.toolType === 'search' ? '搜索' : item.server ? `${item.server} · ${item.tool}` : item.tool;

function ToolRow({ item }: { item: Item<'tool_call'> }) {
  const live = item.status === 'running';
  const Icon = item.toolType === 'search' ? Globe : item.toolType === 'mcp' ? Plug : Wrench;
  const hint = live && item.progress ? item.progress : firstLine(item.args);
  const failed = Boolean(item.error) || item.status === 'failed';
  return (
    <WorkLogRow
      icon={<Icon {...ICON} />}
      tone={failed ? 'bad' : undefined}
      label={
        <>
          <span className={live ? 'asv-shimmer' : undefined}>{toolName(item)}</span>
          {hint && <span className="asv-row-dim">{hint}</span>}
        </>
      }
      trailing={<Trailing item={item} bad={failed ? <span className="asv-row-bad">失败</span> : null} />}
    >
      {item.args || item.output || item.error ? (
        <>
          {item.args && <pre className="asv-output is-command">{item.args}</pre>}
          {item.output && <LiveOutput text={item.output} live={live} />}
          {item.error && <div className="asv-detail-error">{item.error}</div>}
        </>
      ) : null}
    </WorkLogRow>
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
        <button type="button" className="asv-text-btn" onClick={() => void openSessionTarget(file.movePath ?? file.path, session)}>
          打开文件
        </button>
      </div>
      <DiffBlock diff={file.diff} path={file.movePath ?? file.path} change={file.change} />
      {file.truncated && <div className="asv-detail-note">差异较长，已截断</div>}
    </>
  );
}

export function FileChangeRows({ files }: { files: readonly WorkerTimelineFileChange[] }) {
  return (
    <div className="asv-row-list">
      {files.map((file) => (
        <WorkLogRow
          key={file.path}
          icon={<FilePenLine {...ICON} />}
          label={
            <>
              <span>{CHANGE_VERB[file.change]}</span>
              <code className="asv-row-code">{file.path}</code>
            </>
          }
          trailing={<DiffStat added={file.added} removed={file.removed} />}
        >
          <FileDiff file={file} />
        </WorkLogRow>
      ))}
    </div>
  );
}

function FileChangeRow({ item }: { item: Item<'file_change'> }) {
  const live = item.status === 'running';
  const totals = fileChangeTotals(item.files);
  const single = item.files.length === 1 ? item.files[0]! : null;
  return (
    <WorkLogRow
      icon={<FilePenLine {...ICON} />}
      tone={item.status === 'failed' ? 'bad' : undefined}
      label={
        <>
          <span className={live ? 'asv-shimmer' : undefined}>{single ? CHANGE_VERB[single.change] : `编辑了 ${item.files.length} 个文件`}</span>
          {single && <code className="asv-row-code">{single.path}</code>}
        </>
      }
      trailing={
        <>
          {item.status === 'declined' && <span className="asv-row-bad">已拒绝</span>}
          <DiffStat added={totals.added} removed={totals.removed} />
        </>
      }
    >
      {single ? <FileDiff file={single} /> : item.files.length > 0 ? <FileChangeRows files={item.files} /> : null}
    </WorkLogRow>
  );
}

const APPROVAL_STATUS = { pending: '等待授权', approved: '已允许', denied: '已拒绝', expired: '已过期' } as const;

function ApprovalRow({ item }: { item: Item<'approval'> }) {
  const Icon = item.status === 'approved' ? ShieldCheck : item.status === 'pending' ? ShieldAlert : ShieldX;
  return (
    <WorkLogRow
      icon={<Icon {...ICON} />}
      tone={item.status === 'pending' ? 'warn' : item.status === 'approved' ? undefined : 'bad'}
      label={
        <>
          <span>授权请求</span>
          <code className="asv-row-code">{item.tool || item.method}</code>
        </>
      }
      trailing={<span className={`asv-row-status is-${item.status}`}>{APPROVAL_STATUS[item.status]}</span>}
    >
      {item.input || item.reason || item.resolution ? (
        <>
          {item.input && <pre className="asv-output is-command">{item.input}</pre>}
          {item.reason && <div className="asv-detail-note">{item.reason}</div>}
          {item.resolution && item.status !== 'pending' && <div className="asv-detail-note">{item.resolution}</div>}
        </>
      ) : null}
    </WorkLogRow>
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
        {item.text && <SessionMarkdown text={item.text} variant="muted" />}
      </div>
    </div>
  );
}

function NoticeRow({ item }: { item: Item<'notice'> }) {
  const Icon = item.level === 'error' ? CircleX : item.level === 'warning' ? TriangleAlert : Info;
  return (
    <WorkLogRow
      icon={<Icon {...ICON} />}
      tone={item.level === 'error' ? 'bad' : item.level === 'warning' ? 'warn' : undefined}
      wrap
      label={item.text}
    />
  );
}

/** Rows for every item kind that reads as "work" rather than as a message. */
export const WorkItemRow = memo(function WorkItemRow({ item }: { item: WorkerTimelineItem }) {
  switch (item.kind) {
    case 'reasoning': return <ReasoningRow item={item} />;
    case 'command': return <CommandRow item={item} />;
    case 'tool_call': return <ToolRow item={item} />;
    case 'file_change': return <FileChangeRow item={item} />;
    case 'approval': return <ApprovalRow item={item} />;
    case 'plan': return <PlanBlock item={item} />;
    case 'notice': return <NoticeRow item={item} />;
    default: return null;
  }
});

function liveLabel(item: WorkerTimelineItem): string {
  switch (item.kind) {
    case 'reasoning': return '思考中';
    case 'command': return `运行 ${firstLine(unwrapShellCommand(item.command))}`;
    case 'tool_call': return `调用 ${toolName(item)}`;
    default: return '工作中';
  }
}

export function WorkGroup({ block }: { block: Extract<TimelineBlock, { type: 'group' }> }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? block.running;
  const first = block.items[0]?.startedAt;
  return (
    <div className="asv-group" data-asv-row data-open={open || undefined}>
      <button type="button" className="asv-row-line" aria-expanded={open} onClick={() => setUserOpen(!open)}>
        <span className="asv-row-icon"><ChevronRight size={14} className="asv-group-chevron" aria-hidden="true" /></span>
        <span className="asv-row-label">
          {block.running && !open ? (
            <span className="asv-shimmer">{liveLabel(liveGroupItem(block))}</span>
          ) : (
            <span>{groupSummary(block)}</span>
          )}
        </span>
        {block.running && first && <span className="asv-row-trailing"><LiveTimer startedAt={first} /></span>}
      </button>
      {open && (
        <div className="asv-group-body">
          {block.items.map((item) => <WorkItemRow key={item.id} item={item} />)}
        </div>
      )}
    </div>
  );
}
