import type {
  AgentPaneStatus,
  AgentSessionPolicy,
  OrchestrationDispatchProposal,
  OrchestrationDispatchRecord,
  OrchestrationDispatchStage,
  OrchestrationGateRecord,
  OrchestrationQuestionRecord,
  OrchestrationRunRecord,
  OrchestrationSnapshot,
  OrchestrationTaskRecord,
  WorkerApprovalPayload,
  WorkerNativeQuestionPayload,
} from '../types';
import { isSamePath } from './git-panel-model';
import { shortId, taskTitle, type StatusTone } from './orchestration-view';

export interface CrewMemberEntry {
  key: string;
  role: 'coordinator' | 'worker';
  roleName: string | null;
  ptyId: string | null;
  handle: string;
  mentionToken: string;
  label: string;
  subtitle: string;
  cliId: string | null;
  dispatch: OrchestrationDispatchRecord | null;
  task: OrchestrationTaskRecord | null;
  stage: OrchestrationDispatchStage | 'active' | 'idle';
  stageLabel: string;
  tone: StatusTone;
  branch: string | null;
  model: string | null;
  effort: string | null;
  worktreePath: string | null;
  ownsWorktree: boolean;
  ownsPane: boolean;
  retained: boolean;
  isSettled: boolean;
  needsAttention: boolean;
  /** Headless Workers: the tier and network access their next turn runs with. */
  workerControls?: {
    policy: AgentSessionPolicy;
    network: boolean;
    allowSubWorkers: boolean;
    /** Reviews stay read-only without network access. */
    locked: boolean;
  };
}

export interface CrewPeerEntry {
  key: string;
  handle: string;
  ptyId: string | null;
  mentionToken: string;
  label: string;
  lastSubject: string;
  lastMessageAt: string;
  unreadCount: number;
  cliId: string | null;
}

export interface PaneCrewViewModel {
  ptyId: string;
  isVisible: boolean;
  isOrchestrationMode: boolean;
  pendingProposals: OrchestrationDispatchProposal[];
  ownDispatch: OrchestrationDispatchRecord | null;
  ownRun: OrchestrationRunRecord | null;
  managedBy: CrewMemberEntry | null;
  managing: CrewMemberEntry[];
  talkingWith: CrewPeerEntry[];
  openApprovals: WorkerApprovalPayload[];
  openQuestions: OrchestrationQuestionRecord[];
  openNativeQuestions: WorkerNativeQuestionPayload[];
  openGates: OrchestrationGateRecord[];
  workingCount: number;
  attentionCount: number;
  totalCount: number;
  pillLabel: string;
  pillTone: StatusTone;
  mentionAllText: string;
}

export interface BuildCrewViewOptions {
  isAgentPane?: boolean;
}

export interface QuickDispatchTarget {
  agent: string;
  role?: string;
  task: string;
}

const QUICK_DISPATCH_AGENT_ALIASES: Record<string, string> = {
  agy: 'antigravity',
  'claude-code': 'claude',
  'gemini-cli': 'gemini',
};

export function parseQuickDispatchInput(raw: string): QuickDispatchTarget | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const mentionMatch = /^@([a-zA-Z0-9_-]+)(?::([^\s]*))?(?:\s+([\s\S]*))?$/.exec(trimmed);
  if (mentionMatch) {
    const rawAgent = (mentionMatch[1] ?? '').toLowerCase();
    const agent = QUICK_DISPATCH_AGENT_ALIASES[rawAgent] ?? rawAgent;
    const rawRole = (mentionMatch[2] ?? '').trim().replace(/^@+/, '');
    const task = (mentionMatch[3] ?? '').trim();
    if (!task) return null;
    return rawRole ? { agent, role: rawRole, task } : { agent, task };
  }

  return { agent: 'auto', task: trimmed };
}

export const STAGE_LABELS: Record<OrchestrationDispatchStage | 'active' | 'idle', string> = {
  starting: '启动中',
  working: '执行中',
  waiting_permission: '待授权',
  waiting_input: '待输入',
  awaiting_review: '待检视',
  done: '已完成',
  failed: '失败',
  released: '已释放',
  stopped: '已停止',
  active: '在线',
  idle: '空闲',
};

export function stageTone(stage: OrchestrationDispatchStage | 'active' | 'idle'): StatusTone {
  switch (stage) {
    case 'working':
    case 'starting':
    case 'active':
      return 'accent';
    case 'waiting_permission':
    case 'waiting_input':
    case 'awaiting_review':
      return 'warn';
    case 'done':
      return 'ok';
    case 'failed':
      return 'error';
    case 'stopped':
    case 'released':
    case 'idle':
    default:
      return 'neutral';
  }
}

export function deriveClientDispatchStage(
  dispatch: OrchestrationDispatchRecord,
  agentStatus?: AgentPaneStatus | null,
  hasOpenApproval = false,
  hasOpenQuestion = false,
): OrchestrationDispatchStage {
  if (dispatch.releasedAt) return 'released';
  if (dispatch.status === 'completed') return 'done';
  if (dispatch.status === 'failed' || dispatch.status === 'circuit_broken') {
    return dispatch.lastFailureReason === 'worker_stopped' ? 'stopped' : 'failed';
  }
  if (hasOpenApproval) return 'waiting_permission';
  if (agentStatus?.state === 'waiting') {
    return agentStatus.waitKind === 'permission' ? 'waiting_permission' : 'waiting_input';
  }
  if (hasOpenQuestion) return 'waiting_input';
  const gen = dispatch.processGeneration ?? 1;
  if (dispatch.turnStopReportedGeneration === gen && agentStatus?.state !== 'working') {
    return 'awaiting_review';
  }
  if (agentStatus?.state === 'working' || dispatch.startObservation === 'observed') {
    return 'working';
  }
  if (dispatch.startObservation === 'permission') {
    return 'waiting_permission';
  }
  return dispatch.stage ?? 'starting';
}

function isActiveStatus(status: OrchestrationDispatchRecord['status']): boolean {
  return status === 'pending' || status === 'dispatched';
}

/** Chase `followUpOfDispatchId` forward to the latest dispatch in a worker lineage. */
export function resolveClientDispatchLineage(
  dispatches: readonly OrchestrationDispatchRecord[],
  dispatchId: string,
): OrchestrationDispatchRecord | null {
  let current = dispatches.find((d) => d.id === dispatchId) ?? null;
  if (!current) return null;
  const seen = new Set<string>([current.id]);
  while (true) {
    const child = dispatches.find((d) => d.followUpOfDispatchId === current!.id);
    if (!child || seen.has(child.id)) break;
    seen.add(child.id);
    current = child;
  }
  return current;
}

/** Collapse `followUpOfDispatchId` chains so only the latest dispatch in each worker lineage is shown. */
export function collapseFollowUpLineages(
  dispatches: readonly OrchestrationDispatchRecord[],
): OrchestrationDispatchRecord[] {
  const supersededIds = new Set<string>();
  for (const d of dispatches) {
    if (d.followUpOfDispatchId) {
      supersededIds.add(d.followUpOfDispatchId);
    }
  }
  return dispatches.filter((d) => !supersededIds.has(d.id));
}

export interface AgentStatusLookup {
  get(ptyId: string): AgentPaneStatus | null | undefined;
}

function workerRoleSubtitle(
  task: OrchestrationTaskRecord | null,
  roleName: string,
  cliId: string | null,
): string {
  let desc = task?.taskTitle?.trim() || '';
  if (desc) {
    const escaped = roleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = desc.replace(new RegExp(`^@?${escaped}\\s*[:：-]\\s*`, 'i'), '').trim();
    if (stripped) desc = stripped;
  }
  if (!desc && task?.spec) {
    const firstLine = task.spec.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
    if (firstLine) {
      desc = firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
    }
  }
  const parts = [cliId, desc].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(' · ') : roleName;
}

function toWorkerCrewEntry(
  dispatch: OrchestrationDispatchRecord,
  snapshot: OrchestrationSnapshot,
  agentStatuses?: AgentStatusLookup,
): CrewMemberEntry {
  const task = snapshot.tasks.find((t) => t.id === dispatch.taskId) ?? null;
  const ptyId = dispatch.assigneePaneId ?? (dispatch.assigneeHandle.startsWith('local-') ? dispatch.assigneeHandle : null);
  const agentStatus = ptyId ? agentStatuses?.get(ptyId) : undefined;
  const hasOpenApproval = (snapshot.openApprovals ?? []).some(
    (a) => a.dispatchId === dispatch.id && a.status === 'pending',
  );
  const hasOpenQuestion =
    snapshot.questions.some((q) => q.dispatchId === dispatch.id && q.status === 'pending') ||
    (snapshot.openNativeQuestions ?? []).some(
      (q) => q.dispatchId === dispatch.id && q.status === 'pending',
    );
  const stage = deriveClientDispatchStage(dispatch, agentStatus, hasOpenApproval, hasOpenQuestion);
  const isSettled = !isActiveStatus(dispatch.status);
  const roleName = task?.displayName?.trim().replace(/^@+/, '') || null;
  const title = task ? taskTitle(task) : shortId(dispatch.taskId);
  const cliId = dispatch.cliId ?? agentStatus?.agentId ?? null;
  const isReview = Boolean(dispatch.reviewOfDispatchId || dispatch.reviewOfRunId);
  const needsAttention =
    stage === 'waiting_permission' ||
    stage === 'waiting_input' ||
    stage === 'awaiting_review' ||
    stage === 'failed';

  return {
    key: dispatch.id,
    role: 'worker',
    roleName,
    ptyId,
    handle: `dispatch:${dispatch.id}`,
    mentionToken: roleName ? `@${roleName}` : `@dispatch:${dispatch.id}`,
    label: roleName ? `@${roleName}` : title,
    subtitle: roleName
      ? workerRoleSubtitle(task, roleName, cliId)
      : `#${dispatch.taskId} · ${shortId(dispatch.id)}`,
    cliId,
    dispatch,
    task,
    stage,
    stageLabel: STAGE_LABELS[stage],
    tone: stageTone(stage),
    branch: dispatch.branch ?? null,
    model: dispatch.model ?? null,
    effort: dispatch.effort ?? null,
    worktreePath: dispatch.worktreePath ?? task?.worktreePath ?? null,
    ownsWorktree: Boolean(dispatch.ownsWorktree),
    ownsPane: Boolean(dispatch.ownsPane),
    retained: Boolean(dispatch.retained),
    isSettled,
    needsAttention,
    ...(dispatch.executionMode === 'codex-app-server' && (dispatch.workerPolicy || isReview) ? {
      workerControls: {
        policy: isReview ? 'read-only' as const : dispatch.workerPolicy!,
        network: !isReview && dispatch.workerNetwork === true,
        allowSubWorkers: !isReview && dispatch.allowSubWorkers === true,
        locked: isReview,
      },
    } : {}),
  };
}

export function buildCrewViewForPane(
  snapshot: OrchestrationSnapshot,
  ptyId: string,
  agentStatuses?: AgentStatusLookup,
  opts?: BuildCrewViewOptions,
): PaneCrewViewModel {
  const collapsedDispatches = collapseFollowUpLineages(snapshot.dispatches).filter(
    (d) => !d.releasedAt,
  );

  // 1. Identify whether this pane is itself a worker dispatch or a run coordinator.
  const myDispatches = collapsedDispatches.filter(
    (d) => d.assigneePaneId === ptyId || d.assigneeHandle === ptyId,
  );
  const ownDispatch =
    myDispatches.find((d) => isActiveStatus(d.status)) ?? myDispatches.at(-1) ?? null;

  const boundRunId = snapshot.currentRunByConsumer[ptyId];
  const ownRun =
    snapshot.runs.find(
      (r) =>
        r.id === boundRunId ||
        r.coordinatorPaneId === ptyId ||
        r.coordinatorHandle === ptyId,
    ) ??
    (ownDispatch ? snapshot.runs.find((r) => r.id === ownDispatch.runId) ?? null : null);

  // 2. Compute `managedBy` when this pane is a worker.
  let managedBy: CrewMemberEntry | null = null;
  if (ownDispatch) {
    if (ownDispatch.creatorDispatchId) {
      const parentDispatch = resolveClientDispatchLineage(
        snapshot.dispatches,
        ownDispatch.creatorDispatchId,
      );
      if (parentDispatch) {
        managedBy = toWorkerCrewEntry(parentDispatch, snapshot, agentStatuses);
      }
    }
    if (!managedBy) {
      const parentRun = snapshot.runs.find((r) => r.id === ownDispatch.runId) ?? null;
      const parentPtyId =
        ownDispatch.parentPaneId ??
        parentRun?.coordinatorPaneId ??
        (ownDispatch.creator.startsWith('local-') ? ownDispatch.creator : null);
      const parentStatus = parentPtyId ? agentStatuses?.get(parentPtyId) : undefined;
      const parentStage: 'active' | 'idle' =
        parentStatus?.state === 'working' ? 'active' : 'idle';
      managedBy = {
        key: `coord:${ownDispatch.runId}`,
        role: 'coordinator',
        roleName: null,
        ptyId: parentPtyId,
        handle: parentRun ? `run:${parentRun.id}` : ownDispatch.creator,
        mentionToken: '@coordinator',
        label: parentRun?.objective
          ? `Coordinator · ${parentRun.objective.slice(0, 42)}`
          : `Coordinator (${shortId(ownDispatch.runId)})`,
        subtitle: parentPtyId ? shortId(parentPtyId) : ownDispatch.creator,
        cliId: parentStatus?.agentId ?? null,
        dispatch: null,
        task: null,
        stage: parentStage,
        stageLabel: STAGE_LABELS[parentStage],
        tone: stageTone(parentStage),
        branch: null,
        model: null,
        effort: null,
        worktreePath: null,
        ownsWorktree: false,
        ownsPane: false,
        retained: false,
        isSettled: false,
        needsAttention: false,
      };
    }
  }

  // 3. Compute `managing`: workers launched/owned by this pane or its coordinated run(s).
  const coordinatedRunIds = new Set<string>();
  for (const r of snapshot.runs) {
    if (r.coordinatorPaneId === ptyId || r.coordinatorHandle === ptyId) {
      coordinatedRunIds.add(r.id);
    }
  }
  if (boundRunId && !ownDispatch) {
    coordinatedRunIds.add(boundRunId);
  }

  const ownAllDispatchIds = new Set<string>();
  for (const d of snapshot.dispatches) {
    if (d.assigneePaneId === ptyId || d.assigneeHandle === ptyId) {
      ownAllDispatchIds.add(d.id);
      let cursor = d.followUpOfDispatchId;
      while (cursor && !ownAllDispatchIds.has(cursor)) {
        ownAllDispatchIds.add(cursor);
        cursor = snapshot.dispatches.find((x) => x.id === cursor)?.followUpOfDispatchId ?? null;
      }
    }
  }

  const managedDispatches = collapsedDispatches.filter((d) => {
    if (d.assigneePaneId === ptyId || d.assigneeHandle === ptyId) return false;
    if (d.parentPaneId === ptyId || d.creator === ptyId) return true;
    if (d.creatorDispatchId && ownAllDispatchIds.has(d.creatorDispatchId)) return true;
    if (!d.creatorDispatchId && coordinatedRunIds.has(d.runId)) return true;
    return false;
  });

  const managing = managedDispatches
    .map((d) => toWorkerCrewEntry(d, snapshot, agentStatuses))
    .sort((a, b) => {
      const activeDiff = Number(!a.isSettled) - Number(!b.isSettled);
      if (activeDiff !== 0) return -activeDiff;
      const attnDiff = Number(b.needsAttention) - Number(a.needsAttention);
      if (attnDiff !== 0) return attnDiff;
      return (b.dispatch?.createdAt ?? '').localeCompare(a.dispatch?.createdAt ?? '');
    });

  const managedDispatchIdSet = new Set<string>();
  for (const m of managing) {
    if (m.dispatch) {
      managedDispatchIdSet.add(m.dispatch.id);
      let cursor = m.dispatch.followUpOfDispatchId;
      while (cursor) {
        managedDispatchIdSet.add(cursor);
        cursor = snapshot.dispatches.find((x) => x.id === cursor)?.followUpOfDispatchId ?? null;
      }
    }
  }

  // 4. Open approvals, questions, and decision gates that this pane supervises.
  const openApprovals = (snapshot.openApprovals ?? []).filter(
    (a) =>
      a.status === 'pending' &&
      (managedDispatchIdSet.has(a.dispatchId) || coordinatedRunIds.has(a.runId)),
  );
  const openQuestions = snapshot.questions.filter(
    (q) =>
      q.status === 'pending' &&
      (managedDispatchIdSet.has(q.dispatchId) ||
        coordinatedRunIds.has(q.runId) ||
        q.toHandle === ptyId ||
        (ownDispatch !== null && q.toHandle === `dispatch:${ownDispatch.id}`)),
  );
  const openNativeQuestions = (snapshot.openNativeQuestions ?? []).filter(
    (q) =>
      q.status === 'pending' &&
      (managedDispatchIdSet.has(q.dispatchId) ||
        coordinatedRunIds.has(q.runId) ||
        (ownDispatch !== null && q.dispatchId === ownDispatch.id)),
  );
  const managedTaskIds = new Set(managing.map((m) => m.task?.id).filter((id): id is string => Boolean(id)));
  const openGates = snapshot.gates.filter(
    (g) =>
      g.status === 'pending' &&
      (managedTaskIds.has(g.taskId) || coordinatedRunIds.has(g.runId)),
  );

  // 5. Compute `talkingWith` (peers outside `managedBy` and `managing`).
  const excludedHandles = new Set<string>([ptyId]);
  if (ownDispatch) excludedHandles.add(`dispatch:${ownDispatch.id}`);
  for (const runId of coordinatedRunIds) excludedHandles.add(`run:${runId}`);
  if (managedBy) {
    excludedHandles.add(managedBy.handle);
    if (managedBy.ptyId) excludedHandles.add(managedBy.ptyId);
  }
  for (const m of managing) {
    excludedHandles.add(m.handle);
    if (m.ptyId) excludedHandles.add(m.ptyId);
  }
  for (const dId of managedDispatchIdSet) {
    excludedHandles.add(`dispatch:${dId}`);
  }

  const selfHandles = new Set<string>([ptyId]);
  if (ownDispatch) selfHandles.add(`dispatch:${ownDispatch.id}`);
  for (const runId of coordinatedRunIds) selfHandles.add(`run:${runId}`);

  const peerMap = new Map<string, CrewPeerEntry>();
  for (const msg of snapshot.messages) {
    if (msg.type === 'heartbeat' || msg.type === 'dispatch') continue;
    const isInbound = selfHandles.has(msg.toHandle);
    const isOutbound = selfHandles.has(msg.fromHandle);
    if (!isInbound && !isOutbound) continue;
    const other = isInbound ? msg.fromHandle : msg.toHandle;
    if (!other || other === '@all' || other === '@workers' || excludedHandles.has(other)) continue;

    const existing = peerMap.get(other);
    const unreadIncrement = isInbound && !msg.read ? 1 : 0;
    if (!existing || msg.createdAt >= existing.lastMessageAt) {
      const peerPty = other.startsWith('local-')
        ? other
        : other.startsWith('dispatch:')
          ? resolveClientDispatchLineage(snapshot.dispatches, other.slice('dispatch:'.length))
              ?.assigneePaneId ?? null
          : null;
      peerMap.set(other, {
        key: other,
        handle: other,
        ptyId: peerPty,
        mentionToken: `@${other}`,
        label: other.startsWith('dispatch:')
          ? `Worker ${shortId(other.slice('dispatch:'.length))}`
          : other.startsWith('run:')
            ? `Run ${shortId(other.slice('run:'.length))}`
            : shortId(other),
        lastSubject: msg.subject,
        lastMessageAt: msg.createdAt,
        unreadCount: (existing?.unreadCount ?? 0) + unreadIncrement,
        cliId: peerPty ? (agentStatuses?.get(peerPty)?.agentId ?? null) : null,
      });
    } else if (unreadIncrement > 0) {
      existing.unreadCount += unreadIncrement;
    }
  }

  const talkingWith = [...peerMap.values()].sort((a, b) =>
    b.lastMessageAt.localeCompare(a.lastMessageAt),
  );

  const isOrchestrationMode = Boolean(snapshot.orchestrationModePanes?.includes(ptyId));
  const pendingProposals = (snapshot.pendingProposals ?? []).filter(
    (p) =>
      p.status === 'pending' &&
      (p.coordinatorPaneId === ptyId ||
        (!ownDispatch && ownRun !== null && p.runId === ownRun.id) ||
        (p.runId !== null && coordinatedRunIds.has(p.runId))),
  );

  const workingCount = managing.filter(
    (m) => m.stage === 'working' || m.stage === 'starting',
  ).length;
  const memberAttention = managing.filter((m) => m.needsAttention).length;
  const attentionCount =
    pendingProposals.length +
    openApprovals.length +
    openQuestions.length +
    openNativeQuestions.length +
    openGates.length +
    memberAttention;
  const totalCount = (managedBy ? 1 : 0) + managing.length + talkingWith.length;
  const isVisible =
    Boolean(opts?.isAgentPane) ||
    isOrchestrationMode ||
    pendingProposals.length > 0 ||
    totalCount > 0 ||
    openApprovals.length > 0 ||
    openQuestions.length > 0 ||
    openNativeQuestions.length > 0 ||
    openGates.length > 0;

  let pillLabel = isOrchestrationMode ? '编排中' : '编排';
  let pillTone: StatusTone = isOrchestrationMode ? 'accent' : 'neutral';

  if (pendingProposals.length > 0) {
    pillLabel =
      workingCount > 0
        ? `待确认 (${pendingProposals.length}) · ${workingCount} 执行中`
        : `待确认 (${pendingProposals.length})`;
    pillTone = 'warn';
  } else if (openApprovals.length > 0) {
    pillLabel = `${openApprovals.length} 待授权`;
    pillTone = 'warn';
  } else if (openQuestions.length + openNativeQuestions.length + openGates.length > 0) {
    pillLabel = `${openQuestions.length + openNativeQuestions.length + openGates.length} 待回复`;
    pillTone = 'warn';
  } else if (workingCount > 0) {
    pillLabel = `${workingCount} 执行中`;
    pillTone = 'accent';
  } else if (managing.some((m) => m.stage === 'failed')) {
    pillLabel = `${managing.length} Workers`;
    pillTone = 'error';
  } else if (managing.length > 0) {
    pillLabel = `${managing.length} Workers`;
    pillTone = 'ok';
  } else if (managedBy) {
    const ownTask = ownDispatch
      ? snapshot.tasks.find((t) => t.id === ownDispatch.taskId) ?? null
      : null;
    const ownRole = ownTask?.displayName?.trim().replace(/^@+/, '') || null;
    pillLabel = ownRole
      ? `@${ownRole}`
      : ownDispatch
        ? `#${shortId(ownDispatch.taskId)}`
        : 'Worker';
    pillTone = ownDispatch
      ? stageTone(deriveClientDispatchStage(ownDispatch, agentStatuses?.get(ptyId)))
      : 'accent';
  } else if (talkingWith.length > 0) {
    pillLabel = `${totalCount} Crew`;
    pillTone = isOrchestrationMode ? 'accent' : 'neutral';
  }

  const activeWorkerMentions = managing
    .filter((m) => !m.isSettled)
    .map((m) => m.mentionToken);
  const mentionAllText =
    activeWorkerMentions.length > 1
      ? '@workers '
      : activeWorkerMentions.length === 1
        ? `${activeWorkerMentions[0]} `
        : managing.map((m) => m.mentionToken).join(' ') + ' ';

  return {
    ptyId,
    isVisible,
    isOrchestrationMode,
    pendingProposals,
    ownDispatch,
    ownRun,
    managedBy,
    managing,
    talkingWith,
    openApprovals,
    openQuestions,
    openNativeQuestions,
    openGates,
    workingCount,
    attentionCount,
    totalCount,
    pillLabel,
    pillTone,
    mentionAllText,
  };
}

export function isAutoManagedWorktreeFolder(path: string): boolean {
  return /[\\/][^\\/]+\.aha-worktrees(?:[\\/]|$)/i.test(path);
}

export function inferMainRepoFromAutoWorktree(path: string | undefined): string | null {
  if (!path) return null;
  const match = /^(.*?)([\\/])([^\\/]+)\.aha-worktrees(?:[\\/].*)?$/i.exec(path);
  if (!match) return null;
  const parentDir = match[1] ?? '';
  const sep = match[2] ?? '/';
  const repoName = match[3] ?? '';
  if (!repoName) return null;
  return parentDir ? `${parentDir}${sep}${repoName}` : `${sep}${repoName}`;
}

export interface SidebarWindowLineageItem<TWin extends { id: string; cwd?: string }> {
  win: TWin;
  depth: number;
  parentWindowId: string | null;
  effectiveFolder: string | undefined;
  dispatch: OrchestrationDispatchRecord | null;
}

/**
 * Computes parent-child worker lineage for terminal windows so child workers spawned in isolated
 * Git worktrees stay grouped under their parent project and render indented beneath their parent tab.
 */
export function buildSidebarWindowLineage<TWin extends { id: string; cwd?: string }>(
  windows: readonly TWin[],
  snapshot: OrchestrationSnapshot,
  getWindowLeafIds: (windowId: string) => string[],
  defaultCwd?: string,
): SidebarWindowLineageItem<TWin>[] {
  const ptyToWindow = new Map<string, TWin>();
  for (const win of windows) {
    for (const leafId of getWindowLeafIds(win.id)) {
      ptyToWindow.set(`local-${leafId}`, win);
    }
    // Headless Worker sessions have no terminal leaf; their worker handle is the assignee.
    const session = win as { type?: string; workerId?: string };
    if (session.type === 'agent-session' && session.workerId) ptyToWindow.set(session.workerId, win);
  }

  const collapsed = collapseFollowUpLineages(snapshot.dispatches);
  const dispatchByWindowId = new Map<string, OrchestrationDispatchRecord>();
  for (const d of collapsed) {
    const pty = d.assigneePaneId ?? d.assigneeHandle;
    const win = ptyToWindow.get(pty);
    if (win) {
      const prev = dispatchByWindowId.get(win.id);
      if (!prev || isActiveStatus(d.status) || d.createdAt >= prev.createdAt) {
        dispatchByWindowId.set(win.id, d);
      }
    }
  }

  const parentByWindowId = new Map<string, string>();
  for (const win of windows) {
    const d = dispatchByWindowId.get(win.id);
    if (!d) continue;
    let parentWin: TWin | undefined;
    if (d.parentPaneId) {
      parentWin = ptyToWindow.get(d.parentPaneId);
    }
    if (!parentWin && d.creatorDispatchId) {
      const parentDispatch = resolveClientDispatchLineage(
        snapshot.dispatches,
        d.creatorDispatchId,
      );
      const parentPty = parentDispatch?.assigneePaneId ?? parentDispatch?.assigneeHandle;
      if (parentPty) parentWin = ptyToWindow.get(parentPty);
    }
    if (!parentWin) {
      const run = snapshot.runs.find((r) => r.id === d.runId);
      const coordPty = run?.coordinatorPaneId ?? run?.coordinatorHandle;
      if (coordPty) parentWin = ptyToWindow.get(coordPty);
    }
    if (parentWin && parentWin.id !== win.id) {
      parentByWindowId.set(win.id, parentWin.id);
    }
  }

  const byId = new Map(windows.map((w) => [w.id, w]));
  const computeDepthAndRoot = (winId: string): { depth: number; rootWin: TWin } => {
    let depth = 0;
    let cur = byId.get(winId)!;
    const seen = new Set<string>([winId]);
    while (true) {
      const parentId = parentByWindowId.get(cur.id);
      if (!parentId || seen.has(parentId)) break;
      const parent = byId.get(parentId);
      if (!parent) break;
      seen.add(parentId);
      cur = parent;
      depth += 1;
    }
    return { depth, rootWin: cur };
  };

  const rawItems: SidebarWindowLineageItem<TWin>[] = windows.map((win) => {
    const { depth, rootWin } = computeDepthAndRoot(win.id);
    const effectiveFolder =
      depth > 0
        ? (rootWin.cwd ?? inferMainRepoFromAutoWorktree(win.cwd) ?? win.cwd ?? defaultCwd)
        : (inferMainRepoFromAutoWorktree(win.cwd) ?? win.cwd ?? defaultCwd);
    return {
      win,
      depth: Math.min(depth, 3),
      parentWindowId: parentByWindowId.get(win.id) ?? null,
      effectiveFolder,
      dispatch: dispatchByWindowId.get(win.id) ?? null,
    };
  });

  // Order tree so children appear immediately beneath their parent while preserving sibling order.
  const childrenByParent = new Map<string, SidebarWindowLineageItem<TWin>[]>();
  const roots: SidebarWindowLineageItem<TWin>[] = [];
  for (const item of rawItems) {
    if (item.parentWindowId && byId.has(item.parentWindowId)) {
      const list = childrenByParent.get(item.parentWindowId) ?? [];
      list.push(item);
      childrenByParent.set(item.parentWindowId, list);
    } else {
      roots.push(item);
    }
  }

  const ordered: SidebarWindowLineageItem<TWin>[] = [];
  const emitted = new Set<string>();
  const visit = (item: SidebarWindowLineageItem<TWin>) => {
    if (emitted.has(item.win.id)) return;
    emitted.add(item.win.id);
    ordered.push(item);
    for (const child of childrenByParent.get(item.win.id) ?? []) {
      visit(child);
    }
  };
  for (const root of roots) {
    visit(root);
  }
  for (const leftover of rawItems) {
    visit(leftover);
  }
  return ordered;
}

export function filterLineageForFolder<TWin extends { id: string; cwd?: string }>(
  lineage: readonly SidebarWindowLineageItem<TWin>[],
  folderPath: string | undefined,
): SidebarWindowLineageItem<TWin>[] {
  if (!folderPath) return [];
  return lineage.filter(
    (item) => Boolean(item.effectiveFolder && isSamePath(item.effectiveFolder, folderPath)),
  );
}
