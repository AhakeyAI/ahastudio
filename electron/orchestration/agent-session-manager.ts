import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer.js';
import type {
  AgentProvider, AgentQuestion, AgentRuntimeRequest, AgentRuntimeResponse, AgentSessionDriver, AgentSessionEvents,
  AgentSessionPolicy, TurnDelivery,
} from './agent-session-driver.js';
import { WorkerTimeline, type WorkerTimelineChange, type WorkerTimelineSnapshot } from './worker-timeline.js';

export const AGENT_SESSION_ID = /^agent-session-[a-f0-9-]{36}$/;

/** `suspended`: not running, but its provider conversation can be resumed by sending a message. */
export type AgentSessionStatus = 'starting' | 'idle' | 'running' | 'suspended' | 'closed' | 'failed';

export interface AgentSessionInfo {
  id: string;
  provider: AgentProvider;
  title: string;
  cwd: string;
  model: string | null;
  effort: string | null;
  policy: AgentSessionPolicy;
  network: boolean;
  providerSessionId: string | null;
  status: AgentSessionStatus;
  error: string | null;
  /** Questions the agent is blocked on until the person answers or skips them. */
  pendingQuestions: { requestId: string; questions: AgentQuestion[] }[];
  createdAt: number;
}

type SavedSession = Omit<AgentSessionInfo, 'status' | 'error' | 'pendingQuestions'> & { timeline: WorkerTimelineSnapshot };

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
  /** Where sessions are kept across restarts; omitted keeps them in memory only. */
  storageFile?: () => string;
  now?: () => number;
}

const DECLINE: AgentRuntimeResponse = { decision: 'decline' };
const MAX_SAVED_SESSIONS = 20;

/**
 * Conversations a person drives directly, outside orchestration: no dispatch, no report_done. The
 * person in the session is the only writer and the only one who answers its approvals and questions.
 */
export class AgentSessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly timelineListeners = new Set<(change: WorkerTimelineChange) => void>();
  private readonly sessionListeners = new Set<(sessions: AgentSessionInfo[]) => void>();
  private readonly now: () => number;
  private readonly writer: AtomicSnapshotWriter | null;
  private disposing = false;

  constructor(private readonly deps: AgentSessionManagerDependencies) {
    this.now = deps.now ?? Date.now;
    this.writer = deps.storageFile ? new AtomicSnapshotWriter(deps.storageFile, { skipUnchanged: true }) : null;
    this.load();
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
    return [...this.sessions.values()].map((session) => structuredClone(session.info));
  }

  getTimeline(id: string): WorkerTimelineSnapshot | null {
    return this.sessions.get(id)?.timeline.snapshot() ?? null;
  }

  async create(input: {
    cwd: string; policy: AgentSessionPolicy; model?: string | null; effort?: string | null; network?: boolean;
    title?: string;
  }): Promise<AgentSessionInfo> {
    const info: AgentSessionInfo = {
      id: `agent-session-${randomUUID()}`, provider: 'codex', title: input.title?.trim() || '', cwd: input.cwd,
      model: input.model ?? null, effort: input.effort ?? null, policy: input.policy, network: input.network ?? false,
      providerSessionId: null, status: 'starting', error: null, pendingQuestions: [], createdAt: this.now(),
    };
    const session = this.track(info);
    this.sessionsChanged();
    await this.connect(session);
    return structuredClone(info);
  }

  /**
   * Starts a turn with the person's message, resuming the provider conversation first if the
   * session was suspended or its process died. A session takes one turn at a time.
   */
  async send(id: string, input: {
    text: string; model?: string | null; effort?: string | null; policy?: AgentSessionPolicy; network?: boolean;
  }): Promise<TurnDelivery> {
    const session = this.sessions.get(id);
    const text = input.text.trim();
    if (!session) return { status: 'not_accepted', reason: 'Session not found' };
    if (!text) return { status: 'not_accepted', reason: 'Message is empty' };
    if (this.resumable(session)) {
      await this.connect(session, true);
      if (session.info.status !== 'idle') return { status: 'not_accepted', reason: session.info.error ?? 'Session did not resume' };
    }
    if (!session.driver?.alive || session.info.status !== 'idle') {
      return { status: 'not_accepted', reason: `Session is ${session.info.status}` };
    }
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
      ...(input.network !== undefined && input.network !== info.network ? { network: input.network } : {}),
    });
    if (delivery.status === 'accepted') {
      if (input.model) info.model = input.model;
      if (input.effort !== undefined) info.effort = input.effort;
      if (input.policy) info.policy = input.policy;
      if (input.network !== undefined) info.network = input.network;
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
    if (!session || !pending || pending.request.kind !== 'approval') return false;
    this.settleRequest(session, requestId, allow ? 'approved' : 'denied', reason ?? null);
    pending.resolve(allow ? { decision: 'accept' } : DECLINE);
    return true;
  }

  /** Answers (or, with null, skips) a question the agent is waiting on. */
  answer(id: string, requestId: string, answers: Record<string, string[]> | null): boolean {
    const session = this.sessions.get(id);
    const pending = session?.requests.get(requestId);
    if (!session || !pending || pending.request.kind !== 'question') return false;
    const asked = pending.request.questions ?? [];
    if (answers && asked.some((question) => !answers[question.id]?.some((value) => value.trim()))) return false;
    this.settleRequest(session, requestId, answers ? 'approved' : 'denied', null);
    if (answers) {
      const text = asked.map((question) => `${question.header || question.prompt}：${answers[question.id]!.join('、')}`).join('\n');
      session.timeline.apply({ type: 'notice', id: `answer:${requestId}`, level: 'info', text: `已回答提问\n${text}` });
    }
    pending.resolve(answers ? { answers } : DECLINE);
    return true;
  }

  /** Ends the session and forgets it, including its saved history. */
  async close(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;
    this.sessions.delete(id);
    await session.driver?.close(true);
    this.sessionsChanged();
  }

  /** Stops every session's process but keeps them, so they can be resumed after a restart. */
  async dispose(): Promise<void> {
    this.disposing = true;
    await Promise.all([...this.sessions.values()].map((session) => session.driver?.close(true)));
    this.writer?.writeSync(() => this.serialize());
    this.writer?.close();
  }

  private track(info: AgentSessionInfo, initial?: WorkerTimelineSnapshot): Session {
    const session: Session = {
      info, driver: null, requests: new Map(),
      turns: initial?.turns.length ?? 0,
      timeline: new WorkerTimeline({
        workerHandle: info.id, cliId: info.provider, model: info.model, readOnly: info.policy === 'read-only',
        redact: (text) => session.driver?.redactText(text) ?? text,
        now: this.now,
        initial,
        onPatch: (change) => {
          for (const listener of this.timelineListeners) listener(change);
        },
      }),
    };
    this.sessions.set(info.id, session);
    return session;
  }

  private resumable(session: Session): boolean {
    const { status, providerSessionId } = session.info;
    return Boolean(providerSessionId) && !session.driver?.alive && (status === 'suspended' || status === 'failed');
  }

  /** Starts the provider process and opens (or, with `resume`, rejoins) the conversation. */
  private async connect(session: Session, resume = false): Promise<void> {
    const { info, timeline } = session;
    info.status = 'starting';
    info.error = null;
    if (resume) this.sessionsChanged();
    try {
      session.driver = this.deps.launch(info.id, info.cwd, this.eventsFor(session));
      info.provider = session.driver.provider;
      info.providerSessionId = await session.driver.open({
        cwd: info.cwd, model: info.model, policy: info.policy, network: info.network,
        ...(resume && info.providerSessionId ? { resumeSessionId: info.providerSessionId } : {}),
      });
      if (!session.driver.alive) throw new Error(info.error ?? 'The agent closed while starting');
      info.status = 'idle';
      timeline.setMeta({ alive: true, providerSessionId: info.providerSessionId });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      info.status = 'failed';
      info.error = resume ? `无法恢复会话：${reason}` : reason;
      timeline.setMeta({ alive: false });
      await session.driver?.close();
    }
    this.sessionsChanged();
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
        if (request.signal.aborted) return Promise.resolve(DECLINE);
        const requestId = `req_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
        return new Promise<AgentRuntimeResponse>((resolve) => {
          session.requests.set(requestId, { turnKey, request, resolve });
          if (request.kind === 'question') {
            info.pendingQuestions.push({ requestId, questions: request.questions ?? [] });
            this.sessionsChanged();
            return;
          }
          timeline.upsertApproval({
            approvalId: requestId, dispatchId: turnKey, method: request.method,
            tool: request.method.split('/')[1] ?? request.method,
            input: request.toolInput, reason: request.message ?? null, status: 'pending',
          });
        });
      },
      onExit: (reason) => {
        this.cancelRequests(session, reason);
        const expected = Boolean(session.driver?.closing) && !info.error;
        timeline.endActiveTurn(expected ? 'interrupted' : 'failed', reason);
        timeline.setMeta({ alive: false });
        if (info.status !== 'failed') {
          info.status = this.disposing && info.providerSessionId ? 'suspended' : expected ? 'closed' : 'failed';
          if (info.status === 'failed') info.error ??= reason;
        }
        if (this.sessions.has(info.id)) this.sessionsChanged();
      },
    };
  }

  private settleRequest(session: Session, requestId: string, status: 'approved' | 'denied' | 'expired', reason: string | null): void {
    const pending = session.requests.get(requestId);
    if (!pending) return;
    session.requests.delete(requestId);
    if (pending.request.kind === 'question') {
      session.info.pendingQuestions = session.info.pendingQuestions.filter((entry) => entry.requestId !== requestId);
      this.sessionsChanged();
      return;
    }
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

  private load(): void {
    const file = this.deps.storageFile?.();
    if (!file || !existsSync(file)) return;
    let saved: SavedSession[] = [];
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as { version?: number; sessions?: SavedSession[] };
      if (parsed.version === 1 && Array.isArray(parsed.sessions)) saved = parsed.sessions;
    } catch (error) {
      console.warn('[agent-sessions] ignoring unreadable saved sessions:', error);
    }
    for (const entry of saved) {
      if (!entry?.id || !AGENT_SESSION_ID.test(entry.id) || !entry.providerSessionId || !entry.timeline) continue;
      const { timeline, ...rest } = entry;
      const session = this.track({ ...rest, network: rest.network === true, status: 'suspended', error: null, pendingQuestions: [] }, timeline);
      session.timeline.setMeta({ alive: false });
    }
  }

  private serialize(): string {
    const sessions: SavedSession[] = [...this.sessions.values()]
      .filter((session) => session.info.providerSessionId)
      .sort((a, b) => b.info.createdAt - a.info.createdAt)
      .slice(0, MAX_SAVED_SESSIONS)
      .map(({ info, timeline }) => {
        const { status: _status, error: _error, pendingQuestions: _questions, ...rest } = info;
        return { ...rest, timeline: timeline.archive() };
      });
    return JSON.stringify({ version: 1, sessions });
  }

  private sessionsChanged(): void {
    if (!this.disposing) {
      void this.writer?.write(() => this.serialize()).catch((error) => {
        console.warn('[agent-sessions] failed to save sessions:', error);
      });
    }
    const sessions = this.list();
    for (const listener of this.sessionListeners) listener(sessions);
  }
}
