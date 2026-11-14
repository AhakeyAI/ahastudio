// Local tabs borrow a persistent TerminalSession; only explicit tab close
// ends it. Legacy drawer shells use usePtyTerminal and end on unmount.
// Distinct from RealTerminal (worker PTY, attach mode).

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { SearchAddon } from '@xterm/addon-search';
import { usePtyTerminal } from '../hooks/usePtyTerminal';
import { stageWindowStore } from '../lib/stage-window-store';
import { registerTerminalLinks } from '../lib/terminal-links/register-terminal-links';
import { isTerminalSearchShortcut } from '../lib/terminal-search-options';
import type { TerminalSession } from '../lib/terminal-session';
import { terminalSessionStore } from '../lib/terminal-session-store';
import { TerminalSearch } from './TerminalSearch';

export interface ShellTerminalProps {
  cwd?: string;
  cliId?: string;
  shellId?: string;
  /** A tab/pane owns its process until explicitly closed, including across mounts. */
  terminalId?: string;
  isActivePane?: boolean;
  searchOpen?: boolean;
  onOpenSearch?: () => void;
  onCloseSearch?: () => void;
  onFocusPane?: () => void;
  onNotify?: (message: string) => void;
  onCwdChange?: (cwd: string) => void;
}

export function ShellTerminal(props: ShellTerminalProps) {
  if (props.terminalId) {
    return <PersistentShellTerminal {...props} terminalId={props.terminalId} />;
  }
  return <LegacyShellTerminal cwd={props.cwd} cliId={props.cliId} terminalId={props.terminalId} />;
}

function isWorkspaceChord(event: KeyboardEvent): boolean {
  if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey) return false;
  return ['d', 'e', 'w', '[', ']', '{', '}', 'pageup', 'pagedown'].includes(event.key.toLowerCase());
}

function PersistentShellTerminal({
  cwd,
  cliId,
  shellId,
  terminalId,
  isActivePane = true,
  searchOpen = false,
  onOpenSearch,
  onCloseSearch,
  onFocusPane,
  onNotify,
  onCwdChange,
}: ShellTerminalProps & { terminalId: string }) {
  const container = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<TerminalSession | null>(null);
  const [searchAddon, setSearchAddon] = useState<SearchAddon | null>(null);

  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const activePaneRef = useRef(isActivePane);
  activePaneRef.current = isActivePane;
  const onOpenSearchRef = useRef(onOpenSearch);
  onOpenSearchRef.current = onOpenSearch;
  const onNotifyRef = useRef(onNotify);
  onNotifyRef.current = onNotify;
  const onCwdChangeRef = useRef(onCwdChange);
  onCwdChangeRef.current = onCwdChange;

  useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getSnapshot);
  const state = terminalSessionStore.getState(terminalId);
  const appearance = terminalSessionStore.getAppearance();
  const isDark = appearance === 'dark';

  useEffect(() => {
    const host = container.current!;
    const api = window.vibeMeet.shellPty;
    const session = terminalSessionStore.acquire(terminalId, {
      expectedPtyId: `local-${terminalId}`,
      attach: async (size) => {
        const result = await api.create({ cwd: cwdRef.current, cliId, shellId, terminalId, ...size });
        return result.ok ? result : { ok: false, error: result.error ?? '无法启动终端' };
      },
      input: async (id, data) => {
        const result = await api.input(id, data);
        if (!result.ok) throw new Error(result.error ?? '输入失败');
      },
      resize: (id, rows, cols) => { void api.resize(id, rows, cols); },
      onData: api.onData,
      onExit: api.onExit,
      dispose: async (id) => {
        const result = await api.kill(id);
        if (!result.ok) throw new Error(result.error ?? '关闭失败');
      },
    });
    sessionRef.current = session;

    const addon = new SearchAddon({ highlightLimit: 1000 });
    const disposeAddon = session.attachAddon(addon);
    setSearchAddon(addon);

    const disposeLinks = registerTerminalLinks(session, {
      getCwd: () => session.getSnapshot().cwd ?? cwdRef.current,
      onNotify: (msg) => onNotifyRef.current?.(msg),
    });

    session.terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      if (isTerminalSearchShortcut(event)) {
        event.preventDefault();
        onOpenSearchRef.current?.();
        return false;
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'c') {
        const sel = session.getSelection();
        if (sel) {
          void navigator.clipboard?.writeText(sel).then(() => {
            onNotifyRef.current?.('已复制选中内容');
          }).catch(() => {});
          return false;
        }
      }
      if (isWorkspaceChord(event)) {
        return false;
      }
      return true;
    });

    session.mount(host, { focus: activePaneRef.current });

    return () => {
      session.terminal.attachCustomKeyEventHandler(() => true);
      disposeLinks();
      disposeAddon();
      setSearchAddon(null);
      sessionRef.current = null;
      session.unmount(host);
    };
  }, [terminalId, cliId, shellId]);

  useEffect(() => {
    if (isActivePane && sessionRef.current) {
      sessionRef.current.terminal.options.cursorBlink = true;
      if (!searchOpen) {
        sessionRef.current.focus();
      }
    } else if (!isActivePane && sessionRef.current) {
      sessionRef.current.terminal.options.cursorBlink = false;
    }
  }, [isActivePane, searchOpen]);

  useEffect(() => {
    if (state.cwd) {
      onCwdChangeRef.current?.(state.cwd);
    }
  }, [state.cwd]);

  const getSelection = useCallback(() => sessionRef.current?.getSelection() ?? '', []);
  const handleCloseSearch = useCallback(() => {
    onCloseSearch?.();
    sessionRef.current?.focus();
  }, [onCloseSearch]);

  return (
    <div
      className="shell-terminal"
      onMouseDownCapture={() => onFocusPane?.()}
      style={{ height: '100%', display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}
    >
      <TerminalSearch
        isOpen={Boolean(searchOpen && isActivePane)}
        searchAddon={searchAddon}
        getSelection={getSelection}
        isDark={isDark}
        onClose={handleCloseSearch}
      />
      {state.error && <div className="shell-terminal-error" role="alert">{state.error}</div>}
      {state.phase === 'exited' && <div className="shell-terminal-exited" role="status">进程已退出（{state.exitCode ?? '未知'}）</div>}
      <div ref={container} className="shell-terminal-canvas" style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}

function LegacyShellTerminal({ cwd, cliId, terminalId }: ShellTerminalProps) {
  const attach = useCallback(async () => {
    const r = await window.vibeMeet.shellPty.create({ cwd, cliId, terminalId, cols: 100, rows: 30 });
    if (r.ok) return r;
    return { ok: false as const, error: r.error ?? '无法启动终端' };
  }, [cwd, cliId, terminalId]);
  const input = useCallback((ptyId: string, data: string) => {
    void window.vibeMeet.shellPty.input(ptyId, data);
  }, []);
  const resize = useCallback((ptyId: string, rows: number, cols: number) => {
    void window.vibeMeet.shellPty.resize(ptyId, rows, cols);
  }, []);
  const onData = useCallback(
    (cb: (e: { ptyId: string; data: string }) => void) =>
      window.vibeMeet.shellPty.onData(cb),
    [],
  );
  const onExit = useCallback(
    (cb: (e: { ptyId: string; exitCode: number | null }) => void) =>
      window.vibeMeet.shellPty.onExit(cb),
    [],
  );
  const dispose = useCallback((ptyId: string) => {
    if (!terminalId || !stageWindowStore.getSnapshot().windows.some((win) => win.id === terminalId)) {
      void window.vibeMeet.shellPty.kill(ptyId);
    }
  }, [terminalId]);

  const { containerRef, exited, error } = usePtyTerminal({
    attach,
    input,
    resize,
    onData,
    onExit,
    dispose,
  });

  return (
    <div
      className="shell-terminal"
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      {error && <div className="shell-terminal-error">{error}</div>}
      <div
        ref={containerRef}
        style={{ flex: 1, minHeight: 120, opacity: exited ? 0.7 : 1 }}
      />
    </div>
  );
}
