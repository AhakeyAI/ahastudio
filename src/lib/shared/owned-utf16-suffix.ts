// Ported/adapted from Orca (https://github.com/stablyai/orca).
// Copyright (c) 2026 Lovecast Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

const COPY_BLOCK_CODE_UNITS = 4 * 1024

export function copyUtf16SuffixToOwnedString(value: string, suffixCodeUnits: number): string {
  const suffixLength = Math.max(0, Math.min(value.length, suffixCodeUnits))
  const start = value.length - suffixLength
  const blocks: string[] = []
  const codeUnits: number[] = []
  codeUnits.length = Math.min(COPY_BLOCK_CODE_UNITS, suffixLength)

  // Why: slice can retain an arbitrarily large V8 backing string.
  for (let offset = start; offset < value.length; offset += COPY_BLOCK_CODE_UNITS) {
    const blockLength = Math.min(COPY_BLOCK_CODE_UNITS, value.length - offset)
    codeUnits.length = blockLength
    for (let index = 0; index < blockLength; index += 1) {
      codeUnits[index] = value.charCodeAt(offset + index)
    }
    blocks.push(String.fromCharCode(...codeUnits))
  }
  return blocks.join('')
}
