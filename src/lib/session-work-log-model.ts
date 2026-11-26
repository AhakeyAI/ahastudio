// Adapted from Orca (https://github.com/stablyai/orca),
// native-chat-tool-icon.ts, native-chat-tool-run-sentence.ts, native-chat-tool-line-label.ts,
// native-chat-tool-run-outcome.ts, native-chat-tool-summary.ts, and code-fence-language-label.ts.
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import type { WorkerTimelineItem } from '../types';
import { unwrapShellCommand } from './worker-timeline-model';

export type WorkCategory =
  | 'reasoning'
  | 'read'
  | 'search'
  | 'listFiles'
  | 'command'
  | 'fileChange'
  | 'webSearch'
  | 'mcpToolCall'
  | 'subAgentActivity'
  | 'todoList'
  | 'other';

export type WorkIconName =
  | 'brain'
  | 'eye'
  | 'search'
  | 'folder'
  | 'square-terminal'
  | 'pencil'
  | 'globe'
  | 'plug'
  | 'bot'
  | 'list-checks'
  | 'wrench';

export const WORK_ICON_BY_CATEGORY: Record<WorkCategory, WorkIconName> = {
  reasoning: 'brain',
  read: 'eye',
  search: 'search',
  listFiles: 'folder',
  command: 'square-terminal',
  fileChange: 'pencil',
  webSearch: 'globe',
  mcpToolCall: 'plug',
  subAgentActivity: 'bot',
  todoList: 'list-checks',
  other: 'wrench',
};

const READ_TOOLS = new Set(['read', 'read_file', 'view_file', 'cat', 'open_file']);
const SEARCH_TOOLS = new Set([
  'search',
  'grep',
  'glob',
  'grep_search',
  'find_by_name',
  'ripgrep',
  'find_files',
]);
const LIST_TOOLS = new Set(['list', 'ls', 'list_dir', 'list_files', 'list_directory']);
const EDIT_TOOLS = new Set([
  'edit',
  'write',
  'edit_file',
  'write_file',
  'create_file',
  'delete_file',
  'apply_patch',
  'str_replace',
  'str_replace_editor',
  'patch',
  'diff',
  'multi_edit',
  'notebook_edit',
]);
const WEB_TOOLS = new Set(['web_search', 'websearch', 'web search', 'webfetch', 'web_fetch', 'fetch_url']);
const AGENT_TOOLS = new Set(['task', 'agent', 'subagent', 'spawn_agent', 'delegate_task']);
const PLAN_TOOLS = new Set(['todowrite', 'todo_write', 'update_plan']);
const COMMAND_TOOLS = new Set(['exec', 'bash', 'shell', 'local_shell', 'run_command', 'terminal']);

const SHELL_CHAIN_RE = /[|;&><`\n]/;
const SIMPLE_READ_CMD_RE = /^(?:cat|head|tail|nl|bat|get-content|gc|type|sed)\b/i;
const SIMPLE_SEARCH_CMD_RE = /^(?:rg|grep|egrep|fgrep|ack|ag|findstr|select-string|sls|git\s+grep)\b/i;
const SIMPLE_LIST_CMD_RE = /^(?:ls|dir|tree|get-childitem|gci|find)\b/i;

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim())?.trim() ?? '';
}

function collapsePreview(text: string, max = 96): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length <= max ? one : `${one.slice(0, max - 1)}…`;
}

/** Try to parse a JSON object from tool arguments; returns null for plain strings. */
export function parseToolArgsObject(args: string): Record<string, unknown> | null {
  const trimmed = args.trim();
  if (!trimmed.startsWith('{')) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function classifyShellCommand(command: string): WorkCategory {
  const unwrapped = unwrapShellCommand(command);
  if (!unwrapped || SHELL_CHAIN_RE.test(unwrapped)) return 'command';
  if (SIMPLE_SEARCH_CMD_RE.test(unwrapped)) return 'search';
  if (SIMPLE_LIST_CMD_RE.test(unwrapped)) return 'listFiles';
  if (SIMPLE_READ_CMD_RE.test(unwrapped) && extractReadCommandFilePath(unwrapped) !== null) {
    return 'read';
  }
  return 'command';
}

function stripQuotes(token: string): string {
  if (token.length >= 2 && ((token[0] === '"' && token.at(-1) === '"') || (token[0] === "'" && token.at(-1) === "'"))) {
    return token.slice(1, -1);
  }
  return token;
}

function tokenizeSimpleShell(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"\\]|\\.)*"|'[^']*'|[^\s]+/g;
  for (const match of command.matchAll(pattern)) {
    tokens.push(match[0]);
  }
  return tokens;
}

function readFlagTakesValue(cmd: string, flag: string): boolean {
  switch (cmd) {
    case 'head':
    case 'tail':
      return /^-(?:n|c|-?lines|-?bytes)$/i.test(flag);
    case 'get-content':
    case 'gc':
      return /^-(?:totalcount|head|tail|first|last|encoding|readcount|delimiter)$/i.test(flag);
    case 'bat':
      return /^-(?:r|-?line-range|l|-?language|-?theme)$/i.test(flag);
    case 'nl':
      return /^-(?:b|w|s|v|i)$/i.test(flag);
    default:
      // `cat -n` / `cat -b` and `type` take no separate value arguments.
      return false;
  }
}

function looksLikeSingleFileTarget(target: string): boolean {
  if (!target || target === '-' || target.startsWith('$') || /[*?]/.test(target)) return false;
  return /[\\/]/.test(target) || /\.[a-z0-9]{1,10}$/i.test(target);
}

/** Extract a single file path from simple read commands like `cat -n src/a.ts`, `sed -n '1,80p' src/a.ts`, or `Get-Content src/a.ts`. */
export function extractReadCommandFilePath(unwrappedCommand: string): string | null {
  if (!unwrappedCommand || SHELL_CHAIN_RE.test(unwrappedCommand)) return null;
  if (!SIMPLE_READ_CMD_RE.test(unwrappedCommand)) return null;
  const tokens = tokenizeSimpleShell(unwrappedCommand);
  if (tokens.length < 2) return null;
  const cmd = stripQuotes(tokens[0]!).toLowerCase();

  // Strictly match read-only `sed -n '<range>p' <file>` without in-place or multi-script flags.
  if (cmd === 'sed') {
    let hasQuiet = false;
    const positional: string[] = [];
    for (let i = 1; i < tokens.length; i += 1) {
      const raw = tokens[i]!;
      if (raw === '-n' || raw === '--quiet' || raw === '--silent') {
        hasQuiet = true;
        continue;
      }
      if (raw.startsWith('-')) return null;
      positional.push(stripQuotes(raw));
    }
    if (!hasQuiet || positional.length !== 2) return null;
    if (!/^\d+(?:,(?:\d+|\$))?p$/.test(positional[0]!)) return null;
    const target = positional[1]!;
    return looksLikeSingleFileTarget(target) ? target : null;
  }

  const positional: string[] = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const raw = tokens[i]!;
    if (raw === '--') {
      for (let j = i + 1; j < tokens.length; j += 1) {
        positional.push(stripQuotes(tokens[j]!));
      }
      break;
    }
    if (raw.startsWith('-')) {
      if (readFlagTakesValue(cmd, raw)) {
        i += 1;
      }
      continue;
    }
    positional.push(stripQuotes(raw));
  }
  if (positional.length !== 1) return null;
  const target = positional[0]!;
  return looksLikeSingleFileTarget(target) ? target : null;
}

export function classifyWorkItem(item: WorkerTimelineItem): WorkCategory | null {
  switch (item.kind) {
    case 'reasoning':
      return 'reasoning';
    case 'command':
      return classifyShellCommand(item.command);
    case 'file_change':
      return 'fileChange';
    case 'plan':
      return 'todoList';
    case 'tool_call': {
      const normalized = item.tool.trim().toLowerCase();
      if (item.toolType === 'search' || WEB_TOOLS.has(normalized)) return 'webSearch';
      if (item.toolType === 'mcp' || Boolean(item.server) || normalized.startsWith('mcp__')) {
        return 'mcpToolCall';
      }
      if (READ_TOOLS.has(normalized)) return 'read';
      if (SEARCH_TOOLS.has(normalized)) return 'search';
      if (LIST_TOOLS.has(normalized)) return 'listFiles';
      if (EDIT_TOOLS.has(normalized)) return 'fileChange';
      if (AGENT_TOOLS.has(normalized)) return 'subAgentActivity';
      if (PLAN_TOOLS.has(normalized)) return 'todoList';
      if (COMMAND_TOOLS.has(normalized)) return 'command';
      return 'other';
    }
    default:
      return null;
  }
}

export function pathBasename(filePath: string): string {
  const parts = filePath.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) ?? filePath;
}

export function summarizeDisplayPath(filePath: string, max = 56): string {
  const clean = filePath.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const tail = clean.slice(clean.length - (max - 1));
  const boundary = tail.search(/[\\/]/);
  return `…${boundary > 0 ? tail.slice(boundary) : tail}`;
}

/** Extract an openable file path from a work item, or null when the item does not target a single file. */
export function extractWorkItemFileTarget(
  item: WorkerTimelineItem,
): { path: string; label: string; openable: boolean } | null {
  if (item.kind === 'file_change') {
    if (item.files.length !== 1) return null;
    const file = item.files[0]!;
    const targetPath = file.movePath ?? file.path;
    if (!targetPath) return null;
    return {
      path: targetPath,
      label: summarizeDisplayPath(targetPath),
      openable: file.change !== 'delete',
    };
  }
  if (item.kind === 'command') {
    const unwrapped = unwrapShellCommand(item.command);
    const targetPath = extractReadCommandFilePath(unwrapped);
    return targetPath ? { path: targetPath, label: summarizeDisplayPath(targetPath), openable: true } : null;
  }
  if (item.kind === 'tool_call') {
    const category = classifyWorkItem(item);
    if (category !== 'read' && category !== 'fileChange') return null;
    const obj = parseToolArgsObject(item.args);
    if (!obj) return null;
    const candidate =
      obj.file_path ??
      obj.filePath ??
      obj.target_file ??
      obj.TargetFile ??
      obj.AbsolutePath ??
      obj.notebook_path ??
      obj.path;
    if (typeof candidate !== 'string' || !candidate.trim()) return null;
    const clean = candidate.trim();
    return { path: clean, label: summarizeDisplayPath(clean), openable: true };
  }
  return null;
}

const SETTLED_CLAUSES: Record<WorkCategory, (count: number) => string> = {
  reasoning: (n) => (n === 1 ? '思考了 1 次' : `思考了 ${n} 次`),
  read: (n) => `读取了 ${n} 个文件`,
  search: (n) => `搜索了 ${n} 次`,
  listFiles: (n) => `查看了 ${n} 个目录`,
  command: (n) => `运行了 ${n} 条命令`,
  fileChange: (n) => `编辑了 ${n} 个文件`,
  webSearch: (n) => `检索了 ${n} 次网页`,
  mcpToolCall: (n) => `调用了 ${n} 次集成`,
  subAgentActivity: (n) => `运行了 ${n} 个子代理`,
  todoList: (n) => (n === 1 ? '更新了计划' : `更新了 ${n} 次计划`),
  other: (n) => `调用了 ${n} 次工具`,
};

const LIVE_CLAUSES: Record<WorkCategory, (count: number) => string> = {
  reasoning: () => '正在思考',
  read: (n) => `正在读取 ${n} 个文件`,
  search: (n) => (n === 1 ? '正在搜索' : `正在搜索（${n} 次）`),
  listFiles: (n) => `正在查看 ${n} 个目录`,
  command: (n) => `正在运行 ${n} 条命令`,
  fileChange: (n) => `正在编辑 ${n} 个文件`,
  webSearch: (n) => (n === 1 ? '正在检索网页' : `正在检索网页（${n} 次）`),
  mcpToolCall: (n) => `正在调用 ${n} 次集成`,
  subAgentActivity: (n) => `正在运行 ${n} 个子代理`,
  todoList: () => '正在更新计划',
  other: (n) => `正在调用 ${n} 次工具`,
};

/** Count categories in first-use order so the Chinese sentence follows the work chronologically. */
export function formatWorkRunSentence(
  items: readonly WorkerTimelineItem[],
  options: { live?: boolean } = {},
): string {
  const live = options.live === true;
  const workItems: Array<{ item: WorkerTimelineItem; category: WorkCategory }> = [];
  for (const item of items) {
    const category = classifyWorkItem(item);
    if (category !== null) {
      workItems.push({ item, category });
    }
  }
  if (workItems.length === 0) {
    return items.length > 0 ? `${items.length} 步过程` : '';
  }
  // A single settled shell command reads clearest as its unwrapped command line.
  if (workItems.length === 1 && !live && workItems[0]!.item.kind === 'command' && workItems[0]!.category === 'command') {
    const unwrapped = collapsePreview(firstLine(unwrapShellCommand(workItems[0]!.item.command)), 72);
    if (unwrapped) return unwrapped;
  }
  const counts = new Map<WorkCategory, number>();
  for (const { item, category } of workItems) {
    const increment = item.kind === 'file_change' && item.files.length > 0 ? item.files.length : 1;
    counts.set(category, (counts.get(category) ?? 0) + increment);
  }
  const clauses = [...counts].map(([category, count]) =>
    (live ? LIVE_CLAUSES : SETTLED_CLAUSES)[category](count),
  );
  return clauses.join('、');
}

export interface WorkRunSummary {
  sentence: string;
  icon: WorkIconName;
  failedCount: number;
  declinedCount: number;
  succeeded: boolean;
  latestPreview: string | null;
}

function isItemRunning(item: WorkerTimelineItem): boolean {
  if (item.kind === 'approval') return item.status === 'pending';
  return 'status' in item && item.status === 'running';
}

function isItemFailed(item: WorkerTimelineItem): boolean {
  if (item.kind === 'command') {
    return item.status === 'failed' || (item.exitCode !== null && item.exitCode !== 0);
  }
  if (item.kind === 'tool_call') {
    return item.status === 'failed' || Boolean(item.error);
  }
  if (item.kind === 'file_change') {
    return item.status === 'failed';
  }
  if (item.kind === 'approval') {
    return item.status === 'denied' || item.status === 'expired';
  }
  return false;
}

function isItemDeclined(item: WorkerTimelineItem): boolean {
  return 'status' in item && item.status === 'declined';
}

function latestCallPreview(items: readonly WorkerTimelineItem[]): string | null {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const item = items[i]!;
    if (item.kind === 'command') {
      const cmd = collapsePreview(firstLine(unwrapShellCommand(item.command)), 48);
      if (cmd) return cmd;
    } else if (item.kind === 'tool_call') {
      if (item.progress?.trim()) return collapsePreview(item.progress, 48);
      const target = extractWorkItemFileTarget(item);
      if (target) return pathBasename(target.path);
      const name = item.server ? `${item.server} · ${item.tool}` : item.tool;
      if (name) return name;
    }
  }
  return null;
}

/** Semantic summary, whole-run icon, outcome badges, and live preview for a group of work items. */
export function summarizeWorkRun(
  items: readonly WorkerTimelineItem[],
  options: { live?: boolean } = {},
): WorkRunSummary {
  const live = options.live ?? items.some(isItemRunning);
  let sharedCategory: WorkCategory | null = null;
  let mixed = false;
  let failedCount = 0;
  let declinedCount = 0;
  let anyRunning = false;

  for (const item of items) {
    const category = classifyWorkItem(item);
    if (category !== null) {
      if (sharedCategory === null) sharedCategory = category;
      else if (sharedCategory !== category) mixed = true;
    }
    if (isItemRunning(item)) anyRunning = true;
    if (isItemDeclined(item)) declinedCount += 1;
    else if (isItemFailed(item)) failedCount += 1;
  }

  const icon: WorkIconName = !mixed && sharedCategory ? WORK_ICON_BY_CATEGORY[sharedCategory] : 'wrench';
  const sentence = formatWorkRunSentence(items, { live });
  return {
    sentence,
    icon,
    failedCount,
    declinedCount,
    succeeded: !live && !anyRunning && failedCount === 0 && declinedCount === 0,
    latestPreview: live ? latestCallPreview(items) : null,
  };
}

export interface WorkItemLineDescriptor {
  icon: WorkIconName;
  verb: string;
  target: string;
  targetTitle: string;
  codeStyle: boolean;
  fileTarget: { path: string; label: string; openable: boolean } | null;
}

const PRIMARY_ARG_KEYS = ['query', 'pattern', 'url', 'directory', 'command', 'cmd', 'description'] as const;

function extractPrimaryArg(args: string): string {
  const obj = parseToolArgsObject(args);
  if (obj) {
    for (const key of PRIMARY_ARG_KEYS) {
      const value = obj[key];
      if (typeof value === 'string' && value.trim()) {
        return collapsePreview(value, 80);
      }
    }
  }
  return collapsePreview(firstLine(args), 80);
}

/** Semantic Chinese verb, icon, target text, and optional clickable file pill for a command or tool call row. */
export function describeWorkItemLine(
  item: Extract<WorkerTimelineItem, { kind: 'command' | 'tool_call' }>,
): WorkItemLineDescriptor {
  const category = classifyWorkItem(item) ?? 'other';
  const icon = WORK_ICON_BY_CATEGORY[category];
  const live = item.status === 'running';
  const failed = isItemFailed(item);
  const fileTarget = extractWorkItemFileTarget(item);

  if (item.kind === 'command') {
    const unwrapped = unwrapShellCommand(item.command);
    const preview = collapsePreview(firstLine(unwrapped), 96);
    if (category === 'read' && fileTarget) {
      return {
        icon,
        verb: live ? '正在读取' : failed ? '尝试读取' : '读取',
        target: fileTarget.label,
        targetTitle: fileTarget.path,
        codeStyle: false,
        fileTarget,
      };
    }
    if (category === 'search') {
      return {
        icon,
        verb: live ? '正在搜索' : failed ? '搜索失败' : '搜索',
        target: preview,
        targetTitle: unwrapped,
        codeStyle: true,
        fileTarget: null,
      };
    }
    if (category === 'listFiles') {
      return {
        icon,
        verb: live ? '正在查看' : failed ? '查看失败' : '查看目录',
        target: preview,
        targetTitle: unwrapped,
        codeStyle: true,
        fileTarget: null,
      };
    }
    return {
      icon,
      verb: live ? '正在运行' : '',
      target: preview,
      targetTitle: unwrapped,
      codeStyle: true,
      fileTarget: null,
    };
  }

  // Tool call
  const argPreview = live && item.progress?.trim() ? collapsePreview(item.progress, 80) : extractPrimaryArg(item.args);
  if (category === 'webSearch') {
    const isFetch = item.tool.trim().toLowerCase().includes('fetch');
    return {
      icon,
      verb: isFetch
        ? live ? '正在抓取' : failed ? '尝试抓取' : '抓取网页'
        : live ? '正在检索' : failed ? '尝试检索' : '检索网页',
      target: argPreview,
      targetTitle: argPreview,
      codeStyle: false,
      fileTarget: null,
    };
  }
  if (category === 'read' && fileTarget) {
    return {
      icon,
      verb: live ? '正在读取' : failed ? '尝试读取' : '读取',
      target: fileTarget.label,
      targetTitle: fileTarget.path,
      codeStyle: false,
      fileTarget,
    };
  }
  if (category === 'fileChange' && fileTarget) {
    return {
      icon,
      verb: live ? '正在编辑' : failed ? '尝试编辑' : '编辑',
      target: fileTarget.label,
      targetTitle: fileTarget.path,
      codeStyle: false,
      fileTarget,
    };
  }
  if (category === 'search') {
    return {
      icon,
      verb: live ? '正在搜索' : failed ? '尝试搜索' : '搜索',
      target: argPreview,
      targetTitle: argPreview,
      codeStyle: false,
      fileTarget: null,
    };
  }
  if (category === 'listFiles') {
    return {
      icon,
      verb: live ? '正在查看' : failed ? '尝试查看' : '查看目录',
      target: argPreview,
      targetTitle: argPreview,
      codeStyle: false,
      fileTarget: null,
    };
  }
  if (category === 'mcpToolCall') {
    const label = item.server ? `${item.server} · ${item.tool}` : item.tool;
    return {
      icon,
      verb: label,
      target: argPreview,
      targetTitle: argPreview,
      codeStyle: false,
      fileTarget: null,
    };
  }
  if (category === 'subAgentActivity') {
    return {
      icon,
      verb: live ? '正在运行子代理' : '子代理',
      target: argPreview || item.tool,
      targetTitle: argPreview || item.tool,
      codeStyle: false,
      fileTarget: null,
    };
  }
  return {
    icon,
    verb: item.server ? `${item.server} · ${item.tool}` : item.tool,
    target: argPreview,
    targetTitle: argPreview,
    codeStyle: false,
    fileTarget: null,
  };
}

const MAX_TOOL_DETAIL_CHARS = 4000;

/** Lazily pretty-print JSON tool arguments for expanded details, bounded to keep huge payloads light. */
export function formatLazyToolArgs(args: string): string {
  const trimmed = args.trim();
  if (!trimmed) return '';
  let formatted = trimmed;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      formatted = JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
      formatted = trimmed;
    }
  }
  return formatted.length > MAX_TOOL_DETAIL_CHARS
    ? `${formatted.slice(0, MAX_TOOL_DETAIL_CHARS)}…`
    : formatted;
}

const UNIFIED_HUNK_LINE_RE = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/m;
const STANDALONE_DIFF_START_RE = /^(?:diff --git |--- [^\n]+\n\+\+\+ |@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@|\*\*\* Begin Patch\b)/;

function splitDiffLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** Convert Codex `*** Begin Patch` blocks into standard unified hunks that `parseUnifiedDiff` highlights cleanly. */
function convertApplyPatchToUnifiedDiff(patch: string): string | null {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let inHunk = false;
  let hunkHeaderTail = '';
  let hunkLines: string[] = [];
  let sawChange = false;

  const flushHunk = () => {
    if (!inHunk) return;
    let oldCount = 0;
    let newCount = 0;
    for (const line of hunkLines) {
      if (line.startsWith('+')) newCount += 1;
      else if (line.startsWith('-')) oldCount += 1;
      else if (!line.startsWith('\\')) {
        oldCount += 1;
        newCount += 1;
      }
    }
    if (oldCount > 0 || newCount > 0) {
      out.push(`@@ -1,${oldCount} +1,${newCount} @@${hunkHeaderTail}`);
      out.push(...hunkLines);
      sawChange = true;
    }
    inHunk = false;
    hunkHeaderTail = '';
    hunkLines = [];
  };

  for (const line of lines) {
    if (line.startsWith('*** Begin Patch') || line.startsWith('*** End Patch')) {
      flushHunk();
      continue;
    }
    const fileMatch = /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/.exec(line);
    if (fileMatch) {
      flushHunk();
      const file = fileMatch[1]!.trim();
      out.push(`--- a/${file}`, `+++ b/${file}`);
      continue;
    }
    if (line.startsWith('*** Move to:')) {
      continue;
    }
    if (line.startsWith('@@')) {
      flushHunk();
      inHunk = true;
      hunkHeaderTail = line.length > 2 ? line.slice(2) : '';
      continue;
    }
    if (inHunk) {
      if (line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('\\')) {
        hunkLines.push(line);
      } else if (line === '') {
        hunkLines.push(' ');
      }
    } else if (line.startsWith('+') || line.startsWith('-')) {
      // `*** Add File` blocks in apply_patch omit an explicit `@@` header.
      inHunk = true;
      hunkHeaderTail = '';
      hunkLines.push(line);
    }
  }
  flushHunk();
  return sawChange ? out.join('\n') : null;
}

function synthesizeReplacementDiff(oldText: string, newText: string): string | null {
  if (oldText === newText) return null;
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  if (oldLines.length === 0 && newLines.length === 0) return null;
  return [
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
  ].join('\n');
}

function normalizeStandaloneDiff(text: string): string | null {
  const normalized = text.replace(/\r\n/g, '\n');
  const trimmedStart = normalized.replace(/^\s+/, '');
  if (!STANDALONE_DIFF_START_RE.test(trimmedStart)) return null;
  if (trimmedStart.startsWith('*** Begin Patch')) {
    return convertApplyPatchToUnifiedDiff(trimmedStart);
  }
  return UNIFIED_HUNK_LINE_RE.test(trimmedStart) ? trimmedStart : null;
}

/** Detect an inline unified diff inside a tool call's arguments or standalone diff output when expanded. */
export function extractInlineDiffFromText(text: string): string | null {
  if (!text) return null;
  const standalone = normalizeStandaloneDiff(text);
  if (standalone) return standalone;
  const obj = parseToolArgsObject(text);
  if (!obj) return null;
  if (typeof obj.patch === 'string' && obj.patch.trim()) {
    const patch = obj.patch.replace(/\r\n/g, '\n');
    const converted = normalizeStandaloneDiff(patch);
    if (converted) return converted;
    if (patch.includes('@@')) return convertApplyPatchToUnifiedDiff(patch);
  }
  const pairs: Array<[unknown, unknown]> = [
    [obj.old_string, obj.new_string],
    [obj.old_str, obj.new_str],
    [obj.oldText, obj.newText],
  ];
  for (const [oldVal, newVal] of pairs) {
    if (typeof oldVal === 'string' && typeof newVal === 'string') {
      const diff = synthesizeReplacementDiff(oldVal, newVal);
      if (diff) return diff;
    }
  }
  return null;
}

const FENCE_LANGUAGE_LABELS: Record<string, string> = {
  ts: 'TypeScript',
  typescript: 'TypeScript',
  tsx: 'TSX',
  js: 'JavaScript',
  javascript: 'JavaScript',
  mjs: 'JavaScript',
  cjs: 'JavaScript',
  jsx: 'JSX',
  py: 'Python',
  python: 'Python',
  rs: 'Rust',
  rust: 'Rust',
  go: 'Go',
  golang: 'Go',
  sh: 'Shell',
  shell: 'Shell',
  bash: 'Bash',
  zsh: 'Zsh',
  ps1: 'PowerShell',
  pwsh: 'PowerShell',
  powershell: 'PowerShell',
  bat: 'Batch',
  cmd: 'Batch',
  json: 'JSON',
  jsonc: 'JSONC',
  json5: 'JSON5',
  yaml: 'YAML',
  yml: 'YAML',
  toml: 'TOML',
  ini: 'INI',
  xml: 'XML',
  html: 'HTML',
  css: 'CSS',
  scss: 'SCSS',
  less: 'Less',
  md: 'Markdown',
  markdown: 'Markdown',
  mdx: 'MDX',
  sql: 'SQL',
  graphql: 'GraphQL',
  gql: 'GraphQL',
  diff: 'Diff',
  patch: 'Diff',
  c: 'C',
  cpp: 'C++',
  'c++': 'C++',
  cxx: 'C++',
  cs: 'C#',
  csharp: 'C#',
  java: 'Java',
  kt: 'Kotlin',
  kotlin: 'Kotlin',
  swift: 'Swift',
  rb: 'Ruby',
  ruby: 'Ruby',
  php: 'PHP',
  dart: 'Dart',
  lua: 'Lua',
  zig: 'Zig',
  dockerfile: 'Dockerfile',
  docker: 'Dockerfile',
  makefile: 'Makefile',
  cmake: 'CMake',
  proto: 'Protobuf',
  prisma: 'Prisma',
  vue: 'Vue',
  svelte: 'Svelte',
  text: '纯文本',
  txt: '纯文本',
  plain: '纯文本',
  plaintext: '纯文本',
};

/** Human-friendly display label for a fenced code block language tag. */
export function codeFenceLanguageLabel(tag: string): string {
  const clean = tag.trim().split(/\s+/)[0] ?? '';
  if (!clean) return '代码';
  return FENCE_LANGUAGE_LABELS[clean.toLowerCase()] ?? clean;
}
