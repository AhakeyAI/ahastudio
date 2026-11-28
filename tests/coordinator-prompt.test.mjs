import assert from 'node:assert/strict';
import test from 'node:test';

import { coordinatorInstructions } from '../dist-electron/orchestration/coordinator-prompt.js';

const ctx = (extra = {}) => ({
  confirmMode: 'auto',
  roster: [{ cliId: 'codex', specialty: 'general purpose', available: true, idlePanes: [] }],
  ...extra,
});

test('the terminal Coordinator prompt stays byte-identical', () => {
  assert.equal(
    coordinatorInstructions(ctx()),
    '[AhaStation Orchestration Mode Active — Coordinator]\n' +
      'Prefer AhaStation MCP tools (`delegate_task`, `post_message`, `read_board`, `board_wait`, `team_status`, `manage_worker`) over built-in subagents so tasks run in visible AhaStation Coding Agent terminals with optional isolated Git worktrees.\n' +
      'Available Coding Agents: codex: general purpose.\n' +
      'Pick the Coding Agent best suited to each subtask (prefer a heterogeneous CLI for independent review/tests).\n' +
      'Board protocol: an @role mention is a doorbell that wakes that member, not a CC — mention only whoever must act next. In non-review peer handoffs (e.g. researcher → implementer) the Worker mentions the next Worker directly, without @coordinator.\n' +
      'Cite board posts by #seq instead of pasting their content (e.g. "check #4 and #6"; the reader calls `read_board` with `seqs: [4, 6]`). Review Workers cannot see the author’s reports or handoff posts, so give a reviewer its scope, not those #seq.\n' +
      'Before dispatching parallel writable Workers, split file ownership so no two edit the same file. Keep your own turns short: delegate research, builds, and tests, then wait with `board_wait` or end the turn.\n' +
      'Answer pending questions with `message_worker` using the questionId shown on the post. Workers finish only through `report_done`; post `[done]` yourself only when the whole Run is complete, because it pauses stall detection.\n' +
      'A settled Worker idles at no cost: send rework or small follow-ups to the same @role with `message_worker` to reuse its context instead of delegating a new Worker; `manage_worker` stop/release ends it and is not a pause.',
  );
  assert.match(
    coordinatorInstructions(ctx({ confirmMode: 'chat-and-guard' })),
    /Confirmation rule \(2-step\): before spawning new workers/,
  );
});

test('a session Coordinator is told to use the MCP tools directly and delegate read-only work', () => {
  const text = coordinatorInstructions(ctx({ session: { policy: 'workspace-write' } }));
  assert.match(text, /Call the Aha MCP tools directly; do not run the `aha` CLI or read the aha-orchestration skill/);
  assert.match(text, /Do not do the delegated work yourself or redo it to double-check/);
  assert.match(text, /Codex, Claude Code, Antigravity, and Grok Workers run as headless sessions; for read-only work \(searching, counting, reading, reviewing\) pass `taskKind: "research"` \(or `"review"`\) so the Worker uses a read-only sandbox/);
  assert.ok(!text.includes('integrate_worker'), 'no integration note below full-auto');
});

test('the integration note appears only for a full-auto session Coordinator', () => {
  const text = coordinatorInstructions(ctx({ session: { policy: 'full-auto' } }));
  assert.match(text, /`integrate_worker` and `finalize_run_integration` are unavailable in this mode; when changes are ready, ask the user to integrate from the 协作 panel/);
});
