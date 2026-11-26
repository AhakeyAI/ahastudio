import { TerminalSession, INITIAL_TERMINAL_STATE, type PtyTerminalHandle } from './terminal-session';
import {
  resolveInitialAppearancePreference,
  resolveTerminalAppearance,
  TERMINAL_APPEARANCE_STORAGE_KEY,
  TERMINAL_MIN_CONTRAST_RATIO,
  TERMINAL_THEMES,
  type TerminalAppearance,
  type TerminalAppearancePreference,
} from './terminal-appearance';

const sessions = new Map<string, TerminalSession>();
const listeners = new Set<() => void>();
let revision = 0;
const savedFont = Number(localStorage.getItem('aha.terminal.fontSize'));
let fontSize = savedFont >= 10 && savedFont <= 24 ? savedFont : 14;
let appearancePreference: TerminalAppearancePreference = resolveInitialAppearancePreference();
let appearance: TerminalAppearance = resolveTerminalAppearance(appearancePreference);

function notify() {
  revision++;
  for (const listener of listeners) listener();
}

function syncSessionsTheme() {
  const theme = TERMINAL_THEMES[appearance];
  const minContrast = TERMINAL_MIN_CONTRAST_RATIO[appearance];
  for (const session of sessions.values()) session.setTheme(theme, minContrast);
}

function applyResolvedAppearance(next: TerminalAppearance) {
  if (next === appearance) return;
  appearance = next;
  syncSessionsTheme();
  notify();
}

function syncElectronThemeSource(pref: TerminalAppearancePreference) {
  if (typeof window === 'undefined') return;
  const setThemeSource = (
    window as {
      vibeMeet?: {
        setThemeSource?: (
          source: TerminalAppearancePreference,
        ) => Promise<{ shouldUseDarkColors: boolean }>;
      };
    }
  ).vibeMeet?.setThemeSource;
  if (!setThemeSource) return;
  void setThemeSource(pref)
    .then((res) => {
      if (appearancePreference === 'system' && res && typeof res.shouldUseDarkColors === 'boolean') {
        applyResolvedAppearance(res.shouldUseDarkColors ? 'dark' : 'light');
      }
    })
    .catch(() => {
      /* ignore IPC unavailable in browser-only mode */
    });
}

const colorSchemeMedia =
  typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia('(prefers-color-scheme: dark)')
    : null;
colorSchemeMedia?.addEventListener?.('change', (event) => {
  if (appearancePreference !== 'system') return;
  applyResolvedAppearance(event.matches ? 'dark' : 'light');
});
// Native theme events also reach background windows whose media-query change
// notification may be delayed. Keep matchMedia as the browser-only fallback.
if (typeof window !== 'undefined') {
  window.vibeMeet?.onThemeChanged?.(({ shouldUseDarkColors }) => {
    if (appearancePreference === 'system') {
      applyResolvedAppearance(shouldUseDarkColors ? 'dark' : 'light');
    }
  });
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== TERMINAL_APPEARANCE_STORAGE_KEY) return;
    const nextPref = resolveInitialAppearancePreference();
    const nextAppearance = resolveTerminalAppearance(nextPref);
    if (nextPref === appearancePreference && nextAppearance === appearance) return;
    appearancePreference = nextPref;
    if (nextAppearance !== appearance) {
      appearance = nextAppearance;
      syncSessionsTheme();
    }
    notify();
    if (nextPref === 'system') syncElectronThemeSource(nextPref);
  });
}

syncElectronThemeSource(appearancePreference);

export const terminalSessionStore = {
  subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  getSnapshot: () => revision,
  getState: (id: string) => sessions.get(id)?.getSnapshot() ?? INITIAL_TERMINAL_STATE,
  getFontSize: () => fontSize,
  getAppearance: () => appearance,
  getAppearancePreference: () => appearancePreference,
  setAppearance(value: TerminalAppearancePreference) {
    appearancePreference = value;
    try {
      localStorage.setItem(TERMINAL_APPEARANCE_STORAGE_KEY, value);
    } catch {
      /* ignore storage errors */
    }
    const next = resolveTerminalAppearance(value);
    if (next !== appearance) {
      appearance = next;
      syncSessionsTheme();
    }
    notify();
    syncElectronThemeSource(value);
  },
  acquire(id: string, transport: PtyTerminalHandle) {
    let session = sessions.get(id);
    if (!session) {
      session = new TerminalSession(
        transport,
        fontSize,
        notify,
        TERMINAL_THEMES[appearance],
        TERMINAL_MIN_CONTRAST_RATIO[appearance],
      );
      sessions.set(id, session);
    }
    return session;
  },
  async close(id: string) {
    const session = sessions.get(id);
    if (session) {
      await session.close();
      sessions.delete(id);
      notify();
    }
  },
  setFontSize(value: number) {
    fontSize = Math.max(10, Math.min(24, value));
    localStorage.setItem('aha.terminal.fontSize', String(fontSize));
    for (const session of sessions.values()) session.setFontSize(fontSize);
    notify();
  },
};
