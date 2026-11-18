import type { AgentStatusStore } from './agent/agent-status-store.js';
import { HeadlessEmulator, type HeadlessEmulatorOptions } from './terminal-daemon/emulation/headless-emulator.js';
import type { TerminalSnapshot } from './terminal-daemon/protocol/terminal-snapshot.js';

const MAX_TRANSCRIPT_CHARS = 512_000;
const MAX_EXITED_TERMINALS = 64;
const DEFAULT_READ_LIMIT = 16_384;

// Strip CSI, OSC, DCS/APC/PM, and single-char ESC sequences while normalizing CR/LF for readable logs.
const ANSI_ESCAPE_RE =
  // eslint-disable-next-line no-control-regex
  /\x1b(?:\][^\x07\x1b]*(?:\x07|\x1b\\)|[P^_][^\x1b]*\x1b\\|\[[0-?]*[ -/]*[@-~]|[@-Z\\-_])/g;

export function stripAnsiToPlainText(raw: string): string {
  if (!raw) return '';
  return raw
    .replace(ANSI_ESCAPE_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
}

class ScreenReadableHeadlessEmulator extends HeadlessEmulator {
  constructor(opts: HeadlessEmulatorOptions) {
    super(opts);
  }

  renderScreenText(): string {
    const buf = this.terminal.buffer.active;
    const startRow = Math.max(0, buf.baseY);
    const endRow = Math.min(buf.length, startRow + this.terminal.rows);
    const lines: string[] = [];
    for (let y = startRow; y < endRow; y += 1) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
      lines.pop();
    }
    return lines.join('\n');
  }

  renderScrollbackTail(maxLines: number): string {
    const buf = this.terminal.buffer.active;
    const endRow = buf.length;
    const startRow = Math.max(0, endRow - maxLines * 2);
    const lines: string[] = [];
    for (let y = startRow; y < endRow; y += 1) {
      const line = buf.getLine(y);
      lines.push(line ? line.translateToString(true) : '');
    }
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') {
      lines.pop();
    }
    while (lines.length > 0 && lines[0]!.trim() === '') {
      lines.shift();
    }
    return lines.slice(-maxLines).join('\n');
  }
}

export interface TerminalSummary {
  ptyId: string;
  cwd: string;
  cliId: string | null;
  shellId: string | null;
  title: string;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
  exitedAt: string | null;
  cursor: number;
}

export interface TerminalReadResult {
  ptyId: string;
  screen: boolean;
  text: string;
  cursor: number;
  nextCursor: number;
  truncated: boolean;
  hasMore: boolean;
  alive: boolean;
  exitCode: number | null;
}

export interface TerminalWaitResult {
  ptyId: string;
  for: 'exit' | 'tui-idle';
  satisfied: boolean;
  timedOut: boolean;
  aborted: boolean;
  alive: boolean;
  exitCode: number | null;
  state?: string | null;
}

interface InternalTerminalEntry {
  ptyId: string;
  cwd: string;
  cliId: string | null;
  shellId: string | null;
  title: string;
  cols: number;
  rows: number;
  alive: boolean;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
  exitedAt: string | null;
  lastOutputAtMs: number;
  baseCursor: number;
  transcript: string;
  emulator: ScreenReadableHeadlessEmulator | null;
  frozenScreen: string;
}

export class TerminalRuntimeTracker {
  private readonly entries = new Map<string, InternalTerminalEntry>();
  private readonly dataListeners = new Set<(ptyId: string) => void>();
  private readonly exitListeners = new Set<(ptyId: string, exitCode: number | null) => void>();
  private readonly now: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? (() => Date.now());
  }

  registerPty(input: {
    ptyId: string;
    cwd?: string;
    cliId?: string | null;
    shellId?: string | null;
    title?: string;
    cols?: number;
    rows?: number;
    replayBase64?: string;
    exited?: boolean;
    exitCode?: number | null;
  }): TerminalSummary {
    const nowMs = this.now();
    const nowIso = new Date(nowMs).toISOString();
    const cols = Math.max(10, Math.min(500, Math.floor(input.cols ?? 120)));
    const rows = Math.max(4, Math.min(500, Math.floor(input.rows ?? 32)));
    let entry = this.entries.get(input.ptyId);

    if (!entry) {
      entry = {
        ptyId: input.ptyId,
        cwd: input.cwd ?? process.cwd(),
        cliId: input.cliId ?? null,
        shellId: input.shellId ?? null,
        title: input.title ?? input.cliId ?? input.shellId ?? input.ptyId,
        cols,
        rows,
        alive: !input.exited,
        exitCode: input.exitCode ?? null,
        createdAt: nowIso,
        updatedAt: nowIso,
        exitedAt: input.exited ? nowIso : null,
        lastOutputAtMs: 0,
        baseCursor: 0,
        transcript: '',
        emulator: input.exited
          ? null
          : new ScreenReadableHeadlessEmulator({ cols, rows, scrollback: 500 }),
        frozenScreen: '',
      };
      this.entries.set(input.ptyId, entry);
    } else {
      if (input.cwd) entry.cwd = input.cwd;
      if (input.cliId !== undefined && input.cliId !== null) entry.cliId = input.cliId;
      if (input.shellId !== undefined && input.shellId !== null) entry.shellId = input.shellId;
      if (input.title) entry.title = input.title;
      if (!input.exited && !entry.alive) {
        entry.alive = true;
        entry.exitCode = null;
        entry.exitedAt = null;
        entry.emulator = new ScreenReadableHeadlessEmulator({ cols, rows, scrollback: 500 });
      }
      if (entry.cols !== cols || entry.rows !== rows) {
        entry.cols = cols;
        entry.rows = rows;
        entry.emulator?.resize(cols, rows);
      }
      entry.updatedAt = nowIso;
    }

    if (input.replayBase64 && entry.transcript.length === 0) {
      const replayUtf8 = Buffer.from(input.replayBase64, 'base64').toString('utf8');
      if (replayUtf8) {
        this.ingestUtf8Data(input.ptyId, replayUtf8);
      }
    }

    if (input.exited && entry.alive) {
      this.markExited(input.ptyId, input.exitCode ?? null);
    }

    return this.toSummary(entry);
  }

  ingestBase64Data(ptyId: string, base64Data: string): void {
    if (!base64Data) return;
    const utf8 = Buffer.from(base64Data, 'base64').toString('utf8');
    this.ingestUtf8Data(ptyId, utf8);
  }

  restoreScreen(ptyId: string, snapshot?: TerminalSnapshot): string | undefined {
    const entry = this.entries.get(ptyId);
    if (!entry || !snapshot) return undefined;
    entry.emulator?.dispose();
    entry.emulator = null;
    const screen = new ScreenReadableHeadlessEmulator({
      cols: snapshot.cols,
      rows: snapshot.rows,
      scrollback: 500,
    });
    const prefix = snapshot.modes?.alternateScreen
      ? `${snapshot.scrollbackAnsi ?? ''}\x1b[?1049h`
      : '';
    void screen.write(prefix + snapshot.snapshotAnsi + (snapshot.rehydrateSequences ?? '') +
      (snapshot.pendingEscapeTailAnsi ?? ''));
    entry.cwd = snapshot.cwd ?? entry.cwd;
    entry.title = snapshot.lastTitle ?? entry.title;
    entry.frozenScreen = screen.renderScreenText();
    if (entry.alive) entry.emulator = screen;
    else screen.dispose();
    return entry.frozenScreen;
  }

  ingestUtf8Data(ptyId: string, utf8: string): void {
    if (!utf8) return;
    let entry = this.entries.get(ptyId);
    if (!entry) {
      this.registerPty({ ptyId });
      entry = this.entries.get(ptyId)!;
    }

    const nowMs = this.now();
    entry.lastOutputAtMs = nowMs;
    entry.updatedAt = new Date(nowMs).toISOString();

    if (entry.emulator) {
      void entry.emulator.write(utf8);
      try {
        const snap = entry.emulator.getSnapshot({ scrollbackRows: 0 });
        if (snap.cwd) entry.cwd = snap.cwd;
        if (snap.lastTitle) entry.title = snap.lastTitle;
      } catch {
        /* ignore transient headless snapshot failures */
      }
    }

    const plain = stripAnsiToPlainText(utf8);
    if (plain.length > 0) {
      entry.transcript += plain;
      if (entry.transcript.length > MAX_TRANSCRIPT_CHARS) {
        const overflow = entry.transcript.length - MAX_TRANSCRIPT_CHARS;
        entry.transcript = entry.transcript.slice(overflow);
        entry.baseCursor += overflow;
      }
    }

    for (const listener of this.dataListeners) {
      try {
        listener(ptyId);
      } catch {
        /* ignore */
      }
    }
  }

  resizePty(ptyId: string, rows: number, cols: number): void {
    const entry = this.entries.get(ptyId);
    if (!entry) return;
    const safeCols = Math.max(10, Math.min(500, Math.floor(cols)));
    const safeRows = Math.max(4, Math.min(500, Math.floor(rows)));
    entry.cols = safeCols;
    entry.rows = safeRows;
    entry.emulator?.resize(safeCols, safeRows);
  }

  markExited(ptyId: string, exitCode: number | null): void {
    const entry = this.entries.get(ptyId);
    if (!entry) return;
    const nowIso = new Date(this.now()).toISOString();
    if (entry.emulator) {
      try {
        entry.frozenScreen = entry.emulator.renderScreenText();
      } catch {
        entry.frozenScreen = '';
      }
      entry.emulator.dispose();
      entry.emulator = null;
    }
    entry.alive = false;
    entry.exitCode = exitCode;
    entry.exitedAt = entry.exitedAt ?? nowIso;
    entry.updatedAt = nowIso;

    this.pruneExited();
    for (const listener of this.exitListeners) {
      try {
        listener(ptyId, exitCode);
      } catch {
        /* ignore */
      }
    }
  }

  isAlive(ptyId: string): boolean {
    return this.entries.get(ptyId)?.alive === true;
  }

  listTerminals(opts: { includeExited?: boolean } = {}): TerminalSummary[] {
    const includeExited = opts.includeExited ?? false;
    return [...this.entries.values()]
      .filter((e) => includeExited || e.alive)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((e) => this.toSummary(e));
  }

  getTerminal(ptyId: string): TerminalSummary | null {
    const entry = this.entries.get(ptyId);
    return entry ? this.toSummary(entry) : null;
  }

  readOutput(
    ptyId: string,
    opts: { cursor?: number; limit?: number; screen?: boolean } = {}
  ): TerminalReadResult | null {
    const entry = this.entries.get(ptyId);
    if (!entry) return null;

    const endCursor = entry.baseCursor + entry.transcript.length;
    if (opts.screen) {
      const screenText = entry.emulator
        ? entry.emulator.renderScreenText()
        : entry.frozenScreen || entry.transcript.slice(-DEFAULT_READ_LIMIT);
      return {
        ptyId,
        screen: true,
        text: screenText,
        cursor: endCursor,
        nextCursor: endCursor,
        truncated: false,
        hasMore: false,
        alive: entry.alive,
        exitCode: entry.exitCode,
      };
    }

    const limit = Math.max(1, Math.min(256_000, Math.floor(opts.limit ?? DEFAULT_READ_LIMIT)));
    const requestedCursor =
      typeof opts.cursor === 'number' && Number.isFinite(opts.cursor)
        ? Math.max(0, Math.floor(opts.cursor))
        : entry.baseCursor;
    const truncated = requestedCursor < entry.baseCursor;
    const effectiveStart = Math.min(endCursor, Math.max(requestedCursor, entry.baseCursor));
    const offset = effectiveStart - entry.baseCursor;
    const text = entry.transcript.slice(offset, offset + limit);
    const nextCursor = effectiveStart + text.length;

    return {
      ptyId,
      screen: false,
      text,
      cursor: effectiveStart,
      nextCursor,
      truncated,
      hasMore: nextCursor < endCursor,
      alive: entry.alive,
      exitCode: entry.exitCode,
    };
  }

  captureTail(ptyId: string, maxChars = 2_000, maxLines = 40): string {
    const entry = this.entries.get(ptyId);
    if (!entry) return '';
    let candidate = '';
    if (entry.emulator) {
      try {
        candidate = entry.emulator.renderScrollbackTail(maxLines);
      } catch {
        candidate = '';
      }
    } else if (entry.frozenScreen) {
      candidate = entry.frozenScreen;
    }
    if (!candidate.trim() && entry.transcript) {
      const lines = entry.transcript
        .split('\n')
        .map((line) => line.trimEnd())
        .filter((line, idx, arr) => line.length > 0 || (idx > 0 && idx < arr.length - 1));
      candidate = lines.slice(-maxLines).join('\n');
    }
    const trimmed = candidate.trim();
    if (trimmed.length <= maxChars) return trimmed;
    return `…${trimmed.slice(-(maxChars - 1))}`;
  }

  readFullTranscript(ptyId: string, maxChars = 128_000): string {
    const entry = this.entries.get(ptyId);
    if (!entry) return '';
    const screen = entry.emulator ? entry.emulator.renderScreenText() : entry.frozenScreen;
    const base = entry.transcript.trim() ? entry.transcript : screen;
    if (base.length <= maxChars) return base;
    return base.slice(-maxChars);
  }

  async waitForTerminal(
    ptyId: string,
    opts: {
      for: 'exit' | 'tui-idle';
      timeoutMs?: number;
      idleMs?: number;
      agentStatusStore?: AgentStatusStore;
      signal?: AbortSignal;
    }
  ): Promise<TerminalWaitResult> {
    const entry = this.entries.get(ptyId);
    if (!entry) {
      return {
        ptyId,
        for: opts.for,
        satisfied: opts.for === 'exit',
        timedOut: false,
        aborted: false,
        alive: false,
        exitCode: null,
        state: null,
      };
    }

    const timeoutMs = Math.max(0, Math.min(600_000, Math.floor(opts.timeoutMs ?? 30_000)));
    const idleMs = Math.max(100, Math.min(60_000, Math.floor(opts.idleMs ?? 1_000)));

    if (opts.for === 'exit') {
      if (!entry.alive) {
        return {
          ptyId,
          for: 'exit',
          satisfied: true,
          timedOut: false,
          aborted: false,
          alive: false,
          exitCode: entry.exitCode,
          state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
        };
      }
      return new Promise<TerminalWaitResult>((resolve) => {
        let settled = false;
        const finish = (res: TerminalWaitResult) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.exitListeners.delete(onExit);
          opts.signal?.removeEventListener('abort', onAbort);
          resolve(res);
        };
        const onExit = (id: string, exitCode: number | null) => {
          if (id !== ptyId) return;
          finish({
            ptyId,
            for: 'exit',
            satisfied: true,
            timedOut: false,
            aborted: false,
            alive: false,
            exitCode,
            state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
          });
        };
        const onAbort = () => {
          finish({
            ptyId,
            for: 'exit',
            satisfied: false,
            timedOut: false,
            aborted: true,
            alive: entry.alive,
            exitCode: entry.exitCode,
            state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
          });
        };
        const timer = setTimeout(() => {
          finish({
            ptyId,
            for: 'exit',
            satisfied: false,
            timedOut: true,
            aborted: false,
            alive: entry.alive,
            exitCode: entry.exitCode,
            state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
          });
        }, timeoutMs);
        timer.unref?.();
        this.exitListeners.add(onExit);
        if (opts.signal?.aborted) {
          onAbort();
          return;
        }
        opts.signal?.addEventListener('abort', onAbort, { once: true });
      });
    }

    const isTuiIdleNow = (): boolean => {
      const current = this.entries.get(ptyId);
      if (!current || !current.alive) return true;
      const paneStatus = opts.agentStatusStore?.get(ptyId);
      if (paneStatus?.state === 'working') return false;
      if (paneStatus && (paneStatus.state === 'done' || paneStatus.state === 'waiting' || paneStatus.state === 'error')) {
        if (current.lastOutputAtMs === 0 || this.now() - current.lastOutputAtMs >= Math.min(idleMs, 250)) {
          return true;
        }
      }
      if (current.lastOutputAtMs > 0 && this.now() - current.lastOutputAtMs >= idleMs) {
        return true;
      }
      return false;
    };

    if (isTuiIdleNow()) {
      const current = this.entries.get(ptyId);
      return {
        ptyId,
        for: 'tui-idle',
        satisfied: true,
        timedOut: false,
        aborted: false,
        alive: current?.alive ?? false,
        exitCode: current?.exitCode ?? null,
        state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
      };
    }

    return new Promise<TerminalWaitResult>((resolve) => {
      let settled = false;
      const check = () => {
        if (isTuiIdleNow()) {
          const current = this.entries.get(ptyId);
          finish({
            ptyId,
            for: 'tui-idle',
            satisfied: true,
            timedOut: false,
            aborted: false,
            alive: current?.alive ?? false,
            exitCode: current?.exitCode ?? null,
            state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
          });
        }
      };
      const onExit = (id: string, exitCode: number | null) => {
        if (id !== ptyId) return;
        finish({
          ptyId,
          for: 'tui-idle',
          satisfied: true,
          timedOut: false,
          aborted: false,
          alive: false,
          exitCode,
          state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
        });
      };
      const onAbort = () => {
        const current = this.entries.get(ptyId);
        finish({
          ptyId,
          for: 'tui-idle',
          satisfied: false,
          timedOut: false,
          aborted: true,
          alive: current?.alive ?? false,
          exitCode: current?.exitCode ?? null,
          state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
        });
      };
      const pollInterval = setInterval(check, Math.min(100, Math.max(25, Math.floor(idleMs / 4))));
      pollInterval.unref?.();
      const timeoutTimer = setTimeout(() => {
        const current = this.entries.get(ptyId);
        finish({
          ptyId,
          for: 'tui-idle',
          satisfied: false,
          timedOut: true,
          aborted: false,
          alive: current?.alive ?? false,
          exitCode: current?.exitCode ?? null,
          state: opts.agentStatusStore?.get(ptyId)?.state ?? null,
        });
      }, timeoutMs);
      timeoutTimer.unref?.();
      const offStatus = opts.agentStatusStore?.onChange((status) => {
        if (status.ptyId === ptyId) check();
      });

      const finish = (res: TerminalWaitResult) => {
        if (settled) return;
        settled = true;
        clearInterval(pollInterval);
        clearTimeout(timeoutTimer);
        offStatus?.();
        this.exitListeners.delete(onExit);
        opts.signal?.removeEventListener('abort', onAbort);
        resolve(res);
      };

      this.exitListeners.add(onExit);
      if (opts.signal?.aborted) {
        onAbort();
        return;
      }
      opts.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.emulator?.dispose();
      entry.emulator = null;
    }
    this.entries.clear();
    this.dataListeners.clear();
    this.exitListeners.clear();
  }

  private pruneExited(): void {
    const exited = [...this.entries.values()]
      .filter((e) => !e.alive)
      .sort((a, b) => (a.exitedAt ?? a.updatedAt).localeCompare(b.exitedAt ?? b.updatedAt));
    while (exited.length > MAX_EXITED_TERMINALS) {
      const victim = exited.shift()!;
      victim.emulator?.dispose();
      this.entries.delete(victim.ptyId);
    }
  }

  private toSummary(entry: InternalTerminalEntry): TerminalSummary {
    return {
      ptyId: entry.ptyId,
      cwd: entry.cwd,
      cliId: entry.cliId,
      shellId: entry.shellId,
      title: entry.title,
      cols: entry.cols,
      rows: entry.rows,
      alive: entry.alive,
      exitCode: entry.exitCode,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      exitedAt: entry.exitedAt,
      cursor: entry.baseCursor + entry.transcript.length,
    };
  }
}
