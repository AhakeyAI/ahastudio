import { codexItemUpdate } from './codex-app-server-pilot.js';
import { SESSION_WAKE_HEADER } from './coordinator-prompt.js';
import {
  WorkerTimeline,
  type WorkerTimelineAttachment,
  type WorkerTimelineSnapshot,
  type WorkerTimelineTurnStatus,
} from './worker-timeline.js';

/** One past Codex conversation, as the history panel lists it. Times are epoch milliseconds. */
export interface CodexThreadSummary {
  id: string;
  title: string;
  preview: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  model: string | null;
  effort: string | null;
}

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => (value && typeof value === 'object' ? value as Obj : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const seconds = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value * 1000 : null);
const millis = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

// Every Worker brief starts with this header (see the dispatch prompt), and AhaStation starts all
// Worker threads, so this is how a Worker conversation is told apart from one a person had.
const WORKER_BRIEF = /^\s*\[Worker @/u;
const firstLine = (value: string) => value.split(/\r?\n/u).map((line) => line.trim()).find(Boolean) ?? '';

/**
 * A Codex thread worth offering in the history: not a Worker brief, a sub-agent, or a temporary
 * conversation. Null for anything else.
 */
export function codexThreadSummary(raw: unknown): CodexThreadSummary | null {
  const thread = object(raw);
  const id = text(thread.id);
  const cwd = text(thread.cwd);
  if (!id || !cwd || thread.ephemeral === true || thread.parentThreadId) return null;
  if ('subagent' in object(thread.source)) return null;
  const preview = text(thread.preview);
  if (WORKER_BRIEF.test(preview) || WORKER_BRIEF.test(text(thread.name))) return null;
  const createdAt = seconds(thread.createdAt) ?? 0;
  return {
    id,
    title: (textOrNull(thread.name) ?? firstLine(preview).slice(0, 80)) || '未命名会话',
    preview: firstLine(preview).slice(0, 160),
    cwd,
    createdAt,
    updatedAt: seconds(thread.recencyAt) ?? seconds(thread.updatedAt) ?? createdAt,
    model: textOrNull(thread.model),
    effort: textOrNull(thread.reasoningEffort),
  };
}

const TURN_STATUS: Record<string, WorkerTimelineTurnStatus> = {
  completed: 'completed', interrupted: 'interrupted', failed: 'failed',
};

function userInput(content: unknown): { prompt: string; attachments: WorkerTimelineAttachment[] } {
  const parts: string[] = [];
  const attachments: WorkerTimelineAttachment[] = [];
  for (const entry of array(content).map(object)) {
    if (entry.type === 'text' && text(entry.text)) parts.push(text(entry.text));
    else if (entry.type === 'skill' && text(entry.name)) attachments.push({ kind: 'skill', name: text(entry.name) });
    else if (entry.type === 'localImage' || entry.type === 'image') {
      attachments.push({ kind: 'image', name: text(entry.path).split(/[\\/]/u).pop() || '图片' });
    } else if (entry.type === 'mention' && text(entry.name)) attachments.push({ kind: 'file', name: text(entry.name) });
  }
  return { prompt: parts.join('\n'), attachments };
}

/**
 * Replays a stored Codex thread (`thread/read` with turns) into a session timeline, so a reopened
 * conversation shows what happened before. Everything in it is finished; nothing is live.
 */
export function codexThreadTimeline(
  sessionId: string, thread: unknown, options: { model: string | null; readOnly: boolean; redact?: (text: string) => string },
): WorkerTimelineSnapshot {
  let clock = 0;
  const timeline = new WorkerTimeline({
    workerHandle: sessionId, cliId: 'codex', model: options.model, readOnly: options.readOnly,
    now: () => clock, ...(options.redact ? { redact: options.redact } : {}),
  });
  timeline.setMeta({ alive: false, providerSessionId: text(object(thread).id) || null });
  array(object(thread).turns).map(object).forEach((turn, index) => {
    const items = array(turn.items).map(object);
    const startedAt = seconds(turn.startedAt) ?? millis(items[0]?.startedAtMs) ?? 0;
    const completedAt = seconds(turn.completedAt) ?? millis(items.at(-1)?.completedAtMs) ?? startedAt;
    const users = items.filter((item) => item.type === 'userMessage');
    const first = userInput(users[0]?.content);
    clock = startedAt;
    const wake = first.prompt.startsWith(SESSION_WAKE_HEADER);
    timeline.beginTurn({
      dispatchId: `${sessionId}:${index + 1}`, prompt: first.prompt, startedAt,
      ...(wake ? { origin: 'system' as const } : {}),
      ...(first.attachments.length ? { attachments: first.attachments } : {}),
    });
    if (text(turn.id)) timeline.apply({ type: 'turn_started', turnId: text(turn.id), startedAt });
    for (const item of items) {
      clock = millis(item.startedAtMs) ?? clock;
      const done = millis(item.completedAtMs) ?? clock;
      if (item.type === 'userMessage') {
        if (item === users[0]) continue;
        const later = userInput(item.content).prompt;
        if (later) timeline.apply({ type: 'item', item: { id: text(item.id), kind: 'message', role: 'user', text: later, status: 'completed', completedAt: done } });
        continue;
      }
      const update = codexItemUpdate(item, done);
      // A stored item that never finished cannot be running any more.
      if (update && 'status' in update && update.status === 'running') (update as { status: string }).status = 'failed';
      if (update) timeline.apply({ type: 'item', item: update });
    }
    clock = completedAt;
    const message = textOrNull(object(turn.error).message);
    timeline.completeTurn({
      turnId: text(turn.id) || null,
      status: TURN_STATUS[text(turn.status)] ?? 'interrupted',
      error: message,
    });
  });
  return timeline.archive();
}
