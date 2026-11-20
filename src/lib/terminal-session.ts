import { Terminal } from '@xterm/xterm';
import type { ITheme, ITerminalAddon, ILinkProvider, IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { TerminalRestoreEvent, TerminalScreenSnapshot } from '../types';
import { createTerminalOscTracker } from './terminal-osc-tracker';

export interface PtyTerminalHandle {
  attach: (size: { rows: number; cols: number }) => Promise<
    {
      ok: true;
      ptyId: string;
      replay: string;
      sequence?: number;
      exited?: boolean;
      exitCode?: number | null;
      screenSnapshot?: TerminalScreenSnapshot;
    }
    | { ok: false; error: string }
  >;
  input: (ptyId: string, data: string) => void | Promise<void>;
  resize: (ptyId: string, rows: number, cols: number) => void;
  onData: (cb: (event: { ptyId: string; data: string; sequence?: number }) => void) => () => void;
  onRestore?: (cb: (snapshot: TerminalRestoreEvent) => void) => () => void;
  onExit: (cb: (event: { ptyId: string; exitCode: number | null }) => void) => () => void;
  dispose: (ptyId: string) => void | Promise<void>;
  /** A tab has a stable process id before create resolves. */
  expectedPtyId?: string;
}

export interface TerminalSessionState {
  phase: 'starting' | 'running' | 'exited' | 'error' | 'closing';
  error: string | null;
  exitCode?: number | null;
  title?: string;
  cwd?: string;
  commandRunning?: boolean;
  lastExitCode?: number | null;
  lastDurationMs?: number | null;
}

export const INITIAL_TERMINAL_STATE: TerminalSessionState = { phase: 'starting', error: null };
// Base64 strings are ASCII; bound both bytes and event overhead during create.
const MAX_PENDING_SIZE = 1024 * 1024;
const MAX_PENDING_EVENTS = 4096;

function decode(data: string) {
  return Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
}

function parseHexRgb(hex: string | undefined): [number, number, number] | null {
  if (!hex) return null;
  const trimmed = hex.trim().replace(/^#/, '');
  if (trimmed.length === 3 && /^[0-9a-fA-F]{3}$/.test(trimmed)) {
    return [
      Number.parseInt(trimmed[0] + trimmed[0], 16),
      Number.parseInt(trimmed[1] + trimmed[1], 16),
      Number.parseInt(trimmed[2] + trimmed[2], 16),
    ];
  }
  if ((trimmed.length === 6 || trimmed.length === 8) && /^[0-9a-fA-F]+$/.test(trimmed)) {
    return [
      Number.parseInt(trimmed.slice(0, 2), 16),
      Number.parseInt(trimmed.slice(2, 4), 16),
      Number.parseInt(trimmed.slice(4, 6), 16),
    ];
  }
  return null;
}

function formatOscRgb16(hex: string | undefined, fallback: string): string {
  const [r, g, b] = parseHexRgb(hex) ?? parseHexRgb(fallback) ?? [0x1e, 0x1e, 0x1e];
  const ch = (n: number) => n.toString(16).padStart(2, '0').repeat(2);
  return `rgb:${ch(r)}/${ch(g)}/${ch(b)}`;
}

function isLightThemeBackground(theme: ITheme | undefined): boolean {
  const rgb = parseHexRgb(theme?.background);
  if (!rgb) return false;
  return (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255 >= 0.5;
}

function colorSchemeReport(theme: ITheme | undefined): string {
  return isLightThemeBackground(theme) ? '\x1b[?997;2n' : '\x1b[?997;1n';
}

/** Owns the terminal screen and stream; a React surface only borrows its DOM. */
export class TerminalSession {
  readonly element = document.createElement('div');
  readonly terminal: Terminal;
  private fit = new FitAddon();
  private host: HTMLElement | null = null;
  private observer: ResizeObserver;
  private frame = 0;
  private opened = false;
  private destroyed = false;
  private closeRequested = false;
  private ptyId: string | null = null;
  private connected = false;
  private pending: Array<{ data: string; sequence?: number }> = [];
  private pendingSize = 0;
  private overflowed = false;
  private pendingExit: { exitCode: number | null } | null = null;
  private pendingRestore: TerminalRestoreEvent | null = null;
  private sequence = 0;
  private lastSize = '';
  private cleanup: Array<() => void> = [];
  private streamCleanup: Array<() => void> = [];
  private connection?: Promise<void>;
  private closePromise?: Promise<void>;
  private state = INITIAL_TERMINAL_STATE;
  private decoder = new TextDecoder('utf-8', { fatal: false });
  private replayDepth = 0;
  private colorSchemeReporting = false;
  private oscTracker = createTerminalOscTracker({
    onUpdate: (osc) => {
      this.setState({
        ...(osc.cwd !== undefined ? { cwd: osc.cwd } : {}),
        commandRunning: osc.commandRunning,
        lastExitCode: osc.lastExitCode,
        lastDurationMs: osc.lastDurationMs,
      });
    },
  });

  constructor(
    private transport: PtyTerminalHandle,
    fontSize: number,
    private changed: () => void,
    theme?: ITheme,
    minimumContrastRatio?: number,
  ) {
    this.element.className = 'terminal-session-surface';
    this.terminal = new Terminal({
      allowProposedApi: true, cursorBlink: true, cursorInactiveStyle: 'outline', scrollback: 5000,
      fontFamily: '"Cascadia Mono", "Consolas", "Menlo", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Microsoft YaHei UI", "Microsoft YaHei", monospace',
      fontSize, theme,
      ...(minimumContrastRatio !== undefined ? { minimumContrastRatio } : {}),
      fontWeight: '300', fontWeightBold: '400',
    });
    this.terminal.loadAddon(this.fit);
    this.terminal.loadAddon(new Unicode11Addon());
    this.terminal.unicode.activeVersion = '11';
    this.observer = new ResizeObserver(() => this.scheduleFit());
    const input = this.terminal.onData((data) => {
      // Includes xterm's device/cursor replies, including the initial replay.
      if (this.ptyId && !this.closeRequested && this.state.phase === 'running') {
        void Promise.resolve().then(() => {
          if (!this.closeRequested && this.state.phase === 'running') return this.transport.input(this.ptyId!, data);
        }).catch((error) => this.setState({ error: String(error) }));
      }
    });
    const title = this.terminal.onTitleChange((value) => this.setState({ title: value }));
    this.cleanup.push(() => input.dispose(), () => title.dispose());
    this.registerColorSchemeResponders();
    this.streamCleanup.push(transport.onData((event) => {
      if (event.ptyId !== (this.ptyId ?? transport.expectedPtyId)) return;
      if (this.destroyed || this.closeRequested || this.overflowed) return;
      if (!this.connected) {
        if (this.pendingSize + event.data.length > MAX_PENDING_SIZE || this.pending.length >= MAX_PENDING_EVENTS) {
          this.overflowed = true;
          this.clearPending();
          this.setState({ phase: 'error', error: '启动输出超过缓冲上限，请关闭此标签后重新打开。' });
          return;
        }
        this.pending.push(event);
        this.pendingSize += event.data.length;
      }
      else this.write(event);
    }));
    this.streamCleanup.push(transport.onExit((event) => {
      if (event.ptyId !== (this.ptyId ?? transport.expectedPtyId)) return;
      if (this.destroyed || this.closeRequested || this.overflowed) return;
      if (!this.connected) this.pendingExit = event;
      else this.setState({ phase: 'exited', exitCode: event.exitCode, commandRunning: false });
    }));
    const unsubscribeRestore = transport.onRestore?.((snapshot) => {
      if (snapshot.ptyId !== (this.ptyId ?? transport.expectedPtyId)) return;
      if (this.destroyed || this.closeRequested || this.overflowed) return;
      if (!this.connected) {
        this.pendingRestore = snapshot;
      } else if ((snapshot.sequence ?? 0) >= this.sequence) {
        this.restoreScreen(snapshot, true);
      }
    });
    if (unsubscribeRestore) this.streamCleanup.push(unsubscribeRestore);
  }

  getSnapshot = () => this.state;

  getPtyId = () => this.ptyId;

  focus() {
    if (!this.destroyed) {
      this.terminal.focus();
    }
  }

  clear() {
    if (!this.destroyed) {
      this.terminal.clear();
    }
  }

  getSelection(): string {
    return this.destroyed ? '' : this.terminal.getSelection();
  }

  clearSelection() {
    if (!this.destroyed) {
      this.terminal.clearSelection();
    }
  }

  attachAddon(addon: ITerminalAddon): () => void {
    if (this.destroyed) return () => {};
    this.terminal.loadAddon(addon);
    const dispose = () => {
      try { addon.dispose(); } catch { /* ignore */ }
    };
    this.cleanup.push(dispose);
    return dispose;
  }

  registerLinkProvider(provider: ILinkProvider): IDisposable {
    if (this.destroyed || typeof this.terminal.registerLinkProvider !== 'function') {
      return { dispose() {} };
    }
    const disposable = this.terminal.registerLinkProvider(provider);
    const dispose = () => {
      try { disposable.dispose(); } catch { /* ignore */ }
    };
    this.cleanup.push(dispose);
    return { dispose };
  }

  private setState(next: Partial<TerminalSessionState>) {
    if (this.destroyed) return;
    this.state = { ...this.state, ...next };
    this.changed();
  }

  mount(host: HTMLElement, options?: { focus?: boolean }) {
    if (this.destroyed || (this.closeRequested && !this.opened)) return;
    const shouldFocus = options?.focus ?? true;
    this.host = host;
    host.appendChild(this.element);
    if (!this.opened) {
      this.terminal.open(this.element);
      this.opened = true;
      this.fitVisible();
      this.connection = this.connect();
    }
    this.terminal.options.cursorBlink = shouldFocus;
    this.observer.observe(host);
    this.scheduleFit();
    if (shouldFocus) {
      this.terminal.focus();
    }
  }

  unmount(host: HTMLElement) {
    if (this.host !== host) return;
    this.observer.disconnect();
    cancelAnimationFrame(this.frame);
    this.terminal.blur();
    this.terminal.options.cursorBlink = false;
    this.element.remove();
    this.host = null;
  }

  private async connect() {
    try {
      const result = await this.transport.attach({ rows: this.terminal.rows, cols: this.terminal.cols });
      if (!result.ok) {
        this.releaseStream();
        if (!this.closeRequested) this.setState({ phase: 'error', error: result.error });
        return;
      }
      this.ptyId = result.ptyId;
      // close owns disposal after this promise settles. Never reopen input.
      if (this.closeRequested || this.destroyed) { this.releaseStream(); return; }
      if (this.overflowed) { this.releaseStream(); return; }
      this.connected = true;
      const restored = this.pendingRestore;
      this.restoreScreen(restored && (restored.sequence ?? 0) >= (result.sequence ?? 0)
        ? restored : result, false);
      if (this.pendingExit) this.setState({
        phase: 'exited',
        exitCode: this.pendingExit.exitCode,
        commandRunning: false,
      });
      for (const event of this.pending) this.write(event);
      this.clearPending();
      this.fitVisible();
    } catch (error) {
      this.releaseStream();
      if (!this.closeRequested) this.setState({ phase: 'error', error: String(error) });
    }
  }

  private emitProtocolReply(reply: string) {
    if (!this.ptyId || this.closeRequested || this.destroyed || this.state.phase !== 'running' || this.replayDepth > 0) {
      return;
    }
    const targetPtyId = this.ptyId;
    void Promise.resolve().then(() => {
      if (!this.closeRequested && !this.destroyed && this.state.phase === 'running' && this.ptyId === targetPtyId) {
        return this.transport.input(targetPtyId, reply);
      }
    }).catch((error) => this.setState({ error: String(error) }));
  }

  private registerColorSchemeResponders() {
    const parser = this.terminal.parser;
    if (!parser) return;
    const oscColorFor = (ident: number): string | null => {
      const theme = this.terminal.options.theme;
      if (ident === 10) return formatOscRgb16(theme?.foreground, '#d4d4d4');
      if (ident === 11) return formatOscRgb16(theme?.background, '#1e1e1e');
      if (ident === 12) return formatOscRgb16(theme?.cursor ?? theme?.foreground, '#ffffff');
      return null;
    };
    const disposables: IDisposable[] = [];
    for (const baseIdent of [10, 11, 12] as const) {
      disposables.push(parser.registerOscHandler(baseIdent, (data) => {
        const parts = data.split(';');
        let answered = false;
        for (let i = 0; i < parts.length; i++) {
          if (parts[i] !== '?') continue;
          const targetIdent = baseIdent + i;
          const color = oscColorFor(targetIdent);
          if (color) {
            this.emitProtocolReply(`\x1b]${targetIdent};${color}\x1b\\`);
            answered = true;
          }
        }
        return answered && parts.every((part) => part === '?');
      }));
    }
    disposables.push(parser.registerCsiHandler({ prefix: '?', final: 'n' }, (params) => {
      if (params.length > 0 && params[0] === 996) {
        this.emitProtocolReply(colorSchemeReport(this.terminal.options.theme));
        return true;
      }
      return false;
    }));
    disposables.push(parser.registerCsiHandler({ prefix: '?', final: 'h' }, (params) => {
      if (params.some((param) => param === 2031)) {
        this.colorSchemeReporting = true;
      }
      return false;
    }));
    disposables.push(parser.registerCsiHandler({ prefix: '?', final: 'l' }, (params) => {
      if (params.some((param) => param === 2031)) {
        this.colorSchemeReporting = false;
      }
      return false;
    }));
    this.cleanup.push(() => {
      for (const disposable of disposables) {
        try { disposable.dispose(); } catch { /* ignore */ }
      }
    });
  }

  private writeSuppressed(data: string | Uint8Array) {
    if (!this.terminal.parser) {
      this.terminal.write(data);
      return;
    }
    this.replayDepth += 1;
    this.terminal.write(data, () => {
      this.replayDepth = Math.max(0, this.replayDepth - 1);
    });
  }

  private restoreScreen(result: TerminalRestoreEvent, replacing: boolean): void {
    this.sequence = result.sequence ?? 0;
    const snapshot = result.screenSnapshot;
    if (replacing) {
      this.oscTracker.reset();
      this.decoder = new TextDecoder('utf-8', { fatal: false });
    }
    if (snapshot?.cwd) this.oscTracker.seedCwd(snapshot.cwd);
    this.setState({
      phase: result.exited ? 'exited' : 'running',
      exitCode: result.exitCode,
      ...(replacing || result.exited ? { commandRunning: false } : {}),
      ...(snapshot?.lastTitle ? { title: snapshot.lastTitle } : {}),
      ...(snapshot?.cwd ? { cwd: snapshot.cwd } : {}),
    });
    const clear = replacing ? '\x18\x1b[?1049l\x1b[3J\x1b[2J\x1b[H' : '\x18\x1b[?1049l\x1b[2J\x1b[H';
    if (snapshot && (snapshot.snapshotAnsi || snapshot.scrollbackAnsi)) {
      const normal = snapshot.modes?.alternateScreen
        ? (snapshot.scrollbackAnsi ?? '') + '\x1b[?1049h\x1b[2J\x1b[H' : '';
      this.writeSuppressed(new TextEncoder().encode(clear + normal + (snapshot.snapshotAnsi ?? '') +
        (snapshot.rehydrateSequences ?? '') + (snapshot.pendingEscapeTailAnsi ?? '')));
    } else {
      if (replacing) this.writeSuppressed(clear);
      if (result.replay) {
        const bytes = decode(result.replay);
        this.oscTracker.feed(this.decoder.decode(bytes, { stream: true }));
        if (replacing) this.writeSuppressed(bytes);
        else this.terminal.write(bytes);
      }
    }
  }

  private clearPending() {
    this.pending = [];
    this.pendingSize = 0;
    this.pendingExit = null;
    this.pendingRestore = null;
  }

  private releaseStream() {
    for (const dispose of this.streamCleanup.splice(0)) dispose();
    this.clearPending();
  }

  private write(event: { data: string; sequence?: number }) {
    if (event.sequence !== undefined) {
      if (event.sequence <= this.sequence) return;
      this.sequence = event.sequence;
    }
    const bytes = decode(event.data);
    this.oscTracker.feed(this.decoder.decode(bytes, { stream: true }));
    this.terminal.write(bytes);
  }

  private scheduleFit() {
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => this.fitVisible());
  }

  private fitVisible() {
    if (!this.host?.isConnected || !this.host.clientWidth || !this.host.clientHeight) return;
    this.fit.fit();
    const size = `${this.terminal.cols}:${this.terminal.rows}`;
    if (this.ptyId && this.state.phase === 'running' && size !== this.lastSize) {
      this.transport.resize(this.ptyId, this.terminal.rows, this.terminal.cols);
      this.lastSize = size;
    }
    this.terminal.refresh(0, this.terminal.rows - 1);
  }

  setFontSize(value: number) {
    this.terminal.options.fontSize = value;
    this.scheduleFit();
  }

  setTheme(theme: ITheme, minimumContrastRatio?: number) {
    const prevLight = isLightThemeBackground(this.terminal.options.theme);
    this.terminal.options.theme = theme;
    if (minimumContrastRatio !== undefined) {
      this.terminal.options.minimumContrastRatio = minimumContrastRatio;
    }
    const nextLight = isLightThemeBackground(theme);
    if (this.colorSchemeReporting && prevLight !== nextLight) {
      this.emitProtocolReply(colorSchemeReport(theme));
    }
  }

  close() {
    if (this.closePromise) return this.closePromise;
    if (this.destroyed) return Promise.resolve();
    this.closeRequested = true;
    this.terminal.options.disableStdin = true;
    this.clearPending();
    this.setState({ phase: 'closing', error: null });
    this.closePromise = (async () => {
      // Wait for a pending create so closing a just-opened tab cannot orphan it.
      await this.connection;
      if (this.ptyId) await this.transport.dispose(this.ptyId);
      this.destroyed = true;
      this.oscTracker.reset();
      this.releaseStream();
      this.observer.disconnect();
      cancelAnimationFrame(this.frame);
      for (const dispose of this.cleanup) dispose();
      this.terminal.dispose();
      this.element.remove();
    })().catch((error) => {
      this.closePromise = undefined;
      this.setState({ phase: 'error', error: `关闭失败：${String(error)}` });
      throw error;
    });
    return this.closePromise;
  }
}
