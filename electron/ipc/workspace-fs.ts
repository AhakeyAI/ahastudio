import { lstat, open, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  hasAlternateDataStreamColon,
  hasWindowsReservedDeviceSegment,
  validateLocalDirectoryPath,
} from '../git/git-exec.js';
import type { IpcContext } from './context.js';
import { isUncOrDevicePath } from './shell-pty.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';

const MAX_SYMLINK_HOPS = 16;
const MAX_TREE_ENTRIES = 1000;
const DEFAULT_READ_MAX_BYTES = 256 * 1024;
const MAX_READ_MAX_BYTES = 2 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8192;
const WINDOWS_DRIVE_ABS_RE = /^[a-zA-Z]:[\\/]/;

export interface WorkspaceFsTreeEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: 'directory' | 'file';
  isSymlink: boolean;
}

export const workspaceFsListTreeSchema = z
  .object({
    rootPath: z.string().min(1).max(1024),
    relativePath: z.string().max(1024).optional(),
    showHidden: z.boolean().optional(),
  })
  .strict();

export const workspaceFsReadFileSchema = z
  .object({
    rootPath: z.string().min(1).max(1024),
    filePath: z.string().min(1).max(1024),
    maxBytes: z.number().int().min(1024).max(MAX_READ_MAX_BYTES).optional(),
  })
  .strict();

function normalizeForCompare(p: string): string {
  const n = normalize(p);
  return process.platform === 'win32' ? n.toLowerCase() : n;
}

function isInsideOrEqual(root: string, candidate: string, allowEqual: boolean): boolean {
  const rel = relative(normalizeForCompare(root), normalizeForCompare(candidate));
  if (rel === '') return allowEqual;
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function isSafeLocalToken(candidate: string): boolean {
  return (
    !isUncOrDevicePath(candidate) &&
    !hasWindowsReservedDeviceSegment(candidate) &&
    !hasAlternateDataStreamColon(candidate)
  );
}

async function assertSymlinkChainSafe(targetPath: string): Promise<void> {
  let current = targetPath;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    if (!isSafeLocalToken(current)) {
      throw new Error('已拦截指向网络或设备路径的符号链接');
    }
    const ls = await lstat(current);
    if (!ls.isSymbolicLink()) return;
    const rawTarget = await readlink(current);
    const next = isAbsolute(rawTarget) ? normalize(rawTarget) : resolve(dirname(current), rawTarget);
    if (!isSafeLocalToken(next)) {
      throw new Error('已拦截指向网络或设备路径的符号链接');
    }
    current = next;
  }
  throw new Error('符号链接层级过深');
}

async function resolveContainedWorkspacePath(
  rootPath: string,
  targetSubpath: string | undefined,
  opts: { allowRoot: boolean; requireRelativeSubpath: boolean },
): Promise<{ realRoot: string; realTarget: string; relativePath: string }> {
  const validRoot = validateLocalDirectoryPath(rootPath);
  if (!validRoot) {
    throw new Error('无效的工作区根目录路径');
  }

  await assertSymlinkChainSafe(validRoot);
  const realRoot = await realpath(validRoot);
  const rootStat = await stat(realRoot);
  if (!rootStat.isDirectory()) {
    throw new Error('工作区根目录不是文件夹');
  }

  if (targetSubpath === undefined || targetSubpath === '' || targetSubpath === '.') {
    if (!opts.allowRoot) {
      throw new Error('目标路径不能是工作区根目录');
    }
    return { realRoot, realTarget: realRoot, relativePath: '' };
  }

  if (
    targetSubpath.includes('\0') ||
    /[\r\n]/.test(targetSubpath) ||
    !targetSubpath.trim() ||
    !isSafeLocalToken(targetSubpath) ||
    targetSubpath.includes('://')
  ) {
    throw new Error('包含无效或不安全的目标路径');
  }

  if (opts.requireRelativeSubpath) {
    if (isAbsolute(targetSubpath) || /^[a-zA-Z]:/.test(targetSubpath)) {
      throw new Error('目录浏览只允许传入相对路径');
    }
  } else if (isAbsolute(targetSubpath) && process.platform === 'win32') {
    if (!WINDOWS_DRIVE_ABS_RE.test(targetSubpath.trim())) {
      throw new Error('无效的绝对文件路径');
    }
  }

  const candidatePath = isAbsolute(targetSubpath)
    ? normalize(targetSubpath)
    : resolve(validRoot, targetSubpath);

  const containedUnderValidRoot = isInsideOrEqual(validRoot, candidatePath, opts.allowRoot);
  const containedUnderRealRoot = isInsideOrEqual(realRoot, candidatePath, opts.allowRoot);
  if (!containedUnderValidRoot && !containedUnderRealRoot) {
    throw new Error('目标路径超出工作区范围');
  }

  const walkBase = containedUnderValidRoot ? validRoot : realRoot;
  const relSegments = relative(walkBase, candidatePath).split(sep).filter(Boolean);
  let walkCurrent = walkBase;
  for (const seg of relSegments) {
    walkCurrent = join(walkCurrent, seg);
    if (!isSafeLocalToken(walkCurrent)) {
      throw new Error('已拦截不安全的路径组件');
    }
    const ls = await lstat(walkCurrent);
    if (ls.isSymbolicLink()) {
      await assertSymlinkChainSafe(walkCurrent);
      const resolvedSeg = await realpath(walkCurrent);
      if (!isInsideOrEqual(realRoot, resolvedSeg, opts.allowRoot)) {
        throw new Error('目标路径通过符号链接逃逸出工作区');
      }
    }
  }

  const realTarget = await realpath(candidatePath);
  if (!isInsideOrEqual(realRoot, realTarget, opts.allowRoot)) {
    throw new Error('目标路径超出工作区范围');
  }

  const rel = relative(realRoot, realTarget).replace(/\\/g, '/');
  return {
    realRoot,
    realTarget,
    relativePath: rel,
  };
}

export async function listWorkspaceTree(opts: {
  rootPath: string;
  relativePath?: string;
  showHidden?: boolean;
}) {
  const { realRoot, realTarget, relativePath } = await resolveContainedWorkspacePath(
    opts.rootPath,
    opts.relativePath,
    { allowRoot: true, requireRelativeSubpath: true },
  );

  const targetStat = await stat(realTarget);
  if (!targetStat.isDirectory()) {
    return { ok: false as const, error: '目标路径不是文件夹' };
  }

  const dirents = await readdir(realTarget, { withFileTypes: true });
  const entries: WorkspaceFsTreeEntry[] = [];
  const showHidden = opts.showHidden === true;

  for (const dirent of dirents) {
    if (dirent.name === '.git') continue;
    if (!showHidden && dirent.name.startsWith('.')) continue;

    const fullPath = join(realTarget, dirent.name);
    let kind: 'directory' | 'file' | null = null;
    let isSymlink = false;
    let finalPath = fullPath;

    if (dirent.isDirectory()) {
      kind = 'directory';
    } else if (dirent.isFile()) {
      kind = 'file';
    } else if (dirent.isSymbolicLink()) {
      isSymlink = true;
      try {
        await assertSymlinkChainSafe(fullPath);
        const resolved = await realpath(fullPath);
        if (!isInsideOrEqual(realRoot, resolved, false)) {
          continue;
        }
        const st = await stat(resolved);
        if (st.isDirectory()) {
          kind = 'directory';
          finalPath = fullPath;
        } else if (st.isFile()) {
          kind = 'file';
          finalPath = fullPath;
        }
      } catch {
        continue;
      }
    }

    if (!kind) continue;
    const entryRel = relative(realRoot, finalPath).replace(/\\/g, '/');
    entries.push({
      name: dirent.name,
      path: finalPath,
      relativePath: entryRel,
      kind,
      isSymlink,
    });
  }

  entries.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === 'directory' ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  });

  const truncated = entries.length > MAX_TREE_ENTRIES;
  return {
    ok: true as const,
    rootPath: realRoot,
    relativePath,
    entries: truncated ? entries.slice(0, MAX_TREE_ENTRIES) : entries,
    truncated,
  };
}

export async function readWorkspaceFile(opts: {
  rootPath: string;
  filePath: string;
  maxBytes?: number;
}) {
  const { realTarget, relativePath } = await resolveContainedWorkspacePath(
    opts.rootPath,
    opts.filePath,
    { allowRoot: false, requireRelativeSubpath: false },
  );

  const fileStat = await stat(realTarget);
  if (!fileStat.isFile()) {
    return { ok: false as const, error: '目标不是普通文件' };
  }

  const maxBytes = opts.maxBytes ?? DEFAULT_READ_MAX_BYTES;
  const readCap = Math.min(maxBytes, fileStat.size);
  const buffer = Buffer.allocUnsafe(readCap);
  let totalRead = 0;

  if (readCap > 0) {
    const handle = await open(realTarget, 'r');
    try {
      while (totalRead < readCap) {
        const { bytesRead } = await handle.read(buffer, totalRead, readCap - totalRead, totalRead);
        if (bytesRead === 0) break;
        totalRead += bytesRead;
      }
    } finally {
      await handle.close();
    }
  }

  const view = buffer.subarray(0, totalRead);
  const probeLen = Math.min(totalRead, BINARY_SNIFF_BYTES);
  const binary = view.subarray(0, probeLen).includes(0);

  if (binary) {
    return {
      ok: true as const,
      path: realTarget,
      relativePath,
      binary: true,
      content: null,
      size: fileStat.size,
      truncated: false,
      mtimeMs: fileStat.mtimeMs,
    };
  }

  return {
    ok: true as const,
    path: realTarget,
    relativePath,
    binary: false,
    content: view.toString('utf8'),
    size: fileStat.size,
    truncated: fileStat.size > totalRead,
    mtimeMs: fileStat.mtimeMs,
  };
}

export function registerWorkspaceFsIpc(ctx: IpcContext): void {
  const authorize = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const authorizeError = 'Sender is not the main window';

  handleSecure('workspace-fs:list-tree', {
    schema: workspaceFsListTreeSchema,
    authorize,
    authorizeError,
    handler: (payload) => listWorkspaceTree(payload),
  });

  handleSecure('workspace-fs:read-file', {
    schema: workspaceFsReadFileSchema,
    authorize,
    authorizeError,
    handler: (payload) => readWorkspaceFile(payload),
  });
}
