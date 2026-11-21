// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import type { TerminalOscLinkRange } from '../../shared/terminal/links/terminal-osc-link-ranges.js'
import type { TerminalModes } from './terminal-modes.js'
import type { TerminalOwner } from '../../shared/terminal/pty/lifecycle/terminal-owner.js'

export type TerminalSnapshot = {
  snapshotAnsi: string
  /** Parser tail is already counted by the snapshot sequence and must restore last. */
  pendingEscapeTailAnsi?: string
  /** Normal buffer captured separately while snapshotAnsi holds an alternate buffer. */
  scrollbackAnsi: string
  oscLinks?: TerminalOscLinkRange[]
  rehydrateSequences: string
  /** Live modes and cursor state that can be restored without the alt frame. */
  frameRestoreAnsi?: string
  cwd: string | null
  modes: TerminalModes
  cols: number
  rows: number
  scrollbackLines: number
  lastTitle?: string
  /** Optional because persisted snapshots and older v19 daemons lack it. */
  outputSequence?: number
  /** Ordered shell lifecycle evidence captured at this snapshot boundary. */
  terminalOwner?: TerminalOwner
}
