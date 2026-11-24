import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { FolderTree, GitBranch, GitFork, Maximize2, Minimize2, Network, RefreshCw, X } from 'lucide-react';
import { agentStatusClient } from '../lib/agent-status-client';
import { buildTreeDecorations } from '../lib/git-panel-model';
import { orchestrationClient } from '../lib/orchestration-client';
import type { GitStatusResult } from '../types';
import { GitChangesPanel } from './GitChangesPanel';
import { GitWorktreesPanel, type WorktreeHostActions } from './GitWorktreesPanel';
import { OrchestrationBoardPanel } from './OrchestrationBoardPanel';
import { PanelPreview, previewKey, type AgentPromptTarget, type PanelPreviewTarget } from './PanelPreview';
import { WorkspaceFilesPanel } from './WorkspaceFilesPanel';
import './workspace-right-panel.css';

export type RightPanelTab = 'changes' | 'files' | 'worktrees' | 'board';

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
  boardRequest,
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
  sessionTargets,
  onAgentPromptSent,
  onFocusAgentSession,
  activePtyId,
}: {
  boardRequest?: { runId: string };
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
  /** Orchestrating Agent sessions open in this project folder. */
  sessionTargets?: { sessionId: string; windowId: string; title: string; isActive: boolean }[];
  onAgentPromptSent: (target: AgentPromptTarget) => void;
  onFocusAgentSession?: (windowId: string) => void;
  activePtyId?: string;
}) {
  const { status, loading, token, refresh } = useGitStatus(cwd);
  const orchestration = useSyncExternalStore(
    orchestrationClient.subscribe,
    orchestrationClient.getSnapshot,
  );
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
    const syncBoard = () => {
      if (tab === 'board') {
        void orchestrationClient.refresh();
        void agentStatusClient.refresh();
      }
    };
    const onFocus = () => {
      scheduleRefresh(true);
      syncBoard();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        scheduleRefresh(true);
        syncBoard();
      }
    };
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && document.hasFocus()) {
        if (tab === 'board') {
          void orchestrationClient.refresh();
          void agentStatusClient.refresh();
        } else {
          void refresh();
        }
      }
    }, STATUS_POLL_MS);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [refresh, scheduleRefresh, tab]);

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
  const boardAttention = useMemo(() => {
    const proposals = (orchestration.pendingProposals ?? []).filter((p) => p.status === 'pending').length;
    const approvals = (orchestration.openApprovals ?? []).filter((a) => a.status === 'pending').length;
    const questions = orchestration.questions.filter((q) => q.status === 'pending').length;
    const gates = orchestration.gates.filter((g) => g.status === 'pending').length;
    return proposals + approvals + questions + gates;
  }, [orchestration]);
  const boardWorking = useMemo(
    () =>
      orchestration.dispatches.filter(
        (d) => !d.releasedAt && (d.status === 'pending' || d.status === 'dispatched'),
      ).length,
    [orchestration.dispatches],
  );
  const boardBadge = boardAttention > 0 ? boardAttention : boardWorking;

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

  const tabs: Array<{
    id: RightPanelTab;
    label: string;
    icon: ReactElement;
    badge?: number;
    badgeWarn?: boolean;
    disabled?: boolean;
  }> = [
    { id: 'changes', label: '变更', icon: <GitBranch size={13} />, badge: changeCount || undefined, disabled: !isRepo },
    { id: 'files', label: '文件', icon: <FolderTree size={13} /> },
    { id: 'worktrees', label: '工作树', icon: <GitFork size={13} />, disabled: !isRepo },
    {
      id: 'board',
      label: '协作',
      icon: <Network size={13} />,
      badge: boardBadge || undefined,
      badgeWarn: boardAttention > 0,
    },
  ];

  let body: ReactElement;
  if (tab === 'board') {
    body = (
      <OrchestrationBoardPanel
        boardRequest={boardRequest}
        activePtyId={activePtyId}
        agentTargets={agentTargets}
        sessionTargets={sessionTargets}
        onFocusAgentTarget={onAgentPromptSent}
        onFocusAgentSession={onFocusAgentSession}
        onNotify={onNotify}
      />
    );
  } else if (!cwd || !filesRoot) {
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
                <span className={`wrp-badge ${item.badgeWarn ? 'is-warn' : ''}`}>
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
          onClick={() => {
            if (tab === 'board') {
              void orchestrationClient.refresh();
              void agentStatusClient.refresh();
            } else {
              scheduleRefresh(true);
            }
          }}
        >
          <RefreshCw size={13} className={loading ? 'wrp-spin' : ''} />
        </button>
        <button type="button" className="wrp-header-btn" title="关闭面板 (Ctrl+Shift+G)" aria-label="关闭面板" onClick={onClose}>
          <X size={14} />
        </button>
      </header>
      <div className={`wrp-body ${tab !== 'board' && preview ? 'has-preview' : ''} ${tab !== 'board' && preview && previewMax ? 'is-preview-max' : ''}`}>
        <div className="wrp-main">{body}</div>
        {tab !== 'board' && preview && filesRoot && (
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
