import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  AtSign,
  Check,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Eye,
  GitBranch,
  Network,
  Pin,
  Send,
  ShieldAlert,
  Sparkles,
  Square,
  Trash2,
  Users,
  X,
} from 'lucide-react';
import type { OrchestrationAgentRosterEntry, OrchestrationDispatchProposal } from '../types';
import { ptyIdForLeaf } from '../lib/agent-status-view';
import { agentStatusClient } from '../lib/agent-status-client';
import { orchestrationClient } from '../lib/orchestration-client';
import {
  buildCrewViewForPane,
  parseQuickDispatchInput,
  type AgentStatusLookup,
  type CrewMemberEntry,
} from '../lib/orchestration-crew-model';
import { isMacSearchPlatform } from '../lib/terminal-search-options';
import { dispatchFocusOrchestrationTarget } from '../lib/terminal-links/orchestration-terminal-links';
import { headlessDispatchForTarget } from '../lib/orchestration-view';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import './orchestration-crew-panel.css';

export interface OrchestrationCrewPanelProps {
  leafId: string;
  cwd?: string;
  agentStatuses: AgentStatusLookup;
  isAgentPane?: boolean;
  searchOpen?: boolean;
  onNotify?: (message: string) => void;
}

interface ProposalDraft {
  agent: string;
  worktree: boolean;
  reason: string;
}

export function OrchestrationCrewPanel({
  leafId,
  cwd,
  agentStatuses,
  isAgentPane = false,
  searchOpen = false,
  onNotify,
}: OrchestrationCrewPanelProps) {
  const snapshot = useSyncExternalStore(
    orchestrationClient.subscribe,
    orchestrationClient.getSnapshot,
  );
  const agentStatusRevision = useSyncExternalStore(
    agentStatusClient.subscribe,
    agentStatusClient.getSnapshot,
  );
  const ptyId = ptyIdForLeaf(leafId);
  const crew = useMemo(
    () => buildCrewViewForPane(snapshot, ptyId, agentStatuses, { isAgentPane }),
    [snapshot, ptyId, agentStatuses, agentStatusRevision, isAgentPane],
  );

  const rootRef = useRef<HTMLDivElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [agentsRoster, setAgentsRoster] = useState<OrchestrationAgentRosterEntry[]>([]);
  const [proposalDrafts, setProposalDrafts] = useState<Record<string, ProposalDraft>>({});
  const [quickInput, setQuickInput] = useState('');
  const [quickWorktree, setQuickWorktree] = useState(true);
  const lastDefaultWorktreeRef = useRef<boolean | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [denyReasonByApproval, setDenyReasonByApproval] = useState<Record<string, string>>({});
  const [previewByDispatch, setPreviewByDispatch] = useState<Record<string, string>>({});
  const [confirmForceReleaseByDispatch, setConfirmForceReleaseByDispatch] = useState<
    Record<string, string>
  >({});

  const modeShortcutLabel = isMacSearchPlatform() ? 'Cmd+Shift+O' : 'Ctrl+Shift+O';

  useEffect(() => {
    const settingsApi = window.vibeMeet.orchestrationSettings;
    if (!settingsApi) return;
    let cancelled = false;
    const syncDefaultWorktree = () => {
      void settingsApi
        .get()
        .then((settings) => {
          if (
            !cancelled &&
            typeof settings?.defaultWorktree === 'boolean' &&
            settings.defaultWorktree !== lastDefaultWorktreeRef.current
          ) {
            lastDefaultWorktreeRef.current = settings.defaultWorktree;
            setQuickWorktree(settings.defaultWorktree);
          }
        })
        .catch(() => {});
    };
    syncDefaultWorktree();
    const offChanged = settingsApi.onChanged?.(syncDefaultWorktree);
    return () => {
      cancelled = true;
      offChanged?.();
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const listAgents = window.vibeMeet.orchestration?.listAgents;
    if (!listAgents) return;
    let cancelled = false;
    void listAgents({ callerPaneId: ptyId })
      .then((res) => {
        if (!cancelled && res.ok) {
          setAgentsRoster(res.agents);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [expanded, ptyId, crew.pendingProposals.length]);

  useEffect(() => {
    if (!expanded) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setExpanded(false);
      }
    };
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (target && rootRef.current && !rootRef.current.contains(target)) {
        setExpanded(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [expanded]);

  const insertTextIntoCurrentTerminal = useCallback(
    async (text: string) => {
      if (!text) return;
      const res = await window.vibeMeet.shellPty.input(ptyId, text);
      if (!res.ok) {
        onNotify?.(res.error ?? '无法写入当前终端');
      }
    },
    [ptyId, onNotify],
  );

  const focusMemberPane = useCallback(
    (entry: {
      ptyId: string | null;
      label: string;
      dispatchId?: string | null;
      taskId?: string | null;
      cwd?: string | null;
      cliId?: string | null;
    }) => {
      const headless = headlessDispatchForTarget(orchestrationClient.getSnapshot(), {
        ptyId: entry.ptyId,
        dispatchId: entry.dispatchId ?? null,
      });
      if (!entry.ptyId && !headless) {
        onNotify?.(`${entry.label} 没有关联的活跃终端`);
        return;
      }
      dispatchFocusOrchestrationTarget({
        kind: 'dispatch',
        label: entry.label,
        ptyId: entry.ptyId ?? headless?.assigneeHandle ?? null,
        dispatchId: entry.dispatchId ?? null,
        taskId: entry.taskId ?? null,
        cwd: entry.cwd ?? null,
        cliId: entry.cliId ?? null,
      });
    },
    [onNotify],
  );

  const handleToggleOrchestrationMode = async () => {
    const api = window.vibeMeet.orchestration?.setPaneMode;
    if (!api) {
      onNotify?.('编排模式接口不可用');
      return;
    }
    setBusyId('pane-mode');
    try {
      const res = await api({ ptyId, enabled: !crew.isOrchestrationMode });
      if (!res.ok) {
        onNotify?.(res.error);
      } else {
        onNotify?.(res.enabled ? '已开启编排模式' : '已关闭编排模式');
      }
    } finally {
      setBusyId(null);
    }
  };

  const getProposalDraft = (proposal: OrchestrationDispatchProposal): ProposalDraft =>
    proposalDrafts[proposal.id] ?? {
      agent: proposal.resolvedAgent || proposal.requestedAgent || 'auto',
      worktree: proposal.worktree,
      reason: '',
    };

  const updateProposalDraft = (
    proposal: OrchestrationDispatchProposal,
    patch: Partial<ProposalDraft>,
  ) => {
    setProposalDrafts((prev) => ({
      ...prev,
      [proposal.id]: {
        ...getProposalDraft(proposal),
        ...patch,
      },
    }));
  };

  const clearProposalDraft = (proposalId: string) => {
    setProposalDrafts((prev) => {
      if (!(proposalId in prev)) return prev;
      const next = { ...prev };
      delete next[proposalId];
      return next;
    });
  };

  const handleApproveProposal = async (proposal: OrchestrationDispatchProposal) => {
    const api = window.vibeMeet.orchestration?.proposalApprove;
    if (!api) return;
    const draft = getProposalDraft(proposal);
    setBusyId(proposal.id);
    try {
      const res = await api({
        id: proposal.id,
        agent: draft.agent,
        worktree: draft.worktree,
      });
      if (!res.ok) {
        onNotify?.(res.error);
      } else {
        clearProposalDraft(proposal.id);
        const role = proposal.role?.trim().replace(/^@+/, '');
        onNotify?.(role ? `已确认拉起 @${role}` : '已确认拉起 Worker');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleRejectProposal = async (proposal: OrchestrationDispatchProposal) => {
    const api = window.vibeMeet.orchestration?.proposalReject;
    if (!api) return;
    const draft = getProposalDraft(proposal);
    setBusyId(proposal.id);
    try {
      const reason = draft.reason.trim();
      const res = await api({
        id: proposal.id,
        ...(reason ? { reason } : {}),
      });
      if (!res.ok) {
        onNotify?.(res.error);
      } else {
        clearProposalDraft(proposal.id);
        onNotify?.('已取消派发');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleQuickDispatch = async () => {
    const parsed = parseQuickDispatchInput(quickInput);
    if (!parsed) {
      onNotify?.('请输入任务内容（如 @codex 补全单测）');
      return;
    }
    const api = window.vibeMeet.orchestration?.delegateTask;
    if (!api) {
      onNotify?.('快捷派发接口不可用');
      return;
    }
    setQuickBusy(true);
    try {
      const res = await api({
        from: ptyId,
        agent: parsed.agent,
        ...(parsed.role ? { role: parsed.role } : {}),
        ...(cwd ? { callerCwd: cwd } : {}),
        task: parsed.task,
        worktree: quickWorktree,
        userInitiated: true,
      });
      if (!res.ok) {
        onNotify?.(res.error);
      } else if (res.status === 'rejected') {
        onNotify?.(res.message ?? '派发已取消');
      } else if (res.status === 'confirmation_required') {
        setQuickInput('');
        onNotify?.('已生成待确认派发，请在编排面板中确认');
      } else {
        setQuickInput('');
        const target = res.role ? `@${res.role}` : res.agent ?? parsed.agent;
        onNotify?.(res.message ?? `已派发给 ${target}`);
      }
    } finally {
      setQuickBusy(false);
    }
  };

  const handleApprove = async (approvalId: string) => {
    const api = window.vibeMeet.orchestration?.approve;
    if (!api) return;
    setBusyId(approvalId);
    try {
      const res = await api({ id: approvalId, from: ptyId });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已允许工具执行');
    } finally {
      setBusyId(null);
    }
  };

  const handleDeny = async (approvalId: string) => {
    const api = window.vibeMeet.orchestration?.deny;
    if (!api) return;
    setBusyId(approvalId);
    try {
      const reason = denyReasonByApproval[approvalId]?.trim() || 'Denied from Crew panel';
      const res = await api({ id: approvalId, from: ptyId, reason });
      if (!res.ok) onNotify?.(res.error);
      else {
        setDenyReasonByApproval((prev) => {
          const next = { ...prev };
          delete next[approvalId];
          return next;
        });
        onNotify?.('已拒绝工具执行');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleReplyQuestion = async (messageId: string, body: string) => {
    const trimmed = body.trim();
    const api = window.vibeMeet.orchestration?.reply;
    if (!trimmed || !api) return;
    setBusyId(messageId);
    try {
      const res = await api({
        id: messageId,
        body: trimmed,
        from: ptyId,
      });
      if (!res.ok) onNotify?.(res.error);
      else {
        setQuestionDrafts((prev) => {
          const next = { ...prev };
          delete next[messageId];
          return next;
        });
        onNotify?.('已回复 Worker 提问');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleResolveGate = async (gateId: string, resolution: string) => {
    const trimmed = resolution.trim();
    const api = window.vibeMeet.orchestration?.gateResolve;
    if (!trimmed || !api) return;
    setBusyId(gateId);
    try {
      const res = await api({
        id: gateId,
        resolution: trimmed,
      });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已通过决策门禁');
    } finally {
      setBusyId(null);
    }
  };

  const handleTogglePreview = async (entry: CrewMemberEntry) => {
    if (!entry.dispatch) return;
    const dId = entry.dispatch.id;
    if (previewByDispatch[dId] !== undefined) {
      setPreviewByDispatch((prev) => {
        const next = { ...prev };
        delete next[dId];
        return next;
      });
      return;
    }
    const api = window.vibeMeet.orchestration?.workerRead;
    if (!api) return;
    setBusyId(`read:${dId}`);
    try {
      const res = await api({ dispatchId: dId, screen: true });
      if (!res.ok) {
        onNotify?.(res.error);
      } else {
        setPreviewByDispatch((prev) => ({
          ...prev,
          [dId]: res.text.trim() || '(终端屏幕当前为空)',
        }));
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleKeepOpen = async (entry: CrewMemberEntry) => {
    const api = window.vibeMeet.orchestration?.workerKeepOpen;
    if (!entry.dispatch || !api) return;
    const dId = entry.dispatch.id;
    setBusyId(`keep:${dId}`);
    try {
      const res = await api({
        dispatchId: dId,
        keepOpen: !entry.retained,
      });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.(res.retained ? '已保留 Worker 终端' : '已取消保留 Worker 终端');
    } finally {
      setBusyId(null);
    }
  };

  const handleRelease = async (entry: CrewMemberEntry, force = false) => {
    const api = window.vibeMeet.orchestration?.workerRelease;
    if (!entry.dispatch || !api) return;
    const dId = entry.dispatch.id;
    setBusyId(`rel:${dId}`);
    try {
      const res = await api({
        dispatchId: dId,
        ...(force ? { force: true } : {}),
      });
      if (!res.ok) {
        if (!force && res.code === 'operation_rejected') {
          setConfirmForceReleaseByDispatch((prev) => ({
            ...prev,
            [dId]: res.error,
          }));
        }
        onNotify?.(res.error);
      } else {
        setConfirmForceReleaseByDispatch((prev) => {
          if (!(dId in prev)) return prev;
          const next = { ...prev };
          delete next[dId];
          return next;
        });
        onNotify?.(res.closedPane ? '已释放 Worker 资源' : '已释放工作树（保留终端）');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (entry: CrewMemberEntry) => {
    const api = window.vibeMeet.orchestration?.workerStop;
    if (!entry.dispatch || !api) return;
    const dId = entry.dispatch.id;
    setBusyId(`stop:${dId}`);
    try {
      const res = await api({
        dispatchId: dId,
        reason: 'Stopped from Crew panel',
      });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已终止 Worker');
    } finally {
      setBusyId(null);
    }
  };

  if (!crew.isVisible) {
    return null;
  }

  const availableAgents = agentsRoster.filter((agent) => agent.available);
  const showRightSummary = crew.pillLabel !== '编排' && crew.pillLabel !== '编排中';
  const hasDrawerContent =
    crew.pendingProposals.length > 0 ||
    crew.openApprovals.length > 0 ||
    crew.openQuestions.length > 0 ||
    crew.openGates.length > 0 ||
    Boolean(crew.managedBy) ||
    crew.managing.length > 0 ||
    crew.talkingWith.length > 0;

  return (
    <div
      ref={rootRef}
      className={`aha-crew-overlay ${searchOpen ? 'is-below-search' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className={`aha-crew-split-pill tone-${crew.pillTone} ${crew.isOrchestrationMode ? 'is-mode-on' : ''} ${expanded ? 'is-open' : ''}`}
      >
        <button
          type="button"
          className={`aha-crew-mode-btn ${crew.isOrchestrationMode ? 'is-active' : ''}`}
          aria-pressed={crew.isOrchestrationMode}
          aria-label={crew.isOrchestrationMode ? '关闭编排模式' : '开启编排模式'}
          title={`切换编排模式 (${modeShortcutLabel})`}
          disabled={busyId === 'pane-mode'}
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => void handleToggleOrchestrationMode()}
        >
          <span
            className={`aha-crew-dot tone-${crew.isOrchestrationMode ? 'accent' : crew.pillTone}`}
            aria-hidden="true"
          />
          <span>{crew.isOrchestrationMode && !showRightSummary ? '编排中' : '编排'}</span>
        </button>
        <span className="aha-crew-pill-divider" aria-hidden="true" />
        <button
          type="button"
          className="aha-crew-drawer-btn"
          aria-expanded={expanded}
          aria-label="Orchestration Crew"
          title="展开编排详情与快捷派发"
          onMouseDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
          onClick={() => setExpanded((prev) => !prev)}
        >
          {showRightSummary && (
            <>
              <Users size={11} />
              <span className="aha-crew-pill-label">{crew.pillLabel}</span>
            </>
          )}
          {crew.attentionCount > 0 && (
            <span className="aha-crew-pill-badge">{crew.attentionCount}</span>
          )}
          {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
      </div>

      {expanded && (
        <div className="aha-crew-drawer" role="region" aria-label="Orchestration Crew 详情">
          <div className="aha-crew-section-header">
            <span>{crew.isOrchestrationMode ? '编排协作 · 已开启' : '编排协作'}</span>
            <button
              type="button"
              className="aha-crew-mention-all"
              title="在右侧栏打开完整协作板"
              onClick={() => {
                setExpanded(false);
                window.dispatchEvent(new CustomEvent('aha:open-orchestration-board'));
              }}
            >
              <Network size={11} /> 协作板
            </button>
          </div>
          {crew.pendingProposals.length > 0 && (
            <section className="aha-crew-section is-alert">
              <header className="aha-crew-section-header">
                <span>
                  <Sparkles size={12} /> 待确认派发 ({crew.pendingProposals.length})
                </span>
              </header>
              {crew.pendingProposals.map((proposal) => {
                const draft = getProposalDraft(proposal);
                const roleLabel = proposal.role?.trim().replace(/^@+/, '') || 'worker';
                const hasSelectedInRoster = availableAgents.some((a) => a.cliId === draft.agent);
                return (
                  <div key={proposal.id} className="aha-crew-alert-card">
                    <div className="aha-crew-alert-title">
                      <span className="aha-crew-proposal-role">
                        <TerminalProfileIcon id={draft.agent} size={12} />
                        <strong>@{roleLabel}</strong>
                      </span>
                      {proposal.taskKind && <small>{proposal.taskKind}</small>}
                    </div>
                    <p className="aha-crew-question-text" title={proposal.task}>
                      {proposal.planSummary?.trim() || proposal.task}
                    </p>
                    <div className="aha-crew-proposal-controls">
                      <select
                        className="aha-crew-select"
                        aria-label={`选择 @${roleLabel} 的 Coding Agent`}
                        value={draft.agent}
                        disabled={busyId === proposal.id}
                        onChange={(e) => updateProposalDraft(proposal, { agent: e.target.value })}
                      >
                        {!hasSelectedInRoster && (
                          <option value={draft.agent}>{draft.agent}</option>
                        )}
                        {availableAgents.map((agent) => (
                          <option key={agent.cliId} value={agent.cliId}>
                            {agent.label}
                            {agent.idlePanes.length > 0 ? ' (空闲窗格)' : ''}
                          </option>
                        ))}
                      </select>
                      <label className="aha-crew-wt-check" title="在独立 Git worktree 中执行">
                        <input
                          type="checkbox"
                          checked={draft.worktree}
                          disabled={busyId === proposal.id}
                          onChange={(e) =>
                            updateProposalDraft(proposal, { worktree: e.target.checked })
                          }
                        />
                        <span>worktree</span>
                      </label>
                    </div>
                    <div className="aha-crew-inline-actions">
                      <input
                        type="text"
                        placeholder="取消原因（可选）"
                        value={draft.reason}
                        disabled={busyId === proposal.id}
                        onChange={(e) => updateProposalDraft(proposal, { reason: e.target.value })}
                      />
                      <button
                        type="button"
                        className="is-ok"
                        disabled={busyId === proposal.id}
                        onClick={() => void handleApproveProposal(proposal)}
                      >
                        <Check size={11} /> 确认拉起
                      </button>
                      <button
                        type="button"
                        className="is-danger"
                        disabled={busyId === proposal.id}
                        onClick={() => void handleRejectProposal(proposal)}
                      >
                        <X size={11} /> 取消
                      </button>
                    </div>
                  </div>
                );
              })}
            </section>
          )}

          {crew.openApprovals.length > 0 && (
            <section className="aha-crew-section is-alert">
              <header className="aha-crew-section-header">
                <span>
                  <ShieldAlert size={12} /> 权限请求 ({crew.openApprovals.length})
                </span>
              </header>
              {crew.openApprovals.map((app) => (
                <div key={app.approvalId} className="aha-crew-alert-card">
                  <div className="aha-crew-alert-title">
                    <strong>{app.toolName}</strong>
                    <small>{app.approvalId}</small>
                  </div>
                  {app.toolInput && <code className="aha-crew-code">{app.toolInput}</code>}
                  <div className="aha-crew-inline-actions">
                    <input
                      type="text"
                      placeholder="拒绝原因（可选）"
                      value={denyReasonByApproval[app.approvalId] ?? ''}
                      onChange={(e) =>
                        setDenyReasonByApproval((prev) => ({
                          ...prev,
                          [app.approvalId]: e.target.value,
                        }))
                      }
                    />
                    <button
                      type="button"
                      className="is-ok"
                      disabled={busyId === app.approvalId}
                      onClick={() => void handleApprove(app.approvalId)}
                    >
                      <Check size={11} /> Allow
                    </button>
                    <button
                      type="button"
                      className="is-danger"
                      disabled={busyId === app.approvalId}
                      onClick={() => void handleDeny(app.approvalId)}
                    >
                      <X size={11} /> Deny
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {crew.openQuestions.length > 0 && (
            <section className="aha-crew-section is-alert">
              <header className="aha-crew-section-header">
                <span>Worker 提问 ({crew.openQuestions.length})</span>
              </header>
              {crew.openQuestions.map((q) => (
                <div key={q.messageId} className="aha-crew-alert-card">
                  <p className="aha-crew-question-text">{q.question}</p>
                  {q.options.length > 0 && (
                    <div className="aha-crew-chips">
                      {q.options.map((opt) => (
                        <button
                          key={opt}
                          type="button"
                          disabled={busyId === q.messageId}
                          onClick={() => void handleReplyQuestion(q.messageId, opt)}
                        >
                          {opt}
                        </button>
                      ))}
                    </div>
                  )}
                  <div className="aha-crew-inline-actions">
                    <input
                      type="text"
                      placeholder="输入回复…"
                      value={questionDrafts[q.messageId] ?? ''}
                      onChange={(e) =>
                        setQuestionDrafts((prev) => ({ ...prev, [q.messageId]: e.target.value }))
                      }
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void handleReplyQuestion(q.messageId, questionDrafts[q.messageId] ?? '');
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="is-accent"
                      disabled={busyId === q.messageId}
                      onClick={() =>
                        void handleReplyQuestion(q.messageId, questionDrafts[q.messageId] ?? '')
                      }
                    >
                      回复
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {crew.openGates.length > 0 && (
            <section className="aha-crew-section is-alert">
              <header className="aha-crew-section-header">
                <span>决策门禁 ({crew.openGates.length})</span>
              </header>
              {crew.openGates.map((g) => (
                <div key={g.id} className="aha-crew-alert-card">
                  <p className="aha-crew-question-text">{g.question}</p>
                  <div className="aha-crew-chips">
                    {(g.options.length > 0 ? g.options : ['approve', 'reject']).map((opt) => (
                      <button
                        key={opt}
                        type="button"
                        disabled={busyId === g.id}
                        onClick={() => void handleResolveGate(g.id, opt)}
                      >
                        {opt}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </section>
          )}

          {crew.managedBy && (
            <section className="aha-crew-section">
              <header className="aha-crew-section-header">
                <span>Managed by</span>
              </header>
              <div className="aha-crew-row">
                <button
                  type="button"
                  className="aha-crew-row-main"
                  title="点击切换到上级终端"
                  onClick={() =>
                    focusMemberPane({
                      ptyId: crew.managedBy!.ptyId,
                      label: crew.managedBy!.label,
                      dispatchId: crew.managedBy!.dispatch?.id,
                      taskId: crew.managedBy!.task?.id,
                      cwd: crew.managedBy!.worktreePath,
                      cliId: crew.managedBy!.cliId,
                    })
                  }
                >
                  <TerminalProfileIcon id={crew.managedBy.cliId ?? undefined} size={13} />
                  <span className="aha-crew-row-text">
                    <strong>{crew.managedBy.label}</strong>
                    <small>{crew.managedBy.subtitle}</small>
                  </span>
                  <span className={`aha-crew-stage tone-${crew.managedBy.tone}`}>
                    {crew.managedBy.stageLabel}
                  </span>
                </button>
                <div className="aha-crew-row-actions">
                  <button
                    type="button"
                    title={`在终端插入 ${crew.managedBy.mentionToken}`}
                    onClick={() =>
                      void insertTextIntoCurrentTerminal(`${crew.managedBy!.mentionToken} `)
                    }
                  >
                    <AtSign size={12} />
                  </button>
                </div>
              </div>
            </section>
          )}

          {crew.managing.length > 0 && (
            <section className="aha-crew-section">
              <header className="aha-crew-section-header">
                <span>Managing ({crew.managing.length})</span>
                <button
                  type="button"
                  className="aha-crew-mention-all"
                  title="在当前终端插入全部下属 Worker 提及"
                  onClick={() => void insertTextIntoCurrentTerminal(crew.mentionAllText)}
                >
                  <AtSign size={11} /> Mention all
                </button>
              </header>
              {crew.managing.map((entry) => {
                const dId = entry.dispatch?.id ?? entry.key;
                const preview = previewByDispatch[dId];
                const forceReleaseReason = confirmForceReleaseByDispatch[dId];
                return (
                  <div key={entry.key} className="aha-crew-item">
                    <div className="aha-crew-row">
                      <button
                        type="button"
                        className="aha-crew-row-main"
                        title="定位到该 Worker 终端"
                        onClick={() =>
                          focusMemberPane({
                            ptyId: entry.ptyId,
                            label: entry.label,
                            dispatchId: entry.dispatch?.id,
                            taskId: entry.task?.id,
                            cwd: entry.worktreePath,
                            cliId: entry.cliId,
                          })
                        }
                      >
                        <TerminalProfileIcon id={entry.cliId ?? undefined} size={13} />
                        <span className="aha-crew-row-text">
                          <strong>{entry.label}</strong>
                          <small>
                            {entry.subtitle}
                            {entry.model
                              ? ` · ${entry.model}${entry.effort ? ` (${entry.effort})` : ''}`
                              : ''}
                            {entry.branch ? (
                              <>
                                {' · '}
                                <GitBranch size={10} style={{ verticalAlign: '-1px' }} />{' '}
                                {entry.branch}
                              </>
                            ) : null}
                          </small>
                        </span>
                        <span className={`aha-crew-stage tone-${entry.tone}`}>
                          {entry.stageLabel}
                        </span>
                      </button>
                      <div className="aha-crew-row-actions">
                        <button
                          type="button"
                          title={`在终端插入 ${entry.mentionToken}`}
                          onClick={() => void insertTextIntoCurrentTerminal(`${entry.mentionToken} `)}
                        >
                          <AtSign size={12} />
                        </button>
                        <button
                          type="button"
                          className={preview !== undefined ? 'is-active' : ''}
                          title="读取 Worker 当前屏幕快照"
                          onClick={() => void handleTogglePreview(entry)}
                        >
                          <Eye size={12} />
                        </button>
                        <button
                          type="button"
                          className={entry.retained ? 'is-active' : ''}
                          title={entry.retained ? '已保留终端（点击取消）' : '保留 Worker 终端'}
                          onClick={() => void handleKeepOpen(entry)}
                        >
                          <Pin size={12} />
                        </button>
                        {entry.isSettled ? (
                          <button
                            type="button"
                            title="释放已完成的 Worker 与工作树"
                            disabled={busyId === `rel:${dId}`}
                            onClick={() => void handleRelease(entry)}
                          >
                            <Trash2 size={12} />
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="is-danger"
                            title="终止该运行中的 Worker"
                            disabled={busyId === `stop:${dId}`}
                            onClick={() => void handleStop(entry)}
                          >
                            <Square size={11} />
                          </button>
                        )}
                      </div>
                    </div>
                    {forceReleaseReason && (
                      <div className="aha-crew-force-confirm" role="alert">
                        <span>{forceReleaseReason}</span>
                        <div className="aha-crew-inline-actions">
                          <button
                            type="button"
                            className="is-danger"
                            disabled={busyId === `rel:${dId}`}
                            onClick={() => void handleRelease(entry, true)}
                          >
                            强制释放
                          </button>
                          <button
                            type="button"
                            disabled={busyId === `rel:${dId}`}
                            onClick={() =>
                              setConfirmForceReleaseByDispatch((prev) => {
                                const next = { ...prev };
                                delete next[dId];
                                return next;
                              })
                            }
                          >
                            取消
                          </button>
                        </div>
                      </div>
                    )}
                    {preview !== undefined && <pre className="aha-crew-preview">{preview}</pre>}
                  </div>
                );
              })}
            </section>
          )}

          {crew.talkingWith.length > 0 && (
            <section className="aha-crew-section">
              <header className="aha-crew-section-header">
                <span>Talking with ({crew.talkingWith.length})</span>
              </header>
              {crew.talkingWith.map((peer) => (
                <div key={peer.key} className="aha-crew-row">
                  <button
                    type="button"
                    className="aha-crew-row-main"
                    onClick={() =>
                      focusMemberPane({
                        ptyId: peer.ptyId,
                        label: peer.label,
                        cliId: peer.cliId,
                      })
                    }
                  >
                    <TerminalProfileIcon id={peer.cliId ?? undefined} size={13} />
                    <span className="aha-crew-row-text">
                      <strong>{peer.label}</strong>
                      <small>{peer.lastSubject}</small>
                    </span>
                    {peer.unreadCount > 0 && (
                      <span className="aha-crew-pill-badge">{peer.unreadCount}</span>
                    )}
                    {peer.ptyId && <ExternalLink size={11} className="aha-crew-ext" />}
                  </button>
                  <div className="aha-crew-row-actions">
                    <button
                      type="button"
                      title={`在终端插入 ${peer.mentionToken}`}
                      onClick={() => void insertTextIntoCurrentTerminal(`${peer.mentionToken} `)}
                    >
                      <AtSign size={12} />
                    </button>
                  </div>
                </div>
              ))}
            </section>
          )}

          {!hasDrawerContent && (
            <div className="aha-crew-empty-hint">
              {crew.isOrchestrationMode
                ? '编排模式已开启：对话即可让当前 Agent 协作派活，或在下方快捷直派。'
                : '点击左侧「编排」开启对话协作，或直接在下方快捷派发任务。'}
            </div>
          )}

          <form
            className="aha-crew-quick-dispatch"
            onSubmit={(e) => {
              e.preventDefault();
              void handleQuickDispatch();
            }}
          >
            <input
              type="text"
              value={quickInput}
              disabled={quickBusy}
              placeholder="@cli 或直接输入任务（回车直派）…"
              aria-label="快捷派发任务"
              onChange={(e) => setQuickInput(e.target.value)}
            />
            <button
              type="button"
              className={`aha-crew-wt-toggle ${quickWorktree ? 'is-active' : ''}`}
              aria-pressed={quickWorktree}
              disabled={quickBusy}
              title={
                quickWorktree
                  ? '使用独立 Git worktree（点击切换为当前目录）'
                  : '使用当前目录（点击切换为独立 Git worktree）'
              }
              onClick={() => setQuickWorktree((prev) => !prev)}
            >
              WT
            </button>
            <button
              type="submit"
              className="aha-crew-quick-send"
              disabled={quickBusy || !quickInput.trim()}
              title="派发任务"
              aria-label="派发任务"
            >
              <Send size={12} />
            </button>
          </form>
        </div>
      )}
    </div>
  );
}
