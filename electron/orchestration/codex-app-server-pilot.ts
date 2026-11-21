import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { augmentedPath, resolveBinaryFromPath } from '../bin-resolve.js';
import { spawnWindowsCodexJob } from './windows-codex-job.js';
import type {
  WorkerTimelineEvent, WorkerTimelineFileChange, WorkerTimelineItemStatus, WorkerTimelineItemUpdate,
} from './worker-timeline.js';

export const CODEX_WORKER_ID = /^codex-worker-[a-f0-9-]{36}$/;
const APPROVALS = { approvalPolicy: 'on-request', approvalsReviewer: 'user' };
const OUTPUT_LIMIT = 512 * 1024;
const STDERR_LIMIT = 4 * 1024;
const CHILD_CLOSE_TIMEOUT_MS = 3_000;

type Obj = Record<string, unknown>;
type RpcId = string | number;
type Delivery = { status: 'accepted' } | {
  status: 'not_accepted' | 'unknown_acceptance'; reason: string;
};

export interface CodexTurnResult {
  turnId: string;
  stopReason: string;
  finalText: string;
  diff: string | null;
  usage: Record<string, number> | null;
  error: string | null;
}

interface ActiveTurn {
  dispatchId: string;
  id: string | null;
  messages: Map<string, string>;
  usageBaseline: Record<string, number>;
  diff: string | null;
  usage: Record<string, number> | null;
  idle: Promise<void>;
  finish: () => void;
}

export interface CodexApproval {
  method: string;
  toolInput: string;
  message?: string;
  signal: AbortSignal;
}

export interface CodexPilotEvents {
  onTurnStarted: (dispatchId: string) => void;
  onTurnCompleted: (dispatchId: string, result: CodexTurnResult) => void;
  onApproval: (dispatchId: string, request: CodexApproval) => Promise<boolean>;
  onExit: (reason: string, exitCode: number | null) => void;
  /** Normalized process events for the active turn; text is already pilot-redacted. */
  onTimeline?: (dispatchId: string, event: WorkerTimelineEvent) => void;
}

class RpcRejection extends Error {}

function object(value: unknown): Obj {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Obj : {};
}

function string(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numericFields(value: unknown): Record<string, number> {
  return Object.fromEntries(Object.entries(object(value))
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number'));
}

function codexStatus(value: unknown): WorkerTimelineItemStatus {
  if (value === 'completed') return 'completed';
  if (value === 'failed') return 'failed';
  if (value === 'declined') return 'declined';
  return 'running';
}

function textParts(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value.map(object).map((part) => string(part.text) ?? '').filter(Boolean).join('\n');
}

function summarize(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function codexFileChanges(value: unknown): WorkerTimelineFileChange[] {
  if (!Array.isArray(value)) return [];
  return value.map(object).map((change) => {
    const kind = object(change.kind);
    const type = string(kind.type) ?? string(change.kind);
    return {
      path: string(change.path) ?? '',
      change: type === 'add' || type === 'delete' ? type : 'update',
      movePath: string(kind.move_path) ?? string(kind.movePath) ?? null,
      diff: string(change.diff) ?? '',
      added: 0, removed: 0, truncated: false,
    };
  });
}

/** Translates a Codex ThreadItem into a protocol-agnostic timeline item update. */
export function codexItemUpdate(raw: unknown, completedAt?: number): WorkerTimelineItemUpdate | null {
  const item = object(raw);
  const id = string(item.id);
  if (!id) return null;
  const done = completedAt !== undefined ? { completedAt } : {};
  switch (item.type) {
    case 'agentMessage':
      return { id, kind: 'message', role: 'assistant', ...(typeof item.text === 'string' && item.text ? { text: item.text } : {}),
        ...(completedAt !== undefined ? { status: 'completed' as const } : {}), ...done };
    case 'reasoning': {
      const summary = Array.isArray(item.summary) ? item.summary.filter((s): s is string => typeof s === 'string').join('\n\n') : '';
      const content = Array.isArray(item.content) ? item.content.filter((s): s is string => typeof s === 'string').join('\n\n') : '';
      return { id, kind: 'reasoning', ...(summary ? { summary } : {}), ...(content ? { text: content } : {}),
        ...(completedAt !== undefined ? { status: 'completed' as const } : {}), ...done };
    }
    case 'plan':
      return { id, kind: 'plan', ...(typeof item.text === 'string' && item.text ? { text: item.text } : {}),
        ...(completedAt !== undefined ? { status: 'completed' as const } : {}), ...done };
    case 'commandExecution':
      return {
        id, kind: 'command', command: string(item.command) ?? '', cwd: string(item.cwd) ?? null,
        status: codexStatus(item.status),
        ...(typeof item.aggregatedOutput === 'string' ? { output: item.aggregatedOutput } : {}),
        ...(typeof item.exitCode === 'number' ? { exitCode: item.exitCode } : {}),
        ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
        ...done,
      };
    case 'fileChange':
      return { id, kind: 'file_change', status: codexStatus(item.status), files: codexFileChanges(item.changes), ...done };
    case 'mcpToolCall': {
      const result = object(item.result);
      return {
        id, kind: 'tool_call', toolType: 'mcp', server: string(item.server) ?? null, tool: string(item.tool) ?? 'tool',
        args: summarize(item.arguments), status: codexStatus(item.status),
        ...(item.result ? { output: textParts(result.content) || summarize(result.structuredContent) } : {}),
        error: string(object(item.error).message) ?? null,
        ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
        ...done,
      };
    }
    case 'dynamicToolCall':
      return {
        id, kind: 'tool_call', toolType: 'tool', server: string(item.namespace) ?? null, tool: string(item.tool) ?? 'tool',
        args: summarize(item.arguments), status: codexStatus(item.status),
        ...(Array.isArray(item.contentItems) ? { output: textParts(item.contentItems) } : {}),
        ...(item.success === false ? { error: 'Tool reported failure' } : {}),
        ...(typeof item.durationMs === 'number' ? { durationMs: item.durationMs } : {}),
        ...done,
      };
    case 'webSearch':
      return {
        id, kind: 'tool_call', toolType: 'search', server: null, tool: 'web_search', args: string(item.query) ?? '',
        status: completedAt !== undefined ? 'completed' : 'running', ...done,
      };
    case 'contextCompaction':
      return completedAt !== undefined ? { id, kind: 'notice', level: 'info', text: 'Context compacted', ...done } : null;
    case 'userMessage':
      return null;
    default: {
      const type = string(item.type);
      if (!type) return null;
      return {
        id, kind: 'tool_call', toolType: 'tool', server: null, tool: type, args: '',
        status: completedAt !== undefined ? codexStatus(item.status ?? 'completed') : 'running', ...done,
      };
    }
  }
}

/** Maps one Codex app-server notification (already scoped to the active turn) to timeline events. */
export function codexTimelineEvents(method: string, params: Obj): WorkerTimelineEvent[] {
  const itemId = string(params.itemId) ?? '';
  const delta = string(params.delta) ?? '';
  switch (method) {
    case 'item/started': {
      const update = codexItemUpdate(params.item);
      return update ? [{ type: 'item', item: update }] : [];
    }
    case 'item/completed': {
      const at = typeof params.completedAtMs === 'number' ? params.completedAtMs : Date.now();
      const update = codexItemUpdate(params.item, at);
      return update ? [{ type: 'item', item: update }] : [];
    }
    case 'item/agentMessage/delta':
      return itemId ? [{ type: 'delta', id: itemId, kind: 'message', field: 'text', delta }] : [];
    case 'item/reasoning/textDelta':
      return itemId ? [{ type: 'delta', id: itemId, kind: 'reasoning', field: 'text', delta }] : [];
    case 'item/reasoning/summaryTextDelta':
      return itemId ? [{ type: 'delta', id: itemId, kind: 'reasoning', field: 'summary', delta }] : [];
    case 'item/reasoning/summaryPartAdded':
      return itemId && typeof params.summaryIndex === 'number' && params.summaryIndex > 0
        ? [{ type: 'delta', id: itemId, kind: 'reasoning', field: 'summary', delta: '\n\n' }] : [];
    case 'item/commandExecution/outputDelta':
      return itemId ? [{ type: 'delta', id: itemId, kind: 'command', field: 'output', delta }] : [];
    case 'item/plan/delta':
      return itemId ? [{ type: 'delta', id: itemId, kind: 'plan', field: 'text', delta }] : [];
    case 'item/mcpToolCall/progress':
      return itemId ? [{ type: 'item', item: { id: itemId, kind: 'tool_call', progress: string(params.message) ?? null } }] : [];
    case 'item/fileChange/patchUpdated':
      return itemId ? [{ type: 'item', item: { id: itemId, kind: 'file_change', files: codexFileChanges(params.changes) } }] : [];
    case 'turn/plan/updated': {
      const turnId = string(params.turnId) ?? 'turn';
      const steps = (Array.isArray(params.plan) ? params.plan : []).map(object).map((entry) => ({
        step: string(entry.step) ?? '',
        status: entry.status === 'completed' ? 'completed' as const
          : entry.status === 'inProgress' ? 'in_progress' as const : 'pending' as const,
      }));
      const done = steps.length > 0 && steps.every((step) => step.status === 'completed');
      return [{
        type: 'item',
        item: { id: `plan:${turnId}`, kind: 'plan', explanation: string(params.explanation) ?? null, steps,
          status: done ? 'completed' : 'running' },
      }];
    }
    case 'error': {
      const message = string(object(params.error).message) ?? 'Codex reported an error';
      return [{ type: 'notice', level: params.willRetry ? 'warning' : 'error', text: message }];
    }
    default:
      return [];
  }
}
export function enabledCodexPilot(platform: NodeJS.Platform, setting: boolean, override?: string): boolean {
  return platform === 'win32' && (override === '1' || (override !== '0' && setting));
}

export function launchCodexPilot(options: {
  cwd: string;
  mcpServerPath: string;
  mcpEnv: Record<string, string>;
  events: CodexPilotEvents;
}): CodexAppServerPilot {
  const codex = resolveBinaryFromPath('codex');
  const node = resolveBinaryFromPath('node');
  if (!codex || !node) throw new Error('Codex or Node executable was not found');
  const wrapper = /\.(cmd|bat)$/i.test(codex);
  const entry = join(dirname(codex), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (wrapper && !existsSync(entry)) throw new Error('Codex npm entry point was not found');

  const mcpEnv = Object.entries(options.mcpEnv)
    .map(([key, value]) => `${key} = ${JSON.stringify(value)}`).join(', ');
  const args = [
    'app-server', '--stdio',
    '-c', `mcp_servers.aha.command=${JSON.stringify(node)}`,
    '-c', `mcp_servers.aha.args=${JSON.stringify([options.mcpServerPath])}`,
    '-c', `mcp_servers.aha.env={ ${mcpEnv} }`,
    '-c', 'mcp_servers.aha.enabled=true',
    '-c', 'mcp_servers.aha.required=true',
    // These two calls are part of the dispatch contract and still use Worker-scoped auth.
    '-c', 'mcp_servers.aha.tools.report_done.approval_mode="approve"',
    '-c', 'mcp_servers.aha.tools.read_board.approval_mode="approve"',
  ];
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: augmentedPath() };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase().startsWith('AHA_')) delete env[key];
  }
  const executable = wrapper ? node : codex;
  const argv = wrapper ? [entry, ...args] : args;
  const child = process.platform === 'win32'
    ? spawnWindowsCodexJob(executable, argv, options.cwd, env)
    : spawn(executable, argv, { cwd: options.cwd, env, windowsHide: true, stdio: 'pipe' });
  return new CodexAppServerPilot(child, options.events, 30_000, [
    options.mcpEnv.AHA_WORKER_TOKEN, options.mcpEnv.AHA_AGENT_HOOK_TOKEN,
  ].filter((value): value is string => Boolean(value)));
}

export class CodexAppServerPilot {
  private readonly pending = new Map<number, (error: Error | null, value?: unknown) => void>();
  private readonly disconnect = new AbortController();
  private seq = 0;
  private tokenTotal: Record<string, number> = {};
  private threadId: string | null = null;
  private active: ActiveTurn | null = null;
  private output = '';
  private stderrTail = Buffer.alloc(0);
  private offset = 0;
  private outputDispatchId: string | null = null;
  private disconnected = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly childClosed: Promise<void>;

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly events: CodexPilotEvents,
    private readonly requestTimeoutMs = 30_000,
    private readonly secrets: readonly string[] = [],
  ) {
    this.childClosed = new Promise((resolve) => {
      child.once('close', (code, signal) => {
        resolve();
        this.transportLost(`Codex app-server exited (${code ?? signal ?? 'unknown'})`, code);
      });
      child.once('error', (error) => {
        resolve();
        this.transportLost(`Codex app-server process error: ${error.message}`);
      });
    });
    child.stdin.on('error', () => this.transportLost('Codex app-server stdin disconnected'));
    child.stdout.on('error', () => this.transportLost('Codex app-server stdout disconnected'));
    const stderrCapacity = STDERR_LIMIT + secrets.reduce((max, secret) => Math.max(max, Buffer.byteLength(secret)), 0);
    child.stderr.on('data', (chunk: Buffer) => {
      this.stderrTail = Buffer.concat([this.stderrTail, chunk.subarray(-stderrCapacity)])
        .subarray(-stderrCapacity);
    });
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    lines.on('line', (line) => {
      try {
        this.receive(object(JSON.parse(line)));
      } catch {
        this.transportLost('Invalid Codex app-server protocol message');
      }
    });
    lines.once('close', () => {
      if (this.stopping || this.disconnected) return;
      // Prefer the child close event, which arrives after stderr has drained.
      const timer = setTimeout(() => {
        if (!this.stopping && child.exitCode === null && child.signalCode === null) {
          this.transportLost('Codex app-server stdout closed');
        }
      }, 50);
      void this.childClosed.then(() => clearTimeout(timer));
    });
  }

  get alive(): boolean { return !this.disconnected && !this.stopping; }
  get sessionId(): string | null { return this.threadId; }
  get busy(): boolean { return this.active !== null; }
  get closing(): boolean { return this.stopping; }
  get latestDispatchId(): string | null { return this.outputDispatchId; }

  async open(cwd: string, model: string | null): Promise<string> {
    try {
      await this.request('initialize', {
        clientInfo: { name: 'ahastation', title: 'AhaStation', version: '0.1.0' },
      });
      this.write({ method: 'initialized' });
      const result = object(await this.request('thread/start', {
        cwd, ...(model ? { model } : {}), sandbox: 'read-only', ...APPROVALS,
      }));
      const id = string(object(result.thread).id);
      if (!id) throw new Error('Codex did not return a thread ID');
      if (object(result.sandbox).type !== 'readOnly' || result.approvalPolicy !== 'on-request') {
        throw new Error('Codex did not confirm the requested read-only sandbox and approvals');
      }
      this.threadId = id;
      // Codex may cache an empty MCP catalog prepared before the first turn.
      const inventory = object(await this.request('mcpServerStatus/list', {
        threadId: id, serverName: 'aha', detail: 'toolsAndAuthOnly',
      }));
      const servers: unknown[] = Array.isArray(inventory.data) ? inventory.data : [];
      const aha = servers.map(object).find((server) => server.name === 'aha');
      const tools = Object.values(object(aha?.tools)).map(object);
      if (!tools.some((tool) => tool.name === 'report_done' || tool.name === 'mcp__aha__report_done')) {
        throw new Error('Aha MCP did not expose report_done to the Codex thread');
      }
      return id;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(this.withStderr(reason));
    }
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const active = this.active;
    if (!active) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void active.idle.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  async startTurn(dispatchId: string, prompt: string, effort: string | null): Promise<Delivery> {
    if (!this.alive || !this.threadId || this.active) {
      return { status: 'not_accepted', reason: 'Codex thread is closed or busy' };
    }
    let finish!: () => void;
    const idle = new Promise<void>((resolve) => { finish = resolve; });
    const turn: ActiveTurn = {
      dispatchId, id: null, messages: new Map(), diff: null, usage: null, usageBaseline: this.tokenTotal, idle, finish,
    };
    this.active = turn;
    if (this.outputDispatchId !== dispatchId) {
      this.outputDispatchId = dispatchId;
      this.output = '';
      this.offset = 0;
    }
    try {
      const result = object(await this.request('turn/start', {
        threadId: this.threadId,
        input: [{ type: 'text', text: prompt, text_elements: [] }],
        ...(effort ? { effort } : {}),
        sandboxPolicy: { type: 'readOnly', networkAccess: false },
        ...APPROVALS,
      }));
      const id = string(object(result.turn).id);
      if (!id) throw new Error('Codex did not acknowledge a turn ID');
      this.observeStart(turn, id);
      return { status: 'accepted' };
    } catch (error) {
      const rejected = error instanceof RpcRejection && !turn.id && this.alive;
      this.finishTurn(turn);
      return {
        status: rejected ? 'not_accepted' : 'unknown_acceptance',
        reason: error instanceof Error ? this.redact(error.message) : 'Codex delivery failed',
      };
    }
  }

  read(dispatchId: string, cursor = 0, limit = 8_000, screen = false) {
    if (this.outputDispatchId !== dispatchId) return null;
    const start = screen ? this.offset : Math.min(Math.max(Math.floor(cursor), this.offset), this.offset + this.output.length);
    limit = Math.max(1, Math.min(256_000, Math.floor(limit)));
    const text = this.output.slice(start - this.offset, screen ? undefined : start - this.offset + limit);
    return {
      screen, text: this.redact(text), cursor: start, nextCursor: start + text.length, truncated: cursor < this.offset,
      hasMore: start + text.length < this.offset + this.output.length,
      alive: this.alive, exitCode: this.child.exitCode,
    };
  }

  /** Asks Codex to interrupt the running turn; the turn then completes as interrupted. */
  async interrupt(): Promise<boolean> {
    const active = this.active;
    if (!this.alive || !active?.id || !this.threadId) return false;
    try {
      await this.request('turn/interrupt', { threadId: this.threadId, turnId: active.id }, 5_000);
      return true;
    } catch {
      return false;
    }
  }

  close(interrupt = false): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = Promise.resolve().then(() => this.stop(interrupt));
    return this.stopPromise;
  }

  private async stop(interrupt: boolean): Promise<void> {
    if (interrupt && !this.disconnected && this.active?.id) {
      try {
        await this.request('turn/interrupt', { threadId: this.threadId, turnId: this.active.id }, 2_000);
        await this.waitForIdle(2_000);
      } catch {
        // A lost or hung server still has to be reaped.
      }
    }
    this.disconnect.abort();
    try {
      if (this.child.pid && this.child.exitCode === null && this.child.signalCode === null) {
        this.child.kill('SIGKILL');
      }
    } catch {
      // Still release the pipes and bound the wait for the process.
    }
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = await Promise.race([
        this.childClosed.then(() => false),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(true), CHILD_CLOSE_TIMEOUT_MS);
        }),
      ]);
      if (timedOut) this.transportLost('Timed out waiting for Codex app-server to close');
    } finally {
      clearTimeout(timer);
      this.child.stderr.destroy();
    }
  }

  private transportLost(reason: string, exitCode: number | null = null): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.disconnect.abort();
    const summary = this.withStderr(reason);
    for (const finish of this.pending.values()) finish(new Error(summary));
    if (this.active) this.finishTurn(this.active);
    try {
      this.events.onExit(summary, exitCode);
    } finally {
      void this.close();
    }
  }

  private request(method: string, params: Obj, timeout = this.requestTimeoutMs): Promise<unknown> {
    if (this.disconnected) return Promise.reject(new Error('Codex app-server is disconnected'));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null, result?: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => finish(new Error(`Codex ${method} timed out`)), timeout);
      this.pending.set(id, finish);
      try {
        this.write({ method, id, params });
      } catch (error) {
        finish(error instanceof Error ? error : new Error('Codex stdin write failed'));
      }
    });
  }

  private write(message: Obj): void {
    this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  private receive(message: Obj): void {
    if (this.disconnected) return;
    const { id } = message;
    const method = string(message.method);
    const params = object(message.params);
    if (!method && typeof id === 'number') {
      this.pending.get(id)?.(message.error
        ? new RpcRejection(this.redact(string(object(message.error).message) ?? 'Codex rejected the request'))
        : null, message.result);
      return;
    }
    if (!method) return;
    if (typeof id === 'string' || typeof id === 'number') {
      void this.replyToServer(id, method, params).catch(() => this.transportLost('Codex approval response could not be sent'));
      return;
    }
    const turn = this.active;
    if (!turn || params.threadId !== this.threadId) return;
    const reportedTurn = object(params.turn);
    const turnId = string(reportedTurn.id ?? params.turnId);
    if (turn.id && turnId !== turn.id) return;
    if (method === 'turn/started' && turnId) this.observeStart(turn, turnId);
    this.emitTimeline(turn, method, params);
    if (method === 'item/agentMessage/delta' && typeof params.delta === 'string') {
      const itemId = string(params.itemId) ?? '';
      turn.messages.set(itemId, (turn.messages.get(itemId) ?? '') + params.delta);
      this.append(params.delta);
    }
    if (method === 'item/completed') {
      const item = object(params.item);
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        const itemId = string(item.id) ?? '';
        if (!turn.messages.has(itemId)) this.append(item.text);
        turn.messages.set(itemId, item.text);
        this.append('\n');
      }
      if (item.type === 'mcpToolCall') {
        const error = string(object(item.error).message);
        this.append(`\n[MCP ${string(item.server) ?? ''}/${string(item.tool) ?? ''}: ${string(item.status) ?? 'finished'}${error ? ': ' + error : ''}]\n`);
      }
    }
    if (method === 'thread/tokenUsage/updated') {
      const tokenUsage = object(params.tokenUsage);
      const total = numericFields(tokenUsage.total);
      const last = numericFields(tokenUsage.last);
      turn.usage = Object.keys(total).length === 0 ? last : Object.fromEntries(
        Object.entries(total).map(([key, count]) => {
          const baseline = turn.usageBaseline[key] ?? 0;
          return [key, count >= baseline ? count - baseline : last[key] ?? count];
        }),
      );
      if (Object.keys(total).length > 0) this.tokenTotal = total;
      if (turn.usage) this.timeline(turn, { type: 'usage', usage: turn.usage });
    }
    if (method === 'turn/diff/updated') turn.diff = string(params.diff) ?? null;
    if (method === 'turn/completed' && turnId) {
      this.observeStart(turn, turnId);
      for (const entry of Array.isArray(reportedTurn.items) ? reportedTurn.items : []) {
        const item = object(entry);
        const itemId = string(item.id);
        if (item.type === 'agentMessage' && typeof item.text === 'string' && itemId && !turn.messages.has(itemId)) {
          turn.messages.set(itemId, item.text);
          this.append(item.text + '\n');
        }
      }
      this.finishTurn(turn);
      this.events.onTurnCompleted(turn.dispatchId, {
        turnId, stopReason: string(reportedTurn.status) ?? 'unknown',
        finalText: this.redact([...turn.messages.values()].at(-1) ?? ''),
        usage: turn.usage,
        diff: turn.diff === null ? null : this.redact(turn.diff),
        error: this.redact(string(object(reportedTurn.error).message) ?? '') || null,
      });
    }
  }

  private observeStart(turn: ActiveTurn, id: string): void {
    if (turn.id) return;
    turn.id = id;
    this.timeline(turn, { type: 'turn_started', turnId: id });
    this.events.onTurnStarted(turn.dispatchId);
  }

  private emitTimeline(turn: ActiveTurn, method: string, params: Obj): void {
    if (!this.events.onTimeline) return;
    for (const event of codexTimelineEvents(method, params)) this.timeline(turn, event);
  }

  private timeline(turn: ActiveTurn, event: WorkerTimelineEvent): void {
    if (!this.events.onTimeline) return;
    try {
      this.events.onTimeline(turn.dispatchId, this.redactEvent(event));
    } catch (error) {
      console.warn('[orchestration] Codex timeline listener failed:', error);
    }
  }

  private redactEvent(event: WorkerTimelineEvent): WorkerTimelineEvent {
    if (this.secrets.length === 0) return event;
    const walk = (value: unknown): unknown => {
      if (typeof value === 'string') return this.redact(value);
      if (Array.isArray(value)) return value.map(walk);
      if (value && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, walk(entry)]));
      }
      return value;
    };
    return walk(event) as WorkerTimelineEvent;
  }

  private finishTurn(turn: ActiveTurn): void {
    if (this.active === turn) this.active = null;
    turn.finish();
  }

  private withStderr(reason: string): string {
    const safeReason = this.redact(reason);
    if (safeReason.includes('\nCodex stderr:\n')) return safeReason;
    const tail = Buffer.from(this.redact(this.stderrTail.toString('utf8')))
      .subarray(-STDERR_LIMIT).toString('utf8').trim();
    return tail ? `${safeReason}\nCodex stderr:\n${tail}` : safeReason;
  }

  redactText(text: string): string {
    return this.redact(text);
  }

  private redact(text: string): string {
    for (const secret of this.secrets) text = text.replaceAll(secret, '<redacted>');
    return text;
  }

  private append(text: string): void {
    this.output += text;
    const overflow = this.output.length - OUTPUT_LIMIT;
    if (overflow > 0) {
      this.offset += overflow;
      this.output = this.output.slice(overflow);
    }
  }

  private async replyToServer(id: RpcId, method: string, params: Obj): Promise<void> {
    const turn = this.active;
    const mcpConfirmation = method === 'mcpServer/elicitation/request';
    const approval = method === 'item/commandExecution/requestApproval' ||
      method === 'item/fileChange/requestApproval' || method === 'item/permissions/requestApproval' ||
      mcpConfirmation;
    if (!approval) {
      if (turn) this.append(`\n[Unsupported Codex request: ${method}]\n`);
      this.write({ id, error: { code: -32601, message: 'Unsupported request in the AhaStation pilot' } });
      return;
    }
    const schema = object(params.requestedSchema);
    // An approval button cannot supply arbitrary data for an MCP form.
    const supportsConfirmation = !mcpConfirmation || (
      ['form', 'openai/form', 'openaiForm'].includes(string(params.mode) ?? '') &&
      (!Array.isArray(schema.required) || schema.required.length === 0)
    );
    const matchesTurn = turn && params.threadId === this.threadId &&
      (!turn.id || params.turnId === turn.id || (mcpConfirmation && params.turnId === null));
    let allowed = false;
    if (!this.stopping && matchesTurn && supportsConfirmation) {
      try {
        allowed = await this.events.onApproval(turn.dispatchId, {
          method,
          toolInput: this.redact(mcpConfirmation
            ? JSON.stringify({ server: params.serverName, metadata: params._meta, schema })
            : string(params.command) ?? JSON.stringify(params.permissions ?? params.grantRoot ?? {})),
          message: this.redact(string(params.reason ?? params.message) ?? '') || undefined,
          signal: this.disconnect.signal,
        });
      } catch {
        // Fail closed if the host cannot record the approval.
      }
    }
    if (this.disconnected) return;
    if (mcpConfirmation) {
      this.write({ id, result: { action: allowed ? 'accept' : 'decline', content: allowed ? {} : null, _meta: null } });
    } else if (method === 'item/permissions/requestApproval') {
      this.write({ id, result: { permissions: allowed ? object(params.permissions) : {}, scope: 'turn' } });
    } else {
      const offered = params.availableDecisions;
      const decision = allowed && (!Array.isArray(offered) || offered.includes('accept')) ? 'accept' : 'decline';
      this.write({ id, result: { decision } });
    }
  }
}
