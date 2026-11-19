import type { OrchestrationSnapshot } from '../../types';
import { resolveClientDispatchLineage } from '../orchestration-crew-model';

export interface ParsedOrchestrationLinkToken {
  kind: 'task' | 'dispatch' | 'handle';
  rawText: string;
  id: string;
  startIndex: number;
  endIndex: number;
}

export interface ResolvedOrchestrationLinkTarget {
  kind: 'task' | 'dispatch' | 'handle';
  label: string;
  ptyId: string | null;
  dispatchId: string | null;
  taskId: string | null;
  cwd: string | null;
  cliId: string | null;
}

const TOKEN_RE =
  /(^|[\s([{"'`])(#(?:[A-Za-z0-9_-][A-Za-z0-9._:-]{0,78}[A-Za-z0-9_-]|[A-Za-z0-9_-])|task_[A-Za-z0-9_-]{1,80}|dispatch:ctx_[A-Za-z0-9_-]{1,80}|ctx_[A-Za-z0-9_-]{1,80}|@(?:dispatch:ctx_[A-Za-z0-9_-]{1,80}|[A-Za-z0-9_-][A-Za-z0-9._:-]{0,78}[A-Za-z0-9_-]|[A-Za-z0-9_-]))(?=$|[\s)\]}"'`,.;!?])/g;

export function extractOrchestrationTerminalLinks(text: string): ParsedOrchestrationLinkToken[] {
  if (!text) return [];
  const results: ParsedOrchestrationLinkToken[] = [];
  TOKEN_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TOKEN_RE.exec(text)) !== null) {
    const prefix = match[1] ?? '';
    const token = match[2]!;
    const startIndex = match.index + prefix.length;
    const endIndex = startIndex + token.length;

    if (token.startsWith('#')) {
      results.push({
        kind: 'task',
        rawText: token,
        id: token.slice(1),
        startIndex,
        endIndex,
      });
    } else if (token.startsWith('task_')) {
      results.push({
        kind: 'task',
        rawText: token,
        id: token,
        startIndex,
        endIndex,
      });
    } else if (token.startsWith('dispatch:ctx_')) {
      results.push({
        kind: 'dispatch',
        rawText: token,
        id: token.slice('dispatch:'.length),
        startIndex,
        endIndex,
      });
    } else if (token.startsWith('ctx_')) {
      results.push({
        kind: 'dispatch',
        rawText: token,
        id: token,
        startIndex,
        endIndex,
      });
    } else if (token.startsWith('@')) {
      const inner = token.slice(1);
      if (inner.startsWith('dispatch:ctx_')) {
        results.push({
          kind: 'dispatch',
          rawText: token,
          id: inner.slice('dispatch:'.length),
          startIndex,
          endIndex,
        });
      } else {
        results.push({
          kind: 'handle',
          rawText: token,
          id: inner,
          startIndex,
          endIndex,
        });
      }
    }
  }
  return results;
}

export function resolveOrchestrationLinkTarget(
  token: ParsedOrchestrationLinkToken,
  snapshot: OrchestrationSnapshot,
  sourcePtyId?: string | null,
): ResolvedOrchestrationLinkTarget | null {
  if (token.kind === 'task') {
    const task = snapshot.tasks.find((t) => t.id === token.id);
    if (!task) return null;
    const dispatchesForTask = snapshot.dispatches.filter((d) => d.taskId === task.id);
    const seed = task.latestDispatch ?? dispatchesForTask.at(-1) ?? null;
    const latest = seed
      ? (resolveClientDispatchLineage(snapshot.dispatches, seed.id) ?? seed)
      : null;
    return {
      kind: 'task',
      label: `${token.rawText} (${task.taskTitle || task.status})`,
      ptyId: latest?.assigneePaneId ?? (latest?.assigneeHandle.startsWith('local-') ? latest.assigneeHandle : null),
      dispatchId: latest?.id ?? null,
      taskId: task.id,
      cwd: latest?.worktreePath ?? task.worktreePath ?? null,
      cliId: latest?.cliId ?? null,
    };
  }

  if (token.kind === 'dispatch') {
    const rawDispatch = snapshot.dispatches.find((d) => d.id === token.id);
    if (!rawDispatch) return null;
    const dispatch =
      resolveClientDispatchLineage(snapshot.dispatches, rawDispatch.id) ?? rawDispatch;
    return {
      kind: 'dispatch',
      label: `${token.rawText} (${dispatch.stage ?? dispatch.status})`,
      ptyId:
        dispatch.assigneePaneId ??
        (dispatch.assigneeHandle.startsWith('local-') ? dispatch.assigneeHandle : null),
      dispatchId: dispatch.id,
      taskId: dispatch.taskId,
      cwd: dispatch.worktreePath ?? null,
      cliId: dispatch.cliId ?? null,
    };
  }

  // kind === 'handle'
  if (token.id === 'coordinator') {
    const sourceDispatches = sourcePtyId
      ? snapshot.dispatches.filter(
          (d) => d.assigneePaneId === sourcePtyId || d.assigneeHandle === sourcePtyId,
        )
      : [];
    const sourceDispatch =
      sourceDispatches
        .filter((d) => d.status === 'pending' || d.status === 'dispatched')
        .at(-1) ?? sourceDispatches.at(-1);
    const sourceRunId = sourceDispatch?.runId ??
      (sourcePtyId ? snapshot.currentRunByConsumer?.[sourcePtyId] : undefined);
    const activeRuns = snapshot.runs.filter((r) => r.status === 'active');
    const activeRun = sourceRunId
      ? snapshot.runs.find((r) => r.id === sourceRunId)
      : activeRuns.length === 1 ? activeRuns[0] : undefined;
    if (!activeRun) return null;
    return {
      kind: 'handle',
      label: `@coordinator (${activeRun.id})`,
      ptyId: activeRun.coordinatorPaneId,
      dispatchId: null,
      taskId: null,
      cwd: null,
      cliId: null,
    };
  }

  const rawByAssignee = snapshot.dispatches
    .filter((d) => d.assigneeHandle === token.id || d.assigneePaneId === token.id)
    .at(-1);
  if (rawByAssignee) {
    const byAssignee =
      resolveClientDispatchLineage(snapshot.dispatches, rawByAssignee.id) ?? rawByAssignee;
    return {
      kind: 'handle',
      label: `${token.rawText} (${byAssignee.id})`,
      ptyId: byAssignee.assigneePaneId ?? byAssignee.assigneeHandle,
      dispatchId: byAssignee.id,
      taskId: byAssignee.taskId,
      cwd: byAssignee.worktreePath ?? null,
      cliId: byAssignee.cliId ?? null,
    };
  }

  const byCoord = snapshot.runs.find(
    (r) => r.coordinatorHandle === token.id || r.coordinatorPaneId === token.id,
  );
  if (byCoord) {
    return {
      kind: 'handle',
      label: `${token.rawText} (Coordinator)`,
      ptyId: byCoord.coordinatorPaneId,
      dispatchId: null,
      taskId: null,
      cwd: null,
      cliId: null,
    };
  }

  const normalizedRole = token.id.trim().replace(/^@+/, '').toLowerCase();
  if (normalizedRole) {
    const taskById = new Map(snapshot.tasks.map((t) => [t.id, t]));
    const roleDispatches = snapshot.dispatches.filter((d) => {
      if (d.releasedAt) return false;
      const task = taskById.get(d.taskId);
      const role = task?.displayName?.trim().replace(/^@+/, '').toLowerCase();
      return Boolean(role && role === normalizedRole);
    });
    const seed =
      roleDispatches.filter((d) => d.status === 'pending' || d.status === 'dispatched').at(-1) ??
      roleDispatches.at(-1) ??
      null;
    if (seed) {
      const dispatch =
        resolveClientDispatchLineage(snapshot.dispatches, seed.id) ?? seed;
      const task = taskById.get(dispatch.taskId) ?? taskById.get(seed.taskId);
      const canonicalRole =
        task?.displayName?.trim().replace(/^@+/, '') || token.id.trim().replace(/^@+/, '');
      return {
        kind: 'dispatch',
        label: `@${canonicalRole}`,
        ptyId:
          dispatch.assigneePaneId ??
          (dispatch.assigneeHandle.startsWith('local-') ? dispatch.assigneeHandle : null),
        dispatchId: dispatch.id,
        taskId: task?.id ?? dispatch.taskId,
        cwd: dispatch.worktreePath ?? task?.worktreePath ?? null,
        cliId: dispatch.cliId ?? null,
      };
    }
  }

  return null;
}

export const ORCHESTRATION_FOCUS_EVENT = 'aha:focus-orchestration-target';

export function dispatchFocusOrchestrationTarget(target: ResolvedOrchestrationLinkTarget): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(
    new CustomEvent<ResolvedOrchestrationLinkTarget>(ORCHESTRATION_FOCUS_EVENT, {
      detail: target,
    }),
  );
}
