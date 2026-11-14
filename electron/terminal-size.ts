export const MAX_TERMINAL_DIMENSION = 500;

/** Keeps a PTY dimension inside the range node-pty and the daemon protocol both accept. */
export function clampTerminalDim(value: number | undefined, fallback: number): number {
  return Math.min(MAX_TERMINAL_DIMENSION, Math.max(1, Math.floor(value ?? fallback) || 1));
}
