// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import type { NativeChatTextReveal } from './native-chat-text-reveal';

/** Per-transcript reveal state: live-row keys can repeat across sessions. */
export type NativeChatReplyReveals = {
  /** Tail replies first seen while the transcript was open; excludes history already present on load. */
  begun: Set<string>;
  /** How much of a row was drawn when it unmounted, so returning does not replay it. */
  drawn: Map<string, NativeChatTextReveal>;
};

export type NativeChatReplyRevealTracker = {
  reveals: NativeChatReplyReveals;
  rowKeys: readonly string[];
  loadedMessageIds: ReadonlySet<string> | null;
  known: Set<string>;
  /** Becomes true after the first loaded snapshot so fresh empty sessions pace their very first reply. */
  primed: boolean;
};

export function createNativeChatReplyRevealTracker(): NativeChatReplyRevealTracker {
  return {
    reveals: { begun: new Set(), drawn: new Map() },
    rowKeys: [],
    loadedMessageIds: null,
    known: new Set(),
    primed: false,
  };
}

/** Update once per row/message change during render so first paint sees correct reveal state; idempotent. */
export function trackNativeChatReplyRows(
  state: NativeChatReplyRevealTracker,
  rowKeys: readonly string[],
  loadedMessageIds: ReadonlySet<string>,
  ready = true,
): NativeChatReplyReveals {
  if (state.rowKeys !== rowKeys || state.loadedMessageIds !== loadedMessageIds || (ready && !state.primed)) {
    const present = new Set(rowKeys);
    const lastKey = rowKeys.at(-1);
    const { begun, drawn } = state.reveals;
    for (const key of [...begun, ...drawn.keys()]) {
      if (!present.has(key)) {
        begun.delete(key);
        drawn.delete(key);
      }
    }
    // Only mark newly appearing tail rows as begun after the initial snapshot has been observed.
    if (lastKey !== undefined && !state.known.has(lastKey) && (state.known.size > 0 || state.primed)) {
      begun.add(lastKey);
    }
    for (const key of state.known) {
      if (!loadedMessageIds.has(key)) {
        state.known.delete(key);
      }
    }
    for (const key of rowKeys) {
      state.known.add(key);
    }
    if (ready) {
      state.primed = true;
    }
    state.rowKeys = rowKeys;
    state.loadedMessageIds = loadedMessageIds;
  }
  return state.reveals;
}
