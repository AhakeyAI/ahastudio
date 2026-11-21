import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { IntegratedWorkerCliId } from './worker-launch-catalog.js';

export const ORCHESTRATION_SKILL_NAME = 'orchestration';

export const ORCHESTRATION_SKILL_MARKDOWN = `---
name: orchestration
description: Coordinate autonomous multi-agent workers, isolated Git worktrees, mailboxes, permission approvals, and terminals via the aha CLI. Use when decomposing work across parallel coding agents (claude, codex, gemini, opencode, antigravity, grok), inspecting or steering workers, or reporting worker completion.
---

# Multi-Agent Orchestration Guide (\`aha orchestration\` & Native MCP Tools)

Use native AhaStation MCP tools when available, or fall back to \`aha orchestration\`, \`aha terminal\`, and \`aha worktree\` to coordinate parallel AI coding workers inside AhaStation.

## Native MCP Tools (Preferred When Mounted)

- Coordinator tools: \`list_coding_agents\`, \`delegate_task\`, \`team_status\`, \`team_wait\`, \`message_worker\`, \`manage_worker\`, \`inspect_worker_diff\`, \`integrate_worker\`, \`inspect_run_diff\`, \`finalize_run_integration\`.
- Worker tools: \`ask_coordinator\`, \`report_done\` (plus \`delegate_task\` / \`team_wait\` when sub-workers are permitted).
- **Autonomous Close-Out & Adversarial Verification (Coordinator SOP)**:
  1. When a worker calls \`report_done\`, first call \`inspect_worker_diff\` to inspect real committed + uncommitted changes, full 40-char \`snapshotOid\`, and the recommended review tier (\`L0\` / \`L1\` / \`L2\`). Never trust verbal summaries blindly.
  2. For substantive code changes (\`L1\` / \`L2\`), the server enforces a passing **heterogeneous adversarial review** before \`squash\`/\`merge\` integration (only \`L0\` changes are exempt). Call \`delegate_task(reviewOf="<@role or dispatchId>", reviewFocus="...")\`: AhaStation avoids the author's CLI, freezes an unambiguous Git snapshot into a fresh detached review worktree, firewalls the author's reports, and requires an explicit \`verdict\` (\`pass\` | \`reject\`; any P0/P1 or workspace mutation forces \`reject\`). For \`L2\`, you may launch 2 parallel \`reviewOf\` reviewers on the same snapshot with distinct \`reviewFocus\` angles.
  3. If a reviewer reports \`REJECT\` (or stops/fails without explicit \`PASS\`), send the concrete findings back to the original implementation worker via \`message_worker\` and re-verify (max 2 rounds; escalate to the user if still unresolved).
  4. Once verified (\`PASS\`), call \`integrate_worker(role="<@role>", mode="squash", releaseAfter=true)\` to squash-merge the server-approved snapshot as one clean commit into the main branch (protected against ignored-file overwrites and concurrent merges) and release panes. If the main workspace has dirty uncommitted user edits, pass \`targetBranch="integration"\` (or \`"auto"\`) to integrate into an isolated Run integration branch \`aha/run/<runId>\` without touching dirty files in main. Automatically remove only clean author worktrees and safely deletable \`aha/worker/*\` branches.
  5. **Post-Integration Run-Level Secondary Review & Finalization**: After integrating multiple workers, call \`inspect_run_diff\` to inspect the combined Run diff and optionally call \`delegate_task(reviewRun=true, reviewFocus="...")\` to launch a heterogeneous Run-level secondary adversarial review across the combined changes (avoiding all integrated author CLIs). When an \`aha/run/<runId>\` branch is active and the main workspace is clean, call \`finalize_run_integration(mode="squash")\` to promote the combined Run changes back into the main branch and clean up the \`_run-*\` worktree and \`aha/run/*\` branch. Run final integration tests (typecheck/test) in the main workspace before reporting final results to the user.
- In \`chat-and-guard\` mode, use the 2-step confirmation flow: first call \`delegate_task\` with \`confirmed: false\` to register the dispatch plan without spawning, confirm role, Coding Agent, task, and worktree isolation with the user in one short sentence, then after the user replies call \`delegate_task\` with \`confirmed: true\` with the original proposal ID. Register each worker's plan before asking for batch confirmation. In the confirmed turn, matching plans can start in parallel and omitted context fields are inherited.
- **Provide curated coordinator context** when calling \`delegate_task\` (or \`worker-start\`): workers start with a blank conversation and cannot see your prior chat. Populate \`context\` (goal, confirmed decisions, pitfalls), \`constraints\` (boundaries/files not to touch), \`files\` (already-located paths or design docs), and \`acceptance\` (verification commands). Long briefs use a brief file outside the worktree. If marked as truncated, retrieve the full task with the CLI or ask the coordinator.

## Core Coordinator Loop (CLI)

0. **Inspect available Coding Agents, specialties, and idle panes**:
   \`\`\`bash
   aha orchestration agents
   \`\`\`

1. **Launch autonomous workers** (creates a task, optional isolated Git worktree, background agent terminal, and injects the task preamble):
   \`\`\`bash
   aha orchestration worker-start --spec "<clear, self-contained task specification>" --agent claude
   # Optional model/effort & placement flags:
   aha orchestration worker-start --spec "<spec>" --agent codex --model gpt-5.4 --effort high
   aha orchestration worker-start --spec "<spec>" --agent gemini --no-worktree
   aha orchestration worker-start --spec "<spec>" --context "Decision already agreed" --constraint "Keep the API" --file src/main.ts --acceptance "Run npm test"
   aha orchestration worker-start --spec "<spec>" --context-file ./background.md --constraint "Keep the API" --constraint "Preserve Windows support"
   \`\`\`
   Use either --context or --context-file (64 KiB read limit). The value - reads from stdin. Repeat --constraint and --file for multiple items.

2. **Wait reactively for worker events** (never poll in a \`sleep\` loop):
   \`\`\`bash
   aha orchestration check --wait
   \`\`\`
   \`check --wait\` wakes immediately on:
   - Worker completion/failure reports (\`worker_done\` via \`task-done\` / \`task-fail\` / \`worker-done\`)
   - Worker questions (\`ask --wait\`)
   - Held permission approval requests (\`perm_...\`)
   - Automatic turn-stop escalations (when a worker stops its turn without reporting)

3. **Respond, steer, or reactivate**:
   - Answer a worker question:
     \`\`\`bash
     aha orchestration reply --id <msg_id> --body "<answer>"
     \`\`\`
   - Approve or deny a held tool permission request:
     \`\`\`bash
     aha orchestration approve --id <perm_id>
     aha orchestration deny --id <perm_id> --reason "<why and what to do instead>"
     \`\`\`
   - Inspect a worker's live or archived terminal output:
     \`\`\`bash
     aha orchestration worker-show --dispatch <ctx_id>
     aha orchestration worker-read --dispatch <ctx_id> --screen
     \`\`\`
   - Steer an active worker OR reactivate a settled worker in its existing worktree:
     \`\`\`bash
     aha orchestration send --to dispatch:<ctx_id> --subject "Follow-up" --body "<instructions>"
     \`\`\`

4. **Release or stop workers when finished**:
   \`\`\`bash
   # Clean up settled worker's pane and owned Git worktree (refuses if worktree is dirty unless --force):
   aha orchestration worker-release --dispatch <ctx_id>
   # Abort an active stuck worker immediately:
   aha orchestration worker-stop --dispatch <ctx_id> --reason "Superseded"
   \`\`\`

## Worker Responsibilities

When running inside a dispatched worker terminal:
- Ask blocking questions instead of guessing:
  \`aha orchestration ask --question "<question>" --wait --capability <cap>\`
- Report completion when finished:
  \`aha orchestration task-done --dispatch <ctx_id> --summary "<what changed and how verified>" --capability <cap>\`
- Report failure if blocked:
  \`aha orchestration task-fail --dispatch <ctx_id> --summary "<root cause>" --capability <cap>\`

## Reference Guides

- \`references/workers.md\` — \`worker-start\`, 6-CLI \`--model\`/\`--effort\` flags, \`worker-read\`, \`send\` follow-up reactivation, \`worker-release\`, and \`worker-stop\`.
- \`references/messaging.md\` — Mailboxes, \`check --wait\`, \`send\`, \`ask\`, \`reply\`, and turn-stop synthetic escalations.
- \`references/approvals.md\` — Hook-held permission interception and remote \`approve\` / \`deny\`.
- \`references/tasks-and-gates.md\` — Explicit \`run\` & \`task\` DAGs and human \`gate-create\` / \`gate-resolve\`.
- \`references/terminals-and-worktrees.md\` — Companion \`aha terminal\` and \`aha worktree\` commands.
`;

export const ORCHESTRATION_SKILL_REFERENCES: Record<string, string> = {
  'workers.md': `# Autonomous Workers (\`worker-start\` / \`worker-*\`)

## Launching Workers
\`\`\`bash
aha orchestration worker-start \\
  --spec "Implement feature X and run tests" \\
  --title "Feature X" \\
  --agent claude \\
  --model claude-sonnet-4-6 \\
  --effort high
\`\`\`

### Supported Agents & \`--model\` / \`--effort\` Catalog
- \`claude\`: \`--model <id>\`, \`--effort low|medium|high|xhigh|max\` (effort not supported on Haiku models)
- \`codex\`: \`--model <id>\`, \`--effort minimal|low|medium|high|xhigh|max|ultra\`
- \`gemini\`: \`--model <id>\` (\`--effort\` not supported)
- \`opencode\`: \`--model <provider/model>\` (\`--effort\` not supported)
- \`antigravity\`: \`--model <id>\`, \`--effort low|medium|high\`
- \`grok\`: \`--model <id>\`, \`--effort low|medium|high|xhigh\`

### Worktree Placement
- By default in a Git repository, \`worker-start\` creates an isolated Git worktree and branch (\`aha/worker/<slug>\`).
- Pass \`--no-worktree\` (or \`--worktree current\`) to run in the current directory without creating a worktree.
- Pass \`--branch <name>\` and \`--base-branch <ref>\` to control branch creation.
- Pass \`--terminal <ptyId>\` to reuse an existing idle agent pane instead of spawning a new terminal.
- Pass \`--keep-open\` to retain the terminal tab after release.

## Inspection, Follow-Up, and Cleanup
- \`aha orchestration worker-list\` — List active and settled workers.
- \`aha orchestration worker-show --dispatch <ctx_id>\` — Inspect stage, lineage, model, worktree, and open approvals.
- \`aha orchestration worker-read --dispatch <ctx_id> [--screen | --cursor <n> --limit <chars>]\` — Read live screen or incremental/archived transcript.
- \`aha orchestration send --to dispatch:<ctx_id> --subject "Fix edge case" --body "..."\` — If \`ctx_id\` already settled, automatically creates a follow-up dispatch (\`processGeneration + 1\`) in the worker's existing pane (or respawns in its worktree) and transfers custody.
- \`aha orchestration worker-keep-open --dispatch <ctx_id>\` — Keep worker pane open.
- \`aha orchestration worker-release --dispatch <ctx_id> [--keep-pane] [--keep-worktree] [--force]\` — Release settled worker resources safely.
- \`aha orchestration worker-stop --dispatch <ctx_id> [--remove-worktree] [--force]\` — Terminate an active worker.
`,
  'messaging.md': `# Mailboxes, Questions, and Turn-Stop Escalations

## Reading Mail
\`\`\`bash
aha orchestration check --wait
aha orchestration check --peek
aha orchestration inbox --unread
\`\`\`

## Sending & Broadcasting
\`\`\`bash
aha orchestration send --to dispatch:<ctx_id> --subject "Update" --body "..."
aha orchestration send --to '@workers' --subject "Shared context" --body "..."
aha orchestration send --to '@all' --subject "Announcement" --body "..."
\`\`\`
*(In PowerShell, always quote \`'@workers'\` and \`'@all'\` to prevent splatting.)*

## Blocking Questions (\`ask\` / \`reply\`)
Workers ask their coordinator or parent worker:
\`\`\`bash
aha orchestration ask --question "Should we keep v1 compatibility?" --options "yes,no" --wait --capability <cap>
\`\`\`
Coordinator replies:
\`\`\`bash
aha orchestration reply --id <msg_id> --body "yes"
\`\`\`

## Turn-Stop Synthetic Escalations
If an active worker finishes its turn, errors, or waits for input without calling \`task-done\` / \`worker-done\` / \`ask\`, AhaStation automatically captures the last lines of its terminal screen and delivers a synthetic \`escalation\` message to wake the parent's \`check --wait\`, without prematurely failing the dispatch.
`,
  'approvals.md': `# Remote Permission Approvals (\`approve\` / \`deny\`)

When a worker triggers a permission hook (\`PermissionRequest\`, \`BeforeTool\`, or gated \`PreToolUse\`), AhaStation holds the hook request open and delivers an urgent \`escalation\` with an \`approvalId\` (\`perm_...\`) to the parent coordinator.

Approve or deny from the coordinator terminal, the active parent worker, or the desktop UI. An expired application approval is denied. Gemini CLI's standard \`BeforeTool\` event reports activity. Native confirmation remains in the Gemini terminal unless the event explicitly carries a confirmation request.

## Approving a Tool Call
\`\`\`bash
aha orchestration approve --id <perm_id>
\`\`\`

## Denying a Tool Call with Guidance
\`\`\`bash
aha orchestration deny --id <perm_id> --reason "Do not drop the table; add a migration instead."
\`\`\`
`,
  'tasks-and-gates.md': `# Runs, Task DAGs, and Decision Gates

## Explicit Runs & Tasks
\`\`\`bash
aha orchestration run-create --objective "Refactor auth subsystem"
aha orchestration task-create --id task_schema --spec "Add session schema"
aha orchestration task-create --id task_api --deps task_schema --spec "Update auth endpoints"
aha orchestration task-list
aha orchestration task-show --id task_api
\`\`\`

## Human Decision Gates
\`\`\`bash
aha orchestration gate-create --task task_api --question "Approve public API break?" --options "approve,reject"
aha orchestration gate-resolve --id <gate_id> --resolution "approve"
\`\`\`
`,
  'terminals-and-worktrees.md': `# Companion Terminal & Worktree Commands

## \`aha terminal\`
\`\`\`bash
aha terminal list
aha terminal show --id <ptyId>
aha terminal read --id <ptyId> --screen
aha terminal read --id <ptyId> --cursor 0 --limit 8000
aha terminal send --id <ptyId> --text "npm test" --submit
aha terminal wait --id <ptyId> --for tui-idle --timeout-ms 30000
\`\`\`

## \`aha worktree\`
\`\`\`bash
aha worktree list
aha worktree create --branch feat/auth-refactor --agent claude
aha worktree remove --path <worktreePath>
\`\`\`
`,
};

export interface SkillProviderTarget {
  provider: IntegratedWorkerCliId | 'shared';
  skillDir: string;
}

export interface SyncOrchestrationSkillsOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
}

export interface SyncOrchestrationSkillsResult {
  skillName: string;
  targets: SkillProviderTarget[];
  updatedFiles: string[];
  skippedFiles: string[];
}

function readOptional(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function digest(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function writeManagedFile(filePath: string, content: string, create: boolean): void {
  mkdirSync(dirname(filePath), { recursive: true });
  if (create) {
    writeFileSync(filePath, content, { encoding: 'utf8', flag: 'wx' });
    return;
  }
  const temp = `${filePath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx' });
    renameSync(temp, filePath);
  } finally {
    rmSync(temp, { force: true });
  }
}

export function resolveSkillInstallTargets(
  options: SyncOrchestrationSkillsOptions = {}
): SkillProviderTarget[] {
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const targets: SkillProviderTarget[] = [];
  const seenDirs = new Set<string>();

  const addTarget = (provider: SkillProviderTarget['provider'], skillDir: string) => {
    const normalized = skillDir.replace(/\\/g, '/').toLowerCase();
    if (seenDirs.has(normalized)) return;
    seenDirs.add(normalized);
    targets.push({ provider, skillDir });
  };

  // Canonical shared Agents skill root (read natively by Codex & OpenCode).
  addTarget('shared', join(home, '.agents', 'skills', ORCHESTRATION_SKILL_NAME));

  // Codex explicit CODEX_HOME override if configured.
  if (env.CODEX_HOME?.trim()) {
    addTarget('codex', join(env.CODEX_HOME.trim(), 'skills', ORCHESTRATION_SKILL_NAME));
  }

  // OpenCode ~/.config/opencode/skills when OpenCode config dir is used or requested.
  const opencodeConfigDir = join(home, '.config', 'opencode');
  if (existsSync(opencodeConfigDir)) {
    addTarget('opencode', join(opencodeConfigDir, 'skills', ORCHESTRATION_SKILL_NAME));
  }

  // Claude Code
  const claudeRoot = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
  addTarget('claude', join(claudeRoot, 'skills', ORCHESTRATION_SKILL_NAME));

  // Gemini CLI
  const geminiRoot = env.GEMINI_CLI_HOME?.trim() || join(home, '.gemini');
  addTarget('gemini', join(geminiRoot, 'skills', ORCHESTRATION_SKILL_NAME));

  // Antigravity (agy)
  addTarget('antigravity', join(home, '.gemini', 'config', 'skills', ORCHESTRATION_SKILL_NAME));

  // Grok CLI
  const grokRoot = env.GROK_HOME?.trim() || join(home, '.grok');
  addTarget('grok', join(grokRoot, 'skills', ORCHESTRATION_SKILL_NAME));

  return targets;
}

function syncSkillDirectory(
  skillDir: string,
  entryMarkdown: string,
  references: Record<string, string>,
  updatedFiles: string[],
  skippedFiles: string[]
): { entrySkipped: boolean } {
  const files = [
    ['SKILL.md', entryMarkdown] as const,
    ...Object.entries(references).map(([name, content]) => [`references/${name}`, content] as const),
  ];
  const markerPath = join(skillDir, '.aha-skill-digests.json');
  const marker = readOptional(markerPath);
  let known: Record<string, string> = {};
  if (marker) {
    try {
      const decoded: unknown = JSON.parse(marker);
      if (decoded && typeof decoded === 'object') known = decoded as Record<string, string>;
    } catch {
      // A corrupt marker cannot establish ownership of existing content.
    }
  }
  const entryPath = join(skillDir, 'SKILL.md');
  const entry = readOptional(entryPath);
  if (entry !== undefined && entry !== entryMarkdown && digest(entry) !== known['SKILL.md']) {
    skippedFiles.push(entryPath);
    return { entrySkipped: true };
  }
  const next: Record<string, string> = {};
  for (const [name, content] of files) {
    const filePath = join(skillDir, name);
    const existing = readOptional(filePath);
    if (existing !== content) {
      if (existing !== undefined && digest(existing) !== known[name]) {
        skippedFiles.push(filePath);
        continue;
      }
      try {
        writeManagedFile(filePath, content, existing === undefined);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        skippedFiles.push(filePath);
        continue;
      }
      updatedFiles.push(filePath);
    }
    next[name] = digest(content);
  }
  const nextMarker = JSON.stringify(next);
  if (marker !== nextMarker) writeManagedFile(markerPath, nextMarker, false);
  return { entrySkipped: false };
}

export const AHA_ORCHESTRATION_FALLBACK_SKILL_NAME = 'aha-orchestration';

function buildFallbackSkillMarkdown(): string {
  return ORCHESTRATION_SKILL_MARKDOWN.replace(
    /^---\r?\nname:\s*orchestration\r?\n/,
    `---\nname: ${AHA_ORCHESTRATION_FALLBACK_SKILL_NAME}\n`
  );
}

export function syncBundledOrchestrationSkills(
  options: SyncOrchestrationSkillsOptions = {}
): SyncOrchestrationSkillsResult {
  const targets = resolveSkillInstallTargets(options);
  const updatedFiles: string[] = [];
  const skippedFiles: string[] = [];
  const fallbackMarkdown = buildFallbackSkillMarkdown();

  for (const target of targets) {
    const { entrySkipped } = syncSkillDirectory(
      target.skillDir,
      ORCHESTRATION_SKILL_MARKDOWN,
      ORCHESTRATION_SKILL_REFERENCES,
      updatedFiles,
      skippedFiles
    );
    // When another tool (e.g. Orca) or the user owns `orchestration/SKILL.md`, keep it untouched
    // and publish `aha-orchestration` alongside it so AhaStation coordinators still discover `aha`.
    if (entrySkipped) {
      const fallbackDir = join(dirname(target.skillDir), AHA_ORCHESTRATION_FALLBACK_SKILL_NAME);
      syncSkillDirectory(
        fallbackDir,
        fallbackMarkdown,
        ORCHESTRATION_SKILL_REFERENCES,
        updatedFiles,
        skippedFiles
      );
    }
  }

  return {
    skillName: ORCHESTRATION_SKILL_NAME,
    targets,
    updatedFiles,
    skippedFiles,
  };
}

export function listBundledSkills(options: SyncOrchestrationSkillsOptions = {}) {
  return {
    skills: [
      {
        name: ORCHESTRATION_SKILL_NAME,
        description:
          'Coordinate autonomous multi-agent workers, Git worktrees, mailboxes, approvals, and terminals.',
        references: Object.keys(ORCHESTRATION_SKILL_REFERENCES),
        targets: resolveSkillInstallTargets(options),
      },
    ],
  };
}

export function getBundledSkillContent(
  input: { name?: string; reference?: string; full?: boolean } = {}
): {
  name: string;
  reference: string | null;
  content: string;
} {
  const name = input.name?.trim() || ORCHESTRATION_SKILL_NAME;
  if (name !== ORCHESTRATION_SKILL_NAME && name !== AHA_ORCHESTRATION_FALLBACK_SKILL_NAME) {
    throw new Error(`Unknown bundled skill: ${name}`);
  }
  const baseMarkdown =
    name === AHA_ORCHESTRATION_FALLBACK_SKILL_NAME
      ? buildFallbackSkillMarkdown()
      : ORCHESTRATION_SKILL_MARKDOWN;
  if (input.reference?.trim()) {
    const cleanRef = input.reference.trim().replace(/^references[\\/]/, '');
    const content = ORCHESTRATION_SKILL_REFERENCES[cleanRef];
    if (!content) {
      throw new Error(
        `Unknown reference "${input.reference}" for skill ${name}. Available: ${Object.keys(ORCHESTRATION_SKILL_REFERENCES).join(', ')}`
      );
    }
    return { name, reference: cleanRef, content };
  }
  if (input.full) {
    const appended = Object.entries(ORCHESTRATION_SKILL_REFERENCES)
      .map(([refName, refBody]) => `---\n<!-- reference: ${refName} -->\n\n${refBody}`)
      .join('\n\n');
    return {
      name,
      reference: null,
      content: `${baseMarkdown}\n\n${appended}`,
    };
  }
  return { name, reference: null, content: baseMarkdown };
}
