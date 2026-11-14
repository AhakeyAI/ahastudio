import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { z } from 'zod';

export type SenderPolicy = (event: IpcMainInvokeEvent) => boolean | { ok: boolean; error?: string };

export function mainWindowSenderPolicy(getMainWindowId: () => number | null): SenderPolicy {
  return (event) => {
    const id = getMainWindowId();
    return id !== null && event.sender.id === id;
  };
}

export function handleSecure<T extends z.ZodTypeAny>(
  channel: string,
  opts: {
    authorize?: SenderPolicy;
    authorizeError?: string;
    schema?: T;
    handler: (input: z.infer<T>, event: IpcMainInvokeEvent) => unknown | Promise<unknown>;
  },
): void {
  ipcMain.handle(channel, async (event, rawInput) => {
    if (opts.authorize) {
      const verdict = opts.authorize(event);
      const allowed = typeof verdict === 'boolean' ? verdict : verdict.ok;
      if (!allowed) {
        return {
          ok: false,
          error:
            (typeof verdict === 'object' && verdict.error) ||
            opts.authorizeError ||
            'Unauthorized IPC sender',
        };
      }
    }
    try {
      if (opts.schema) {
        const normalizedInput = rawInput === undefined ? {} : rawInput;
        const parsed = opts.schema.safeParse(normalizedInput);
        if (!parsed.success) {
          return { ok: false, error: 'Invalid IPC payload' };
        }
        return await opts.handler(parsed.data, event);
      }
      return await opts.handler(rawInput as z.infer<T>, event);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
