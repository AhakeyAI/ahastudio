import type { ITheme } from '@xterm/xterm';

export type TerminalAppearance = 'light' | 'dark';
export type TerminalAppearancePreference = 'system' | TerminalAppearance;
export const TERMINAL_APPEARANCE_STORAGE_KEY = 'aha.terminal.appearance';

// Light backgrounds use 4.5 to rescue white-on-white ANSI text; dark uses 3 to keep near-background glyphs legible without washing saturated colors.
export const TERMINAL_MIN_CONTRAST_RATIO: Record<TerminalAppearance, number> = {
  light: 4.5,
  dark: 3,
};

function prefersSystemDark(): boolean {
  if (typeof window !== 'undefined' && typeof window.matchMedia === 'function') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  return false;
}

export function resolveInitialAppearancePreference(): TerminalAppearancePreference {
  try {
    const saved =
      typeof localStorage !== 'undefined'
        ? localStorage.getItem(TERMINAL_APPEARANCE_STORAGE_KEY)
        : null;
    if (saved === 'dark' || saved === 'light' || saved === 'system') return saved;
  } catch {
    /* ignore storage errors */
  }
  return 'system';
}

export function resolveTerminalAppearance(
  preference: TerminalAppearancePreference,
  systemDark = prefersSystemDark(),
): TerminalAppearance {
  if (preference === 'dark' || preference === 'light') return preference;
  return systemDark ? 'dark' : 'light';
}

export function resolveInitialTerminalAppearance(): TerminalAppearance {
  return resolveTerminalAppearance(resolveInitialAppearancePreference());
}

// Tango-based light palette, aligned with Orca's Builtin Tango Light.
// Source: Orca src/shared/terminal-themes/defaults.ts (MIT; see NOTICE below).
export const TERMINAL_THEMES: Record<TerminalAppearance, ITheme> = {
  light: {
    background: '#ffffff',
    foreground: '#2e3434',
    cursor: '#2e3434',
    cursorAccent: '#ffffff',
    selectionBackground: '#accef7',
    selectionInactiveBackground: '#d5e4f5',
    selectionForeground: '#2e3434',
    scrollbarSliderBackground: 'rgba(15, 23, 42, 0.22)',
    scrollbarSliderHoverBackground: 'rgba(15, 23, 42, 0.38)',
    scrollbarSliderActiveBackground: 'rgba(15, 23, 42, 0.52)',
    overviewRulerBorder: 'transparent',
    black: '#2e3436',
    red: '#b84a42',
    green: '#2f6f3f',
    yellow: '#8a6d1d',
    blue: '#3465a4',
    magenta: '#75507b',
    cyan: '#05727e',
    white: '#666666',
    brightBlack: '#585c62',
    brightRed: '#ca5b52',
    brightGreen: '#4a8054',
    brightYellow: '#a1842f',
    brightBlue: '#487ab5',
    brightMagenta: '#916b96',
    brightCyan: '#2b828a',
    brightWhite: '#3d3d3d',
  },
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#e4e4e4',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    selectionInactiveBackground: '#3a3d41',
    selectionForeground: '#ffffff',
    scrollbarSliderBackground: 'rgba(212, 212, 212, 0.22)',
    scrollbarSliderHoverBackground: 'rgba(212, 212, 212, 0.38)',
    scrollbarSliderActiveBackground: 'rgba(212, 212, 212, 0.52)',
    overviewRulerBorder: 'transparent',
    black: '#141619',
    red: '#e06c75',
    green: '#7ec67d',
    yellow: '#e5c07b',
    blue: '#6cb0f6',
    magenta: '#c68ee0',
    cyan: '#5ec2c8',
    white: '#d4d4d4',
    brightBlack: '#858b92',
    brightRed: '#f28b94',
    brightGreen: '#98db97',
    brightYellow: '#f2d59b',
    brightBlue: '#8dc4ff',
    brightMagenta: '#d9aef0',
    brightCyan: '#7fdde2',
    brightWhite: '#ffffff',
  },
};

/* NOTICE: MIT License — Copyright (c) 2026 Lovecast Inc.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.
THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE. */
