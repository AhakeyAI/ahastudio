const { contextBridge, ipcRenderer } = require('electron');

const api = {
  pickCwd: () => ipcRenderer.invoke('dialog:pick-cwd'),
  listDir: (path, showHidden) => ipcRenderer.invoke('dialog:list-dir', { path, showHidden }),
  confirmCwd: (path) => ipcRenderer.invoke('dialog:confirm-cwd', { path }),

  getVoiceConfig: () => ipcRenderer.invoke('settings:get-voice-config'),
  setVoiceLockEnabled: (on) => ipcRenderer.invoke('settings:set-voice-lock-enabled', on),
  setVoicePrint: (vp) => ipcRenderer.invoke('settings:set-voice-print', vp),
  onVoiceConfigChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('voiceconfig:changed', listener);
    return () => ipcRenderer.removeListener('voiceconfig:changed', listener);
  },

  voiceLockEnrollStart: () => ipcRenderer.invoke('voicelock:enroll-start'),
  voiceLockEnrollCancel: () => ipcRenderer.invoke('voicelock:enroll-cancel'),
  onVoiceLockEnrollCmd: (cb) => {
    const listener = (_, cmd) => cb(cmd);
    ipcRenderer.on('voicelock:enroll-cmd', listener);
    return () => ipcRenderer.removeListener('voicelock:enroll-cmd', listener);
  },
  sendVoiceLockEnrollState: (state) => ipcRenderer.send('voicelock:enroll-state', state),
  onVoiceLockEnrollState: (cb) => {
    const listener = (_, state) => cb(state);
    ipcRenderer.on('voicelock:enroll-state', listener);
    return () => ipcRenderer.removeListener('voicelock:enroll-state', listener);
  },

  getVoicePref: () => ipcRenderer.invoke('settings:get-voice-pref'),
  setVoicePref: (patch) => ipcRenderer.invoke('settings:set-voice-pref', patch),
  onVoicePrefChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('voicepref:changed', listener);
    return () => ipcRenderer.removeListener('voicepref:changed', listener);
  },
  openVoiceSettings: () => ipcRenderer.invoke('system:open-voice-settings'),

  asrAvailable: () => ipcRenderer.invoke('asr:available'),
  startAsrStream: (lang, includePreRoll) =>
    ipcRenderer.invoke('asr:stream-start', { lang, includePreRoll }),
  sendAsrStreamFrame: (frameBuffer, isPreRoll) =>
    ipcRenderer.send('asr:stream-frame', frameBuffer, isPreRoll),
  finishAsrStream: (sessionId) => ipcRenderer.invoke('asr:stream-finish', sessionId),
  cancelAsrStream: (sessionId) => ipcRenderer.invoke('asr:stream-cancel', sessionId),
  polishAsrText: (text) => ipcRenderer.invoke('asr:polish-text', text),

  requestMicPermission: () => ipcRenderer.invoke('mic:request-permission'),

  settingsWindow: {
    open: () => ipcRenderer.invoke('settings:open-window'),
    close: () => ipcRenderer.invoke('settings:close-window'),
  },

  appVersion: () => ipcRenderer.invoke('app:version'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  setThemeSource: (source) => ipcRenderer.invoke('theme:set-source', source),

  onDisplayChanged: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('display:changed', listener);
    return () => ipcRenderer.removeListener('display:changed', listener);
  },

  shellPty: {
    listClis: () => ipcRenderer.invoke('shell-pty:list-clis'),
    listShells: () => ipcRenderer.invoke('shell-pty:list-shells'),
    create: (opts) => ipcRenderer.invoke('shell-pty:create', opts),
    input: (ptyId, data) => ipcRenderer.invoke('shell-pty:input', { ptyId, data }),
    resize: (ptyId, rows, cols) => ipcRenderer.invoke('shell-pty:resize', { ptyId, rows, cols }),
    kill: (ptyId) => ipcRenderer.invoke('shell-pty:kill', { ptyId }),
    openLink: (opts) => ipcRenderer.invoke('shell-pty:open-link', opts),
    checkPaths: (opts) => ipcRenderer.invoke('shell-pty:check-paths', opts),
    onData: (cb) => {
      const listener = (_, e) => cb(e);
      ipcRenderer.on('shell-pty:data', listener);
      return () => ipcRenderer.removeListener('shell-pty:data', listener);
    },
    onExit: (cb) => {
      const listener = (_, e) => cb(e);
      ipcRenderer.on('shell-pty:exit', listener);
      return () => ipcRenderer.removeListener('shell-pty:exit', listener);
    },
  },

  workspaceState: {
    get: () => ipcRenderer.invoke('workspace-state:get'),
    set: (state) => ipcRenderer.invoke('workspace-state:set', state),
  },

  git: {
    inspect: (opts) => ipcRenderer.invoke('git:inspect', opts),
    status: (opts) => ipcRenderer.invoke('git:status', opts),
    diff: (opts) => ipcRenderer.invoke('git:diff', opts),
    stage: (opts) => ipcRenderer.invoke('git:stage', opts),
    unstage: (opts) => ipcRenderer.invoke('git:unstage', opts),
    discard: (opts) => ipcRenderer.invoke('git:discard', opts),
    commit: (opts) => ipcRenderer.invoke('git:commit', opts),
    branches: (opts) => ipcRenderer.invoke('git:branches', opts),
    checkout: (opts) => ipcRenderer.invoke('git:checkout', opts),
    listWorktrees: (opts) => ipcRenderer.invoke('git:worktree-list', opts),
    addWorktree: (opts) => ipcRenderer.invoke('git:worktree-add', opts),
    removeWorktree: (opts) => ipcRenderer.invoke('git:worktree-remove', opts),
  },

  workspaceFs: {
    listTree: (opts) => ipcRenderer.invoke('workspace-fs:list-tree', opts),
    readFile: (opts) => ipcRenderer.invoke('workspace-fs:read-file', opts),
  },

  agentHooks: {
    status: () => ipcRenderer.invoke('agent-hooks:status'),
    install: (opts) => ipcRenderer.invoke('agent-hooks:install', opts),
    uninstall: (opts) => ipcRenderer.invoke('agent-hooks:uninstall', opts),
  },

  agent: {
    listStatuses: () => ipcRenderer.invoke('agent:list-statuses'),
    getStatus: (opts) => ipcRenderer.invoke('agent:get-status', opts),
    acknowledge: (opts) => ipcRenderer.invoke('agent:acknowledge', opts),
    reportHook: (opts) => ipcRenderer.invoke('agent:report-hook', opts),
    sendPrompt: (opts) => ipcRenderer.invoke('agent:send-prompt', opts),
    onStatusChanged: (cb) => {
      const listener = (_, status) => cb(status);
      ipcRenderer.on('agent:status-changed', listener);
      return () => ipcRenderer.removeListener('agent:status-changed', listener);
    },
    onFocusPane: (cb) => {
      const listener = (_, payload) => cb(payload);
      ipcRenderer.on('agent:focus-pane', listener);
      return () => ipcRenderer.removeListener('agent:focus-pane', listener);
    },
  },
  orchestration: {
    getSnapshot: (opts) => ipcRenderer.invoke('orchestration:get-snapshot', opts),
    runCreate: (opts) => ipcRenderer.invoke('orchestration:run-create', opts),
    runUse: (opts) => ipcRenderer.invoke('orchestration:run-use', opts),
    runCurrent: (opts) => ipcRenderer.invoke('orchestration:run-current', opts),
    runList: (opts) => ipcRenderer.invoke('orchestration:run-list', opts),
    runShow: (opts) => ipcRenderer.invoke('orchestration:run-show', opts),
    taskCreate: (opts) => ipcRenderer.invoke('orchestration:task-create', opts),
    taskList: (opts) => ipcRenderer.invoke('orchestration:task-list', opts),
    taskShow: (opts) => ipcRenderer.invoke('orchestration:task-show', opts),
    taskUpdate: (opts) => ipcRenderer.invoke('orchestration:task-update', opts),
    dispatch: (opts) => ipcRenderer.invoke('orchestration:dispatch', opts),
    dispatchShow: (opts) => ipcRenderer.invoke('orchestration:dispatch-show', opts),
    coordinatorStart: (opts) => ipcRenderer.invoke('orchestration:coordinator-start', opts),
    coordinatorStop: () => ipcRenderer.invoke('orchestration:coordinator-stop'),
    coordinatorTick: (opts) => ipcRenderer.invoke('orchestration:coordinator-tick', opts),
    coordinatorStatus: (opts) => ipcRenderer.invoke('orchestration:coordinator-status', opts),
    send: (opts) => ipcRenderer.invoke('orchestration:send', opts),
    workerDone: (opts) => ipcRenderer.invoke('orchestration:worker-done', opts),
    check: (opts) => ipcRenderer.invoke('orchestration:check', opts),
    inbox: (opts) => ipcRenderer.invoke('orchestration:inbox', opts),
    ask: (opts) => ipcRenderer.invoke('orchestration:ask', opts),
    reply: (opts) => ipcRenderer.invoke('orchestration:reply', opts),
    gateCreate: (opts) => ipcRenderer.invoke('orchestration:gate-create', opts),
    gateResolve: (opts) => ipcRenderer.invoke('orchestration:gate-resolve', opts),
    gateList: (opts) => ipcRenderer.invoke('orchestration:gate-list', opts),
    onEvent: (cb) => {
      const listener = (_, event) => cb(event);
      ipcRenderer.on('orchestration:event', listener);
      return () => ipcRenderer.removeListener('orchestration:event', listener);
    },
    onPaneSpawned: (cb) => {
      const listener = (_, event) => cb(event);
      ipcRenderer.on('orchestration:pane-spawned', listener);
      return () => ipcRenderer.removeListener('orchestration:pane-spawned', listener);
    },
  },
};

contextBridge.exposeInMainWorld('vibeMeet', api);
