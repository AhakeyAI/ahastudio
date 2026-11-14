import type { AgentPaneStatus } from '../types';
import { isAttentionTransition } from './agent-status-view';

type Listener = () => void;
type AttentionListener = (status: AgentPaneStatus) => void;
type FocusListener = (ptyId: string) => void;

const statuses = new Map<string, AgentPaneStatus>();
const listeners = new Set<Listener>();
const attentionListeners = new Set<AttentionListener>();
const focusListeners = new Set<FocusListener>();
let revision = 0;
let started = false;
let hookPort: number | null = null;

function notify() {
  revision++;
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* listener errors must not break the store */
    }
  }
}

function upsert(next: AgentPaneStatus, fromPush: boolean) {
  const prev = statuses.get(next.ptyId);
  if (prev && prev.updatedAt > next.updatedAt) return;
  statuses.set(next.ptyId, next);
  notify();
  if (fromPush && isAttentionTransition(prev, next)) {
    for (const listener of attentionListeners) listener(next);
  }
}

function start() {
  if (started || typeof window === 'undefined') return;
  const api = window.vibeMeet?.agent;
  if (!api) return;
  started = true;
  api.onStatusChanged((status) => upsert(status, true));
  api.onFocusPane?.(({ ptyId }) => {
    for (const listener of focusListeners) listener(ptyId);
  });
  void api
    .listStatuses()
    .then((res) => {
      if (!res.ok) return;
      hookPort = res.hookPort;
      for (const status of res.statuses) upsert(status, false);
    })
    .catch(() => {});
}

export const agentStatusClient = {
  subscribe(listener: Listener) {
    start();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => revision,
  get: (ptyId: string): AgentPaneStatus | null => statuses.get(ptyId) ?? null,
  getHookPort: () => hookPort,
  onAttention(listener: AttentionListener) {
    start();
    attentionListeners.add(listener);
    return () => {
      attentionListeners.delete(listener);
    };
  },
  onFocusRequest(listener: FocusListener) {
    start();
    focusListeners.add(listener);
    return () => {
      focusListeners.delete(listener);
    };
  },
  acknowledge(ptyId: string) {
    const current = statuses.get(ptyId);
    const api = window.vibeMeet?.agent;
    if (!current?.unread || !api) return;
    statuses.set(ptyId, { ...current, unread: false });
    notify();
    void api
      .acknowledge({ ptyId })
      .then((res) => {
        if (res.ok && res.status) upsert(res.status, false);
      })
      .catch(() => {});
  },
  forget(ptyId: string) {
    if (statuses.delete(ptyId)) notify();
  },
};
