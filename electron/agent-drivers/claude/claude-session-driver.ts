// Claude Code's native stream-json stdio driver (`claude -p --input-format stream-json --output-format stream-json`).
// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// - src/main/claude/claude-stream-json-connection.ts
// - src/main/claude/structured/journal/claude-message-journaling.ts, claude-result-journaling.ts,
//   claude-streamed-block-identity.ts, claude-streamed-thinking.ts
// - src/main/claude/structured/permissions/claude-structured-inbound-control.ts, claude-permission-mode-ladder.ts
// - src/main/claude/structured/turns/claude-result-outcome.ts
import { randomUUID } from 'node:crypto';
import type {
  AgentOutputSlice,
  AgentRuntimeResponse,
  AgentSessionDriver,
  AgentSessionEvents,
  AgentSessionPolicy,
  AgentTurnAttachment,
  TurnDelivery,
} from '../../orchestration/agent-session-driver.js';
import type { CodexModelOption } from '../../orchestration/codex-catalog.js';
import type { WorkerTimelineEvent } from '../../orchestration/worker-timeline.js';
import { AgentProcessHandle, type AgentChild } from '../agent-process.js';
import { driverCapabilities } from '../driver-capabilities.js';
import {
  JsonlRpc,
  JsonlRpcClosedError,
  JsonlRpcError,
  JsonlRpcWriteError,
  type JsonlRecord,
} from '../jsonl-rpc.js';
import {
  asArray,
  asNonEmptyText,
  asObject,
  asText,
  buildClaudeUserContent,
  CLAUDE_CONTROL_ENVELOPE,
  claudePermissionModeForPolicy,
  claudeRequestRequiresPerson,
  describeClaudeResultError,
  formatClaudeApprovalInput,
  formatClaudeApprovalMessage,
  formatClaudeCompactNotice,
  isClaudeAutoRefusal,
  isClaudeBypassRefusal,
  normalizeClaudeUsage,
  parseClaudeAskUserQuestion,
  parseClaudeModels,
  readClaudeSettings,
  translateClaudeToolResult,
  translateClaudeToolStart,
  type ClaudePermissionMode,
  type Obj,
  type TrackedClaudeTool,
} from './claude-protocol.js';

const OUTPUT_LIMIT = 512 * 1024;
const MAX_TOOL_JSON_BUF = 256 * 1024;
const INTERRUPT_CANCEL_QUEUED_CAPABILITY = 'interrupt_cancel_queued_v1';
const ABORTED_TERMINAL_REASONS = new Set(['aborted_streaming', 'aborted_tools']);

interface StreamBlockState {
  kind: 'message' | 'reasoning' | 'tool';
  id: string;
  closed: boolean;
  toolName?: string;
  toolId?: string;
  jsonBuf?: string;
}

interface StreamedMessageQueues {
  textIds: string[];
  thinkIds: string[];
}

interface ClaudeTurn {
  turnKey: string;
  turnId: string;
  userMessageUuid: string;
  command: 'compact' | null;
  textSeg: number;
  thinkSeg: number;
  activeMessageId: string | null;
  activeThoughtId: string | null;
  messages: Map<string, string>;
  lastMessage: string | null;
  streamMsgId: string | null;
  streamBlocks: Map<number, StreamBlockState>;
  streamedByMsg: Map<string, StreamedMessageQueues>;
  tools: Map<string, TrackedClaudeTool>;
  declinedTools: Set<string>;
  usage: Record<string, number> | null;
  lastError: string | null;
  compactBoundarySeen: boolean;
  started: boolean;
  evidence: boolean;
  onEvidence: (() => void) | null;
  cancelRequested: boolean;
  idle: Promise<void>;
  finish: () => void;
}

export interface ClaudeDriverOptions {
  /** Session id passed at CLI launch (`--session-id` or `--resume`), so open knows it immediately. */
  sessionId?: string;
  /** Initial policy passed at CLI launch (`--permission-mode`). */
  policy?: AgentSessionPolicy;
  /** How long a written user message waits for Claude's first sign of work before counting as accepted. */
  acceptanceWindowMs?: number;
  /** How long `close()` waits for stdin EOF before forcing SIGKILL. */
  gracefulCloseMs?: number;
  requestTimeoutMs?: number;
  setupTimeoutMs?: number;
}

/** One Claude Code conversation driven over bidirectional stream-json stdio. */
export class ClaudeSessionDriver implements AgentSessionDriver {
  readonly provider = 'claude' as const;
  readonly capabilities = { resume: true, steer: false, policies: driverCapabilities('claude').policies };
  private readonly rpc: JsonlRpc;
  private readonly proc: AgentProcessHandle;
  private readonly disconnect = new AbortController();
  private readonly pendingControls = new Map<string, AbortController>();
  private readonly acceptanceWindowMs: number;
  private readonly gracefulCloseMs: number;
  private readonly setupTimeoutMs: number;
  private claudeSessionId: string | null;
  private policy: AgentSessionPolicy;
  private currentPermissionMode: ClaudePermissionMode | null = null;
  private bypassRefused = false;
  private autoRefused = false;
  private serverCapabilities = new Set<string>();
  private rawModels: unknown[] = [];
  private modelOptions: CodexModelOption[] = [];
  private currentModel: string | null = null;
  private currentEffort: string | null = null;
  private active: ClaudeTurn | null = null;
  private turns = 0;
  private output = '';
  private offset = 0;
  private outputTurnKey: string | null = null;
  private disconnected = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    child: AgentChild,
    private readonly events: AgentSessionEvents,
    options: ClaudeDriverOptions = {},
  ) {
    this.claudeSessionId = options.sessionId ?? null;
    this.policy = options.policy ?? 'workspace-write';
    this.acceptanceWindowMs = options.acceptanceWindowMs ?? 1_500;
    this.gracefulCloseMs = options.gracefulCloseMs ?? 1_500;
    this.setupTimeoutMs = options.setupTimeoutMs ?? 60_000;
    this.proc = new AgentProcessHandle(child);
    this.rpc = new JsonlRpc(child.stdout, child.stdin, CLAUDE_CONTROL_ENVELOPE, {
      onRecord: (record) => this.receive(record),
      onClose: () => {
        if (this.stopping || this.disconnected) return;
        // Prefer process exit, which carries the exit code and lets stderr drain.
        const timer = setTimeout(() => this.transportLost('Claude Code 的输出已关闭'), 100);
        void this.proc.closed.then(() => clearTimeout(timer));
      },
    }, { requestTimeoutMs: options.requestTimeoutMs ?? 30_000 });
    void this.proc.closed.then(({ code, signal }) =>
      this.transportLost(`Claude Code 已退出（${code ?? signal ?? 'unknown'}）`, code));
  }

  get alive(): boolean { return !this.disconnected && !this.stopping; }
  get busy(): boolean { return this.active !== null; }
  get closing(): boolean { return this.stopping; }
  get sessionId(): string | null { return this.claudeSessionId; }
  get latestTurnKey(): string | null { return this.outputTurnKey; }
  get effectiveModel(): string | null { return this.currentModel; }
  get effectiveEffort(): string | null { return this.currentEffort; }

  models(): CodexModelOption[] {
    return this.modelOptions;
  }

  async open({ model, policy, resumeSessionId }: {
    cwd: string; model: string | null; policy: AgentSessionPolicy; resumeSessionId?: string; network?: boolean;
    developerInstructions?: string;
  }): Promise<string> {
    try {
      const init = asObject(await this.rpc.request(
        'initialize',
        { supportedDialogKinds: [] },
        { timeoutMs: this.setupTimeoutMs },
      ));
      this.readCapabilities(init.capabilities);
      const initPermMode = asNonEmptyText(init.current_permission_mode);
      if (initPermMode) this.currentPermissionMode = initPermMode as ClaudePermissionMode;

      const initModels = asArray(init.models);
      if (initModels.length > 0) {
        this.rawModels = initModels;
      } else {
        const listed = asObject(await this.rpc.request('list_models', {}, { timeoutMs: 15_000 }).catch(() => ({})));
        this.rawModels = asArray(listed.models);
      }

      const settings = await this.rpc.request('get_settings', {}, { timeoutMs: 10_000 }).catch(() => null);
      if (settings !== null) {
        const parsed = readClaudeSettings(settings);
        if (parsed.model) this.currentModel = parsed.model;
        if (parsed.effort !== undefined) this.currentEffort = parsed.effort;
      }

      this.refreshModelOptions();
      if (!this.currentModel) {
        this.currentModel = this.modelOptions.find((entry) => entry.isDefault)?.id ?? this.modelOptions[0]?.id ?? null;
      }

      if (resumeSessionId) this.claudeSessionId = resumeSessionId;
      this.claudeSessionId ??= randomUUID();

      if (model && model !== this.currentModel) await this.setModel(model);
      await this.applyPolicy(policy);
      return this.claudeSessionId;
    } catch (error) {
      throw new Error(this.proc.withStderr(describe(error)));
    }
  }

  async startTurn({ turnKey, prompt, effort, model, policy, attachments = [] }: {
    turnKey: string; prompt: string; effort?: string | null; model?: string | null; policy?: AgentSessionPolicy;
    network?: boolean; attachments?: readonly AgentTurnAttachment[];
  }): Promise<TurnDelivery> {
    return this.dispatchTurn({ turnKey, prompt, effort, model, policy, attachments, command: null });
  }

  async compactThread(turnKey: string): Promise<TurnDelivery> {
    return this.dispatchTurn({ turnKey, prompt: '/compact', attachments: [], command: 'compact' });
  }

  async interrupt(): Promise<boolean> {
    const turn = this.active;
    if (!this.alive || !turn) return false;
    turn.cancelRequested = true;
    try {
      const cancelQueued = this.serverCapabilities.has(INTERRUPT_CANCEL_QUEUED_CAPABILITY);
      await this.rpc.request(
        'interrupt',
        cancelQueued ? { cancel_queued: true } : {},
        { timeoutMs: 5_000 },
      );
      return true;
    } catch {
      return false;
    }
  }

  async setName(name: string): Promise<boolean> {
    if (!this.alive || !this.claudeSessionId) return false;
    try {
      await this.rpc.request(
        'rename_session',
        { title: name, source: 'host', session_id: this.claudeSessionId },
        { timeoutMs: 5_000 },
      );
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
    const start = screen
      ? this.offset
      : Math.min(Math.max(Math.floor(cursor), this.offset), this.offset + this.output.length);
    const size = Math.max(1, Math.min(256_000, Math.floor(limit)));
    const slice = this.output.slice(start - this.offset, screen ? undefined : start - this.offset + size);
    return {
      screen,
      text: slice,
      cursor: start,
      nextCursor: start + slice.length,
      truncated: cursor < this.offset,
      hasMore: start + slice.length < this.offset + this.output.length,
      alive: this.alive,
      exitCode: this.proc.exitCode,
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
        this.active.cancelRequested = true;
        await this.rpc.request('interrupt', {}, { timeoutMs: 2_000 }).catch(() => {});
        await this.waitForIdle(2_000);
      }
      this.disconnect.abort();
      for (const controller of this.pendingControls.values()) controller.abort();
      this.pendingControls.clear();
      this.rpc.close();
      try {
        if (!this.proc.child.stdin.destroyed && this.proc.child.stdin.writable) {
          this.proc.child.stdin.end();
        }
      } catch {
        // Ignore pipe teardown errors.
      }
      if (this.gracefulCloseMs > 0 && this.proc.child.exitCode === null && this.proc.child.signalCode === null) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          this.proc.closed,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, this.gracefulCloseMs);
            timer.unref?.();
          }),
        ]);
        clearTimeout(timer);
      }
      await this.proc.kill();
    })();
    return this.stopPromise;
  }

  // --- Dispatch & Options ---

  private async dispatchTurn(input: {
    turnKey: string;
    prompt: string;
    effort?: string | null;
    model?: string | null;
    policy?: AgentSessionPolicy;
    attachments: readonly AgentTurnAttachment[];
    command: 'compact' | null;
  }): Promise<TurnDelivery> {
    if (!this.alive || !this.claudeSessionId || this.active) {
      return { status: 'not_accepted', reason: 'Claude Code 会话已关闭或正忙' };
    }
    const targetModel = input.model ?? this.currentModel;
    if (input.effort && input.effort !== this.currentEffort) {
      const targetOpt = this.modelOptions.find((entry) => entry.id === targetModel || entry.model === targetModel);
      if (targetOpt && targetOpt.efforts.length > 0 && !targetOpt.efforts.some((entry) => entry.value === input.effort)) {
        return { status: 'not_accepted', reason: `Claude 当前模型不支持推理强度 ${input.effort}` };
      }
    }
    try {
      if (input.model && input.model !== this.currentModel) await this.setModel(input.model);
      if (input.effort && input.effort !== this.currentEffort) await this.setEffort(input.effort);
      if (input.policy && input.policy !== this.policy) await this.applyPolicy(input.policy);
    } catch (error) {
      return { status: this.alive ? 'not_accepted' : 'unknown_acceptance', reason: describe(error) };
    }

    let content: Obj[];
    try {
      content = buildClaudeUserContent(input.prompt, input.attachments);
    } catch (error) {
      return { status: 'not_accepted', reason: describe(error) };
    }

    let finish!: () => void;
    const idle = new Promise<void>((resolve) => { finish = resolve; });
    const userMessageUuid = randomUUID();
    const turn: ClaudeTurn = {
      turnKey: input.turnKey,
      turnId: `run-${++this.turns}`,
      userMessageUuid,
      command: input.command,
      textSeg: 0,
      thinkSeg: 0,
      activeMessageId: null,
      activeThoughtId: null,
      messages: new Map(),
      lastMessage: null,
      streamMsgId: null,
      streamBlocks: new Map(),
      streamedByMsg: new Map(),
      tools: new Map(),
      declinedTools: new Set(),
      usage: null,
      lastError: null,
      compactBoundarySeen: false,
      started: false,
      evidence: false,
      onEvidence: null,
      cancelRequested: false,
      idle,
      finish,
    };
    this.active = turn;
    if (this.outputTurnKey !== input.turnKey) {
      this.outputTurnKey = input.turnKey;
      this.output = '';
      this.offset = 0;
    }

    try {
      await this.rpc.write({
        type: 'user',
        uuid: userMessageUuid,
        session_id: this.claudeSessionId,
        parent_tool_use_id: null,
        message: { role: 'user', content },
      });
    } catch (error) {
      this.dropTurn(turn);
      const safe = error instanceof JsonlRpcWriteError;
      return { status: safe ? 'not_accepted' : 'unknown_acceptance', reason: describe(error) };
    }

    const delivery = await new Promise<TurnDelivery>((resolve) => {
      let settled = false;
      const done = (value: TurnDelivery) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        turn.onEvidence = null;
        this.disconnect.signal.removeEventListener('abort', onDisconnect);
        resolve(value);
      };
      const onDisconnect = () => {
        if (turn.evidence) done({ status: 'accepted' });
        else done({ status: 'unknown_acceptance', reason: 'Claude Code 在确认收到消息前断开' });
      };
      const timer = setTimeout(() => {
        done(this.alive
          ? { status: 'accepted' }
          : { status: 'unknown_acceptance', reason: 'Claude Code 在确认收到消息前断开' });
      }, this.acceptanceWindowMs);
      turn.onEvidence = () => done({ status: 'accepted' });
      if (turn.evidence) done({ status: 'accepted' });
      else if (this.disconnect.signal.aborted) onDisconnect();
      else this.disconnect.signal.addEventListener('abort', onDisconnect, { once: true });
    });

    if (delivery.status !== 'accepted') {
      this.dropTurn(turn);
      return delivery;
    }
    turn.evidence = true;
    this.emitTurnStarted(turn);
    return delivery;
  }

  private async setModel(model: string): Promise<void> {
    await this.rpc.request('set_model', { model });
    this.currentModel = model;
  }

  private async setEffort(effort: string): Promise<void> {
    const currentOpt = this.modelOptions.find((entry) => entry.id === this.currentModel || entry.model === this.currentModel);
    if (currentOpt && currentOpt.efforts.length > 0 && !currentOpt.efforts.some((entry) => entry.value === effort)) {
      throw new Error(`Claude 当前模型不支持推理强度 ${effort}`);
    }
    await this.rpc.request('apply_flag_settings', { settings: { effortLevel: effort } });
    this.currentEffort = effort;
    this.refreshModelOptions();
  }

  private async applyPolicy(policy: AgentSessionPolicy): Promise<void> {
    if (!driverCapabilities('claude').policies.includes(policy)) {
      throw new Error(`Claude Code 不支持「${policy}」权限档位`);
    }
    const target = claudePermissionModeForPolicy(policy);
    if (target === 'bypassPermissions') {
      await this.applyFullAutoPermissionMode();
    } else if (this.currentPermissionMode !== target) {
      await this.rpc.request('set_permission_mode', { mode: target });
      this.currentPermissionMode = target;
    }
    this.policy = policy;
  }

  /**
   * Applies Claude's `bypassPermissions` mode with Orca's fallback ladder (`auto` -> `default`)
   * when enterprise or local settings disable bypass mode; client-side `can_use_tool` still
   * auto-approves non-user-interaction tools under `full-auto`.
   */
  private async applyFullAutoPermissionMode(): Promise<void> {
    if (this.currentPermissionMode === 'bypassPermissions') return;
    if (!this.bypassRefused) {
      try {
        await this.rpc.request('set_permission_mode', { mode: 'bypassPermissions' });
        this.currentPermissionMode = 'bypassPermissions';
        return;
      } catch (error) {
        if (!isClaudeBypassRefusal(error)) throw error;
        this.bypassRefused = true;
      }
    }
    if (!this.autoRefused && this.currentPermissionMode !== 'auto') {
      try {
        await this.rpc.request('set_permission_mode', { mode: 'auto' });
        this.currentPermissionMode = 'auto';
        return;
      } catch (error) {
        if (!isClaudeAutoRefusal(error)) throw error;
        this.autoRefused = true;
      }
    }
    if (this.currentPermissionMode !== 'default') {
      await this.rpc.request('set_permission_mode', { mode: 'default' });
      this.currentPermissionMode = 'default';
    }
  }

  private readCapabilities(raw: unknown): void {
    for (const entry of asArray(raw)) {
      if (typeof entry === 'string' && entry) this.serverCapabilities.add(entry);
    }
  }

  private refreshModelOptions(): void {
    this.modelOptions = parseClaudeModels(this.rawModels, this.currentEffort);
  }

  // --- Inbound Frame Router ---

  private receive(record: JsonlRecord): void {
    if (this.disconnected) return;
    const type = asText(record.type);
    if (!type) return;

    if (type === 'control_request') {
      void this.handleControlRequest(record);
      return;
    }
    if (type === 'control_cancel_request') {
      const requestId = asNonEmptyText(record.request_id);
      if (requestId) {
        const controller = this.pendingControls.get(requestId);
        if (controller) {
          this.pendingControls.delete(requestId);
          controller.abort();
        }
      }
      return;
    }
    if (type === 'conversation_reset') {
      const nextId = asNonEmptyText(record.new_conversation_id);
      if (nextId) this.claudeSessionId = nextId;
      return;
    }
    if (type === 'system') {
      this.handleSystem(record);
      return;
    }

    const turn = this.active;
    if (!turn) return;

    if (type === 'command_lifecycle') {
      if (record.command_uuid === turn.userMessageUuid) this.sawEvidence(turn);
      return;
    }
    if (type === 'stream_event') {
      this.sawEvidence(turn);
      this.handleStreamEvent(turn, record);
      return;
    }
    if (type === 'assistant') {
      this.sawEvidence(turn);
      this.handleAssistant(turn, record);
      return;
    }
    if (type === 'user') {
      this.handleUser(turn, record);
      return;
    }
    if (type === 'result') {
      this.sawEvidence(turn);
      this.handleResult(turn, record);
    }
  }

  private handleSystem(record: JsonlRecord): void {
    const subtype = asText(record.subtype);
    const turn = this.active;
    if (subtype === 'init') {
      const sid = asNonEmptyText(record.session_id);
      if (sid && !this.claudeSessionId) this.claudeSessionId = sid;
      const model = asNonEmptyText(record.model);
      if (model) this.currentModel = model;
      const permMode = asNonEmptyText(record.permissionMode);
      if (permMode) this.currentPermissionMode = permMode as ClaudePermissionMode;
      this.readCapabilities(record.capabilities);
      if (turn) this.sawEvidence(turn);
      return;
    }
    if (!turn) return;

    if (subtype === 'session_state_changed') {
      if (record.state === 'running') this.sawEvidence(turn);
      return;
    }
    if (subtype === 'status') {
      this.sawEvidence(turn);
      if (record.status === 'compacting') {
        this.timeline(turn, { type: 'notice', id: `compact:${turn.turnId}`, level: 'info', text: '正在压缩上下文…' });
      } else if (record.compact_result === 'success' && !turn.compactBoundarySeen) {
        this.timeline(turn, { type: 'notice', id: `compact:${turn.turnId}`, level: 'info', text: '上下文已压缩' });
      } else if (record.compact_result === 'failed' && !turn.cancelRequested) {
        const detail = asNonEmptyText(record.compact_error);
        this.timeline(turn, {
          type: 'notice',
          id: `compact:${turn.turnId}`,
          level: 'warning',
          text: detail ? `压缩上下文失败：${detail}` : '压缩上下文失败',
        });
      }
      return;
    }
    if (subtype === 'compact_boundary') {
      turn.compactBoundarySeen = true;
      this.timeline(turn, {
        type: 'notice',
        id: `compact:${turn.turnId}`,
        level: 'info',
        text: formatClaudeCompactNotice(record.compact_metadata),
      });
      return;
    }
    if (subtype === 'api_retry') {
      const attempt = typeof record.attempt === 'number' ? record.attempt : null;
      const max = typeof record.max_retries === 'number' ? record.max_retries : null;
      const label = attempt && max ? `Claude 请求失败，正在第 ${attempt}/${max} 次重试…` : 'Claude 请求失败，正在自动重试…';
      this.timeline(turn, { type: 'notice', id: `retry:${turn.turnId}:${attempt ?? Date.now()}`, level: 'warning', text: label });
    }
  }

  // --- Stream Events (Partial Messages) ---

  private handleStreamEvent(turn: ClaudeTurn, record: JsonlRecord): void {
    // Subagent stream deltas stay isolated from the root assistant bubble.
    if (asNonEmptyText(record.parent_tool_use_id)) return;
    const event = asObject(record.event);
    const eventType = asText(event.type);
    if (!eventType) return;

    if (eventType === 'message_start') {
      this.closeOpenStreams(turn);
      const message = asObject(event.message);
      turn.streamMsgId = asNonEmptyText(message.id) ?? null;
      turn.streamBlocks.clear();
      const usage = normalizeClaudeUsage(message.usage);
      if (usage) {
        turn.usage = usage;
        this.timeline(turn, { type: 'usage', usage });
      }
      return;
    }

    if (eventType === 'content_block_start') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const block = asObject(event.content_block);
      const blockType = asText(block.type);
      if (blockType === 'thinking') {
        this.closeActiveText(turn);
        const id = `think:${turn.turnId}:${++turn.thinkSeg}`;
        const state: StreamBlockState = { kind: 'reasoning', id, closed: false };
        turn.streamBlocks.set(index, state);
        turn.activeThoughtId = id;
        this.recordStreamedBlock(turn, 'think', id);
        const initial = asText(block.thinking);
        if (initial) {
          this.timeline(turn, { type: 'delta', id, kind: 'reasoning', field: 'text', delta: initial });
        } else {
          this.timeline(turn, { type: 'item', item: { id, kind: 'reasoning', status: 'running' } });
        }
        return;
      }
      if (blockType === 'text') {
        this.closeActiveThought(turn);
        const id = `msg:${turn.turnId}:${++turn.textSeg}`;
        const state: StreamBlockState = { kind: 'message', id, closed: false };
        turn.streamBlocks.set(index, state);
        turn.activeMessageId = id;
        this.recordStreamedBlock(turn, 'text', id);
        const initial = asText(block.text);
        if (initial) {
          turn.messages.set(id, (turn.messages.get(id) ?? '') + initial);
          turn.lastMessage = id;
          this.append(initial);
          this.timeline(turn, { type: 'delta', id, kind: 'message', field: 'text', delta: initial });
        }
        return;
      }
      if (blockType === 'tool_use' || blockType === 'server_tool_use') {
        this.closeOpenStreams(turn);
        const toolId = asNonEmptyText(block.id);
        const toolName = asNonEmptyText(block.name);
        if (toolId && toolName) {
          turn.streamBlocks.set(index, {
            kind: 'tool',
            id: `tool:${toolId}`,
            closed: false,
            toolId,
            toolName,
            jsonBuf: '',
          });
        }
      }
      return;
    }

    if (eventType === 'content_block_delta') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const delta = asObject(event.delta);
      const deltaType = asText(delta.type);
      if (deltaType === 'thinking_delta') {
        const chunk = asText(delta.thinking);
        if (!chunk) return;
        let entry = turn.streamBlocks.get(index);
        if (!entry || entry.kind !== 'reasoning') {
          this.closeActiveText(turn);
          const id = `think:${turn.turnId}:${++turn.thinkSeg}`;
          entry = { kind: 'reasoning', id, closed: false };
          turn.streamBlocks.set(index, entry);
          turn.activeThoughtId = id;
          this.recordStreamedBlock(turn, 'think', id);
        }
        this.timeline(turn, { type: 'delta', id: entry.id, kind: 'reasoning', field: 'text', delta: chunk });
        return;
      }
      if (deltaType === 'text_delta') {
        const chunk = asText(delta.text);
        if (!chunk) return;
        let entry = turn.streamBlocks.get(index);
        if (!entry || entry.kind !== 'message') {
          this.closeActiveThought(turn);
          const id = `msg:${turn.turnId}:${++turn.textSeg}`;
          entry = { kind: 'message', id, closed: false };
          turn.streamBlocks.set(index, entry);
          turn.activeMessageId = id;
          this.recordStreamedBlock(turn, 'text', id);
        }
        turn.messages.set(entry.id, (turn.messages.get(entry.id) ?? '') + chunk);
        turn.lastMessage = entry.id;
        this.append(chunk);
        this.timeline(turn, { type: 'delta', id: entry.id, kind: 'message', field: 'text', delta: chunk });
        return;
      }
      if (deltaType === 'input_json_delta') {
        const partial = asText(delta.partial_json);
        const entry = turn.streamBlocks.get(index);
        if (entry?.kind === 'tool' && partial && (entry.jsonBuf?.length ?? 0) < MAX_TOOL_JSON_BUF) {
          entry.jsonBuf = (entry.jsonBuf ?? '') + partial;
        }
      }
      return;
    }

    if (eventType === 'content_block_stop') {
      const index = typeof event.index === 'number' ? event.index : 0;
      const entry = turn.streamBlocks.get(index);
      if (!entry || entry.closed) return;
      entry.closed = true;
      if (entry.kind === 'reasoning') {
        this.timeline(turn, { type: 'item', item: { id: entry.id, kind: 'reasoning', status: 'completed', completedAt: Date.now() } });
        if (turn.activeThoughtId === entry.id) turn.activeThoughtId = null;
      } else if (entry.kind === 'message') {
        this.timeline(turn, { type: 'item', item: { id: entry.id, kind: 'message', status: 'completed', completedAt: Date.now() } });
        if (turn.activeMessageId === entry.id) turn.activeMessageId = null;
      } else if (entry.kind === 'tool' && entry.toolId && entry.toolName && !turn.tools.has(entry.toolId)) {
        // Fallback when a stream omits the companion `assistant` frame after tool input finishes.
        let parsedInput: unknown = {};
        if (entry.jsonBuf) {
          try {
            parsedInput = JSON.parse(entry.jsonBuf);
          } catch {
            parsedInput = {};
          }
        }
        this.emitToolUse(turn, entry.toolId, entry.toolName, parsedInput);
      }
      return;
    }

    if (eventType === 'message_delta') {
      const usage = normalizeClaudeUsage(event.usage);
      if (usage) {
        turn.usage = usage;
        this.timeline(turn, { type: 'usage', usage });
      }
      return;
    }

    if (eventType === 'message_stop') {
      this.closeOpenStreams(turn);
    }
  }

  private recordStreamedBlock(turn: ClaudeTurn, kind: 'text' | 'think', id: string): void {
    const key = turn.streamMsgId ?? '__current__';
    let entry = turn.streamedByMsg.get(key);
    if (!entry) {
      entry = { textIds: [], thinkIds: [] };
      turn.streamedByMsg.set(key, entry);
    }
    if (kind === 'text') entry.textIds.push(id);
    else entry.thinkIds.push(id);
  }

  private claimStreamedBlock(turn: ClaudeTurn, msgId: string | null, kind: 'text' | 'think'): string | null {
    const queue = (msgId ? turn.streamedByMsg.get(msgId) : undefined) ?? turn.streamedByMsg.get('__current__');
    if (!queue) return null;
    const id = kind === 'text' ? queue.textIds.shift() : queue.thinkIds.shift();
    return id ?? null;
  }

  private markStreamBlockClosed(turn: ClaudeTurn, id: string): void {
    for (const entry of turn.streamBlocks.values()) {
      if (entry.id === id) entry.closed = true;
    }
    if (turn.activeMessageId === id) turn.activeMessageId = null;
    if (turn.activeThoughtId === id) turn.activeThoughtId = null;
  }

  // --- Assistant & User (Tool Result) Frames ---

  private handleAssistant(turn: ClaudeTurn, record: JsonlRecord): void {
    const parentToolUseId = asNonEmptyText(record.parent_tool_use_id);
    const message = asObject(record.message);
    const content = asArray(message.content).map(asObject);

    // Subagent activity updates the parent Task/Agent tool call's progress line instead of polluting root prose.
    if (parentToolUseId) {
      const parent = turn.tools.get(parentToolUseId);
      if (parent && parent.itemKind === 'tool_call') {
        const subTool = content.find((block) => block.type === 'tool_use' && typeof block.name === 'string');
        if (subTool) {
          this.timeline(turn, {
            type: 'item',
            item: { id: `tool:${parentToolUseId}`, kind: 'tool_call', progress: `子代理调用 ${subTool.name as string}` },
          });
        }
      }
      return;
    }

    const msgId = asNonEmptyText(message.id) ?? null;
    const apiError = asNonEmptyText(record.error) ?? asNonEmptyText(record.api_error);
    if (record.is_api_error_message === true) {
      const errorText = content
        .filter((block) => block.type === 'text' && typeof block.text === 'string')
        .map((block) => (block.text as string).trim())
        .filter(Boolean)
        .join('\n');
      turn.lastError = errorText || apiError || turn.lastError;
      return;
    }
    if (apiError) {
      turn.lastError = apiError;
    }

    const usage = normalizeClaudeUsage(message.usage);
    if (usage) {
      turn.usage = usage;
      this.timeline(turn, { type: 'usage', usage });
    }

    for (const block of content) {
      const blockType = asText(block.type);
      if (blockType === 'thinking') {
        const thinking = asText(block.thinking) ?? '';
        const claimed = this.claimStreamedBlock(turn, msgId, 'think');
        if (claimed) {
          this.markStreamBlockClosed(turn, claimed);
          this.timeline(turn, {
            type: 'item',
            item: { id: claimed, kind: 'reasoning', status: 'completed', ...(thinking ? { text: thinking } : {}), completedAt: Date.now() },
          });
        } else if (thinking) {
          const id = `think:${turn.turnId}:${++turn.thinkSeg}`;
          this.timeline(turn, {
            type: 'item',
            item: { id, kind: 'reasoning', status: 'completed', text: thinking, completedAt: Date.now() },
          });
        }
        continue;
      }

      if (blockType === 'text') {
        const value = asText(block.text) ?? '';
        const claimed = this.claimStreamedBlock(turn, msgId, 'text');
        if (claimed) {
          this.markStreamBlockClosed(turn, claimed);
          if (value) {
            turn.messages.set(claimed, value);
            turn.lastMessage = claimed;
          }
          this.timeline(turn, {
            type: 'item',
            item: { id: claimed, kind: 'message', role: 'assistant', status: 'completed', ...(value ? { text: value } : {}), completedAt: Date.now() },
          });
        } else if (value) {
          const id = `msg:${turn.turnId}:${++turn.textSeg}`;
          turn.messages.set(id, value);
          turn.lastMessage = id;
          this.append(value);
          this.timeline(turn, {
            type: 'item',
            item: { id, kind: 'message', role: 'assistant', status: 'completed', text: value, completedAt: Date.now() },
          });
        }
        continue;
      }

      if (blockType === 'tool_use' || blockType === 'server_tool_use') {
        const toolId = asNonEmptyText(block.id);
        const toolName = asNonEmptyText(block.name);
        if (toolId && toolName) {
          this.closeOpenStreams(turn);
          this.emitToolUse(turn, toolId, toolName, block.input ?? {});
        }
      }
    }
  }

  private emitToolUse(turn: ClaudeTurn, toolId: string, toolName: string, input: unknown): void {
    const { tracked, event } = translateClaudeToolStart(turn.turnId, toolId, toolName, input);
    turn.tools.set(toolId, tracked);
    if (event) this.timeline(turn, event);
  }

  private handleUser(turn: ClaudeTurn, record: JsonlRecord): void {
    if (record.uuid === turn.userMessageUuid) this.sawEvidence(turn);
    // Skip replayed/synthetic user messages; only tool_result blocks update timeline items.
    if (record.isReplay === true || record.isSynthetic === true) return;
    if (asNonEmptyText(record.parent_tool_use_id)) return;
    const message = asObject(record.message);
    const content = asArray(message.content).map(asObject);
    for (const block of content) {
      if (block.type !== 'tool_result') continue;
      const toolUseId = asNonEmptyText(block.tool_use_id);
      if (!toolUseId) continue;
      this.sawEvidence(turn);
      const tracked = turn.tools.get(toolUseId) ?? {
        id: toolUseId,
        name: 'tool',
        input: {},
        itemKind: 'tool_call' as const,
      };
      const event = translateClaudeToolResult(
        turn.turnId,
        tracked,
        block.content,
        block.is_error === true,
        record.tool_use_result,
        turn.declinedTools.has(toolUseId),
        Date.now(),
      );
      if (event) this.timeline(turn, event);
      turn.tools.delete(toolUseId);
    }
  }

  // --- Result & Turn Settlement ---

  private handleResult(turn: ClaudeTurn, record: JsonlRecord): void {
    // Subagent results never settle the root turn.
    if (asNonEmptyText(record.parent_tool_use_id)) return;
    this.closeOpenStreams(turn);

    const usage = normalizeClaudeUsage(record.usage) ?? turn.usage;
    if (usage) {
      turn.usage = usage;
      this.timeline(turn, { type: 'usage', usage });
    }

    const terminalReason = asNonEmptyText(record.terminal_reason);
    const aborted = Boolean(terminalReason && ABORTED_TERMINAL_REASONS.has(terminalReason));
    const isError = record.is_error === true || (typeof record.subtype === 'string' && record.subtype.startsWith('error'));

    const stopReason = aborted || turn.cancelRequested
      ? 'interrupted'
      : isError
        ? 'failed'
        : 'completed';
    const error = stopReason === 'failed' ? describeClaudeResultError(record, turn.lastError) : null;

    const resultText = asText(record.result) ?? '';
    let finalText = turn.lastMessage ? (turn.messages.get(turn.lastMessage) ?? '') : '';
    if (!finalText && resultText) {
      finalText = resultText;
      // Show a final result string when Claude produced no assistant text block (e.g. a local command).
      if (stopReason === 'completed' && turn.command !== 'compact') {
        const id = `msg:${turn.turnId}:${++turn.textSeg}`;
        turn.messages.set(id, resultText);
        turn.lastMessage = id;
        this.append(resultText);
        this.timeline(turn, {
          type: 'item',
          item: { id, kind: 'message', role: 'assistant', status: 'completed', text: resultText, completedAt: Date.now() },
        });
      }
    }

    this.dropTurn(turn);
    this.events.onTurnCompleted(turn.turnKey, {
      turnId: turn.turnId,
      stopReason,
      finalText,
      diff: null,
      usage,
      error,
    });
  }

  // --- Inbound Control Requests (Permissions & AskUserQuestion) ---

  private async handleControlRequest(record: JsonlRecord): Promise<void> {
    const requestId = asNonEmptyText(record.request_id);
    const req = asObject(record.request);
    const subtype = asNonEmptyText(req.subtype);
    if (!requestId || !subtype) return;

    // Per Claude Code wire contract: a host must not answer an undeclared request_user_dialog.
    if (subtype === 'request_user_dialog') return;

    const cancel = new AbortController();
    this.pendingControls.set(requestId, cancel);
    const signal = AbortSignal.any([this.disconnect.signal, cancel.signal]);
    try {
      let response: Obj | null;
      if (subtype === 'can_use_tool') {
        response = await this.handleCanUseTool(req, signal);
      } else if (subtype === 'elicitation') {
        response = { action: 'decline' };
      } else if (subtype === 'hook_callback') {
        response = {};
      } else {
        await this.writeControlError(requestId, `Unsupported Claude control request subtype: ${subtype}`);
        return;
      }
      if (this.disconnected || cancel.signal.aborted || response === null) return;
      await this.rpc.write({
        type: 'control_response',
        response: { subtype: 'success', request_id: requestId, response },
      }).catch(() => {});
    } catch (error) {
      if (this.disconnected || cancel.signal.aborted) return;
      await this.writeControlError(requestId, describe(error));
    } finally {
      if (this.pendingControls.get(requestId) === cancel) this.pendingControls.delete(requestId);
    }
  }

  private async writeControlError(requestId: string, error: string): Promise<void> {
    if (this.disconnected) return;
    await this.rpc.write({
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    }).catch(() => {});
  }

  private async handleCanUseTool(req: Obj, signal: AbortSignal): Promise<Obj | null> {
    const toolName = asNonEmptyText(req.tool_name) ?? 'tool';
    const input = asObject(req.input);
    const toolUseId = asNonEmptyText(req.tool_use_id) ?? '';
    const turn = this.active;
    if (!turn || this.stopping) {
      return { behavior: 'deny', message: 'Session is closing.', ...(toolUseId ? { toolUseID: toolUseId } : {}) };
    }
    this.sawEvidence(turn);

    // AskUserQuestion always asks the person regardless of permission tier.
    if (toolName === 'AskUserQuestion') {
      const parsed = parseClaudeAskUserQuestion(input);
      if (parsed) {
        let answers: Record<string, string[]> | null = null;
        try {
          const response = await this.events.onRequest(turn.turnKey, {
            kind: 'question',
            method: 'claude/AskUserQuestion',
            toolInput: '',
            questions: parsed.questions,
            signal,
          });
          answers = 'answers' in response ? response.answers : null;
        } catch {
          answers = null;
        }
        if (signal.aborted || this.disconnected) return null;
        if (!answers && toolUseId) turn.declinedTools.add(toolUseId);
        return parsed.reply(answers, toolUseId);
      }
    }

    // Read-only denies any action that asks for write/execution approval.
    if (this.policy === 'read-only') {
      if (toolUseId) turn.declinedTools.add(toolUseId);
      this.timeline(turn, { type: 'notice', level: 'warning', text: '只读模式：已拒绝一次需要授权的操作' });
      return {
        behavior: 'deny',
        message: 'Read-only mode: this action is not allowed.',
        ...(toolUseId ? { toolUseID: toolUseId } : {}),
      };
    }

    // Full-auto approves ordinary tool permissions automatically, never questions or plan/person-only prompts.
    if (this.policy === 'full-auto' && !claudeRequestRequiresPerson(toolName, req)) {
      return {
        behavior: 'allow',
        updatedInput: input,
        ...(toolUseId ? { toolUseID: toolUseId } : {}),
      };
    }

    let response: AgentRuntimeResponse;
    try {
      const message = formatClaudeApprovalMessage(req);
      response = await this.events.onRequest(turn.turnKey, {
        kind: 'approval',
        method: `claude/${toolName}`,
        toolInput: formatClaudeApprovalInput(toolName, input, req),
        ...(message ? { message } : {}),
        signal,
      });
    } catch {
      if (signal.aborted || this.disconnected) return null;
      if (toolUseId) turn.declinedTools.add(toolUseId);
      return { behavior: 'deny', message: 'User denied this action.', ...(toolUseId ? { toolUseID: toolUseId } : {}) };
    }
    if (signal.aborted || this.disconnected) return null;
    if ('decision' in response && response.decision === 'accept') {
      return {
        behavior: 'allow',
        updatedInput: input,
        ...(toolUseId ? { toolUseID: toolUseId } : {}),
      };
    }
    if (toolUseId) turn.declinedTools.add(toolUseId);
    const denial = toolName === 'ExitPlanMode'
      ? 'The user asked you to keep planning. Revise the plan and call ExitPlanMode again.'
      : 'User denied this action.';
    return {
      behavior: 'deny',
      message: denial,
      ...(toolUseId ? { toolUseID: toolUseId } : {}),
    };
  }

  // --- Helpers & Teardown ---

  private sawEvidence(turn: ClaudeTurn): void {
    if (turn.evidence) return;
    turn.evidence = true;
    this.emitTurnStarted(turn);
    turn.onEvidence?.();
  }

  private emitTurnStarted(turn: ClaudeTurn): void {
    if (turn.started) return;
    turn.started = true;
    this.timeline(turn, { type: 'turn_started', turnId: turn.turnId });
    this.events.onTurnStarted(turn.turnKey);
  }

  private closeActiveThought(turn: ClaudeTurn): void {
    if (!turn.activeThoughtId) return;
    const id = turn.activeThoughtId;
    this.markStreamBlockClosed(turn, id);
    this.timeline(turn, { type: 'item', item: { id, kind: 'reasoning', status: 'completed', completedAt: Date.now() } });
  }

  private closeActiveText(turn: ClaudeTurn): void {
    if (!turn.activeMessageId) return;
    const id = turn.activeMessageId;
    this.markStreamBlockClosed(turn, id);
    this.timeline(turn, { type: 'item', item: { id, kind: 'message', status: 'completed', completedAt: Date.now() } });
  }

  private closeOpenStreams(turn: ClaudeTurn): void {
    this.closeActiveThought(turn);
    this.closeActiveText(turn);
  }

  private dropTurn(turn: ClaudeTurn): void {
    if (this.active === turn) this.active = null;
    turn.onEvidence = null;
    turn.finish();
  }

  private transportLost(reason: string, exitCode: number | null = null): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.disconnect.abort();
    for (const controller of this.pendingControls.values()) controller.abort();
    this.pendingControls.clear();
    this.rpc.close(new JsonlRpcClosedError(reason));
    if (this.active) this.dropTurn(this.active);
    try {
      this.events.onExit(this.proc.withStderr(reason), exitCode);
    } finally {
      void this.close();
    }
  }

  private timeline(turn: ClaudeTurn, event: WorkerTimelineEvent): void {
    try {
      this.events.onTimeline?.(turn.turnKey, event);
    } catch (error) {
      console.warn('[agent-drivers] Claude Code timeline listener failed:', error);
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
  if (error instanceof JsonlRpcError) return error.message;
  return error instanceof Error ? error.message : String(error);
}
