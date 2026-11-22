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

/** True while some step of the turn is visibly in progress, so no separate "working" line is needed. */
export function turnHasLiveItem(turn: Pick<WorkerTimelineTurn, 'items'>): boolean {
  return turn.items.some(itemRunning);
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

/** Compact duration for row trailers and live timers: 1.2s, 42s, 3m 05s, 1h 02m. */
export function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const clamped = Math.max(0, ms);
  if (clamped < 10_000) return `${(clamped / 1000).toFixed(1)}s`;
  const seconds = Math.floor(clamped / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

/** Whole-second elapsed time for a ticking timer, so the text only changes once per second. */
export function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return formatDuration(seconds * 1000);
}

export interface DispatchPromptParts {
  /** The task text a person would recognize as "what was asked". */
  body: string;
  /** Orchestration header and protocol lines wrapped around the body; null for plain prompts. */
  system: string | null;
  followUp: boolean;
}

const PREAMBLE_HEAD_RE = /^\[(?:Worker|ORCHESTRATION)\b[^\]]*\]\s*$/;
const PREAMBLE_META_RE = /^(?:Workspace|Branch|Full Brief File): |^Read full context file first\.$/;
// Matched against the exact protocol lines, so a task that merely starts a bullet the same way stays whole.
const PREAMBLE_TAIL_RE =
  /^(?:- Need clarification or blocked\? Call MCP tool |- When finished or blocked, call MCP tool |- Sub-tasks permitted: use MCP tools |Use MCP ask_coordinator or report_done\.$|Dispatch Capability: |Use \S+ orchestration worker-done with --capability )/;
const SPEC_OPEN_RE = /^=== (?:TASK SPECIFICATION|FOLLOW-UP INSTRUCTIONS) ===$/;
const SPEC_CLOSE_RE = /^=== END (?:TASK SPECIFICATION|FOLLOW-UP INSTRUCTIONS) ===$/;

/**
 * Separates a dispatch prompt into the task itself and the orchestration wrapper built by
 * electron/orchestration/worker-dispatch-preamble.ts. Anything unrecognized stays in the body.
 */
export function splitDispatchPrompt(prompt: string): DispatchPromptParts {
  const text = prompt.replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const plain: DispatchPromptParts = { body: text.trim(), system: null, followUp: false };
  if (!PREAMBLE_HEAD_RE.test(lines[0] ?? '')) return plain;
  const followUp = /follow-up/i.test(lines[0]!);
  const joinSystem = (parts: string[]) => parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const open = lines.findIndex((line) => SPEC_OPEN_RE.test(line));
  if (open >= 0) {
    let close = lines.length - 1;
    while (close > open && !SPEC_CLOSE_RE.test(lines[close]!)) close -= 1;
    const body = close > open ? lines.slice(open + 1, close).join('\n').trim() : '';
    if (!body) return plain;
    return { body, system: joinSystem([...lines.slice(0, open), '', ...lines.slice(close + 1)]), followUp };
  }

  let start = 1;
  while (start < lines.length && PREAMBLE_META_RE.test(lines[start]!)) start += 1;
  let end = lines.length;
  while (end > start && (!lines[end - 1]!.trim() || PREAMBLE_TAIL_RE.test(lines[end - 1]!))) end -= 1;
  const body = lines.slice(start, end).join('\n').trim();
  if (!body) return plain;
  return { body, system: joinSystem([...lines.slice(0, start), '', ...lines.slice(end)]), followUp };
}

const SHELL_NAMES = new Set(['bash', 'zsh', 'sh', 'dash', 'pwsh', 'powershell']);

/** Shows `bash -lc "npm test"` as `npm test`; commands that are not a shell wrapper are returned as is. */
export function unwrapShellCommand(command: string): string {
  const trimmed = command.trim();
  const match = /^("[^"]+"|\S+)\s+(?:-[\w-]+\s+)*?-(?:c|lc|command)\s+([\s\S]+)$/i.exec(trimmed);
  if (!match) return trimmed;
  const exe = match[1]!.replace(/^"|"$/g, '').split(/[\\/]/).pop()!.toLowerCase().replace(/\.exe$/, '');
  if (!SHELL_NAMES.has(exe)) return trimmed;
  let inner = match[2]!.trim();
  const quote = inner[0];
  if ((quote === '"' || quote === "'") && inner.length > 1 && inner.endsWith(quote)) {
    inner = inner.slice(1, -1);
    // Inside double quotes the shell reads \" \\ \$ \` as the bare character.
    if (quote === '"') inner = inner.replace(/\\(["\\$`])/g, '$1');
  }
  return inner.trim() || trimmed;
}

/** The step a running group is currently on, used for its live header label. */
export function liveGroupItem(block: Extract<TimelineBlock, { type: 'group' }>): WorkerTimelineItem {
  for (let i = block.items.length - 1; i >= 0; i -= 1) {
    if (itemRunning(block.items[i]!)) return block.items[i]!;
  }
  return block.items[block.items.length - 1]!;
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

const PLAIN_FENCES = new Set(['text', 'txt', 'plain', 'plaintext', 'console', 'output']);

/** Language id from a fence info string (` ```ts title=x `), or null when there is nothing to highlight. */
export function fenceLanguage(info: string | null | undefined): string | null {
  const lang = info?.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!/^[a-z0-9+#._-]{1,32}$/.test(lang)) return null;
  return PLAIN_FENCES.has(lang) ? null : lang;
}

/** Splits a multi-file `git diff` into one unified diff per file; headerless input stays whole. */
export function splitDiffByFile(diff: string): Array<{ path: string; diff: string }> {
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  const files: Array<{ path: string; lines: string[] }> = [];
  for (const line of lines) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header || files.length === 0) files.push({ path: header?.[2] ?? '', lines: [] });
    const current = files.at(-1)!;
    const renamed = /^\+\+\+ b\/(.+)$/.exec(line);
    if (renamed && current.lines.every((prev) => !prev.startsWith('@@'))) current.path = renamed[1]!;
    current.lines.push(line);
  }
  return files
    .map((file) => ({ path: file.path, diff: file.lines.join('\n') }))
    .filter((file) => file.diff.trim());
}

/** Whether the scroll position counts as "at the bottom" for stick-to-bottom behavior. */
export function isNearBottom(el: { scrollTop: number; scrollHeight: number; clientHeight: number }, threshold = 48): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= threshold;
}
