import { isAbsolute, normalize } from 'node:path';
import { codexThreadSummary, type CodexThreadSummary } from './codex-thread-history.js';

/** What the catalog needs from a Codex app-server process; `CodexAppServerPilot` provides it. */
export interface CodexQueryConnection {
  readonly alive: boolean;
  query(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

export interface CodexModelOption {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  efforts: { value: string; description: string }[];
  defaultEffort: string | null;
  /** Accepts image input. */
  images: boolean;
}

export interface CodexSkillOption {
  name: string;
  description: string;
  path: string;
  scope: string;
  enabled: boolean;
  pluginId: string | null;
}

export interface CodexPluginOption {
  id: string;
  name: string;
  displayName: string;
  description: string;
  developer: string | null;
  category: string | null;
  marketplace: string;
  enabled: boolean;
  capabilities: string[];
  defaultPrompts: string[];
}

export interface CodexFileMatch {
  /** Relative to the searched folder, with forward slashes. */
  path: string;
  fileName: string;
}

export interface CodexRateLimitWindow {
  usedPercent: number;
  /** Length of the window, e.g. 300 for five hours; null when Codex does not say. */
  windowMinutes: number | null;
  /** When the window resets, in epoch milliseconds. */
  resetsAt: number | null;
}

/** The account's Codex usage limits, as of when they were read. */
export interface CodexRateLimits {
  name: string | null;
  primary: CodexRateLimitWindow | null;
  secondary: CodexRateLimitWindow | null;
  planType: string | null;
  /** Codex reports the limit as reached (or the workspace out of credits). */
  reached: boolean;
}

const MODEL_TTL_MS = 10 * 60_000;
const LIST_TTL_MS = 60_000;
const MAX_MODEL_PAGES = 5;
const MAX_FILE_MATCHES = 30;
const THREAD_PAGE = 50;

type Obj = Record<string, unknown>;
const object = (value: unknown): Obj => (value && typeof value === 'object' ? value as Obj : {});
const array = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const limitWindow = (value: unknown): CodexRateLimitWindow | null => {
  const entry = object(value);
  const usedPercent = finite(entry.usedPercent);
  if (usedPercent === null) return null;
  const resetsAt = finite(entry.resetsAt);
  return {
    usedPercent: Math.min(Math.max(usedPercent, 0), 100),
    windowMinutes: finite(entry.windowDurationMins),
    resetsAt: resetsAt === null ? null : resetsAt * 1000,
  };
};
const samePath = (a: string, b: string) => {
  const clean = (value: string) => normalize(value).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b);
};

interface Cached<T> { value: T; at: number }

/**
 * Models, skills, installed plugins, and file search for the session composer. They come from one
 * Codex app-server started on demand without a conversation, so asking never touches a session's
 * thread and works while a session is suspended. The process stops after a quiet period.
 */
export class CodexCatalog {
  private connection: CodexQueryConnection | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private models: Cached<CodexModelOption[]> | null = null;
  private readonly skillsByCwd = new Map<string, Cached<CodexSkillOption[]>>();
  private readonly pluginsByCwd = new Map<string, Cached<CodexPluginOption[]>>();
  private disposed = false;
  private inFlight = 0;

  constructor(
    private readonly launch: () => CodexQueryConnection,
    private readonly idleMs = 120_000,
    private readonly now: () => number = Date.now,
  ) {}

  async listModels(): Promise<CodexModelOption[]> {
    if (this.models && this.now() - this.models.at < MODEL_TTL_MS) return this.models.value;
    const models: CodexModelOption[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MODEL_PAGES; page++) {
      const result = object(await this.query('model/list', cursor ? { cursor } : {}));
      for (const entry of array(result.data).map(object)) {
        if (entry.hidden === true || !text(entry.id)) continue;
        models.push({
          id: text(entry.id),
          model: text(entry.model) || text(entry.id),
          displayName: text(entry.displayName) || text(entry.id),
          description: text(entry.description),
          isDefault: entry.isDefault === true,
          efforts: array(entry.supportedReasoningEfforts).map(object)
            .filter((option) => text(option.reasoningEffort))
            .map((option) => ({ value: text(option.reasoningEffort), description: text(option.description) })),
          defaultEffort: textOrNull(entry.defaultReasoningEffort),
          images: array(entry.inputModalities).includes('image'),
        });
      }
      cursor = textOrNull(result.nextCursor);
      if (!cursor) break;
    }
    this.models = { value: models, at: this.now() };
    return models;
  }

  async listSkills(cwd: string, reload = false): Promise<CodexSkillOption[]> {
    const cached = this.skillsByCwd.get(cwd);
    if (!reload && cached && this.now() - cached.at < LIST_TTL_MS) return cached.value;
    const result = object(await this.query('skills/list', { cwds: [cwd], ...(reload ? { forceReload: true } : {}) }));
    const entries = array(result.data).map(object);
    const entry = entries.find((item) => samePath(text(item.cwd), cwd)) ?? entries[0];
    const skills = array(entry?.skills).map(object)
      .filter((skill) => text(skill.name) && isAbsolute(text(skill.path)))
      .map((skill): CodexSkillOption => {
        const ui = object(skill.interface);
        return {
          name: text(skill.name),
          description: text(ui.shortDescription) || text(skill.shortDescription) || text(skill.description),
          path: text(skill.path),
          scope: text(skill.scope),
          enabled: skill.enabled !== false,
          pluginId: textOrNull(skill.pluginId),
        };
      });
    this.skillsByCwd.set(cwd, { value: skills, at: this.now() });
    return skills;
  }

  /** The skill at `path` as Codex last listed it for `cwd`, so a message can only name a real skill. */
  async findSkill(cwd: string, path: string): Promise<CodexSkillOption | null> {
    const match = (skills: CodexSkillOption[]) => skills.find((skill) => samePath(skill.path, path)) ?? null;
    return match(await this.listSkills(cwd)) ?? match(await this.listSkills(cwd, true));
  }

  async setSkillEnabled(cwd: string, path: string, enabled: boolean): Promise<void> {
    const skill = await this.findSkill(cwd, path);
    if (!skill) throw new Error('Codex 没有列出这个技能');
    await this.query('skills/config/write', { path: skill.path, enabled });
    this.skillsByCwd.clear();
  }

  async listPlugins(cwd: string): Promise<CodexPluginOption[]> {
    const cached = this.pluginsByCwd.get(cwd);
    if (cached && this.now() - cached.at < LIST_TTL_MS) return cached.value;
    const result = object(await this.query('plugin/installed', { cwds: [cwd] }));
    const plugins: CodexPluginOption[] = [];
    for (const marketplace of array(result.marketplaces).map(object)) {
      for (const plugin of array(marketplace.plugins).map(object)) {
        if (plugin.installed !== true || !text(plugin.id)) continue;
        const ui = object(plugin.interface);
        plugins.push({
          id: text(plugin.id),
          name: text(plugin.name),
          displayName: text(ui.displayName) || text(plugin.name),
          description: text(ui.shortDescription),
          developer: textOrNull(ui.developerName),
          category: textOrNull(ui.category),
          marketplace: text(marketplace.name),
          enabled: plugin.enabled === true,
          capabilities: array(ui.capabilities).filter((value): value is string => typeof value === 'string'),
          defaultPrompts: array(ui.defaultPrompt).filter((value): value is string => typeof value === 'string').slice(0, 3),
        });
      }
    }
    this.pluginsByCwd.set(cwd, { value: plugins, at: this.now() });
    return plugins;
  }

  async searchFiles(cwd: string, query: string): Promise<CodexFileMatch[]> {
    const result = object(await this.query('fuzzyFileSearch', { query, roots: [cwd], cancellationToken: null }));
    return array(result.files).map(object)
      .filter((file) => text(file.path))
      .slice(0, MAX_FILE_MATCHES)
      .map((file) => ({ path: text(file.path).replace(/\\/g, '/'), fileName: text(file.file_name) }));
  }

  /**
   * Usage limits of the signed-in account. Not cached here: the renderer decides how fresh it
   * needs them. Throws when Codex has no account to ask about (e.g. an API key login).
   */
  async readRateLimits(): Promise<CodexRateLimits> {
    const result = object(await this.query('account/rateLimits/read', { excludeResetCreditDetails: true }));
    // The per-limit view has the Codex bucket by name; the single snapshot mirrors older servers.
    const snapshot = object(object(result.rateLimitsByLimitId).codex ?? result.rateLimits);
    return {
      name: textOrNull(snapshot.limitName),
      primary: limitWindow(snapshot.primary),
      secondary: limitWindow(snapshot.secondary),
      planType: textOrNull(snapshot.planType),
      reached: Boolean(textOrNull(snapshot.rateLimitReachedType)) || result.ordinaryUsageAllowed === false,
    };
  }

  /**
   * Past conversations in `cwd`, newest first, without Worker threads. `cursor` continues a
   * previous page. A page can come back shorter than `limit` once Worker threads are left out.
   */
  async listThreads(input: { cwd: string; search?: string; archived?: boolean; cursor?: string | null; limit?: number }): Promise<{
    threads: CodexThreadSummary[]; nextCursor: string | null;
  }> {
    const result = object(await this.query('thread/list', {
      cwd: input.cwd, limit: input.limit ?? THREAD_PAGE, sortKey: 'updated_at', archived: input.archived ?? false,
      ...(input.search?.trim() ? { searchTerm: input.search.trim() } : {}),
      ...(input.cursor ? { cursor: input.cursor } : {}),
    }));
    const threads = array(result.data).map(codexThreadSummary).filter((thread): thread is CodexThreadSummary => Boolean(thread));
    return { threads, nextCursor: textOrNull(result.nextCursor) };
  }

  /** A stored thread with its turns, for replaying it into a reopened session. */
  async readThread(threadId: string): Promise<Record<string, unknown>> {
    const result = object(await this.query('thread/read', { threadId, includeTurns: true }));
    const thread = object(result.thread);
    if (text(thread.id) !== threadId) throw new Error('Codex 没有找到这个会话');
    return thread;
  }

  async setThreadArchived(threadId: string, archived: boolean): Promise<void> {
    await this.query(archived ? 'thread/archive' : 'thread/unarchive', { threadId });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.clearIdle();
    const connection = this.connection;
    this.connection = null;
    await connection?.close();
  }

  private async query(method: string, params: Obj): Promise<unknown> {
    if (this.disposed) throw new Error('Codex catalog is closed');
    if (!this.connection?.alive) this.connection = this.launch();
    const connection = this.connection;
    this.clearIdle();
    this.inFlight++;
    try {
      return await connection.query(method, params);
    } finally {
      this.inFlight--;
      if (this.inFlight === 0 && this.connection === connection && !this.disposed) {
        this.idleTimer = setTimeout(() => {
          this.idleTimer = null;
          if (this.connection === connection) this.connection = null;
          void connection.close();
        }, this.idleMs);
        this.idleTimer.unref?.();
      }
    }
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }
}
