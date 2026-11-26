import type {
  AgentDriverId, AgentDriverSummary, AgentSessionInfo, AgentSessionPolicy, CodexModelOption, CodexRateLimits, CodexSkillOption,
} from '../types';

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
  async create(opts: { cwd?: string; policy: AgentSessionPolicy; provider?: AgentDriverId }): Promise<
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
  /**
   * Opens a past Codex conversation as a session (the one already open, if any). No process
   * starts until the first message.
   */
  async openHistory(threadId: string): Promise<{ ok: true; session: AgentSessionInfo } | { ok: false; error: string }> {
    const api = window.vibeMeet?.agentSessions;
    if (!api?.openHistory) return { ok: false, error: '当前环境不支持会话历史' };
    start();
    const res = await api.openHistory({ threadId, policy: 'workspace-write' })
      .catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) }));
    if (!res.ok) return res;
    if (!sessions.some((session) => session.id === res.session.id)) publish([...sessions, res.session]);
    return res;
  },
};

const LIMITS_CACHE_MS = 60_000;
let limitsRequest: { at: number; request: Promise<CodexRateLimits | null> } | null = null;

/**
 * The account's Codex usage limits, shared by every session view and read at most once a minute
 * unless `force`d. Any failure (signed out, API key login, offline) resolves to null.
 */
export const usageLimitsClient = {
  read(force = false): Promise<CodexRateLimits | null> {
    const api = typeof window !== 'undefined' ? window.vibeMeet?.agentSessions : undefined;
    if (!api?.rateLimits) return Promise.resolve(null);
    if (!force && limitsRequest && Date.now() - limitsRequest.at < LIMITS_CACHE_MS) return limitsRequest.request;
    const request = api.rateLimits().then((res) => (res.ok ? res.limits : null), () => null);
    limitsRequest = { at: Date.now(), request };
    return request;
  },
};

const DRIVERS_CACHE_MS = 30_000;
let driversRequest: { at: number; request: Promise<AgentDriverSummary[]> } | null = null;

/** Native session drivers and whether each CLI is installed, read at most every 30 seconds. */
export const agentDriversClient = {
  list(force = false): Promise<AgentDriverSummary[]> {
    const api = typeof window !== 'undefined' ? window.vibeMeet?.agentSessions : undefined;
    if (!api?.drivers) return Promise.resolve([]);
    if (!force && driversRequest && Date.now() - driversRequest.at < DRIVERS_CACHE_MS) return driversRequest.request;
    const request = api.drivers().then((res) => (res.ok ? res.drivers : []), () => []);
    driversRequest = { at: Date.now(), request };
    return request;
  },
};

let modelsRequest: Promise<CodexModelOption[]> | null = null;
const skillRequests = new Map<string, { at: number; request: Promise<CodexSkillOption[]> }>();
const SKILL_CACHE_MS = 60_000;

/** Models and skills for the composer, shared by every open session view. */
export const codexCatalogClient = {
  models(): Promise<CodexModelOption[]> {
    const api = window.vibeMeet?.agentSessions;
    if (!api?.models) return Promise.resolve([]);
    modelsRequest ??= api.models().then((res) => {
      if (res.ok) return res.models;
      modelsRequest = null;
      throw new Error(res.error);
    }, (error: unknown) => {
      modelsRequest = null;
      throw error;
    });
    return modelsRequest;
  },
  /** The models a session's own driver offers: Codex's catalog, or what the live process listed. */
  sessionModels(sessionId: string, provider: AgentDriverId | undefined): Promise<CodexModelOption[]> {
    if (!provider || provider === 'codex') return this.models();
    const api = window.vibeMeet?.agentSessions;
    if (!api?.models) return Promise.resolve([]);
    return api.models({ id: sessionId }).then((res) => (res.ok ? res.models : []), () => []);
  },
  skills(sessionId: string): Promise<CodexSkillOption[]> {
    const api = window.vibeMeet?.agentSessions;
    if (!api?.skills) return Promise.resolve([]);
    const cached = skillRequests.get(sessionId);
    if (cached && Date.now() - cached.at < SKILL_CACHE_MS) return cached.request;
    const request = api.skills({ id: sessionId }).then((res) => {
      if (res.ok) return res.skills;
      skillRequests.delete(sessionId);
      throw new Error(res.error);
    });
    skillRequests.set(sessionId, { at: Date.now(), request });
    return request;
  },
};
