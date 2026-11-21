// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

export type TerminalOwner = 'shell'

export function parseTerminalOwner(value: unknown): TerminalOwner | undefined {
  return value === 'shell' ? value : undefined
}
