import { RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { LocalCliInventoryEntry } from '../types';
import { AgentHooksPanel } from './AgentHooksPanel';

export function CliAgentSettingsPanel() {
  const [clis, setClis] = useState<LocalCliInventoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await window.vibeMeet.cliInventory.list();
      if (result.ok) setClis(result.clis);
      else setError(result.error);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading settings-heading-with-action">
        <div>
          <h2>CLI 与 Agent</h2>
          <p>查看本机 CLI 检测结果和 Agent 状态上报集成。</p>
        </div>
        <button type="button" className="settings-button" disabled={loading} onClick={() => void refresh()}>
          <RotateCw size={14} aria-hidden className={loading ? 'is-spinning' : undefined} />
          重新检测
        </button>
      </div>

      <section className="settings-card">
        <div className="settings-card-title">
          <h3>本机 CLI</h3>
          <p>各 CLI 继续使用自己的模型和认证配置。</p>
        </div>
        {error && <div className="settings-error" role="alert">{error}</div>}
        {!error && clis.length === 0 && loading && <p className="settings-muted">正在检测…</p>}
        <div className="settings-cli-list">
          {clis.map((cli) => (
            <div className="settings-cli-row" key={cli.id}>
              <div>
                <div className="settings-cli-name">
                  <strong>{cli.label}</strong>
                  <span className={cli.installed ? 'settings-status is-ok' : 'settings-status'}>
                    {cli.installed ? '已检测' : '未检测'}
                  </span>
                </div>
                <div className="settings-path" title={cli.binaryPath ?? cli.command}>
                  {cli.binaryPath ?? `命令：${cli.command}`}
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

      <section className="settings-card settings-hooks-card">
        <AgentHooksPanel />
      </section>
    </div>
  );
}
