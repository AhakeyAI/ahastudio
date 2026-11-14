import { app, BrowserWindow, nativeTheme, protocol, screen, session } from 'electron';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHookServer } from './agent/agent-hook-server.js';
import { AgentStatusStore } from './agent/agent-status-store.js';
import { registerAgentIpc } from './ipc/agent.js';
import { registerAgentHooksIpc } from './ipc/agent-hooks.js';
import { registerAsrIpc } from './ipc/asr.js';
import type { IpcContext } from './ipc/context.js';
import { registerDesktopIpc } from './ipc/desktop.js';
import { registerDialogIpc } from './ipc/dialog.js';
import { registerGitIpc } from './ipc/git.js';
import { registerSettingsIpc } from './ipc/settings.js';
import { registerSettingsWindowIpc } from './ipc/settings-window.js';
import { registerShellPtyIpc } from './ipc/shell-pty.js';
import { LOCAL_CLI_IDS } from './local-cli.js';
import { registerWorkspaceFsIpc } from './ipc/workspace-fs.js';
import { getPtyHost } from './pty-host.js';
import {
  buildRendererSecurityHeaders,
  resolveAppAssetPath,
  themeBackgroundColor,
} from './renderer-security.js';
import { flushSettingsWrites } from './store.js';
import { getDefaultWorkspaceStateStore } from './persistence/workspace-state-store.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const DIST_DIR = join(APP_ROOT, 'dist');
const PRELOAD_PATH = join(__dirname, 'preload.cjs');
const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const DEV_ORIGIN = DEV_SERVER_URL ? new URL(DEV_SERVER_URL).origin : null;

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: false,
    },
  },
]);

if (process.platform === 'linux') {
  app.disableHardwareAcceleration();
}

try {
  const marker = join(app.getPath('userData'), '.gpu-init-marker');
  if (existsSync(marker)) {
    app.disableHardwareAcceleration();
  }
  mkdirSync(app.getPath('userData'), { recursive: true });
  writeFileSync(marker, String(Date.now()), 'utf8');
  app.once('browser-window-created', () => {
    setTimeout(() => {
      try { unlinkSync(marker); } catch { /* ignore */ }
    }, 5000).unref();
  });
} catch { /* non-fatal */ }

let mainWindow: BrowserWindow | null = null;
let currentCwd: string | undefined;
let agentHookServer: AgentHookServer | null = null;
let disposeAgentIpc: (() => void) | null = null;
let disposeOrchestration: (() => void) | null = null;

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.cjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function isTrustedRendererUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.origin === 'app://bundle') return true;
    if (DEV_ORIGIN && parsed.origin === DEV_ORIGIN) return true;
  } catch { /* invalid URL -> untrusted */ }
  return false;
}

function registerAppProtocol(): void {
  const securityHeaders = buildRendererSecurityHeaders({
    isDev: Boolean(DEV_SERVER_URL),
    devServerUrl: DEV_SERVER_URL,
  });

  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (!isTrustedRendererUrl(details.url)) {
      callback({ responseHeaders: details.responseHeaders });
      return;
    }
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        ...securityHeaders,
      },
    });
  });

  protocol.handle('app', (request) => {
    const resolved = resolveAppAssetPath(DIST_DIR, request.url);
    if (!resolved) {
      return new Response('Forbidden', { status: 403 });
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      return new Response('Not found', { status: 404 });
    }
    const body = readFileSync(resolved);
    const mime = MIME_TYPES[extname(resolved).toLowerCase()] ?? 'application/octet-stream';
    const headers = new Headers({ 'content-type': mime });
    for (const [k, vals] of Object.entries(securityHeaders)) {
      if (vals.length > 0) headers.set(k, vals.join(', '));
    }
    return new Response(body, { status: 200, headers });
  });
}

function installSecurityGuards(win: BrowserWindow): void {
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, targetUrl) => {
    if (isTrustedRendererUrl(targetUrl)) return;
    event.preventDefault();
  });
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    title: 'AhaStation Local CLI',
    backgroundColor: themeBackgroundColor(nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  installSecurityGuards(win);
  mainWindow = win;

  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null;
  });

  if (DEV_SERVER_URL) {
    void win.loadURL(DEV_SERVER_URL);
  } else {
    void win.loadURL('app://bundle/index.html');
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    } else if (app.isReady()) {
      createWindow();
    }
  });
}

app.whenReady().then(async () => {
  registerAppProtocol();

  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
    if (permission === 'media') {
      return isTrustedRendererUrl(requestingOrigin);
    }
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((wc, permission, callback) => {
    if (permission === 'media') {
      callback(isTrustedRendererUrl(wc.getURL()));
      return;
    }
    callback(false);
  });

  const agentStatusStore = new AgentStatusStore();
  agentHookServer = new AgentHookServer(agentStatusStore);
  agentHookServer.setEndpointFile(join(app.getPath('userData'), 'agent-hook-endpoint.json'));
  try {
    const { createOrchestrationBinShim } = await import(
      './orchestration/orchestration-bin-shim.js'
    );
    const binShim = createOrchestrationBinShim({
      binDir: join(app.getPath('userData'), 'orchestration-bin'),
    });
    agentHookServer.setOrchestrationBinShim(binShim);
  } catch (error) {
    console.warn('[orchestration] failed to initialize CLI bin shim:', error);
  }
  try {
    await agentHookServer.start();
  } catch (error) {
    console.warn('[agent-hooks] loopback server failed to start:', error);
  }

  const ipcCtx: IpcContext = {
    liveWindow: () => (mainWindow && !mainWindow.isDestroyed() ? mainWindow : null),
    getCurrentCwd: () => currentCwd,
    daemon: {
      dataDir: join(app.getPath('userData'), 'terminal-daemon'),
      runtimePath: process.execPath,
    },
    userDataDir: () => app.getPath('userData'),
    agentStatusStore,
    agentHookEnv: (ptyId) => agentHookServer?.envForPane(ptyId) ?? { AHA_TERMINAL_ID: ptyId },
  };

  const shellPtyCtrl = registerShellPtyIpc(ipcCtx);
  disposeAgentIpc = registerAgentIpc(ipcCtx, {
    store: agentStatusStore,
    hookServer: agentHookServer,
    sendInput: shellPtyCtrl.sendInput,
  }).dispose;

  const { OrchestrationStore } = await import('./orchestration/orchestration-store.js');
  const { OrchestrationService } = await import('./orchestration/orchestration-service.js');
  const { dispatchOrchestrationHttpAction } = await import(
    './orchestration/orchestration-http-router.js'
  );
  const { registerOrchestrationIpc } = await import('./ipc/orchestration.js');

  const isLocalCliId = (id: string) => (LOCAL_CLI_IDS as readonly string[]).includes(id);
  const orchestrationStore = OrchestrationStore.forUserDataDir(() => app.getPath('userData'));
  const orchestrationService = new OrchestrationService({
    store: orchestrationStore,
    agentStatusStore,
    writePty: shellPtyCtrl.sendInput,
    spawnWorkerPty: async ({ cliId, cwd }) => {
      if (!cliId || !isLocalCliId(cliId)) {
        throw new Error(`Worker CLI must be an agent CLI: ${cliId ?? '(none)'}`);
      }
      // The dispatch prompt is typed as soon as this resolves; let the agent UI start first.
      return shellPtyCtrl.createPty({ cliId, cwd, waitForReady: { quietMs: 1_500, maxMs: 20_000 } });
    },
    isAgentCliId: isLocalCliId,
    turnStartObserveTimeoutMs: 2_000,
    startConfirmationTimeoutMs: 60_000,
    heartbeatTimeoutMs: 300_000,
    staleWarningTimeoutMs: 900_000,
    staleSweepIntervalMs: 15_000,
  });
  ipcCtx.orchestrationService = orchestrationService;
  agentHookServer.setOrchestrationHandler((action, payload, context) =>
    dispatchOrchestrationHttpAction(orchestrationService, action, payload, context)
  );
  const orchestrationIpc = registerOrchestrationIpc(ipcCtx);
  const offPtyExit = shellPtyCtrl.onPtyExit((ptyId) => {
    orchestrationService.markPtyExited(ptyId);
  });
  disposeOrchestration = () => {
    offPtyExit();
    orchestrationIpc.dispose();
    orchestrationService.dispose();
  };
  registerAgentHooksIpc();
  registerGitIpc(ipcCtx);
  registerWorkspaceFsIpc(ipcCtx);
  registerDialogIpc(ipcCtx);
  registerAsrIpc();
  registerSettingsIpc();
  registerSettingsWindowIpc();
  registerDesktopIpc();

  const broadcastDisplayChanged = () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('display:changed');
      }
    }
  };
  screen.on('display-metrics-changed', broadcastDisplayChanged);
  screen.on('display-added', broadcastDisplayChanged);
  screen.on('display-removed', broadcastDisplayChanged);

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('before-quit', () => {
  try {
    disposeOrchestration?.();
    disposeOrchestration = null;
  } catch { /* ignore */ }
  try {
    disposeAgentIpc?.();
    disposeAgentIpc = null;
  } catch { /* ignore */ }
  try {
    void agentHookServer?.stop();
    agentHookServer = null;
  } catch { /* ignore */ }
  try {
    getPtyHost().killAll();
  } catch { /* ignore */ }
  try {
    getDefaultWorkspaceStateStore(() => app.getPath('userData')).flushSync();
  } catch (error) {
    console.error('[workspace-state] flush on quit failed:', error);
  }
  flushSettingsWrites();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
