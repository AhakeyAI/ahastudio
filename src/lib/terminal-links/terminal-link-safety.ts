import {
  classifyTerminalOscLinkTarget,
  type TerminalOscLinkTarget,
} from '../orca-shared/terminal/links/terminal-osc-link-target';

const UNC_OR_DEVICE_PREFIX_RE = /^(?:[\\/]{2}|[\\/]\?\?(?:[\\/]|$))/;
const WINDOWS_RESERVED_DEVICE_RE = /^(CON|PRN|AUX|NUL|COM\d|LPT\d)(\.|$)/i;

function defaultIsWinHost(): boolean {
  if (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) {
    return /win/i.test(navigator.platform || navigator.userAgent);
  }
  const proc = (globalThis as { process?: { platform?: string } }).process;
  return proc?.platform === 'win32';
}

/**
 * Rejects UNC shares, Windows device namespaces (`\\.\`, `\\?\`, `\??\`), and non-localhost `file://` URLs
 * before any hover `stat` or click handler can trigger an SMB/network connection.
 */
export function isUnsafeTerminalLinkTarget(rawTarget: string, isWinHost = defaultIsWinHost()): boolean {
  const trimmed = rawTarget.trim();
  if (!trimmed) return true;
  if (UNC_OR_DEVICE_PREFIX_RE.test(trimmed)) return true;

  if (/^file:/i.test(trimmed)) {
    if (!/^file:\/\//i.test(trimmed)) return true;
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return true;
    }
    const host = parsed.hostname.toLowerCase();
    if (host && host !== 'localhost') return true;
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(parsed.pathname);
    } catch {
      return true;
    }
    return UNC_OR_DEVICE_PREFIX_RE.test(decodedPath);
  }

  if (isWinHost) {
    const base = trimmed.split(/[\\/]/).pop()?.split(':')[0] ?? '';
    if (WINDOWS_RESERVED_DEVICE_RE.test(base)) return true;
  }
  return false;
}

export function isSafeTerminalLinkCandidate(
  pathText: string,
  cwd?: string,
  isWinHost = defaultIsWinHost(),
): boolean {
  if (isUnsafeTerminalLinkTarget(pathText, isWinHost)) return false;
  if (cwd && cwd.trim() && isUnsafeTerminalLinkTarget(cwd, isWinHost)) return false;
  return true;
}

export function resolveSafeOscLinkTarget(
  rawText: string,
  cwd?: string,
  isWinHost = defaultIsWinHost(),
): TerminalOscLinkTarget | null {
  if (/^file:/i.test(rawText.trim()) && isUnsafeTerminalLinkTarget(rawText, isWinHost)) {
    return null;
  }
  const target = classifyTerminalOscLinkTarget(rawText, {
    windowsPathsFirst: Boolean(cwd && /^[a-zA-Z]:[\\/]/.test(cwd)) || isWinHost,
    allowUncHost: false,
  });
  if (!target) return null;
  if (target.kind === 'url') return target;
  const candidatePath = target.kind === 'file-url' ? target.target.filePath : target.link.pathText;
  if (!isSafeTerminalLinkCandidate(candidatePath, cwd, isWinHost)) {
    return null;
  }
  return target;
}
