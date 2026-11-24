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
      'Pick the Coding Agent best suited to each subtask (prefer a heterogeneous CLI for independent review/tests).',
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
  assert.match(text, /Codex Workers run as headless sessions; for read-only work \(searching, counting, reading, reviewing\) pass `taskKind: "research"` \(or `"review"`\) so the Worker uses a read-only sandbox/);
  assert.ok(!text.includes('integrate_worker'), 'no integration note below full-auto');
});

test('the integration note appears only for a full-auto session Coordinator', () => {
  const text = coordinatorInstructions(ctx({ session: { policy: 'full-auto' } }));
  assert.match(text, /`integrate_worker` and `finalize_run_integration` are unavailable in this mode; when changes are ready, ask the user to integrate from the 协作 panel/);
});
