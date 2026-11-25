// Generic Agent Client Protocol (ACP) session driver; dialects adapt each agent's extensions.
// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// - src/main/acp/protocol/acp-session-runtime.ts, acp-session-setup.ts, acp-permission-requests.ts
// - src/main/acp/timeline/acp-session-update.ts, acp-tool-timeline.ts
// - src/main/acp/requests/acp-structured-permission-handler.ts
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type {
  AgentOutputSlice, AgentRuntimeResponse, AgentSessionDriver, AgentSessionEvents, AgentSessionPolicy,
  AgentTurnAttachment, TurnDelivery,
} from '../../orchestration/agent-session-driver.js';
import type { CodexModelOption } from '../../orchestration/codex-catalog.js';
import type { WorkerTimelineEvent, WorkerTimelineFileChange, WorkerTimelineItemStatus } from '../../orchestration/worker-timeline.js';
import { AgentProcessHandle, type AgentChild } from '../agent-process.js';
import { driverCapabilities } from '../driver-capabilities.js';
import {
  JSON_RPC_2_ENVELOPE, JsonlRpc, JsonlRpcClosedError, JsonlRpcError, JsonlRpcWriteError, type JsonlRecord,
} from '../jsonl-rpc.js';
import { AcpRequestError } from './acp-form-elicitation.js';
import type { AcpClaimedRequest, AcpLaunchSpec, AcpToolUpdate } from './acp-dialects.js';

export const ACP_PROTOCOL_VERSION = 1;
const AUTH_REQUIRED = -32000;
const OUTPUT_LIMIT = 512 * 1024;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const numericFields = (value: unknown): Record<string, number> =>
  Object.fromEntries(Object.entries(object(value)).filter((entry): entry is [string, number] => typeof entry[1] === 'number'));

interface ToolMemory { itemKind: 'command' | 'file_change' | 'tool_call'; input: unknown; name: string }

interface AcpTurn {
  turnKey: string;
  turnId: string;
  messages: Map<string, string>;
  lastMessage: string | null;
  textSeg: number;
  thinkSeg: number;
  last: 'text' | 'thought' | 'tool' | null;
  tools: Map<string, ToolMemory>;
  retries: number;
  evidence: boolean;
  onEvidence: (() => void) | null;
  cancelRequested: boolean;
  idle: Promise<void>;
  finish: () => void;
}

export interface AcpDriverOptions {
  /** How long a written prompt waits for the agent's first sign of work before it counts as accepted. */
  acceptanceWindowMs?: number;
  requestTimeoutMs?: number;
  /** Session setup can wait on the agent's own sign-in refresh. */
  setupTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

function toolStatus(status: unknown, previous?: WorkerTimelineItemStatus): WorkerTimelineItemStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'pending' || status === 'in_progress') return 'running';
  return previous ?? 'running';
}

function toolOutput(update: AcpToolUpdate): string | undefined {
  const texts = array(update.content).map(object)
    .flatMap((block) => (block.type === 'content' && object(block.content).type === 'text' ? [text(object(block.content).text) ?? ''] : []));
  if (texts.length) return texts.join('\n');
  if (update.rawOutput === undefined) return undefined;
  if (typeof update.rawOutput === 'string') return update.rawOutput;
  const raw = object(update.rawOutput);
  if (typeof raw.stdout === 'string' || typeof raw.stderr === 'string') {
    return [raw.stdout, raw.stderr].filter((part): part is string => typeof part === 'string').join('\n');
  }
  return JSON.stringify(update.rawOutput);
}

function unifiedDiff(path: string, oldText: string | null, newText: string): string {
  const lines = (value: string) => (value ? value.replace(/\n$/u, '').split('\n') : []);
  const before = oldText === null ? [] : lines(oldText);
  const after = lines(newText);
  return [`--- ${oldText === null ? '/dev/null' : `a/${path}`}`, `+++ b/${path}`, `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`), ...after.map((line) => `+${line}`)].join('\n');
}

function fileChanges(update: AcpToolUpdate): WorkerTimelineFileChange[] {
  return array(update.content).map(object).filter((block) => block.type === 'diff' && typeof block.path === 'string')
    .map((block) => {
      const oldText = typeof block.oldText === 'string' ? block.oldText : null;
      const path = block.path as string;
      return {
        path, change: oldText === null ? 'add' as const : 'update' as const, movePath: null,
        diff: unifiedDiff(path, oldText, text(block.newText) ?? ''), added: 0, removed: 0, truncated: false,
      };
    });
}

/** One ACP session over `session/new|load|resume` and `session/prompt`. */
export class AcpSessionDriver implements AgentSessionDriver {
  readonly provider: AcpLaunchSpec['driver'];
  readonly capabilities: { resume: boolean; steer: boolean; policies: readonly AgentSessionPolicy[] };
  private readonly rpc: JsonlRpc;
  private readonly proc: AgentProcessHandle;
  private readonly disconnect = new AbortController();
  private readonly acceptanceWindowMs: number;
  private readonly setupTimeoutMs: number;
  private readonly env: NodeJS.ProcessEnv;
  private initialized: Obj | null = null;
  private acpSessionId: string | null = null;
  private policy: AgentSessionPolicy = 'workspace-write';
  private active: AcpTurn | null = null;
  private prompts = 0;
  private currentModel: string | null = null;
  private modelOptions: { id: string; name: string; description: string }[] = [];
  private modelConfigId: string | null = null;
  private effortConfigId: string | null = null;
  private effortValues: { value: string; description: string }[] = [];
  private currentEffort: string | null = null;
  private modeConfigId: string | null = null;
  private modeValues: string[] = [];
  private currentMode: string | null = null;
  private output = '';
  private offset = 0;
  private outputTurnKey: string | null = null;
  private disconnected = false;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;

  constructor(
    child: AgentChild,
    private readonly spec: AcpLaunchSpec,
    private readonly events: AgentSessionEvents,
    options: AcpDriverOptions = {},
  ) {
    this.provider = spec.driver;
    this.capabilities = { resume: true, steer: false, policies: driverCapabilities(spec.driver).policies };
    this.acceptanceWindowMs = options.acceptanceWindowMs ?? 1_500;
    this.setupTimeoutMs = options.setupTimeoutMs ?? 60_000;
    this.env = options.env ?? process.env;
    this.proc = new AgentProcessHandle(child);
    this.rpc = new JsonlRpc(child.stdout, child.stdin, JSON_RPC_2_ENVELOPE, {
      onRecord: (record) => this.receive(record),
      onClose: () => {
        if (this.stopping || this.disconnected) return;
        // Prefer the exit, which carries the code and lets stderr drain.
        const timer = setTimeout(() => this.transportLost(`${spec.label} 的输出已关闭`), 100);
        void this.proc.closed.then(() => clearTimeout(timer));
      },
    }, { requestTimeoutMs: options.requestTimeoutMs ?? 30_000 });
    void this.proc.closed.then(({ code, signal }) =>
      this.transportLost(`${spec.label} 已退出（${code ?? signal ?? 'unknown'}）`, code));
  }

  get alive(): boolean { return !this.disconnected && !this.stopping; }
  get busy(): boolean { return this.active !== null; }
  get closing(): boolean { return this.stopping; }
  get sessionId(): string | null { return this.acpSessionId; }
  get latestTurnKey(): string | null { return this.outputTurnKey; }
  get effectiveModel(): string | null { return this.currentModel; }
  get effectiveEffort(): string | null { return this.currentEffort; }

  /** Models the agent offered for this session (none before `open`). */
  models(): CodexModelOption[] {
    const images = object(object(this.initialized?.agentCapabilities).promptCapabilities).image === true;
    return this.modelOptions.map((option) => ({
      id: option.id, model: option.id, displayName: option.name || option.id, description: option.description,
      isDefault: option.id === this.currentModel, efforts: this.effortValues, defaultEffort: this.currentEffort, images,
    }));
  }

  async open({ cwd, model, policy, resumeSessionId }: {
    cwd: string; model: string | null; policy: AgentSessionPolicy; resumeSessionId?: string; network?: boolean;
    developerInstructions?: string;
  }): Promise<string> {
    try {
      const initialized = await this.initialize();
      const params = { cwd, mcpServers: [] };
      const capabilities = object(initialized.agentCapabilities);
      let method = 'session/new';
      if (resumeSessionId) {
        if (capabilities.loadSession === true) method = 'session/load';
        else if (object(capabilities.sessionCapabilities).resume) method = 'session/resume';
        else throw new Error(`${this.spec.label} 不支持恢复会话`);
      }
      const response = object(await this.withSignIn(initialized, () => this.rpc.request(
        method, resumeSessionId ? { ...params, sessionId: resumeSessionId } : params, { timeoutMs: this.setupTimeoutMs },
      )));
      const id = resumeSessionId ?? text(response.sessionId);
      if (!id) throw new Error(`${this.spec.label} 没有返回会话 ID`);
      this.acpSessionId = id;
      this.readSessionOptions(response);
      if (model && model !== this.currentModel) await this.setModel(model);
      await this.applyPolicy(policy);
      return id;
    } catch (error) {
      throw new Error(this.proc.withStderr(this.describe(error)));
    }
  }

  async startTurn({ turnKey, prompt, effort, model, policy, attachments = [] }: {
    turnKey: string; prompt: string; effort?: string | null; model?: string | null; policy?: AgentSessionPolicy;
    network?: boolean; attachments?: readonly AgentTurnAttachment[];
  }): Promise<TurnDelivery> {
    if (!this.alive || !this.acpSessionId || this.active) {
      return { status: 'not_accepted', reason: `${this.spec.label} 会话已关闭或正忙` };
    }
    try {
      if (model && model !== this.currentModel) await this.setModel(model);
      if (effort && effort !== this.currentEffort) await this.setEffort(effort);
      if (policy) await this.applyPolicy(policy);
    } catch (error) {
      return { status: this.alive ? 'not_accepted' : 'unknown_acceptance', reason: this.describe(error) };
    }
    let blocks: Obj[];
    try {
      blocks = this.promptBlocks(prompt, attachments);
    } catch (error) {
      return { status: 'not_accepted', reason: this.describe(error) };
    }
    let finish!: () => void;
    const idle = new Promise<void>((resolve) => { finish = resolve; });
    const turn: AcpTurn = {
      turnKey, turnId: `prompt-${++this.prompts}`, messages: new Map(), lastMessage: null, textSeg: 0, thinkSeg: 0, last: null,
      tools: new Map(), retries: 0, evidence: false, onEvidence: null, cancelRequested: false, idle, finish,
    };
    this.active = turn;
    if (this.outputTurnKey !== turnKey) {
      this.outputTurnKey = turnKey;
      this.output = '';
      this.offset = 0;
    }
    const reply = this.rpc.request('session/prompt', { sessionId: this.acpSessionId, prompt: blocks }, { timeoutMs: null });
    const delivery = await new Promise<TurnDelivery>((resolve) => {
      const timer = setTimeout(() => resolve(this.alive
        ? { status: 'accepted' }
        : { status: 'unknown_acceptance', reason: `${this.spec.label} 在确认收到消息前断开` }), this.acceptanceWindowMs);
      const done = (value: TurnDelivery) => {
        clearTimeout(timer);
        turn.onEvidence = null;
        resolve(value);
      };
      turn.onEvidence = () => done({ status: 'accepted' });
      if (turn.evidence) done({ status: 'accepted' });
      reply.then(
        () => done({ status: 'accepted' }),
        (error: unknown) => {
          if (turn.evidence) return done({ status: 'accepted' });
          // Only a refusal the agent sent before any work, or a write that never left, is safe to resend.
          if (error instanceof JsonlRpcWriteError || (error instanceof JsonlRpcError && this.alive)) {
            return done({ status: 'not_accepted', reason: this.describe(error) });
          }
          done({ status: 'unknown_acceptance', reason: this.describe(error) });
        },
      );
    });
    if (delivery.status !== 'accepted') {
      this.finishTurn(turn);
      return delivery;
    }
    turn.evidence = true;
    this.timeline(turn, { type: 'turn_started', turnId: turn.turnId });
    this.events.onTurnStarted(turnKey);
    void reply.then(
      (result) => this.completeTurn(turn, object(result), null),
      (error: unknown) => {
        if (error instanceof JsonlRpcError) this.completeTurn(turn, {}, error);
      },
    );
    return delivery;
  }

  /** Runs the agent's own `/compact` command as a turn. */
  async compactThread(turnKey: string): Promise<TurnDelivery> {
    if (!this.spec.dialect.compactCommand) return { status: 'not_accepted', reason: `${this.spec.label} 不支持压缩上下文` };
    return this.startTurn({ turnKey, prompt: this.spec.dialect.compactCommand });
  }

  async interrupt(): Promise<boolean> {
    const turn = this.active;
    if (!this.alive || !turn || !this.acpSessionId) return false;
    turn.cancelRequested = true;
    try {
      await this.rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.acpSessionId } });
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
      if (interrupt && this.active && !this.disconnected && this.acpSessionId) {
        this.active.cancelRequested = true;
        await this.rpc.write({ jsonrpc: '2.0', method: 'session/cancel', params: { sessionId: this.acpSessionId } }).catch(() => {});
        await this.waitForIdle(2_000);
      }
      this.disconnect.abort();
      this.rpc.close();
      await this.proc.kill();
    })();
    return this.stopPromise;
  }

  private initialize(): Promise<Obj> {
    if (this.initialized) return Promise.resolve(this.initialized);
    return this.rpc.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...this.spec.dialect.clientCapabilities },
      clientInfo: { name: 'ahastation', title: 'AhaStation', version: '0.1.0' },
    }).then((value) => {
      const response = object(value);
      if (response.protocolVersion !== ACP_PROTOCOL_VERSION) {
        throw new Error(`${this.spec.label} 使用不支持的 ACP 版本 ${String(response.protocolVersion)}`);
      }
      this.initialized = response;
      return response;
    });
  }

  private async withSignIn<T>(initialized: Obj, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof JsonlRpcError) || error.code !== AUTH_REQUIRED) throw error;
      const advertised = array(initialized.authMethods).map(object).map((method) => text(method.id)).filter((id): id is string => Boolean(id));
      const methodId = this.spec.dialect.authMethod?.(advertised, this.env);
      if (!methodId) throw new Error(`${this.spec.label} 需要先登录：请在终端运行 ${this.spec.command} 完成登录后重试`);
      await this.rpc.request('authenticate', { methodId }, { timeoutMs: this.setupTimeoutMs });
      return run();
    }
  }

  private readSessionOptions(response: Obj): void {
    const models = object(response.models);
    const listed = array(models.availableModels).map(object).filter((model) => typeof model.modelId === 'string');
    if (listed.length) {
      this.modelOptions = listed.map((model) => ({
        id: model.modelId as string, name: text(model.name) ?? (model.modelId as string), description: text(model.description) ?? '',
      }));
      this.currentModel = text(models.currentModelId) ?? this.currentModel;
    }
    this.readConfigOptions(response.configOptions);
    const modes = object(response.modes);
    const available = array(modes.availableModes).map(object).map((mode) => text(mode.id)).filter((id): id is string => Boolean(id));
    if (available.length && !this.modeConfigId) {
      this.modeValues = available;
      this.currentMode = text(modes.currentModeId) ?? null;
    }
  }

  private readConfigOptions(value: unknown): void {
    for (const option of array(value).map(object)) {
      const id = text(option.id);
      if (!id) continue;
      const values = array(option.options).map(object).filter((entry) => typeof entry.value === 'string');
      if (option.category === 'model') {
        this.modelConfigId = id;
        this.currentModel = text(option.currentValue) ?? this.currentModel;
        this.modelOptions = values.map((entry) => ({
          id: entry.value as string, name: text(entry.name) ?? (entry.value as string), description: text(entry.description) ?? '',
        }));
      } else if (option.category === 'thought_level') {
        this.effortConfigId = id;
        this.currentEffort = text(option.currentValue) ?? this.currentEffort;
        this.effortValues = values.map((entry) => ({ value: entry.value as string, description: text(entry.name) ?? '' }));
      } else if (option.category === 'mode') {
        this.modeConfigId = id;
        this.currentMode = text(option.currentValue) ?? this.currentMode;
        this.modeValues = values.map((entry) => entry.value as string);
      }
    }
  }

  private async setModel(model: string): Promise<void> {
    if (!this.modelOptions.some((option) => option.id === model)) throw new Error(`${this.spec.label} 没有提供模型 ${model}`);
    if (this.modelConfigId) {
      const response = object(await this.rpc.request('session/set_config_option', {
        sessionId: this.acpSessionId, configId: this.modelConfigId, value: model,
      }));
      this.readConfigOptions(response.configOptions);
    } else {
      await this.rpc.request('session/set_model', { sessionId: this.acpSessionId, modelId: model });
    }
    this.currentModel = model;
  }

  private async setEffort(effort: string): Promise<void> {
    if (!this.effortConfigId || !this.effortValues.some((option) => option.value === effort)) {
      throw new Error(`${this.spec.label} 不支持推理强度 ${effort}`);
    }
    const response = object(await this.rpc.request('session/set_config_option', {
      sessionId: this.acpSessionId, configId: this.effortConfigId, value: effort,
    }));
    this.readConfigOptions(response.configOptions);
    this.currentEffort = effort;
  }

  private async applyPolicy(policy: AgentSessionPolicy): Promise<void> {
    if (!driverCapabilities(this.spec.driver).policies.includes(policy)) {
      throw new Error(`${this.spec.label} 不支持「${policy}」权限档位`);
    }
    const mode = this.spec.dialect.readOnlyMode;
    const wanted = mode ? (policy === 'read-only' ? mode.value : mode.normal) : null;
    if (wanted && this.currentMode !== wanted) {
      if (!this.modeValues.includes(wanted)) {
        if (policy === 'read-only') throw new Error(`${this.spec.label} 没有只读模式`);
      } else if (this.modeConfigId) {
        const response = object(await this.rpc.request('session/set_config_option', {
          sessionId: this.acpSessionId, configId: this.modeConfigId, value: wanted,
        }));
        this.readConfigOptions(response.configOptions);
        this.currentMode = wanted;
      } else {
        await this.rpc.request('session/set_mode', { sessionId: this.acpSessionId, modeId: wanted });
        this.currentMode = wanted;
      }
    }
    this.policy = policy;
  }

  private promptBlocks(prompt: string, attachments: readonly AgentTurnAttachment[]): Obj[] {
    const images = object(object(this.initialized?.agentCapabilities).promptCapabilities).image === true;
    const blocks: Obj[] = [];
    const notes: string[] = [];
    for (const item of attachments) {
      if (item.type === 'skill') continue;
      const name = (item.name || basename(item.path)).replace(/"/gu, "'");
      const mime = IMAGE_MIME[extname(item.path).toLowerCase()];
      if (item.type === 'localImage' && images && mime) {
        const bytes = readFileSync(item.path);
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 10MB');
        blocks.push({ type: 'image', mimeType: mime, data: bytes.toString('base64') });
      }
      notes.push(`[Attached ${item.type === 'localImage' ? 'image' : 'file'} "${name}" is saved at: ${item.path}]`);
    }
    const body = [prompt, ...notes].filter(Boolean).join('\n\n');
    return [...(body ? [{ type: 'text', text: body }] : []), ...blocks];
  }

  private receive(record: JsonlRecord): void {
    if (this.disconnected) return;
    const method = text(record.method);
    if (!method) return;
    const id = record.id;
    if (typeof id === 'number' || typeof id === 'string') {
      void this.answer(id, method, record.params);
      return;
    }
    if (method !== 'session/update') return;
    const params = object(record.params);
    const turn = this.active;
    // A reopened session replays its history; only the running prompt's updates are shown.
    if (!turn || params.sessionId !== this.acpSessionId) return;
    this.sawEvidence(turn);
    this.applyUpdate(turn, object(params.update));
  }

  private sawEvidence(turn: AcpTurn): void {
    if (turn.evidence) return;
    turn.evidence = true;
    turn.onEvidence?.();
  }

  private applyUpdate(turn: AcpTurn, update: Obj): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
      case 'agent_thought_chunk': {
        const content = object(update.content);
        const chunk = text(content.text);
        if (content.type !== 'text' || !chunk) return;
        const thought = update.sessionUpdate === 'agent_thought_chunk';
        const retry = thought ? undefined : this.spec.dialect.retryNotice?.(chunk);
        if (retry) {
          this.timeline(turn, { type: 'notice', id: `retry:${turn.turnId}:${++turn.retries}`, level: 'warning', text: retry });
          return;
        }
        const messageId = text(update.messageId);
        if (thought) {
          if (turn.last === 'text' || turn.last === 'tool') turn.thinkSeg++;
          turn.last = 'thought';
          const id = messageId ? `think:${messageId}` : `think:${turn.turnId}:${turn.thinkSeg}`;
          this.timeline(turn, { type: 'delta', id, kind: 'reasoning', field: 'text', delta: chunk });
          return;
        }
        if (turn.last === 'thought' || turn.last === 'tool') turn.textSeg++;
        turn.last = 'text';
        const id = messageId ? `msg:${messageId}` : `msg:${turn.turnId}:${turn.textSeg}`;
        turn.messages.set(id, (turn.messages.get(id) ?? '') + chunk);
        turn.lastMessage = id;
        this.append(chunk);
        this.timeline(turn, { type: 'delta', id, kind: 'message', field: 'text', delta: chunk });
        return;
      }
      case 'tool_call':
      case 'tool_call_update':
        if (typeof update.toolCallId === 'string') this.applyTool(turn, update as AcpToolUpdate);
        return;
      case 'plan': {
        const steps = array(update.entries).map(object).map((entry) => ({
          step: text(entry.content) ?? '',
          status: entry.status === 'completed' ? 'completed' as const : entry.status === 'in_progress' ? 'in_progress' as const : 'pending' as const,
        }));
        this.timeline(turn, {
          type: 'item',
          item: {
            id: `plan:${turn.turnId}`, kind: 'plan', explanation: null, steps,
            status: steps.length > 0 && steps.every((step) => step.status === 'completed') ? 'completed' : 'running',
          },
        });
        return;
      }
      case 'config_option_update':
        this.readConfigOptions(update.configOptions);
        return;
      case 'current_mode_update':
        this.currentMode = text(update.currentModeId) ?? this.currentMode;
        return;
      default:
        return;
    }
  }

  private applyTool(turn: AcpTurn, raw: AcpToolUpdate): void {
    const update = this.spec.dialect.normalizeToolUpdate?.(raw) ?? raw;
    const known = turn.tools.get(update.toolCallId);
    const input = update.rawInput === undefined ? known?.input : update.rawInput;
    const files = fileChanges(update);
    const command = text(object(input).command);
    const itemKind = known?.itemKind ?? (files.length ? 'file_change' : update.kind === 'execute' || command ? 'command' : 'tool_call');
    const name = this.spec.dialect.toolName?.(update) ?? text(update.title) ?? known?.name ?? update.kind ?? 'tool';
    turn.tools.set(update.toolCallId, { itemKind, input, name: known?.name && !update.title ? known.name : name });
    turn.last = 'tool';
    const status = toolStatus(update.status);
    const output = toolOutput(update);
    const id = `tool:${update.toolCallId}`;
    const done = status === 'running' ? {} : { completedAt: Date.now() };
    if (itemKind === 'command') {
      const exitCode = object(update.rawOutput).exitCode;
      this.timeline(turn, {
        type: 'item',
        item: {
          id, kind: 'command', status, ...done,
          ...(command ?? text(update.title) ? { command: command ?? text(update.title)! } : {}),
          ...(typeof object(input).cwd === 'string' ? { cwd: object(input).cwd as string } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(typeof exitCode === 'number' ? { exitCode } : {}),
        },
      });
    } else if (itemKind === 'file_change') {
      this.timeline(turn, { type: 'item', item: { id, kind: 'file_change', status, ...done, ...(files.length ? { files } : {}) } });
    } else {
      this.timeline(turn, {
        type: 'item',
        item: {
          id, kind: 'tool_call', toolType: 'tool', server: null, tool: turn.tools.get(update.toolCallId)!.name, status, ...done,
          ...(input !== undefined ? { args: typeof input === 'string' ? input : JSON.stringify(input) } : {}),
          ...(output !== undefined ? { output } : {}),
          ...(status === 'failed' ? { error: output ?? '工具调用失败' } : {}),
        },
      });
    }
  }

  private async answer(id: string | number, method: string, params: unknown): Promise<void> {
    let reply: { result: unknown } | { error: { code: number; message: string } };
    try {
      reply = { result: await this.handleRequest(method, params) };
    } catch (error) {
      reply = error instanceof AcpRequestError
        ? { error: { code: error.code, message: error.message } }
        : { error: { code: -32603, message: error instanceof Error ? error.message : String(error) } };
    }
    if (this.disconnected) return;
    await this.rpc.write({ jsonrpc: '2.0', id, ...reply }).catch(() => {});
  }

  private async handleRequest(method: string, params: unknown): Promise<unknown> {
    const { dialect } = this.spec;
    const turn = this.active;
    const settled = dialect.settleRequest?.(method, params);
    if (settled) {
      if (turn && settled.notice) this.timeline(turn, { type: 'notice', level: 'info', text: settled.notice });
      return settled.reply;
    }
    const claimed = dialect.request?.(method, params);
    if (method === 'session/request_permission') return this.permission(object(params), claimed);
    if (claimed?.kind === 'question') return this.ask(method, claimed);
    throw new AcpRequestError(`Unsupported ACP client method: ${method}`, -32601);
  }

  /** Answers by policy, except requests a dialect claims (questions, warned approvals), which only the person answers. */
  private async permission(request: Obj, claimed: AcpClaimedRequest | undefined): Promise<unknown> {
    const cancelled = { outcome: { outcome: 'cancelled' } };
    const turn = this.active;
    if (!turn || request.sessionId !== this.acpSessionId) return cancelled;
    this.sawEvidence(turn);
    if (claimed?.kind === 'question') return this.ask('session/request_permission', claimed);
    const options = array(request.options).map(object).filter((option) => typeof option.optionId === 'string');
    const pick = (kinds: string[]) => kinds.map((kind) => options.find((option) => option.kind === kind)).find(Boolean);
    const allow = pick(['allow_once', 'allow_always']);
    const reject = pick(['reject_once', 'reject_always']);
    const select = (option: Obj | undefined) => (option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : cancelled);
    if (this.policy === 'read-only') {
      this.timeline(turn, { type: 'notice', level: 'warning', text: '只读模式：已拒绝一次需要授权的操作' });
      return select(reject);
    }
    if (this.policy === 'full-auto' && !claimed && allow) return select(allow);
    const toolCall = object(request.toolCall);
    const command = text(object(toolCall.rawInput).command);
    const title = text(toolCall.title) ?? text(toolCall.kind) ?? 'tool';
    let response: AgentRuntimeResponse;
    try {
      response = await this.events.onRequest(turn.turnKey, {
        kind: 'approval',
        method: `session/request_permission/${text(toolCall.kind) ?? 'tool'}`,
        toolInput: command ?? title,
        ...(claimed?.kind === 'approval' ? { message: claimed.warning } : command && title !== command ? { message: title } : {}),
        signal: this.disconnect.signal,
      });
    } catch {
      return cancelled;
    }
    if (this.disconnected) return cancelled;
    return 'decision' in response && response.decision === 'accept' ? select(allow) : select(reject);
  }

  /** Questions always wait for the person, whatever the policy. */
  private async ask(method: string, claimed: Extract<AcpClaimedRequest, { kind: 'question' }>): Promise<unknown> {
    const turn = this.active;
    if (!turn || this.stopping) return claimed.reply(null);
    this.sawEvidence(turn);
    let answers: Record<string, string[]> | null = null;
    try {
      const response = await this.events.onRequest(turn.turnKey, {
        kind: 'question', method, toolInput: '', questions: claimed.questions, signal: this.disconnect.signal,
      });
      answers = 'answers' in response ? response.answers : null;
    } catch {
      answers = null;
    }
    return claimed.reply(answers);
  }

  private completeTurn(turn: AcpTurn, result: Obj, error: JsonlRpcError | null): void {
    if (this.active !== turn) return;
    const blocked = error ? undefined : this.spec.dialect.hookBlock?.(result._meta);
    if (blocked) this.timeline(turn, { type: 'notice', level: 'warning', text: `本轮被 Hook 拦截：${blocked.reason}` });
    const reason = text(result.stopReason) ?? 'end_turn';
    // An agent that stops on its own (e.g. after a refused tool) also says `cancelled`; only our stop interrupts.
    const stopReason = error ? 'failed'
      : blocked || reason === 'end_turn' ? 'completed'
        : reason === 'cancelled' ? (turn.cancelRequested ? 'interrupted' : 'completed') : 'failed';
    const failure = error
      ? this.spec.dialect.promptErrorDetail?.(error) ?? error.message
      : stopReason === 'failed'
        ? reason === 'max_tokens' ? '已达到模型输出上限' : reason === 'refusal' ? '模型拒绝回答' : `本轮结束：${reason}`
        : null;
    const usage = numericFields(result.usage);
    this.finishTurn(turn);
    this.events.onTurnCompleted(turn.turnKey, {
      turnId: turn.turnId, stopReason, finalText: turn.lastMessage ? turn.messages.get(turn.lastMessage) ?? '' : '',
      diff: null, usage: Object.keys(usage).length ? usage : null, error: failure,
    });
  }

  private finishTurn(turn: AcpTurn): void {
    if (this.active === turn) this.active = null;
    turn.onEvidence = null;
    turn.finish();
  }

  private transportLost(reason: string, exitCode: number | null = null): void {
    if (this.disconnected) return;
    this.disconnected = true;
    this.disconnect.abort();
    this.rpc.close(new JsonlRpcClosedError(reason));
    if (this.active) this.finishTurn(this.active);
    try {
      this.events.onExit(this.proc.withStderr(reason), exitCode);
    } finally {
      void this.close();
    }
  }

  private timeline(turn: AcpTurn, event: WorkerTimelineEvent): void {
    try {
      this.events.onTimeline?.(turn.turnKey, event);
    } catch (error) {
      console.warn(`[agent-drivers] ${this.spec.label} timeline listener failed:`, error);
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

  private describe(error: unknown): string {
    if (error instanceof JsonlRpcError) return this.spec.dialect.promptErrorDetail?.(error) ?? error.message;
    return error instanceof Error ? error.message : String(error);
  }
}
