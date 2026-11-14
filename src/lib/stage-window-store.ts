// StageWindow store — manages dynamic multi-window tabs in the stage area.
// Follows the same subscribe/getSnapshot pattern as browser-store for
// useSyncExternalStore compatibility.

import { browserStore } from './browser-store';
import { terminalSessionStore } from './terminal-session-store';
import type { PersistedWorkspaceState } from '../types';
import { collectLayoutLeafIdsInOrder, equalizePaneTree, findLeafInLayout, findNeighborLeafId, removeLeafFromLayout, setSplitRatioAtPath, splitLeafInLayout, type PaneLayoutNode, type PaneNavigateDirection, type SplitDirection, type SplitNodePath } from './terminal-pane-tree';

export type StageWindowType = 'activity' | 'browser' | 'terminal' | 'file';

export interface StageWindowOptions {
  workerId?: string;
  title?: string;
  /** Manual local terminal; 'shell' starts the default interactive shell. */
  localCliId?: string;
  shellId?: string;
  cwd?: string;
  /** Terminal only: fixed window/leaf id, used to attach to a PTY created outside the renderer. */
  windowId?: string;
  /** Defaults to true; false adds the window without switching to it. */
  activate?: boolean;
}

export interface StagePaneMeta {
  id: string;
  cwd?: string;
  title?: string;
  localCliId?: string;
  shellId?: string;
}

export interface StageWindow {
  id: string;
  type: StageWindowType;
  title: string;
  browserTabId?: string;
  filePath?: string;
  /** For terminal windows: the worker id whose activity should be displayed */
  workerId?: string;
  localCliId?: string;
  shellId?: string;
  cwd?: string;
  /** Recursive binary split layout for multi-pane terminal windows. */
  splitTree?: PaneLayoutNode;
  /** Currently focused leaf pane id inside splitTree. */
  activeLeafId?: string;
  /** Per-pane metadata keyed by leaf id. */
  panes?: Record<string, StagePaneMeta>;
}

export interface StageWindowState {
  windows: StageWindow[];
  activeWindowId: string | null;
}

type Listener = () => void;

let nextId = 1;
function genId(): string {
  return `sw-${Date.now()}-${nextId++}`;
}

const ACTIVITY_TAB_ID = 'activity-default';

const initialState: StageWindowState = {
  windows: [{ id: ACTIVITY_TAB_ID, type: 'activity', title: '工作区' }],
  activeWindowId: ACTIVITY_TAB_ID,
};

function ensureTerminalWindowLayout(win: StageWindow): StageWindow {
  if (win.type !== 'terminal') return win;
  const splitTree: PaneLayoutNode = win.splitTree ?? { type: 'leaf', id: win.id };
  const leafIds = collectLayoutLeafIdsInOrder(splitTree);
  const activeLeafId =
    win.activeLeafId && leafIds.includes(win.activeLeafId)
      ? win.activeLeafId
      : (leafIds[0] ?? win.id);
  const panes: Record<string, StagePaneMeta> = {};
  for (const leafId of leafIds) {
    const existing = win.panes?.[leafId];
    panes[leafId] = existing ?? {
      id: leafId,
      cwd: win.cwd,
      title: win.title,
      localCliId: win.localCliId,
      shellId: win.shellId,
    };
  }
  return { ...win, splitTree, activeLeafId, panes };
}

class StageWindowStore {
  private state: StageWindowState = { ...initialState };
  private listeners = new Set<Listener>();
  private browserUnsubs = new Map<string, () => void>();
  private closingPanes = new Set<string>();
  private modifiedBeforeHydrate = false;
  // Persisting before the saved state is read would overwrite it with the initial one-tab state.
  private hydrated = false;

  constructor() {
    if (typeof window !== 'undefined' && window.vibeMeet?.workspaceState) {
      void this.hydrateFromDisk();
    } else {
      this.hydrated = true;
    }
  }

  private async hydrateFromDisk(): Promise<void> {
    try {
      const res = await window.vibeMeet?.workspaceState?.get();
      if (res && !res.ok) console.warn('[workspace-state] restore failed:', res.error);
      const saved = res && res.ok ? res.state : null;
      if (!saved) return;
      const restored = saved.windows
        .filter((w) =>
          w.type === 'activity' ||
          (w.type === 'terminal' && Boolean(w.localCliId || w.shellId)) ||
          (w.type === 'file' && Boolean(w.filePath))
        )
        .map((w) => ensureTerminalWindowLayout(w as StageWindow));
      if (restored.length === 0) return;
      if (this.modifiedBeforeHydrate) {
        // The user already changed tabs; keep those changes and add back the saved tabs they do not duplicate.
        const currentIds = new Set(this.state.windows.map((w) => w.id));
        const missing = restored.filter((w) => !currentIds.has(w.id));
        if (missing.length > 0) {
          this.state = { ...this.state, windows: [...this.state.windows, ...missing] };
          this.notify();
        }
        return;
      }
      const windows: StageWindow[] = restored.some((w) => w.type === 'activity')
        ? restored
        : [{ id: ACTIVITY_TAB_ID, type: 'activity', title: '工作区' }, ...restored];
      const activeWindowId =
        saved.activeWindowId && windows.some((w) => w.id === saved.activeWindowId)
          ? saved.activeWindowId
          : windows[0]!.id;
      this.state = { windows, activeWindowId };
      this.notify();
    } catch (error) {
      console.warn('[workspace-state] restore failed:', error);
    } finally {
      this.hydrated = true;
      if (this.modifiedBeforeHydrate) this.persistWorkspace();
    }
  }

  private persistWorkspace(): void {
    const api = typeof window !== 'undefined' ? window.vibeMeet?.workspaceState : undefined;
    if (!api || !this.hydrated) return;
    const windows = this.state.windows
      .filter((w) =>
        w.type === 'activity' ||
        (w.type === 'terminal' && Boolean(w.localCliId || w.shellId)) ||
        (w.type === 'file' && Boolean(w.filePath))
      )
      .map((w) => ({
        id: w.id,
        type: w.type,
        title: w.title,
        ...(w.workerId !== undefined ? { workerId: w.workerId } : {}),
        ...(w.localCliId !== undefined ? { localCliId: w.localCliId } : {}),
        ...(w.shellId !== undefined ? { shellId: w.shellId } : {}),
        ...(w.cwd !== undefined ? { cwd: w.cwd } : {}),
        ...(w.filePath !== undefined ? { filePath: w.filePath } : {}),
        ...(w.activeLeafId !== undefined ? { activeLeafId: w.activeLeafId } : {}),
        ...(w.splitTree !== undefined ? { splitTree: w.splitTree } : {}),
        ...(w.panes !== undefined ? { panes: w.panes } : {}),
      }));
    const activeWindowId =
      this.state.activeWindowId && windows.some((w) => w.id === this.state.activeWindowId)
        ? this.state.activeWindowId
        : (windows[0]?.id ?? null);
    const payload: PersistedWorkspaceState = { version: 1, windows, activeWindowId };
    // The main process reports rejected or failed saves as { ok: false }, not as a rejection.
    void api.set(payload).then(
      (res) => { if (!res.ok) console.warn('[workspace-state] save failed:', res.error); },
      (error) => console.warn('[workspace-state] save failed:', error),
    );
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  getSnapshot = (): StageWindowState => this.state;

  private notify(): void {
    for (const fn of this.listeners) {
      try { fn(); } catch { /* ignore */ }
    }
  }

  private update(partial: Partial<StageWindowState>, persist = true): void {
    this.modifiedBeforeHydrate = true;
    this.state = { ...this.state, ...partial };
    this.notify();
    if (persist) {
      this.persistWorkspace();
    }
  }

  getWindowLeafIds(windowId: string): string[] {
    const win = this.state.windows.find((w) => w.id === windowId);
    if (!win || win.type !== 'terminal') return [];
    return collectLayoutLeafIdsInOrder(win.splitTree ?? { type: 'leaf', id: win.id });
  }

  getActiveLeafId(win: StageWindow): string {
    const tree = win.splitTree ?? { type: 'leaf', id: win.id };
    if (win.activeLeafId && findLeafInLayout(tree, win.activeLeafId)) {
      return win.activeLeafId;
    }
    return collectLayoutLeafIdsInOrder(tree)[0] ?? win.id;
  }

  async createWindow(type: StageWindowType, opts?: StageWindowOptions): Promise<void> {
    if (type === 'activity') {
      await this.setActiveWindow(ACTIVITY_TAB_ID);
      return;
    }

    const fixedId = type === 'terminal' ? opts?.windowId : undefined;
    if (fixedId) {
      const owner = this.state.windows.find(
        (w) => w.id === fixedId || (w.type === 'terminal' && this.getWindowLeafIds(w.id).includes(fixedId)),
      );
      if (owner) {
        if (opts?.activate !== false) {
          await this.setActiveWindow(owner.id);
          if (owner.id !== fixedId) this.focusPane(owner.id, fixedId);
        }
        return;
      }
    }
    const id = fixedId ?? genId();

    if (type === 'browser') {
      const tab = await browserStore.openTab();
      if (!tab) return;
      const window: StageWindow = {
        id,
        type: 'browser',
        title: '新标签页',
        browserTabId: tab.id,
      };
      const unsub = browserStore.subscribe(() => {
        const snap = browserStore.getSnapshot();
        const bTab = snap.tabs.find((t) => t.id === tab.id);
        if (bTab) {
          const current = this.state.windows.find((w) => w.id === id);
          if (current && current.title !== bTab.title && bTab.title !== '新标签页') {
            this.update({
              windows: this.state.windows.map((w) =>
                w.id === id ? { ...w, title: bTab.title } : w,
              ),
            });
          }
        }
      });
      this.browserUnsubs.set(id, unsub);
      this.update({
        windows: [...this.state.windows, window],
        activeWindowId: id,
      });
      await browserStore.setActiveTab(tab.id);
    } else if (type === 'terminal') {
      const title = opts?.title ?? '终端';
      const window: StageWindow = {
        id,
        type: 'terminal',
        title,
        workerId: opts?.workerId,
        localCliId: opts?.localCliId,
        shellId: opts?.shellId,
        cwd: opts?.cwd,
        splitTree: { type: 'leaf', id },
        activeLeafId: id,
        panes: {
          [id]: {
            id,
            title,
            localCliId: opts?.localCliId,
            shellId: opts?.shellId,
            cwd: opts?.cwd,
          },
        },
      };
      if (opts?.activate === false) {
        this.update({ windows: [...this.state.windows, window] });
        return;
      }
      await browserStore.setVisible(false);
      this.update({
        windows: [...this.state.windows, window],
        activeWindowId: id,
      });
    } else {
      const title = '文件';
      const window: StageWindow = { id, type, title };
      this.update({
        windows: [...this.state.windows, window],
        activeWindowId: id,
      });
    }
  }

  splitPane(
    windowId: string,
    targetLeafId: string,
    direction: SplitDirection,
    opts?: { cwd?: string; localCliId?: string; shellId?: string; title?: string },
  ): string | null {
    const win = this.state.windows.find((w) => w.id === windowId);
    if (!win || win.type !== 'terminal') return null;
    const baseTree = win.splitTree ?? { type: 'leaf', id: win.id };
    if (!findLeafInLayout(baseTree, targetLeafId)) return null;

    const targetPane = win.panes?.[targetLeafId];
    const liveCwd = terminalSessionStore.getState(targetLeafId).cwd;
    const newLeafId = genId();
    const res = splitLeafInLayout(baseTree, targetLeafId, newLeafId, direction);
    if (!res.inserted) return null;

    const newPane: StagePaneMeta = {
      id: newLeafId,
      cwd: opts?.cwd ?? liveCwd ?? targetPane?.cwd ?? win.cwd,
      title: opts?.title ?? targetPane?.title ?? win.title,
      localCliId: opts?.localCliId ?? targetPane?.localCliId ?? win.localCliId,
      shellId: opts?.shellId ?? targetPane?.shellId ?? win.shellId,
    };

    const nextPanes: Record<string, StagePaneMeta> = {
      ...(win.panes ?? {
        [win.id]: {
          id: win.id,
          cwd: win.cwd,
          title: win.title,
          localCliId: win.localCliId,
          shellId: win.shellId,
        },
      }),
      [newLeafId]: newPane,
    };

    this.update({
      windows: this.state.windows.map((w) =>
        w.id === windowId
          ? { ...w, splitTree: res.layout, activeLeafId: newLeafId, panes: nextPanes }
          : w,
      ),
    });
    return newLeafId;
  }

  focusPane(windowId: string, leafId: string): void {
    const win = this.state.windows.find((w) => w.id === windowId);
    if (!win || win.type !== 'terminal') return;
    const tree = win.splitTree ?? { type: 'leaf', id: win.id };
    if (!findLeafInLayout(tree, leafId)) return;
    if (win.activeLeafId === leafId) return;
    this.update({
      windows: this.state.windows.map((w) =>
        w.id === windowId ? { ...w, activeLeafId: leafId } : w,
      ),
    });
  }

  focusNeighborPane(windowId: string, direction: PaneNavigateDirection): string | null {
    const win = this.state.windows.find((w) => w.id === windowId);
    if (!win || win.type !== 'terminal') return null;
    const tree = win.splitTree ?? { type: 'leaf', id: win.id };
    const currentId = this.getActiveLeafId(win);
    const neighborId = findNeighborLeafId(tree, currentId, direction);
    if (neighborId) {
      this.focusPane(windowId, neighborId);
    }
    return neighborId;
  }

  updateSplitRatio(windowId: string, path: SplitNodePath, ratio: number, persist = true): void {
    const win = this.state.windows.find((w) => w.id === windowId);
    if (!win || win.type !== 'terminal' || !win.splitTree) return;
    const nextTree = setSplitRatioAtPath(win.splitTree, path, ratio);
    if (nextTree === win.splitTree && !persist) return;
    this.update(
      {
        windows: this.state.windows.map((w) =>
          w.id === windowId ? { ...w, splitTree: nextTree } : w,
        ),
      },
      persist,
    );
  }

  equalizePanes(windowId: string): void {
    const win = this.state.windows.find((w) => w.id === windowId);
    if (!win || win.type !== 'terminal' || !win.splitTree) return;
    const nextTree = equalizePaneTree(win.splitTree);
    if (nextTree === win.splitTree) return;
    this.update({
      windows: this.state.windows.map((w) =>
        w.id === windowId ? { ...w, splitTree: nextTree } : w,
      ),
    });
  }

  updatePaneMeta(windowId: string, leafId: string, patch: Partial<Omit<StagePaneMeta, 'id'>>): void {
    const win = this.state.windows.find((w) => w.id === windowId);
    if (!win || win.type !== 'terminal') return;
    const tree = win.splitTree ?? { type: 'leaf', id: win.id };
    if (!findLeafInLayout(tree, leafId)) return;
    const currentMeta = win.panes?.[leafId] ?? {
      id: leafId,
      cwd: win.cwd,
      title: win.title,
      localCliId: win.localCliId,
      shellId: win.shellId,
    };
    const nextMeta: StagePaneMeta = { ...currentMeta, ...patch };
    if (
      nextMeta.cwd === currentMeta.cwd &&
      nextMeta.title === currentMeta.title &&
      nextMeta.localCliId === currentMeta.localCliId &&
      nextMeta.shellId === currentMeta.shellId
    ) {
      return;
    }
    const nextPanes: Record<string, StagePaneMeta> = {
      ...(win.panes ?? {}),
      [leafId]: nextMeta,
    };
    this.update({
      windows: this.state.windows.map((w) =>
        w.id === windowId ? { ...w, panes: nextPanes } : w,
      ),
    });
  }

  async closePane(windowId: string, leafId: string): Promise<void> {
    const win = this.state.windows.find((w) => w.id === windowId);
    if (!win) return;
    const leafIds = this.getWindowLeafIds(windowId);
    if (leafIds.length <= 1) {
      await this.closeWindow(windowId);
      return;
    }
    if (!leafIds.includes(leafId)) return;

    const lockKey = `${windowId}:${leafId}`;
    if (this.closingPanes.has(lockKey)) return;
    this.closingPanes.add(lockKey);
    try {
      if (win.localCliId) {
        try {
          await terminalSessionStore.close(leafId);
        } catch {
          return;
        }
      }
      const latest = this.state.windows.find((w) => w.id === windowId);
      if (!latest) return;
      const latestTree = latest.splitTree ?? { type: 'leaf', id: latest.id };
      const res = removeLeafFromLayout(latestTree, leafId);
      if (!res.removed) return;
      if (!res.layout) {
        await this.closeWindow(windowId);
        return;
      }
      const nextPanes = { ...(latest.panes ?? {}) };
      delete nextPanes[leafId];
      const nextActiveLeafId =
        latest.activeLeafId && latest.activeLeafId !== leafId && findLeafInLayout(res.layout, latest.activeLeafId)
          ? latest.activeLeafId
          : (res.fallbackFocusId ?? collectLayoutLeafIdsInOrder(res.layout)[0]);
      this.update({
        windows: this.state.windows.map((w) =>
          w.id === windowId
            ? { ...w, splitTree: res.layout!, activeLeafId: nextActiveLeafId, panes: nextPanes }
            : w,
        ),
      });
    } finally {
      this.closingPanes.delete(lockKey);
    }
  }

  async closeWindow(id: string): Promise<void> {
    if (id === ACTIVITY_TAB_ID) return;
    const win = this.state.windows.find((w) => w.id === id);
    if (!win) return;

    if (win.localCliId) {
      const leafIds = this.getWindowLeafIds(id);
      for (const leafId of leafIds) {
        // The session owns create/terminate ordering and displays close failures.
        // A never-mounted tab has no process to terminate.
        try {
          await terminalSessionStore.close(leafId);
        } catch {
          // Prune any earlier closed panes so dead surfaces never linger.
          const current = this.state.windows.find((w) => w.id === id);
          if (current && leafIds.length > 1) {
            const idx = leafIds.indexOf(leafId);
            const closedIds = leafIds.slice(0, idx);
            if (closedIds.length > 0 && current.splitTree) {
              let tree: PaneLayoutNode | null = current.splitTree;
              const nextPanes = { ...(current.panes ?? {}) };
              for (const closedId of closedIds) {
                if (!tree) break;
                const removed = removeLeafFromLayout(tree, closedId);
                tree = removed.layout;
                delete nextPanes[closedId];
              }
              if (tree) {
                const activeLeafId =
                  current.activeLeafId && findLeafInLayout(tree, current.activeLeafId)
                    ? current.activeLeafId
                    : leafId;
                this.update({
                  windows: this.state.windows.map((w) =>
                    w.id === id ? { ...w, splitTree: tree!, activeLeafId, panes: nextPanes } : w,
                  ),
                });
              }
            }
          }
          return;
        }
      }
    }

    if (win.type === 'browser' && win.browserTabId) {
      const unsub = this.browserUnsubs.get(id);
      if (unsub) {
        unsub();
        this.browserUnsubs.delete(id);
      }
      await browserStore.closeTab(win.browserTabId);
    }

    const newWindows = this.state.windows.filter((w) => w.id !== id);
    let newActiveId = this.state.activeWindowId;
    if (newActiveId === id) {
      newActiveId = newWindows.length > 0
        ? newWindows[newWindows.length - 1].id
        : ACTIVITY_TAB_ID;
    }

    this.update({ windows: newWindows, activeWindowId: newActiveId });

    if (newActiveId) {
      const nextWin = newWindows.find((w) => w.id === newActiveId);
      if (nextWin?.type === 'browser' && nextWin.browserTabId) {
        await browserStore.setActiveTab(nextWin.browserTabId);
        await browserStore.setVisible(true);
      } else {
        await browserStore.setVisible(false);
      }
    }
  }

  async setActiveWindow(id: string): Promise<void> {
    const win = this.state.windows.find((w) => w.id === id);
    if (!win) return;

    const prevWin = this.state.windows.find((w) => w.id === this.state.activeWindowId);
    if (prevWin?.type === 'browser' && win.type !== 'browser') {
      await browserStore.setVisible(false);
    }

    this.update({ activeWindowId: id });

    if (win.type === 'browser' && win.browserTabId) {
      await browserStore.setActiveTab(win.browserTabId);
      await browserStore.setVisible(true);
    }
  }

  renameWindow(id: string, title: string): void {
    this.update({
      windows: this.state.windows.map((w) =>
        w.id === id ? { ...w, title } : w,
      ),
    });
  }

  async openFile(filePath: string): Promise<void> {
    const fileName = filePath.split('/').pop() || filePath;
    const ext = fileName.split('.').pop()?.toLowerCase();

    if (ext === 'html' || ext === 'htm') {
      await this.openHtmlInBrowser(filePath, fileName);
      return;
    }

    const existing = this.state.windows.find((w) => w.type === 'file' && w.filePath === filePath);
    if (existing) {
      await this.setActiveWindow(existing.id);
      return;
    }

    const prevWin = this.state.windows.find((w) => w.id === this.state.activeWindowId);
    if (prevWin?.type === 'browser') {
      await browserStore.setVisible(false);
    }

    const id = genId();
    const window: StageWindow = { id, type: 'file', title: fileName, filePath };
    this.update({
      windows: [...this.state.windows, window],
      activeWindowId: id,
    });
  }

  private async openHtmlInBrowser(filePath: string, fileName: string): Promise<void> {
    const fileUrl = `file://${filePath}`;
    const existingBrowserWin = this.state.windows.find(
      (w) => w.type === 'browser' && w.filePath === filePath,
    );
    if (existingBrowserWin) {
      await this.setActiveWindow(existingBrowserWin.id);
      return;
    }

    const tab = await browserStore.openTab(fileUrl);
    if (!tab) {
      await this.openFileAsRegularFile(filePath, fileName);
      return;
    }

    const id = genId();
    const window: StageWindow = {
      id,
      type: 'browser',
      title: fileName,
      browserTabId: tab.id,
      filePath,
    };

    const unsub = browserStore.subscribe(() => {
      const snap = browserStore.getSnapshot();
      const bTab = snap.tabs.find((t) => t.id === tab.id);
      if (bTab) {
        const current = this.state.windows.find((w) => w.id === id);
        if (current && current.title !== bTab.title && bTab.title !== '新标签页') {
          this.update({
            windows: this.state.windows.map((w) =>
              w.id === id ? { ...w, title: bTab.title } : w,
            ),
          });
        }
      }
    });
    this.browserUnsubs.set(id, unsub);
    this.update({
      windows: [...this.state.windows, window],
      activeWindowId: id,
    });
    await browserStore.setActiveTab(tab.id);
  }

  private async openFileAsRegularFile(filePath: string, fileName: string): Promise<void> {
    const id = genId();
    const window: StageWindow = { id, type: 'file', title: fileName, filePath };
    this.update({
      windows: [...this.state.windows, window],
      activeWindowId: id,
    });
  }

  removeByType(type: StageWindowType): void {
    const toRemove = this.state.windows.filter((w) => w.type === type);
    for (const w of toRemove) {
      void this.closeWindow(w.id);
    }
  }
}

export const stageWindowStore = new StageWindowStore();
