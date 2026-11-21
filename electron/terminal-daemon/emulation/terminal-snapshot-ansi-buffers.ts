// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

import type { TerminalModes } from '../protocol/terminal-modes.js'
import { splitAtAlternateScreenEntry } from '../../shared/terminal/protocol/escape/terminal-alternate-screen-split.js'

export function splitTerminalSnapshotAnsi(
  snapshotAnsi: string,
  modes: TerminalModes
): { snapshotAnsi: string; scrollbackAnsi: string } {
  const split = modes.alternateScreen ? splitAtAlternateScreenEntry(snapshotAnsi) : null
  if (!split) {
    return { snapshotAnsi, scrollbackAnsi: '' }
  }
  // Keep normal-buffer replay separate; rehydrateSequences owns the alternate-screen transition.
  return { scrollbackAnsi: split.normalAnsi, snapshotAnsi: split.alternateAnsi }
}
