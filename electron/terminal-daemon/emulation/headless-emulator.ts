import './xterm-env-polyfill.js'
import xtermHeadless, { type ITerminalOptions, type Terminal as HeadlessTerminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
const { Terminal } = xtermHeadless
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal/appearance/terminal-unicode-provider.js'
import {
  readSavedCursorRegister,
  serializeWithAbsoluteCursor
} from '../../shared/terminal/replay/terminal-serialize-absolute-cursor.js'
import { advancePartialEscapeTail } from '../../shared/terminal/protocol/escape/terminal-partial-escape-tail.js'
import { resizeLikeOwnPty } from './conpty-reflow-viewport.js'
import { DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT } from '../../shared/terminal/replay/terminal-scrollback-policy.js'
import { collectHeadlessOscLinkRanges } from './headless-osc-link-ranges.js'
import { readTerminalModes, trackModifyOtherKeys } from './headless-emulator-modes.js'
import { buildRehydrateSequences } from './terminal-mode-rehydrate-sequences.js'
import { TerminalOscCwdTitleScanner } from './terminal-osc-cwd-title-scanner.js'
import { buildFrameRestoreSnapshotFields } from './terminal-frame-restore-sequences.js'
import { splitTerminalSnapshotAnsi } from './terminal-snapshot-ansi-buffers.js'
import type { TerminalSnapshot } from '../protocol/terminal-snapshot.js'
import type { TerminalModes } from '../protocol/terminal-modes.js'
import type { TerminalOscLinkRange } from '../../shared/terminal/links/terminal-osc-link-ranges.js'

/** windowsPty: ConPTY repaints its own grid after a resize, so growing rows must not pull scrollback. */
export type HeadlessEmulatorOptions = Pick<ITerminalOptions, 'windowsPty'> & {
  cols: number
  rows: number
  scrollback?: number
}

type TerminalWithSynchronousWrite = HeadlessTerminal & {
  _core?: {
    writeSync?: (data: string) => void
  }
}

/** Screen-state mirror of a PTY. It never answers terminal queries: replies would race the renderer into shell input. */
export class HeadlessEmulator {
  protected terminal: HeadlessTerminal
  protected serializer: SerializeAddon
  private oscText: TerminalOscCwdTitleScanner
  private restoredOscLinks: TerminalOscLinkRange[] = []
  private disposed = false
  // serialize() omits parser state, so preserve an incomplete escape for the next live chunk.
  private partialEscapeTail = ''

  constructor(opts: HeadlessEmulatorOptions) {
    this.oscText = new TerminalOscCwdTitleScanner({})
    this.terminal = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? DESKTOP_TERMINAL_SCROLLBACK_ROWS_DEFAULT,
      allowProposedApi: true,
      logLevel: 'off',
      windowsPty: opts.windowsPty ?? {}
    })

    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)
    trackModifyOtherKeys(this.terminal)

    // Match renderer cell widths to prevent shifted snapshot rows.
    this.terminal.loadAddon(new Unicode11Addon())
    activateOrcaTerminalUnicodeProvider(this.terminal)
  }

  write(data: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }
    if (this.tryWriteSync(data)) {
      return Promise.resolve()
    }
    this.oscText.scan(data)
    return new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
        resolve()
      })
    })
  }

  /** Apply bytes before snapshotting; return false if the private sync API is unavailable. */
  private writeSync(data: string): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryWriteSync(data)
  }

  private tryWriteSync(data: string): boolean {
    const writeSync = (this.terminal as TerminalWithSynchronousWrite)._core?.writeSync
    if (typeof writeSync !== 'function') {
      return false
    }
    this.oscText.scan(data)
    // Queued PTY writes could leave a snapshot with half-cleared TUI rows.
    writeSync.call((this.terminal as TerminalWithSynchronousWrite)._core, data)
    this.partialEscapeTail = advancePartialEscapeTail(this.partialEscapeTail, data)
    return true
  }

  resize(cols: number, rows: number): void {
    // Preserve row-indexed restored links on same-size resizes; only real resizes invalidate them.
    if (this.disposed || (this.terminal.cols === cols && this.terminal.rows === rows)) {
      return
    }
    this.restoredOscLinks = []
    const writeSync = this.partialEscapeTail ? null : (data: string) => void this.writeSync(data)
    resizeLikeOwnPty(this.terminal, cols, rows, writeSync)
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot {
    const modes = this.getModes()
    // Absolute cursor restore avoids wrap-pending drift; carry the saved register for DECRC.
    const serializedAnsi = serializeWithAbsoluteCursor(
      this.serializer,
      this.terminal,
      { scrollback: opts.scrollbackRows },
      readSavedCursorRegister(this.terminal)
    )
    const { snapshotAnsi, scrollbackAnsi } = splitTerminalSnapshotAnsi(serializedAnsi, modes)
    const snapshot: TerminalSnapshot = {
      snapshotAnsi,
      scrollbackAnsi,
      oscLinks: collectHeadlessOscLinkRanges(
        this.terminal,
        opts.scrollbackRows,
        this.restoredOscLinks
      ),
      rehydrateSequences: buildRehydrateSequences(modes),
      ...buildFrameRestoreSnapshotFields(this.serializer, this.terminal, modes),
      cwd: this.oscText.cwd,
      modes,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      scrollbackLines: this.terminal.buffer.normal.length - this.terminal.rows,
      lastTitle: this.oscText.lastTitle ?? undefined,
      // Restore this last so the next live chunk completes the incomplete escape.
      ...(this.partialEscapeTail.length > 0
        ? { pendingEscapeTailAnsi: this.partialEscapeTail }
        : {})
    }
    return snapshot
  }

  dispose(): void {
    this.disposed = true
    this.terminal.dispose()
  }

  private getModes(): TerminalModes {
    return readTerminalModes(this.terminal)
  }
}
