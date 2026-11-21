// Pure helpers for the Agent session timeline: patch merging, step grouping, and formatting.
import type {
  WorkerTimelineFileChange,
  WorkerTimelineItem,
  WorkerTimelinePatch,
  WorkerTimelineSnapshot,
  WorkerTimelineTurn,
} from '../types';

/** Merges a coalesced patch (full item states) into a snapshot; stale or foreign patches are ignored. */
export function applyWorkerTimelinePatch(
  snapshot: WorkerTimelineSnapshot | null,
  patch: WorkerTimelinePatch,
): WorkerTimelineSnapshot {
  if (snapshot && snapshot.workerHandle !== patch.workerHandle) return snapshot;
  if (snapshot && patch.seq <= snapshot.seq) return snapshot;
  const turns = snapshot ? [...snapshot.turns] : [];
  for (const patchTurn of patch.turns) {
    const index = turns.findIndex((turn) => turn.key === patchTurn.key);
    if (index < 0) {
      turns.push({ ...patchTurn, items: [...patchTurn.items] });
      continue;
    }
    const current = turns[index]!;
    const items = [...current.items];
    for (const item of patchTurn.items) {
      const at = items.findIndex((entry) => entry.id === item.id);
      if (at < 0) items.push(item);
      else items[at] = item;
    }
    const { items: _patchItems, ...header } = patchTurn;
    turns[index] = { ...current, ...header, items };
  }
  turns.sort((a, b) => a.generation - b.generation || a.startedAt - b.startedAt);
  return { ...patch.header, turns };
}

export type TimelineBlock =
  | { type: 'item'; item: WorkerTimelineItem }
  | {
      type: 'group';
      id: string;
      items: WorkerTimelineItem[];
      running: boolean;
      durationMs: number | null;
    };

const EXPLORATION_KINDS = new Set<WorkerTimelineItem['kind']>(['reasoning', 'command', 'tool_call']);

function itemRunning(item: WorkerTimelineItem): boolean {
  if (item.kind === 'approval') return item.status === 'pending';
  return 'status' in item && item.status === 'running';
}

/** Collapses consecutive exploration steps (reasoning, commands, tool calls) into one group. */
export function groupTimelineItems(items: readonly WorkerTimelineItem[]): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let run: WorkerTimelineItem[] = [];
  const flush = () => {
    if (run.length === 1) blocks.push({ type: 'item', item: run[0]! });
    else if (run.length > 1) {
      const starts = run.map((item) => item.startedAt).filter((v): v is number => typeof v === 'number');
      const ends = run.map((item) => item.completedAt).filter((v): v is number => typeof v === 'number');
      const running = run.some(itemRunning);
      blocks.push({
        type: 'group',
        id: `group:${run[0]!.id}`,
        items: run,
        running,
        durationMs: starts.length && ends.length && !running ? Math.max(0, Math.max(...ends) - Math.min(...starts)) : null,
      });
    }
    run = [];
  };
  for (const item of items) {
    if (EXPLORATION_KINDS.has(item.kind)) run.push(item);
    else {
      flush();
      blocks.push({ type: 'item', item });
    }
  }
  flush();
  return blocks;
}

export function formatSeconds(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  return `${(ms / 1000).toFixed(1)}s`;
}

export function groupSummary(block: Extract<TimelineBlock, { type: 'group' }>): string {
  const steps = `已执行 ${block.items.length} 步`;
  if (block.running) return `${steps} · 进行中`;
  return block.durationMs !== null ? `${steps} · 耗时 ${formatSeconds(block.durationMs)}` : steps;
}

export function fileChangeTotals(files: readonly WorkerTimelineFileChange[]): { added: number; removed: number } {
  return files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), {
    added: 0,
    removed: 0,
  });
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return String(count);
}

/** Sums per-turn token usage across the session. */
export function totalTokenUsage(snapshot: WorkerTimelineSnapshot | null): { input: number; output: number; total: number } | null {
  if (!snapshot) return null;
  let input = 0;
  let output = 0;
  let total = 0;
  let seen = false;
  for (const turn of snapshot.turns) {
    if (!turn.usage) continue;
    seen = true;
    input += turn.usage.inputTokens ?? 0;
    output += turn.usage.outputTokens ?? 0;
    total += turn.usage.totalTokens ?? (turn.usage.inputTokens ?? 0) + (turn.usage.outputTokens ?? 0);
  }
  return seen ? { input, output, total } : null;
}

export function activeTimelineTurn(snapshot: WorkerTimelineSnapshot | null): WorkerTimelineTurn | null {
  const last = snapshot?.turns.at(-1);
  return last && last.status === 'running' ? last : null;
}

export function pendingApprovals(snapshot: WorkerTimelineSnapshot | null): Array<Extract<WorkerTimelineItem, { kind: 'approval' }>> {
  if (!snapshot) return [];
  return snapshot.turns.flatMap((turn) =>
    turn.items.filter((item): item is Extract<WorkerTimelineItem, { kind: 'approval' }> =>
      item.kind === 'approval' && item.status === 'pending'),
  );
}

export type DiffLineKind = 'add' | 'del' | 'hunk' | 'meta' | 'ctx';

export function classifyDiffLines(diff: string): Array<{ kind: DiffLineKind; text: string }> {
  return diff.split('\n').map((text) => {
    if (text.startsWith('@@')) return { kind: 'hunk', text };
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff --git') || text.startsWith('index ')) {
      return { kind: 'meta', text };
    }
    if (text.startsWith('+')) return { kind: 'add', text };
    if (text.startsWith('-')) return { kind: 'del', text };
    return { kind: 'ctx', text };
  });
}

/** Whether the scroll position counts as "at the bottom" for stick-to-bottom behavior. */
export function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, threshold = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
