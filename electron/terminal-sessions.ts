import { type PtyHost, type PtySpawnOptions } from './pty-host.js';
import { PtyInputLimiter } from './pty-input-limiter.js';
import { clampTerminalDim } from './terminal-size.js';
import { HeadlessEmulator } from './terminal-daemon/emulation/headless-emulator.js';
import type { TerminalSnapshot } from './terminal-daemon/protocol/terminal-snapshot.js';

export interface TerminalRecord {
  terminalId: string;
  pid: number;
  startedAt: string;
  cwd: string;
  label: string;
  cols: number;
  rows: number;
  sequence: number;
  exited: boolean;
  exitCode?: number | null;
  terminationError?: string;
}
export interface TerminalData { ptyId: string; data: string; sequence: number }
export interface TerminalExit { ptyId: string; exitCode: number | null }
interface Session {
  record: TerminalRecord;
  replay?: string;
  emulator?: HeadlessEmulator;
  exitScreenSnapshot?: TerminalSnapshot;
  limiter: PtyInputLimiter;
  unsubscribeData: () => void;
  unsubscribeExit: () => void;
}

// A daemon frame above 1 MiB destroys the socket, so a snapshot must leave headroom
// for the rest of the attach response.
export const MAX_SCREEN_SNAPSHOT_BYTES = 768 * 1024;

/** Keeps the visible screen and trims oldest scrollback until the snapshot fits the transport budget. */
export function boundedScreenSnapshot(emulator: HeadlessEmulator): TerminalSnapshot {
  let snapshot = emulator.getSnapshot();
  let bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  let rows = snapshot.scrollbackLines;
  for (let attempt = 0; bytes > MAX_SCREEN_SNAPSHOT_BYTES && rows > 0; attempt++) {
    rows = attempt >= 4 ? 0 : Math.floor(rows * (MAX_SCREEN_SNAPSHOT_BYTES / bytes) * 0.85);
    snapshot = emulator.getSnapshot({ scrollbackRows: rows });
    bytes = Buffer.byteLength(JSON.stringify(snapshot), 'utf8');
  }
  return snapshot;
}

/** Pure process owner shared by the existing main path and the isolated daemon.
 * Launch configuration (CLI discovery, app settings) belongs to the caller. */
export class TerminalSessions {
  private sessions = new Map<string, Session>();

  constructor(private host: PtyHost, private events: {
    data: (event: TerminalData) => void; exit: (event: TerminalExit) => void;
  }) {}

  create(ptyId: string, options: PtySpawnOptions, label = '', retainExit = true) {
    const existing = this.sessions.get(ptyId);
    if (existing) return this.snapshot(ptyId, existing);
    const pid = this.host.spawn(ptyId, options);
    const cols = clampTerminalDim(options.cols, 100);
    const rows = clampTerminalDim(options.rows, 30);
    const emulator = new HeadlessEmulator({
      cols,
      rows,
      windowsPty: process.platform === 'win32' ? { backend: 'conpty' } : undefined,
    });
    const session: Session = {
      record: { terminalId: ptyId, pid, startedAt: new Date().toISOString(),
        cwd: options.cwd, label, cols, rows,
        sequence: 0, exited: false },
      emulator,
      limiter: new PtyInputLimiter(), unsubscribeData: () => {}, unsubscribeExit: () => {},
    };
    this.sessions.set(ptyId, session);
    session.unsubscribeData = this.host.onData(ptyId, (data) => {
      void session.emulator?.write(data);
      this.events.data({ ptyId, data: Buffer.from(data, 'utf8').toString('base64'), sequence: ++session.record.sequence });
    });
    session.unsubscribeExit = this.host.onExit(ptyId, (exitCode) => {
      session.replay = this.host.replayBuffer(ptyId)?.toString('base64') ?? '';
      try {
        session.exitScreenSnapshot = session.emulator && boundedScreenSnapshot(session.emulator);
      } catch {
        /* ignore emulator snapshot failure on exit */
      }
      session.emulator?.dispose();
      session.emulator = undefined;
      session.record.exited = true;
      session.record.exitCode = exitCode;
      session.unsubscribeData();
      session.unsubscribeExit();
      if (!retainExit) this.sessions.delete(ptyId);
      this.events.exit({ ptyId, exitCode });
    });
    return this.snapshot(ptyId, session);
  }

  get(id: string) { const session = this.sessions.get(id); return session && this.snapshot(id, session); }
  async ready(ptyId: string) {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error('Unknown terminal');
    session.record.pid = await this.host.readyPid(ptyId);
    return this.snapshot(ptyId, session);
  }
  list(): TerminalRecord[] { return [...this.sessions.values()].map(s => ({ ...s.record })); }

  forgetExited(ptyId: string): boolean {
    const session = this.sessions.get(ptyId);
    if (!session?.record.exited || session.record.terminationError) return false;
    return this.sessions.delete(ptyId);
  }

  private snapshot(ptyId: string, session: Session) {
    let screenSnapshot = session.exitScreenSnapshot;
    if (!screenSnapshot && session.emulator) {
      try {
        screenSnapshot = boundedScreenSnapshot(session.emulator);
      } catch {
        /* ignore snapshot failure */
      }
    }
    // The renderer replays a non-empty snapshot in preference to the raw tail, so sending both only doubles the frame.
    const replay = screenSnapshot && (screenSnapshot.snapshotAnsi || screenSnapshot.scrollbackAnsi)
      ? ''
      : session.replay ?? this.host.replayBuffer(ptyId)?.toString('base64') ?? '';
    return {
      ok: true as const,
      ptyId,
      ...session.record,
      replay,
      ...(screenSnapshot ? { screenSnapshot } : {}),
    };
  }

  input(ptyId: string, data: string) {
    const session = this.sessions.get(ptyId);
    if (!session || session.record.exited) return { ok: false, error: '终端进程已结束' };
    if (!session.limiter.allow(Buffer.byteLength(data, 'utf8'))) {
      return { ok: false, error: 'PTY input rate/size limit exceeded', dropped: true };
    }
    return { ok: this.host.write(ptyId, data) };
  }

  resize(ptyId: string, rows: number, cols: number) {
    const session = this.sessions.get(ptyId);
    const ok = !!session && this.host.resize(ptyId, rows, cols);
    if (ok) {
      session.record.rows = clampTerminalDim(rows, 1);
      session.record.cols = clampTerminalDim(cols, 1);
      session.emulator?.resize(session.record.cols, session.record.rows);
    }
    return { ok };
  }

  close(ptyId: string) {
    const session = this.sessions.get(ptyId);
    if (!session) return { ok: true };
    this.host.kill(ptyId, { strict: true });
    session.unsubscribeData(); session.unsubscribeExit();
    session.emulator?.dispose();
    session.emulator = undefined;
    this.sessions.delete(ptyId);
    return { ok: true };
  }

  /** Daemon stop keeps its exit record and waits for the native exit event. */
  async terminate(ptyId: string) {
    const session = this.sessions.get(ptyId);
    if (!session) throw new Error('Unknown terminal');
    if (session.record.terminationError) throw new Error(`Tree cleanup not confirmed: ${session.record.terminationError}`);
    if (!session.record.exited) {
      try { await this.host.terminateTree(ptyId); }
      catch (error) {
        // Root exit alone cannot certify a partially failed taskkill /T.
        session.record.terminationError = error instanceof Error ? error.message : 'Tree termination failed';
        throw error;
      }
    }
    if (!session.record.exited) throw new Error('PTY exit not confirmed');
    return this.snapshot(ptyId, session);
  }

  closeAll() { for (const id of this.sessions.keys()) this.close(id); }
}
