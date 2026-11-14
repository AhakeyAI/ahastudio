import type { AgentPaneStatus } from '../types';
import type { DiffLine } from './git-panel-model';

export type AgentTone = AgentPaneStatus['state'];

export const ptyIdForLeaf = (leafId: string) => `local-${leafId}`;

const AGENT_NAMES: Record<string, string> = {
  antigravity: 'Antigravity',
  agy: 'Antigravity',
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  'grok-build': 'Grok',
  qwen: 'Qwen Code',
  qoder: 'Qoder',
  kimi: 'Kimi',
  opencode: 'OpenCode',
  openclaude: 'OpenClaude',
  pi: 'Pi',
};

export function agentDisplayName(agentId: string | null | undefined): string {
  if (!agentId) return 'Agent';
  return AGENT_NAMES[agentId.toLowerCase()] ?? agentId;
}

/** Hidden when there is nothing to report: an idle pane the user has already seen. */
export function isAgentStatusVisible(status: AgentPaneStatus | null | undefined): status is AgentPaneStatus {
  return Boolean(status && (status.state !== 'idle' || status.unread));
}

export function agentStatusLabel(status: AgentPaneStatus): string {
  switch (status.state) {
    case 'working': {
      const active = status.subagents.filter((s) => s.state !== 'idle').length;
      return active > 0 ? `运行中 · ${active} 个子任务` : '运行中';
    }
    case 'waiting':
      return status.waitKind === 'question' ? '等待回答' : status.waitKind === 'auth' ? '需要登录' : '等待确认';
    case 'done':
      return '已完成';
    case 'error':
      return '出错';
    default:
      return '空闲';
  }
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** One-line secondary summary: tool call, progress, message. */
export function agentStatusDetail(status: AgentPaneStatus): string {
  const parts: string[] = [];
  if (status.toolName) {
    const input = status.toolInput?.replace(/\s+/g, ' ').trim();
    parts.push(input ? `${status.toolName}: ${clip(input, 80)}` : status.toolName);
  }
  if (typeof status.progress === 'number' && Number.isFinite(status.progress)) {
    const pct = status.progress <= 1 ? status.progress * 100 : status.progress;
    parts.push(`${Math.round(Math.max(0, Math.min(100, pct)))}%`);
  }
  if (status.message) parts.push(clip(status.message.replace(/\s+/g, ' ').trim(), 120));
  return parts.join(' · ');
}

export function agentStatusTooltip(status: AgentPaneStatus, now = Date.now()): string {
  const lines = [`${agentDisplayName(status.agentId)} · ${agentStatusLabel(status)}`];
  const detail = agentStatusDetail(status);
  if (detail) lines.push(detail);
  for (const sub of status.subagents.slice(0, 5)) {
    lines.push(`  ↳ ${sub.title ?? sub.id} (${sub.state === 'working' ? '运行中' : sub.state === 'waiting' ? '等待中' : '空闲'})`);
  }
  if (status.subagents.length > 5) lines.push(`  … 另有 ${status.subagents.length - 5} 个子任务`);
  const elapsed = formatElapsed(now - status.stateStartedAt);
  if (elapsed) lines.push(`已持续 ${elapsed}`);
  return lines.join('\n');
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms) || ms < 1000) return '';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 小时 ${m % 60} 分`;
}

const PRIORITY: Record<AgentTone, number> = { waiting: 5, error: 4, working: 3, done: 2, idle: 1 };

/** The status that most deserves the user's attention among several panes. */
export function pickAttentionStatus(
  statuses: ReadonlyArray<AgentPaneStatus | null | undefined>,
): AgentPaneStatus | null {
  let best: AgentPaneStatus | null = null;
  const score = (s: AgentPaneStatus) => PRIORITY[s.state] * 2 + (s.unread ? 1 : 0);
  for (const status of statuses) {
    if (!isAgentStatusVisible(status)) continue;
    if (!best || score(status) > score(best) || (score(status) === score(best) && status.updatedAt > best.updatedAt)) {
      best = status;
    }
  }
  return best;
}

/** True when the transition from prev to next should alert the user. */
export function isAttentionTransition(prev: AgentPaneStatus | undefined, next: AgentPaneStatus): boolean {
  if (!next.unread) return false;
  if (next.state !== 'waiting' && next.state !== 'done' && next.state !== 'error') return false;
  return !prev || !prev.unread || prev.state !== next.state || prev.waitKind !== next.waitKind;
}

export interface DiffSelectionPayload {
  snippet: string;
  startLine?: number;
  endLine?: number;
  rowCount: number;
}

function diffRowText(row: DiffLine): string {
  if (row.kind === 'add') return `+${row.text}`;
  if (row.kind === 'del') return `-${row.text}`;
  if (row.kind === 'context') return ` ${row.text}`;
  return row.text;
}

/**
 * Turn a run of parsed diff rows into a snippet plus the line range it covers.
 * The range uses new-file numbers, falling back to old-file numbers for pure deletions.
 * With no explicit range the whole diff body (hunks only, no git headers) is used.
 */
export function buildDiffSnippet(rows: readonly DiffLine[], start?: number, end?: number): DiffSelectionPayload {
  const ranged = start !== undefined && end !== undefined;
  const lo = ranged ? Math.max(0, Math.min(start, end)) : 0;
  const hi = ranged ? Math.min(rows.length - 1, Math.max(start, end)) : rows.length - 1;
  const picked = rows.slice(lo, hi + 1).filter((row) => ranged || (row.kind !== 'file' && row.kind !== 'meta'));
  const snippet = picked.map(diffRowText).join('\n');
  if (!ranged) return { snippet, rowCount: picked.length };
  const newNums = picked.flatMap((r) => (r.newLine !== null ? [r.newLine] : []));
  const nums = newNums.length ? newNums : picked.flatMap((r) => (r.oldLine !== null ? [r.oldLine] : []));
  return {
    snippet,
    startLine: nums.length ? Math.min(...nums) : undefined,
    endLine: nums.length ? Math.max(...nums) : undefined,
    rowCount: picked.length,
  };
}

const encoder = new TextEncoder();
export const utf8Bytes = (text: string) => encoder.encode(text).length;

/** Room the backend framing needs around the parts (paste markers, fences, path label). */
const FRAMING_OVERHEAD_BYTES = 96;

/**
 * Trim the snippet from its end, on line boundaries, so the framed prompt fits
 * the backend PTY write limit. The prompt itself is never cut.
 */
export function fitPromptParts(
  parts: { prompt: string; filePath?: string; diffSnippet?: string },
  maxBytes = 8192,
): { diffSnippet?: string; truncated: boolean; overLimit: boolean } {
  const fixed = utf8Bytes(parts.prompt) + utf8Bytes(parts.filePath ?? '') + FRAMING_OVERHEAD_BYTES;
  if (fixed > maxBytes) return { diffSnippet: parts.diffSnippet, truncated: false, overLimit: true };
  const snippet = parts.diffSnippet;
  if (!snippet || fixed + utf8Bytes(snippet) <= maxBytes) return { diffSnippet: snippet, truncated: false, overLimit: false };
  const marker = '\n… (已截断)';
  const budget = maxBytes - fixed - utf8Bytes(marker);
  const lines = snippet.split('\n');
  const kept: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = utf8Bytes(line) + 1;
    if (used + cost > budget) break;
    kept.push(line);
    used += cost;
  }
  return { diffSnippet: kept.length ? kept.join('\n') + marker : undefined, truncated: true, overLimit: false };
}

/**
 * Path of `target` as seen from directory `fromDir`, using '/' separators;
 * null when target is outside fromDir.
 */
export function relativeFromDir(fromDir: string, target: string): string | null {
  const windows = /^[a-zA-Z]:/.test(fromDir) || fromDir.includes('\\');
  const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const base = norm(fromDir);
  const full = norm(target);
  const cmpBase = windows ? base.toLowerCase() : base;
  const cmpFull = windows ? full.toLowerCase() : full;
  if (cmpFull === cmpBase) return '.';
  const prefix = cmpBase.endsWith('/') ? cmpBase : `${cmpBase}/`;
  return cmpFull.startsWith(prefix) ? full.slice(prefix.length) : null;
}
