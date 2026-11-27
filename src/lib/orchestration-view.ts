import type {
  OrchestrationCoordinatorStatus,
  OrchestrationDispatchProposal,
  OrchestrationDispatchRecord,
  OrchestrationDispatchStatus,
  OrchestrationGateRecord,
  OrchestrationMemberCursor,
  OrchestrationMessagePriority,
  OrchestrationMessageRecord,
  OrchestrationMessageType,
  OrchestrationQuestionRecord,
  OrchestrationRunRecord,
  OrchestrationRunStatus,
  OrchestrationSnapshot,
  OrchestrationStartObservation,
  OrchestrationTaskStatus,
  OrchestrationTaskWithDispatch,
} from '../types';

/** Mailbox the desktop UI acts as; matches the service's default `from`. */
export const UI_HANDLE = 'coordinator';

export const EMPTY_SNAPSHOT: OrchestrationSnapshot = {
  runs: [],
  tasks: [],
  dispatches: [],
  gates: [],
  messages: [],
  questions: [],
  openApprovals: [],
  openNativeQuestions: [],
  pendingProposals: [],
  orchestrationModePanes: [],
  memberCursorsByRun: {},
  coordinatorRuns: [],
  activeCoordinatorRun: null,
  currentRunByConsumer: {},
};

export const TASK_STATUS_LABELS: Record<OrchestrationTaskStatus, string> = {
  pending: '等待依赖',
  ready: '就绪',
  dispatched: '执行中',
  completed: '已完成',
  failed: '失败',
  blocked: '受阻',
};

export const RUN_STATUS_LABELS: Record<OrchestrationRunStatus, string> = {
  active: '进行中',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

export const DISPATCH_STATUS_LABELS: Record<OrchestrationDispatchStatus, string> = {
  pending: '待派发',
  dispatched: '已派发',
  completed: '已完成',
  failed: '失败',
  circuit_broken: '已熔断',
};

export const START_OBSERVATION_LABELS: Record<OrchestrationStartObservation, string> = {
  pending: '待确认',
  observed: '已开始',
  queued: '排队中',
  permission: '等待授权',
  unobserved: '未确认启动',
  unsupported: '未启用观测',
};

export const COORDINATOR_STATUS_LABELS: Record<OrchestrationCoordinatorStatus, string> = {
  idle: '空闲',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  stopped: '已停止',
};

export const MESSAGE_TYPE_LABELS: Record<OrchestrationMessageType, string> = {
  status: '状态',
  dispatch: '派发',
  worker_done: '完成报告',
  merge_ready: '可合并',
  escalation: '升级',
  handoff: '交接',
  decision_gate: '决策',
  question: '提问',
  heartbeat: '心跳',
};

export const PRIORITY_LABELS: Record<OrchestrationMessagePriority, string> = {
  low: '低',
  normal: '普通',
  high: '高',
  urgent: '紧急',
};

export type StatusTone = 'neutral' | 'accent' | 'ok' | 'warn' | 'error';

export const START_OBSERVATION_TONES: Record<OrchestrationStartObservation, StatusTone> = {
  pending: 'neutral',
  observed: 'ok',
  queued: 'accent',
  permission: 'warn',
  unobserved: 'warn',
  unsupported: 'neutral',
};

const DIAGNOSTIC_START_OBSERVATIONS = new Set<OrchestrationStartObservation>(['unobserved', 'permission', 'queued']);

export interface DispatchStartDiagnostic {
  observation: OrchestrationStartObservation;
  label: string;
  tone: StatusTone;
  reason: string | null;
}

/** Diagnostic badge info for an active dispatch whose turn start needs context or attention. */
export function dispatchStartDiagnostic(
  dispatch: Pick<OrchestrationDispatchRecord, 'status' | 'startObservation' | 'startObservationReason'> | null | undefined,
): DispatchStartDiagnostic | null {
  if (!dispatch || dispatch.status !== 'dispatched' || !dispatch.startObservation) return null;
  if (!DIAGNOSTIC_START_OBSERVATIONS.has(dispatch.startObservation)) return null;
  return {
    observation: dispatch.startObservation,
    label: START_OBSERVATION_LABELS[dispatch.startObservation],
    tone: START_OBSERVATION_TONES[dispatch.startObservation],
    reason: dispatch.startObservationReason?.trim() || null,
  };
}

export function taskStatusTone(status: OrchestrationTaskStatus): StatusTone {
  switch (status) {
    case 'completed':
      return 'ok';
    case 'dispatched':
      return 'accent';
    case 'ready':
      return 'accent';
    case 'failed':
      return 'error';
    case 'blocked':
      return 'warn';
    default:
      return 'neutral';
  }
}

export function sortRuns(runs: OrchestrationRunRecord[]): OrchestrationRunRecord[] {
  return [...runs].sort((a, b) => {
    const activeDiff = Number(b.status === 'active') - Number(a.status === 'active');
    if (activeDiff !== 0) return activeDiff;
    return b.createdAt.localeCompare(a.createdAt);
  });
}

/**
 * Picks the run the panel shows: the user's explicit choice if it still exists,
 * otherwise the coordinator's run, the UI mailbox's current run, then the newest active run.
 */
export function pickRunId(snapshot: OrchestrationSnapshot, preferred: string | null): string | null {
  const ids = new Set(snapshot.runs.map((run) => run.id));
  if (preferred && ids.has(preferred)) return preferred;
  const coordinatorRunId = snapshot.activeCoordinatorRun?.runId;
  if (coordinatorRunId && ids.has(coordinatorRunId)) return coordinatorRunId;
  const current = snapshot.currentRunByConsumer[UI_HANDLE];
  if (current && ids.has(current)) return current;
  return sortRuns(snapshot.runs)[0]?.id ?? null;
}

export function tasksForRun(snapshot: OrchestrationSnapshot, runId: string | null): OrchestrationTaskWithDispatch[] {
  if (!runId) return [];
  return snapshot.tasks.filter((task) => task.runId === runId);
}

export interface TaskRow {
  task: OrchestrationTaskWithDispatch;
  /** Longest dependency chain below this task; 0 for tasks without deps. */
  level: number;
  /** Dependency ids that are not completed yet. */
  waitingOn: string[];
  /** Dependency ids that do not exist in the run. */
  missingDeps: string[];
  pendingGates: number;
}

/** Orders tasks by dependency level (a layered DAG), then by creation time. Cycles are tolerated. */
export function buildTaskRows(
  tasks: OrchestrationTaskWithDispatch[],
  gates: OrchestrationGateRecord[] = [],
): TaskRow[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const levels = new Map<string, number>();
  const visiting = new Set<string>();
  const levelOf = (id: string): number => {
    const cached = levels.get(id);
    if (cached !== undefined) return cached;
    const task = byId.get(id);
    if (!task || visiting.has(id)) return 0;
    visiting.add(id);
    let level = 0;
    for (const dep of [...task.deps, ...(task.codeDeps ?? [])]) {
      if (byId.has(dep)) level = Math.max(level, levelOf(dep) + 1);
    }
    visiting.delete(id);
    levels.set(id, level);
    return level;
  };
  const dispatchByParent = new Map(tasks.flatMap(t => t.latestDispatch?.followUpOfDispatchId ? [[t.latestDispatch.followUpOfDispatchId, t.latestDispatch] as const] : []));
  const codeDelivered = (id: string) => {
    let head = byId.get(id)?.latestDispatch;
    const seen = new Set<string>();
    while (head && !seen.has(head.id) && dispatchByParent.has(head.id)) {
      seen.add(head.id);
      head = dispatchByParent.get(head.id);
    }
    return head?.status === 'completed' && head.integrationStatus === 'merged' && Boolean(head.integratedCommit);
  };
  const pendingGateCount = new Map<string, number>();
  for (const gate of gates) {
    if (gate.status === 'pending') pendingGateCount.set(gate.taskId, (pendingGateCount.get(gate.taskId) ?? 0) + 1);
  }
  return tasks
    .map((task) => ({
      task,
      level: levelOf(task.id),
      waitingOn: [...new Set([...task.deps.filter(dep => byId.has(dep) && byId.get(dep)!.status !== 'completed'), ...(task.codeDeps ?? []).filter(dep => byId.has(dep) && !codeDelivered(dep))])],
      missingDeps: [...new Set([...task.deps, ...(task.codeDeps ?? [])])].filter(dep => !byId.has(dep)),
      pendingGates: pendingGateCount.get(task.id) ?? 0,
    }))
    .sort((a, b) => a.level - b.level || a.task.createdAt.localeCompare(b.task.createdAt) || a.task.id.localeCompare(b.task.id));
}

export type TaskCounts = Record<OrchestrationTaskStatus, number> & { total: number };

export function countTasks(tasks: OrchestrationTaskWithDispatch[]): TaskCounts {
  const counts: TaskCounts = { total: tasks.length, pending: 0, ready: 0, dispatched: 0, completed: 0, failed: 0, blocked: 0 };
  for (const task of tasks) counts[task.status] += 1;
  return counts;
}

export function taskTitle(task: {
  taskTitle?: string | null;
  displayName?: string | null;
  spec?: string | null;
  id?: string;
}): string {
  const title = task.displayName?.trim() || task.taskTitle?.trim();
  if (title) return title;
  const firstLine = (task.spec ?? '').split(/\r?\n/).find((line) => line.trim())?.trim();
  return firstLine ? (firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine) : (task.id ?? '');
}

export function workerTabTitle(
  task:
    | {
        taskTitle?: string | null;
        displayName?: string | null;
        spec?: string | null;
        id?: string;
      }
    | null
    | undefined,
  fallbackId?: string,
): string {
  const role = task?.displayName?.trim().replace(/^@+/, '');
  if (role) return `Worker · @${role}`;
  if (task) {
    const title = taskTitle(task);
    if (title) return `Worker · ${title}`;
  }
  return fallbackId ? `Worker · ${fallbackId}` : 'Worker';
}

export function newPendingProposals(
  prev: OrchestrationSnapshot | null,
  next: OrchestrationSnapshot,
): OrchestrationDispatchProposal[] {
  if (!prev) return [];
  const prevPendingIds = new Set(
    (prev.pendingProposals ?? []).filter((p) => p.status === 'pending').map((p) => p.id),
  );
  return (next.pendingProposals ?? []).filter(
    (p) => p.status === 'pending' && !prevPendingIds.has(p.id),
  );
}

export interface AttentionItems {
  gates: OrchestrationGateRecord[];
  questions: OrchestrationQuestionRecord[];
}

/** Pending gates and worker questions; the user supervises the run and may answer any of them. */
export function attentionItems(snapshot: OrchestrationSnapshot, runId?: string | null): AttentionItems {
  const inRun = (id: string) => runId === undefined || runId === null || id === runId;
  return {
    gates: snapshot.gates.filter((gate) => gate.status === 'pending' && inRun(gate.runId)),
    questions: snapshot.questions.filter((question) => question.status === 'pending' && inRun(question.runId)),
  };
}

export function attentionCount(snapshot: OrchestrationSnapshot): number {
  const items = attentionItems(snapshot);
  return items.gates.length + items.questions.length;
}

/** Ids of gates/questions in `next` that were not pending in `prev`. */
export function newAttention(prev: OrchestrationSnapshot | null, next: OrchestrationSnapshot): AttentionItems {
  const after = attentionItems(next);
  if (!prev) return { gates: [], questions: [] };
  const before = attentionItems(prev);
  const gateIds = new Set(before.gates.map((gate) => gate.id));
  const questionIds = new Set(before.questions.map((question) => question.messageId));
  return {
    gates: after.gates.filter((gate) => !gateIds.has(gate.id)),
    questions: after.questions.filter((question) => !questionIds.has(question.messageId)),
  };
}

export function messagesForRun(
  snapshot: OrchestrationSnapshot,
  runId: string | null,
  opts: { includeHeartbeats?: boolean; limit?: number } = {},
): OrchestrationMessageRecord[] {
  if (!runId) return [];
  const list = snapshot.messages
    .filter((message) => message.runId === runId && (opts.includeHeartbeats || message.type !== 'heartbeat'))
    .sort((a, b) => b.seq - a.seq || b.createdAt.localeCompare(a.createdAt));
  return opts.limit ? list.slice(0, opts.limit) : list;
}

/** Messages whose arrival should interrupt the user with a toast. */
export function newUrgentMessages(
  prev: OrchestrationSnapshot | null,
  next: OrchestrationSnapshot,
): OrchestrationMessageRecord[] {
  if (!prev) return [];
  const seen = new Set(prev.messages.map((message) => message.id));
  return next.messages.filter(
    (message) =>
      !seen.has(message.id) &&
      (message.type === 'escalation' || message.priority === 'urgent'),
  );
}

/** Renderer terminal leaf id for a PTY the orchestrator spawned (`local-<terminalId>`). */
export function leafIdForSpawnedPty(ptyId: string): string | null {
  if (!ptyId.startsWith('local-')) return null;
  const leafId = ptyId.slice('local-'.length);
  return /^[a-zA-Z0-9._-]{1,128}$/.test(leafId) ? leafId : null;
}

const KNOWN_CLI_IDS = new Set([
  'codex',
  'claude',
  'gemini',
  'opencode',
  'qoder',
  'kimi',
  'qwen',
  'pi',
  'antigravity',
  'grok',
]);
const KNOWN_SHELL_IDS = new Set(['default', 'pwsh', 'powershell', 'cmd', 'git-bash']);

/** Stage-window launch fields that re-attach to a worker PTY created by the main process. */
export function workerWindowTarget(cliId: string | undefined): { localCliId: string; shellId?: string } {
  const id = cliId?.trim();
  if (id && KNOWN_CLI_IDS.has(id)) return { localCliId: id };
  return { localCliId: 'shell', shellId: id && KNOWN_SHELL_IDS.has(id) ? id : 'default' };
}

export function shortId(id: string): string {
  const parts = id.split('-');
  return parts.length > 1 ? parts.at(-1)!.slice(0, 8) : id.slice(0, 8);
}

export function formatRelativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '';
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return '';
  const diff = Math.max(0, now - ts);
  if (diff < 45_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} 小时前`;
  return `${Math.round(diff / 86_400_000)} 天前`;
}

function mergeScopedRecords<T extends { runId: string }>(
  prevItems: readonly T[],
  incomingItems: readonly T[],
  runId: string,
  validRunIds: ReadonlySet<string>,
  getKey: (item: T) => string,
  compare: (a: T, b: T) => number,
  includeUnbound = false,
): T[] {
  const byKey = new Map<string, T>();
  for (const item of prevItems) {
    if (item.runId !== runId && (validRunIds.has(item.runId) || (includeUnbound && item.runId === 'run_unbound'))) {
      byKey.set(getKey(item), item);
    }
  }
  for (const item of incomingItems) {
    byKey.set(getKey(item), item);
  }
  return [...byKey.values()].sort(compare);
}

/** Merges a run-scoped snapshot pushed by `orchestration:event` into the previously loaded global snapshot. */
export function mergeRunSnapshot(
  prev: OrchestrationSnapshot,
  runId: string,
  incoming: OrchestrationSnapshot,
): OrchestrationSnapshot {
  const validRunIds = new Set(incoming.runs.map((run) => run.id));
  validRunIds.add(runId);
  const byCreatedAt = (a: { createdAt: string }, b: { createdAt: string }) =>
    a.createdAt.localeCompare(b.createdAt);

  return {
    runs: incoming.runs,
    tasks: mergeScopedRecords(prev.tasks, incoming.tasks, runId, validRunIds, (t) => t.id, byCreatedAt),
    dispatches: mergeScopedRecords(prev.dispatches, incoming.dispatches, runId, validRunIds, (d) => d.id, byCreatedAt),
    gates: mergeScopedRecords(prev.gates, incoming.gates, runId, validRunIds, (g) => g.id, byCreatedAt),
    messages: mergeScopedRecords(
      prev.messages,
      incoming.messages,
      runId,
      validRunIds,
      (m) => m.id,
      (a, b) => a.seq - b.seq || a.createdAt.localeCompare(b.createdAt),
      true,
    ),
    questions: mergeScopedRecords(prev.questions, incoming.questions, runId, validRunIds, (q) => q.messageId, byCreatedAt),
    ...(incoming.openApprovals !== undefined || prev.openApprovals !== undefined
      ? {
          openApprovals: mergeScopedRecords(
            prev.openApprovals ?? [],
            incoming.openApprovals ?? [],
            runId,
            validRunIds,
            (a) => a.approvalId,
            byCreatedAt,
          ),
        }
      : {}),
    ...(incoming.openNativeQuestions !== undefined || prev.openNativeQuestions !== undefined
      ? {
          openNativeQuestions: mergeScopedRecords(
            prev.openNativeQuestions ?? [],
            incoming.openNativeQuestions ?? [],
            runId,
            validRunIds,
            (q) => q.requestId,
            byCreatedAt,
          ),
        }
      : {}),
    ...(incoming.pendingProposals !== undefined || prev.pendingProposals !== undefined
      ? {
          pendingProposals: (() => {
            const byId = new Map<string, OrchestrationDispatchProposal>();
            for (const p of prev.pendingProposals ?? []) {
              if (p.runId === null || (p.runId !== runId && validRunIds.has(p.runId))) {
                byId.set(p.id, p);
              }
            }
            for (const p of incoming.pendingProposals ?? []) {
              byId.set(p.id, p);
            }
            return [...byId.values()].sort(byCreatedAt);
          })(),
        }
      : {}),
    ...(incoming.orchestrationModePanes !== undefined
      ? { orchestrationModePanes: incoming.orchestrationModePanes }
      : prev.orchestrationModePanes !== undefined
        ? { orchestrationModePanes: prev.orchestrationModePanes }
        : {}),
    ...(incoming.memberCursorsByRun !== undefined || prev.memberCursorsByRun !== undefined
      ? {
          memberCursorsByRun: (() => {
            const merged: Record<string, Record<string, OrchestrationMemberCursor>> = {};
            for (const [id, cursors] of Object.entries(prev.memberCursorsByRun ?? {})) {
              if (id !== runId && validRunIds.has(id)) {
                merged[id] = cursors;
              }
            }
            for (const [id, cursors] of Object.entries(incoming.memberCursorsByRun ?? {})) {
              if (validRunIds.has(id)) {
                merged[id] = cursors;
              }
            }
            return merged;
          })(),
        }
      : {}),
    coordinatorRuns: mergeScopedRecords(
      prev.coordinatorRuns,
      incoming.coordinatorRuns,
      runId,
      validRunIds,
      (c) => c.id,
      (a, b) => a.startedAt.localeCompare(b.startedAt),
    ),
    activeCoordinatorRun: incoming.activeCoordinatorRun,
    currentRunByConsumer: incoming.currentRunByConsumer,
  };
}

export function isHeadlessDispatch(dispatch: Pick<OrchestrationDispatchRecord, 'executionMode'> | null | undefined): boolean {
  return dispatch?.executionMode === 'codex-app-server';
}

/**
 * The newest headless dispatch a focus target points at (by worker handle or dispatch id),
 * so clicks on app-server Workers open their Agent session instead of a terminal.
 */
export function headlessDispatchForTarget(
  snapshot: Pick<OrchestrationSnapshot, 'dispatches'>,
  target: { ptyId: string | null; dispatchId: string | null },
): OrchestrationDispatchRecord | null {
  const seedId = target.dispatchId?.replace(/^dispatch:/, '');
  const seed = seedId ? snapshot.dispatches.find((d) => d.id === seedId) : undefined;
  const handle = seed && isHeadlessDispatch(seed)
    ? seed.assigneeHandle
    : target.ptyId && snapshot.dispatches.some((d) => d.assigneeHandle === target.ptyId && isHeadlessDispatch(d))
      ? target.ptyId
      : null;
  if (!handle) return null;
  return snapshot.dispatches
    .filter((d) => d.assigneeHandle === handle && isHeadlessDispatch(d))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .at(-1) ?? null;
}
