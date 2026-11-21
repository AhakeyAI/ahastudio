import { RotateCw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type {
  LocalCliInventoryEntry,
  OrchestrationAgentProfile,
  OrchestrationConfirmMode,
  OrchestrationPeerMessagingMode,
  OrchestrationSettings,
  OrchestrationSettingsPatch,
} from '../types';
import { AgentHooksPanel } from './AgentHooksPanel';
import { AgentMcpPanel } from './AgentMcpPanel';

const DEFAULT_ORCHESTRATION_SETTINGS: OrchestrationSettings = {
  confirmBeforeDispatch: 'chat-and-guard',
  defaultWorktree: true,
  peerMessagingMode: 'controlled-p2p',
  agentProfiles: {},
};

const DEFAULT_SPECIALTY_PLACEHOLDERS: Record<string, string> = {
  claude: '架构设计、复杂多文件实现与推理',
  codex: '代码评审、单测编写与精准调试',
  gemini: '大代码库调研、文档与方案探索',
  antigravity: '全栈实现、UI 调整与跨模块协作',
  grok: '快速排查、代码审查与问题定位',
  opencode: '通用编码与脚本自动化',
  qwen: '代码实现、中文文档与测试补全',
  kimi: '长文档分析与方案梳理',
  qoder: '通用开发与代码修改',
  pi: '轻量脚本与快速实验',
};

interface CliProfileDraft {
  specialty?: string;
  defaultModel?: string;
}

export function CliAgentSettingsPanel() {
  const orchApi = window.vibeMeet.orchestrationSettings;
  const [clis, setClis] = useState<LocalCliInventoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshToken, setRefreshToken] = useState(0);

  const [orchSettings, setOrchSettings] = useState<OrchestrationSettings>(
    DEFAULT_ORCHESTRATION_SETTINGS,
  );
  const [orchSaving, setOrchSaving] = useState(false);
  const [orchError, setOrchError] = useState<string | null>(null);
  const [profileDrafts, setProfileDrafts] = useState<Record<string, CliProfileDraft>>({});
  const [expandedProfiles, setExpandedProfiles] = useState<Record<string, boolean>>({});

  const loadOrchestrationSettings = useCallback(async () => {
    if (!orchApi) return;
    try {
      const next = await orchApi.get();
      if (next) {
        setOrchSettings(next);
        setOrchError(null);
      }
    } catch (cause) {
      setOrchError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [orchApi]);

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
    await loadOrchestrationSettings();
    setRefreshToken((n) => n + 1);
  }, [loadOrchestrationSettings]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!orchApi?.onChanged) return;
    return orchApi.onChanged(() => {
      void loadOrchestrationSettings();
    });
  }, [orchApi, loadOrchestrationSettings]);

  const persistOrchestrationPatch = useCallback(
    async (patch: OrchestrationSettingsPatch): Promise<boolean> => {
      if (!orchApi) return false;
      setOrchSaving(true);
      setOrchError(null);
      try {
        const res = await orchApi.set(patch);
        if (!res.ok) {
          setOrchError(res.error);
          return false;
        }
        setOrchSettings(res.settings);
        return true;
      } catch (cause) {
        setOrchError(cause instanceof Error ? cause.message : String(cause));
        return false;
      } finally {
        setOrchSaving(false);
      }
    },
    [orchApi],
  );

  const updateCliProfile = useCallback(
    async (cliId: string, patch: Partial<OrchestrationAgentProfile>): Promise<boolean> => {
      const current = orchSettings.agentProfiles[cliId] ?? {};
      const merged: OrchestrationAgentProfile = { ...current, ...patch };
      const cleaned: OrchestrationAgentProfile = {};
      if (typeof merged.enabled === 'boolean') cleaned.enabled = merged.enabled;
      if (typeof merged.specialty === 'string') cleaned.specialty = merged.specialty.trim();
      if (typeof merged.defaultModel === 'string') cleaned.defaultModel = merged.defaultModel.trim();
      if (typeof merged.defaultEffort === 'string') cleaned.defaultEffort = merged.defaultEffort.trim();

      return persistOrchestrationPatch({
        agentProfiles: {
          [cliId]: cleaned,
        },
      });
    },
    [orchSettings.agentProfiles, persistOrchestrationPatch],
  );

  const clearCliFieldDraft = useCallback(
    (cliId: string, field: 'specialty' | 'defaultModel') => {
      setProfileDrafts((prev) => {
        if (!prev[cliId] || !(field in prev[cliId]!)) return prev;
        const next = { ...prev };
        const copy = { ...next[cliId]! };
        delete copy[field];
        if (Object.keys(copy).length === 0) delete next[cliId];
        else next[cliId] = copy;
        return next;
      });
    },
    [],
  );

  const commitCliTextField = (
    cliId: string,
    field: 'specialty' | 'defaultModel',
    rawValue: string,
  ) => {
    const trimmed = rawValue.trim();
    const stored = (orchSettings.agentProfiles[cliId]?.[field] ?? '').trim();
    if (trimmed === stored) {
      clearCliFieldDraft(cliId, field);
      return;
    }
    void updateCliProfile(cliId, { [field]: trimmed }).then((ok) => {
      if (ok) {
        clearCliFieldDraft(cliId, field);
      }
    });
  };

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading settings-heading-with-action">
        <div>
          <h2>CLI 与 Agent</h2>
          <p>查看本机 CLI 检测结果，配置编排行为、MCP 协作与状态上报集成。</p>
        </div>
        <button
          type="button"
          className="settings-button"
          disabled={loading}
          onClick={() => void refresh()}
        >
          <RotateCw size={14} aria-hidden className={loading ? 'is-spinning' : undefined} />
          重新检测
        </button>
      </div>

      {orchApi && (
        <section className="settings-card">
          <div className="settings-card-title">
            <h3>编排行为</h3>
            <p>控制 Agent 派发子任务前的确认方式与默认工作树策略。</p>
          </div>
          {orchError && (
            <div className="settings-error" role="alert">
              {orchError}
            </div>
          )}
          <div className="settings-orchestration-list">
            <div className="settings-row">
              <div>
                <div className="settings-orchestration-label">派活前确认</div>
                <p className="settings-orchestration-hint">
                  推荐在对话里先确认方案，再由系统防抢跑闸门放行派发。
                </p>
              </div>
              <select
                className="settings-select"
                aria-label="派活前确认"
                disabled={orchSaving}
                value={orchSettings.confirmBeforeDispatch}
                onChange={(e) =>
                  void persistOrchestrationPatch({
                    confirmBeforeDispatch: e.target.value as OrchestrationConfirmMode,
                  })
                }
              >
                <option value="chat-and-guard">对话确认 + 防抢跑（推荐）</option>
                <option value="always-ui">每次胶囊一键确认</option>
                <option value="auto">自动派发免确认</option>
              </select>
            </div>
            <div className="settings-row">
              <div>
                <div className="settings-orchestration-label">跨 Worker 协作</div>
                <p className="settings-orchestration-hint">
                  控制同任务下 Worker 之间是否允许在协作板上直接点对点交接。
                </p>
              </div>
              <select
                className="settings-select"
                aria-label="跨 Worker 协作"
                disabled={orchSaving}
                value={orchSettings.peerMessagingMode ?? 'controlled-p2p'}
                onChange={(e) =>
                  void persistOrchestrationPatch({
                    peerMessagingMode: e.target.value as OrchestrationPeerMessagingMode,
                  })
                }
              >
                <option value="controlled-p2p">允许受控点对点交接（3 轮熔断升级主控，推荐）</option>
                <option value="hub-only">严格经主控中转</option>
              </select>
            </div>
            <label className="settings-checkbox-row">
              <input
                type="checkbox"
                disabled={orchSaving}
                checked={orchSettings.defaultWorktree}
                onChange={(e) =>
                  void persistOrchestrationPatch({ defaultWorktree: e.target.checked })
                }
              />
              <span>默认使用独立 Git worktree（避免多 Agent 并行改乱同一工作区）</span>
            </label>
            <label className="settings-checkbox-row">
              <input
                type="checkbox"
                disabled={orchSaving}
                checked={orchSettings.codexAppServerPilot ?? false}
                onChange={(e) =>
                  void persistOrchestrationPatch({ codexAppServerPilot: e.target.checked })
                }
              />
              <span>Windows Codex 只读无头 Worker（试点）</span>
            </label>
          </div>
        </section>
      )}

      <section className="settings-card">
        <div className="settings-card-title">
          <h3>本机 CLI</h3>
          <p>各 CLI 继续使用自己的模型和认证配置；可按需设置是否参与编排及擅长方向。</p>
        </div>
        {error && (
          <div className="settings-error" role="alert">
            {error}
          </div>
        )}
        {!error && clis.length === 0 && loading && <p className="settings-muted">正在检测…</p>}
        <div className="settings-cli-list">
          {clis.map((cli) => {
            const profile = orchSettings.agentProfiles[cli.id];
            const enabled = profile?.enabled ?? cli.installed;
            const draft = profileDrafts[cli.id];
            const specialtyValue = draft?.specialty ?? profile?.specialty ?? '';
            const modelValue = draft?.defaultModel ?? profile?.defaultModel ?? '';
            const showProfileFields =
              Boolean(orchApi) && (cli.installed ? enabled : Boolean(expandedProfiles[cli.id]));

            return (
              <div className="settings-cli-row" key={cli.id}>
                <div className="settings-cli-row-header">
                  <div className="settings-cli-info">
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
                  {orchApi && (
                    <div className="settings-cli-controls">
                      {!cli.installed && (
                        <button
                          type="button"
                          className="settings-link-button settings-cli-expand"
                          onClick={() =>
                            setExpandedProfiles((prev) => ({
                              ...prev,
                              [cli.id]: !prev[cli.id],
                            }))
                          }
                        >
                          {expandedProfiles[cli.id] ? '收起' : '配置'}
                        </button>
                      )}
                      <label className="settings-cli-toggle">
                        <input
                          type="checkbox"
                          checked={enabled}
                          disabled={orchSaving}
                          onChange={(e) =>
                            void updateCliProfile(cli.id, { enabled: e.target.checked })
                          }
                        />
                        <span>参与编排</span>
                      </label>
                    </div>
                  )}
                </div>

                {showProfileFields && (
                  <div className="settings-cli-profile">
                    <label className="settings-cli-profile-field">
                      <span>擅长方向</span>
                      <input
                        type="text"
                        className="settings-input settings-input-compact"
                        value={specialtyValue}
                        placeholder={
                          DEFAULT_SPECIALTY_PLACEHOLDERS[cli.id] ?? '如：代码评审、测试编写'
                        }
                        onChange={(e) =>
                          setProfileDrafts((prev) => ({
                            ...prev,
                            [cli.id]: { ...prev[cli.id], specialty: e.target.value },
                          }))
                        }
                        onBlur={(e) => commitCliTextField(cli.id, 'specialty', e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                    <label className="settings-cli-profile-field settings-cli-model-field">
                      <span>默认模型</span>
                      <input
                        type="text"
                        className="settings-input settings-input-compact"
                        value={modelValue}
                        placeholder="留空使用默认"
                        onChange={(e) =>
                          setProfileDrafts((prev) => ({
                            ...prev,
                            [cli.id]: { ...prev[cli.id], defaultModel: e.target.value },
                          }))
                        }
                        onBlur={(e) => commitCliTextField(cli.id, 'defaultModel', e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.currentTarget.blur();
                          }
                        }}
                      />
                    </label>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <section className="settings-card settings-hooks-card">
        <AgentMcpPanel refreshToken={refreshToken} />
      </section>

      <section className="settings-card settings-hooks-card">
        <AgentHooksPanel />
      </section>
    </div>
  );
}
