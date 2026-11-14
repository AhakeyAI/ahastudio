import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, win32 as pathWin32 } from 'node:path';
import { getBashIntegrationRcfileContent, getZshIntegrationZshenvContent } from './posix-bootstrap.js';
import {
  getPowerShellOsc133EncodedCommand,
  isPowerShellExecutableName,
} from './powershell-bootstrap.js';

const SHELL_WRAPPER_DIR_MARKER = 'ahastation-shell-integration';

const preparedDirs = new Set<string>();

function assertSafeExistingEntry(targetPath: string, expectedKind: 'dir' | 'file'): void {
  let stats;
  try {
    stats = lstatSync(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  if (stats.isSymbolicLink()) {
    throw new Error(`Refusing symlink shell integration path: ${targetPath}`);
  }
  if (expectedKind === 'dir' && !stats.isDirectory()) {
    throw new Error(`Expected directory for shell integration path: ${targetPath}`);
  }
  if (expectedKind === 'file' && !stats.isFile()) {
    throw new Error(`Expected file for shell integration path: ${targetPath}`);
  }
  if (process.platform !== 'win32' && typeof process.getuid === 'function') {
    if (stats.uid !== process.getuid()) {
      throw new Error(`Untrusted owner for shell integration path: ${targetPath}`);
    }
  }
}

function writeIfChanged(filePath: string, content: string): void {
  assertSafeExistingEntry(filePath, 'file');
  try {
    if (readFileSync(filePath, 'utf8') === content) return;
  } catch {
    // Missing or unreadable file: write below.
  }
  writeFileSync(filePath, content, { encoding: 'utf8', mode: 0o600 });
  if (process.platform !== 'win32') {
    chmodSync(filePath, 0o600);
  }
}

export function resolveDefaultShellIntegrationDir(): string {
  if (process.platform === 'win32') {
    // %TEMP% is user-writable and predictable; callers must pass an app-private directory.
    throw new Error('A private wrapperBaseDir is required on Windows');
  }
  const runtimeDir = process.env.XDG_RUNTIME_DIR?.trim();
  if (runtimeDir) {
    return join(runtimeDir, SHELL_WRAPPER_DIR_MARKER);
  }
  return join(homedir(), '.cache', SHELL_WRAPPER_DIR_MARKER);
}

export function ensureShellIntegrationFiles(baseDir = resolveDefaultShellIntegrationDir()): {
  bashRcPath: string;
  zshWrapperDir: string;
} {
  const bashDir = join(baseDir, 'bash');
  const zshDir = join(baseDir, 'zsh');
  const bashRcPath = join(bashDir, 'rcfile');
  const zshEnvPath = join(zshDir, '.zshenv');

  assertSafeExistingEntry(baseDir, 'dir');
  assertSafeExistingEntry(bashDir, 'dir');
  assertSafeExistingEntry(zshDir, 'dir');
  assertSafeExistingEntry(bashRcPath, 'file');
  assertSafeExistingEntry(zshEnvPath, 'file');

  if (!preparedDirs.has(baseDir) || !existsSync(bashRcPath) || !existsSync(zshEnvPath)) {
    mkdirSync(baseDir, { recursive: true, mode: 0o700 });
    mkdirSync(bashDir, { recursive: true, mode: 0o700 });
    mkdirSync(zshDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') {
      chmodSync(baseDir, 0o700);
      chmodSync(bashDir, 0o700);
      chmodSync(zshDir, 0o700);
    }
    assertSafeExistingEntry(baseDir, 'dir');
    assertSafeExistingEntry(bashDir, 'dir');
    assertSafeExistingEntry(zshDir, 'dir');
    writeIfChanged(bashRcPath, getBashIntegrationRcfileContent());
    writeIfChanged(zshEnvPath, getZshIntegrationZshenvContent(SHELL_WRAPPER_DIR_MARKER));
    preparedDirs.add(baseDir);
  }

  return { bashRcPath, zshWrapperDir: zshDir };
}

function normalizedShellName(file: string): string {
  return pathWin32.basename(basename(file)).toLowerCase();
}

function hasNonInteractiveShellFlags(args: readonly string[]): boolean {
  return args.some((arg) => {
    const lower = arg.toLowerCase();
    return (
      lower === '-c' ||
      lower === '-command' ||
      lower === '-encodedcommand' ||
      lower === '-e' ||
      lower === '-file' ||
      lower === '-f' ||
      lower === '--noprofile' ||
      lower === '--rcfile' ||
      lower === '--init-file'
    );
  });
}

function readEnvCaseInsensitive(env: Record<string, string | undefined>, key: string): string | undefined {
  if (key in env) return env[key];
  const lower = key.toLowerCase();
  for (const [k, v] of Object.entries(env)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export interface ShellIntegrationInput {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
  cliId?: string | null;
  wrapperBaseDir?: string;
}

export interface ShellIntegrationResult {
  file: string;
  args: string[];
  env: Record<string, string | undefined>;
  integrated: boolean;
}

/**
 * Wraps interactive shell launches (PowerShell, Bash, Zsh) with OSC 7 / OSC 133 hooks
 * while leaving explicit AI CLI launches (codex/claude/antigravity/etc.) completely untouched.
 */
export function applyShellIntegration(input: ShellIntegrationInput): ShellIntegrationResult {
  const isExplicitCli = Boolean(input.cliId && input.cliId !== 'shell');
  if (isExplicitCli || hasNonInteractiveShellFlags(input.args)) {
    return {
      file: input.file,
      args: [...input.args],
      env: { ...input.env },
      integrated: false,
    };
  }

  const shellName = normalizedShellName(input.file);
  if (isPowerShellExecutableName(shellName)) {
    return {
      file: input.file,
      args: ['-NoLogo', '-NoExit', '-EncodedCommand', getPowerShellOsc133EncodedCommand()],
      env: { ...input.env },
      integrated: true,
    };
  }

  if (shellName === 'bash' || shellName === 'bash.exe') {
    try {
      const { bashRcPath } = ensureShellIntegrationFiles(input.wrapperBaseDir);
      return {
        file: input.file,
        args: ['--rcfile', bashRcPath, '-i'],
        env: { ...input.env },
        integrated: true,
      };
    } catch {
      return {
        file: input.file,
        args: [...input.args],
        env: { ...input.env },
        integrated: false,
      };
    }
  }

  if (shellName === 'zsh' || shellName === 'zsh.exe') {
    try {
      const { zshWrapperDir } = ensureShellIntegrationFiles(input.wrapperBaseDir);
      const nextEnv = { ...input.env };
      const existingZdotdir = readEnvCaseInsensitive(nextEnv, 'ZDOTDIR');
      if (existingZdotdir && !existingZdotdir.includes(SHELL_WRAPPER_DIR_MARKER)) {
        nextEnv.AHA_ORIG_ZDOTDIR = existingZdotdir;
      } else {
        delete nextEnv.AHA_ORIG_ZDOTDIR;
      }
      nextEnv.ZDOTDIR = zshWrapperDir;
      const args = input.args.length > 0 ? [...input.args] : ['-l', '-i'];
      return {
        file: input.file,
        args,
        env: nextEnv,
        integrated: true,
      };
    } catch {
      return {
        file: input.file,
        args: [...input.args],
        env: { ...input.env },
        integrated: false,
      };
    }
  }

  return {
    file: input.file,
    args: [...input.args],
    env: { ...input.env },
    integrated: false,
  };
}
