import type { ChildProcess } from 'node:child_process';

/**
 * POSIX agents run as their own process group so closing one also stops the tools and MCP
 * servers it started. Windows gets the same from the job object the launcher puts them in.
 */
export const SPAWN_AGENT_PROCESS_GROUP = process.platform !== 'win32';

/** Children AhaStation started as the leader of their own process group. */
const groupLeaders = new WeakSet<object>();

/** Records that `child` was spawned with `detached: SPAWN_AGENT_PROCESS_GROUP`, so it leads its group. */
export function markProcessGroupLeader<T extends object>(child: T): T {
  if (SPAWN_AGENT_PROCESS_GROUP) groupLeaders.add(child);
  return child;
}

/**
 * Stops `child` and, when AhaStation made it a process group leader, every process in its group.
 * Signalling `-pid` for any other child could hit an unrelated group that happens to share the id.
 */
export function killProcessTree(child: Pick<ChildProcess, 'pid' | 'exitCode' | 'signalCode' | 'kill'>): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (groupLeaders.has(child) && child.pid) {
    try {
      process.kill(-child.pid, 'SIGKILL');
      return;
    } catch {
      // The group is gone or was never created; fall back to the child itself.
    }
  }
  child.kill('SIGKILL');
}

function signalZero(target: number): boolean {
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // Permission errors count as alive, so an unknown process is never treated as gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Whether the agent process recorded as `pid`, or on POSIX anything left in its process group, still runs. */
export function isProcessTreeAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  return signalZero(pid) || (SPAWN_AGENT_PROCESS_GROUP && signalZero(-pid));
}
