import type { ChildProcess } from 'node:child_process';

/**
 * POSIX agents run as their own process group so closing one also stops the tools and MCP
 * servers it started. Windows gets the same from the job object the launcher puts them in.
 */
export const SPAWN_AGENT_PROCESS_GROUP = process.platform !== 'win32';

/** Stops `child` and, on POSIX, every process in its group. */
export function killProcessTree(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (SPAWN_AGENT_PROCESS_GROUP && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group is gone or was never created; fall back to the child itself.
    }
  }
  child.kill('SIGKILL');
}

/**
 * Whether the agent process recorded as `pid` (POSIX: anything left in its process group) still
 * runs. Permission errors count as alive, so an unknown process is never treated as gone.
 */
export function isProcessTreeAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(SPAWN_AGENT_PROCESS_GROUP ? -pid : pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
