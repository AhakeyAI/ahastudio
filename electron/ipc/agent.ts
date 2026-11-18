import { z } from 'zod';
import { AgentHookServer, normalizeAgentHookPayload } from '../agent/agent-hook-server.js';
import { deliverPromptToPty, type PtyWriteFn } from '../agent/agent-prompt-delivery.js';
import { AgentStatusStore, type AgentPaneStatus } from '../agent/agent-status-store.js';
import type { IpcContext } from './context.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';

const PTY_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export const agentListStatusesSchema = z.object({}).strict();
export const agentPtyIdSchema = z
  .object({
    ptyId: z.string().regex(PTY_ID_RE),
  })
  .strict();

export const agentReportHookSchema = z
  .object({
    ptyId: z.string().regex(PTY_ID_RE),
    provider: z.string().min(1).max(64).optional(),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export const agentSendPromptSchema = z
  .object({
    ptyId: z.string().regex(PTY_ID_RE),
    prompt: z.string().max(8192),
    filePath: z.string().min(1).max(1024).optional(),
    startLine: z.number().int().min(1).max(1_000_000).optional(),
    endLine: z.number().int().min(1).max(1_000_000).optional(),
    diffSnippet: z.string().max(8192).optional(),
    submit: z.boolean().optional(),
  })
  .strict();

export interface RegisterAgentIpcOptions {
  store?: AgentStatusStore;
  hookServer?: AgentHookServer;
  sendInput?: PtyWriteFn;
  getHookPort?: () => number | null;
}

function formatAttentionTitle(status: AgentPaneStatus): string {
  const agentLabel = status.agentId ? status.agentId : '终端 Agent';
  if (status.state === 'waiting') {
    if (status.waitKind === 'question') return `${agentLabel} 正在等待回答`;
    if (status.waitKind === 'auth') return `${agentLabel} 需要认证`;
    return `${agentLabel} 等待确认`;
  }
  if (status.state === 'error') {
    return `${agentLabel} 执行出错`;
  }
  return `${agentLabel} 已完成`;
}

async function notifyAttentionIfBackground(
  status: AgentPaneStatus,
  ctx: IpcContext,
): Promise<void> {
  if (process.env.ORCA_BACKGROUND_LAUNCH === '1') return;
  const win = ctx.liveWindow();
  if (win && win.isFocused() && !win.isMinimized()) return;

  try {
    const electronMod = (await import('electron')) as Record<string, unknown>;
    const NotificationCtor = electronMod.Notification as
      | (new (opts: { title: string; body?: string; silent?: boolean }) => {
          on?: (event: string, cb: () => void) => void;
          show: () => void;
        }) & { isSupported?: () => boolean }
      | undefined;
    if (
      !NotificationCtor ||
      typeof NotificationCtor.isSupported !== 'function' ||
      !NotificationCtor.isSupported()
    ) {
      return;
    }
    const body = status.toolName
      ? status.toolInput
        ? `${status.toolName}: ${status.toolInput}`
        : status.toolName
      : status.message;
    const notif = new NotificationCtor({
      title: formatAttentionTitle(status),
      body: body ?? '',
      silent: false,
    });
    notif.on?.('click', () => {
      const live = ctx.liveWindow();
      if (live && !live.isDestroyed()) {
        if (live.isMinimized()) live.restore();
        live.focus();
        live.webContents.send('agent:focus-pane', { ptyId: status.ptyId });
      }
    });
    notif.show();
  } catch {
    /* Notification errors are non-fatal */
  }
}

export function registerAgentIpc(
  ctx: IpcContext,
  opts: RegisterAgentIpcOptions = {},
): { dispose: () => void } {
  const authorize = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const authorizeError = 'Sender is not the main window';

  const store = opts.store ?? ctx.agentStatusStore ?? new AgentStatusStore();
  const sendInput = opts.sendInput ?? ctx.sendPtyInput;
  const getHookPort = opts.getHookPort ?? (() => opts.hookServer?.port ?? null);

  handleSecure('agent:list-statuses', {
    schema: agentListStatusesSchema,
    authorize,
    authorizeError,
    handler: () => ({
      ok: true,
      statuses: store.list(),
      hookPort: getHookPort(),
    }),
  });

  handleSecure('agent:get-status', {
    schema: agentPtyIdSchema,
    authorize,
    authorizeError,
    handler: ({ ptyId }) => ({
      ok: true,
      status: store.get(ptyId),
    }),
  });

  handleSecure('agent:acknowledge', {
    schema: agentPtyIdSchema,
    authorize,
    authorizeError,
    handler: ({ ptyId }) => ({
      ok: true,
      status: store.acknowledge(ptyId),
    }),
  });

  handleSecure('agent:report-hook', {
    schema: agentReportHookSchema,
    authorize,
    authorizeError,
    handler: ({ ptyId, provider, payload }) => {
      const normalized = normalizeAgentHookPayload(provider, payload, ptyId);
      if (!normalized) {
        return { ok: false, error: 'Unrecognized hook payload' };
      }
      const status = store.ingestHookEvent(normalized);
      return { ok: true, status };
    },
  });

  handleSecure('agent:send-prompt', {
    schema: agentSendPromptSchema,
    authorize,
    authorizeError,
    handler: async ({ ptyId, prompt, filePath, startLine, endLine, diffSnippet, submit }) => {
      if (!sendInput) {
        return { ok: false, error: 'Terminal input channel unavailable' };
      }
      return deliverPromptToPty(
        {
          ptyId,
          prompt,
          filePath,
          startLine,
          endLine,
          diffSnippet,
          submit,
          agentId: store.get(ptyId)?.agentId ?? null,
          readScreen: ctx.terminalTracker
            ? () => ctx.terminalTracker!.captureTail(ptyId, 4_000)
            : undefined,
          getLastOutputAtMs: ctx.terminalTracker
            ? () => ctx.terminalTracker!.getLastOutputAtMs(ptyId)
            : undefined,
        },
        sendInput,
      );
    },
  });

  const unsubChange = store.onChange((status) => {
    ctx.liveWindow()?.webContents.send('agent:status-changed', status);
  });

  const unsubAttention = store.onAttention((status) => {
    void notifyAttentionIfBackground(status, ctx);
  });

  return {
    dispose: () => {
      unsubChange();
      unsubAttention();
    },
  };
}
