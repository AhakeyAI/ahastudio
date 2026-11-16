import { useEffect, useState } from 'react';
import { useRemoteVoiceLock } from '../hooks/useRemoteVoiceLock';
import { useVoiceInputPreferences } from '../hooks/useVoiceInputPreferences';
import { VoiceLockPanel } from './VoiceLockPanel';

export function VoiceInputSettingsPanel() {
  const { preferences, loaded, saving, error, update } = useVoiceInputPreferences();
  const voiceLock = useRemoteVoiceLock();
  const [appId, setAppId] = useState('');
  const [xfyunApiKey, setXfyunApiKey] = useState('');
  const [xfyunApiSecret, setXfyunApiSecret] = useState('');
  const [polishApiKey, setPolishApiKey] = useState('');
  const [polishBaseUrl, setPolishBaseUrl] = useState('');
  const [polishModel, setPolishModel] = useState('');
  const [saved, setSaved] = useState<'asr' | 'polish' | null>(null);

  useEffect(() => {
    if (!loaded) return;
    setAppId(preferences.xfyunAsr.appId);
    setPolishBaseUrl(preferences.voicePolishBaseUrl);
    setPolishModel(preferences.voicePolishModel);
  }, [loaded]);

  if (!loaded) return <div className="settings-panel settings-muted">正在读取语音输入设置…</div>;

  const asrDirty = appId !== preferences.xfyunAsr.appId || Boolean(xfyunApiKey || xfyunApiSecret);
  const polishDirty = polishBaseUrl !== preferences.voicePolishBaseUrl
    || polishModel !== preferences.voicePolishModel
    || Boolean(polishApiKey);

  const saveAsr = async () => {
    const ok = await update({
      xfyunAsr: {
        appId,
        ...(xfyunApiKey ? { apiKey: xfyunApiKey } : {}),
        ...(xfyunApiSecret ? { apiSecret: xfyunApiSecret } : {}),
      },
    });
    if (ok) {
      setXfyunApiKey('');
      setXfyunApiSecret('');
      setSaved('asr');
    }
  };

  const savePolish = async () => {
    const ok = await update({
      voicePolishBaseUrl: polishBaseUrl,
      voicePolishModel: polishModel,
      ...(polishApiKey ? { voicePolishApiKey: polishApiKey } : {}),
    });
    if (ok) {
      setPolishApiKey('');
      setSaved('polish');
    }
  };

  return (
    <div className="settings-panel">
      <div className="settings-panel-heading">
        <h2>语音输入</h2>
        <p>配置写入当前终端的语音识别、文本整理和声纹锁。</p>
      </div>

      {error && <div className="settings-error" role="alert">{error}</div>}

      <section className="settings-card">
        <div className="settings-card-title">
          <h3>讯飞 ASR</h3>
          <p>密钥留空表示保持原值；保存后会重新探测并重连麦克风。</p>
        </div>
        <label className="settings-field">
          <span>AppID</span>
          <input className="settings-input" value={appId} onChange={(event) => { setAppId(event.target.value); setSaved(null); }} placeholder="AppID" />
        </label>
        <label className="settings-field">
          <span>API Key</span>
          <div className="settings-secret-input">
            <input
              className="settings-input"
              type="password"
              aria-label="讯飞 API Key"
              value={xfyunApiKey}
              onChange={(event) => { setXfyunApiKey(event.target.value); setSaved(null); }}
              placeholder={preferences.xfyunAsr.apiKeyConfigured ? '已保存，输入以替换' : 'API Key'}
              autoComplete="off"
            />
            {preferences.xfyunAsr.apiKeyConfigured && (
              <button type="button" className="settings-link-button" disabled={saving} onClick={() => void update({ xfyunAsr: { apiKey: '' } })}>清除</button>
            )}
          </div>
        </label>
        <label className="settings-field">
          <span>API Secret</span>
          <div className="settings-secret-input">
            <input
              className="settings-input"
              type="password"
              aria-label="讯飞 API Secret"
              value={xfyunApiSecret}
              onChange={(event) => { setXfyunApiSecret(event.target.value); setSaved(null); }}
              placeholder={preferences.xfyunAsr.apiSecretConfigured ? '已保存，输入以替换' : 'API Secret'}
              autoComplete="off"
            />
            {preferences.xfyunAsr.apiSecretConfigured && (
              <button type="button" className="settings-link-button" disabled={saving} onClick={() => void update({ xfyunAsr: { apiSecret: '' } })}>清除</button>
            )}
          </div>
        </label>
        <div className="settings-actions">
          <button type="button" className="settings-button is-primary" disabled={saving || !asrDirty} onClick={() => void saveAsr()}>
            {saving ? '保存中…' : '保存并重连麦克风'}
          </button>
          {saved === 'asr' && <span className="settings-save-success">已保存</span>}
        </div>
      </section>

      <section className="settings-card">
        <div className="settings-row">
          <div>
            <h3>语音整理</h3>
            <p>{preferences.voicePolishEnabled ? '口语整理为书面语后再写入当前终端。' : '识别文本原样写入当前终端。'}</p>
          </div>
          <button
            type="button"
            className={`drawer-toggle ${preferences.voicePolishEnabled ? 'drawer-toggle-on' : ''}`}
            aria-label="语音整理"
            aria-pressed={preferences.voicePolishEnabled}
            disabled={saving}
            onClick={() => void update({ voicePolishEnabled: !preferences.voicePolishEnabled })}
          >
            <span className="drawer-toggle-knob" />
          </button>
        </div>
        {!preferences.voicePolishApiKeyConfigured && !polishApiKey && (
          <div className="settings-warning">尚未配置 API Key，开启语音整理也不会改变识别文本。</div>
        )}
        <label className="settings-field">
          <span>API Key</span>
          <div className="settings-secret-input">
            <input
              className="settings-input"
              type="password"
              aria-label="语音整理 API Key"
              value={polishApiKey}
              onChange={(event) => { setPolishApiKey(event.target.value); setSaved(null); }}
              placeholder={preferences.voicePolishApiKeyConfigured ? '已保存，输入以替换' : '语音整理专用 API Key'}
              autoComplete="off"
            />
            {preferences.voicePolishApiKeyConfigured && (
              <button type="button" className="settings-link-button" disabled={saving} onClick={() => void update({ voicePolishApiKey: '' })}>清除</button>
            )}
          </div>
        </label>
        <label className="settings-field">
          <span>Base URL</span>
          <input className="settings-input" value={polishBaseUrl} onChange={(event) => { setPolishBaseUrl(event.target.value); setSaved(null); }} placeholder="可选，兼容 Anthropic Messages API" />
        </label>
        <label className="settings-field">
          <span>模型</span>
          <input className="settings-input" value={polishModel} onChange={(event) => { setPolishModel(event.target.value); setSaved(null); }} placeholder="claude-sonnet-4-20250514" />
        </label>
        <div className="settings-actions">
          <button type="button" className="settings-button is-primary" disabled={saving || !polishDirty} onClick={() => void savePolish()}>
            {saving ? '保存中…' : '保存语音整理配置'}
          </button>
          {saved === 'polish' && <span className="settings-save-success">已保存</span>}
        </div>
      </section>

      <section className="settings-card settings-voice-lock-card">
        <VoiceLockPanel
          enabled={voiceLock.voiceLockEnabled}
          enrolledAt={voiceLock.voicePrint?.enrolledAt ?? null}
          modelMatches={true}
          enrollment={voiceLock.enrollment}
          recentlyRejected={voiceLock.recentlyRejected}
          enrollmentToast={voiceLock.enrollmentToast}
          onToggleEnabled={voiceLock.handleToggleVoiceLock}
          onStartEnroll={voiceLock.handleStartEnrollment}
          onCancelEnroll={voiceLock.handleCancelEnrollment}
          onClearEnrollment={voiceLock.handleClearEnrollment}
        />
      </section>
    </div>
  );
}
