// Per-turn summary of changed files, built from the turn's own file_change records (no git).
// The directory tree is adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.),
// apps/web/src/lib/turnDiffTree.ts.
import type { WorkerTimelineFileChange, WorkerTimelineItem } from '../types';

export interface TurnChangePart {
  diff: string;
  change: WorkerTimelineFileChange['change'];
}

export interface TurnChangedFile {
  /** Path as the agent reported it; used to open the file. */
  path: string;
  /** Forward-slash path relative to the session folder when it is inside it, for display and the tree. */
  displayPath: string;
  change: WorkerTimelineFileChange['change'];
  movePath: string | null;
  added: number;
  removed: number;
  truncated: boolean;
  /** Every edit of the file in this turn, oldest first; each is shown as its own diff. */
  parts: TurnChangePart[];
}

export interface TurnChanges {
  files: TurnChangedFile[];
  added: number;
  removed: number;
}

const slash = (path: string) => path.replace(/\\/g, '/');

/** `path` relative to `cwd` when it lies inside it (case-insensitive for drive-letter paths). */
export function relativeToCwd(path: string, cwd: string | null | undefined): string {
  const file = slash(path);
  if (!cwd) return file.replace(/^\.\//, '');
  const root = slash(cwd).replace(/\/+$/, '');
  const fold = /^[a-z]:\//i.test(root) ? (value: string) => value.toLowerCase() : (value: string) => value;
  if (root && fold(file).startsWith(`${fold(root)}/`)) return file.slice(root.length + 1);
  return file.replace(/^\.\//, '');
}

/**
 * Merges the turn's applied file changes per file. A file the turn created and then deleted
 * nets out to nothing; declined and failed edits never touched the disk and are left out.
 */
export function summarizeTurnChanges(items: readonly WorkerTimelineItem[], cwd?: string | null): TurnChanges {
  const byPath = new Map<string, TurnChangedFile>();
  for (const item of items) {
    if (item.kind !== 'file_change' || item.status === 'declined' || item.status === 'failed') continue;
    for (const file of item.files) {
      const slashed = slash(file.path);
      const key = /^[a-z]:\//i.test(slashed) ? slashed.toLowerCase() : slashed;
      const existing = byPath.get(key);
      const part = { diff: file.diff, change: file.change };
      if (!existing) {
        byPath.set(key, {
          path: file.path, displayPath: relativeToCwd(file.movePath ?? file.path, cwd), change: file.change,
          movePath: file.movePath, added: file.added, removed: file.removed, truncated: file.truncated, parts: [part],
        });
        continue;
      }
      existing.change = existing.change === 'add'
        ? (file.change === 'delete' ? 'delete' : 'add')
        : file.change === 'delete' ? 'delete' : 'update';
      if (existing.change === 'delete' && existing.parts[0]?.change === 'add') {
        byPath.delete(key);
        continue;
      }
      if (file.movePath) {
        existing.movePath = file.movePath;
        existing.displayPath = relativeToCwd(file.movePath, cwd);
      }
      existing.added += file.added;
      existing.removed += file.removed;
      existing.truncated ||= file.truncated;
      existing.parts.push(part);
    }
  }
  const files = [...byPath.values()];
  return {
    files,
    added: files.reduce((sum, file) => sum + file.added, 0),
    removed: files.reduce((sum, file) => sum + file.removed, 0),
  };
}

export interface ChangeTreeStat { added: number; removed: number }

export type ChangeTreeNode =
  | { kind: 'directory'; name: string; path: string; stat: ChangeTreeStat; children: ChangeTreeNode[] }
  | { kind: 'file'; name: string; path: string; stat: ChangeTreeStat; file: TurnChangedFile };

interface MutableDirectory {
  name: string;
  path: string;
  stat: ChangeTreeStat;
  directories: Map<string, MutableDirectory>;
  files: Extract<ChangeTreeNode, { kind: 'file' }>[];
}

let collator: Intl.Collator | undefined;
const byName = (a: { name: string }, b: { name: string }) => {
  collator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  return collator.compare(a.name, b.name);
};

/** A directory with a single subdirectory and no files shows as one `a/b` row. */
function compact(node: Extract<ChangeTreeNode, { kind: 'directory' }>): Extract<ChangeTreeNode, { kind: 'directory' }> {
  let current = node;
  while (current.children.length === 1 && current.children[0]!.kind === 'directory') {
    const only = current.children[0] as Extract<ChangeTreeNode, { kind: 'directory' }>;
    current = { kind: 'directory', name: `${current.name}/${only.name}`, path: only.path, stat: only.stat, children: only.children };
  }
  return current;
}

function toNodes(directory: MutableDirectory): ChangeTreeNode[] {
  const directories = [...directory.directories.values()].sort(byName).map((child) => compact({
    kind: 'directory', name: child.name, path: child.path, stat: { ...child.stat }, children: toNodes(child),
  }));
  return [...directories, ...[...directory.files].sort(byName)];
}

/** Folders first, then files, each sorted by name; folder stats sum their files. */
export function buildChangeTree(files: readonly TurnChangedFile[]): ChangeTreeNode[] {
  const root: MutableDirectory = { name: '', path: '', stat: { added: 0, removed: 0 }, directories: new Map(), files: [] };
  for (const file of files) {
    const segments = file.displayPath.split('/').filter(Boolean);
    const name = segments.at(-1);
    if (!name) continue;
    const ancestors = [root];
    let current = root;
    for (const segment of segments.slice(0, -1)) {
      let next = current.directories.get(segment);
      if (!next) {
        next = { name: segment, path: current.path ? `${current.path}/${segment}` : segment, stat: { added: 0, removed: 0 }, directories: new Map(), files: [] };
        current.directories.set(segment, next);
      }
      current = next;
      ancestors.push(current);
    }
    current.files.push({ kind: 'file', name, path: segments.join('/'), stat: { added: file.added, removed: file.removed }, file });
    for (const ancestor of ancestors) {
      ancestor.stat.added += file.added;
      ancestor.stat.removed += file.removed;
    }
  }
  return toNodes(root);
}

/** 999 → "999", 1234 → "1.2k", 45_600 → "46k". */
export function formatDiffCount(value: number): string {
  if (value < 1000) return String(value);
  if (value < 999_500) {
    const k = value / 1000;
    return `${k < 10 ? k.toFixed(1).replace(/\.0$/, '') : Math.round(k)}k`;
  }
  const m = value / 1_000_000;
  return `${m < 10 ? m.toFixed(1).replace(/\.0$/, '') : Math.round(m)}m`;
}
