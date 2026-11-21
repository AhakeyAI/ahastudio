import {
  AGENT_MCP_CLI_IDS,
  type AgentMcpCliStatus,
  type AgentMcpInstallMode,
} from '../agent/agent-mcp-installer.js';
import type { AgentHookCliStatus } from '../agent/agent-hook-installer.js';
import { listLocalCliInventory, type LocalCliInventoryEntry } from '../local-cli.js';
import {
  normalizeOrchestrationSettings,
  type OrchestrationSettings,
  type OrchestrationTaskKind,
} from '../store.js';

export const DEFAULT_AGENT_SPECIALTIES: Record<string, string> = {
  claude: '复杂架构设计、长上下文重构、跨模块实现与方案拆解',
  codex: '精准代码实现、代码审查、单测补全与问题定位',
  gemini: '资料检索、文档整理、多文件阅读与方案调研',
  antigravity: '全栈工程实现、前端 UI 迭代、端到端调试与验证',
  grok: '快速排障、代码审查、边界用例分析与验证',
  opencode: '轻量代码修改、通用脚本开发与多模型协作',
  qwen: '常规功能开发、中文文档编写与代码补全',
  kimi: '长文档梳理、需求分析与资料总结',
  qoder: '常规编码任务、模块重构与日常开发',
  pi: '轻量终端辅助、快速原型与通用脚本',
};

export interface OrchestrationIdlePaneInfo {
  ptyId: string;
  cliId: string;
  cwd: string | null;
}

export interface OrchestrationAgentRosterEntry {
  cliId: string;
  label: string;
  command: string;
  installed: boolean;
  enabled: boolean;
  available: boolean;
  specialty: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  hooksInstalled: boolean;
  mcpMode: 'launch-arg' | 'config' | 'cli-fallback';
  mcpReady: boolean;
  idlePanes: OrchestrationIdlePaneInfo[];
}

export interface BuildAgentRosterDeps {
  inventory?: readonly LocalCliInventoryEntry[];
  settings?: Partial<OrchestrationSettings> | null;
  hookStatuses?: readonly Pick<AgentHookCliStatus, 'cliId' | 'state'>[];
  mcpStatuses?: readonly Pick<AgentMcpCliStatus, 'cliId' | 'mode' | 'state'>[];
  idlePanes?: readonly OrchestrationIdlePaneInfo[];
}

export interface SelectAgentForTaskOptions {
  roster: readonly OrchestrationAgentRosterEntry[];
  requestedAgent?: string | null;
  taskKind?: OrchestrationTaskKind | null;
  coordinatorCliId?: string | null;
  /** CLI that authored the work under review; review tasks strictly avoid it first. */
  authorCliId?: string | null;
  /** Multiple author CLIs (e.g. Run-level review across several integrated workers). */
  authorCliIds?: readonly string[];
  excludeCliIds?: readonly string[];
  preferIdle?: boolean;
}

export interface SelectedAgentResult {
  cliId: string;
  reason: string;
  model: string | null;
  effort: string | null;
  idlePaneId: string | null;
  fallbacks: string[];
}

const CLI_ALIASES: Record<string, string> = {
  agy: 'antigravity',
  'claude-code': 'claude',
  'gemini-cli': 'gemini',
};

const MCP_MANAGED_CLI_SET = new Set<string>(AGENT_MCP_CLI_IDS);

const TASK_KIND_AFFINITY: Record<OrchestrationTaskKind, readonly string[]> = {
  review: ['codex', 'grok', 'claude', 'antigravity', 'gemini', 'opencode', 'qwen', 'qoder', 'kimi', 'pi'],
  tests: ['codex', 'grok', 'claude', 'antigravity', 'gemini', 'opencode', 'qwen', 'qoder', 'kimi', 'pi'],
  debug: ['codex', 'grok', 'claude', 'antigravity', 'gemini', 'opencode', 'qwen', 'qoder', 'kimi', 'pi'],
  research: ['gemini', 'antigravity', 'claude', 'kimi', 'codex', 'grok', 'qwen', 'opencode', 'qoder', 'pi'],
  docs: ['gemini', 'antigravity', 'claude', 'kimi', 'codex', 'grok', 'qwen', 'opencode', 'qoder', 'pi'],
  architecture: ['claude', 'antigravity', 'codex', 'grok', 'gemini', 'opencode', 'qwen', 'qoder', 'kimi', 'pi'],
  implementation: ['claude', 'antigravity', 'codex', 'grok', 'gemini', 'opencode', 'qwen', 'qoder', 'kimi', 'pi'],
};

const DEFAULT_PRIORITY: readonly string[] = [
  'claude',
  'codex',
  'antigravity',
  'gemini',
  'grok',
  'opencode',
  'qwen',
  'qoder',
  'kimi',
  'pi',
];

export function normalizeAgentCliAlias(raw: string): string {
  const cleaned = raw.trim().replace(/^@+/, '').toLowerCase();
  return CLI_ALIASES[cleaned] ?? cleaned;
}

function defaultMcpModeForCli(cliId: string): AgentMcpInstallMode | 'cli-fallback' {
  if (cliId === 'claude' || cliId === 'codex') return 'launch-arg';
  if (MCP_MANAGED_CLI_SET.has(cliId)) return 'config';
  return 'cli-fallback';
}

export function buildAgentRoster(deps: BuildAgentRosterDeps = {}): OrchestrationAgentRosterEntry[] {
  const inventory = deps.inventory ?? listLocalCliInventory();
  const settings = normalizeOrchestrationSettings(deps.settings);

  const hookMap = new Map<string, Pick<AgentHookCliStatus, 'cliId' | 'state'>>();
  for (const status of deps.hookStatuses ?? []) {
    hookMap.set(status.cliId, status);
  }

  const mcpMap = new Map<string, Pick<AgentMcpCliStatus, 'cliId' | 'mode' | 'state'>>();
  for (const status of deps.mcpStatuses ?? []) {
    mcpMap.set(status.cliId, status);
  }

  const idleByCli = new Map<string, OrchestrationIdlePaneInfo[]>();
  for (const pane of deps.idlePanes ?? []) {
    const cliId = normalizeAgentCliAlias(pane.cliId);
    if (!cliId) continue;
    const list = idleByCli.get(cliId) ?? [];
    list.push({ ptyId: pane.ptyId, cliId, cwd: pane.cwd ?? null });
    idleByCli.set(cliId, list);
  }

  return inventory.map((item) => {
    const profile = settings.agentProfiles[item.id];
    const enabled = profile?.enabled ?? true;
    const available = item.installed && enabled;
    const specialty =
      profile?.specialty?.trim() || DEFAULT_AGENT_SPECIALTIES[item.id] || '通用编码与协作任务';
    const defaultModel = profile?.defaultModel?.trim() || null;
    const defaultEffort = profile?.defaultEffort?.trim() || null;

    const hookStatus = hookMap.get(item.id);
    const hooksInstalled = hookStatus?.state === 'installed';

    const mcpStatus = mcpMap.get(item.id);
    const mcpMode: 'launch-arg' | 'config' | 'cli-fallback' =
      mcpStatus?.mode ?? defaultMcpModeForCli(item.id);
    const mcpReady = mcpStatus
      ? mcpStatus.state === 'launch-managed' || mcpStatus.state === 'installed'
      : mcpMode === 'launch-arg';

    return {
      cliId: item.id,
      label: item.label,
      command: item.command,
      installed: item.installed,
      enabled,
      available,
      specialty,
      defaultModel,
      defaultEffort,
      hooksInstalled,
      mcpMode,
      mcpReady,
      idlePanes: idleByCli.get(item.id) ?? [],
    };
  });
}

function affinityScore(cliId: string, taskKind?: OrchestrationTaskKind | null): number {
  if (taskKind && TASK_KIND_AFFINITY[taskKind]) {
    const idx = TASK_KIND_AFFINITY[taskKind].indexOf(cliId);
    if (idx === 0) return 30;
    if (idx === 1) return 25;
    if (idx === 2) return 20;
    if (idx > 2) return Math.max(0, 12 - idx);
    return 0;
  }
  const idx = DEFAULT_PRIORITY.indexOf(cliId);
  if (idx >= 0 && idx < 5) return 20 - idx * 2;
  if (idx >= 5) return Math.max(0, 10 - (idx - 5));
  return 0;
}

function rankCandidates(
  candidates: readonly OrchestrationAgentRosterEntry[],
  opts: {
    taskKind?: OrchestrationTaskKind | null;
    coordinatorCliId?: string | null;
    authorCliIds?: ReadonlySet<string>;
    preferIdle?: boolean;
  },
): Array<{ entry: OrchestrationAgentRosterEntry; score: number; heterogeneousReview: boolean; usedIdleBoost: boolean }> {
  const authorSet = opts.authorCliIds ?? new Set<string>();
  return candidates
    .map((entry, index) => {
      let score = affinityScore(entry.cliId, opts.taskKind);
      let heterogeneousReview = false;
      if (opts.taskKind === 'review') {
        if (authorSet.size > 0) {
          if (!authorSet.has(entry.cliId)) {
            score += 60;
            heterogeneousReview = true;
          }
          if (opts.coordinatorCliId && entry.cliId !== opts.coordinatorCliId) {
            score += 20;
          }
        } else if (opts.coordinatorCliId && entry.cliId !== opts.coordinatorCliId) {
          score += 50;
          heterogeneousReview = true;
        }
      }
      const usedIdleBoost = Boolean(opts.preferIdle && entry.idlePanes.length > 0);
      if (usedIdleBoost) {
        score += 12;
      }
      // Small tie-breaker that never overrides task affinity, review heterogeneity, or idle preference.
      if (entry.mcpReady) {
        score += 0.5;
      }
      return { entry, score, index, heterogeneousReview, usedIdleBoost };
    })
    .sort((a, b) => (b.score !== a.score ? b.score - a.score : a.index - b.index));
}

export function selectAgentForTask(opts: SelectAgentForTaskOptions): SelectedAgentResult {
  const excluded = new Set(
    (opts.excludeCliIds ?? []).map((id) => normalizeAgentCliAlias(id)).filter(Boolean),
  );
  const coordinatorCliId = opts.coordinatorCliId
    ? normalizeAgentCliAlias(opts.coordinatorCliId)
    : null;
  const authorCliIds = new Set<string>();
  if (opts.authorCliId) {
    const normalized = normalizeAgentCliAlias(opts.authorCliId);
    if (normalized) authorCliIds.add(normalized);
  }
  for (const raw of opts.authorCliIds ?? []) {
    const normalized = normalizeAgentCliAlias(raw);
    if (normalized) authorCliIds.add(normalized);
  }
  const availableEntries = opts.roster.filter(
    (entry) => entry.available && !excluded.has(entry.cliId),
  );

  const rawRequested = opts.requestedAgent?.trim();
  const normalizedRequested = rawRequested ? normalizeAgentCliAlias(rawRequested) : '';

  if (normalizedRequested && normalizedRequested !== 'auto') {
    const entry = opts.roster.find((item) => item.cliId === normalizedRequested);
    if (!entry) {
      throw new Error(`未识别的 Coding Agent: ${rawRequested}`);
    }
    if (!entry.installed) {
      throw new Error(
        `指定的 Coding Agent "${entry.label}" (${entry.cliId}) 未安装，请先安装或改用其他可用 Agent`,
      );
    }
    if (!entry.enabled) {
      throw new Error(
        `指定的 Coding Agent "${entry.label}" (${entry.cliId}) 已在编排设置中禁用，请先启用或改用其他可用 Agent`,
      );
    }
    if (!entry.available) {
      throw new Error(`指定的 Coding Agent "${entry.label}" (${entry.cliId}) 当前不可用`);
    }
    if (excluded.has(entry.cliId)) {
      throw new Error(`指定的 Coding Agent "${entry.label}" (${entry.cliId}) 已被排除，无法选用`);
    }
    const fallbacks = rankCandidates(
      availableEntries.filter((item) => item.cliId !== entry.cliId),
      { taskKind: opts.taskKind, coordinatorCliId, authorCliIds, preferIdle: opts.preferIdle },
    ).map((item) => item.entry.cliId);

    return {
      cliId: entry.cliId,
      reason: `按指定选择 ${entry.label} (${entry.cliId})`,
      model: entry.defaultModel,
      effort: entry.defaultEffort,
      idlePaneId: opts.preferIdle && entry.idlePanes.length > 0 ? entry.idlePanes[0].ptyId : null,
      fallbacks,
    };
  }

  if (availableEntries.length === 0) {
    if (opts.roster.length === 0) {
      throw new Error('没有可用的 Coding Agent');
    }
    if (opts.roster.every((entry) => !entry.installed)) {
      throw new Error('本机未检测到已安装的 Coding Agent，请先安装至少一个 CLI');
    }
    if (opts.roster.some((entry) => entry.installed) && opts.roster.every((entry) => !entry.available)) {
      throw new Error('所有已安装的 Coding Agent 均已被禁用，请在设置中启用至少一个 Agent');
    }
    throw new Error('没有可用的 Coding Agent（候选 Agent 已被排除或不可用）');
  }

  const ranked = rankCandidates(availableEntries, {
    taskKind: opts.taskKind,
    coordinatorCliId,
    authorCliIds,
    preferIdle: opts.preferIdle,
  });
  const top = ranked[0];
  const reasons: string[] = [];
  if (top.heterogeneousReview) {
    if (authorCliIds.size > 0) {
      reasons.push(`异构评审（避开实现者 ${[...authorCliIds].join('/')}）`);
    } else if (coordinatorCliId) {
      reasons.push(`异构评审（避开协调者 ${coordinatorCliId}）`);
    }
  }
  if (opts.taskKind) {
    reasons.push(`匹配任务类型 ${opts.taskKind}`);
  } else {
    reasons.push('默认优先级自动选择');
  }
  if (top.usedIdleBoost) {
    reasons.push('优先复用空闲终端');
  }

  return {
    cliId: top.entry.cliId,
    reason: reasons.join('，'),
    model: top.entry.defaultModel,
    effort: top.entry.defaultEffort,
    idlePaneId:
      opts.preferIdle && top.entry.idlePanes.length > 0 ? top.entry.idlePanes[0].ptyId : null,
    fallbacks: ranked.slice(1).map((item) => item.entry.cliId),
  };
}
