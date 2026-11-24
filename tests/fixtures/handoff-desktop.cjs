// Run with the project's Electron executable after build:electron. All state lives in a temporary profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const { mkdtempSync, mkdirSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const assert = require('node:assert/strict');
const root = mkdtempSync(join(tmpdir(), 'aha-handoff-ui-'));
app.setPath('userData', root);
app.disableHardwareAcceleration();
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  const { createServer } = await import('vite');
  const { OrchestrationStore } = await import('../../dist-electron/orchestration/orchestration-store.js');
  const { OrchestrationService } = await import('../../dist-electron/orchestration/orchestration-service.js');
  const { AgentStatusStore } = await import('../../dist-electron/agent/agent-status-store.js');
  const coordinator = 'agent-session-00000000-0000-0000-0000-000000000001';
  const coordinatorDir = join(root, 'project');
  const workerDir = join(root, 'worker');
  mkdirSync(coordinatorDir); mkdirSync(workerDir);
  const store = OrchestrationStore.forUserDataDir(() => root);
  const service = new OrchestrationService({
    store, agentStatusStore: new AgentStatusStore(), getDefaultCwd: () => workerDir,
    getConfirmMode: () => 'auto', spawnWorkerPty: async () => { throw Error('Unexpected PTY'); },
    writePty: async () => { throw Error('Unexpected PTY input'); },
    codexPilot: { enabled: () => true, launch: () => ({
      alive: true, busy: false, open: async () => 'offline-thread',
      startTurn: async () => ({ status: 'accepted', turnId: 'offline-turn' }),
      close: async () => {}, read: () => null, redactText: text => text,
    }) },
  });
  service.setSessionCoordinators({ get: id => id === coordinator ? { active: true, idle: true, cwd: coordinatorDir, provider: 'codex' } : null });
  const run = service.runCreate({ from: coordinator, paneId: coordinator, objective: '离线交接验收' }).run;
  const launched = await service.delegateTask({ runId: run.id, from: coordinator, callerPaneId: coordinator,
    role: 'offline', task: '离线检查', agent: 'codex', worktree: false, userInitiated: true, callerCwd: workerDir });
  assert.equal(launched.status, 'started');
  store.updateDispatchStage(launched.dispatch.id, 'awaiting_review');
  const info = { id: coordinator, provider: 'codex', title: '离线协调者', status: 'idle', cwd: coordinatorDir,
    orchestration: true, policy: 'read-only', pendingQuestions: [], queued: [], goal: null, createdAt: Date.now() };
  ipcMain.handle('fixture:setup', () => ({ coordinator, coordinatorDir, workerDir, info, worker: launched.dispatch.assigneeHandle, dispatch: launched.dispatch.id }));
  ipcMain.handle('fixture:snapshot', () => ({ ok: true, snapshot: service.getSnapshot() }));
  ipcMain.handle('fixture:clear', (_, opts) => ({ ok: true, ...service.reset(opts) }));
  const server = await createServer({ server: { port: 0, host: '127.0.0.1' }, logLevel: 'error' });
  let win;
  try {
    await server.listen();
    win = new BrowserWindow({ show: false, webPreferences: { preload: join(__dirname, 'handoff-preload.cjs'), contextIsolation: true, sandbox: true } });
    win.webContents.on('console-message', (_, level, message) => { if (level >= 2) console.error(message); });
    win.webContents.on('dom-ready', () => win.webContents.executeJavaScript("window.addEventListener('error', e => console.error(e.error?.stack))"));
    await win.loadURL('http://127.0.0.1:' + server.httpServer.address().port + '/tests/fixtures/handoff-workspace.html');
    const evaluate = script => win.webContents.executeJavaScript(script);
    async function until(script) {
      for (let n = 0; n < 200; n++) {
        if (await evaluate(script)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw Error('Missing expected state: ' + script + '\n' + await evaluate('document.body.innerText'));
    }
    const button = label => `[...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(label)})`;
    const workerTab = `[...document.querySelectorAll('button')].find(b => b.innerText.includes('交接验收 Worker'))`;
    await until(workerTab + ' !== undefined');
    await evaluate(workerTab + '.click()');
    await until(button('回到主对话处理') + ' !== undefined');
    await evaluate(button('回到主对话处理') + '.click()');
    await until('localStorage.getItem("aha.terminal.cwd") === ' + JSON.stringify(coordinatorDir));
    await until(button('待核对 1') + ' !== undefined');
    const otherFolder = `[...document.querySelectorAll('.terminal-directory-row button')].find(b => b.title === ${JSON.stringify(workerDir)})`;
    await evaluate(otherFolder + '.click()');
    await until('localStorage.getItem("aha.terminal.cwd") === ' + JSON.stringify(workerDir));
    await evaluate(`window.dispatchEvent(new CustomEvent('aha:open-orchestration-board', {detail: {runId: ${JSON.stringify(run.id)}, coordinator: true}}))`);
    await until('localStorage.getItem("aha.terminal.cwd") === ' + JSON.stringify(coordinatorDir));
    await until(button('待核对 1') + ' !== undefined');
    await evaluate(button('待核对 1') + '.click()');
    await until('document.querySelector(".obp-run-title")?.textContent === "离线交接验收"');
    await service.workerDoneByPane(launched.dispatch.assigneeHandle, { outcome: 'completed', summary: '离线检查完成' });
    store.updateRunIntegrationState(run.id, { integrationStatus: 'active', integrationBranch: 'aha/run/offline', integrationBaseBranch: 'main' });
    store.updateRunStatus(run.id, 'completed');
    win.webContents.send('fixture:changed', { reason: 'offline:completed', snapshot: service.getSnapshot(), updatedAt: new Date().toISOString() });
    await until('document.body.innerText.includes("待合回 main")');
    await evaluate('document.querySelector("[aria-label=清理历史协作记录]").click()');
    await until('document.body.innerText.includes("集成分支尚未交付")');
    assert.ok(store.getRun(run.id));
    console.log('PASS: offline dispatch, cross-folder Coordinator, selected Run, delivery location and protected history');
  } finally {
    win?.destroy(); await server.close(); service.dispose();
  }
}).then(() => app.exit(0), error => { console.error(error); app.exit(1); });
app.once('quit', () => { try { rmSync(root, { recursive: true, force: true }); } catch {} });
