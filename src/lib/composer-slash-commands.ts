// Slash command catalog, ranked search, highlight resolution, and command parsers for the direct session composer.
// Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.):
// - apps/web/src/components/chat/composerSlashCommandSearch.ts
// - apps/web/src/components/chat/composerMenuHighlight.ts
// - apps/web/src/providerSkillSearch.ts
// - packages/client-runtime/src/providerSkills.ts
// - packages/client-runtime/src/state/composerDispatch.ts
// - packages/client-runtime/src/state/threadFeedback.ts
// - packages/contracts/src/orchestrationV2.ts (`parseGoalCommand`)
// - packages/shared/src/composerTrigger.ts (`isSlashCommand`, `isClearComposerCommand`)
// - packages/shared/src/usageLimits.ts (`USAGE_LIMITS_COMMAND`, `isUsageLimitsCommand`)

import type { CodexSkillOption } from '../types';
import { insertRankedSearchResult, normalizeSearchQuery, scoreQueryMatch } from './search-ranking';

export type BuiltInSlashCommandId = 'model' | 'clear' | 'history' | 'rename' | 'orchestration';
export type ProviderSlashCommandId = 'compact' | 'usage-limits' | 'goal' | 'feedback';
export type SkillSourceKind = 'app' | 'repo' | 'project' | 'personal' | 'system' | 'other';

export type SlashCommandItem =
  | {
      type: 'builtin';
      id: string;
      command: BuiltInSlashCommandId;
      label: string;
      description: string;
      hint?: string;
      keywords?: readonly string[];
      promptStartOnly: boolean;
    }
  | {
      type: 'provider';
      id: string;
      command: ProviderSlashCommandId;
      label: string;
      description: string;
      hint?: string;
      keywords?: readonly string[];
      promptStartOnly: boolean;
    }
  | {
      type: 'skill';
      id: string;
      skill: CodexSkillOption;
      label: string;
      description: string;
      sourceKind: SkillSourceKind;
      promptStartOnly: false;
    };

export type GoalCommandAction =
  | { type: 'show' }
  | { type: 'clear' }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'set'; objective: string };

export const MAX_GOAL_OBJECTIVE_CHARS = 2_000;

export const SKILL_SOURCE_LABELS: Record<SkillSourceKind, { label: string; skillLabel: string }> = {
  app: { label: '插件', skillLabel: '插件技能' },
  repo: { label: '仓库', skillLabel: '仓库技能' },
  project: { label: '项目', skillLabel: '项目技能' },
  personal: { label: '个人', skillLabel: '个人技能' },
  system: { label: '内置', skillLabel: '内置技能' },
  other: { label: '技能', skillLabel: '技能' },
};

export function resolveSkillSourceKind(skill: Pick<CodexSkillOption, 'path' | 'scope' | 'pluginId'>): SkillSourceKind {
  const normalizedPath = skill.path.replaceAll('\\', '/');
  if (skill.pluginId || normalizedPath.includes('/.codex/plugins/') || normalizedPath.includes('/.agents/plugins/')) {
    return 'app';
  }
  switch (skill.scope.trim().toLowerCase()) {
    case 'repo':
    case 'repository':
      return 'repo';
    case 'project':
    case 'workspace':
    case 'local':
      return 'project';
    case 'user':
    case 'personal':
      return 'personal';
    case 'system':
      return 'system';
    default:
      return 'other';
  }
}

export function dedupeEnabledSkills(skills: readonly CodexSkillOption[]): CodexSkillOption[] {
  const seen = new Set<string>();
  return skills.filter((skill) => {
    if (!skill.enabled) return false;
    const key = skill.name.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function scoreSkill(skill: CodexSkillOption, query: string): number | null {
  const name = skill.name.toLowerCase();
  const description = skill.description.toLowerCase();
  const scope = skill.scope.toLowerCase();
  const sourceLabel = SKILL_SOURCE_LABELS[resolveSkillSourceKind(skill)].label.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: name,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ['-', '_', '/'],
    }),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
    scoreQueryMatch({
      value: scope,
      query,
      exactBase: 40,
      prefixBase: 42,
      includesBase: 44,
    }),
    scoreQueryMatch({
      value: sourceLabel,
      query,
      exactBase: 40,
      prefixBase: 42,
      includesBase: 44,
    }),
  ].filter((score): score is number => score !== null);

  return scores.length > 0 ? Math.min(...scores) : null;
}

/** Ranked search for the `$` skill picker (adapted from T3 Code `searchProviderSkills`). */
export function searchSkills(
  skills: readonly CodexSkillOption[],
  query: string,
  limit = 20,
): CodexSkillOption[] {
  const enabled = dedupeEnabledSkills(skills);
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\$+/u });
  if (!normalizedQuery) return enabled.slice(0, limit);

  const ranked: Array<{ item: CodexSkillOption; score: number; tieBreaker: string }> = [];
  for (const skill of enabled) {
    const score = scoreSkill(skill, normalizedQuery);
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      { item: skill, score, tieBreaker: `${skill.name.toLowerCase()}\u0000${skill.path}` },
      limit,
    );
  }
  return ranked.map((entry) => entry.item);
}

export interface SlashMenuContext {
  readonly isAtPromptStart: boolean;
  readonly hasTurns: boolean;
  readonly canCompact: boolean;
  readonly hasUsageLimits: boolean;
  readonly canHistory: boolean;
  readonly canRename: boolean;
  readonly canOrchestration: boolean;
  readonly orchestrationOn: boolean;
  readonly skills: readonly CodexSkillOption[];
  /** The driver runs `/goal` (Codex thread goals); defaults to true. */
  readonly canGoal?: boolean;
  /** The driver uploads `/feedback`; defaults to true. */
  readonly canFeedback?: boolean;
  /** The driver lists models for `/model`; defaults to true. */
  readonly canModel?: boolean;
}

/**
 * Whole-message commands (`/clear`, `/compact`, `/usage-limits`, `/goal`, `/feedback`, `/history`,
 * `/rename`, `/orchestration`) appear only at the start of the prompt; `/model` and `/skill:<name>`
 * work anywhere.
 */
export function slashCommandItemsForPromptPosition(
  items: readonly SlashCommandItem[],
  isAtPromptStart: boolean,
): SlashCommandItem[] {
  if (isAtPromptStart) return [...items];
  return items.filter((item) => !item.promptStartOnly);
}

export function buildSlashCommandItems(ctx: SlashMenuContext): SlashCommandItem[] {
  const builtIns: SlashCommandItem[] = [
    ...(ctx.canModel !== false
      ? [{
          type: 'builtin' as const,
          id: 'slash:model',
          command: 'model' as const,
          label: '/model',
          description: '切换当前会话的模型与推理强度',
          keywords: ['model', 'effort', 'reasoning', '模型', '推理'],
          promptStartOnly: false,
        }]
      : []),
    ...(ctx.hasTurns
      ? [{
          type: 'builtin' as const,
          id: 'slash:clear',
          command: 'clear' as const,
          label: '/clear',
          description: '下一条消息开启全新上下文，上方历史记录保持可见',
          keywords: ['clear', 'fresh', 'reset', 'new', '清空', '新上下文', '重置'],
          promptStartOnly: true,
        }]
      : []),
    ...(ctx.canHistory
      ? [{
          type: 'builtin' as const,
          id: 'slash:history',
          command: 'history' as const,
          label: '/history',
          description: '打开当前文件夹的 Codex 历史会话列表',
          keywords: ['history', 'threads', 'past', '历史', '记录'],
          promptStartOnly: true,
        }]
      : []),
    ...(ctx.canRename
      ? [{
          type: 'builtin' as const,
          id: 'slash:rename',
          command: 'rename' as const,
          label: '/rename',
          description: '修改当前会话标题',
          hint: '新标题',
          keywords: ['rename', 'title', 'name', '改名', '重命名', '标题'],
          promptStartOnly: true,
        }]
      : []),
    ...(ctx.canOrchestration
      ? [{
          type: 'builtin' as const,
          id: 'slash:orchestration',
          command: 'orchestration' as const,
          label: '/orchestration',
          description: ctx.orchestrationOn
            ? '关闭编排模式（当前已开启）'
            : '开启编排模式（派发与管理 Worker）',
          hint: 'on / off',
          keywords: ['orchestration', 'coordinator', 'worker', 'orch', '编排', '协调'],
          promptStartOnly: true,
        }]
      : []),
  ];

  const enabledSkills = dedupeEnabledSkills(ctx.skills);
  const skillNames = new Set(enabledSkills.map((skill) => skill.name.trim().toLowerCase()));

  const providers: SlashCommandItem[] = [
    ...(ctx.canCompact
      ? [{
          type: 'provider' as const,
          id: 'provider:compact',
          command: 'compact' as const,
          label: '/compact',
          description: '压缩当前对话上下文，减少 token 占用',
          keywords: ['compact', 'summarize', 'compress', '压缩', '上下文'],
          promptStartOnly: true,
        }]
      : []),
    ...(ctx.hasUsageLimits
      ? [{
          type: 'provider' as const,
          id: 'provider:usage-limits',
          command: 'usage-limits' as const,
          label: '/usage-limits',
          description: '查看当前 Codex 账号的使用额度与重置时间',
          keywords: ['usage', 'limits', 'quota', '额度', '用量', '配额'],
          promptStartOnly: true,
        }]
      : []),
    ...(ctx.canGoal !== false
      ? [{
          type: 'provider' as const,
          id: 'provider:goal',
          command: 'goal' as const,
          label: '/goal',
          description: '设定持续推进的目标，或输入 pause / resume / clear',
          hint: '目标，或 pause / resume / clear',
          keywords: ['goal', 'objective', '目标', '持续'],
          promptStartOnly: true,
        }]
      : []),
    ...(ctx.hasTurns && ctx.canFeedback !== false
      ? [{
          type: 'provider' as const,
          id: 'provider:feedback',
          command: 'feedback' as const,
          label: '/feedback',
          description: '将当前会话与 Codex 日志反馈给 OpenAI',
          hint: '问题描述（可选）',
          keywords: ['feedback', 'bug', 'report', '反馈', '上报'],
          promptStartOnly: true,
        }]
      : []),
  ].filter((item) => !skillNames.has(item.command));

  const skillItems: SlashCommandItem[] = enabledSkills.map((skill) => {
    const sourceKind = resolveSkillSourceKind(skill);
    return {
      type: 'skill',
      id: `skill:${skill.name}`,
      skill,
      label: `/skill:${skill.name}`,
      description: skill.description || `${SKILL_SOURCE_LABELS[sourceKind].skillLabel}`,
      sourceKind,
      promptStartOnly: false,
    };
  });

  return slashCommandItemsForPromptPosition([...builtIns, ...providers, ...skillItems], ctx.isAtPromptStart);
}

function scoreSlashCommandItem(item: SlashCommandItem, query: string): number | null {
  if (item.type === 'skill') {
    if (query === 'skill') return 0;
    const skillQuery = query.startsWith('skill:') ? query.slice('skill:'.length) : query;
    const skillScore = skillQuery ? scoreSkill(item.skill, skillQuery) : 0;
    if (skillScore !== null) return skillScore;
    return 'skill'.startsWith(query) ? Number.MAX_SAFE_INTEGER : null;
  }

  const primaryValue = item.command.toLowerCase();
  const description = item.description.toLowerCase();

  const scores = [
    scoreQueryMatch({
      value: primaryValue,
      query,
      exactBase: 0,
      prefixBase: 2,
      boundaryBase: 4,
      includesBase: 6,
      fuzzyBase: 100,
      boundaryMarkers: ['-', '_', '/'],
    }),
    ...(item.keywords ?? []).map((keyword) =>
      scoreQueryMatch({
        value: keyword.toLowerCase(),
        query,
        exactBase: 8,
        prefixBase: 10,
        boundaryBase: 12,
        includesBase: 14,
      }),
    ),
    scoreQueryMatch({
      value: description,
      query,
      exactBase: 20,
      prefixBase: 22,
      boundaryBase: 24,
      includesBase: 26,
    }),
  ].filter((score): score is number => score !== null);

  return scores.length > 0 ? Math.min(...scores) : null;
}

export function searchSlashCommandItems(
  items: readonly SlashCommandItem[],
  query: string,
): SlashCommandItem[] {
  const normalizedQuery = normalizeSearchQuery(query, { trimLeadingPattern: /^\/+/u });
  if (!normalizedQuery) return [...items];

  const ranked: Array<{ item: SlashCommandItem; score: number; tieBreaker: string }> = [];
  for (const item of items) {
    const score = scoreSlashCommandItem(item, normalizedQuery);
    if (score === null) continue;
    insertRankedSearchResult(
      ranked,
      {
        item,
        score,
        tieBreaker:
          item.type === 'builtin'
            ? `0\u0000${item.command}`
            : item.type === 'provider'
              ? `1\u0000${item.command}`
              : `2\u0000${item.skill.name.toLowerCase()}`,
      },
      Number.POSITIVE_INFINITY,
    );
  }
  return ranked.map((entry) => entry.item);
}

/** Keeps the highlighted item stable while the search key matches, otherwise picks the first item. */
export function resolveMenuActiveItemId(input: {
  items: readonly { id: string }[];
  highlightedItemId: string | null;
  currentSearchKey: string | null;
  highlightedSearchKey: string | null;
}): string | null {
  if (input.items.length === 0) return null;
  if (
    input.currentSearchKey === input.highlightedSearchKey &&
    input.highlightedItemId &&
    input.items.some((item) => item.id === input.highlightedItemId)
  ) {
    return input.highlightedItemId;
  }
  return input.items[0]?.id ?? null;
}

/** A message that invokes a slash command (such as `/compact` or `/goal fix tests`), not a path like `/src/a.ts`. */
export function isSlashCommand(text: string, attachmentCount = 0): boolean {
  return attachmentCount === 0 && /^\/[\w:-]+(?:\s|$)/u.test(text.trim());
}

export const isModelCommand = (text: string): boolean => /^\/model\s*$/iu.test(text.trim());
export const isClearCommand = (text: string): boolean => /^\/clear\s*$/iu.test(text.trim());
export const isCompactCommand = (text: string): boolean => /^\/compact\s*$/iu.test(text.trim());
export const isUsageLimitsCommand = (text: string): boolean => /^\/usage(?:-limits)?\s*$/iu.test(text.trim());
export const isHistoryCommand = (text: string): boolean => /^\/history\s*$/iu.test(text.trim());

export function parseRenameCommand(text: string): { title: string } | null {
  const match = /^\/rename(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  return match ? { title: match[1]?.trim() ?? '' } : null;
}

export function parseOrchestrationCommand(text: string): { mode: 'toggle' | 'on' | 'off' } | null {
  const match = /^\/orchestration(?:\s+([^\s]+))?\s*$/iu.exec(text.trim());
  if (!match) return null;
  const arg = match[1]?.toLowerCase();
  if (!arg) return { mode: 'toggle' };
  if (arg === 'on' || arg === 'true' || arg === '1' || arg === '开' || arg === '开启') return { mode: 'on' };
  if (arg === 'off' || arg === 'false' || arg === '0' || arg === '关' || arg === '关闭') return { mode: 'off' };
  return null;
}

export function parseFeedbackCommand(text: string): { reason?: string } | null {
  const match = /^\/feedback(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  const reason = match[1]?.trim();
  return reason ? { reason } : {};
}

export function parseGoalCommand(text: string, attachmentCount = 0): GoalCommandAction | null {
  if (attachmentCount > 0) return null;
  const match = /^\/goal(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return null;
  const argument = (match[1] ?? '').trim();
  switch (argument.toLowerCase()) {
    case '':
    case 'edit':
    case 'show':
      return { type: 'show' };
    case 'clear':
      return { type: 'clear' };
    case 'pause':
      return { type: 'pause' };
    case 'resume':
      return { type: 'resume' };
    default:
      return { type: 'set', objective: argument };
  }
}

/**
 * Drafts that execute locally in the composer or via a direct control IPC, so they never queue
 * behind a running turn and are never sent as plain chat prompts.
 */
export function runsSlashCommandLocally(input: {
  readonly text: string;
  readonly holdsOnlyText: boolean;
  readonly hasTurns: boolean;
  readonly hasUsageLimits: boolean;
  readonly canHistory: boolean;
  readonly canRename: boolean;
  readonly canOrchestration: boolean;
  readonly canGoal?: boolean;
  readonly canFeedback?: boolean;
  /** `/model` opens the picker only when the driver lists models; defaults to true. */
  readonly canModel?: boolean;
}): boolean {
  if (!input.holdsOnlyText) return false;
  const { text } = input;
  if (input.canModel !== false && isModelCommand(text)) return true;
  if (input.hasTurns && isClearCommand(text)) return true;
  if (input.hasUsageLimits && isUsageLimitsCommand(text)) return true;
  if (input.canFeedback !== false && parseFeedbackCommand(text) !== null) return true;
  if (input.canGoal !== false && parseGoalCommand(text) !== null) return true;
  if (input.canHistory && isHistoryCommand(text)) return true;
  if (input.canRename && parseRenameCommand(text) !== null) return true;
  if (input.canOrchestration && parseOrchestrationCommand(text) !== null) return true;
  return false;
}
