import { useSyncExternalStore, useCallback } from 'react';
import {
  stageWindowStore,
  type StagePaneMeta,
  type StageWindow,
  type StageWindowOptions,
  type StageWindowType,
} from '../lib/stage-window-store';
import type { PaneNavigateDirection, SplitDirection, SplitNodePath } from '../lib/terminal-pane-tree';

export function useStageWindows() {
  const state = useSyncExternalStore(
    stageWindowStore.subscribe,
    stageWindowStore.getSnapshot,
    stageWindowStore.getSnapshot,
  );

  const createWindow = useCallback((type: StageWindowType, opts?: StageWindowOptions) => {
    void stageWindowStore.createWindow(type, opts);
  }, []);

  const closeWindow = useCallback((id: string) => {
    void stageWindowStore.closeWindow(id);
  }, []);

  const setActiveWindow = useCallback((id: string) => {
    void stageWindowStore.setActiveWindow(id);
  }, []);

  const renameWindow = useCallback((id: string, title: string) => {
    stageWindowStore.renameWindow(id, title);
  }, []);

  const openFile = useCallback((filePath: string) => {
    void stageWindowStore.openFile(filePath);
  }, []);

  const splitPane = useCallback(
    (
      windowId: string,
      targetLeafId: string,
      direction: SplitDirection,
      opts?: { cwd?: string; localCliId?: string; shellId?: string; title?: string },
    ) => stageWindowStore.splitPane(windowId, targetLeafId, direction, opts),
    [],
  );

  const focusPane = useCallback((windowId: string, leafId: string) => {
    stageWindowStore.focusPane(windowId, leafId);
  }, []);

  const focusNeighborPane = useCallback(
    (windowId: string, direction: PaneNavigateDirection) =>
      stageWindowStore.focusNeighborPane(windowId, direction),
    [],
  );

  const closePane = useCallback((windowId: string, leafId: string) => {
    void stageWindowStore.closePane(windowId, leafId);
  }, []);

  const updateSplitRatio = useCallback(
    (windowId: string, path: SplitNodePath, ratio: number, persist = true) => {
      stageWindowStore.updateSplitRatio(windowId, path, ratio, persist);
    },
    [],
  );

  const equalizePanes = useCallback((windowId: string) => {
    stageWindowStore.equalizePanes(windowId);
  }, []);

  const updatePaneMeta = useCallback(
    (windowId: string, leafId: string, patch: Partial<Omit<StagePaneMeta, 'id'>>) => {
      stageWindowStore.updatePaneMeta(windowId, leafId, patch);
    },
    [],
  );

  const getWindowLeafIds = useCallback(
    (windowId: string) => stageWindowStore.getWindowLeafIds(windowId),
    [],
  );

  const getActiveLeafId = useCallback(
    (win: StageWindow) => stageWindowStore.getActiveLeafId(win),
    [],
  );

  return {
    windows: state.windows,
    activeWindowId: state.activeWindowId,
    createWindow,
    closeWindow,
    setActiveWindow,
    renameWindow,
    openFile,
    splitPane,
    focusPane,
    focusNeighborPane,
    closePane,
    updateSplitRatio,
    equalizePanes,
    updatePaneMeta,
    getWindowLeafIds,
    getActiveLeafId,
  };
}
