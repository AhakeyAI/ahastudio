// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

export function encodePowerShellCommand(command: string): string {
  // Sandboxed renderers lack Buffer; use browser-safe globals for PowerShell’s required UTF-16LE encoding.
  let bytes = ''
  for (let index = 0; index < command.length; index += 1) {
    const code = command.charCodeAt(index)
    bytes += String.fromCharCode(code & 0xff, code >>> 8)
  }
  return btoa(bytes)
}
