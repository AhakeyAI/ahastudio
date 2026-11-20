import type { OrchestrationTaskContext } from './orchestration-types.js';
import {
  clipUtf8Bytes,
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
  input: BuildDispatchPreambleInput,
): BuildDispatchPreambleResult {
  const cli = input.cliCommand?.trim() || 'aha';
  const fullBody = formatStructuredTaskBody({
    taskSpec: input.taskSpec,
    taskContext: input.taskContext,
    sharedContext: input.isFollowUp ? null : input.sharedContext,
    mcpEnabled: input.mcpEnabled,
    cliCommand: cli,
  });
  const clipped = clipUtf8Bytes(fullBody, INLINE_SPEC_MAX_BYTES);
  let briefFilePath: string | null = null;

  if (clipped !== fullBody && input.briefsDir) {
    const fileLines: string[] = [
      `# Worker Task Brief (${input.taskId})`,
      ...(input.role ? [`- Role: @${input.role.trim().replace(/^@+/, '')}`] : []),
      ...(input.runId ? [`- Run: ${input.runId}`] : []),
      ...(input.worktreePath ? [`- Workspace: ${input.worktreePath}`] : []),
      ...(input.branch ? [`- Branch: ${input.branch}`] : []),
      '',
      fullBody,
    ];
    try {
      briefFilePath = writeWorkerBriefFile(input.briefsDir, input.dispatchId, fileLines.join('\n'));
    } catch {
      briefFilePath = null;
    }
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
    const mcpSpecLines =
      clipped === fullBody
        ? [fullBody]
        : [
            clipped.trimEnd(),
            '…',
            briefFilePath
              ? `[Brief truncated inline. Read full context file first: ${briefFilePath}]`
              : `[Specification truncated (${input.taskId}); ask coordinator if details are missing.]`,
          ];
    const lines: string[] = [
      header,
      ...(input.worktreePath ? [`Workspace: ${input.worktreePath}`] : []),
      ...(input.branch ? [`Branch: ${input.branch}`] : []),
      ...(briefFilePath ? [`Full Brief File: ${briefFilePath}`] : []),
      '',
      ...mcpSpecLines,
      '',
      `- Need clarification or blocked? Call MCP tool \`ask_coordinator\` (wait=true).`,
      `- When finished or blocked, call MCP tool \`report_done\` with outcome & brief summary.`,
      ...(input.canDispatchSubWorkers
        ? [`- Sub-tasks permitted: use MCP tools \`delegate_task\` and \`team_wait\` if needed.`]
        : []),
    ];
    return { preamble: lines.join('\n'), briefFilePath };
  }

  const fromFlag = `--from ${input.workerHandle}`;
  const capabilityFlag = input.dispatchCapability ? ` --capability ${input.dispatchCapability}` : '';
  const specLines =
    clipped === fullBody
      ? [fullBody]
      : [
          clipped.trimEnd(),
          '…',
          briefFilePath
            ? `[Brief truncated inline. Read full context file first: ${briefFilePath}]`
            : `[Specification truncated. Read the full text with: ${cli} orchestration task-show --id ${input.taskId} --json]`,
        ];

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
    ...(briefFilePath ? [`Full Brief File: ${briefFilePath}`] : []),
    '',
    input.isFollowUp ? '=== FOLLOW-UP INSTRUCTIONS ===' : '=== TASK SPECIFICATION ===',
    ...specLines,
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
  return { preamble: lines.join('\n'), briefFilePath };
}

export function buildDispatchPreamble(input: BuildDispatchPreambleInput): string {
  return buildDispatchPreambleWithBrief(input).preamble;
}
