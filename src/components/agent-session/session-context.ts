import { createContext, useContext } from 'react';
import type { CodeHighlightAppearance } from '../../lib/code-syntax-highlight';

export interface AgentSessionContextValue {
  /** Directory that relative file links and changed-file paths resolve against. */
  cwd: string | null;
  /** Picks the syntax theme for code blocks and diffs. */
  appearance: CodeHighlightAppearance;
  onNotify?: (message: string) => void;
}

export const AgentSessionContext = createContext<AgentSessionContextValue>({ cwd: null, appearance: 'light' });

export const useAgentSession = () => useContext(AgentSessionContext);

/** Same path as terminal links: the main process validates the target, then opens or reveals it. */
export async function openSessionTarget(target: string, session: AgentSessionContextValue): Promise<void> {
  const openLink = window.vibeMeet?.shellPty?.openLink;
  if (!openLink) {
    session.onNotify?.('当前环境不支持打开链接');
    return;
  }
  try {
    const res = await openLink({ target, ...(session.cwd ? { cwd: session.cwd } : {}) });
    if (!res.ok) session.onNotify?.(res.error ?? `无法打开：${target}`);
  } catch (error) {
    session.onNotify?.(error instanceof Error ? error.message : `无法打开：${target}`);
  }
}
