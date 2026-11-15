import { Terminal } from '@xterm/xterm';
import type { ITheme, ITerminalAddon, ILinkProvider, IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import '@xterm/xterm/css/xterm.css';
import type { TerminalScreenSnapshot } from '../types';
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
  private sequence = 0;
  private lastSize = '';
  private cleanup: Array<() => void> = [];
  private streamCleanup: Array<() => void> = [];
  private connection?: Promise<void>;
  private closePromise?: Promise<void>;
  private state = INITIAL_TERMINAL_STATE;
  private decoder = new TextDecoder('utf-8', { fatal: false });
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
      this.sequence = result.sequence ?? 0;
      this.connected = true;
      const snapshot = result.screenSnapshot;
      if (snapshot?.cwd) {
        this.oscTracker.seedCwd(snapshot.cwd);
      }
      this.setState({
        phase: result.exited || this.pendingExit ? 'exited' : 'running',
        exitCode: this.pendingExit?.exitCode ?? result.exitCode,
        ...(snapshot?.lastTitle ? { title: snapshot.lastTitle } : {}),
        ...(snapshot?.cwd ? { cwd: snapshot.cwd } : {}),
      });
      if (snapshot && (snapshot.snapshotAnsi || snapshot.scrollbackAnsi)) {
        const chunks: string[] = ['\x18'];
        if (snapshot.modes?.alternateScreen) {
          chunks.push('\x1b[?1049l\x1b[2J\x1b[H');
          if (snapshot.scrollbackAnsi) chunks.push(snapshot.scrollbackAnsi);
          chunks.push('\x1b[?1049h\x1b[2J\x1b[H');
        } else {
          chunks.push('\x1b[?1049l\x1b[2J\x1b[H');
        }
        if (snapshot.snapshotAnsi) chunks.push(snapshot.snapshotAnsi);
        if (snapshot.rehydrateSequences) chunks.push(snapshot.rehydrateSequences);
        if (snapshot.pendingEscapeTailAnsi) chunks.push(snapshot.pendingEscapeTailAnsi);
        this.terminal.write(new TextEncoder().encode(chunks.join('')));
      } else if (result.replay) {
        const bytes = decode(result.replay);
        this.oscTracker.feed(this.decoder.decode(bytes, { stream: true }));
        this.terminal.write(bytes);
      }
      for (const event of this.pending) this.write(event);
      this.clearPending();
      this.fitVisible();
    } catch (error) {
      this.releaseStream();
      if (!this.closeRequested) this.setState({ phase: 'error', error: String(error) });
    }
  }

  private clearPending() {
    this.pending = [];
    this.pendingSize = 0;
    this.pendingExit = null;
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
    this.terminal.options.theme = theme;
    if (minimumContrastRatio !== undefined) {
      this.terminal.options.minimumContrastRatio = minimumContrastRatio;
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
