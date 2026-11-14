import { useCallback, useEffect, useState } from 'react';
import type { AgentHookCliId, AgentHookCliStatus } from '../types';

const STATE_LABEL: Record<AgentHookCliStatus['state'], string> = {
  'not-installed': '未启用',
  installed: '已启用',
  outdated: '需要更新',
  conflict: '存在冲突',
  error: '读取失败',
};

const STATE_COLOR: Record<AgentHookCliStatus['state'], string> = {
  'not-installed': 'rgba(230,232,236,0.55)',
  installed: '#7ee2a8',
  outdated: '#ffd27a',
  conflict: '#ffb070',
  error: '#ff8a8a',
};

const buttonStyle = {
  background: 'transparent',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 6,
  color: 'inherit',
  padding: '4px 10px',
  cursor: 'pointer',
  fontSize: 12,
  whiteSpace: 'nowrap' as const,
};

export function AgentHooksPanel() {
  const api = window.vibeMeet.agentHooks;
  const [statuses, setStatuses] = useState<AgentHookCliStatus[]>([]);
  const [busy, setBusy] = useState<AgentHookCliId | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!api) return;
    const res = await api.status();
    if (res.ok) setStatuses(res.statuses);
    else setError(res.error);
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!api) return null;

  const run = async (cliId: AgentHookCliId, action: 'install' | 'uninstall') => {
    setBusy(cliId);
    setError(null);
    try {
      const res = await api[action]({ cliId });
      if (!res.ok) setError(res.error);
      const next = res.status;
      if (next) setStatuses((prev) => prev.map((s) => (s.cliId === cliId ? next : s)));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="drawer-settings">
      <div className="drawer-settings-label" style={{ marginBottom: 10 }}>
        <div className="drawer-settings-title">Agent 状态上报 · Hooks</div>
        <div className="drawer-settings-hint">
          在各 CLI 的用户配置中加入一个转发 hook，让终端标签实时显示“运行中 / 等待确认 / 已完成”。
          只有在本应用的终端里运行时才会上报，其他终端中该 hook 会直接退出。需要本机可用的 node。
          新开的 CLI 会话生效，已在运行的会话需重启 CLI。
        </div>
      </div>
      {statuses.map((s) => {
        const enabled = s.state === 'installed' || s.state === 'outdated';
        const canInstall = s.state !== 'conflict' && s.state !== 'error';
        return (
          <div
            key={s.cliId}
            className="drawer-settings-row"
            style={{ padding: '6px 0', borderTop: '1px solid rgba(255,255,255,0.06)' }}
          >
            <div className="drawer-settings-label">
              <div className="drawer-settings-title" style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                <span>{s.label}</span>
                <span style={{ fontSize: 12, color: STATE_COLOR[s.state] }}>{STATE_LABEL[s.state]}</span>
              </div>
              <div className="drawer-settings-hint" title={s.configPath} style={{ wordBreak: 'break-all' }}>
                {s.configPath}
                {s.detail ? ` · ${s.detail}` : ''}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              {(s.state !== 'installed') && canInstall && (
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy !== null}
                  onClick={() => void run(s.cliId, 'install')}
                >
                  {busy === s.cliId ? '处理中…' : s.state === 'outdated' ? '更新' : '启用'}
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
          </div>
        );
      })}
      {error && (
        <div className="drawer-settings-hint" style={{ color: '#ff8a8a', marginTop: 8 }}>
          {error}
        </div>
      )}
    </div>
  );
}
