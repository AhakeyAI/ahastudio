// ACP launch specs and dialect hooks for Antigravity, Grok, and OpenCode.
// Adapted from Orca (MIT, Copyright (c) 2026 Lovecast Inc.):
// - src/main/acp/acp-dialects/acp-dialect.ts, antigravity-dialect.ts, grok-dialect.ts, grok-requests.ts, opencode-dialect.ts
// - src/main/acp/launch/acp-launch-registry.ts, acp-instructions.ts, src/main/antigravity/antigravity-acp-launch-spec.ts
import type { AgentQuestion } from '../../orchestration/agent-session-driver.js';
import { ACP_FORM_ELICITATION_METHOD, AcpRequestError, acpFormQuestions, type AcpQuestionPresentation } from './acp-form-elicitation.js';

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => (value && typeof value === 'object' && !Array.isArray(value) ? value as Obj : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** An ACP permission option as the agent offers it. */
export interface AcpPermissionOption {
  optionId: string;
  name: string;
  kind: string;
  _meta?: unknown;
}

/** A request the dialect claims: shown to the person as questions and never answered by policy. */
export type AcpClaimedRequest =
  | ({ kind: 'question' } & AcpQuestionPresentation)
  /** An approval with extra warning text; policy still never approves it on its own. */
  | { kind: 'approval'; warning: string };

/** A request the dialect answers itself, with a notice for the timeline. */
export interface AcpSettledRequest {
  reply: unknown;
  notice?: string;
}

export interface AcpToolUpdate extends Obj {
  toolCallId: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
  _meta?: unknown;
}

/** Hooks interpret one agent's extensions; turns, requests, and timeline mapping stay shared. */
export interface AcpDialect {
  clientCapabilities?: Obj;
  request?(method: string, params: unknown): AcpClaimedRequest | undefined;
  settleRequest?(method: string, params: unknown): AcpSettledRequest | undefined;
  normalizeToolUpdate?(update: AcpToolUpdate): AcpToolUpdate;
  toolName?(update: AcpToolUpdate): string | undefined;
  /** An agent message chunk that announces a retry, shown as a warning instead of reply text. */
  retryNotice?(chunk: string): string | undefined;
  /** A turn the agent's hook refused ends completed with this reason, not as the person's stop. */
  hookBlock?(meta: unknown): { reason: string } | undefined;
  /** The prompt text that runs the agent's own context compaction. */
  compactCommand?: string;
  /** The mode that makes the agent read-only, and the one it normally runs in. */
  readOnlyMode?: { value: string; normal: string };
  /** Builds `_meta` for `session/new|load|resume` when the agent accepts appended system instructions natively. */
  systemPromptMeta?(initialized: Obj, instructions: string): Obj | undefined;
  /** Picks the authentication method when `session/new` says sign-in is required. */
  authMethod?(advertised: readonly string[], env: NodeJS.ProcessEnv): string | undefined;
  promptErrorDetail?(error: { message: string; data?: unknown }): string | undefined;
}

export interface AcpLaunchSpec {
  driver: 'antigravity' | 'grok' | 'opencode';
  label: string;
  command: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  dialect: AcpDialect;
}

function choiceQuestion(id: string, prompt: string, options: { label: string; description?: string }[], allowOther: boolean): AgentQuestion {
  return {
    id, header: '', prompt, allowOther,
    options: options.map((option) => ({ label: option.label, description: option.description ?? '' })),
  };
}

// --- Antigravity (`agy acp`) ---

// The server's question forms open with only a count; each field's title is the real question.
const AGY_QUESTION_FORM = /^The agent has (?:a question|\d+ questions)\.$/u;
const AGY_RETRY_NOTICE = /^\s*\u26a0 (Model produced invalid output\.)\s*$/u;

function agyRequest(method: string, params: unknown): AcpClaimedRequest | undefined {
  if (method === ACP_FORM_ELICITATION_METHOD) {
    const form = object(params);
    const message = text(form.message) ?? '';
    return { kind: 'question', ...acpFormQuestions(AGY_QUESTION_FORM.test(message) ? { ...form, message: '' } : form) };
  }
  if (method !== 'session/request_permission') return undefined;
  const request = object(params);
  const toolCall = object(request.toolCall);
  const options = (Array.isArray(request.options) ? request.options : []).map(object)
    .filter((option) => typeof option.optionId === 'string')
    .map((option) => ({ optionId: option.optionId as string, name: text(option.name) ?? (option.optionId as string), meta: option._meta }));
  // Formless servers ask through interaction_ permissions; never approve them by policy.
  if (text(toolCall.toolCallId)?.startsWith('interaction_')) {
    const question = choiceQuestion('q1', text(toolCall.title) ?? '问题', options.map((option) => ({ label: option.name })), false);
    return {
      kind: 'question',
      questions: [question],
      reply(answers) {
        if (answers === null) return { outcome: { outcome: 'cancelled' } };
        const values = answers.q1 ?? [];
        const chosen = options.find((option) => option.name === values[0]);
        if (values.length !== 1 || !chosen) throw new AcpRequestError('Question answer must choose one offered option');
        return { outcome: { outcome: 'selected', optionId: chosen.optionId } };
      },
    };
  }
  // A risky Allow Always option carries its warning in option metadata.
  const warning = options
    .map((option) => object(object(option.meta)['agy.security.warning']))
    .map((found) => text(found.message)?.trim() || text(found.title)?.trim())
    .find(Boolean);
  return warning ? { kind: 'approval', warning: warning.slice(0, 512) } : undefined;
}

const AGY_COMMAND_FIELDS = {
  command: ['CommandLine', 'command_line', 'commandLine', 'command'],
  cwd: ['Cwd', 'WorkingDirectory', 'working_dir', 'workingDir', 'cwd'],
  stdout: ['combinedOutput', 'combined_output', 'stdout'],
  exitCode: ['exitCode', 'exit_code'],
} as const;

function pick(source: Obj, keys: readonly string[]): unknown {
  for (const key of keys) if (source[key] !== undefined) return source[key];
  return undefined;
}

function normalizeAgyToolUpdate(update: AcpToolUpdate): AcpToolUpdate {
  const input = object(update.rawInput);
  const output = object(update.rawOutput);
  const command = pick(input, AGY_COMMAND_FIELDS.command);
  const cwd = pick(input, AGY_COMMAND_FIELDS.cwd);
  const stdout = pick(output, AGY_COMMAND_FIELDS.stdout);
  const exitCode = pick(output, AGY_COMMAND_FIELDS.exitCode);
  return {
    ...update,
    ...(typeof command === 'string' ? { rawInput: { command, ...(typeof cwd === 'string' ? { cwd } : {}) } } : {}),
    ...(typeof stdout === 'string' || typeof exitCode === 'number'
      ? { rawOutput: { ...(typeof stdout === 'string' ? { stdout } : {}), ...(typeof exitCode === 'number' ? { exitCode } : {}) } }
      : {}),
  };
}

export const ANTIGRAVITY_DIALECT: AcpDialect = {
  // With forms, ask_question carries a write-in field per question; permissions cannot carry text.
  clientCapabilities: { elicitation: { form: {} } },
  request: agyRequest,
  normalizeToolUpdate: normalizeAgyToolUpdate,
  // Avoid using the full command line as the tool name.
  toolName: (update) => (update.kind === 'execute' ? 'execute' : undefined),
  systemPromptMeta: (initialized, instructions) =>
    object(object(object(object(initialized.agentCapabilities)._meta).antigravity).systemPrompt).append === true
      ? { antigravity: { systemPrompt: { append: instructions } } }
      : undefined,
  retryNotice: (chunk) => {
    const cause = AGY_RETRY_NOTICE.exec(chunk)?.[1];
    return cause ? `模型输出无效，Antigravity 正在重试（${cause}）` : undefined;
  },
  promptErrorDetail: (error) => {
    const raw = text(object(error.data).details) ?? error.message;
    const prefix = /^Cloud Code Assist API error \(\d{3}\):\s*/u.exec(raw);
    if (!prefix) return undefined;
    try {
      return text(object(object(JSON.parse(raw.slice(prefix[0].length))).error).message);
    } catch {
      return undefined;
    }
  },
};

// --- Grok (`grok agent stdio`) ---

const GROK_PLAN_SHOWN =
  'AhaStation showed your plan to the user. Stop here and wait for their feedback or a request to implement it in a later turn.';

function grokQuestions(params: unknown): AcpQuestionPresentation {
  const asked = (Array.isArray(object(params).questions) ? object(params).questions as unknown[] : []).map(object)
    .filter((question) => typeof question.question === 'string');
  if (asked.length === 0) throw new AcpRequestError('Invalid agent question request');
  const questions = asked.map((question, index) => choiceQuestion(
    `q${index + 1}`, question.question as string,
    (Array.isArray(question.options) ? question.options : []).map(object)
      .filter((option) => typeof option.label === 'string')
      .map((option) => ({ label: option.label as string, ...(text(option.description) ? { description: text(option.description)! } : {}) })),
    true,
  ));
  return {
    questions,
    reply(answers) {
      if (answers === null) return { outcome: 'cancelled' };
      const replies: Record<string, string | string[]> = {};
      const annotations: Record<string, { notes: string }> = {};
      questions.forEach((question, index) => {
        const given = (answers[question.id] ?? []).map((value) => value.trim()).filter(Boolean);
        const chosen = given.filter((value) => question.options.some((option) => option.label === value));
        const notes = given.filter((value) => !chosen.includes(value)).join('\n');
        if (notes) annotations[question.prompt] = { notes };
        const values = chosen.length ? chosen : notes ? ['Other'] : [];
        // Grok's own question card leaves a skipped question out of `answers`.
        if (values.length) replies[question.prompt] = asked[index]!.multiSelect === true ? values : values[0]!;
      });
      return { outcome: 'accepted', answers: replies, ...(Object.keys(annotations).length ? { annotations } : {}) };
    },
  };
}

function grokRequest(method: string, params: unknown): AcpClaimedRequest | undefined {
  const name = method.replace(/^_/u, '');
  if (name === 'x.ai/ask_user_question') return { kind: 'question', ...grokQuestions(params) };
  if (name === 'x.ai/mcp/elicit') {
    const request = object(params);
    const server = text(request.serverName) ?? '';
    const message = text(request.message) ?? '';
    // Grok reads the answer under `outcome` rather than ACP's `action`; URL forms are not supported here.
    if (request.mode === 'url') throw new AcpRequestError('URL elicitation is not supported');
    const form = acpFormQuestions({ ...request, message: server ? `${server}: ${message}` : message });
    return {
      kind: 'question',
      questions: form.questions,
      reply: (answers) => {
        const { action, content } = object(form.reply(answers));
        return { outcome: action, ...(content === undefined ? {} : { content }) };
      },
    };
  }
  if (method === ACP_FORM_ELICITATION_METHOD) return { kind: 'question', ...acpFormQuestions(params) };
  return undefined;
}

export const GROK_DIALECT: AcpDialect = {
  request: grokRequest,
  settleRequest: (method, params) => {
    if (method.replace(/^_/u, '') !== 'x.ai/exit_plan_mode') return undefined;
    const plan = text(object(params).planContent)?.trim() || 'The agent exited plan mode without writing a plan.';
    return { reply: { outcome: 'abandoned', feedback: GROK_PLAN_SHOWN }, notice: `计划：\n${plan}` };
  },
  toolName: (update) => text(object(object(update._meta)['x.ai/tool']).name),
  hookBlock: (meta) => {
    const parsed = object(meta);
    if (parsed.cancellationCategory !== 'HookDenied') return undefined;
    return { reason: text(object(parsed.cancellationContext).reason)?.trim() || '被 Hook 拦截' };
  },
  compactCommand: '/compact',
  // Prefer an API key in the environment, then the cached sign-in; never prompt interactively.
  authMethod: (advertised, env) =>
    env.XAI_API_KEY?.trim() && advertised.includes('xai.api_key') ? 'xai.api_key'
      : advertised.includes('cached_token') ? 'cached_token' : undefined,
  promptErrorDetail: (error) => text(object(error.data).message),
};

// --- OpenCode (`opencode acp`) ---

function normalizeOpenCodeToolUpdate(update: AcpToolUpdate): AcpToolUpdate {
  const raw = object(update.rawOutput);
  const metadata = object(raw.metadata);
  const output = typeof raw.output === 'string' ? raw.output : text(metadata.output);
  const exit = typeof metadata.exit === 'number' ? metadata.exit : undefined;
  if (output === undefined && exit === undefined) return update;
  return {
    ...update,
    rawOutput: {
      ...raw,
      ...(output !== undefined && raw.stdout === undefined ? { stdout: output } : {}),
      ...(exit !== undefined && raw.exitCode === undefined ? { exitCode: exit } : {}),
    },
  };
}

export const OPENCODE_DIALECT: AcpDialect = {
  clientCapabilities: { elicitation: { form: {} } },
  request: (method, params) =>
    method === ACP_FORM_ELICITATION_METHOD ? { kind: 'question', ...acpFormQuestions(params) } : undefined,
  normalizeToolUpdate: normalizeOpenCodeToolUpdate,
  compactCommand: '/compact',
  readOnlyMode: { value: 'plan', normal: 'build' },
};

export const ACP_LAUNCH_SPECS: Readonly<Record<AcpLaunchSpec['driver'], AcpLaunchSpec>> = {
  antigravity: {
    driver: 'antigravity', label: 'Antigravity', command: 'agy', args: ['acp'],
    // A background updater steals focus on Windows and can replace agy mid-session.
    env: { AGY_CLI_DISABLE_AUTO_UPDATE: 'true' },
    dialect: ANTIGRAVITY_DIALECT,
  },
  grok: { driver: 'grok', label: 'Grok', command: 'grok', args: ['agent', 'stdio'], env: {}, dialect: GROK_DIALECT },
  opencode: {
    driver: 'opencode', label: 'OpenCode', command: 'opencode', args: ['acp'],
    // 1.x cannot answer ACP questions through its own tool; 2.x negotiates form support instead.
    env: { OPENCODE_CLIENT: 'acp', OPENCODE_ENABLE_QUESTION_TOOL: 'false' },
    dialect: OPENCODE_DIALECT,
  },
};
