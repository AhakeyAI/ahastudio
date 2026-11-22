import { randomUUID } from 'node:crypto';
import type {
  AgentProvider, AgentRuntimeRequest, AgentRuntimeResponse, AgentSessionDriver, AgentSessionEvents,
  AgentSessionPolicy, TurnDelivery,
} from './agent-session-driver.js';
import { WorkerTimeline, type WorkerTimelineChange, type WorkerTimelineSnapshot } from './worker-timeline.js';

export const AGENT_SESSION_ID = /^agent-session-[a-f0-9-]{36}$/;

export type AgentSessionStatus = 'starting' | 'idle' | 'running' | 'closed' | 'failed';

export interface AgentSessionInfo {
  id: string;
  provider: AgentProvider;
  title: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  policy: AgentSessionPolicy;
  providerSessionId: string | null;
  status: AgentSessionStatus;
  error: string | null;
  createdAt: number;
}

interface PendingRequest {
  turnKey: string;
  request: AgentRuntimeRequest;
  resolve: (response: AgentRuntimeResponse) => void;
}

interface Session {
  info: AgentSessionInfo;
  driver: AgentSessionDriver | null;
  timeline: WorkerTimeline;
  turns: number;
  requests: Map<string, PendingRequest>;
}

export interface AgentSessionManagerDependencies {
  launch: (sessionId: string, cwd: string, events: AgentSessionEvents) => AgentSessionDriver;
  now?: () => number;
}

const DECLINE: AgentRuntimeResponse = { decision: 'decline' };

/**
 * Conversations a person drives directly, outside orchestration: no dispatch, no report_done. The
 * person in the session is the only writer and the only one who answers its approvals.
 */
export class AgentSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly timelineListeners = new Set<(change: WorkerTimelineChange) => void>();
  private readonly sessionListeners = new Set<(sessions: AgentSessionInfo[]) => void>();
  private readonly now: () => number;

  constructor(private readonly deps: AgentSessionManagerDependencies) {
    this.now = deps.now ?? Date.now;
  }

  onTimelineChange(listener: (change: WorkerTimelineChange) => void): () => void {
    this.timelineListeners.add(listener);
    return () => this.timelineListeners.delete(listener);
  }

  onSessionsChanged(listener: (sessions: AgentSessionInfo[]) => void): () => void {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  list(): AgentSessionInfo[] {
    return [...this.sessions.values()].map((session) => ({ ...session.info }));
  }

  getTimeline(id: string): WorkerTimelineSnapshot | null {
    return this.sessions.get(id)?.timeline.snapshot() ?? null;
  }

  async create(input: {
    cwd: string; policy: AgentSessionPolicy; model?: string | null; effort?: string | null; title?: string;
  }): Promise<AgentSessionInfo> {
    const id = `agent-session-${randomUUID()}`;
    const info: AgentSessionInfo = {
      id, provider: 'codex', title: input.title?.trim() || '', cwd: input.cwd,
      model: input.model ?? null, effort: input.effort ?? null, policy: input.policy,
      providerSessionId: null, status: 'starting', error: null, createdAt: this.now(),
    };
    const session: Session = {
      info, driver: null, turns: 0, requests: new Map(),
      timeline: new WorkerTimeline({
        workerHandle: id, cliId: 'codex', model: info.model, readOnly: info.policy === 'read-only',
        redact: (text) => session.driver?.redactText(text) ?? text,
        now: this.now,
        onPatch: (change) => {
          for (const listener of this.timelineListeners) listener(change);
        },
      }),
    };
    this.sessions.set(id, session);
    this.sessionsChanged();
    try {
      session.driver = this.deps.launch(id, input.cwd, this.eventsFor(session));
      info.provider = session.driver.provider;
      info.providerSessionId = await session.driver.open({ cwd: input.cwd, model: info.model, policy: info.policy });
      if (!session.driver.alive) throw new Error(info.error ?? 'The agent closed while starting');
      info.status = 'idle';
      session.timeline.setMeta({ providerSessionId: info.providerSessionId });
    } catch (error) {
      info.status = 'failed';
      info.error = error instanceof Error ? error.message : String(error);
      session.timeline.setMeta({ alive: false });
      await session.driver?.close();
    }
    this.sessionsChanged();
    return { ...info };
  }

  /** Starts a turn with the person's message. A session takes one turn at a time. */
  async send(id: string, input: {
    text: string; model?: string | null; effort?: string | null; policy?: AgentSessionPolicy;
  }): Promise<TurnDelivery> {
    const session = this.sessions.get(id);
    const text = input.text.trim();
    if (!session?.driver?.alive || session.info.status !== 'idle') {
      return { status: 'not_accepted', reason: session ? `Session is ${session.info.status}` : 'Session not found' };
    }
    if (!text) return { status: 'not_accepted', reason: 'Message is empty' };
    const { info, timeline } = session;
    const turnKey = `${id}:${++session.turns}`;
    if (!info.title) info.title = text.split('\n')[0]!.slice(0, 60);
    info.status = 'running';
    timeline.beginTurn({ dispatchId: turnKey, prompt: text });
    this.sessionsChanged();
    const delivery = await session.driver.startTurn({
      turnKey, prompt: text,
      effort: input.effort ?? info.effort,
      ...(input.model && input.model !== info.model ? { model: input.model } : {}),
      ...(input.policy && input.policy !== info.policy ? { policy: input.policy } : {}),
    });
    if (delivery.status === 'accepted') {
      if (input.model) info.model = input.model;
      if (input.effort !== undefined) info.effort = input.effort;
      if (input.policy) info.policy = input.policy;
      timeline.setMeta({ model: info.model, readOnly: info.policy === 'read-only' });
    } else {
      timeline.endActiveTurn('failed', delivery.reason);
      // Unknown acceptance leaves the provider thread in an unknown state; do not send into it again.
      if (delivery.status === 'unknown_acceptance') {
        info.error = delivery.reason;
        await session.driver.close();
      } else if (info.status === 'running') {
        info.status = 'idle';
      }
    }
    this.sessionsChanged();
    return delivery;
  }

  async interrupt(id: string): Promise<boolean> {
    return (await this.sessions.get(id)?.driver?.interrupt()) ?? false;
  }

  /** Answers an approval the agent is waiting on. Returns false if it is no longer pending. */
  respond(id: string, requestId: string, allow: boolean, reason?: string): boolean {
    const session = this.sessions.get(id);
    const pending = session?.requests.get(requestId);
    if (!session || !pending) return false;
    this.settleRequest(session, requestId, allow ? 'approved' : 'denied', reason ?? null);
    pending.resolve(allow ? { decision: 'accept' } : DECLINE);
    return true;
  }

  /** Ends the session and forgets it. */
  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    await session.driver?.close(true);
    this.sessions.delete(id);
    this.sessionsChanged();
  }

  async dispose(): Promise<void> {
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private eventsFor(session: Session): AgentSessionEvents {
    const { info, timeline } = session;
    return {
      onTurnStarted: () => {},
      onTimeline: (turnKey, event) => {
        if (timeline.activeTurn?.dispatchId === turnKey) timeline.apply(event);
      },
      onTurnCompleted: (_turnKey, result) => {
        this.cancelRequests(session, 'Turn ended');
        timeline.completeTurn({
          turnId: result.turnId, stopReason: result.stopReason, usage: result.usage, error: result.error,
          status: result.stopReason === 'completed' ? 'completed'
            : result.stopReason === 'interrupted' ? 'interrupted' : 'failed',
        });
        if (info.status === 'running') info.status = 'idle';
        this.sessionsChanged();
      },
      onRequest: (turnKey, request) => {
        // Questions have no place in the timeline yet; the provider is told they are unsupported.
        if (request.kind !== 'approval' || request.signal.aborted) return Promise.resolve(DECLINE);
        const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        return new Promise<AgentRuntimeResponse>((resolve) => {
          session.requests.set(requestId, { turnKey, request, resolve });
          timeline.upsertApproval({
            approvalId: requestId, dispatchId: turnKey, method: request.method,
            tool: request.method.split('/')[1] ?? request.method,
            input: request.toolInput, reason: request.message ?? null, status: 'pending',
          });
        });
      },
      onExit: (reason) => {
        this.cancelRequests(session, reason);
        timeline.endActiveTurn(session.driver?.closing ? 'interrupted' : 'failed', reason);
        timeline.setMeta({ alive: false });
        if (info.status !== 'failed') {
          const expected = session.driver?.closing && !info.error;
          info.status = expected ? 'closed' : 'failed';
          if (!expected) info.error ??= reason;
        }
        if (this.sessions.has(info.id)) this.sessionsChanged();
      },
    };
  }

  private settleRequest(session: Session, requestId: string, status: 'approved' | 'denied' | 'expired', reason: string | null): void {
    const pending = session.requests.get(requestId);
    if (!pending) return;
    session.requests.delete(requestId);
    session.timeline.upsertApproval({
      approvalId: requestId, dispatchId: pending.turnKey, method: pending.request.method,
      tool: pending.request.method.split('/')[1] ?? pending.request.method,
      input: pending.request.toolInput, reason: pending.request.message ?? null, status, resolution: reason,
    });
  }

  private cancelRequests(session: Session, reason: string): void {
    for (const [requestId, pending] of [...session.requests]) {
      this.settleRequest(session, requestId, 'expired', reason);
      pending.resolve(DECLINE);
    }
  }

  private sessionsChanged(): void {
    const sessions = this.list();
    for (const listener of this.sessionListeners) listener(sessions);
  }
}
