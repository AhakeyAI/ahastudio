import type {
  OrchestrationPaneClosedEvent,
  OrchestrationPaneSpawnedEvent,
  OrchestrationSnapshot,
  WorkerTimelinePatch,
  WorkerTimelineSnapshot,
} from '../types';
import { EMPTY_SNAPSHOT, mergeRunSnapshot } from './orchestration-view';

type Listener = () => void;
type ChangeListener = (prev: OrchestrationSnapshot | null, next: OrchestrationSnapshot) => void;
export type { OrchestrationPaneClosedEvent, OrchestrationPaneSpawnedEvent };
type SpawnListener = (event: OrchestrationPaneSpawnedEvent) => void;
type ClosedListener = (event: OrchestrationPaneClosedEvent) => void;

let snapshot: OrchestrationSnapshot = {
  ...EMPTY_SNAPSHOT,
  pendingProposals: [],
  orchestrationModePanes: [],
};
let loaded = false;
let hasGlobalSnapshot = false;
let error: string | null = null;
let started = false;
// Events may be global or run-scoped; preserve other runs if a run-scoped event beats the initial fetch.
let lastPushAt = '';
const pendingPreGlobalRunEvents: Array<{ runId: string; snapshot: OrchestrationSnapshot }> = [];
const listeners = new Set<Listener>();
const changeListeners = new Set<ChangeListener>();
const spawnListeners = new Set<SpawnListener>();
const closedListeners = new Set<ClosedListener>();
const pendingSpawns: OrchestrationPaneSpawnedEvent[] = [];
const pendingCloses: OrchestrationPaneClosedEvent[] = [];
const timelinePatchListeners = new Set<(patch: WorkerTimelinePatch) => void>();
let timelinePatchUnsub: (() => void) | null = null;

function emit() {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* listener errors must not break the store */
    }
  }
}

function apply(next: OrchestrationSnapshot) {
  const prev = loaded ? snapshot : null;
  snapshot = next;
  loaded = true;
  error = null;
  emit();
  for (const listener of changeListeners) {
    try {
      listener(prev, next);
    } catch {
      /* ignore */
    }
  }
}

async function refresh(): Promise<void> {
  const api = typeof window !== 'undefined' ? window.vibeMeet?.orchestration : undefined;
  if (!api) {
    error = '编排接口不可用';
    emit();
    return;
  }
  const requestedAfter = lastPushAt;
  try {
    const res = await api.getSnapshot();
    if (!res.ok) {
      error = res.error;
      emit();
      return;
    }
    if (!hasGlobalSnapshot) {
      let merged = res.snapshot;
      for (const ev of pendingPreGlobalRunEvents.splice(0)) {
        merged = mergeRunSnapshot(merged, ev.runId, ev.snapshot);
      }
      hasGlobalSnapshot = true;
      apply(merged);
      return;
    }
    if (lastPushAt !== requestedAfter) return;
    apply(res.snapshot);
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    emit();
  }
}

function start() {
  if (started || typeof window === 'undefined') return;
  const api = window.vibeMeet?.orchestration;
  if (!api) return;
  started = true;
  api.onEvent((event) => {
    if (!event?.snapshot) return;
    lastPushAt = event.updatedAt || String(Date.now());
    if (!event.runId) {
      hasGlobalSnapshot = true;
      pendingPreGlobalRunEvents.length = 0;
      apply(event.snapshot);
      return;
    }
    if (!hasGlobalSnapshot) {
      pendingPreGlobalRunEvents.push({ runId: event.runId, snapshot: event.snapshot });
    }
    apply(loaded ? mergeRunSnapshot(snapshot, event.runId, event.snapshot) : event.snapshot);
  });
  api.onPaneSpawned((event) => {
    if (spawnListeners.size === 0) {
      pendingSpawns.push(event);
      return;
    }
    for (const listener of spawnListeners) listener(event);
  });
  api.onPaneClosed?.((event) => {
    for (let i = pendingSpawns.length - 1; i >= 0; i -= 1) {
      if (pendingSpawns[i]!.ptyId === event.ptyId) {
        pendingSpawns.splice(i, 1);
      }
    }
    if (closedListeners.size === 0) {
      pendingCloses.push(event);
      return;
    }
    for (const listener of closedListeners) listener(event);
  });
  void refresh();
}

export const orchestrationClient = {
  subscribe(listener: Listener) {
    start();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => snapshot,
  isLoaded: () => loaded,
  getError: () => error,
  refresh,
  /** Called with the previous snapshot (null before the first load) on every update. */
  onChange(listener: ChangeListener) {
    start();
    changeListeners.add(listener);
    return () => {
      changeListeners.delete(listener);
    };
  },
  onPaneSpawned(listener: SpawnListener) {
    start();
    spawnListeners.add(listener);
    for (const event of pendingSpawns.splice(0)) listener(event);
    return () => {
      spawnListeners.delete(listener);
    };
  },
  onPaneClosed(listener: ClosedListener) {
    start();
    closedListeners.add(listener);
    for (const event of pendingCloses.splice(0)) listener(event);
    return () => {
      closedListeners.delete(listener);
    };
  },
  /** Streams coalesced headless Worker timeline patches; one IPC subscription serves all views. */
  onWorkerTimelinePatch(listener: (patch: WorkerTimelinePatch) => void) {
    timelinePatchListeners.add(listener);
    const api = typeof window !== 'undefined' ? window.vibeMeet?.orchestration : undefined;
    if (!timelinePatchUnsub && api?.onWorkerTimelinePatch) {
      timelinePatchUnsub = api.onWorkerTimelinePatch((patch) => {
        for (const fn of timelinePatchListeners) {
          try {
            fn(patch);
          } catch {
            /* ignore */
          }
        }
      });
    }
    return () => {
      timelinePatchListeners.delete(listener);
      if (timelinePatchListeners.size === 0 && timelinePatchUnsub) {
        timelinePatchUnsub();
        timelinePatchUnsub = null;
      }
    };
  },
  async getWorkerTimeline(opts: { dispatchId?: string; workerHandle?: string }): Promise<
    { ok: true; timeline: WorkerTimelineSnapshot | null } | { ok: false; error: string }
  > {
    const api = typeof window !== 'undefined' ? window.vibeMeet?.orchestration : undefined;
    if (!api?.workerTimelineGet) return { ok: false, error: '会话接口不可用' };
    try {
      const res = await api.workerTimelineGet(opts);
      return res.ok ? { ok: true, timeline: res.timeline } : { ok: false, error: res.error };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
};
