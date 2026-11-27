// Protocol-agnostic process timeline for headless Workers.
// Providers translate their wire events into WorkerTimelineEvent; this module owns
// state, redaction, size caps, patches, and archival trimming.

import type { AgentSessionPolicy } from './agent-session-driver.js';

export type WorkerTimelineTurnStatus = 'running' | 'completed' | 'interrupted' | 'failed';
export type WorkerTimelineItemStatus = 'running' | 'completed' | 'failed' | 'declined';
export type WorkerTimelineApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

interface ItemBase {
  id: string;
  startedAt: number | null;
  completedAt: number | null;
}

export interface WorkerTimelineReasoningItem extends ItemBase {
  kind: 'reasoning';
  status: WorkerTimelineItemStatus;
  summary: string;
  text: string;
}

export interface WorkerTimelinePlanStep {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface WorkerTimelinePlanItem extends ItemBase {
  kind: 'plan';
  status: WorkerTimelineItemStatus;
  explanation: string | null;
  steps: WorkerTimelinePlanStep[];
  text: string;
}

export interface WorkerTimelineCommandItem extends ItemBase {
  kind: 'command';
  status: WorkerTimelineItemStatus;
  command: string;
  cwd: string | null;
  output: string;
  outputTruncated: boolean;
  exitCode: number | null;
  durationMs: number | null;
}

export interface WorkerTimelineFileChange {
  path: string;
  change: 'add' | 'delete' | 'update';
  movePath: string | null;
  diff: string;
  added: number;
  removed: number;
  truncated: boolean;
}

export interface WorkerTimelineFileChangeItem extends ItemBase {
  kind: 'file_change';
  status: WorkerTimelineItemStatus;
  files: WorkerTimelineFileChange[];
}

export interface WorkerTimelineToolCallItem extends ItemBase {
  kind: 'tool_call';
  status: WorkerTimelineItemStatus;
  toolType: 'mcp' | 'search' | 'tool';
  server: string | null;
  tool: string;
  args: string;
  progress: string | null;
  output: string;
  error: string | null;
  durationMs: number | null;
}

export interface WorkerTimelineApprovalItem extends ItemBase {
  kind: 'approval';
  approvalId: string;
  method: string;
  tool: string;
  input: string;
  reason: string | null;
  status: WorkerTimelineApprovalStatus;
  resolution: string | null;
}

export interface WorkerTimelineMessageItem extends ItemBase {
  kind: 'message';
  status: WorkerTimelineItemStatus;
  role: 'assistant' | 'user';
  text: string;
}

export interface WorkerTimelineNoticeItem extends ItemBase {
  kind: 'notice';
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface WorkerTimelineSettlementItem extends ItemBase {
  kind: 'settlement';
  settlement: 'turn_pending_confirmation' | 'report_done';
  stopReason: string | null;
  outcome: string | null;
  verdict: string | null;
  findings: string[];
  summary: string;
  diff: string | null;
  diffSource: 'provider' | 'git' | null;
}

export type WorkerTimelineItem =
  | WorkerTimelineReasoningItem
  | WorkerTimelinePlanItem
  | WorkerTimelineCommandItem
  | WorkerTimelineFileChangeItem
  | WorkerTimelineToolCallItem
  | WorkerTimelineApprovalItem
  | WorkerTimelineMessageItem
  | WorkerTimelineNoticeItem
  | WorkerTimelineSettlementItem;

export type WorkerTimelineItemKind = WorkerTimelineItem['kind'];

export interface WorkerTimelineAttachment {
  kind: 'skill' | 'image' | 'file';
  name: string;
}

export interface WorkerTimelineTurn {
  /** Unique per timeline; a dispatch can own several turns (mailbox wake-ups). */
  key: string;
  dispatchId: string;
  turnId: string | null;
  generation: number;
  prompt: string;
  /** `system`: AhaStation started the turn (a wake-up), not the person or a dispatch brief. */
  origin?: 'system';
  /** True when `/clear` started a fresh provider thread before this turn while keeping prior history visible. */
  freshContext?: boolean;
  /** Marks control turns initiated by slash commands (`/compact`, `/goal`). */
  commandKind?: 'compact' | 'goal';
  /** Skills and images sent with the prompt, by name. */
  attachments?: WorkerTimelineAttachment[];
  startedAt: number;
  completedAt: number | null;
  status: WorkerTimelineTurnStatus;
  stopReason: string | null;
  usage: Record<string, number> | null;
  error: string | null;
  itemsTrimmed?: boolean;
  items: WorkerTimelineItem[];
}

export interface WorkerTimelineSnapshot {
  workerHandle: string;
  providerSessionId: string | null;
  cliId: string;
  model: string | null;
  readOnly: boolean;
  /** Absent on timelines saved before per-Worker controls: `readOnly` decides, with network off. */
  policy?: AgentSessionPolicy;
  network?: boolean;
  alive: boolean;
  seq: number;
  turns: WorkerTimelineTurn[];
}

export type WorkerTimelineHeader = Omit<WorkerTimelineSnapshot, 'turns'>;
export type WorkerTimelineTurnHeader = Omit<WorkerTimelineTurn, 'items'>;

export interface WorkerTimelinePatch {
  workerHandle: string;
  seq: number;
  header: WorkerTimelineHeader;
  turns: Array<WorkerTimelineTurnHeader & { items: WorkerTimelineItem[] }>;
}

type DistributivePartial<T> = T extends unknown ? Partial<T> : never;
export type WorkerTimelineItemUpdate = DistributivePartial<WorkerTimelineItem> & {
  id: string;
  kind: WorkerTimelineItemKind;
};

export type WorkerTimelineEvent =
  | { type: 'turn_started'; turnId: string; startedAt?: number }
  | { type: 'usage'; usage: Record<string, number> }
  | { type: 'item'; item: WorkerTimelineItemUpdate }
  | {
      type: 'delta';
      id: string;
      kind: 'message' | 'reasoning' | 'command' | 'plan' | 'tool_call';
      field: 'text' | 'summary' | 'output' | 'progress';
      delta: string;
    }
  | { type: 'notice'; id?: string; level: 'info' | 'warning' | 'error'; text: string };

export const TIMELINE_LIMITS = {
  output: 64 * 1024,
  text: 64 * 1024,
  diff: 64 * 1024,
  args: 4 * 1024,
  prompt: 16 * 1024,
  liveBytes: 2 * 1024 * 1024,
  archiveBytes: 256 * 1024,
  maxTurns: 200,
  maxItemsPerTurn: 2_000,
};

const TRUNCATED_HEAD = '…[truncated]\n';
const TRUNCATED_TAIL = '\n…[truncated]';

/** Keeps the end of streamed output, where the latest lines live. */
export function capTail(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  return { text: TRUNCATED_HEAD + text.slice(text.length - limit), truncated: true };
}

export function capHead(text: string, limit: number): string {
  return text.length <= limit ? text : text.slice(0, limit) + TRUNCATED_TAIL;
}

export function diffLineStats(diff: string, change?: 'add' | 'delete' | 'update'): { added: number; removed: number } {
  if (!diff) return { added: 0, removed: 0 };
  const lines = diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!/^(@@|diff --git|--- |\+\+\+ )/m.test(diff)) {
    if (change === 'add') return { added: lines.length, removed: 0 };
    if (change === 'delete') return { added: 0, removed: lines.length };
  }
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+')) added += 1;
    else if (line.startsWith('-')) removed += 1;
  }
  return { added, removed };
}

function cloneItem<T extends WorkerTimelineItem>(item: T): T {
  return structuredClone(item);
}

function itemBytes(item: WorkerTimelineItem): number {
  return Buffer.byteLength(JSON.stringify(item));
}

const BULKY_LIMIT = 2 * 1024;

function shrinkItem(item: WorkerTimelineItem): WorkerTimelineItem {
  const next = cloneItem(item);
  switch (next.kind) {
    case 'command': {
      const capped = capTail(next.output, BULKY_LIMIT);
      next.output = capped.text;
      next.outputTruncated ||= capped.truncated;
      break;
    }
    case 'file_change':
      next.files = next.files.map((file) => file.diff.length > BULKY_LIMIT
        ? { ...file, diff: capHead(file.diff, BULKY_LIMIT), truncated: true }
        : file);
      break;
    case 'tool_call':
      next.output = capHead(next.output, BULKY_LIMIT);
      next.args = capHead(next.args, BULKY_LIMIT);
      break;
    case 'reasoning':
      next.text = capHead(next.text, BULKY_LIMIT);
      next.summary = capHead(next.summary, BULKY_LIMIT);
      break;
    case 'message':
    case 'notice':
      next.text = capHead(next.text, BULKY_LIMIT * 4);
      break;
    case 'plan':
      next.text = capHead(next.text, BULKY_LIMIT);
      break;
    case 'settlement':
      if (next.diff) next.diff = capHead(next.diff, BULKY_LIMIT * 4);
      next.summary = capHead(next.summary, BULKY_LIMIT * 4);
      break;
    case 'approval':
      next.input = capHead(next.input, BULKY_LIMIT);
      break;
  }
  return next;
}

/**
 * Returns a copy of the snapshot that serializes within maxBytes. Older turns lose bulky
 * fields first, then their items, so the most recent activity survives intact.
 */
export function trimTimelineSnapshot(snapshot: WorkerTimelineSnapshot, maxBytes: number): WorkerTimelineSnapshot {
  const copy: WorkerTimelineSnapshot = structuredClone(snapshot);
  let size = Buffer.byteLength(JSON.stringify(copy));
  if (size <= maxBytes) return copy;
  for (const turn of copy.turns) {
    turn.prompt = capHead(turn.prompt, BULKY_LIMIT);
  }
  size = Buffer.byteLength(JSON.stringify(copy));
  // Pass 1: shrink bulky fields, oldest first.
  for (const turn of copy.turns) {
    if (size <= maxBytes) break;
    for (let i = 0; i < turn.items.length && size > maxBytes; i += 1) {
      const before = itemBytes(turn.items[i]!);
      const shrunk = shrinkItem(turn.items[i]!);
      const after = itemBytes(shrunk);
      if (after < before) {
        turn.items[i] = shrunk;
        turn.itemsTrimmed = true;
        size -= before - after;
      }
    }
  }
  // Pass 2: drop whole items from the oldest turns, never the newest turn's settlement.
  for (let t = 0; t < copy.turns.length && size > maxBytes; t += 1) {
    const turn = copy.turns[t]!;
    const newest = t === copy.turns.length - 1;
    while (turn.items.length > 0 && size > maxBytes) {
      const index = newest ? turn.items.findIndex((item) => item.kind !== 'settlement') : 0;
      if (index < 0) break;
      const [removed] = turn.items.splice(index, 1);
      size -= itemBytes(removed!) + 1;
      turn.itemsTrimmed = true;
    }
  }
  // Pass 3: drop the oldest turn headers.
  while (copy.turns.length > 1 && Buffer.byteLength(JSON.stringify(copy)) > maxBytes) {
    copy.turns.shift();
  }
  return copy;
}

/** Applies a string transform to every string in a timeline snapshot (used for re-redaction). */
export function mapTimelineStrings<T>(value: T, fn: (text: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((entry) => mapTimelineStrings(entry, fn)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, mapTimelineStrings(entry, fn)])) as T;
  }
  return value;
}

const STRING_FIELDS = new Set([
  'summary', 'text', 'command', 'cwd', 'output', 'args', 'progress', 'error', 'input', 'reason',
  'resolution', 'explanation', 'stopReason', 'diff', 'tool', 'server', 'method',
]);

function defaultItem(id: string, kind: WorkerTimelineItemKind, now: number): WorkerTimelineItem {
  const base = { id, startedAt: now, completedAt: null };
  switch (kind) {
    case 'reasoning': return { ...base, kind, status: 'running', summary: '', text: '' };
    case 'plan': return { ...base, kind, status: 'running', explanation: null, steps: [], text: '' };
    case 'command': return {
      ...base, kind, status: 'running', command: '', cwd: null, output: '', outputTruncated: false,
      exitCode: null, durationMs: null,
    };
    case 'file_change': return { ...base, kind, status: 'running', files: [] };
    case 'tool_call': return {
      ...base, kind, status: 'running', toolType: 'tool', server: null, tool: '', args: '', progress: null,
      output: '', error: null, durationMs: null,
    };
    case 'approval': return {
      ...base, kind, approvalId: id, method: '', tool: '', input: '', reason: null, status: 'pending', resolution: null,
    };
    case 'message': return { ...base, kind, status: 'running', role: 'assistant', text: '' };
    case 'notice': return { ...base, kind, level: 'info', text: '' };
    case 'settlement': return {
      ...base, kind, settlement: 'turn_pending_confirmation', stopReason: null, outcome: null, verdict: null,
      findings: [], summary: '', diff: null, diffSource: null,
    };
  }
}

export interface WorkerTimelineOptions {
  workerHandle: string;
  cliId: string;
  model: string | null;
  readOnly: boolean;
  policy?: AgentSessionPolicy;
  network?: boolean;
  redact?: (text: string) => string;
  now?: () => number;
  onPatch?: (patch: WorkerTimelineChange) => void;
  /** Earlier turns to continue from, e.g. a session saved before the app restarted. */
  initial?: WorkerTimelineSnapshot;
}

/** One mutation's effect; item and turn are live references, cloned when a patch is flushed. */
export interface WorkerTimelineChange {
  timeline: WorkerTimeline;
  turn: WorkerTimelineTurn | null;
  item: WorkerTimelineItem | null;
}

export class WorkerTimeline {
  private readonly header: WorkerTimelineHeader;
  private readonly turns: WorkerTimelineTurn[] = [];
  private readonly redact: (text: string) => string;
  private readonly now: () => number;
  private readonly onPatch?: (change: WorkerTimelineChange) => void;
  private generation = 0;
  private noticeSeq = 0;

  constructor(options: WorkerTimelineOptions) {
    this.header = {
      workerHandle: options.workerHandle,
      providerSessionId: null,
      cliId: options.cliId,
      model: options.model,
      readOnly: options.readOnly,
      ...(options.policy !== undefined ? { policy: options.policy } : {}),
      ...(options.network !== undefined ? { network: options.network } : {}),
      alive: true,
      seq: 0,
    };
    this.redact = options.redact ?? ((text) => text);
    this.now = options.now ?? Date.now;
    this.onPatch = options.onPatch;
    if (options.initial) this.restore(options.initial);
  }

  private restore(initial: WorkerTimelineSnapshot): void {
    this.header.providerSessionId = initial.providerSessionId;
    if (initial.policy !== undefined && this.header.policy === undefined) this.header.policy = initial.policy;
    if (initial.network !== undefined && this.header.network === undefined) this.header.network = initial.network;
    for (const turn of structuredClone(initial.turns)) {
      // A turn still running when the snapshot was taken can never finish now.
      if (turn.status === 'running') {
        turn.status = 'interrupted';
        turn.stopReason = 'interrupted';
        turn.completedAt ??= turn.startedAt;
        for (const item of turn.items) {
          if ('status' in item && item.status === 'running') item.status = 'failed';
        }
      }
      this.turns.push(turn);
      this.generation = Math.max(this.generation, turn.generation);
    }
  }

  get workerHandle(): string { return this.header.workerHandle; }
  get activeTurn(): WorkerTimelineTurn | null {
    const last = this.turns.at(-1);
    return last && last.status === 'running' ? last : null;
  }

  getHeader(): WorkerTimelineHeader { return { ...this.header }; }

  hasDispatch(dispatchId: string): boolean {
    return this.turns.some((turn) => turn.dispatchId === dispatchId);
  }

  setMeta(
    meta: Partial<Pick<WorkerTimelineHeader, 'alive' | 'providerSessionId' | 'model' | 'readOnly' | 'policy' | 'network'>>,
  ): void {
    Object.assign(this.header, meta);
    if (meta.policy !== undefined) this.header.readOnly = meta.policy === 'read-only';
    this.changed(null, null);
  }

  beginTurn(input: {
    dispatchId: string; prompt: string; startedAt?: number; origin?: 'system';
    freshContext?: boolean; commandKind?: 'compact' | 'goal';
    attachments?: readonly WorkerTimelineAttachment[];
  }): WorkerTimelineTurn {
    const running = this.activeTurn;
    if (running) this.finishTurn(running, { status: 'interrupted', stopReason: 'superseded' });
    this.generation += 1;
    const turn: WorkerTimelineTurn = {
      key: `${input.dispatchId}#${this.generation}`,
      dispatchId: input.dispatchId,
      turnId: null,
      generation: this.generation,
      prompt: capHead(this.redact(input.prompt), TIMELINE_LIMITS.prompt),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.freshContext ? { freshContext: true } : {}),
      ...(input.commandKind ? { commandKind: input.commandKind } : {}),
      ...(input.attachments?.length
        ? { attachments: input.attachments.map((item) => ({ kind: item.kind, name: capHead(this.redact(item.name), 200) })) }
        : {}),
      startedAt: input.startedAt ?? this.now(),
      completedAt: null,
      status: 'running',
      stopReason: null,
      usage: null,
      error: null,
      items: [],
    };
    this.turns.push(turn);
    while (this.turns.length > TIMELINE_LIMITS.maxTurns) this.turns.shift();
    this.changed(turn, null);
    return turn;
  }

  apply(event: WorkerTimelineEvent): void {
    const turn = this.activeTurn;
    if (!turn) return;
    switch (event.type) {
      case 'turn_started':
        if (!turn.turnId) {
          turn.turnId = event.turnId;
          this.changed(turn, null);
        }
        return;
      case 'usage':
        turn.usage = { ...event.usage };
        this.changed(turn, null);
        return;
      case 'item':
        this.upsertItem(turn, event.item);
        return;
      case 'delta':
        this.appendDelta(turn, event);
        return;
      case 'notice': {
        const id = event.id ?? `notice-${++this.noticeSeq}`;
        this.upsertItem(turn, { id, kind: 'notice', level: event.level, text: event.text, completedAt: this.now() });
        return;
      }
    }
  }

  completeTurn(input: {
    turnId?: string | null;
    status: WorkerTimelineTurnStatus;
    stopReason?: string | null;
    usage?: Record<string, number> | null;
    error?: string | null;
  }): void {
    const turn = this.activeTurn;
    if (!turn) return;
    if (input.turnId && turn.turnId && input.turnId !== turn.turnId) return;
    this.finishTurn(turn, input);
  }

  /** Ends the running turn after a transport loss or stop, without a provider completion event. */
  endActiveTurn(status: 'interrupted' | 'failed', reason: string): void {
    const turn = this.activeTurn;
    if (turn) this.finishTurn(turn, { status, stopReason: status, error: reason });
  }

  upsertApproval(input: {
    approvalId: string;
    dispatchId: string;
    method: string;
    tool: string;
    input?: string;
    reason?: string | null;
    status: WorkerTimelineApprovalStatus;
    resolution?: string | null;
  }): void {
    const id = `approval:${input.approvalId}`;
    const existing = this.findItem(id);
    const turn = existing?.turn ?? this.turnForDispatch(input.dispatchId);
    if (!turn) return;
    this.upsertItem(turn, {
      id, kind: 'approval', approvalId: input.approvalId, method: input.method, tool: input.tool,
      input: input.input ?? '', reason: input.reason ?? null, status: input.status,
      resolution: input.resolution ?? null,
      ...(input.status !== 'pending' ? { completedAt: this.now() } : {}),
    });
  }

  addSettlement(dispatchId: string, settlement: Omit<WorkerTimelineSettlementItem, 'id' | 'kind' | 'startedAt' | 'completedAt'>): void {
    const turn = this.turnForDispatch(dispatchId);
    if (!turn) return;
    const now = this.now();
    this.upsertItem(turn, {
      id: `settlement:${turn.key}:${settlement.settlement}`, kind: 'settlement', ...settlement,
      startedAt: now, completedAt: now,
    });
  }

  snapshot(maxBytes = TIMELINE_LIMITS.liveBytes): WorkerTimelineSnapshot {
    return trimTimelineSnapshot({ ...this.header, turns: this.turns }, maxBytes);
  }

  archive(maxBytes = TIMELINE_LIMITS.archiveBytes): WorkerTimelineSnapshot {
    return trimTimelineSnapshot({ ...this.header, turns: this.turns }, maxBytes);
  }

  private turnForDispatch(dispatchId: string): WorkerTimelineTurn | null {
    for (let i = this.turns.length - 1; i >= 0; i -= 1) {
      if (this.turns[i]!.dispatchId === dispatchId) return this.turns[i]!;
    }
    return null;
  }

  private findItem(id: string): { turn: WorkerTimelineTurn; item: WorkerTimelineItem } | null {
    for (let t = this.turns.length - 1; t >= 0; t -= 1) {
      const turn = this.turns[t]!;
      const item = turn.items.find((entry) => entry.id === id);
      if (item) return { turn, item };
    }
    return null;
  }

  private findInTurn(turn: WorkerTimelineTurn, id: string): { turn: WorkerTimelineTurn; item: WorkerTimelineItem } | null {
    const item = turn.items.find((entry) => entry.id === id);
    return item ? { turn, item } : null;
  }

  private finishTurn(turn: WorkerTimelineTurn, input: {
    turnId?: string | null;
    status: WorkerTimelineTurnStatus;
    stopReason?: string | null;
    usage?: Record<string, number> | null;
    error?: string | null;
  }): void {
    if (turn.status !== 'running') return;
    turn.status = input.status;
    turn.turnId ??= input.turnId ?? null;
    turn.stopReason = input.stopReason ?? input.status;
    if (input.usage) turn.usage = { ...input.usage };
    turn.error = input.error ? capHead(this.redact(input.error), TIMELINE_LIMITS.text) : null;
    turn.completedAt = this.now();
    for (const item of turn.items) {
      if ('status' in item && item.status === 'running') {
        item.status = input.status === 'completed' ? 'completed' : 'failed';
        item.completedAt ??= turn.completedAt;
        this.changed(turn, item);
      }
    }
    this.changed(turn, null);
  }

  // Provider item ids are only trusted to be unique within one turn, so lookups stay turn-scoped.
  private upsertItem(turn: WorkerTimelineTurn, update: WorkerTimelineItemUpdate): void {
    let found = this.findInTurn(turn, update.id);
    if (!found) {
      if (turn.items.length >= TIMELINE_LIMITS.maxItemsPerTurn) {
        turn.items.shift();
        turn.itemsTrimmed = true;
      }
      const created = defaultItem(update.id, update.kind, this.now());
      turn.items.push(created);
      found = { turn, item: created };
    }
    const { item } = found;
    if (item.kind !== update.kind) return;
    for (const [key, raw] of Object.entries(update)) {
      if (key === 'id' || key === 'kind' || raw === undefined) continue;
      let value: unknown = raw;
      if (typeof value === 'string' && STRING_FIELDS.has(key)) value = this.redact(value);
      (item as unknown as Record<string, unknown>)[key] = value;
    }
    this.normalize(item);
    this.changed(found.turn, item);
  }

  private appendDelta(turn: WorkerTimelineTurn, event: Extract<WorkerTimelineEvent, { type: 'delta' }>): void {
    if (!event.delta) return;
    let found = this.findInTurn(turn, event.id);
    if (!found) {
      this.upsertItem(turn, { id: event.id, kind: event.kind } as WorkerTimelineItemUpdate);
      found = this.findInTurn(turn, event.id);
      if (!found) return;
    }
    const record = found.item as unknown as Record<string, unknown>;
    const current = typeof record[event.field] === 'string' ? record[event.field] as string : '';
    // Redact the joined text: a secret can straddle two streamed fragments.
    record[event.field] = this.redact(current + event.delta);
    this.normalize(found.item);
    this.changed(found.turn, found.item);
  }

  /** Re-applies caps after a mutation; redaction runs on each fragment before it is stored. */
  private normalize(item: WorkerTimelineItem): void {
    switch (item.kind) {
      case 'command': {
        const capped = capTail(item.output, TIMELINE_LIMITS.output);
        item.output = capped.text;
        item.outputTruncated ||= capped.truncated;
        item.command = capHead(item.command, TIMELINE_LIMITS.args);
        break;
      }
      case 'file_change':
        item.files = item.files.map((file) => {
          const raw = this.redact(file.diff ?? '');
          const stats = diffLineStats(raw, file.change);
          const diff = capHead(raw, TIMELINE_LIMITS.diff);
          return {
            ...file, path: this.redact(file.path), movePath: file.movePath ? this.redact(file.movePath) : null,
            diff, truncated: file.truncated || diff.length !== raw.length,
            added: file.added || stats.added, removed: file.removed || stats.removed,
          };
        });
        break;
      case 'tool_call':
        item.args = capHead(item.args, TIMELINE_LIMITS.args);
        item.output = capHead(item.output, TIMELINE_LIMITS.output);
        if (item.progress) item.progress = capHead(item.progress, TIMELINE_LIMITS.args);
        break;
      case 'reasoning':
        item.text = capHead(item.text, TIMELINE_LIMITS.text);
        item.summary = capHead(item.summary, TIMELINE_LIMITS.text);
        break;
      case 'message':
      case 'notice':
        item.text = capHead(item.text, TIMELINE_LIMITS.text);
        break;
      case 'plan':
        item.text = capHead(item.text, TIMELINE_LIMITS.text);
        item.steps = item.steps.slice(0, 100).map((step) => ({ ...step, step: capHead(this.redact(step.step), 1_000) }));
        break;
      case 'settlement':
        item.diff = item.diff === null ? null : capHead(item.diff, TIMELINE_LIMITS.diff);
        item.summary = capHead(item.summary, TIMELINE_LIMITS.text);
        item.findings = item.findings.slice(0, 50).map((finding) => capHead(this.redact(finding), 2_000));
        break;
      case 'approval':
        item.input = capHead(item.input, TIMELINE_LIMITS.args);
        break;
    }
  }

  private changed(turn: WorkerTimelineTurn | null, item: WorkerTimelineItem | null): void {
    this.header.seq += 1;
    this.onPatch?.({ timeline: this, turn, item });
  }
}

/**
 * Merges per-mutation changes per worker and flushes one patch per worker at most every
 * intervalMs, so streamed deltas do not flood the renderer.
 */
export class WorkerTimelinePatchCoalescer {
  private readonly pending = new Map<string, {
    timeline: WorkerTimeline;
    turns: Map<string, { turn: WorkerTimelineTurn; items: Map<string, WorkerTimelineItem> }>;
  }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;

  constructor(
    private readonly send: (patch: WorkerTimelinePatch) => void,
    private readonly intervalMs = 40,
  ) {}

  push(change: WorkerTimelineChange): void {
    if (this.disposed) return;
    let entry = this.pending.get(change.timeline.workerHandle);
    if (!entry) {
      entry = { timeline: change.timeline, turns: new Map() };
      this.pending.set(change.timeline.workerHandle, entry);
    }
    if (change.turn) {
      let turnEntry = entry.turns.get(change.turn.key);
      if (!turnEntry) {
        turnEntry = { turn: change.turn, items: new Map() };
        entry.turns.set(change.turn.key, turnEntry);
      }
      if (change.item) turnEntry.items.set(change.item.id, change.item);
    }
    this.timer ??= setTimeout(() => this.flush(), this.intervalMs);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const batches = [...this.pending.values()];
    this.pending.clear();
    for (const { timeline, turns } of batches) {
      const header = timeline.getHeader();
      const patch: WorkerTimelinePatch = {
        workerHandle: header.workerHandle,
        seq: header.seq,
        header,
        turns: [...turns.values()].map(({ turn, items }) => {
          const { items: _all, ...turnHeader } = turn;
          return { ...structuredClone(turnHeader), items: [...items.values()].map((item) => structuredClone(item)) };
        }),
      };
      try {
        this.send(patch);
      } catch (error) {
        console.warn('[orchestration] worker timeline patch failed:', error);
      }
    }
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}
