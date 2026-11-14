import { useEffect, useRef, useState } from 'react';
import { Columns2, Rows2, X } from 'lucide-react';
import type { StagePaneMeta } from '../lib/stage-window-store';
import {
  clampSplitRatio,
  type PaneLayoutNode,
  type SplitDirection,
  type SplitNodePath,
} from '../lib/terminal-pane-tree';
import { agentStatusDetail, isAgentStatusVisible, ptyIdForLeaf } from '../lib/agent-status-view';
import { terminalSessionStore } from '../lib/terminal-session-store';
import { AgentStatusBadge, useAgentStatuses } from './AgentStatusBadge';
import { ShellTerminal } from './ShellTerminal';
import { TerminalProfileIcon } from './TerminalProfileIcon';

interface SplitPaneContainerProps {
  node: PaneLayoutNode;
  path?: SplitNodePath;
  activeLeafId: string;
  panes: Record<string, StagePaneMeta>;
  fallbackCwd?: string;
  fallbackCliId?: string;
  fallbackShellId?: string;
  fallbackTitle?: string;
  leafCount: number;
  searchOpen: boolean;
  onOpenSearch: () => void;
  onCloseSearch: () => void;
  onFocusPane: (leafId: string) => void;
  onSplitPane: (leafId: string, direction: SplitDirection) => void;
  onClosePane: (leafId: string) => void;
  onResizeRatio: (path: SplitNodePath, ratio: number, persist: boolean) => void;
  onCwdChange: (leafId: string, cwd: string) => void;
  onNotify: (msg: string) => void;
}

const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

export function formatCommandDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) return '';
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  const mins = Math.floor(durationMs / 60_000);
  const secs = Math.round((durationMs % 60_000) / 1000);
  return `${mins}m${secs}s`;
}

export function SplitPaneContainer({
  node,
  path = [],
  activeLeafId,
  panes,
  fallbackCwd,
  fallbackCliId,
  fallbackShellId,
  fallbackTitle,
  leafCount,
  searchOpen,
  onOpenSearch,
  onCloseSearch,
  onFocusPane,
  onSplitPane,
  onClosePane,
  onResizeRatio,
  onCwdChange,
  onNotify,
}: SplitPaneContainerProps) {
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const cleanupDragRef = useRef<(() => void) | null>(null);
  const [dragging, setDragging] = useState(false);
  const agents = useAgentStatuses();

  useEffect(() => () => cleanupDragRef.current?.(), []);

  if (node.type === 'leaf') {
    const meta = panes[node.id];
    const isActive = node.id === activeLeafId;
    const sessionState = terminalSessionStore.getState(node.id);
    const effectiveCliId = meta?.localCliId ?? fallbackCliId;
    const effectiveShellId = meta?.shellId ?? fallbackShellId;
    const effectiveCwd = sessionState.cwd ?? meta?.cwd ?? fallbackCwd;
    const rawTitle = sessionState.title || meta?.title || fallbackTitle || '终端';
    const paneLabel = effectiveCwd ? `${folderName(effectiveCwd)} · ${rawTitle}` : rawTitle;
    const durationText = formatCommandDuration(sessionState.lastDurationMs);
    const agentStatus = agents.get(ptyIdForLeaf(node.id));
    const agentDetail = isAgentStatusVisible(agentStatus) ? agentStatusDetail(agentStatus) : '';

    return (
      <div
        className={`split-pane-leaf ${leafCount > 1 ? 'is-multi' : ''} ${isActive ? 'is-focused' : ''}`}
        onMouseDownCapture={() => {
          if (!isActive) onFocusPane(node.id);
        }}
      >
        {leafCount > 1 && (
          <div className="split-pane-header">
            <span className="split-pane-focus-dot" aria-hidden="true" />
            <TerminalProfileIcon
              id={effectiveCliId === 'shell' ? effectiveShellId : effectiveCliId}
              size={12}
            />
            <span className="split-pane-title" title={effectiveCwd ?? paneLabel}>
              {paneLabel}
            </span>
            <AgentStatusBadge status={agentStatus} variant="label" size={11} />
            {agentDetail && (
              <span className="split-pane-agent-detail" title={agentDetail}>
                {agentDetail}
              </span>
            )}
            <span className="split-pane-osc">
              {sessionState.commandRunning ? (
                <span className="osc-status is-running" title="命令执行中">执行中</span>
              ) : sessionState.lastExitCode !== null && sessionState.lastExitCode !== undefined ? (
                <span
                  className={`osc-status ${sessionState.lastExitCode === 0 ? 'is-ok' : 'is-fail'}`}
                  title={`上次退出码 ${sessionState.lastExitCode}${durationText ? ` · 耗时 ${durationText}` : ''}`}
                >
                  {sessionState.lastExitCode === 0 ? '✓' : `✗ ${sessionState.lastExitCode}`}
                  {durationText ? ` ${durationText}` : ''}
                </span>
              ) : null}
            </span>
            <button
              type="button"
              className="split-pane-action"
              title="向右分屏"
              aria-label="向右分屏"
              onClick={(e) => {
                e.stopPropagation();
                onSplitPane(node.id, 'horizontal');
              }}
            >
              <Columns2 size={12} />
            </button>
            <button
              type="button"
              className="split-pane-action"
              title="向下分屏"
              aria-label="向下分屏"
              onClick={(e) => {
                e.stopPropagation();
                onSplitPane(node.id, 'vertical');
              }}
            >
              <Rows2 size={12} />
            </button>
            <button
              type="button"
              className="split-pane-action is-close"
              title="关闭窗格"
              aria-label="关闭窗格"
              onClick={(e) => {
                e.stopPropagation();
                onClosePane(node.id);
              }}
            >
              <X size={12} />
            </button>
          </div>
        )}
        <div className="split-pane-terminal-host">
          <ShellTerminal
            key={node.id}
            terminalId={node.id}
            cwd={meta?.cwd ?? fallbackCwd}
            shellId={effectiveShellId}
            cliId={effectiveCliId === 'shell' ? undefined : effectiveCliId}
            isActivePane={isActive}
            searchOpen={searchOpen && isActive}
            onOpenSearch={onOpenSearch}
            onCloseSearch={onCloseSearch}
            onFocusPane={() => onFocusPane(node.id)}
            onNotify={onNotify}
            onCwdChange={(nextCwd) => onCwdChange(node.id, nextCwd)}
          />
        </div>
      </div>
    );
  }

  const ratio = clampSplitRatio(node.ratio);
  const isHorizontal = node.direction === 'horizontal';

  const startResize = (downEvent: React.PointerEvent<HTMLDivElement>) => {
    if (downEvent.button !== 0) return;
    downEvent.preventDefault();
    const container = splitContainerRef.current;
    if (!container) return;

    const target = downEvent.currentTarget;
    target.setPointerCapture?.(downEvent.pointerId);
    setDragging(true);

    const computeRatio = (clientX: number, clientY: number) => {
      const rect = container.getBoundingClientRect();
      const total = isHorizontal ? rect.width : rect.height;
      if (total <= 0) return ratio;
      const offset = isHorizontal ? clientX - rect.left : clientY - rect.top;
      return clampSplitRatio(offset / total);
    };

    const handleMove = (moveEvent: PointerEvent) => {
      onResizeRatio(path, computeRatio(moveEvent.clientX, moveEvent.clientY), false);
    };

    const cleanup = () => {
      setDragging(false);
      window.removeEventListener('pointermove', handleMove);
      window.removeEventListener('pointerup', handleUp);
      window.removeEventListener('pointercancel', handleUp);
      cleanupDragRef.current = null;
    };

    const handleUp = (upEvent: PointerEvent) => {
      onResizeRatio(path, computeRatio(upEvent.clientX, upEvent.clientY), true);
      cleanup();
    };

    cleanupDragRef.current = cleanup;
    window.addEventListener('pointermove', handleMove);
    window.addEventListener('pointerup', handleUp);
    window.addEventListener('pointercancel', handleUp);
  };

  return (
    <div
      ref={splitContainerRef}
      className={`split-pane-branch is-${node.direction} ${dragging ? 'is-dragging' : ''}`}
    >
      <div className="split-pane-child" style={{ flex: `${ratio} 1 0%` }}>
        <SplitPaneContainer
          node={node.first}
          path={[...path, 'first']}
          activeLeafId={activeLeafId}
          panes={panes}
          fallbackCwd={fallbackCwd}
          fallbackCliId={fallbackCliId}
          fallbackShellId={fallbackShellId}
          fallbackTitle={fallbackTitle}
          leafCount={leafCount}
          searchOpen={searchOpen}
          onOpenSearch={onOpenSearch}
          onCloseSearch={onCloseSearch}
          onFocusPane={onFocusPane}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          onResizeRatio={onResizeRatio}
          onCwdChange={onCwdChange}
          onNotify={onNotify}
        />
      </div>
      <div
        role="separator"
        aria-orientation={isHorizontal ? 'vertical' : 'horizontal'}
        className={`split-pane-divider is-${node.direction}`}
        title="拖动调整窗格大小（双击均分）"
        onPointerDown={startResize}
        onDoubleClick={() => onResizeRatio(path, 0.5, true)}
      />
      <div className="split-pane-child" style={{ flex: `${1 - ratio} 1 0%` }}>
        <SplitPaneContainer
          node={node.second}
          path={[...path, 'second']}
          activeLeafId={activeLeafId}
          panes={panes}
          fallbackCwd={fallbackCwd}
          fallbackCliId={fallbackCliId}
          fallbackShellId={fallbackShellId}
          fallbackTitle={fallbackTitle}
          leafCount={leafCount}
          searchOpen={searchOpen}
          onOpenSearch={onOpenSearch}
          onCloseSearch={onCloseSearch}
          onFocusPane={onFocusPane}
          onSplitPane={onSplitPane}
          onClosePane={onClosePane}
          onResizeRatio={onResizeRatio}
          onCwdChange={onCwdChange}
          onNotify={onNotify}
        />
      </div>
    </div>
  );
}
