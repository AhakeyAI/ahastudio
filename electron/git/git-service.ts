import { lstat, mkdir, readlink, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, relative, resolve, sep } from 'node:path';
import { isUncOrDevicePath } from '../ipc/shell-pty.js';
import {
  hasAlternateDataStreamColon,
  hasWindowsReservedDeviceSegment,
  runGitCommand,
  validateGitRefName,
  validateLocalDirectoryPath,
  validateRepoRelativePath,
} from './git-exec.js';
import {
  type GitStatusFileEntry,
  type GitWorktreeEntry,
  parsePorcelainV1Status,
  parseWorktreeListPorcelain,
} from './porcelain-parser.js';

const MAX_DIFF_BYTES = 512 * 1024;
const MAX_SYMLINK_HOPS = 16;
const PATHSPEC_CHUNK_SIZE = 100;

export interface GitInspectResult {
  ok: true;
  isGitRepo: boolean;
  cwd: string;
  rootPath: string | null;
  commonDir: string | null;
  gitDir: string | null;
  head: string | null;
  branch: string | null;
}

export interface GitStatusResult {
  ok: true;
  isGitRepo: boolean;
  rootPath: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  detached: boolean;
  head: string | null;
  entries: GitStatusFileEntry[];
}

export interface GitDiffResult {
  ok: true;
  diff: string;
  truncated: boolean;
  staged: boolean;
  path: string | null;
}

export interface GitBranchInfo {
  name: string;
  refName: string;
  kind: 'local' | 'remote';
  current: boolean;
  commit: string;
  upstream: string | null;
}

export interface GitBranchesResult {
  ok: true;
  isGitRepo: boolean;
  currentBranch: string | null;
  branches: GitBranchInfo[];
}

export interface GitWorktreeListResult {
  ok: true;
  isGitRepo: boolean;
  worktrees: GitWorktreeEntry[];
}

export interface GitErrorResult {
  ok: false;
  error: string;
}

function isSamePath(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  return process.platform === 'win32' ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function isInsideOrEqual(root: string, candidate: string): boolean {
  const normRoot = process.platform === 'win32' ? normalize(root).toLowerCase() : normalize(root);
  const normCandidate =
    process.platform === 'win32' ? normalize(candidate).toLowerCase() : normalize(candidate);
  const rel = relative(normRoot, normCandidate);
  return (
    rel === '' ||
    (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
  );
}

function isSafeFilesystemTarget(candidate: string): boolean {
  return (
    !isUncOrDevicePath(candidate) &&
    !hasWindowsReservedDeviceSegment(candidate) &&
    !hasAlternateDataStreamColon(candidate)
  );
}

async function assertSymlinkChainSafe(targetPath: string): Promise<void> {
  let current = targetPath;
  for (let hop = 0; hop < MAX_SYMLINK_HOPS; hop++) {
    if (!isSafeFilesystemTarget(current)) {
      throw new Error('已拦截指向网络或设备路径的符号链接');
    }
    const ls = await lstat(current);
    if (!ls.isSymbolicLink()) return;
    const rawTarget = await readlink(current);
    const next = isAbsolute(rawTarget) ? normalize(rawTarget) : resolve(dirname(current), rawTarget);
    if (!isSafeFilesystemTarget(next)) {
      throw new Error('已拦截指向网络或设备路径的符号链接');
    }
    current = next;
  }
  throw new Error('符号链接层级过深');
}

async function assertRelPathContainedInWorktree(
  rootPath: string,
  relPath: string,
  opts: { allowSymlinkLeaf: boolean },
): Promise<void> {
  const realRoot = await realpath(rootPath);
  const segments = relPath.split('/').filter(Boolean);
  let current = rootPath;

  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!);
    let ls;
    try {
      ls = await lstat(current);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw err;
    }
    const isLeaf = i === segments.length - 1;
    if (ls.isSymbolicLink()) {
      await assertSymlinkChainSafe(current);
      if (isLeaf && opts.allowSymlinkLeaf) {
        return;
      }
      const realCurrent = await realpath(current);
      if (!isInsideOrEqual(realRoot, realCurrent)) {
        throw new Error(`路径 "${relPath}" 通过符号链接逃逸出工作区`);
      }
    }
  }

  try {
    await lstat(current);
    const realTarget = await realpath(current);
    if (!isInsideOrEqual(realRoot, realTarget)) {
      throw new Error(`路径 "${relPath}" 超出工作区边界`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }
}

async function runChunkedGitArgs(
  prefixArgs: string[],
  paths: string[],
  cwd: string,
): Promise<{ ok: true } | GitErrorResult> {
  for (let i = 0; i < paths.length; i += PATHSPEC_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + PATHSPEC_CHUNK_SIZE);
    const res = await runGitCommand(['--literal-pathspecs', ...prefixArgs, ...chunk], { cwd });
    if (res.exitCode !== 0) {
      return {
        ok: false,
        error: res.stderr.trim() || res.stdout.trim() || 'Git 命令执行失败',
      };
    }
  }
  return { ok: true };
}

function isUnsupportedPathFormatError(stderr: string): boolean {
  const lower = stderr.toLowerCase();
  return lower.includes('path-format') || lower.includes('unrecognized') || lower.includes('usage:');
}

export async function inspectGitRepo(cwd: string): Promise<GitInspectResult | GitErrorResult> {
  const validCwd = validateLocalDirectoryPath(cwd);
  if (!validCwd) {
    return { ok: false, error: '无效的工作目录路径' };
  }

  let cwdStat;
  try {
    await assertSymlinkChainSafe(validCwd);
    cwdStat = await stat(validCwd);
  } catch {
    return { ok: false, error: '工作目录不存在或不可访问' };
  }
  if (!cwdStat.isDirectory()) {
    return { ok: false, error: '工作目录不是文件夹' };
  }

  let revRes = await runGitCommand(
    ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir'],
    { cwd: validCwd, readOnly: true },
  );
  if (revRes.exitCode !== 0 && isUnsupportedPathFormatError(revRes.stderr)) {
    revRes = await runGitCommand(
      ['rev-parse', '--show-toplevel', '--git-common-dir', '--git-dir'],
      { cwd: validCwd, readOnly: true },
    );
  }

  if (revRes.exitCode !== 0) {
    return {
      ok: true,
      isGitRepo: false,
      cwd: validCwd,
      rootPath: null,
      commonDir: null,
      gitDir: null,
      head: null,
      branch: null,
    };
  }

  const lines = revRes.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('-'));
  if (lines.length < 3) {
    return {
      ok: true,
      isGitRepo: false,
      cwd: validCwd,
      rootPath: null,
      commonDir: null,
      gitDir: null,
      head: null,
      branch: null,
    };
  }

  const [rawTop, rawCommon, rawGitDir] = lines.slice(-3);
  const rootPath = resolve(validCwd, rawTop!);
  const commonDir = resolve(validCwd, rawCommon!);
  const gitDir = resolve(validCwd, rawGitDir!);

  const [headRes, branchRes] = await Promise.all([
    runGitCommand(['rev-parse', '--short', 'HEAD'], { cwd: rootPath, readOnly: true }),
    runGitCommand(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: rootPath, readOnly: true }),
  ]);

  const head = headRes.exitCode === 0 ? headRes.stdout.trim() || null : null;
  const branch = branchRes.exitCode === 0 ? branchRes.stdout.trim() || null : null;

  return {
    ok: true,
    isGitRepo: true,
    cwd: validCwd,
    rootPath,
    commonDir,
    gitDir,
    head,
    branch,
  };
}

export async function getGitStatus(cwd: string): Promise<GitStatusResult | GitErrorResult> {
  const inspected = await inspectGitRepo(cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return {
      ok: true,
      isGitRepo: false,
      rootPath: null,
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      detached: false,
      head: null,
      entries: [],
    };
  }

  const res = await runGitCommand(
    ['-c', 'core.quotePath=false', 'status', '--porcelain=v1', '-z', '-b', '-uall'],
    { cwd: inspected.rootPath, readOnly: true },
  );
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || '读取 Git 状态失败' };
  }

  const parsed = parsePorcelainV1Status(res.stdout);
  return {
    ok: true,
    isGitRepo: true,
    rootPath: inspected.rootPath,
    branch: parsed.branch ?? inspected.branch,
    upstream: parsed.upstream,
    ahead: parsed.ahead,
    behind: parsed.behind,
    detached: parsed.detached,
    head: inspected.head,
    entries: parsed.entries,
  };
}

export async function getGitDiff(opts: {
  cwd: string;
  path?: string;
  staged?: boolean;
  contextLines?: number;
}): Promise<GitDiffResult | GitErrorResult> {
  const inspected = await inspectGitRepo(opts.cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return { ok: false, error: '当前目录不是 Git 仓库' };
  }

  const rootPath = inspected.rootPath;
  let relPath: string | null = null;
  if (opts.path !== undefined && opts.path !== '') {
    relPath = validateRepoRelativePath(opts.path, rootPath);
    if (!relPath) {
      return { ok: false, error: '无效的仓库相对路径' };
    }
    await assertRelPathContainedInWorktree(rootPath, relPath, { allowSymlinkLeaf: false });
  }

  const contextLines = opts.contextLines ?? 3;
  const args = ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-color', `-U${contextLines}`];
  if (opts.staged) {
    args.push('--cached');
  }
  args.push('--');
  if (relPath) {
    args.push(relPath);
  }

  const res = await runGitCommand(args, {
    cwd: rootPath,
    readOnly: true,
    maxBytes: MAX_DIFF_BYTES,
  });
  if (!res.truncated && res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || '获取 Diff 失败' };
  }

  if (!opts.staged && relPath && !res.stdout && !res.truncated) {
    const untrackedCheck = await runGitCommand(
      ['--literal-pathspecs', 'ls-files', '--others', '--exclude-standard', '--', relPath],
      { cwd: rootPath, readOnly: true },
    );
    if (untrackedCheck.exitCode === 0 && untrackedCheck.stdout.trim().length > 0) {
      const targetStat = await stat(resolve(rootPath, relPath)).catch(() => null);
      if (targetStat?.isFile()) {
        const noIndexRes = await runGitCommand(
          ['diff', '--no-index', '--no-ext-diff', '--no-color', `-U${contextLines}`, '--', '/dev/null', relPath],
          { cwd: rootPath, readOnly: true, maxBytes: MAX_DIFF_BYTES },
        );
        if (!noIndexRes.truncated && noIndexRes.exitCode !== 0 && noIndexRes.exitCode !== 1) {
          return { ok: false, error: noIndexRes.stderr.trim() || '获取未跟踪文件 Diff 失败' };
        }
        return {
          ok: true,
          diff: noIndexRes.stdout,
          truncated: noIndexRes.truncated,
          staged: false,
          path: relPath,
        };
      }
    }
  }

  return {
    ok: true,
    diff: res.stdout,
    truncated: res.truncated,
    staged: Boolean(opts.staged),
    path: relPath,
  };
}

export async function stageGitPaths(opts: {
  cwd: string;
  paths?: string[];
  all?: boolean;
}): Promise<{ ok: true } | GitErrorResult> {
  const inspected = await inspectGitRepo(opts.cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return { ok: false, error: '当前目录不是 Git 仓库' };
  }
  const rootPath = inspected.rootPath;

  if (opts.all === true) {
    const res = await runGitCommand(['add', '-A'], { cwd: rootPath });
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.trim() || '暂存全部更改失败' };
    }
    return { ok: true };
  }

  const rawPaths = opts.paths ?? [];
  if (rawPaths.length === 0) {
    return { ok: false, error: '请提供要暂存的文件路径，或指定 all: true' };
  }

  const validated: string[] = [];
  for (const p of rawPaths) {
    const rel = validateRepoRelativePath(p, rootPath);
    if (!rel) return { ok: false, error: `包含无效的文件路径: ${p}` };
    validated.push(rel);
  }

  return runChunkedGitArgs(['add', '--'], validated, rootPath);
}

export async function unstageGitPaths(opts: {
  cwd: string;
  paths?: string[];
  all?: boolean;
}): Promise<{ ok: true } | GitErrorResult> {
  const inspected = await inspectGitRepo(opts.cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return { ok: false, error: '当前目录不是 Git 仓库' };
  }
  const rootPath = inspected.rootPath;

  if (opts.all === true) {
    const res = await runGitCommand(['reset', '--quiet'], { cwd: rootPath });
    if (res.exitCode !== 0) {
      return { ok: false, error: res.stderr.trim() || '取消暂存全部更改失败' };
    }
    return { ok: true };
  }

  const rawPaths = opts.paths ?? [];
  if (rawPaths.length === 0) {
    return { ok: false, error: '请提供要取消暂存的文件路径，或指定 all: true' };
  }

  const validated: string[] = [];
  for (const p of rawPaths) {
    const rel = validateRepoRelativePath(p, rootPath);
    if (!rel) return { ok: false, error: `包含无效的文件路径: ${p}` };
    validated.push(rel);
  }

  return runChunkedGitArgs(['reset', '--quiet', '--'], validated, rootPath);
}

export async function discardGitPaths(opts: {
  cwd: string;
  paths: string[];
}): Promise<{ ok: true; restored: string[]; removed: string[] } | GitErrorResult> {
  const inspected = await inspectGitRepo(opts.cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return { ok: false, error: '当前目录不是 Git 仓库' };
  }
  const rootPath = inspected.rootPath;

  if (!opts.paths || opts.paths.length === 0) {
    return { ok: false, error: '请提供要丢弃更改的文件路径' };
  }

  const validated: string[] = [];
  for (const p of opts.paths) {
    const rel = validateRepoRelativePath(p, rootPath);
    if (!rel) return { ok: false, error: `包含无效的文件路径: ${p}` };
    await assertRelPathContainedInWorktree(rootPath, rel, { allowSymlinkLeaf: true });
    validated.push(rel);
  }

  const trackedSet = new Set<string>();
  for (let i = 0; i < validated.length; i += PATHSPEC_CHUNK_SIZE) {
    const chunk = validated.slice(i, i + PATHSPEC_CHUNK_SIZE);
    const lsRes = await runGitCommand(['--literal-pathspecs', 'ls-files', '-z', '--', ...chunk], {
      cwd: rootPath,
      readOnly: true,
    });
    if (lsRes.exitCode !== 0) {
      return { ok: false, error: lsRes.stderr.trim() || '检查文件跟踪状态失败' };
    }
    for (const trackedPath of lsRes.stdout.split('\0')) {
      if (trackedPath) {
        trackedSet.add(trackedPath.replace(/\\/g, '/'));
      }
    }
  }

  const trackedPaths: string[] = [];
  const untrackedPaths: string[] = [];
  for (const rel of validated) {
    if (trackedSet.has(rel)) {
      trackedPaths.push(rel);
    } else {
      untrackedPaths.push(rel);
    }
  }

  if (trackedPaths.length > 0) {
    for (let i = 0; i < trackedPaths.length; i += PATHSPEC_CHUNK_SIZE) {
      const chunk = trackedPaths.slice(i, i + PATHSPEC_CHUNK_SIZE);
      let res = await runGitCommand(['--literal-pathspecs', 'restore', '--worktree', '--', ...chunk], {
        cwd: rootPath,
      });
      if (
        res.exitCode !== 0 &&
        res.stderr.toLowerCase().includes('not a git command')
      ) {
        res = await runGitCommand(['--literal-pathspecs', 'checkout', '--', ...chunk], {
          cwd: rootPath,
        });
      }
      if (res.exitCode !== 0) {
        return { ok: false, error: res.stderr.trim() || '恢复已跟踪文件失败' };
      }
    }
  }

  if (untrackedPaths.length > 0) {
    for (const rel of untrackedPaths) {
      await assertRelPathContainedInWorktree(rootPath, rel, { allowSymlinkLeaf: true });
    }
    const cleanRes = await runChunkedGitArgs(['clean', '-ffdx', '--'], untrackedPaths, rootPath);
    if (!cleanRes.ok) return cleanRes;
  }

  return { ok: true, restored: trackedPaths, removed: untrackedPaths };
}

export async function commitGitChanges(opts: {
  cwd: string;
  message: string;
  amend?: boolean;
}): Promise<{ ok: true; commitHash: string | null; branch: string | null } | GitErrorResult> {
  const inspected = await inspectGitRepo(opts.cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return { ok: false, error: '当前目录不是 Git 仓库' };
  }
  const rootPath = inspected.rootPath;

  if (!opts.message.trim()) {
    return { ok: false, error: '提交说明不能为空' };
  }

  const args = ['commit', '-F', '-'];
  if (opts.amend) {
    args.push('--amend');
  }

  const res = await runGitCommand(args, { cwd: rootPath, stdin: opts.message });
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || 'Git 提交失败' };
  }

  const [headRes, branchRes] = await Promise.all([
    runGitCommand(['rev-parse', '--short', 'HEAD'], { cwd: rootPath, readOnly: true }),
    runGitCommand(['symbolic-ref', '--quiet', '--short', 'HEAD'], { cwd: rootPath, readOnly: true }),
  ]);

  return {
    ok: true,
    commitHash: headRes.exitCode === 0 ? headRes.stdout.trim() || null : null,
    branch: branchRes.exitCode === 0 ? branchRes.stdout.trim() || null : null,
  };
}

export async function listGitBranches(cwd: string): Promise<GitBranchesResult | GitErrorResult> {
  const inspected = await inspectGitRepo(cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return {
      ok: true,
      isGitRepo: false,
      currentBranch: null,
      branches: [],
    };
  }

  const res = await runGitCommand(
    [
      'for-each-ref',
      '--format=%(refname)%09%(refname:short)%09%(objectname:short)%09%(upstream:short)%09%(HEAD)%09%(symref)',
      'refs/heads',
      'refs/remotes',
    ],
    { cwd: inspected.rootPath, readOnly: true },
  );
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || '获取分支列表失败' };
  }

  const branches: GitBranchInfo[] = [];
  for (const line of res.stdout.split(/\r?\n/)) {
    if (!line) continue;
    const [refName = '', name = '', commit = '', upstream = '', headMark = '', symref = ''] =
      line.split('\t');
    if (!refName || !name) continue;
    if (symref && refName.startsWith('refs/remotes/')) continue;

    branches.push({
      name,
      refName,
      kind: refName.startsWith('refs/heads/') ? 'local' : 'remote',
      current: headMark === '*',
      commit,
      upstream: upstream || null,
    });
  }

  return {
    ok: true,
    isGitRepo: true,
    currentBranch: inspected.branch,
    branches,
  };
}

export async function checkoutGitBranch(opts: {
  cwd: string;
  branch: string;
  create?: boolean;
  startPoint?: string;
}): Promise<{ ok: true } | GitErrorResult> {
  const inspected = await inspectGitRepo(opts.cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return { ok: false, error: '当前目录不是 Git 仓库' };
  }

  const validBranch = validateGitRefName(opts.branch);
  if (!validBranch) {
    return { ok: false, error: '无效的分支名称' };
  }

  let validStartPoint: string | null = null;
  if (opts.startPoint !== undefined && opts.startPoint !== '') {
    validStartPoint = validateGitRefName(opts.startPoint);
    if (!validStartPoint) {
      return { ok: false, error: '无效的起始分支或提交引用' };
    }
  }

  const args = opts.create
    ? ['checkout', '-b', validBranch, ...(validStartPoint ? [validStartPoint] : [])]
    : ['checkout', validBranch, '--'];

  const res = await runGitCommand(args, { cwd: inspected.rootPath });
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || '切换分支失败' };
  }
  return { ok: true };
}

export async function listGitWorktrees(cwd: string): Promise<GitWorktreeListResult | GitErrorResult> {
  const inspected = await inspectGitRepo(cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return {
      ok: true,
      isGitRepo: false,
      worktrees: [],
    };
  }

  let res = await runGitCommand(['worktree', 'list', '--porcelain', '-z'], {
    cwd: inspected.rootPath,
    readOnly: true,
  });
  if (res.exitCode !== 0) {
    const lower = res.stderr.toLowerCase();
    if (lower.includes('unknown') || lower.includes('usage:') || lower.includes('-z')) {
      res = await runGitCommand(['worktree', 'list', '--porcelain'], {
        cwd: inspected.rootPath,
        readOnly: true,
      });
    }
  }
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || '获取 Worktree 列表失败' };
  }

  const worktrees = parseWorktreeListPorcelain(res.stdout).map((wt) => ({
    ...wt,
    path: resolve(wt.path),
  }));

  return {
    ok: true,
    isGitRepo: true,
    worktrees,
  };
}

export async function addGitWorktree(opts: {
  cwd: string;
  worktreePath: string;
  branch?: string;
  newBranch?: string;
  startPoint?: string;
  detach?: boolean;
}): Promise<{ ok: true; path: string } | GitErrorResult> {
  const inspected = await inspectGitRepo(opts.cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return { ok: false, error: '当前目录不是 Git 仓库' };
  }

  const validWorktreePath = validateLocalDirectoryPath(opts.worktreePath);
  if (!validWorktreePath) {
    return { ok: false, error: '无效的 Worktree 目标路径' };
  }

  if (opts.branch && opts.newBranch) {
    return { ok: false, error: 'branch 与 newBranch 不能同时指定' };
  }

  let validBranch: string | null = null;
  if (opts.branch !== undefined && opts.branch !== '') {
    validBranch = validateGitRefName(opts.branch);
    if (!validBranch) return { ok: false, error: '无效的分支名称' };
  }

  let validNewBranch: string | null = null;
  if (opts.newBranch !== undefined && opts.newBranch !== '') {
    validNewBranch = validateGitRefName(opts.newBranch);
    if (!validNewBranch) return { ok: false, error: '无效的新建分支名称' };
  }

  let validStartPoint: string | null = null;
  if (opts.startPoint !== undefined && opts.startPoint !== '') {
    validStartPoint = validateGitRefName(opts.startPoint);
    if (!validStartPoint) return { ok: false, error: '无效的起始引用' };
  }

  const parentDir = dirname(validWorktreePath);
  try {
    await mkdir(parentDir, { recursive: true });
    await assertSymlinkChainSafe(parentDir);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : '无法准备 Worktree 父目录',
    };
  }

  const args = ['worktree', 'add'];
  if (opts.detach) {
    args.push('--detach');
  }
  if (validNewBranch) {
    args.push('-b', validNewBranch);
  }
  args.push(validWorktreePath);

  if (opts.detach) {
    if (validStartPoint ?? validBranch) {
      args.push((validStartPoint ?? validBranch)!);
    }
  } else if (validNewBranch) {
    if (validStartPoint) {
      args.push(validStartPoint);
    }
  } else if (validBranch) {
    args.push(validBranch);
  }

  const res = await runGitCommand(args, {
    cwd: inspected.rootPath,
    timeoutMs: 60_000,
  });
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || '创建 Worktree 失败' };
  }

  return { ok: true, path: validWorktreePath };
}

export async function removeGitWorktree(opts: {
  cwd: string;
  worktreePath: string;
  force?: boolean;
}): Promise<{ ok: true; path: string } | GitErrorResult> {
  const inspected = await inspectGitRepo(opts.cwd);
  if (!inspected.ok) return inspected;
  if (!inspected.isGitRepo || !inspected.rootPath) {
    return { ok: false, error: '当前目录不是 Git 仓库' };
  }

  const validWorktreePath = validateLocalDirectoryPath(opts.worktreePath);
  if (!validWorktreePath) {
    return { ok: false, error: '无效的 Worktree 路径' };
  }

  const listed = await listGitWorktrees(inspected.rootPath);
  if (!listed.ok) return listed;

  const matched = listed.worktrees.find((wt) => isSamePath(wt.path, validWorktreePath));
  if (!matched) {
    return { ok: false, error: '目标路径不是当前仓库已注册的 Worktree' };
  }
  if (matched.isMainWorktree) {
    return { ok: false, error: '不能移除主工作区 (main worktree)' };
  }

  const mainWorktree = listed.worktrees.find((wt) => wt.isMainWorktree);
  const execCwd = mainWorktree?.path ?? inspected.rootPath;

  const args = ['worktree', 'remove'];
  if (opts.force) {
    args.push('--force');
    if (matched.locked) {
      // Git requires `-f -f` (`--force --force`) to override a locked worktree.
      args.push('--force');
    }
  }
  args.push('--', matched.path);

  const res = await runGitCommand(args, { cwd: execCwd, timeoutMs: 30_000 });
  if (res.exitCode !== 0) {
    return { ok: false, error: res.stderr.trim() || res.stdout.trim() || '移除 Worktree 失败' };
  }

  return { ok: true, path: matched.path };
}
