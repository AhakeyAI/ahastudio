import { useState } from 'react';
import type { CodexRuntimeReport, RuntimeState } from '../../electron/orchestration/codex-runtime-types';

const labels: Record<RuntimeState, string> = {
  'not-installed': '未安装', 'not-enabled': '未启用', 'dependency-missing': '依赖缺失',
  'authentication-required': '需要认证', 'permission-required': '需要系统授权',
  'host-unsupported': '宿主不支持', configured: '已配置·待验证', verified: '只读验证通过',
  unverified: '尚未验证', error: '检查未完成',
};

export function CodexRuntimePanel({ sessionId, running = false }: { sessionId?: string; running?: boolean }) {
  const api = window.vibeMeet.agentSessions;
  const [report, setReport] = useState<CodexRuntimeReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  if (!api?.runtime) return null;
  const inspect = async (probe: boolean) => {
    setBusy(true); setMessage('');
    try {
      const result = await api.runtime!({ id: sessionId, probe });
      if (result.ok) setReport(result.report); else setMessage(result.error);
    } catch { setMessage('检查未完成，请稍后重试。'); }
    finally { setBusy(false); }
  };
  const reload = async () => {
    if (!sessionId || !api.reloadTools) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.reloadTools({ id: sessionId });
      setMessage(result.ok ? '已请求在原线程重读工具配置，下轮生效；如仍不可用，请重新检查。不会重载外部 harness 的启动脚本。' : result.error);
    } catch { setMessage('重载未完成，原会话保留。请正常退出后从历史恢复，勿同时打开两个入口。'); }
    finally { setBusy(false); }
  };
  return <details className="drawer-settings" style={{ padding: 12, borderBottom: '1px solid var(--border)', maxHeight: 320, overflow: 'auto' }}>
    <summary style={{ cursor: 'pointer' }}>Codex 工具与启动检查</summary>
    <p className="drawer-settings-hint">终端脚本可能选择不同的工具配置。这里使用原生 Codex 检查当前项目，不导入登录、会话或其他配置，也不会自动改变权限。</p>
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button type="button" className="settings-button" disabled={busy} onClick={() => void inspect(false)}>检查配置</button>
      <button type="button" className="settings-button" disabled={busy} onClick={() => void inspect(true)}>验证 Computer Use（只读）</button>
      <button type="button" className="settings-button" disabled={busy} onClick={() => void api.revealRuntimeConfig?.()}>打开用户配置位置</button>
      {sessionId && <button type="button" className="settings-button" disabled={busy || running} onClick={() => void reload()}>本轮结束后重载工具</button>}
    </div>
    <p className="drawer-settings-hint">验证会连接已配置的服务，仅调用经确认的官方应用列表工具，不操作应用。插件可能还需要官方宿主；其他 Agent 的兼容性需分别检查。</p>
    {busy && <p role="status">正在检查，请稍候…</p>}
    {message && <p role="status">{message}</p>}
    {report && <>
      <p>{report.separateProfile ? '独立工具配置' : '本机工具配置'} · 项目：{report.cwd}</p>
      <ul>{report.findings.map((finding, i) => <li key={i}><strong>{finding.name} · {labels[finding.state]}</strong><br />{finding.detail}</li>)}</ul>
      <details><summary>诊断详情</summary><p>CLI：{report.cli ?? '未找到'}</p><p>用户配置：{report.configFile}</p>
        <p>项目或组织规则可能覆盖用户配置。以下来源与是否生效由 Codex 返回，不会在这里修改信任或批准规则。</p>
        <ul>{report.configSources.map((source, i) => <li key={i}>{source.kind} · {source.active ? '已加载' : '已跳过'}{source.path ? ` · ${source.path}` : ''}</li>)}</ul>
      </details>
      {sessionId && <p className="drawer-settings-hint">以上检查使用新连接，当前线程可能仍保留旧配置。请等回合和待批准请求结束再重载；不支持热重载时，正常退出后从历史恢复同一会话，只保留一个入口。</p>}
    </>}
  </details>;
}
