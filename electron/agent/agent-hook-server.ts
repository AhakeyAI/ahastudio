import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AgentStatusStore,
  type AgentLifecycleState,
  type AgentWaitKind,
  type NormalizedAgentHookEvent,
} from './agent-status-store.js';
import { isProgramStatusKind, normalizeAgentId } from './program-status-osc.js';

const PTY_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
const PROVIDER_SEGMENT_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const MAX_HOOK_BODY_BYTES = 65_536;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_CHARS = 300;
const MAX_TOOL_INPUT_CHARS = 160;

const DIRECT_STATES = new Set<AgentLifecycleState>([
  'idle',
  'working',
  'waiting',
  'done',
  'error',
]);

function canonicalHookEventName(name: string): string {
  if (name === 'agent-turn-complete') return name;
  switch (name.replace(/[-_\s]+/g, '').toLowerCase()) {
    case 'sessionstart': return 'SessionStart';
    case 'sessionend': return 'SessionEnd';
    case 'userpromptsubmit': return 'UserPromptSubmit';
    case 'preinvocation': return 'PreInvocation';
    case 'postinvocation': return 'PostInvocation';
    case 'beforeagent': return 'BeforeAgent';
    case 'afteragent': return 'AfterAgent';
    case 'beforetool': return 'BeforeTool';
    case 'aftertool': return 'AfterTool';
    case 'pretooluse': return 'PreToolUse';
    case 'posttooluse': return 'PostToolUse';
    case 'posttoolusefailure': return 'PostToolUseFailure';
    case 'permissionrequest': return 'PermissionRequest';
    case 'notification': return 'Notification';
    case 'subagentstart': return 'SubagentStart';
    case 'subagentstop':
    case 'subagentend': return 'SubagentStop';
    case 'teammateidle': return 'TeammateIdle';
    case 'stop': return 'Stop';
    case 'stopcancelled':
    case 'stopcanceled': return 'StopCancelled';
    case 'stopfailure': return 'StopFailure';
    case 'postcompact': return 'PostCompact';
    default: return name;
  }
}

function hasActiveGrokBackgroundTask(raw: Record<string, unknown>): boolean {
  const tasks = raw.backgroundTasks ?? raw.background_tasks;
  if (!Array.isArray(tasks)) return false;
  return tasks.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    const type = typeof record.type === 'string' ? record.type.toLowerCase() : '';
    if (type !== 'subagent' && type !== 'shell') return false;
    const status = typeof record.status === 'string' ? record.status.toLowerCase() : '';
    return !status || (status !== 'completed' && status !== 'failed' && status !== 'cancelled' && status !== 'canceled');
  });
}

function optStr(value: unknown, maxChars = MAX_MESSAGE_CHARS): string | undefined {
  if (typeof value !== 'string') return undefined;
  const compact = value.replace(/\s+/g, ' ').trim();
  if (!compact) return undefined;
  return compact.length > maxChars ? `${compact.slice(0, maxChars - 1)}…` : compact;
}

function extractToolInputPreview(toolInput: unknown, maxChars = MAX_TOOL_INPUT_CHARS): string | undefined {
  if (typeof toolInput === 'string') {
    return optStr(toolInput, maxChars);
  }
  if (!toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return undefined;
  }
  const record = toolInput as Record<string, unknown>;
  for (const key of [
    'command',
    'CommandLine',
    'cmd',
    'code',
    'file_path',
    'filePath',
    'path',
    'Path',
    'TargetFile',
    'target_file',
    'AbsolutePath',
    'pattern',
    'query',
    'url',
    'question',
    'prompt',
    'Prompt',
    'message',
    'description',
    'Description',
    'toolSummary',
    'Role',
    'name',
  ]) {
    const val = optStr(record[key], maxChars);
    if (val) return val;
  }
  if (Array.isArray(record.questions) && record.questions[0] && typeof record.questions[0] === 'object') {
    const firstQuestion = optStr((record.questions[0] as Record<string, unknown>).question, maxChars);
    if (firstQuestion) return firstQuestion;
  }
  try {
    return optStr(JSON.stringify(record), maxChars);
  } catch {
    return undefined;
  }
}

function extractToolInfo(
  raw: Record<string, unknown>,
  maxInputChars = MAX_TOOL_INPUT_CHARS,
): { toolName?: string; toolInput?: string } {
  const toolCall =
    raw.toolCall && typeof raw.toolCall === 'object' && !Array.isArray(raw.toolCall)
      ? (raw.toolCall as Record<string, unknown>)
      : undefined;
  const toolName = optStr(
    raw.tool_name ??
      raw.toolName ??
      raw.name ??
      raw.tool ??
      toolCall?.name ??
      toolCall?.toolName ??
      toolCall?.tool_name,
    80,
  );
  const toolInput = extractToolInputPreview(
    raw.tool_input ?? raw.toolInput ?? raw.input ?? raw.arguments ?? toolCall?.args ?? toolCall?.input,
    maxInputChars,
  );
  return { toolName, toolInput };
}

function resolveWaitKind(value: unknown): AgentWaitKind {
  return isProgramStatusKind(value) ? value : 'permission';
}

export function normalizeAgentHookPayload(
  providerHint: string | undefined,
  raw: Record<string, unknown>,
  fallbackPtyId?: string,
): NormalizedAgentHookEvent | null {
  const rawPtyId = fallbackPtyId ?? raw.ptyId ?? raw.terminalId ?? raw.paneId;
  if (typeof rawPtyId !== 'string' || !PTY_ID_RE.test(rawPtyId)) {
    return null;
  }
  const ptyId = rawPtyId;

  const hintedAgent =
    normalizeAgentId(providerHint) ??
    normalizeAgentId(optStr(raw.agentId ?? raw.agent ?? raw.provider ?? raw.app, 64));

  const rawEventName = optStr(raw.hook_event_name ?? raw.hookEventName ?? raw.event ?? raw.type, 64);
  const eventName = rawEventName ? canonicalHookEventName(rawEventName) : undefined;

  if (eventName) {
    // Grok child subagent hooks carry subagentType and must not overwrite parent main state.
    if (
      hintedAgent === 'grok' &&
      eventName !== 'SubagentStart' &&
      eventName !== 'SubagentStop' &&
      optStr(raw.subagentType ?? raw.subagent_type, 128)
    ) {
      return null;
    }

    switch (eventName) {
      case 'SessionStart':
        return { ptyId, agentId: hintedAgent, state: 'idle' };

      case 'UserPromptSubmit':
        return {
          ptyId,
          agentId: hintedAgent,
          state: 'working',
          clearTool: true,
          message: optStr(raw.prompt ?? raw.message),
        };

      case 'PreInvocation':
        return {
          ptyId,
          agentId: hintedAgent ?? 'antigravity',
          state: 'working',
          clearTool: true,
          message: optStr(raw.lastUserInput ?? raw.prompt ?? raw.message),
        };

      case 'PostInvocation':
        return {
          ptyId,
          agentId: hintedAgent ?? 'antigravity',
          state: 'working',
          clearTool: true,
        };

      case 'BeforeAgent':
        return {
          ptyId,
          agentId: hintedAgent ?? 'gemini',
          state: 'working',
          clearTool: true,
          message: optStr(raw.prompt ?? raw.message),
        };

      case 'BeforeTool': {
        const { toolName, toolInput } = extractToolInfo(raw);
        if (
          raw.requiresApproval === true ||
          raw.requires_approval === true ||
          raw.askPermission === true ||
          raw.ask_permission === true ||
          raw.confirmationDetails != null
        ) {
          return {
            ptyId,
            agentId: hintedAgent ?? 'gemini',
            state: 'waiting',
            waitKind: 'permission',
            toolName,
            toolInput,
          };
        }
        return {
          ptyId,
          agentId: hintedAgent ?? 'gemini',
          state: 'working',
          toolName,
          toolInput,
        };
      }

      case 'AfterTool':
        return {
          ptyId,
          agentId: hintedAgent ?? 'gemini',
          state: 'working',
          clearTool: true,
        };

      case 'AfterAgent':
        return {
          ptyId,
          agentId: hintedAgent ?? 'gemini',
          state: 'done',
          clearTool: true,
          message: optStr(raw.lastAssistantMessage ?? raw.last_assistant_message ?? raw.message),
        };

      case 'PreToolUse': {
        const { toolName, toolInput } = extractToolInfo(raw);
        if (
          toolName === 'AskUserQuestion' ||
          toolName === 'ask_user' ||
          toolName === 'ask_question' ||
          toolName === 'ask_user_question'
        ) {
          return {
            ptyId,
            agentId: hintedAgent,
            state: 'waiting',
            waitKind: 'question',
            toolName,
            toolInput,
          };
        }
        if (toolName === 'ask_permission') {
          return {
            ptyId,
            agentId: hintedAgent,
            state: 'waiting',
            waitKind: 'permission',
            toolName,
            toolInput,
          };
        }
        return {
          ptyId,
          agentId: hintedAgent,
          state: 'working',
          toolName,
          toolInput,
        };
      }

      case 'PostToolUse':
      case 'PostToolUseFailure':
        return {
          ptyId,
          agentId: hintedAgent,
          state: 'working',
          clearTool: true,
        };

      case 'PermissionRequest': {
        const { toolName, toolInput } = extractToolInfo(raw);
        return {
          ptyId,
          agentId: hintedAgent,
          state: 'waiting',
          waitKind: 'permission',
          toolName,
          toolInput,
          message: optStr(raw.message),
        };
      }

      case 'Notification': {
        const notifType = optStr(raw.notification_type ?? raw.notificationType ?? raw.type, 64) ?? '';
        const msg = optStr(raw.message ?? raw.title);
        // Grok routine bypassPermissions permission_prompt ("Tool permission requested") is non-blocking info.
        if (
          hintedAgent === 'grok' &&
          notifType.toLowerCase() === 'permission_prompt' &&
          msg?.toLowerCase() === 'tool permission requested'
        ) {
          const level = optStr(raw.level ?? raw.severity, 32)?.toLowerCase();
          if (!level || level === 'info') return null;
        }
        const combined = `${notifType} ${msg ?? ''}`;
        if (/(permission|approval|confirm|allow|elicitation|question|input|waiting)/i.test(combined)) {
          const waitKind: AgentWaitKind = /(question|elicitation|input)/i.test(combined)
            ? 'question'
            : 'permission';
          return {
            ptyId,
            agentId: hintedAgent,
            state: 'waiting',
            waitKind,
            message: msg,
          };
        }
        if (/idle/i.test(notifType)) {
          return {
            ptyId,
            agentId: hintedAgent,
            state: 'done',
            clearTool: true,
            message: msg,
          };
        }
        return null;
      }

      case 'SubagentStart': {
        const subId = optStr(raw.agent_id ?? raw.subagent_id ?? raw.agentId ?? raw.subagentId, 128) ?? 'subagent';
        return {
          ptyId,
          agentId: hintedAgent,
          subagentOp: {
            action: 'start',
            id: subId,
            title: optStr(
              raw.agent_type ?? raw.subagentType ?? raw.subagent_type ?? raw.description ?? raw.title,
              120,
            ),
          },
        };
      }

      case 'SubagentStop':
      case 'TeammateIdle': {
        const subId = optStr(raw.agent_id ?? raw.subagent_id ?? raw.agentId ?? raw.subagentId, 128) ?? 'subagent';
        return {
          ptyId,
          agentId: hintedAgent,
          subagentOp: {
            action: 'stop',
            id: subId,
          },
        };
      }

      case 'Stop':
      case 'PostCompact':
        if (eventName === 'Stop') {
          if (raw.fullyIdle === false || raw.fully_idle === false) {
            return {
              ptyId,
              agentId: hintedAgent,
              state: 'working',
              clearTool: true,
            };
          }
          if (String(raw.terminationReason ?? '').toUpperCase() === 'ERROR') {
            return {
              ptyId,
              agentId: hintedAgent,
              state: 'error',
              clearTool: true,
              message: optStr(
                raw.error ?? raw.message ?? raw.lastAssistantMessage ?? raw.last_assistant_message,
              ),
            };
          }
          if (hintedAgent === 'grok') {
            const reason = optStr(raw.reason, 64)?.toLowerCase();
            if (reason === 'shutdown' || reason === 'channel_closed') {
              return {
                ptyId,
                agentId: hintedAgent,
                state: 'idle',
                clearTool: true,
              };
            }
          }
          if (hasActiveGrokBackgroundTask(raw)) {
            return {
              ptyId,
              agentId: hintedAgent,
              state: 'working',
              clearTool: true,
            };
          }
        }
        return {
          ptyId,
          agentId: hintedAgent,
          state: 'done',
          clearTool: true,
          message: optStr(raw.lastAssistantMessage ?? raw.last_assistant_message ?? raw.message),
        };

      case 'StopCancelled':
        if (hasActiveGrokBackgroundTask(raw)) {
          return {
            ptyId,
            agentId: hintedAgent,
            state: 'working',
            clearTool: true,
          };
        }
        return {
          ptyId,
          agentId: hintedAgent,
          state: 'done',
          clearTool: true,
          message: optStr(
            raw.lastAssistantMessage ??
              raw.last_assistant_message ??
              raw.reasonDetails ??
              raw.reason_details ??
              raw.message,
          ),
        };

      case 'StopFailure':
        return {
          ptyId,
          agentId: hintedAgent,
          state: 'error',
          clearTool: true,
          message: optStr(
            raw.lastAssistantMessage ??
              raw.last_assistant_message ??
              raw.errorDetails ??
              raw.error_details ??
              raw.error ??
              raw.message,
          ),
        };

      case 'SessionEnd':
        return {
          ptyId,
          agentId: hintedAgent,
          state: 'idle',
          clearTool: true,
        };

      // Codex CLI notify event
      case 'agent-turn-complete':
        return {
          ptyId,
          agentId: hintedAgent ?? 'codex',
          state: 'done',
          message: optStr(raw['last-assistant-message'] ?? raw.last_assistant_message ?? raw.message),
        };
    }
  }

  // Generic state format fallback
  if (typeof raw.state === 'string' && DIRECT_STATES.has(raw.state as AgentLifecycleState)) {
    const state = raw.state as AgentLifecycleState;
    const event: NormalizedAgentHookEvent = {
      ptyId,
      agentId: hintedAgent,
      state,
      ...(state === 'waiting' ? { waitKind: resolveWaitKind(raw.waitKind ?? raw.kind) } : {}),
      ...(optStr(raw.toolName ?? raw.tool_name, 80)
        ? { toolName: optStr(raw.toolName ?? raw.tool_name, 80) }
        : {}),
      ...(extractToolInputPreview(raw.toolInput ?? raw.tool_input)
        ? { toolInput: extractToolInputPreview(raw.toolInput ?? raw.tool_input) }
        : {}),
      ...(optStr(raw.message) ? { message: optStr(raw.message) } : {}),
    };
    if (typeof raw.progress === 'number' && Number.isFinite(raw.progress)) {
      event.progress = Math.max(0, Math.min(100, Math.round(raw.progress)));
    }
    return event;
  }

  return null;
}

function sendJson(
  res: ServerResponse,
  statusCode: number,
  body: unknown,
  closeConnection = false,
): void {
  if (res.writableEnded) return;
  const text = JSON.stringify(body);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
    ...(closeConnection ? { connection: 'close' } : {}),
  });
  if (closeConnection) {
    res.end(text, () => {
      res.socket?.end();
    });
    return;
  }
  res.end(text);
}

function tokensEqual(expected: string, actual: string): boolean {
  const expectedBuf = Buffer.from(expected, 'utf8');
  const actualBuf = Buffer.from(actual, 'utf8');
  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

function extractBearerOrHookToken(req: IncomingMessage): string | null {
  const direct = req.headers['x-aha-agent-hook-token'];
  if (typeof direct === 'string' && direct.length > 0) {
    return direct;
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

export type OrchestrationHttpHandler = (
  action: string,
  payload: unknown,
  context: { signal: AbortSignal; callerPaneId: string | null }
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type CompanionHttpHandler = (
  namespace: 'terminal' | 'worktree' | 'skills',
  action: string,
  payload: unknown,
  context: { signal: AbortSignal; callerPaneId: string | null }
) => Promise<{ status: number; body: Record<string, unknown> }>;

export type PermissionHookInterceptor = (input: {
  ptyId: string;
  providerHint?: string;
  eventName: string;
  rawPayload: Record<string, unknown>;
  toolName?: string;
  toolInput?: string;
  message?: string;
  signal: AbortSignal;
}) => Promise<{ held: false } | { held: true; hookStdout?: string }>;

export interface UserPromptInterceptRequest {
  ptyId: string;
  provider: string;
  eventName: string;
  promptText?: string;
}

export type UserPromptInterceptor = (
  req: UserPromptInterceptRequest
) =>
  | { hookStdout?: string }
  | null
  | void
  | Promise<{ hookStdout?: string } | null | void>;

export interface PostToolInterceptRequest {
  ptyId: string;
  provider: string;
  eventName: string;
  toolName?: string;
}

export type PostToolInterceptor = (
  req: PostToolInterceptRequest
) =>
  | { hookStdout?: string }
  | null
  | void
  | Promise<{ hookStdout?: string } | null | void>;

export function supportsPostToolContextInjection(provider: string, eventName: string): boolean {
  const normProvider = provider.trim().toLowerCase();
  const cleanEvent = eventName.trim();
  return (
    ((normProvider === 'claude' || normProvider === 'claude-code' || normProvider === 'qwen') &&
      cleanEvent === 'PostToolUse') ||
    ((normProvider === 'gemini' || normProvider === 'gemini-cli') && cleanEvent === 'AfterTool')
  );
}

export function formatPostToolContextHookStdout(
  provider: string,
  eventName: string,
  text: string
): string | undefined {
  if (!supportsPostToolContextInjection(provider, eventName)) return undefined;
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  const cleanEvent = eventName.trim();
  return `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: cleanEvent,
      additionalContext: trimmed,
    },
  })}\n`;
}

export function formatAdditionalContextHookStdout(
  provider: string,
  eventName: string,
  text: string
): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  const normProvider = provider.trim().toLowerCase();
  const cleanEvent = eventName.trim() || 'UserPromptSubmit';

  if (normProvider === 'claude' || normProvider === 'claude-code') {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: cleanEvent,
        additionalContext: trimmed,
      },
    })}\n`;
  }

  if (normProvider === 'gemini' || normProvider === 'gemini-cli') {
    return `${JSON.stringify({
      hookSpecificOutput: {
        hookEventName: eventName.trim() || 'BeforeAgent',
        additionalContext: trimmed,
      },
    })}\n`;
  }

  if (normProvider === 'antigravity' || normProvider === 'agy') {
    return `${JSON.stringify({
      additionalContext: trimmed,
      hookSpecificOutput: {
        hookEventName: eventName.trim() || 'PreInvocation',
        additionalContext: trimmed,
      },
    })}\n`;
  }

  return `${JSON.stringify({
    additionalContext: trimmed,
    hookSpecificOutput: {
      hookEventName: cleanEvent,
      additionalContext: trimmed,
    },
  })}\n`;
}

export interface AgentHookBinShim {
  applyToEnv: (env: Record<string, string>) => Record<string, string>;
}

const MAX_ORCHESTRATION_BODY_BYTES = 256 * 1024;

function readBoundedJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let totalBytes = 0;
    const chunks: Buffer[] = [];
    let settled = false;

    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        fail(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', fail);
  });
}

export class AgentHookServer {
  private readonly token = randomBytes(32).toString('hex');
  private paneKey = randomBytes(32);
  private server: Server | null = null;
  private boundPort: number | null = null;
  private orchestrationHandler: OrchestrationHttpHandler | null = null;
  private companionHandler: CompanionHttpHandler | null = null;
  private permissionHookInterceptor: PermissionHookInterceptor | null = null;
  private userPromptInterceptor: UserPromptInterceptor | null = null;
  private postToolInterceptor: PostToolInterceptor | null = null;
  private orchestrationBinShim: AgentHookBinShim | null = null;
  private endpointFile: string | null = null;

  constructor(private readonly store: AgentStatusStore) {}

  setPaneKeyFile(path: string): void {
    try {
      writeFileSync(path, this.paneKey, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const saved = readFileSync(path);
      if (saved.length !== 32) throw new Error('Invalid orchestration pane key');
      this.paneKey = saved;
    }
  }

  private paneToken(ptyId: string): string {
    return createHmac('sha256', this.paneKey).update(ptyId).digest('hex');
  }

  private authenticatedPane(req: IncomingMessage): string | null {
    const ptyId = req.headers['x-aha-pty-id'];
    const credential = req.headers['x-aha-pane-token'];
    return typeof ptyId === 'string' && PTY_ID_RE.test(ptyId) &&
      typeof credential === 'string' && tokensEqual(this.paneToken(ptyId), credential)
      ? ptyId : null;
  }

  /**
   * Terminals outlive the app (detached daemon), but port and token change on every start.
   * Restored terminals read this file to find the current server instead of their stale env.
   */
  setEndpointFile(path: string | null): void {
    this.endpointFile = path;
    if (path && this.boundPort !== null) this.writeEndpointFile();
  }

  private writeEndpointFile(): void {
    const path = this.endpointFile;
    if (!path || this.boundPort === null) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(
        tmp,
        JSON.stringify({ port: this.boundPort, token: this.token, pid: process.pid }),
        { encoding: 'utf8', mode: 0o600 },
      );
      renameSync(tmp, path);
    } catch (error) {
      console.warn('[agent-hooks] failed to write endpoint file:', error);
    }
  }

  setOrchestrationHandler(handler: OrchestrationHttpHandler | null): void {
    this.orchestrationHandler = handler;
  }

  setCompanionHandler(handler: CompanionHttpHandler | null): void {
    this.companionHandler = handler;
  }

  setPermissionHookInterceptor(interceptor: PermissionHookInterceptor | null): void {
    this.permissionHookInterceptor = interceptor;
  }

  setUserPromptInterceptor(interceptor: UserPromptInterceptor | null): void {
    this.userPromptInterceptor = interceptor;
  }

  setPostToolInterceptor(interceptor: PostToolInterceptor | null): void {
    this.postToolInterceptor = interceptor;
  }

  setOrchestrationBinShim(shim: AgentHookBinShim | null): void {
    this.orchestrationBinShim = shim;
  }

  get port(): number | null {
    return this.boundPort;
  }

  get authToken(): string {
    return this.token;
  }

  envForPane(ptyId: string): Record<string, string> {
    if (this.boundPort === null) {
      const base: Record<string, string> = {
        AHA_TERMINAL_ID: ptyId,
        AHA_ORCHESTRATION_PANE_TOKEN: this.paneToken(ptyId),
        PI_PROGRAM_STATUS: '1',
        ...(this.endpointFile ? { AHA_AGENT_HOOK_ENDPOINT_FILE: this.endpointFile } : {}),
      };
      return this.orchestrationBinShim ? this.orchestrationBinShim.applyToEnv(base) : base;
    }
    const base: Record<string, string> = {
      AHA_TERMINAL_ID: ptyId,
      AHA_ORCHESTRATION_PANE_TOKEN: this.paneToken(ptyId),
      PI_PROGRAM_STATUS: '1',
      AHA_AGENT_HOOK_PORT: String(this.boundPort),
      AHA_AGENT_HOOK_TOKEN: this.token,
      AHA_AGENT_HOOK_URL: `http://127.0.0.1:${this.boundPort}/hook`,
      AHA_ORCHESTRATION_URL: `http://127.0.0.1:${this.boundPort}/orchestration`,
      ...(this.endpointFile ? { AHA_AGENT_HOOK_ENDPOINT_FILE: this.endpointFile } : {}),
    };
    return this.orchestrationBinShim ? this.orchestrationBinShim.applyToEnv(base) : base;
  }

  async start(): Promise<{ port: number; token: string }> {
    if (this.server && this.boundPort !== null) {
      return { port: this.boundPort, token: this.token };
    }

    const server = createServer((req, res) => {
      void this.handleRequest(req, res);
    });
    server.requestTimeout = REQUEST_TIMEOUT_MS;
    server.headersTimeout = REQUEST_TIMEOUT_MS;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener('listening', onListen);
        reject(err);
      };
      const onListen = () => {
        server.removeListener('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListen);
      server.listen(0, '127.0.0.1');
    });

    const address = server.address() as AddressInfo | null;
    if (!address || typeof address.port !== 'number') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      throw new Error('AgentHookServer failed to acquire loopback port');
    }

    this.server = server;
    this.boundPort = address.port;
    this.writeEndpointFile();
    return { port: address.port, token: this.token };
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    if (this.endpointFile) {
      try {
        rmSync(this.endpointFile, { force: true });
      } catch {
        /* a stale file is rejected by the token check anyway */
      }
    }
    if (!server) return;
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method Not Allowed' }, true);
      req.resume();
      return;
    }

    // Authenticate before reading any request body.
    const candidate = extractBearerOrHookToken(req);
    if (!candidate || !tokensEqual(this.token, candidate)) {
      sendJson(res, 403, { ok: false, error: 'Unauthorized' }, true);
      req.resume();
      return;
    }

    const rawUrl = (req.url ?? '/').split('?')[0] ?? '/';
    const companionMatch = /^\/(terminal|worktree|skills)\/([^/]+)$/.exec(rawUrl);
    if (companionMatch) {
      const namespace = companionMatch[1] as 'terminal' | 'worktree' | 'skills';
      const action = companionMatch[2]!;
      if (!this.companionHandler) {
        sendJson(res, 404, { ok: false, error: 'Companion CLI service unavailable' }, true);
        req.resume();
        return;
      }
      req.setTimeout(0);
      res.setTimeout(0);
      let payload: unknown;
      try {
        payload = await readBoundedJsonBody(req, MAX_ORCHESTRATION_BODY_BYTES);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid request body';
        sendJson(res, msg.includes('large') ? 413 : 400, { ok: false, error: msg }, true);
        return;
      }
      const abortController = new AbortController();
      const onSocketClose = () => {
        if (!res.writableFinished) abortController.abort();
      };
      req.once('aborted', onSocketClose);
      res.once('close', onSocketClose);
      try {
        const result = await this.companionHandler(namespace, action, payload, {
          signal: abortController.signal,
          callerPaneId: this.authenticatedPane(req),
        });
        if (!res.writableEnded) {
          sendJson(res, result.status, result.body, true);
        }
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(
            res,
            500,
            { ok: false, error: err instanceof Error ? err.message : 'Internal error' },
            true
          );
        }
      } finally {
        req.removeListener('aborted', onSocketClose);
        res.removeListener('close', onSocketClose);
      }
      return;
    }

    if (rawUrl.startsWith('/orchestration/')) {
      const action = rawUrl.slice('/orchestration/'.length);
      if (!action || action.includes('/') || !this.orchestrationHandler) {
        sendJson(
          res,
          404,
          { ok: false, error: this.orchestrationHandler ? 'Not Found' : 'Orchestration unavailable' },
          true
        );
        req.resume();
        return;
      }

      req.setTimeout(0);
      res.setTimeout(0);

      let payload: unknown;
      try {
        payload = await readBoundedJsonBody(req, MAX_ORCHESTRATION_BODY_BYTES);
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Invalid request body';
        sendJson(res, msg.includes('large') ? 413 : 400, { ok: false, error: msg }, true);
        return;
      }

      const abortController = new AbortController();
      const onSocketClose = () => {
        if (!res.writableFinished) {
          abortController.abort();
        }
      };
      req.once('aborted', onSocketClose);
      res.once('close', onSocketClose);

      try {
        const result = await this.orchestrationHandler(action, payload, {
          signal: abortController.signal,
          callerPaneId: this.authenticatedPane(req),
        });
        if (!res.writableEnded) {
          sendJson(res, result.status, result.body, true);
        }
      } catch (err) {
        if (!res.writableEnded) {
          sendJson(
            res,
            500,
            { ok: false, error: err instanceof Error ? err.message : 'Internal error' },
            true
          );
        }
      } finally {
        req.removeListener('aborted', onSocketClose);
        res.removeListener('close', onSocketClose);
      }
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid URL' }, true);
      req.resume();
      return;
    }

    let providerHint: string | undefined;
    if (url.pathname === '/hook' || url.pathname === '/hook/') {
      providerHint = undefined;
    } else if (url.pathname.startsWith('/hook/')) {
      const segment = url.pathname.slice('/hook/'.length);
      if (!PROVIDER_SEGMENT_RE.test(segment)) {
        sendJson(res, 404, { ok: false, error: 'Not Found' }, true);
        req.resume();
        return;
      }
      providerHint = segment;
    } else {
      sendJson(res, 404, { ok: false, error: 'Not Found' }, true);
      req.resume();
      return;
    }

    const bodyResult = await readBoundedBody(req);
    if (bodyResult.status !== 200) {
      sendJson(res, bodyResult.status, { ok: false, error: bodyResult.error }, true);
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bodyResult.body);
    } catch {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON payload' });
      return;
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      sendJson(res, 400, { ok: false, error: 'Hook payload must be a JSON object' });
      return;
    }

    const queryPtyId = url.searchParams.get('ptyId') ?? undefined;
    const headerPtyIdRaw = req.headers['x-aha-pty-id'];
    const headerPtyId = Array.isArray(headerPtyIdRaw) ? headerPtyIdRaw[0] : headerPtyIdRaw;
    const fallbackPtyId = queryPtyId ?? headerPtyId;

    const normalized = normalizeAgentHookPayload(
      providerHint,
      parsed as Record<string, unknown>,
      fallbackPtyId,
    );
    if (!normalized) {
      sendJson(res, 400, { ok: false, error: 'Unrecognized hook payload or missing ptyId' });
      return;
    }

    this.store.ingestHookEvent(normalized);

    const rawRecord = parsed as Record<string, unknown>;
    const rawEv = optStr(
      rawRecord.hook_event_name ?? rawRecord.hookEventName ?? rawRecord.event ?? rawRecord.type,
      64,
    );
    const eventName = rawEv ? canonicalHookEventName(rawEv) : '';

    if (
      this.userPromptInterceptor &&
      (eventName === 'UserPromptSubmit' ||
        eventName === 'BeforeAgent' ||
        eventName === 'PreInvocation')
    ) {
      const provider = providerHint ?? normalized.agentId ?? 'unknown';
      const promptText =
        optStr(rawRecord.prompt ?? rawRecord.lastUserInput ?? rawRecord.message, 4_000) ??
        normalized.message;
      try {
        const promptReply = await this.userPromptInterceptor({
          ptyId: normalized.ptyId,
          provider,
          eventName,
          promptText,
        });
        if (!res.writableEnded) {
          sendJson(
            res,
            200,
            promptReply && typeof promptReply.hookStdout === 'string' && promptReply.hookStdout.length > 0
              ? { hookStdout: promptReply.hookStdout }
              : {},
          );
        }
        return;
      } catch (err) {
        console.warn('[agent-hooks] userPromptInterceptor failed:', err);
        if (!res.writableEnded) {
          sendJson(res, 200, {});
        }
        return;
      }
    }

    if (
      this.postToolInterceptor &&
      (eventName === 'PostToolUse' || eventName === 'AfterTool')
    ) {
      const provider = providerHint ?? normalized.agentId ?? 'unknown';
      const { toolName } = extractToolInfo(rawRecord);
      try {
        const postToolReply = await this.postToolInterceptor({
          ptyId: normalized.ptyId,
          provider,
          eventName,
          toolName: toolName ?? normalized.toolName,
        });
        if (!res.writableEnded) {
          sendJson(
            res,
            200,
            postToolReply &&
              typeof postToolReply.hookStdout === 'string' &&
              postToolReply.hookStdout.length > 0
              ? { hookStdout: postToolReply.hookStdout }
              : {},
          );
        }
        return;
      } catch (err) {
        console.warn('[agent-hooks] postToolInterceptor failed:', err);
        if (!res.writableEnded) {
          sendJson(res, 200, {});
        }
        return;
      }
    }

    if (this.permissionHookInterceptor) {
      if (
        eventName === 'PermissionRequest' ||
        eventName === 'BeforeTool' ||
        eventName === 'PreToolUse'
      ) {
        req.setTimeout(0);
        res.setTimeout(0);
        const abortController = new AbortController();
        const onSocketClose = () => {
          if (!res.writableFinished) abortController.abort();
        };
        req.once('aborted', onSocketClose);
        res.once('close', onSocketClose);
        try {
          const { toolName, toolInput } = extractToolInfo(rawRecord, 2_000);
          const intercept = await this.permissionHookInterceptor({
            ptyId: normalized.ptyId,
            providerHint,
            eventName,
            rawPayload: rawRecord,
            toolName: toolName ?? normalized.toolName,
            toolInput: toolInput ?? normalized.toolInput,
            message: normalized.message,
            signal: abortController.signal,
          });
          if (!res.writableEnded) {
            sendJson(
              res,
              200,
              intercept.held && intercept.hookStdout ? { hookStdout: intercept.hookStdout } : {},
              true
            );
          }
          return;
        } finally {
          req.removeListener('aborted', onSocketClose);
          res.removeListener('close', onSocketClose);
        }
      }
    }

    sendJson(res, 200, {});
  }
}

function readBoundedBody(
  req: IncomingMessage,
): Promise<{ status: 200; body: string } | { status: 408 | 413 | 400; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (
      result: { status: 200; body: string } | { status: 408 | 413 | 400; error: string },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      req.removeListener('aborted', onAborted);
      resolve(result);
    };

    const timer = setTimeout(() => {
      req.pause();
      finish({ status: 408, error: 'Request Timeout' });
    }, REQUEST_TIMEOUT_MS);

    const onData = (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_HOOK_BODY_BYTES) {
        req.pause();
        finish({ status: 413, error: 'Payload Too Large' });
        return;
      }
      chunks.push(chunk);
    };

    const onEnd = () => {
      finish({ status: 200, body: Buffer.concat(chunks).toString('utf8') });
    };

    const onError = () => {
      finish({ status: 400, error: 'Request stream failed' });
    };

    const onAborted = () => {
      finish({ status: 400, error: 'Request aborted' });
    };

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
  });
}
