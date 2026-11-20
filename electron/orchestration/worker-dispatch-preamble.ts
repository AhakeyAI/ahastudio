import { formatAgentPromptPayload, sanitizeBracketedPasteText } from '../agent/agent-prompt-delivery.js';
import { PTY_INPUT_MAX_BYTES } from '../pty-input-limiter.js';
import type { OrchestrationTaskContext } from './orchestration-types.js';
import {
  BRIEF_FILE_MAX_BYTES,
  clipMarkdown,
  formatStructuredTaskBody,
  writeWorkerBriefFile,
  type SharedRunContext,
} from './worker-brief-context.js';

export interface BuildDispatchPreambleInput {
  taskId: string;
  dispatchId: string;
  taskSpec: string;
  taskContext?: OrchestrationTaskContext | null;
  sharedContext?: SharedRunContext | null;
  briefsDir?: string | null;
  coordinatorHandle: string;
  workerHandle: string;
  runId?: string;
  worktreePath?: string | null;
  branch?: string | null;
  canDispatchSubWorkers?: boolean;
  cliCommand?: string;
  /** Per-dispatch worker credential; only ever written to the assignee's own PTY. */
  dispatchCapability?: string | null;
  isFollowUp?: boolean;
  previousDispatchId?: string | null;
  redactText?: (text: string) => string;
  mcpEnabled?: boolean;
  role?: string | null;
}

export interface BuildDispatchPreambleResult {
  preamble: string;
  briefFilePath: string | null;
}

/**
 * Prompt delivery rejects writes over 8 KiB, so long specs are clipped inline and persisted to a
 * brief file (outside the user's git worktree) or read through the CLI.
 */
export const INLINE_SPEC_MAX_BYTES = 4_096;

/**
 * Audit messages and previews are readable by other workers and the renderer, so they must never
 * carry the assignee's credential. Only the PTY write may contain the clear-text capability.
 */
export function redactDispatchCapability(text: string, capability?: string | null): string {
  if (!capability) {
    return text;
  }
  return text.split(capability).join('<redacted>');
}

export function buildDispatchPreambleWithBrief(
  raw: BuildDispatchPreambleInput,
): BuildDispatchPreambleResult {
  const redact = raw.redactText ?? ((value: string) => redactDispatchCapability(value, raw.dispatchCapability));
  const clean = (text: string) => redact(sanitizeBracketedPasteText(text));
  const cleanLabel = (text: string) => clean(text).replace(/\n/g, ' ');
  const input: BuildDispatchPreambleInput = {
    ...raw,
    taskId: cleanLabel(raw.taskId),
    dispatchId: cleanLabel(raw.dispatchId),
    runId: raw.runId && cleanLabel(raw.runId),
    workerHandle: cleanLabel(raw.workerHandle),
    coordinatorHandle: cleanLabel(raw.coordinatorHandle),
    worktreePath: raw.worktreePath && cleanLabel(raw.worktreePath),
    branch: raw.branch && cleanLabel(raw.branch),
    role: raw.role && cleanLabel(raw.role),
    previousDispatchId: raw.previousDispatchId && cleanLabel(raw.previousDispatchId),
  };
  const cli = cleanLabel(raw.cliCommand ?? '').trim() || 'aha';
  const bodyInput = {
    taskSpec: input.taskSpec,
    taskContext: input.taskContext,
    sharedContext: input.isFollowUp ? null : input.sharedContext,
    mcpEnabled: input.mcpEnabled,
    cliCommand: cli,
    sanitizeText: clean,
  };
  const fullBody = formatStructuredTaskBody(bodyInput);
  const measure = (prompt: string) => Buffer.byteLength(formatAgentPromptPayload({ prompt }), 'utf8');
  const frameBudget = PTY_INPUT_MAX_BYTES - 64;
  if (Buffer.byteLength(fullBody, 'utf8') <= INLINE_SPEC_MAX_BYTES) {
    const inline = renderDispatchPreamble(input, cli, fullBody, '', null, false);
    if (measure(inline) <= frameBudget) return { preamble: inline, briefFilePath: null };
  }

  let briefFilePath: string | null = null;
  if (input.briefsDir) {
    try {
      const title = clean('# Worker Task Brief (' + input.taskId + ')');
      const heading = clipMarkdown(title, 512);
      const fileBody = formatStructuredTaskBody({
        ...bodyInput,
        maxFileBodyBytes: BRIEF_FILE_MAX_BYTES - Buffer.byteLength(heading, 'utf8') - 3,
      });
      briefFilePath = writeWorkerBriefFile(input.briefsDir, raw.dispatchId, heading + '\n\n' + fileBody);
    } catch {
      // The inline retrieval hint still works when the brief directory is unavailable.
    }
  }

  let pointer = briefFilePath;
  const fallback = input.mcpEnabled
    ? '[Specification truncated (' + input.taskId + '); ask coordinator if details are missing.]'
    : '[Specification truncated. Read the full text with: ' + cli + ' orchestration task-show --id ' + input.taskId + ' --json]';
  let notice = pointer ? '' : fallback;
  let skeleton = renderDispatchPreamble(input, cli, '', notice, pointer, false);
  const compact = measure(skeleton) > frameBudget - 512;
  if (compact) {
    skeleton = renderDispatchPreamble(input, cli, '', notice, pointer, true);
    if (measure(skeleton) > frameBudget - 256) {
      notice = '[Specification truncated. Retrieve the full task or ask the coordinator.]';
      pointer = null;
      skeleton = renderDispatchPreamble(input, cli, '', notice, pointer, true);
    }
  }
  const byteBudget = Math.min(INLINE_SPEC_MAX_BYTES, frameBudget - measure(skeleton) - 2);
  const preview = clipMarkdown(fullBody, byteBudget);
  const preamble = renderDispatchPreamble(input, cli, preview, notice, pointer, compact);
  return { preamble: measure(preamble) <= frameBudget ? preamble : skeleton, briefFilePath };
}

function renderDispatchPreamble(
  input: BuildDispatchPreambleInput,
  cli: string,
  body: string,
  notice: string,
  briefFilePath: string | null,
  compact: boolean,
): string {
  const pointerLines = briefFilePath ? ['Full Brief File: ' + briefFilePath, 'Read full context file first.'] : [];
  if (compact) {
    const capability = input.dispatchCapability ? 'Dispatch Capability: ' + input.dispatchCapability : '';
    return [
      input.isFollowUp ? '[Worker follow-up]' : '[Worker dispatch]',
      ...pointerLines,
      body,
      notice,
      ...(input.mcpEnabled
        ? ['Use MCP ask_coordinator or report_done.']
        : [capability, 'Use aha orchestration worker-done with --capability to report completion.']),
    ].filter(Boolean).join('\n');
  }

  if (input.mcpEnabled) {
    const cleanRole = input.role?.trim().replace(/^@+/, '') || '';
    const header = cleanRole
      ? input.isFollowUp
        ? `[Worker @${cleanRole} · Follow-Up]`
        : `[Worker @${cleanRole}]`
      : input.isFollowUp
        ? `[Worker ${input.dispatchId} · Follow-Up]`
        : `[Worker ${input.dispatchId}]`;
    const lines: string[] = [
      header,
      ...(input.worktreePath ? [`Workspace: ${input.worktreePath}`] : []),
      ...(input.branch ? [`Branch: ${input.branch}`] : []),
      ...pointerLines,
      '',
      body,
      ...(notice ? [notice] : []),
      '',
      `- Need clarification or blocked? Call MCP tool \`ask_coordinator\` (wait=true).`,
      `- When finished or blocked, call MCP tool \`report_done\` with outcome & brief summary.`,
      ...(input.canDispatchSubWorkers
        ? [`- Sub-tasks permitted: use MCP tools \`delegate_task\` and \`team_wait\` if needed.`]
        : []),
    ];
    return lines.join('\n');
  }

  const fromFlag = `--from ${input.workerHandle}`;
  const capabilityFlag = input.dispatchCapability ? ` --capability ${input.dispatchCapability}` : '';
  const headerTitle = input.isFollowUp
    ? `[ORCHESTRATION FOLLOW-UP DISPATCH ${input.dispatchId}]`
    : `[ORCHESTRATION DISPATCH ${input.dispatchId}]`;

  const lines: string[] = [
    headerTitle,
    `Task: ${input.taskId}`,
    ...(input.previousDispatchId ? [`Previous Dispatch: ${input.previousDispatchId}`] : []),
    ...(input.runId ? [`Run: ${input.runId}`] : []),
    `Worker Handle: ${input.workerHandle}`,
    `Coordinator Handle: ${input.coordinatorHandle}`,
    ...(input.dispatchCapability ? [`Dispatch Capability: ${input.dispatchCapability}`] : []),
    ...(input.worktreePath ? [`Workspace CWD: ${input.worktreePath}`] : []),
    ...(input.branch ? [`Git Branch: ${input.branch}`] : []),
    ...pointerLines,
    '',
    input.isFollowUp ? '=== FOLLOW-UP INSTRUCTIONS ===' : '=== TASK SPECIFICATION ===',
    body,
    ...(notice ? [notice] : []),
    input.isFollowUp ? '=== END FOLLOW-UP INSTRUCTIONS ===' : '=== END TASK SPECIFICATION ===',
    '',
    '=== ORCHESTRATION PROTOCOL ===',
    `- Ask coordinator if requirements are ambiguous (waits for reply):`,
    `  ${cli} orchestration ask ${fromFlag} --to ${input.coordinatorHandle} --question "<question>" --wait${capabilityFlag}`,
    `- Escalate an unresolvable blocker:`,
    `  ${cli} orchestration send ${fromFlag} --to ${input.coordinatorHandle} --type escalation --subject "Blocker on ${input.taskId}" --body "<details>"`,
    `- Check incoming coordinator messages or guidance:`,
    `  ${cli} orchestration check ${fromFlag}`,
    `- Report completion or failure when done (REQUIRED):`,
    `  ${cli} orchestration worker-done ${fromFlag} --task ${input.taskId} --dispatch ${input.dispatchId} --outcome completed --summary "<brief summary>"${capabilityFlag}`,
    `  (Aliases: \`${cli} orchestration task-done\` / \`${cli} orchestration task-fail\`; valid --outcome values: completed | failed | blocked | escalated | abandoned)`,
    ...(input.dispatchCapability
      ? [
          `- The dispatch capability above is your per-dispatch credential. Pass it with --capability for worker-done, task-done, task-fail, ask, and heartbeat sends; it is required, not optional.`,
        ]
      : []),
  ];

  if (input.canDispatchSubWorkers) {
    lines.push(
      `- Sub-workers permitted: you may create dependent subtasks via \`${cli} orchestration task-create\` or launch a helper worker via \`${cli} orchestration worker-start ${fromFlag} --spec "<subtask>"\`.`
    );
  }

  lines.push('Begin working on the task now.');
  return lines.join('\n');
}

export function buildDispatchPreamble(input: BuildDispatchPreambleInput): string {
  return buildDispatchPreambleWithBrief(input).preamble;
}
