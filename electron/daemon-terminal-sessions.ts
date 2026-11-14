import { createHash, randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { delimiter, isAbsolute, join, resolve } from 'node:path';
import { ensureTerminalDaemon, type DaemonLaunchOptions } from './terminal-daemon/launcher.js';
import type { TerminalClient } from './terminal-daemon/client.js';
import type { Snapshot } from './terminal-daemon/protocol.js';
import { resolveDefaultShell } from './pty-host.js';
import { resolveLocalTerminal, type LocalCliId } from './local-cli.js';
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
  private readonly ptyToDaemonId = new Map<string, string>();
  private readonly daemonToPtyId = new Map<string, string>();
  // The daemon tracks attachments per connection, so a new connection must re-attach every live terminal.
  private readonly attachedDaemonIds = new Set<string>();

  constructor(
    private readonly config: DaemonSessionConfig,
    private readonly events: {
      data: (event: LocalTerminalData) => void;
      exit: (event: LocalTerminalExit) => void;
    },
    private readonly currentCwd: () => string | undefined,
    private readonly extraEnv?: (ptyId: string, cliId?: LocalCliId) => Record<string, string>,
  ) {}

  private async getClient(): Promise<TerminalClient> {
    if (this.activeClient) return this.activeClient;
    if (!this.clientPromise) {
      const launchOpts: DaemonLaunchOptions = {
        dataDir: this.config.dataDir,
        runtimePath: this.config.runtimePath ?? process.execPath,
        entryPath: this.config.entryPath,
      };
      this.clientPromise = ensureTerminalDaemon(launchOpts)
        .then((client) => {
          this.activeClient = client;
          this.unsubEvents?.();
          this.unsubEvents = client.onEvent((ev) => {
            const ptyId = this.daemonToPtyId.get(ev.terminalId) ?? ev.terminalId;
            if (ev.event === 'output') {
              this.events.data({ ptyId, data: ev.data, sequence: ev.sequence });
            } else if (ev.event === 'exit') {
              this.attachedDaemonIds.delete(ev.terminalId);
              this.daemonToPtyId.delete(ev.terminalId);
              this.events.exit({ ptyId, exitCode: ev.exitCode });
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
    if (this.activeClient) {
      this.activeClient.disconnect();
      this.activeClient = null;
    }
  }

  private async reattachAll(client: TerminalClient): Promise<void> {
    for (const daemonId of [...this.attachedDaemonIds]) {
      try {
        await client.attach(daemonId, true);
      } catch (error) {
        const msg = error instanceof Error ? error.message : '';
        if (msg.includes('Unknown terminal')) this.attachedDaemonIds.delete(daemonId);
        else if (msg.includes('Terminal disconnected')) throw error;
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
      const lostLease = msg.includes('Terminal has no controller lease');
      const disconnected = msg.includes('Terminal disconnected');
      if (!lostLease && !disconnected) throw error;
      this.resetClientConnection(client);
      // After a drop mid-request the daemon may or may not have applied it; replaying could duplicate input.
      if (msg.includes('outcome may be unknown')) throw error;
      const fresh = await this.getClient();
      await this.reattachAll(fresh);
      if (reattachDaemonId && !this.attachedDaemonIds.has(reattachDaemonId)) {
        await fresh.attach(reattachDaemonId, true);
        this.attachedDaemonIds.add(reattachDaemonId);
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
          ? resolveLocalTerminal(payload.cliId, payload.shellId)
          : null;
      const cwd = resolve(payload.cwd ?? target?.cwd ?? this.currentCwd() ?? process.cwd());
      const rawFile = target?.file ?? resolveDefaultShell();
      const baseEnv: NodeJS.ProcessEnv = {
        ...(target?.env ?? mergedSubprocessEnv()),
        AHA_TERMINAL_ID: ptyId,
        PI_PROGRAM_STATUS: '1',
        ...(this.extraEnv?.(ptyId, payload.cliId) ?? {}),
      };
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
      await this.withClient(async (client) => {
        for (let offset = 0; offset < data.length; offset += MAX_INPUT_CHUNK) {
          const chunk = data.slice(offset, offset + MAX_INPUT_CHUNK);
          if (chunk.length > 0) {
            await client.input(daemonId, chunk);
          }
        }
      }, daemonId);
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

  async close(ptyId: string): Promise<{ ok: boolean }> {
    const daemonId = this.ptyToDaemonId.get(ptyId) ?? toDaemonUuid(ptyId);
    this.ptyToDaemonId.delete(ptyId);
    // daemonToPtyId stays until the exit event, so the renderer still receives it under the original ptyId.
    try {
      await this.withClient((client) => client.terminate(daemonId), daemonId);
    } catch {
      /* Already exited or daemon absent */
    }
    this.attachedDaemonIds.delete(daemonId);
    return { ok: true };
  }

  /** Disconnect client socket on window close without terminating daemon-hosted PTYs. */
  detachAll(): void {
    this.attachedDaemonIds.clear();
    this.resetClientConnection();
  }
}
