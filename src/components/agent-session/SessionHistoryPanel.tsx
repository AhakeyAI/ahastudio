import { memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Archive, ArchiveRestore, History, X } from 'lucide-react';
import { agentSessionClient } from '../../lib/agent-session-client';
import { folderName } from '../../lib/session-title';
import { stageWindowStore } from '../../lib/stage-window-store';
import { formatThreadTime, groupThreadsByDay, mergeThreadPages } from '../../lib/session-history';
import type { CodexThreadSummary } from '../../types';
import '../agent-session-view.css';

type Tab = 'all' | 'archived';

const SEARCH_DELAY_MS = 250;

const HistoryRow = memo(function HistoryRow({
  thread, now, selected, open, archived, busy, onSelect, onOpen, onArchive,
}: {
  thread: CodexThreadSummary; now: number; selected: boolean; open: boolean; archived: boolean; busy: boolean;
  onSelect: (id: string) => void; onOpen: (thread: CodexThreadSummary) => void; onArchive: (thread: CodexThreadSummary) => void;
}) {
  return (
    <li className={`asv-history-row${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="asv-history-main"
        aria-expanded={selected}
        title={thread.preview || thread.title}
        onClick={() => onSelect(thread.id)}
        onDoubleClick={() => onOpen(thread)}
      >
        <span className="asv-history-line">
          <span className="asv-history-title">{thread.title}</span>
          {open && <span className="asv-history-badge">已打开</span>}
          <time className="asv-history-time" dateTime={new Date(thread.updatedAt).toISOString()}>
            {formatThreadTime(thread.updatedAt, now)}
          </time>
        </span>
        {thread.preview && thread.preview !== thread.title && <span className="asv-history-preview">{thread.preview}</span>}
      </button>
      {selected && (
        <div className="asv-history-actions">
          <button type="button" className="asv-btn is-primary" disabled={busy} onClick={() => onOpen(thread)}>
            {open ? '切换到标签' : '在新标签打开'}
          </button>
          <button
            type="button"
            className="asv-btn"
            disabled={busy || open}
            title={open ? '先关闭这个会话的标签再归档' : archived ? '移回会话历史' : '从历史中收起，Codex 记录仍保留'}
            onClick={() => onArchive(thread)}
          >
            {archived ? <><ArchiveRestore size={12} /> 取消归档</> : <><Archive size={12} /> 归档</>}
          </button>
        </div>
      )}
    </li>
  );
});

/**
 * Past Codex conversations in one folder. Opening one only reads its record; Codex resumes it
 * when the first message is sent from the new tab.
 */
export function SessionHistoryPanel({ cwd, onClose, onOpened, onNotify, className }: {
  cwd: string;
  onClose: () => void;
  /** The session is open in a tab now (or already was). */
  onOpened?: () => void;
  onNotify?: (message: string) => void;
  className?: string;
}) {
  const api = typeof window !== 'undefined' ? window.vibeMeet?.agentSessions : undefined;
  const sessions = useSyncExternalStore(agentSessionClient.subscribe, agentSessionClient.getSnapshot);
  const openThreads = useMemo(
    () => new Set(sessions.flatMap((session) => (session.providerSessionId ? [session.providerSessionId] : []))),
    [sessions],
  );
  const [tab, setTab] = useState<Tab>('all');
  const [query, setQuery] = useState('');
  const [search, setSearch] = useState('');
  const [threads, setThreads] = useState<CodexThreadSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const request = useRef(0);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => setSearch(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const load = useCallback(async (more: string | null) => {
    if (!api?.history) {
      setLoading(false);
      setError('当前环境无法读取 Codex 会话历史');
      return;
    }
    const ticket = ++request.current;
    setLoading(true);
    setError(null);
    const res = await api.history({
      cwd, archived: tab === 'archived', ...(search ? { search } : {}), ...(more ? { cursor: more } : {}),
    }).catch((reason: unknown) => ({ ok: false as const, error: reason instanceof Error ? reason.message : String(reason) }));
    if (ticket !== request.current) return;
    setLoading(false);
    setNow(Date.now());
    if (!res.ok) {
      setError(res.error);
      return;
    }
    setThreads((current) => (more ? mergeThreadPages(current, res.threads) : res.threads));
    setCursor(res.nextCursor);
  }, [api, cwd, tab, search]);

  useEffect(() => {
    setThreads([]);
    setCursor(null);
    setSelected(null);
    void load(null);
  }, [load]);

  useEffect(() => searchRef.current?.focus(), []);

  const open = useCallback(async (thread: CodexThreadSummary) => {
    if (!api?.openHistory) return;
    setBusy(thread.id);
    const res = await agentSessionClient.openHistory(thread.id);
    setBusy(null);
    if (!res.ok) {
      onNotify?.(res.error);
      return;
    }
    // Switches to the session's tab when it is already open.
    await stageWindowStore.createWindow('agent-session', {
      workerId: res.session.id, cwd: res.session.cwd, localCliId: 'codex', title: res.session.title || 'Codex 会话',
    });
    onOpened?.();
  }, [api, onNotify, onOpened]);

  const archive = useCallback(async (thread: CodexThreadSummary) => {
    if (!api?.archiveHistory) return;
    setBusy(thread.id);
    const archived = tab !== 'archived';
    const res = await api.archiveHistory({ threadId: thread.id, archived })
      .catch((reason: unknown) => ({ ok: false as const, error: reason instanceof Error ? reason.message : String(reason) }));
    setBusy(null);
    if (!res.ok) {
      onNotify?.(res.error);
      return;
    }
    setThreads((current) => current.filter((entry) => entry.id !== thread.id));
    onNotify?.(archived ? `已归档「${thread.title}」` : `已取消归档「${thread.title}」`);
  }, [api, tab, onNotify]);

  const select = useCallback((id: string) => setSelected((current) => (current === id ? null : id)), []);
  const groups = useMemo(() => groupThreadsByDay(threads, now), [threads, now]);

  return (
    <aside
      className={`asv-history${className ? ` ${className}` : ''}`}
      aria-label="会话历史"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="asv-history-head">
        <History size={14} aria-hidden="true" />
        <strong>会话历史</strong>
        <span className="asv-history-scope" title={cwd}>{folderName(cwd)} · 本机 Codex 记录</span>
        <span className="asv-spacer" />
        <button type="button" className="asv-act" aria-label="关闭会话历史" title="关闭 (Esc)" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
      <input
        ref={searchRef}
        className="asv-history-search"
        type="search"
        placeholder="搜索标题和内容…"
        aria-label="搜索会话历史"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
      />
      <div className="asv-history-tabs" role="tablist">
        {(['all', 'archived'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            className={`asv-history-tab${tab === value ? ' is-active' : ''}`}
            onClick={() => setTab(value)}
          >
            {value === 'all' ? '全部' : '已归档'}
          </button>
        ))}
      </div>
      <div className="asv-history-list">
        {groups.map((group) => (
          <section key={group.label} className="asv-history-group">
            <h3>{group.label}</h3>
            <ul>
              {group.threads.map((thread) => (
                <HistoryRow
                  key={thread.id}
                  thread={thread}
                  now={now}
                  selected={selected === thread.id}
                  open={openThreads.has(thread.id)}
                  archived={tab === 'archived'}
                  busy={busy === thread.id}
                  onSelect={select}
                  onOpen={open}
                  onArchive={archive}
                />
              ))}
            </ul>
          </section>
        ))}
        {loading && <div className="asv-history-hint" role="status"><span className="asv-shimmer">正在读取…</span></div>}
        {error && (
          <div className="asv-history-hint" role="alert">
            {error}
            <button type="button" className="asv-text-btn" onClick={() => void load(null)}>重试</button>
          </div>
        )}
        {!loading && !error && !threads.length && (
          <div className="asv-history-hint">
            {search ? '没有匹配的会话' : tab === 'archived' ? '没有归档的会话' : '这个文件夹还没有 Codex 会话记录'}
          </div>
        )}
        {!loading && !error && cursor && (
          <button type="button" className="asv-btn asv-history-more" onClick={() => void load(cursor)}>加载更多</button>
        )}
      </div>
      <p className="asv-history-foot">关闭标签不会删除这里的记录。打开时只读取记录，发出第一条消息后才恢复会话。</p>
    </aside>
  );
}
