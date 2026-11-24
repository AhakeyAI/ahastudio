import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../src/styles.css';
import '../../src/aha-tokens.css';
import '../../src/aha-ui.css';
import { LocalTerminalWorkspace } from '../../src/components/LocalTerminalWorkspace';
import { stageWindowStore } from '../../src/lib/stage-window-store';

const fixture = await window.handoffFixture.setup();
localStorage.setItem('aha.terminal.directories', JSON.stringify([fixture.coordinatorDir, fixture.workerDir]));
localStorage.setItem('aha.terminal.cwd', fixture.coordinatorDir);
await stageWindowStore.createWindow('agent-session', {
  workerId: fixture.coordinator, cwd: fixture.coordinatorDir, title: '离线协调者', activate: false,
});
await stageWindowStore.createWindow('agent-session', {
  workerId: fixture.worker, dispatchId: fixture.dispatch, cwd: fixture.workerDir, title: '交接验收 Worker',
});
createRoot(document.getElementById('root')!).render(<LocalTerminalWorkspace />);
