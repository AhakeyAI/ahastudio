import type { ISearchOptions } from '@xterm/addon-search';

export const TERMINAL_SEARCH_MAX_QUERY_LENGTH = 500;

export function buildTerminalSearchDecorations(
  isDark: boolean,
): NonNullable<ISearchOptions['decorations']> {
  if (isDark) {
    return {
      matchBackground: '#614a18',
      matchBorder: '#8c6b21',
      matchOverviewRuler: '#c4962b',
      activeMatchBackground: '#9a6b17',
      activeMatchBorder: '#f0b84b',
      activeMatchColorOverviewRuler: '#f0b84b',
    };
  }
  return {
    matchBackground: '#fde68a',
    matchBorder: '#d97706',
    matchOverviewRuler: '#d97706',
    activeMatchBackground: '#fb923c',
    activeMatchBorder: '#c2410c',
    activeMatchColorOverviewRuler: '#ea580c',
  };
}

export function buildTerminalSearchOptions(
  opts: {
    caseSensitive: boolean;
    regex: boolean;
    incremental?: boolean;
    isDark: boolean;
  },
): ISearchOptions {
  return {
    caseSensitive: opts.caseSensitive,
    regex: opts.regex,
    incremental: opts.incremental ?? false,
    decorations: buildTerminalSearchDecorations(opts.isDark),
  };
}

export function extractTerminalSearchSeed(selection: string): string {
  const trimmed = selection.trim();
  if (!trimmed || trimmed.includes('\n') || trimmed.includes('\r')) return '';
  return trimmed.length <= TERMINAL_SEARCH_MAX_QUERY_LENGTH ? trimmed : '';
}

export function isMacSearchPlatform(): boolean {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);
}

export function getTerminalSearchShortcutLabel(isMac = isMacSearchPlatform()): string {
  return isMac ? 'Cmd+F' : 'Ctrl+Shift+F';
}

export interface SearchShortcutKeyLike {
  key: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/**
 * Windows/Linux bind terminal search to `Ctrl+Shift+F` so plain `Ctrl+F` keeps reaching
 * readline/vim/less intact; macOS uses `Cmd+F`.
 */
export function isTerminalSearchShortcut(
  event: SearchShortcutKeyLike,
  isMac = isMacSearchPlatform(),
): boolean {
  if (event.altKey || event.key.toLowerCase() !== 'f') return false;
  if (isMac) {
    return event.metaKey && !event.ctrlKey && !event.shiftKey;
  }
  return event.ctrlKey && event.shiftKey && !event.metaKey;
}

export function shouldConfirmPaneClose(state?: { commandRunning?: boolean; phase?: string }): boolean {
  return Boolean(state?.commandRunning && state.phase !== 'exited');
}
