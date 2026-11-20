export interface VoicePrint {
  embedding: number[];
  model: string;
  secondsCaptured: number;
  enrolledAt: number;
}

export interface VoiceLockEnrollState {
  enrollment: {
    targetSeconds: number;
    capturedSeconds: number;
    segments: number;
  } | null;
  toast: 'saved' | 'tooShort' | 'cancelled' | null;
}

export type HandheldModeSetting = 'auto' | 'desktop' | 'handheld';
export type SettingsSection = 'appearance' | 'terminal' | 'voice-input' | 'cli-agents';

export interface VoiceInputPreferences {
  voicePolishEnabled: boolean;
  voicePolishApiKeyConfigured: boolean;
  voicePolishBaseUrl: string;
  voicePolishModel: string;
  xfyunAsr: {
    appId: string;
    apiKeyConfigured: boolean;
    apiSecretConfigured: boolean;
  };
}

export interface VoiceInputPatch {
  voicePolishEnabled?: boolean;
  voicePolishApiKey?: string;
  voicePolishBaseUrl?: string;
  voicePolishModel?: string;
  xfyunAsr?: {
    appId?: string;
    apiKey?: string;
    apiSecret?: string;
  };
}

export interface LocalCliInventoryEntry extends Omit<LocalCliInfo, 'binaryPath'> {
  binaryPath: string | null;
  installed: boolean;
}

export interface LocalCliInfo {
  id: string;
  label: string;
  command: string;
  binaryPath: string;
}

export interface DirListEntry {
  name: string;
  path: string;
}

export type ListDirResult =
  | { ok: true; path: string; parent: string | null; entries: DirListEntry[] }
  | { ok: false; error: string };

export interface BrowserTabInfo {
  id: string;
  url: string;
  title: string;
  isLoading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface BrowserStateSnapshot {
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  visible: boolean;
}

export interface BrowserApi {
  openTab: (url?: string) => Promise<{ ok: true; tab: BrowserTabInfo } | { ok: false; error: string }>;
  closeTab: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  setActive: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  navigate: (tabId: string, url: string) => Promise<{ ok: boolean }>;
  back: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  forward: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  reload: (tabId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  setBounds: (bounds: { x: number; y: number; width: number; height: number; dpr: number }) => Promise<{ ok: true } | { ok: false; error: string }>;
  setVisible: (visible: boolean) => Promise<{ ok: true } | { ok: false; error: string }>;
  getState: () => Promise<BrowserStateSnapshot>;
  capturePage: (tabId?: string) => Promise<{ ok: true; pngBase64: string; width: number; height: number } | { ok: false; error: string }>;
  onStateUpdate: (cb: (state: BrowserStateSnapshot) => void) => () => void;
}

export interface VibeMeetApi {
  pickCwd: () => Promise<string | null>;
  listDir: (path: string | null, showHidden?: boolean) => Promise<ListDirResult>;
  confirmCwd: (path: string) => Promise<string | null>;

  getVoiceConfig: () => Promise<{ enabled: boolean; voicePrint: VoicePrint | null }>;
  setVoiceLockEnabled: (on: boolean) => Promise<{ ok: boolean; error?: string }>;
  setVoicePrint: (vp: VoicePrint | null) => Promise<{ ok: boolean; error?: string }>;
  onVoiceConfigChanged?: (cb: () => void) => () => void;

  voiceLockEnrollStart: () => Promise<{ ok: boolean }>;
  voiceLockEnrollCancel: () => Promise<{ ok: boolean }>;
  onVoiceLockEnrollCmd?: (cb: (cmd: 'start' | 'cancel') => void) => () => void;
  sendVoiceLockEnrollState?: (state: VoiceLockEnrollState) => void;
  onVoiceLockEnrollState?: (cb: (state: VoiceLockEnrollState) => void) => () => void;

  voiceInput: {
    get: () => Promise<VoiceInputPreferences>;
    set: (patch: VoiceInputPatch) => Promise<{ ok: boolean; error?: string }>;
    onChanged: (cb: () => void) => () => void;
  };

  uiPreferences: {
    get: () => Promise<{ handheldMode: HandheldModeSetting }>;
    set: (patch: { handheldMode?: HandheldModeSetting }) => Promise<{ ok: boolean; error?: string }>;
    onChanged: (cb: () => void) => () => void;
  };

  cliInventory: {
    list: () => Promise<{ ok: true; clis: LocalCliInventoryEntry[] } | { ok: false; error: string }>;
  };

  asrAvailable: () => Promise<{ ok: boolean; available: boolean; error?: string; reason?: string }>;
  startAsrStream: (
    lang: 'auto' | 'zh' | 'en',
    includePreRoll?: boolean,
  ) => Promise<{ ok: true; sessionId: string } | { ok: false; error: string }>;
  sendAsrStreamFrame: (frameBuffer: ArrayBufferLike, isPreRoll?: boolean) => void;
  finishAsrStream: (
    sessionId: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  cancelAsrStream: (sessionId?: string) => Promise<{ ok: boolean }>;
  polishAsrText: (
    text: string,
  ) => Promise<{ ok: true; text: string } | { ok: false; error?: string; text?: string }>;

  requestMicPermission: () => Promise<boolean>;

  settingsWindow: {
    open: (focus?: SettingsSection) => Promise<{ ok: boolean }>;
    close: () => Promise<{ ok: boolean }>;
    onFocusSection: (cb: (section: SettingsSection) => void) => () => void;
  };

  appVersion: () => Promise<string>;
  relaunchApp: () => Promise<void>;
  setThemeSource?: (
    source: 'system' | 'light' | 'dark',
  ) => Promise<{ shouldUseDarkColors: boolean }>;
  onDisplayChanged?: (cb: () => void) => () => void;

  shellPty: {
    listClis: () => Promise<{ ok: true; clis: LocalCliInfo[] } | { ok: false; error: string }>;
    listShells: () => Promise<{ ok: true; shells: LocalCliInfo[]; defaultCwd: string } | { ok: false; error: string }>;
    create: (opts?: {
      cwd?: string;
      cols?: number;
      rows?: number;
      cliId?: string;
      shellId?: string;
      terminalId?: string;
    }) => Promise<
      | {
          ok: true;
          ptyId: string;
          replay: string;
          sequence: number;
          exited?: boolean;
          exitCode?: number | null;
          screenSnapshot?: TerminalScreenSnapshot;
        }
      | { ok: false; error?: string }
    >;
    input: (ptyId: string, data: string) => Promise<{ ok: boolean; error?: string; dropped?: boolean }>;
    resize: (ptyId: string, rows: number, cols: number) => Promise<{ ok: boolean; error?: string }>;
    kill: (ptyId: string) => Promise<{ ok: boolean; error?: string }>;
    openLink?: (opts: {
      target: string;
      cwd?: string;
    }) => Promise<
      | { ok: true; action: 'external' | 'opened' | 'revealed'; path?: string }
      | { ok: false; error?: string }
    >;
    checkPaths?: (opts: {
      cwd?: string;
      paths: string[];
    }) => Promise<
      | { ok: true; existing: Record<string, { path: string; isDirectory: boolean }> }
      | { ok: false; error?: string }
    >;
    onData: (cb: (e: { ptyId: string; data: string; sequence: number }) => void) => () => void;
    onRestore: (cb: (snapshot: TerminalRestoreEvent) => void) => () => void;
    onExit: (cb: (e: { ptyId: string; exitCode: number | null }) => void) => () => void;
  };

  workspaceState?: {
    get: () => Promise<{ ok: true; state: PersistedWorkspaceState | null } | { ok: false; error?: string }>;
    set: (state: PersistedWorkspaceState) => Promise<{ ok: boolean; error?: string }>;
  };

  git?: GitApi;
  workspaceFs?: WorkspaceFsApi;
  agent?: AgentApi;
  agentHooks?: AgentHooksApi;
  agentMcp?: {
    status: () => Promise<{ ok: true; statuses: AgentMcpCliStatus[] } | { ok: false; error: string }>;
    install: (opts: {
      cliId: AgentMcpCliId;
    }) => Promise<{ ok: true; status?: AgentMcpCliStatus } | { ok: false; error: string; status?: AgentMcpCliStatus }>;
    uninstall: (opts: {
      cliId: AgentMcpCliId;
    }) => Promise<{ ok: true; status?: AgentMcpCliStatus } | { ok: false; error: string; status?: AgentMcpCliStatus }>;
  };
  orchestrationSettings?: {
    get: () => Promise<OrchestrationSettings>;
    set: (
      patch: OrchestrationSettingsPatch,
    ) => Promise<{ ok: true; settings: OrchestrationSettings } | { ok: false; error: string }>;
    onChanged: (cb: () => void) => () => void;
  };
  orchestration?: OrchestrationApi;

  browser?: BrowserApi;
}

export interface GitStatusFileEntry {
  path: string;
  origPath: string | null;
  indexStatus: string;
  worktreeStatus: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflicted: boolean;
}

export interface GitWorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
  branchRef: string | null;
  isBare: boolean;
  detached: boolean;
  locked: boolean;
  lockReason: string | null;
  prunable: boolean;
  prunableReason: string | null;
  isMainWorktree: boolean;
}

export interface GitBranchInfo {
  name: string;
  refName: string;
  kind: 'local' | 'remote';
  current: boolean;
  commit: string;
  upstream: string | null;
}

export type GitInspectResult =
  | {
      ok: true;
      isGitRepo: boolean;
      cwd: string;
      rootPath: string | null;
      commonDir: string | null;
      gitDir: string | null;
      head: string | null;
      branch: string | null;
    }
  | { ok: false; error: string };

export type GitStatusResult =
  | {
      ok: true;
      isGitRepo: boolean;
      rootPath: string | null;
      branch: string | null;
      upstream: string | null;
      ahead: number;
      behind: number;
      detached: boolean;
      head: string | null;
      entries: GitStatusFileEntry[];
    }
  | { ok: false; error: string };

export type GitDiffResult =
  | {
      ok: true;
      diff: string;
      truncated: boolean;
      staged: boolean;
      path: string | null;
    }
  | { ok: false; error: string };

export type GitMutationResult = { ok: true } | { ok: false; error: string };

export type GitDiscardResult =
  | { ok: true; restored: string[]; removed: string[] }
  | { ok: false; error: string };

export type GitCommitResult =
  | { ok: true; commitHash: string | null; branch: string | null }
  | { ok: false; error: string };

export type GitBranchesResult =
  | {
      ok: true;
      isGitRepo: boolean;
      currentBranch: string | null;
      branches: GitBranchInfo[];
    }
  | { ok: false; error: string };

export type GitWorktreeListResult =
  | {
      ok: true;
      isGitRepo: boolean;
      worktrees: GitWorktreeEntry[];
    }
  | { ok: false; error: string };

export type GitWorktreePathResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

export interface GitApi {
  inspect: (opts: { cwd: string }) => Promise<GitInspectResult>;
  status: (opts: { cwd: string }) => Promise<GitStatusResult>;
  diff: (opts: {
    cwd: string;
    path?: string;
    staged?: boolean;
    contextLines?: number;
  }) => Promise<GitDiffResult>;
  stage: (opts: { cwd: string; paths?: string[]; all?: boolean }) => Promise<GitMutationResult>;
  unstage: (opts: { cwd: string; paths?: string[]; all?: boolean }) => Promise<GitMutationResult>;
  discard: (opts: { cwd: string; paths: string[] }) => Promise<GitDiscardResult>;
  commit: (opts: { cwd: string; message: string; amend?: boolean }) => Promise<GitCommitResult>;
  branches: (opts: { cwd: string }) => Promise<GitBranchesResult>;
  checkout: (opts: {
    cwd: string;
    branch: string;
    create?: boolean;
    startPoint?: string;
  }) => Promise<GitMutationResult>;
  listWorktrees: (opts: { cwd: string }) => Promise<GitWorktreeListResult>;
  addWorktree: (opts: {
    cwd: string;
    worktreePath: string;
    branch?: string;
    newBranch?: string;
    startPoint?: string;
    detach?: boolean;
  }) => Promise<GitWorktreePathResult>;
  removeWorktree: (opts: {
    cwd: string;
    worktreePath: string;
    force?: boolean;
  }) => Promise<GitWorktreePathResult>;
}

export interface WorkspaceFsTreeEntry {
  name: string;
  path: string;
  relativePath: string;
  kind: 'directory' | 'file';
  isSymlink: boolean;
}

export type WorkspaceFsListTreeResult =
  | {
      ok: true;
      rootPath: string;
      relativePath: string;
      entries: WorkspaceFsTreeEntry[];
      truncated: boolean;
    }
  | { ok: false; error: string };

export type WorkspaceFsReadFileResult =
  | {
      ok: true;
      path: string;
      relativePath: string;
      binary: boolean;
      content: string | null;
      size: number;
      truncated: boolean;
      mtimeMs: number;
    }
  | { ok: false; error: string };

export interface WorkspaceFsApi {
  listTree: (opts: {
    rootPath: string;
    relativePath?: string;
    showHidden?: boolean;
  }) => Promise<WorkspaceFsListTreeResult>;
  readFile: (opts: {
    rootPath: string;
    filePath: string;
    maxBytes?: number;
  }) => Promise<WorkspaceFsReadFileResult>;
}

export type AgentLifecycleState = 'idle' | 'working' | 'waiting' | 'done' | 'error';
export type AgentWaitKind = 'permission' | 'question' | 'auth';
export type AgentStatusSource = 'hook' | 'osc7501' | 'title' | 'process';

export interface AgentSubagentStatus {
  id: string;
  state: 'working' | 'waiting' | 'idle';
  title?: string;
  startedAt: number;
}

export interface AgentPaneStatus {
  ptyId: string;
  agentId: string | null;
  state: AgentLifecycleState;
  waitKind?: AgentWaitKind;
  source: AgentStatusSource;
  message?: string;
  toolName?: string;
  toolInput?: string;
  progress?: number;
  subagents: AgentSubagentStatus[];
  unread: boolean;
  stateStartedAt: number;
  updatedAt: number;
}

export type AgentHookCliId = 'claude' | 'antigravity' | 'codex' | 'gemini' | 'qwen' | 'grok';
export type AgentHookInstallState = 'not-installed' | 'installed' | 'outdated' | 'conflict' | 'error';

export interface AgentHookCliStatus {
  cliId: AgentHookCliId;
  label: string;
  configPath: string;
  configExists: boolean;
  state: AgentHookInstallState;
  detail?: string;
}

export interface AgentHooksApi {
  status: () => Promise<{ ok: true; statuses: AgentHookCliStatus[] } | { ok: false; error: string }>;
  install: (opts: {
    cliId: AgentHookCliId;
  }) => Promise<{ ok: true; status: AgentHookCliStatus } | { ok: false; error: string; status?: AgentHookCliStatus }>;
  uninstall: (opts: {
    cliId: AgentHookCliId;
  }) => Promise<{ ok: true; status: AgentHookCliStatus } | { ok: false; error: string; status?: AgentHookCliStatus }>;
}

export interface AgentApi {
  listStatuses: () => Promise<
    { ok: true; statuses: AgentPaneStatus[]; hookPort: number | null } | { ok: false; error: string }
  >;
  getStatus: (opts: {
    ptyId: string;
  }) => Promise<{ ok: true; status: AgentPaneStatus | null } | { ok: false; error: string }>;
  acknowledge: (opts: {
    ptyId: string;
  }) => Promise<{ ok: true; status: AgentPaneStatus | null } | { ok: false; error: string }>;
  reportHook: (opts: {
    ptyId: string;
    provider?: string;
    payload: Record<string, unknown>;
  }) => Promise<{ ok: true; status: AgentPaneStatus } | { ok: false; error: string }>;
  sendPrompt: (opts: {
    ptyId: string;
    prompt: string;
    filePath?: string;
    startLine?: number;
    endLine?: number;
    diffSnippet?: string;
    submit?: boolean;
  }) => Promise<{ ok: true; bytesWritten: number } | { ok: false; error: string }>;
  onStatusChanged: (cb: (status: AgentPaneStatus) => void) => () => void;
  /** Fired when the user clicks a system notification for a pane. */
  onFocusPane?: (cb: (payload: { ptyId: string }) => void) => () => void;
}

export type OrchestrationMessageType =
  | 'status'
  | 'dispatch'
  | 'worker_done'
  | 'merge_ready'
  | 'escalation'
  | 'handoff'
  | 'decision_gate'
  | 'question'
  | 'heartbeat';

export type OrchestrationMessagePriority = 'low' | 'normal' | 'high' | 'urgent';

export type OrchestrationTaskStatus =
  | 'pending'
  | 'ready'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'blocked';

export type OrchestrationDispatchStatus =
  | 'pending'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'circuit_broken';

export type OrchestrationStartObservation =
  | 'pending'
  | 'observed'
  | 'queued'
  | 'permission'
  | 'unobserved'
  | 'unsupported';

export type OrchestrationDispatchStage =
  | 'starting'
  | 'working'
  | 'waiting_permission'
  | 'waiting_input'
  | 'awaiting_review'
  | 'done'
  | 'failed'
  | 'released'
  | 'stopped';

export type WorkerApprovalStatus = 'pending' | 'approved' | 'denied' | 'expired';

export interface WorkerApprovalPayload {
  approvalId: string;
  dispatchId: string;
  taskId: string;
  runId: string;
  workerHandle: string;
  ptyId: string;
  provider: string;
  eventName: string;
  toolName: string;
  toolInput?: string;
  message?: string;
  status: WorkerApprovalStatus;
  createdAt: string;
  resolvedAt?: string | null;
  resolvedBy?: string | null;
  reason?: string | null;
}

export type OrchestrationWorkerReportOutcome =
  | 'completed'
  | 'failed'
  | 'blocked'
  | 'escalated'
  | 'abandoned';

export type OrchestrationGateStatus = 'pending' | 'resolved' | 'timeout';
export type OrchestrationRunStatus = 'active' | 'completed' | 'failed' | 'stopped';
export type OrchestrationCoordinatorStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'completed'
  | 'failed'
  | 'stopped';
export type OrchestrationQuestionStatus = 'pending' | 'answered' | 'closed';

export interface OrchestrationRunRecord {
  id: string;
  objective: string;
  status: OrchestrationRunStatus;
  coordinatorHandle: string;
  coordinatorPaneId: string | null;
  consumerGeneration: number;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
}

export interface OrchestrationDispatchRecord {
  id: string;
  taskId: string;
  runId: string;
  creator: string;
  creatorRunId: string | null;
  creatorDispatchId?: string | null;
  parentPaneId?: string | null;
  depth: number;
  assigneeHandle: string;
  assigneePaneId: string | null;
  processIncarnation: string | null;
  worktreePath?: string | null;
  branch?: string | null;
  ownsWorktree?: boolean;
  ownsPane?: boolean;
  cliId?: string | null;
  model?: string | null;
  effort?: string | null;
  processGeneration?: number;
  stage?: OrchestrationDispatchStage;
  turnStopReportedGeneration?: number | null;
  followUpOfDispatchId?: string | null;
  retained?: boolean;
  releasedAt?: string | null;
  archivedOutput?: string | null;
  status: OrchestrationDispatchStatus;
  failureCount: number;
  lastFailureReason: string | null;
  failureSummary: string | null;
  lastHeartbeatAt: string | null;
  consumerGeneration: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  startObservation?: OrchestrationStartObservation;
  startObservationReason?: string | null;
  turnStartedAt?: string | null;
  promptSentAt?: string | null;
  queuedWorkingBaseline?: number | null;
  staleWarningAt?: string | null;
}

export interface OrchestrationTaskRecord {
  id: string;
  runId: string;
  spec: string;
  taskTitle: string;
  displayName: string;
  deps: string[];
  priority: OrchestrationMessagePriority;
  status: OrchestrationTaskStatus;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OrchestrationTaskWithDispatch extends OrchestrationTaskRecord {
  latestDispatch: OrchestrationDispatchRecord | null;
}

export interface OrchestrationGateRecord {
  id: string;
  taskId: string;
  runId: string;
  requesterDispatchId: string | null;
  requesterHandle: string | null;
  question: string;
  options: string[];
  status: OrchestrationGateStatus;
  resolution: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface OrchestrationMessageRecord {
  id: string;
  runId: string;
  seq: number;
  boardSeq?: number;
  type: OrchestrationMessageType;
  priority: OrchestrationMessagePriority;
  fromHandle: string;
  fromRole?: string;
  toHandle: string;
  mentions?: string[];
  refs?: number[];
  kind?: OrchestrationBoardPostKind;
  subject: string;
  body: string;
  payload: string | null;
  artifacts?: OrchestrationReportArtifacts | null;
  threadId: string | null;
  deliveredAt: string | null;
  read: boolean;
  createdAt: string;
  lifecycleRejectedReason: string | null;
}

export interface OrchestrationReportFollowUp {
  kind: 'send' | 'worker_start';
  dispatchId?: string;
  active?: boolean;
}

export interface OrchestrationExposedMessage {
  id: string;
  runId: string;
  boardSeq?: number;
  type: OrchestrationMessageType;
  priority: OrchestrationMessagePriority;
  fromHandle: string;
  fromRole?: string;
  toHandle: string;
  mentions?: string[];
  refs?: number[];
  kind?: OrchestrationBoardPostKind;
  subject: string;
  body: string;
  payload: string | null;
  artifacts?: OrchestrationReportArtifacts | null;
  threadId: string | null;
  deliveredAt: string | null;
  createdAt: string;
  lifecycleRejectedReason: string | null;
  followUp?: OrchestrationReportFollowUp;
}

export interface OrchestrationQuestionRecord {
  messageId: string;
  runId: string;
  dispatchId: string;
  fromHandle: string;
  toHandle: string;
  question: string;
  options: string[];
  status: OrchestrationQuestionStatus;
  answerBody: string | null;
  answerMessageId: string | null;
  answeredBy: string | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface OrchestrationCoordinatorRunRecord {
  id: string;
  runId: string;
  spec: string;
  status: OrchestrationCoordinatorStatus;
  coordinatorHandle: string;
  pollIntervalMs: number;
  maxConcurrent: number;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export type OrchestrationConfirmMode = 'chat-and-guard' | 'always-ui' | 'auto';
export type OrchestrationPeerMessagingMode = 'controlled-p2p' | 'hub-only';
export type OrchestrationBoardPostKind =
  | 'brief'
  | 'post'
  | 'update'
  | 'handoff'
  | 'question'
  | 'answer'
  | 'report'
  | 'approval'
  | 'stall'
  | 'system';

export interface OrchestrationMemberCursor {
  lastReadSeq: number;
  lastPostSeq: number;
  lastDeliveredSeq: number;
}

export interface OrchestrationReportArtifacts {
  branch?: string | null;
  worktreePath?: string | null;
  headCommit?: string | null;
  changedFiles?: string[];
  changedFileCount?: number;
}

export type OrchestrationTaskKind =
  | 'architecture'
  | 'implementation'
  | 'debug'
  | 'tests'
  | 'review'
  | 'research'
  | 'docs';

export interface OrchestrationAgentProfile {
  enabled?: boolean;
  specialty?: string;
  defaultModel?: string;
  defaultEffort?: string;
}

export interface OrchestrationSettings {
  confirmBeforeDispatch: OrchestrationConfirmMode;
  defaultWorktree: boolean;
  peerMessagingMode?: OrchestrationPeerMessagingMode;
  agentProfiles: Record<string, OrchestrationAgentProfile>;
}

export interface OrchestrationSettingsPatch {
  confirmBeforeDispatch?: OrchestrationConfirmMode;
  defaultWorktree?: boolean;
  peerMessagingMode?: OrchestrationPeerMessagingMode;
  agentProfiles?: Record<string, OrchestrationAgentProfile | null>;
}

export type AgentMcpCliId = 'claude' | 'codex' | 'antigravity' | 'grok' | 'gemini' | 'qwen' | 'opencode';
export type AgentMcpInstallMode = 'launch-arg' | 'config';
export type AgentMcpInstallState =
  | 'launch-managed'
  | 'not-installed'
  | 'installed'
  | 'outdated'
  | 'conflict'
  | 'error';

export interface AgentMcpCliStatus {
  cliId: AgentMcpCliId;
  label: string;
  mode: AgentMcpInstallMode;
  configPath: string;
  state: AgentMcpInstallState;
  detail?: string;
}

export interface OrchestrationIdlePaneInfo {
  ptyId: string;
  cliId: string;
  cwd: string | null;
}

export interface OrchestrationAgentRosterEntry {
  cliId: string;
  label: string;
  command: string;
  installed: boolean;
  enabled: boolean;
  available: boolean;
  specialty: string;
  defaultModel: string | null;
  defaultEffort: string | null;
  hooksInstalled: boolean;
  mcpMode: 'launch-arg' | 'config' | 'cli-fallback';
  mcpReady: boolean;
  idlePanes: OrchestrationIdlePaneInfo[];
}

export interface OrchestrationDispatchProposal {
  id: string;
  coordinatorPaneId: string;
  runId: string | null;
  role: string;
  task: string;
  planSummary: string;
  requestedAgent: string;
  resolvedAgent: string;
  taskKind: OrchestrationTaskKind | null;
  worktree: boolean;
  model: string | null;
  effort: string | null;
  terminal: string | null;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  resolvedAt: string | null;
  reason?: string | null;
}

export interface OrchestrationSnapshot {
  runs: OrchestrationRunRecord[];
  tasks: OrchestrationTaskWithDispatch[];
  dispatches: OrchestrationDispatchRecord[];
  gates: OrchestrationGateRecord[];
  messages: OrchestrationMessageRecord[];
  questions: OrchestrationQuestionRecord[];
  openApprovals?: WorkerApprovalPayload[];
  pendingProposals?: OrchestrationDispatchProposal[];
  orchestrationModePanes?: string[];
  memberCursorsByRun?: Record<string, Record<string, OrchestrationMemberCursor>>;
  coordinatorRuns: OrchestrationCoordinatorRunRecord[];
  activeCoordinatorRun: OrchestrationCoordinatorRunRecord | null;
  currentRunByConsumer: Record<string, string>;
}

export interface OrchestrationEvent {
  reason: string;
  runId?: string;
  updatedAt: string;
  snapshot: OrchestrationSnapshot;
}

export interface OrchestrationPaneSpawnedEvent {
  ptyId: string;
  runId: string;
  taskId: string;
  displayName?: string | null;
  taskTitle?: string;
  dispatchId?: string;
  parentPaneId?: string | null;
  cwd?: string;
  worktreePath?: string | null;
  branch?: string | null;
  cliId?: string;
  ownsWorktree?: boolean;
  ownsPane?: boolean;
}

export interface OrchestrationPaneClosedEvent {
  ptyId: string;
  runId?: string;
  taskId?: string;
  dispatchId?: string;
}

export type OrchestrationTaskShowResult = {
  task: OrchestrationTaskRecord;
  latestDispatch: OrchestrationDispatchRecord | null;
  dispatches: OrchestrationDispatchRecord[];
  gates: OrchestrationGateRecord[];
};

export type OrchestrationCoordinatorStatusResult = {
  running: boolean;
  runId: string | null;
  coordinatorRun: OrchestrationCoordinatorRunRecord | null;
  activeCoordinatorRun: OrchestrationCoordinatorRunRecord | null;
  run: OrchestrationRunRecord | null;
  taskCounts: {
    total: number;
    pending: number;
    ready: number;
    dispatched: number;
    blocked: number;
    completed: number;
    failed: number;
  };
  activeDispatches: number;
  pendingGates: number;
};

export type OrchestrationResult<T extends Record<string, unknown>> =
  | ({ ok: true } & T)
  | { ok: false; code: string; error: string; data?: Record<string, unknown> };

export interface OrchestrationApi {
  getSnapshot: (
    opts?: { runId?: string }
  ) => Promise<OrchestrationResult<{ snapshot: OrchestrationSnapshot }>>;
  runCreate: (opts: {
    id?: string;
    objective: string;
    from?: string;
    paneId?: string;
  }) => Promise<OrchestrationResult<{ run: OrchestrationRunRecord }>>;
  runUse: (opts: {
    id: string;
    from?: string;
    paneId?: string;
  }) => Promise<OrchestrationResult<{ run: OrchestrationRunRecord }>>;
  runCurrent: (
    opts?: { from?: string }
  ) => Promise<OrchestrationResult<{ run: OrchestrationRunRecord | null }>>;
  runList: (
    opts?: { status?: string }
  ) => Promise<OrchestrationResult<{ runs: OrchestrationRunRecord[]; count: number }>>;
  runShow: (opts: {
    id: string;
  }) => Promise<
    OrchestrationResult<{
      run: OrchestrationRunRecord;
      tasks: OrchestrationTaskWithDispatch[];
      gates: OrchestrationGateRecord[];
    }>
  >;
  taskCreate: (opts: {
    id?: string;
    runId?: string;
    from?: string;
    spec: string;
    taskTitle?: string;
    displayName?: string;
    deps?: string[];
    priority?: OrchestrationMessagePriority;
    worktreePath?: string;
  }) => Promise<OrchestrationResult<{ task: OrchestrationTaskRecord }>>;
  taskList: (opts?: {
    runId?: string;
    from?: string;
    status?: OrchestrationTaskStatus;
    priority?: OrchestrationMessagePriority;
  }) => Promise<OrchestrationResult<{ tasks: OrchestrationTaskWithDispatch[]; count: number }>>;
  taskShow: (opts: {
    id: string;
  }) => Promise<OrchestrationResult<OrchestrationTaskShowResult>>;
  taskUpdate: (opts: {
    id: string;
    status: OrchestrationTaskStatus;
  }) => Promise<OrchestrationResult<{ task: OrchestrationTaskRecord }>>;
  dispatch: (opts: {
    taskId: string;
    to?: string;
    from?: string;
    inject?: boolean;
    dryRun?: boolean;
  }) => Promise<
    OrchestrationResult<{
      dispatch: OrchestrationDispatchRecord | null;
      injected: boolean;
      dryRun?: boolean;
      preamble?: string;
    }>
  >;
  dispatchShow: (opts: {
    taskId: string;
    preamble?: boolean;
  }) => Promise<OrchestrationResult<{ dispatch: OrchestrationDispatchRecord | null; preamble?: string }>>;
  coordinatorStart: (opts?: {
    runId?: string;
    spec?: string;
    from?: string;
    pollIntervalMs?: number;
    maxConcurrent?: number;
    autoSpawnWorkers?: boolean;
    workerCliId?: string;
    cwd?: string;
    /** Existing panes the coordinator may use; omit to allow any idle agent pane. */
    workerPaneIds?: string[];
  }) => Promise<
    OrchestrationResult<{
      coordinatorRun: OrchestrationCoordinatorRunRecord;
      runId: string;
      status: 'running';
    }>
  >;
  coordinatorStop: () => Promise<
    OrchestrationResult<{ runId: string; coordinatorRunId: string; stopped: boolean }>
  >;
  coordinatorTick: (
    opts?: { runId?: string; workerPaneIds?: string[] }
  ) => Promise<OrchestrationResult<{ converged: boolean; runId: string }>>;
  coordinatorStatus: (
    opts?: { runId?: string }
  ) => Promise<OrchestrationResult<OrchestrationCoordinatorStatusResult>>;
  send: (opts: {
    from?: string;
    to: string;
    type?: OrchestrationMessageType;
    priority?: OrchestrationMessagePriority;
    subject: string;
    body?: string;
    payload?: string | Record<string, unknown> | null;
    runId?: string;
    threadId?: string;
  }) => Promise<
    OrchestrationResult<{
      message: OrchestrationExposedMessage;
      messages?: OrchestrationExposedMessage[];
      recipients?: string[];
    }>
  >;
  workerDone: (opts: {
    from?: string;
    taskId?: string;
    dispatchId?: string;
    outcome?: OrchestrationWorkerReportOutcome;
    summary?: string;
  }) => Promise<
    OrchestrationResult<{
      message: OrchestrationExposedMessage;
      task: OrchestrationTaskRecord;
      dispatch: OrchestrationDispatchRecord;
    }>
  >;
  workerStart?: (opts: {
    from?: string;
    runId?: string;
    taskId?: string;
    spec?: string;
    taskTitle?: string;
    deps?: string[];
    priority?: OrchestrationMessagePriority;
    cliId?: string;
    agent?: string;
    model?: string;
    effort?: string;
    terminal?: string;
    worktree?: string | boolean;
    noWorktree?: boolean;
    branch?: string;
    baseBranch?: string;
    name?: string;
    cwd?: string;
    callerCwd?: string;
    keepOpen?: boolean;
  }) => Promise<
    OrchestrationResult<{
      dispatch: OrchestrationDispatchRecord;
      task: OrchestrationTaskRecord;
      run: OrchestrationRunRecord;
      ptyId: string;
      worktreePath: string | null;
      branch: string | null;
      ownsWorktree: boolean;
      ownsPane: boolean;
    }>
  >;
  workerList?: (opts?: {
    runId?: string;
    from?: string;
    parent?: string;
    status?: OrchestrationDispatchStatus;
    stage?: OrchestrationDispatchStage;
    includeReleased?: boolean;
  }) => Promise<OrchestrationResult<{ dispatches: OrchestrationDispatchRecord[]; count: number }>>;
  workerShow?: (opts: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
  }) => Promise<
    OrchestrationResult<{
      dispatch: OrchestrationDispatchRecord;
      task: OrchestrationTaskRecord | null;
      openApprovals: WorkerApprovalPayload[];
    }>
  >;
  workerRead?: (opts: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    cursor?: number;
    limit?: number;
    screen?: boolean;
  }) => Promise<
    OrchestrationResult<{
      ptyId: string;
      dispatchId: string;
      screen: boolean;
      text: string;
      cursor: number;
      nextCursor: number;
      hasMore: boolean;
      alive: boolean;
      archived: boolean;
    }>
  >;
  workerKeepOpen?: (opts: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    keepOpen?: boolean;
  }) => Promise<OrchestrationResult<{ dispatch: OrchestrationDispatchRecord; retained: boolean }>>;
  workerRelease?: (opts: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    keepPane?: boolean;
    keepWorktree?: boolean;
    force?: boolean;
  }) => Promise<
    OrchestrationResult<{
      dispatch: OrchestrationDispatchRecord;
      closedPane: boolean;
      removedWorktree: boolean;
    }>
  >;
  workerStop?: (opts: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    reason?: string;
    removeWorktree?: boolean;
    force?: boolean;
  }) => Promise<
    OrchestrationResult<{
      dispatch: OrchestrationDispatchRecord;
      closedPane: boolean;
      removedWorktree: boolean;
    }>
  >;
  workerAbandon?: (opts: {
    dispatchId?: string;
    worker?: string;
    taskId?: string;
    reason?: string;
  }) => Promise<
    OrchestrationResult<{
      dispatch: OrchestrationDispatchRecord;
      task: OrchestrationTaskRecord;
      warning: string;
    }>
  >;
  reset?: (opts: {
    all?: boolean;
    tasks?: boolean;
    messages?: boolean;
  }) => Promise<
    OrchestrationResult<{
      reset: 'all' | 'tasks' | 'messages';
      removed: {
        runs: number;
        tasks: number;
        dispatches: number;
        gates: number;
        messages: number;
      };
    }>
  >;
  approve?: (opts: {
    id: string;
    dispatchId?: string;
    from?: string;
    reason?: string;
    updatedInput?: Record<string, unknown>;
  }) => Promise<OrchestrationResult<{ approval: WorkerApprovalPayload }>>;
  deny?: (opts: {
    id: string;
    dispatchId?: string;
    from?: string;
    reason?: string;
  }) => Promise<OrchestrationResult<{ approval: WorkerApprovalPayload }>>;
  check: (opts?: {
    from?: string;
    runId?: string;
    unread?: boolean;
    peek?: boolean;
    all?: boolean;
    wait?: boolean;
    timeoutMs?: number;
    types?: OrchestrationMessageType[];
    ack?: string;
    holdAck?: boolean;
    format?: boolean;
    requestId?: string;
  }) => Promise<
    OrchestrationResult<{
      mailbox: string;
      runId?: string;
      dispatchId?: string;
      deliveryId: string | null;
      acknowledged: string | null;
      replayed: boolean;
      messages: OrchestrationExposedMessage[];
      count: number;
      timedOut: boolean;
      cancelled: boolean;
      connectionLost: boolean;
      formatted?: string;
    }>
  >;
  inbox: (opts?: {
    from?: string;
    runId?: string;
    limit?: number;
    types?: OrchestrationMessageType[];
    unreadOnly?: boolean;
  }) => Promise<
    OrchestrationResult<{
      mailbox: string;
      messages: OrchestrationExposedMessage[];
      count: number;
    }>
  >;
  ask: (opts: {
    from?: string;
    to?: string;
    question?: string;
    options?: string[];
    wait?: boolean;
    timeoutMs?: number;
    resume?: string;
    dispatchId?: string;
    runId?: string;
    requestId?: string;
  }) => Promise<
    OrchestrationResult<{
      messageId: string;
      threadId: string;
      answer: string | null;
      answerMessageId?: string | null;
      pending: boolean;
      timedOut: boolean;
      cancelled: boolean;
      connectionLost: boolean;
    }>
  >;
  cancelWait: (opts: { requestId: string }) => Promise<OrchestrationResult<{ cancelled: boolean }>>;
  reply: (opts: {
    id: string;
    body: string;
    from?: string;
  }) => Promise<
    OrchestrationResult<{
      message: OrchestrationExposedMessage;
      question?: OrchestrationQuestionRecord;
      duplicate?: boolean;
    }>
  >;
  gateCreate: (opts: {
    taskId: string;
    question: string;
    options?: string[];
    from?: string;
  }) => Promise<OrchestrationResult<{ gate: OrchestrationGateRecord }>>;
  gateResolve: (opts: {
    id: string;
    resolution: string;
  }) => Promise<OrchestrationResult<{ gate: OrchestrationGateRecord }>>;
  gateList: (opts?: {
    runId?: string;
    taskId?: string;
    status?: OrchestrationGateStatus;
  }) => Promise<OrchestrationResult<{ gates: OrchestrationGateRecord[]; count: number }>>;
  setPaneMode?: (opts: {
    ptyId: string;
    enabled: boolean;
  }) => Promise<OrchestrationResult<{ ptyId: string; enabled: boolean }>>;
  listAgents?: (opts?: {
    callerPaneId?: string;
  }) => Promise<OrchestrationResult<{ agents: OrchestrationAgentRosterEntry[] }>>;
  delegateTask?: (opts: {
    from?: string;
    runId?: string;
    role?: string;
    task: string;
    agent?: string;
    taskKind?: OrchestrationTaskKind;
    worktree?: boolean;
    model?: string;
    effort?: string;
    terminal?: string;
    callerCwd?: string;
    userInitiated?: boolean;
    confirmed?: boolean;
    planSummary?: string;
    requestId?: string;
  }) => Promise<
    OrchestrationResult<{
      status: 'started' | 'confirmation_required' | 'rejected';
      role?: string;
      agent?: string;
      selectionReason?: string;
      fallbackFrom?: string | null;
      message?: string;
      dispatch?: OrchestrationDispatchRecord;
      task?: OrchestrationTaskRecord;
      run?: OrchestrationRunRecord;
      ptyId?: string;
      worktreePath?: string | null;
      branch?: string | null;
      proposal?: OrchestrationDispatchProposal;
    }>
  >;
  proposalApprove?: (opts: {
    id: string;
    agent?: string;
    worktree?: boolean;
    model?: string | null;
    effort?: string | null;
  }) => Promise<
    OrchestrationResult<{
      proposal: OrchestrationDispatchProposal;
      dispatch?: OrchestrationDispatchRecord;
      task?: OrchestrationTaskRecord;
      run?: OrchestrationRunRecord;
      ptyId?: string;
      worktreePath?: string | null;
      branch?: string | null;
    }>
  >;
  proposalReject?: (opts: {
    id: string;
    reason?: string;
  }) => Promise<OrchestrationResult<{ proposal: OrchestrationDispatchProposal }>>;
  boardPost?: (opts: {
    runId?: string;
    text: string;
    kind?: OrchestrationBoardPostKind;
    subject?: string;
  }) => Promise<
    OrchestrationResult<{
      post: OrchestrationExposedMessage;
      boardSeq: number;
      headSeq: number;
      woke: string[];
      escalatedToCoordinator?: boolean;
    }>
  >;
  boardRead?: (opts?: {
    runId?: string;
    since?: number;
    seqs?: number[];
    limit?: number;
  }) => Promise<
    OrchestrationResult<{
      runId: string;
      headSeq: number;
      lastReadSeq: number;
      posts: OrchestrationExposedMessage[];
      formatted: string;
      teamSummary: string;
    }>
  >;
  onEvent: (cb: (event: OrchestrationEvent) => void) => () => void;
  onPaneSpawned: (cb: (event: OrchestrationPaneSpawnedEvent) => void) => () => void;
  onPaneClosed: (cb: (event: OrchestrationPaneClosedEvent) => void) => () => void;
}

export interface TerminalRestoreEvent {
  ptyId: string;
  sequence?: number;
  exitCode?: number | null;
  exited?: boolean;
  replay: string;
  screenSnapshot?: TerminalScreenSnapshot;
}

export interface TerminalScreenSnapshot {
  snapshotAnsi: string;
  scrollbackAnsi?: string;
  rehydrateSequences?: string;
  pendingEscapeTailAnsi?: string;
  frameRestoreAnsi?: string;
  cwd?: string | null;
  modes?: {
    alternateScreen?: boolean;
  };
  cols: number;
  rows: number;
  lastTitle?: string;
}

export type PersistedPaneLayoutNode =
  | { type: 'leaf'; id: string }
  | {
      type: 'split';
      direction: 'horizontal' | 'vertical';
      ratio: number;
      first: PersistedPaneLayoutNode;
      second: PersistedPaneLayoutNode;
    };

export interface PersistedPaneMeta {
  id: string;
  cwd?: string;
  title?: string;
  localCliId?: string;
  shellId?: string;
}

export interface PersistedWorkspaceState {
  version: 1;
  windows: Array<{
    id: string;
    type: 'activity' | 'terminal' | 'file' | 'browser';
    title: string;
    workerId?: string;
    localCliId?: string;
    shellId?: string;
    cwd?: string;
    filePath?: string;
    browserTabId?: string;
    activeLeafId?: string;
    splitTree?: PersistedPaneLayoutNode;
    panes?: Record<string, PersistedPaneMeta>;
  }>;
  activeWindowId: string | null;
}

declare global {
  interface Window {
    vibeMeet: VibeMeetApi;
  }
}
