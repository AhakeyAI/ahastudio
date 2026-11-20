import { z } from 'zod';
import {
  ORCHESTRATION_BOARD_POST_KINDS,
  ORCHESTRATION_MESSAGE_TYPES,
  ORCHESTRATION_TASK_KINDS,
  OrchestrationError,
} from '../orchestration/orchestration-types.js';
import type { IpcContext } from './context.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';

const optionalSchema = <T extends z.ZodTypeAny>(schema: T): z.ZodType<z.output<T>> =>
  z.preprocess((val) => (val === undefined ? {} : val), schema) as unknown as z.ZodType<z.output<T>>;

const nonEmptyId = z.string().trim().min(1).max(200);
const boardPostKindEnum = z.enum(ORCHESTRATION_BOARD_POST_KINDS);
const messageTypeEnum = z.enum(ORCHESTRATION_MESSAGE_TYPES);
const taskKindEnum = z.enum(ORCHESTRATION_TASK_KINDS);
const priorityEnum = z.enum(['low', 'normal', 'high', 'urgent']);
const taskStatusEnum = z.enum(['pending', 'ready', 'dispatched', 'completed', 'failed', 'blocked']);
const gateStatusEnum = z.enum(['pending', 'resolved', 'timeout']);
const workerOutcomeEnum = z
  .enum(['completed', 'succeeded', 'failed', 'blocked', 'escalated', 'abandoned'])
  .transform((v) => (v === 'succeeded' ? 'completed' : v));

const getSnapshotSchema = optionalSchema(
  z.object({ runId: nonEmptyId.optional() }).strict()
);

const runCreateSchema = z
  .object({
    id: nonEmptyId.optional(),
    objective: z.string().trim().min(1).max(8_000),
    from: nonEmptyId.optional(),
    paneId: nonEmptyId.optional(),
  })
  .strict();

const runUseSchema = z
  .object({
    id: nonEmptyId,
    from: nonEmptyId.optional(),
    paneId: nonEmptyId.optional(),
  })
  .strict();

const runCurrentSchema = optionalSchema(
  z.object({ from: nonEmptyId.optional() }).strict()
);

const runListSchema = optionalSchema(
  z.object({ status: z.string().trim().min(1).max(64).optional() }).strict()
);

const runShowSchema = z.object({ id: nonEmptyId }).strict();

const taskCreateSchema = z
  .object({
    id: nonEmptyId.optional(),
    runId: nonEmptyId.optional(),
    from: nonEmptyId.optional(),
    spec: z.string().trim().min(1).max(64_000),
    taskTitle: z.string().trim().min(1).max(200).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    deps: z.array(nonEmptyId).max(100).optional(),
    priority: priorityEnum.optional(),
    worktreePath: z.string().trim().min(1).max(1024).optional(),
  })
  .strict();

const taskListSchema = optionalSchema(
  z
    .object({
      runId: nonEmptyId.optional(),
      from: nonEmptyId.optional(),
      status: taskStatusEnum.optional(),
      priority: priorityEnum.optional(),
    })
    .strict()
);

const taskShowSchema = z
  .object({
    id: nonEmptyId,
  })
  .strict();

const taskUpdateSchema = z
  .object({
    id: nonEmptyId,
    status: taskStatusEnum,
  })
  .strict();

const dispatchSchema = z
  .object({
    taskId: nonEmptyId,
    to: nonEmptyId.optional(),
    from: nonEmptyId.optional(),
    inject: z.boolean().optional(),
    dryRun: z.boolean().optional(),
  })
  .strict();

const dispatchShowSchema = z
  .object({
    taskId: nonEmptyId,
    preamble: z.boolean().optional(),
  })
  .strict();

const coordinatorStartSchema = optionalSchema(
  z
    .object({
      runId: nonEmptyId.optional(),
      spec: z.string().trim().min(1).max(64_000).optional(),
      from: nonEmptyId.optional(),
      pollIntervalMs: z.number().int().min(50).max(60_000).optional(),
      maxConcurrent: z.number().int().min(1).max(32).optional(),
      autoSpawnWorkers: z.boolean().optional(),
      workerCliId: nonEmptyId.optional(),
      cwd: z.string().trim().min(1).max(1024).optional(),
      workerPaneIds: z.array(nonEmptyId).max(64).optional(),
    })
    .strict()
);

const emptyObjSchema = optionalSchema(z.object({}).strict());

const coordinatorTickSchema = optionalSchema(
  z
    .object({
      runId: nonEmptyId.optional(),
      workerPaneIds: z.array(nonEmptyId).max(64).optional(),
    })
    .strict()
);

const coordinatorStatusSchema = optionalSchema(
  z.object({ runId: nonEmptyId.optional() }).strict()
);

const sendSchema = z
  .object({
    capability: nonEmptyId.optional(),
    from: nonEmptyId.optional(),
    to: nonEmptyId.optional(),
    type: messageTypeEnum.optional(),
    priority: priorityEnum.optional(),
    subject: z.string().trim().min(1).max(500),
    body: z.string().max(64_000).optional(),
    payload: z.union([z.string().max(64_000), z.record(z.string(), z.unknown()), z.null()]).optional(),
    runId: nonEmptyId.optional(),
    threadId: nonEmptyId.optional(),
  })
  .strict();

const workerDoneSchema = z
  .object({
    capability: nonEmptyId.optional(),
    from: nonEmptyId.optional(),
    taskId: nonEmptyId.optional(),
    dispatchId: nonEmptyId.optional(),
    outcome: workerOutcomeEnum.optional(),
    summary: z.string().max(16_000).optional(),
  })
  .strict();

const workerStartSchema = z
  .object({
    from: nonEmptyId.optional(),
    runId: nonEmptyId.optional(),
    taskId: nonEmptyId.optional(),
    spec: z.string().trim().min(1).max(64_000).optional(),
    taskTitle: z.string().trim().min(1).max(200).optional(),
    displayName: z.string().trim().min(1).max(200).optional(),
    deps: z.array(nonEmptyId).max(100).optional(),
    priority: priorityEnum.optional(),
    retryOfDispatchId: nonEmptyId.optional(),
    cliId: nonEmptyId.optional(),
    agent: nonEmptyId.optional(),
    model: nonEmptyId.optional(),
    effort: nonEmptyId.optional(),
    terminal: nonEmptyId.optional(),
    worktree: z.union([z.string().trim().max(1024), z.boolean()]).optional(),
    noWorktree: z.boolean().optional(),
    branch: nonEmptyId.optional(),
    baseBranch: nonEmptyId.optional(),
    name: nonEmptyId.optional(),
    cwd: z.string().trim().min(1).max(1024).optional(),
    callerCwd: z.string().trim().min(1).max(1024).optional(),
    keepOpen: z.boolean().optional(),
  })
  .strict();

const workerListSchema = optionalSchema(
  z
    .object({
      runId: nonEmptyId.optional(),
      status: z.enum(['pending', 'dispatched', 'completed', 'failed', 'circuit_broken']).optional(),
      includeSettled: z.boolean().optional(),
    })
    .strict()
);

const workerTargetSchema = z
  .object({
    dispatchId: nonEmptyId.optional(),
    worker: nonEmptyId.optional(),
    taskId: nonEmptyId.optional(),
  })
  .strict();

const workerReadSchema = z
  .object({
    dispatchId: nonEmptyId.optional(),
    worker: nonEmptyId.optional(),
    taskId: nonEmptyId.optional(),
    cursor: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(256_000).optional(),
    screen: z.boolean().optional(),
  })
  .strict();

const workerKeepOpenSchema = z
  .object({
    dispatchId: nonEmptyId.optional(),
    worker: nonEmptyId.optional(),
    taskId: nonEmptyId.optional(),
    keepOpen: z.boolean().optional(),
  })
  .strict();

const workerReleaseSchema = z
  .object({
    dispatchId: nonEmptyId.optional(),
    worker: nonEmptyId.optional(),
    taskId: nonEmptyId.optional(),
    keepPane: z.boolean().optional(),
    keepWorktree: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();

const workerStopSchema = z
  .object({
    dispatchId: nonEmptyId.optional(),
    worker: nonEmptyId.optional(),
    taskId: nonEmptyId.optional(),
    reason: z.string().max(4_000).optional(),
    removeWorktree: z.boolean().optional(),
    force: z.boolean().optional(),
  })
  .strict();

const workerAbandonSchema = z
  .object({
    dispatchId: nonEmptyId.optional(),
    worker: nonEmptyId.optional(),
    taskId: nonEmptyId.optional(),
    reason: z.string().max(4_000).optional(),
  })
  .strict();

const resetSchema = z
  .object({
    all: z.boolean().optional(),
    tasks: z.boolean().optional(),
    messages: z.boolean().optional(),
  })
  .strict();

const approveSchema = z
  .object({
    id: nonEmptyId,
    dispatchId: nonEmptyId.optional(),
    from: nonEmptyId.optional(),
    reason: z.string().max(4_000).optional(),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

const denySchema = z
  .object({
    id: nonEmptyId,
    dispatchId: nonEmptyId.optional(),
    from: nonEmptyId.optional(),
    reason: z.string().max(4_000).optional(),
  })
  .strict();

const checkSchema = optionalSchema(
  z
    .object({
      from: nonEmptyId.optional(),
      runId: nonEmptyId.optional(),
      unread: z.boolean().optional(),
      peek: z.boolean().optional(),
      all: z.boolean().optional(),
      wait: z.boolean().optional(),
      timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
      types: z.array(messageTypeEnum).max(20).optional(),
      ack: nonEmptyId.optional(),
      holdAck: z.boolean().optional(),
      format: z.boolean().optional(),
      requestId: nonEmptyId.optional(),
    })
    .strict()
);

const inboxSchema = optionalSchema(
  z
    .object({
      from: nonEmptyId.optional(),
      runId: nonEmptyId.optional(),
      limit: z.number().int().min(1).max(500).optional(),
      types: z.array(messageTypeEnum).max(20).optional(),
      unreadOnly: z.boolean().optional(),
    })
    .strict()
);

const askSchema = z
  .object({
    capability: nonEmptyId.optional(),
    from: nonEmptyId.optional(),
    to: nonEmptyId.optional(),
    question: z.string().trim().min(1).max(16_000).optional(),
    options: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    wait: z.boolean().optional(),
    timeoutMs: z.number().int().min(0).max(3_600_000).optional(),
    resume: nonEmptyId.optional(),
    dispatchId: nonEmptyId.optional(),
    runId: nonEmptyId.optional(),
    requestId: nonEmptyId.optional(),
  })
  .strict();

const cancelWaitSchema = z.object({ requestId: nonEmptyId }).strict();

const replySchema = z
  .object({
    id: nonEmptyId,
    body: z.string().trim().min(1).max(64_000),
    from: nonEmptyId.optional(),
  })
  .strict();

const gateCreateSchema = z
  .object({
    taskId: nonEmptyId,
    question: z.string().trim().min(1).max(16_000),
    options: z.array(z.string().trim().min(1).max(500)).max(20).optional(),
    from: nonEmptyId.optional(),
  })
  .strict();

const gateResolveSchema = z
  .object({
    id: nonEmptyId,
    resolution: z.string().trim().min(1).max(16_000),
    from: nonEmptyId.optional(),
  })
  .strict();

const gateListSchema = optionalSchema(
  z
    .object({
      runId: nonEmptyId.optional(),
      taskId: nonEmptyId.optional(),
      status: gateStatusEnum.optional(),
    })
    .strict()
);

const setPaneModeSchema = z
  .object({
    ptyId: nonEmptyId,
    enabled: z.boolean(),
  })
  .strict();

const listAgentsSchema = optionalSchema(
  z
    .object({
      callerPaneId: nonEmptyId.optional(),
    })
    .strict()
);

const delegateTaskSchema = z
  .object({
    from: nonEmptyId.optional(),
    role: z.string().trim().max(120).optional(),
    task: z.string().trim().min(1).max(64_000),
    agent: nonEmptyId.optional(),
    taskKind: taskKindEnum.optional(),
    worktree: z.boolean().optional(),
    model: nonEmptyId.optional(),
    effort: nonEmptyId.optional(),
    terminal: nonEmptyId.optional(),
    userInitiated: z.boolean().optional(),
    confirmed: z.boolean().optional(),
    planSummary: z.string().trim().max(1_000).optional(),
    runId: nonEmptyId.optional(),
    requestId: nonEmptyId.optional(),
  })
  .strict();

const proposalApproveSchema = z
  .object({
    id: nonEmptyId,
    agent: nonEmptyId.optional(),
    worktree: z.boolean().optional(),
    model: z.union([nonEmptyId, z.null()]).optional(),
    effort: z.union([nonEmptyId, z.null()]).optional(),
  })
  .strict();

const proposalRejectSchema = z
  .object({
    id: nonEmptyId,
    reason: z.string().max(4_000).optional(),
  })
  .strict();

const boardPostSchema = z
  .object({
    runId: nonEmptyId.optional(),
    text: z.string().trim().min(1).max(64_000),
    kind: boardPostKindEnum.optional(),
    subject: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

const boardReadSchema = optionalSchema(
  z
    .object({
      runId: nonEmptyId.optional(),
      since: z.number().int().min(0).optional(),
      seqs: z.array(z.number().int().min(1)).max(200).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    })
    .strict()
);

function formatIpcFailure(error: unknown): {
  ok: false;
  code: string;
  error: string;
  data?: Record<string, unknown>;
} {
  if (error instanceof OrchestrationError) {
    return {
      ok: false,
      code: error.code,
      error: error.message,
      ...(error.data ? { data: error.data } : {}),
    };
  }
  return {
    ok: false,
    code: 'internal_error',
    error: error instanceof Error ? error.message : String(error),
  };
}

async function runAction<T extends Record<string, unknown>>(
  fn: () => Promise<T> | T,
  drain?: () => Promise<void>
): Promise<({ ok: true } & T) | ReturnType<typeof formatIpcFailure>> {
  try {
    const data = await fn();
    if (drain) {
      // Acknowledge only after the snapshot write is durable on disk.
      await drain();
    }
    return { ok: true, ...data };
  } catch (error) {
    return formatIpcFailure(error);
  }
}

export function registerOrchestrationIpc(ctx: IpcContext): { dispose: () => void } {
  const service = ctx.orchestrationService;
  const authorize = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const authorizeError = 'Sender is not the main window';

  const act = <T extends Record<string, unknown>>(fn: () => Promise<T> | T) =>
    runAction(fn, () => requireService().waitForPendingWrites());

  const inFlightWaits = new Map<string, AbortController>();

  const runCancellableWait = <T extends Record<string, unknown>>(
    requestId: string | undefined,
    sender: {
      once?: (event: 'destroyed', listener: () => void) => unknown;
      removeListener?: (event: 'destroyed', listener: () => void) => unknown;
    },
    fn: (signal: AbortSignal) => Promise<T>,
  ) =>
    act(async () => {
      const controller = new AbortController();
      if (requestId) {
        inFlightWaits.get(requestId)?.abort();
        inFlightWaits.set(requestId, controller);
      }
      const onDestroyed = () => controller.abort();
      sender.once?.('destroyed', onDestroyed);
      try {
        return await fn(controller.signal);
      } finally {
        sender.removeListener?.('destroyed', onDestroyed);
        if (requestId && inFlightWaits.get(requestId) === controller) {
          inFlightWaits.delete(requestId);
        }
      }
    });

  const requireService = () => {
    if (!service) {
      throw new OrchestrationError('not_found', 'Orchestration service is not initialized.');
    }
    return service;
  };

  handleSecure('orchestration:get-snapshot', {
    schema: getSnapshotSchema,
    authorize,
    authorizeError,
    handler: ({ runId }) => act(() => ({ snapshot: requireService().getSnapshot(runId) })),
  });

  handleSecure('orchestration:run-create', {
    schema: runCreateSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().runCreate(payload)),
  });

  handleSecure('orchestration:run-use', {
    schema: runUseSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().runUse(payload)),
  });

  handleSecure('orchestration:run-current', {
    schema: runCurrentSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().runCurrent(payload)),
  });

  handleSecure('orchestration:run-list', {
    schema: runListSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().runList(payload)),
  });

  handleSecure('orchestration:run-show', {
    schema: runShowSchema,
    authorize,
    authorizeError,
    handler: ({ id }) => act(() => requireService().runShow(id)),
  });

  handleSecure('orchestration:task-create', {
    schema: taskCreateSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().taskCreate(payload)),
  });

  handleSecure('orchestration:task-list', {
    schema: taskListSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().taskList(payload)),
  });

  handleSecure('orchestration:task-show', {
    schema: taskShowSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().taskShow(payload)),
  });

  handleSecure('orchestration:task-update', {
    schema: taskUpdateSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().taskUpdate(payload)),
  });

  handleSecure('orchestration:dispatch', {
    schema: dispatchSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().dispatchTask(payload)),
  });

  handleSecure('orchestration:dispatch-show', {
    schema: dispatchShowSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().dispatchShow(payload)),
  });

  handleSecure('orchestration:coordinator-start', {
    schema: coordinatorStartSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().coordinatorStart(payload)),
  });

  handleSecure('orchestration:coordinator-stop', {
    schema: emptyObjSchema,
    authorize,
    authorizeError,
    handler: () => act(() => requireService().coordinatorStop()),
  });

  handleSecure('orchestration:coordinator-tick', {
    schema: coordinatorTickSchema,
    authorize,
    authorizeError,
    handler: ({ runId, workerPaneIds }) =>
      act(() => requireService().coordinatorTick(runId, { workerPaneIds })),
  });

  handleSecure('orchestration:coordinator-status', {
    schema: coordinatorStatusSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().coordinatorStatus(payload)),
  });

  handleSecure('orchestration:send', {
    schema: sendSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().send(payload)),
  });

  handleSecure('orchestration:worker-done', {
    schema: workerDoneSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().workerDone(payload)),
  });

  handleSecure('orchestration:worker-start', {
    schema: workerStartSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().workerStart(payload)),
  });

  handleSecure('orchestration:worker-list', {
    schema: workerListSchema,
    authorize,
    authorizeError,
    handler: (payload) => runAction(() => requireService().workerList(payload)),
  });

  handleSecure('orchestration:worker-show', {
    schema: workerTargetSchema,
    authorize,
    authorizeError,
    handler: (payload) => runAction(() => ({ ...requireService().workerShow(payload) })),
  });

  handleSecure('orchestration:worker-read', {
    schema: workerReadSchema,
    authorize,
    authorizeError,
    handler: (payload) => runAction(() => ({ ...requireService().workerRead(payload) })),
  });

  handleSecure('orchestration:worker-keep-open', {
    schema: workerKeepOpenSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().workerKeepOpen(payload)),
  });

  handleSecure('orchestration:worker-release', {
    schema: workerReleaseSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().workerRelease(payload)),
  });

  handleSecure('orchestration:worker-stop', {
    schema: workerStopSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().workerStop(payload)),
  });

  handleSecure('orchestration:worker-abandon', {
    schema: workerAbandonSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().workerAbandon(payload)),
  });

  handleSecure('orchestration:reset', {
    schema: resetSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().reset(payload)),
  });

  handleSecure('orchestration:approve', {
    schema: approveSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().approve(payload)),
  });

  handleSecure('orchestration:deny', {
    schema: denySchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().deny(payload)),
  });

  handleSecure('orchestration:check', {
    schema: checkSchema,
    authorize,
    authorizeError,
    handler: ({ requestId, ...payload }, event) =>
      runCancellableWait(requestId, event.sender, (signal) => requireService().check(payload, signal)),
  });

  handleSecure('orchestration:inbox', {
    schema: inboxSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().inbox(payload)),
  });

  handleSecure('orchestration:ask', {
    schema: askSchema,
    authorize,
    authorizeError,
    handler: ({ requestId, ...payload }, event) =>
      runCancellableWait(requestId, event.sender, (signal) => requireService().ask(payload, signal)),
  });

  handleSecure('orchestration:cancel-wait', {
    schema: cancelWaitSchema,
    authorize,
    authorizeError,
    handler: ({ requestId }) =>
      runAction(() => {
        const ctrl = inFlightWaits.get(requestId);
        if (ctrl) {
          ctrl.abort();
          return { cancelled: true };
        }
        return { cancelled: false };
      }),
  });

  handleSecure('orchestration:reply', {
    schema: replySchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().reply(payload)),
  });

  handleSecure('orchestration:gate-create', {
    schema: gateCreateSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().gateCreate(payload)),
  });

  handleSecure('orchestration:gate-resolve', {
    schema: gateResolveSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().gateResolve(payload)),
  });

  handleSecure('orchestration:gate-list', {
    schema: gateListSchema,
    authorize,
    authorizeError,
    handler: (payload) => act(() => requireService().gateList(payload)),
  });

  handleSecure('orchestration:set-pane-mode', {
    schema: setPaneModeSchema,
    authorize,
    authorizeError,
    handler: ({ ptyId, enabled }) =>
      runAction(() => requireService().setPaneOrchestrationMode(ptyId, enabled)),
  });

  handleSecure('orchestration:list-agents', {
    schema: listAgentsSchema,
    authorize,
    authorizeError,
    handler: ({ callerPaneId }) =>
      runAction(() => ({ agents: requireService().listCodingAgents(callerPaneId ?? null) })),
  });

  handleSecure('orchestration:delegate-task', {
    schema: delegateTaskSchema,
    authorize,
    authorizeError,
    handler: ({ requestId, ...payload }, event) =>
      runCancellableWait(requestId, event.sender, (signal) =>
        requireService().delegateTask(payload, signal)
      ),
  });

  handleSecure('orchestration:proposal-approve', {
    schema: proposalApproveSchema,
    authorize,
    authorizeError,
    handler: ({ id, agent, worktree, model, effort }) =>
      runAction(() =>
        requireService().approveDispatchProposal(id, { agent, worktree, model, effort })
      ),
  });

  handleSecure('orchestration:proposal-reject', {
    schema: proposalRejectSchema,
    authorize,
    authorizeError,
    handler: ({ id, reason }) =>
      runAction(() => requireService().rejectDispatchProposal(id, reason)),
  });

  handleSecure('orchestration:board-post', {
    schema: boardPostSchema,
    authorize,
    authorizeError,
    handler: (payload) =>
      act(() =>
        requireService().boardPost({
          ...payload,
          from: 'user',
          isUser: true,
        })
      ),
  });

  handleSecure('orchestration:board-read', {
    schema: boardReadSchema,
    authorize,
    authorizeError,
    handler: (payload) =>
      runAction(() =>
        requireService().boardRead({
          ...payload,
          from: 'user',
          isUser: true,
          markRead: false,
        })
      ),
  });

  if (!service) {
    return {
      dispose: () => {
        for (const ctrl of inFlightWaits.values()) {
          ctrl.abort();
        }
        inFlightWaits.clear();
      },
    };
  }

  const offEvent = service.onEvent((event) => {
    ctx.liveWindow()?.webContents.send('orchestration:event', event);
  });

  const offSpawned = service.onPaneSpawned((event) => {
    ctx.liveWindow()?.webContents.send('orchestration:pane-spawned', event);
  });

  const offClosed = service.onPaneClosed((event) => {
    ctx.liveWindow()?.webContents.send('orchestration:pane-closed', event);
  });

  return {
    dispose: () => {
      for (const ctrl of inFlightWaits.values()) {
        ctrl.abort();
      }
      inFlightWaits.clear();
      offEvent();
      offSpawned();
      offClosed();
    },
  };
}
