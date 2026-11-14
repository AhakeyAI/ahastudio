import type { GitStatusFileEntry } from '../types';

export type GitChangeGroupId = 'conflicts' | 'staged' | 'changes' | 'untracked';

export interface GitChangeItem {
  key: string;
  group: GitChangeGroupId;
  entry: GitStatusFileEntry;
  /** Single-letter badge shown in the list (VS Code style). */
  letter: string;
}

export type GitChangeGroups = Record<GitChangeGroupId, GitChangeItem[]>;

export const GIT_CHANGE_GROUP_ORDER: GitChangeGroupId[] = ['conflicts', 'staged', 'changes', 'untracked'];

export const GIT_CHANGE_GROUP_LABELS: Record<GitChangeGroupId, string> = {
  conflicts: '合并冲突',
  staged: '暂存的更改',
  changes: '更改',
  untracked: '未跟踪',
};

const byPath = (a: GitChangeItem, b: GitChangeItem) =>
  a.entry.path.localeCompare(b.entry.path, undefined, { numeric: true, sensitivity: 'base' });

/**
 * Partition porcelain entries into the panel's sections. A file that is both
 * staged and modified again in the worktree (e.g. `MM`) appears in both
 * "staged" and "changes"; conflicts take precedence over everything else.
 */
export function groupGitStatusEntries(entries: readonly GitStatusFileEntry[]): GitChangeGroups {
  const groups: GitChangeGroups = { conflicts: [], staged: [], changes: [], untracked: [] };
  for (const entry of entries) {
    if (entry.conflicted) {
      groups.conflicts.push({ key: `conflicts:${entry.path}`, group: 'conflicts', entry, letter: '!' });
      continue;
    }
    if (entry.untracked) {
      groups.untracked.push({ key: `untracked:${entry.path}`, group: 'untracked', entry, letter: 'U' });
      continue;
    }
    if (entry.staged) {
      groups.staged.push({
        key: `staged:${entry.path}`,
        group: 'staged',
        entry,
        letter: normalizeLetter(entry.indexStatus),
      });
    }
    if (entry.unstaged) {
      groups.changes.push({
        key: `changes:${entry.path}`,
        group: 'changes',
        entry,
        letter: normalizeLetter(entry.worktreeStatus),
      });
    }
  }
  for (const id of GIT_CHANGE_GROUP_ORDER) groups[id].sort(byPath);
  return groups;
}

function normalizeLetter(code: string): string {
  const c = code.trim();
  return c && c !== '?' ? c : 'M';
}

const LETTER_LABELS: Record<string, string> = {
  M: '已修改',
  A: '已添加',
  D: '已删除',
  R: '已重命名',
  C: '已复制',
  T: '类型变更',
  U: '未跟踪',
  '!': '冲突',
};

export function gitStatusLetterLabel(letter: string): string {
  return LETTER_LABELS[letter] ?? letter;
}

/** CSS-friendly tone for a status letter. */
export function gitStatusTone(letter: string): 'added' | 'deleted' | 'modified' | 'renamed' | 'untracked' | 'conflict' {
  switch (letter) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
    case 'C':
      return 'renamed';
    case 'U':
      return 'untracked';
    case '!':
      return 'conflict';
    default:
      return 'modified';
  }
}

export function splitRepoPath(path: string): { name: string; dir: string } {
  const clean = path.replace(/\\/g, '/').replace(/\/+$/, '');
  const idx = clean.lastIndexOf('/');
  return idx < 0 ? { name: clean, dir: '' } : { name: clean.slice(idx + 1), dir: clean.slice(0, idx) };
}

/**
 * Per-path status decorations for the file tree. Directories inherit a dot
 * when any descendant has changes. Keys are repo-relative with '/'.
 */
export function buildTreeDecorations(entries: readonly GitStatusFileEntry[]): {
  files: Map<string, string>;
  dirs: Set<string>;
} {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  for (const entry of entries) {
    const letter = entry.conflicted
      ? '!'
      : entry.untracked
        ? 'U'
        : normalizeLetter(entry.unstaged ? entry.worktreeStatus : entry.indexStatus);
    const path = entry.path.replace(/\/+$/, '');
    files.set(path, letter);
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join('/'));
  }
  return { files, dirs };
}

export type DiffLineKind = 'file' | 'meta' | 'hunk' | 'add' | 'del' | 'context' | 'note';

export interface DiffLine {
  kind: DiffLineKind;
  text: string;
  oldLine: number | null;
  newLine: number | null;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parse `git diff` unified output into display rows with line numbers.
 * Hunk bodies are consumed by their declared line counts, so content lines
 * that happen to start with `+++`/`---`/`diff ` are never mistaken for headers.
 */
export function parseUnifiedDiff(diff: string): DiffLine[] {
  const rows: DiffLine[] = [];
  const lines = diff.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldLine = 0;
  let newLine = 0;
  let oldLeft = 0;
  let newLeft = 0;
  for (const line of lines) {
    if (oldLeft > 0 || newLeft > 0) {
      const sign = line[0];
      const body = line.slice(1);
      if (sign === '+') {
        rows.push({ kind: 'add', text: body, oldLine: null, newLine: newLine++ });
        newLeft--;
        continue;
      }
      if (sign === '-') {
        rows.push({ kind: 'del', text: body, oldLine: oldLine++, newLine: null });
        oldLeft--;
        continue;
      }
      if (sign === ' ' || line === '') {
        rows.push({ kind: 'context', text: body, oldLine: oldLine++, newLine: newLine++ });
        oldLeft--;
        newLeft--;
        continue;
      }
      if (sign === '\\') {
        rows.push({ kind: 'note', text: line, oldLine: null, newLine: null });
        continue;
      }
      oldLeft = 0;
      newLeft = 0;
    }
    if (line.startsWith('\\')) {
      rows.push({ kind: 'note', text: line, oldLine: null, newLine: null });
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      rows.push({ kind: 'hunk', text: line, oldLine: null, newLine: null });
      continue;
    }
    rows.push({ kind: line.startsWith('diff ') ? 'file' : 'meta', text: line, oldLine: null, newLine: null });
  }
  return rows;
}

export function countDiffStats(rows: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === 'add') added++;
    else if (row.kind === 'del') removed++;
  }
  return { added, removed };
}

function pathSep(path: string): '\\' | '/' {
  return /^[a-zA-Z]:[\\/]/.test(path) || (path.includes('\\') && !path.includes('/')) ? '\\' : '/';
}

function isWindowsLike(path: string): boolean {
  return /^[a-zA-Z]:/.test(path) || path.includes('\\');
}

function normalizeForCompare(path: string, windows: boolean): string {
  let p = path.replace(/[\\/]+/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  if (/^[a-zA-Z]:$/.test(p)) p += '/';
  return windows ? p.toLowerCase() : p;
}

/** True when `child` equals `parent` or lives below it. */
export function isPathInside(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const windows = isWindowsLike(parent) || isWindowsLike(child);
  const p = normalizeForCompare(parent, windows);
  const c = normalizeForCompare(child, windows);
  if (c === p) return true;
  return c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

export function isSamePath(a: string, b: string): boolean {
  return isPathInside(a, b) && isPathInside(b, a);
}

export function sanitizeBranchForPath(branch: string): string {
  return branch
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 80);
}

/** Default sibling folder for a new worktree: `<parent>/<repo>-<branch>`. */
export function suggestWorktreePath(rootPath: string, branch: string): string {
  const sep = pathSep(rootPath);
  const trimmed = rootPath.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  const parent = idx <= 0 ? trimmed : trimmed.slice(0, idx);
  const repoName = idx < 0 ? trimmed : trimmed.slice(idx + 1);
  const suffix = sanitizeBranchForPath(branch) || 'worktree';
  return `${parent}${sep}${repoName}-${suffix}`;
}

export function joinHostPath(parent: string, name: string): string {
  const sep = pathSep(parent);
  return `${parent.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** Light client-side check mirroring `git check-ref-format --branch`. */
export function validateBranchName(name: string): string | null {
  const n = name.trim();
  if (!n) return '分支名不能为空';
  if (/[\s~^:?*[\\\x00-\x1f\x7f]/.test(n)) return '分支名包含非法字符';
  if (n.startsWith('-') || n.startsWith('/') || n.endsWith('/') || n.endsWith('.')) return '分支名格式无效';
  if (n.includes('..') || n.includes('//') || n.includes('@{') || n === '@') return '分支名格式无效';
  if (n.endsWith('.lock') || n.split('/').some((part) => part.startsWith('.'))) return '分支名格式无效';
  return null;
}

/** IPC path arrays are capped at 500 entries per call. */
export function chunkPaths<T>(items: readonly T[], size = 500): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
