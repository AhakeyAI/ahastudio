import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { augmentedPath, resolveBinaryFromPath } from '../bin-resolve.js';
import { spawnWindowsCodexJob } from '../orchestration/windows-codex-job.js';

export type AgentChild = ChildProcessWithoutNullStreams;

/** The JavaScript entry an npm `.cmd` shim runs, so it can be started with node and no shell. */
export function npmShimEntry(shimPath: string, read: (path: string) => string = (path) => readFileSync(path, 'utf8')): string | null {
  let text: string;
  try {
    text = read(shimPath);
  } catch {
    return null;
  }
  const match = /"%(?:~?dp0)%\\([^"%]+\.(?:c|m)?js)"/iu.exec(text);
  return match ? join(dirname(shimPath), match[1]!) : null;
}

/** Where a CLI resolves on this machine, or null when it is not installed. */
export function resolveAgentCommand(command: string): string | null {
  return resolveBinaryFromPath(command);
}

/** Environment for an agent process: the person's own, minus AhaStation's terminal and token plumbing. */
export function agentEnvironment(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('AHA_') || key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  return { ...env, ...extra };
}

/**
 * Starts an agent CLI with piped stdio. On Windows the process runs in a job that closes with it,
 * so tool processes it started cannot outlive the session; npm shims run through node directly.
 */
export function spawnAgentProcess(input: {
  command: string; args: readonly string[]; cwd: string; env?: Readonly<Record<string, string>>;
}): AgentChild {
  const resolved = resolveAgentCommand(input.command);
  if (!resolved) throw new Error(`没有找到 ${input.command} 命令，请先安装并登录对应 CLI`);
  let file = resolved;
  let args = [...input.args];
  if (/\.(cmd|bat)$/iu.test(resolved)) {
    const entry = npmShimEntry(resolved);
    const node = resolveBinaryFromPath('node');
    if (!entry || !existsSync(entry) || !node) throw new Error(`无法解析 ${input.command} 的启动脚本`);
    file = node;
    args = [entry, ...args];
  }
  const env = agentEnvironment(input.env);
  return process.platform === 'win32'
    ? spawnWindowsCodexJob(file, args, input.cwd, env)
    : spawn(file, args, { cwd: input.cwd, env, windowsHide: true, stdio: 'pipe' });
}

const STDERR_LIMIT = 4 * 1024;
const CHILD_CLOSE_TIMEOUT_MS = 3_000;

/** Lifecycle shared by drivers: bounded stderr for failure messages and a bounded, idempotent teardown. */
export class AgentProcessHandle {
  private stderr = '';
  private closePromise: Promise<void> | null = null;
  readonly closed: Promise<{ code: number | null; signal: string | null }>;

  constructor(readonly child: AgentChild) {
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-STDERR_LIMIT);
    });
    child.stderr.on('error', () => {});
    child.stdin.on('error', () => {});
    this.closed = new Promise((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: null, signal: null }));
    });
  }

  get exitCode(): number | null {
    return this.child.exitCode;
  }

  stderrTail(redact: (text: string) => string = (text) => text): string {
    return redact(this.stderr).trim();
  }

  withStderr(reason: string, redact?: (text: string) => string): string {
    const tail = this.stderrTail(redact);
    return tail && !reason.includes(tail) ? `${reason}\n${tail}` : reason;
  }

  kill(): Promise<void> {
    this.closePromise ??= (async () => {
      try {
        if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
      } catch {
        // Still release the pipes.
      }
      this.child.stdin.destroy();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        this.closed,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, CHILD_CLOSE_TIMEOUT_MS); }),
      ]);
      clearTimeout(timer);
      this.child.stdout.destroy();
      this.child.stderr.destroy();
    })();
    return this.closePromise;
  }
}
