export const DEFAULT_STALL_WATCHDOG_INTERVAL_MS = 10_000;
export const DEFAULT_STALL_THRESHOLD_MS = 25_000;

export interface BoardStallRunState {
  runId: string;
  coordinatorPaneId: string | null;
  coordinatorIdle: boolean;
  coordinatorHasWaiter: boolean;
  hasActiveWorkers: boolean;
  hasSettledOrWaitingWorkers: boolean;
  hasPendingAttention: boolean;
  headSeq: number;
  lastPostAtMs: number;
  lastPostIsDone: boolean;
  hasWakeBudget?: boolean;
}

export interface BoardStallWatchdogOptions {
  intervalMs?: number;
  stallThresholdMs?: number;
  now?: () => number;
  inspectRuns: () => readonly BoardStallRunState[];
  onStallDetected: (runId: string, headSeq: number, idleMs: number) => void;
}

export interface BoardStallEvent {
  runId: string;
  headSeq: number;
  idleMs: number;
}

export class BoardStallWatchdog {
  private readonly intervalMs: number;
  private readonly stallThresholdMs: number;
  private readonly now: () => number;
  private readonly inspectRuns: () => readonly BoardStallRunState[];
  private readonly onStallDetected: (runId: string, headSeq: number, idleMs: number) => void;
  private readonly notifiedHeadByRun = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(opts: BoardStallWatchdogOptions) {
    this.intervalMs = opts.intervalMs ?? 0;
    this.stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_THRESHOLD_MS;
    this.now = opts.now ?? Date.now;
    this.inspectRuns = opts.inspectRuns;
    this.onStallDetected = opts.onStallDetected;
  }

  start(): void {
    if (this.disposed || this.timer || this.intervalMs <= 0) return;
    this.timer = setInterval(() => {
      try {
        this.sweep();
      } catch {
        /* non-fatal; next sweep will retry */
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.notifiedHeadByRun.clear();
  }

  sweep(): BoardStallEvent[] {
    if (this.disposed) return [];
    const runs = this.inspectRuns();
    const currentNow = this.now();
    const seen = new Set<string>();
    const detected: BoardStallEvent[] = [];

    for (const run of runs) {
      seen.add(run.runId);
      const idleMs = currentNow - run.lastPostAtMs;
      const isStalled =
        run.hasSettledOrWaitingWorkers &&
        !run.hasActiveWorkers &&
        !run.hasPendingAttention &&
        run.coordinatorIdle &&
        !run.coordinatorHasWaiter &&
        !run.lastPostIsDone &&
        run.hasWakeBudget !== false &&
        idleMs >= this.stallThresholdMs;

      if (!isStalled) continue;
      if (this.notifiedHeadByRun.get(run.runId) === run.headSeq) continue;

      this.notifiedHeadByRun.set(run.runId, run.headSeq);
      detected.push({ runId: run.runId, headSeq: run.headSeq, idleMs });
      this.onStallDetected(run.runId, run.headSeq, idleMs);
    }

    for (const trackedRunId of this.notifiedHeadByRun.keys()) {
      if (!seen.has(trackedRunId)) {
        this.notifiedHeadByRun.delete(trackedRunId);
      }
    }

    return detected;
  }
}
