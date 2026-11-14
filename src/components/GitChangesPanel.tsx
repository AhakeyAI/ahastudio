import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  FileText,
  GitBranch,
  LoaderCircle,
  Minus,
  Plus,
  Search,
  Undo2,
} from 'lucide-react';
import {
  chunkPaths,
  GIT_CHANGE_GROUP_LABELS,
  GIT_CHANGE_GROUP_ORDER,
  gitStatusLetterLabel,
  gitStatusTone,
  groupGitStatusEntries,
  splitRepoPath,
  validateBranchName,
  type GitChangeGroupId,
  type GitChangeItem,
} from '../lib/git-panel-model';
import type { GitBranchInfo, GitStatusResult } from '../types';
import { previewKey, type PanelPreviewTarget } from './PanelPreview';

type ConfirmRequest = {
  message: string;
  confirmLabel: string;
  action: () => Promise<void>;
};

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export function GitChangesPanel({
  cwd,
  status,
  refresh,
  onNotify,
  selectedKey,
  onPreview,
  onOpenFile,
}: {
  cwd: string;
  status: GitStatusResult | null;
  refresh: () => Promise<void>;
  onNotify: (message: string) => void;
  selectedKey: string;
  onPreview: (target: PanelPreviewTarget) => void;
  onOpenFile: (relativePath: string) => void;
}) {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [collapsed, setCollapsed] = useState<Partial<Record<GitChangeGroupId, boolean>>>({});

  const entries = status?.ok ? status.entries : [];
  const groups = useMemo(() => groupGitStatusEntries(entries), [entries]);
  const stagedCount = groups.staged.length;
  const totalCount = entries.length;

  useEffect(() => {
    setError(null);
    setConfirm(null);
  }, [cwd]);

  const api = window.vibeMeet.git;

  const run = async (label: string, fn: () => Promise<{ ok: boolean; error?: string } | void>) => {
    if (busy) return false;
    setBusy(label);
    setError(null);
    let ok = true;
    try {
      const res = await fn();
      if (res && !res.ok) {
        ok = false;
        setError(res.error ?? `${label}失败`);
      }
    } catch (err) {
      ok = false;
      setError(errorText(err));
    } finally {
      setBusy(null);
      await refresh();
    }
    return ok;
  };

  const forChunks = async (
    paths: string[],
    call: (chunk: string[]) => Promise<{ ok: boolean; error?: string }>,
  ) => {
    for (const chunk of chunkPaths(paths)) {
      const res = await call(chunk);
      if (!res.ok) return res;
    }
    return { ok: true };
  };

  const stagePaths = (paths: string[]) =>
    api && run('暂存', () => forChunks(paths, (chunk) => api.stage({ cwd, paths: chunk })));
  const unstagePaths = (paths: string[]) =>
    api && run('取消暂存', () => forChunks(paths, (chunk) => api.unstage({ cwd, paths: chunk })));
  const discardPaths = (paths: string[], untracked: boolean) => {
    if (!api || !paths.length) return;
    const label = paths.length === 1 ? `“${splitRepoPath(paths[0]).name}”` : `${paths.length} 个文件`;
    setConfirm({
      message: untracked
        ? `将永久删除 ${label}（未跟踪），此操作无法撤销。`
        : `将丢弃 ${label} 在工作区中的更改，此操作无法撤销。`,
      confirmLabel: untracked ? '删除' : '丢弃更改',
      action: async () => {
        await run('丢弃更改', () => forChunks(paths, (chunk) => api.discard({ cwd, paths: chunk })));
      },
    });
  };

  const canCommit = Boolean(api) && !busy && message.trim().length > 0 && (stagedCount > 0 || amend);

  const commit = async () => {
    if (!api || !canCommit) return;
    const ok = await run('提交', async () => {
      const res = await api.commit({ cwd, message, amend: amend || undefined });
      if (res.ok) {
        onNotify(`已提交${res.commitHash ? ` ${res.commitHash.slice(0, 7)}` : ''}${res.branch ? ` 到 ${res.branch}` : ''}`);
      }
      return res;
    });
    if (ok) {
      setMessage('');
      setAmend(false);
    }
  };

  const handleMessageKey = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void commit();
    }
  };

  if (!status) {
    return (
      <div className="wrp-empty">
        <LoaderCircle size={18} className="wrp-spin" />
        <p>正在读取 Git 状态…</p>
      </div>
    );
  }
  if (!status.ok) {
    return (
      <div className="wrp-empty">
        <p className="wrp-error-text">{status.error}</p>
        <button type="button" className="wrp-btn" onClick={() => void refresh()}>
          重试
        </button>
      </div>
    );
  }
  if (!status.isGitRepo) {
    return (
      <div className="wrp-empty">
        <GitBranch size={22} />
        <p>当前目录不是 Git 仓库</p>
        <small>仍可在「文件」标签页中浏览和预览文件。</small>
      </div>
    );
  }

  const branchLabel = status.detached
    ? `分离 HEAD @ ${status.head?.slice(0, 7) ?? '?'}`
    : (status.branch ?? '(无分支)');

  const previewItem = (item: GitChangeItem) =>
    onPreview({
      kind: 'diff',
      cwd,
      path: item.entry.path,
      staged: item.group === 'staged',
      group: item.group,
    });

  const groupActions = (id: GitChangeGroupId, items: GitChangeItem[]) => {
    const paths = items.map((item) => item.entry.path);
    if (id === 'staged') {
      return (
        <IconButton label="全部取消暂存" onClick={() => void unstagePaths(paths)}>
          <Minus size={14} />
        </IconButton>
      );
    }
    if (id === 'conflicts') {
      return (
        <IconButton label="全部标记为已解决（暂存）" onClick={() => void stagePaths(paths)}>
          <Plus size={14} />
        </IconButton>
      );
    }
    return (
      <>
        <IconButton
          label={id === 'untracked' ? '删除全部未跟踪文件' : '放弃全部更改'}
          onClick={() => discardPaths(paths, id === 'untracked')}
        >
          <Undo2 size={14} />
        </IconButton>
        <IconButton label="全部暂存" onClick={() => void stagePaths(paths)}>
          <Plus size={14} />
        </IconButton>
      </>
    );
  };

  const rowActions = (item: GitChangeItem) => {
    const path = item.entry.path;
    const deleted = item.letter === 'D';
    return (
      <>
        {!deleted && (
          <IconButton label="打开文件" onClick={() => onOpenFile(path)}>
            <FileText size={13} />
          </IconButton>
        )}
        {(item.group === 'changes' || item.group === 'untracked') && (
          <IconButton
            label={item.group === 'untracked' ? '删除文件' : '放弃更改'}
            onClick={() => discardPaths([path], item.group === 'untracked')}
          >
            <Undo2 size={13} />
          </IconButton>
        )}
        {item.group === 'staged' ? (
          <IconButton label="取消暂存" onClick={() => void unstagePaths([path])}>
            <Minus size={13} />
          </IconButton>
        ) : (
          <IconButton label={item.group === 'conflicts' ? '标记为已解决' : '暂存更改'} onClick={() => void stagePaths([path])}>
            <Plus size={13} />
          </IconButton>
        )}
      </>
    );
  };

  return (
    <div className="wrp-changes">
      <div className="wrp-branch-bar">
        <BranchMenu cwd={cwd} label={branchLabel} disabled={Boolean(busy)} onCheckedOut={async (name) => {
          onNotify(`已切换到 ${name}`);
          await refresh();
        }} />
        {status.upstream && (
          <span className="wrp-sync" title={`上游 ${status.upstream}`}>
            {status.ahead > 0 && (
              <span>
                <ArrowUp size={11} />
                {status.ahead}
              </span>
            )}
            {status.behind > 0 && (
              <span>
                <ArrowDown size={11} />
                {status.behind}
              </span>
            )}
            {status.ahead === 0 && status.behind === 0 && <span>已同步</span>}
          </span>
        )}
      </div>

      <div className="wrp-commit">
        <textarea
          aria-label="提交信息"
          placeholder={`提交信息（Ctrl+Enter 提交到 ${status.branch ?? 'HEAD'}）`}
          value={message}
          rows={Math.min(6, Math.max(2, message.split('\n').length))}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleMessageKey}
        />
        <div className="wrp-commit-row">
          <label className="wrp-check">
            <input type="checkbox" checked={amend} onChange={(event) => setAmend(event.target.checked)} />
            修改上次提交
          </label>
          <button
            type="button"
            className="wrp-btn is-primary"
            disabled={!canCommit}
            onClick={() => void commit()}
            title={stagedCount === 0 && !amend ? '没有暂存的更改' : '提交 (Ctrl+Enter)'}
          >
            {busy === '提交' ? <LoaderCircle size={13} className="wrp-spin" /> : <Check size={13} />}
            提交{stagedCount > 0 ? ` (${stagedCount})` : ''}
          </button>
        </div>
      </div>

      {confirm && (
        <div className="wrp-confirm" role="alertdialog" aria-label="确认操作">
          <span>{confirm.message}</span>
          <div>
            <button type="button" className="wrp-btn" onClick={() => setConfirm(null)}>
              取消
            </button>
            <button
              type="button"
              className="wrp-btn is-danger"
              onClick={() => {
                const request = confirm;
                setConfirm(null);
                void request.action();
              }}
            >
              {confirm.confirmLabel}
            </button>
          </div>
        </div>
      )}
      {error && (
        <div className="wrp-inline-error" role="alert">
          <span>{error}</span>
          <button type="button" aria-label="关闭错误" onClick={() => setError(null)}>
            ×
          </button>
        </div>
      )}

      <div className="wrp-change-list">
        {totalCount === 0 && <p className="wrp-hint">工作区干净，没有需要提交的更改。</p>}
        {GIT_CHANGE_GROUP_ORDER.map((id) => {
          const items = groups[id];
          if (!items.length) return null;
          const isCollapsed = Boolean(collapsed[id]);
          return (
            <div className="wrp-group" key={id}>
              <div className="wrp-group-header">
                <button
                  type="button"
                  className="wrp-group-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() => setCollapsed((prev) => ({ ...prev, [id]: !isCollapsed }))}
                >
                  {isCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  <span>{GIT_CHANGE_GROUP_LABELS[id]}</span>
                </button>
                <span className="wrp-group-actions">{groupActions(id, items)}</span>
                <span className="wrp-count">{items.length}</span>
              </div>
              {!isCollapsed &&
                items.map((item) => {
                  const { name, dir } = splitRepoPath(item.entry.path);
                  const key = previewKey({
                    kind: 'diff',
                    cwd,
                    path: item.entry.path,
                    staged: item.group === 'staged',
                    group: item.group,
                  });
                  const tone = gitStatusTone(item.letter);
                  return (
                    <div
                      key={item.key}
                      className={`wrp-file-row ${selectedKey === key ? 'is-selected' : ''}`}
                      title={`${item.entry.origPath ? `${item.entry.origPath} → ` : ''}${item.entry.path} · ${gitStatusLetterLabel(item.letter)}`}
                    >
                      <button type="button" className="wrp-file-main" onClick={() => previewItem(item)}>
                        <span className={`wrp-file-name is-${tone}`}>{name}</span>
                        {dir && <small>{dir}</small>}
                      </button>
                      <span className="wrp-row-actions">{rowActions(item)}</span>
                      <span className={`wrp-letter is-${tone}`} aria-label={gitStatusLetterLabel(item.letter)}>
                        {item.letter}
                      </span>
                    </div>
                  );
                })}
            </div>
          );
        })}
      </div>
      {busy && busy !== '提交' && (
        <div className="wrp-busy">
          <LoaderCircle size={12} className="wrp-spin" /> {busy}中…
        </div>
      )}
    </div>
  );
}

export function IconButton({
  label,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`wrp-icon-btn ${className ?? ''}`}
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </button>
  );
}

function BranchMenu({
  cwd,
  label,
  disabled,
  onCheckedOut,
}: {
  cwd: string;
  label: string;
  disabled: boolean;
  onCheckedOut: (name: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [branches, setBranches] = useState<GitBranchInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const api = window.vibeMeet.git;

  useEffect(() => {
    if (!open || !api) return;
    let cancelled = false;
    setBranches(null);
    setError(null);
    api
      .branches({ cwd })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setBranches(res.branches);
        else setError(res.error);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, [open, cwd, api]);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer, true);
    return () => document.removeEventListener('pointerdown', onPointer, true);
  }, [open]);

  const q = query.trim();
  const filtered = (branches ?? []).filter((b) => b.name.toLowerCase().includes(q.toLowerCase()));
  const local = filtered.filter((b) => b.kind === 'local');
  const remote = filtered.filter((b) => b.kind === 'remote');
  const exists = (branches ?? []).some((b) => b.kind === 'local' && b.name === q);
  const createError = q ? validateBranchName(q) : null;

  const checkout = async (opts: { branch: string; create?: boolean; startPoint?: string }) => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.checkout({ cwd, ...opts });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setOpen(false);
      setQuery('');
      await onCheckedOut(opts.branch);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const checkoutRemote = (branch: GitBranchInfo) => {
    const slash = branch.name.indexOf('/');
    const localName = slash >= 0 ? branch.name.slice(slash + 1) : branch.name;
    const hasLocal = (branches ?? []).some((b) => b.kind === 'local' && b.name === localName);
    void checkout(hasLocal ? { branch: localName } : { branch: localName, create: true, startPoint: branch.name });
  };

  return (
    <div className="wrp-branch" ref={rootRef}>
      <button
        type="button"
        className="wrp-branch-trigger"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="切换分支"
        onClick={() => setOpen((value) => !value)}
      >
        <GitBranch size={13} />
        <span>{label}</span>
        <ChevronDown size={12} />
      </button>
      {open && (
        <div
          className="wrp-branch-menu"
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <label className="wrp-search">
            <Search size={13} />
            <input
              autoFocus
              aria-label="搜索或新建分支"
              placeholder="搜索或输入新分支名"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && q && !exists && !createError) {
                  event.preventDefault();
                  void checkout({ branch: q, create: true });
                }
              }}
            />
          </label>
          {error && <p className="wrp-error-text">{error}</p>}
          <div className="wrp-branch-list" role="listbox">
            {q && !exists && (
              <button
                type="button"
                className="wrp-branch-item is-create"
                disabled={Boolean(createError) || busy}
                title={createError ?? undefined}
                onClick={() => void checkout({ branch: q, create: true })}
              >
                <Plus size={13} />
                <span>新建分支 “{q}”</span>
                {createError && <small>{createError}</small>}
              </button>
            )}
            {!branches && !error && <p className="wrp-hint">加载分支…</p>}
            {local.length > 0 && <div className="wrp-branch-section">本地分支</div>}
            {local.map((b) => (
              <button
                type="button"
                key={b.refName}
                role="option"
                aria-selected={b.current}
                className={`wrp-branch-item ${b.current ? 'is-current' : ''}`}
                disabled={busy}
                onClick={() => (b.current ? setOpen(false) : void checkout({ branch: b.name }))}
              >
                {b.current ? <Check size={13} /> : <GitBranch size={13} />}
                <span>{b.name}</span>
                <small>{b.commit.slice(0, 7)}</small>
              </button>
            ))}
            {remote.length > 0 && <div className="wrp-branch-section">远程分支</div>}
            {remote.map((b) => (
              <button
                type="button"
                key={b.refName}
                role="option"
                aria-selected={false}
                className="wrp-branch-item"
                disabled={busy}
                onClick={() => checkoutRemote(b)}
              >
                <GitBranch size={13} />
                <span>{b.name}</span>
                <small>{b.commit.slice(0, 7)}</small>
              </button>
            ))}
            {branches && !filtered.length && !q && <p className="wrp-hint">没有分支</p>}
          </div>
        </div>
      )}
    </div>
  );
}
