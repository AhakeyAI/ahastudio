import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { ensureTerminalDaemon, type DaemonLaunchOptions } from './terminal-daemon/launcher.js';
import type { TerminalClient } from './terminal-daemon/client.js';
import type { DaemonEvent, Snapshot } from './terminal-daemon/protocol.js';
import { resolveDefaultShell } from './pty-host.js';
import { mergeTerminalProcessEnv, resolveLocalTerminal, type OrchestrationCliId } from './local-cli.js';
import { mergedSubprocessEnv } from './settings-loader.js';
import { applyShellIntegration } from './shell-integration/index.js';
import { clampTerminalDim } from './terminal-size.js';
import type {
  LocalTerminalData,
  LocalTerminalExit,
  LocalTerminalLaunch,
} from './local-terminal-sessions.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_INPUT_CHUNK = 8192;

export function toDaemonUuid(rawId: string): string {
  if (UUID_RE.test(rawId)) return rawId.toLowerCase();
  const bytes = Buffer.from(
    createHash('sha256').update(`ahastation-terminal:${rawId}`).digest().subarray(0, 16)
  );
  // Set RFC 4122 version 5 + variant 1 bits so Zod z.string().uuid() always accepts it.
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function isExecutableFile(candidate: string): boolean {
  try {
    accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveAbsoluteExecutable(file: string, env: Record<string, string>): string {
  if (isAbsolute(file)) return file;
  const pathVal = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path ?? '';
  const dirs = pathVal.split(delimiter).filter(Boolean);
  const exts =
    process.platform === 'win32'
      ? (env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
          .split(';')
          .filter(Boolean)
      : [''];
  const hasKnownExt =
    process.platform === 'win32' && /\.[a-z0-9]+$/i.test(file);

  for (const dir of dirs) {
    if (hasKnownExt || exts.length === 0) {
      const candidate = join(dir, file);
      if (isExecutableFile(candidate)) return candidate;
    } else {
      for (const ext of exts) {
        const candidate = join(dir, `${file}${ext}`);
        if (isExecutableFile(candidate)) return candidate;
      }
    }
  }
  return resolve(file);
}

function normalizeEnv(env: Record<string, string | undefined>): Record<string, string> {
  const clean: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') clean[key] = value;
  }
  return clean;
}

export interface DaemonSessionConfig {
  dataDir: string;
  runtimePath?: string;
  entryPath?: string;
  shellIntegrationDir?: string;
}

export class DaemonTerminalSessions {
  private clientPromise: Promise<TerminalClient> | null = null;
  private activeClient: TerminalClient | null = null;
  private unsubEvents: (() => void) | null = null;
  private unsubDisconnect: (() => void) | null = null;
  private connectionGeneration = 0;
  private readonly ptyToDaemonId = new Map<string, string>();
  private readonly daemonToPtyId = new Map<string, string>();
  // The daemon tracks attachments per connection, so a new connection must re-attach every live terminal.
  private readonly attachedDaemonIds = new Set<string>();

  constructor(
    private readonly config: DaemonSessionConfig,
    private readonly events: {
      data: (event: LocalTerminalData) => void;
      exit: (event: LocalTerminalExit) => void;
      restore?: (snapshot: Snapshot) => void;
    },
    private readonly currentCwd: () => string | undefined,
    private readonly extraEnv?: (ptyId: string, cliId?: OrchestrationCliId) => Record<string, string>,
  ) {}

  private async getClient(): Promise<TerminalClient> {
    if (this.activeClient) return this.activeClient;
    if (!this.clientPromise) {
      const launchOpts: DaemonLaunchOptions = {
        dataDir: this.config.dataDir,
        runtimePath: this.config.runtimePath ?? process.execPath,
        entryPath: this.config.entryPath,
      };
      const generation = this.connectionGeneration;
      this.clientPromise = ensureTerminalDaemon(launchOpts)
        .then(async (client) => {
          if (generation !== this.connectionGeneration) {
            client.disconnect();
            throw new Error('Terminal client detached');
          }
          const restoreBuffers = new Map<string, DaemonEvent[]>();
          this.unsubEvents = client.onEvent((event) => {
            const pending = restoreBuffers.get(event.terminalId);
            if (pending) pending.push(event);
            else this.forwardEvent(event);
          });
          try {
            await this.reattachAll(client, restoreBuffers);
          } catch (error) {
            this.unsubEvents?.();
            this.unsubEvents = null;
            client.disconnect();
            throw error;
          }
          if (generation !== this.connectionGeneration) {
            client.disconnect();
            throw new Error('Terminal client detached');
          }
          this.activeClient = client;
          this.unsubDisconnect = client.onDisconnect(() => {
            this.resetClientConnection(client);
            if (generation === this.connectionGeneration && this.attachedDaemonIds.size) {
              void this.getClient().catch(error => console.warn('[shell-pty] reconnect failed:', error));
            }
          });
          return client;
        })
        .finally(() => {
          this.clientPromise = null;
        });
    }
    return this.clientPromise;
  }

  private resetClientConnection(only?: TerminalClient): void {
    // A concurrent caller may already have replaced the failed client; do not destroy its replacement.
    if (only && this.activeClient !== only) return;
    this.unsubEvents?.();
    this.unsubEvents = null;
    this.unsubDisconnect?.();
    this.unsubDisconnect = null;
    if (this.activeClient) {
      this.activeClient.disconnect();
      this.activeClient = null;
    }
  }

  private forwardEvent(event: DaemonEvent): void {
    const ptyId = this.daemonToPtyId.get(event.terminalId) ?? event.terminalId;
    if (event.event === 'output') {
      this.events.data({ ptyId, data: event.data, sequence: event.sequence });
    } else {
      this.attachedDaemonIds.delete(event.terminalId);
      this.daemonToPtyId.delete(event.terminalId);
      this.events.exit({ ptyId, exitCode: event.exitCode });
    }
  }

  private async reattachAll(client: TerminalClient, buffers: Map<string, DaemonEvent[]>): Promise<void> {
    for (const daemonId of [...this.attachedDaemonIds]) {
      const events: DaemonEvent[] = [];
      buffers.set(daemonId, events);
      try {
        const snapshot = await client.attach(daemonId, true);
        const ptyId = this.daemonToPtyId.get(daemonId) ?? daemonId;
        this.events.restore?.({ ...snapshot, ptyId });
        if (snapshot.exited) {
          this.forwardEvent({ event: 'exit', terminalId: daemonId, exitCode: snapshot.exitCode ?? null });
        } else {
          for (const event of events) {
            if (event.event === 'exit' || event.sequence > snapshot.sequence) this.forwardEvent(event);
          }
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        if (msg === 'Unknown terminal') {
          this.forwardEvent({ event: 'exit', terminalId: daemonId, exitCode: null });
        } else throw error;
      } finally {
        buffers.delete(daemonId);
      }
    }
  }

  private async withClient<T>(
    fn: (client: TerminalClient) => Promise<T>,
    reattachDaemonId?: string
  ): Promise<T> {
    const client = await this.getClient();
    try {
      return await fn(client);
    } catch (error) {
      const msg = error instanceof Error ? error.message : '';
      const lostLease = msg.includes('Terminal has no controller lease') ||
        msg === 'Stale terminal controller';
      const disconnected = msg.includes('Terminal disconnected');
      if (!lostLease && !disconnected) throw error;
      this.resetClientConnection(client);
      // After a drop mid-request the daemon may or may not have applied it; replaying could duplicate input.
      if (msg.includes('outcome may be unknown')) throw error;
      const fresh = await this.getClient();
      if (reattachDaemonId && !this.attachedDaemonIds.has(reattachDaemonId)) {
        const attached = await fresh.attach(reattachDaemonId, true);
        if (!attached.exited) {
          this.attachedDaemonIds.add(reattachDaemonId);
        }
      }
      return fn(fresh);
    }
  }

  async create(payload: LocalTerminalLaunch): Promise<Snapshot> {
    const ptyId = payload.terminalId ? `local-${payload.terminalId}` : `shell-${randomUUID()}`;
    const daemonId = toDaemonUuid(ptyId);
    this.ptyToDaemonId.set(ptyId, daemonId);
    this.daemonToPtyId.set(daemonId, ptyId);

    const cols = clampTerminalDim(payload.cols, 100);
    const rows = clampTerminalDim(payload.rows, 30);

    return this.withClient(async (client) => {
      try {
        const attached = await client.attach(daemonId, true);
        this.attachedDaemonIds.add(daemonId);
        if (attached.cols !== cols || attached.rows !== rows) {
          try {
            await client.resize(daemonId, cols, rows);
          } catch {
            /* ignore resize error on already-exited attached session */
          }
        }
        return { ...attached, ptyId };
      } catch (err) {
        const message = err instanceof Error ? err.message : '';
        if (!message.includes('Unknown terminal')) throw err;
      }

      const target =
        payload.terminalId || payload.cliId || payload.shellId
          ? resolveLocalTerminal(payload.cliId, payload.shellId, payload.extraArgs)
          : null;
      const cwd = resolve(payload.cwd ?? target?.cwd ?? this.currentCwd() ?? process.cwd());
      const rawFile = target?.file ?? resolveDefaultShell();
      const baseEnv = mergeTerminalProcessEnv(
        target?.env ?? mergedSubprocessEnv(),
        {
          AHA_TERMINAL_ID: ptyId,
          PI_PROGRAM_STATUS: '1',
          ...(this.extraEnv?.(ptyId, payload.cliId) ?? {}),
        },
      );
      const integration = applyShellIntegration({
        file: rawFile,
        args: target?.args ?? [],
        env: baseEnv,
        cliId: payload.cliId,
        wrapperBaseDir: this.config.shellIntegrationDir ?? join(this.config.dataDir, 'shell-integration'),
      });
      const env = normalizeEnv(integration.env);
      const file = resolveAbsoluteExecutable(integration.file, env);
      const label = (payload.cliId ?? payload.shellId ?? '').slice(0, 256);

      await client.spawn(randomUUID(), {
        terminalId: daemonId,
        label,
        file,
        args: integration.args,
        cwd,
        env,
        cols,
        rows,
      });
      const attached = await client.attach(daemonId, true);
      this.attachedDaemonIds.add(daemonId);
      console.log(`[shell-pty] AUDIT daemon-create: ptyId=${ptyId} daemonId=${daemonId} cwd=${cwd} shell=${file}`);
      return { ...attached, ptyId };
    });
  }

  async input(ptyId: string, data: string): Promise<{ ok: boolean; error?: string }> {
    const daemonId = this.ptyToDaemonId.get(ptyId) ?? toDaemonUuid(ptyId);
    try {
      for (let offset = 0; offset < data.length; offset += MAX_INPUT_CHUNK) {
        const chunk = data.slice(offset, offset + MAX_INPUT_CHUNK);
        await this.withClient(client => client.input(daemonId, chunk), daemonId);
      }
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'Terminal input failed' };
    }
  }

  async resize(ptyId: string, rows: number, cols: number): Promise<{ ok: boolean }> {
    const daemonId = this.ptyToDaemonId.get(ptyId) ?? toDaemonUuid(ptyId);
    const clampedCols = clampTerminalDim(cols, 100);
    const clampedRows = clampTerminalDim(rows, 30);
    try {
      await this.withClient((client) => client.resize(daemonId, clampedCols, clampedRows), daemonId);
      return { ok: true };
    } catch {
      return { ok: false };
    }
  }

  async close(ptyId: string): Promise<{ ok: boolean; error?: string }> {
    const daemonId = this.ptyToDaemonId.get(ptyId) ?? toDaemonUuid(ptyId);
    // daemonToPtyId stays until the exit event, so the renderer still receives it under the original ptyId.
    try {
      await this.withClient((client) => client.terminate(daemonId), daemonId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== 'Unknown terminal') return { ok: false, error: message };
    }
    this.ptyToDaemonId.delete(ptyId);
    this.attachedDaemonIds.delete(daemonId);
    return { ok: true };
  }

  /** Disconnect client socket on window close without terminating daemon-hosted PTYs. */
  detachAll(): void {
    this.connectionGeneration += 1;
    this.attachedDaemonIds.clear();
    this.resetClientConnection();
  }
}
