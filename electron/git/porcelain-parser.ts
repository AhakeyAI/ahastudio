export interface GitStatusFileEntry {
  path: string;
  origPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface ParsedGitStatus {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  entries: GitStatusFileEntry[];
}

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  branchRef: string | null;
  isBare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
  isMainWorktree: boolean;
}

function decodeGitCQuotedPath(value: string): string {
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') {
    return value;
  }

  let decoded = '';
  for (let index = 1; index < value.length - 1; index += 1) {
    const char = value[index];
    if (char !== '\\') {
      decoded += char;
      continue;
    }

    index += 1;
    const escaped = value[index];
    switch (escaped) {
      case 'a':
        decoded += '\u0007';
        break;
      case 'b':
        decoded += '\b';
        break;
      case 'f':
        decoded += '\f';
        break;
      case 'n':
        decoded += '\n';
        break;
      case 'r':
        decoded += '\r';
        break;
      case 't':
        decoded += '\t';
        break;
      case 'v':
        decoded += '\v';
        break;
      case '\\':
      case '"':
        decoded += escaped;
        break;
      default:
        if (escaped && /[0-7]/.test(escaped)) {
          const bytes: number[] = [];
          let octalStart = index;
          while (octalStart < value.length - 1) {
            let octal = value[octalStart] ?? '';
            let octalEnd = octalStart;
            while (
              octalEnd + 1 < value.length - 1 &&
              octal.length < 3 &&
              /[0-7]/.test(value[octalEnd + 1] ?? '')
            ) {
              octalEnd += 1;
              octal += value[octalEnd];
            }
            bytes.push(Number.parseInt(octal, 8));
            index = octalEnd;
            if (value[index + 1] !== '\\' || !/[0-7]/.test(value[index + 2] ?? '')) {
              break;
            }
            octalStart = index + 2;
          }
          decoded += new TextDecoder('utf-8', { ignoreBOM: true }).decode(Uint8Array.from(bytes));
        } else if (escaped) {
          decoded += escaped;
        }
        break;
    }
  }

  return decoded;
}

function parseBranchHeader(headerBody: string): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
} {
  const unbornMatch = /^(?:No commits yet|Initial commit) on (.+)$/.exec(headerBody);
  if (unbornMatch) {
    return {
      branch: unbornMatch[1] || null,
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
    };
  }

  if (headerBody === 'HEAD (no branch)' || headerBody.startsWith('HEAD (detached')) {
    return {
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: true,
    };
  }

  let refPart = headerBody;
  let ahead = 0;
  let behind = 0;

  const trackingMatch = /^(.*?)\s+\[((?:ahead \d+(?:,\s*behind \d+)?)|(?:behind \d+)|gone)\]$/.exec(
    headerBody,
  );
  if (trackingMatch) {
    refPart = trackingMatch[1] ?? '';
    const bracket = trackingMatch[2] ?? '';
    const aheadMatch = /ahead (\d+)/.exec(bracket);
    const behindMatch = /behind (\d+)/.exec(bracket);
    ahead = aheadMatch ? Number(aheadMatch[1]) : 0;
    behind = behindMatch ? Number(behindMatch[1]) : 0;
  }

  const sepIdx = refPart.indexOf('...');
  if (sepIdx !== -1) {
    return {
      branch: refPart.slice(0, sepIdx) || null,
      upstream: refPart.slice(sepIdx + 3) || null,
      ahead,
      behind,
      detached: false,
    };
  }

  return {
    branch: refPart || null,
    upstream: null,
    ahead,
    behind,
    detached: false,
  };
}

export function parsePorcelainV1Status(stdout: string): ParsedGitStatus {
  const fields = stdout.split('\0');
  let branch: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  let detached = false;
  const entries: GitStatusFileEntry[] = [];

  for (let index = 0; index < fields.length; index++) {
    const field = fields[index];
    if (!field) continue;

    if (index === 0 && field.startsWith('## ')) {
      const parsedHeader = parseBranchHeader(field.slice(3));
      branch = parsedHeader.branch;
      upstream = parsedHeader.upstream;
      ahead = parsedHeader.ahead;
      behind = parsedHeader.behind;
      detached = parsedHeader.detached;
      continue;
    }

    if (field.length < 4 || field[2] !== ' ') {
      continue;
    }

    const indexStatus = field[0]!;
    const worktreeStatus = field[1]!;
    const filePath = field.slice(3).replace(/\\/g, '/');

    let origPath: string | null = null;
    if (
      indexStatus === 'R' ||
      indexStatus === 'C' ||
      worktreeStatus === 'R' ||
      worktreeStatus === 'C'
    ) {
      const next = fields[index + 1];
      if (next !== undefined) {
        origPath = next ? next.replace(/\\/g, '/') : null;
        index += 1;
      }
    }

    const conflicted =
      indexStatus === 'U' ||
      worktreeStatus === 'U' ||
      (indexStatus === 'D' && worktreeStatus === 'D') ||
      (indexStatus === 'A' && worktreeStatus === 'A');
    const untracked = indexStatus === '?' && worktreeStatus === '?';
    const staged = !conflicted && !untracked && indexStatus !== ' ' && indexStatus !== '!';
    const unstaged = !conflicted && !untracked && worktreeStatus !== ' ' && worktreeStatus !== '!';

    entries.push({
      path: filePath,
      origPath,
      indexStatus,
      worktreeStatus,
      staged,
      unstaged,
      untracked,
      conflicted,
    });
  }

  return {
    branch,
    upstream,
    ahead,
    behind,
    detached,
    entries,
  };
}

function splitLineWorktreeBlocks(output: string): string[][] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  return trimmed.split(/\r?\n\r?\n/).map((block) => block.trim().split(/\r?\n/));
}

function splitNulWorktreeBlocks(output: string): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const field of output.split('\0')) {
    if (field) {
      current.push(field);
    } else if (current.length > 0) {
      blocks.push(current);
      current = [];
    }
  }
  if (current.length > 0) {
    blocks.push(current);
  }
  return blocks;
}

export function parseWorktreeListPorcelain(stdout: string): GitWorktreeEntry[] {
  const nulDelimited = stdout.includes('\0');
  const blocks = nulDelimited ? splitNulWorktreeBlocks(stdout) : splitLineWorktreeBlocks(stdout);
  const worktrees: GitWorktreeEntry[] = [];

  for (const lines of blocks) {
    if (lines.length === 0) continue;

    let path = '';
    let head = '';
    let branchRef: string | null = null;
    let isBare = false;
    let detached = false;
    let locked = false;
    let lockReason: string | null = null;
    let prunable = false;
    let prunableReason: string | null = null;

    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        const raw = line.slice('worktree '.length);
        path = nulDelimited ? raw : decodeGitCQuotedPath(raw);
      } else if (line.startsWith('HEAD ')) {
        head = line.slice('HEAD '.length);
      } else if (line.startsWith('branch ')) {
        branchRef = line.slice('branch '.length) || null;
      } else if (line === 'detached') {
        detached = true;
      } else if (line === 'bare') {
        isBare = true;
      } else if (line === 'locked' || line.startsWith('locked ')) {
        locked = true;
        const rawReason = line.slice('locked'.length).trim();
        const reason = nulDelimited ? rawReason : decodeGitCQuotedPath(rawReason);
        lockReason = reason || null;
      } else if (line === 'prunable' || line.startsWith('prunable ')) {
        prunable = true;
        const rawReason = line.slice('prunable'.length).trim();
        const reason = nulDelimited ? rawReason : decodeGitCQuotedPath(rawReason);
        prunableReason = reason || null;
      }
    }

    if (path) {
      const branch = branchRef
        ? branchRef.startsWith('refs/heads/')
          ? branchRef.slice('refs/heads/'.length)
          : branchRef
        : null;
      worktrees.push({
        path,
        head,
        branch,
        branchRef,
        isBare,
        detached,
        locked,
        lockReason,
        prunable,
        prunableReason,
        isMainWorktree: worktrees.length === 0,
      });
    }
  }

  return worktrees;
}
