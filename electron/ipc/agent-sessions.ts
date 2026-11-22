import { existsSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { AGENT_SESSION_ID, type AgentSessionManager } from '../orchestration/agent-session-manager.js';
import { WorkerTimelinePatchCoalescer } from '../orchestration/worker-timeline.js';
import type { IpcContext } from './context.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';

const id = z.string().regex(AGENT_SESSION_ID);
const policy = z.enum(['read-only', 'workspace-write', 'full-auto']);
const optionalName = z.string().trim().min(1).max(200).nullish();

const createSchema = z.object({
  cwd: z.string().min(1).max(1024).optional(),
  policy,
  model: optionalName,
  effort: optionalName,
  network: z.boolean().optional(),
}).strict();
const sendSchema = z.object({
  id, text: z.string().min(1).max(512_000), policy: policy.optional(), model: optionalName, effort: optionalName,
  network: z.boolean().optional(),
}).strict();
const answerSchema = z.object({
  id, requestId: z.string().min(1).max(64),
  answers: z.record(z.string().max(200), z.array(z.string().max(4_000)).max(20)).nullable(),
}).strict();
const targetSchema = z.object({ id }).strict();
const respondSchema = z.object({
  id, requestId: z.string().min(1).max(64), allow: z.boolean(), reason: z.string().max(2_000).optional(),
}).strict();

const fail = (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : String(error) });

export function registerAgentSessionsIpc(ctx: IpcContext, manager: AgentSessionManager): { dispose: () => void } {
  const authorize = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const secure = <T extends z.ZodTypeAny>(
    channel: string, schema: T, handler: (input: z.infer<T>) => Promise<Record<string, unknown>> | Record<string, unknown>,
  ) => handleSecure(`agent-sessions:${channel}`, {
    schema, authorize, authorizeError: 'Sender is not the main window',
    handler: async (input) => {
      try {
        return { ok: true, ...(await handler(input)) };
      } catch (error) {
        return fail(error);
      }
    },
  });

  secure('list', z.object({}).strict(), () => ({ sessions: manager.list() }));
  secure('create', createSchema, async (input) => {
    const cwd = input.cwd ?? ctx.getCurrentCwd();
    if (!cwd || !isAbsolute(cwd) || !existsSync(cwd) || !statSync(cwd).isDirectory()) {
      throw new Error('请选择一个项目文件夹后再新建会话');
    }
    return { session: await manager.create({ cwd, policy: input.policy, model: input.model, effort: input.effort, network: input.network }) };
  });
  secure('send', sendSchema, async ({ id: sessionId, ...message }) => {
    const delivery = await manager.send(sessionId, message);
    if (delivery.status !== 'accepted') throw new Error(delivery.reason);
    return {};
  });
  secure('interrupt', targetSchema, async (input) => ({ interrupted: await manager.interrupt(input.id) }));
  secure('respond', respondSchema, (input) => {
    if (!manager.respond(input.id, input.requestId, input.allow, input.reason)) throw new Error('这个授权请求已经结束');
    return {};
  });
  secure('answer', answerSchema, (input) => {
    if (!manager.answer(input.id, input.requestId, input.answers)) throw new Error('这个提问已经结束，或还有问题没有回答');
    return {};
  });
  secure('close', targetSchema, async (input) => {
    await manager.close(input.id);
    return {};
  });
  secure('timeline', targetSchema, (input) => ({ timeline: manager.getTimeline(input.id) }));

  const send = (channel: string, payload: unknown) => {
    const win = ctx.liveWindow();
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  };
  // Same channel and shape as Worker timelines, so one renderer subscription serves both.
  const patches = new WorkerTimelinePatchCoalescer((patch) => send('orchestration:worker-timeline-patch', patch), 40);
  const offTimeline = manager.onTimelineChange((change) => {
    if (ctx.liveWindow()) patches.push(change);
  });
  const offSessions = manager.onSessionsChanged((sessions) => send('agent-sessions:changed', sessions));

  return {
    dispose: () => {
      offTimeline();
      offSessions();
      patches.dispose();
    },
  };
}
