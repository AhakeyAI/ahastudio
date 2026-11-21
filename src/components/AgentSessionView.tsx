import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowDown, Check, ChevronRight, Circle, CircleDot, FileDiff, Lock, Send, Square, X } from 'lucide-react';
import { useWorkerTimeline } from '../hooks/useWorkerTimeline';
import { orchestrationClient } from '../lib/orchestration-client';
import { parseMarkdown, type MdBlock, type MdInline } from '../lib/safe-markdown';
import { stageWindowStore, type StageWindow } from '../lib/stage-window-store';
import {
  activeTimelineTurn,
  classifyDiffLines,
  fileChangeTotals,
  formatSeconds,
  formatTokenCount,
  groupSummary,
  groupTimelineItems,
  isNearBottom,
  totalTokenUsage,
  type TimelineBlock,
} from '../lib/worker-timeline-model';
import type {
  OrchestrationDispatchRecord,
  OrchestrationDispatchStage,
  WorkerTimelineFileChange,
  WorkerTimelineItem,
  WorkerTimelineTurn,
} from '../types';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import './agent-session-view.css';

const STAGE_LABELS: Record<OrchestrationDispatchStage, string> = {
  starting: '启动中',
  working: '工作中',
  waiting_permission: '等待授权',
  waiting_input: '等待输入',
  awaiting_review: '待确认',
  done: '已完成',
  failed: '失败',
  released: '已释放',
  stopped: '已停止',
};

const TURN_LABELS: Record<WorkerTimelineTurn['status'], string> = {
  running: '进行中',
  completed: '已完成',
  interrupted: '已中断',
  failed: '失败',
};

type Item<K extends WorkerTimelineItem['kind']> = Extract<WorkerTimelineItem, { kind: K }>;

function Inline({ nodes }: { nodes: MdInline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case 'text': return <Fragment key={i}>{node.text}</Fragment>;
          case 'code': return <code key={i}>{node.text}</code>;
          case 'strong': return <strong key={i}><Inline nodes={node.children} /></strong>;
          case 'em': return <em key={i}><Inline nodes={node.children} /></em>;
          case 'link': return <span key={i} className="asv-md-link" title={node.href}>{node.text}</span>;
        }
      })}
    </>
  );
}

export function SafeMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  const render = (block: MdBlock, i: number): ReactNode => {
    switch (block.type) {
      case 'heading': {
        const level = Math.min(6, Math.max(3, block.level + 2));
        const Tag = `h${level}` as 'h3';
        return <Tag key={i}><Inline nodes={block.children} /></Tag>;
      }
      case 'paragraph': return <p key={i}><Inline nodes={block.children} /></p>;
      case 'code': return <pre key={i} className="asv-md-code" data-lang={block.lang || undefined}><code>{block.text}</code></pre>;
      case 'list': {
        const Tag = block.ordered ? 'ol' : 'ul';
        return <Tag key={i}>{block.items.map((item, j) => <li key={j}><Inline nodes={item} /></li>)}</Tag>;
      }
      case 'quote': return <blockquote key={i}><Inline nodes={block.children} /></blockquote>;
      case 'rule': return <hr key={i} />;
    }
  };
  return <div className="asv-md">{blocks.map(render)}</div>;
}

function StatusDot({ status }: { status: string }) {
  if (status === 'running' || status === 'pending') return <span className="asv-spinner" aria-label="进行中" />;
  if (status === 'completed' || status === 'approved') return <Check size={12} className="asv-ok" aria-label="完成" />;
  return <X size={12} className="asv-fail" aria-label={status} />;
}

/** Same path as terminal file links: the main process resolves against cwd and opens or reveals it. */
async function openChangedFile(path: string, cwd: string | null | undefined, onNotify?: (m: string) => void): Promise<void> {
  const openLink = window.vibeMeet?.shellPty?.openLink;
  if (!openLink) {
    onNotify?.('当前环境不支持打开本地文件');
    return;
  }
  try {
    const res = await openLink({ target: path, ...(cwd ? { cwd } : {}) });
    if (!res.ok) onNotify?.(res.error ?? '无法打开文件');
  } catch (error) {
    onNotify?.(error instanceof Error ? error.message : '无法打开文件');
  }
}

function DiffView({ diff }: { diff: string }) {
  return (
    <pre className="asv-diff">
      {classifyDiffLines(diff).map((line, i) => (
        <span key={i} className={`asv-diff-${line.kind}`}>{line.text || ' '}{'\n'}</span>
      ))}
    </pre>
  );
}

function FileRow({ file, cwd, onNotify }: { file: WorkerTimelineFileChange; cwd?: string | null; onNotify?: (m: string) => void }) {
  const [open, setOpen] = useState(false);
  const label = file.change === 'add' ? '新增' : file.change === 'delete' ? '删除' : '修改';
  return (
    <div className="asv-file">
      <div className="asv-file-row">
        <button type="button" className="asv-icon-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="展开差异">
          <ChevronRight size={12} className={open ? 'is-open' : ''} />
        </button>
        <span className={`asv-file-kind is-${file.change}`}>{label}</span>
        <button type="button" className="asv-path" title="打开文件" onClick={() => void openChangedFile(file.movePath ?? file.path, cwd, onNotify)}>
          {file.path}{file.movePath ? ` → ${file.movePath}` : ''}
        </button>
        <span className="asv-stat-add">+{file.added}</span>
        <span className="asv-stat-del">-{file.removed}</span>
      </div>
      {open && (file.diff ? <DiffView diff={file.diff} /> : <div className="asv-muted">没有可显示的差异</div>)}
      {open && file.truncated && <div className="asv-muted">差异已截断</div>}
    </div>
  );
}

function CommandCard({ item }: { item: Item<'command'> }) {
  const [open, setOpen] = useState(item.status === 'running');
  useEffect(() => { if (item.status === 'running') setOpen(true); }, [item.status]);
  const exit = item.exitCode;
  return (
    <div className={`asv-card asv-command is-${item.status}`}>
      <button type="button" className="asv-card-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <StatusDot status={item.status} />
        <code className="asv-cmd">$ {item.command}</code>
        {item.durationMs !== null && <span className="asv-muted">{formatSeconds(item.durationMs)}</span>}
        {exit !== null && <span className={`asv-badge ${exit === 0 ? 'is-ok' : 'is-fail'}`}>exit {exit}</span>}
        {item.status === 'declined' && <span className="asv-badge is-fail">已拒绝</span>}
      </button>
      {open && (item.output || item.cwd) && (
        <div className="asv-card-body">
          {item.cwd && <div className="asv-muted asv-cwd">{item.cwd}</div>}
          {item.output && <pre className="asv-output">{item.output}</pre>}
        </div>
      )}
    </div>
  );
}

function ToolCard({ item }: { item: Item<'tool_call'> }) {
  const [open, setOpen] = useState(false);
  const name = item.toolType === 'search' ? '搜索' : item.server ? `${item.server} / ${item.tool}` : item.tool;
  return (
    <div className={`asv-card asv-tool is-${item.status}`}>
      <button type="button" className="asv-card-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <StatusDot status={item.status} />
        <span className="asv-badge">{item.toolType === 'mcp' ? 'MCP' : item.toolType === 'search' ? 'Web' : 'Tool'}</span>
        <span className="asv-tool-name">{name}</span>
        {item.args && <span className="asv-muted asv-ellipsis">{item.args}</span>}
        {item.durationMs !== null && <span className="asv-muted">{formatSeconds(item.durationMs)}</span>}
      </button>
      {item.progress && item.status === 'running' && <div className="asv-muted asv-indent">{item.progress}</div>}
      {open && (
        <div className="asv-card-body">
          {item.args && <pre className="asv-output">{item.args}</pre>}
          {item.output && <pre className="asv-output">{item.output}</pre>}
          {item.error && <div className="asv-error">{item.error}</div>}
        </div>
      )}
      {!open && item.error && <div className="asv-error asv-indent">{item.error}</div>}
    </div>
  );
}

function ReasoningRow({ item }: { item: Item<'reasoning'> }) {
  const [open, setOpen] = useState(false);
  const summary = item.summary || item.text;
  return (
    <div className="asv-reasoning">
      <button type="button" className="asv-card-head is-plain" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <StatusDot status={item.status} />
        <span className="asv-muted">{item.status === 'running' ? '思考中…' : '思考'}</span>
        {!open && summary && <span className="asv-muted asv-ellipsis">{summary.split('\n')[0]}</span>}
      </button>
      {open && summary && <div className="asv-reasoning-body"><SafeMarkdown text={item.summary && item.text ? `${item.summary}\n\n${item.text}` : summary} /></div>}
    </div>
  );
}

function ApprovalCard({ item, onNotify }: { item: Item<'approval'>; onNotify?: (m: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const api = window.vibeMeet?.orchestration;
  const decide = async (allow: boolean) => {
    const call = allow ? api?.approve : api?.deny;
    if (!call) return;
    setBusy(true);
    try {
      const res = await call({ id: item.approvalId, ...(allow ? {} : { reason: reason.trim() || 'Denied from Agent session' }) });
      if (!res.ok) onNotify?.(res.error);
    } finally {
      setBusy(false);
    }
  };
  const statusLabel = { pending: '等待授权', approved: '已允许', denied: '已拒绝', expired: '已过期' }[item.status];
  return (
    <div className={`asv-card asv-approval is-${item.status}`} role="group" aria-label="授权请求">
      <div className="asv-card-head is-static">
        <Lock size={13} />
        <span className="asv-tool-name">{item.tool || item.method}</span>
        <span className={`asv-badge is-${item.status}`}>{statusLabel}</span>
      </div>
      <div className="asv-card-body">
        {item.input && <pre className="asv-output">{item.input}</pre>}
        {item.reason && <div className="asv-muted">{item.reason}</div>}
        {item.resolution && item.status !== 'pending' && <div className="asv-muted">{item.resolution}</div>}
        {item.status === 'pending' && (
          <div className="asv-approval-actions">
            <button type="button" className="asv-btn is-primary" disabled={busy} onClick={() => void decide(true)}>允许</button>
            <input
              className="asv-input"
              placeholder="拒绝原因（可选）"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              aria-label="拒绝原因"
            />
            <button type="button" className="asv-btn is-danger" disabled={busy} onClick={() => void decide(false)}>拒绝</button>
          </div>
        )}
      </div>
    </div>
  );
}

function PlanCard({ item }: { item: Item<'plan'> }) {
  return (
    <div className="asv-card asv-plan">
      <div className="asv-card-head is-static"><span className="asv-tool-name">计划</span></div>
      <div className="asv-card-body">
        {item.explanation && <div className="asv-muted">{item.explanation}</div>}
        {item.steps.length > 0 && (
          <ul className="asv-plan-steps">
            {item.steps.map((step, i) => (
              <li key={i} className={`is-${step.status}`}>
                {step.status === 'completed' ? <Check size={12} /> : step.status === 'in_progress' ? <CircleDot size={12} /> : <Circle size={12} />}
                <span>{step.step}</span>
              </li>
            ))}
          </ul>
        )}
        {item.text && <SafeMarkdown text={item.text} />}
      </div>
    </div>
  );
}

function SettlementCard({ item }: { item: Item<'settlement'> }) {
  const [showDiff, setShowDiff] = useState(false);
  if (item.settlement === 'report_done') {
    const ok = item.outcome === 'completed';
    return (
      <div className={`asv-card asv-settlement is-report ${ok ? 'is-ok' : 'is-fail'}`}>
        <div className="asv-card-head is-static">
          <span className="asv-tool-name">已提交 report_done</span>
          {item.outcome && <span className={`asv-badge ${ok ? 'is-ok' : 'is-fail'}`}>{item.outcome}</span>}
          {item.verdict && <span className={`asv-badge ${item.verdict === 'pass' ? 'is-ok' : 'is-fail'}`}>verdict: {item.verdict}</span>}
        </div>
        <div className="asv-card-body">
          {item.summary && <SafeMarkdown text={item.summary} />}
          {item.findings.length > 0 && <ul className="asv-findings">{item.findings.map((f, i) => <li key={i}>{f}</li>)}</ul>}
        </div>
      </div>
    );
  }
  return (
    <div className="asv-card asv-settlement is-pending">
      <div className="asv-card-head is-static">
        <span className="asv-tool-name">本轮结束，结果待确认</span>
        {item.stopReason && <span className="asv-badge">{item.stopReason}</span>}
      </div>
      <div className="asv-card-body">
        <div className="asv-muted">Worker 未调用 report_done。请检查输出与差异证据后再决定下一步。</div>
        {item.diff !== null && (
          <>
            <button type="button" className="asv-btn" onClick={() => setShowDiff((v) => !v)}>
              <FileDiff size={12} /> {showDiff ? '收起差异' : `查看差异${item.diffSource === 'git' ? '（git diff）' : ''}`}
            </button>
            {showDiff && (item.diff ? <DiffView diff={item.diff} /> : <div className="asv-muted">工作区没有差异</div>)}
          </>
        )}
      </div>
    </div>
  );
}

function ItemView({ item, cwd, onNotify }: { item: WorkerTimelineItem; cwd?: string | null; onNotify?: (m: string) => void }) {
  switch (item.kind) {
    case 'reasoning': return <ReasoningRow item={item} />;
    case 'command': return <CommandCard item={item} />;
    case 'tool_call': return <ToolCard item={item} />;
    case 'plan': return <PlanCard item={item} />;
    case 'approval': return <ApprovalCard item={item} onNotify={onNotify} />;
    case 'settlement': return <SettlementCard item={item} />;
    case 'notice': return <div className={`asv-notice is-${item.level}`}>{item.text}</div>;
    case 'message':
      return (
        <div className={`asv-message is-${item.role}`}>
          <SafeMarkdown text={item.text} />
          {item.status === 'running' && <span className="asv-caret" aria-hidden="true" />}
        </div>
      );
    case 'file_change': {
      const totals = fileChangeTotals(item.files);
      return (
        <div className={`asv-card asv-files is-${item.status}`}>
          <div className="asv-card-head is-static">
            <StatusDot status={item.status} />
            <span className="asv-tool-name">修改了 {item.files.length} 个文件</span>
            <span className="asv-stat-add">+{totals.added}</span>
            <span className="asv-stat-del">-{totals.removed}</span>
            {item.status === 'declined' && <span className="asv-badge is-fail">已拒绝</span>}
          </div>
          <div className="asv-card-body">{item.files.map((file) => <FileRow key={file.path} file={file} cwd={cwd} onNotify={onNotify} />)}</div>
        </div>
      );
    }
  }
}

function GroupView({ block, cwd, onNotify }: { block: Extract<TimelineBlock, { type: 'group' }>; cwd?: string | null; onNotify?: (m: string) => void }) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? block.running;
  return (
    <div className={`asv-group ${block.running ? 'is-running' : ''}`}>
      <button type="button" className="asv-group-head" onClick={() => setUserOpen(!open)} aria-expanded={open}>
        <ChevronRight size={12} className={open ? 'is-open' : ''} />
        {block.running && <span className="asv-spinner" aria-hidden="true" />}
        <span>{groupSummary(block)}</span>
      </button>
      {open && <div className="asv-group-body">{block.items.map((item) => <ItemView key={item.id} item={item} cwd={cwd} onNotify={onNotify} />)}</div>}
    </div>
  );
}

function TurnView({ turn, cwd, onNotify }: { turn: WorkerTimelineTurn; cwd?: string | null; onNotify?: (m: string) => void }) {
  const blocks = useMemo(() => groupTimelineItems(turn.items), [turn.items]);
  return (
    <section className={`asv-turn is-${turn.status}`} aria-label={`第 ${turn.generation} 轮`}>
      <details className="asv-prompt">
        <summary>
          <span className="asv-prompt-label">第 {turn.generation} 轮 · 指令</span>
          <span className="asv-muted asv-ellipsis">{turn.prompt.split('\n').find((line) => line.trim()) ?? ''}</span>
        </summary>
        <pre className="asv-prompt-body">{turn.prompt}</pre>
      </details>
      {turn.itemsTrimmed && <div className="asv-muted asv-indent">部分较早的过程记录已截断</div>}
      {blocks.map((block) =>
        block.type === 'group'
          ? <GroupView key={block.id} block={block} cwd={cwd} onNotify={onNotify} />
          : <ItemView key={block.item.id} item={block.item} cwd={cwd} onNotify={onNotify} />,
      )}
      {turn.status !== 'running' && (
        <div className={`asv-turn-foot is-${turn.status}`}>
          {TURN_LABELS[turn.status]}
          {turn.completedAt ? ` · ${formatSeconds(turn.completedAt - turn.startedAt)}` : ''}
          {turn.error ? ` · ${turn.error}` : ''}
        </div>
      )}
    </section>
  );
}

function latestDispatchFor(dispatches: OrchestrationDispatchRecord[], workerId?: string, dispatchId?: string) {
  const mine = dispatches.filter((d) => (workerId && d.assigneeHandle === workerId) || d.id === dispatchId);
  return mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
}

export function AgentSessionView({ win, onNotify }: { win: StageWindow; onNotify?: (message: string) => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const { timeline, loading, error } = useWorkerTimeline(win.workerId, win.dispatchId, reloadKey);
  const snapshot = useSyncExternalStore(orchestrationClient.subscribe, orchestrationClient.getSnapshot);
  const dispatch = latestDispatchFor(snapshot.dispatches, win.workerId ?? timeline?.workerHandle, win.dispatchId);
  const task = dispatch ? snapshot.tasks.find((t) => t.id === dispatch.taskId) : undefined;
  const role = task?.displayName?.trim().replace(/^@+/, '');
  const title = role ? `@${role}` : task?.taskTitle || win.title;
  const usage = totalTokenUsage(timeline);
  const running = Boolean(activeTimelineTurn(timeline));
  const alive = Boolean(timeline?.alive);
  const cwd = dispatch?.worktreePath ?? win.cwd ?? null;
  const targetDispatchId = dispatch?.id ?? win.dispatchId;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stick) el.scrollTop = el.scrollHeight;
  }, [timeline, stick]);

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const api = window.vibeMeet?.orchestration;

  // A follow-up on another dispatch of the same Worker should keep the tab pointed at the newest one.
  useEffect(() => {
    if (dispatch && win.dispatchId !== dispatch.id && win.workerId) {
      void stageWindowStore.createWindow('agent-session', { workerId: win.workerId, dispatchId: dispatch.id, activate: false });
    }
  }, [dispatch?.id, win.dispatchId, win.workerId]);

  const run = async (key: string, fn: () => Promise<{ ok: boolean; error?: string } | undefined>) => {
    setBusy(key);
    try {
      const res = await fn();
      if (res && !res.ok) onNotify?.(res.error ?? '操作失败');
      return res?.ok ?? false;
    } finally {
      setBusy(null);
    }
  };

  const send = async () => {
    const text = draft.trim();
    if (!text || !targetDispatchId || !api) return;
    const [first = '', ...rest] = text.split('\n');
    const long = first.length > 200;
    const body = long ? text : rest.join('\n').trim();
    const ok = await run('send', () => api.send({
      to: `dispatch:${targetDispatchId}`,
      subject: long ? `${first.slice(0, 197)}...` : first,
      ...(body ? { body } : {}),
    }));
    if (ok) {
      setDraft('');
      setStick(true);
    }
  };

  const stop = () => {
    if (!targetDispatchId || !api?.workerStop) return;
    void run('stop', () => api.workerStop!({ dispatchId: targetDispatchId, reason: 'Stopped from Agent session' }));
  };

  const interrupt = () => {
    if (!targetDispatchId || !api?.workerInterrupt) return;
    void run('interrupt', () => api.workerInterrupt!({ dispatchId: targetDispatchId }));
  };

  return (
    <div className="agent-session-view" data-running={running || undefined}>
      <header className="asv-header">
        <TerminalProfileIcon id={timeline?.cliId ?? win.localCliId ?? 'codex'} size={18} />
        <div className="asv-title">
          <strong>{title}</strong>
          {task?.taskTitle && role && <span className="asv-muted asv-ellipsis">{task.taskTitle}</span>}
        </div>
        {timeline?.model && <span className="asv-badge">{timeline.model}</span>}
        {(timeline?.readOnly ?? true) && <span className="asv-badge is-readonly">只读</span>}
        {dispatch?.stage && <span className={`asv-badge is-stage-${dispatch.stage}`}>{STAGE_LABELS[dispatch.stage] ?? dispatch.stage}</span>}
        {!alive && timeline && <span className="asv-badge">已结束</span>}
        <span className="asv-spacer" />
        {usage && (
          <span className="asv-muted" title={`输入 ${usage.input} · 输出 ${usage.output}`}>
            {formatTokenCount(usage.total)} tokens
          </span>
        )}
        {alive && (
          <button type="button" className="asv-btn is-danger" disabled={busy === 'stop'} onClick={stop}>
            <Square size={11} /> 停止
          </button>
        )}
      </header>

      <div
        className="asv-scroll"
        ref={scrollRef}
        onScroll={(e) => setStick(isNearBottom(e.currentTarget))}
      >
        {loading && !timeline && <div className="asv-empty">正在加载会话…</div>}
        {error && (
          <div className="asv-empty">
            {error}
            <button type="button" className="asv-btn" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
          </div>
        )}
        {!loading && !error && !timeline && <div className="asv-empty">这个 Worker 还没有可回放的过程记录。</div>}
        {timeline?.turns.map((turn) => <TurnView key={turn.key} turn={turn} cwd={cwd} onNotify={onNotify} />)}
      </div>
      {!stick && (
        <button
          type="button"
          className="asv-to-bottom"
          onClick={() => {
            setStick(true);
            const el = scrollRef.current;
            if (el) el.scrollTop = el.scrollHeight;
          }}
        >
          <ArrowDown size={12} /> 回到底部
        </button>
      )}

      <footer className="asv-footer">
        {alive ? (
          <>
            <textarea
              className="asv-composer"
              placeholder={running ? 'Worker 正在执行，消息会在本轮结束后送达…' : '发送追加指令给 Worker（Enter 发送，Shift+Enter 换行）'}
              value={draft}
              rows={2}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void send();
                }
              }}
              aria-label="追加指令"
            />
            <div className="asv-footer-actions">
              {running && (
                <button type="button" className="asv-btn" disabled={busy === 'interrupt'} onClick={interrupt}>
                  <Square size={11} /> 中断
                </button>
              )}
              <button type="button" className="asv-btn is-primary" disabled={!draft.trim() || busy === 'send'} onClick={() => void send()}>
                <Send size={12} /> 发送
              </button>
            </div>
          </>
        ) : (
          <div className="asv-readonly-notice">会话已结束，当前为只读回放。</div>
        )}
      </footer>
    </div>
  );
}
