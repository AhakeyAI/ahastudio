import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FolderInput,
  FolderPlus,
  GitBranch,
  GitFork,
  LoaderCircle,
  Lock,
  Plus,
  RefreshCw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import {
  isPathInside,
  joinHostPath,
  sanitizeBranchForPath,
  suggestWorktreePath,
  validateBranchName,
} from '../lib/git-panel-model';
import type { GitBranchInfo, GitWorktreeEntry } from '../types';
import { IconButton } from './GitChangesPanel';

export interface WorktreeHostActions {
  openTerminal: (path: string) => void;
  selectProject: (path: string) => void;
  /** Terminal panes whose cwd is inside `path`. */
  countTerminalsIn: (path: string) => number;
  /** Close every terminal pane inside `path`; resolves once their PTYs are gone. */
  releaseTerminalsIn: (path: string) => Promise<number>;
  forgetProject: (path: string) => void;
  pickDirectory: (initial?: string) => Promise<string | null>;
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function GitWorktreesPanel({
  cwd,
  rootPath,
  currentPath,
  refreshSignal,
  onNotify,
  onChanged,
  actions,
}: {
  cwd: string;
  rootPath: string;
  /** Directory the workspace is focused on; used to mark the current worktree. */
  currentPath: string;
  refreshSignal: number;
  onNotify: (message: string) => void;
  onChanged: () => void;
  actions: WorktreeHostActions;
}) {
  const [worktrees, setWorktrees] = useState<GitWorktreeEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<GitWorktreeEntry | null>(null);
  const api = window.vibeMeet.git;

  const load = useCallback(async () => {
    if (!api) {
      setError('Git 接口不可用');
      return;
    }
    setLoading(true);
    try {
      const res = await api.listWorktrees({ cwd });
      if (res.ok) {
        setWorktrees(res.worktrees);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [api, cwd]);

  useEffect(() => {
    setWorktrees(null);
    setAdding(false);
    setRemoving(null);
  }, [cwd]);

  useEffect(() => {
    void load();
  }, [load, refreshSignal]);

  const mainWorktree = worktrees?.find((w) => w.isMainWorktree) ?? null;
  const currentWorktreePath = useMemo(() => {
    let best: string | null = null;
    for (const w of worktrees ?? []) {
      if (isPathInside(w.path, currentPath) && (!best || w.path.length > best.length)) best = w.path;
    }
    return best;
  }, [worktrees, currentPath]);

  const occupiedBranches = useMemo(
    () => new Set((worktrees ?? []).flatMap((w) => (w.branch ? [w.branch] : []))),
    [worktrees],
  );

  return (
    <div className="wrp-worktrees">
      <div className="wrp-subbar">
        <span className="wrp-subbar-title">工作树{worktrees ? ` (${worktrees.length})` : ''}</span>
        {loading && <LoaderCircle size={12} className="wrp-spin" />}
        <IconButton label="新建工作树" className={adding ? 'is-active' : ''} onClick={() => setAdding((v) => !v)}>
          <Plus size={14} />
        </IconButton>
        <IconButton label="刷新工作树" onClick={() => void load()}>
          <RefreshCw size={13} />
        </IconButton>
      </div>

      {adding && (
        <AddWorktreeForm
          cwd={cwd}
          rootPath={mainWorktree?.path ?? rootPath}
          occupiedBranches={occupiedBranches}
          pickDirectory={actions.pickDirectory}
          onCancel={() => setAdding(false)}
          onCreated={(path, openTerminal) => {
            setAdding(false);
            onNotify(`已创建工作树 ${folderName(path)}`);
            actions.selectProject(path);
            if (openTerminal) actions.openTerminal(path);
            void load();
            onChanged();
          }}
        />
      )}

      {removing && (
        <RemoveWorktreeConfirm
          key={removing.path}
          worktree={removing}
          cwd={mainWorktree?.path ?? cwd}
          terminalCount={actions.countTerminalsIn(removing.path)}
          releaseTerminals={actions.releaseTerminalsIn}
          onCancel={() => setRemoving(null)}
          onRemoved={(path) => {
            setRemoving(null);
            onNotify(`已删除工作树 ${folderName(path)}`);
            actions.forgetProject(path);
            if (currentWorktreePath && isPathInside(path, currentPath) && mainWorktree) {
              actions.selectProject(mainWorktree.path);
            }
            void load();
            onChanged();
          }}
        />
      )}

      {error && <p className="wrp-inline-error">{error}</p>}

      <div className="wrp-wt-list">
        {!worktrees && !error && (
          <p className="wrp-hint">
            <LoaderCircle size={12} className="wrp-spin" /> 加载中…
          </p>
        )}
        {worktrees?.map((w) => {
          const isCurrent = currentWorktreePath === w.path;
          return (
            <div key={w.path} className={`wrp-wt-item ${isCurrent ? 'is-current' : ''}`}>
              <div className="wrp-wt-head">
                <GitFork size={14} />
                <strong title={w.path}>{folderName(w.path)}</strong>
                {w.isMainWorktree && <span className="wrp-chip">主工作树</span>}
                {isCurrent && <span className="wrp-chip is-accent">当前</span>}
                {w.locked && (
                  <span className="wrp-chip is-warn" title={w.lockReason ?? '已锁定'}>
                    <Lock size={10} /> 锁定
                  </span>
                )}
                {w.prunable && (
                  <span className="wrp-chip is-warn" title={w.prunableReason ?? '目录已不存在'}>
                    可清理
                  </span>
                )}
              </div>
              <div className="wrp-wt-meta">
                <GitBranch size={12} />
                <span>{w.isBare ? '(bare)' : w.detached ? `分离 @ ${w.head.slice(0, 7)}` : (w.branch ?? '?')}</span>
                <small>{w.head.slice(0, 7)}</small>
              </div>
              <div className="wrp-wt-path" title={w.path}>
                {w.path}
              </div>
              <div className="wrp-wt-actions">
                <button type="button" className="wrp-btn" disabled={w.prunable} onClick={() => actions.openTerminal(w.path)}>
                  <Terminal size={12} /> 打开终端
                </button>
                <button
                  type="button"
                  className="wrp-btn"
                  disabled={w.prunable || isCurrent}
                  onClick={() => actions.selectProject(w.path)}
                  title="在左侧项目中选中此工作树"
                >
                  <FolderInput size={12} /> 切换到此
                </button>
                {!w.isMainWorktree && (
                  <IconButton label="删除工作树" className="is-danger" onClick={() => setRemoving(w)}>
                    <Trash2 size={13} />
                  </IconButton>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AddWorktreeForm({
  cwd,
  rootPath,
  occupiedBranches,
  pickDirectory,
  onCancel,
  onCreated,
}: {
  cwd: string;
  rootPath: string;
  occupiedBranches: Set<string>;
  pickDirectory: (initial?: string) => Promise<string | null>;
  onCancel: () => void;
  onCreated: (path: string, openTerminal: boolean) => void;
}) {
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [newBranch, setNewBranch] = useState('');
  const [existing, setExisting] = useState('');
  const [startPoint, setStartPoint] = useState('');
  const [path, setPath] = useState('');
  const [pathEdited, setPathEdited] = useState(false);
  const [openTerminal, setOpenTerminal] = useState(true);
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = window.vibeMeet.git;

  useEffect(() => {
    let cancelled = false;
    void api
      ?.branches({ cwd })
      .then((res) => {
        if (!cancelled && res.ok) setBranches(res.branches.filter((b) => b.kind === 'local'));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, cwd]);

  const available = branches.filter((b) => !occupiedBranches.has(b.name));
  const branchName = mode === 'new' ? newBranch.trim() : existing;

  useEffect(() => {
    if (!pathEdited) setPath(branchName ? suggestWorktreePath(rootPath, branchName) : '');
  }, [branchName, pathEdited, rootPath]);

  const branchError = mode === 'new' && newBranch.trim() ? validateBranchName(newBranch) : null;
  const canSubmit = !busy && Boolean(branchName) && !branchError && Boolean(path.trim());

  const browse = async () => {
    const parent = await pickDirectory(rootPath);
    if (!parent) return;
    setPathEdited(true);
    setPath(joinHostPath(parent, `${folderName(rootPath)}-${sanitizeBranchForPath(branchName) || 'worktree'}`));
  };

  const submit = async () => {
    if (!api || !canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const res = await api.addWorktree({
        cwd,
        worktreePath: path.trim(),
        ...(mode === 'new'
          ? { newBranch: newBranch.trim(), ...(startPoint.trim() ? { startPoint: startPoint.trim() } : {}) }
          : { branch: existing }),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      onCreated(res.path, openTerminal);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="wrp-wt-form"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <div className="wrp-wt-form-head">
        <strong>新建工作树</strong>
        <IconButton label="取消" onClick={onCancel}>
          <X size={13} />
        </IconButton>
      </div>
      <div className="wrp-segmented" role="radiogroup" aria-label="分支来源">
        <button type="button" role="radio" aria-checked={mode === 'new'} className={mode === 'new' ? 'is-on' : ''} onClick={() => setMode('new')}>
          新分支
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={mode === 'existing'}
          className={mode === 'existing' ? 'is-on' : ''}
          onClick={() => setMode('existing')}
        >
          已有分支
        </button>
      </div>
      {mode === 'new' ? (
        <>
          <label className="wrp-field">
            <span>分支名</span>
            <input autoFocus value={newBranch} placeholder="feature/my-task" onChange={(e) => setNewBranch(e.target.value)} />
          </label>
          {branchError && <small className="wrp-error-text">{branchError}</small>}
          <label className="wrp-field">
            <span>起点（可选）</span>
            <input value={startPoint} placeholder="默认为当前 HEAD" onChange={(e) => setStartPoint(e.target.value)} />
          </label>
        </>
      ) : (
        <label className="wrp-field">
          <span>分支</span>
          <select value={existing} onChange={(e) => setExisting(e.target.value)}>
            <option value="">{available.length ? '选择分支…' : '没有可用分支（均已被检出）'}</option>
            {available.map((b) => (
              <option key={b.refName} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="wrp-field">
        <span>目录</span>
        <span className="wrp-field-row">
          <input
            value={path}
            placeholder="工作树目录（必须不存在或为空）"
            onChange={(e) => {
              setPathEdited(true);
              setPath(e.target.value);
            }}
          />
          <IconButton label="选择父目录" onClick={() => void browse()}>
            <FolderPlus size={13} />
          </IconButton>
        </span>
      </label>
      <label className="wrp-check">
        <input type="checkbox" checked={openTerminal} onChange={(e) => setOpenTerminal(e.target.checked)} />
        创建后在新终端中打开
      </label>
      {error && <p className="wrp-inline-error">{error}</p>}
      <div className="wrp-form-actions">
        <button type="button" className="wrp-btn" onClick={onCancel}>
          取消
        </button>
        <button type="submit" className="wrp-btn is-primary" disabled={!canSubmit}>
          {busy ? <LoaderCircle size={12} className="wrp-spin" /> : <Plus size={12} />}
          创建
        </button>
      </div>
    </form>
  );
}

function RemoveWorktreeConfirm({
  worktree,
  cwd,
  terminalCount,
  releaseTerminals,
  onCancel,
  onRemoved,
}: {
  worktree: GitWorktreeEntry;
  cwd: string;
  terminalCount: number;
  releaseTerminals: (path: string) => Promise<number>;
  onCancel: () => void;
  onRemoved: (path: string) => void;
}) {
  const [force, setForce] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const api = window.vibeMeet.git;

  const remove = async () => {
    if (!api || busy) return;
    setBusy(true);
    setError(null);
    try {
      const closed = await releaseTerminals(worktree.path);
      // Windows keeps directory handles briefly after a shell exits.
      if (closed > 0) await delay(400);
      let res = await api.removeWorktree({ cwd, worktreePath: worktree.path, force: force || undefined });
      if (!res.ok && closed > 0 && /permission denied|busy|being used|resource/i.test(res.error)) {
        await delay(1200);
        res = await api.removeWorktree({ cwd, worktreePath: worktree.path, force: force || undefined });
      }
      if (!res.ok) {
        setError(
          /modified or untracked|contains modified|untracked files/i.test(res.error) && !force
            ? `${res.error}\n工作树中有未提交的更改，可勾选“强制删除”后重试。`
            : res.error,
        );
        return;
      }
      onRemoved(res.path);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wrp-confirm is-block" role="alertdialog" aria-label="确认删除工作树">
      <span>
        删除工作树 <strong>{folderName(worktree.path)}</strong>
        {worktree.branch ? `（分支 ${worktree.branch} 会保留）` : ''}。
        {terminalCount > 0 && ` 将先关闭其中的 ${terminalCount} 个终端窗格。`}
      </span>
      <label className="wrp-check">
        <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
        强制删除（丢弃未提交的更改）
      </label>
      {error && <p className="wrp-inline-error">{error}</p>}
      <div>
        <button type="button" className="wrp-btn" onClick={onCancel} disabled={busy}>
          取消
        </button>
        <button type="button" className="wrp-btn is-danger" onClick={() => void remove()} disabled={busy}>
          {busy ? <LoaderCircle size={12} className="wrp-spin" /> : <Trash2 size={12} />}
          删除
        </button>
      </div>
    </div>
  );
}
