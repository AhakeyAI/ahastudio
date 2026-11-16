import { useCallback, useEffect, useRef, useState } from 'react';
import type { VoiceInputPatch, VoiceInputPreferences } from '../types';

const DEFAULT_PREFERENCES: VoiceInputPreferences = {
  voicePolishEnabled: false,
  voicePolishApiKeyConfigured: false,
  voicePolishBaseUrl: '',
  voicePolishModel: '',
  xfyunAsr: { appId: '', apiKeyConfigured: false, apiSecretConfigured: false },
};

export function useVoiceInputPreferences() {
  const [preferences, setPreferences] = useState(DEFAULT_PREFERENCES);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await window.vibeMeet.voiceInput.get();
      if (!mounted.current) return;
      setPreferences(next);
      setLoaded(true);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = window.vibeMeet.voiceInput.onChanged(() => void refresh());
    return () => {
      mounted.current = false;
      unsubscribe();
    };
  }, [refresh]);

  const update = useCallback(async (patch: VoiceInputPatch): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const result = await window.vibeMeet.voiceInput.set(patch);
      if (!result.ok) {
        setError(result.error ?? '保存失败');
        return false;
      }
      await refresh();
      return true;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  return { preferences, loaded, saving, error, update };
}
