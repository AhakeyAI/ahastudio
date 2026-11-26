import { useState, useRef, useEffect } from 'react';
import { Globe, Plus, History } from 'lucide-react';
import { agentSessionClient } from '../lib/agent-session-client';
import { DRIVER_LABELS } from '../lib/session-capabilities';
import { requestHideBrowser } from '../lib/browser-store';
import type { AgentDriverId, LocalCliInfo } from '../types';
import type { StageWindowType, StageWindowOptions } from '../lib/stage-window-store';
import { TerminalProfileIcon } from './TerminalProfileIcon';

interface SessionCreateMenuProps {
  onCreate: (type: StageWindowType, opts?: StageWindowOptions) => void;
  localOnly?: boolean;
  onOpenHistory?: () => void;
  label?: string;
}
const SESSION_DRIVERS: readonly AgentDriverId[] = ['codex', 'antigravity', 'grok', 'opencode', 'pi'];

export function SessionCreateMenu({ onCreate, localOnly = false, onOpenHistory, label = '新建窗口' }: SessionCreateMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [clis, setClis] = useState<LocalCliInfo[]>([]);
  const [shells, setShells] = useState<LocalCliInfo[]>([]);
  const [defaultCwd, setDefaultCwd] = useState<string>();
  const [query, setQuery] = useState('');
  const [menuPosition, setMenuPosition] = useState({ left: 0, top: 0 });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const position = () => {
      const rect = menuRef.current?.getBoundingClientRect();
      if (!rect) return;
      // A project may be near the bottom of a scrolling, narrow sidebar.
      setMenuPosition({
        left: Math.max(8, Math.min(rect.left, window.innerWidth - 328)),
        top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - Math.min(520, window.innerHeight * 0.65) - 12)),
      });
    };
    position();
    window.addEventListener('resize', position);
    window.addEventListener('scroll', position, true);
    return () => {
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    setClis([]);
    setShells([]);
    void Promise.all([window.vibeMeet.shellPty.listClis(), window.vibeMeet.shellPty.listShells()]).then(([cliResult, shellResult]) => {
      if (cancelled) return;
      if (cliResult.ok) setClis(cliResult.clis);
      if (shellResult.ok) { setShells(shellResult.shells); setDefaultCwd(shellResult.defaultCwd); }
      const errors = [!cliResult.ok && cliResult.error, !shellResult.ok && shellResult.error].filter(Boolean);
      if (errors.length) setError(errors.join('；'));
    }).catch((err) => { if (!cancelled) setError(String(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [menuOpen]);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && e.target instanceof Node && !menuRef.current.contains(e.target)) {
        setMenuOpen(false);
      }
    };
    const handleKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { setMenuOpen(false); menuRef.current?.querySelector('button')?.focus(); } };
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [menuOpen]);

  // Hide browser WebContentsView when the "+" dropdown opens, because the
  // native OS view paints ON TOP of all renderer HTML (z-index is irrelevant).
  useEffect(() => {
    if (!menuOpen) return;
    return requestHideBrowser();
  }, [menuOpen]);

  const handleCreate = (type: StageWindowType, opts?: StageWindowOptions) => {
    onCreate(type, { cwd: defaultCwd, ...opts });
    setMenuOpen(false);
  };
  const matches = (entry: LocalCliInfo) => `${entry.label} ${entry.command} ${entry.id}`.toLowerCase().includes(query.trim().toLowerCase());
  const filteredShells = shells.filter(matches);
  const filteredClis = clis.filter(matches);
  // Desktop sessions run the same installed CLIs natively; the driver ids are the CLI ids.
  const sessionQuery = query.trim().toLowerCase();
  const sessionDrivers = SESSION_DRIVERS.filter((driver) =>
    clis.some((cli) => cli.id === driver) &&
    `${DRIVER_LABELS[driver]} ${driver} 会话 session 历史 history`.toLowerCase().includes(sessionQuery));

  return (
      <div className="stage-tab-add" ref={menuRef}>
        <button
          type="button"
          className="stage-tab-add-btn"
          onClick={(event) => { event.stopPropagation(); setQuery(''); setMenuOpen((v) => !v); }}
          aria-label={label}
          title={label}
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <Plus size={16} />
        </button>
        {menuOpen && (
          <div className="stage-tab-menu" role="menu" aria-label="新建终端或标签页"
            style={localOnly ? { position: 'fixed', left: menuPosition.left, top: menuPosition.top, right: 'auto', maxHeight: `calc(100vh - ${menuPosition.top + 12}px)` } : undefined}
            onKeyDown={event => {
              const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                event.preventDefault();
                items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
              } else if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
                event.preventDefault(); items[0]?.click();
              }
            }}>
            <input autoFocus className="stage-tab-search" aria-label="搜索终端" placeholder="搜索 CLI 或 Shell…"
              value={query} onChange={(event) => setQuery(event.target.value)} />
            {!localOnly && '新建浏览器 browser'.includes(query.toLowerCase()) && (
              <button
                type="button"
                role="menuitem"
                className="stage-tab-menu-item"
                onClick={() => handleCreate('browser')}
              >
                <Globe size={14} />
                <span>新建浏览器</span>
              </button>
            )}
            {agentSessionClient.available() && sessionDrivers.length > 0 && (
              <>
                <div className="stage-tab-menu-section">桌面会话</div>
                {sessionDrivers.map((driver) => (
                  <button type="button" role="menuitem" className="stage-tab-menu-item" key={`session:${driver}`}
                    title={`不经终端，直接与 ${DRIVER_LABELS[driver]} 对话`}
                    onClick={() => handleCreate('agent-session', { localCliId: driver, title: `${DRIVER_LABELS[driver]} 会话` })}>
                    <TerminalProfileIcon id={driver} /><span>{DRIVER_LABELS[driver]} 会话</span>
                  </button>
                ))}
                {onOpenHistory && sessionDrivers.includes('codex') && 'codex 历史 history'.includes(query.trim().toLowerCase()) && (
                  <button type="button" role="menuitem" className="stage-tab-menu-item"
                    title="打开这个文件夹里以前的 Codex 会话"
                    onClick={() => { setMenuOpen(false); onOpenHistory(); }}>
                    <History size={14} /><span>从历史打开…</span>
                  </button>
                )}
              </>
            )}
            <div className="stage-tab-menu-section">本地 Shell</div>
            {filteredShells.map((shell) => (
              <button type="button" role="menuitem" className="stage-tab-menu-item" key={shell.id}
                title={shell.binaryPath}
                onClick={() => handleCreate('terminal', { localCliId: 'shell', shellId: shell.id, title: shell.label })}>
                <TerminalProfileIcon id={shell.id} /><span>{shell.label}</span>
              </button>
            ))}
            <div className="stage-tab-menu-section">本地 Agent CLI</div>
            {loading && <div className="stage-tab-menu-hint" role="status">正在检测本机终端…</div>}
            {error && <div className="stage-tab-menu-hint" role="alert">{error}</div>}
            {!loading && !error && !filteredClis.length && <div className="stage-tab-menu-hint">
              {query ? '没有匹配的 CLI' : '未检测到已安装的 CLI。安装后重新打开此菜单。'}
            </div>}
            {!loading && query && !filteredShells.length && <div className="stage-tab-menu-hint">没有匹配的 Shell</div>}
            {filteredClis.map((cli) => (
              <button type="button" role="menuitem" className="stage-tab-menu-item" key={cli.id}
                title={`${cli.binaryPath}\n使用本机登录和配置`}
                onClick={() => handleCreate('terminal', { localCliId: cli.id, title: cli.label })}>
                <TerminalProfileIcon id={cli.id} />
                <span>{cli.label}</span>
                <small>{cli.command}</small>
              </button>
            ))}
          </div>
        )}
      </div>
  );
}
