// Ported/adapted from Orca (https://github.com/stablyai/orca),
// native-chat-disclosure-store.ts and native-chat-reply-reveals.ts.
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import {
  createNativeChatReplyRevealTracker,
  trackNativeChatReplyRows,
  type NativeChatReplyReveals,
} from '../../lib/shared/native-chat/native-chat-reply-reveals';

export interface SessionDisclosureStore {
  read: (key: string) => boolean | undefined;
  write: (key: string, open: boolean, group?: string) => void;
}

export const SessionDisclosureContext = createContext<SessionDisclosureStore | null>(null);

export const MAX_SESSION_DISCLOSURES = 512;

export function useSessionDisclosures(): SessionDisclosureStore {
  const [openMap, setOpenMap] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const write = useCallback((key: string, next: boolean, group?: string) => {
    setOpenMap((current) => {
      const others =
        next && group !== undefined
          ? [...current].filter(([other, open]) => open && other !== key && other.startsWith(group))
          : [];
      if (current.get(key) === next && others.length === 0) {
        return current;
      }
      const updated = new Map(current);
      for (const [other] of others) {
        updated.set(other, false);
      }
      updated.set(key, next);
      if (updated.size > MAX_SESSION_DISCLOSURES) {
        const oldest = updated.keys().next().value;
        if (oldest !== undefined && oldest !== key) {
          updated.delete(oldest);
        }
      }
      return updated;
    });
  }, []);
  return useMemo(() => ({ read: (key: string) => openMap.get(key), write }), [openMap, write]);
}

export interface SessionDisclosure {
  open: boolean;
  setOpen: (next: boolean) => void;
}

/** Remember a row or turn's disclosure state across unmounts/folds; falls back to local state if unkeyed. */
export function useSessionDisclosure(
  key: string | undefined,
  initialOpen: boolean,
  group?: string,
): SessionDisclosure {
  const store = useContext(SessionDisclosureContext);
  const [local, setLocal] = useState({ key, initialOpen, open: initialOpen });
  const write = store?.write;
  const isStored = key !== undefined && store !== null;
  const localOpen =
    local.key === key && local.initialOpen === initialOpen ? local.open : initialOpen;
  const open = isStored ? (store.read(key) ?? localOpen) : localOpen;
  const setOpen = useCallback(
    (next: boolean) => {
      setLocal({ key, initialOpen, open: next });
      if (key !== undefined && write) {
        write(key, next, group);
      }
    },
    [group, initialOpen, key, write],
  );
  return { open, setOpen };
}

/** Absent outside a transcript: standalone Markdown renders at full text immediately. */
export const SessionReplyRevealsContext = createContext<NativeChatReplyReveals | null>(null);

/** Track which assistant replies appeared after load and remember each row's reveal progress. */
export function useSessionReplyReveals(
  rowKeys: readonly string[],
  loadedMessageIds: ReadonlySet<string>,
  ready = true,
): NativeChatReplyReveals {
  const [tracker] = useState(createNativeChatReplyRevealTracker);
  return trackNativeChatReplyRows(tracker, rowKeys, loadedMessageIds, ready);
}
