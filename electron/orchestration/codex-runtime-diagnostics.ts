import { existsSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolveBinaryFromPath } from '../bin-resolve.js';
import type { CodexRuntimeReport, RuntimeFinding, RuntimeState } from './codex-runtime-types.js';
export type { CodexRuntimeReport } from './codex-runtime-types.js';
export interface RuntimeConnection {
  query(method: string, params: Record<string, unknown>): Promise<unknown>;
  probeComputerUse(cwd: string): Promise<unknown>;
  close(): Promise<void>;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const array = (v: unknown): unknown[] => Array.isArray(v) ? v : [];
const text = (v: unknown) => typeof v === 'string' ? v : '';

/** Classify privately; never forward raw service errors (which may echo env, prompts or tokens). */
export function runtimeFailure(error: unknown): RuntimeFinding {
  const message = error instanceof Error ? error.message : String(error);
  const state: RuntimeState = /not authenticated|unauthori[sz]ed|sign.?in|oauth|401\b/i.test(message) ? 'authentication-required'
    : /accessibility|screen recording|permission denied|not permitted|TCC/i.test(message) ? 'permission-required'
    : /method not found|unsupported|not supported|unknown variant|unknown method|-32601/i.test(message) ? 'host-unsupported'
    : /enoent|not found|runtime app is missing|cannot find module/i.test(message) ? 'dependency-missing' : 'error';
  const detail: Record<RuntimeState, string> = {
    'authentication-required': '服务要求登录或宿主认证；请使用官方支持入口，勿复制其他配置的认证信息。',
    'permission-required': '服务要求系统授权；请按官方提示在系统设置中授权，然后重新验证。',
    'host-unsupported': '当前 CLI 或宿主不支持此检查；可从官方客户端使用该能力。',
    'dependency-missing': '启动文件或配套组件缺失；请按提供方安装说明修复，不会自动改写配置。',
    error: '检查未完成，不能判为可用。请在原 CLI 中检查配置和服务日志。',
    'not-installed': '', 'not-enabled': '', configured: '', verified: '', unverified: '',
  };
  return { name: '连接检查', state, detail: detail[state] };
}

/** Check only the executable token of a literal command; never evaluate a shell command. */
export function hookPathChecks(hooks: unknown, exists = existsSync): { missing: number; unverified: number } {
  let missing = 0, unverified = 0;
  function visit(value: unknown, depth: number) {
    if (depth > 12 || missing >= 100) return;
    if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, depth + 1); return; }
    const item = object(value);
    if (typeof item.command === 'string') {
      const match = /^(?:"([^"\n]+)"|'([^'\n]+)'|([^\s'";&|<>]+))(?:\s|$)/u.exec(item.command.trim());
      const executable = match?.[1] ?? match?.[2] ?? match?.[3];
      if (executable && isAbsolute(executable) && !executable.includes('$')) {
        if (!exists(executable)) missing++;
        else if (/(?:^|[/\\])(?:ba|z|da|k)?sh(?:\.exe)?$/i.test(executable)) unverified++;
      } else unverified++;
    }
    for (const [key, child] of Object.entries(item).slice(0, 100)) if (key !== 'command') visit(child, depth + 1);
  }
  visit(hooks, 0);
  return { missing, unverified };
}
export const missingHookExecutables = (hooks: unknown, exists = existsSync) => hookPathChecks(hooks, exists).missing;

function officialComputerUse(command: unknown): boolean {
  if (process.platform !== 'darwin' || typeof command !== 'string' || !isAbsolute(command)) return false;
  try {
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', command], { stdio: 'ignore', timeout: 3000 });
    const details = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=2', command], { encoding: 'utf8', timeout: 3000 });
    return details.status === 0 && /TeamIdentifier=2DC432GLL2\b/.test(details.stderr);
  } catch { return false; }
}

export async function inspectCodexRuntime(cwd: string, probe: boolean, launch: () => RuntimeConnection,
  options: { cli?: string | null; env?: NodeJS.ProcessEnv; systemHome?: string; verifyOfficial?: (command: unknown) => boolean } = {},
): Promise<CodexRuntimeReport> {
  const env = options.env ?? process.env;
  const home = env.HOME || env.USERPROFILE || homedir();
  let systemHome = options.systemHome;
  if (!systemHome) { try { systemHome = userInfo().homedir; } catch { systemHome = home; } }
  const configHome = env.CODEX_HOME || join(home, '.codex');
  const report: CodexRuntimeReport = {
    cwd, cli: options.cli === undefined ? resolveBinaryFromPath('codex') : options.cli,
    configFile: join(configHome, 'config.toml'), separateProfile: resolve(configHome) !== resolve(systemHome, '.codex'),
    findings: [], configSources: [], checkedAt: Date.now(),
  };
  if (!report.cli) { report.findings.push({ name: 'Codex', state: 'not-installed', detail: '未找到本机 CLI，请先安装或检查启动路径。' }); return report; }
  const add = (name: string, state: RuntimeState, detail: string) => report.findings.push({ name: name.slice(0, 100), state, detail });
  add('配置来源', 'configured', report.separateProfile
    ? '正在使用独立的工具配置；不会自动导入日常配置中的登录、插件或会话。项目文件夹隔离本身不要求使用独立工具配置。'
    : '沿用本机 CLI 的工具配置；项目的权限、受信状态及配置覆盖仍由 Codex 处理。');
  let connection: RuntimeConnection | undefined;
  try {
    connection = launch();
    // Let Codex enforce trust, managed policy and configuration precedence. Never parse/merge TOML ourselves.
    const response = object(await connection.query('config/read', { cwd, includeLayers: true }));
    report.configSources = array(response.layers).slice(0, 50).map(value => {
      const layer = object(value), source = object(layer.name);
      const path = text(source.file) || (text(source.dotCodexFolder) ? join(text(source.dotCodexFolder), 'config.toml') : null);
      return { kind: text(source.type), path, active: !layer.disabledReason };
    });
    const config = object(response.config);
    const { missing, unverified } = hookPathChecks(config.hooks);
    if (missing) add('Hook 启动文件', 'dependency-missing', `检测到 ${missing} 个绝对启动路径不存在；可能造成 hook 失败，但退出127也有其他原因。请修复提供方安装或明确配置路径，不会自动禁用保护。`);
    if (unverified) add('Hook 脚本', 'unverified', '包含脚本包装或动态命令，尚未执行，无法静态确认内部依赖。退出127不能单独证明命令不存在；请在提供方日志中核对实际失败路径，不会自动禁用 hook。');
    const plugins = object(await connection.query('plugin/installed', { cwds: [cwd] }));
    for (const market of array(plugins.marketplaces)) for (const value of array(object(market).plugins).slice(0, 50)) {
      const plugin = object(value);
      if (plugin.installed === true) add(text(plugin.name) || '插件', plugin.enabled === true ? 'configured' : 'not-enabled',
        plugin.enabled === true ? '已安装并启用；仍需相应宿主、依赖和实际调用验证。' : '已安装但在当前配置中未启用，请在 CLI 或官方插件设置中处理。');
    }
    const servers = object(config.mcp_servers);
    for (const [name, value] of Object.entries(servers).slice(0, 50)) {
      const server = object(value);
      if (server.enabled === false) add(name, 'not-enabled', '当前配置未启用此服务。');
      else if (typeof server.command === 'string' && isAbsolute(server.command) && !existsSync(server.command)) add(name, 'dependency-missing', '服务启动文件不存在，请修复提供方安装或明确配置路径。');
      else add(name, 'configured', '已配置；尚未证明服务认证或系统授权可用。');
    }
    if (probe) {
      const status = object(await connection.query('mcpServerStatus/list', { serverName: 'computer-use', detail: 'toolsAndAuthOnly' }));
      const server = array(status.data).map(object).find((entry) => entry.name === 'computer-use');
      if (!server) add('Computer Use', 'unverified', '当前配置未发现独立 Computer Use MCP；宿主管理插件可能需要官方客户端。');
      else if (server.toolsError) report.findings.push(runtimeFailure(server.toolsError));
      else if (object(server.serverInfo).name !== 'Computer Use' || !object(object(server.tools).list_apps).name
        || !(options.verifyOfficial ?? officialComputerUse)(object(servers['computer-use']).command)) {
        add('Computer Use', 'unverified', '无法确认是官方签名的独立只读探针入口，未调用任何工具；请使用官方宿主验证。');
      } else {
        const result = object(await connection.probeComputerUse(cwd));
        if (result.isError === true) report.findings.push(runtimeFailure(array(result.content).map((c) => text(object(c).text)).join('\n')));
        else if (!array(result.content).length) add('Computer Use', 'unverified', '服务返回空结果，不能判为可用。');
        else add('Computer Use', 'verified', '新连接已完成官方只读应用列表调用；未操作应用，未验证截屏、键盘或鼠标权限。');
      }
    }
  } catch (error) { report.findings.push(runtimeFailure(error)); }
  finally { await connection?.close(); }
  return report;
}
