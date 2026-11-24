import type { CodexRateLimits, CodexRateLimitWindow } from '../types';

// Pure formatting for the composer's usage-limit chip.

export type UsageLevel = 'ok' | 'warn' | 'bad';

export interface UsageWindowLine {
  label: string;
  /** 0–100, for the bar. */
  percent: number;
  level: UsageLevel;
  used: string;
  reset: string | null;
}

export interface UsageSummary {
  text: string;
  level: UsageLevel;
  windows: UsageWindowLine[];
  planType: string | null;
}

const WARN_AT = 75;
const BAD_AT = 90;

/** "5 小时", "每周", "每天" for the common Codex windows; null when the length is unknown. */
export function usageWindowLabel(minutes: number | null): string {
  if (!minutes || minutes <= 0) return '额度';
  if (minutes === 10_080) return '每周';
  if (minutes === 1_440) return '每天';
  if (minutes % 1_440 === 0) return `${minutes / 1_440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

/** Time until `resetsAt`, rounded up to the minute so it never reads "0 分钟". */
export function formatResetIn(resetsAt: number | null, now: number): string | null {
  if (resetsAt === null) return null;
  const minutes = Math.ceil((resetsAt - now) / 60_000);
  if (minutes <= 0) return '即将重置';
  if (minutes < 60) return `${minutes} 分钟后重置`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}后重置`;
  const days = Math.floor(hours / 24);
  return `${days} 天${hours % 24 ? ` ${hours % 24} 小时` : ''}后重置`;
}

const levelOf = (percent: number): UsageLevel => (percent >= BAD_AT ? 'bad' : percent >= WARN_AT ? 'warn' : 'ok');

const line = (window: CodexRateLimitWindow, now: number): UsageWindowLine => ({
  label: usageWindowLabel(window.windowMinutes),
  percent: window.usedPercent,
  level: levelOf(window.usedPercent),
  used: `已用 ${Math.round(window.usedPercent)}%`,
  reset: formatResetIn(window.resetsAt, now),
});

/**
 * What the chip shows: the main window's usage, unless another window is close to spent (then
 * that one, named), so a nearly used-up weekly limit is not hidden behind a quiet five-hour one.
 * Null when there is nothing to show.
 */
export function summarizeUsage(limits: CodexRateLimits | null, now: number): UsageSummary | null {
  if (!limits) return null;
  const windows = [limits.primary, limits.secondary].filter((entry): entry is CodexRateLimitWindow => Boolean(entry));
  if (!windows.length && !limits.reached) return null;
  const highest = Math.max(0, ...windows.map((entry) => entry.usedPercent));
  const main = windows[0];
  const fullest = windows.find((entry) => entry.usedPercent === highest);
  const shown = fullest && main && fullest !== main && highest >= WARN_AT && highest > main.usedPercent ? fullest : main;
  const named = shown && shown !== main ? usageWindowLabel(shown.windowMinutes) : '';
  return {
    text: limits.reached || !shown ? '额度已用尽' : `${named}额度 ${Math.round(shown.usedPercent)}%`,
    level: limits.reached ? 'bad' : levelOf(highest),
    windows: windows.map((entry) => line(entry, now)),
    planType: limits.planType,
  };
}
