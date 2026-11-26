// Pure wire helpers for Claude Code's native stream-json protocol.
// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// - src/shared/agent-session/options/model-catalog/claude-model-list-probe.ts
// - src/main/claude/structured/launch/claude-structured-model-catalog.ts
// - src/main/claude/structured/dispatch/claude-structured-dispatch-content.ts
// - src/main/claude/structured/journal/claude-structured-prompt-replies.ts
// - src/main/claude/structured/journal/claude-structured-item-translation.ts
// - src/main/claude/structured/permissions/claude-permission-mode-ladder.ts
// - src/shared/agent-launch/startup/parent-agent-session-env.ts
import { readFileSync } from 'node:fs';
import { basename, extname } from 'node:path';
import type {
  AgentQuestion,
  AgentSessionPolicy,
  AgentTurnAttachment,
} from '../../orchestration/agent-session-driver.js';
import type { CodexModelOption } from '../../orchestration/codex-catalog.js';
import type {
  WorkerTimelineEvent,
  WorkerTimelineFileChange,
  WorkerTimelineItemStatus,
  WorkerTimelinePlanStep,
} from '../../orchestration/worker-timeline.js';
import {
  JsonlRpcError,
  type JsonlRecord,
  type JsonlRpcEnvelope,
} from '../jsonl-rpc.js';

export type Obj = Record<string, unknown>;
export const asObject = (value: unknown): Obj =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {};
export const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
export const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
export const asNonEmptyText = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

// Strips ANSI CSI/OSC sequences and control chars from producer-authored permission text.
// eslint-disable-next-line no-control-regex
const ANSI_AND_CONTROL_RE = /\x1B(?:\][^\x07\x1B]*(?:\x07|\x1B\\)|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])|[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/gu;

export function sanitizeControlText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const cleaned = value.replace(ANSI_AND_CONTROL_RE, '').trim();
  return cleaned.length > 0 ? cleaned : undefined;
}

/** Parent Claude session stamp env vars that must not leak into an independent child session. */
export const CLAUDE_PARENT_SESSION_ENV_KEYS = [
  'CLAUDECODE',
  'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_SESSION_ID',
  'CLAUDE_CODE_BRIDGE_SESSION_ID',
  'CLAUDE_CODE_HOST_SESSION_ID',
  'CLAUDE_CODE_SESSION_ATTENDED',
  'CLAUDE_CODE_MESSAGING_SOCKET',
  'CLAUDE_CODE_MESSAGING_TOKEN',
  'CLAUDE_CODE_EXECPATH',
  'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_DESKTOP_APP_VERSION',
  'CLAUDE_EFFORT',
  'CLAUDE_PID',
  'CLAUDE_AGENT_SDK_VERSION',
] as const;

export const CLAUDE_SESSION_ENV: Readonly<Record<string, string>> = {
  CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: '1',
};

/** SDK PreToolUse hook that enforces `read-only` even when user settings auto-allow write tools. */
export const CLAUDE_READ_ONLY_HOOK_ID = 'aha_readonly_guard';
export const CLAUDE_READ_ONLY_HOOK_MATCHER = 'Edit|MultiEdit|Write|NotebookEdit|ExitPlanMode';

/** SDK PreToolUse hook that answers Aha MCP tool calls by orchestration role, whatever the permission mode. */
export const CLAUDE_AHA_MCP_HOOK_ID = 'aha_mcp_gate';
export const CLAUDE_AHA_MCP_HOOK_MATCHER = '^mcp__aha__';

/** A per-process `--mcp-config` with only the Aha server; the person's own config files are never touched. */
export function claudeAhaMcpConfig(server: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }): string {
  return JSON.stringify({ mcpServers: { aha: { type: 'stdio', command: server.command, args: [...server.args], env: { ...server.env } } } });
}

export type ClaudePermissionMode = 'plan' | 'default' | 'acceptEdits' | 'auto' | 'bypassPermissions' | 'dontAsk';

/** Maps AhaStudio's three permission tiers to Claude Code's native `--permission-mode`. */
export function claudePermissionModeForPolicy(policy: AgentSessionPolicy): ClaudePermissionMode {
  switch (policy) {
    case 'read-only':
      return 'plan';
    case 'full-auto':
      return 'bypassPermissions';
    case 'workspace-write':
    default:
      return 'default';
  }
}

/**
 * CLI arguments for Claude Code's bidirectional stream-json stdio transport.
 * Always passes `--allow-dangerously-skip-permissions` (which does not enable bypass by itself)
 * so switching to `full-auto` between turns via `set_permission_mode` needs no relaunch.
 */
export function claudeLaunchArgs(options: {
  policy: AgentSessionPolicy;
  sessionId?: string;
  resumeSessionId?: string;
  model?: string | null;
  effort?: string | null;
  /** Inline `--mcp-config` JSON (see `claudeAhaMcpConfig`). */
  mcpConfig?: string;
  /** Appended to Claude's system prompt for this process, e.g. the Coordinator rules. */
  appendSystemPrompt?: string;
}): string[] {
  const mode = claudePermissionModeForPolicy(options.policy);
  return [
    '-p',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--replay-user-messages',
    '--permission-prompt-tool', 'stdio',
    '--permission-mode', mode,
    '--allow-dangerously-skip-permissions',
    ...(options.resumeSessionId
      ? ['--resume', options.resumeSessionId]
      : options.sessionId ? ['--session-id', options.sessionId] : []),
    ...(options.model ? ['--model', options.model] : []),
    ...(options.effort ? ['--effort', options.effort] : []),
    ...(options.mcpConfig ? ['--mcp-config', options.mcpConfig] : []),
    ...(options.appendSystemPrompt ? ['--append-system-prompt', options.appendSystemPrompt] : []),
  ];
}

/**
 * Claude Code's bidirectional control envelope:
 * - Outgoing: `{ type: 'control_request', request_id, request: { subtype, ...params } }`
 * - Incoming reply: `{ type: 'control_response', response: { subtype: 'success' | 'error', request_id, response | error } }`
 */
export const CLAUDE_CONTROL_ENVELOPE: JsonlRpcEnvelope = {
  nextId: (seq) => `aha-${seq}`,
  request: (id, method, params) => ({
    type: 'control_request',
    request_id: String(id),
    request: { ...(params ?? {}), subtype: method },
  }),
  reply: (record: JsonlRecord) => {
    if (record.type !== 'control_response') return null;
    const response = asObject(record.response);
    const id = typeof response.request_id === 'string' ? response.request_id : undefined;
    if (!id) return null;
    if (response.subtype === 'error') {
      const message = typeof response.error === 'string' && response.error
        ? response.error
        : 'Claude 拒绝了控制请求';
      return { id, error: new JsonlRpcError(message, null, response) };
    }
    if (response.subtype === 'success') {
      return { id, value: response.response ?? {} };
    }
    return null;
  },
};

/** Formats versioned Anthropic model ids like `claude-opus-4-6[1m]` into concise labels (`Opus 4.6 (1M)`). */
export function formatClaudeModelLabel(modelId: string): string {
  const withoutDate = modelId.replace(/-\d{8}(?=$|\[)/u, '');
  const contextMatch = /\[([^\]]+)\]$/u.exec(withoutDate);
  const base = contextMatch ? withoutDate.slice(0, contextMatch.index) : withoutDate;
  if (!/^claude-/iu.test(base)) return modelId;
  const parts = base.replace(/^claude-/iu, '').split('-').filter(Boolean);
  if (parts.length === 0) return modelId;
  const family = parts[0]!.charAt(0).toUpperCase() + parts[0]!.slice(1);
  const versionTokens: string[] = [];
  const restTokens: string[] = [];
  for (const part of parts.slice(1)) {
    if (/^\d+$/u.test(part) && restTokens.length === 0) versionTokens.push(part);
    else restTokens.push(part);
  }
  const version = versionTokens.length > 0 ? versionTokens.join('.') : '';
  const suffix = restTokens.length > 0 ? ` ${restTokens.join(' ')}` : '';
  const context = contextMatch ? ` (${contextMatch[1]!.toUpperCase()})` : '';
  return `${family}${version ? ` ${version}` : ''}${suffix}${context}`.trim();
}

/** Parses Claude Code's `initialize.models` / `list_models` array into AhaStudio model options. */
export function parseClaudeModels(
  rawModels: unknown,
  currentEffort: string | null = null,
): CodexModelOption[] {
  const rows = asArray(rawModels)
    .map(asObject)
    .filter((row) => asNonEmptyText(row.value) !== undefined && row.disabled !== true);
  if (rows.length === 0) return [];
  const defaultRow = rows.find((row) => asNonEmptyText(row.value) === 'default');
  const defaultResolved = asNonEmptyText(defaultRow?.resolvedModel);
  // Look up non-default rows by resolved id so their picker display names win over "Default (recommended)"
  // without pushing the default model to the bottom of the list.
  const namedById = new Map<string, Obj>();
  for (const row of rows) {
    const value = asNonEmptyText(row.value)!;
    if (value === 'default') continue;
    const id = asNonEmptyText(row.resolvedModel) ?? value;
    if (!namedById.has(id)) namedById.set(id, row);
  }
  const seen = new Set<string>();
  const models: CodexModelOption[] = [];
  for (const row of rows) {
    const value = asNonEmptyText(row.value)!;
    const resolved = asNonEmptyText(row.resolvedModel);
    const id = resolved ?? value;
    if (id === 'default' && rows.length > 1) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const named = value === 'default' ? namedById.get(id) : undefined;
    const isDefault = defaultResolved ? id === defaultResolved : value === 'default';
    const rawDisplay = asNonEmptyText(named?.displayName) ?? asNonEmptyText(row.displayName);
    const displayName = value === 'default' && !named
      ? (resolved ? formatClaudeModelLabel(resolved) : (rawDisplay ?? id))
      : (rawDisplay ?? formatClaudeModelLabel(id));
    const description = asNonEmptyText(named?.description) ?? asNonEmptyText(row.description) ?? '';
    const efforts = row.supportsEffort === true && Array.isArray(row.supportedEffortLevels)
      ? row.supportedEffortLevels
        .map(asNonEmptyText)
        .filter((level): level is string => Boolean(level))
        .map((level) => ({ value: level, description: '' }))
      : [];
    const defaultEffort = efforts.length === 0
      ? null
      : currentEffort && efforts.some((entry) => entry.value === currentEffort)
        ? currentEffort
        : efforts.some((entry) => entry.value === 'medium')
          ? 'medium'
          : efforts[0]!.value;
    models.push({
      id,
      model: id,
      displayName,
      description,
      isDefault,
      efforts,
      defaultEffort,
      images: true,
    });
  }
  if (models.length > 0 && !models.some((entry) => entry.isDefault)) {
    models[0] = { ...models[0]!, isDefault: true };
  }
  return models;
}

/** Reads the active model and effort from Claude Code's `get_settings` reply. */
export function readClaudeSettings(settings: unknown): {
  model: string | null | undefined;
  effort: string | null | undefined;
} {
  const root = asObject(settings);
  const applied = asObject(root.applied);
  const effective = asObject(root.effective);
  const hasApplied = Object.keys(applied).length > 0;
  const model = asNonEmptyText(applied.model) ?? asNonEmptyText(effective.model);
  const effort = hasApplied && Object.prototype.hasOwnProperty.call(applied, 'effort')
    ? (applied.effort === null ? null : asNonEmptyText(applied.effort))
    : asNonEmptyText(effective.effortLevel);
  return { model, effort };
}

const BYPASS_REFUSAL_RE = /bypassPermissions.*(?:disabled by settings|not supported in restricted mode)|not launched with --(?:allow-)?dangerously-skip/iu;
const AUTO_REFUSAL_RE = /Cannot set permission mode to auto|auto mode disabled by settings/iu;

export function isClaudeBypassRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const data = error instanceof JsonlRpcError ? asObject(error.data) : {};
  const code = asText(data.errorCode) ?? asText(data.error_code);
  return code === 'bypass_disabled' || code === 'bypass_restricted' || code === 'bypass_not_launched' ||
    BYPASS_REFUSAL_RE.test(error.message);
}

export function isClaudeAutoRefusal(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const data = error instanceof JsonlRpcError ? asObject(error.data) : {};
  const code = asText(data.errorCode) ?? asText(data.error_code);
  return (typeof code === 'string' && code.startsWith('auto_mode')) || AUTO_REFUSAL_RE.test(error.message);
}

/**
 * Builds Claude Messages API content blocks for a user turn.
 * Places inline base64 images first and the single joined text block last because Claude Code
 * reads only the trailing text block for prompt and slash-command expansion.
 */
export function buildClaudeUserContent(
  prompt: string,
  attachments: readonly AgentTurnAttachment[],
  readImage: (path: string) => Buffer = (path) => readFileSync(path),
): Obj[] {
  const images: Obj[] = [];
  const notes: string[] = [];
  for (const item of attachments) {
    if (item.type === 'skill') continue;
    const name = (item.name || basename(item.path)).replace(/"/gu, "'");
    const mime = item.type === 'localImage' ? IMAGE_MIME[extname(item.path).toLowerCase()] : undefined;
    if (item.type === 'localImage' && mime) {
      const bytes = readImage(item.path);
      if (bytes.length === 0) throw new Error('图片是空的或无法读取');
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片不能超过 10MB');
      images.push({
        type: 'image',
        source: { type: 'base64', media_type: mime, data: bytes.toString('base64') },
      });
    }
    notes.push(`[Attached ${item.type === 'localImage' ? 'image' : 'file'} "${name}" is saved at: ${item.path}]`);
  }
  const body = [prompt, ...notes].filter(Boolean).join('\n\n');
  const content: Obj[] = [...images, ...(body ? [{ type: 'text', text: body }] : [])];
  if (content.length === 0) throw new Error('消息是空的');
  return content;
}

export interface ParsedClaudeAskUserQuestion {
  questions: AgentQuestion[];
  reply: (answers: Record<string, string[]> | null, toolUseId: string) => Obj;
}

/**
 * Parses Claude Code's `AskUserQuestion` tool input into AhaStudio `AgentQuestion[]` and builds
 * the `can_use_tool` response carrying `updatedInput.answers: Record<string, string>`.
 */
export function parseClaudeAskUserQuestion(input: Obj): ParsedClaudeAskUserQuestion | null {
  const rawQuestions = asArray(input.questions)
    .map(asObject)
    .filter((entry) => Boolean(asNonEmptyText(entry.question) || asNonEmptyText(entry.header)));
  if (rawQuestions.length === 0) return null;

  const entries = rawQuestions.map((raw, index) => {
    const id = `q${index + 1}`;
    const prompt = asNonEmptyText(raw.question) ?? asNonEmptyText(raw.header) ?? `问题 ${index + 1}`;
    const header = asNonEmptyText(raw.header) ?? '';
    const answerKey = asNonEmptyText(raw.question) ?? asNonEmptyText(raw.header) ?? `question-${index + 1}`;
    const multiSelect = raw.multiSelect === true;
    const options = asArray(raw.options)
      .map(asObject)
      .flatMap((option) => {
        const label = asNonEmptyText(option.label);
        return label ? [{ label, description: asNonEmptyText(option.description) ?? '' }] : [];
      });
    const question: AgentQuestion = {
      id,
      header,
      prompt,
      allowOther: true,
      ...(multiSelect ? { multiSelect: true } : {}),
      options,
    };
    return { id, answerKey, multiSelect, question };
  });

  return {
    questions: entries.map((entry) => entry.question),
    reply: (answers, toolUseId) => {
      if (!answers) {
        return {
          behavior: 'deny',
          message: 'The user dismissed these questions without answering. End your turn and wait for them.',
          ...(toolUseId ? { toolUseID: toolUseId } : {}),
        };
      }
      const mapped: Record<string, string> = {};
      for (const entry of entries) {
        const chosen = (answers[entry.id] ?? []).map((value) => value.trim()).filter(Boolean);
        if (chosen.length === 0) continue;
        mapped[entry.answerKey] = entry.multiSelect ? chosen.join(', ') : chosen[0]!;
      }
      if (Object.keys(mapped).length === 0) {
        return {
          behavior: 'deny',
          message: 'The user dismissed these questions without answering. End your turn and wait for them.',
          ...(toolUseId ? { toolUseID: toolUseId } : {}),
        };
      }
      return {
        behavior: 'allow',
        updatedInput: { ...input, answers: mapped },
        ...(toolUseId ? { toolUseID: toolUseId } : {}),
      };
    },
  };
}

/** Tools whose card is the person's answer, never auto-approved even under `full-auto`. */
export const CLAUDE_USER_ANSWERED_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode']);

export function claudeRequestRequiresPerson(toolName: string, request: Obj): boolean {
  return CLAUDE_USER_ANSWERED_TOOLS.has(toolName) || request.requires_user_interaction === true;
}

export function formatClaudeApprovalInput(toolName: string, input: Obj, request: Obj): string {
  const lower = toolName.toLowerCase();
  if ((lower === 'bash' || lower === 'powershell') && typeof input.command === 'string' && input.command.trim()) {
    return input.command;
  }
  if (toolName === 'ExitPlanMode' && typeof input.plan === 'string' && input.plan.trim()) {
    return input.plan;
  }
  const filePath = asNonEmptyText(input.file_path) ?? asNonEmptyText(input.notebook_path) ?? asNonEmptyText(input.path);
  if (filePath && (lower === 'edit' || lower === 'write' || lower === 'multiedit' || lower === 'notebookedit' || lower === 'read')) {
    return filePath;
  }
  const title = sanitizeControlText(request.title);
  if (Object.keys(input).length === 0) return title ?? toolName;
  try {
    return JSON.stringify(input, null, 2);
  } catch {
    return title ?? toolName;
  }
}

export function formatClaudeApprovalMessage(request: Obj): string | undefined {
  const parts = [
    sanitizeControlText(request.decision_reason),
    sanitizeControlText(request.description),
    sanitizeControlText(request.blocked_path) ? `受限路径：${sanitizeControlText(request.blocked_path)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const unique = [...new Set(parts)];
  return unique.length > 0 ? unique.join('\n') : undefined;
}

// --- Diff & Tool Translation ---

function splitDiffLines(value: string): string[] {
  if (!value) return [];
  const normalized = value.replace(/\r\n/gu, '\n');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

export function buildUnifiedDiff(path: string, oldText: string | null, newText: string): string {
  const before = oldText === null ? [] : splitDiffLines(oldText);
  const after = splitDiffLines(newText);
  return [
    `--- ${oldText === null ? '/dev/null' : `a/${path}`}`,
    `+++ b/${path}`,
    `@@ -1,${before.length} +1,${after.length} @@`,
    ...before.map((line) => `-${line}`),
    ...after.map((line) => `+${line}`),
  ].join('\n');
}

export function formatStructuredPatchDiff(path: string, structuredPatch: unknown): string | null {
  const hunks = asArray(structuredPatch).map(asObject).filter((hunk) => Array.isArray(hunk.lines));
  if (hunks.length === 0) return null;
  const out = [`--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) {
    const oldStart = typeof hunk.oldStart === 'number' ? hunk.oldStart : 1;
    const oldLines = typeof hunk.oldLines === 'number' ? hunk.oldLines : 0;
    const newStart = typeof hunk.newStart === 'number' ? hunk.newStart : 1;
    const newLines = typeof hunk.newLines === 'number' ? hunk.newLines : 0;
    out.push(`@@ -${oldStart},${oldLines} +${newStart},${newLines} @@`);
    for (const line of asArray(hunk.lines)) {
      if (typeof line === 'string') out.push(line);
    }
  }
  return out.join('\n');
}

function buildMultiEditDiff(path: string, edits: unknown): string {
  const items = asArray(edits).map(asObject);
  const hunks: string[] = [`--- a/${path}`, `+++ b/${path}`];
  for (const edit of items) {
    const oldText = asText(edit.old_string) ?? '';
    const newText = asText(edit.new_string) ?? '';
    const before = splitDiffLines(oldText);
    const after = splitDiffLines(newText);
    hunks.push(`@@ -1,${before.length} +1,${after.length} @@`);
    hunks.push(...before.map((line) => `-${line}`));
    hunks.push(...after.map((line) => `+${line}`));
  }
  return hunks.join('\n');
}

function parseMcpToolName(name: string): { server: string; tool: string } | null {
  if (!name.startsWith('mcp__')) return null;
  const rest = name.slice('mcp__'.length);
  const sep = rest.indexOf('__');
  if (sep <= 0) return null;
  return { server: rest.slice(0, sep), tool: rest.slice(sep + 2) || rest };
}

export interface TrackedClaudeTool {
  id: string;
  name: string;
  input: Obj;
  itemKind: 'command' | 'file_change' | 'plan' | 'tool_call' | 'question';
  files?: WorkerTimelineFileChange[];
}

function parseTodoSteps(input: Obj): WorkerTimelinePlanStep[] {
  return asArray(input.todos).map(asObject).flatMap((entry) => {
    const step = asNonEmptyText(entry.content) ?? asNonEmptyText(entry.activeForm);
    if (!step) return [];
    const status = entry.status === 'completed'
      ? 'completed' as const
      : entry.status === 'in_progress'
        ? 'in_progress' as const
        : 'pending' as const;
    return [{ step, status }];
  });
}

function buildInitialFileChange(name: string, input: Obj): WorkerTimelineFileChange[] {
  const lower = name.toLowerCase();
  const path = asNonEmptyText(input.file_path) ?? asNonEmptyText(input.notebook_path) ?? asNonEmptyText(input.path);
  if (!path) return [];
  if (lower === 'edit') {
    const oldText = asText(input.old_string) ?? '';
    const newText = asText(input.new_string) ?? '';
    return [{
      path,
      change: 'update',
      movePath: null,
      diff: buildUnifiedDiff(path, oldText, newText),
      added: 0,
      removed: 0,
      truncated: false,
    }];
  }
  if (lower === 'multiedit') {
    return [{
      path,
      change: 'update',
      movePath: null,
      diff: buildMultiEditDiff(path, input.edits),
      added: 0,
      removed: 0,
      truncated: false,
    }];
  }
  if (lower === 'write') {
    const content = asText(input.content) ?? '';
    return [{
      path,
      change: 'add',
      movePath: null,
      diff: buildUnifiedDiff(path, null, content),
      added: 0,
      removed: 0,
      truncated: false,
    }];
  }
  if (lower === 'notebookedit') {
    const change = input.edit_mode === 'delete' ? 'delete' as const : 'update' as const;
    const source = asText(input.new_source) ?? '';
    return [{
      path,
      change,
      movePath: null,
      diff: change === 'delete' ? '' : buildUnifiedDiff(path, null, source),
      added: 0,
      removed: 0,
      truncated: false,
    }];
  }
  return [];
}

const FILE_EDIT_TOOLS = new Set(['edit', 'multiedit', 'write', 'notebookedit']);
const WEB_SEARCH_TOOLS = new Set(['websearch', 'webfetch', 'web_search', 'web_fetch']);

export function isClaudeFileEditTool(name: string): boolean {
  return FILE_EDIT_TOOLS.has(name.toLowerCase());
}

/** True for client `tool_result` blocks and server-side tool result blocks (`web_search_tool_result`, etc.). */
export function isClaudeToolResultBlock(block: Obj): boolean {
  if (block.type === 'tool_result') return true;
  if (block.type === 'tool_use' || block.type === 'server_tool_use') return false;
  return asNonEmptyText(block.tool_use_id) !== undefined;
}

/** True when a tool result reports an error, including server-tool `*_error` payloads. */
export function isClaudeToolResultError(block: Obj): boolean {
  if (block.is_error === true) return true;
  const content = asObject(block.content);
  return typeof content.type === 'string' && content.type.endsWith('_error');
}

/** True for Claude Code's `<synthetic>` `"No response requested."` resume-repair assistant frames. */
export function isClaudeSyntheticNoResponse(record: Obj): boolean {
  if (record.type !== 'assistant') return false;
  if (
    record.error !== undefined ||
    record.api_error !== undefined ||
    record.is_api_error_message === true ||
    record.isApiErrorMessage === true ||
    record.apiErrorStatus !== undefined
  ) {
    return false;
  }
  const message = asObject(record.message);
  if (message.role !== 'assistant' || message.model !== '<synthetic>') return false;
  if (message.stop_reason !== 'stop_sequence' || message.stop_sequence !== '') return false;
  const usage = asObject(message.usage);
  const zeroUsage = ['input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens', 'output_tokens']
    .every((key) => usage[key] === 0);
  if (!zeroUsage) return false;
  const content = asArray(message.content).map(asObject);
  if (content.length === 0 || content.some((part) => part.type !== 'text')) return false;
  const text = content
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('\n')
    .trim();
  return text === 'No response requested.';
}

/** Classifies a Claude tool_use and produces the initial timeline event (or null for AskUserQuestion). */
export function translateClaudeToolStart(
  turnId: string,
  toolUseId: string,
  name: string,
  rawInput: unknown,
): { tracked: TrackedClaudeTool; event: WorkerTimelineEvent | null } {
  const input = asObject(rawInput);
  const lower = name.toLowerCase();
  const timelineId = `tool:${toolUseId}`;

  if (name === 'AskUserQuestion') {
    return { tracked: { id: toolUseId, name, input, itemKind: 'question' }, event: null };
  }

  if (lower === 'bash' || lower === 'powershell') {
    const command = asNonEmptyText(input.command) ?? name;
    const cwd = asNonEmptyText(input.cwd) ?? null;
    return {
      tracked: { id: toolUseId, name, input, itemKind: 'command' },
      event: {
        type: 'item',
        item: { id: timelineId, kind: 'command', status: 'running', command, cwd },
      },
    };
  }

  if (lower === 'todowrite') {
    const steps = parseTodoSteps(input);
    const done = steps.length > 0 && steps.every((step) => step.status === 'completed');
    return {
      tracked: { id: toolUseId, name, input, itemKind: 'plan' },
      event: {
        type: 'item',
        item: {
          id: `plan:${turnId}`,
          kind: 'plan',
          explanation: null,
          steps,
          status: done ? 'completed' : 'running',
        },
      },
    };
  }

  if (FILE_EDIT_TOOLS.has(lower)) {
    const files = buildInitialFileChange(name, input);
    if (files.length > 0) {
      return {
        tracked: { id: toolUseId, name, input, itemKind: 'file_change', files },
        event: {
          type: 'item',
          item: { id: timelineId, kind: 'file_change', status: 'running', files },
        },
      };
    }
  }

  const mcp = parseMcpToolName(name);
  const toolType = mcp ? 'mcp' as const : WEB_SEARCH_TOOLS.has(lower) ? 'search' as const : 'tool' as const;
  const args = Object.keys(input).length > 0 ? JSON.stringify(input) : '';
  return {
    tracked: { id: toolUseId, name, input, itemKind: 'tool_call' },
    event: {
      type: 'item',
      item: {
        id: timelineId,
        kind: 'tool_call',
        toolType,
        server: mcp ? mcp.server : null,
        tool: mcp ? mcp.tool : name,
        args,
        status: 'running',
      },
    },
  };
}

export function extractClaudeToolResultText(content: unknown, toolUseResult?: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const texts = content.flatMap((entry) => {
      if (typeof entry === 'string') return [entry];
      const block = asObject(entry);
      if (typeof block.text === 'string') return [block.text];
      if (typeof block.content === 'string') return [block.content];
      if (typeof block.title === 'string' && typeof block.url === 'string') return [`${block.title} (${block.url})`];
      return [];
    });
    if (texts.length > 0) return texts.join('\n');
  }
  const extra = asObject(toolUseResult);
  if (typeof extra.stdout === 'string' || typeof extra.stderr === 'string') {
    return [extra.stdout, extra.stderr].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n');
  }
  if (content === undefined || content === null) return '';
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Updates a previously tracked Claude tool item when its `tool_result` arrives. */
export function translateClaudeToolResult(
  turnId: string,
  tracked: TrackedClaudeTool,
  resultContent: unknown,
  isError: boolean,
  toolUseResult: unknown,
  declined: boolean,
  completedAt: number,
): WorkerTimelineEvent | null {
  const output = extractClaudeToolResultText(resultContent, toolUseResult);
  const status: WorkerTimelineItemStatus = declined ? 'declined' : isError ? 'failed' : 'completed';
  const timelineId = `tool:${tracked.id}`;

  if (tracked.itemKind === 'question') {
    if (!isError || declined) return null;
    return {
      type: 'notice',
      id: `question-err:${tracked.id}`,
      level: 'warning',
      text: output || '提问未能完成',
    };
  }

  if (tracked.itemKind === 'plan') {
    const steps = parseTodoSteps(tracked.input);
    const done = steps.length > 0 && steps.every((step) => step.status === 'completed');
    return {
      type: 'item',
      item: {
        id: `plan:${turnId}`,
        kind: 'plan',
        explanation: null,
        steps,
        status: isError ? 'failed' : done ? 'completed' : 'running',
        ...(done || isError ? { completedAt } : {}),
      },
    };
  }

  if (tracked.itemKind === 'command') {
    const extra = asObject(toolUseResult);
    const structuredOutput = typeof extra.stdout === 'string' || typeof extra.stderr === 'string'
      ? [extra.stdout, extra.stderr].filter((part): part is string => typeof part === 'string' && part.length > 0).join('\n')
      : '';
    const finalOutput = structuredOutput || (output === '(Bash completed with no output)' ? '' : output);
    return {
      type: 'item',
      item: {
        id: timelineId,
        kind: 'command',
        status,
        completedAt,
        output: finalOutput,
        ...(typeof extra.exitCode === 'number'
          ? { exitCode: extra.exitCode }
          : declined
            ? {}
            : isError
              ? { exitCode: 1 }
              : { exitCode: 0 }),
      },
    };
  }

  if (tracked.itemKind === 'file_change') {
    const extra = asObject(toolUseResult);
    const existing = tracked.files?.[0];
    const path = asNonEmptyText(extra.filePath) ?? existing?.path ?? asNonEmptyText(tracked.input.file_path);
    let files = tracked.files ?? [];
    if (path && !declined && !isError) {
      const patched = formatStructuredPatchDiff(path, extra.structuredPatch);
      const change: WorkerTimelineFileChange['change'] = extra.type === 'create'
        ? 'add'
        : extra.type === 'update' || patched
          ? 'update'
          : existing?.change ?? 'update';
      files = [{
        path,
        change,
        movePath: null,
        diff: patched ?? existing?.diff ?? '',
        added: 0,
        removed: 0,
        truncated: false,
      }];
    }
    return {
      type: 'item',
      item: { id: timelineId, kind: 'file_change', status, completedAt, ...(files.length > 0 ? { files } : {}) },
    };
  }

  const mcp = parseMcpToolName(tracked.name);
  return {
    type: 'item',
    item: {
      id: timelineId,
      kind: 'tool_call',
      toolType: mcp ? 'mcp' : WEB_SEARCH_TOOLS.has(tracked.name.toLowerCase()) ? 'search' : 'tool',
      server: mcp ? mcp.server : null,
      tool: mcp ? mcp.tool : tracked.name,
      status,
      completedAt,
      output,
      ...(status === 'failed' ? { error: output || '工具调用失败' } : {}),
    },
  };
}

/** Normalizes Claude snake_case usage into AhaStudio's camelCase token fields. */
export function normalizeClaudeUsage(rawUsage: unknown): Record<string, number> | null {
  const usage = asObject(rawUsage);
  const input = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
  const cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
  const cacheCreate = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
  const output = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
  const totalInput = input + cacheRead + cacheCreate;
  const total = totalInput + output;
  if (total === 0) return null;
  return {
    inputTokens: totalInput,
    outputTokens: output,
    totalTokens: total,
    ...(cacheRead > 0 ? { cacheReadInputTokens: cacheRead } : {}),
    ...(cacheCreate > 0 ? { cacheCreationInputTokens: cacheCreate } : {}),
  };
}

export function formatClaudeCompactNotice(metadata: unknown): string {
  const info = asObject(metadata);
  const pre = typeof info.pre_tokens === 'number' ? info.pre_tokens : null;
  const post = typeof info.post_tokens === 'number' ? info.post_tokens : null;
  if (pre !== null && post !== null) {
    return `上下文已压缩（${pre.toLocaleString('en-US')} → ${post.toLocaleString('en-US')} tokens）`;
  }
  return '上下文已压缩';
}

export function describeClaudeResultError(frame: Obj, fallbackError: string | null = null): string {
  const errors = asArray(frame.errors).map(asNonEmptyText).filter((entry): entry is string => Boolean(entry));
  if (errors.length > 0) return errors.join('\n');
  const resultText = asNonEmptyText(frame.result);
  if (resultText) return resultText;
  if (fallbackError) return fallbackError;
  const subtype = asNonEmptyText(frame.subtype);
  if (subtype === 'error_max_turns') return '已达到最大轮次上限';
  if (subtype === 'error_max_budget_usd') return '已达到预算上限';
  if (subtype === 'error_max_structured_output_retries') return '结构化输出重试次数已达上限';
  return subtype ? `本轮执行失败（${subtype}）` : '本轮执行失败';
}
