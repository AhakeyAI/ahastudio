import os from 'node:os';
import { createRequire } from 'node:module';
import { guardWindowsPtyStartup } from '../windows-pty-startup.js';
import type { PtyProcess } from '../pty-host.js';

const WARMUP_KILL_TIMEOUT_MS = 10_000;
const requireFromModule = createRequire(import.meta.url);

type NodePtyModule = {
  spawn: (
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: Record<string, string>;
      useConptyDll?: boolean;
    }
  ) => PtyProcess;
};

const defaultSpawnWarmupPty = (
  file: string,
  args: string[],
  options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string>; useConptyDll: boolean }
): PtyProcess => {
  const nodePty = requireFromModule('@lydell/node-pty') as NodePtyModule;
  return guardWindowsPtyStartup(nodePty.spawn(file, args, options));
};

/**
 * Move first-ConPTY startup cost ahead of the user's first terminal when possible.
 * Returns a cleanup callback so daemon shutdown never waits on a lingering warmup shell.
 */
export function warmWindowsConptyOnce(
  spawnPty: typeof defaultSpawnWarmupPty = defaultSpawnWarmupPty
): () => void {
  if (process.platform !== 'win32' || process.env.AHA_DISABLE_CONPTY_WARMUP === '1') {
    return () => {};
  }

  let disposed = false;
  let activeProc: PtyProcess | null = null;
  let killTimer: ReturnType<typeof setTimeout> | null = null;

  const immediate = setImmediate(() => {
    if (disposed) return;
    try {
      const proc = spawnPty(process.env.COMSPEC || 'cmd.exe', ['/c', 'exit'], {
        name: 'xterm-256color',
        cols: 2,
        rows: 1,
        cwd: os.homedir(),
        env: process.env as Record<string, string>,
        useConptyDll: true,
      });
      if (disposed) {
        try { proc.kill(); } catch { /* ignore */ }
        return;
      }
      activeProc = proc;
      killTimer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
          /* A stuck warmup shell must not make cleanup fail. */
        }
      }, WARMUP_KILL_TIMEOUT_MS);
      killTimer.unref?.();
      proc.onExit(() => {
        if (killTimer) {
          clearTimeout(killTimer);
          killTimer = null;
        }
        activeProc = null;
      });
    } catch {
      /* Warmup is optional; real spawns report their own errors. */
    }
  });
  immediate.unref?.();

  return () => {
    disposed = true;
    clearImmediate(immediate);
    if (killTimer) {
      clearTimeout(killTimer);
      killTimer = null;
    }
    if (activeProc) {
      try {
        activeProc.kill();
      } catch {
        /* ignore */
      }
      activeProc = null;
    }
  };
}
