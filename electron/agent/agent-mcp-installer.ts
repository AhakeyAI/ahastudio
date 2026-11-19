import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_MCP_CLI_IDS = [
  'claude',
  'codex',
  'antigravity',
  'grok',
  'gemini',
  'qwen',
  'opencode',
] as const;
export type AgentMcpCliId = (typeof AGENT_MCP_CLI_IDS)[number];

export const MCP_SERVER_NAME = 'aha';
export const MCP_SERVER_FILE_NAME = 'aha-mcp-server.cjs';
export const CLAUDE_MCP_CONFIG_FILE_NAME = 'claude-mcp-config.json';
const GROK_MCP_MARKER = '# managed by AhaStation (orchestration MCP)';

export type AgentMcpInstallMode = 'launch-arg' | 'config';
export type AgentMcpInstallState =
  | 'launch-managed'
  | 'not-installed'
  | 'installed'
  | 'outdated'
  | 'conflict'
  | 'error';

export interface AgentMcpCliStatus {
  cliId: AgentMcpCliId;
  label: string;
  mode: AgentMcpInstallMode;
  configPath: string;
  state: AgentMcpInstallState;
  detail?: string;
}

export interface AgentMcpInstallerOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Directory that receives the managed MCP server script. Defaults to ~/.ahastation/agent-hooks. */
  serverDir?: string;
  /** Source of the MCP server script shipped with the app. */
  serverSourcePath?: string;
  /** Custom path for Claude's generated --mcp-config JSON file. */
  claudeMcpConfigPath?: string;
  nodeCommand?: string;
}

const LABELS: Record<AgentMcpCliId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  antigravity: 'Antigravity',
  grok: 'Grok',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  opencode: 'OpenCode',
};

function defaultServerSource(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const bundled = resolve(here, '..', 'orchestration', MCP_SERVER_FILE_NAME);
  const unpacked = bundled.replace(/\.asar([\\/])/, '.asar.unpacked$1');
  const source = resolve(here, '..', '..', 'electron', 'orchestration', MCP_SERVER_FILE_NAME);
  if (existsSync(source)) {
    if (existsSync(bundled)) {
      try {
        const content = readFileSync(source, 'utf8');
        if (readFileSync(bundled, 'utf8') !== content) {
          writeAtomic(bundled, content);
        }
      } catch {
        /* non-fatal; callers still read from source */
      }
    }
    return source;
  }
  return existsSync(unpacked) ? unpacked : bundled;
}

export class AgentMcpInstaller {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly serverDir: string;
  private readonly serverSourcePath: string;
  private readonly claudeMcpConfigPath: string;
  private readonly nodeCommand: string;

  constructor(opts: AgentMcpInstallerOptions = {}) {
    this.home = opts.homeDir ?? homedir();
    this.env = opts.env ?? process.env;
    this.serverDir = opts.serverDir ?? join(this.home, '.ahastation', 'agent-hooks');
    this.serverSourcePath = opts.serverSourcePath ?? defaultServerSource();
    this.claudeMcpConfigPath =
      opts.claudeMcpConfigPath ?? join(this.serverDir, CLAUDE_MCP_CONFIG_FILE_NAME);
    this.nodeCommand = opts.nodeCommand ?? 'node';
  }

  get serverPath(): string {
    return join(this.serverDir, MCP_SERVER_FILE_NAME);
  }

  get sourcePath(): string {
    return this.serverSourcePath;
  }

  get claudeConfigPath(): string {
    return this.claudeMcpConfigPath;
  }

  isServerUpToDate(): boolean {
    if (!existsSync(this.serverSourcePath)) return true;
    if (!existsSync(this.serverPath)) return false;
    try {
      return readFileSync(this.serverPath, 'utf8') === readFileSync(this.serverSourcePath, 'utf8');
    } catch {
      return false;
    }
  }

  /** Forward slashes keep the path valid across bash, cmd, PowerShell, JSON, and TOML. */
  private serverArgPath(): string {
    return this.serverPath.replace(/\\/g, '/');
  }

  mode(cliId: AgentMcpCliId): AgentMcpInstallMode {
    return cliId === 'claude' || cliId === 'codex' ? 'launch-arg' : 'config';
  }

  private grokHomeDir(): string {
    const raw = this.env.GROK_HOME?.trim();
    if (!raw) return join(this.home, '.grok');
    if (raw === '~') return this.home;
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(this.home, raw.slice(2));
    return isAbsolute(raw) ? raw : resolve(this.home, raw);
  }

  configPath(cliId: AgentMcpCliId): string {
    switch (cliId) {
      case 'claude':
        return this.claudeMcpConfigPath;
      case 'codex':
        return this.serverPath;
      case 'antigravity':
        return join(this.home, '.gemini', 'config', 'mcp_config.json');
      case 'gemini':
        return join(this.env.GEMINI_CLI_HOME || join(this.home, '.gemini'), 'settings.json');
      case 'qwen':
        return join(this.home, '.qwen', 'settings.json');
      case 'opencode':
        return join(this.home, '.config', 'opencode', 'opencode.json');
      case 'grok':
        return join(this.grokHomeDir(), 'config.toml');
    }
  }

  /** Write Claude's --mcp-config JSON atomically and refresh the managed MCP bridge script. */
  ensureClaudeMcpConfigFile(configPath = this.claudeMcpConfigPath): string {
    this.writeServer();
    const payload = `${JSON.stringify(
      {
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: this.nodeCommand,
            args: [this.serverArgPath()],
          },
        },
      },
      null,
      2,
    )}\n`;
    if (!existsSync(configPath) || readFileSync(configPath, 'utf8') !== payload) {
      writeAtomic(configPath, payload);
    }
    return configPath;
  }

  /** Refresh the managed MCP server script when any integration already references it. */
  refreshServerIfInstalled(): void {
    const anyManaged =
      existsSync(this.serverPath) ||
      existsSync(this.claudeMcpConfigPath) ||
      AGENT_MCP_CLI_IDS.some((cliId) => {
        if (this.mode(cliId) === 'launch-arg') return false;
        const state = this.status(cliId).state;
        return state === 'installed' || state === 'outdated';
      });
    if (!anyManaged) return;
    try {
      this.writeServer();
      if (existsSync(this.claudeMcpConfigPath)) {
        this.ensureClaudeMcpConfigFile(this.claudeMcpConfigPath);
      }
    } catch {
      /* stale server keeps working; next install retries */
    }
  }

  listStatus(): AgentMcpCliStatus[] {
    return AGENT_MCP_CLI_IDS.map((cliId) => this.status(cliId));
  }

  status(cliId: AgentMcpCliId): AgentMcpCliStatus {
    const mode = this.mode(cliId);
    const configPath = this.configPath(cliId);
    const base = { cliId, label: LABELS[cliId], mode, configPath };
    if (mode === 'launch-arg') {
      const detail =
        cliId === 'claude'
          ? '启动时通过 --mcp-config 自动注入，不修改用户全局配置'
          : '启动时通过 -c 参数自动注入，不修改用户全局配置';
      return { ...base, state: 'launch-managed', detail };
    }
    try {
      const state =
        cliId === 'grok'
          ? this.grokState(configPath)
          : cliId === 'opencode'
            ? this.openCodeState(configPath)
            : this.jsonMcpServersState(configPath);
      if (state.state === 'installed' && existsSync(this.serverSourcePath)) {
        if (!existsSync(this.serverPath)) {
          return { ...base, state: 'outdated', detail: 'MCP 桥接脚本缺失，重新启用即可修复' };
        }
        if (!this.isServerUpToDate()) {
          return { ...base, state: 'outdated', detail: 'MCP 桥接脚本已更新，重新启用即可生效' };
        }
      }
      return { ...base, ...state };
    } catch (error) {
      return { ...base, state: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  install(cliId: AgentMcpCliId): AgentMcpCliStatus {
    if (cliId === 'claude') {
      this.ensureClaudeMcpConfigFile();
      return this.status(cliId);
    }
    if (cliId === 'codex') {
      this.writeServer();
      return this.status(cliId);
    }
    const configPath = this.configPath(cliId);
    this.writeServer();
    if (cliId === 'grok') this.installGrok(configPath);
    else if (cliId === 'opencode') this.installOpenCode(configPath);
    else this.installJsonMcpServers(configPath);
    return this.status(cliId);
  }

  uninstall(cliId: AgentMcpCliId): AgentMcpCliStatus {
    if (this.mode(cliId) === 'launch-arg') {
      return this.status(cliId);
    }
    const configPath = this.configPath(cliId);
    if (existsSync(configPath)) {
      if (cliId === 'grok') this.uninstallGrok(configPath);
      else if (cliId === 'opencode') this.uninstallOpenCode(configPath);
      else this.uninstallJsonMcpServers(configPath);
    }
    return this.status(cliId);
  }

  private writeServer(): void {
    mkdirSync(this.serverDir, { recursive: true });
    if (!existsSync(this.serverSourcePath)) return;
    const content = readFileSync(this.serverSourcePath, 'utf8');
    if (existsSync(this.serverPath) && readFileSync(this.serverPath, 'utf8') === content) return;
    writeAtomic(this.serverPath, content);
  }

  // ---- Standard JSON mcpServers.aha (Antigravity / Gemini / Qwen) ----

  private isOurMcpServerEntry(entry: unknown): boolean {
    if (!isRecord(entry)) return false;
    if (
      Array.isArray(entry.args) &&
      entry.args.some((arg) => typeof arg === 'string' && arg.includes(MCP_SERVER_FILE_NAME))
    ) {
      return true;
    }
    return typeof entry.command === 'string' && entry.command.includes(MCP_SERVER_FILE_NAME);
  }

  private isExactMcpServerEntry(entry: unknown): boolean {
    if (!isRecord(entry)) return false;
    return (
      entry.command === this.nodeCommand &&
      Array.isArray(entry.args) &&
      entry.args.length === 1 &&
      entry.args[0] === this.serverArgPath()
    );
  }

  private jsonMcpServersState(configPath: string): { state: AgentMcpInstallState; detail?: string } {
    if (!existsSync(configPath)) return { state: 'not-installed' };
    const root = readJsonConfig(configPath);
    if (root.mcpServers === undefined) return { state: 'not-installed' };
    if (!isRecord(root.mcpServers)) {
      throw new Error(`${configPath} 中的 mcpServers 字段不是对象，已停止修改`);
    }
    if (!Object.hasOwn(root.mcpServers, MCP_SERVER_NAME)) return { state: 'not-installed' };
    const entry = root.mcpServers[MCP_SERVER_NAME];
    if (!this.isOurMcpServerEntry(entry)) {
      return {
        state: 'conflict',
        detail: '配置中已存在非 AhaStation 管理的 aha MCP 服务；为避免覆盖，请先手动移除或重命名',
      };
    }
    if (!this.isExactMcpServerEntry(entry)) {
      return { state: 'outdated', detail: '已安装的 MCP 配置与当前版本不一致，重新启用即可更新' };
    }
    return { state: 'installed' };
  }

  private installJsonMcpServers(configPath: string): void {
    const exists = existsSync(configPath);
    const root = exists ? readJsonConfig(configPath) : {};
    if (root.mcpServers !== undefined && !isRecord(root.mcpServers)) {
      throw new Error(`${configPath} 中的 mcpServers 字段不是对象，已停止修改`);
    }
    const mcpServers: Record<string, unknown> = {
      ...(isRecord(root.mcpServers) ? root.mcpServers : {}),
    };
    if (
      Object.hasOwn(mcpServers, MCP_SERVER_NAME) &&
      !this.isOurMcpServerEntry(mcpServers[MCP_SERVER_NAME])
    ) {
      throw new Error(`${configPath} 中已配置了其他 aha MCP 服务，未做修改`);
    }
    mcpServers[MCP_SERVER_NAME] = {
      command: this.nodeCommand,
      args: [this.serverArgPath()],
    };
    const next = { ...root, mcpServers };
    if (exists) backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  private uninstallJsonMcpServers(configPath: string): void {
    const root = readJsonConfig(configPath);
    if (!isRecord(root.mcpServers) || !Object.hasOwn(root.mcpServers, MCP_SERVER_NAME)) return;
    if (!this.isOurMcpServerEntry(root.mcpServers[MCP_SERVER_NAME])) return;
    const mcpServers: Record<string, unknown> = { ...root.mcpServers };
    delete mcpServers[MCP_SERVER_NAME];
    const next: Record<string, unknown> = { ...root };
    if (Object.keys(mcpServers).length === 0) delete next.mcpServers;
    else next.mcpServers = mcpServers;
    backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  // ---- OpenCode (~/.config/opencode/opencode.json -> mcp.aha) ----

  private isOurOpenCodeEntry(entry: unknown): boolean {
    if (!isRecord(entry)) return false;
    if (
      Array.isArray(entry.command) &&
      entry.command.some((part) => typeof part === 'string' && part.includes(MCP_SERVER_FILE_NAME))
    ) {
      return true;
    }
    return typeof entry.command === 'string' && entry.command.includes(MCP_SERVER_FILE_NAME);
  }

  private isExactOpenCodeEntry(entry: unknown): boolean {
    if (!isRecord(entry)) return false;
    return (
      entry.type === 'local' &&
      entry.enabled === true &&
      Array.isArray(entry.command) &&
      entry.command.length === 2 &&
      entry.command[0] === this.nodeCommand &&
      entry.command[1] === this.serverArgPath()
    );
  }

  private openCodeState(configPath: string): { state: AgentMcpInstallState; detail?: string } {
    if (!existsSync(configPath)) return { state: 'not-installed' };
    const root = readJsonConfig(configPath);
    if (root.mcp === undefined) return { state: 'not-installed' };
    if (!isRecord(root.mcp)) {
      throw new Error(`${configPath} 中的 mcp 字段不是对象，已停止修改`);
    }
    if (!Object.hasOwn(root.mcp, MCP_SERVER_NAME)) return { state: 'not-installed' };
    const entry = root.mcp[MCP_SERVER_NAME];
    if (!this.isOurOpenCodeEntry(entry)) {
      return {
        state: 'conflict',
        detail: 'opencode.json 已存在非 AhaStation 管理的 aha MCP 服务；为避免覆盖，请先手动移除或重命名',
      };
    }
    if (!this.isExactOpenCodeEntry(entry)) {
      return { state: 'outdated', detail: '已安装的 MCP 配置与当前版本不一致，重新启用即可更新' };
    }
    return { state: 'installed' };
  }

  private installOpenCode(configPath: string): void {
    const exists = existsSync(configPath);
    const root = exists ? readJsonConfig(configPath) : {};
    if (root.mcp !== undefined && !isRecord(root.mcp)) {
      throw new Error(`${configPath} 中的 mcp 字段不是对象，已停止修改`);
    }
    const mcp: Record<string, unknown> = { ...(isRecord(root.mcp) ? root.mcp : {}) };
    if (Object.hasOwn(mcp, MCP_SERVER_NAME) && !this.isOurOpenCodeEntry(mcp[MCP_SERVER_NAME])) {
      throw new Error(`${configPath} 中已配置了其他 aha MCP 服务，未做修改`);
    }
    mcp[MCP_SERVER_NAME] = {
      type: 'local',
      command: [this.nodeCommand, this.serverArgPath()],
      enabled: true,
    };
    const next = { ...root, mcp };
    if (exists) backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  private uninstallOpenCode(configPath: string): void {
    const root = readJsonConfig(configPath);
    if (!isRecord(root.mcp) || !Object.hasOwn(root.mcp, MCP_SERVER_NAME)) return;
    if (!this.isOurOpenCodeEntry(root.mcp[MCP_SERVER_NAME])) return;
    const mcp: Record<string, unknown> = { ...root.mcp };
    delete mcp[MCP_SERVER_NAME];
    const next: Record<string, unknown> = { ...root };
    if (Object.keys(mcp).length === 0) delete next.mcp;
    else next.mcp = mcp;
    backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  // ---- Grok TOML (~/.grok/config.toml -> [mcp_servers.aha]) ----

  private grokMcpLines(): string[] {
    return [
      `[mcp_servers.${MCP_SERVER_NAME}] ${GROK_MCP_MARKER}`,
      `command = ${JSON.stringify(this.nodeCommand)}`,
      `args = [${JSON.stringify(this.serverArgPath())}]`,
    ];
  }

  private grokState(configPath: string): { state: AgentMcpInstallState; detail?: string } {
    if (!existsSync(configPath)) return { state: 'not-installed' };
    const parsed = parseGrokMcpAha(readFileSync(configPath, 'utf8'));
    if (parsed.kind === 'none') return { state: 'not-installed' };
    if (parsed.kind === 'conflict' || !parsed.isOurs) {
      return {
        state: 'conflict',
        detail: 'Grok config.toml 已配置了其他 mcp_servers.aha 服务；为避免覆盖，请先手动移除或重命名',
      };
    }
    const actual = parsed.lines.slice(parsed.blockStart, parsed.bodyEnd).map((line) => line.trim());
    const expected = this.grokMcpLines();
    if (actual.length === expected.length && actual.every((line, idx) => line === expected[idx])) {
      return { state: 'installed' };
    }
    return { state: 'outdated', detail: '已安装的 MCP 配置与当前版本不一致，重新启用即可更新' };
  }

  private installGrok(configPath: string): void {
    const exists = existsSync(configPath);
    const raw = exists ? readFileSync(configPath, 'utf8') : '';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const parsed = parseGrokMcpAha(raw);
    if (parsed.kind === 'conflict' || (parsed.kind === 'section' && !parsed.isOurs)) {
      throw new Error('Grok config.toml 已配置了其他 mcp_servers.aha 服务，未做修改');
    }
    const nextLines = [...parsed.lines];
    const expected = this.grokMcpLines();
    if (parsed.kind === 'section') {
      nextLines.splice(parsed.blockStart, parsed.bodyEnd - parsed.blockStart, ...expected);
    } else {
      if (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() !== '') {
        nextLines.push('');
      }
      nextLines.push(...expected);
    }
    if (exists) backupOnce(configPath);
    mkdirSync(dirname(configPath), { recursive: true });
    writeAtomic(configPath, `${nextLines.join(eol)}${eol}`);
  }

  private uninstallGrok(configPath: string): void {
    const raw = readFileSync(configPath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const parsed = parseGrokMcpAha(raw);
    if (parsed.kind !== 'section' || !parsed.isOurs) return;
    const nextLines = [...parsed.lines];
    nextLines.splice(parsed.blockStart, parsed.bodyEnd - parsed.blockStart);
    if (
      parsed.blockStart > 0 &&
      nextLines[parsed.blockStart - 1]?.trim() === '' &&
      (parsed.blockStart >= nextLines.length || nextLines[parsed.blockStart]?.trim() === '')
    ) {
      nextLines.splice(parsed.blockStart - 1, 1);
    } else if (parsed.blockStart === 0 && nextLines[0]?.trim() === '') {
      nextLines.splice(0, 1);
    }
    backupOnce(configPath);
    writeAtomic(configPath, nextLines.length ? `${nextLines.join(eol)}${eol}` : '');
  }
}

type ParsedGrokMcpAha =
  | { kind: 'none'; lines: string[] }
  | { kind: 'conflict'; lines: string[] }
  | { kind: 'section'; lines: string[]; blockStart: number; bodyEnd: number; isOurs: boolean };

function parseGrokMcpAha(raw: string): ParsedGrokMcpAha {
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  let currentTable = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*\[\[/.test(line)) {
      currentTable = '__array_table__';
      continue;
    }
    const tableMatch = /^\s*\[\s*([^\]]+?)\s*\](?:\s*(?:#.*)?)?$/.exec(line);
    if (tableMatch) {
      const tableName = tableMatch[1].trim();
      if (/^mcp_servers\.(?:aha|"aha"|'aha')$/.test(tableName)) {
        const isHeaderLine = (l: string): boolean =>
          /^\s*\[\[/.test(l) || /^\s*\[\s*([^\]]+?)\s*\](?:\s*(?:#.*)?)?$/.test(l);
        let end = i + 1;
        while (end < lines.length && !isHeaderLine(lines[end])) {
          end += 1;
        }
        for (let k = end; k < lines.length; k += 1) {
          const restMatch = /^\s*\[\s*([^\]]+?)\s*\](?:\s*(?:#.*)?)?$/.exec(lines[k]);
          if (restMatch) {
            const restName = restMatch[1].trim();
            if (
              /^mcp_servers\.(?:aha|"aha"|'aha')$/.test(restName) ||
              /^mcp_servers\.(?:aha|"aha"|'aha')\./.test(restName)
            ) {
              return { kind: 'conflict', lines };
            }
          }
        }
        let bodyEnd = end;
        while (bodyEnd > i + 1 && lines[bodyEnd - 1].trim() === '') {
          bodyEnd -= 1;
        }
        let blockStart = i;
        if (i > 0 && lines[i - 1].trim() === GROK_MCP_MARKER) {
          blockStart = i - 1;
        }
        const sectionSlice = lines.slice(blockStart, bodyEnd);
        const isOurs = sectionSlice.some(
          (l) => l.includes(GROK_MCP_MARKER) || l.includes(MCP_SERVER_FILE_NAME),
        );
        return { kind: 'section', lines, blockStart, bodyEnd, isOurs };
      }
      if (/^mcp_servers\.(?:aha|"aha"|'aha')\./.test(tableName)) {
        return { kind: 'conflict', lines };
      }
      currentTable = tableName;
      continue;
    }

    const stripped = line.trim();
    if (!stripped || stripped.startsWith('#')) continue;
    if (
      currentTable === '' &&
      /^mcp_servers\.(?:aha|"aha"|'aha')(?:\s*=|\.)/.test(stripped)
    ) {
      return { kind: 'conflict', lines };
    }
    if (
      currentTable === 'mcp_servers' &&
      /^(?:aha|"aha"|'aha')(?:\s*=|\.)/.test(stripped)
    ) {
      return { kind: 'conflict', lines };
    }
  }

  return { kind: 'none', lines };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonConfig(path: string): Record<string, unknown> {
  const raw = readFileSync(path, 'utf8').replace(/^\uFEFF/, '');
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${path} 不是标准 JSON（可能含注释），为避免破坏配置未做修改`);
  }
  if (!isRecord(parsed)) throw new Error(`${path} 顶层不是 JSON 对象，未做修改`);
  return parsed;
}

function backupOnce(path: string): void {
  const backup = `${path}.ahastation.bak`;
  if (!existsSync(backup)) copyFileSync(path, backup);
}

function writeAtomic(linkOrPath: string, content: string): void {
  const path = existsSync(linkOrPath) ? realpathSync(linkOrPath) : linkOrPath;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  try {
    renameSync(tmp, path);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (
      process.platform === 'win32' &&
      (code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')
    ) {
      try {
        writeFileSync(path, content, 'utf8');
      } finally {
        try {
          unlinkSync(tmp);
        } catch {
          // ignore cleanup failure
        }
      }
      return;
    }
    try {
      unlinkSync(tmp);
    } catch {
      // ignore cleanup failure
    }
    throw err;
  }
}
