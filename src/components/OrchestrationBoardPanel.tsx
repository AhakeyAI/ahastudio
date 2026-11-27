import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cpu,
  GitBranch,
  GitMerge,
  Network,
  Pause,
  Pin,
  Play,
  Search,
  Send,
  ShieldAlert,
  ShieldCheck,
  SkipBack,
  Sparkles,
  Square,
  Trash2,
  User,
  X,
} from 'lucide-react';
import type {
  OrchestrationAgentRosterEntry,
  OrchestrationBoardPostKind,
  OrchestrationDispatchProposal,
} from '../types';
import { agentStatusDetail, agentStatusLabel } from '../lib/agent-status-view';
import { agentSessionClient } from '../lib/agent-session-client';
import { agentStatusClient } from '../lib/agent-status-client';
import { orchestrationClient } from '../lib/orchestration-client';
import {
  buildBoardGraphModel,
  buildBoardViewModel,
  parseInlineBoardTokens,
  roleColorIndex,
  sessionCoordinatorState,
  type BoardGraphNode,
  type BoardMemberCard,
  type BoardPostView,
} from '../lib/orchestration-board-model';
import { isMacSearchPlatform } from '../lib/terminal-search-options';
import { dispatchFocusOrchestrationTarget } from '../lib/terminal-links/orchestration-terminal-links';
import { headlessDispatchForTarget } from '../lib/orchestration-view';
import { useAgentStatuses } from './AgentStatusBadge';
import type { AgentPromptTarget } from './PanelPreview';
import {
  proposalControlOverrides,
  proposalControlsDefault,
  type ProposalWorkerControlsDraft,
} from '../lib/session-capabilities';
import { ProposalWorkerControls } from './ProposalWorkerControls';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import { WorkerNativeQuestionCard } from './WorkerNativeQuestionCard';
import './orchestration-board-panel.css';

type BoardSubTab = 'board' | 'members' | 'graph';

const KIND_LABELS: Record<OrchestrationBoardPostKind, string> = {
  brief: '派发',
  post: '发言',
  update: '进展',
  handoff: '交接',
  question: '提问',
  answer: '回复',
  report: '汇报',
  approval: '审批',
  stall: '停滞',
  system: '系统',
};

const PILL_HEIGHT = 28;

function computePillEdgePoint(
  node: BoardGraphNode,
  targetX: number,
  targetY: number,
  pad = 4,
): { x: number; y: number } {
  const dx = targetX - node.x;
  const dy = targetY - node.y;
  const hw = node.width / 2 + pad;
  const hh = PILL_HEIGHT / 2 + pad;
  if (Math.abs(dx) < 0.001 && Math.abs(dy) < 0.001) {
    return { x: node.x, y: node.y };
  }
  const scaleX = Math.abs(dx) > 0.001 ? hw / Math.abs(dx) : Number.POSITIVE_INFINITY;
  const scaleY = Math.abs(dy) > 0.001 ? hh / Math.abs(dy) : Number.POSITIVE_INFINITY;
  const t = Math.min(scaleX, scaleY);
  return { x: node.x + dx * t, y: node.y + dy * t };
}

function isLongPost(body: string): boolean {
  return body.length > 420 || body.split(/\r?\n/).length > 6;
}

type LiveWorkspaceAgentItem =
  | {
      kind: 'pane';
      target: AgentPromptTarget;
      ptyId: string;
      label: string;
      cliId: string | null;
      tone: string;
      stageLabel: string;
      detail: string;
      isOrchestrationMode: boolean;
      isActive: boolean;
    }
  | {
      kind: 'session';
      sessionId: string;
      windowId: string;
      label: string;
      cliId: string;
      tone: string;
      stageLabel: string;
      detail: string;
      isActive: boolean;
    };

function renderAvatarContent(role: string, cliId: string | null) {
  if (cliId) return <TerminalProfileIcon id={cliId} size={14} />;
  const lower = role.toLowerCase();
  if (lower === 'user') return <User size={13} />;
  if (lower === 'system') return <Cpu size={13} />;
  return <span>{(role[0] ?? '?').toUpperCase()}</span>;
}

export function OrchestrationBoardPanel({
  activePtyId,
  agentTargets = [],
  sessionTargets = [],
  onFocusAgentTarget,
  onFocusAgentSession,
  onNotify,
}: {
  activePtyId?: string;
  agentTargets?: AgentPromptTarget[];
  /** Orchestrating Agent sessions open in this workspace folder (no PTY, not prompt targets). */
  sessionTargets?: { sessionId: string; windowId: string; title: string; isActive: boolean }[];
  onFocusAgentTarget?: (target: AgentPromptTarget) => void;
  onFocusAgentSession?: (windowId: string) => void;
  onNotify?: (message: string) => void;
}) {
  const snapshot = useSyncExternalStore(
    orchestrationClient.subscribe,
    orchestrationClient.getSnapshot,
  );
  const agentStatusRev = useSyncExternalStore(
    agentStatusClient.subscribe,
    agentStatusClient.getSnapshot,
  );
  const agents = useAgentStatuses();

  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [subTab, setSubTab] = useState<BoardSubTab>('board');

  // Board filter & interaction state
  const [boardSearch, setBoardSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<string>('all');
  const [kindFilter, setKindFilter] = useState<string>('all');
  const [expandedPosts, setExpandedPosts] = useState<Record<string, boolean>>({});
  const [expandedArtifacts, setExpandedArtifacts] = useState<Record<string, boolean>>({});
  const [highlightedSeq, setHighlightedSeq] = useState<number | null>(null);

  // Composer state
  const [composerText, setComposerText] = useState('');
  const [composerFocused, setComposerFocused] = useState(false);
  const [composerBusy, setComposerBusy] = useState(false);

  // Inline action states
  const [busyId, setBusyId] = useState<string | null>(null);
  const [questionDrafts, setQuestionDrafts] = useState<Record<string, string>>({});
  const [agentsRoster, setAgentsRoster] = useState<OrchestrationAgentRosterEntry[]>([]);
  const [proposalDrafts, setProposalDrafts] = useState<
    Record<string, ProposalWorkerControlsDraft & { agent: string; worktree: boolean; authorizeReviews: boolean }>
  >({});

  // Members search state
  const [memberSearch, setMemberSearch] = useState('');

  // Graph replay & controls state
  const [replaySeq, setReplaySeq] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<number>(1);
  const [hideInactive, setHideInactive] = useState(false);
  const [expandAll, setExpandAll] = useState(false);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);

  const postRefs = useRef(new Map<number, HTMLElement>());
  const feedRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const prevHeadSeqRef = useRef(0);
  const seenActiveRunIdsRef = useRef<Set<string> | null>(null);
  const composerInputRef = useRef<HTMLInputElement | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const livePaneIds = useMemo(
    () => new Set(agentTargets.map((target) => target.ptyId)),
    [agentTargets],
  );
  const agentSessions = useSyncExternalStore(agentSessionClient.subscribe, agentSessionClient.getSnapshot);
  const sessionCoordinators = useMemo(
    () => new Map(agentSessions.filter((session) => session.orchestration).map((session) => (
      [session.id, { provider: session.provider, state: sessionCoordinatorState(session) }] as const
    ))),
    [agentSessions],
  );

  // Sync fresh orchestration & agent statuses whenever the Board tab mounts.
  useEffect(() => {
    void orchestrationClient.refresh();
    void agentStatusClient.refresh();
  }, []);

  // Auto-follow whenever a brand-new active collaboration run starts.
  useEffect(() => {
    const activeIds = snapshot.runs.filter((r) => r.status === 'active').map((r) => r.id);
    if (seenActiveRunIdsRef.current === null) {
      seenActiveRunIdsRef.current = new Set(activeIds);
      return;
    }
    const brandNew = activeIds.find((id) => !seenActiveRunIdsRef.current!.has(id));
    seenActiveRunIdsRef.current = new Set(activeIds);
    if (brandNew) {
      setSelectedRunId(null);
      setReplaySeq(null);
      setPlaying(false);
    }
  }, [snapshot.runs]);

  const model = useMemo(
    () =>
      buildBoardViewModel(snapshot, {
        runId: selectedRunId,
        agentStatuses: agents,
        activePtyId: activePtyId ?? null,
        livePaneIds,
        sessionCoordinators,
      }),
    [snapshot, selectedRunId, agents, agentStatusRev, activePtyId, livePaneIds, sessionCoordinators],
  );

  useEffect(() => {
    setReplaySeq(null);
    setPlaying(false);
    setRoleFilter('all');
    setKindFilter('all');
    stickToBottomRef.current = true;
    prevHeadSeqRef.current = 0;
  }, [model.run?.id]);

  // Auto-scroll to the latest post when new board messages arrive and the user is at the bottom.
  useEffect(() => {
    if (subTab !== 'board') return;
    if (model.headSeq > prevHeadSeqRef.current && stickToBottomRef.current) {
      const raf = requestAnimationFrame(() => {
        const el = feedRef.current;
        if (el) {
          el.scrollTo({ top: el.scrollHeight, behavior: prevHeadSeqRef.current === 0 ? 'auto' : 'smooth' });
        }
      });
      prevHeadSeqRef.current = model.headSeq;
      return () => cancelAnimationFrame(raf);
    }
    prevHeadSeqRef.current = model.headSeq;
    return undefined;
  }, [model.headSeq, subTab]);

  useEffect(() => {
    if (model.pendingProposals.length === 0) return;
    const listAgents = window.vibeMeet.orchestration?.listAgents;
    if (!listAgents) return;
    let cancelled = false;
    void listAgents({ callerPaneId: activePtyId })
      .then((res) => {
        if (!cancelled && res.ok) setAgentsRoster(res.agents);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [model.pendingProposals.length, activePtyId]);

  useEffect(
    () => () => {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    },
    [],
  );

  // Auto-replay timer in Graph sub-view
  useEffect(() => {
    if (!playing || subTab !== 'graph') return;
    if (model.headSeq <= 0) {
      setPlaying(false);
      return;
    }
    const intervalMs = Math.max(250, Math.round(1100 / speed));
    const timer = setInterval(() => {
      setReplaySeq((current) => {
        const cur = current ?? 0;
        if (cur >= model.headSeq) {
          setPlaying(false);
          return null;
        }
        const next = cur + 1;
        if (next >= model.headSeq) {
          setPlaying(false);
          return null;
        }
        return next;
      });
    }, intervalMs);
    return () => clearInterval(timer);
  }, [playing, subTab, speed, model.headSeq]);

  const roleLookup = useMemo(() => {
    const map = new Map<
      string,
      { ptyId: string | null; label: string; cliId: string | null; dispatchId?: string; taskId?: string; cwd?: string | null }
    >();
    if (model.coordinator) {
      map.set('coordinator', {
        ptyId: model.coordinator.ptyId,
        label: '@coordinator',
        cliId: model.coordinator.cliId,
      });
    }
    for (const member of model.members) {
      map.set(member.role.toLowerCase(), {
        ptyId: member.ptyId,
        label: member.label,
        cliId: member.cliId,
        dispatchId: member.dispatchId,
        taskId: member.taskId,
        cwd: member.worktreePath,
      });
    }
    return map;
  }, [model.coordinator, model.members]);

  const focusRole = useCallback(
    (role: string): boolean => {
      const target = roleLookup.get(role.toLowerCase());
      if (!target) return false;
      const headless = headlessDispatchForTarget(snapshot, {
        ptyId: target.ptyId,
        dispatchId: target.dispatchId ?? null,
      });
      if (!target.ptyId && !headless) return false;
      dispatchFocusOrchestrationTarget({
        kind: 'dispatch',
        label: target.label,
        ptyId: target.ptyId ?? headless?.assigneeHandle ?? null,
        dispatchId: target.dispatchId ?? null,
        taskId: target.taskId ?? null,
        cwd: target.cwd ?? null,
        cliId: target.cliId ?? null,
      });
      return true;
    },
    [roleLookup, snapshot],
  );

  const handleMentionClick = useCallback(
    (role: string) => {
      const lower = role.toLowerCase();
      if (lower === 'all' || lower === 'workers') return;
      if (!focusRole(lower)) {
        setRoleFilter((prev) => (prev === lower ? 'all' : lower));
      }
    },
    [focusRole],
  );

  useEffect(() => {
    if (highlightedSeq === null || subTab !== 'board') return;
    const raf = requestAnimationFrame(() => {
      postRefs.current.get(highlightedSeq)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
    return () => cancelAnimationFrame(raf);
  }, [highlightedSeq, subTab]);

  const jumpToSeq = useCallback((seq: number) => {
    setSubTab('board');
    setBoardSearch('');
    setRoleFilter('all');
    setKindFilter('all');
    setHighlightedSeq(seq);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    highlightTimerRef.current = setTimeout(() => setHighlightedSeq(null), 1800);
  }, []);

  const handleBoardPost = async () => {
    const trimmed = composerText.trim();
    if (!trimmed || !model.run) return;
    const api = window.vibeMeet.orchestration?.boardPost;
    if (!api) {
      onNotify?.('协作板发帖接口不可用');
      return;
    }
    setComposerBusy(true);
    try {
      const res = await api({ runId: model.run.id, text: trimmed });
      if (!res.ok) {
        onNotify?.(res.error);
      } else {
        setComposerText('');
        stickToBottomRef.current = true;
      }
    } finally {
      setComposerBusy(false);
    }
  };

  const handleTogglePaneMode = async (ptyId: string, currentlyEnabled: boolean) => {
    const api = window.vibeMeet.orchestration?.setPaneMode;
    if (!api) {
      onNotify?.('编排模式接口不可用');
      return;
    }
    setBusyId(`mode:${ptyId}`);
    try {
      const res = await api({ ptyId, enabled: !currentlyEnabled });
      if (!res.ok) {
        onNotify?.(res.error);
      } else {
        onNotify?.(res.enabled ? '已开启编排模式' : '已关闭编排模式');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleClearHistory = async () => {
    if (model.hasAnyActiveRun) {
      onNotify?.('仍有进行中的协作任务，无法清理历史');
      return;
    }
    const api = window.vibeMeet.orchestration?.reset;
    if (!api) return;
    setBusyId('reset-history');
    try {
      const res = await api({ all: true });
      if (!res.ok) {
        onNotify?.(res.error);
      } else {
        setSelectedRunId(null);
        onNotify?.('已清理历史协作记录');
      }
    } finally {
      setBusyId(null);
    }
  };

  const insertComposerMention = (token: string) => {
    setComposerText((prev) => {
      const suffix = prev.length === 0 || prev.endsWith(' ') ? `${token} ` : ` ${token} `;
      return `${prev}${suffix}`;
    });
    composerInputRef.current?.focus();
  };

  const handleApprovePermission = async (approvalId: string) => {
    const api = window.vibeMeet.orchestration?.approve;
    if (!api) return;
    setBusyId(`app:${approvalId}`);
    try {
      const res = await api({ id: approvalId, from: 'user' });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已允许工具执行');
    } finally {
      setBusyId(null);
    }
  };

  const handleDenyPermission = async (approvalId: string) => {
    const api = window.vibeMeet.orchestration?.deny;
    if (!api) return;
    setBusyId(`app:${approvalId}`);
    try {
      const res = await api({
        id: approvalId,
        from: 'user',
        reason: 'Denied from Board panel',
      });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已拒绝工具执行');
    } finally {
      setBusyId(null);
    }
  };

  const handleReplyQuestion = async (messageId: string, body: string) => {
    const trimmed = body.trim();
    const api = window.vibeMeet.orchestration?.reply;
    if (!trimmed || !api) return;
    setBusyId(`q:${messageId}`);
    try {
      const res = await api({ id: messageId, body: trimmed, from: 'user' });
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
    const api = window.vibeMeet.orchestration?.gateResolve;
    if (!api) return;
    setBusyId(`gate:${gateId}`);
    try {
      const res = await api({ id: gateId, resolution });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已通过决策门禁');
    } finally {
      setBusyId(null);
    }
  };

  const getProposalDraft = (p: OrchestrationDispatchProposal) =>
    proposalDrafts[p.id] ?? {
      agent: p.resolvedAgent || p.requestedAgent || 'auto',
      worktree: p.worktree,
      ...proposalControlsDefault(p),
      authorizeReviews: p.authorizeReviews ?? true,
    };

  const handleApproveProposal = async (proposal: OrchestrationDispatchProposal) => {
    const api = window.vibeMeet.orchestration?.proposalApprove;
    if (!api) return;
    const draft = getProposalDraft(proposal);
    setBusyId(`prop:${proposal.id}`);
    try {
      const res = await api({
        id: proposal.id,
        agent: draft.agent,
        worktree: draft.worktree,
        ...proposalControlOverrides(proposal, draft.agent, draft, snapshot.dispatches),
        authorizeReviews: draft.authorizeReviews,
      });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.(`已确认拉起 @${proposal.role?.replace(/^@+/, '') || 'worker'}`);
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleRunAutoReview = async () => {
    const api = window.vibeMeet.orchestration?.runSetAutoReview;
    if (!api || !model.run) return;
    const nextEnabled = !model.reviewAutoAuthorized;
    setBusyId(`run-auto-review:${model.run.id}`);
    try {
      const res = await api({ runId: model.run.id, enabled: nextEnabled });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.(nextEnabled ? '已开启本轮免确认自动审查' : '已切换为审查前手动确认');
    } finally {
      setBusyId(null);
    }
  };

  const handleStartRunReview = async () => {
    const api = window.vibeMeet.orchestration?.delegateTask;
    if (!api || !model.run) return;
    setBusyId(`run-review:${model.run.id}`);
    try {
      const res = await api({
        runId: model.run.id,
        reviewRun: true,
        userInitiated: true,
      });
      if (!res.ok) onNotify?.(res.error);
      else if (res.status === 'started') {
        onNotify?.(`已启动整体验收审查（${res.agent ?? 'heterogeneous'}）`);
      } else {
        onNotify?.(res.message || '整体验收审查未启动');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleFinalizeRun = async (force = false) => {
    const api = window.vibeMeet.orchestration?.runFinalize;
    if (!api || !model.run) return;
    setBusyId(`run-finalize:${model.run.id}`);
    try {
      const res = await api({
        runId: model.run.id,
        mode: 'squash',
        ...(force ? { force: true } : {}),
      });
      if (!res.ok) onNotify?.(res.error);
      else if (res.integrated) {
        onNotify?.(`已将 ${res.integrationBranch} 合并回 ${res.targetBranch ?? 'main'}`);
      } else if (res.noChanges) {
        onNotify?.('集成分支与主分支无差异，已标记收尾');
      } else {
        onNotify?.(res.message || '合回主分支未完成，请检查冲突');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleTriggerWorkerReview = async (member: BoardMemberCard) => {
    const api = window.vibeMeet.orchestration?.delegateTask;
    if (!api || !model.run) return;
    setBusyId(`rev:${member.dispatchId}`);
    try {
      const res = await api({
        runId: model.run.id,
        reviewOf: member.dispatchId,
        userInitiated: true,
      });
      if (!res.ok) onNotify?.(res.error);
      else if (res.status === 'started') {
        onNotify?.(`已对 ${member.label} 发起异构审查（${res.agent ?? 'heterogeneous'}）`);
      } else {
        onNotify?.(res.message || '审查未启动');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleIntegrateWorker = async (member: BoardMemberCard, force = false) => {
    const api = window.vibeMeet.orchestration?.workerIntegrate;
    if (!api) return;
    setBusyId(`int:${member.dispatchId}`);
    try {
      const res = await api({
        dispatchId: member.dispatchId,
        mode: 'squash',
        targetBranch: 'auto',
        ...(force ? { force: true } : {}),
      });
      if (!res.ok) onNotify?.(res.error);
      else if (res.integrated) {
        onNotify?.(
          res.usedRunIntegrationBranch
            ? `已将 ${member.label} 暂存至集成分支 ${res.targetBranch ?? ''}`
            : `已将 ${member.label} 合入 ${res.targetBranch ?? 'main'}`,
        );
      } else if (res.noChanges) {
        onNotify?.(`${member.label} 无代码差异，已标记集成`);
      } else {
        onNotify?.(res.message || '集成存在冲突，请处理后重试');
      }
    } finally {
      setBusyId(null);
    }
  };

  const handleRejectProposal = async (proposal: OrchestrationDispatchProposal) => {
    const api = window.vibeMeet.orchestration?.proposalReject;
    if (!api) return;
    setBusyId(`prop:${proposal.id}`);
    try {
      const res = await api({ id: proposal.id });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.('已取消派发');
    } finally {
      setBusyId(null);
    }
  };

  const handleKeepOpen = async (member: BoardMemberCard) => {
    const api = window.vibeMeet.orchestration?.workerKeepOpen;
    if (!api) return;
    setBusyId(`pin:${member.dispatchId}`);
    try {
      const res = await api({ dispatchId: member.dispatchId, keepOpen: !member.retained });
      if (!res.ok) onNotify?.(res.error);
      else onNotify?.(res.retained ? '已保留 Worker 终端' : '已取消保留 Worker 终端');
    } finally {
      setBusyId(null);
    }
  };

  const handleReleaseOrStop = async (member: BoardMemberCard) => {
    if (member.isSettled) {
      const api = window.vibeMeet.orchestration?.workerRelease;
      if (!api) return;
      setBusyId(`rel:${member.dispatchId}`);
      try {
        const res = await api({ dispatchId: member.dispatchId });
        if (!res.ok) onNotify?.(res.error);
        else onNotify?.(res.closedPane ? '已释放 Worker 资源' : '已释放工作树');
      } finally {
        setBusyId(null);
      }
    } else {
      const api = window.vibeMeet.orchestration?.workerStop;
      if (!api) return;
      setBusyId(`stop:${member.dispatchId}`);
      try {
        const res = await api({ dispatchId: member.dispatchId, reason: 'Stopped from Board panel' });
        if (!res.ok) onNotify?.(res.error);
        else onNotify?.('已终止 Worker');
      } finally {
        setBusyId(null);
      }
    }
  };

  const shortcutLabel = isMacSearchPlatform() ? 'Cmd+Shift+O' : 'Ctrl+Shift+O';

  // Unique roles appearing in posts + team for filter dropdown
  const filterRoles = useMemo(() => {
    const seen = new Map<string, string>();
    if (model.coordinator) seen.set('coordinator', 'coordinator');
    for (const m of model.members) seen.set(m.role.toLowerCase(), m.role);
    for (const p of model.posts) {
      const lower = p.fromRole.toLowerCase();
      if (!seen.has(lower)) seen.set(lower, p.fromRole);
    }
    return [...seen.entries()];
  }, [model.coordinator, model.members, model.posts]);

  const reviewerRolesByTarget = useMemo(() => {
    const map = new Map<string, Set<string>>();
    for (const m of model.members) {
      if (m.reviewerRoles.length > 0) {
        map.set(m.role.toLowerCase(), new Set(m.reviewerRoles));
      }
    }
    return map;
  }, [model.members]);

  const filteredPosts = useMemo(() => {
    const q = boardSearch.trim().toLowerCase();
    const reviewerRolesForFilter =
      roleFilter !== 'all' ? reviewerRolesByTarget.get(roleFilter) : undefined;
    return model.posts.filter((post) => {
      if (roleFilter !== 'all') {
        const postAuthorLower = post.fromRole.toLowerCase();
        const matchesAuthor = postAuthorLower === roleFilter;
        const matchesMention = post.mentions.includes(roleFilter);
        const matchesReviewerForTarget = Boolean(reviewerRolesForFilter?.has(postAuthorLower));
        if (!matchesAuthor && !matchesMention && !matchesReviewerForTarget) return false;
      }
      if (kindFilter !== 'all' && post.kind !== kindFilter) return false;
      if (q) {
        const hay = `${post.fromRole} ${post.mentions.join(' ')} #${post.boardSeq} ${post.subject} ${post.body}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [model.posts, boardSearch, roleFilter, kindFilter, reviewerRolesByTarget]);

  // Match open approvals / questions to posts so actions render inline where possible
  const questionByMessageId = useMemo(
    () => new Map(model.openQuestions.map((q) => [q.messageId, q])),
    [model.openQuestions],
  );
  const approvalByPostId = useMemo(() => {
    const map = new Map<string, (typeof model.openApprovals)[number]>();
    const claimed = new Set<string>();
    for (const post of model.posts) {
      if (post.kind !== 'approval') continue;
      const hit = model.openApprovals.find(
        (a) =>
          !claimed.has(a.approvalId) &&
          (post.body.includes(a.approvalId) ||
            post.subject.includes(a.toolName) ||
            post.fromHandle === `dispatch:${a.dispatchId}` ||
            post.fromHandle === a.ptyId),
      );
      if (hit) {
        map.set(post.id, hit);
        claimed.add(hit.approvalId);
      }
    }
    return { map, unclaimed: model.openApprovals.filter((a) => !claimed.has(a.approvalId)) };
  }, [model.posts, model.openApprovals]);

  const filteredMembers = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return model.members;
    return model.members.filter((m) =>
      `${m.role} ${m.cliId ?? ''} ${m.model ?? ''} ${m.taskSummary} ${m.branch ?? ''} ${m.latestPostPreview}`
        .toLowerCase()
        .includes(q),
    );
  }, [model.members, memberSearch]);

  const showCoordinatorInMembers = useMemo(() => {
    if (!model.coordinator) return false;
    const q = memberSearch.trim().toLowerCase();
    if (!q) return true;
    return `coordinator ${model.coordinator.cliId ?? ''} ${model.coordinator.subtitle} ${model.coordinator.latestPostPreview}`
      .toLowerCase()
      .includes(q);
  }, [model.coordinator, memberSearch]);

  const isReplayLive = replaySeq === null;
  const effectiveUpToSeq = replaySeq === null ? model.headSeq : Math.min(replaySeq, model.headSeq);

  const graph = useMemo(
    () =>
      buildBoardGraphModel(model.posts, model.members, model.coordinator, {
        upToSeq: replaySeq,
        hideInactive,
        expandAll,
      }),
    [model.posts, model.members, model.coordinator, replaySeq, hideInactive, expandAll],
  );

  const graphNodeById = useMemo(
    () => new Map(graph.nodes.map((node) => [node.id, node])),
    [graph.nodes],
  );

  const renderInlineTokens = (line: string) =>
    parseInlineBoardTokens(line).map((tok, idx) => {
      switch (tok.kind) {
        case 'bold':
          return <strong key={idx}>{tok.text}</strong>;
        case 'code':
          return (
            <code key={idx} className="obp-inline-code">
              {tok.text}
            </code>
          );
        case 'mention':
          return (
            <button
              key={idx}
              type="button"
              className="obp-mention-pill"
              onClick={() => handleMentionClick(String(tok.value ?? ''))}
            >
              {tok.text}
            </button>
          );
        case 'ref':
          return (
            <button
              key={idx}
              type="button"
              className="obp-ref-pill"
              title={`跳转到 ${tok.text}`}
              onClick={() => jumpToSeq(Number(tok.value))}
            >
              {tok.text}
            </button>
          );
        default:
          return <span key={idx}>{tok.text}</span>;
      }
    });

  const renderPostBody = (body: string) => {
    const lines = body.split(/\r?\n/);
    const blocks: Array<{ kind: 'list'; items: string[] } | { kind: 'p'; lines: string[] }> = [];
    for (const raw of lines) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const bulletMatch = /^(?:[-*•]|\d+\.)\s+(.+)$/.exec(trimmed);
      if (bulletMatch) {
        const last = blocks.at(-1);
        if (last && last.kind === 'list') {
          last.items.push(bulletMatch[1]!);
        } else {
          blocks.push({ kind: 'list', items: [bulletMatch[1]!] });
        }
      } else {
        const last = blocks.at(-1);
        if (last && last.kind === 'p') {
          last.lines.push(trimmed);
        } else {
          blocks.push({ kind: 'p', lines: [trimmed] });
        }
      }
    }
    return (
      <div className="obp-post-content">
        {blocks.map((block, bIdx) =>
          block.kind === 'list' ? (
            <ul key={bIdx} className="obp-post-list">
              {block.items.map((item, iIdx) => (
                <li key={iIdx}>{renderInlineTokens(item)}</li>
              ))}
            </ul>
          ) : (
            <p key={bIdx} className="obp-post-para">
              {block.lines.map((line, lIdx) => (
                <span key={lIdx}>
                  {lIdx > 0 && <br />}
                  {renderInlineTokens(line)}
                </span>
              ))}
            </p>
          ),
        )}
      </div>
    );
  };

  const orchestrationModeSet = useMemo(
    () => new Set(snapshot.orchestrationModePanes ?? []),
    [snapshot.orchestrationModePanes],
  );

  // Live open Agent CLI terminals in the current workspace, synced with agentStatusClient & orchestration mode.
  const liveWorkspaceAgents: LiveWorkspaceAgentItem[] = useMemo(() => {
    const runPaneIds = new Set<string>();
    if (model.isLive) {
      if (model.coordinator?.ptyId) runPaneIds.add(model.coordinator.ptyId);
      for (const m of model.members) {
        if (m.ptyId && !m.released) runPaneIds.add(m.ptyId);
      }
    }
    const panes = agentTargets
      .filter((target) => target.isAgent && !runPaneIds.has(target.ptyId))
      .map((target) => {
        const liveStatus = agents.get(target.ptyId) ?? target.status ?? null;
        const state = liveStatus?.state ?? 'idle';
        const tone =
          state === 'working'
            ? 'accent'
            : state === 'waiting'
              ? 'warn'
              : state === 'done'
                ? 'ok'
                : state === 'error'
                  ? 'error'
                  : 'neutral';
        const stageLabel = liveStatus ? agentStatusLabel(liveStatus) : '空闲';
        const detail = liveStatus ? agentStatusDetail(liveStatus) : '';
        return {
          kind: 'pane' as const,
          target,
          ptyId: target.ptyId,
          label: target.label,
          cliId: liveStatus?.agentId ?? target.cliId ?? null,
          tone,
          stageLabel,
          detail,
          isOrchestrationMode: orchestrationModeSet.has(target.ptyId),
          isActive: target.isActive,
        };
      });
    // Orchestrating Agent sessions in this folder appear alongside the terminals; they are the
    // same kind of Coordinator the panes are, so a live run's coordinator is skipped identically.
    const sessions = sessionTargets
      .filter((target) => !runPaneIds.has(target.sessionId))
      .map((target) => {
        const coordinator = sessionCoordinators.get(target.sessionId);
        const state = coordinator?.state ?? 'offline';
        const tone =
          state === 'working' ? 'accent' : state === 'waiting' ? 'warn' : state === 'idle' ? 'ok' : 'neutral';
        const stageLabel =
          state === 'working' ? '执行中' : state === 'waiting' ? '待回答' : state === 'idle' ? '在线' : '离线';
        return {
          kind: 'session' as const,
          sessionId: target.sessionId,
          windowId: target.windowId,
          label: target.title,
          cliId: coordinator?.provider ?? 'codex',
          tone,
          stageLabel,
          detail: '',
          isActive: target.isActive,
        };
      });
    return [...sessions, ...panes];
  }, [agentTargets, sessionTargets, agents, agentStatusRev, model.isLive, model.coordinator?.ptyId, model.members, orchestrationModeSet, sessionCoordinators]);

  const filteredLiveAgents = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return liveWorkspaceAgents;
    return liveWorkspaceAgents.filter((item) =>
      `${item.label} ${item.cliId ?? ''} ${item.stageLabel} ${item.detail}`.toLowerCase().includes(q),
    );
  }, [liveWorkspaceAgents, memberSearch]);

  const renderLiveWorkspaceAgentsList = (
    items: typeof liveWorkspaceAgents,
    compactHeading?: string,
  ) => (
    <div className="obp-live-section">
      {compactHeading && <div className="obp-team-heading">{compactHeading}</div>}
      {items.map((item) =>
        item.kind === 'session' ? (
          <div
            key={item.sessionId}
            className={`obp-member-card is-worker is-workspace-live ${item.isActive ? 'is-focused-pane' : ''}`}
          >
            <button
              type="button"
              className="obp-member-card-body"
              onClick={() => onFocusAgentSession?.(item.windowId)}
            >
              <div className="obp-member-card-top">
                <span className="obp-avatar-wrap">
                  <span className={`obp-avatar obp-avatar-c${roleColorIndex(item.cliId ?? item.label)}`}>
                    {renderAvatarContent(item.label, item.cliId)}
                  </span>
                  <span className={`obp-status-dot tone-${item.tone}`} />
                </span>
                <div className="obp-member-title-col">
                  <div className="obp-member-name-row">
                    <strong>{item.label}</strong>
                    <span className={`obp-stage-pill tone-${item.tone}`}>{item.stageLabel}</span>
                  </div>
                </div>
              </div>
            </button>
            <div className="obp-member-actions">
              <span className="obp-mode-chip is-on">协调者</span>
            </div>
          </div>
        ) : (
          <div
            key={item.ptyId}
            className={`obp-member-card is-worker is-workspace-live ${item.isActive ? 'is-focused-pane' : ''}`}
          >
            <button
              type="button"
              className="obp-member-card-body"
              onClick={() => onFocusAgentTarget?.(item.target)}
            >
              <div className="obp-member-card-top">
                <span className="obp-avatar-wrap">
                  <span className={`obp-avatar obp-avatar-c${roleColorIndex(item.cliId ?? item.label)}`}>
                    {renderAvatarContent(item.label, item.cliId)}
                  </span>
                  <span className={`obp-status-dot tone-${item.tone}`} />
                </span>
                <div className="obp-member-title-col">
                  <div className="obp-member-name-row">
                    <strong>{item.label}</strong>
                    <span className={`obp-stage-pill tone-${item.tone}`}>{item.stageLabel}</span>
                  </div>
                  {item.detail && <p className="obp-member-live-activity">{item.detail}</p>}
                </div>
              </div>
            </button>
            <div className="obp-member-actions">
              <button
                type="button"
                className={`obp-mode-chip ${item.isOrchestrationMode ? 'is-on' : ''}`}
                title={item.isOrchestrationMode ? '点击关闭该终端编排模式' : '点击开启该终端编排模式'}
                disabled={busyId === `mode:${item.ptyId}`}
                onClick={() => void handleTogglePaneMode(item.ptyId, item.isOrchestrationMode)}
              >
                {item.isOrchestrationMode ? '编排中' : '编排'}
              </button>
            </div>
          </div>
        ),
      )}
    </div>
  );

  if (!model.run && model.pendingProposals.length === 0) {
    return (
      <div className="obp-root">
        <div className="obp-empty-wrap">
          <div className="wrp-empty obp-empty">
            <Network size={22} />
            {model.focusedSessionCoordinator ? (
              <p>此会话是协调者，还没有协作。发消息让它派发 Worker。</p>
            ) : (
              <>
                <p>暂无进行中的协作任务</p>
                <small>
                  开启任一终端的「编排」模式（或按 {shortcutLabel}），即可自动派发多 Agent 协作
                </small>
              </>
            )}
          </div>
          {liveWorkspaceAgents.length > 0 && (
            <div className="obp-members-list">
              {renderLiveWorkspaceAgentsList(
                liveWorkspaceAgents,
                `当前活跃 AGENT · ${liveWorkspaceAgents.length}`,
              )}
            </div>
          )}
        </div>
      </div>
    );
  }

  const availableAgents = agentsRoster.filter((a) => a.available);
  const memberTotalCount =
    (model.coordinator ? 1 : 0) + model.members.length + liveWorkspaceAgents.length;
  const quickMentionRoles = [
    ...(model.coordinator ? ['coordinator'] : []),
    ...model.members.filter((m) => !m.released).map((m) => m.role),
    'all',
  ];

  const renderProposalStrip = (proposals: OrchestrationDispatchProposal[]) =>
    proposals.map((proposal) => {
      const draft = getProposalDraft(proposal);
      const roleLabel = proposal.role?.trim().replace(/^@+/, '') || 'worker';
      const hasSelected = availableAgents.some((a) => a.cliId === draft.agent);
      const context = proposal.taskContext;
      const contextPreview = [context?.background, context?.constraints?.[0], context?.files?.[0], context?.acceptance]
        .filter(Boolean)
        .join(' · ');
      return (
        <div key={proposal.id} className="obp-inline-card is-warn">
          <div className="obp-inline-card-head">
            <span>
              <Sparkles size={12} /> 待确认派发 <strong>@{roleLabel}</strong>
            </span>
            {proposal.taskKind && <span className="wrp-chip">{proposal.taskKind}</span>}
          </div>
          <p className="obp-inline-card-text" title={proposal.task}>
            {proposal.planSummary?.trim() || proposal.task}
          </p>
          {context && (
            <details className="obp-proposal-context">
              <summary className="obp-proposal-context-toggle">
                <span className="obp-proposal-context-open">展开上下文</span>
                <span className="obp-proposal-context-close">收起上下文</span>
                {contextPreview && <span className="obp-proposal-context-preview">{contextPreview}</span>}
              </summary>
              <dl className="obp-proposal-context-content">
                {context.background && (
                  <>
                    <dt>背景</dt>
                    <dd>{context.background}</dd>
                  </>
                )}
                {context.constraints && context.constraints.length > 0 && (
                  <>
                    <dt>约束</dt>
                    <dd>
                      <ul>{context.constraints.map((constraint) => <li key={constraint}>{constraint}</li>)}</ul>
                    </dd>
                  </>
                )}
                {context.files && context.files.length > 0 && (
                  <>
                    <dt>文件</dt>
                    <dd>
                      <ul>{context.files.map((file) => <li key={file}><code>{file}</code></li>)}</ul>
                    </dd>
                  </>
                )}
                {context.acceptance && (
                  <>
                    <dt>验收</dt>
                    <dd>{context.acceptance}</dd>
                  </>
                )}
              </dl>
            </details>
          )}
          <div className="obp-inline-card-controls">
            <select
              className="obp-select"
              aria-label={`选择 @${roleLabel} 的 Coding Agent`}
              value={draft.agent}
              disabled={busyId === `prop:${proposal.id}`}
              onChange={(e) =>
                setProposalDrafts((prev) => ({
                  ...prev,
                  [proposal.id]: { ...draft, agent: e.target.value },
                }))
              }
            >
              {!hasSelected && <option value={draft.agent}>{draft.agent}</option>}
              {availableAgents.map((agent) => (
                <option key={agent.cliId} value={agent.cliId}>
                  {agent.label}
                </option>
              ))}
            </select>
            <label className="wrp-check obp-wt-check">
              <input
                type="checkbox"
                checked={draft.worktree}
                disabled={busyId === `prop:${proposal.id}`}
                onChange={(e) =>
                  setProposalDrafts((prev) => ({
                    ...prev,
                    [proposal.id]: { ...draft, worktree: e.target.checked },
                  }))
                }
              />
              <span>worktree</span>
            </label>
            <ProposalWorkerControls
              variant="board"
              proposal={proposal}
              agent={draft.agent}
              draft={draft}
              dispatches={snapshot.dispatches}
              disabled={busyId === `prop:${proposal.id}`}
              onChange={(patch) =>
                setProposalDrafts((prev) => ({ ...prev, [proposal.id]: { ...draft, ...patch } }))
              }
            />
            <label
              className="wrp-check obp-wt-check"
              title="批准后本轮 Run 内的后续异构审查与整体验收自动放行，不再重复弹窗确认"
            >
              <input
                type="checkbox"
                checked={draft.authorizeReviews}
                disabled={busyId === `prop:${proposal.id}`}
                onChange={(e) =>
                  setProposalDrafts((prev) => ({
                    ...prev,
                    [proposal.id]: { ...draft, authorizeReviews: e.target.checked },
                  }))
                }
              />
              <span>免确认后续审查</span>
            </label>
            <div className="obp-inline-card-btns">
              <button
                type="button"
                className="wrp-btn is-primary obp-btn-sm"
                disabled={busyId === `prop:${proposal.id}`}
                onClick={() => void handleApproveProposal(proposal)}
              >
                <Check size={11} /> 确认拉起
              </button>
              <button
                type="button"
                className="wrp-btn is-danger obp-btn-sm"
                disabled={busyId === `prop:${proposal.id}`}
                onClick={() => void handleRejectProposal(proposal)}
              >
                <X size={11} /> 取消
              </button>
            </div>
          </div>
        </div>
      );
    });

  return (
    <div className="obp-root">
      {/* Shared Header */}
      <header className="obp-header">
        <div className="obp-header-top">
          {model.runs.length > 1 ? (
            <select
              className="obp-run-select"
              aria-label="选择协作任务"
              value={model.run?.id ?? ''}
              onChange={(e) => setSelectedRunId(e.target.value || null)}
            >
              {model.runs.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.objective || r.id}
                </option>
              ))}
            </select>
          ) : (
            <h3 className="obp-run-title" title={model.run?.objective ?? ''}>
              {model.run?.objective || '待确认派发'}
            </h3>
          )}
          <span className={`obp-live-pill ${model.isLive ? 'is-live' : 'is-done'}`}>
            <span className="obp-live-dot" aria-hidden="true" />
            {model.runStatusLabel}
          </span>
          {!model.hasAnyActiveRun && model.runs.length > 0 && (
            <button
              type="button"
              className="wrp-icon-btn obp-clear-history-btn"
              title="清理历史协作记录"
              aria-label="清理历史协作记录"
              disabled={busyId === 'reset-history'}
              onClick={() => void handleClearHistory()}
            >
              <Trash2 size={12} />
            </button>
          )}
        </div>
        {(model.runIntegrationBadge || model.runReviewBadge) && (
          <div className="obp-header-badges">
            {model.runIntegrationBadge && (
              <span
                className={`obp-stage-pill obp-header-badge tone-${model.runIntegrationBadge.tone}`}
                title={model.runIntegrationBadge.label}
              >
                {model.runIntegrationBadge.label}
              </span>
            )}
            {model.runReviewBadge && (
              <span
                className={`obp-stage-pill obp-header-badge tone-${model.runReviewBadge.tone}`}
                title={model.runReviewBadge.label}
              >
                {model.runReviewBadge.label}
              </span>
            )}
          </div>
        )}
        {model.run && model.isLive && (
          <div className="obp-header-controls">
            <button
              type="button"
              className={`obp-auto-review-pill ${model.reviewAutoAuthorized ? 'is-enabled' : ''}`}
              title={
                model.reviewAutoAuthorized
                  ? '本轮 Run 的后续异构审查与整体验收已授权免确认（点击关闭）'
                  : '开启后，本轮 Run 内的后续异构审查与整体验收将自动放行，不再重复确认'
              }
              disabled={busyId === `run-auto-review:${model.run.id}`}
              onClick={() => void handleToggleRunAutoReview()}
            >
              <ShieldCheck size={11} />
              <span>{model.reviewAutoAuthorized ? '免确认审查：开' : '免确认审查：关'}</span>
            </button>
            {model.canStartRunReview && (
              <button
                type="button"
                className="wrp-btn obp-btn-sm"
                title="对本轮已合并的全部改动发起异构整体验收审查"
                disabled={busyId === `run-review:${model.run.id}`}
                onClick={() => void handleStartRunReview()}
              >
                <ShieldCheck size={11} /> 整体验收
              </button>
            )}
            {model.canFinalizeRun && (
              <button
                type="button"
                className={`wrp-btn obp-btn-sm ${model.canForceFinalizeRun ? 'is-danger' : 'is-primary'}`}
                title={
                  model.canForceFinalizeRun
                    ? '强制忽略未通过的整体验收并将集成分支合并回主分支'
                    : '将当前 Run 集成分支合并回主分支并清理临时 worktree'
                }
                disabled={busyId === `run-finalize:${model.run.id}`}
                onClick={() => void handleFinalizeRun(model.canForceFinalizeRun)}
              >
                <GitMerge size={11} /> {model.canForceFinalizeRun ? '人工放行合回' : '合并回主分支'}
              </button>
            )}
          </div>
        )}
        <nav className="obp-subtabs" role="tablist" aria-label="协作视图">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'board'}
            className={subTab === 'board' ? 'is-active' : ''}
            onClick={() => setSubTab('board')}
          >
            <span>Board</span>
            <span className="obp-subtab-count">{model.posts.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'members'}
            className={subTab === 'members' ? 'is-active' : ''}
            onClick={() => setSubTab('members')}
          >
            <span>Members</span>
            <span className="obp-subtab-count">{memberTotalCount}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'graph'}
            className={subTab === 'graph' ? 'is-active' : ''}
            onClick={() => setSubTab('graph')}
          >
            <span>Graph</span>
          </button>
        </nav>
      </header>

      {/* Sub-view 1: Board */}
      {subTab === 'board' && (
        <div className="obp-board-view">
          <div className="obp-toolbar">
            <label className="wrp-search obp-search-box">
              <Search size={12} />
              <input
                type="text"
                placeholder="Search"
                aria-label="搜索协作板消息"
                value={boardSearch}
                onChange={(e) => setBoardSearch(e.target.value)}
              />
              {boardSearch && (
                <button
                  type="button"
                  className="obp-clear-btn"
                  aria-label="清空搜索"
                  onClick={() => setBoardSearch('')}
                >
                  <X size={11} />
                </button>
              )}
            </label>
            <select
              className="obp-filter-select"
              aria-label="按成员筛选"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
            >
              <option value="all">全部成员</option>
              {filterRoles.map(([key, label]) => (
                <option key={key} value={key}>
                  @{label}
                </option>
              ))}
            </select>
            <select
              className="obp-filter-select"
              aria-label="按类型筛选"
              value={kindFilter}
              onChange={(e) => setKindFilter(e.target.value)}
            >
              <option value="all">全部类型</option>
              {(Object.keys(KIND_LABELS) as OrchestrationBoardPostKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </div>

          <div
            ref={feedRef}
            className="obp-feed"
            onScroll={(e) => {
              const el = e.currentTarget;
              const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
              stickToBottomRef.current = distanceFromBottom <= 60;
            }}
          >
            {!model.isLive && liveWorkspaceAgents.length > 0 && (
              <div className="obp-history-banner">
                <span>
                  当前展示为历史记录 · 工作区另有 <strong>{liveWorkspaceAgents.length}</strong> 个活跃 Agent
                </span>
                <button
                  type="button"
                  className="obp-banner-link"
                  onClick={() => setSubTab('members')}
                >
                  查看实时状态
                </button>
              </div>
            )}
            {model.pendingProposals.length > 0 && (
              <div className="obp-attention-stack">{renderProposalStrip(model.pendingProposals)}</div>
            )}

            {filteredPosts.length === 0 ? (
              <div className="obp-feed-empty">
                {model.posts.length === 0 ? '协作板还没有消息，派发任务或在下方直接发言开始协作。' : '没有符合筛选条件的消息。'}
              </div>
            ) : (
              filteredPosts.map((post: BoardPostView) => {
                const collapsible = isLongPost(post.body);
                const isExpanded = Boolean(expandedPosts[post.id]);
                const artifactsOpen = Boolean(expandedArtifacts[post.id]);
                const inlineQuestion = questionByMessageId.get(post.id);
                const inlineApproval = approvalByPostId.map.get(post.id);
                const colorIdx = roleColorIndex(post.fromRole);
                const fileCount =
                  post.artifacts?.changedFileCount ?? post.artifacts?.changedFiles?.length ?? 0;

                return (
                  <article
                    key={post.id}
                    ref={(el) => {
                      if (el) postRefs.current.set(post.boardSeq, el);
                      else postRefs.current.delete(post.boardSeq);
                    }}
                    className={`obp-post ${highlightedSeq === post.boardSeq ? 'is-highlighted' : ''}`}
                  >
                    <button
                      type="button"
                      className={`obp-avatar obp-avatar-c${colorIdx} ${post.fromPtyId ? 'is-clickable' : ''}`}
                      title={post.fromPtyId ? `聚焦到 @${post.fromRole} 终端` : `@${post.fromRole}`}
                      onClick={() => handleMentionClick(post.fromRole)}
                    >
                      {renderAvatarContent(post.fromRole, post.fromCliId)}
                    </button>

                    <div className="obp-post-main">
                      <div className="obp-post-head">
                        <div className="obp-post-who">
                          <button
                            type="button"
                            className="obp-author-btn"
                            onClick={() => handleMentionClick(post.fromRole)}
                          >
                            @{post.fromRole}
                          </button>
                          {post.mentions.length > 0 && (
                            <span className="obp-post-targets">
                              <span className="obp-arrow" aria-hidden="true">
                                →
                              </span>
                              {post.mentions.map((target) => (
                                <button
                                  key={target}
                                  type="button"
                                  className="obp-target-btn"
                                  onClick={() => handleMentionClick(target)}
                                >
                                  @{target}
                                </button>
                              ))}
                            </span>
                          )}
                        </div>
                        <span className="obp-post-meta">
                          #{post.boardSeq}
                          {post.timeLabel ? ` · ${post.timeLabel}` : ''}
                        </span>
                      </div>

                      <div
                        className={`obp-post-body-wrap ${collapsible && !isExpanded ? 'is-collapsed' : ''}`}
                      >
                        {renderPostBody(post.body)}
                        {collapsible && !isExpanded && (
                          <div className="obp-post-fade" aria-hidden="true" />
                        )}
                      </div>

                      {collapsible && (
                        <button
                          type="button"
                          className="obp-expand-btn"
                          onClick={() =>
                            setExpandedPosts((prev) => ({ ...prev, [post.id]: !prev[post.id] }))
                          }
                        >
                          {isExpanded ? (
                            <>
                              收起 <ChevronUp size={11} />
                            </>
                          ) : (
                            <>
                              展开 <ChevronDown size={11} />
                            </>
                          )}
                        </button>
                      )}

                      {post.artifacts &&
                        (post.artifacts.branch ||
                          post.artifacts.headCommit ||
                          fileCount > 0) && (
                          <div className="obp-artifacts">
                            <div className="obp-artifacts-chips">
                              {post.artifacts.branch && (
                                <span className="wrp-chip">
                                  <GitBranch size={10} /> {post.artifacts.branch}
                                </span>
                              )}
                              {post.artifacts.headCommit && (
                                <span className="wrp-chip obp-mono">
                                  {post.artifacts.headCommit.slice(0, 10)}
                                </span>
                              )}
                              {fileCount > 0 && (
                                <button
                                  type="button"
                                  className="wrp-chip is-accent obp-files-toggle"
                                  onClick={() =>
                                    setExpandedArtifacts((prev) => ({
                                      ...prev,
                                      [post.id]: !prev[post.id],
                                    }))
                                  }
                                >
                                  {fileCount} {fileCount === 1 ? 'file' : 'files'} changed
                                  {artifactsOpen ? (
                                    <ChevronUp size={10} />
                                  ) : (
                                    <ChevronDown size={10} />
                                  )}
                                </button>
                              )}
                            </div>
                            {artifactsOpen &&
                              post.artifacts.changedFiles &&
                              post.artifacts.changedFiles.length > 0 && (
                                <ul className="obp-artifacts-files">
                                  {post.artifacts.changedFiles.map((file) => (
                                    <li key={file}>{file}</li>
                                  ))}
                                </ul>
                              )}
                          </div>
                        )}

                      {inlineApproval && (
                        <div className="obp-inline-card is-warn">
                          <div className="obp-inline-card-head">
                            <span>
                              <ShieldAlert size={12} /> 权限请求 ·{' '}
                              <strong>{inlineApproval.toolName}</strong>
                            </span>
                          </div>
                          {inlineApproval.toolInput && (
                            <code className="obp-inline-snippet">{inlineApproval.toolInput}</code>
                          )}
                          <div className="obp-inline-card-btns">
                            <button
                              type="button"
                              className="wrp-btn is-primary obp-btn-sm"
                              disabled={busyId === `app:${inlineApproval.approvalId}`}
                              onClick={() => void handleApprovePermission(inlineApproval.approvalId)}
                            >
                              <Check size={11} /> Allow
                            </button>
                            <button
                              type="button"
                              className="wrp-btn is-danger obp-btn-sm"
                              disabled={busyId === `app:${inlineApproval.approvalId}`}
                              onClick={() => void handleDenyPermission(inlineApproval.approvalId)}
                            >
                              <X size={11} /> Deny
                            </button>
                          </div>
                        </div>
                      )}

                      {inlineQuestion && (
                        <div className="obp-inline-card is-warn">
                          {inlineQuestion.options.length > 0 && (
                            <div className="obp-option-chips">
                              {inlineQuestion.options.map((opt) => (
                                <button
                                  key={opt}
                                  type="button"
                                  className="wrp-btn obp-btn-sm"
                                  disabled={busyId === `q:${inlineQuestion.messageId}`}
                                  onClick={() =>
                                    void handleReplyQuestion(inlineQuestion.messageId, opt)
                                  }
                                >
                                  {opt}
                                </button>
                              ))}
                            </div>
                          )}
                          <div className="obp-reply-row">
                            <input
                              type="text"
                              placeholder="输入回复…"
                              value={questionDrafts[inlineQuestion.messageId] ?? ''}
                              onChange={(e) =>
                                setQuestionDrafts((prev) => ({
                                  ...prev,
                                  [inlineQuestion.messageId]: e.target.value,
                                }))
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void handleReplyQuestion(
                                    inlineQuestion.messageId,
                                    questionDrafts[inlineQuestion.messageId] ?? '',
                                  );
                                }
                              }}
                            />
                            <button
                              type="button"
                              className="wrp-btn is-primary obp-btn-sm"
                              disabled={busyId === `q:${inlineQuestion.messageId}`}
                              onClick={() =>
                                void handleReplyQuestion(
                                  inlineQuestion.messageId,
                                  questionDrafts[inlineQuestion.messageId] ?? '',
                                )
                              }
                            >
                              回复
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  </article>
                );
              })
            )}

            {/* Unmatched pending approvals, native questions & decision gates */}
            {(approvalByPostId.unclaimed.length > 0 ||
              model.openNativeQuestions.length > 0 ||
              model.openGates.length > 0) && (
              <div className="obp-attention-stack">
                {model.openNativeQuestions.map((nq) => {
                  const member = model.members.find((m) => m.dispatchId === nq.dispatchId);
                  const dispatch = snapshot.dispatches.find((d) => d.id === nq.dispatchId);
                  return (
                    <WorkerNativeQuestionCard
                      key={nq.requestId}
                      entry={nq}
                      workerLabel={member?.label ?? nq.workerHandle}
                      variant="board"
                      onFocusWorker={() =>
                        dispatchFocusOrchestrationTarget({
                          kind: 'dispatch',
                          label: member?.label ?? nq.workerHandle,
                          ptyId: nq.workerHandle,
                          dispatchId: nq.dispatchId,
                          taskId: nq.taskId,
                          cwd: member?.worktreePath ?? dispatch?.worktreePath ?? null,
                          cliId: nq.provider,
                        })
                      }
                      onNotify={onNotify}
                    />
                  );
                })}
                {approvalByPostId.unclaimed.map((app) => (
                  <div key={app.approvalId} className="obp-inline-card is-warn">
                    <div className="obp-inline-card-head">
                      <span>
                        <ShieldAlert size={12} /> 权限请求 · <strong>{app.toolName}</strong>
                      </span>
                    </div>
                    {app.toolInput && <code className="obp-inline-snippet">{app.toolInput}</code>}
                    <div className="obp-inline-card-btns">
                      <button
                        type="button"
                        className="wrp-btn is-primary obp-btn-sm"
                        disabled={busyId === `app:${app.approvalId}`}
                        onClick={() => void handleApprovePermission(app.approvalId)}
                      >
                        <Check size={11} /> Allow
                      </button>
                      <button
                        type="button"
                        className="wrp-btn is-danger obp-btn-sm"
                        disabled={busyId === `app:${app.approvalId}`}
                        onClick={() => void handleDenyPermission(app.approvalId)}
                      >
                        <X size={11} /> Deny
                      </button>
                    </div>
                  </div>
                ))}
                {model.openGates.map((gate) => (
                  <div key={gate.id} className="obp-inline-card is-warn">
                    <div className="obp-inline-card-head">
                      <span>决策门禁</span>
                    </div>
                    <p className="obp-inline-card-text">{gate.question}</p>
                    <div className="obp-option-chips">
                      {(gate.options.length > 0 ? gate.options : ['approve', 'reject']).map(
                        (opt) => (
                          <button
                            key={opt}
                            type="button"
                            className="wrp-btn obp-btn-sm"
                            disabled={busyId === `gate:${gate.id}`}
                            onClick={() => void handleResolveGate(gate.id, opt)}
                          >
                            {opt}
                          </button>
                        ),
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {model.run && (
            <div className="obp-composer-wrap">
              {composerFocused && quickMentionRoles.length > 0 && (
                <div className="obp-composer-hints">
                  {quickMentionRoles.map((role) => (
                    <button
                      key={role}
                      type="button"
                      className="obp-mention-chip"
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => insertComposerMention(`@${role}`)}
                    >
                      @{role}
                    </button>
                  ))}
                </div>
              )}
              <form
                className="obp-composer"
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleBoardPost();
                }}
              >
                <input
                  ref={composerInputRef}
                  type="text"
                  value={composerText}
                  disabled={composerBusy}
                  placeholder="@role 或直接发言（回车发送到协作板）…"
                  aria-label="在协作板发言"
                  onFocus={() => setComposerFocused(true)}
                  onBlur={() => setComposerFocused(false)}
                  onChange={(e) => setComposerText(e.target.value)}
                />
                <button
                  type="submit"
                  className="obp-composer-send"
                  disabled={composerBusy || !composerText.trim()}
                  title="发送到协作板"
                  aria-label="发送到协作板"
                >
                  <Send size={13} />
                </button>
              </form>
            </div>
          )}
        </div>
      )}

      {/* Sub-view 2: Members */}
      {subTab === 'members' && (
        <div className="obp-members-view">
          <div className="obp-toolbar">
            <label className="wrp-search obp-search-box is-full">
              <Search size={12} />
              <input
                type="text"
                placeholder="Search members"
                aria-label="搜索协作成员"
                value={memberSearch}
                onChange={(e) => setMemberSearch(e.target.value)}
              />
              {memberSearch && (
                <button
                  type="button"
                  className="obp-clear-btn"
                  aria-label="清空搜索"
                  onClick={() => setMemberSearch('')}
                >
                  <X size={11} />
                </button>
              )}
            </label>
          </div>

          <div className="obp-members-list">
            {filteredLiveAgents.length > 0 &&
              renderLiveWorkspaceAgentsList(
                filteredLiveAgents,
                `当前工作区 AGENT · ${filteredLiveAgents.length}`,
              )}

            {(showCoordinatorInMembers || filteredMembers.length > 0) && (
              <div className="obp-team-heading">
                {model.isLive ? '当前协作团队' : '历史协作记录'} ·{' '}
                {(showCoordinatorInMembers ? 1 : 0) + filteredMembers.length}
              </div>
            )}

            {showCoordinatorInMembers && model.coordinator && (
              <button
                type="button"
                className="obp-member-card is-coordinator"
                onClick={() => {
                  if (!focusRole('coordinator')) {
                    onNotify?.('@coordinator 没有关联的活跃终端');
                  }
                }}
              >
                <div className="obp-member-card-top">
                  <span className="obp-avatar-wrap">
                    <span className={`obp-avatar obp-avatar-c0`}>
                      {renderAvatarContent('coordinator', model.coordinator.cliId)}
                    </span>
                    <span className={`obp-status-dot tone-${model.coordinator.tone}`} />
                  </span>
                  <div className="obp-member-title-col">
                    <div className="obp-member-name-row">
                      <strong>@coordinator</strong>
                      <span className="obp-member-meta-right">
                        {model.coordinator.cliId ?? 'Coordinator'}
                        {model.coordinator.latestPostSeq
                          ? ` · #${model.coordinator.latestPostSeq}`
                          : ''}
                      </span>
                    </div>
                    <div className="obp-member-sub-row">
                      <span className="obp-member-sub">{model.coordinator.subtitle}</span>
                      <span className={`obp-stage-pill tone-${model.coordinator.tone}`}>
                        {model.coordinator.stageLabel}
                      </span>
                    </div>
                  </div>
                </div>
                {model.coordinator.liveActivity && (
                  <p className="obp-member-live-activity">{model.coordinator.liveActivity}</p>
                )}
                {model.coordinator.latestPostPreview && (
                  <p className="obp-member-preview is-two-line">
                    {model.coordinator.latestPostPreview}
                  </p>
                )}
              </button>
            )}

            {filteredMembers.length === 0 ? (
              filteredLiveAgents.length === 0 && (
                <div className="obp-feed-empty">暂无下属 Worker 成员。</div>
              )
            ) : (
              filteredMembers.map((member) => {
                const colorIdx = roleColorIndex(member.role);
                const modelMeta = [member.cliId, member.model].filter(Boolean).join('/');
                return (
                  <div key={member.key} className="obp-member-card is-worker">
                    <button
                      type="button"
                      className="obp-member-card-body"
                      onClick={() => {
                        if (!focusRole(member.role)) {
                          onNotify?.(`${member.label} 终端已关闭或未关联`);
                        }
                      }}
                    >
                      <div className="obp-member-card-top">
                        <span className="obp-avatar-wrap">
                          <span className={`obp-avatar obp-avatar-c${colorIdx}`}>
                            {renderAvatarContent(member.role, member.cliId)}
                          </span>
                          <span className={`obp-status-dot tone-${member.tone}`} />
                        </span>
                        <div className="obp-member-title-col">
                          <div className="obp-member-name-row">
                            <strong>{member.label}</strong>
                            <span className="obp-member-meta-right">
                              {modelMeta || 'worker'}
                              {member.latestPostSeq ? ` · #${member.latestPostSeq}` : ''}
                            </span>
                          </div>
                          <div className="obp-member-sub-row">
                            <span className="obp-member-sub">{member.taskSummary}</span>
                            {member.verificationBadge && (
                              <span className={`obp-stage-pill tone-${member.verificationBadge.tone}`}>
                                {member.verificationBadge.label}
                              </span>
                            )}
                            <span className={`obp-stage-pill tone-${member.tone}`}>
                              {member.stageLabel}
                            </span>
                          </div>
                        </div>
                      </div>
                      {member.liveActivity && (
                        <p className="obp-member-live-activity">{member.liveActivity}</p>
                      )}
                      {member.latestPostPreview && (
                        <p className="obp-member-preview">{member.latestPostPreview}</p>
                      )}
                    </button>
                    {!member.released && (
                      <div className="obp-member-actions">
                        <button
                          type="button"
                          className={`wrp-icon-btn ${member.retained ? 'is-active' : ''}`}
                          title={member.retained ? '取消保留终端' : '保留终端'}
                          disabled={busyId === `pin:${member.dispatchId}`}
                          onClick={() => void handleKeepOpen(member)}
                        >
                          <Pin size={12} />
                        </button>
                        <button
                          type="button"
                          className={`wrp-icon-btn ${member.isSettled ? '' : 'is-danger'}`}
                          title={member.isSettled ? '释放 Worker 与工作树' : '终止 Worker'}
                          disabled={
                            busyId === `rel:${member.dispatchId}` ||
                            busyId === `stop:${member.dispatchId}`
                          }
                          onClick={() => void handleReleaseOrStop(member)}
                        >
                          {member.isSettled ? <Trash2 size={12} /> : <Square size={11} />}
                        </button>
                      </div>
                    )}
                    {(member.canTriggerReview || member.canIntegrate) && (
                      <div className="obp-member-workflow-bar">
                        {member.canTriggerReview && (
                          <button
                            type="button"
                            className="wrp-btn obp-btn-sm"
                            title={`对 ${member.label} 发起独立只读异构审查`}
                            disabled={busyId === `rev:${member.dispatchId}`}
                            onClick={() => void handleTriggerWorkerReview(member)}
                          >
                            <ShieldCheck size={11} /> {member.reviewStatus === 'rejected' || member.reviewStatus === 'escalated' ? '重新审查' : '异构审查'}
                          </button>
                        )}
                        {member.canIntegrate && (
                          <button
                            type="button"
                            className={`wrp-btn obp-btn-sm ${member.canForceIntegrate ? 'is-danger' : 'is-primary'}`}
                            title={
                              member.canForceIntegrate
                                ? `人工跳过审查门禁并将 ${member.label} 合入（主分支脏时自动暂存到 Run 集成分支）`
                                : `将 ${member.label} squash 合入（主分支脏时自动暂存到 Run 集成分支）`
                            }
                            disabled={busyId === `int:${member.dispatchId}`}
                            onClick={() => void handleIntegrateWorker(member, member.canForceIntegrate)}
                          >
                            <GitMerge size={11} /> {member.canForceIntegrate ? '人工放行合入' : '合入'}
                          </button>
                        )}
                        {(member.reviewStatus === 'rejected' || member.reviewStatus === 'escalated') && (
                          <button
                            type="button"
                            className="wrp-btn obp-btn-sm"
                            title="在协作板查看审查意见"
                            onClick={() => {
                              setBoardSearch('');
                              setKindFilter('all');
                              setRoleFilter(member.role.toLowerCase());
                              setSubTab('board');
                            }}
                          >
                            查看意见
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Sub-view 3: Graph */}
      {subTab === 'graph' && (
        <div className="obp-graph-view">
          <div className="obp-replay-bar">
            <button
              type="button"
              className="wrp-icon-btn"
              title="跳到开头"
              aria-label="跳到开头"
              disabled={model.headSeq <= 0}
              onClick={() => {
                setPlaying(false);
                setReplaySeq(1);
              }}
            >
              <SkipBack size={12} />
            </button>
            <button
              type="button"
              className="wrp-icon-btn"
              title="上一条消息"
              aria-label="上一条消息"
              disabled={model.headSeq <= 0 || effectiveUpToSeq <= 1}
              onClick={() => {
                setPlaying(false);
                setReplaySeq(Math.max(1, effectiveUpToSeq - 1));
              }}
            >
              <ChevronLeft size={13} />
            </button>
            <button
              type="button"
              className="wrp-icon-btn"
              title={playing ? '暂停回放' : '自动回放'}
              aria-label={playing ? '暂停回放' : '自动回放'}
              disabled={model.headSeq <= 1}
              onClick={() => {
                if (playing) {
                  setPlaying(false);
                } else {
                  if (replaySeq === null || replaySeq >= model.headSeq) {
                    setReplaySeq(1);
                  }
                  setPlaying(true);
                }
              }}
            >
              {playing ? <Pause size={12} /> : <Play size={12} />}
            </button>
            <button
              type="button"
              className="wrp-icon-btn"
              title="下一条消息"
              aria-label="下一条消息"
              disabled={model.headSeq <= 0 || isReplayLive}
              onClick={() => {
                setPlaying(false);
                const next = effectiveUpToSeq + 1;
                setReplaySeq(next >= model.headSeq ? null : next);
              }}
            >
              <ChevronRight size={13} />
            </button>
            <input
              type="range"
              className="obp-scrubber"
              aria-label="时间轴进度"
              min={1}
              max={Math.max(1, model.headSeq)}
              value={Math.max(1, effectiveUpToSeq)}
              disabled={model.headSeq <= 1}
              onChange={(e) => {
                setPlaying(false);
                const val = Number(e.target.value);
                setReplaySeq(val >= model.headSeq ? null : val);
              }}
            />
            <button
              type="button"
              className={`obp-live-toggle ${isReplayLive ? 'is-active' : ''}`}
              onClick={() => {
                setPlaying(false);
                setReplaySeq(null);
              }}
            >
              <span className="obp-live-dot" aria-hidden="true" />
              Live
            </button>
          </div>

          <div className="obp-graph-controls">
            <span className="obp-graph-stats">{graph.durationLabel}</span>
            <div className="obp-graph-toggles">
              <label className="wrp-check">
                <input
                  type="checkbox"
                  checked={hideInactive}
                  onChange={(e) => setHideInactive(e.target.checked)}
                />
                <span>Hide inactive</span>
              </label>
              <label className="wrp-check">
                <input
                  type="checkbox"
                  checked={expandAll}
                  onChange={(e) => setExpandAll(e.target.checked)}
                />
                <span>Expand @all</span>
              </label>
              <select
                className="obp-speed-select"
                aria-label="回放倍速"
                value={String(speed)}
                onChange={(e) => setSpeed(Number(e.target.value))}
              >
                <option value="0.5">0.5×</option>
                <option value="1">1×</option>
                <option value="2">2×</option>
              </select>
            </div>
          </div>

          <div className="obp-graph-stage">
            <svg
              className="obp-graph-svg"
              viewBox={`0 0 ${graph.width} ${graph.height}`}
              role="img"
              aria-label="Agent 协作关系图"
            >
              <defs>
                <marker
                  id="obp-arrow"
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="obp-arrow-head" />
                </marker>
                <marker
                  id="obp-arrow-active"
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="obp-arrow-head is-active" />
                </marker>
                <marker
                  id="obp-arrow-all"
                  viewBox="0 0 10 10"
                  refX="8.5"
                  refY="5"
                  markerWidth="5.5"
                  markerHeight="5.5"
                  orient="auto-start-reverse"
                >
                  <path d="M 1 1.5 L 9 5 L 1 8.5 z" className="obp-arrow-head is-all" />
                </marker>
              </defs>

              {/* Edges */}
              {graph.edges.map((edge) => {
                const fromNode = graphNodeById.get(edge.from);
                const toNode = graphNodeById.get(edge.to);
                if (!fromNode || !toNode) return null;

                const dx = toNode.x - fromNode.x;
                const dy = toNode.y - fromNode.y;
                const dist = Math.hypot(dx, dy) || 1;
                const nx = -dy / dist;
                const ny = dx / dist;
                const curve = edge.hasReverse ? 24 : 14;
                const cx = (fromNode.x + toNode.x) / 2 + nx * curve;
                const cy = (fromNode.y + toNode.y) / 2 + ny * curve;

                const start = computePillEdgePoint(fromNode, cx, cy, 2);
                const end = computePillEdgePoint(toNode, cx, cy, 4);
                const midX = 0.25 * start.x + 0.5 * cx + 0.25 * end.x;
                const midY = 0.25 * start.y + 0.5 * cy + 0.25 * end.y;

                const isHighlighted =
                  hoveredNodeId !== null &&
                  (edge.from === hoveredNodeId || edge.to === hoveredNodeId);
                const isDimmed = hoveredNodeId !== null && !isHighlighted;
                const strokeWidth = edge.viaAll
                  ? 1.4
                  : Math.min(4.4, 1.5 + (edge.count - 1) * 0.65);

                return (
                  <g
                    key={edge.key}
                    className={`obp-graph-edge ${edge.viaAll ? 'is-all' : ''} ${isHighlighted ? 'is-highlighted' : ''} ${isDimmed ? 'is-dimmed' : ''}`}
                  >
                    <path
                      d={`M ${start.x.toFixed(1)} ${start.y.toFixed(1)} Q ${cx.toFixed(1)} ${cy.toFixed(1)} ${end.x.toFixed(1)} ${end.y.toFixed(1)}`}
                      fill="none"
                      strokeWidth={strokeWidth}
                      strokeDasharray={edge.viaAll ? '4 3' : undefined}
                      markerEnd={
                        isHighlighted
                          ? 'url(#obp-arrow-active)'
                          : edge.viaAll
                            ? 'url(#obp-arrow-all)'
                            : 'url(#obp-arrow)'
                      }
                    />
                    {edge.count > 1 && (
                      <g transform={`translate(${midX.toFixed(1)}, ${midY.toFixed(1)})`}>
                        <circle r="8.5" className="obp-edge-badge-bg" />
                        <text className="obp-edge-badge-text" textAnchor="middle" dy="3.5">
                          {edge.count}
                        </text>
                      </g>
                    )}
                  </g>
                );
              })}

              {/* Nodes */}
              {graph.nodes.map((node) => {
                const halfW = node.width / 2;
                const halfH = PILL_HEIGHT / 2;
                const isHovered = hoveredNodeId === node.id;
                const isRelated =
                  hoveredNodeId === null ||
                  isHovered ||
                  graph.edges.some(
                    (e) =>
                      (e.from === hoveredNodeId && e.to === node.id) ||
                      (e.to === hoveredNodeId && e.from === node.id),
                  );

                return (
                  <g
                    key={node.id}
                    className={`obp-graph-node ${node.kind === 'coordinator' ? 'is-coord' : ''} ${!node.active ? 'is-inactive' : ''} ${isHovered ? 'is-hovered' : ''} ${!isRelated ? 'is-dimmed' : ''}`}
                    transform={`translate(${node.x}, ${node.y})`}
                    onMouseEnter={() => setHoveredNodeId(node.id)}
                    onMouseLeave={() => setHoveredNodeId(null)}
                    onClick={() => {
                      if (!focusRole(node.id)) {
                        onNotify?.(`@${node.label} 没有关联的活跃终端`);
                      }
                    }}
                  >
                    {node.postedWithNoMention && (
                      <rect
                        x={-halfW - 4}
                        y={-halfH - 4}
                        width={node.width + 8}
                        height={PILL_HEIGHT + 8}
                        rx={18}
                        className="obp-node-halo"
                      />
                    )}
                    <rect
                      x={-halfW}
                      y={-halfH}
                      width={node.width}
                      height={PILL_HEIGHT}
                      rx={14}
                      className="obp-node-pill"
                    />
                    <circle
                      cx={-halfW + 13}
                      cy={0}
                      r={3.5}
                      className={`obp-node-dot tone-${node.tone}`}
                    />
                    <text
                      x={-halfW + 23}
                      y={4}
                      className="obp-node-label"
                    >
                      {node.label.length > 14 ? `${node.label.slice(0, 13)}…` : node.label}
                    </text>
                  </g>
                );
              })}
            </svg>
          </div>

          <footer className="obp-graph-legend">
            <span>→ @mention, width = count</span>
            <span className="obp-legend-sep">·</span>
            <span>--&gt; via @all</span>
            <span className="obp-legend-sep">·</span>
            <span>◌ posted with no mention</span>
            <span className="obp-legend-all-pill">@all {graph.allPostCount}</span>
          </footer>
        </div>
      )}
    </div>
  );
}
