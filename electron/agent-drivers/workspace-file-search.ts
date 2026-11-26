import { execFile } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

export interface WorkspaceFileMatch {
  /** Relative to the searched folder, with forward slashes. */
  path: string;
  fileName: string;
}

const MAX_MATCHES = 30;
const MAX_WALK_ENTRIES = 20_000;
const LIST_TTL_MS = 10_000;
const SKIPPED_DIRS = new Set(['.git', 'node_modules', 'dist', 'dist-electron', 'build', 'out', 'target', '.next', '.venv', '__pycache__']);

/** Git's own view (tracked plus untracked, minus ignored), so `@` never suggests ignored files. */
function gitFiles(cwd: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd, timeout: 5_000, maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => resolve(error ? null : stdout.split('\0').filter(Boolean)));
  });
}

async function walk(root: string): Promise<string[]> {
  const files: string[] = [];
  const queue = [root];
  let seen = 0;
  while (queue.length && seen < MAX_WALK_ENTRIES) {
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++seen > MAX_WALK_ENTRIES) break;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) queue.push(full);
      } else if (entry.isFile()) {
        files.push(relative(root, full));
      }
    }
  }
  return files;
}

/** Lower is better; null when the query does not match at all. */
export function scoreWorkspacePath(path: string, query: string): number | null {
  const lowerPath = path.toLowerCase();
  const name = lowerPath.slice(lowerPath.lastIndexOf('/') + 1);
  const q = query.toLowerCase().replace(/\\/gu, '/');
  if (!q) return 0;
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(q)) return 2;
  if (lowerPath.includes(q)) return 3;
  let at = 0;
  for (const char of q) {
    at = lowerPath.indexOf(char, at);
    if (at === -1) return null;
    at += 1;
  }
  return 4;
}

/** `@` file search for every session driver, rooted at the session's folder. */
export class WorkspaceFileSearch {
  private readonly lists = new Map<string, { at: number; files: Promise<string[]> }>();

  constructor(private readonly now: () => number = Date.now) {}

  async search(cwd: string, query: string, limit = MAX_MATCHES): Promise<WorkspaceFileMatch[]> {
    const files = await this.files(cwd);
    const ranked: { path: string; score: number }[] = [];
    for (const file of files) {
      const path = file.replace(/\\/gu, '/');
      const score = scoreWorkspacePath(path, query.trim());
      if (score !== null) ranked.push({ path, score });
    }
    ranked.sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path));
    return ranked.slice(0, limit).map(({ path }) => ({ path, fileName: path.slice(path.lastIndexOf('/') + 1) }));
  }

  private files(cwd: string): Promise<string[]> {
    const cached = this.lists.get(cwd);
    if (cached && this.now() - cached.at < LIST_TTL_MS) return cached.files;
    const files = gitFiles(cwd).then((listed) => listed ?? walk(cwd));
    this.lists.set(cwd, { at: this.now(), files });
    return files;
  }
}
