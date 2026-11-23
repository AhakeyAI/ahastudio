import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  ArrowDown, BellRing, ChevronRight, CircleAlert, CircleCheck, Cpu, FileText, Folder, History, Hourglass, Image as ImageIcon, PencilLine, Sparkles,
  Square, Workflow,
} from 'lucide-react';
import { useTimelineScroll } from '../hooks/useTimelineScroll';
import { useWorkerTimeline } from '../hooks/useWorkerTimeline';
import { countDiffStats, parseUnifiedDiff } from '../lib/git-panel-model';
import { agentSessionClient, codexCatalogClient, isStandaloneSession, usageLimitsClient } from '../lib/agent-session-client';
import { summarizeUsage, type UsageSummary } from '../lib/usage-limits';
import { effortLabel } from '../lib/composer-tokens';
import { folderName } from '../lib/session-title';
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
  splitSystemWake,
  totalTokenUsage,
  turnHasLiveItem,
} from '../lib/worker-timeline-model';
import { summarizeTurnChanges } from '../lib/turn-changes';
import type {
  AgentSessionInfo,
  AgentSessionPolicy,
  AgentTurnAttachment,
  CodexModelOption,
  OrchestrationDispatchRecord,
  OrchestrationDispatchStage,
  WorkerTimelineFileChange,
  WorkerTimelineItem,
  WorkerTimelineTurn,
} from '../types';
import { CopyButton, DiffBlock } from './agent-session/SessionCode';
import { SessionComposer, type ComposerHandle } from './agent-session/SessionComposer';
import { SessionMarkdown } from './agent-session/SessionMarkdown';
import { SessionTitle } from './agent-session/SessionTitle';
import { SessionEmptyState } from './agent-session/SessionEmptyState';
import { SessionHistoryPanel } from './agent-session/SessionHistoryPanel';
import { FileChangeRows, LiveTimer, WorkGroup, WorkItemRow } from './agent-session/SessionWorkLog';
import { AgentSessionContext, useAgentSession } from './agent-session/session-context';
import { TurnChangesCard } from './agent-session/TurnChangesCard';
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

/** Hover actions under a message; shown by CSS so rows hold no hover state. */
function MessageActions({ text, onEdit }: { text: string; onEdit?: () => void }) {
  if (!text.trim()) return null;
  return (
    <span className="asv-msg-actions">
      <CopyButton text={text} label="复制" className="asv-act" />
      {onEdit && (
        <button type="button" className="asv-act" aria-label="编辑后重发" title="编辑后重发（填回输入框，不会自动发送）" onClick={onEdit}>
          <PencilLine size={13} />
        </button>
      )}
    </span>
  );
}

function UserBubble({ text, caption, attachments, editable = false }: {
  text: string; caption?: string; attachments?: WorkerTimelineTurn['attachments']; editable?: boolean;
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

const TimelineItem = memo(function TimelineItem({ item, inlineDiff }: { item: WorkerTimelineItem; inlineDiff: boolean }) {
  if (item.kind === 'settlement') return <SettlementBlock item={item} />;
  if (item.kind !== 'message') return <WorkItemRow item={item} inlineDiff={inlineDiff} />;
  if (item.role === 'user') return <UserBubble text={item.text} caption="追加指令" />;
  const streaming = item.status === 'running';
  return (
    <div className="asv-assistant" data-asv-row>
      <SessionMarkdown text={item.text} streaming={streaming} />
      {!streaming && <div className="asv-assistant-foot"><MessageActions text={item.text} /></div>}
    </div>
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

function turnFootText(turn: WorkerTimelineTurn): string {
  const elapsed = turn.completedAt ? formatDuration(turn.completedAt - turn.startedAt) : '';
  const label = turn.status === 'interrupted' ? '已中断' : turn.status === 'failed' ? '失败' : '';
  return [label, elapsed && `用时 ${elapsed}`, turn.error].filter(Boolean).join(' · ');
}

const TurnView = memo(function TurnView({ turn, minHeight }: { turn: WorkerTimelineTurn; minHeight?: number }) {
  const { cwd } = useAgentSession();
  const blocks = useMemo(() => groupTimelineItems(turn.items), [turn.items]);
  const running = turn.status === 'running';
  const foot = running ? '' : turnFootText(turn);
  const changes = useMemo(() => (running ? null : summarizeTurnChanges(turn.items, cwd)), [running, turn.items, cwd]);
  const hasCard = Boolean(changes?.files.length);
  const renderBlock = (block: (typeof blocks)[number]) =>
    block.type === 'group' ? <WorkGroup key={block.id} block={block} />
      : <TimelineItem key={block.item.id} item={block.item} inlineDiff={!hasCard} />;
  const isSettlement = (block: (typeof blocks)[number]) => block.type === 'item' && block.item.kind === 'settlement';
  return (
    <section className={`asv-turn is-${turn.status}`} aria-label={`第 ${turn.generation} 轮`} style={minHeight ? { minHeight } : undefined}>
      {turn.origin === 'system'
        ? <SystemWakeRow text={turn.prompt} generation={turn.generation} />
        : <UserBubble text={turn.prompt} caption={`第 ${turn.generation} 轮`} attachments={turn.attachments} editable />}
      {turn.itemsTrimmed && <div className="asv-turn-note">部分较早的过程记录已截断</div>}
      {blocks.filter((block) => !isSettlement(block)).map(renderBlock)}
      {hasCard && <TurnChangesCard changes={changes!} />}
      {blocks.filter(isSettlement).map(renderBlock)}
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
  suspended: '待恢复',
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
  const [nextNetwork, setNextNetwork] = useState<boolean | null>(null);
  const [nextModel, setNextModel] = useState<string | null>(null);
  const [nextEffort, setNextEffort] = useState<string | null>(null);
  const policy = nextPolicy ?? info?.policy;
  const network = nextNetwork ?? info?.network ?? false;
  const resumable = Boolean(info?.providerSessionId) && (info?.status === 'suspended' || info?.status === 'failed');
  const dispatch = direct ? null : latestDispatchFor(snapshot.dispatches, win.workerId ?? timeline?.workerHandle, win.dispatchId);
  const task = dispatch ? snapshot.tasks.find((t) => t.id === dispatch.taskId) : undefined;
  const role = task?.displayName?.trim().replace(/^@+/, '');
  const title = direct ? info?.title || win.title : role ? `@${role}` : task?.taskTitle || win.title;
  const usage = totalTokenUsage(timeline);
  const running = Boolean(activeTimelineTurn(timeline));
  const alive = direct ? info?.status === 'idle' || info?.status === 'running' || resumable : Boolean(timeline?.alive);
  const cwd = info?.cwd ?? dispatch?.worktreePath ?? win.cwd ?? null;
  const targetDispatchId = dispatch?.id ?? win.dispatchId;
  const approvals = useMemo(() => pendingApprovals(timeline), [timeline]);
  const questions = useMemo(
    () => snapshot.questions.filter((q) => q.status === 'pending' && q.dispatchId === targetDispatchId),
    [snapshot.questions, targetDispatchId],
  );
  const appearance = useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getAppearance);
  const sessionId = direct ? win.workerId : undefined;
  const composerRef = useRef<ComposerHandle>(null);
  const editMessage = useCallback((text: string) => composerRef.current?.fill(text), []);
  const canEdit = Boolean(sessionId) && alive;
  const session = useMemo(() => ({
    cwd, appearance, onNotify,
    ...(sessionId ? {
      resolveApproval: async (requestId: string, allow: boolean, reason?: string) =>
        (await window.vibeMeet?.agentSessions?.respond({ id: sessionId, requestId, allow, ...(reason ? { reason } : {}) }))
          ?? { ok: false, error: '会话接口不可用' },
    } : {}),
    ...(canEdit ? { editMessage } : {}),
  }), [cwd, appearance, onNotify, sessionId, canEdit, editMessage]);

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

  const send = async (text: string, attachments: AgentTurnAttachment[] = []) => {
    if (sessionId) {
      const sessions = window.vibeMeet?.agentSessions;
      if (!sessions) return false;
      const ok = await run('send', () => sessions.send({
        id: sessionId, text,
        ...(attachments.length ? { attachments } : {}),
        ...(nextPolicy && nextPolicy !== info?.policy ? { policy: nextPolicy } : {}),
        ...(nextNetwork !== null && nextNetwork !== info?.network ? { network: nextNetwork } : {}),
        ...(nextModel && nextModel !== info?.model ? { model: nextModel } : {}),
        ...(nextEffort && nextEffort !== info?.effort ? { effort: nextEffort } : {}),
      }));
      if (ok) {
        setNextPolicy(null);
        setNextNetwork(null);
        setNextModel(null);
        setNextEffort(null);
        scroll.scrollToEnd();
      }
      return ok;
    }
    if (!text) return false;
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

  const answer = async (requestId: string, answers: Record<string, string[]> | null) => {
    if (!sessionId) return false;
    return run('answer', async () => window.vibeMeet?.agentSessions?.answer({ id: sessionId, requestId, answers }));
  };

  const interrupt = () => {
    if (sessionId) {
      void run('interrupt', async () => window.vibeMeet?.agentSessions?.interrupt({ id: sessionId }));
      return;
    }
    if (!targetDispatchId || !api?.workerInterrupt) return;
    void run('interrupt', () => api.workerInterrupt!({ dispatchId: targetDispatchId }));
  };

  // Switching replaces the Codex process, so it waits until nothing is running or waiting on the person.
  const canToggleOrchestration = Boolean(
    info?.providerSessionId && !running && approvals.length === 0 && !info.pendingQuestions.length &&
      (info.status === 'idle' || resumable),
  );
  const toggleOrchestration = () => {
    if (!sessionId || !info) return;
    const enabled = !info.orchestration;
    void run('orchestration', async () => window.vibeMeet?.agentSessions?.setOrchestration({ id: sessionId, enabled }))
      .then((ok) => {
        if (ok) onNotify?.(enabled ? '已开启编排模式：这个会话可以派发和管理 Worker' : '已关闭编排模式');
      });
  };

  const rename = useCallback(async (next: string) => {
    if (!sessionId) return false;
    const res = await window.vibeMeet?.agentSessions?.rename?.({ id: sessionId, title: next });
    if (!res?.ok) {
      onNotify?.(res?.error ?? '改名失败');
      return false;
    }
    stageWindowStore.renameWindow(win.id, next);
    return true;
  }, [sessionId, onNotify, win.id]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  // The header names the model the way the composer's picker does, once the catalog is loaded.
  const headerModelId = direct ? info?.model ?? null : timeline?.model ?? dispatch?.model ?? null;
  const [modelName, setModelName] = useState<string | null>(null);
  useEffect(() => {
    setModelName(null);
    if (!direct || !headerModelId) return;
    let live = true;
    codexCatalogClient.models().then((models) => {
      const match = models.find((entry) => entry.id === headerModelId || entry.model === headerModelId);
      if (live && match) setModelName(match.displayName);
    }, () => {});
    return () => { live = false; };
  }, [direct, headerModelId]);
  const modelText = headerModelId
    ? `${modelName ?? headerModelId}${direct && info?.effort ? ` · ${effortLabel(info.effort)}` : ''}`
    : null;

  // Account usage is the person's own Codex quota, so only direct sessions show it.
  const [usageLimits, setUsageLimits] = useState<UsageSummary | null>(null);
  const loadUsage = useRef<(force: boolean) => void>(() => {});
  useEffect(() => {
    if (!direct) return;
    let live = true;
    loadUsage.current = (force) => {
      void usageLimitsClient.read(force).then((limits) => {
        if (live) setUsageLimits(summarizeUsage(limits, Date.now()));
      });
    };
    loadUsage.current(false);
    // Also keeps the "resets in" text current.
    const timer = setInterval(() => loadUsage.current(false), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
      loadUsage.current = () => {};
    };
  }, [direct]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) loadUsage.current(true);
    wasRunning.current = running;
  }, [running]);

  const stage = dispatch?.stage;
  const stageLabel = direct
    ? (info ? SESSION_STATUS_LABELS[info.status] : '已结束')
    : stage ? STAGE_LABELS[stage] ?? stage : timeline ? (alive ? '运行中' : '已结束') : '';
  const emptyText = !direct ? '这个 Worker 还没有可回放的过程记录。'
    : !info ? '这个会话已经结束。'
      : info.status === 'failed' && !resumable ? `会话无法启动：${info.error ?? '未知错误'}`
        : info.status === 'starting' ? '正在启动 Codex…' : '发一条消息开始。';

  return (
    <AgentSessionContext.Provider value={session}>
      <div className="agent-session-view" data-running={running || undefined}>
        <header className="asv-header">
          <TerminalProfileIcon id={timeline?.cliId ?? win.localCliId ?? 'codex'} size={16} />
          <SessionTitle title={title} {...(direct && info && info.status !== 'closed' ? { onRename: rename } : {})} />
          {task?.taskTitle && role && <span className="asv-subtitle">{task.taskTitle}</span>}
          {(cwd || modelText) && (
            <span className="asv-head-meta">
              {cwd && <span className="asv-head-chip" title={cwd}><Folder size={12} /><span>{folderName(cwd)}</span></span>}
              {modelText && <span className="asv-head-chip is-model" title="模型 · 推理强度"><Cpu size={12} /><span>{modelText}</span></span>}
            </span>
          )}
          <span className="asv-spacer" />
          {stageLabel && (
            <span className={`asv-stage${stage ? ` is-${stage}` : info?.status === 'running' ? ' is-working' : info?.status === 'failed' ? ' is-failed' : ''}`}>
              <i className="asv-stage-dot" aria-hidden="true" />
              {stageLabel}
            </span>
          )}
          {direct && cwd && window.vibeMeet?.agentSessions?.history && (
            <button
              type="button"
              className={`asv-btn is-ghost${historyOpen ? ' is-pressed' : ''}`}
              aria-pressed={historyOpen}
              title="这个文件夹里以前的 Codex 会话"
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <History size={13} /> 历史
            </button>
          )}
          {direct && info && info.status !== 'closed' && (
            <button
              type="button"
              className={`asv-btn is-ghost asv-orchestration${info.orchestration ? ' is-on' : ''}`}
              aria-pressed={info.orchestration}
              disabled={!canToggleOrchestration || busy === 'orchestration'}
              title={canToggleOrchestration
                ? (info.orchestration ? '关闭后这个会话不再派发和管理 Worker' : '开启后这个会话作为协调者派发和管理 Worker')
                : '本轮结束后才能切换编排模式'}
              onClick={toggleOrchestration}
            >
              <Workflow size={13} /> {busy === 'orchestration' ? '切换中…' : info.orchestration ? '编排模式 · 开' : '编排模式'}
            </button>
          )}
          {alive && !(direct && resumable) && (
            <button type="button" className="asv-btn is-ghost is-quiet-danger" disabled={busy === 'stop'} onClick={stop}
              title={direct ? '结束这个会话' : '停止这个 Worker'}>
              <Square size={11} fill="currentColor" /> 停止
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
            {!loading && !error && !timeline?.turns.length && (
              direct && info && canEdit && info.status !== 'starting'
                ? <SessionEmptyState folder={cwd ? folderName(cwd) : null} policy={policy} onPick={editMessage} />
                : (!timeline || direct) && (
                  <div className="asv-empty">
                    {info?.status === 'starting' ? <span className="asv-shimmer">{emptyText}</span> : emptyText}
                  </div>
                )
            )}
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
            branch={dispatch?.branch ?? null}
            readOnly={timeline?.readOnly}
            direct={direct}
            {...(direct && policy ? { policy, onPolicyChange: setNextPolicy } : {})}
            {...(direct ? {
              network, onNetworkChange: setNextNetwork, resumable,
              directQuestions: info?.pendingQuestions ?? [], onAnswer: answer,
            } : {})}
            {...(direct && sessionId && info && info.status !== 'closed' ? {
              toolbar: {
                sessionId,
                modelId: nextModel ?? info.model,
                effort: nextEffort ?? info.effort,
                onModelChange: (model: CodexModelOption) => {
                  setNextModel(model.id);
                  const effort = nextEffort ?? info.effort;
                  if (!model.efforts.some((option) => option.value === effort)) setNextEffort(model.defaultEffort);
                },
                onEffortChange: setNextEffort,
                onNotify,
              },
            } : {})}
            usage={usage}
            usageLimits={direct ? usageLimits : null}
            draftKey={win.workerId ?? win.id}
            onSend={send}
            onInterrupt={interrupt}
            handleRef={composerRef}
          />
        </div>
        {historyOpen && direct && cwd && (
          <SessionHistoryPanel cwd={cwd} onClose={closeHistory} onOpened={closeHistory} {...(onNotify ? { onNotify } : {})} />
        )}
      </div>
    </AgentSessionContext.Provider>
  );
}
