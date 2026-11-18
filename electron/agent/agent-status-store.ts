import {
  classifyAgentTitleStatus,
  createAgentPtyOscScanner,
  detectCliStartupConfirmationPrompt,
  normalizeAgentId,
  PROGRAM_STATUS_QUERY_REPLY,
  type AgentPtyOscEvent,
  type ProgramStatusKind,
  type ProgramStatusReport,
} from './program-status-osc.js';

export type AgentLifecycleState = 'idle' | 'working' | 'waiting' | 'done' | 'error';
export type AgentWaitKind = ProgramStatusKind;
export type AgentStatusSource = 'hook' | 'osc7501' | 'title' | 'process';

export interface AgentSubagentStatus {
  id: string;
  state: 'working' | 'waiting' | 'idle';
  title?: string;
  startedAt: number;
}

export interface AgentPaneStatus {
  ptyId: string;
  agentId: string | null;
  state: AgentLifecycleState;
  waitKind?: AgentWaitKind;
  source: AgentStatusSource;
  message?: string;
  toolName?: string;
  toolInput?: string;
  progress?: number;
  subagents: AgentSubagentStatus[];
  unread: boolean;
  stateStartedAt: number;
  updatedAt: number;
}

export interface AgentPaneActivitySnapshot {
  ptyId: string;
  exists: boolean;
  state: AgentLifecycleState | null;
  source: AgentStatusSource | null;
  workingSequence: number;
  permissionSequence: number;
  outputSequence: number;
  lastHookAt: number;
  hookWorkingAt: number;
  stateStartedAt: number;
  updatedAt: number;
}

export interface NormalizedAgentHookEvent {
  ptyId: string;
  agentId?: string | null;
  state?: AgentLifecycleState;
  waitKind?: AgentWaitKind;
  message?: string;
  toolName?: string;
  toolInput?: string;
  clearTool?: boolean;
  progress?: number;
  subagentOp?: {
    action: 'start' | 'stop';
    id: string;
    title?: string;
  };
}

const HOOK_PRECEDENCE_MS = 120_000;
const MAX_TRACKED_PANES = 256;
const MAX_STARTUP_BUFFER_CHARS = 2048;
const TRUST_WAIT_MESSAGE = 'Waiting for directory trust confirmation';

interface InternalPaneRecord {
  status: AgentPaneStatus;
  subagents: Map<string, AgentSubagentStatus>;
  oscScanner: (data: string) => AgentPtyOscEvent[];
  osc7501ActiveInInvocation: boolean;
  lastHookAt: number;
  hookWorkingAt: number;
  workingSequence: number;
  permissionSequence: number;
  outputSequence: number;
  startupBuffer: string;
  startupTrustBlocked: boolean;
  lastDigest: string;
}

function cloneStatus(status: AgentPaneStatus): AgentPaneStatus {
  return {
    ...status,
    subagents: status.subagents.map((sub) => ({ ...sub })),
  };
}

function statusDigest(status: AgentPaneStatus): string {
  return JSON.stringify({
    agentId: status.agentId,
    state: status.state,
    waitKind: status.waitKind ?? null,
    source: status.source,
    message: status.message ?? null,
    toolName: status.toolName ?? null,
    toolInput: status.toolInput ?? null,
    progress: status.progress ?? null,
    subagents: status.subagents,
    unread: status.unread,
  });
}

function isAttentionTransition(prev: AgentLifecycleState, next: AgentLifecycleState): boolean {
  if (next === 'waiting' && prev !== 'waiting') return true;
  if (next === 'error' && prev !== 'error') return true;
  if (next === 'done' && (prev === 'working' || prev === 'waiting')) return true;
  return false;
}

export class AgentStatusStore {
  private readonly panes = new Map<string, InternalPaneRecord>();
  private readonly exitedPanes = new Set<string>();
  private readonly changeListeners = new Set<(status: AgentPaneStatus) => void>();
  private readonly attentionListeners = new Set<(status: AgentPaneStatus) => void>();
  private readonly activityListeners = new Set<(snapshot: AgentPaneActivitySnapshot) => void>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  onChange(listener: (status: AgentPaneStatus) => void): () => void {
    this.changeListeners.add(listener);
    return () => {
      this.changeListeners.delete(listener);
    };
  }

  onAttention(listener: (status: AgentPaneStatus) => void): () => void {
    this.attentionListeners.add(listener);
    return () => {
      this.attentionListeners.delete(listener);
    };
  }

  onActivity(listener: (snapshot: AgentPaneActivitySnapshot) => void): () => void {
    this.activityListeners.add(listener);
    return () => {
      this.activityListeners.delete(listener);
    };
  }

  registerPane(ptyId: string, opts?: { agentId?: string | null }): AgentPaneStatus {
    this.exitedPanes.delete(ptyId);
    const existing = this.panes.get(ptyId);
    const normalizedAgent = opts?.agentId !== undefined ? normalizeAgentId(opts.agentId) : undefined;
    if (existing) {
      if (normalizedAgent !== undefined && existing.status.agentId !== normalizedAgent) {
        existing.status.agentId = normalizedAgent;
        existing.status.updatedAt = this.now();
        if (this.commitIfChanged(existing, existing.status.state)) {
          this.emitActivitySnapshot(this.toActivitySnapshot(existing));
        }
      }
      return cloneStatus(existing.status);
    }

    if (this.panes.size >= MAX_TRACKED_PANES) {
      const oldestKey = this.panes.keys().next().value;
      if (oldestKey) this.panes.delete(oldestKey);
    }

    const ts = this.now();
    const initial: AgentPaneStatus = {
      ptyId,
      agentId: normalizedAgent ?? null,
      state: 'idle',
      source: 'process',
      subagents: [],
      unread: false,
      stateStartedAt: ts,
      updatedAt: ts,
    };
    const record: InternalPaneRecord = {
      status: initial,
      subagents: new Map(),
      oscScanner: createAgentPtyOscScanner(),
      osc7501ActiveInInvocation: false,
      lastHookAt: 0,
      hookWorkingAt: 0,
      workingSequence: 0,
      permissionSequence: 0,
      outputSequence: 0,
      startupBuffer: '',
      startupTrustBlocked: false,
      lastDigest: statusDigest(initial),
    };
    this.panes.set(ptyId, record);
    return cloneStatus(initial);
  }

  removePane(ptyId: string): void {
    this.rememberPtyExit(ptyId);
    const existing = this.panes.get(ptyId);
    this.panes.delete(ptyId);
    if (existing) {
      this.emitActivitySnapshot({
        ptyId,
        exists: false,
        state: null,
        source: null,
        workingSequence: existing.workingSequence,
        permissionSequence: existing.permissionSequence,
        outputSequence: existing.outputSequence,
        lastHookAt: existing.lastHookAt,
        hookWorkingAt: existing.hookWorkingAt,
        stateStartedAt: existing.status.stateStartedAt,
        updatedAt: this.now(),
      });
    }
  }

  get(ptyId: string): AgentPaneStatus | null {
    const record = this.panes.get(ptyId);
    return record ? cloneStatus(record.status) : null;
  }

  getActivitySnapshot(ptyId: string): AgentPaneActivitySnapshot | null {
    const record = this.panes.get(ptyId);
    return record ? this.toActivitySnapshot(record) : null;
  }

  list(): AgentPaneStatus[] {
    return [...this.panes.values()].map((record) => cloneStatus(record.status));
  }

  acknowledge(ptyId: string): AgentPaneStatus | null {
    const record = this.panes.get(ptyId);
    if (!record) return null;
    if (record.status.unread) {
      record.status.unread = false;
      record.status.updatedAt = this.now();
      this.commitIfChanged(record, record.status.state);
    }
    return cloneStatus(record.status);
  }

  ingestPtyData(ptyId: string, utf8Chunk: string): { replyToWrite?: string } {
    if (this.exitedPanes.has(ptyId)) return {};
    const record = this.ensureRecord(ptyId);
    const hasOutput = utf8Chunk.length > 0;
    if (hasOutput) {
      record.outputSequence += 1;
      record.status.updatedAt = this.now();
    }
    const events = record.oscScanner(utf8Chunk);
    let replyToWrite: string | undefined;
    let emittedActivity = false;

    for (const event of events) {
      switch (event.type) {
        case 'osc7501-query':
          replyToWrite = PROGRAM_STATUS_QUERY_REPLY;
          break;
        case 'osc7501-report':
          if (this.applyOsc7501Report(record, event.report)) {
            emittedActivity = true;
          }
          break;
        case 'title':
          if (this.applyTitle(record, event.title)) {
            emittedActivity = true;
          }
          break;
        case 'prompt-start':
        case 'full-reset':
          if (this.applyShellBoundary(record)) {
            emittedActivity = true;
          }
          break;
      }
    }

    if (hasOutput && !emittedActivity) {
      if (
        record.workingSequence === 0 &&
        !this.hasFreshHook(record) &&
        !record.osc7501ActiveInInvocation
      ) {
        const lastClear2J = utf8Chunk.lastIndexOf('\x1b[2J');
        const lastReset = utf8Chunk.lastIndexOf('\x1bc');
        const clearIndex = Math.max(lastClear2J, lastReset);
        const hasScreenClear = clearIndex !== -1;
        if (hasScreenClear) {
          record.startupBuffer = utf8Chunk.slice(clearIndex);
        } else {
          record.startupBuffer += utf8Chunk;
        }
        if (record.startupBuffer.length > MAX_STARTUP_BUFFER_CHARS) {
          record.startupBuffer = record.startupBuffer.slice(-MAX_STARTUP_BUFFER_CHARS);
        }

        const trustPrompt = detectCliStartupConfirmationPrompt(record.startupBuffer);
        if (trustPrompt) {
          if (record.status.state !== 'waiting') {
            const prevState = record.status.state;
            const ts = this.now();
            record.startupTrustBlocked = true;
            record.status.state = 'waiting';
            record.status.waitKind = 'permission';
            record.status.source = 'process';
            record.status.message = trustPrompt;
            record.status.stateStartedAt = ts;
            record.status.updatedAt = ts;
            record.permissionSequence += 1;
            this.commitIfChanged(record, prevState);
            this.emitActivitySnapshot(this.toActivitySnapshot(record));
            emittedActivity = true;
          }
        } else if (record.startupTrustBlocked && hasScreenClear) {
          if (this.resolveStartupTrustToIdle(record)) {
            emittedActivity = true;
          }
        }
      }
      if (!emittedActivity) {
        this.emitActivitySnapshot(this.toActivitySnapshot(record));
      }
    }

    return replyToWrite ? { replyToWrite } : {};
  }

  notifyUserInput(ptyId: string, data: string): void {
    const record = this.panes.get(ptyId);
    if (!record || !record.startupTrustBlocked) return;
    if (!data.includes('\r') && !data.includes('\n')) return;
    this.resolveStartupTrustToIdle(record);
  }

  private resolveStartupTrustToIdle(record: InternalPaneRecord): boolean {
    const prevState = record.status.state;
    this.clearStartupTrustState(record);
    if (prevState !== 'waiting') return false;
    const ts = this.now();
    record.status.state = 'idle';
    record.status.source = 'process';
    record.status.unread = false;
    delete record.status.waitKind;
    if (record.status.message === TRUST_WAIT_MESSAGE) {
      delete record.status.message;
    }
    record.status.stateStartedAt = ts;
    record.status.updatedAt = ts;
    this.commitIfChanged(record, prevState);
    this.emitActivitySnapshot(this.toActivitySnapshot(record));
    return true;
  }

  seedStartupScreen(ptyId: string, screen: string): void {
    if (detectCliStartupConfirmationPrompt(screen)) this.ingestPtyData(ptyId, screen);
  }

  ingestHookEvent(event: NormalizedAgentHookEvent): AgentPaneStatus | null {
    if (this.exitedPanes.has(event.ptyId)) return this.get(event.ptyId);
    const record = this.ensureRecord(event.ptyId);
    const prevState = record.status.state;
    const ts = this.now();

    this.clearStartupTrustState(record);
    if (record.status.message === TRUST_WAIT_MESSAGE && event.message === undefined) {
      delete record.status.message;
    }
    record.lastHookAt = ts;
    record.status.source = 'hook';

    if (event.agentId !== undefined && event.agentId !== null) {
      record.status.agentId = normalizeAgentId(event.agentId) ?? event.agentId;
    }

    if (event.subagentOp) {
      if (event.subagentOp.action === 'start') {
        const existingSub = record.subagents.get(event.subagentOp.id);
        record.subagents.set(event.subagentOp.id, {
          id: event.subagentOp.id,
          state: 'working',
          title: event.subagentOp.title ?? existingSub?.title,
          startedAt: existingSub?.startedAt ?? ts,
        });
      } else {
        record.subagents.delete(event.subagentOp.id);
      }
      record.status.subagents = [...record.subagents.values()];
    }

    if (event.state !== undefined) {
      record.status.state = event.state;
      if (event.state === 'working') {
        record.workingSequence += 1;
        record.hookWorkingAt = ts;
      } else if (event.state === 'waiting') {
        record.permissionSequence += 1;
      }
      if (event.state !== prevState) {
        record.status.stateStartedAt = ts;
      }
      if (event.state === 'waiting') {
        record.status.waitKind = event.waitKind ?? 'permission';
      } else {
        delete record.status.waitKind;
      }

      if (event.state === 'idle' || event.state === 'done' || event.state === 'error') {
        delete record.status.toolName;
        delete record.status.toolInput;
        delete record.status.progress;
      }
      if (event.state === 'working' || event.state === 'idle') {
        record.status.unread = false;
      }
    }

    if (event.clearTool) {
      delete record.status.toolName;
      delete record.status.toolInput;
    }
    if (event.toolName !== undefined) {
      record.status.toolName = event.toolName;
    }
    if (event.toolInput !== undefined) {
      record.status.toolInput = event.toolInput;
    }
    if (event.message !== undefined) {
      record.status.message = event.message;
    }
    if (event.progress !== undefined) {
      record.status.progress = event.progress;
    }

    record.status.updatedAt = ts;
    const changed = this.commitIfChanged(record, prevState);
    if (
      changed ||
      event.state === 'working' ||
      event.state === 'waiting' ||
      (event.state !== undefined && event.state !== prevState)
    ) {
      this.emitActivitySnapshot(this.toActivitySnapshot(record));
    }
    return cloneStatus(record.status);
  }

  handlePtyExit(ptyId: string, exitCode: number | null): void {
    this.rememberPtyExit(ptyId);
    const record = this.panes.get(ptyId);
    if (!record) return;
    const prevState = record.status.state;
    const ts = this.now();

    record.osc7501ActiveInInvocation = false;
    record.lastHookAt = 0;
    this.clearStartupTrustState(record);
    if (record.status.message === TRUST_WAIT_MESSAGE) {
      delete record.status.message;
    }
    record.subagents.clear();
    record.status.subagents = [];
    delete record.status.toolName;
    delete record.status.toolInput;
    delete record.status.progress;
    delete record.status.waitKind;

    if (prevState === 'working' || prevState === 'waiting') {
      record.status.state = exitCode !== null && exitCode !== 0 ? 'error' : 'done';
      record.status.source = 'process';
      record.status.stateStartedAt = ts;
    }

    record.status.updatedAt = ts;
    const changed = this.commitIfChanged(record, prevState);
    if (changed || prevState !== record.status.state) {
      this.emitActivitySnapshot(this.toActivitySnapshot(record));
    }
  }

  private rememberPtyExit(ptyId: string): void {
    this.exitedPanes.add(ptyId);
    if (this.exitedPanes.size > MAX_TRACKED_PANES * 2) {
      const oldest = this.exitedPanes.values().next().value;
      if (oldest) this.exitedPanes.delete(oldest);
    }
  }

  private clearStartupTrustState(record: InternalPaneRecord): void {
    record.startupBuffer = '';
    record.startupTrustBlocked = false;
  }

  private ensureRecord(ptyId: string): InternalPaneRecord {
    const existing = this.panes.get(ptyId);
    if (existing) return existing;
    this.registerPane(ptyId);
    return this.panes.get(ptyId)!;
  }

  private hasFreshHook(record: InternalPaneRecord): boolean {
    return record.lastHookAt > 0 && this.now() - record.lastHookAt <= HOOK_PRECEDENCE_MS;
  }

  private toActivitySnapshot(record: InternalPaneRecord): AgentPaneActivitySnapshot {
    return {
      ptyId: record.status.ptyId,
      exists: true,
      state: record.status.state,
      source: record.status.source,
      workingSequence: record.workingSequence,
      permissionSequence: record.permissionSequence,
      outputSequence: record.outputSequence,
      lastHookAt: record.lastHookAt,
      hookWorkingAt: record.hookWorkingAt,
      stateStartedAt: record.status.stateStartedAt,
      updatedAt: record.status.updatedAt,
    };
  }

  private emitActivitySnapshot(snapshot: AgentPaneActivitySnapshot): void {
    if (this.activityListeners.size === 0) return;
    for (const listener of this.activityListeners) {
      try {
        listener(snapshot);
      } catch {
        /* listener errors must not break status ingestion */
      }
    }
  }

  private applyOsc7501Report(record: InternalPaneRecord, report: ProgramStatusReport): boolean {
    record.osc7501ActiveInInvocation = true;
    this.clearStartupTrustState(record);
    if (record.status.message === TRUST_WAIT_MESSAGE && report.msg === undefined && report.title === undefined) {
      delete record.status.message;
    }
    // Let recent managed hooks remain authoritative unless silent for > 120s.
    if (this.hasFreshHook(record)) {
      return false;
    }

    const prevState = record.status.state;
    const ts = this.now();

    if (report.app) {
      record.status.agentId = normalizeAgentId(report.app) ?? report.app;
    }

    if (report.id !== null) {
      if (report.state === 'done' || report.state === 'error' || report.state === 'clear') {
        record.subagents.delete(report.id);
      } else {
        const existingSub = record.subagents.get(report.id);
        const mappedState: AgentSubagentStatus['state'] =
          report.state === 'working'
            ? 'working'
            : report.state === 'blocked'
              ? 'waiting'
              : 'idle';
        record.subagents.set(report.id, {
          id: report.id,
          state: mappedState,
          title: report.title ?? report.msg ?? existingSub?.title,
          startedAt: existingSub?.startedAt ?? ts,
        });
      }
      record.status.subagents = [...record.subagents.values()];
      record.status.source = 'osc7501';
      record.status.updatedAt = ts;
      const changed = this.commitIfChanged(record, prevState);
      if (changed) {
        this.emitActivitySnapshot(this.toActivitySnapshot(record));
        return true;
      }
      return false;
    }

    let nextState: AgentLifecycleState;
    switch (report.state) {
      case 'working':
        nextState = 'working';
        delete record.status.waitKind;
        break;
      case 'blocked':
        nextState = 'waiting';
        record.status.waitKind = report.kind ?? 'permission';
        break;
      case 'done':
        nextState = 'done';
        delete record.status.waitKind;
        break;
      case 'error':
        nextState = 'error';
        delete record.status.waitKind;
        break;
      case 'idle':
        // Preserve `done` across repeated resting `idle` heartbeats within the same invocation.
        nextState =
          prevState === 'working' || prevState === 'waiting' || prevState === 'done'
            ? 'done'
            : 'idle';
        delete record.status.waitKind;
        break;
      case 'clear':
        nextState = prevState === 'working' || prevState === 'waiting' ? 'done' : 'idle';
        delete record.status.waitKind;
        break;
    }

    record.status.state = nextState;
    record.status.source = 'osc7501';
    if (nextState === 'working') {
      record.workingSequence += 1;
    } else if (nextState === 'waiting') {
      record.permissionSequence += 1;
    }
    if (nextState !== prevState) {
      record.status.stateStartedAt = ts;
    }

    if (nextState === 'working' || nextState === 'idle') {
      record.status.unread = false;
    }

    if (nextState === 'idle' || nextState === 'done' || nextState === 'error') {
      delete record.status.progress;
      delete record.status.toolName;
      delete record.status.toolInput;
    } else if (report.progress !== undefined) {
      record.status.progress = report.progress;
    } else if (nextState !== prevState) {
      delete record.status.progress;
    }

    if (report.msg !== undefined) {
      record.status.message = report.msg;
    } else if (report.title !== undefined) {
      record.status.message = report.title;
    } else if (report.state === 'clear') {
      delete record.status.message;
    }

    if (report.state === 'clear') {
      record.subagents.clear();
      record.status.subagents = [];
    }

    record.status.updatedAt = ts;
    const changed = this.commitIfChanged(record, prevState);
    if (changed || nextState === 'working' || nextState === 'waiting' || nextState !== prevState) {
      this.emitActivitySnapshot(this.toActivitySnapshot(record));
      return true;
    }
    return false;
  }

  private applyTitle(record: InternalPaneRecord, title: string): boolean {
    if (record.osc7501ActiveInInvocation || this.hasFreshHook(record)) {
      return false;
    }
    const classified = classifyAgentTitleStatus(title);
    if (!classified) return false;

    this.clearStartupTrustState(record);
    if (record.status.message === TRUST_WAIT_MESSAGE && !classified.cleanTitle) {
      delete record.status.message;
    }

    const prevState = record.status.state;
    const ts = this.now();

    let nextState: AgentLifecycleState;
    if (classified.state === 'waiting') {
      nextState = 'waiting';
      record.status.waitKind = classified.waitKind ?? 'permission';
    } else if (classified.state === 'working') {
      nextState = 'working';
      delete record.status.waitKind;
    } else {
      nextState =
        prevState === 'working' || prevState === 'waiting' || prevState === 'done'
          ? 'done'
          : 'idle';
      delete record.status.waitKind;
    }

    record.status.state = nextState;
    record.status.source = 'title';
    if (nextState === 'working') {
      record.workingSequence += 1;
    } else if (nextState === 'waiting') {
      record.permissionSequence += 1;
    }
    if (nextState !== prevState) {
      record.status.stateStartedAt = ts;
    }
    if (nextState === 'working' || nextState === 'idle') {
      record.status.unread = false;
    }
    if (classified.cleanTitle) {
      record.status.message = classified.cleanTitle;
    }

    record.status.updatedAt = ts;
    const changed = this.commitIfChanged(record, prevState);
    if (changed || nextState === 'working' || nextState === 'waiting' || nextState !== prevState) {
      this.emitActivitySnapshot(this.toActivitySnapshot(record));
      return true;
    }
    return false;
  }

  private applyShellBoundary(record: InternalPaneRecord): boolean {
    const prevState = record.status.state;
    const ts = this.now();

    record.osc7501ActiveInInvocation = false;
    record.lastHookAt = 0;
    this.clearStartupTrustState(record);
    if (record.status.message === TRUST_WAIT_MESSAGE) {
      delete record.status.message;
    }
    record.subagents.clear();
    record.status.subagents = [];
    delete record.status.toolName;
    delete record.status.toolInput;
    delete record.status.progress;
    delete record.status.waitKind;

    if (prevState === 'working' || prevState === 'waiting') {
      record.status.state = 'done';
      record.status.source = 'process';
      record.status.stateStartedAt = ts;
    }

    record.status.updatedAt = ts;
    const changed = this.commitIfChanged(record, prevState);
    if (changed || prevState !== record.status.state) {
      this.emitActivitySnapshot(this.toActivitySnapshot(record));
      return true;
    }
    return false;
  }

  private commitIfChanged(record: InternalPaneRecord, prevState: AgentLifecycleState): boolean {
    const nextState = record.status.state;
    const becameAttention = isAttentionTransition(prevState, nextState);
    if (becameAttention) {
      record.status.unread = true;
    }

    const digest = statusDigest(record.status);
    if (digest === record.lastDigest) {
      return false;
    }
    record.lastDigest = digest;

    const snapshot = cloneStatus(record.status);
    for (const listener of this.changeListeners) {
      try {
        listener(snapshot);
      } catch {
        /* listener errors must not break status ingestion */
      }
    }
    if (becameAttention) {
      for (const listener of this.attentionListeners) {
        try {
          listener(snapshot);
        } catch {
          /* listener errors must not break status ingestion */
        }
      }
    }
    return true;
  }
}
