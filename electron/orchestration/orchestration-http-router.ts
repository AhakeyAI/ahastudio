import { z } from 'zod';
import { OrchestrationService } from './orchestration-service.js';
import {
  ORCHESTRATION_MESSAGE_TYPES,
  OrchestrationError,
} from './orchestration-types.js';

const messageTypeEnum = z.enum(ORCHESTRATION_MESSAGE_TYPES);
const priorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
const taskStatusEnum = z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']);
const gateStatusEnum = z.enum(['pending', 'resolved', 'timeout']);
const workerOutcomeEnum = z.enum(['completed', 'failed', 'blocked', 'escalated', 'abandoned']);

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
  taskTitle: z.string().trim().min(1).optional(),
  displayName: z.string().trim().min(1).optional(),
  deps: z.array(z.string().trim().min(1)).optional(),
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
  to: z.string().trim().min(1),
  type: messageTypeEnum.optional(),
  priority: priorityEnum.optional(),
  subject: z.string().trim().min(1),
  body: z.string().optional(),
  payload: z.union([z.string(), z.record(z.string(), z.unknown()), z.null()]).optional(),
  runId: z.string().trim().min(1).optional(),
  threadId: z.string().trim().min(1).optional(),
});

const workerDoneSchema = z.object({
  capability: z.string().trim().min(1).optional(),
  from: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1),
  dispatchId: z.string().trim().min(1),
  outcome: workerOutcomeEnum.optional(),
  summary: z.string().optional(),
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

export interface OrchestrationHttpDispatchResult {
  status: number;
  body: Record<string, unknown>;
}

export function isLongPollOrchestrationAction(action: string): boolean {
  return action === 'check' || action === 'ask';
}

/** Reads skip the durability barrier; every mutation is fsynced before its receipt is returned. */
const READ_ONLY_ORCHESTRATION_ACTIONS = new Set([
  'run-current',
  'run-list',
  'run-show',
  'task-list',
  'task-show',
  'dispatch-show',
  'coordinator-status',
  'gate-list',
  'inbox',
  'snapshot',
]);

export async function dispatchOrchestrationHttpAction(
  service: OrchestrationService,
  action: string,
  rawPayload: unknown,
  context: { signal: AbortSignal }
): Promise<OrchestrationHttpDispatchResult> {
  const payload =
    typeof rawPayload === 'object' && rawPayload !== null && !Array.isArray(rawPayload)
      ? (rawPayload as Record<string, unknown>)
      : {};
  const formatReceipt = payload.receiptText === true;
  const full = payload.full === true;

  try {
    let result: unknown;
    switch (action) {
      case 'run-create':
        result = service.runCreate(runCreateSchema.parse(payload));
        break;
      case 'run-use':
        result = service.runUse(runUseSchema.parse(payload));
        break;
      case 'run-current':
        result = service.runCurrent(runCurrentSchema.parse(payload));
        break;
      case 'run-list':
        result = service.runList(runListSchema.parse(payload));
        break;
      case 'run-show':
        result = service.runShow(runShowSchema.parse(payload).id);
        break;
      case 'task-create':
        result = service.taskCreate(taskCreateSchema.parse(payload));
        break;
      case 'task-list':
        result = service.taskList(taskListSchema.parse(payload));
        break;
      case 'task-show':
        result = service.taskShow(taskShowSchema.parse(payload));
        break;
      case 'task-update':
        result = service.taskUpdate(taskUpdateSchema.parse(payload));
        break;
      case 'dispatch':
        result = await service.dispatchTask(dispatchSchema.parse(payload));
        break;
      case 'dispatch-show':
        result = service.dispatchShow(dispatchShowSchema.parse(payload));
        break;
      case 'coordinator-start':
        result = service.coordinatorStart(coordinatorStartSchema.parse(payload));
        break;
      case 'coordinator-stop':
        result = service.coordinatorStop();
        break;
      case 'coordinator-tick':
        result = await service.coordinatorTick(coordinatorTickSchema.parse(payload).runId);
        break;
      case 'coordinator-status':
        result = service.coordinatorStatus(coordinatorStatusSchema.parse(payload));
        break;
      case 'send':
        result = service.send(sendSchema.parse(payload));
        break;
      case 'worker-done':
        result = service.workerDone(workerDoneSchema.parse(payload));
        break;
      case 'check':
        result = await service.check(checkSchema.parse(payload), context.signal);
        break;
      case 'inbox':
        result = service.inbox(inboxSchema.parse(payload));
        break;
      case 'ask':
        result = await service.ask(askSchema.parse(payload), context.signal);
        break;
      case 'reply':
        result = service.reply(replySchema.parse(payload));
        break;
      case 'gate-create':
        result = service.gateCreate(gateCreateSchema.parse(payload));
        break;
      case 'gate-resolve':
        result = service.gateResolve(gateResolveSchema.parse(payload));
        break;
      case 'gate-list':
        result = service.gateList(gateListSchema.parse(payload));
        break;
      case 'snapshot':
        result = service.getSnapshot(snapshotSchema.parse(payload).runId);
        break;
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
        error.code === 'gate_not_found'
          ? 404
          : error.code === 'answer_conflict' ||
              error.code === 'gate_already_resolved' ||
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
