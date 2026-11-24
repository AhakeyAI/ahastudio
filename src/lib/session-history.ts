import type { CodexThreadSummary } from '../types';

export interface HistoryGroup {
  label: string;
  threads: CodexThreadSummary[];
}

const startOfDay = (at: number) => {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
};

/** Splits a newest-first list into 今天 / 昨天 / 更早, keeping the order and dropping empty groups. */
export function groupThreadsByDay(threads: readonly CodexThreadSummary[], now: number): HistoryGroup[] {
  const today = startOfDay(now);
  const yesterday = startOfDay(today - 1);
  const groups: HistoryGroup[] = [
    { label: '今天', threads: [] }, { label: '昨天', threads: [] }, { label: '更早', threads: [] },
  ];
  for (const thread of threads) {
    groups[thread.updatedAt >= today ? 0 : thread.updatedAt >= yesterday ? 1 : 2]!.threads.push(thread);
  }
  return groups.filter((group) => group.threads.length);
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Short time for a history row: 10:42, 昨天 18:03, 6月2日, or 2024/6/2 for another year. */
export function formatThreadTime(at: number, now: number): string {
  const date = new Date(at);
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const today = startOfDay(now);
  if (at >= today) return clock;
  if (at >= startOfDay(today - 1)) return `昨天 ${clock}`;
  if (date.getFullYear() === new Date(now).getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`;
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`;
}

/** Appends a further page, skipping threads already listed (a thread can move while paging). */
export function mergeThreadPages(current: readonly CodexThreadSummary[], next: readonly CodexThreadSummary[]): CodexThreadSummary[] {
  const seen = new Set(current.map((thread) => thread.id));
  return [...current, ...next.filter((thread) => !seen.has(thread.id))];
}
