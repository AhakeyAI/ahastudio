// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

// Import before @xterm/headless: ELECTRON_RUN_AS_NODE lacks the window global its environment check expects.
if (globalThis.window === undefined) {
  ;(globalThis as Record<string, unknown>).window = globalThis
}
