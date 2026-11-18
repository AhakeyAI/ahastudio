import { isOrchestrationCliId, type OrchestrationCliId } from '../local-cli.js';
import { OrchestrationError } from './orchestration-types.js';

export const INTEGRATED_WORKER_CLI_IDS = [
  'claude',
  'codex',
  'gemini',
  'opencode',
  'antigravity',
  'grok',
] as const;

export type IntegratedWorkerCliId = (typeof INTEGRATED_WORKER_CLI_IDS)[number];

export interface WorkerLaunchOptionCatalogEntry {
  cliId: IntegratedWorkerCliId;
  command: string;
  modelFlag: '-m' | '--model';
  supportsEffort: boolean;
  effortLevels: readonly string[];
  seedModels: readonly string[];
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const CODEX_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const;
const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'] as const;
const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'] as const;

export const WORKER_LAUNCH_OPTION_CATALOG: Record<
  IntegratedWorkerCliId,
  WorkerLaunchOptionCatalogEntry
> = {
  claude: {
    cliId: 'claude',
    command: 'claude',
    modelFlag: '--model',
    supportsEffort: true,
    effortLevels: CLAUDE_EFFORTS,
    seedModels: [
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'opus',
      'sonnet',
      'haiku',
    ],
  },
  codex: {
    cliId: 'codex',
    command: 'codex',
    modelFlag: '-m',
    supportsEffort: true,
    effortLevels: CODEX_EFFORTS,
    seedModels: [
      'gpt-5.4',
      'gpt-5.5',
      'gpt-5.6-luna',
      'gpt-5.3-codex',
      'gpt-5.2-codex',
      'o3',
      'o4-mini',
    ],
  },
  gemini: {
    cliId: 'gemini',
    command: 'gemini',
    modelFlag: '-m',
    supportsEffort: false,
    effortLevels: [],
    seedModels: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-3-pro', 'gemini-3.1-pro'],
  },
  opencode: {
    cliId: 'opencode',
    command: 'opencode',
    modelFlag: '--model',
    supportsEffort: false,
    effortLevels: [],
    seedModels: ['anthropic/claude-sonnet-4-6', 'openai/gpt-5.4', 'google/gemini-2.5-pro'],
  },
  antigravity: {
    cliId: 'antigravity',
    command: 'agy',
    modelFlag: '--model',
    supportsEffort: true,
    effortLevels: ANTIGRAVITY_EFFORTS,
    seedModels: ['gemini-3.1-pro', 'gemini-2.5-pro', 'claude-sonnet-4-6'],
  },
  grok: {
    cliId: 'grok',
    command: 'grok',
    modelFlag: '-m',
    supportsEffort: true,
    effortLevels: GROK_EFFORTS,
    seedModels: ['grok-4.6-beta', 'grok-4.5', 'grok-code-fast-1'],
  },
};

export function normalizeWorkerCliId(raw?: string | null): OrchestrationCliId {
  const trimmed = raw?.trim().toLowerCase() ?? '';
  if (!trimmed) {
    return 'claude';
  }
  if (trimmed === 'agy') {
    return 'antigravity';
  }
  if (trimmed === 'claude-code') {
    return 'claude';
  }
  if (trimmed === 'gemini-cli') {
    return 'gemini';
  }
  if (isOrchestrationCliId(trimmed)) {
    return trimmed;
  }
  throw new OrchestrationError(
    'invalid_argument',
    `Unsupported worker agent CLI "${raw}". Expected one of: ${INTEGRATED_WORKER_CLI_IDS.join(', ')}.`
  );
}

export interface ResolvedWorkerLaunchConfig {
  cliId: OrchestrationCliId;
  model: string | null;
  effort: string | null;
  extraArgs: string[];
}

function assertEffortCeiling(
  cliId: string,
  model: string,
  effort: string,
  orderedLevels: readonly string[],
  maxLevel: string
): void {
  const idx = orderedLevels.indexOf(effort);
  const maxIdx = orderedLevels.indexOf(maxLevel);
  if (idx !== -1 && maxIdx !== -1 && idx > maxIdx) {
    throw new OrchestrationError(
      'invalid_argument',
      `Model "${model}" on ${cliId} supports effort up to "${maxLevel}" (received "${effort}").`
    );
  }
}

export function resolveWorkerLaunchConfig(input: {
  cliId?: string | null;
  model?: string | null;
  effort?: string | null;
  reusingTerminal?: boolean;
}): ResolvedWorkerLaunchConfig {
  const cliId = normalizeWorkerCliId(input.cliId);
  const model = input.model?.trim() || null;
  const effort = input.effort?.trim().toLowerCase() || null;

  if (input.reusingTerminal && (model || effort)) {
    throw new OrchestrationError(
      'invalid_argument',
      '--model and --effort cannot be applied when reusing an existing terminal.'
    );
  }

  if (effort && !model) {
    throw new OrchestrationError('invalid_argument', '--effort requires --model.');
  }

  if (!model) {
    return { cliId, model: null, effort: null, extraArgs: [] };
  }

  if (/[\r\n\0]/.test(model)) {
    throw new OrchestrationError('invalid_argument', 'Invalid --model value.');
  }

  const catalog = (
    WORKER_LAUNCH_OPTION_CATALOG as Partial<
      Record<OrchestrationCliId, WorkerLaunchOptionCatalogEntry>
    >
  )[cliId];

  if (!catalog) {
    if (effort) {
      throw new OrchestrationError(
        'invalid_argument',
        `CLI "${cliId}" does not support --effort.`
      );
    }
    return {
      cliId,
      model,
      effort: null,
      extraArgs: ['--model', model],
    };
  }

  if (effort) {
    if (!catalog.supportsEffort) {
      throw new OrchestrationError(
        'invalid_argument',
        `CLI "${cliId}" does not support --effort.`
      );
    }
    if (!catalog.effortLevels.includes(effort)) {
      throw new OrchestrationError(
        'invalid_argument',
        `Invalid --effort "${effort}" for ${cliId}. Supported levels: ${catalog.effortLevels.join(', ')}.`
      );
    }

    const lowerModel = model.toLowerCase();
    if (cliId === 'claude' && lowerModel.includes('haiku')) {
      throw new OrchestrationError(
        'invalid_argument',
        `Model "${model}" on claude does not support --effort.`
      );
    }
    if (cliId === 'codex') {
      if (
        lowerModel === 'gpt-5.5' ||
        lowerModel === 'gpt-5.2-codex' ||
        lowerModel === 'gpt-5.3-codex'
      ) {
        assertEffortCeiling('codex', model, effort, CODEX_EFFORTS, 'xhigh');
      } else if (lowerModel === 'gpt-5.6-luna') {
        assertEffortCeiling('codex', model, effort, CODEX_EFFORTS, 'max');
      }
    }
    if (cliId === 'grok' && lowerModel.startsWith('grok-4.5')) {
      assertEffortCeiling('grok', model, effort, GROK_EFFORTS, 'high');
    }
  }

  const extraArgs: string[] = [catalog.modelFlag, model];
  if (effort) {
    switch (cliId) {
      case 'claude':
      case 'antigravity':
        extraArgs.push('--effort', effort);
        break;
      case 'codex':
        extraArgs.push('-c', `model_reasoning_effort="${effort}"`);
        break;
      case 'grok':
        extraArgs.push('--reasoning-effort', effort);
        break;
    }
  }

  return {
    cliId,
    model,
    effort,
    extraArgs,
  };
}
