// Visibility-gated shared clock adapted from Orca's useNow / use-native-chat-elapsed-seconds.
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import { useSyncExternalStore } from 'react';

type ClockEntry = {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  onVisibility: (() => void) | null;
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => number;
};

const clocks = new Map<number, ClockEntry>();

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function notifyClock(entry: ClockEntry): void {
  entry.now = Date.now();
  for (const listener of entry.listeners) {
    listener();
  }
}

function startClock(intervalMs: number, entry: ClockEntry): void {
  if (entry.timer !== null || !isDocumentVisible()) return;
  entry.timer = setInterval(() => notifyClock(entry), intervalMs);
}

function stopClock(entry: ClockEntry): void {
  if (entry.timer !== null) {
    clearInterval(entry.timer);
    entry.timer = null;
  }
}

function getClock(intervalMs: number): ClockEntry {
  let entry = clocks.get(intervalMs);
  if (!entry) {
    const created: ClockEntry = {
      now: Date.now(),
      listeners: new Set(),
      timer: null,
      onVisibility: null,
      subscribe: (listener: () => void) => {
        const wasEmpty = created.listeners.size === 0;
        created.listeners.add(listener);
        if (wasEmpty) {
          created.now = Date.now();
          startClock(intervalMs, created);
          if (typeof document !== 'undefined') {
            created.onVisibility = () => {
              if (isDocumentVisible()) {
                notifyClock(created);
                startClock(intervalMs, created);
              } else {
                stopClock(created);
              }
            };
            document.addEventListener('visibilitychange', created.onVisibility);
          }
        }
        return () => {
          created.listeners.delete(listener);
          if (created.listeners.size === 0) {
            stopClock(created);
            if (created.onVisibility && typeof document !== 'undefined') {
              document.removeEventListener('visibilitychange', created.onVisibility);
              created.onVisibility = null;
            }
          }
        };
      },
      getSnapshot: () => created.now,
    };
    clocks.set(intervalMs, created);
    entry = created;
  }
  return entry;
}

const noopSubscribe = () => () => {};
const getInactiveSnapshot = () => 0;

/** Shared visibility-gated epoch clock; pauses intervals in hidden tabs and catches up on focus. */
export function useSharedNow(intervalMs = 1_000, active = true): number {
  const clock = active ? getClock(intervalMs) : null;
  return useSyncExternalStore(
    clock ? clock.subscribe : noopSubscribe,
    clock ? clock.getSnapshot : getInactiveSnapshot,
    getInactiveSnapshot,
  );
}
