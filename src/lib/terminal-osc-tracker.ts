import { ownRetainedString } from './shared/own-retained-string';
import { createOsc133CommandFinishedScanner } from './shared/terminal/output/terminal-osc133-command-finished';

const OSC_7_PREFIX = '\x1b]7;';
const MAX_OSC_CARRY_LENGTH = 4096;

export interface OscTrackerState {
  cwd?: string;
  commandRunning: boolean;
  lastExitCode: number | null;
  lastDurationMs: number | null;
}

export interface OscTrackerOptions {
  isWindows?: boolean;
  now?: () => number;
  onUpdate?: (state: OscTrackerState) => void;
}

function detectWindowsHost(): boolean {
  if (typeof navigator !== 'undefined' && /win/i.test(navigator.platform || navigator.userAgent)) {
    return true;
  }
  const proc = (globalThis as { process?: { platform?: string } }).process;
  if (proc?.platform === 'win32') {
    return true;
  }
  return false;
}

export function parseOsc7FileUri(rawUri: string, isWindows = detectWindowsHost()): string | null {
  const trimmed = rawUri.trim();
  if (!trimmed) return null;

  let pathname: string | null = null;
  if (trimmed.startsWith('file://')) {
    const rest = trimmed.slice('file://'.length);
    const slashIndex = rest.indexOf('/');
    if (slashIndex === -1) return null;
    const authority = rest.slice(0, slashIndex).toLowerCase();
    // Accept file:///path and file://localhost/path; allow non-empty single-host names too.
    if (authority && authority !== 'localhost' && authority.includes(':')) {
      return null;
    }
    pathname = rest.slice(slashIndex);
  } else if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) {
    pathname = trimmed;
  }

  if (!pathname) return null;
  let decoded = pathname;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    // Keep raw pathname if percent-encoding is malformed.
  }

  if (isWindows) {
    const driveMatch = /^\/?([a-zA-Z]):(?:[\\/](.*))?$/.exec(decoded);
    if (driveMatch) {
      const tail = (driveMatch[2] ?? '').replaceAll('/', '\\').replace(/\\+$/, '');
      const candidate = `${driveMatch[1]!.toUpperCase()}:\\${tail}`;
      return /^(?:[\\/]{2}|[\\/]\?\?)/.test(candidate) ? null : candidate;
    }
    const msysMatch = /^\/([a-zA-Z])(?:\/(.*))?$/.exec(decoded);
    if (msysMatch) {
      const tail = (msysMatch[2] ?? '').replaceAll('/', '\\').replace(/\\+$/, '');
      const candidate = `${msysMatch[1]!.toUpperCase()}:\\${tail}`;
      return /^(?:[\\/]{2}|[\\/]\?\?)/.test(candidate) ? null : candidate;
    }
  }

  if (/^(?:[\\/]{2}|[\\/]\?\?)/.test(decoded)) {
    return null;
  }
  if (decoded.length > 1) {
    return decoded.replace(/\/+$/, '');
  }
  return decoded;
}

function findOscTerminator(data: string, startIndex: number): { index: number; length: number } | null {
  const bel = data.indexOf('\x07', startIndex);
  const st = data.indexOf('\x1b\\', startIndex);
  if (bel === -1 && st === -1) return null;
  if (bel !== -1 && (st === -1 || bel < st)) return { index: bel, length: 1 };
  return { index: st, length: 2 };
}

function findPrefixCarry(data: string, prefix: string): string {
  const maxLen = Math.min(data.length, prefix.length - 1);
  for (let len = maxLen; len > 0; len -= 1) {
    const suffix = data.slice(data.length - len);
    if (prefix.startsWith(suffix)) return suffix;
  }
  return '';
}

export interface TerminalOscTracker {
  feed: (chunk: string) => void;
  seedCwd: (cwd: string | null | undefined) => void;
  getState: () => OscTrackerState;
  reset: () => void;
}

export function createTerminalOscTracker(options: OscTrackerOptions = {}): TerminalOscTracker {
  const isWindows = options.isWindows ?? detectWindowsHost();
  const now = options.now ?? (() => Date.now());
  let state: OscTrackerState = {
    commandRunning: false,
    lastExitCode: null,
    lastDurationMs: null,
  };
  let commandStartedAt: number | null = null;
  let osc7Carry = '';

  const emitUpdate = (next: Partial<OscTrackerState>): void => {
    const merged: OscTrackerState = { ...state, ...next };
    if (
      merged.cwd === state.cwd &&
      merged.commandRunning === state.commandRunning &&
      merged.lastExitCode === state.lastExitCode &&
      merged.lastDurationMs === state.lastDurationMs
    ) {
      return;
    }
    state = merged;
    options.onUpdate?.(state);
  };

  const osc133Scanner = createOsc133CommandFinishedScanner(
    (bestEffortExitCode) => {
      const durationMs =
        commandStartedAt !== null ? Math.max(0, now() - commandStartedAt) : null;
      commandStartedAt = null;
      emitUpdate({
        commandRunning: false,
        lastExitCode: bestEffortExitCode,
        lastDurationMs: durationMs,
      });
    },
    () => {
      commandStartedAt = now();
      emitUpdate({ commandRunning: true });
    },
  );

  const scanOsc7 = (data: string): void => {
    let combined = osc7Carry + data;
    osc7Carry = '';
    while (combined.length > 0) {
      const start = combined.indexOf(OSC_7_PREFIX);
      if (start === -1) {
        osc7Carry = findPrefixCarry(combined, OSC_7_PREFIX);
        break;
      }
      const payloadStart = start + OSC_7_PREFIX.length;
      const terminator = findOscTerminator(combined, payloadStart);
      if (!terminator) {
        osc7Carry = combined.slice(start);
        if (osc7Carry.length > MAX_OSC_CARRY_LENGTH) {
          osc7Carry = osc7Carry.slice(osc7Carry.length - MAX_OSC_CARRY_LENGTH);
        }
        osc7Carry = ownRetainedString(osc7Carry);
        break;
      }
      const parsedCwd = parseOsc7FileUri(combined.slice(payloadStart, terminator.index), isWindows);
      if (parsedCwd) {
        emitUpdate({ cwd: parsedCwd });
      }
      combined = combined.slice(terminator.index + terminator.length);
    }
  };

  return {
    feed(chunk: string) {
      if (!chunk) return;
      scanOsc7(chunk);
      osc133Scanner.scan(chunk);
    },
    seedCwd(cwd: string | null | undefined) {
      if (cwd && cwd.trim()) {
        emitUpdate({ cwd: cwd.trim() });
      }
    },
    getState: () => state,
    reset() {
      osc7Carry = '';
      commandStartedAt = null;
      osc133Scanner.reset();
    },
  };
}
