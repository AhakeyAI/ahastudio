import { useState, useSyncExternalStore } from 'react';
import { Monitor, Moon, Sun, X } from 'lucide-react';
import { AgentHooksPanel } from './AgentHooksPanel';
import { VoiceGuideModal } from './VoiceGuideModal';
import { VoiceLockPanel } from './VoiceLockPanel';
import { VoiceSelector } from './VoiceSelector';
import { useRemoteVoiceLock } from '../hooks/useRemoteVoiceLock';
import { useVoicePreferences } from '../hooks/useVoicePreferences';
import type { TerminalAppearancePreference } from '../lib/terminal-appearance';
import { terminalSessionStore } from '../lib/terminal-session-store';

const APPEARANCE_OPTIONS: ReadonlyArray<{
  value: TerminalAppearancePreference;
  label: string;
  Icon: typeof Monitor;
}> = [
  { value: 'system', label: '跟随系统', Icon: Monitor },
  { value: 'light', label: '浅色', Icon: Sun },
  { value: 'dark', label: '深色', Icon: Moon },
];

export function SettingsWindow() {
  const prefs = useVoicePreferences();
  const voiceLock = useRemoteVoiceLock();
  const [guideOpen, setGuideOpen] = useState(false);
  const appearancePreference = useSyncExternalStore(
    terminalSessionStore.subscribe,
    terminalSessionStore.getAppearancePreference,
  );
  const resolvedAppearance = useSyncExternalStore(
    terminalSessionStore.subscribe,
    terminalSessionStore.getAppearance,
  );

  return (
    <div
      style={{
        height: '100vh',
        overflowY: 'auto',
        background: 'var(--bg-app)',
        color: 'var(--text-primary)',
        padding: '20px 24px',
        boxSizing: 'border-box',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 16,
          paddingBottom: 12,
          borderBottom: '1px solid var(--border-soft)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>设置</h1>
        <button
          type="button"
          onClick={() => void window.vibeMeet.settingsWindow.close()}
          aria-label="关闭设置"
          style={{
            background: 'transparent',
            border: '1px solid var(--border-strong)',
            borderRadius: 6,
            color: 'inherit',
            padding: '4px 8px',
            cursor: 'pointer',
            display: 'inline-flex',
            alignItems: 'center',
          }}
        >
          <X size={16} />
        </button>
      </header>

      <section style={{ marginBottom: 20 }}>
        <div className="drawer-settings">
          <div className="drawer-settings-row settings-theme-row">
            <div className="drawer-settings-label">
              <div className="drawer-settings-title">界面与终端主题</div>
              <div className="drawer-settings-hint">
                当前生效：{resolvedAppearance === 'dark' ? '深色' : '浅色'}，可随时恢复跟随操作系统设置
              </div>
            </div>
            <div className="settings-theme-options" role="group" aria-label="界面与终端主题">
              {APPEARANCE_OPTIONS.map(({ value, label, Icon }) => {
                const active = appearancePreference === value;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => terminalSessionStore.setAppearance(value)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 5,
                      padding: '5px 10px',
                      borderRadius: 6,
                      fontSize: 12,
                      cursor: 'pointer',
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--border-strong)'}`,
                      background: active ? 'var(--accent-soft)' : 'transparent',
                      color: active ? 'var(--accent)' : 'inherit',
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    <Icon size={13} aria-hidden />
                    <span>{label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>

      <section style={{ marginBottom: 20 }}>
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

      <section style={{ marginBottom: 20 }}>
        <VoiceSelector
          voices={prefs.voices}
          selectedVoiceName={prefs.selectedVoiceName}
          filterMode={prefs.filterMode}
          voicePolishEnabled={prefs.voicePolishEnabled}
          reportModeEnabled={prefs.reportModeEnabled}
          handheldMode={prefs.handheldMode}
          xfyunAsr={prefs.xfyunAsr}
          xfyunDirty={prefs.xfyunDirty}
          xfyunSaveState={prefs.xfyunSaveState}
          onChange={prefs.handleVoiceChange}
          onOpenGuide={() => setGuideOpen(true)}
          onChangeFilterMode={prefs.handleFilterModeChange}
          onChangeVoicePolish={prefs.handleVoicePolishChange}
          onChangeReportMode={prefs.handleReportModeChange}
          onChangeHandheldMode={prefs.handleHandheldModeChange}
          onXfyunAsrInput={prefs.handleXfyunAsrInput}
          onXfyunAsrCommit={prefs.handleXfyunAsrCommit}
        />
      </section>

      <section style={{ marginBottom: 20 }}>
        <AgentHooksPanel />
      </section>

      <VoiceGuideModal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        onDismissForever={() => {
          prefs.handleDismissForever();
          setGuideOpen(false);
        }}
      />
    </div>
  );
}
