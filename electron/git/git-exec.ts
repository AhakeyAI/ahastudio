import { spawn } from 'node:child_process';
import { basename, isAbsolute, normalize, relative, resolve, sep } from 'node:path';
import { augmentedPath, resolveBinaryFromPath } from '../bin-resolve.js';
import { isUncOrDevicePath } from '../ipc/shell-pty.js';

const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;
const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
const WINDOWS_DRIVE_ABS_RE = /^[a-zA-Z]:[\\/]/;

let cachedGitBinary: string | null | undefined;

function getGitBinary(): string {
  if (cachedGitBinary === undefined) {
    cachedGitBinary = resolveBinaryFromPath('git');
  }
  return cachedGitBinary ?? 'git';
}

export function hasWindowsReservedDeviceSegment(candidate: string): boolean {
  if (process.platform !== 'win32') return false;
  const segments = candidate.split(/[\\/]/).filter(Boolean);
  for (const seg of segments) {
    const base = basename(seg).split(':')[0] ?? '';
    if (WINDOWS_DEVICE_RE.test(base)) {
      return true;
    }
  }
  return false;
}

export function hasAlternateDataStreamColon(candidate: string): boolean {
  if (process.platform !== 'win32') return false;
  const withoutDrive = candidate.replace(/^[a-zA-Z]:/, '');
  return withoutDrive.includes(':');
}

export interface GitCommandOptions {
  cwd: string;
  stdin?: string | Buffer;
  timeoutMs?: number;
  maxBytes?: number;
  readOnly?: boolean;
  env?: Record<string, string>;
}

export interface GitCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export function runGitCommand(args: string[], opts: GitCommandOptions): Promise<GitCommandResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const gitBin = getGitBinary();

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(gitBin, args, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        PATH: augmentedPath(),
        GIT_TERMINAL_PROMPT: '0',
        GCM_INTERACTIVE: 'never',
        LC_ALL: 'C.UTF-8',
        ...(opts.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
        ...(opts.env ?? {}),
      },
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let settled = false;
    let forceKillTimer: ReturnType<typeof setTimeout> | null = null;

    const killChild = () => {
      if (child.killed) return;
      try {
        child.kill('SIGTERM');
      } catch {
        // Ignore already-exited child errors.
      }
      forceKillTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // Ignore already-exited child errors.
        }
      }, 500);
      forceKillTimer.unref?.();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killChild();
      rejectPromise(new Error(`Git 命令超时 (${timeoutMs}ms): git ${args[0] ?? ''}`.trim()));
    }, timeoutMs);
    timer.unref?.();

    const cleanupTimers = () => {
      clearTimeout(timer);
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    child.stdout?.on('data', (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - stdoutBytes;
      if (remaining <= 0) {
        truncated = true;
        killChild();
        return;
      }
      if (chunk.length > remaining) {
        stdoutChunks.push(chunk.subarray(0, remaining));
        stdoutBytes += remaining;
        truncated = true;
        killChild();
        return;
      }
      stdoutChunks.push(chunk);
      stdoutBytes += chunk.length;
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const stderrCap = 256 * 1024;
      const remaining = stderrCap - stderrBytes;
      if (remaining <= 0) return;
      const slice = chunk.length > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrChunks.push(slice);
      stderrBytes += slice.length;
    });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      rejectPromise(error);
    });

    child.on('close', (exitCode) => {
      if (settled) return;
      settled = true;
      cleanupTimers();
      resolvePromise({
        exitCode,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
        truncated,
      });
    });

    child.stdin?.on('error', () => {
      // Ignore EPIPE when git exits early without consuming stdin.
    });
    if (opts.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

export function validateLocalDirectoryPath(rawPath: string): string | null {
  if (typeof rawPath !== 'string') return null;
  if (rawPath.includes('\0') || /[\r\n]/.test(rawPath)) return null;
  const trimmed = rawPath.trim();
  if (!trimmed || trimmed.length > 1024) return null;
  if (isUncOrDevicePath(trimmed) || trimmed.includes('://')) return null;
  if (hasWindowsReservedDeviceSegment(trimmed) || hasAlternateDataStreamColon(trimmed)) {
    return null;
  }
  if (process.platform === 'win32') {
    if (!WINDOWS_DRIVE_ABS_RE.test(trimmed)) return null;
  } else if (!isAbsolute(trimmed)) {
    return null;
  }
  return normalize(trimmed);
}

export function validateRepoRelativePath(rawPath: string, repoRoot: string): string | null {
  if (typeof rawPath !== 'string') return null;
  if (!rawPath || rawPath.length > 1024 || rawPath.includes('\0') || /[\r\n]/.test(rawPath)) {
    return null;
  }
  if (!rawPath.trim()) return null;
  if (isUncOrDevicePath(rawPath) || isAbsolute(rawPath) || /^[a-zA-Z]:/.test(rawPath)) {
    return null;
  }
  if (hasWindowsReservedDeviceSegment(rawPath) || hasAlternateDataStreamColon(rawPath)) {
    return null;
  }

  const resolvedRoot = resolve(repoRoot);
  const resolvedTarget = resolve(resolvedRoot, rawPath);
  const rel = relative(resolvedRoot, resolvedTarget);
  if (!rel || rel === '.' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return null;
  }

  const normalizedRel = rel.replace(/\\/g, '/');
  if (normalizedRel === '.git' || normalizedRel.startsWith('.git/')) {
    return null;
  }
  return normalizedRel;
}

export function validateGitRefName(rawRef: string): string | null {
  if (typeof rawRef !== 'string') return null;
  if (!rawRef || rawRef.length > 256) return null;
  if (rawRef !== rawRef.trim()) return null;
  if (rawRef.startsWith('-') || rawRef === '@') return null;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f\s]/.test(rawRef)) return null;
  if (rawRef.includes('..') || rawRef.includes('@{') || rawRef.includes('\\')) return null;
  if (/[~^:?*[\]]/.test(rawRef)) return null;
  if (rawRef.startsWith('/') || rawRef.endsWith('/') || rawRef.includes('//')) return null;
  if (rawRef.endsWith('.')) return null;

  const segments = rawRef.split('/');
  for (const segment of segments) {
    if (!segment || segment.startsWith('.') || segment.endsWith('.') || segment.endsWith('.lock')) {
      return null;
    }
  }
  return rawRef;
}
