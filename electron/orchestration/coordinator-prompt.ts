import type { AgentSessionPolicy } from './agent-session-driver.js';

/**
 * First line of every system turn AhaStation starts in an orchestrating Agent session. The session
 * view hides it (src/lib/worker-timeline-model.ts `splitSystemWake`) and labels the turn instead.
 */
export const SESSION_WAKE_HEADER =
  '[AhaStation system wake-up — not a message from the user. The user has not replied; do not treat this as their confirmation.]';

/** Sent once when an ACP session turns orchestration off after an orchestrated turn, since ACP keeps prior rules in message history. */
export const ORCHESTRATION_ENDED_INSTRUCTIONS =
  '[AhaStation Orchestration Mode Ended — Aha MCP tools are disconnected; handle requests directly in this session.]';

/** What the Coordinator prompt needs from the caller's MCP context. */
export interface CoordinatorPromptContext {
  confirmMode: string;
  roster: readonly { cliId: string; specialty: string; available: boolean; idlePanes: readonly unknown[] }[];
  /** Present only for an orchestrating Agent session; a terminal Coordinator leaves it unset. */
  session?: { policy: AgentSessionPolicy };
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
    'Board protocol: an @role mention is a doorbell that wakes that member, not a CC — mention only whoever must act next. In non-review peer handoffs (e.g. researcher → implementer) the Worker mentions the next Worker directly, without @coordinator.',
    'Cite board posts by #seq instead of pasting their content (e.g. "check #4 and #6"; the reader calls `read_board` with `seqs: [4, 6]`). Review Workers cannot see the author\u2019s reports or handoff posts, so give a reviewer its scope, not those #seq.',
    'Before dispatching parallel writable Workers, split file ownership so no two edit the same file. Keep your own turns short: delegate research, builds, and tests, then wait with `board_wait` or end the turn.',
    'Answer pending questions with `message_worker` using the questionId shown on the post. Workers finish only through `report_done`; post `[done]` yourself only when the whole Run is complete, because it pauses stall detection.',
    'A settled Worker idles at no cost: send rework or small follow-ups to the same @role with `message_worker` to reuse its context instead of delegating a new Worker; `manage_worker` stop/release ends it and is not a pause.',
    ...(ctx.confirmMode === 'chat-and-guard'
      ? [
          'Confirmation rule (2-step): before spawning new workers on a request, first call `delegate_task` with `confirmed=false` to register the dispatch plan without spawning, then give ONE short natural sentence confirming role, Coding Agent, task, and whether to use an isolated worktree; after the user replies to confirm, call `delegate_task` with `confirmed=true` (parallel batch calls in that confirmed turn all pass without re-confirming).',
        ]
      : []),
    ...(ctx.session
      ? [
          'Call the Aha MCP tools directly; do not run the `aha` CLI or read the aha-orchestration skill — this conversation is already connected as the Coordinator.',
          'Do not do the delegated work yourself or redo it to double-check; rely on the Worker\u2019s report and the inspect tools.',
          'Codex, Claude Code, Antigravity, and Grok Workers run as headless sessions; for read-only work (searching, counting, reading, reviewing) pass `taskKind: "research"` (or `"review"`) so the Worker uses a read-only sandbox. Antigravity and Grok have no read-only mode, so their read-only tasks run in a terminal instead; prefer Codex or Claude Code for them.',
          ...(ctx.session.policy === 'full-auto'
            ? [
                '`integrate_worker` and `finalize_run_integration` are unavailable in this mode; when changes are ready, ask the user to integrate from the 协作 panel.',
              ]
            : []),
        ]
      : []),
  ].join('\n');
}
