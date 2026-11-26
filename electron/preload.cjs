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

  voiceInput: {
    get: () => ipcRenderer.invoke('settings:get-voice-input'),
    set: (patch) => ipcRenderer.invoke('settings:set-voice-input', patch),
    onChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on('settings:voice-input-changed', listener);
      return () => ipcRenderer.removeListener('settings:voice-input-changed', listener);
    },
  },

  uiPreferences: {
    get: () => ipcRenderer.invoke('settings:get-ui-preferences'),
    set: (patch) => ipcRenderer.invoke('settings:set-ui-preferences', patch),
    onChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on('settings:ui-preferences-changed', listener);
      return () => ipcRenderer.removeListener('settings:ui-preferences-changed', listener);
    },
  },

  cliInventory: {
    list: () => ipcRenderer.invoke('settings:list-cli-inventory'),
  },

  orchestrationSettings: {
    get: () => ipcRenderer.invoke('settings:get-orchestration'),
    set: (patch) => ipcRenderer.invoke('settings:set-orchestration', patch),
    onChanged: (cb) => {
      const listener = () => cb();
      ipcRenderer.on('settings:orchestration-changed', listener);
      return () => ipcRenderer.removeListener('settings:orchestration-changed', listener);
    },
  },

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
    open: (focus) => ipcRenderer.invoke('settings:open-window', { focus }),
    close: () => ipcRenderer.invoke('settings:close-window'),
    onFocusSection: (cb) => {
      const listener = (_, payload) => cb(payload.section);
      ipcRenderer.on('settings:focus-section', listener);
      return () => ipcRenderer.removeListener('settings:focus-section', listener);
    },
  },

  appVersion: () => ipcRenderer.invoke('app:version'),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboardText: (text) => ipcRenderer.invoke('clipboard:write-text', text),
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
    onRestore: (cb) => {
      const listener = (_, e) => cb(e);
      ipcRenderer.on('shell-pty:restore', listener);
      return () => ipcRenderer.removeListener('shell-pty:restore', listener);
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

  agentMcp: {
    status: () => ipcRenderer.invoke('agent-mcp:status'),
    install: (opts) => ipcRenderer.invoke('agent-mcp:install', opts),
    uninstall: (opts) => ipcRenderer.invoke('agent-mcp:uninstall', opts),
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
    workerStart: (opts) => ipcRenderer.invoke('orchestration:worker-start', opts),
    workerList: (opts) => ipcRenderer.invoke('orchestration:worker-list', opts),
    workerShow: (opts) => ipcRenderer.invoke('orchestration:worker-show', opts),
    workerRead: (opts) => ipcRenderer.invoke('orchestration:worker-read', opts),
    workerTimelineGet: (opts) => ipcRenderer.invoke('orchestration:worker-timeline-get', opts),
    workerInterrupt: (opts) => ipcRenderer.invoke('orchestration:worker-interrupt', opts),
    workerKeepOpen: (opts) => ipcRenderer.invoke('orchestration:worker-keep-open', opts),
    workerRelease: (opts) => ipcRenderer.invoke('orchestration:worker-release', opts),
    workerStop: (opts) => ipcRenderer.invoke('orchestration:worker-stop', opts),
    workerAbandon: (opts) => ipcRenderer.invoke('orchestration:worker-abandon', opts),
    workerDiff: (opts) => ipcRenderer.invoke('orchestration:worker-diff', opts),
    workerIntegrate: (opts) => ipcRenderer.invoke('orchestration:worker-integrate', opts),
    runDiff: (opts) => ipcRenderer.invoke('orchestration:run-diff', opts),
    runFinalize: (opts) => ipcRenderer.invoke('orchestration:run-finalize', opts),
    runSetAutoReview: (opts) => ipcRenderer.invoke('orchestration:run-set-auto-review', opts),
    reset: (opts) => ipcRenderer.invoke('orchestration:reset', opts),
    approve: (opts) => ipcRenderer.invoke('orchestration:approve', opts),
    deny: (opts) => ipcRenderer.invoke('orchestration:deny', opts),
    check: (opts) => ipcRenderer.invoke('orchestration:check', opts),
    inbox: (opts) => ipcRenderer.invoke('orchestration:inbox', opts),
    ask: (opts) => ipcRenderer.invoke('orchestration:ask', opts),
    cancelWait: (opts) => ipcRenderer.invoke('orchestration:cancel-wait', opts),
    reply: (opts) => ipcRenderer.invoke('orchestration:reply', opts),
    gateCreate: (opts) => ipcRenderer.invoke('orchestration:gate-create', opts),
    gateResolve: (opts) => ipcRenderer.invoke('orchestration:gate-resolve', opts),
    gateList: (opts) => ipcRenderer.invoke('orchestration:gate-list', opts),
    setPaneMode: (opts) => ipcRenderer.invoke('orchestration:set-pane-mode', opts),
    listAgents: (opts) => ipcRenderer.invoke('orchestration:list-agents', opts),
    delegateTask: (opts) => ipcRenderer.invoke('orchestration:delegate-task', opts),
    proposalApprove: (opts) => ipcRenderer.invoke('orchestration:proposal-approve', opts),
    proposalReject: (opts) => ipcRenderer.invoke('orchestration:proposal-reject', opts),
    boardPost: (opts) => ipcRenderer.invoke('orchestration:board-post', opts),
    boardRead: (opts) => ipcRenderer.invoke('orchestration:board-read', opts),
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
    onPaneClosed: (cb) => {
      const listener = (_, event) => cb(event);
      ipcRenderer.on('orchestration:pane-closed', listener);
      return () => ipcRenderer.removeListener('orchestration:pane-closed', listener);
    },
    onWorkerTimelinePatch: (cb) => {
      const listener = (_, patch) => cb(patch);
      ipcRenderer.on('orchestration:worker-timeline-patch', listener);
      return () => ipcRenderer.removeListener('orchestration:worker-timeline-patch', listener);
    },
  },
  agentSessions: {
    runtime: (opts) => ipcRenderer.invoke('agent-sessions:runtime', opts),
    revealRuntimeConfig: () => ipcRenderer.invoke('agent-sessions:runtime-config', {}),
    reloadTools: (opts) => ipcRenderer.invoke('agent-sessions:reload-tools', opts),
    list: () => ipcRenderer.invoke('agent-sessions:list', {}),
    create: (opts) => ipcRenderer.invoke('agent-sessions:create', opts),
    send: (opts) => ipcRenderer.invoke('agent-sessions:send', opts),
    enqueue: (opts) => ipcRenderer.invoke('agent-sessions:enqueue', opts),
    unqueue: (opts) => ipcRenderer.invoke('agent-sessions:unqueue', opts),
    resumeQueue: (opts) => ipcRenderer.invoke('agent-sessions:resume-queue', opts),
    interrupt: (opts) => ipcRenderer.invoke('agent-sessions:interrupt', opts),
    respond: (opts) => ipcRenderer.invoke('agent-sessions:respond', opts),
    answer: (opts) => ipcRenderer.invoke('agent-sessions:answer', opts),
    close: (opts) => ipcRenderer.invoke('agent-sessions:close', opts),
    timeline: (opts) => ipcRenderer.invoke('agent-sessions:timeline', opts),
    setOrchestration: (opts) => ipcRenderer.invoke('agent-sessions:set-orchestration', opts),
    rename: (opts) => ipcRenderer.invoke('agent-sessions:rename', opts),
    goal: (opts) => ipcRenderer.invoke('agent-sessions:goal', opts),
    uploadFeedback: (opts) => ipcRenderer.invoke('agent-sessions:upload-feedback', opts),
    history: (opts) => ipcRenderer.invoke('agent-sessions:history', opts),
    openHistory: (opts) => ipcRenderer.invoke('agent-sessions:open-history', opts),
    archiveHistory: (opts) => ipcRenderer.invoke('agent-sessions:archive-history', opts),
    drivers: () => ipcRenderer.invoke('agent-sessions:drivers', {}),
    handoff: (opts) => ipcRenderer.invoke('agent-sessions:handoff', opts),
    reclaim: (opts) => ipcRenderer.invoke('agent-sessions:reclaim', opts),
    models: (opts) => ipcRenderer.invoke('agent-sessions:models', opts && opts.id ? { id: opts.id } : {}),
    rateLimits: () => ipcRenderer.invoke('agent-sessions:rate-limits', {}),
    skills: (opts) => ipcRenderer.invoke('agent-sessions:skills', opts),
    setSkillEnabled: (opts) => ipcRenderer.invoke('agent-sessions:set-skill-enabled', opts),
    plugins: (opts) => ipcRenderer.invoke('agent-sessions:plugins', opts),
    searchFiles: (opts) => ipcRenderer.invoke('agent-sessions:search-files', opts),
    attachImage: (opts) => ipcRenderer.invoke('agent-sessions:attach-image', opts),
    attachFile: (opts) => ipcRenderer.invoke('agent-sessions:attach-file', opts),
    onChanged: (cb) => {
      const listener = (_, sessions) => cb(sessions);
      ipcRenderer.on('agent-sessions:changed', listener);
      return () => ipcRenderer.removeListener('agent-sessions:changed', listener);
    },
  },
};

contextBridge.exposeInMainWorld('vibeMeet', api);
