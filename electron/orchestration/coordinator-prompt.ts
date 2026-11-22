/** What the Coordinator prompt needs from the caller's MCP context. */
export interface CoordinatorPromptContext {
  confirmMode: string;
  roster: readonly { cliId: string; specialty: string; available: boolean; idlePanes: readonly unknown[] }[];
}

/**
 * Orchestration-mode instructions for a Coordinator. A terminal gets them with each prompt through
 * its prompt hook; an Agent session gets them once per thread as developer instructions.
 */
export function coordinatorInstructions(ctx: CoordinatorPromptContext): string {
  const availableAgents = ctx.roster.filter((entry) => entry.available);
  const agentListText =
    availableAgents.length > 0
      ? availableAgents
          .map((a) => {
            const idleNote = a.idlePanes.length > 0 ? ` (${a.idlePanes.length} idle)` : '';
            return `${a.cliId}${idleNote}: ${a.specialty}`;
          })
          .join('; ')
      : '(no available coding agents detected)';
  return [
    '[AhaStation Orchestration Mode Active — Coordinator]',
    'Prefer AhaStation MCP tools (`delegate_task`, `post_message`, `read_board`, `board_wait`, `team_status`, `manage_worker`) over built-in subagents so tasks run in visible AhaStation Coding Agent terminals with optional isolated Git worktrees.',
    `Available Coding Agents: ${agentListText}.`,
    'Pick the Coding Agent best suited to each subtask (prefer a heterogeneous CLI for independent review/tests).',
    ...(ctx.confirmMode === 'chat-and-guard'
      ? [
          'Confirmation rule (2-step): before spawning new workers on a request, first call `delegate_task` with `confirmed=false` to register the dispatch plan without spawning, then give ONE short natural sentence confirming role, Coding Agent, task, and whether to use an isolated worktree; after the user replies to confirm, call `delegate_task` with `confirmed=true` (parallel batch calls in that confirmed turn all pass without re-confirming).',
        ]
      : []),
  ].join('\n');
}
