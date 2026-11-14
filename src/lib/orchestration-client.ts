import type { OrchestrationPaneSpawnedEvent, OrchestrationSnapshot } from '../types';
import { EMPTY_SNAPSHOT } from './orchestration-view';

type Listener = () => void;
type ChangeListener = (prev: OrchestrationSnapshot | null, next: OrchestrationSnapshot) => void;
type SpawnListener = (event: OrchestrationPaneSpawnedEvent) => void;

let snapshot: OrchestrationSnapshot = EMPTY_SNAPSHOT;
let loaded = false;
let error: string | null = null;
let started = false;
// Events carry a full snapshot; a slow initial fetch must not overwrite a newer pushed one.
let lastPushAt = '';
const listeners = new Set<Listener>();
const changeListeners = new Set<ChangeListener>();
const spawnListeners = new Set<SpawnListener>();
const pendingSpawns: OrchestrationPaneSpawnedEvent[] = [];

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
    apply(event.snapshot);
  });
  api.onPaneSpawned((event) => {
    if (spawnListeners.size === 0) {
      pendingSpawns.push(event);
      return;
    }
    for (const listener of spawnListeners) listener(event);
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
};
