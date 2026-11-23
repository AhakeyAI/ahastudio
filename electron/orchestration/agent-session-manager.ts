import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { AtomicSnapshotWriter } from '../persistence/atomic-snapshot-writer.js';
import type {
  AgentProvider, AgentQuestion, AgentRuntimeRequest, AgentRuntimeResponse, AgentSessionDriver, AgentSessionEvents,
  AgentSessionPolicy, AgentTurnAttachment, TurnDelivery,
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
  /** Acts as a Coordinator through Aha MCP; only switched while idle, and kept across restarts. */
  orchestration: boolean;
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
  /** Bumped for each provider process, so a replaced process cannot change the session. */
  generation: number;
  /** The provider accepted a turn; Codex saves a thread only then, so before it there is nothing to resume. */
  hasTurns: boolean;
  /** Policy the live process was launched with; Aha MCP approvals are baked in at that point. */
  launchedPolicy: AgentSessionPolicy | null;
  /** A title the person chose that the provider has not stored yet; sent when a process is next up. */
  unsyncedName: string | null;
}

export interface AgentSessionManagerDependencies {
  launch: (
    sessionId: string, cwd: string, events: AgentSessionEvents,
    options: { orchestration: boolean; policy: AgentSessionPolicy },
  ) => AgentSessionDriver;
  /** Coordinator rules for an orchestrating session's conversation; without it orchestration mode is unavailable. */
  coordinatorInstructions?: (sessionId: string, options: { policy: AgentSessionPolicy }) => string;
  /** A session stopped coordinating (switched off or closed); its pending orchestration state can go. */
  onCoordinatorEnded?: (sessionId: string) => void;
  /**
   * A message the person typed started a turn in an orchestrating session. Only these turns can
   * confirm the Coordinator's dispatch proposals; turns AhaStation starts itself never call this.
   */
  onUserTurn?: (sessionId: string) => void;
  /** An orchestrating session became idle and can take a system turn (see `wake`). */
  onCoordinatorIdle?: (sessionId: string) => void;
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
      orchestration: false, providerSessionId: null, status: 'starting', error: null, pendingQuestions: [], createdAt: this.now(),
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
    attachments?: readonly AgentTurnAttachment[];
  }): Promise<TurnDelivery> {
    const session = this.sessions.get(id);
    const text = input.text.trim();
    if (!session) return { status: 'not_accepted', reason: 'Session not found' };
    if (!text && !input.attachments?.length) return { status: 'not_accepted', reason: 'Message is empty' };
    const { info } = session;
    const wanted = input.policy ?? info.policy;
    if (this.resumable(session)) {
      const previous = info.policy;
      if (info.orchestration) info.policy = wanted;
      await this.connect(session, true);
      if (session.info.status !== 'idle') {
        info.policy = previous;
        this.sessionsChanged();
        return { status: 'not_accepted', reason: session.info.error ?? 'Session did not resume' };
      }
    }
    if (!session.driver?.alive || session.info.status !== 'idle') {
      return { status: 'not_accepted', reason: `Session is ${session.info.status}` };
    }
    // An orchestrating session whose approval tier changed must be relaunched: the Aha MCP tool
    // approvals are baked into the process arguments, so a per-turn policy delta cannot grant
    // manage_worker under `full-auto`. The other tiers differ only per turn and need no relaunch.
    if (info.orchestration && (wanted === 'full-auto') !== (session.launchedPolicy === 'full-auto')) {
      const previous = info.policy;
      info.policy = wanted;
      const driver = session.driver;
      session.generation++;
      session.driver = null;
      info.status = 'starting';
      this.sessionsChanged();
      await driver.close();
      await this.connect(session, true);
      // connect() moved the status on; widen the type narrowed by the assignment above.
      if ((info.status as AgentSessionStatus) !== 'idle') {
        info.policy = previous;
        this.sessionsChanged();
        return { status: 'not_accepted', reason: info.error ?? 'Session did not restart' };
      }
    }
    if (!session.info.title) {
      const firstSkill = input.attachments?.find((item) => item.type === 'skill');
      session.info.title = (text.split('\n')[0] || (firstSkill?.type === 'skill' ? `$${firstSkill.name}` : '附件')).slice(0, 60);
    }
    const delivery = await this.startTurn(session, text, input);
    if (delivery.status === 'accepted' && session.info.orchestration) this.deps.onUserTurn?.(id);
    // Codex may refuse to name a thread before its first turn; try again once it has one.
    if (delivery.status === 'accepted' && session.unsyncedName) void this.syncName(session);
    return delivery;
  }

  /**
   * Starts a system turn in an idle orchestrating session, for Worker news and stall reminders. It
   * never resumes a stopped conversation and never counts as the person's message.
   */
  async wake(id: string, prompt: string): Promise<TurnDelivery> {
    const session = this.sessions.get(id);
    const text = prompt.trim();
    if (!session || !text) return { status: 'not_accepted', reason: 'Nothing to deliver' };
    if (!this.coordinatorState(id)?.idle) return { status: 'not_accepted', reason: 'Session is not an idle Coordinator' };
    return this.startTurn(session, text, {}, 'system');
  }

  private async startTurn(
    session: Session, text: string,
    input: {
      model?: string | null; effort?: string | null; policy?: AgentSessionPolicy; network?: boolean;
      attachments?: readonly AgentTurnAttachment[];
    },
    origin?: 'system',
  ): Promise<TurnDelivery> {
    const { info, timeline } = session;
    const driver = session.driver!;
    const turnKey = `${info.id}:${++session.turns}`;
    const attachments = input.attachments ?? [];
    info.status = 'running';
    timeline.beginTurn({
      dispatchId: turnKey, prompt: text, ...(origin ? { origin } : {}),
      attachments: attachments.map((item) => item.type === 'skill'
        ? { kind: 'skill' as const, name: item.name }
        : { kind: item.type === 'localImage' ? 'image' as const : 'file' as const, name: item.name || basename(item.path) }),
    });
    this.sessionsChanged();
    const delivery = await driver.startTurn({
      turnKey, prompt: text, ...(attachments.length ? { attachments } : {}),
      effort: input.effort ?? info.effort,
      ...(input.model && input.model !== info.model ? { model: input.model } : {}),
      ...(input.policy && input.policy !== info.policy ? { policy: input.policy } : {}),
      ...(input.network !== undefined && input.network !== info.network ? { network: input.network } : {}),
    });
    if (delivery.status === 'accepted') {
      session.hasTurns = true;
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
        await driver.close();
      } else if (info.status === 'running') {
        info.status = 'idle';
      }
    }
    this.sessionsChanged();
    if (delivery.status !== 'accepted') this.coordinatorSettled(session);
    return delivery;
  }

  /** Coordinator state the orchestration service checks before trusting the session's MCP calls. */
  coordinatorState(id: string): { cwd: string; provider: string; active: boolean; idle: boolean; network: boolean } | null {
    const session = this.sessions.get(id);
    if (!session) return null;
    const { info, driver } = session;
    const live = info.status === 'starting' || info.status === 'idle' || info.status === 'running';
    const active = info.orchestration && live;
    const idle = active && info.status === 'idle' && Boolean(driver?.alive) && !driver?.busy && session.requests.size === 0;
    return { cwd: info.cwd, provider: info.provider, active, idle, network: info.network };
  }

  /**
   * Switches orchestration mode between turns. A running provider process is replaced and the same
   * conversation resumed with (or without) Aha MCP; a suspended session takes the mode on its next resume.
   */
  async setOrchestration(id: string, enabled: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: '会话不存在' };
    const { info } = session;
    if (info.orchestration === enabled) return { ok: true };
    if (enabled && !this.deps.coordinatorInstructions) return { ok: false, error: '编排模式当前不可用' };
    if (info.status === 'starting' || info.status === 'running' || session.driver?.busy || session.requests.size > 0) {
      return { ok: false, error: '请等本轮结束后再切换编排模式' };
    }
    if (!info.providerSessionId || info.status === 'closed') return { ok: false, error: '这个会话无法切换编排模式' };
    info.orchestration = enabled;
    if (!enabled) this.deps.onCoordinatorEnded?.(id);
    const driver = session.driver;
    if (!driver?.alive) {
      this.sessionsChanged();
      return { ok: true };
    }
    session.generation++;
    session.driver = null;
    info.status = 'starting';
    this.sessionsChanged();
    await driver.close();
    await this.connect(session, true);
    // connect() moved the status on; widen the type narrowed by the assignment above.
    if ((info.status as AgentSessionStatus) === 'idle') return { ok: true };
    // Fall back to the previous mode; the conversation resumes with it on the next message.
    const error = info.error ?? '会话没有恢复';
    info.orchestration = !enabled;
    if (enabled) this.deps.onCoordinatorEnded?.(id);
    this.sessionsChanged();
    return { ok: false, error };
  }

  async interrupt(id: string): Promise<boolean> {
    return (await this.sessions.get(id)?.driver?.interrupt()) ?? false;
  }

  /**
   * Retitles the session. The title is kept here at once; the provider thread is renamed too, now
   * if its process is up, otherwise the next time it starts. `synced` says whether that happened.
   */
  async rename(id: string, title: string): Promise<{ ok: true; synced: boolean } | { ok: false; error: string }> {
    const session = this.sessions.get(id);
    if (!session) return { ok: false, error: '会话不存在' };
    const name = title.replace(/\s+/gu, ' ').trim();
    if (!name) return { ok: false, error: '标题不能为空' };
    session.info.title = name;
    session.unsyncedName = name;
    this.sessionsChanged();
    return { ok: true, synced: await this.syncName(session) };
  }

  private async syncName(session: Session): Promise<boolean> {
    const { driver, unsyncedName: name } = session;
    if (!name || !driver?.alive || !driver.sessionId || !driver.setName) return false;
    const synced = await driver.setName(name);
    // A newer rename while this one was in flight keeps its own pending name.
    if (synced && session.unsyncedName === name) session.unsyncedName = null;
    return synced;
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
    if (session.info.orchestration) this.deps.onCoordinatorEnded?.(id);
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
      info, driver: null, requests: new Map(), generation: 0, launchedPolicy: null, unsyncedName: null,
      turns: initial?.turns.length ?? 0,
      // A turn that never reached the provider ends failed with no turn id and no output.
      hasTurns: initial?.turns.some((turn) => turn.status !== 'failed' || turn.turnId !== null || turn.items.length > 0) ?? false,
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

  /**
   * Starts the provider process and opens (or, with `resume`, rejoins) the conversation. A thread
   * that never took a turn cannot be rejoined, so it is replaced by a new one.
   */
  private async connect(session: Session, resume = false): Promise<void> {
    const { info, timeline } = session;
    const rejoin = resume && Boolean(info.providerSessionId) && session.hasTurns;
    info.status = 'starting';
    info.error = null;
    if (resume) this.sessionsChanged();
    const generation = ++session.generation;
    try {
      const orchestration = info.orchestration;
      const developerInstructions = orchestration
        ? this.deps.coordinatorInstructions?.(info.id, { policy: info.policy })
        : undefined;
      session.driver = this.deps.launch(info.id, info.cwd, this.eventsFor(session, generation), {
        orchestration, policy: info.policy,
      });
      session.launchedPolicy = info.policy;
      info.provider = session.driver.provider;
      info.providerSessionId = await session.driver.open({
        cwd: info.cwd, model: info.model, policy: info.policy, network: info.network,
        ...(developerInstructions ? { developerInstructions } : {}),
        ...(rejoin && info.providerSessionId ? { resumeSessionId: info.providerSessionId } : {}),
      });
      if (!session.driver.alive) throw new Error(info.error ?? 'The agent closed while starting');
      // What the provider actually uses, e.g. a default from the person's own config.
      info.model = session.driver.effectiveModel ?? info.model;
      info.effort = session.driver.effectiveEffort ?? info.effort;
      info.status = 'idle';
      timeline.setMeta({ alive: true, providerSessionId: info.providerSessionId });
      void this.syncName(session);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      info.status = 'failed';
      info.error = rejoin ? `无法恢复会话：${reason}` : reason;
      timeline.setMeta({ alive: false });
      await session.driver?.close();
    }
    this.sessionsChanged();
    this.coordinatorSettled(session);
  }

  private coordinatorSettled(session: Session): void {
    if (session.info.orchestration && session.info.status === 'idle') this.deps.onCoordinatorIdle?.(session.info.id);
  }

  private eventsFor(session: Session, generation: number): AgentSessionEvents {
    const { info, timeline } = session;
    const current = () => session.generation === generation;
    return {
      onTurnStarted: () => {},
      onTimeline: (turnKey, event) => {
        if (current() && timeline.activeTurn?.dispatchId === turnKey) timeline.apply(event);
      },
      onTurnCompleted: (_turnKey, result) => {
        if (!current()) return;
        this.cancelRequests(session, 'Turn ended');
        timeline.completeTurn({
          turnId: result.turnId, stopReason: result.stopReason, usage: result.usage, error: result.error,
          status: result.stopReason === 'completed' ? 'completed'
            : result.stopReason === 'interrupted' ? 'interrupted' : 'failed',
        });
        if (info.status === 'running') info.status = 'idle';
        this.sessionsChanged();
        this.coordinatorSettled(session);
      },
      onRequest: (turnKey, request) => {
        if (!current() || request.signal.aborted) return Promise.resolve(DECLINE);
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
        if (!current()) return;
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
      const session = this.track({ ...rest, network: rest.network === true, orchestration: rest.orchestration === true, status: 'suspended', error: null, pendingQuestions: [] }, timeline);
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
