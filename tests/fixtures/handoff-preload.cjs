const { contextBridge, ipcRenderer } = require('electron');
const setup = () => ipcRenderer.invoke('fixture:setup');
const noop = () => () => {};
const snapshot = () => ipcRenderer.invoke('fixture:snapshot');
contextBridge.exposeInMainWorld('handoffFixture', { setup });
contextBridge.exposeInMainWorld('vibeMeet', {
  uiPreferences: { get: async () => ({ handheldMode: 'auto' }), onChanged: noop },
  shellPty: { listShells: async () => ({ ok: true, shells: [] }) },
  agentSessions: {
    list: async () => ({ ok: true, sessions: [(await setup()).info] }),
    onChanged: noop, onTimelinePatch: noop, timeline: async () => ({ ok: true, timeline: null }),
  },
  orchestration: {
    getSnapshot: snapshot, onEvent: cb => {
      const listener = (_, event) => cb(event);
      ipcRenderer.on('fixture:changed', listener);
      return () => ipcRenderer.off('fixture:changed', listener);
    },
    onPaneSpawned: noop, onPaneClosed: noop, onWorkerTimelinePatch: noop,
    workerTimelineGet: async () => ({ ok: true, timeline: null }),
    reset: opts => ipcRenderer.invoke('fixture:clear', opts),
  },
});
