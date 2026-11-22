import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, ChevronRight, CircleAlert, CircleCheck, Hourglass, Square } from 'lucide-react';
import { useTimelineScroll } from '../hooks/useTimelineScroll';
import { useWorkerTimeline } from '../hooks/useWorkerTimeline';
import { countDiffStats, parseUnifiedDiff } from '../lib/git-panel-model';
import { agentSessionClient, isStandaloneSession } from '../lib/agent-session-client';
import { orchestrationClient } from '../lib/orchestration-client';
import { stageWindowStore, type StageWindow } from '../lib/stage-window-store';
import { terminalSessionStore } from '../lib/terminal-session-store';
import {
  activeTimelineTurn,
  formatDuration,
  groupTimelineItems,
  pendingApprovals,
  splitDiffByFile,
  splitDispatchPrompt,
  totalTokenUsage,
  turnHasLiveItem,
} from '../lib/worker-timeline-model';
import type {
  AgentSessionInfo,
  AgentSessionPolicy,
  OrchestrationDispatchRecord,
  OrchestrationDispatchStage,
  WorkerTimelineFileChange,
  WorkerTimelineItem,
  WorkerTimelineTurn,
} from '../types';
import { DiffBlock } from './agent-session/SessionCode';
import { SessionComposer } from './agent-session/SessionComposer';
import { SessionMarkdown } from './agent-session/SessionMarkdown';
import { FileChangeRows, LiveTimer, WorkGroup, WorkItemRow } from './agent-session/SessionWorkLog';
import { AgentSessionContext } from './agent-session/session-context';
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

/** Space kept between the last timeline row and the floating composer. */
const DOCK_GAP = 16;
const LONG_PROMPT_CHARS = 1200;
const LONG_PROMPT_LINES = 16;

type Item<K extends WorkerTimelineItem['kind']> = Extract<WorkerTimelineItem, { kind: K }>;

function UserBubble({ text, caption }: { text: string; caption?: string }) {
  const parts = useMemo(() => splitDispatchPrompt(text), [text]);
  const long = parts.body.length > LONG_PROMPT_CHARS || parts.body.split('\n').length > LONG_PROMPT_LINES;
  const [expanded, setExpanded] = useState(false);
  const [showSystem, setShowSystem] = useState(false);
  const origin = parts.system ? (parts.followUp ? '追加派发' : '编排派发') : null;
  return (
    <div className="asv-user" data-asv-row>
      <div className={`asv-bubble${long && !expanded ? ' is-clamped' : ''}`}>
        <SessionMarkdown text={parts.body} variant="bubble" />
      </div>
      {(long || parts.system || caption) && (
        <div className="asv-user-meta">
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
        {item.summary && <SessionMarkdown text={item.summary} />}
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

const TimelineItem = memo(function TimelineItem({ item }: { item: WorkerTimelineItem }) {
  if (item.kind === 'settlement') return <SettlementBlock item={item} />;
  if (item.kind !== 'message') return <WorkItemRow item={item} />;
  if (item.role === 'user') return <UserBubble text={item.text} caption="追加指令" />;
  return (
    <div className="asv-assistant" data-asv-row>
      <SessionMarkdown text={item.text} streaming={item.status === 'running'} />
    </div>
  );
});

function turnFootText(turn: WorkerTimelineTurn): string {
  const elapsed = turn.completedAt ? formatDuration(turn.completedAt - turn.startedAt) : '';
  const label = turn.status === 'interrupted' ? '已中断' : turn.status === 'failed' ? '失败' : '';
  return [label, elapsed && `用时 ${elapsed}`, turn.error].filter(Boolean).join(' · ');
}

const TurnView = memo(function TurnView({ turn, minHeight }: { turn: WorkerTimelineTurn; minHeight?: number }) {
  const blocks = useMemo(() => groupTimelineItems(turn.items), [turn.items]);
  const running = turn.status === 'running';
  const foot = running ? '' : turnFootText(turn);
  return (
    <section className={`asv-turn is-${turn.status}`} aria-label={`第 ${turn.generation} 轮`} style={minHeight ? { minHeight } : undefined}>
      <UserBubble text={turn.prompt} caption={`第 ${turn.generation} 轮`} />
      {turn.itemsTrimmed && <div className="asv-turn-note">部分较早的过程记录已截断</div>}
      {blocks.map((block) =>
        block.type === 'group' ? <WorkGroup key={block.id} block={block} /> : <TimelineItem key={block.item.id} item={block.item} />,
      )}
      {running && !turnHasLiveItem(turn) && (
        <div className="asv-working">
          <span className="asv-shimmer">工作中</span>
          <LiveTimer startedAt={turn.startedAt} />
        </div>
      )}
      {foot && <div className={`asv-turn-foot is-${turn.status}`}>{foot}</div>}
    </section>
  );
});

const SESSION_STATUS_LABELS: Record<AgentSessionInfo['status'], string> = {
  starting: '启动中',
  idle: '就绪',
  running: '工作中',
  closed: '已结束',
  failed: '失败',
};

function latestDispatchFor(dispatches: OrchestrationDispatchRecord[], workerId?: string, dispatchId?: string) {
  const mine = dispatches.filter((d) => (workerId && d.assigneeHandle === workerId) || d.id === dispatchId);
  return mine.sort((a, b) => a.createdAt.localeCompare(b.createdAt)).at(-1) ?? null;
}

export function AgentSessionView({ win, onNotify }: { win: StageWindow; onNotify?: (message: string) => void }) {
  const [reloadKey, setReloadKey] = useState(0);
  const { timeline, loading, error } = useWorkerTimeline(win.workerId, win.dispatchId, reloadKey);
  const snapshot = useSyncExternalStore(orchestrationClient.subscribe, orchestrationClient.getSnapshot);
  // A direct session belongs to the person at the keyboard; it has no dispatch, task, or report_done.
  const direct = isStandaloneSession(win.workerId);
  const directSessions = useSyncExternalStore(agentSessionClient.subscribe, agentSessionClient.getSnapshot);
  const info = direct ? directSessions.find((entry) => entry.id === win.workerId) : undefined;
  const [nextPolicy, setNextPolicy] = useState<AgentSessionPolicy | null>(null);
  const policy = nextPolicy ?? info?.policy;
  const dispatch = direct ? null : latestDispatchFor(snapshot.dispatches, win.workerId ?? timeline?.workerHandle, win.dispatchId);
  const task = dispatch ? snapshot.tasks.find((t) => t.id === dispatch.taskId) : undefined;
  const role = task?.displayName?.trim().replace(/^@+/, '');
  const title = direct ? info?.title || win.title : role ? `@${role}` : task?.taskTitle || win.title;
  const usage = totalTokenUsage(timeline);
  const running = Boolean(activeTimelineTurn(timeline));
  const alive = direct ? info?.status === 'idle' || info?.status === 'running' : Boolean(timeline?.alive);
  const cwd = info?.cwd ?? dispatch?.worktreePath ?? win.cwd ?? null;
  const targetDispatchId = dispatch?.id ?? win.dispatchId;
  const approvals = useMemo(() => pendingApprovals(timeline), [timeline]);
  const questions = useMemo(
    () => snapshot.questions.filter((q) => q.status === 'pending' && q.dispatchId === targetDispatchId),
    [snapshot.questions, targetDispatchId],
  );
  const appearance = useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getAppearance);
  const sessionId = direct ? win.workerId : undefined;
  const session = useMemo(() => ({
    cwd, appearance, onNotify,
    ...(sessionId ? {
      resolveApproval: async (requestId: string, allow: boolean, reason?: string) =>
        (await window.vibeMeet?.agentSessions?.respond({ id: sessionId, requestId, allow, ...(reason ? { reason } : {}) }))
          ?? { ok: false, error: '会话接口不可用' },
    } : {}),
  }), [cwd, appearance, onNotify, sessionId]);

  const dockRef = useRef<HTMLDivElement>(null);
  const [dockHeight, setDockHeight] = useState(0);
  useLayoutEffect(() => {
    const dock = dockRef.current;
    if (!dock) return;
    const measure = () => setDockHeight(dock.offsetHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(dock);
    return () => observer.disconnect();
  }, []);
  const composerInset = dockHeight + DOCK_GAP;
  const scroll = useTimelineScroll({ lastTurnKey: timeline?.turns.at(-1)?.key ?? null, composerInset });

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

  const send = async (text: string) => {
    if (sessionId) {
      const sessions = window.vibeMeet?.agentSessions;
      if (!sessions) return false;
      const ok = await run('send', () => sessions.send({
        id: sessionId, text, ...(nextPolicy && nextPolicy !== info?.policy ? { policy: nextPolicy } : {}),
      }));
      if (ok) {
        setNextPolicy(null);
        scroll.scrollToEnd();
      }
      return ok;
    }
    if (!targetDispatchId || !api) return false;
    const [first = '', ...rest] = text.split('\n');
    const long = first.length > 200;
    const body = long ? text : rest.join('\n').trim();
    const ok = await run('send', () => api.send({
      to: `dispatch:${targetDispatchId}`,
      subject: long ? `${first.slice(0, 197)}...` : first,
      ...(body ? { body } : {}),
    }));
    if (ok) scroll.scrollToEnd();
    return ok;
  };

  const stop = () => {
    if (sessionId) {
      void run('stop', async () => window.vibeMeet?.agentSessions?.close({ id: sessionId }));
      return;
    }
    if (!targetDispatchId || !api?.workerStop) return;
    void run('stop', () => api.workerStop!({ dispatchId: targetDispatchId, reason: 'Stopped from Agent session' }));
  };

  const interrupt = () => {
    if (sessionId) {
      void run('interrupt', async () => window.vibeMeet?.agentSessions?.interrupt({ id: sessionId }));
      return;
    }
    if (!targetDispatchId || !api?.workerInterrupt) return;
    void run('interrupt', () => api.workerInterrupt!({ dispatchId: targetDispatchId }));
  };

  const stage = dispatch?.stage;
  const stageLabel = direct
    ? (info ? SESSION_STATUS_LABELS[info.status] : '已结束')
    : stage ? STAGE_LABELS[stage] ?? stage : timeline ? (alive ? '运行中' : '已结束') : '';
  const emptyText = !direct ? '这个 Worker 还没有可回放的过程记录。'
    : !info ? '这个会话已经结束。'
      : info.status === 'failed' ? `会话无法启动：${info.error ?? '未知错误'}`
        : info.status === 'starting' ? '正在启动 Codex…' : '发一条消息开始。';

  return (
    <AgentSessionContext.Provider value={session}>
      <div className="agent-session-view" data-running={running || undefined}>
        <header className="asv-header">
          <TerminalProfileIcon id={timeline?.cliId ?? win.localCliId ?? 'codex'} size={16} />
          <span className="asv-title">{title}</span>
          {task?.taskTitle && role && <span className="asv-subtitle">{task.taskTitle}</span>}
          <span className="asv-spacer" />
          {stageLabel && (
            <span className={`asv-stage${stage ? ` is-${stage}` : info?.status === 'running' ? ' is-working' : info?.status === 'failed' ? ' is-failed' : ''}`}>
              <i className="asv-stage-dot" aria-hidden="true" />
              {stageLabel}
            </span>
          )}
          {alive && (
            <button type="button" className="asv-btn is-quiet-danger" disabled={busy === 'stop'} onClick={stop}>
              <Square size={10} fill="currentColor" /> 停止
            </button>
          )}
        </header>

        <div className="asv-scroll" ref={scroll.scrollerRef} onScroll={scroll.onScroll} onClickCapture={scroll.onClickCapture}>
          <div className="asv-content" ref={scroll.contentRef} style={{ paddingBottom: composerInset }}>
            {loading && !timeline && <div className="asv-empty">正在加载会话…</div>}
            {error && (
              <div className="asv-empty">
                {error}
                <button type="button" className="asv-btn" onClick={() => setReloadKey((k) => k + 1)}>重试</button>
              </div>
            )}
            {!loading && !error && !timeline?.turns.length && (!timeline || direct) && <div className="asv-empty">{emptyText}</div>}
            {timeline?.turns.map((turn) => (
              <TurnView key={turn.key} turn={turn} minHeight={turn.key === scroll.anchoredTurnKey ? scroll.anchoredMinHeight : undefined} />
            ))}
          </div>
        </div>

        {!scroll.following && (
          <button type="button" className="asv-to-bottom" style={{ bottom: composerInset - 4 }} onClick={scroll.scrollToEnd} aria-label="回到底部" title="回到底部">
            <ArrowDown size={14} />
          </button>
        )}

        <div className="asv-dock" ref={dockRef}>
          <SessionComposer
            alive={alive}
            running={running}
            sending={busy === 'send'}
            interrupting={busy === 'interrupt'}
            approvals={approvals}
            questions={questions}
            cwd={cwd}
            branch={dispatch?.branch ?? null}
            model={timeline?.model ?? dispatch?.model ?? null}
            readOnly={timeline?.readOnly ?? true}
            direct={direct}
            {...(direct && policy ? { policy, onPolicyChange: setNextPolicy } : {})}
            usage={usage}
            onSend={send}
            onInterrupt={interrupt}
          />
        </div>
      </div>
    </AgentSessionContext.Provider>
  );
}
