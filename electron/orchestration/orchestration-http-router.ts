import { AGENT_SESSION_ID } from './agent-session-manager.js';
import { HEADLESS_SUB_WORKER_ACTIONS, HEADLESS_WORKER_ID } from './headless-workers.js';
import { z } from 'zod';
import { OrchestrationService } from './orchestration-service.js';
import { taskContextFields } from './task-context-schema.js';
import {
  ORCHESTRATION_BOARD_POST_KINDS,
  ORCHESTRATION_MESSAGE_TYPES,
  ORCHESTRATION_TASK_KINDS,
  OrchestrationError,
} from './orchestration-types.js';

const boardPostKindEnum = z.enum(ORCHESTRATION_BOARD_POST_KINDS);
const messageTypeEnum = z.enum(ORCHESTRATION_MESSAGE_TYPES);
const taskKindEnum = z.enum(ORCHESTRATION_TASK_KINDS);
const priorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
const taskStatusEnum = z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']);
const gateStatusEnum = z.enum(['pending', 'resolved', 'timeout']);
const workerOutcomeEnum = z
  .enum(['completed', 'succeeded', 'failed', 'blocked', 'escalated', 'abandoned'])
  .transform((v) => (v === 'succeeded' ? 'completed' : v));

const runCreateSchema = z.object({
  id: z.string().trim().min(1).optional(),
  objective: z.string().trim().min(1),
  from: z.string().trim().min(1).optional(),
  paneId: z.string().trim().min(1).optional(),
});

const runUseSchema = z.object({
  id: z.string().trim().min(1),
  from: z.string().trim().min(1).optional(),
  paneId: z.string().trim().min(1).optional(),
});

const runCurrentSchema = z.object({
  from: z.string().trim().min(1).optional(),
});

const runListSchema = z.object({
  status: z.string().trim().min(1).optional(),
});

const runShowSchema = z.object({
  id: z.string().trim().min(1),
});

const taskCreateSchema = z.object({
  id: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  spec: z.string().trim().min(1),
  ...taskContextFields,
  taskTitle: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  deps: z.array(z.string().trim().min(1)).optional(),
  codeDeps: z.array(z.string().trim().min(1)).max(100).optional(),
  priority: priorityEnum.optional(),
  worktreePath: z.string().trim().min(1).optional(),
});

const taskListSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  status: taskStatusEnum.optional(),
  priority: priorityEnum.optional(),
});

const taskShowSchema = z.object({
  id: z.string().trim().min(1),
});

const taskUpdateSchema = z.object({
  id: z.string().trim().min(1),
  status: taskStatusEnum,
});

const dispatchSchema = z.object({
  taskId: z.string().trim().min(1),
  to: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  inject: z.boolean().optional(),
  dryRun: z.boolean().optional(),
});

const dispatchShowSchema = z.object({
  taskId: z.string().trim().min(1),
  preamble: z.boolean().optional(),
});

const coordinatorStartSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  spec: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  pollIntervalMs: z.number().int().min(50).max(60_000).optional(),
  maxConcurrent: z.number().int().min(1).max(32).optional(),
  autoSpawnWorkers: z.boolean().optional(),
  workerCliId: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  workerPaneIds: z.array(z.string().trim().min(1)).max(64).optional(),
});

const coordinatorTickSchema = z.object({
  runId: z.string().trim().min(1).optional(),
});

const coordinatorStatusSchema = z.object({
  runId: z.string().trim().min(1).optional(),
});

const sendSchema = z.object({
  capability: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  type: messageTypeEnum.optional(),
  priority: priorityEnum.optional(),
  subject: z.string().trim().min(1),
  body: z.string().optional(),
  payload: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
  runId: z.string().trim().min(1).optional(),
  threadId: z.string().trim().min(1).optional(),
});

const reviewVerdictEnum = z.enum(['pass', 'reject']);
const reviewFindingSchema = z.object({
  severity: z.enum(['P0', 'P1', 'P2']),
  location: z.string().trim().min(1).max(240),
  title: z.string().trim().min(1).max(240),
  evidence: z.string().trim().min(1).max(1_200),
  fix: z.string().trim().max(800).optional(),
});

const workerDoneSchema = z.object({
  capability: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  dispatchId: z.string().trim().min(1).optional(),
  outcome: workerOutcomeEnum.optional(),
  summary: z.string().optional(),
  verdict: reviewVerdictEnum.optional(),
  findings: z.array(reviewFindingSchema).max(25).optional(),
});

const workerStartSchema = z.object({
  from: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  spec: z.string().trim().min(1).optional(),
  ...taskContextFields,
  taskTitle: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  deps: z.array(z.string().trim().min(1)).optional(),
  codeDeps: z.array(z.string().trim().min(1)).max(100).optional(),
  priority: priorityEnum.optional(),
  retryOfDispatchId: z.string().trim().min(1).optional(),
  reviewOf: z.string().trim().min(1).max(128).optional(),
  reviewRun: z.union([z.boolean(), z.string().trim().min(1).max(128)]).optional(),
  reviewFocus: z.string().trim().min(1).max(400).optional(),
  confirmed: z.boolean().optional(),
  proposalId: z.string().trim().min(1).max(128).optional(),
  authorizeReviews: z.boolean().optional(),
  cliId: z.string().trim().min(1).optional(),
  agent: z.string().trim().min(1).optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  terminal: z.string().trim().min(1).optional(),
  readOnly: z.boolean().optional(),
  policy: z.enum(['read-only', 'workspace-write', 'full-auto']).optional(),
  network: z.boolean().optional(),
  allowSubWorkers: z.boolean().optional(),
  worktree: z.union([z.string().trim(), z.boolean()]).optional(),
  noWorktree: z.boolean().optional(),
  branch: z.string().trim().min(1).optional(),
  baseBranch: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).optional(),
  cwd: z.string().trim().min(1).optional(),
  callerCwd: z.string().trim().min(1).optional(),
  keepOpen: z.boolean().optional(),
});

const workerListSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  status: z.enum(['pending', 'dispatched', 'completed', 'failed', 'circuit_broken']).optional(),
  includeSettled: z.boolean().optional(),
});

const workerTargetSchema = z.object({
  dispatchId: z.string().trim().min(1).optional(),
  worker: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
});

const workerReadSchema = workerTargetSchema.extend({
  cursor: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).max(256_000).optional(),
  screen: z.boolean().optional(),
});

const workerKeepOpenSchema = workerTargetSchema.extend({
  keepOpen: z.boolean().optional(),
});

const workerReleaseSchema = workerTargetSchema.extend({
  keepPane: z.boolean().optional(),
  keepWorktree: z.boolean().optional(),
  force: z.boolean().optional(),
});

const workerStopSchema = workerTargetSchema.extend({
  reason: z.string().optional(),
  removeWorktree: z.boolean().optional(),
  force: z.boolean().optional(),
});

const workerAbandonSchema = workerTargetSchema.extend({
  reason: z.string().optional(),
});

const resetSchema = z.object({
  all: z.boolean().optional(),
  tasks: z.boolean().optional(),
  messages: z.boolean().optional(),
});

const approveSchema = z.object({
  id: z.string().trim().min(1),
  dispatchId: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  reason: z.string().optional(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
});

const denySchema = z.object({
  id: z.string().trim().min(1),
  dispatchId: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  reason: z.string().optional(),
});

const checkSchema = z.object({
  from: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  unread: z.boolean().optional(),
  peek: z.boolean().optional(),
  all: z.boolean().optional(),
  wait: z.boolean().optional(),
  timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
  types: z.array(messageTypeEnum).optional(),
  ack: z.string().trim().min(1).optional(),
  holdAck: z.boolean().optional(),
  format: z.boolean().optional(),
});

const inboxSchema = z.object({
  from: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  types: z.array(messageTypeEnum).optional(),
  unreadOnly: z.boolean().optional(),
});

const askSchema = z.object({
  capability: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  to: z.string().trim().min(1).optional(),
  question: z.string().trim().min(1).optional(),
  options: z.array(z.string().trim().min(1)).optional(),
  wait: z.boolean().optional(),
  timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
  resume: z.string().trim().min(1).optional(),
  dispatchId: z.string().trim().min(1).optional(),
  runId: z.string().trim().min(1).optional(),
});

const replySchema = z.object({
  id: z.string().trim().min(1),
  body: z.string().trim().min(1),
  from: z.string().trim().min(1).optional(),
});

const gateCreateSchema = z.object({
  taskId: z.string().trim().min(1),
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).optional(),
  from: z.string().trim().min(1).optional(),
});

const gateResolveSchema = z.object({
  id: z.string().trim().min(1),
  resolution: z.string().trim().min(1),
  from: z.string().trim().min(1).optional(),
});

const gateListSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  status: gateStatusEnum.optional(),
});

const snapshotSchema = z.object({
  runId: z.string().trim().min(1).optional(),
});

const agentsSchema = z.object({
  callerPaneId: z.string().trim().min(1).optional(),
});

const mcpContextSchema = z.object({
  ptyId: z.string().trim().min(1).optional(),
});

const workerDiffSchema = z.object({
  dispatchId: z.string().trim().min(1).optional(),
  worker: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  files: z.array(z.string().trim().min(1).max(400)).max(30).optional(),
  maxDiffBytes: z.number().int().min(1_024).max(131_072).optional(),
});

const workerIntegrateSchema = z.object({
  dispatchId: z.string().trim().min(1).optional(),
  worker: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  mode: z.enum(['check', 'squash', 'merge']).optional(),
  targetBranch: z.enum(['main', 'integration', 'auto']).optional(),
  expectedSnapshotOid: z.string().trim().min(7).max(40).optional(),
  commitMessage: z.string().trim().min(1).max(500).optional(),
  releaseAfter: z.boolean().optional(),
  deleteBranch: z.boolean().optional(),
  force: z.boolean().optional(),
});

const runDiffSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  files: z.array(z.string().trim().min(1).max(400)).max(30).optional(),
  maxDiffBytes: z.number().int().min(1_024).max(131_072).optional(),
});

const runFinalizeSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  mode: z.enum(['check', 'squash', 'merge']).optional(),
  expectedSnapshotOid: z.string().trim().min(7).max(40).optional(),
  commitMessage: z.string().trim().min(1).max(500).optional(),
  deleteBranch: z.boolean().optional(),
  keepWorktree: z.boolean().optional(),
  force: z.boolean().optional(),
});

const delegateTaskSchema = z.object({
  from: z.string().trim().min(1).optional(),
  role: z.string().trim().max(120).optional(),
  task: z.string().trim().min(1).optional(),
  reviewOf: z.string().trim().min(1).max(128).optional(),
  reviewRun: z.union([z.boolean(), z.string().trim().min(1).max(128)]).optional(),
  reviewFocus: z.string().trim().min(1).max(400).optional(),
  authorizeReviews: z.boolean().optional(),
  ...taskContextFields,
  agent: z.string().trim().min(1).optional(),
  taskKind: taskKindEnum.optional(),
  deps: z.array(z.string().trim().min(1)).max(100).optional(),
  codeDeps: z.array(z.string().trim().min(1)).max(100).optional(),
  baseBranch: z.string().trim().min(1).optional(),
  worktree: z.boolean().optional(),
  model: z.string().trim().min(1).optional(),
  effort: z.string().trim().min(1).optional(),
  terminal: z.string().trim().min(1).optional(),
  policy: z.enum(['read-only', 'workspace-write', 'full-auto']).optional(),
  network: z.boolean().optional(),
  allowSubWorkers: z.boolean().optional(),
  confirmed: z.boolean().optional(),
  proposalId: z.string().trim().min(1).max(128).optional(),
  planSummary: z.string().trim().max(1_000).optional(),
  runId: z.string().trim().min(1).optional(),
  callerCwd: z.string().trim().min(1).optional(),
}).refine((val) => Boolean(val.task || val.reviewOf || val.reviewRun), {
  message: 'Either task, reviewOf, or reviewRun is required.',
});

const workerDoneSelfSchema = z.object({
  from: z.string().trim().min(1).optional(),
  outcome: workerOutcomeEnum.optional(),
  summary: z.string().trim().min(1),
  verdict: reviewVerdictEnum.optional(),
  findings: z.array(reviewFindingSchema).max(25).optional(),
});

const askSelfSchema = z.object({
  from: z.string().trim().min(1).optional(),
  question: z.string().trim().min(1),
  options: z.array(z.string().trim().min(1)).optional(),
  wait: z.boolean().optional(),
  timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
});

const proposalApproveSchema = z.object({
  id: z.string().trim().min(1),
  agent: z.string().trim().min(1).optional(),
  worktree: z.boolean().optional(),
  model: z.union([z.string().trim().min(1), z.null()]).optional(),
  effort: z.union([z.string().trim().min(1), z.null()]).optional(),
  policy: z.union([z.enum(['read-only', 'workspace-write', 'full-auto']), z.null()]).optional(),
  network: z.union([z.boolean(), z.null()]).optional(),
  allowSubWorkers: z.boolean().optional(),
  authorizeReviews: z.boolean().optional(),
});

const proposalRejectSchema = z.object({
  id: z.string().trim().min(1),
  reason: z.string().max(4_000).optional(),
});

const paneModeSetSchema = z.object({
  ptyId: z.string().trim().min(1).optional(),
  enabled: z.boolean(),
});

const roleMessageSchema = z.object({
  from: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1),
  message: z.string().trim().min(1),
  subject: z.string().trim().min(1).optional(),
});

const roleManageSchema = z.object({
  from: z.string().trim().min(1).optional(),
  role: z.string().trim().min(1),
  action: z.enum(['read', 'approve', 'deny', 'release', 'stop']),
  reason: z.string().max(4_000).optional(),
  force: z.boolean().optional(),
  screen: z.boolean().optional(),
});

const boardPostSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  text: z.string().trim().min(1).max(64_000),
  kind: boardPostKindEnum.optional(),
  subject: z.string().trim().min(1).max(500).optional(),
  isUser: z.boolean().optional(),
});

const boardReadSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  since: z.number().int().min(0).optional(),
  seqs: z.array(z.number().int().min(1)).max(200).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  markRead: z.boolean().optional(),
});

const boardWaitSchema = z.object({
  runId: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  since: z.number().int().min(0).optional(),
  mentionsOnly: z.boolean().optional(),
  timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
});

export interface OrchestrationHttpDispatchResult {
  status: number;
  body: Record<string, unknown>;
}

export function isLongPollOrchestrationAction(action: string): boolean {
  return (
    action === 'check' ||
    action === 'ask' ||
    action === 'ask-self' ||
    action === 'delegate-task' ||
    action === 'board-wait' ||
    action === 'role-manage' ||
    action === 'worker-integrate' ||
    action === 'run-finalize'
  );
}

/** Reads skip the durability barrier; every mutation is fsynced before its receipt is returned. */
// Worker MCP tools, scoped reads, and mailbox operations. check handles acknowledgments
// and send handles heartbeats without exposing the Coordinator's management actions.
const CODEX_WORKER_ACTIONS = new Set([
  'mcp-context',
  'worker-done-self',
  'ask-self',
  'board-post',
  'board-read',
  'board-wait',
  'check',
  'inbox',
  'send',
  'run-current',
  'run-show',
  'task-list',
  'task-show',
  'dispatch-show',
  'worker-list',
  'worker-show',
  'worker-read',
  'worker-diff',
]);

// What the Coordinator MCP tools call, plus scoped reads. Raw starts (worker-start, dispatch) and
// run binding stay closed so every new Worker passes through delegate-task and its user-confirmation gate.
const AGENT_SESSION_COORDINATOR_ACTIONS = new Set([
  'mcp-context',
  'agents',
  'delegate-task',
  'role-message',
  'role-manage',
  'board-post',
  'board-read',
  'board-wait',
  'check',
  'inbox',
  'worker-diff',
  'worker-integrate',
  'run-diff',
  'run-finalize',
  'run-current',
  'run-show',
  'task-list',
  'task-show',
  'dispatch-show',
  'worker-list',
  'worker-show',
  'worker-read',
  'coordinator-status',
]);

const READ_ONLY_ORCHESTRATION_ACTIONS = new Set([
  'run-current',
  'run-list',
  'run-show',
  'run-diff',
  'task-list',
  'task-show',
  'dispatch-show',
  'worker-list',
  'worker-show',
  'worker-read',
  'worker-diff',
  'coordinator-status',
  'gate-list',
  'inbox',
  'snapshot',
  'agents',
  'mcp-context',
]);

export async function dispatchOrchestrationHttpAction(
  service: OrchestrationService,
  action: string,
  rawPayload: unknown,
  context: { signal: AbortSignal; callerPaneId?: string | null }
): Promise<OrchestrationHttpDispatchResult> {
  const payload =
    typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const formatReceipt = payload.receiptText === true;
  const full = payload.full === true;
  const codexCaller = context.callerPaneId && HEADLESS_WORKER_ID.test(context.callerPaneId)
    ? context.callerPaneId : null;
  const sessionCaller = context.callerPaneId && AGENT_SESSION_ID.test(context.callerPaneId)
    ? context.callerPaneId : null;
  const requireCallerPane = (): string => {
    if (!context.callerPaneId || !service.isAuthenticatedCallerActive(context.callerPaneId, action === 'mcp-context', action === 'worker-done-self')) {
      throw new OrchestrationError(
        'operation_rejected',
        sessionCaller
          ? 'This Agent session is not in orchestration mode.'
          : 'This action requires an authenticated AhaStation terminal or an active headless Worker.'
      );
    }
    return context.callerPaneId;
  };
  const httpCallerPane = (): string | undefined => context.callerPaneId === undefined ? undefined : requireCallerPane();
  const scopedRunId = (runId?: string): string | undefined => {
    const pane = httpCallerPane();
    return pane === undefined ? runId : service.authorizeRunAccess(runId, pane);
  };
  const assertWorkerTarget = (target?: string): void => {
    if (target && context.callerPaneId !== undefined && service.isCoordinatorTerminal(target)) {
      throw new OrchestrationError('terminal_is_coordinator', 'Choose a worker terminal. This pane coordinates a run.');
    }
  };

  try {
    if (codexCaller) {
      requireCallerPane();
      // Sub-Worker actions open only while the Worker's own dispatch allows them.
      if (!CODEX_WORKER_ACTIONS.has(action) &&
          !(HEADLESS_SUB_WORKER_ACTIONS.has(action) && service.canHeadlessWorkerDelegate(codexCaller))) {
        throw new OrchestrationError('operation_rejected', 'This action is unavailable to headless Workers.');
      }
    }
    if (sessionCaller) {
      requireCallerPane();
      if (!AGENT_SESSION_COORDINATOR_ACTIONS.has(action)) {
        throw new OrchestrationError('operation_rejected', 'This action is unavailable to an Agent session Coordinator.');
      }
      await service.gateSessionCoordinatorAction(sessionCaller, action, payload, context.signal);
    }
    let result: unknown;
    switch (action) {
      case 'run-create': {
        const parsed = runCreateSchema.parse(payload);
        const caller = context.callerPaneId;
        result = service.runCreate(caller ? { ...parsed, from: caller, paneId: caller } : parsed);
        break;
      }
      case 'run-use': {
        const parsed = runUseSchema.parse(payload);
        const caller = requireCallerPane();
        service.assertCanBindRunCoordinator(parsed.id, caller);
        result = service.runUse({ ...parsed, from: caller, paneId: caller });
        break;
      }
      case 'run-current':
        result = service.runCurrent(codexCaller ? { from: codexCaller } : runCurrentSchema.parse(payload));
        break;
      case 'run-list':
        result = service.runList(runListSchema.parse(payload));
        break;
      case 'run-show':
        result = service.runShow(runShowSchema.parse(payload).id, httpCallerPane());
        break;
      case 'run-diff':
        result = await service.runDiff(runDiffSchema.parse(payload), httpCallerPane());
        break;
      case 'run-finalize':
        result = await service.runFinalizeIntegration(runFinalizeSchema.parse(payload), httpCallerPane());
        break;
      case 'task-create': {
        const parsed = taskCreateSchema.parse(payload);
        result = service.taskCreate({ ...parsed, runId: scopedRunId(parsed.runId) });
        break;
      }
      case 'task-list': {
        const parsed = taskListSchema.parse(payload);
        result = service.taskList({ ...parsed, runId: scopedRunId(parsed.runId) }, httpCallerPane());
        break;
      }
      case 'task-show':
        result = service.taskShow(taskShowSchema.parse(payload), httpCallerPane());
        break;
      case 'task-update': {
        const parsed = taskUpdateSchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          service.assertTaskCoordinator(parsed.id, requireCallerPane());
        }
        result = service.taskUpdate(parsed);
        break;
      }
      case 'dispatch': {
        const parsed = dispatchSchema.parse(payload);
        if (!parsed.dryRun && parsed.inject !== false) assertWorkerTarget(parsed.to);
        result = await service.dispatchTask({
          ...parsed,
          ...(context.callerPaneId !== undefined ? { callerPaneId: requireCallerPane() } : {}),
        });
        break;
      }
      case 'dispatch-show':
        result = service.dispatchShow({
          ...dispatchShowSchema.parse(payload),
          ...(context.callerPaneId !== undefined ? { callerPaneId: requireCallerPane() } : {}),
        });
        break;
      case 'coordinator-start': {
        const parsed = coordinatorStartSchema.parse(payload);
        const pane = httpCallerPane();
        if (pane !== undefined) {
          service.assertCanControlCoordinatorLoop(pane, parsed.runId);
        }
        result = service.coordinatorStart(pane === undefined ? parsed : { ...parsed, from: pane });
        break;
      }
      case 'coordinator-stop': {
        const pane = httpCallerPane();
        if (pane !== undefined) {
          service.assertCanControlCoordinatorLoop(pane, service.coordinatorLoopRunId());
        }
        result = service.coordinatorStop();
        break;
      }
      case 'coordinator-tick': {
        const parsed = coordinatorTickSchema.parse(payload);
        const pane = httpCallerPane();
        if (pane !== undefined) {
          const runId = service.coordinatorLoopRunId(parsed.runId) ?? service.authorizeRunAccess(undefined, pane);
          service.assertCanControlCoordinatorLoop(pane, runId);
        }
        result = await service.coordinatorTick(parsed.runId);
        break;
      }
      case 'coordinator-status':
        result = service.coordinatorStatus(coordinatorStatusSchema.parse(payload));
        break;
      case 'send': {
        const parsed = sendSchema.parse(payload);
        result = codexCaller ? service.sendFromCodexWorker(codexCaller, parsed) : await service.send(parsed);
        break;
      }
      case 'worker-done':
        result = await service.workerDoneWithArtifacts(workerDoneSchema.parse(payload));
        break;
      case 'task-done':
        result = await service.workerDoneWithArtifacts({
          ...workerDoneSchema.parse(payload),
          outcome: 'completed',
        });
        break;
      case 'task-fail':
        result = await service.workerDoneWithArtifacts({
          ...workerDoneSchema.parse(payload),
          outcome: 'failed',
        });
        break;
      case 'worker-start': {
        const parsed = workerStartSchema.parse(payload);
        assertWorkerTarget(parsed.terminal);
        const pane = httpCallerPane();
        const isReviewStart = Boolean(
          parsed.reviewOf?.trim() ||
            parsed.reviewRun === true ||
            (typeof parsed.reviewRun === 'string' && parsed.reviewRun.trim().length > 0),
        );
        if (isReviewStart) {
          const delegated = await service.delegateTask(
            {
              from: pane ?? parsed.from ?? 'coordinator',
              callerPaneId: pane,
              runId: parsed.runId,
              role: parsed.displayName || parsed.name,
              task: parsed.spec,
              reviewOf: parsed.reviewOf,
              reviewRun: parsed.reviewRun,
              reviewFocus: parsed.reviewFocus,
              confirmed: parsed.confirmed,
              proposalId: parsed.proposalId,
              authorizeReviews: parsed.authorizeReviews,
              agent: parsed.cliId ?? parsed.agent,
              model: parsed.model,
              effort: parsed.effort,
              terminal: parsed.terminal,
              worktree: parsed.noWorktree ? false : undefined,
              callerCwd: parsed.callerCwd ?? parsed.cwd,
              userInitiated: false,
            },
            context.signal,
          );
          if (delegated.status !== 'started') {
            const proposalHint = delegated.proposal?.id
              ? ` (proposalId=${delegated.proposal.id}; after user confirmation retry with --confirmed --proposal-id ${delegated.proposal.id})`
              : '';
            throw new OrchestrationError(
              'operation_rejected',
              `${delegated.message || 'Review dispatch requires user confirmation before starting.'}${proposalHint}`,
              delegated.proposal ? { proposal: delegated.proposal } : undefined,
            );
          }
          result = delegated;
        } else {
          result = await service.workerStart(
            pane === undefined ? parsed : { ...parsed, from: pane, callerPaneId: pane },
          );
        }
        break;
      }
      case 'worker-list': {
        const parsed = workerListSchema.parse(payload);
        result = service.workerList({ ...parsed, runId: scopedRunId(parsed.runId) }, httpCallerPane());
        break;
      }
      case 'worker-show':
        result = service.workerShow(workerTargetSchema.parse(payload), httpCallerPane());
        break;
      case 'worker-read':
        result = service.workerRead(workerReadSchema.parse(payload), httpCallerPane());
        break;
      case 'worker-diff':
        result = await service.workerDiff(workerDiffSchema.parse(payload), httpCallerPane());
        break;
      case 'worker-integrate':
        result = await service.workerIntegrate(workerIntegrateSchema.parse(payload), httpCallerPane());
        break;
      case 'worker-keep-open':
      case 'worker-retain': {
        const parsed = workerKeepOpenSchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          service.assertWorkerController(parsed, requireCallerPane());
        }
        result = service.workerKeepOpen(parsed);
        break;
      }
      case 'worker-release': {
        const parsed = workerReleaseSchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          service.assertWorkerController(parsed, requireCallerPane());
        }
        result = await service.workerRelease(parsed);
        break;
      }
      case 'worker-stop': {
        const parsed = workerStopSchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          service.assertWorkerController(parsed, requireCallerPane());
        }
        result = await service.workerStop(parsed);
        break;
      }
      case 'worker-abandon': {
        const parsed = workerAbandonSchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          service.assertWorkerController(parsed, requireCallerPane());
        }
        result = service.workerAbandon(parsed);
        break;
      }
      case 'reset': {
        const parsed = resetSchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          service.assertNotActiveWorker(requireCallerPane());
        }
        result = service.reset(parsed);
        break;
      }
      case 'approve': {
        const caller = requireCallerPane();
        result = service.approve(approveSchema.parse(payload), caller);
        break;
      }
      case 'deny': {
        const caller = requireCallerPane();
        result = service.deny(denySchema.parse(payload), caller);
        break;
      }
      case 'check':
        result = await service.check({
          ...checkSchema.parse(payload), ...(sessionCaller ? { from: sessionCaller } : {}), callerPaneId: httpCallerPane(),
        }, context.signal);
        break;
      case 'inbox':
        result = service.inbox({
          ...inboxSchema.parse(payload), ...(sessionCaller ? { from: sessionCaller } : {}), callerPaneId: httpCallerPane(),
        });
        break;
      case 'ask':
        result = await service.ask(askSchema.parse(payload), context.signal);
        break;
      case 'reply': {
        const parsed = replySchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          const caller = requireCallerPane();
          service.assertCanReply(parsed.id, caller);
          result = service.reply({ ...parsed, from: caller });
        } else {
          result = service.reply(parsed);
        }
        break;
      }
      case 'gate-create':
        result = service.gateCreate(gateCreateSchema.parse(payload));
        break;
      case 'gate-resolve': {
        const caller = requireCallerPane();
        result = service.gateResolve(gateResolveSchema.parse(payload), caller);
        break;
      }
      case 'gate-list':
        result = service.gateList(gateListSchema.parse(payload));
        break;
      case 'snapshot':
        result = service.getSnapshot(
          snapshotSchema.parse(payload).runId,
          httpCallerPane(),
        );
        break;
      case 'agents': {
        const parsed = agentsSchema.parse(payload);
        result = {
          agents: service.listCodingAgents(sessionCaller ?? parsed.callerPaneId ?? context.callerPaneId ?? null),
        };
        break;
      }
      case 'mcp-context': {
        const parsed = mcpContextSchema.parse(payload);
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.ptyId || 'coordinator';
        result = service.getMcpContextForPane(caller);
        break;
      }
      case 'delegate-task': {
        const parsed = delegateTaskSchema.parse(payload);
        assertWorkerTarget(parsed.terminal);
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.from || 'coordinator';
        result = await service.delegateTask(
          {
            ...parsed,
            from: caller,
            callerPaneId: context.callerPaneId ?? undefined,
            userInitiated: false,
          },
          context.signal
        );
        break;
      }
      case 'worker-done-self': {
        const parsed = workerDoneSelfSchema.parse(payload);
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.from || '';
        result = await service.workerDoneByPane(caller, {
          outcome: parsed.outcome,
          summary: parsed.summary,
          verdict: parsed.verdict,
          findings: parsed.findings,
        });
        break;
      }
      case 'ask-self': {
        const parsed = askSelfSchema.parse(payload);
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.from || '';
        result = await service.askCoordinatorByPane(
          caller,
          {
            question: parsed.question,
            options: parsed.options,
            wait: parsed.wait,
            timeoutMs: parsed.timeoutMs,
          },
          context.signal
        );
        break;
      }
      case 'proposal-approve': {
        const parsed = proposalApproveSchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          throw new OrchestrationError(
            'operation_rejected',
            'Dispatch proposals can only be approved or rejected from the AhaStation UI.'
          );
        }
        result = service.approveDispatchProposal(parsed.id, {
          agent: parsed.agent,
          worktree: parsed.worktree,
          model: parsed.model,
          effort: parsed.effort,
          ...(parsed.policy !== undefined ? { policy: parsed.policy } : {}),
          ...(parsed.network !== undefined ? { network: parsed.network } : {}),
          ...(parsed.allowSubWorkers !== undefined ? { allowSubWorkers: parsed.allowSubWorkers } : {}),
          ...(parsed.authorizeReviews !== undefined ? { authorizeReviews: parsed.authorizeReviews } : {}),
        });
        break;
      }
      case 'proposal-reject': {
        const parsed = proposalRejectSchema.parse(payload);
        if (context.callerPaneId !== undefined) {
          throw new OrchestrationError(
            'operation_rejected',
            'Dispatch proposals can only be approved or rejected from the AhaStation UI.'
          );
        }
        result = service.rejectDispatchProposal(parsed.id, parsed.reason);
        break;
      }
      case 'pane-mode-set': {
        const parsed = paneModeSetSchema.parse(payload);
        let targetPtyId: string;
        if (context.callerPaneId !== undefined) {
          const caller = requireCallerPane();
          if (parsed.ptyId && parsed.ptyId !== caller) {
            throw new OrchestrationError(
              'operation_rejected',
              'A terminal pane may only change its own orchestration mode.'
            );
          }
          targetPtyId = caller;
        } else {
          targetPtyId = parsed.ptyId ?? requireCallerPane();
        }
        result = service.setPaneOrchestrationMode(targetPtyId, parsed.enabled);
        break;
      }
      case 'role-message': {
        const parsed = roleMessageSchema.parse(payload);
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.from || 'coordinator';
        result = await service.messageWorkerByRole(caller, {
          role: parsed.role,
          message: parsed.message,
          subject: parsed.subject,
        });
        break;
      }
      case 'role-manage': {
        const parsed = roleManageSchema.parse(payload);
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.from || 'coordinator';
        result = await service.manageWorkerByRole(caller, {
          role: parsed.role,
          action: parsed.action,
          reason: parsed.reason,
          force: parsed.force,
          screen: parsed.screen,
        });
        break;
      }
      case 'board-post': {
        const parsed = boardPostSchema.parse(payload);
        if (parsed.isUser === true) {
          throw new OrchestrationError(
            'operation_rejected',
            'Cannot post as @user over HTTP; use the AhaStation UI.'
          );
        }
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.from || 'coordinator';
        result = await service.boardPost({
          runId: parsed.runId,
          from: caller,
          text: parsed.text,
          kind: parsed.kind,
          subject: parsed.subject,
          isUser: false,
        });
        break;
      }
      case 'board-read': {
        const parsed = boardReadSchema.parse(payload);
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.from || 'coordinator';
        result = service.boardRead({
          runId: parsed.runId,
          from: caller,
          since: parsed.since,
          seqs: parsed.seqs,
          limit: parsed.limit,
          markRead: parsed.markRead,
          isUser: false,
        });
        break;
      }
      case 'board-wait': {
        const parsed = boardWaitSchema.parse(payload);
        const caller =
          context.callerPaneId !== undefined
            ? requireCallerPane()
            : parsed.from || 'coordinator';
        result = await service.boardWait(
          {
            runId: parsed.runId,
            from: caller,
            since: parsed.since,
            mentionsOnly: parsed.mentionsOnly,
            timeoutMs: parsed.timeoutMs,
          },
          context.signal
        );
        break;
      }
      default:
        return {
          status: 404,
          body: { ok: false, code: 'not_found', error: `Unknown orchestration action: ${action}` },
        };
    }

    if (!READ_ONLY_ORCHESTRATION_ACTIONS.has(action)) {
      // Do not acknowledge a mutation before the snapshot is durable on disk.
      await service.waitForPendingWrites();
    }

    const receiptText = formatReceipt
      ? service.formatActionReceiptText(action, result, { full })
      : undefined;

    return {
      status: 200,
      body: {
        ok: true,
        result,
        ...(receiptText !== undefined ? { receiptText } : {}),
      },
    };
  } catch (error) {
    if (error instanceof z.ZodError) {
      return {
        status: 400,
        body: {
          ok: false,
          code: 'invalid_argument',
          error: error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '),
        },
      };
    }
    if (error instanceof OrchestrationError) {
      const status =
        error.code === 'not_found' ||
        error.code === 'run_not_found' ||
        error.code === 'task_not_found' ||
        error.code === 'dispatch_not_found' ||
        error.code === 'delivery_not_found' ||
        error.code === 'gate_not_found' ||
        error.code === 'approval_not_found' ||
        error.code === 'proposal_not_found'
          ? 404
          : error.code === 'answer_conflict' ||
              error.code === 'gate_already_resolved' ||
              error.code === 'approval_already_resolved' ||
              error.code === 'proposal_already_resolved' ||
              error.code === 'worker_busy' ||
              error.code === 'duplicate_run' ||
              error.code === 'duplicate_task' ||
              error.code === 'coordinator_already_running'
            ? 409
            : error.code === 'terminal_unavailable' || error.code === 'prompt_delivery_failed'
              ? 503
              : 400;
      return {
        status,
        body: {
          ok: false,
          code: error.code,
          error: error.message,
          ...(error.data ? { data: error.data } : {}),
        },
      };
    }
    return {
      status: 500,
      body: {
        ok: false,
        code: 'internal_error',
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}
