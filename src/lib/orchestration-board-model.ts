import type {
  OrchestrationBoardPostKind,
  OrchestrationDispatchProposal,
  OrchestrationDispatchRecord,
  OrchestrationDispatchStage,
  OrchestrationGateRecord,
  OrchestrationMessageRecord,
  OrchestrationMessageType,
  OrchestrationQuestionRecord,
  OrchestrationReportArtifacts,
  OrchestrationRunRecord,
  OrchestrationSnapshot,
  OrchestrationTaskRecord,
  WorkerApprovalPayload,
} from '../types';
import {
  collapseFollowUpLineages,
  deriveClientDispatchStage,
  STAGE_LABELS,
  stageTone,
  type AgentStatusLookup,
} from './orchestration-crew-model';
import { shortId, sortRuns, taskTitle, type StatusTone } from './orchestration-view';

export interface InlineBoardToken {
  kind: 'text' | 'bold' | 'code' | 'mention' | 'ref';
  text: string;
  value?: string | number;
}

export interface BoardPostView {
  id: string;
  runId: string;
  seq: number;
  boardSeq: number;
  type: OrchestrationMessageType;
  kind: OrchestrationBoardPostKind;
  fromHandle: string;
  fromRole: string;
  fromCliId: string | null;
  fromPtyId: string | null;
  mentions: string[];
  refs: number[];
  subject: string;
  body: string;
  artifacts: OrchestrationReportArtifacts | null;
  createdAt: string;
  timeLabel: string;
  threadId: string | null;
}

export interface BoardCoordinatorCard {
  role: 'coordinator';
  label: '@coordinator';
  ptyId: string | null;
  cliId: string | null;
  model: string | null;
  status: 'working' | 'waiting' | 'idle' | 'offline' | 'stopped';
  stageLabel: string;
  tone: StatusTone;
  subtitle: string;
  liveActivity: string | null;
  latestPostSeq: number | null;
  latestPostPreview: string;
}

export interface BoardMemberCard {
  key: string;
  role: string;
  label: string;
  dispatchId: string;
  taskId: string;
  ptyId: string | null;
  cliId: string | null;
  model: string | null;
  effort: string | null;
  stage: OrchestrationDispatchStage;
  stageLabel: string;
  tone: StatusTone;
  branch: string | null;
  worktreePath: string | null;
  taskSummary: string;
  liveActivity: string | null;
  latestPostSeq: number | null;
  latestPostPreview: string;
  isSettled: boolean;
  retained: boolean;
  released: boolean;
  needsAttention: boolean;
  verificationBadge?: { label: string; tone: StatusTone } | null;
}

export interface BoardViewModel {
  runs: OrchestrationRunRecord[];
  run: OrchestrationRunRecord | null;
  isLive: boolean;
  runStatusLabel: string;
  hasAnyActiveRun: boolean;
  headSeq: number;
  posts: BoardPostView[];
  coordinator: BoardCoordinatorCard | null;
  members: BoardMemberCard[];
  openApprovals: WorkerApprovalPayload[];
  openQuestions: OrchestrationQuestionRecord[];
  openGates: OrchestrationGateRecord[];
  pendingProposals: OrchestrationDispatchProposal[];
  attentionCount: number;
  durationLabel: string;
}

export interface BoardGraphNode {
  id: string;
  label: string;
  kind: 'coordinator' | 'worker' | 'user' | 'system';
  x: number;
  y: number;
  width: number;
  cliId: string | null;
  ptyId: string | null;
  stage: string;
  tone: StatusTone;
  postCount: number;
  incomingCount: number;
  active: boolean;
  postedWithNoMention: boolean;
}

export interface BoardGraphEdge {
  key: string;
  from: string;
  to: string;
  count: number;
  viaAll: boolean;
  hasReverse: boolean;
}

export interface BoardGraphModel {
  width: number;
  height: number;
  upToSeq: number;
  visiblePostCount: number;
  durationLabel: string;
  allPostCount: number;
  nodes: BoardGraphNode[];
  edges: BoardGraphEdge[];
}

export const GRAPH_WIDTH = 560;
export const GRAPH_HEIGHT = 320;

const NON_MENTION_PREFIX = /[a-zA-Z0-9._-]/;
const NON_REF_PREFIX = /[a-zA-Z0-9_#]/;

function pushTextToken(tokens: InlineBoardToken[], chunk: string) {
  if (!chunk) return;
  const last = tokens.at(-1);
  if (last && last.kind === 'text') {
    last.text += chunk;
  } else {
    tokens.push({ kind: 'text', text: chunk });
  }
}

/**
 * Safely tokenizes board message text into inline spans (`bold`, `code`, `@mention`, `#seq`, `text`)
 * without HTML parsing. Ignores email addresses (e.g. `a@b.com`), hex colors (`#ffffff`), and headings (`## 1`).
 */
export function parseInlineBoardTokens(text: string): InlineBoardToken[] {
  const tokens: InlineBoardToken[] = [];
  if (!text) return tokens;

  let i = 0;
  const len = text.length;

  while (i < len) {
    const ch = text[i]!;

    // Inline code: `...` (single-line)
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      const nl = text.indexOf('\n', i + 1);
      if (close > i + 1 && (nl === -1 || close < nl)) {
        const content = text.slice(i + 1, close);
        tokens.push({ kind: 'code', text: content, value: content });
        i = close + 1;
        continue;
      }
    }

    // Bold: **...** (single-line)
    if (ch === '*' && text[i + 1] === '*') {
      const close = text.indexOf('**', i + 2);
      const nl = text.indexOf('\n', i + 2);
      if (close > i + 2 && (nl === -1 || close < nl)) {
        const content = text.slice(i + 2, close);
        if (content.trim()) {
          tokens.push({ kind: 'bold', text: content, value: content });
          i = close + 2;
          continue;
        }
      }
    }

    const prev = i === 0 ? '' : text[i - 1]!;

    // @mention (only outside ASCII email/word prefixes; skips emails like a@b.com while allowing CJK prefixes)
    if (ch === '@' && (i === 0 || !NON_MENTION_PREFIX.test(prev))) {
      const slice = text.slice(i);
      const m = /^@([a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9_-])?)(?![a-zA-Z0-9_-])/.exec(slice);
      if (m && m[1]) {
        const handle = m[1];
        tokens.push({ kind: 'mention', text: `@${handle}`, value: handle.toLowerCase() });
        i += m[0].length;
        continue;
      }
    }

    // #seq numeric reference (excludes ## headings, identifiers like foo#1, and hex colors like #ffffff)
    if (ch === '#' && (i === 0 || !NON_REF_PREFIX.test(prev))) {
      const slice = text.slice(i);
      const m = /^#([1-9]\d{0,5})(?![a-zA-Z0-9_])/.exec(slice);
      if (m && m[1]) {
        const seq = Number(m[1]);
        tokens.push({ kind: 'ref', text: `#${seq}`, value: seq });
        i += m[0].length;
        continue;
      }
    }

    pushTextToken(tokens, ch);
    i += 1;
  }

  return tokens;
}

export function formatBoardDuration(ms: number): string {
  const safeMs = Math.max(0, Number.isFinite(ms) ? ms : 0);
  const totalSec = Math.round(safeMs / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return remMins > 0 ? `${hours}h ${remMins}m` : `${hours}h`;
}

export function formatPostsDurationLabel(
  posts: ReadonlyArray<{ createdAt: string }>,
  runCreatedAt?: string | null,
): string {
  if (posts.length === 0) return '0 posts';
  const countWord = posts.length === 1 ? '1 post' : `${posts.length} posts`;
  const firstTs = Date.parse(posts[0]!.createdAt);
  const lastTs = Date.parse(posts.at(-1)!.createdAt);
  const runTs = runCreatedAt ? Date.parse(runCreatedAt) : Number.NaN;
  const startTs = Number.isFinite(firstTs) ? firstTs : runTs;
  const endTs = Number.isFinite(lastTs) ? lastTs : startTs;
  if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return countWord;
  return `${countWord} over ${formatBoardDuration(Math.max(0, endTs - startTs))}`;
}

export function roleColorIndex(role: string): number {
  const key = role.trim().toLowerCase();
  if (key === 'coordinator') return 0;
  if (key === 'user') return 1;
  if (key === 'system') return 2;
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) {
    hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  }
  return 3 + (hash % 5);
}

function formatTimeHHMM(iso: string): string {
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const date = new Date(ts);
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function normalizeRoleName(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/^@+/, '');
}

function inferKindFromType(type: OrchestrationMessageType): OrchestrationBoardPostKind {
  switch (type) {
    case 'dispatch':
      return 'brief';
    case 'worker_done':
    case 'merge_ready':
      return 'report';
    case 'question':
    case 'decision_gate':
      return 'question';
    case 'handoff':
      return 'handoff';
    case 'escalation':
    case 'status':
      return 'update';
    default:
      return 'post';
  }
}

function compactPreview(text: string, maxLen = 110): string {
  const single = text.replace(/\s+/g, ' ').trim();
  if (single.length <= maxLen) return single;
  return `${single.slice(0, maxLen - 1)}…`;
}

function cleanTaskSummary(task: OrchestrationTaskRecord | null, role: string): string {
  if (!task) return '';
  let desc = task.taskTitle?.trim() || '';
  if (desc && role) {
    const escaped = role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const stripped = desc.replace(new RegExp(`^@?${escaped}\\s*[:：-]\\s*`, 'i'), '').trim();
    if (stripped) desc = stripped;
  }
  if (!desc) {
    const firstLine = task.spec.split(/\r?\n/).find((line) => line.trim())?.trim() ?? '';
    desc = firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
  }
  return desc || taskTitle(task);
}

function formatLiveAgentActivity(status: {
  state?: string;
  waitKind?: string;
  toolName?: string;
  toolInput?: string;
  message?: string;
} | null | undefined): string | null {
  if (!status) return null;
  const tool = status.toolName?.trim();
  const input = status.toolInput?.trim();
  const msg = status.message?.trim();
  if (status.state === 'waiting') {
    const prefix = status.waitKind === 'question' ? '等待回答' : '等待授权';
    if (tool && input) return compactPreview(`${prefix} · ${tool}: ${input}`, 110);
    if (tool) return compactPreview(`${prefix} · ${tool}`, 110);
    if (msg) return compactPreview(`${prefix} · ${msg}`, 110);
    return prefix;
  }
  if (status.state === 'working') {
    if (tool && input) return compactPreview(`${tool}: ${input}`, 110);
    if (tool) return compactPreview(`正在执行 ${tool}`, 110);
    if (msg) return compactPreview(msg, 110);
    return null;
  }
  if (status.state === 'error' && msg) {
    return compactPreview(msg, 110);
  }
  return null;
}

function runStatusDisplayLabel(status: OrchestrationRunRecord['status']): string {
  switch (status) {
    case 'active':
      return 'Live';
    case 'completed':
      return '历史 · 已完成';
    case 'failed':
      return '历史 · 失败';
    case 'stopped':
    default:
      return '历史 · 已停止';
  }
}

function pickTargetRun(
  snapshot: OrchestrationSnapshot,
  opts: { runId?: string | null; activePtyId?: string | null },
): OrchestrationRunRecord | null {
  const sorted = sortRuns(snapshot.runs);
  if (sorted.length === 0) return null;
  if (opts.runId) {
    const explicit = sorted.find((r) => r.id === opts.runId);
    if (explicit) return explicit;
  }

  const activeRuns = sorted.filter((r) => r.status === 'active');

  const findBoundRunForPty = (ptyId: string, pool: OrchestrationRunRecord[]): OrchestrationRunRecord | null => {
    const boundId = snapshot.currentRunByConsumer[ptyId];
    if (boundId) {
      const bound = pool.find((r) => r.id === boundId);
      if (bound) return bound;
    }
    const coordRun = pool.find(
      (r) => r.coordinatorPaneId === ptyId || r.coordinatorHandle === ptyId,
    );
    if (coordRun) return coordRun;
    const activeDispatch = snapshot.dispatches.find(
      (d) =>
        (d.assigneePaneId === ptyId || d.assigneeHandle === ptyId) &&
        (d.status === 'pending' || d.status === 'dispatched') &&
        pool.some((r) => r.id === d.runId),
    );
    const anyDispatch =
      activeDispatch ??
      snapshot.dispatches.find(
        (d) =>
          (d.assigneePaneId === ptyId || d.assigneeHandle === ptyId) &&
          pool.some((r) => r.id === d.runId),
      );
    if (anyDispatch) {
      return pool.find((r) => r.id === anyDispatch.runId) ?? null;
    }
    return null;
  };

  // Prefer active runs over historical stopped runs so a live collaboration is never hidden by old history.
  if (activeRuns.length > 0) {
    if (opts.activePtyId) {
      const activeForPane = findBoundRunForPty(opts.activePtyId, activeRuns);
      if (activeForPane) return activeForPane;
    }
    const activeCoordRunId = snapshot.activeCoordinatorRun?.runId;
    if (activeCoordRunId) {
      const found = activeRuns.find((r) => r.id === activeCoordRunId);
      if (found) return found;
    }
    return activeRuns[0] ?? null;
  }

  if (opts.activePtyId) {
    const historicalForPane = findBoundRunForPty(opts.activePtyId, sorted);
    if (historicalForPane) return historicalForPane;
  }
  const activeCoordRunId = snapshot.activeCoordinatorRun?.runId;
  if (activeCoordRunId) {
    const found = sorted.find((r) => r.id === activeCoordRunId);
    if (found) return found;
  }
  return sorted[0] ?? null;
}

export function buildBoardViewModel(
  snapshot: OrchestrationSnapshot,
  opts: {
    runId?: string | null;
    agentStatuses?: AgentStatusLookup;
    activePtyId?: string | null;
    livePaneIds?: ReadonlySet<string>;
  } = {},
): BoardViewModel {
  const runs = sortRuns(snapshot.runs);
  const hasAnyActiveRun = runs.some((r) => r.status === 'active');
  const run = pickTargetRun(snapshot, opts);
  const pendingProposalsAll = (snapshot.pendingProposals ?? []).filter(
    (p) => p.status === 'pending',
  );

  if (!run) {
    return {
      runs,
      run: null,
      isLive: false,
      runStatusLabel: '空闲',
      hasAnyActiveRun,
      headSeq: 0,
      posts: [],
      coordinator: null,
      members: [],
      openApprovals: [],
      openQuestions: [],
      openGates: [],
      pendingProposals: pendingProposalsAll,
      attentionCount: pendingProposalsAll.length,
      durationLabel: '0 posts',
    };
  }

  const runTasks = snapshot.tasks.filter((t) => t.runId === run.id);
  const taskById = new Map(runTasks.map((t) => [t.id, t]));
  const runDispatches = snapshot.dispatches.filter((d) => d.runId === run.id);
  const collapsedDispatches = collapseFollowUpLineages(runDispatches);

  // Build handle/dispatch/pane -> role & cli/pty lookups across all dispatches in the run.
  const roleByHandle = new Map<string, string>();
  const metaByRole = new Map<string, { cliId: string | null; ptyId: string | null }>();

  const coordPtyId =
    run.coordinatorPaneId ??
    (run.coordinatorHandle.startsWith('local-') ? run.coordinatorHandle : null);
  const coordAgentStatus = coordPtyId ? opts.agentStatuses?.get(coordPtyId) : undefined;
  const coordCliId = coordAgentStatus?.agentId ?? null;

  roleByHandle.set('coordinator', 'coordinator');
  roleByHandle.set(`run:${run.id}`, 'coordinator');
  if (run.coordinatorHandle) roleByHandle.set(run.coordinatorHandle, 'coordinator');
  if (coordPtyId) roleByHandle.set(coordPtyId, 'coordinator');
  metaByRole.set('coordinator', { cliId: coordCliId, ptyId: coordPtyId });

  const dispatchRole = (dispatch: OrchestrationDispatchRecord): string => {
    const task = taskById.get(dispatch.taskId) ?? null;
    const named = normalizeRoleName(task?.displayName);
    return named || shortId(dispatch.taskId);
  };

  for (const dispatch of runDispatches) {
    const role = dispatchRole(dispatch);
    const ptyId =
      dispatch.assigneePaneId ??
      (dispatch.assigneeHandle.startsWith('local-') ? dispatch.assigneeHandle : null);
    const cliId = dispatch.cliId ?? (ptyId ? opts.agentStatuses?.get(ptyId)?.agentId ?? null : null);
    roleByHandle.set(`dispatch:${dispatch.id}`, role);
    roleByHandle.set(dispatch.id, role);
    if (dispatch.assigneeHandle) roleByHandle.set(dispatch.assigneeHandle, role);
    if (ptyId) roleByHandle.set(ptyId, role);
    metaByRole.set(role.toLowerCase(), { cliId, ptyId });
  }

  const resolveRole = (handle: string): string => {
    const clean = normalizeRoleName(handle);
    if (!clean) return 'system';
    const lower = clean.toLowerCase();
    if (lower === 'user' || lower === 'human') return 'user';
    if (lower === 'system') return 'system';
    if (lower === 'coordinator') return 'coordinator';
    if (lower === 'all' || lower === 'workers') return 'all';
    const mapped = roleByHandle.get(clean);
    if (mapped) return mapped;
    if (clean.startsWith('dispatch:')) {
      return shortId(clean.slice('dispatch:'.length));
    }
    return clean;
  };

  const rawMessages = snapshot.messages
    .filter((m) => m.runId === run.id && m.type !== 'heartbeat')
    .sort((a, b) => {
      const seqDiff = (a.boardSeq ?? a.seq) - (b.boardSeq ?? b.seq);
      if (seqDiff !== 0) return seqDiff;
      return a.createdAt.localeCompare(b.createdAt);
    });

  const posts: BoardPostView[] = rawMessages.map((msg: OrchestrationMessageRecord, index) => {
    const boardSeq = msg.boardSeq ?? index + 1;
    const fromRole = normalizeRoleName(msg.fromRole) || resolveRole(msg.fromHandle);
    const body = msg.body?.trim() || msg.subject?.trim() || '';
    const tokens = parseInlineBoardTokens(body);

    const mentionSet = new Set<string>();
    if (msg.mentions && msg.mentions.length > 0) {
      for (const m of msg.mentions) {
        const cleaned = normalizeRoleName(m).toLowerCase();
        if (cleaned) mentionSet.add(cleaned);
      }
    } else {
      for (const tok of tokens) {
        if (tok.kind === 'mention' && typeof tok.value === 'string') {
          mentionSet.add(tok.value);
        }
      }
      if (mentionSet.size === 0 && msg.toHandle) {
        const toRole = resolveRole(msg.toHandle).toLowerCase();
        if (toRole && toRole !== fromRole.toLowerCase()) {
          mentionSet.add(toRole);
        }
      }
    }

    const refSet = new Set<number>();
    if (msg.refs && msg.refs.length > 0) {
      for (const r of msg.refs) {
        if (Number.isInteger(r) && r > 0) refSet.add(r);
      }
    } else {
      for (const tok of tokens) {
        if (tok.kind === 'ref' && typeof tok.value === 'number') {
          refSet.add(tok.value);
        }
      }
    }

    const fromMeta = metaByRole.get(fromRole.toLowerCase());
    return {
      id: msg.id,
      runId: msg.runId,
      seq: msg.seq,
      boardSeq,
      type: msg.type,
      kind: msg.kind ?? inferKindFromType(msg.type),
      fromHandle: msg.fromHandle,
      fromRole,
      fromCliId: fromMeta?.cliId ?? null,
      fromPtyId: fromMeta?.ptyId ?? null,
      mentions: [...mentionSet],
      refs: [...refSet],
      subject: msg.subject?.trim() ?? '',
      body,
      artifacts: msg.artifacts ?? null,
      createdAt: msg.createdAt,
      timeLabel: formatTimeHHMM(msg.createdAt),
      threadId: msg.threadId,
    };
  });

  const latestPostByRole = new Map<string, BoardPostView>();
  for (const post of posts) {
    latestPostByRole.set(post.fromRole.toLowerCase(), post);
  }

  const coordLatestPost = latestPostByRole.get('coordinator') ?? null;
  const coordPaneAlive =
    Boolean(coordAgentStatus) || Boolean(coordPtyId && opts.livePaneIds?.has(coordPtyId));
  let coordStatus: BoardCoordinatorCard['status'];
  let coordStageLabel: string;
  let coordTone: StatusTone;
  if (run.status !== 'active') {
    coordStatus = 'stopped';
    coordStageLabel =
      run.status === 'completed' ? '已完成' : run.status === 'failed' ? '失败' : '已结束';
    coordTone = run.status === 'completed' ? 'ok' : run.status === 'failed' ? 'error' : 'neutral';
  } else if (coordAgentStatus?.state === 'working') {
    coordStatus = 'working';
    coordStageLabel = '执行中';
    coordTone = 'accent';
  } else if (coordAgentStatus?.state === 'waiting') {
    coordStatus = 'waiting';
    coordStageLabel = coordAgentStatus.waitKind === 'question' ? '待回答' : '待授权';
    coordTone = 'warn';
  } else if (coordPaneAlive) {
    coordStatus = 'idle';
    coordStageLabel = '在线';
    coordTone = 'ok';
  } else {
    coordStatus = 'offline';
    coordStageLabel = '离线';
    coordTone = 'neutral';
  }
  const coordLiveActivity =
    run.status === 'active' ? formatLiveAgentActivity(coordAgentStatus) : null;
  const coordinator: BoardCoordinatorCard = {
    role: 'coordinator',
    label: '@coordinator',
    ptyId: coordPtyId,
    cliId: coordCliId,
    model: null,
    status: coordStatus,
    stageLabel: coordStageLabel,
    tone: coordTone,
    subtitle: coordCliId ? `Coordinator · ${coordCliId}` : 'Coordinator',
    liveActivity: coordLiveActivity,
    latestPostSeq: coordLatestPost?.boardSeq ?? null,
    latestPostPreview: coordLatestPost
      ? compactPreview(coordLatestPost.body, 140)
      : compactPreview(run.objective, 140),
  };

  const openApprovals = (snapshot.openApprovals ?? []).filter(
    (a) => a.status === 'pending' && a.runId === run.id,
  );
  const openQuestions = snapshot.questions.filter(
    (q) => q.status === 'pending' && q.runId === run.id,
  );
  const openGates = snapshot.gates.filter((g) => g.status === 'pending' && g.runId === run.id);
  const pendingProposals = pendingProposalsAll.filter(
    (p) =>
      p.runId === run.id ||
      (p.runId === null && (p.coordinatorPaneId === coordPtyId || run.status === 'active')),
  );

  const members: BoardMemberCard[] = collapsedDispatches
    .map((dispatch) => {
      const task = taskById.get(dispatch.taskId) ?? null;
      const role = dispatchRole(dispatch);
      const ptyId =
        dispatch.assigneePaneId ??
        (dispatch.assigneeHandle.startsWith('local-') ? dispatch.assigneeHandle : null);
      const agentStatus = ptyId ? opts.agentStatuses?.get(ptyId) : undefined;
      const hasOpenApproval = openApprovals.some((a) => a.dispatchId === dispatch.id);
      const hasOpenQuestion = openQuestions.some((q) => q.dispatchId === dispatch.id);
      const stage = deriveClientDispatchStage(
        dispatch,
        agentStatus,
        hasOpenApproval,
        hasOpenQuestion,
      );
      const isSettled = dispatch.status !== 'pending' && dispatch.status !== 'dispatched';
      const needsAttention =
        stage === 'waiting_permission' ||
        stage === 'waiting_input' ||
        stage === 'awaiting_review' ||
        stage === 'failed';
      const cliId = dispatch.cliId ?? agentStatus?.agentId ?? null;
      const latestPost = latestPostByRole.get(role.toLowerCase()) ?? null;
      const summary = cleanTaskSummary(task, role);
      const liveActivity =
        !isSettled && !dispatch.releasedAt ? formatLiveAgentActivity(agentStatus) : null;
      let verificationBadge: { label: string; tone: StatusTone } | null = null;
      if (dispatch.integrationStatus === 'merged') {
        verificationBadge = { label: '已合入', tone: 'ok' };
      } else if (dispatch.integrationStatus === 'conflict') {
        verificationBadge = { label: '合入冲突', tone: 'error' };
      } else if (dispatch.reviewStatus === 'escalated') {
        verificationBadge = { label: '审查升级', tone: 'error' };
      } else if (dispatch.reviewStatus === 'rejected') {
        verificationBadge = { label: `打回 R${dispatch.reviewRound ?? 1}`, tone: 'warn' };
      } else if (dispatch.reviewStatus === 'pending') {
        verificationBadge = { label: '对抗审查中', tone: 'accent' };
      } else if (dispatch.reviewStatus === 'passed') {
        verificationBadge = { label: '审查通过', tone: 'ok' };
      }

      return {
        key: dispatch.id,
        role,
        label: `@${role}`,
        dispatchId: dispatch.id,
        taskId: dispatch.taskId,
        ptyId,
        cliId,
        model: dispatch.model ?? null,
        effort: dispatch.effort ?? null,
        stage,
        stageLabel: STAGE_LABELS[stage],
        tone: stageTone(stage),
        branch: dispatch.branch ?? null,
        worktreePath: dispatch.worktreePath ?? task?.worktreePath ?? null,
        taskSummary: summary,
        liveActivity,
        latestPostSeq: latestPost?.boardSeq ?? null,
        latestPostPreview: latestPost
          ? compactPreview(latestPost.body, 110)
          : dispatch.branch
            ? `branch ${dispatch.branch}`
            : summary,
        isSettled,
        retained: Boolean(dispatch.retained),
        released: Boolean(dispatch.releasedAt),
        needsAttention,
        verificationBadge,
      };
    })
    .sort((a, b) => {
      const activeDiff = Number(!a.isSettled && !a.released) - Number(!b.isSettled && !b.released);
      if (activeDiff !== 0) return -activeDiff;
      const attnDiff = Number(b.needsAttention) - Number(a.needsAttention);
      if (attnDiff !== 0) return attnDiff;
      return (b.latestPostSeq ?? 0) - (a.latestPostSeq ?? 0) || a.role.localeCompare(b.role);
    });

  const headSeq = posts.reduce((max, p) => Math.max(max, p.boardSeq), 0);
  const attentionCount =
    pendingProposals.length +
    openApprovals.length +
    openQuestions.length +
    openGates.length;

  return {
    runs,
    run,
    isLive: run.status === 'active',
    runStatusLabel: runStatusDisplayLabel(run.status),
    hasAnyActiveRun,
    headSeq,
    posts,
    coordinator,
    members,
    openApprovals,
    openQuestions,
    openGates,
    pendingProposals,
    attentionCount,
    durationLabel: formatPostsDurationLabel(posts, run.createdAt),
  };
}

function estimatePillWidth(label: string): number {
  const clamped = Math.min(label.length, 16);
  return Math.max(76, Math.min(136, 36 + clamped * 6.8));
}

export function buildBoardGraphModel(
  posts: readonly BoardPostView[],
  members: readonly BoardMemberCard[],
  coordinator: BoardCoordinatorCard | null,
  opts: {
    upToSeq?: number | null;
    hideInactive?: boolean;
    expandAll?: boolean;
  } = {},
): BoardGraphModel {
  const maxSeq = posts.reduce((max, p) => Math.max(max, p.boardSeq), 0);
  const upToSeq = opts.upToSeq == null ? maxSeq : Math.max(0, Math.min(opts.upToSeq, maxSeq));
  const visiblePosts =
    opts.upToSeq == null ? posts : posts.filter((p) => p.boardSeq <= upToSeq);

  type RawNode = {
    id: string;
    label: string;
    kind: 'coordinator' | 'worker' | 'user' | 'system';
    cliId: string | null;
    ptyId: string | null;
    stage: string;
    tone: StatusTone;
    postCount: number;
    incomingCount: number;
    postedWithNoMention: boolean;
  };

  const nodeMap = new Map<string, RawNode>();

  if (coordinator || visiblePosts.some((p) => p.fromRole.toLowerCase() === 'coordinator')) {
    nodeMap.set('coordinator', {
      id: 'coordinator',
      label: 'coordinator',
      kind: 'coordinator',
      cliId: coordinator?.cliId ?? null,
      ptyId: coordinator?.ptyId ?? null,
      stage: coordinator?.status ?? 'idle',
      tone: coordinator?.tone ?? 'neutral',
      postCount: 0,
      incomingCount: 0,
      postedWithNoMention: false,
    });
  }

  for (const member of members) {
    const id = member.role.toLowerCase();
    if (!id || nodeMap.has(id)) continue;
    nodeMap.set(id, {
      id,
      label: member.role,
      kind: 'worker',
      cliId: member.cliId,
      ptyId: member.ptyId,
      stage: member.stage,
      tone: member.tone,
      postCount: 0,
      incomingCount: 0,
      postedWithNoMention: false,
    });
  }

  // Register any additional human/system/ad-hoc roles referenced in posts.
  for (const post of posts) {
    const fromId = post.fromRole.toLowerCase();
    if (fromId && !nodeMap.has(fromId)) {
      nodeMap.set(fromId, {
        id: fromId,
        label: post.fromRole,
        kind: fromId === 'user' ? 'user' : fromId === 'system' ? 'system' : 'worker',
        cliId: post.fromCliId,
        ptyId: post.fromPtyId,
        stage: 'idle',
        tone: fromId === 'user' ? 'accent' : 'neutral',
        postCount: 0,
        incomingCount: 0,
        postedWithNoMention: false,
      });
    }
    for (const mention of post.mentions) {
      if (!mention || mention === 'all' || mention === 'workers') continue;
      if (!nodeMap.has(mention)) {
        nodeMap.set(mention, {
          id: mention,
          label: mention,
          kind: mention === 'user' ? 'user' : mention === 'system' ? 'system' : 'worker',
          cliId: null,
          ptyId: null,
          stage: 'idle',
          tone: 'neutral',
          postCount: 0,
          incomingCount: 0,
          postedWithNoMention: false,
        });
      }
    }
  }

  const allTeamTargetIds = [...nodeMap.values()]
    .filter((n) => n.kind === 'worker' || n.kind === 'coordinator')
    .map((n) => n.id);

  let allPostCount = 0;
  const edgeMap = new Map<string, { from: string; to: string; count: number; viaAll: boolean }>();

  const bumpEdge = (from: string, to: string, viaAll: boolean) => {
    if (from === to) return;
    const key = `${from}->${to}|${viaAll ? 'all' : 'direct'}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      edgeMap.set(key, { from, to, count: 1, viaAll });
    }
    const target = nodeMap.get(to);
    if (target) target.incomingCount += 1;
  };

  for (const post of visiblePosts) {
    const fromId = post.fromRole.toLowerCase();
    const fromNode = nodeMap.get(fromId);
    if (fromNode) {
      fromNode.postCount += 1;
      if (post.mentions.length === 0) {
        fromNode.postedWithNoMention = true;
      }
    }

    const mentionsAll = post.mentions.includes('all') || post.mentions.includes('workers');
    if (mentionsAll) {
      allPostCount += 1;
      if (opts.expandAll) {
        for (const targetId of allTeamTargetIds) {
          if (targetId !== fromId) {
            bumpEdge(fromId, targetId, true);
          }
        }
      }
    }

    for (const mention of post.mentions) {
      if (!mention || mention === 'all' || mention === 'workers') continue;
      if (nodeMap.has(mention) && mention !== fromId) {
        bumpEdge(fromId, mention, false);
      }
    }
  }

  let rawNodes = [...nodeMap.values()].map((n) => ({
    ...n,
    active: n.postCount > 0 || n.incomingCount > 0,
  }));

  if (opts.hideInactive) {
    const activeOnly = rawNodes.filter((n) => n.active);
    rawNodes = activeOnly;
  }

  const keptIds = new Set(rawNodes.map((n) => n.id));
  const coordNode = rawNodes.find((n) => n.id === 'coordinator') ?? null;
  const otherNodes = rawNodes.filter((n) => n.id !== 'coordinator');

  const positionedNodes: BoardGraphNode[] = [];

  if (coordNode) {
    positionedNodes.push({
      ...coordNode,
      x: GRAPH_WIDTH / 2,
      y: 52,
      width: estimatePillWidth(coordNode.label),
    });
  }

  const count = otherNodes.length;
  otherNodes.forEach((node, index) => {
    let x = GRAPH_WIDTH / 2;
    let y = 236;
    if (count === 1) {
      x = GRAPH_WIDTH / 2;
      y = 244;
    } else if (count === 2) {
      x = index === 0 ? 150 : 410;
      y = 232;
    } else {
      const startDeg = count >= 6 ? -15 : 12;
      const endDeg = count >= 6 ? 195 : 168;
      const deg = startDeg + ((endDeg - startDeg) * index) / (count - 1);
      const rad = (deg * Math.PI) / 180;
      const cx = GRAPH_WIDTH / 2;
      const cy = count >= 6 ? 158 : 148;
      const rx = 202;
      const ry = 114;
      x = Math.round(Math.max(76, Math.min(GRAPH_WIDTH - 76, cx + rx * Math.cos(rad))));
      y = Math.round(Math.max(106, Math.min(GRAPH_HEIGHT - 36, cy + ry * Math.sin(rad))));
    }
    positionedNodes.push({
      ...node,
      x,
      y,
      width: estimatePillWidth(node.label),
    });
  });

  const filteredEdges = [...edgeMap.entries()]
    .filter(([, edge]) => keptIds.has(edge.from) && keptIds.has(edge.to))
    .map(([key, edge]) => ({ key, ...edge }));

  const pairSet = new Set(filteredEdges.map((e) => `${e.from}->${e.to}`));
  const edges: BoardGraphEdge[] = filteredEdges.map((e) => ({
    ...e,
    hasReverse: pairSet.has(`${e.to}->${e.from}`),
  }));

  return {
    width: GRAPH_WIDTH,
    height: GRAPH_HEIGHT,
    upToSeq,
    visiblePostCount: visiblePosts.length,
    durationLabel: formatPostsDurationLabel(visiblePosts),
    allPostCount,
    nodes: positionedNodes,
    edges,
  };
}
