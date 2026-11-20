// Manual terminals launch the user's installed commands with their own
// configuration. They do not use meeting backends, SDKs, or app API keys.
import { homedir } from 'node:os';
import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { augmentedPath, resolveBinaryFromPath } from './bin-resolve.js';
import { resolveDefaultShell } from './pty-host.js';

export const LOCAL_CLI_IDS = ['codex', 'claude', 'opencode', 'qoder', 'kimi', 'qwen', 'pi', 'antigravity', 'grok', 'gemini'] as const;
export type LocalCliId = typeof LOCAL_CLI_IDS[number];
export const ORCHESTRATION_CLI_IDS = LOCAL_CLI_IDS;
export type OrchestrationCliId = typeof ORCHESTRATION_CLI_IDS[number];
export const LOCAL_SHELL_IDS = ['default', 'pwsh', 'powershell', 'cmd', 'git-bash'] as const;
export type LocalShellId = typeof LOCAL_SHELL_IDS[number];

export interface LocalCliInventoryEntry {
  id: LocalCliId;
  label: string;
  command: string;
  binaryPath: string | null;
  installed: boolean;
}

export interface ResolveMcpLaunchArgsOptions {
  mcpServerPath?: string;
  claudeMcpConfigPath?: string;
  nodeCommand?: string;
  enabled?: boolean;
}

const ALL_COMMANDS: Record<OrchestrationCliId, { label: string; command: string }> = {
  codex: { label: 'Codex', command: 'codex' },
  claude: { label: 'Claude Code', command: 'claude' },
  gemini: { label: 'Gemini CLI', command: 'gemini' },
  opencode: { label: 'OpenCode', command: 'opencode' },
  qoder: { label: 'Qoder CLI', command: 'qodercli' },
  kimi: { label: 'Kimi', command: 'kimi' },
  qwen: { label: 'Qwen Code', command: 'qwen' },
  pi: { label: 'Pi', command: 'pi' },
  antigravity: { label: 'Antigravity', command: 'agy' },
  grok: { label: 'Grok', command: 'grok' },
};

export function isOrchestrationCliId(value: string): value is OrchestrationCliId {
  return (ORCHESTRATION_CLI_IDS as readonly string[]).includes(value);
}

export function listLocalCliInventory(): LocalCliInventoryEntry[] {
  return LOCAL_CLI_IDS.map((id) => {
    const entry = ALL_COMMANDS[id];
    const binaryPath = resolveBinaryFromPath(entry.command);
    return { id, ...entry, binaryPath, installed: binaryPath !== null };
  });
}

export function resolveMcpLaunchArgs(
  cliId: OrchestrationCliId,
  opts?: ResolveMcpLaunchArgsOptions,
): string[] {
  if (opts?.enabled === false) return [];
  if (cliId === 'claude') {
    const configPath = opts?.claudeMcpConfigPath?.trim();
    return configPath ? ['--mcp-config', configPath] : [];
  }
  if (cliId === 'codex') {
    const serverPath = opts?.mcpServerPath?.trim();
    if (!serverPath) return [];
    const nodeCommand = opts?.nodeCommand?.trim() || 'node';
    const normalizedServerPath = serverPath.replace(/\\/g, '/');
    return [
      '-c',
      `mcp_servers.aha.command=${JSON.stringify(nodeCommand)}`,
      '-c',
      `mcp_servers.aha.args=${JSON.stringify([normalizedServerPath])}`,
    ];
  }
  return [];
}

export function listLocalClis() {
  return LOCAL_CLI_IDS.flatMap((id) => {
    const entry = ALL_COMMANDS[id];
    const binaryPath = resolveBinaryFromPath(entry.command);
    return binaryPath ? [{ id, ...entry, binaryPath }] : [];
  });
}

export function listLocalShells() {
  const defaultPath = resolveDefaultShell();
  const entries = [{ id: 'default', label: `默认终端 · ${basename(defaultPath).replace(/\.exe$/i, '')}`, command: 'shell', binaryPath: defaultPath }];
  if (process.platform !== 'win32') return entries;
  for (const [id, label] of [['pwsh', 'PowerShell 7'], ['powershell', 'Windows PowerShell'], ['cmd', '命令提示符']] as const) {
    const binaryPath = resolveBinaryFromPath(id);
    if (binaryPath) entries.push({ id, label, command: id, binaryPath });
  }
  const git = resolveBinaryFromPath('git');
  const gitBash = [
    ...(git ? [join(dirname(git), '..', 'bin', 'bash.exe')] : []),
    join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'),
    join(process.env.LOCALAPPDATA ?? homedir(), 'Programs', 'Git', 'bin', 'bash.exe'),
  ].find(existsSync);
  if (gitBash) entries.push({ id: 'git-bash', label: 'Git Bash', command: 'bash', binaryPath: gitBash });
  return entries;
}

export function mergeTerminalProcessEnv(
  base: NodeJS.ProcessEnv,
  overlay: Record<string, string | undefined>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  let canonicalPathKey: string | null = null;
  const pathSegments: string[] = [];
  const seenSegments = new Set<string>();
  const addSegments = (raw: string | undefined, prepend = false) => {
    if (!raw) return;
    const items = raw.split(delimiter).filter(Boolean);
    const fresh: string[] = [];
    for (const seg of items) {
      const norm = process.platform === 'win32' ? seg.toLowerCase() : seg;
      if (!seenSegments.has(norm)) {
        seenSegments.add(norm);
        fresh.push(seg);
      }
    }
    if (prepend) pathSegments.unshift(...fresh);
    else pathSegments.push(...fresh);
  };

  for (const [k, v] of Object.entries(base)) {
    if (k.toUpperCase() === 'PATH') {
      canonicalPathKey = canonicalPathKey ?? k;
      addSegments(v, false);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  for (const [k, v] of Object.entries(overlay)) {
    if (k.toUpperCase() === 'PATH') {
      canonicalPathKey = canonicalPathKey ?? k;
      // Prepend overlay PATH entries (such as orchestration-bin) ahead of base PATH.
      addSegments(v, true);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }

  const finalPathKey =
    canonicalPathKey ??
    Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ??
    'PATH';
  if (pathSegments.length > 0) {
    out[finalPathKey] = pathSegments.join(delimiter);
  }
  return out;
}

function readGrokUiThemeConfig(env: NodeJS.ProcessEnv): {
  theme?: string;
  autoLightTheme?: string;
  autoDarkTheme?: string;
} {
  const grokHome = env.GROK_HOME?.trim() || join(homedir(), '.grok');
  const configPath = join(grokHome, 'config.toml');
  if (!existsSync(configPath)) return {};
  let raw: string;
  try {
    raw = readFileSync(configPath, 'utf8');
  } catch {
    return {};
  }
  let inUiSection = false;
  const out: { theme?: string; autoLightTheme?: string; autoDarkTheme?: string } = {};
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const sectionMatch = /^\[([^\]]+)\]/.exec(line);
    if (sectionMatch) {
      inUiSection = sectionMatch[1].trim() === 'ui';
      continue;
    }
    if (!inUiSection) continue;
    const kv = /^(theme|auto_light_theme|auto_dark_theme)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(line);
    if (!kv) continue;
    const value = (kv[2] ?? kv[3] ?? '').trim();
    if (kv[1] === 'theme') out.theme = value;
    else if (kv[1] === 'auto_light_theme') out.autoLightTheme = value;
    else if (kv[1] === 'auto_dark_theme') out.autoDarkTheme = value;
  }
  return out;
}

function resolveGrokDefaultTheme(appearance: 'light' | 'dark', env: NodeJS.ProcessEnv): string | null {
  const cfg = readGrokUiThemeConfig(env);
  const configured = cfg.theme?.toLowerCase();
  if (configured && configured !== 'auto' && configured !== 'system') {
    return null;
  }
  return appearance === 'light'
    ? (cfg.autoLightTheme || 'grokday')
    : (cfg.autoDarkTheme || 'groknight');
}

export function resolveLocalTerminal(
  cliId?: OrchestrationCliId,
  shellId: LocalShellId = 'default',
  extraArgs?: readonly string[],
  options?: { appearance?: 'light' | 'dark' },
) {
  const file = cliId ? resolveBinaryFromPath(ALL_COMMANDS[cliId].command)
    : shellId === 'default' ? resolveDefaultShell() : listLocalShells().find((shell) => shell.id === shellId)?.binaryPath;
  if (!file) throw new Error(`未找到本机 ${cliId ? ALL_COMMANDS[cliId].label : 'Shell'}，请检查安装和 PATH 后重试。`);
  const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.toUpperCase() !== 'PATH' && v !== undefined) env[k] = v;
  }
  env[pathKey] = augmentedPath();
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  if (options?.appearance) {
    if (!env.COLORFGBG) env.COLORFGBG = options.appearance === 'light' ? '0;15' : '15;0';
    if (!env.GROK_APPEARANCE && !env.LC_GROK_APPEARANCE) env.GROK_APPEARANCE = options.appearance;
  }
  // Electron switches belong to the app, not a manually launched CLI.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  if (cliId === 'grok') {
    if (!env.GROK_DISABLE_AUTOUPDATER) env.GROK_DISABLE_AUTOUPDATER = '1';
    if (options?.appearance && !env.GROK_THEME && !env.LC_GROK_THEME) {
      const grokTheme = resolveGrokDefaultTheme(options.appearance, env);
      if (grokTheme) env.GROK_THEME = grokTheme;
    }
  }
  const baseArgs = !cliId && shellId === 'git-bash' ? ['--login', '-i'] : [];
  const args = extraArgs && extraArgs.length > 0 ? [...baseArgs, ...extraArgs] : baseArgs;
  // Keep the user's color and theme preferences unchanged. TERM and
  // COLORTERM above describe the embedded terminal's capabilities only.
  return { file, args, env, cwd: homedir() };
}
