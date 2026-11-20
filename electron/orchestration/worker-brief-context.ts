import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  OrchestrationBoardPostKind,
  OrchestrationTaskContext,
} from './orchestration-types.js';

export const TASK_CONTEXT_MAX_BACKGROUND_CHARS = 16_000;
export const TASK_CONTEXT_MAX_ACCEPTANCE_CHARS = 4_000;
export const TASK_CONTEXT_MAX_CONSTRAINTS = 20;
export const TASK_CONTEXT_MAX_FILES = 30;
export const TASK_CONTEXT_MAX_ITEM_CHARS = 400;
export const SHARED_RUN_CONTEXT_MAX_BYTES = 1_500;
export const BRIEF_FILE_MAX_BYTES = 64 * 1024;
const SAFE_BRIEF_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export interface TaskContextInput {
  taskContext?: OrchestrationTaskContext | null;
  context?: string | null;
  background?: string | null;
  constraints?: readonly string[] | null;
  files?: readonly string[] | null;
  acceptance?: string | null;
}

export interface SharedRunPeerSummary {
  role: string;
  taskTitle: string;
}

export interface SharedRunBoardPostSummary {
  boardSeq: number;
  kind: OrchestrationBoardPostKind;
  fromRole: string;
  summary: string;
}

export interface SharedRunContext {
  runObjective?: string | null;
  activePeers?: SharedRunPeerSummary[];
  recentBoardPosts?: SharedRunBoardPostSummary[];
  latestBoardSeq?: number;
}

function clipChars(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  let end = maxChars;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
  return `${text.slice(0, end).trimEnd()}…`;
}

export function clipUtf8Bytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), 'utf8') <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end -= 1;
  return text.slice(0, end);
}

function normalizeList(
  items: readonly string[] | null | undefined,
  maxItems: number,
): string[] | undefined {
  if (!Array.isArray(items) || items.length === 0) return undefined;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of items) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const clipped = clipChars(trimmed, TASK_CONTEXT_MAX_ITEM_CHARS);
    if (seen.has(clipped)) continue;
    seen.add(clipped);
    out.push(clipped);
    if (out.length >= maxItems) break;
  }
  return out.length > 0 ? out : undefined;
}

export function normalizeTaskContext(input?: TaskContextInput | null): OrchestrationTaskContext | null {
  if (!input) return null;
  const nested = input.taskContext ?? null;
  const rawBackground =
    (typeof input.background === 'string' ? input.background : undefined) ??
    (typeof input.context === 'string' ? input.context : undefined) ??
    nested?.background;
  const rawAcceptance =
    (typeof input.acceptance === 'string' ? input.acceptance : undefined) ??
    nested?.acceptance;
  const rawConstraints = input.constraints ?? nested?.constraints;
  const rawFiles = input.files ?? nested?.files;

  const background = rawBackground?.trim()
    ? clipChars(rawBackground.trim(), TASK_CONTEXT_MAX_BACKGROUND_CHARS)
    : undefined;
  const acceptance = rawAcceptance?.trim()
    ? clipChars(rawAcceptance.trim(), TASK_CONTEXT_MAX_ACCEPTANCE_CHARS)
    : undefined;
  const constraints = normalizeList(rawConstraints, TASK_CONTEXT_MAX_CONSTRAINTS);
  const files = normalizeList(rawFiles, TASK_CONTEXT_MAX_FILES);

  if (!background && !acceptance && !constraints && !files) {
    return null;
  }
  return {
    ...(background ? { background } : {}),
    ...(constraints ? { constraints } : {}),
    ...(files ? { files } : {}),
    ...(acceptance ? { acceptance } : {}),
  };
}

export function cloneTaskContext(
  ctx?: OrchestrationTaskContext | null,
): OrchestrationTaskContext | null {
  if (!ctx) return null;
  return normalizeTaskContext({ taskContext: ctx });
}

function collapseSingleLine(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  return clipChars(collapsed, maxChars);
}

export function formatSharedRunContextBlock(
  shared: SharedRunContext | null | undefined,
  taskSpec: string,
  mcpEnabled: boolean,
  cliCommand: string,
): string {
  if (!shared) return '';
  const sections: string[] = [];
  const normalizedSpec = taskSpec.replace(/\s+/g, ' ').trim();
  const objective = shared.runObjective ? collapseSingleLine(shared.runObjective, 220) : '';
  if (objective && objective !== normalizedSpec && !normalizedSpec.startsWith(objective)) {
    sections.push(`- Run Objective: ${objective}`);
  }
  const peers = (shared.activePeers ?? []).slice(0, 6);
  if (peers.length > 0) {
    const peerItems = peers.map(
      (p) => `@${p.role.replace(/^@+/, '')} (${collapseSingleLine(p.taskTitle, 72)})`,
    );
    sections.push(`- Active Peers: ${peerItems.join('; ')}`);
  }
  const recent = (shared.recentBoardPosts ?? []).slice(-3);
  if (recent.length > 0) {
    sections.push('- Recent Board Highlights:');
    for (const post of recent) {
      sections.push(
        `  - #${post.boardSeq} [${post.kind}] @${post.fromRole.replace(/^@+/, '')}: ${collapseSingleLine(post.summary, 160)}`,
      );
    }
  }
  if (sections.length === 0) return '';
  if (typeof shared.latestBoardSeq === 'number' && shared.latestBoardSeq > 0) {
    const readHint = mcpEnabled
      ? `Call \`read_board\` (current head #${shared.latestBoardSeq}) for full team context.`
      : `Run \`${cliCommand} orchestration board-read\` (current head #${shared.latestBoardSeq}) for full team context.`;
    sections.push(`- Board: ${readHint}`);
  }
  const block = `### Shared Run Context\n${sections.join('\n')}`;
  if (Buffer.byteLength(block, 'utf8') <= SHARED_RUN_CONTEXT_MAX_BYTES) {
    return block;
  }
  return `${clipUtf8Bytes(block, SHARED_RUN_CONTEXT_MAX_BYTES - 4).trimEnd()}\n…`;
}

export function formatStructuredTaskBody(input: {
  taskSpec: string;
  taskContext?: OrchestrationTaskContext | null;
  sharedContext?: SharedRunContext | null;
  mcpEnabled?: boolean;
  cliCommand?: string;
}): string {
  const spec = input.taskSpec.trim();
  const ctx = normalizeTaskContext({ taskContext: input.taskContext });
  const sharedBlock = formatSharedRunContextBlock(
    input.sharedContext,
    spec,
    Boolean(input.mcpEnabled),
    input.cliCommand?.trim() || 'aha',
  );
  if (!ctx && !sharedBlock) {
    return spec;
  }

  const parts: string[] = [spec];
  if (ctx?.background) {
    parts.push(`### Background & Decisions\n${ctx.background}`);
  }
  if (ctx?.constraints && ctx.constraints.length > 0) {
    parts.push(`### Constraints\n${ctx.constraints.map((c) => `- ${c}`).join('\n')}`);
  }
  if (ctx?.files && ctx.files.length > 0) {
    parts.push(`### Relevant Files\n${ctx.files.map((f) => `- ${f}`).join('\n')}`);
  }
  if (ctx?.acceptance) {
    parts.push(`### Acceptance Criteria\n${ctx.acceptance}`);
  }
  if (sharedBlock) {
    parts.push(sharedBlock);
  }
  return parts.join('\n\n');
}

export function writeWorkerBriefFile(
  briefsDir: string,
  dispatchId: string,
  markdown: string,
): string | null {
  if (!briefsDir || !SAFE_BRIEF_ID_RE.test(dispatchId)) return null;
  const dir = resolve(briefsDir);
  const target = join(dir, `${dispatchId}.md`);
  const rel = relative(dir, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;

  const bounded =
    Buffer.byteLength(markdown, 'utf8') <= BRIEF_FILE_MAX_BYTES
      ? markdown
      : `${clipUtf8Bytes(markdown, BRIEF_FILE_MAX_BYTES - 64).trimEnd()}\n\n[Brief truncated at 64 KiB limit.]\n`;

  mkdirSync(dirname(target), { recursive: true });
  const tmpPath = `${target}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmpPath, `${bounded.trimEnd()}\n`, 'utf8');
  renameSync(tmpPath, target);
  return target;
}

export function removeWorkerBriefFile(briefsDir: string | null | undefined, filePath: string | null | undefined): void {
  if (!briefsDir || !filePath) return;
  try {
    const dir = resolve(briefsDir);
    const resolved = resolve(filePath);
    const rel = relative(dir, resolved);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return;
    if (existsSync(resolved)) {
      rmSync(resolved, { force: true });
    }
  } catch {
    /* non-fatal cleanup */
  }
}
