// Pi's native JSON-lines RPC (`pi --mode rpc`) as an AhaStation session driver.
// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// - src/main/pi/rpc/rpc-protocol.ts, rpc-messages.ts, rpc-turns.ts, rpc-extension-dialogs.ts
// - src/main/pi/rpc/launch/rpc-launch.ts, src/main/pi/rpc/rpc-compaction.ts
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type {
  AgentOutputSlice, AgentQuestion, AgentRuntimeResponse, AgentSessionDriver, AgentSessionEvents, AgentSessionPolicy,
  AgentTurnAttachment, TurnDelivery,
} from '../../orchestration/agent-session-driver.js';
import type { CodexModelOption } from '../../orchestration/codex-catalog.js';
import type { WorkerTimelineEvent } from '../../orchestration/worker-timeline.js';
import { AgentProcessHandle, type AgentChild } from '../agent-process.js';
import { driverCapabilities } from '../driver-capabilities.js';
import {
  JsonlRpc, JsonlRpcClosedError, JsonlRpcError, JsonlRpcWriteError, TYPED_COMMAND_ENVELOPE, type JsonlRecord,
} from '../jsonl-rpc.js';

export const PI_READ_TOOLS = ['read', 'grep', 'find', 'ls'] as const;
export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** The levels a model accepts: its `thinkingLevelMap` entries Pi maps to something, plus off. */
export function piModelEfforts(model: Record<string, unknown>): string[] {
  if (model.reasoning !== true) return [];
  const map = model.thinkingLevelMap && typeof model.thinkingLevelMap === 'object' ? model.thinkingLevelMap as Record<string, unknown> : null;
  if (!map) return [...PI_THINKING_LEVELS];
  return ['off', ...Object.entries(map).filter(([, value]) => value !== null && value !== undefined).map(([key]) => key)];
}
const OUTPUT_LIMIT = 512 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** `pi --mode rpc` arguments; a read-only session gets Pi's read tools only, with MCP off. */
export function piRpcArgs(options: { policy: AgentSessionPolicy; sessionFile?: string }): string[] {
  return [
    '--mode', 'rpc',
    ...(options.policy === 'read-only' ? ['--tools', PI_READ_TOOLS.join(','), '--no-mcp'] : []),
    ...(options.sessionFile ? ['--session', options.sessionFile] : []),
  ];
}

interface PiTurn {
  turnKey: string;
  turnId: string;
  ordinal: number;
  streamed: Set<string>;
  messages: Map<string, string>;
  lastMessage: string | null;
  usage: Record<string, number>;
  failure: string | null;
  stopped: boolean;
  command: 'compact' | null;
  idle: Promise<void>;
  finish: () => void;
}

/** One Pi conversation, stored by Pi in its own session file. */
export class PiSessionDriver implements AgentSessionDriver {
  readonly provider = 'pi' as const;
  readonly capabilities = { resume: true, steer: driverCapabilities('pi').supportsSteer, policies: driverCapabilities('pi').policies };
  private readonly rpc: JsonlRpc;
  private readonly proc: AgentProcessHandle;

  get pid(): number | null {
    return this.proc.pid;
  }
  private readonly disconnect = new AbortController();
  private sessionFile: string | null = null;
  private model: { provider: string; id: string } | null = null;
  private thinking: string | null = null;
  private available: CodexModelOption[] = [];
  private active: PiTurn | null = null;
  private turns = 0;
  private output = '';
  private offset = 0;
  private outputTurnKey: string | null = null;
  private disconnected = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private settleCheck = 0;

  constructor(
    child: AgentChild,
    private readonly events: AgentSessionEvents,
    private readonly options: { policy: AgentSessionPolicy; requestTimeoutMs?: number },
  ) {
    this.proc = new AgentProcessHandle(child);
    this.rpc = new JsonlRpc(child.stdout, child.stdin, TYPED_COMMAND_ENVELOPE, {
      onRecord: (record) => this.receive(record),
      onClose: () => {
        if (this.stopping || this.disconnected) return;
        const timer = setTimeout(() => this.transportLost('Pi 的输出已关闭'), 100);
        void this.proc.closed.then(() => clearTimeout(timer));
      },
    }, { requestTimeoutMs: options.requestTimeoutMs ?? 30_000 });
    void this.proc.closed.then(({ code, signal }) => this.transportLost(`Pi 已退出（${code ?? signal ?? 'unknown'}）`, code));
  }

  get alive(): boolean { return !this.disconnected && !this.stopping; }
  get busy(): boolean { return this.active !== null; }
  get closing(): boolean { return this.stopping; }
  /** Pi resumes from its session file, so that path is the provider session id. */
  get sessionId(): string | null { return this.sessionFile; }
  get latestTurnKey(): string | null { return this.outputTurnKey; }
  get effectiveModel(): string | null { return this.model ? `${this.model.provider}/${this.model.id}` : null; }
  get effectiveEffort(): string | null { return this.thinking; }

  models(): CodexModelOption[] {
    return this.available;
  }

  async open({ model, effort, policy }: {
    cwd: string; model: string | null; effort?: string | null; policy: AgentSessionPolicy; resumeSessionId?: string;
    network?: boolean; developerInstructions?: string;
  }): Promise<string> {
    if (policy !== this.options.policy) throw new Error('Pi 的权限档位在启动时确定');
    try {
      this.readState(await this.rpc.request('get_state', {}, { timeoutMs: 60_000 }));
      if (!this.sessionFile) throw new Error('Pi 没有返回会话文件');
      this.available = await this.listModels().catch(() => []);
      if (model && model !== this.effectiveModel) await this.setModel(model);
      if (effort && effort !== this.thinking) {
        const offered = this.available.find((entry) => entry.id === this.effectiveModel)?.efforts.map((option) => option.value);
        if ((offered ?? PI_THINKING_LEVELS as readonly string[]).includes(effort)) await this.setThinking(effort);
      }
      return this.sessionFile;
    } catch (error) {
      throw new Error(this.proc.withStderr(describe(error)));
    }
  }

  async startTurn({ turnKey, prompt, effort, model, policy, attachments = [] }: {
    turnKey: string; prompt: string; effort?: string | null; model?: string | null; policy?: AgentSessionPolicy;
    network?: boolean; attachments?: readonly AgentTurnAttachment[];
  }): Promise<TurnDelivery> {
    if (!this.alive || !this.sessionFile || this.active) return { status: 'not_accepted', reason: 'Pi 会话已关闭或正忙' };
    if (policy && policy !== this.options.policy) return { status: 'not_accepted', reason: 'Pi 需要重启才能切换权限档位' };
    let images: Obj[];
    try {
      if (model && model !== this.effectiveModel) await this.setModel(model);
      if (effort && effort !== this.thinking) await this.setThinking(effort);
      images = this.images(attachments);
    } catch (error) {
      return { status: this.alive ? 'not_accepted' : 'unknown_acceptance', reason: describe(error) };
    }
    const turn = this.beginTurn(turnKey, null);
    const notes = attachments.filter((item) => item.type !== 'skill')
      .map((item) => `[Attached ${item.type === 'localImage' ? 'image' : 'file'} "${(item.name || basename(item.path)).replace(/"/gu, "'")}" is saved at: ${item.path}]`);
    try {
      const reply = object(await this.rpc.request('prompt', {
        message: [prompt, ...notes].filter(Boolean).join('\n\n'), ...(images.length ? { images } : {}),
      }));
      this.started(turn);
      // A command Pi handled without running the agent (an extension's own) ends the turn here.
      if (object(reply).disposition === 'handled') queueMicrotask(() => this.finish(turn));
      return { status: 'accepted' };
    } catch (error) {
      this.dropTurn(turn);
      // A refusal (e.g. no API key) or a write that never left can be sent again; a lost reply cannot.
      const safe = error instanceof JsonlRpcWriteError || (error instanceof JsonlRpcError && this.alive);
      return { status: safe ? 'not_accepted' : 'unknown_acceptance', reason: describe(error) };
    }
  }

  async compactThread(turnKey: string): Promise<TurnDelivery> {
    if (!this.alive || !this.sessionFile || this.active) return { status: 'not_accepted', reason: 'Pi 会话已关闭或正忙' };
    const turn = this.beginTurn(turnKey, 'compact');
    this.started(turn);
    void this.rpc.request('compact', {}, { timeoutMs: null }).then(
      () => this.finish(turn),
      (error: unknown) => {
        if (!(error instanceof JsonlRpcError)) return;
        if (/Nothing to compact/iu.test(error.message)) {
          this.timeline(turn, { type: 'notice', level: 'info', text: '对话太短，无需压缩' });
        } else {
          turn.failure = error.message;
        }
        this.finish(turn);
      },
    );
    return { status: 'accepted' };
  }

  async interrupt(): Promise<boolean> {
    const turn = this.active;
    if (!this.alive || !turn) return false;
    turn.stopped = true;
    try {
      await this.rpc.request('abort', {}, { timeoutMs: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async setName(name: string): Promise<boolean> {
    if (!this.alive) return false;
    try {
      await this.rpc.request('set_session_name', { name }, { timeoutMs: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  async waitForIdle(timeoutMs: number): Promise<boolean> {
    const turn = this.active;
    if (!turn) return true;
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      void turn.idle.then(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  read(turnKey: string, cursor = 0, limit = 8_000, screen = false): AgentOutputSlice | null {
    if (this.outputTurnKey !== turnKey) return null;
    const start = screen ? this.offset : Math.min(Math.max(Math.floor(cursor), this.offset), this.offset + this.output.length);
    const size = Math.max(1, Math.min(256_000, Math.floor(limit)));
    const slice = this.output.slice(start - this.offset, screen ? undefined : start - this.offset + size);
    return {
      screen, text: slice, cursor: start, nextCursor: start + slice.length, truncated: cursor < this.offset,
      hasMore: start + slice.length < this.offset + this.output.length, alive: this.alive, exitCode: this.proc.exitCode,
    };
  }

  redactText(value: string): string {
    return value;
  }

  close(interrupt = false): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.stopPromise = (async () => {
      if (interrupt && this.active && !this.disconnected) {
        this.active.stopped = true;
        await this.rpc.request('abort', {}, { timeoutMs: 2_000 }).catch(() => {});
        await this.waitForIdle(2_000);
      }
      this.disconnect.abort();
      this.rpc.close();
      await this.proc.kill();
    })();
    return this.stopPromise;
  }

  private readState(value: unknown): Obj {
    const state = object(value);
    const model = object(state.model);
    if (typeof model.id === 'string' && typeof model.provider === 'string' && model.id !== 'unknown') {
      this.model = { provider: model.provider, id: model.id };
    }
    this.thinking = text(state.thinkingLevel) ?? this.thinking;
    this.sessionFile = text(state.sessionFile) ?? this.sessionFile;
    return state;
  }

  private async listModels(): Promise<CodexModelOption[]> {
    const data = object(await this.rpc.request('get_available_models', {}, { timeoutMs: 30_000 }));
    return array(data.models).map(object)
      .filter((model) => typeof model.id === 'string' && typeof model.provider === 'string')
      .map((model) => {
        const id = `${model.provider as string}/${model.id as string}`;
        return {
          id, model: id, displayName: text(model.name) ?? (model.id as string), description: model.provider as string,
          isDefault: id === this.effectiveModel,
          efforts: piModelEfforts(model).map((value) => ({ value, description: '' })),
          defaultEffort: model.reasoning === true ? this.thinking : null,
          images: array(model.input).includes('image'),
        };
      });
  }

  private async setModel(value: string): Promise<void> {
    const slash = value.indexOf('/');
    if (slash <= 0) throw new Error(`Pi 模型需写作 provider/model：${value}`);
    const provider = value.slice(0, slash);
    const modelId = value.slice(slash + 1);
    await this.rpc.request('set_model', { provider, modelId });
    this.model = { provider, id: modelId };
  }

  private async setThinking(level: string): Promise<void> {
    const offered = this.available.find((model) => model.id === this.effectiveModel)?.efforts.map((option) => option.value);
    if (!(offered ?? PI_THINKING_LEVELS as readonly string[]).includes(level)) throw new Error(`Pi 当前模型不支持思考强度 ${level}`);
    await this.rpc.request('set_thinking_level', { level });
    this.thinking = level;
  }

  private images(attachments: readonly AgentTurnAttachment[]): Obj[] {
    return attachments.flatMap((item) => {
      const mime = item.type === 'localImage' ? IMAGE_MIME[extname(item.path).toLowerCase()] : undefined;
      if (!mime) return [];
      const bytes = readFileSync(item.path);
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 10MB');
      return [{ type: 'image', data: bytes.toString('base64'), mimeType: mime }];
    });
  }

  private beginTurn(turnKey: string, command: PiTurn['command']): PiTurn {
    let finish!: () => void;
    const idle = new Promise<void>((resolve) => { finish = resolve; });
    const turn: PiTurn = {
      turnKey, turnId: `run-${++this.turns}`, ordinal: 0, streamed: new Set(), messages: new Map(), lastMessage: null,
      usage: {}, failure: null, stopped: false, command, idle, finish,
    };
    this.active = turn;
    if (this.outputTurnKey !== turnKey) {
      this.outputTurnKey = turnKey;
      this.output = '';
      this.offset = 0;
    }
    return turn;
  }

  private started(turn: PiTurn): void {
    this.timeline(turn, { type: 'turn_started', turnId: turn.turnId });
    this.events.onTurnStarted(turn.turnKey);
  }

  private dropTurn(turn: PiTurn): void {
    if (this.active === turn) this.active = null;
    turn.finish();
  }

  private receive(record: JsonlRecord): void {
    if (this.disconnected) return;
    if (record.type === 'extension_ui_request') {
      void this.dialog(record);
      return;
    }
    const turn = this.active;
    if (!turn) return;
    switch (record.type) {
      case 'message_start':
        if (object(record.message).role === 'assistant') turn.ordinal++;
        return;
      case 'message_update':
        this.messageUpdate(turn, object(record.assistantMessageEvent));
        return;
      case 'message_end':
        this.messageEnd(turn, object(record.message));
        return;
      case 'tool_execution_start':
      case 'tool_execution_update':
      case 'tool_execution_end':
        this.tool(turn, record);
        return;
      case 'compaction_start':
      case 'auto_compaction_start':
        this.timeline(turn, { type: 'notice', id: `compact:${turn.turnId}`, level: 'info', text: '正在压缩上下文…' });
        return;
      case 'compaction_end':
      case 'auto_compaction_end':
        this.timeline(turn, { type: 'notice', id: `compact:${turn.turnId}`, level: 'info', text: '上下文已压缩' });
        return;
      case 'auto_retry_start':
        this.timeline(turn, { type: 'notice', level: 'warning', text: 'Pi 请求失败，正在自动重试…' });
        return;
      case 'auto_retry_end':
        turn.failure = record.success === true ? null : text(record.finalError) ?? 'Pi 自动重试失败';
        return;
      case 'agent_end':
        void this.checkSettled(turn);
        return;
      case 'agent_settled':
        this.finish(turn);
        return;
      default:
        return;
    }
  }

  private messageUpdate(turn: PiTurn, update: Obj): void {
    const kind = update.type === 'text_delta' ? 'message' : update.type === 'thinking_delta' ? 'reasoning' : null;
    const delta = text(update.delta);
    if (!kind || !delta) return;
    const id = `${kind}:${turn.turnId}:${turn.ordinal}:${typeof update.contentIndex === 'number' ? update.contentIndex : 0}`;
    turn.streamed.add(id);
    if (kind === 'message') {
      turn.messages.set(id, (turn.messages.get(id) ?? '') + delta);
      turn.lastMessage = id;
      this.append(delta);
    }
    this.timeline(turn, { type: 'delta', id, kind, field: 'text', delta });
  }

  private messageEnd(turn: PiTurn, message: Obj): void {
    if (message.role !== 'assistant') return;
    const usage = object(message.usage);
    for (const key of ['input', 'output', 'cacheRead', 'cacheWrite'] as const) {
      if (typeof usage[key] === 'number') turn.usage[key] = (turn.usage[key] ?? 0) + (usage[key] as number);
    }
    if (Object.keys(turn.usage).length) this.timeline(turn, { type: 'usage', usage: { ...turn.usage } });
    if (message.stopReason === 'error') turn.failure = text(message.errorMessage) ?? 'Pi 请求失败';
    const content = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : array(message.content).map(object);
    content.forEach((block, index) => {
      const kind = block.type === 'text' ? 'message' : block.type === 'thinking' ? 'reasoning' : null;
      const value = kind === 'message' ? text(block.text) : text(block.thinking);
      if (!kind || !value) return;
      const id = `${kind}:${turn.turnId}:${turn.ordinal}:${index}`;
      if (kind === 'message') {
        turn.messages.set(id, value);
        turn.lastMessage = id;
      }
      // A message Pi did not stream still gets its row once.
      if (!turn.streamed.has(id)) {
        turn.streamed.add(id);
        if (kind === 'message') this.append(value);
        this.timeline(turn, { type: 'delta', id, kind, field: 'text', delta: value });
      }
      this.timeline(turn, { type: 'item', item: { id, kind, status: 'completed', completedAt: Date.now() } });
    });
  }

  private tool(turn: PiTurn, event: JsonlRecord): void {
    const callId = text(event.toolCallId);
    const name = text(event.toolName) ?? 'tool';
    if (!callId) return;
    const args = object(event.args);
    const result = event.result ?? event.partialResult;
    const output = result === undefined ? undefined
      : array(object(result).content).map(object).flatMap((block) => (typeof block.text === 'string' ? [block.text] : [])).join('\n')
        || (object(result).content ? '' : JSON.stringify(result));
    const status = event.type === 'tool_execution_end' ? (event.isError === true ? 'failed' : 'completed') : 'running';
    const done = status === 'running' ? {} : { completedAt: Date.now() };
    const id = `tool:${callId}`;
    if (name === 'bash' && typeof args.command === 'string') {
      this.timeline(turn, {
        type: 'item',
        item: { id, kind: 'command', command: args.command, status, ...done, ...(output !== undefined ? { output } : {}) },
      });
      return;
    }
    this.timeline(turn, {
      type: 'item',
      item: {
        id, kind: 'tool_call', toolType: 'tool', server: null, tool: name, status, ...done,
        ...(event.args !== undefined ? { args: JSON.stringify(event.args) } : {}),
        ...(output !== undefined ? { output } : {}),
        ...(status === 'failed' ? { error: output || '工具调用失败' } : {}),
      },
    });
  }

  /** Pi can end a run and start another (a queued follow-up or retry), so idleness is confirmed first. */
  private async checkSettled(turn: PiTurn): Promise<void> {
    const check = ++this.settleCheck;
    try {
      const state = this.readState(await this.rpc.request('get_state', {}, { timeoutMs: 10_000 }));
      const idle = state.isStreaming !== true && state.isCompacting !== true && !(typeof state.pendingMessageCount === 'number' && state.pendingMessageCount > 0);
      if (idle && check === this.settleCheck) this.finish(turn);
    } catch {
      // agent_settled or the process exit still ends the turn.
    }
  }

  private finish(turn: PiTurn): void {
    if (this.active !== turn) return;
    this.active = null;
    turn.finish();
    const stopReason = turn.stopped ? 'interrupted' : turn.failure ? 'failed' : 'completed';
    this.events.onTurnCompleted(turn.turnKey, {
      turnId: turn.turnId, stopReason,
      finalText: turn.lastMessage ? turn.messages.get(turn.lastMessage) ?? '' : '',
      diff: null, usage: Object.keys(turn.usage).length ? { ...turn.usage } : null,
      error: stopReason === 'failed' ? turn.failure : null,
    });
  }

  /** Extension dialogs are the person's to answer in every policy; notices only inform. */
  private async dialog(record: JsonlRecord): Promise<void> {
    const id = record.id;
    const method = text(record.method);
    const turn = this.active;
    const title = text(record.title) ?? '';
    const message = text(record.message);
    if (method === 'notify') {
      if (turn && message) this.timeline(turn, { type: 'notice', level: record.notifyType === 'error' ? 'error' : record.notifyType === 'warning' ? 'warning' : 'info', text: message });
      return;
    }
    if ((typeof id !== 'string' && typeof id !== 'number') || !['confirm', 'select', 'input', 'editor'].includes(method ?? '')) return;
    const respond = (reply: Obj) => this.rpc.write({ type: 'extension_ui_response', id, ...reply }).catch(() => {});
    if (!turn || this.stopping) return void respond({ cancelled: true });
    const options = method === 'select' ? array(record.options).filter((option): option is string => typeof option === 'string') : [];
    let response: AgentRuntimeResponse;
    try {
      if (method === 'confirm') {
        response = await this.events.onRequest(turn.turnKey, {
          kind: 'approval', method: 'pi/confirm', toolInput: title, ...(message ? { message } : {}), signal: this.disconnect.signal,
        });
        if (this.disconnected) return;
        return void respond('decision' in response ? { confirmed: response.decision === 'accept' } : { cancelled: true });
      }
      const prefill = method === 'editor' ? text(record.prefill) : undefined;
      const question: AgentQuestion = {
        id: 'q1', header: title,
        prompt: [message, prefill ? `当前内容：\n${prefill}` : undefined, text(record.placeholder)].filter(Boolean).join('\n\n') || title,
        allowOther: method !== 'select',
        options: options.map((label) => ({ label: label || '（空）', description: '' })),
      };
      response = await this.events.onRequest(turn.turnKey, {
        kind: 'question', method: `pi/${method}`, toolInput: '', questions: [question], signal: this.disconnect.signal,
      });
    } catch {
      return void respond({ cancelled: true });
    }
    if (this.disconnected) return;
    if (!('answers' in response)) return void respond({ cancelled: true });
    const value = response.answers.q1?.[0];
    if (value === undefined) return void respond({ cancelled: true });
    if (method === 'select') {
      const index = options.findIndex((label) => (label || '（空）') === value);
      return void respond(index >= 0 ? { value: options[index] } : { cancelled: true });
    }
    return void respond({ value });
  }

  private transportLost(reason: string, exitCode: number | null = null): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.disconnect.abort();
    this.rpc.close(new JsonlRpcClosedError(reason));
    if (this.active) this.dropTurn(this.active);
    try {
      this.events.onExit(this.proc.withStderr(reason), exitCode);
    } finally {
      void this.close();
    }
  }

  private timeline(turn: PiTurn, event: WorkerTimelineEvent): void {
    try {
      this.events.onTimeline?.(turn.turnKey, event);
    } catch (error) {
      console.warn('[agent-drivers] Pi timeline listener failed:', error);
    }
  }

  private append(chunk: string): void {
    this.output += chunk;
    const overflow = this.output.length - OUTPUT_LIMIT;
    if (overflow > 0) {
      this.offset += overflow;
      this.output = this.output.slice(overflow);
    }
  }
}

function describe(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  // Pi's sign-in refusal carries local install paths after its first lines.
  return message.split(/\r?\n\r?\n/u)[0]!.trim() || message;
}
