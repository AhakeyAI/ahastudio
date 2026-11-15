import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  ArrowLeft,
  Columns2,
  Equal,
  FolderOpen,
  FolderPlus,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  Rows2,
  Search,
  Sun,
  Terminal,
} from 'lucide-react';
import { useStageWindows } from '../hooks/useStageWindows';
import { agentStatusClient } from '../lib/agent-status-client';
import {
  agentDisplayName,
  agentStatusDetail,
  agentStatusLabel,
  isAgentStatusVisible,
  pickAttentionStatus,
  ptyIdForLeaf,
} from '../lib/agent-status-view';
import { isPathInside, isSamePath } from '../lib/git-panel-model';
import { orchestrationClient } from '../lib/orchestration-client';
import {
  attentionCount,
  leafIdForSpawnedPty,
  newAttention,
  newUrgentMessages,
  taskTitle,
  workerWindowTarget,
} from '../lib/orchestration-view';
import { stageWindowStore } from '../lib/stage-window-store';
import {
  getTerminalSearchShortcutLabel,
  isTerminalSearchShortcut,
  shouldConfirmPaneClose,
} from '../lib/terminal-search-options';
import { type TerminalAppearancePreference } from '../lib/terminal-appearance';
import { terminalSessionStore } from '../lib/terminal-session-store';
import { usePickCwd } from './DirPickerModal';
import { formatCommandDuration, SplitPaneContainer } from './SplitPaneContainer';
import { StageTabBar } from './StageTabBar';
import { TerminalProfileIcon } from './TerminalProfileIcon';
import { AgentStatusBadge, useAgentStatuses } from './AgentStatusBadge';
import type { WorktreeHostActions } from './GitWorktreesPanel';
import type { AgentPromptTarget } from './PanelPreview';
import type { OrchestrationHostActions, OrchestrationPaneTarget } from './OrchestrationPanel';
import { clampRightPanelWidth, WorkspaceRightPanel, type RightPanelTab } from './WorkspaceRightPanel';
import './local-terminal-workspace.css';

function readDirectories(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('aha.terminal.directories') ?? '[]');
    return Array.isArray(value)
      ? value.filter((item): item is string => typeof item === 'string').slice(0, 20)
      : [];
  } catch {
    return [];
  }
}

function readRightPanelTab(): RightPanelTab {
  const value = localStorage.getItem('aha.rightPanel.tab');
  return value === 'files' || value === 'worktrees' || value === 'orchestration' ? value : 'changes';
}

function paneCwd(win: { cwd?: string; panes?: Record<string, { cwd?: string }> }, leafId: string) {
  return terminalSessionStore.getState(leafId).cwd ?? win.panes?.[leafId]?.cwd ?? win.cwd;
}

function terminalPanesInside(path: string): Array<{ windowId: string; leafId: string; all: boolean }> {
  const hits: Array<{ windowId: string; leafId: string; all: boolean }> = [];
  for (const win of stageWindowStore.getSnapshot().windows) {
    if (!win.localCliId) continue;
    const leafIds = stageWindowStore.getWindowLeafIds(win.id);
    const inside = leafIds.filter((leafId) => {
      const cwd = paneCwd(win, leafId);
      return Boolean(cwd && isPathInside(path, cwd));
    });
    for (const leafId of inside) hits.push({ windowId: win.id, leafId, all: inside.length === leafIds.length });
  }
  return hits;
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
const phaseLabels = {
  starting: '启动中',
  running: '运行中',
  exited: '已退出',
  error: '错误',
  closing: '关闭中',
};

export function LocalTerminalWorkspace({
  onBack,
  toolbarExtra,
}: {
  onBack?: () => void;
  toolbarExtra?: ReactNode;
}) {
  const stage = useStageWindows();
  const { pickCwd, pickerModal } = usePickCwd();
  const [directories, setDirectories] = useState(readDirectories);
  const [cwd, setCwd] = useState<string | undefined>(
    () => localStorage.getItem('aha.terminal.cwd') ?? undefined,
  );
  const [sidebar, setSidebar] = useState(true);
  const [query, setQuery] = useState('');
  const [defaultCwd, setDefaultCwd] = useState<string>();
  const [searchOpen, setSearchOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingClosePane, setPendingClosePane] = useState<{ windowId: string; leafId: string } | null>(null);
  const [rightPanel, setRightPanel] = useState(() => localStorage.getItem('aha.rightPanel.open') === '1');
  const [rightTab, setRightTab] = useState<RightPanelTab>(readRightPanelTab);
  const [rightWidth, setRightWidth] = useState(() =>
    clampRightPanelWidth(Number(localStorage.getItem('aha.rightPanel.width')) || 360),
  );

  useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getSnapshot);
  const agents = useAgentStatuses();
  const fontSize = terminalSessionStore.getFontSize();
  const appearance = terminalSessionStore.getAppearance();
  const appearancePreference = terminalSessionStore.getAppearancePreference();
  const windows = stage.windows.filter((win) => win.localCliId);
  const windowFolder = (win: { cwd?: string }) => win.cwd ?? defaultCwd;
  const selectedCwd =
    cwd ?? windows.find((win) => win.id === stage.activeWindowId)?.cwd ?? defaultCwd;
  // Each project folder owns the CLIs opened in it; only those are shown.
  const folderWindows = windows.filter((win) => {
    const folder = windowFolder(win);
    return Boolean(folder && selectedCwd && isSamePath(folder, selectedCwd));
  });
  const lastActiveByFolder = useRef(new Map<string, string>());
  const rememberedId = selectedCwd ? lastActiveByFolder.current.get(selectedCwd.toLowerCase()) : undefined;
  const active =
    folderWindows.find((win) => win.id === stage.activeWindowId) ??
    folderWindows.find((win) => win.id === rememberedId) ??
    folderWindows.at(-1);
  const activeLeafId = active ? stage.getActiveLeafId(active) : undefined;
  const activeLeafIds = active ? stage.getWindowLeafIds(active.id) : [];
  const activeLeafState = activeLeafId ? terminalSessionStore.getState(activeLeafId) : undefined;
  const pendingLeafState = pendingClosePane
    ? terminalSessionStore.getState(pendingClosePane.leafId)
    : undefined;
  const searchShortcut = getTerminalSearchShortcutLabel();
  const activePaneCwd =
    activeLeafState?.cwd ??
    (activeLeafId ? active?.panes?.[activeLeafId]?.cwd : undefined) ??
    active?.cwd;
  const displayCwd = activePaneCwd ?? selectedCwd ?? '用户目录';
  const folders = [
    ...directories,
    ...windows.flatMap((win) => {
      const folder = windowFolder(win);
      return folder ? [folder] : [];
    }),
    ...(selectedCwd ? [selectedCwd] : []),
  ].reduce<string[]>(
    (list, path) => (list.some((item) => isSamePath(item, path)) ? list : [...list, path]),
    [],
  );

  const windowAgentStatus = (win: { id: string }) =>
    pickAttentionStatus(stage.getWindowLeafIds(win.id).map((leafId) => agents.get(ptyIdForLeaf(leafId))));
  const activePtyId = activeLeafId ? ptyIdForLeaf(activeLeafId) : undefined;
  const activeAgent = activePtyId ? agents.get(activePtyId) : null;
  const agentTargets: AgentPromptTarget[] = folderWindows.flatMap((win) => {
    const leafIds = stage.getWindowLeafIds(win.id);
    return leafIds.map((leafId, index) => {
      const pane = win.panes?.[leafId];
      const cliId = pane?.localCliId ?? win.localCliId;
      const status = agents.get(ptyIdForLeaf(leafId));
      return {
        ptyId: ptyIdForLeaf(leafId),
        windowId: win.id,
        leafId,
        label: `${pane?.title ?? win.title}${leafIds.length > 1 ? ` · 窗格 ${index + 1}` : ''}`,
        cwd: terminalSessionStore.getState(leafId).cwd ?? pane?.cwd ?? win.cwd,
        isAgent: Boolean(cliId && cliId !== 'shell'),
        isActive: leafId === activeLeafId && win.id === active?.id,
        status,
      };
    });
  });

  const orchestrationPanes: OrchestrationPaneTarget[] = windows.flatMap((win) => {
    const leafIds = stage.getWindowLeafIds(win.id);
    const folder = windowFolder(win);
    return leafIds.map((leafId, index) => {
      const pane = win.panes?.[leafId];
      const cliId = pane?.localCliId ?? win.localCliId;
      const status = agents.get(ptyIdForLeaf(leafId));
      return {
        ptyId: ptyIdForLeaf(leafId),
        label: `${folder ? `${folderName(folder)} / ` : ''}${pane?.title ?? win.title}${leafIds.length > 1 ? ` · 窗格 ${index + 1}` : ''}`,
        isAgent: Boolean((cliId && cliId !== 'shell') || status?.agentId),
        status,
      };
    });
  });

  const panelCwd = activePaneCwd ?? selectedCwd;
  const commandSignal = [
    activeLeafId ?? '',
    activeLeafState?.commandRunning ? 'run' : 'idle',
    activeLeafState?.lastExitCode ?? '',
    activeLeafState?.lastDurationMs ?? '',
  ].join('|');

  const toggleRightPanel = useCallback((next?: boolean) => {
    setRightPanel((value) => {
      const open = next ?? !value;
      localStorage.setItem('aha.rightPanel.open', open ? '1' : '0');
      return open;
    });
  }, []);

  const changeRightTab = useCallback((tab: RightPanelTab) => {
    localStorage.setItem('aha.rightPanel.tab', tab);
    setRightTab(tab);
  }, []);

  const changeRightWidth = useCallback((width: number, persist: boolean) => {
    const next = clampRightPanelWidth(width);
    setRightWidth(next);
    if (persist) localStorage.setItem('aha.rightPanel.width', String(next));
  }, []);

  useEffect(() => {
    if (!rightPanel) return;
    const onResize = () => setRightWidth((width) => clampRightPanelWidth(width));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [rightPanel]);

  useEffect(() => {
    setSearchOpen(false);
  }, [active?.id]);

  // Keep the store's active window (used by voice input) in step with the folder view.
  const globalActiveIsCli = windows.some((win) => win.id === stage.activeWindowId);
  useEffect(() => {
    if (active) {
      if (selectedCwd) lastActiveByFolder.current.set(selectedCwd.toLowerCase(), active.id);
      if (stage.activeWindowId !== active.id) stage.setActiveWindow(active.id);
    } else if (globalActiveIsCli) {
      stage.setActiveWindow('activity-default');
    }
  }, [active?.id, selectedCwd, stage.activeWindowId, globalActiveIsCli]);

  useEffect(() => {
    if (!pendingClosePane) return;
    if (
      !active ||
      pendingClosePane.windowId !== active.id ||
      !activeLeafIds.includes(pendingClosePane.leafId) ||
      !shouldConfirmPaneClose(pendingLeafState)
    ) {
      setPendingClosePane(null);
    }
  }, [active, activeLeafIds, pendingClosePane, pendingLeafState]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 3200);
    return () => clearTimeout(timer);
  }, [toast]);

  // Looking at a pane counts as reading it; acknowledge once the app window has focus.
  useEffect(() => {
    if (!activePtyId || !activeAgent?.unread) return;
    const ack = () => {
      if (document.visibilityState === 'visible' && document.hasFocus()) agentStatusClient.acknowledge(activePtyId);
    };
    ack();
    window.addEventListener('focus', ack);
    return () => window.removeEventListener('focus', ack);
  }, [activePtyId, activeAgent?.unread, activeAgent?.updatedAt]);

  const agentEventsRef = useRef<{
    focus: (ptyId: string) => void;
    attention: (ptyId: string, message: string) => void;
  }>();
  agentEventsRef.current = {
    focus: (ptyId) => {
      const hit = findLeafByPtyId(ptyId);
      if (!hit) return;
      const folder = windowFolder(hit.win);
      if (folder) selectFolder(folder);
      stage.setActiveWindow(hit.win.id);
      stage.focusPane(hit.win.id, hit.leafId);
    },
    attention: (ptyId, message) => {
      if (ptyId === activePtyId && document.hasFocus()) return;
      const hit = findLeafByPtyId(ptyId);
      if (!hit) return;
      const folder = windowFolder(hit.win);
      setToast(`${folder ? `${folderName(folder)} · ` : ''}${hit.win.title}：${message}`);
    },
  };

  useEffect(() => {
    const offFocus = agentStatusClient.onFocusRequest((ptyId) => agentEventsRef.current?.focus(ptyId));
    const offAttention = agentStatusClient.onAttention((status) =>
      agentEventsRef.current?.attention(status.ptyId, agentStatusLabel(status)),
    );
    return () => {
      offFocus();
      offAttention();
    };
  }, []);

  const seenWorkerPanes = useRef<Set<string> | null>(null);
  if (seenWorkerPanes.current === null) {
    seenWorkerPanes.current = new Set(
      stageWindowStore
        .getSnapshot()
        .windows.flatMap((win) => stageWindowStore.getWindowLeafIds(win.id).map((leafId) => ptyIdForLeaf(leafId))),
    );
  }

  const openWorkerPane = (
    target: { ptyId: string; cliId?: string; cwd?: string; title: string },
    activate: boolean,
  ): boolean => {
    const leafId = leafIdForSpawnedPty(target.ptyId);
    if (!leafId) return false;
    seenWorkerPanes.current!.add(target.ptyId);
    void stageWindowStore.createWindow('terminal', {
      windowId: leafId,
      ...workerWindowTarget(target.cliId),
      cwd: target.cwd,
      title: target.title,
      activate,
    });
    return true;
  };

  const orchestrationEventsRef = useRef<{
    spawned: (event: { ptyId: string; taskId: string; cwd?: string; cliId?: string }) => void;
    changed: Parameters<typeof orchestrationClient.onChange>[0];
  }>();
  orchestrationEventsRef.current = {
    spawned: (event) => {
      const task = orchestrationClient.getSnapshot().tasks.find((item) => item.id === event.taskId);
      const name = task ? taskTitle(task) : event.taskId;
      if (openWorkerPane({ ...event, title: `Worker · ${name}` }, false)) {
        setToast(`编排：已为「${name}」启动 Worker`);
      }
    },
    changed: (prev, next) => {
      // Workers spawned while this window was not listening (e.g. after a reload) still get a tab, once.
      for (const dispatch of next.dispatches) {
        const ptyId = dispatch.assigneePaneId;
        if (!ptyId || (dispatch.status !== 'pending' && dispatch.status !== 'dispatched')) continue;
        if (!leafIdForSpawnedPty(ptyId)?.startsWith('orch-') || seenWorkerPanes.current!.has(ptyId)) continue;
        if (!agentStatusClient.get(ptyId)) continue;
        const task = next.tasks.find((item) => item.id === dispatch.taskId);
        openWorkerPane(
          { ptyId, cwd: task?.worktreePath ?? undefined, title: `Worker · ${task ? taskTitle(task) : dispatch.taskId}` },
          false,
        );
      }
      const viewing = rightPanel && rightTab === 'orchestration' && document.hasFocus();
      if (viewing) return;
      const fresh = newAttention(prev, next);
      const urgent = newUrgentMessages(prev, next);
      if (fresh.gates.length) {
        setToast(`编排：需要你决策「${fresh.gates[0]!.question.slice(0, 60)}」`);
      } else if (fresh.questions.length) {
        setToast(`编排：Worker 提问「${fresh.questions[0]!.question.slice(0, 60)}」`);
      } else if (urgent.length) {
        setToast(`编排：${urgent[0]!.subject.slice(0, 60)}`);
      }
    },
  };

  useEffect(() => {
    const offSpawned = orchestrationClient.onPaneSpawned((event) => orchestrationEventsRef.current?.spawned(event));
    const offChange = orchestrationClient.onChange((prev, next) => orchestrationEventsRef.current?.changed(prev, next));
    return () => {
      offSpawned();
      offChange();
    };
  }, []);

  const orchestration = useSyncExternalStore(orchestrationClient.subscribe, orchestrationClient.getSnapshot);
  const orchestrationAttention = attentionCount(orchestration);

  useEffect(() => {
    let cancelled = false;
    void window.vibeMeet.shellPty
      .listShells()
      .then((result) => {
        if (!cancelled && result.ok) setDefaultCwd(result.defaultCwd);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const selectFolder = (path: string) => {
    setCwd(path);
    localStorage.setItem('aha.terminal.cwd', path);
    setDirectories((previous) => {
      const next = [path, ...previous.filter((item) => item !== path)].slice(0, 20);
      localStorage.setItem('aha.terminal.directories', JSON.stringify(next));
      return next;
    });
  };

  const addFolder = async () => {
    const selected = await pickCwd(selectedCwd);
    if (selected) selectFolder(selected);
  };

  function findLeafByPtyId(ptyId: string) {
    for (const win of windows) {
      const leafId = stage.getWindowLeafIds(win.id).find((id) => ptyIdForLeaf(id) === ptyId);
      if (leafId) return { win, leafId };
    }
    return null;
  }

  const orchestrationActions: OrchestrationHostActions = {
    focusPane: (ptyId) => {
      if (!findLeafByPtyId(ptyId)) return false;
      agentEventsRef.current?.focus(ptyId);
      return true;
    },
    openWorkerPane: (target) => {
      if (!agentStatusClient.get(target.ptyId)) {
        setToast('该 Worker 终端已退出');
        return;
      }
      if (target.cwd) selectFolder(target.cwd);
      openWorkerPane(target, true);
    },
  };

  const focusAgentTarget = (target: AgentPromptTarget) => {
    stage.setActiveWindow(target.windowId);
    stage.focusPane(target.windowId, target.leafId);
  };

  const forgetFolder = (path: string) => {
    setDirectories((previous) => {
      const next = previous.filter((item) => !isPathInside(path, item));
      localStorage.setItem('aha.terminal.directories', JSON.stringify(next));
      return next;
    });
    if (cwd && isPathInside(path, cwd)) {
      setCwd(undefined);
      localStorage.removeItem('aha.terminal.cwd');
    }
  };

  const openTerminalAt = (path: string) => {
    selectFolder(path);
    stage.createWindow('terminal', {
      localCliId: 'shell',
      shellId: 'default',
      cwd: path,
      title: '终端',
    });
  };

  const worktreeActions: WorktreeHostActions = {
    openTerminal: openTerminalAt,
    selectProject: selectFolder,
    countTerminalsIn: (path) => terminalPanesInside(path).length,
    releaseTerminalsIn: async (path) => {
      const hits = terminalPanesInside(path);
      const closedWindows = new Set<string>();
      for (const hit of hits) {
        if (hit.all) {
          if (closedWindows.has(hit.windowId)) continue;
          closedWindows.add(hit.windowId);
          await stageWindowStore.closeWindow(hit.windowId);
        } else {
          await stageWindowStore.closePane(hit.windowId, hit.leafId);
        }
      }
      return hits.length;
    },
    forgetProject: forgetFolder,
    pickDirectory: pickCwd,
  };

  const selectTab = (id: string) => {
    const win = windows.find((item) => item.id === id);
    const path = win ? windowFolder(win) : undefined;
    if (path) selectFolder(path);
    stage.setActiveWindow(id);
  };

  const handleOpenSearch = useCallback(() => {
    if (active) setSearchOpen(true);
  }, [active]);

  const handleCloseSearch = useCallback(() => {
    setSearchOpen(false);
  }, []);

  const handleCwdChange = useCallback(
    (leafId: string, nextCwd: string) => {
      if (!active) return;
      stage.updatePaneMeta(active.id, leafId, { cwd: nextCwd });
    },
    [active, stage],
  );

  const handleNotify = useCallback((message: string) => {
    setToast(message);
  }, []);

  const requestClosePane = useCallback(
    (windowId: string, leafId: string) => {
      if (shouldConfirmPaneClose(terminalSessionStore.getState(leafId))) {
        stage.focusPane(windowId, leafId);
        setPendingClosePane({ windowId, leafId });
        return;
      }
      setPendingClosePane(null);
      void stage.closePane(windowId, leafId);
    },
    [stage],
  );

  const handleKey = (event: KeyboardEvent) => {
    if (event.nativeEvent.isComposing) return;
    if (
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === 'g'
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (rightPanel && rightTab === 'changes') {
        toggleRightPanel(false);
      } else {
        changeRightTab('changes');
        toggleRightPanel(true);
      }
      return;
    }
    if (
      event.ctrlKey &&
      event.shiftKey &&
      !event.altKey &&
      !event.metaKey &&
      event.key.toLowerCase() === 'o'
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (rightPanel && rightTab === 'orchestration') {
        toggleRightPanel(false);
      } else {
        changeRightTab('orchestration');
        toggleRightPanel(true);
      }
      return;
    }
    if (!active || !activeLeafId) return;

    if (pendingClosePane) {
      const inConfirmControl =
        event.target instanceof Element &&
        Boolean(event.target.closest('[data-pane-close-confirm]'));
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setPendingClosePane(null);
        return;
      }
      const confirmChord =
        event.ctrlKey &&
        event.shiftKey &&
        !event.altKey &&
        !event.metaKey &&
        event.key.toLowerCase() === 'w';
      const confirmEnter =
        !inConfirmControl &&
        event.key === 'Enter' &&
        !event.ctrlKey &&
        !event.shiftKey &&
        !event.altKey &&
        !event.metaKey;
      if (confirmChord || confirmEnter) {
        event.preventDefault();
        event.stopPropagation();
        const target = pendingClosePane;
        setPendingClosePane(null);
        void stage.closePane(target.windowId, target.leafId);
        return;
      }
    }

    const isInput =
      event.target instanceof Element &&
      Boolean(event.target.closest('input, select, textarea, [role="dialog"]'));

    if (isTerminalSearchShortcut(event)) {
      if (isInput && !(event.target instanceof Element && event.target.closest('[role="search"]'))) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      setSearchOpen(true);
      return;
    }

    if (!event.ctrlKey || !event.shiftKey || event.altKey || event.metaKey || isInput) return;
    const keyLower = event.key.toLowerCase();

    if (keyLower === 'd') {
      event.preventDefault();
      event.stopPropagation();
      stage.splitPane(active.id, activeLeafId, 'horizontal');
    } else if (keyLower === 'e') {
      event.preventDefault();
      event.stopPropagation();
      stage.splitPane(active.id, activeLeafId, 'vertical');
    } else if (event.key === '[' || event.key === '{') {
      event.preventDefault();
      event.stopPropagation();
      stage.focusNeighborPane(active.id, 'prev');
    } else if (event.key === ']' || event.key === '}') {
      event.preventDefault();
      event.stopPropagation();
      stage.focusNeighborPane(active.id, 'next');
    } else if (keyLower === 'w') {
      event.preventDefault();
      event.stopPropagation();
      requestClosePane(active.id, activeLeafId);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      event.stopPropagation();
      const index = folderWindows.indexOf(active);
      selectTab(
        folderWindows[
          (index + (event.key === 'PageUp' ? -1 : 1) + folderWindows.length) % folderWindows.length
        ].id,
      );
    }
  };

  const activeDuration = formatCommandDuration(activeLeafState?.lastDurationMs);

  return (
    <div
      className="local-terminal-workspace"
      data-appearance={appearance}
      data-sidebar={sidebar}
      data-right-panel={rightPanel}
      style={{ '--right-panel-width': rightPanel ? `${rightWidth}px` : '0px' } as CSSProperties}
      onKeyDownCapture={handleKey}
    >
      <header className="terminal-workspace-toolbar">
        {onBack && (
          <button type="button" onClick={onBack} title="返回首页" aria-label="返回首页">
            <ArrowLeft size={16} />
          </button>
        )}
        <span className="terminal-workspace-brand">AhaStation</span>
        <button
          type="button"
          onClick={() => setSidebar((value) => !value)}
          aria-label="切换目录侧栏"
          aria-expanded={sidebar}
        >
          <PanelLeft size={16} />
        </button>
        {toolbarExtra}
      </header>

      {sidebar && (
        <aside className="terminal-workspace-sidebar" aria-label="项目目录">
          <label className="terminal-directory-search">
            <Search size={15} />
            <input
              aria-label="搜索目录和终端"
              placeholder="搜索目录和终端"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <div className="terminal-directory-heading">
            <span>项目</span>
            <button
              type="button"
              onClick={() => void addFolder()}
              aria-label="添加项目目录"
              title="添加项目目录"
            >
              <FolderPlus size={16} />
            </button>
          </div>
          <div className="terminal-directory-list">
            {folders.map((path) => {
              const tabs = windows.filter((win) => {
                const folder = windowFolder(win);
                return Boolean(folder && isSamePath(folder, path));
              });
              const matchingTabs = tabs.filter((win) =>
                win.title.toLowerCase().includes(query.toLowerCase()),
              );
              if (
                query &&
                !path.toLowerCase().includes(query.toLowerCase()) &&
                !matchingTabs.length
              ) {
                return null;
              }
              return (
                <div className="terminal-directory-group" key={path}>
                  <div
                    className={`terminal-directory-row ${selectedCwd && isSamePath(selectedCwd, path) ? 'is-selected' : ''}`}
                  >
                    <button type="button" title={path} onClick={() => selectFolder(path)}>
                      <FolderOpen size={15} />
                      <span>{folderName(path)}</span>
                    </button>
                    {(() => {
                      const unread = tabs.reduce(
                        (count, win) =>
                          count +
                          stage
                            .getWindowLeafIds(win.id)
                            .filter((leafId) => agents.get(ptyIdForLeaf(leafId))?.unread).length,
                        0,
                      );
                      return unread > 0 ? (
                        <span className="terminal-directory-attention" title={`${unread} 个 Agent 需要关注`}>
                          {unread}
                        </span>
                      ) : null;
                    })()}
                    <button
                      type="button"
                      title="在此目录打开终端"
                      aria-label={`在 ${folderName(path)} 打开终端`}
                      onClick={() => {
                        selectFolder(path);
                        stage.createWindow('terminal', {
                          localCliId: 'shell',
                          shellId: 'default',
                          cwd: path,
                          title: '终端',
                        });
                      }}
                    >
                      <Plus size={14} />
                    </button>
                  </div>
                  {(query && !path.toLowerCase().includes(query.toLowerCase())
                    ? matchingTabs
                    : tabs
                  ).map((win) => {
                    const winLeafId = stage.getActiveLeafId(win);
                    const winLeafCount = stage.getWindowLeafIds(win.id).length;
                    const state = terminalSessionStore.getState(winLeafId);
                    return (
                      <button
                        type="button"
                        key={win.id}
                        className={`terminal-directory-session ${active?.id === win.id ? 'is-active' : ''}`}
                        onClick={() => selectTab(win.id)}
                        title={state.error ?? win.title}
                      >
                        <TerminalProfileIcon
                          id={win.localCliId === 'shell' ? win.shellId : win.localCliId}
                          size={14}
                        />
                        <span>{win.title}</span>
                        {(() => {
                          const agentStatus = windowAgentStatus(win);
                          if (isAgentStatusVisible(agentStatus) && state.phase === 'running' && !state.error) {
                            return (
                              <small className="is-agent">
                                {winLeafCount > 1 ? `${winLeafCount}分屏 · ` : ''}
                                <AgentStatusBadge status={agentStatus} size={11} />
                                {agentStatusLabel(agentStatus)}
                              </small>
                            );
                          }
                          return (
                            <small>
                              {winLeafCount > 1 ? `${winLeafCount}分屏 · ` : ''}
                              {state.error ? '错误' : phaseLabels[state.phase]}
                            </small>
                          );
                        })()}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {!folders.length && (
              <p className="terminal-directory-hint">添加项目目录，在项目中打开终端。</p>
            )}
          </div>
          <button
            type="button"
            className="terminal-add-folder"
            onClick={() => void addFolder()}
          >
            <Plus size={14} />
            添加目录
          </button>
        </aside>
      )}

      <div className="terminal-workspace-tabs">
        <StageTabBar
          windows={folderWindows}
          activeWindowId={active?.id ?? null}
          onSelect={selectTab}
          onClose={stage.closeWindow}
          localOnly
          renderTabBadge={(win) => <AgentStatusBadge status={windowAgentStatus(win)} />}
          onCreate={(type, opts) =>
            stage.createWindow(type, { ...opts, cwd: selectedCwd ?? opts?.cwd })
          }
        />
        <div className="terminal-tab-actions">
          {active && activeLeafId && (
            <>
            <button
              type="button"
              className={searchOpen ? 'is-active' : ''}
              title={`搜索终端内容 (${searchShortcut})`}
              aria-label="搜索终端内容"
              onClick={() => setSearchOpen((prev) => !prev)}
            >
              <Search size={14} />
            </button>
            <button
              type="button"
              title="左右分屏 (Ctrl+Shift+D)"
              aria-label="左右分屏"
              onClick={() => stage.splitPane(active.id, activeLeafId, 'horizontal')}
            >
              <Columns2 size={14} />
            </button>
            <button
              type="button"
              title="上下分屏 (Ctrl+Shift+E)"
              aria-label="上下分屏"
              onClick={() => stage.splitPane(active.id, activeLeafId, 'vertical')}
            >
              <Rows2 size={14} />
            </button>
            {activeLeafIds.length > 1 && (
              <button
                type="button"
                title="均分所有窗格"
                aria-label="均分所有窗格"
                onClick={() => stage.equalizePanes(active.id)}
              >
                <Equal size={14} />
              </button>
            )}
              <span className="terminal-tab-actions-sep" aria-hidden />
            </>
          )}
          <button
            type="button"
            className={rightPanel ? 'is-active' : ''}
            title={`Git、文件与编排面板 (Ctrl+Shift+G / Ctrl+Shift+O)${orchestrationAttention ? ` · 编排有 ${orchestrationAttention} 项待处理` : ''}`}
            aria-label="切换 Git、文件与编排面板"
            aria-expanded={rightPanel}
            onClick={() => toggleRightPanel()}
          >
            <PanelRight size={14} />
            {orchestrationAttention > 0 && !(rightPanel && rightTab === 'orchestration') && (
              <span className="terminal-tab-attention-dot" aria-hidden />
            )}
          </button>
        </div>
      </div>

      {rightPanel && (
        <WorkspaceRightPanel
          cwd={panelCwd}
          tab={rightTab}
          onTabChange={changeRightTab}
          width={rightWidth}
          onWidthChange={changeRightWidth}
          commandSignal={commandSignal}
          onNotify={handleNotify}
          onClose={() => toggleRightPanel(false)}
          worktreeActions={worktreeActions}
          agentTargets={agentTargets}
          onAgentPromptSent={focusAgentTarget}
          orchestrationPanes={orchestrationPanes}
          orchestrationActions={orchestrationActions}
        />
      )}

      <main className="local-terminal-body">
        {active && activeLeafId ? (
          <SplitPaneContainer
            node={active.splitTree ?? { type: 'leaf', id: active.id }}
            activeLeafId={activeLeafId}
            panes={active.panes ?? {}}
            fallbackCwd={active.cwd}
            fallbackCliId={active.localCliId}
            fallbackShellId={active.shellId}
            fallbackTitle={active.title}
            leafCount={activeLeafIds.length}
            searchOpen={searchOpen}
            onOpenSearch={handleOpenSearch}
            onCloseSearch={handleCloseSearch}
            onFocusPane={(leafId) => stage.focusPane(active.id, leafId)}
            onSplitPane={(leafId, direction) =>
              stage.splitPane(active.id, leafId, direction)
            }
            onClosePane={(leafId) => requestClosePane(active.id, leafId)}
            onResizeRatio={(path, ratio, persist) =>
              stage.updateSplitRatio(active.id, path, ratio, persist)
            }
            onCwdChange={handleCwdChange}
            onNotify={handleNotify}
          />
        ) : (
          <div className="local-terminal-empty">
            <Terminal size={28} />
            <p>{selectedCwd ? `在 ${folderName(selectedCwd)} 中开始工作` : '在这里开始工作'}</p>
            <small>点击上方 +，打开本机 CLI 或终端</small>
            <button type="button" onClick={() => void addFolder()}>
              <FolderOpen size={14} />
              选择项目目录
            </button>
          </div>
        )}
        {pendingClosePane && (
          <div
            className="terminal-pane-close-confirm"
            role="alertdialog"
            aria-label="确认关闭运行中的终端"
            data-pane-close-confirm
          >
            <span>当前窗格仍有命令在运行，关闭会直接终止进程。</span>
            <div className="terminal-pane-close-confirm-actions">
              <button type="button" onClick={() => setPendingClosePane(null)}>
                取消 (Esc)
              </button>
              <button
                type="button"
                className="is-danger"
                onClick={() => {
                  const target = pendingClosePane;
                  setPendingClosePane(null);
                  void stage.closePane(target.windowId, target.leafId);
                }}
              >
                关闭并终止 (Ctrl+Shift+W)
              </button>
            </div>
          </div>
        )}
        {toast && (
          <div className="terminal-workspace-toast" role="status">
            {toast}
          </div>
        )}
      </main>

      <footer className="local-terminal-footer">
        <span className="local-terminal-location" title={displayCwd}>
          <FolderOpen size={12} />
          <span>{displayCwd}</span>
        </span>
        {isAgentStatusVisible(activeAgent) && (
          <span className="local-terminal-agent" title={agentStatusDetail(activeAgent) || undefined}>
            <AgentStatusBadge status={activeAgent} variant="label" size={11} />
            <span>
              {agentDisplayName(activeAgent.agentId)}
              {agentStatusDetail(activeAgent) ? ` · ${agentStatusDetail(activeAgent)}` : ''}
            </span>
          </span>
        )}
        {activeLeafState?.commandRunning ? (
          <span className="osc-status is-running" title="Shell 命令正在运行">
            命令运行中…
          </span>
        ) : activeLeafState?.lastExitCode !== null &&
          activeLeafState?.lastExitCode !== undefined ? (
          <span
            className={`osc-status ${activeLeafState.lastExitCode === 0 ? 'is-ok' : 'is-fail'}`}
            title={`上次退出码 ${activeLeafState.lastExitCode}${activeDuration ? ` · 耗时 ${activeDuration}` : ''}`}
          >
            {activeLeafState.lastExitCode === 0
              ? '✓ 0'
              : `✗ ${activeLeafState.lastExitCode}`}
            {activeDuration ? ` · ${activeDuration}` : ''}
          </span>
        ) : null}
        <span
          className="terminal-shortcut-hint"
          title={`${searchShortcut} 搜索 · Ctrl+Shift+D/E 分屏 · Ctrl+Shift+[/] 切换窗格 · Ctrl+Shift+W 关闭`}
        >
          {folderWindows.length} 个终端
          {activeLeafIds.length > 1 ? ` · ${activeLeafIds.length} 窗格` : ''}
        </span>
        <label
          className="local-terminal-appearance"
          title={`界面与终端主题（当前：${appearance === 'dark' ? '深色' : '浅色'}）`}
        >
          {appearancePreference === 'system' ? (
            <Monitor size={13} aria-hidden />
          ) : appearance === 'light' ? (
            <Sun size={13} aria-hidden />
          ) : (
            <Moon size={13} aria-hidden />
          )}
          <select
            aria-label="界面主题"
            value={appearancePreference}
            onChange={(event) =>
              terminalSessionStore.setAppearance(
                event.target.value as TerminalAppearancePreference,
              )
            }
          >
            <option value="system">跟随系统</option>
            <option value="light">浅色</option>
            <option value="dark">深色</option>
          </select>
        </label>
        <label className="local-terminal-font">
          字号{' '}
          <select
            aria-label="终端字号"
            value={fontSize}
            onChange={(event) => terminalSessionStore.setFontSize(Number(event.target.value))}
          >
            {Array.from({ length: 15 }, (_, index) => index + 10).map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </footer>
      {pickerModal}
    </div>
  );
}
