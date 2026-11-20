import type {
  OrchestrationReviewFinding,
  OrchestrationReviewSeverity,
  OrchestrationReviewVerdict,
  OrchestrationTaskContext,
} from './orchestration-types.js';
import type { WorkerDiffInspection } from './worker-git-integration.js';

export const MAX_ADVERSARIAL_REVIEW_ROUNDS = 2;
const MAX_FINDINGS = 25;

export interface AdversarialVerdictEvaluation {
  requestedVerdict: OrchestrationReviewVerdict;
  effectiveVerdict: OrchestrationReviewVerdict;
  overriddenByBlockingFindings: boolean;
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
 * Enforces the adversarial verdict contract:
 * - Any P0 or P1 finding forces `reject` even if the reviewer wrote `pass`.
 * - Only P2 findings (or none) never block integration unless the reviewer explicitly rejected with a reason.
 */
export function evaluateAdversarialVerdict(input: {
  verdict?: OrchestrationReviewVerdict | null;
  findings?: readonly OrchestrationReviewFinding[] | null;
  summary?: string;
}): AdversarialVerdictEvaluation {
  const findings = normalizeReviewFindings(input.findings ?? []);
  const blockingFindings = findings.filter((f) => f.severity === 'P0' || f.severity === 'P1');
  const advisoryFindings = findings.filter((f) => f.severity === 'P2');

  let requestedVerdict: OrchestrationReviewVerdict;
  if (input.verdict === 'pass' || input.verdict === 'reject') {
    requestedVerdict = input.verdict;
  } else if (blockingFindings.length > 0) {
    requestedVerdict = 'reject';
  } else if (/\b(reject|not ready to merge|do not merge|暂不建议合并)\b/i.test(input.summary ?? '')) {
    requestedVerdict = 'reject';
  } else {
    requestedVerdict = 'pass';
  }

  let effectiveVerdict: OrchestrationReviewVerdict = requestedVerdict;
  let overriddenByBlockingFindings = false;
  if (blockingFindings.length > 0 && requestedVerdict === 'pass') {
    effectiveVerdict = 'reject';
    overriddenByBlockingFindings = true;
  } else if (blockingFindings.length === 0 && advisoryFindings.length > 0 && requestedVerdict === 'reject') {
    // Advisory-only P2 items must not block integration.
    effectiveVerdict = 'pass';
  }

  return {
    requestedVerdict,
    effectiveVerdict,
    overriddenByBlockingFindings,
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
  const focusLine = focus ? `Focus Area: ${focus}` : 'Focus Area: Full-spectrum adversarial audit (correctness, security, state transitions, edge cases, tests)';

  const taskSpecLines = [
    `Adversarial Read-Only Review (Round ${input.reviewRound}/${maxRounds}) of @${cleanRole} (${input.targetDispatchId}).`,
    focusLine,
    '',
    'Original Task Under Review (author verbal summary intentionally withheld — verify directly from code and tests):',
    input.targetTaskSpec.trim(),
    '',
    'Adversarial Rules:',
    '- READ-ONLY: Do NOT edit, commit, or fix project files in this review worktree (you may run read-only tests/checks).',
    '- Assume hidden bugs, regressions, security/auth bypasses, edge-case failures, or missing cleanup exist until disproven by code inspection or execution.',
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

export function formatReviewVerdictForBoard(input: {
  targetRole: string;
  reviewRound: number;
  maxRounds: number;
  evaluation: AdversarialVerdictEvaluation;
  escalated: boolean;
  mutatedWorkspace: boolean;
  summary: string;
}): string {
  const { evaluation } = input;
  const tag = input.escalated
    ? `ESCALATED (Round ${input.reviewRound}/${input.maxRounds} limit reached)`
    : evaluation.effectiveVerdict === 'pass'
      ? `PASS (Round ${input.reviewRound})`
      : `REJECT (Round ${input.reviewRound}/${input.maxRounds})`;
  const lines = [
    `[Adversarial Review ${tag} · @${input.targetRole.replace(/^@+/, '')}]`,
    ...(input.mutatedWorkspace
      ? ['Warning: reviewer modified its isolated review worktree; changes were discarded.']
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
