import { useCallback, useEffect, useState } from 'react';
import type { AgentMcpCliId, AgentMcpCliStatus, AgentMcpInstallState } from '../types';

const STATE_LABEL: Record<AgentMcpInstallState, string> = {
  'launch-managed': '已自动注入',
  'not-installed': '未启用',
  installed: '已启用',
  outdated: '需要更新',
  conflict: '存在冲突',
  error: '读取失败',
};

const STATE_COLOR: Record<AgentMcpInstallState, string> = {
  'launch-managed': 'var(--success)',
  'not-installed': 'var(--text-muted)',
  installed: 'var(--success)',
  outdated: 'var(--warn)',
  conflict: 'var(--warn)',
  error: 'var(--danger)',
};

const buttonStyle = {
  background: 'transparent',
  border: '1px solid var(--border-strong)',
  borderRadius: 6,
  color: 'inherit',
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap' as const,
};

export function AgentMcpPanel({ refreshToken = 0 }: { refreshToken?: number }) {
  const api = window.vibeMeet.agentMcp;
  const [statuses, setStatuses] = useState<AgentMcpCliStatus[]>([]);
  const [busy, setBusy] = useState<AgentMcpCliId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    try {
      const res = await api.status();
      if (res.ok) {
        setStatuses(res.statuses);
        setError(null);
      } else {
        setError(res.error);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshToken]);

  if (!api) return null;

  const run = async (cliId: AgentMcpCliId, action: 'install' | 'uninstall') => {
    setBusy(cliId);
    setError(null);
    try {
      const res = await api[action]({ cliId });
      if (!res.ok) {
        setError(res.error);
        await refresh();
      } else if (res.status) {
        const next = res.status;
        setStatuses((prev) => prev.map((s) => (s.cliId === cliId ? next : s)));
      } else {
        await refresh();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="drawer-settings">
      <div className="drawer-settings-label" style={{ marginBottom: 10 }}>
        <div className="drawer-settings-title">Agent 编排协作 · MCP</div>
        <div className="drawer-settings-hint">
          为本机 CLI 提供本地 stdio MCP 工具（aha），支持在对话中发现可用 Agent 并派发协作任务。
          Claude Code 与 Codex 通过启动参数自动注入；其余 CLI 写入各自配置，且仅在本应用终端内生效。
        </div>
      </div>
      {statuses.map((s) => {
        const isLaunchManaged = s.mode === 'launch-arg' || s.state === 'launch-managed';
        const enabled = s.state === 'installed' || s.state === 'outdated';
        const canInstall = !isLaunchManaged && s.state !== 'conflict' && s.state !== 'error';
        const hintText = isLaunchManaged
          ? s.detail || '启动时自动注入，无需改写用户全局配置'
          : `${s.configPath}${s.detail ? ` · ${s.detail}` : ''}`;

        return (
          <div
            key={s.cliId}
            className="drawer-settings-row"
            style={{ padding: '6px 0', borderTop: '1px solid var(--border-soft)' }}
          >
            <div className="drawer-settings-label">
              <div
                className="drawer-settings-title"
                style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}
              >
                <span>{s.label}</span>
                <span style={{ fontSize: 12, color: STATE_COLOR[s.state] }}>
                  {STATE_LABEL[s.state]}
                </span>
              </div>
              <div className="drawer-settings-hint" title={hintText} style={{ wordBreak: 'break-all' }}>
                {hintText}
              </div>
            </div>
            {!isLaunchManaged && (
              <div style={{ display: 'flex', gap: 6 }}>
                {canInstall && (
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy !== null}
                    onClick={() => void run(s.cliId, 'install')}
                  >
                    {busy === s.cliId
                      ? '处理中…'
                      : s.state === 'outdated'
                        ? '更新'
                        : s.state === 'installed'
                          ? '重新安装'
                          : '启用'}
                  </button>
                )}
                {enabled && (
                  <button
                    type="button"
                    style={buttonStyle}
                    disabled={busy !== null}
                    onClick={() => void run(s.cliId, 'uninstall')}
                  >
                    {busy === s.cliId ? '处理中…' : '移除'}
                  </button>
                )}
              </div>
            )}
          </div>
        );
      })}
      {error && (
        <div className="drawer-settings-hint" style={{ color: 'var(--danger)', marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
