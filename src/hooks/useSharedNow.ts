// Visibility-gated shared clock adapted from Orca's useNow / use-native-chat-elapsed-seconds.
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import { useSyncExternalStore } from 'react';

type ClockEntry = {
  now: number;
  listeners: Set<() => void>;
  timer: ReturnType<typeof setInterval> | null;
  onVisibility: (() => void) | null;
};

const clocks = new Map<number, ClockEntry>();

function isDocumentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

function getClock(intervalMs: number): ClockEntry {
  let entry = clocks.get(intervalMs);
  if (!entry) {
    entry = { now: Date.now(), listeners: new Set(), timer: null, onVisibility: null };
    clocks.set(intervalMs, entry);
  }
  return entry;
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

const noopSubscribe = () => () => {};

/** Shared visibility-gated epoch clock; pauses intervals in hidden tabs and catches up on focus. */
export function useSharedNow(intervalMs = 1_000, active = true): number {
  const subscribe = (listener: () => void) => {
    const entry = getClock(intervalMs);
    const wasEmpty = entry.listeners.size === 0;
    entry.listeners.add(listener);
    if (wasEmpty) {
      entry.now = Date.now();
      startClock(intervalMs, entry);
      if (typeof document !== 'undefined') {
        entry.onVisibility = () => {
          if (isDocumentVisible()) {
            notifyClock(entry);
            startClock(intervalMs, entry);
          } else {
            stopClock(entry);
          }
        };
        document.addEventListener('visibilitychange', entry.onVisibility);
      }
    }
    return () => {
      entry.listeners.delete(listener);
      if (entry.listeners.size === 0) {
        stopClock(entry);
        if (entry.onVisibility && typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', entry.onVisibility);
          entry.onVisibility = null;
        }
      }
    };
  };

  return useSyncExternalStore(
    active ? subscribe : noopSubscribe,
    () => (active ? getClock(intervalMs).now : Date.now()),
    () => Date.now(),
  );
}
