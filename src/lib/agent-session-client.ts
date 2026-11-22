import type { AgentSessionInfo, AgentSessionPolicy } from '../types';

const STANDALONE_ID = /^agent-session-[a-f0-9-]{36}$/;

/** True for a conversation the person drives directly, as opposed to an orchestration Worker. */
export const isStandaloneSession = (id?: string | null): id is string => Boolean(id && STANDALONE_ID.test(id));

export const POLICY_LABELS: Record<AgentSessionPolicy, string> = {
  'read-only': '只读',
  'workspace-write': '可写 · 需确认',
  'full-auto': '自动',
};

let sessions: AgentSessionInfo[] = [];
let started = false;
const listeners = new Set<() => void>();

function publish(next: AgentSessionInfo[]) {
  sessions = next;
  for (const listener of listeners) listener();
}

function start() {
  const api = typeof window !== 'undefined' ? window.vibeMeet?.agentSessions : undefined;
  if (started || !api) return;
  started = true;
  api.onChanged(publish);
  void api.list().then((res) => {
    if (res.ok) publish(res.sessions);
  });
}

export const agentSessionClient = {
  available: () => Boolean(typeof window !== 'undefined' && window.vibeMeet?.agentSessions),
  subscribe(listener: () => void) {
    start();
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  getSnapshot: () => sessions,
  async create(opts: { cwd?: string; policy: AgentSessionPolicy }): Promise<
    { ok: true; session: AgentSessionInfo } | { ok: false; error: string }
  > {
    const api = window.vibeMeet?.agentSessions;
    if (!api) return { ok: false, error: '当前环境不支持桌面会话' };
    start();
    const res = await api.create(opts);
    if (!res.ok) return res;
    // The change event can arrive after this call resolves; the view needs the session right away.
    if (!sessions.some((session) => session.id === res.session.id)) publish([...sessions, res.session]);
    return res;
  },
};
