import { useEffect, useState } from 'react';
import { orchestrationClient } from '../lib/orchestration-client';
import { applyWorkerTimelinePatch } from '../lib/worker-timeline-model';
import type { WorkerTimelinePatch, WorkerTimelineSnapshot } from '../types';

export interface WorkerTimelineState {
  timeline: WorkerTimelineSnapshot | null;
  loading: boolean;
  error: string | null;
}

/** Loads a headless Worker timeline (live or archived) and keeps it current from pushed patches. */
export function useWorkerTimeline(workerHandle?: string, dispatchId?: string, reloadKey = 0): WorkerTimelineState {
  const [state, setState] = useState<WorkerTimelineState>({ timeline: null, loading: true, error: null });

  useEffect(() => {
    if (!workerHandle && !dispatchId) {
      setState({ timeline: null, loading: false, error: null });
      return;
    }
    let cancelled = false;
    let loaded = false;
    let current: WorkerTimelineSnapshot | null = null;
    const buffered: WorkerTimelinePatch[] = [];
    const matches = (patch: WorkerTimelinePatch) =>
      workerHandle ? patch.workerHandle === workerHandle : current?.workerHandle === patch.workerHandle;
    const off = orchestrationClient.onWorkerTimelinePatch((patch) => {
      if (!loaded) {
        buffered.push(patch);
        return;
      }
      if (!matches(patch)) return;
      current = applyWorkerTimelinePatch(current, patch);
      setState({ timeline: current, loading: false, error: null });
    });
    setState((prev) => ({ ...prev, loading: true }));
    void orchestrationClient
      .getWorkerTimeline(workerHandle ? { workerHandle } : { dispatchId })
      .then((res) => {
        if (cancelled) return;
        loaded = true;
        if (!res.ok) {
          setState({ timeline: null, loading: false, error: res.error });
          return;
        }
        current = res.timeline;
        for (const patch of buffered.splice(0)) {
          if (matches(patch)) current = applyWorkerTimelinePatch(current, patch);
        }
        setState({ timeline: current, loading: false, error: null });
      });
    return () => {
      cancelled = true;
      off();
    };
  }, [workerHandle, dispatchId, reloadKey]);

  return state;
}
