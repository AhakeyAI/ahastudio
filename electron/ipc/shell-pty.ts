// Manual terminal IPC validates the caller and delegates to the session owner.
import { z } from 'zod';
import { lstat, readlink, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'node:path';
import { getPtyHost } from '../pty-host.js';
import type { IpcContext } from './context.js';
import { handleSecure, mainWindowSenderPolicy } from './validators.js';
import { PTY_INPUT_MAX_BYTES } from '../pty-input-limiter.js';
import {
  isOrchestrationCliId,
  LOCAL_SHELL_IDS,
  listLocalClis,
  listLocalShells,
  ORCHESTRATION_CLI_IDS,
  type OrchestrationCliId,
} from '../local-cli.js';
import { LocalTerminalSessions } from '../local-terminal-sessions.js';
import { DaemonTerminalSessions } from '../daemon-terminal-sessions.js';
import type { Snapshot } from '../terminal-daemon/protocol.js';
import { getDefaultWorkspaceStateStore } from '../persistence/workspace-state-store.js';
import { parseFileUriPathParts } from '../terminal-daemon/emulation/osc7-file-uri.js';
import { TerminalRuntimeTracker } from '../terminal-runtime-tracker.js';
import { inspectLinkedFile } from './linked-file-inspection.js';

const PTY_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;
export const shellPtyCreateSchema = z.object({
  cwd: z.string().min(1).max(1024).optional(),
  cols: z.number().int().min(1).max(500).optional(),
  rows: z.number().int().min(1).max(500).optional(),
  cliId: z.enum(ORCHESTRATION_CLI_IDS).optional(),
  shellId: z.enum(LOCAL_SHELL_IDS).optional(),
  // The process id is `local-<terminalId>` and must still pass PTY_ID_RE on input/resize/kill.
  terminalId: z.string().regex(PTY_ID_RE).max(128 - 'local-'.length).optional(),
}).strict().refine((value) => !(value.cliId && value.shellId), '选择 CLI 或 shell 其中一种');

export const shellPtyIdSchema = z.object({ ptyId: z.string().regex(PTY_ID_RE) }).strict();
export const shellPtyInputSchema = z.object({
  ptyId: z.string().regex(PTY_ID_RE), data: z.string().min(1).max(PTY_INPUT_MAX_BYTES),
}).strict();
export const shellPtyResizeSchema = z.object({
  ptyId: z.string().regex(PTY_ID_RE),
  rows: z.number().int().min(1).max(500), cols: z.number().int().min(1).max(500),
}).strict();

type PersistedPaneLayoutNode =
  | { type: 'leaf'; id: string }
  | {
      type: 'split';
      direction: 'horizontal' | 'vertical';
      ratio: number;
      first: PersistedPaneLayoutNode;
      second: PersistedPaneLayoutNode;
    };

const paneLayoutNodeSchema: z.ZodType<PersistedPaneLayoutNode> = z.lazy(() =>
  z.union([
    z.object({ type: z.literal('leaf'), id: z.string().regex(PTY_ID_RE) }).strict(),
    z.object({
      type: z.literal('split'),
      direction: z.enum(['horizontal', 'vertical']),
      ratio: z.number().min(0.1).max(0.9),
      first: paneLayoutNodeSchema,
      second: paneLayoutNodeSchema,
    }).strict(),
  ]),
);

const persistedPaneMetaSchema = z.object({
  id: z.string().regex(PTY_ID_RE),
  cwd: z.string().max(1024).optional(),
  title: z.string().max(256).optional(),
  localCliId: z.string().max(128).optional(),
  shellId: z.string().max(128).optional(),
}).strict();

const persistedStageWindowSchema = z.object({
  id: z.string().regex(PTY_ID_RE),
  type: z.enum(['activity', 'terminal', 'file', 'browser']),
  title: z.string().max(256),
  workerId: z.string().max(128).optional(),
  localCliId: z.string().max(128).optional(),
  shellId: z.string().max(128).optional(),
  cwd: z.string().max(1024).optional(),
  filePath: z.string().max(1024).optional(),
  browserTabId: z.string().max(128).optional(),
  activeLeafId: z.string().regex(PTY_ID_RE).optional(),
  splitTree: paneLayoutNodeSchema.optional(),
  panes: z.record(z.string().regex(PTY_ID_RE), persistedPaneMetaSchema).optional(),
}).strict();
export const workspaceStateSetSchema = z.object({
  version: z.literal(1),
  windows: z.array(persistedStageWindowSchema).max(64),
  activeWindowId: z.string().regex(PTY_ID_RE).nullable(),
}).strict();

export const shellPtyOpenLinkSchema = z.object({
  target: z.string().min(1).max(4096),
  cwd: z.string().max(1024).optional(),
}).strict();

export const shellPtyCheckPathsSchema = z.object({
  cwd: z.string().max(1024).optional(),
  paths: z.array(z.string().min(1).max(1024)).max(200),
}).strict();

const WINDOWS_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i;
const UNC_OR_DEVICE_PREFIX_RE = /^(?:[\\/]{2}|[\\/]\?\?(?:[\\/]|$))/;

export function isUncOrDevicePath(candidate: string): boolean {
  return UNC_OR_DEVICE_PREFIX_RE.test(candidate.trim());
}

function isReservedDevicePath(candidate: string): boolean {
  if (process.platform !== 'win32') return false;
  const base = basename(candidate).split(':')[0] ?? '';
  return WINDOWS_DEVICE_RE.test(base);
}

function hasAlternateDataStreamColon(candidate: string): boolean {
  if (process.platform !== 'win32') return false;
  const withoutDrive = candidate.replace(/^[a-zA-Z]:/, '');
  return withoutDrive.includes(':');
}

function finalizeResolvedLocalPath(candidate: string | null): string | null {
  if (!candidate) return null;
  if (isUncOrDevicePath(candidate) || isReservedDevicePath(candidate) || hasAlternateDataStreamColon(candidate)) {
    return null;
  }
  return candidate;
}

export function resolveTerminalLinkPath(rawTarget: string, cwd?: string): string | null {
  const trimmed = rawTarget.trim();
  if (!trimmed || isUncOrDevicePath(trimmed)) return null;
  if (cwd && isUncOrDevicePath(cwd)) return null;

  if (/^file:/i.test(trimmed)) {
    if (!/^file:\/\//i.test(trimmed)) return null;
    const parts = parseFileUriPathParts(trimmed);
    if (!parts) return null;
    if (parts.hostname && parts.hostname !== 'localhost') return null;
    if (isUncOrDevicePath(parts.path) || !isAbsolute(parts.path)) return null;
    return finalizeResolvedLocalPath(normalize(parts.path));
  }

  if (trimmed.includes('://')) return null;

  const expanded =
    trimmed === '~'
      ? homedir()
      : trimmed.startsWith('~/') || trimmed.startsWith('~\\')
        ? join(homedir(), trimmed.slice(2))
        : trimmed;

  if (isUncOrDevicePath(expanded)) return null;

  if (process.platform === 'win32') {
    const msysMatch = /^\/([a-zA-Z])\/(.+)$/.exec(expanded);
    if (msysMatch) {
      const winPath = normalize(`${msysMatch[1]!.toUpperCase()}:/${msysMatch[2]!}`);
      return finalizeResolvedLocalPath(winPath);
    }
  }

  const resolved = isAbsolute(expanded)
    ? normalize(expanded)
    : cwd && isAbsolute(cwd)
      ? resolve(cwd, expanded)
      : null;
  return finalizeResolvedLocalPath(resolved);
}

const MAX_SAFE_STAT_SYMLINK_HOPS = 16;

/** Stat a local path without ever traversing symlinks that point at UNC or device paths. */
async function safeStatLocalPath(resolvedPath: string): Promise<{ isDirectory: boolean } | null> {
  let current = resolvedPath;
  for (let hop = 0; hop < MAX_SAFE_STAT_SYMLINK_HOPS; hop++) {
    if (!finalizeResolvedLocalPath(current)) return null;
    const ls = await lstat(current);
    if (!ls.isSymbolicLink()) {
      const finalStats = hop === 0 ? ls : await stat(current);
      return { isDirectory: finalStats.isDirectory() };
    }
    const rawTarget = await readlink(current);
    const nextTarget = isAbsolute(rawTarget) ? normalize(rawTarget) : resolve(dirname(current), rawTarget);
    if (!finalizeResolvedLocalPath(nextTarget)) return null;
    current = nextTarget;
  }
  return null;
}

export function registerShellPtyIpc(ctx: IpcContext): {
  sendInput: (ptyId: string, data: string) => Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string };
  createPty: (payload: {
    terminalId?: string;
    cwd?: string;
    cliId?: string;
    extraArgs?: string[];
    cols?: number;
    rows?: number;
    /** Resolve only after the program has printed output and then gone quiet (bounded wait). */
    waitForReady?: { quietMs?: number; maxMs?: number };
  }) => Promise<{ ptyId: string; cwd?: string }>;
  closePty: (ptyId: string) => Promise<{ ok: boolean }>;
  onPtyExit: (cb: (ptyId: string) => void) => () => void;
  tracker: TerminalRuntimeTracker;
  isPtyAlive: (ptyId: string) => boolean;
} {
  const authorize = mainWindowSenderPolicy(() => ctx.liveWindow()?.webContents.id ?? null);
  const authorizeError = 'Sender is not the main window';
  const tracker = ctx.terminalTracker ?? new TerminalRuntimeTracker();
  ctx.terminalTracker = tracker;
  const exitListeners = new Set<(ptyId: string) => void>();
  const notifyExitListeners = (ptyId: string) => {
    for (const listener of exitListeners) {
      try {
        listener(ptyId);
      } catch {
        /* ignore */
      }
    }
  };
  const lastOutputAt = new Map<string, number>();
  const exitedPtys = new Set<string>();
  const waitForOutputSettled = async (ptyId: string, quietMs: number, maxMs: number) => {
    const started = Date.now();
    while (Date.now() - started < maxMs) {
      if (exitedPtys.has(ptyId)) return;
      const status = ctx.agentStatusStore?.get(ptyId);
      if (status?.state === 'waiting') {
        await new Promise((resolve) => setTimeout(resolve, 100));
        continue;
      }
      const last = lastOutputAt.get(ptyId);
      const activity = ctx.agentStatusStore?.getActivitySnapshot(ptyId);
      const hasExplicitReadySignal = Boolean(
        activity &&
          activity.state === 'idle' &&
          (activity.lastHookAt > 0 || activity.source === 'osc7501' || activity.source === 'title'),
      );
      const requiredQuietMs = hasExplicitReadySignal ? Math.min(quietMs, 300) : quietMs;
      if (last !== undefined && Date.now() - last >= requiredQuietMs) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  };
  const events = {
    data: (event: { ptyId: string; data: string; sequence: number }) => {
      if (lastOutputAt.has(event.ptyId)) lastOutputAt.set(event.ptyId, Date.now());
      const utf8 = Buffer.from(event.data, 'base64').toString('utf8');
      tracker.ingestUtf8Data(event.ptyId, utf8);
      if (ctx.agentStatusStore) {
        const res = ctx.agentStatusStore.ingestPtyData(event.ptyId, utf8);
        if (res.replyToWrite) {
          void service.input(event.ptyId, res.replyToWrite);
        }
      }
      ctx.liveWindow()?.webContents.send('shell-pty:data', event);
    },
    exit: (event: { ptyId: string; exitCode: number | null }) => {
      if (lastOutputAt.has(event.ptyId)) exitedPtys.add(event.ptyId);
      tracker.markExited(event.ptyId, event.exitCode);
      ctx.agentStatusStore?.handlePtyExit(event.ptyId, event.exitCode);
      notifyExitListeners(event.ptyId);
      ctx.liveWindow()?.webContents.send('shell-pty:exit', event);
    },
    restore: (snapshot: Snapshot) => {
      const screen = tracker.restoreScreen(snapshot.ptyId, snapshot.screenSnapshot);
      if (screen && !snapshot.exited) ctx.agentStatusStore?.seedStartupScreen(snapshot.ptyId, screen);
      ctx.liveWindow()?.webContents.send('shell-pty:restore', snapshot);
    },
  };
  const shellIntegrationDir = ctx.userDataDir
    ? () => join(ctx.userDataDir!(), 'shell-integration')
    : undefined;
  const daemonConfig = ctx.daemon
    ? {
        ...ctx.daemon,
        shellIntegrationDir:
          ctx.daemon.shellIntegrationDir ??
          (ctx.userDataDir
            ? join(ctx.userDataDir(), 'shell-integration')
            : join(ctx.daemon.dataDir, 'shell-integration')),
      }
    : null;
  const daemonService = daemonConfig
    ? new DaemonTerminalSessions(
        daemonConfig,
        events,
        () => ctx.getCurrentCwd() ?? undefined,
        ctx.agentHookEnv,
        ctx.mcpLaunchArgsForCli,
      )
    : null;
  const localService = daemonService
    ? null
    : new LocalTerminalSessions(
        getPtyHost(),
        events,
        () => ctx.getCurrentCwd() ?? undefined,
        shellIntegrationDir,
        ctx.agentHookEnv,
        ctx.mcpLaunchArgsForCli,
      );
  let cleanupBound = false;

  handleSecure('shell-pty:list-clis', {
    schema: z.object({}).strict(), authorize, authorizeError,
    handler: () => ({ ok: true, clis: listLocalClis() }),
  });
  handleSecure('shell-pty:list-shells', {
    schema: z.object({}).strict(), authorize, authorizeError,
    handler: () => ({ ok: true, shells: listLocalShells(), defaultCwd: homedir() }),
  });
  const service = daemonService ?? localService!;
  handleSecure('shell-pty:create', {
    schema: shellPtyCreateSchema, authorize, authorizeError,
    handler: async (payload) => {
      if (!cleanupBound) {
        ctx.liveWindow()!.webContents.once('destroyed', () => {
          if (daemonService) daemonService.detachAll();
          else localService?.closeAll();
          cleanupBound = false;
        });
        cleanupBound = true;
      }
      const snapshot = await service.create(payload);
      if (
        snapshot &&
        typeof snapshot === 'object' &&
        'ptyId' in snapshot &&
        typeof snapshot.ptyId === 'string'
      ) {
        const snapObj = snapshot as Record<string, unknown>;
        tracker.registerPty({
          ptyId: snapshot.ptyId,
          cwd: typeof snapObj.cwd === 'string' ? snapObj.cwd : payload.cwd,
          cliId: payload.cliId,
          shellId: payload.shellId,
          cols: payload.cols,
          rows: payload.rows,
          replayBase64: typeof snapObj.replay === 'string' ? snapObj.replay : undefined,
          exited: snapObj.exited === true,
          exitCode: typeof snapObj.exitCode === 'number' ? snapObj.exitCode : null,
        });
        // Re-attaching a pane without a cliId must not erase what the orchestrator registered.
        ctx.agentStatusStore?.registerPane(
          snapshot.ptyId,
          payload.cliId ? { agentId: payload.cliId } : undefined,
        );
        if ('screenSnapshot' in snapshot) {
          const restored = (snapshot as Snapshot).screenSnapshot;
          const screen = tracker.restoreScreen(snapshot.ptyId, restored);
          if (screen && !snapObj.exited) ctx.agentStatusStore?.seedStartupScreen(snapshot.ptyId, screen);
          if (snapObj.exited) ctx.agentStatusStore?.handlePtyExit(snapshot.ptyId, (snapshot as Snapshot).exitCode ?? null);
        }
      }
      return snapshot;
    },
  });
  handleSecure('shell-pty:input', {
    schema: shellPtyInputSchema, authorize, authorizeError,
    handler: ({ ptyId, data }) => {
      ctx.agentStatusStore?.notifyUserInput(ptyId, data);
      if (data.includes('\r') || data.includes('\n')) {
        ctx.orchestrationService?.recordUserPromptTurn(ptyId, 'pty');
      }
      return service.input(ptyId, data);
    },
  });
  handleSecure('shell-pty:resize', {
    schema: shellPtyResizeSchema, authorize, authorizeError,
    handler: ({ ptyId, rows, cols }) => {
      tracker.resizePty(ptyId, rows, cols);
      return service.resize(ptyId, rows, cols);
    },
  });
  handleSecure('shell-pty:kill', {
    schema: shellPtyIdSchema, authorize, authorizeError,
    handler: async ({ ptyId }) => {
      const result = await service.close(ptyId);
      if (result && typeof result === 'object' && 'ok' in result && result.ok !== false) {
        ctx.agentStatusStore?.removePane(ptyId);
        tracker.markExited(ptyId, null);
        notifyExitListeners(ptyId);
      }
      return result;
    },
  });
  handleSecure('shell-pty:open-link', {
    schema: shellPtyOpenLinkSchema, authorize, authorizeError,
    handler: async ({ target, cwd }) => {
      if (/^https?:\/\//i.test(target)) {
        let parsed: URL;
        try {
          parsed = new URL(target);
        } catch {
          return { ok: false, error: '无效的 URL' };
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, error: '不支持的链接协议' };
        }
        const { shell } = await import('electron');
        await shell.openExternal(parsed.toString());
        return { ok: true, action: 'external' as const };
      }

      const resolved = resolveTerminalLinkPath(target, cwd);
      if (!resolved) {
        return { ok: false, error: '无效或不安全的本地路径' };
      }
      let probed: { isDirectory: boolean } | null = null;
      try {
        probed = await safeStatLocalPath(resolved);
      } catch {
        return { ok: false, error: '目标文件或目录不存在' };
      }
      if (!probed) {
        return { ok: false, error: '已拦截指向网络或设备路径的符号链接' };
      }

      const action = await inspectLinkedFile(resolved);
      const { shell } = await import('electron');
      if (action !== 'open') {
        shell.showItemInFolder(resolved);
        return { ok: true, action: 'revealed' as const, path: resolved };
      }
      const errMsg = await shell.openPath(resolved);
      if (errMsg) {
        return { ok: false, error: errMsg };
      }
      return { ok: true, action: 'opened' as const, path: resolved };
    },
  });
  handleSecure('shell-pty:check-paths', {
    schema: shellPtyCheckPathsSchema, authorize, authorizeError,
    handler: async ({ cwd, paths }) => {
      const existing: Record<string, { path: string; isDirectory: boolean }> = {};
      await Promise.all(
        paths.map(async (rawPath) => {
          const resolved = resolveTerminalLinkPath(rawPath, cwd);
          if (!resolved) return;
          try {
            const s = await safeStatLocalPath(resolved);
            if (s) {
              existing[rawPath] = { path: resolved, isDirectory: s.isDirectory };
            }
          } catch {
            // Non-existent path is simply omitted from `existing`.
          }
        }),
      );
      return { ok: true, existing };
    },
  });
  handleSecure('workspace-state:get', {
    schema: z.object({}).strict(), authorize, authorizeError,
    handler: () => {
      if (!ctx.userDataDir) return { ok: true, state: null };
      const raw = getDefaultWorkspaceStateStore(ctx.userDataDir).read();
      if (raw === null) return { ok: true, state: null };
      // The file is user-editable and may predate the current schema; only hand the renderer a known shape.
      const parsed = workspaceStateSetSchema.safeParse(raw);
      if (!parsed.success) {
        console.warn('[workspace-state] ignoring saved state that does not match the schema:', parsed.error.issues[0]?.message);
        return { ok: true, state: null };
      }
      return { ok: true, state: parsed.data };
    },
  });
  handleSecure('workspace-state:set', {
    schema: workspaceStateSetSchema, authorize, authorizeError,
    handler: async (payload) => {
      if (!ctx.userDataDir) return { ok: true };
      try {
        return await getDefaultWorkspaceStateStore(ctx.userDataDir).write(payload);
      } catch (error) {
        console.error('[workspace-state] failed to write:', error);
        throw error;
      }
    },
  });

  return {
    sendInput: (ptyId: string, data: string) => {
      ctx.agentStatusStore?.notifyUserInput(ptyId, data);
      return service.input(ptyId, data);
    },
    createPty: async (payload) => {
      const terminalId =
        payload.terminalId ??
        `orch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const cwd = payload.cwd ?? ctx.getCurrentCwd() ?? process.cwd();
      const rawCliId = payload.cliId?.trim();
      let target: { cliId?: OrchestrationCliId; shellId?: (typeof LOCAL_SHELL_IDS)[number] };
      if (!rawCliId) {
        target = { shellId: 'default' };
      } else if (isOrchestrationCliId(rawCliId)) {
        target = { cliId: rawCliId };
      } else if ((LOCAL_SHELL_IDS as readonly string[]).includes(rawCliId)) {
        target = { shellId: rawCliId as (typeof LOCAL_SHELL_IDS)[number] };
      } else {
        throw new Error(`Unknown worker cliId: ${rawCliId}`);
      }

      const createPayload = {
        terminalId,
        cwd,
        ...target,
        ...(payload.extraArgs && payload.extraArgs.length > 0 ? { extraArgs: payload.extraArgs } : {}),
        cols: payload.cols ?? 120,
        rows: payload.rows ?? 32,
      };
      const expectedPtyId = `local-${terminalId}`;
      if (payload.waitForReady) lastOutputAt.set(expectedPtyId, Number.NaN);
      try {
        const snapshot = (await service.create(createPayload)) as { ptyId?: unknown; cwd?: unknown; replay?: unknown };
        const ptyId = typeof snapshot?.ptyId === 'string' ? snapshot.ptyId : expectedPtyId;
        const resolvedCwd = typeof snapshot?.cwd === 'string' ? snapshot.cwd : cwd;
        tracker.registerPty({
          ptyId,
          cwd: resolvedCwd,
          cliId: target.cliId ?? null,
          shellId: target.shellId ?? null,
          cols: createPayload.cols,
          rows: createPayload.rows,
          replayBase64: typeof snapshot?.replay === 'string' ? snapshot.replay : undefined,
        });
        ctx.agentStatusStore?.registerPane(ptyId, { agentId: target.cliId ?? null });
        if (payload.waitForReady) {
          await waitForOutputSettled(
            ptyId,
            payload.waitForReady.quietMs ?? 1_500,
            payload.waitForReady.maxMs ?? 20_000,
          );
        }
        return { ptyId, cwd: resolvedCwd };
      } finally {
        lastOutputAt.delete(expectedPtyId);
        exitedPtys.delete(expectedPtyId);
      }
    },
    closePty: async (ptyId: string) => {
      const result = (await service.close(ptyId)) as { ok?: boolean; error?: string } | undefined;
      if (result?.ok !== false) {
        ctx.agentStatusStore?.removePane(ptyId);
        tracker.markExited(ptyId, null);
        notifyExitListeners(ptyId);
      }
      return { ok: result?.ok !== false, ...(result?.error ? { error: result.error } : {}) };
    },
    onPtyExit: (cb: (ptyId: string) => void) => {
      exitListeners.add(cb);
      return () => exitListeners.delete(cb);
    },
    tracker,
    isPtyAlive: (ptyId: string) => {
      const tracked = tracker.getTerminal(ptyId);
      if (tracked) return tracked.alive;
      return Boolean(ctx.agentStatusStore?.get(ptyId));
    },
  };
}
