// Manual terminals launch the user's installed commands with their own
// configuration. They do not use meeting backends, SDKs, or app API keys.
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { basename, delimiter, dirname, join } from 'node:path';
import { augmentedPath, resolveBinaryFromPath } from './bin-resolve.js';
import { resolveDefaultShell } from './pty-host.js';

export const LOCAL_CLI_IDS = ['codex', 'claude', 'opencode', 'qoder', 'kimi', 'qwen', 'pi', 'antigravity', 'grok'] as const;
export type LocalCliId = typeof LOCAL_CLI_IDS[number];
export const ORCHESTRATION_CLI_IDS = [...LOCAL_CLI_IDS, 'gemini'] as const;
export type OrchestrationCliId = typeof ORCHESTRATION_CLI_IDS[number];
export const LOCAL_SHELL_IDS = ['default', 'pwsh', 'powershell', 'cmd', 'git-bash'] as const;
export type LocalShellId = typeof LOCAL_SHELL_IDS[number];

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

export function listLocalCliInventory() {
  return LOCAL_CLI_IDS.map((id) => {
    const entry = ALL_COMMANDS[id];
    const binaryPath = resolveBinaryFromPath(entry.command);
    return { id, ...entry, binaryPath, installed: binaryPath !== null };
  });
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

export function resolveLocalTerminal(
  cliId?: OrchestrationCliId,
  shellId: LocalShellId = 'default',
  extraArgs?: readonly string[],
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
  // Electron switches belong to the app, not a manually launched CLI.
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.ELECTRON_NO_ASAR;
  if (cliId === 'grok' && !env.GROK_DISABLE_AUTOUPDATER) env.GROK_DISABLE_AUTOUPDATER = '1';
  const baseArgs = !cliId && shellId === 'git-bash' ? ['--login', '-i'] : [];
  const args = extraArgs && extraArgs.length > 0 ? [...baseArgs, ...extraArgs] : baseArgs;
  // Keep the user's color and theme preferences unchanged. TERM and
  // COLORTERM above describe the embedded terminal's capabilities only.
  return { file, args, env, cwd: homedir() };
}
