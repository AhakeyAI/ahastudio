import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGENT_HOOK_CLI_IDS = ['claude', 'antigravity', 'codex', 'qwen', 'grok'] as const;
export type AgentHookCliId = typeof AGENT_HOOK_CLI_IDS[number];

export const RELAY_FILE_NAME = 'aha-agent-hook.cjs';
const CODEX_MARKER = '# managed by AhaStation (agent status hook)';

export type AgentHookInstallState = 'not-installed' | 'installed' | 'outdated' | 'conflict' | 'error';

export interface AgentHookCliStatus {
  cliId: AgentHookCliId;
  label: string;
  configPath: string;
  configExists: boolean;
  state: AgentHookInstallState;
  detail?: string;
}

export interface AgentHookInstallerOptions {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Directory that receives the relay script. Defaults to ~/.ahastation/agent-hooks. */
  relayDir?: string;
  /** Source of the relay script shipped with the app. */
  relaySourcePath?: string;
  nodeCommand?: string;
}

const LABELS: Record<AgentHookCliId, string> = {
  claude: 'Claude Code',
  antigravity: 'Antigravity',
  codex: 'Codex',
  qwen: 'Qwen Code',
  grok: 'Grok',
};

// Only lifecycle events the hook server understands. Claude rejects a settings
// file containing unknown hook events on older versions, so newer events such
// as PermissionRequest are left out there; Notification already covers prompts.
const JSON_HOOK_EVENTS: Record<Exclude<AgentHookCliId, 'codex' | 'antigravity' | 'grok'>, readonly string[]> = {
  claude: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Notification', 'Stop', 'SubagentStop'],
  qwen: [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PostToolUseFailure',
    'Notification',
    'PermissionRequest',
    'Stop',
    'StopFailure',
    'SubagentStart',
    'SubagentStop',
  ],
};

const ANTIGRAVITY_DIRECT_EVENTS = ['PreInvocation', 'PostInvocation', 'Stop'] as const;
const ANTIGRAVITY_TOOL_EVENTS = ['PreToolUse', 'PostToolUse'] as const;
const ANTIGRAVITY_ALL_EVENTS = [...ANTIGRAVITY_DIRECT_EVENTS, ...ANTIGRAVITY_TOOL_EVENTS] as const;

const GROK_TOOL_MATCHER = '.*';
const GROK_DIRECT_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'Stop',
  'StopCancelled',
  'StopFailure',
  'SessionEnd',
  'Notification',
] as const;
const GROK_TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const;
const GROK_ALL_EVENTS = [...GROK_DIRECT_EVENTS, ...GROK_TOOL_EVENTS] as const;

const HOOK_NAME = 'ahastation-agent-status';

function defaultRelaySource(): string {
  return join(dirname(fileURLToPath(import.meta.url)), 'agent-hook-relay.cjs');
}

export class AgentHookInstaller {
  private readonly home: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly relayDir: string;
  private readonly relaySourcePath: string;
  private readonly nodeCommand: string;

  constructor(opts: AgentHookInstallerOptions = {}) {
    this.home = opts.homeDir ?? homedir();
    this.env = opts.env ?? process.env;
    this.relayDir = opts.relayDir ?? join(this.home, '.ahastation', 'agent-hooks');
    this.relaySourcePath = opts.relaySourcePath ?? defaultRelaySource();
    this.nodeCommand = opts.nodeCommand ?? 'node';
  }

  get relayPath(): string {
    return join(this.relayDir, RELAY_FILE_NAME);
  }

  /** Forward slashes keep the path valid in bash, cmd and PowerShell alike. */
  private relayArgPath(): string {
    return this.relayPath.replace(/\\/g, '/');
  }

  commandFor(cliId: AgentHookCliId, eventName?: string): string {
    const suffix = eventName ? ` ${eventName}` : '';
    return `${this.nodeCommand} "${this.relayArgPath()}" ${cliId}${suffix}`;
  }

  private grokHomeDir(): string {
    const raw = this.env.GROK_HOME?.trim();
    if (!raw) return join(this.home, '.grok');
    if (raw === '~') return this.home;
    if (raw.startsWith('~/') || raw.startsWith('~\\')) return join(this.home, raw.slice(2));
    return isAbsolute(raw) ? raw : resolve(this.home, raw);
  }

  configPath(cliId: AgentHookCliId): string {
    switch (cliId) {
      case 'claude':
        return join(this.env.CLAUDE_CONFIG_DIR || join(this.home, '.claude'), 'settings.json');
      case 'antigravity':
        return join(this.home, '.gemini', 'config', 'hooks.json');
      case 'codex':
        return join(this.env.CODEX_HOME || join(this.home, '.codex'), 'config.toml');
      case 'qwen':
        return join(this.home, '.qwen', 'settings.json');
      case 'grok':
        return join(this.grokHomeDir(), 'hooks', `${HOOK_NAME}.json`);
    }
  }

  /** Refresh the relay script when hooks already reference it (e.g. after an app update). */
  refreshRelayIfInstalled(): void {
    if (!existsSync(this.relayPath)) return;
    try {
      this.writeRelay();
    } catch {
      /* stale relay keeps working; next install retries */
    }
  }

  listStatus(): AgentHookCliStatus[] {
    return AGENT_HOOK_CLI_IDS.map((id) => this.status(id));
  }

  status(cliId: AgentHookCliId): AgentHookCliStatus {
    const configPath = this.configPath(cliId);
    const base = { cliId, label: LABELS[cliId], configPath, configExists: existsSync(configPath) };
    try {
      const state =
        cliId === 'codex'
          ? this.codexState(configPath)
          : cliId === 'antigravity'
            ? this.antigravityState(configPath)
            : cliId === 'grok'
              ? this.grokState(configPath)
              : this.jsonState(cliId, configPath);
      if (state.state === 'installed' && !existsSync(this.relayPath)) {
        return { ...base, state: 'outdated', detail: '转发脚本缺失，重新安装即可修复' };
      }
      return { ...base, ...state };
    } catch (error) {
      return { ...base, state: 'error', detail: error instanceof Error ? error.message : String(error) };
    }
  }

  install(cliId: AgentHookCliId): AgentHookCliStatus {
    const configPath = this.configPath(cliId);
    this.writeRelay();
    if (cliId === 'codex') this.installCodex(configPath);
    else if (cliId === 'antigravity') this.installAntigravity(configPath);
    else if (cliId === 'grok') this.installGrok(configPath);
    else this.installJson(cliId, configPath);
    return this.status(cliId);
  }

  uninstall(cliId: AgentHookCliId): AgentHookCliStatus {
    const configPath = this.configPath(cliId);
    if (existsSync(configPath)) {
      if (cliId === 'codex') this.uninstallCodex(configPath);
      else if (cliId === 'antigravity') this.uninstallAntigravity(configPath);
      else if (cliId === 'grok') this.uninstallGrok(configPath);
      else this.uninstallJson(configPath);
    }
    return this.status(cliId);
  }

  private writeRelay(): void {
    mkdirSync(this.relayDir, { recursive: true });
    const content = readFileSync(this.relaySourcePath, 'utf8');
    if (existsSync(this.relayPath) && readFileSync(this.relayPath, 'utf8') === content) return;
    writeAtomic(this.relayPath, content);
  }

  // ---- JSON settings (Claude / Qwen) ----

  private isOurCommand(command: unknown): boolean {
    return typeof command === 'string' && command.includes(RELAY_FILE_NAME);
  }

  private jsonState(
    cliId: Exclude<AgentHookCliId, 'codex' | 'antigravity' | 'grok'>,
    configPath: string,
  ): { state: AgentHookInstallState; detail?: string } {
    if (!existsSync(configPath)) return { state: 'not-installed' };
    const settings = readJsonSettings(configPath);
    const hooks = isRecord(settings.hooks) ? settings.hooks : {};
    const expected = this.commandFor(cliId);
    let found = 0;
    let exact = 0;
    for (const event of JSON_HOOK_EVENTS[cliId]) {
      const commands = collectCommands(hooks[event]).filter((c) => this.isOurCommand(c));
      if (commands.length > 0) found += 1;
      if (commands.includes(expected)) exact += 1;
    }
    const anyOurs = Object.values(hooks).some((groups) =>
      collectCommands(groups).some((c) => this.isOurCommand(c)),
    );
    if (!anyOurs) return { state: 'not-installed' };
    if (exact === JSON_HOOK_EVENTS[cliId].length && found === exact) return { state: 'installed' };
    return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
  }

  private installJson(cliId: Exclude<AgentHookCliId, 'codex' | 'antigravity' | 'grok'>, configPath: string): void {
    const exists = existsSync(configPath);
    const settings = exists ? readJsonSettings(configPath) : {};
    if (settings.hooks !== undefined && !isRecord(settings.hooks)) {
      throw new Error(`${configPath} 中的 hooks 字段不是对象，已停止修改`);
    }
    const hooks: Record<string, unknown> = { ...(isRecord(settings.hooks) ? settings.hooks : {}) };
    stripOurHooks(hooks, (c) => this.isOurCommand(c));
    const command = this.commandFor(cliId);
    const entry: Record<string, unknown> =
      cliId === 'claude'
        ? { type: 'command', command, timeout: 5 }
        : { type: 'command', command, name: HOOK_NAME, timeout: 5 };
    for (const event of JSON_HOOK_EVENTS[cliId]) {
      const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
      groups.push({ hooks: [{ ...entry }] });
      hooks[event] = groups;
    }
    const next = { ...settings, hooks };
    if (exists) backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  private uninstallJson(configPath: string): void {
    const settings = readJsonSettings(configPath);
    if (!isRecord(settings.hooks)) return;
    const hooks: Record<string, unknown> = { ...settings.hooks };
    if (!stripOurHooks(hooks, (c) => this.isOurCommand(c))) return;
    const next: Record<string, unknown> = { ...settings };
    if (Object.keys(hooks).length === 0) delete next.hooks;
    else next.hooks = hooks;
    backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  // ---- Grok Build (~/.grok/hooks/ahastation-agent-status.json) ----

  private grokState(configPath: string): { state: AgentHookInstallState; detail?: string } {
    if (!existsSync(configPath)) return { state: 'not-installed' };
    const settings = readJsonSettings(configPath);
    const hooks = isRecord(settings.hooks) ? settings.hooks : {};
    const anyOurs = Object.values(hooks).some((groups) =>
      collectCommands(groups).some((c) => this.isOurCommand(c)),
    );
    if (!anyOurs) return { state: 'not-installed' };

    const expected = this.commandFor('grok');
    const expectedEventSet = new Set<string>(GROK_ALL_EVENTS);
    for (const [event, groups] of Object.entries(hooks)) {
      const ours = collectCommands(groups).filter((c) => this.isOurCommand(c));
      if ((!expectedEventSet.has(event) && ours.length > 0) || ours.some((c) => c !== expected)) {
        return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
      }
    }

    const hasGroup = (groups: unknown, matcher?: string): boolean =>
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isRecord(group) &&
          (matcher === undefined ? !group.matcher : group.matcher === matcher) &&
          Array.isArray(group.hooks) &&
          group.hooks.some((hook) => isRecord(hook) && hook.command === expected),
      );

    for (const event of GROK_DIRECT_EVENTS) {
      if (!hasGroup(hooks[event])) {
        return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
      }
    }
    for (const event of GROK_TOOL_EVENTS) {
      if (!hasGroup(hooks[event], GROK_TOOL_MATCHER)) {
        return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
      }
    }
    return { state: 'installed' };
  }

  private installGrok(configPath: string): void {
    const exists = existsSync(configPath);
    const settings = exists ? readJsonSettings(configPath) : {};
    if (settings.hooks !== undefined && !isRecord(settings.hooks)) {
      throw new Error(`${configPath} 中的 hooks 字段不是对象，已停止修改`);
    }
    const hooks: Record<string, unknown> = { ...(isRecord(settings.hooks) ? settings.hooks : {}) };
    stripOurHooks(hooks, (c) => this.isOurCommand(c));
    const entry = { type: 'command', command: this.commandFor('grok'), timeout: 5 };
    for (const event of GROK_DIRECT_EVENTS) {
      const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
      groups.push({ hooks: [{ ...entry }] });
      hooks[event] = groups;
    }
    for (const event of GROK_TOOL_EVENTS) {
      const groups = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
      groups.push({ matcher: GROK_TOOL_MATCHER, hooks: [{ ...entry }] });
      hooks[event] = groups;
    }
    const next = { ...settings, hooks };
    if (exists) backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  private uninstallGrok(configPath: string): void {
    const settings = readJsonSettings(configPath);
    if (!isRecord(settings.hooks)) return;
    const hooks: Record<string, unknown> = { ...settings.hooks };
    if (!stripOurHooks(hooks, (c) => this.isOurCommand(c))) return;
    const next: Record<string, unknown> = { ...settings };
    if (Object.keys(hooks).length === 0) delete next.hooks;
    else next.hooks = hooks;
    if (Object.keys(next).length === 0) {
      rmSync(configPath, { force: true });
      return;
    }
    backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  // ---- Antigravity (~/.gemini/config/hooks.json bundle) ----

  private antigravityState(configPath: string): { state: AgentHookInstallState; detail?: string } {
    if (!existsSync(configPath)) return { state: 'not-installed' };
    const root = readJsonSettings(configPath);
    const bundle = root[HOOK_NAME];
    const hasLegacyOutside = Object.entries(root).some(
      ([key, value]) => key !== HOOK_NAME && recordHasOurAntigravityCommand(value, (c) => this.isOurCommand(c)),
    );
    const hasOursInBundle = recordHasOurAntigravityCommand(bundle, (c) => this.isOurCommand(c));
    if (!hasLegacyOutside && !hasOursInBundle) return { state: 'not-installed' };
    if (hasLegacyOutside || !isRecord(bundle)) {
      return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
    }

    const expectedEventSet = new Set<string>(ANTIGRAVITY_ALL_EVENTS);
    for (const [event, defs] of Object.entries(bundle)) {
      if (!expectedEventSet.has(event) && collectAntigravityCommands(defs).some((c) => this.isOurCommand(c))) {
        return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
      }
    }

    for (const event of ANTIGRAVITY_DIRECT_EVENTS) {
      const expected = this.commandFor('antigravity', event);
      const defs = bundle[event];
      if (!Array.isArray(defs)) {
        return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
      }
      const hasExact = defs.some((def) => isRecord(def) && def.command === expected);
      const hasStale = collectAntigravityCommands(defs).some((c) => this.isOurCommand(c) && c !== expected);
      if (!hasExact || hasStale) {
        return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
      }
    }

    for (const event of ANTIGRAVITY_TOOL_EVENTS) {
      const expected = this.commandFor('antigravity', event);
      const defs = bundle[event];
      if (!Array.isArray(defs)) {
        return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
      }
      const hasExact = defs.some(
        (def) =>
          isRecord(def) &&
          Array.isArray(def.hooks) &&
          def.hooks.some((hook) => isRecord(hook) && hook.command === expected),
      );
      const hasStale = collectAntigravityCommands(defs).some((c) => this.isOurCommand(c) && c !== expected);
      if (!hasExact || hasStale) {
        return { state: 'outdated', detail: '已安装的 hook 与当前版本不一致，重新安装即可更新' };
      }
    }

    return { state: 'installed' };
  }

  private installAntigravity(configPath: string): void {
    const exists = existsSync(configPath);
    const next: Record<string, unknown> = exists ? { ...readJsonSettings(configPath) } : {};
    for (const [key, value] of Object.entries(next)) {
      if (key === HOOK_NAME || !isRecord(value)) continue;
      const clone = { ...value };
      if (stripAntigravityHandlers(clone, (c) => this.isOurCommand(c))) {
        if (Object.keys(clone).length === 0) delete next[key];
        else next[key] = clone;
      }
    }
    const bundle: Record<string, unknown> = {};
    for (const event of ANTIGRAVITY_DIRECT_EVENTS) {
      bundle[event] = [{ type: 'command', command: this.commandFor('antigravity', event), timeout: 10 }];
    }
    for (const event of ANTIGRAVITY_TOOL_EVENTS) {
      bundle[event] = [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: this.commandFor('antigravity', event), timeout: 10 }],
        },
      ];
    }
    next[HOOK_NAME] = bundle;
    if (exists) backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  private uninstallAntigravity(configPath: string): void {
    const root = readJsonSettings(configPath);
    const next: Record<string, unknown> = { ...root };
    let changed = false;
    if (Object.hasOwn(next, HOOK_NAME)) {
      delete next[HOOK_NAME];
      changed = true;
    }
    for (const [key, value] of Object.entries(next)) {
      if (!isRecord(value)) continue;
      const clone = { ...value };
      if (stripAntigravityHandlers(clone, (c) => this.isOurCommand(c))) {
        changed = true;
        if (Object.keys(clone).length === 0) delete next[key];
        else next[key] = clone;
      }
    }
    if (!changed) return;
    backupOnce(configPath);
    writeAtomic(configPath, `${JSON.stringify(next, null, 2)}\n`);
  }

  // ---- Codex config.toml `notify` ----

  private codexNotifyLine(): string {
    const argv = [this.nodeCommand, this.relayArgPath(), 'codex'];
    return `notify = [${argv.map((a) => JSON.stringify(a)).join(', ')}] ${CODEX_MARKER}`;
  }

  private codexState(configPath: string): { state: AgentHookInstallState; detail?: string } {
    if (!existsSync(configPath)) return { state: 'not-installed' };
    const { lines, notifyIndex } = parseCodexTopLevel(readFileSync(configPath, 'utf8'));
    if (notifyIndex < 0) return { state: 'not-installed' };
    const line = lines[notifyIndex];
    if (!line.includes(RELAY_FILE_NAME)) {
      return {
        state: 'conflict',
        detail: 'config.toml 已配置了其他 notify 命令；为避免覆盖，请先手动移除或合并',
      };
    }
    return line.trim() === this.codexNotifyLine()
      ? { state: 'installed' }
      : { state: 'outdated', detail: '已安装的 notify 与当前版本不一致，重新安装即可更新' };
  }

  private installCodex(configPath: string): void {
    const exists = existsSync(configPath);
    const raw = exists ? readFileSync(configPath, 'utf8') : '';
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const { lines, notifyIndex } = parseCodexTopLevel(raw);
    const nextLine = this.codexNotifyLine();
    if (notifyIndex >= 0) {
      if (!lines[notifyIndex].includes(RELAY_FILE_NAME)) {
        throw new Error('Codex config.toml 已配置了其他 notify 命令，未做修改');
      }
      lines[notifyIndex] = nextLine;
    } else {
      // Top-level keys must precede every [table]; the file start is always top-level.
      lines.unshift(nextLine);
    }
    if (exists) backupOnce(configPath);
    mkdirSync(dirname(configPath), { recursive: true });
    let text = lines.join(eol);
    if (!text.endsWith(eol)) text += eol;
    writeAtomic(configPath, text);
  }

  private uninstallCodex(configPath: string): void {
    const raw = readFileSync(configPath, 'utf8');
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const { lines, notifyIndex } = parseCodexTopLevel(raw);
    if (notifyIndex < 0 || !lines[notifyIndex].includes(RELAY_FILE_NAME)) return;
    lines.splice(notifyIndex, 1);
    backupOnce(configPath);
    writeAtomic(configPath, lines.length ? `${lines.join(eol)}${eol}` : '');
  }
}

function parseCodexTopLevel(raw: string): { lines: string[]; notifyIndex: number } {
  const lines = raw.length ? raw.split(/\r?\n/) : [];
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let notifyIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (/^\s*\[/.test(lines[i])) break;
    if (/^\s*notify\s*=/.test(lines[i])) {
      notifyIndex = i;
      break;
    }
  }
  return { lines, notifyIndex };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function readJsonSettings(path: string): Record<string, unknown> {
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

function collectCommands(groups: unknown): string[] {
  if (!Array.isArray(groups)) return [];
  const out: string[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) continue;
    for (const hook of group.hooks) {
      if (isRecord(hook) && typeof hook.command === 'string') out.push(hook.command);
    }
  }
  return out;
}

function collectAntigravityCommands(definitions: unknown): string[] {
  if (!Array.isArray(definitions)) return [];
  const out: string[] = [];
  for (const def of definitions) {
    if (!isRecord(def)) continue;
    if (typeof def.command === 'string') out.push(def.command);
    if (Array.isArray(def.hooks)) {
      for (const hook of def.hooks) {
        if (isRecord(hook) && typeof hook.command === 'string') out.push(hook.command);
      }
    }
  }
  return out;
}

function recordHasOurAntigravityCommand(value: unknown, isOurs: (command: unknown) => boolean): boolean {
  if (Array.isArray(value)) return collectAntigravityCommands(value).some(isOurs);
  if (!isRecord(value)) return false;
  return Object.values(value).some((defs) => collectAntigravityCommands(defs).some(isOurs));
}

function stripAntigravityHandlers(bundle: Record<string, unknown>, isOurs: (command: unknown) => boolean): boolean {
  let changed = false;
  for (const [event, defs] of Object.entries(bundle)) {
    if (!Array.isArray(defs)) continue;
    const nextDefs: unknown[] = [];
    for (const def of defs) {
      if (!isRecord(def)) {
        nextDefs.push(def);
        continue;
      }
      if (Array.isArray(def.hooks)) {
        const kept = def.hooks.filter((hook) => !(isRecord(hook) && isOurs(hook.command)));
        if (kept.length !== def.hooks.length) {
          changed = true;
          if (kept.length > 0) nextDefs.push({ ...def, hooks: kept });
          continue;
        }
        if (isOurs(def.command)) {
          changed = true;
          continue;
        }
        nextDefs.push(def);
      } else if (isOurs(def.command)) {
        changed = true;
      } else {
        nextDefs.push(def);
      }
    }
    if (nextDefs.length === 0) delete bundle[event];
    else bundle[event] = nextDefs;
  }
  return changed;
}

/** Removes our hook entries in place; returns true when anything changed. */
function stripOurHooks(hooks: Record<string, unknown>, isOurs: (command: unknown) => boolean): boolean {
  let changed = false;
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const nextGroups: unknown[] = [];
    for (const group of groups) {
      if (!isRecord(group) || !Array.isArray(group.hooks)) {
        nextGroups.push(group);
        continue;
      }
      const kept = group.hooks.filter((hook) => !(isRecord(hook) && isOurs(hook.command)));
      if (kept.length === group.hooks.length) {
        nextGroups.push(group);
        continue;
      }
      changed = true;
      if (kept.length > 0) nextGroups.push({ ...group, hooks: kept });
    }
    if (nextGroups.length === 0) delete hooks[event];
    else hooks[event] = nextGroups;
  }
  return changed;
}

function backupOnce(path: string): void {
  const backup = `${path}.ahastation.bak`;
  if (!existsSync(backup)) copyFileSync(path, backup);
}

function writeAtomic(linkOrPath: string, content: string): void {
  // Write through symlinks (dotfile managers) instead of replacing the link.
  const path = existsSync(linkOrPath) ? realpathSync(linkOrPath) : linkOrPath;
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, content, 'utf8');
  renameSync(tmp, path);
}
