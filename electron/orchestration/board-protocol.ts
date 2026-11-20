import { getGitStatus, inspectGitRepo } from '../git/git-service.js';

export const DEFAULT_PEER_PING_PONG_LIMIT = 3;
const MAX_REPORT_CHANGED_FILES = 20;
const MAX_INLINE_ARTIFACT_FILES = 8;

const MENTION_PATTERN = /(?:^|[\s([{"'（【「,，、:：;；])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/g;
const REF_PATTERN = /(?:^|[\s([{"'（【「,])#([1-9]\d{0,5})\b/g;

export interface BoardReportArtifacts {
  branch: string | null;
  worktreePath: string | null;
  headCommit: string | null;
  changedFiles: string[];
  changedFileCount: number;
}

export interface BoardPostFormatInput {
  boardSeq?: number;
  seq: number;
  fromRole?: string;
  fromHandle: string;
  mentions?: readonly string[];
  kind?: string;
  subject?: string;
  body: string;
  createdAt: string;
  artifacts?: {
    branch?: string | null;
    worktreePath?: string | null;
    headCommit?: string | null;
    changedFiles?: readonly string[];
    changedFileCount?: number;
  } | null;
}

export interface BoardTeamSummaryWorker {
  role: string;
  cliId?: string | null;
  stage: string;
  openApprovalCount?: number;
  openQuestionCount?: number;
}

export interface BoardTeamSummaryInput {
  headSeq: number;
  workers: readonly BoardTeamSummaryWorker[];
  pendingProposalCount?: number;
}

export interface CollectWorkerReportArtifactsDeps {
  inspectGitRepo?: typeof inspectGitRepo;
  getGitStatus?: typeof getGitStatus;
}

export function parseBoardMentions(text: string): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  MENTION_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const cleaned = (match[1] ?? '').replace(/\.+$/, '').toLowerCase();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

export function parseBoardRefs(text: string): number[] {
  if (!text) return [];
  const seen = new Set<number>();
  const out: number[] = [];
  REF_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(REF_PATTERN)) {
    const seq = Number.parseInt(match[1] ?? '', 10);
    if (!Number.isSafeInteger(seq) || seq <= 0 || seen.has(seq)) continue;
    seen.add(seq);
    out.push(seq);
  }
  return out;
}

function normalizeRoleKey(role: string): string {
  return role.trim().replace(/^@+/, '').toLowerCase();
}

function sortedPairKey(a: string, b: string): string {
  const normA = normalizeRoleKey(a);
  const normB = normalizeRoleKey(b);
  return normA <= normB ? `${normA}<->${normB}` : `${normB}<->${normA}`;
}

export class PeerPingPongTracker {
  private readonly countsByRun = new Map<string, Map<string, number>>();

  recordCoordinatorOrUserActivity(runId: string): void {
    this.countsByRun.delete(runId);
  }

  recordPeerExchange(
    runId: string,
    fromRole: string,
    toRole: string,
    limit = DEFAULT_PEER_PING_PONG_LIMIT,
  ): { count: number; exceeded: boolean } {
    const effectiveLimit =
      Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : DEFAULT_PEER_PING_PONG_LIMIT;
    let pairs = this.countsByRun.get(runId);
    if (!pairs) {
      pairs = new Map<string, number>();
      this.countsByRun.set(runId, pairs);
    }
    const key = sortedPairKey(fromRole, toRole);
    const count = (pairs.get(key) ?? 0) + 1;
    pairs.set(key, count);
    return { count, exceeded: count >= effectiveLimit };
  }

  getExchangeCount(runId: string, roleA: string, roleB: string): number {
    return this.countsByRun.get(runId)?.get(sortedPairKey(roleA, roleB)) ?? 0;
  }

  clearRun(runId: string): void {
    this.countsByRun.delete(runId);
  }

  clearAll(): void {
    this.countsByRun.clear();
  }
}

export async function collectWorkerReportArtifacts(
  worktreePath?: string | null,
  branch?: string | null,
  deps?: CollectWorkerReportArtifactsDeps,
): Promise<BoardReportArtifacts | null> {
  const trimmedBranch = branch?.trim() || null;
  const trimmedPath = worktreePath?.trim() || null;
  if (!trimmedPath) {
    return trimmedBranch
      ? {
          branch: trimmedBranch,
          worktreePath: null,
          headCommit: null,
          changedFiles: [],
          changedFileCount: 0,
        }
      : null;
  }

  try {
    const inspectFn = deps?.inspectGitRepo ?? inspectGitRepo;
    const statusFn = deps?.getGitStatus ?? getGitStatus;
    const [inspected, status] = await Promise.all([
      inspectFn(trimmedPath).catch(() => null),
      statusFn(trimmedPath).catch(() => null),
    ]);
    const resolvedBranch =
      (status && status.ok && status.isGitRepo ? status.branch : null) ??
      (inspected && inspected.ok && inspected.isGitRepo ? inspected.branch : null) ??
      trimmedBranch;
    const rawHead =
      (status && status.ok && status.isGitRepo ? status.head : null) ??
      (inspected && inspected.ok && inspected.isGitRepo ? inspected.head : null) ??
      null;
    const headCommit = rawHead ? rawHead.trim().slice(0, 10) || null : null;
    const allPaths =
      status && status.ok && status.isGitRepo
        ? status.entries.map((entry) => entry.path).filter((path): path is string => Boolean(path))
        : [];
    return {
      branch: resolvedBranch,
      worktreePath: trimmedPath,
      headCommit,
      changedFiles: allPaths.slice(0, MAX_REPORT_CHANGED_FILES),
      changedFileCount: allPaths.length,
    };
  } catch {
    return {
      branch: trimmedBranch,
      worktreePath: trimmedPath,
      headCommit: null,
      changedFiles: [],
      changedFileCount: 0,
    };
  }
}

export function formatBoardPostForAgent(post: BoardPostFormatInput): string {
  const seq = post.boardSeq ?? post.seq;
  const from = normalizeRoleKey(post.fromRole?.trim() || post.fromHandle) || 'unknown';
  const mentions = (post.mentions ?? [])
    .map((m) => normalizeRoleKey(m))
    .filter(Boolean);
  const targetPart = mentions.length > 0 ? ` -> ${mentions.map((m) => `@${m}`).join(' ')}` : '';
  const kindPart = post.kind?.trim() ? ` · ${post.kind.trim()}` : '';
  const header = `[#${seq} · @${from}${targetPart}${kindPart}]`;

  const lines = [header];
  const trimmedSubject = post.subject?.trim();
  const trimmedBody = post.body.trim();
  if (trimmedSubject && trimmedSubject !== trimmedBody && !trimmedBody.startsWith(trimmedSubject)) {
    lines.push(trimmedSubject);
  }
  if (trimmedBody) {
    lines.push(trimmedBody);
  }

  const artifacts = post.artifacts;
  if (artifacts) {
    const parts: string[] = [];
    if (artifacts.branch?.trim()) parts.push(`branch=${artifacts.branch.trim()}`);
    if (artifacts.headCommit?.trim()) parts.push(`commit=${artifacts.headCommit.trim()}`);
    const files = (artifacts.changedFiles ?? []).filter(Boolean);
    const count = artifacts.changedFileCount ?? files.length;
    if (count > 0) {
      const shown = files.slice(0, MAX_INLINE_ARTIFACT_FILES);
      const more = count > shown.length ? ` (+${count - shown.length} more)` : '';
      const filePart = shown.length > 0 ? `: ${shown.join(', ')}${more}` : '';
      parts.push(`${count} changed file(s)${filePart}`);
    } else if (parts.length > 0) {
      parts.push('0 changed file(s)');
    }
    if (parts.length > 0) {
      lines.push(`Artifacts: ${parts.join(' | ')}`);
    }
  }

  return lines.join('\n');
}

function formatWorkerTag(worker: BoardTeamSummaryWorker): string {
  const role = normalizeRoleKey(worker.role) || 'worker';
  const cli = worker.cliId?.trim();
  return cli ? `@${role}(${cli})` : `@${role}`;
}

export function formatBoardTeamSummary(input: BoardTeamSummaryInput): string {
  const working: string[] = [];
  const waiting: string[] = [];
  let doneCount = 0;
  let failedCount = 0;
  let approvalCount = 0;
  let questionCount = 0;

  for (const worker of input.workers) {
    approvalCount += worker.openApprovalCount ?? 0;
    questionCount += worker.openQuestionCount ?? 0;
    switch (worker.stage) {
      case 'starting':
      case 'working':
        working.push(formatWorkerTag(worker));
        break;
      case 'waiting_permission':
      case 'waiting_input':
      case 'awaiting_review':
        waiting.push(formatWorkerTag(worker));
        break;
      case 'done':
      case 'released':
        doneCount += 1;
        break;
      case 'failed':
      case 'stopped':
        failedCount += 1;
        break;
      default:
        break;
    }
  }

  const segments = [
    `Board head=#${input.headSeq}`,
    `working: ${working.length > 0 ? working.join(', ') : 'none'}`,
  ];
  if (waiting.length > 0) segments.push(`waiting: ${waiting.join(', ')}`);
  segments.push(`done: ${doneCount}`);
  if (failedCount > 0) segments.push(`failed: ${failedCount}`);
  segments.push(`approvals: ${approvalCount}`);
  if (questionCount > 0) segments.push(`questions: ${questionCount}`);
  if ((input.pendingProposalCount ?? 0) > 0) {
    segments.push(`proposals: ${input.pendingProposalCount}`);
  }
  return segments.join(' | ');
}
