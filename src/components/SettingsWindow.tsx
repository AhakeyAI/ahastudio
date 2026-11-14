import { useState } from 'react';
import { X } from 'lucide-react';
import { AgentHooksPanel } from './AgentHooksPanel';
import { VoiceGuideModal } from './VoiceGuideModal';
import { VoiceLockPanel } from './VoiceLockPanel';
import { VoiceSelector } from './VoiceSelector';
import { useRemoteVoiceLock } from '../hooks/useRemoteVoiceLock';
import { useVoicePreferences } from '../hooks/useVoicePreferences';

export function SettingsWindow() {
  const prefs = useVoicePreferences();
  const voiceLock = useRemoteVoiceLock();
  const [guideOpen, setGuideOpen] = useState(false);

  return (
    <div
      style={{
        height: '100vh',
        overflowY: 'auto',
        background: '#16181d',
        color: '#e6e8ec',
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
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <h1 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>设置</h1>
        <button
          type="button"
          onClick={() => void window.vibeMeet.settingsWindow.close()}
          aria-label="关闭设置"
          style={{
            background: 'transparent',
            border: '1px solid rgba(255,255,255,0.14)',
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
