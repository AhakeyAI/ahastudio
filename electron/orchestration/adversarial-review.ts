import type {
  OrchestrationReviewFinding,
  OrchestrationReviewSeverity,
  OrchestrationReviewVerdict,
  OrchestrationTaskContext,
} from './orchestration-types.js';
import type {
  RunCommitRangeDiffInspection,
  WorkerDiffInspection,
} from './worker-git-integration.js';

export const MAX_ADVERSARIAL_REVIEW_ROUNDS = 2;
const MAX_FINDINGS = 25;

export interface AdversarialVerdictEvaluation {
  requestedVerdict: OrchestrationReviewVerdict;
  effectiveVerdict: OrchestrationReviewVerdict;
  overriddenByBlockingFindings: boolean;
  overriddenByWorkspaceIntegrity: boolean;
  blockingFindings: OrchestrationReviewFinding[];
  advisoryFindings: OrchestrationReviewFinding[];
  findings: OrchestrationReviewFinding[];
}

export function normalizeReviewFindings(raw: unknown): OrchestrationReviewFinding[] {
  if (!Array.isArray(raw)) return [];
  const out: OrchestrationReviewFinding[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const rawSev = typeof rec.severity === 'string' ? rec.severity.trim().toUpperCase() : '';
    const severity: OrchestrationReviewSeverity =
      rawSev === 'P0' || rawSev === 'P1' || rawSev === 'P2' ? rawSev : 'P2';
    const location = typeof rec.location === 'string' ? rec.location.trim().slice(0, 240) : '';
    const title = typeof rec.title === 'string' ? rec.title.trim().slice(0, 240) : '';
    const evidence = typeof rec.evidence === 'string' ? rec.evidence.trim().slice(0, 1200) : '';
    const fix = typeof rec.fix === 'string' ? rec.fix.trim().slice(0, 800) : '';
    if (!title && !evidence) continue;
    out.push({
      severity,
      location: location || '(unspecified)',
      title: title || evidence.slice(0, 120),
      evidence: evidence || title,
      ...(fix ? { fix } : {}),
    });
    if (out.length >= MAX_FINDINGS) break;
  }
  return out;
}

/**
 * Enforces the fail-closed adversarial verdict contract:
 * - Missing or invalid verdict defaults to `reject` (never auto-passes incomplete reports).
 * - Explicit `reject` is always respected and never downgraded to `pass`.
 * - Any P0 or P1 finding forces `reject` even if the reviewer wrote `pass`.
 * - Workspace mutation or unverifiable read-only integrity forces `reject`.
 * - Explicit `pass` with only P2 findings (or none) passes without blocking.
 */
export function evaluateAdversarialVerdict(input: {
  verdict?: OrchestrationReviewVerdict | null;
  findings?: readonly OrchestrationReviewFinding[] | null;
  summary?: string;
  mutatedWorkspace?: boolean;
  verificationFailed?: boolean;
}): AdversarialVerdictEvaluation {
  const findings = normalizeReviewFindings(input.findings ?? []);
  const blockingFindings = findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
  const advisoryFindings = findings.filter((f) => f.severity === 'P2');

  const requestedVerdict: OrchestrationReviewVerdict =
    input.verdict === 'pass' ? 'pass' : 'reject';

  let effectiveVerdict: OrchestrationReviewVerdict = requestedVerdict;
  let overriddenByBlockingFindings = false;
  let overriddenByWorkspaceIntegrity = false;

  if (blockingFindings.length > 0 && effectiveVerdict === 'pass') {
    effectiveVerdict = 'reject';
    overriddenByBlockingFindings = true;
  }
  if ((input.mutatedWorkspace || input.verificationFailed) && effectiveVerdict === 'pass') {
    effectiveVerdict = 'reject';
    overriddenByWorkspaceIntegrity = true;
  }

  return {
    requestedVerdict,
    effectiveVerdict,
    overriddenByBlockingFindings,
    overriddenByWorkspaceIntegrity,
    blockingFindings,
    advisoryFindings,
    findings,
  };
}

/**
 * Builds an information-firewalled adversarial review task spec.
 * Deliberately omits the implementation worker's verbal summary so the reviewer relies strictly
 * on original requirements, constraints, acceptance criteria, and the immutable diff snapshot.
 */
export function buildAdversarialReviewTask(input: {
  targetRole: string;
  targetDispatchId: string;
  targetTaskSpec: string;
  targetTaskContext?: OrchestrationTaskContext | null;
  diff: WorkerDiffInspection;
  reviewFocus?: string | null;
  reviewRound: number;
  maxRounds?: number;
  mcpEnabled: boolean;
  cliCommand?: string;
}): { taskSpec: string; taskContext: OrchestrationTaskContext } {
  const maxRounds = input.maxRounds ?? MAX_ADVERSARIAL_REVIEW_ROUNDS;
  const cleanRole = input.targetRole.replace(/^@+/, '') || input.targetDispatchId;
  const focus = input.reviewFocus?.trim();
  const focusLine = focus ? `Focus Area: ${focus}` : 'Focus Area: Full-spectrum code review (correctness, validation, state transitions, edge cases, tests)';

  const taskSpecLines = [
    `Independent Read-Only Code Review (Round ${input.reviewRound}/${maxRounds}) of @${cleanRole} (${input.targetDispatchId}).`,
    focusLine,
    '',
    'Original Task Under Review (author summary omitted — verify directly from code and tests):',
    input.targetTaskSpec.trim(),
    '',
    'Review Guidelines:',
    '- READ-ONLY: Do NOT edit, commit, or fix project files in this review worktree (you may run read-only tests/checks).',
    '- Look carefully for hidden bugs, regressions, permission or validation gaps, edge-case failures, or missing cleanup, and verify directly by inspecting code or running checks.',
    '- Report ONLY real, verifiable defects with exact `file:line` location and concrete failure scenario/evidence. Do not block on cosmetic style nitpicks.',
    input.mcpEnabled
      ? '- When finished, call `report_done` with structured `verdict` ("pass" | "reject"), `findings` ([{ severity: "P0"|"P1"|"P2", location, title, evidence, fix }]), and a concise `summary`. Any P0/P1 blocks merge; P2 is advisory only.'
      : `- When finished, report with \`${input.cliCommand || 'aha'} orchestration worker-done --outcome completed --verdict pass|reject --summary "<verdict + findings>"\`.`,
  ];

  const changedPreview =
    input.diff.changedFiles.length > 0
      ? input.diff.changedFiles.slice(0, 25)
      : (input.targetTaskContext?.files ?? []);

  const backgroundParts = [
    ...(input.diff.baseCommit
      ? [`Git Scope: compare ${input.diff.baseCommit.slice(0, 12)}..${(input.diff.snapshotOid ?? input.diff.headCommit ?? 'HEAD').slice(0, 12)} (${input.diff.changedFiles.length} file(s), ${input.diff.commitsAhead} commit(s), ${input.diff.uncommittedFiles.length} uncommitted).`]
      : []),
    ...(input.diff.diffStat ? [`Diff Stat:\n${input.diff.diffStat}`] : []),
    ...(input.targetTaskContext?.background ? [`Original Coordinator Background:\n${input.targetTaskContext.background}`] : []),
  ];

  const constraints = [
    'Strictly read-only review: do not modify repository files',
    ...(input.targetTaskContext?.constraints ?? []),
  ];

  return {
    taskSpec: taskSpecLines.join('\n'),
    taskContext: {
      ...(backgroundParts.length > 0 ? { background: backgroundParts.join('\n\n') } : {}),
      constraints,
      ...(changedPreview.length > 0 ? { files: changedPreview } : {}),
      ...(input.targetTaskContext?.acceptance
        ? { acceptance: `Verify implementation satisfies: ${input.targetTaskContext.acceptance}` }
        : {}),
    },
  };
}

export interface RunIntegratedWorkerSummaryForReview {
  dispatchId: string;
  role: string;
  cliId?: string | null;
  taskSpec: string;
  taskContext?: OrchestrationTaskContext | null;
  integratedCommit?: string | null;
}

/**
 * Builds an information-firewalled Run-level overall secondary adversarial review brief
 * across the combined integrated changes of a Run. Deliberately omits all worker verbal
 * self-summaries and focuses on cross-worker integration defects, regressions, and end-to-end invariants.
 */
export function buildRunAdversarialReviewTask(input: {
  runId: string;
  runObjective: string;
  diff: RunCommitRangeDiffInspection;
  integratedWorkers: readonly RunIntegratedWorkerSummaryForReview[];
  reviewFocus?: string | null;
  reviewRound: number;
  maxRounds?: number;
  mcpEnabled: boolean;
  cliCommand?: string;
}): { taskSpec: string; taskContext: OrchestrationTaskContext } {
  const maxRounds = input.maxRounds ?? MAX_ADVERSARIAL_REVIEW_ROUNDS;
  const focus = input.reviewFocus?.trim();
  const focusLine = focus
    ? `Focus Area: ${focus}`
    : 'Focus Area: Combined Run-level secondary code review (cross-worker contract/wiring mismatches, end-to-end regressions, permission/validation invariants, concurrency/cleanup, and test coverage)';

  const workerSections: string[] = [];
  const allConstraints = new Set<string>(['Strictly read-only review: do not modify repository files']);
  const allAcceptance: string[] = [];

  for (const w of input.integratedWorkers.slice(0, 12)) {
    const cleanRole = w.role.replace(/^@+/, '') || w.dispatchId;
    const commitTag = w.integratedCommit ? ` @ ${w.integratedCommit.slice(0, 10)}` : '';
    const cliTag = w.cliId ? ` [${w.cliId}]` : '';
    workerSections.push(
      `- @${cleanRole} (${w.dispatchId}${cliTag}${commitTag}): ${w.taskSpec.trim().slice(0, 400)}`,
    );
    for (const c of w.taskContext?.constraints ?? []) {
      const trimmed = c.trim();
      if (trimmed) allConstraints.add(trimmed);
    }
    if (w.taskContext?.acceptance?.trim()) {
      allAcceptance.push(`@${cleanRole}: ${w.taskContext.acceptance.trim()}`);
    }
  }

  const taskSpecLines = [
    `Run-Level Overall Secondary Read-Only Code Review (Round ${input.reviewRound}/${maxRounds}) for Run ${input.runId}.`,
    focusLine,
    '',
    `Run Objective: ${input.runObjective.trim()}`,
    '',
    'Integrated Worker Original Requirements (author summaries omitted — verify combined code and tests directly):',
    ...(workerSections.length > 0 ? workerSections : ['- (Combined commits in Run range below)']),
    '',
    'Review Guidelines:',
    '- READ-ONLY: Do NOT edit, commit, or fix project files in this detached review worktree (you may run read-only tests/typechecks/checks).',
    '- Focus on the COMBINED diff across all integrated changes: look for cross-worker integration bugs, broken contracts/types/wiring, duplicated or conflicting state transitions, permission or validation gaps, cleanup leaks, and missing end-to-end test coverage.',
    '- Report ONLY real, verifiable defects with exact `file:line` location and concrete failure scenario/evidence. Do not block on cosmetic style nitpicks.',
    input.mcpEnabled
      ? '- When finished, call `report_done` with structured `verdict` ("pass" | "reject"), `findings` ([{ severity: "P0"|"P1"|"P2", location, title, evidence, fix }]), and a concise `summary`. Any P0/P1 blocks promotion/sign-off; P2 is advisory only.'
      : `- When finished, report with \`${input.cliCommand || 'aha'} orchestration worker-done --outcome completed --verdict pass|reject --summary "<verdict + findings>"\`.`,
  ];

  const changedPreview = input.diff.changedFiles.slice(0, 30);
  const backgroundParts = [
    ...(input.diff.baseCommit && input.diff.targetCommit
      ? [
          `Combined Git Scope: compare ${input.diff.baseCommit.slice(0, 12)}..${input.diff.targetCommit.slice(0, 12)}${input.diff.branch ? ` on ${input.diff.branch}` : ''} (${input.diff.changedFiles.length} file(s), ${input.diff.commitsAhead} commit(s)).`,
        ]
      : []),
    ...(input.diff.commits.length > 0
      ? [
          `Integrated Commits:\n${input.diff.commits
            .slice(0, 20)
            .map((c) => `- ${c.sha} ${c.subject}`)
            .join('\n')}`,
        ]
      : []),
    ...(input.diff.diffStat ? [`Combined Diff Stat:\n${input.diff.diffStat}`] : []),
  ];

  return {
    taskSpec: taskSpecLines.join('\n'),
    taskContext: {
      ...(backgroundParts.length > 0 ? { background: backgroundParts.join('\n\n') } : {}),
      constraints: [...allConstraints].slice(0, 20),
      ...(changedPreview.length > 0 ? { files: changedPreview } : {}),
      ...(allAcceptance.length > 0
        ? { acceptance: `Verify combined Run implementation satisfies:\n${allAcceptance.slice(0, 10).join('\n')}` }
        : {}),
    },
  };
}

export function formatReviewVerdictForBoard(input: {
  targetRole: string;
  reviewRound: number;
  maxRounds: number;
  evaluation: AdversarialVerdictEvaluation;
  escalated: boolean;
  mutatedWorkspace: boolean;
  summary: string;
  isRunReview?: boolean;
}): string {
  const { evaluation } = input;
  const tag = input.escalated
    ? `ESCALATED (Round ${input.reviewRound}/${input.maxRounds} limit reached)`
    : evaluation.effectiveVerdict === 'pass'
      ? `PASS (Round ${input.reviewRound})`
      : `REJECT (Round ${input.reviewRound}/${input.maxRounds})`;
  const headerPrefix = input.isRunReview
    ? `[Run Adversarial Review ${tag} · ${input.targetRole.replace(/^@+/, '')}]`
    : `[Adversarial Review ${tag} · @${input.targetRole.replace(/^@+/, '')}]`;
  const lines = [
    headerPrefix,
    ...(input.mutatedWorkspace
      ? ['Rejected: reviewer modified or failed integrity verification on its isolated read-only review worktree; changes were discarded.']
      : []),
    ...(evaluation.overriddenByBlockingFindings
      ? ['Verdict overridden to REJECT because blocking P0/P1 findings were reported.']
      : []),
    ...(input.summary.trim() ? [input.summary.trim()] : []),
  ];
  if (evaluation.blockingFindings.length > 0) {
    lines.push('', 'Blocking Findings (P0/P1):');
    for (const f of evaluation.blockingFindings) {
      lines.push(`- [${f.severity}] ${f.location} — ${f.title}: ${f.evidence}${f.fix ? ` (Fix: ${f.fix})` : ''}`);
    }
  }
  if (evaluation.advisoryFindings.length > 0) {
    lines.push('', `Advisory Findings (P2, non-blocking: ${evaluation.advisoryFindings.length}):`);
    for (const f of evaluation.advisoryFindings.slice(0, 5)) {
      lines.push(`- [P2] ${f.location} — ${f.title}`);
    }
  }
  return lines.join('\n');
}
