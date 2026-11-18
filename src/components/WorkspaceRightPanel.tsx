import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { FolderTree, GitBranch, GitFork, Maximize2, Minimize2, RefreshCw, X } from 'lucide-react';
import { buildTreeDecorations } from '../lib/git-panel-model';
import type { GitStatusResult } from '../types';
import { GitChangesPanel } from './GitChangesPanel';
import { GitWorktreesPanel, type WorktreeHostActions } from './GitWorktreesPanel';
import { PanelPreview, previewKey, type AgentPromptTarget, type PanelPreviewTarget } from './PanelPreview';
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel';
import './workspace-right-panel.css';

export type RightPanelTab = 'changes' | 'files' | 'worktrees';

export const RIGHT_PANEL_MIN_WIDTH = 260;
export const RIGHT_PANEL_MAX_WIDTH = 1100;
const STATUS_POLL_MS = 10_000;

export function clampRightPanelWidth(width: number): number {
  const viewportMax = typeof window === 'undefined' ? RIGHT_PANEL_MAX_WIDTH : window.innerWidth - 380;
  return Math.round(
    Math.max(RIGHT_PANEL_MIN_WIDTH, Math.min(width, RIGHT_PANEL_MAX_WIDTH, Math.max(RIGHT_PANEL_MIN_WIDTH, viewportMax))),
  );
}

function useGitStatus(cwd: string | undefined) {
  const [status, setStatus] = useState<GitStatusResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [token, setToken] = useState(0);
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    const api = window.vibeMeet.git;
    const id = ++seq.current;
    if (!cwd) {
      setStatus(null);
      return;
    }
    if (!api) {
      setStatus({ ok: false, error: 'Git 接口不可用' });
      return;
    }
    setLoading(true);
    let next: GitStatusResult;
    try {
      next = await api.status({ cwd });
    } catch (error) {
      next = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    if (id !== seq.current) return;
    setStatus(next);
    setLoading(false);
    setToken((value) => value + 1);
  }, [cwd]);

  useEffect(() => {
    setStatus(null);
    void refresh();
  }, [refresh]);

  return { status, loading, token, refresh };
}

export function WorkspaceRightPanel({
  cwd,
  tab,
  onTabChange,
  width,
  onWidthChange,
  commandSignal,
  onNotify,
  onClose,
  worktreeActions,
  agentTargets,
  onAgentPromptSent,
}: {
  cwd: string | undefined;
  tab: RightPanelTab;
  onTabChange: (tab: RightPanelTab) => void;
  width: number;
  onWidthChange: (width: number, persist: boolean) => void;
  /** Changes whenever a shell command finishes in the active pane. */
  commandSignal: string;
  onNotify: (message: string) => void;
  onClose: () => void;
  worktreeActions: WorktreeHostActions;
  /** Terminal panes in the current project that can receive file/diff context. */
  agentTargets: AgentPromptTarget[];
  onAgentPromptSent: (target: AgentPromptTarget) => void;
}) {
  const { status, loading, token, refresh } = useGitStatus(cwd);
  const [fsSignal, setFsSignal] = useState(0);
  const [preview, setPreview] = useState<PanelPreviewTarget | null>(null);
  const [previewMax, setPreviewMax] = useState(false);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const gitRoot = status?.ok && status.isGitRepo ? status.rootPath : null;
  const isRepo = Boolean(gitRoot);
  const filesRoot = gitRoot ?? cwd ?? null;

  const scheduleRefresh = useCallback(
    (includeFs: boolean) => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        debounce.current = null;
        void refresh();
        if (includeFs) setFsSignal((value) => value + 1);
      }, 250);
    },
    [refresh],
  );

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const firstCommandSignal = useRef(true);
  useEffect(() => {
    if (firstCommandSignal.current) {
      firstCommandSignal.current = false;
      return;
    }
    scheduleRefresh(true);
  }, [commandSignal, scheduleRefresh]);

  useEffect(() => {
    const onFocus = () => scheduleRefresh(true);
    const onVisible = () => {
      if (document.visibilityState === 'visible') scheduleRefresh(true);
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) void refresh();
    }, STATUS_POLL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [refresh, scheduleRefresh]);

  useEffect(() => {
    setPreview(null);
    setPreviewMax(false);
  }, [filesRoot]);

  useEffect(() => {
    if (!isRepo && (tab === 'changes' || tab === 'worktrees') && status?.ok) onTabChange('files');
  }, [isRepo, status?.ok]);

  const decorations = useMemo(
    () => (status?.ok && status.isGitRepo ? buildTreeDecorations(status.entries) : null),
    [status],
  );

  const changeCount = status?.ok ? status.entries.length : 0;

  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const target = event.currentTarget;
    target.setPointerCapture(event.pointerId);
    let latest = startWidth;
    const onMove = (move: PointerEvent) => {
      latest = clampRightPanelWidth(startWidth + (startX - move.clientX));
      onWidthChange(latest, false);
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      target.removeEventListener('pointercancel', onUp);
      onWidthChange(latest, true);
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
    target.addEventListener('pointercancel', onUp);
  };

  const openFilePreview = (relativePath: string) => {
    if (filesRoot) setPreview({ kind: 'file', rootPath: filesRoot, relativePath });
  };

  const selectedKey = previewKey(preview);

  const tabs: Array<{ id: RightPanelTab; label: string; icon: ReactElement; badge?: number; disabled?: boolean }> = [
    { id: 'changes', label: '变更', icon: <GitBranch size={13} />, badge: changeCount || undefined, disabled: !isRepo },
    { id: 'files', label: '文件', icon: <FolderTree size={13} /> },
    { id: 'worktrees', label: '工作树', icon: <GitFork size={13} />, disabled: !isRepo },
  ];

  let body: ReactElement;
  if (!cwd || !filesRoot) {
    body = (
      <div className="wrp-empty">
        <FolderTree size={22} />
        <p>尚未选择项目目录</p>
        <small>在左侧添加或选择一个项目目录。</small>
      </div>
    );
  } else if (tab === 'changes') {
    body = (
      <GitChangesPanel
        cwd={cwd}
        status={status}
        refresh={async () => {
          await refresh();
          setFsSignal((value) => value + 1);
        }}
        onNotify={onNotify}
        selectedKey={selectedKey}
        onPreview={setPreview}
        onOpenFile={openFilePreview}
      />
    );
  } else if (tab === 'files') {
    body = (
      <WorkspaceFilesPanel
        rootPath={filesRoot}
        decorations={decorations}
        selectedKey={selectedKey}
        refreshSignal={fsSignal}
        onPreview={setPreview}
      />
    );
  } else if (gitRoot) {
    body = (
      <GitWorktreesPanel
        cwd={cwd}
        rootPath={gitRoot}
        currentPath={cwd}
        refreshSignal={fsSignal}
        onNotify={onNotify}
        onChanged={() => scheduleRefresh(true)}
        actions={worktreeActions}
      />
    );
  } else {
    body = (
      <div className="wrp-empty">
        <GitFork size={22} />
        <p>当前目录不是 Git 仓库</p>
      </div>
    );
  }

  return (
    <aside className="workspace-right-panel" aria-label="Git 与文件面板">
      <div
        className="wrp-resize-handle"
        role="separator"
        aria-orientation="vertical"
        aria-label="调整面板宽度"
        onPointerDown={startResize}
        onDoubleClick={() => onWidthChange(360, true)}
      />
      <header className="wrp-header">
        <div className="wrp-tabs" role="tablist">
          {tabs.map((item) => (
            <button
              key={item.id}
              type="button"
              role="tab"
              aria-selected={tab === item.id}
              className={tab === item.id ? 'is-active' : ''}
              disabled={item.disabled}
              title={
                item.disabled
                  ? '当前目录不是 Git 仓库'
                  : item.label
              }
              onClick={() => onTabChange(item.id)}
            >
              {item.icon}
              <span>{item.label}</span>
              {item.badge !== undefined && (
                <span className="wrp-badge">
                  {item.badge > 999 ? '999+' : item.badge}
                </span>
              )}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="wrp-header-btn"
          title="刷新"
          aria-label="刷新"
          onClick={() => scheduleRefresh(true)}
        >
          <RefreshCw size={13} className={loading ? 'wrp-spin' : ''} />
        </button>
        <button type="button" className="wrp-header-btn" title="关闭面板 (Ctrl+Shift+G)" aria-label="关闭面板" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className={`wrp-body ${preview ? 'has-preview' : ''} ${preview && previewMax ? 'is-preview-max' : ''}`}>
        <div className="wrp-main">{body}</div>
        {preview && filesRoot && (
          <div className="wrp-preview-host">
            <PanelPreview
              key={previewKey(preview)}
              target={preview}
              rootPath={preview.kind === 'file' ? preview.rootPath : (gitRoot ?? filesRoot)}
              refreshToken={token}
              agentTargets={agentTargets}
              onAgentPromptSent={onAgentPromptSent}
              headerExtra={
                <button
                  type="button"
                  title={previewMax ? '还原预览' : '最大化预览'}
                  aria-label={previewMax ? '还原预览' : '最大化预览'}
                  onClick={() => setPreviewMax((value) => !value)}
                >
                  {previewMax ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
                </button>
              }
              onClose={() => {
                setPreview(null);
                setPreviewMax(false);
              }}
            />
          </div>
        )}
      </div>
    </aside>
  );
}
