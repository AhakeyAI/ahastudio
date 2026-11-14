import { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, MicOff, RotateCw, Settings, Volume2, VolumeX } from 'lucide-react';
import { LocalTerminalWorkspace } from './components/LocalTerminalWorkspace';
import { VoiceGuideModal } from './components/VoiceGuideModal';
import { useAsr } from './hooks/useAsr';
import { useSpacebarMute } from './hooks/useSpacebarMute';
import { useStageWindows } from './hooks/useStageWindows';
import { useVoiceLock } from './hooks/useVoiceLock';
import { useVoicePreferences } from './hooks/useVoicePreferences';

export function App() {
  const { windows, activeWindowId } = useStageWindows();
  const active = windows.find((w) => w.id === activeWindowId) ?? null;
  const activeRef = useRef(active);
  activeRef.current = active;

  const [micEnabled, setMicEnabled] = useState(false);
  const [micMuted, setMicMuted] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const speakingRef = useRef(false);
  const prefs = useVoicePreferences();
  const voiceLock = useVoiceLock({
    muted: micMuted,
    setMuted: setMicMuted,
    setAiSpeaking: () => {},
    speakingRef,
  });

  useSpacebarMute(micEnabled, () => setMicMuted((prev) => !prev));

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Bridge voice-lock enrollment commands from SettingsWindow <-> App mic pipeline.
  useEffect(() => {
    const unsub = window.vibeMeet.onVoiceLockEnrollCmd?.((cmd) => {
      if (cmd === 'start') {
        setMicEnabled(true);
        setMicMuted(false);
        voiceLock.handleStartEnrollment();
      } else {
        voiceLock.handleCancelEnrollment();
      }
    });
    return () => unsub?.();
  }, [voiceLock.handleStartEnrollment, voiceLock.handleCancelEnrollment]);

  useEffect(() => {
    window.vibeMeet.sendVoiceLockEnrollState?.({
      enrollment: voiceLock.enrollment,
      toast: voiceLock.enrollmentToast,
    });
  }, [voiceLock.enrollment, voiceLock.enrollmentToast]);

  const handleTranscript = useCallback(
    async (rawText: string) => {
      const cleaned = rawText.trim();
      if (!cleaned) return;
      let textToSend = cleaned;
      if (prefs.voicePolishEnabled || prefs.reportModeEnabled) {
        try {
          const polished = await window.vibeMeet.polishAsrText(cleaned);
          if (polished.ok && polished.text) {
            textToSend = polished.text;
          }
        } catch { /* fall back to raw ASR transcript */ }
      }
      const target = activeRef.current;
      if (!target || target.type !== 'terminal') {
        setNotice(`语音识别：${textToSend}`);
        return;
      }
      const targetPaneId = target.activeLeafId ?? target.id;
      const res = await window.vibeMeet.shellPty.input(`local-${targetPaneId}`, textToSend);
      if (!res.ok) {
        setNotice(res.error ?? '无法写入当前终端');
      }
    },
    [prefs.voicePolishEnabled, prefs.reportModeEnabled],
  );

  const asr = useAsr({
    enabled: micEnabled,
    paused: micMuted && voiceLock.enrollment === null,
    lang: 'auto',
    voiceLockEnabled: voiceLock.voiceLockEnabled,
    voicePrintEmbedding: voiceLock.voicePrintEmbedding,
    tapSegment: voiceLock.handleEnrollmentSegment,
    onVoiceLockReject: () => {
      setNotice('声纹未匹配，已过滤此段语音');
    },
    onTranscript: (text) => {
      void handleTranscript(text);
    },
  });

  const handleToggleMic = useCallback(() => {
    if (!micEnabled) {
      setMicMuted(false);
      setMicEnabled(true);
    } else {
      setMicEnabled(false);
    }
  }, [micEnabled]);

  const statusText = notice
    ? notice
    : !micEnabled
      ? '语音输入关闭'
      : asr.lastError
        ? asr.lastError
        : micMuted
          ? '已静音 (按空格恢复)'
          : asr.listening
            ? `聆听中 · ${asr.mode === 'xfyun' ? '讯飞 ASR' : asr.mode}`
            : asr.mode === 'unavailable'
              ? 'ASR 不可用'
              : '正在连接麦克风…';

  const toolbarExtra = (
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          fontSize: 12,
          color: asr.lastError ? '#f87171' : asr.listening && !micMuted ? '#4ade80' : '#9aa3b2',
          maxWidth: 280,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={statusText}
      >
        {statusText}
      </span>

      {micEnabled && asr.retryable && (
        <button type="button" onClick={asr.retry} title="重试连接麦克风与 ASR" aria-label="重试语音连接">
          <RotateCw size={15} />
        </button>
      )}

      {micEnabled && (
        <button
          type="button"
          onClick={() => setMicMuted((prev) => !prev)}
          title={micMuted ? '取消静音 (空格)' : '静音 (空格)'}
          aria-label={micMuted ? '取消静音' : '静音'}
        >
          {micMuted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        </button>
      )}

      <button
        type="button"
        onClick={handleToggleMic}
        title={micEnabled ? '关闭语音输入' : '开启语音输入 (写入当前终端)'}
        aria-label={micEnabled ? '关闭语音输入' : '开启语音输入'}
        style={
          micEnabled && !micMuted
            ? { color: '#4ade80', borderColor: 'rgba(74, 222, 128, 0.5)' }
            : undefined
        }
      >
        {micEnabled ? <Mic size={16} /> : <MicOff size={16} />}
      </button>

      <button
        type="button"
        onClick={() => void window.vibeMeet.settingsWindow.open()}
        title="语音与声纹设置"
        aria-label="语音与声纹设置"
      >
        <Settings size={16} />
      </button>
    </div>
  );

  return (
    <>
      <LocalTerminalWorkspace toolbarExtra={toolbarExtra} />
      <VoiceGuideModal
        open={guideOpen}
        onClose={() => setGuideOpen(false)}
        onDismissForever={() => {
          prefs.handleDismissForever();
          setGuideOpen(false);
        }}
      />
    </>
  );
}
