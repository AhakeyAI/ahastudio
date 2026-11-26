import { agentSessionClient } from './agent-session-client';
import { stageWindowStore, type StageWindowOptions, type StageWindowType } from './stage-window-store';

/** Both create menus use this entry point; the caller owns the target folder. */
export async function createWorkspaceSession(
  type: StageWindowType,
  opts: StageWindowOptions | undefined,
  folder: string | undefined,
  onError: (message: string) => void,
) {
  const cwd = folder ?? opts?.cwd;
  if (type !== 'agent-session') {
    return stageWindowStore.createWindow(type, { ...opts, cwd });
  }
  const provider = (['codex', 'antigravity', 'grok', 'opencode', 'pi'] as const)
    .find((id) => id === opts?.localCliId) ?? 'codex';
  try {
    const res = await agentSessionClient.create({ ...(cwd ? { cwd } : {}), provider, policy: 'workspace-write' });
    if (!res.ok) return onError(res.error);
    return await stageWindowStore.createWindow('agent-session', {
      ...opts, cwd: res.session.cwd, workerId: res.session.id,
    });
  } catch (error) {
    onError(error instanceof Error ? error.message : String(error));
  }
}
