import { SessionCreateMenu } from './SessionCreateMenu';
import { useSyncExternalStore, type ReactNode } from 'react';
import { Activity, Globe, Terminal, FileText, X, SquareArrowOutUpRight, MessagesSquare } from 'lucide-react';
import type { StageWindow, StageWindowType, StageWindowOptions } from '../lib/stage-window-store';
import { terminalSessionStore } from '../lib/terminal-session-store';
import { TerminalProfileIcon } from './TerminalProfileIcon';

interface StageTabBarProps {
  windows: StageWindow[];
  activeWindowId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCreate: (type: StageWindowType, opts?: StageWindowOptions) => void;
  onPopOut?: (id: string) => void;
  localOnly?: boolean;
  /** Extra status shown after a tab title (e.g. agent lifecycle). */
  renderTabBadge?: (win: StageWindow) => ReactNode;
  /** Shows the folder's past Codex conversations; without it the menu does not offer them. */
  onOpenHistory?: () => void;
}

const ACTIVITY_TAB_ID = 'activity-default';
const PHASE_LABELS = { starting: '启动中', running: '运行中', exited: '已退出', error: '错误', closing: '关闭中' };

const ICON_MAP: Record<StageWindowType, typeof Globe> = {
  activity: Activity,
  browser: Globe,
  terminal: Terminal,
  file: FileText,
  'agent-session': MessagesSquare,
};

export function StageTabBar({
  windows,
  activeWindowId,
  onSelect,
  onClose,
  onCreate,
  onPopOut,
  localOnly = false,
  renderTabBadge,
  onOpenHistory,
}: StageTabBarProps) {
  useSyncExternalStore(terminalSessionStore.subscribe, terminalSessionStore.getSnapshot);

  return (
    <div className="stage-tab-bar">
      <div className="stage-tab-list" role="tablist" aria-label="工作区标签页">
        {windows.map((win) => {
          const Icon = ICON_MAP[win.type];
          const isActivity = win.id === ACTIVITY_TAB_ID;
          const isSession = win.type === 'agent-session';
          const state = win.localCliId && !isSession ? terminalSessionStore.getState(win.id) : null;
          return (
            <div
              key={win.id}
              className={`stage-tab ${win.id === activeWindowId ? 'stage-tab-active' : ''}`}
              onClick={() => onSelect(win.id)}
              role="tab"
              aria-selected={win.id === activeWindowId}
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
                  event.preventDefault();
                  onSelect(win.id);
                }
              }}
            >
              <span className="stage-tab-icon">
                {win.localCliId ? <TerminalProfileIcon id={win.localCliId === 'shell' ? win.shellId : win.localCliId} size={14} /> : <Icon size={14} />}
              </span>
              <span className="stage-tab-title">{win.title}</span>
              {renderTabBadge?.(win)}
              {isSession && <span className="stage-tab-status is-session" title="无头 Worker 会话">会话</span>}
              {state && <span className={`stage-tab-status is-${state.error ? 'error' : state.phase}`}
                aria-label={state.error ? '错误' : PHASE_LABELS[state.phase]}
                title={state.error ?? (state.phase === 'exited' ? `退出码：${state.exitCode ?? '未知'}` : PHASE_LABELS[state.phase])}>
                {state.error ? '错误' : PHASE_LABELS[state.phase]}
              </span>}
              {!isActivity && !win.localCliId && onPopOut && (
                <button
                  type="button"
                  className="stage-tab-popout"
                  onClick={(e) => { e.stopPropagation(); onPopOut(win.id); }}
                  aria-label="独立窗口打开"
                  title="在新窗口中打开"
                >
                  <SquareArrowOutUpRight size={11} />
                </button>
              )}
              {!isActivity && (
                <button
                  type="button"
                  className="stage-tab-close"
                  onClick={(e) => { e.stopPropagation(); onClose(win.id); }}
                  aria-label="关闭"
                >
                  <X size={12} />
                </button>
              )}
            </div>
          );
        })}
      </div>

      <SessionCreateMenu onCreate={onCreate} localOnly={localOnly} onOpenHistory={onOpenHistory} />
    </div>
  );
}
