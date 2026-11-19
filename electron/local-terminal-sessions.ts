import { randomUUID } from 'node:crypto';
import { type PtyHost, resolveDefaultShell } from './pty-host.js';
import { mergeTerminalProcessEnv, resolveLocalTerminal, type LocalShellId, type OrchestrationCliId } from './local-cli.js';
import { mergedSubprocessEnv } from './settings-loader.js';
import { TerminalSessions } from './terminal-sessions.js';
import { applyShellIntegration } from './shell-integration/index.js';

export interface LocalTerminalLaunch {
  terminalId?: string;
  cliId?: OrchestrationCliId;
  shellId?: LocalShellId;
  cwd?: string;
  cols?: number;
  rows?: number;
  extraArgs?: string[];
}

export interface LocalTerminalData { ptyId: string; data: string; sequence: number }
export interface LocalTerminalExit { ptyId: string; exitCode: number | null }

export function mergeCliLaunchArgs(
  mcpArgs: readonly string[],
  extraArgs?: readonly string[],
): string[] | undefined {
  const userArgs = extraArgs ?? [];
  if (mcpArgs.length === 0) return userArgs.length > 0 ? [...userArgs] : undefined;
  const hasMcpConfig = userArgs.some(
    (arg) => arg === '--mcp-config' || arg.startsWith('--mcp-config='),
  );
  const hasCodexAhaMcp = userArgs.some((arg) => arg.includes('mcp_servers.aha.'));
  const filtered: string[] = [];
  for (let i = 0; i < mcpArgs.length; i += 1) {
    const arg = mcpArgs[i]!;
    if (arg === '--mcp-config' && hasMcpConfig) {
      i += 1;
      continue;
    }
    if (arg === '-c' && mcpArgs[i + 1]?.includes('mcp_servers.aha.') && hasCodexAhaMcp) {
      i += 1;
      continue;
    }
    filtered.push(arg);
  }
  const combined = [...filtered, ...userArgs];
  return combined.length > 0 ? combined : undefined;
}

/** App launch configuration stays outside the pure process service. */
export class LocalTerminalSessions {
  private core: TerminalSessions;
  constructor(
    host: PtyHost,
    events: { data: (event: LocalTerminalData) => void; exit: (event: LocalTerminalExit) => void },
    private currentCwd: () => string | undefined,
    private wrapperBaseDir?: () => string | undefined,
    private extraEnv?: (ptyId: string, cliId?: OrchestrationCliId) => Record<string, string>,
    private mcpLaunchArgsForCli?: (cliId: OrchestrationCliId) => string[],
  ) { this.core = new TerminalSessions(host, events); }

  create(payload: LocalTerminalLaunch) {
    const ptyId = payload.terminalId ? `local-${payload.terminalId}` : `shell-${randomUUID()}`;
    const existing = this.core.get(ptyId);
    if (existing) return existing;
    const mergedArgs = payload.cliId
      ? mergeCliLaunchArgs(this.mcpLaunchArgsForCli?.(payload.cliId) ?? [], payload.extraArgs)
      : payload.extraArgs;
    const target = payload.terminalId || payload.cliId || payload.shellId
      ? resolveLocalTerminal(payload.cliId, payload.shellId, mergedArgs) : null;
    const cwd = payload.cwd ?? target?.cwd ?? this.currentCwd() ?? process.cwd();
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