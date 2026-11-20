import { randomUUID } from 'node:crypto';
import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
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
const FILE_TASK_RESERVE_BYTES = 4 * 1024;
const SAFE_BRIEF_ID_RE = /^[a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}$/;
const BRIEF_NAME_RE = /^([a-zA-Z0-9_-][a-zA-Z0-9._-]{0,127}?)\.md(\.[a-zA-Z0-9-]+(?:\.\d+)?\.tmp)?$/;

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
  let end = maxChars - 1;
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
  const firstText = (...values: unknown[]) => values.find((value): value is string => (
    typeof value === 'string' && Boolean(value.trim())
  ))?.trim();
  const rawBackground = firstText(input.context, input.background, nested?.background);
  const rawAcceptance = firstText(input.acceptance, nested?.acceptance);

  const background = rawBackground ? clipChars(rawBackground, TASK_CONTEXT_MAX_BACKGROUND_CHARS) : undefined;
  const acceptance = rawAcceptance ? clipChars(rawAcceptance, TASK_CONTEXT_MAX_ACCEPTANCE_CHARS) : undefined;
  const constraints = normalizeList(input.constraints, TASK_CONTEXT_MAX_CONSTRAINTS) ??
    normalizeList(nested?.constraints, TASK_CONTEXT_MAX_CONSTRAINTS);
  const files = normalizeList(input.files, TASK_CONTEXT_MAX_FILES) ??
    normalizeList(nested?.files, TASK_CONTEXT_MAX_FILES);

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

// Nonempty overrides replace individual fields. Lists are normalized and deduplicated.
export function mergeTaskContext(
  base?: OrchestrationTaskContext | null,
  override?: OrchestrationTaskContext | null,
): OrchestrationTaskContext | null {
  return normalizeTaskContext({
    taskContext: { ...cloneTaskContext(base), ...cloneTaskContext(override) },
  });
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
  maxFileBodyBytes?: number;
  sanitizeText?: (text: string) => string;
}): string {
  const sanitize = input.sanitizeText ?? ((text: string) => text);
  const spec = sanitize(input.taskSpec).trim();
  const ctx = normalizeTaskContext({ taskContext: input.taskContext });
  const sharedBlock = sanitize(formatSharedRunContextBlock(
    input.sharedContext,
    spec,
    Boolean(input.mcpEnabled),
    input.cliCommand?.trim() || 'aha',
  ));
  if (!ctx && !sharedBlock) {
    return spec;
  }

  const background = ctx?.background ? '### Background & Decisions\n' + sanitize(ctx.background) : '';
  const files = ctx?.files?.length
    ? '### Relevant Files\n' + ctx.files.map((file) => '- ' + sanitize(file)).join('\n')
    : '';
  const constraints = ctx?.constraints?.length
    ? '### Constraints\n' + ctx.constraints.map((constraint) => '- ' + sanitize(constraint)).join('\n')
    : '';
  const acceptance = ctx?.acceptance ? '### Acceptance Criteria\n' + sanitize(ctx.acceptance) : '';
  const joinSections = (...sections: string[]) => sections.filter(Boolean).join('\n\n');
  if (input.maxFileBodyBytes === undefined) {
    return joinSections(spec, background, constraints, files, acceptance, sharedBlock);
  }

  const guardrails = joinSections(constraints, acceptance);
  // Keep guardrails whole even if all lists and the specification reach their limits.
  const taskReserve = Math.min(Buffer.byteLength(spec, 'utf8'), FILE_TASK_RESERVE_BYTES);
  const filesBudget = input.maxFileBodyBytes - Buffer.byteLength(guardrails, 'utf8') - taskReserve - 4;
  const required = joinSections(guardrails, clipMarkdown(files, filesBudget));
  const taskBudget = input.maxFileBodyBytes - Buffer.byteLength(required, 'utf8') - 2;
  const task = clipMarkdown(spec, taskBudget);
  const essential = joinSections(task, required);
  const extraBudget = input.maxFileBodyBytes - Buffer.byteLength(essential, 'utf8') - 2;
  const shared = clipMarkdown(sharedBlock, extraBudget);
  const backgroundBudget = extraBudget - (shared ? Buffer.byteLength(shared, 'utf8') + 2 : 0);
  return joinSections(essential, clipMarkdown(background, backgroundBudget), shared);
}

export function clipMarkdown(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  const notice = '\n\n[Section truncated.]';
  const contentBudget = maxBytes - Buffer.byteLength(notice, 'utf8');
  let budget = contentBudget;
  while (budget > 0) {
    const rawPrefix = clipUtf8Bytes(text, budget);
    let prefix = rawPrefix.trimEnd();
    // Drop a partial fence line before determining which fence still needs a close.
    if (text[rawPrefix.length] !== '\n' && /^[ \t]{0,3}(\x60{3,}|~{3,})/.test(prefix.slice(prefix.lastIndexOf('\n') + 1))) {
      prefix = prefix.slice(0, prefix.lastIndexOf('\n') + 1).trimEnd();
    }
    let fence = '';
    for (const line of prefix.split(/\r?\n/)) {
      const match = /^[ \t]{0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
      if (!match) continue;
      if (!fence) fence = match[1]!;
      else if (match[1]![0] === fence[0] && match[1]!.length >= fence.length && !match[2]!.trim()) fence = '';
    }
    const close = fence ? '\n' + fence : '';
    const overflow = Buffer.byteLength(prefix + close, 'utf8') - contentBudget;
    if (overflow <= 0) return prefix + close + notice;
    budget -= overflow;
  }
  return '';
}

function resolveBriefDirectory(briefsDir: string, create: boolean): string | null {
  const requested = resolve(briefsDir);
  if (create) mkdirSync(requested, { recursive: true, mode: 0o700 });
  const stats = lstatSync(requested);
  if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
  const canonical = realpathSync(requested);
  // The application data parent is trusted and may itself use a platform alias.
  const expected = join(realpathSync(dirname(requested)), basename(requested));
  return relative(expected, canonical) === '' ? canonical : null;
}

export function writeWorkerBriefFile(
  briefsDir: string,
  dispatchId: string,
  markdown: string,
): string | null {
  if (!briefsDir || !SAFE_BRIEF_ID_RE.test(dispatchId)) return null;
  const dir = resolveBriefDirectory(briefsDir, true);
  if (!dir) return null;
  const target = join(dir, dispatchId + '.md');
  const tmpPath = target + '.' + randomUUID() + '.tmp';
  let created = false;
  try {
    const bounded = clipMarkdown(markdown.trimEnd(), BRIEF_FILE_MAX_BYTES - 1);
    const fd = openSync(tmpPath, 'wx', 0o600);
    created = true;
    try {
      writeFileSync(fd, bounded + '\n', 'utf8');
    } finally {
      closeSync(fd);
    }
    renameSync(tmpPath, target);
    created = false;
    return target;
  } finally {
    if (created) rmSync(tmpPath, { force: true });
  }
}

export function listWorkerBriefFiles(briefsDir: string | null): Array<{
  dispatchId: string;
  temporary: boolean;
  regularFile: boolean;
  path: string;
}> | null {
  if (!briefsDir) return null;
  try {
    const dir = resolveBriefDirectory(briefsDir, false);
    if (!dir) return null;
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const match = BRIEF_NAME_RE.exec(entry.name);
      return match ? [{
        dispatchId: match[1]!,
        temporary: Boolean(match[2]),
        regularFile: entry.isFile(),
        path: join(dir, entry.name),
      }] : [];
    });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
}

export function removeWorkerBriefFile(
  briefsDir: string | null | undefined,
  dispatchId: string,
  temporaryOnly = false,
): boolean {
  if (!briefsDir) return true;
  if (!SAFE_BRIEF_ID_RE.test(dispatchId)) return false;
  try {
    const dir = resolveBriefDirectory(briefsDir, false);
    if (!dir) return false;
    for (const name of readdirSync(dir)) {
      const match = BRIEF_NAME_RE.exec(name);
      if (match?.[1] !== dispatchId || (temporaryOnly && !match[2])) continue;
      // Never recurse. A file symlink is removed without following its target.
      rmSync(join(dir, name), { force: true });
    }
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}
