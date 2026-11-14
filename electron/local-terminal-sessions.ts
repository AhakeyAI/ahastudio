import { randomUUID } from 'node:crypto';
import { type PtyHost, resolveDefaultShell } from './pty-host.js';
import { resolveLocalTerminal, type LocalCliId, type LocalShellId } from './local-cli.js';
import { mergedSubprocessEnv } from './settings-loader.js';
import { TerminalSessions } from './terminal-sessions.js';
import { applyShellIntegration } from './shell-integration/index.js';

export interface LocalTerminalLaunch {
  terminalId?: string;
  cliId?: LocalCliId;
  shellId?: LocalShellId;
  cwd?: string;
  cols?: number;
  rows?: number;
}

export interface LocalTerminalData { ptyId: string; data: string; sequence: number }
export interface LocalTerminalExit { ptyId: string; exitCode: number | null }

/** App launch configuration stays outside the pure process service. */
export class LocalTerminalSessions {
  private core: TerminalSessions;
  constructor(
    host: PtyHost,
    events: { data: (event: LocalTerminalData) => void; exit: (event: LocalTerminalExit) => void },
    private currentCwd: () => string | undefined,
    private wrapperBaseDir?: () => string | undefined,
    private extraEnv?: (ptyId: string, cliId?: LocalCliId) => Record<string, string>,
  ) { this.core = new TerminalSessions(host, events); }

  create(payload: LocalTerminalLaunch) {
    const ptyId = payload.terminalId ? `local-${payload.terminalId}` : `shell-${randomUUID()}`;
    const existing = this.core.get(ptyId);
    if (existing) return existing;
    const target = payload.terminalId || payload.cliId || payload.shellId
      ? resolveLocalTerminal(payload.cliId, payload.shellId) : null;
    const cwd = payload.cwd ?? target?.cwd ?? this.currentCwd() ?? process.cwd();
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
      wrapperBaseDir: this.wrapperBaseDir?.(),
    });
    const result = this.core.create(ptyId, {
      file: integration.file, args: integration.args, cwd, env: integration.env,
      cols: payload.cols ?? 100, rows: payload.rows ?? 30,
    }, payload.cliId ?? payload.shellId, !!payload.terminalId);
    console.log(`[shell-pty] AUDIT create: ptyId=${ptyId} cwd=${cwd} shell=${integration.file}`);
    return result;
  }
  input(ptyId: string, data: string) { return this.core.input(ptyId, data); }
  resize(ptyId: string, rows: number, cols: number) { return this.core.resize(ptyId, rows, cols); }
  close(ptyId: string) { return this.core.close(ptyId); }
  closeAll() { this.core.closeAll(); }
}