import { agentSessionClient, isStandaloneSession } from '../lib/agent-session-client';
import { SessionHistoryPanel } from './agent-session/SessionHistoryPanel';
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
  buildSidebarWindowLineage,
  filterLineageForFolder,
  isAutoManagedWorktreeFolder,
} from '../lib/orchestration-crew-model';
import {
  leafIdForSpawnedPty,
  newAttention,
  newPendingProposals,
  newUrgentMessages,
  taskTitle,
  headlessDispatchForTarget,
  isHeadlessDispatch,
  workerTabTitle,
  workerWindowTarget,
} from '../lib/orchestration-view';
import {
  ORCHESTRATION_FOCUS_EVENT,
  type ResolvedOrchestrationLinkTarget,
} from '../lib/terminal-links/orchestration-terminal-links';
import { stageWindowStore } from '../lib/stage-window-store';
import {
  getTerminalSearchShortcutLabel,
  isMacSearchPlatform,
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
import { AgentSessionView } from './AgentSessionView';
import type { WorktreeHostActions } from './GitWorktreesPanel';
import type { AgentPromptTarget } from './PanelPreview';
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

export const OPEN_ORCHESTRATION_BOARD_EVENT = 'aha:open-orchestration-board';

function readRightPanelTab(): RightPanelTab {
  const value = localStorage.getItem('aha.rightPanel.tab');
  return value === 'files' || value === 'worktrees' || value === 'board' ? value : 'changes';
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
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [pendingClosePane, setPendingClosePane] = useState<{ windowId: string; leafId: string } | null>(null);
  const [rightPanel, setRightPanel] = useState(() => localStorage.getItem('aha.rightPanel.open') === '1');
  const [boardRequest, setBoardRequest] = useState<{ runId: string }>();
  const [rightTab, setRightTab] = useState<RightPanelTab>(readRightPanelTab);
  const [rightWidth, setRightWidth] = useState(() =>
    clampRightPanelWidth(Number(localStorage.getItem('aha.rightPanel.width')) || 360),
  );

  useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getSnapshot);
  const orchestration = useSyncExternalStore(
    orchestrationClient.subscribe,
    orchestrationClient.getSnapshot,
  );
  const agents = useAgentStatuses();
  const agentSessions = useSyncExternalStore(agentSessionClient.subscribe, agentSessionClient.getSnapshot);
  const fontSize = terminalSessionStore.getFontSize();
  const appearance = terminalSessionStore.getAppearance();
  const appearancePreference = terminalSessionStore.getAppearancePreference();
  const windows = stage.windows.filter((win) => win.localCliId);
  const windowLineage = buildSidebarWindowLineage(
    windows,
    orchestration,
    stage.getWindowLeafIds,
    defaultCwd,
  );
  const effectiveFolderByWinId = new Map(
    windowLineage.map((item) => [item.win.id, item.effectiveFolder]),
  );
  const windowFolder = (win: { id: string; cwd?: string }) =>
    effectiveFolderByWinId.get(win.id) ?? win.cwd ?? defaultCwd;
  const activeGlobalWin = windows.find((win) => win.id === stage.activeWindowId);
  const selectedCwd =
    cwd ?? (activeGlobalWin ? windowFolder(activeGlobalWin) : undefined) ?? defaultCwd;
  // Each project folder owns the CLIs opened in it plus child workers spawned beneath them.
  const folderLineage = filterLineageForFolder(windowLineage, selectedCwd);
  const folderWindows = folderLineage.map((item) => item.win);
  const lastActiveByFolder = useRef(new Map<string, string>());
  const rememberedId = selectedCwd ? lastActiveByFolder.current.get(selectedCwd.toLowerCase()) : undefined;
  const active =
    folderWindows.find((win) => win.id === stage.activeWindowId) ??
    folderWindows.find((win) => win.id === rememberedId) ??
    folderWindows.at(-1);
  const activeIsSession = active?.type === 'agent-session';
  // Agent sessions have no terminal leaves; leaving these unset keeps PTY-only controls away from them.
  const activeLeafId = active && !activeIsSession ? stage.getActiveLeafId(active) : undefined;
  const activeLeafIds = active && !activeIsSession ? stage.getWindowLeafIds(active.id) : [];
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
    ...windowLineage.flatMap((item) => {
      const folder = item.effectiveFolder;
      if (!folder || (item.depth > 0 && isAutoManagedWorktreeFolder(folder))) return [];
      if (isAutoManagedWorktreeFolder(folder) && !directories.some((d) => isSamePath(d, folder))) {
        return [];
      }
      return [folder];
    }),
    ...(selectedCwd && !isAutoManagedWorktreeFolder(selectedCwd) ? [selectedCwd] : []),
  ].reduce<string[]>(
    (list, path) => (list.some((item) => isSamePath(item, path)) ? list : [...list, path]),
    [],
  );

  const windowAgentStatus = (win: { id: string }) =>
    pickAttentionStatus(stage.getWindowLeafIds(win.id).map((leafId) => agents.get(ptyIdForLeaf(leafId))));
  const activePtyId = activeLeafId ? ptyIdForLeaf(activeLeafId) : undefined;
  const activeAgent = activePtyId ? agents.get(activePtyId) : null;
  // Headless sessions have no PTY, so they can never receive pasted prompts.
  const agentTargets: AgentPromptTarget[] = folderWindows.filter((win) => win.type !== 'agent-session').flatMap((win) => {
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
        cliId: cliId && cliId !== 'shell' ? cliId : undefined,
        isAgent: Boolean(cliId && cliId !== 'shell'),
        isActive: leafId === activeLeafId && win.id === active?.id,
        status,
      };
    });
  });

  // Orchestrating Agent sessions in this folder are workspace Coordinators, not prompt targets.
  const sessionTargets = folderWindows.flatMap((win) => {
    if (win.type !== 'agent-session' || !win.workerId) return [];
    const session = agentSessions.find((item) => item.id === win.workerId);
    return session?.orchestration
      ? [{ sessionId: session.id, windowId: win.id, title: win.title, isActive: win.id === active?.id }]
      : [];
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

  const seenHeadlessWorkers = useRef(new Set<string>());
  const openAgentSession = (
    target: { workerId: string; dispatchId?: string; cliId?: string; cwd?: string; title: string },
    activate: boolean,
  ) => {
    seenHeadlessWorkers.current.add(target.workerId);
    void stageWindowStore.createWindow('agent-session', {
      workerId: target.workerId,
      dispatchId: target.dispatchId,
      localCliId: target.cliId ?? 'codex',
      cwd: target.cwd,
      title: target.title,
      activate,
    });
  };

  const closeWorkerPane = (ptyId: string) => {
    seenWorkerPanes.current?.delete(ptyId);
    const hit = findLeafByPtyId(ptyId);
    if (hit) {
      void stageWindowStore.closePane(hit.win.id, hit.leafId);
    }
  };

  const orchestrationEventsRef = useRef<{
    spawned: (event: {
      ptyId: string;
      taskId: string;
      displayName?: string | null;
      taskTitle?: string;
      cwd?: string;
      cliId?: string;
      dispatchId?: string;
      worktreePath?: string | null;
      headless?: boolean;
    }) => void;
    closed: (event: { ptyId: string }) => void;
    changed: Parameters<typeof orchestrationClient.onChange>[0];
  }>();
  orchestrationEventsRef.current = {
    spawned: (event) => {
      const task = orchestrationClient.getSnapshot().tasks.find((item) => item.id === event.taskId);
      const fallbackTask =
        event.displayName || event.taskTitle
          ? {
              id: event.taskId,
              displayName: event.displayName ?? '',
              taskTitle: event.taskTitle ?? '',
              spec: event.taskTitle ?? '',
            }
          : null;
      const effectiveTask = task ?? fallbackTask;
      const title = workerTabTitle(effectiveTask, event.taskId);
      const role = effectiveTask?.displayName?.trim().replace(/^@+/, '');
      const name = role ? `@${role}` : effectiveTask ? taskTitle(effectiveTask) : event.taskId;
      if (event.headless) {
        openAgentSession(
          { workerId: event.ptyId, dispatchId: event.dispatchId, cliId: event.cliId, cwd: event.worktreePath ?? event.cwd, title },
          false,
        );
        setToast(`编排：已为「${name}」启动无头 Worker 会话`);
        return;
      }
      if (openWorkerPane({ ...event, title }, false)) {
        setToast(`编排：已为「${name}」启动 Worker`);
      }
    },
    closed: (event) => {
      closeWorkerPane(event.ptyId);
    },
    changed: (prev, next) => {
      // Workers spawned while this window was not listening (e.g. after a reload) still get a tab, once.
      for (const dispatch of next.dispatches) {
        if (!isHeadlessDispatch(dispatch)) continue;
        if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') continue;
        if (seenHeadlessWorkers.current.has(dispatch.assigneeHandle)) continue;
        if (stageWindowStore.findAgentSession(dispatch.assigneeHandle)) {
          seenHeadlessWorkers.current.add(dispatch.assigneeHandle);
          continue;
        }
        const task = next.tasks.find((item) => item.id === dispatch.taskId);
        openAgentSession(
          {
            workerId: dispatch.assigneeHandle,
            dispatchId: dispatch.id,
            cliId: dispatch.cliId ?? undefined,
            cwd: dispatch.worktreePath ?? task?.worktreePath ?? undefined,
            title: workerTabTitle(task, dispatch.taskId),
          },
          false,
        );
      }
      for (const dispatch of next.dispatches) {
        const ptyId = dispatch.assigneePaneId;
        if (!ptyId) continue;
        if (!leafIdForSpawnedPty(ptyId)?.startsWith('orch-')) continue;
        const task = next.tasks.find((item) => item.id === dispatch.taskId);
        const hit = findLeafByPtyId(ptyId);
        if (hit && task) {
          const nextTitle = workerTabTitle(task, dispatch.taskId);
          if (hit.win.title !== nextTitle) {
            stageWindowStore.renameWindow(hit.win.id, nextTitle);
            stageWindowStore.updatePaneMeta(hit.win.id, hit.leafId, { title: nextTitle });
          }
        }
        if (dispatch.status !== 'pending' && dispatch.status !== 'dispatched') continue;
        if (seenWorkerPanes.current!.has(ptyId)) continue;
        if (!agentStatusClient.get(ptyId)) continue;
        openWorkerPane(
          {
            ptyId,
            cliId: dispatch.cliId ?? undefined,
            cwd: dispatch.worktreePath ?? task?.worktreePath ?? undefined,
            title: workerTabTitle(task, dispatch.taskId),
          },
          false,
        );
      }
      if (prev) {
        for (const dispatch of next.dispatches) {
          if (!dispatch.releasedAt) continue;
          const prevDispatch = prev.dispatches.find((d) => d.id === dispatch.id);
          if (prevDispatch?.releasedAt) continue;
          const ptyId = dispatch.assigneePaneId ?? dispatch.assigneeHandle;
          if (!leafIdForSpawnedPty(ptyId)?.startsWith('orch-')) continue;
          if (!agentStatusClient.get(ptyId)) {
            closeWorkerPane(ptyId);
          }
        }
      }
      const freshProposals = newPendingProposals(prev, next);
      const fresh = newAttention(prev, next);
      const urgent = newUrgentMessages(prev, next);
      const prevApprovalIds = new Set((prev?.openApprovals ?? []).map((a) => a.approvalId));
      const newApprovals = (next.openApprovals ?? []).filter(
        (a) => a.status === 'pending' && !prevApprovalIds.has(a.approvalId),
      );
      if (freshProposals.length) {
        const proposal = freshProposals[0]!;
        const role = proposal.role?.trim().replace(/^@+/, '') || 'worker';
        const agent = proposal.resolvedAgent || proposal.requestedAgent || 'auto';
        setToast(`编排：待确认拉起 @${role} (${agent})`);
      } else if (newApprovals.length) {
        setToast(`编排：Worker 请求权限「${newApprovals[0]!.toolName}」`);
      } else if (fresh.gates.length) {
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
    const offClosed = orchestrationClient.onPaneClosed((event) => orchestrationEventsRef.current?.closed(event));
    const offChange = orchestrationClient.onChange((prev, next) => orchestrationEventsRef.current?.changed(prev, next));
    return () => {
      offSpawned();
      offClosed();
      offChange();
    };
  }, []);

  const focusOrchestrationTargetRef = useRef<(target: ResolvedOrchestrationLinkTarget) => void>();
  focusOrchestrationTargetRef.current = (target) => {
    if (target.ptyId && isStandaloneSession(target.ptyId)) {
      const win = stageWindowStore.findAgentSession(target.ptyId);
      if (win) {
        const folder = windowFolder(win);
        if (folder) selectFolder(folder);
        stage.setActiveWindow(win.id);
        return;
      }
    }
    const headless = headlessDispatchForTarget(orchestrationClient.getSnapshot(), target);
    if (headless) {
      const task = orchestrationClient.getSnapshot().tasks.find((item) => item.id === headless.taskId);
      const folder = headless.worktreePath ?? undefined;
      openAgentSession(
        {
          workerId: headless.assigneeHandle,
          dispatchId: headless.id,
          cliId: headless.cliId ?? undefined,
          cwd: folder,
          title: workerTabTitle(task, headless.taskId),
        },
        true,
      );
      const win = stageWindowStore.findAgentSession(headless.assigneeHandle);
      const winFolder = win ? windowFolder(win) : undefined;
      if (winFolder) selectFolder(winFolder);
      return;
    }
    if (!target.ptyId) {
      setToast(`${target.label} 没有活跃终端`);
      return;
    }
    const existing = findLeafByPtyId(target.ptyId);
    if (existing) {
      agentEventsRef.current?.focus(target.ptyId);
      return;
    }
    if (!agentStatusClient.get(target.ptyId)) {
      setToast(`${target.label} 终端已关闭`);
      return;
    }
    openWorkerPane(
      {
        ptyId: target.ptyId,
        cliId: target.cliId ?? undefined,
        cwd: target.cwd ?? undefined,
        title: `Worker · ${target.label}`,
      },
      true,
    );
  };

  useEffect(() => {
    const onOpenBoard = (event: Event) => {
      const detail = (event as CustomEvent<{ runId?: string; coordinator?: boolean }>).detail;
      if (detail?.runId) {
        const run = orchestrationClient.getSnapshot().runs.find(item => item.id === detail.runId);
        const id = run?.coordinatorPaneId ?? run?.coordinatorHandle;
        if (detail.coordinator && id) {
          const win = stageWindowStore.findAgentSession(id);
          if (win && agentSessionClient.getSnapshot().some(session => session.id === id && session.status !== 'closed')) {
            const folder = windowFolder(win);
            if (folder) selectFolder(folder);
            stage.setActiveWindow(win.id);
            return;
          }
          if (findLeafByPtyId(id)) { agentEventsRef.current?.focus(id); return; }
        }
        setBoardRequest({ runId: detail.runId });
      }
      changeRightTab('board');
      toggleRightPanel(true);
    };
    window.addEventListener(OPEN_ORCHESTRATION_BOARD_EVENT, onOpenBoard);
    return () => window.removeEventListener(OPEN_ORCHESTRATION_BOARD_EVENT, onOpenBoard);
  }, [changeRightTab, toggleRightPanel]);

  useEffect(() => {
    const onFocusTarget = (ev: Event) => {
      const custom = ev as CustomEvent<ResolvedOrchestrationLinkTarget>;
      if (custom.detail) {
        focusOrchestrationTargetRef.current?.(custom.detail);
      }
    };
    window.addEventListener(ORCHESTRATION_FOCUS_EVENT, onFocusTarget);
    return () => window.removeEventListener(ORCHESTRATION_FOCUS_EVENT, onFocusTarget);
  }, []);

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
    if (!active || !activeLeafId) return;

    const isNonTerminalInput =
      event.target instanceof Element &&
      !event.target.classList.contains('xterm-helper-textarea') &&
      Boolean(event.target.closest('input, select, textarea, [role="dialog"]'));

    const isMac = isMacSearchPlatform();
    const isOrchestrationModeShortcut =
      !event.altKey &&
      event.shiftKey &&
      event.key.toLowerCase() === 'o' &&
      (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

    if (isOrchestrationModeShortcut && !isNonTerminalInput && activePtyId) {
      const paneCliId = active.panes?.[activeLeafId]?.localCliId ?? active.localCliId;
      if (paneCliId && paneCliId !== 'shell') {
        event.preventDefault();
        event.stopPropagation();
        event.nativeEvent.stopPropagation();
        const api = window.vibeMeet.orchestration?.setPaneMode;
        if (api) {
          const enabled = !Boolean(orchestration.orchestrationModePanes?.includes(activePtyId));
          void api({ ptyId: activePtyId, enabled }).then((res) => {
            if (!res.ok) setToast(res.error);
            else setToast(res.enabled ? '已开启编排模式' : '已关闭编排模式');
          });
        }
        return;
      }
    }

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
          className="terminal-sidebar-toggle"
          onClick={() => setSidebar((value) => !value)}
          aria-label="切换目录侧栏"
          aria-expanded={sidebar}
          title={sidebar ? '收起目录侧栏' : '展开目录侧栏'}
        >
          <PanelLeft size={16} />
        </button>
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
              const lineageItems = filterLineageForFolder(windowLineage, path);
              const tabs = lineageItems.map((item) => item.win);
              const matchingLineage = lineageItems.filter((item) =>
                item.win.title.toLowerCase().includes(query.toLowerCase()),
              );
              if (
                query &&
                !path.toLowerCase().includes(query.toLowerCase()) &&
                !matchingLineage.length
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
                    ? matchingLineage
                    : lineageItems
                  ).map(({ win, depth, dispatch }) => {
                    const isSession = win.type === 'agent-session';
                    const winLeafId = stage.getActiveLeafId(win);
                    const winLeafCount = stage.getWindowLeafIds(win.id).length;
                    const state = terminalSessionStore.getState(winLeafId);
                    const sessionDispatch = isSession
                      ? (dispatch ?? orchestration.dispatches.find((d) => d.id === win.dispatchId))
                      : undefined;
                    return (
                      <button
                        type="button"
                        key={win.id}
                        data-lineage-depth={depth > 0 ? depth : undefined}
                        className={`terminal-directory-session ${depth > 0 ? 'is-child-worker' : ''} ${active?.id === win.id ? 'is-active' : ''}`}
                        style={
                          depth > 0
                            ? ({ paddingLeft: `${12 + depth * 14}px` } as CSSProperties)
                            : undefined
                        }
                        onClick={() => selectTab(win.id)}
                        title={
                          (isSession ? undefined : state.error) ??
                          (dispatch?.branch
                            ? `${win.title} (${dispatch.branch})`
                            : win.title)
                        }
                      >
                        {depth > 0 && (
                          <span className="terminal-lineage-connector" aria-hidden="true">
                            └
                          </span>
                        )}
                        <TerminalProfileIcon
                          id={win.localCliId === 'shell' ? win.shellId : win.localCliId}
                          size={14}
                        />
                        <span>{win.title}</span>
                        {(() => {
                          if (isSession) {
                            const live = sessionDispatch?.status === 'pending' || sessionDispatch?.status === 'dispatched';
                            return <small className={live ? 'is-agent' : undefined}>{live ? '无头会话 · 运行中' : '无头会话'}</small>;
                          }
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
          onClose={(id) => {
            const closing = folderWindows.find((win) => win.id === id);
            // Closing the tab of a direct session ends it; Worker sessions keep running without a tab.
            if (closing?.type === 'agent-session' && isStandaloneSession(closing.workerId)) {
              void window.vibeMeet?.agentSessions?.close({ id: closing.workerId });
            }
            stage.closeWindow(id);
          }}
          localOnly
          renderTabBadge={(win) => (win.type === 'agent-session' ? null : <AgentStatusBadge status={windowAgentStatus(win)} />)}
          {...(selectedCwd && window.vibeMeet?.agentSessions?.history ? { onOpenHistory: () => setHistoryOpen(true) } : {})}
          onCreate={(type, opts) => {
            const cwd = selectedCwd ?? opts?.cwd;
            if (type !== 'agent-session') return stage.createWindow(type, { ...opts, cwd });
            void agentSessionClient.create({ ...(cwd ? { cwd } : {}), policy: 'workspace-write' }).then((res) => {
              if (!res.ok) return handleNotify(res.error);
              void stageWindowStore.createWindow('agent-session', { ...opts, cwd: res.session.cwd, workerId: res.session.id });
            });
          }}
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
            title="Git、文件与工作树面板 (Ctrl+Shift+G)"
            aria-label="切换 Git、文件与工作树面板"
            aria-expanded={rightPanel}
            onClick={() => toggleRightPanel()}
          >
            <PanelRight size={14} />
          </button>
        </div>
        {toolbarExtra && (
          <div className="terminal-workspace-toolbar-extra">
            {toolbarExtra}
          </div>
        )}
      </div>

      {rightPanel && (
        <WorkspaceRightPanel
          boardRequest={boardRequest}
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
          sessionTargets={sessionTargets}
          onAgentPromptSent={focusAgentTarget}
          onFocusAgentSession={selectTab}
          activePtyId={activePtyId ?? (activeIsSession ? active?.workerId : undefined)}
        />
      )}

      <main className="local-terminal-body">
        {active && activeIsSession ? (
          <AgentSessionView key={active.id} win={active} onNotify={handleNotify} />
        ) : active && activeLeafId ? (
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
        {historyOpen && selectedCwd && (
          <SessionHistoryPanel
            className="is-floating"
            cwd={selectedCwd}
            onClose={() => setHistoryOpen(false)}
            onOpened={() => setHistoryOpen(false)}
            onNotify={handleNotify}
          />
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
          title={`${searchShortcut} 搜索 · ${isMacSearchPlatform() ? 'Cmd+Shift+O' : 'Ctrl+Shift+O'} 编排模式 · Ctrl+Shift+D/E 分屏 · Ctrl+Shift+[/] 切换窗格 · Ctrl+Shift+W 关闭`}
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
