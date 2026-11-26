import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ArrowDown, Cpu, Folder, History, Square, SquareTerminal, Workflow } from 'lucide-react';
import { useTimelineScroll } from '../hooks/useTimelineScroll';
import { useWorkerTimeline } from '../hooks/useWorkerTimeline';
import { agentSessionClient, codexCatalogClient, isStandaloneSession, usageLimitsClient } from '../lib/agent-session-client';
import { DRIVER_LABELS, sessionCapabilities } from '../lib/session-capabilities';
import { summarizeUsage, type UsageSummary } from '../lib/usage-limits';
import type { GoalCommandAction } from '../lib/composer-slash-commands';
import { effortLabel } from '../lib/composer-tokens';
import { composerDrafts } from '../lib/composer-drafts';
import { createSessionFileLinkChecker } from '../lib/session-file-link-checker';
import { folderName } from '../lib/session-title';
import { selectTurnAnswerItemIds } from '../lib/session-turn-model';
import { orchestrationClient } from '../lib/orchestration-client';
import { stageWindowStore, type StageWindow } from '../lib/stage-window-store';
import { terminalSessionStore } from '../lib/terminal-session-store';
import {
  activeTimelineTurn,
  currentThreadHasTurns,
  pendingApprovals,
  totalTokenUsage,
} from '../lib/worker-timeline-model';
import type {
  AgentSessionInfo,
  AgentSessionPolicy,
  AgentTurnAttachment,
  CodexModelOption,
  OrchestrationDispatchRecord,
  OrchestrationDispatchStage,
} from '../types';
import type { FeedbackBannerState } from './agent-session/ComposerBanners';
import { SessionComposer, type ComposerHandle, type ComposerSlashControl } from './agent-session/SessionComposer';
import { SessionTitle } from './agent-session/SessionTitle';
import { SessionEmptyState } from './agent-session/SessionEmptyState';
import { SessionHistoryPanel } from './agent-session/SessionHistoryPanel';
import { TurnView } from './agent-session/SessionTurnView';
import { AgentSessionContext } from './agent-session/session-context';
import {
  SessionDisclosureContext,
  SessionReplyRevealsContext,
  useSessionDisclosures,
  useSessionReplyReveals,
} from './agent-session/session-disclosure-store';
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
  const caps = sessionCapabilities(info);
  const handoff = info?.handoff ?? null;
  const resumable = !handoff && Boolean(info?.providerSessionId) && (info?.status === 'suspended' || info?.status === 'failed');
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
  const disclosures = useSessionDisclosures();
  const fileLinkExistence = useMemo(() => createSessionFileLinkChecker(cwd), [cwd]);
  const prevFileCheckRunning = useRef<{ existence: typeof fileLinkExistence; running: boolean }>({
    existence: fileLinkExistence,
    running,
  });
  useEffect(() => {
    const prev = prevFileCheckRunning.current;
    prevFileCheckRunning.current = { existence: fileLinkExistence, running };
    if (fileLinkExistence && prev.existence === fileLinkExistence && prev.running && !running) {
      fileLinkExistence.recheck();
    }
  }, [fileLinkExistence, running]);

  const { assistantRowKeys, loadedAssistantIds, latestResponseKey } = useMemo(() => {
    const keys: string[] = [];
    let latest: string | null = null;
    for (const turn of timeline?.turns ?? []) {
      const answerIds = selectTurnAnswerItemIds(turn.items);
      for (const item of turn.items) {
        if (item.kind === 'message' && item.role === 'assistant') {
          const rowKey = `${turn.key}:${item.id}`;
          keys.push(rowKey);
          if (turn.status !== 'running' && item.status !== 'running' && answerIds.has(item.id) && item.text.trim()) {
            latest = rowKey;
          }
        }
      }
    }
    return {
      assistantRowKeys: keys,
      loadedAssistantIds: new Set(keys),
      latestResponseKey: latest,
    };
  }, [timeline?.turns]);
  const replyReveals = useSessionReplyReveals(assistantRowKeys, loadedAssistantIds, !loading && timeline !== null);

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

  const session = useMemo(() => ({
    cwd, appearance, onNotify, fileLinkExistence,
    scrollElementToTop: scroll.scrollElementToTop,
    ...(sessionId ? {
      resolveApproval: async (requestId: string, allow: boolean, reason?: string) =>
        (await window.vibeMeet?.agentSessions?.respond({ id: sessionId, requestId, allow, ...(reason ? { reason } : {}) }))
          ?? { ok: false, error: '会话接口不可用' },
    } : {}),
    ...(canEdit ? { editMessage } : {}),
  }), [cwd, appearance, onNotify, fileLinkExistence, scroll.scrollElementToTop, sessionId, canEdit, editMessage]);

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

  const send = async (text: string, attachments: AgentTurnAttachment[] = [], options?: { freshContext?: boolean }) => {
    if (sessionId) {
      const sessions = window.vibeMeet?.agentSessions;
      if (!sessions) return false;
      // Through the queue, a message written during a turn goes out after it, in order.
      const deliver = sessions.enqueue ?? sessions.send;
      const ok = await run('send', () => deliver({
        id: sessionId, text,
        ...(attachments.length ? { attachments } : {}),
        ...(options?.freshContext ? { freshContext: true } : {}),
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

  const setOrchestrationMode = useCallback((mode: 'toggle' | 'on' | 'off') => {
    if (!sessionId || !info) return;
    const enabled = mode === 'toggle' ? !info.orchestration : mode === 'on';
    if (enabled === info.orchestration) {
      onNotify?.(enabled ? '编排模式已经是开启状态' : '编排模式已经是关闭状态');
      return;
    }
    if (!canToggleOrchestration || busy === 'orchestration') {
      onNotify?.('本轮结束后才能切换编排模式');
      return;
    }
    void run('orchestration', async () => window.vibeMeet?.agentSessions?.setOrchestration({ id: sessionId, enabled }))
      .then((ok) => {
        if (ok) onNotify?.(enabled ? '已开启编排模式：这个会话可以派发和管理 Worker' : '已关闭编排模式');
      });
  }, [sessionId, info, canToggleOrchestration, busy, onNotify]);

  // The terminal pane writes the conversation from here on; this view sends nothing until it is taken back.
  const hasThreadTurns = currentThreadHasTurns(timeline?.turns ?? []);
  const canHandoff = Boolean(
    direct && info && caps.terminalResume && !handoff && info.providerSessionId && hasThreadTurns && !info.orchestration &&
      !running && approvals.length === 0 && !info.pendingQuestions.length && (info.status === 'idle' || resumable),
  );
  const continueInTerminal = () => {
    if (!sessionId || !info) return;
    void run('handoff', async () => {
      const res = await window.vibeMeet?.agentSessions?.handoff?.({ id: sessionId });
      if (!res) return { ok: false, error: '当前环境无法打开终端' };
      if (!res.ok) return res;
      const terminalId = res.ptyId.replace(/^local-/u, '');
      await stageWindowStore.createWindow('terminal', {
        windowId: terminalId, localCliId: res.cliId, cwd: res.cwd, title: `${DRIVER_LABELS[res.cliId]}（续）`,
      });
      onNotify?.('已在终端中继续这个会话；退出终端后可以回到这里');
      return { ok: true };
    });
  };
  const handoffTerminalOpen = useSyncExternalStore(stageWindowStore.subscribe, () => {
    const ptyId = handoff?.ptyId;
    if (!ptyId) return false;
    const terminalId = ptyId.replace(/^local-/u, '');
    return stageWindowStore.getSnapshot().windows.some((w) => w.id === terminalId || Boolean(w.panes?.[terminalId]));
  });
  const reclaim = () => {
    if (!sessionId) return;
    void run('reclaim', async () => window.vibeMeet?.agentSessions?.reclaim?.({ id: sessionId }))
      .then((ok) => {
        if (ok) onNotify?.('已回到这里；发送消息会接着同一个会话');
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

  // A waiting `/clear` lives in the draft store, so switching tabs and back keeps it.
  const draftKey = win.workerId ?? win.id;
  const [freshSessionArmed, setFreshSessionArmedState] = useState(() => Boolean(composerDrafts.get(draftKey).freshContext));
  const setFreshSessionArmed = useCallback((armed: boolean) => {
    composerDrafts.set(draftKey, { freshContext: armed });
    setFreshSessionArmedState(armed);
  }, [draftKey]);
  const [usageLimitsOpen, setUsageLimitsOpen] = useState(false);
  const [usageLimitsRefreshing, setUsageLimitsRefreshing] = useState(false);
  const [feedbackState, setFeedbackState] = useState<FeedbackBannerState | null>(null);
  const [goalBusy, setGoalBusy] = useState(false);
  useEffect(() => {
    // Another session's own waiting `/clear` (if any) comes back from the draft store.
    setFreshSessionArmedState(Boolean(composerDrafts.get(draftKey).freshContext));
    setUsageLimitsOpen(false);
    setFeedbackState(null);
  }, [sessionId, draftKey]);

  const armFreshSession = useCallback(() => setFreshSessionArmed(true), [setFreshSessionArmed]);
  const disarmFreshSession = useCallback(() => setFreshSessionArmed(false), [setFreshSessionArmed]);
  const closeUsageLimits = useCallback(() => setUsageLimitsOpen(false), []);
  const dismissFeedback = useCallback(() => setFeedbackState(null), []);

  const queue = useMemo(() => {
    const api = window.vibeMeet?.agentSessions;
    if (!sessionId || !info || !api?.enqueue || !api.unqueue || !api.resumeQueue) return undefined;
    const { unqueue, resumeQueue } = api;
    return {
      items: info.queued ?? [],
      paused: Boolean(info.queuePaused),
      take: async (messageId: string) => {
        const res = await unqueue({ id: sessionId, messageId });
        if (!res.ok) onNotify?.(res.error);
        return res.ok ? res.message : null;
      },
      resume: () => {
        void resumeQueue({ id: sessionId }).then((res) => {
          if (!res.ok) onNotify?.(res.error);
        });
      },
    };
  }, [sessionId, info, onNotify]);

  const [historyOpen, setHistoryOpen] = useState(false);
  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  // The header names the model the way the composer's picker does, once the catalog is loaded.
  const headerModelId = direct ? info?.model ?? null : timeline?.model ?? dispatch?.model ?? null;
  const [modelName, setModelName] = useState<string | null>(null);
  useEffect(() => {
    setModelName(null);
    if (!direct || !headerModelId || !sessionId) return;
    let live = true;
    codexCatalogClient.sessionModels(sessionId, info?.provider).then((models) => {
      const match = models.find((entry) => entry.id === headerModelId || entry.model === headerModelId);
      if (live && match) setModelName(match.displayName);
    }, () => {});
    return () => { live = false; };
  }, [direct, headerModelId, sessionId, info?.provider]);
  const modelText = headerModelId
    ? `${modelName ?? headerModelId}${direct && info?.effort ? ` · ${effortLabel(info.effort)}` : ''}`
    : null;

  // Account usage is the person's own Codex quota, so only direct sessions show it.
  const [usageLimits, setUsageLimits] = useState<UsageSummary | null>(null);
  const loadUsage = useRef<(force: boolean) => Promise<UsageSummary | null>>(async () => null);
  const showsUsageLimits = direct && caps.usageLimits;
  useEffect(() => {
    if (!showsUsageLimits) return;
    let live = true;
    loadUsage.current = async (force) => {
      const limits = await usageLimitsClient.read(force);
      const summary = summarizeUsage(limits, Date.now());
      if (live) setUsageLimits(summary);
      return summary;
    };
    void loadUsage.current(false);
    // Also keeps the "resets in" text current.
    const timer = setInterval(() => void loadUsage.current(false), 60_000);
    return () => {
      live = false;
      clearInterval(timer);
      loadUsage.current = async () => null;
    };
  }, [showsUsageLimits]);
  const wasRunning = useRef(running);
  useEffect(() => {
    if (wasRunning.current && !running) void loadUsage.current(true);
    wasRunning.current = running;
  }, [running]);

  const openUsageLimits = useCallback(() => {
    if (usageLimits) setUsageLimitsOpen(true);
    setUsageLimitsRefreshing(true);
    void loadUsage.current(true).then((summary) => {
      if (summary) {
        setUsageLimitsOpen(true);
      } else {
        setUsageLimitsOpen(false);
        onNotify?.('当前账号没有可用的 Codex 额度信息');
      }
    }).finally(() => setUsageLimitsRefreshing(false));
  }, [usageLimits, onNotify]);

  const refreshUsageLimits = useCallback(() => {
    setUsageLimitsRefreshing(true);
    void loadUsage.current(true).finally(() => setUsageLimitsRefreshing(false));
  }, []);

  const canHistory = Boolean(direct && cwd && caps.history && window.vibeMeet?.agentSessions?.history);
  const openHistory = useCallback(() => {
    if (canHistory) setHistoryOpen(true);
  }, [canHistory]);

  const runGoalCommand = useCallback(async (action: GoalCommandAction): Promise<boolean> => {
    if (!sessionId) return false;
    const goalApi = window.vibeMeet?.agentSessions?.goal;
    if (!goalApi) {
      onNotify?.('当前环境不支持 /goal 命令');
      return false;
    }
    setGoalBusy(true);
    try {
      const res = await goalApi({ id: sessionId, action });
      if (!res.ok) {
        onNotify?.(res.error);
        return false;
      }
      if (res.message) onNotify?.(res.message);
      if (action.type === 'set' || action.type === 'resume') scroll.scrollToEnd();
      return true;
    } finally {
      setGoalBusy(false);
    }
  }, [sessionId, onNotify, scroll]);

  const runFeedbackCommand = useCallback((reason?: string) => {
    if (!sessionId) return;
    const uploadApi = window.vibeMeet?.agentSessions?.uploadFeedback;
    if (!uploadApi) {
      onNotify?.('当前环境不支持 /feedback 命令');
      return;
    }
    setFeedbackState({ status: 'uploading' });
    void uploadApi({ id: sessionId, ...(reason ? { reason } : {}) }).then(
      (res) => {
        if (res.ok) setFeedbackState({ status: 'sent', feedbackId: res.feedbackId });
        else setFeedbackState({ status: 'failed', error: res.error });
      },
      (err: unknown) => {
        setFeedbackState({ status: 'failed', error: err instanceof Error ? err.message : String(err) });
      },
    );
  }, [sessionId, onNotify]);

  const slashControl = useMemo<ComposerSlashControl | undefined>(() => {
    if (!direct || !sessionId || !info || info.status === 'closed') return undefined;
    return {
      currentTitle: title,
      // A waiting `/clear` means the next message starts a new thread, so there is nothing to compact.
      hasTurns: !freshSessionArmed && hasThreadTurns,
      hasUsageLimits: caps.usageLimits && Boolean(window.vibeMeet?.agentSessions?.rateLimits),
      canHistory,
      // A title is kept here for every driver; only some also store it with the provider.
      canRename: Boolean(window.vibeMeet?.agentSessions?.rename),
      canOrchestration: caps.orchestration && Boolean(window.vibeMeet?.agentSessions?.setOrchestration),
      orchestrationOn: info.orchestration,
      canCompact: caps.compact,
      canGoal: caps.goal,
      canFeedback: caps.feedback,
      canModel: caps.models,
      freshSessionArmed,
      goal: info.goal ?? null,
      goalBusy,
      usageLimitsOpen,
      usageLimitsRefreshing,
      feedback: feedbackState,
      onArmFreshSession: armFreshSession,
      onDisarmFreshSession: disarmFreshSession,
      onOpenUsageLimits: openUsageLimits,
      onRefreshUsageLimits: refreshUsageLimits,
      onCloseUsageLimits: closeUsageLimits,
      onOpenHistory: openHistory,
      onRename: rename,
      onSetOrchestration: setOrchestrationMode,
      onGoalCommand: runGoalCommand,
      onFeedbackCommand: runFeedbackCommand,
      onDismissFeedback: dismissFeedback,
    };
  }, [
    direct, sessionId, info, caps, canHistory, title, timeline?.turns, freshSessionArmed, goalBusy,
    usageLimitsOpen, usageLimitsRefreshing, feedbackState, armFreshSession, disarmFreshSession,
    openUsageLimits, refreshUsageLimits, closeUsageLimits, openHistory, rename, setOrchestrationMode,
    runGoalCommand, runFeedbackCommand, dismissFeedback,
  ]);

  const stage = dispatch?.stage;
  const stageLabel = direct
    ? (info ? SESSION_STATUS_LABELS[info.status] : '已结束')
    : stage ? STAGE_LABELS[stage] ?? stage : timeline ? (alive ? '运行中' : '已结束') : '';
  const emptyText = !direct ? '这个 Worker 还没有可回放的过程记录。'
    : !info ? '这个会话已经结束。'
      : info.status === 'failed' && !resumable ? `会话无法启动：${info.error ?? '未知错误'}`
        : info.status === 'starting' ? '正在启动会话…' : '发一条消息开始。';

  return (
    <AgentSessionContext.Provider value={session}>
      <SessionDisclosureContext.Provider value={disclosures}>
        <SessionReplyRevealsContext.Provider value={replyReveals}>
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
          {direct && info && caps.terminalResume && !handoff && info.status !== 'closed' && window.vibeMeet?.agentSessions?.handoff && (
            <button
              type="button"
              className="asv-btn is-ghost"
              disabled={!canHandoff || busy === 'handoff'}
              title={canHandoff
                ? `暂停这里，在终端里用 ${DRIVER_LABELS[info.provider]} 自己的界面继续同一个会话`
                : info.orchestration ? '先关闭编排模式，再在终端中继续'
                  : !info.providerSessionId || !hasThreadTurns ? '发送第一条消息后才能在终端中继续' : '本轮结束后才能在终端中继续'}
              onClick={continueInTerminal}
            >
              <SquareTerminal size={13} /> {busy === 'handoff' ? '打开终端…' : '在终端中继续'}
            </button>
          )}
          {canHistory && (
            <button
              type="button"
              className={`asv-btn is-ghost${historyOpen ? ' is-pressed' : ''}`}
              aria-pressed={historyOpen}
              title="这个文件夹里以前的历史会话"
              onClick={() => setHistoryOpen((value) => !value)}
            >
              <History size={13} /> 历史
            </button>
          )}
          {direct && info && caps.orchestration && info.status !== 'closed' && (
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
              <TurnView
                key={turn.key}
                turn={turn}
                minHeight={turn.key === scroll.anchoredTurnKey ? scroll.anchoredMinHeight : undefined}
                stopping={busy === 'interrupt' && turn.status === 'running'}
                latestResponseKey={latestResponseKey}
              />
            ))}
          </div>
        </div>

        {!scroll.following && (
          <button type="button" className="asv-to-bottom" style={{ bottom: composerInset - 4 }} onClick={scroll.scrollToEnd} aria-label="回到底部" title="回到底部">
            <ArrowDown size={14} />
          </button>
        )}

        <div className="asv-dock" ref={dockRef}>
          {direct && handoff && (
            <div className="asv-handoff" role="status">
              <SquareTerminal size={14} aria-hidden="true" />
              <span>
                {handoffTerminalOpen
                  ? '这个会话正在终端里继续。退出终端里的 CLI 或关闭终端后，可以回到这里接着对话。'
                  : '终端已关闭，可以回到这里接着对话。'}
              </span>
              <button type="button" className="asv-btn" disabled={busy === 'reclaim'} onClick={reclaim}>
                {busy === 'reclaim' ? '收回中…' : '回到这里'}
              </button>
            </div>
          )}
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
            {...(queue ? { queue } : {})}
            {...(direct && policy ? { policy, onPolicyChange: setNextPolicy } : {})}
            {...(direct ? {
              ...(caps.network ? { network, onNetworkChange: setNextNetwork } : {}),
              ...(handoff ? { endedText: '会话正在终端中继续，这里暂停发送' } : {}),
              resumable,
              directQuestions: info?.pendingQuestions ?? [], onAnswer: answer,
            } : {})}
            {...(direct && sessionId && info && info.status !== 'closed' ? {
              toolbar: {
                sessionId,
                provider: info.provider,
                capabilities: caps,
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
            {...(slashControl ? { slash: slashControl } : {})}
            usage={usage}
            usageLimits={showsUsageLimits ? usageLimits : null}
            draftKey={draftKey}
            onSend={send}
            onInterrupt={interrupt}
            handleRef={composerRef}
          />
        </div>
        {historyOpen && direct && cwd && (
          <SessionHistoryPanel cwd={cwd} onClose={closeHistory} onOpened={closeHistory} {...(onNotify ? { onNotify } : {})} />
        )}
      </div>
        </SessionReplyRevealsContext.Provider>
      </SessionDisclosureContext.Provider>
    </AgentSessionContext.Provider>
  );
}
