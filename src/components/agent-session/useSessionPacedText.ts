// Ported/adapted from Orca (https://github.com/stablyai/orca),
// use-native-chat-paced-text.ts. Copyright (c) 2026 Lovecast Inc. — MIT License.
// See THIRD_PARTY_NOTICES.md.

import { useContext, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import {
  nativeChatTextAppended,
  playNativeChatTextReveal,
  receiveNativeChatText,
  startNativeChatTextReveal,
  type NativeChatTextReveal,
  type NativeChatTextRevealFrames,
} from '../../lib/shared/native-chat/native-chat-text-reveal';
import { SessionReplyRevealsContext } from './session-disclosure-store';

const WORD_FADE_MS = 300;
const useIsomorphicLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const FRAMES: NativeChatTextRevealFrames = {
  now: () => (typeof performance !== 'undefined' ? performance.now() : Date.now()),
  request: (step) => (typeof requestAnimationFrame === 'function' ? requestAnimationFrame(step) : 0),
  cancel: (frame) => {
    if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
  },
};

export interface SessionPacedText {
  text: string;
  revealing: boolean;
  fading: boolean;
}

export function useSessionPacedText(
  rowKey: string,
  text: string,
  streaming: boolean,
): SessionPacedText {
  const reducedMotion = usePrefersReducedMotion();
  const reveals = useContext(SessionReplyRevealsContext);
  const [initial] = useState<NativeChatTextReveal>(() =>
    startNativeChatTextReveal(
      text,
      streaming,
      reveals?.drawn.get(rowKey),
      reveals?.begun.has(rowKey) === true,
      FRAMES.now(),
    ),
  );
  const pace = useRef(initial);
  const [shown, setShown] = useState(initial.shown);
  const [grew, setGrew] = useState(initial.shown < text.length);

  useIsomorphicLayoutEffect(() => {
    const previous = pace.current;
    if (streaming && nativeChatTextAppended(previous, text)) {
      setGrew(true);
    }
    pace.current = receiveNativeChatText(previous, text, streaming, reducedMotion, FRAMES.now());
    setShown(pace.current.shown);
    reveals?.drawn.set(rowKey, pace.current);
  }, [text, streaming, reducedMotion, reveals, rowKey]);

  const behind = !reducedMotion && shown < text.length;
  useEffect(() => {
    if (!behind) {
      if (!streaming) {
        reveals?.drawn.delete(rowKey);
      }
      return;
    }
    return playNativeChatTextReveal(
      () => pace.current,
      (next) => {
        pace.current = next;
        reveals?.drawn.set(rowKey, next);
        setShown(next.shown);
      },
      FRAMES,
    );
  }, [behind, text, reveals, rowKey, streaming]);

  const revealing = !reducedMotion && ((streaming && grew) || behind);
  const [lingering, setLingering] = useState(false);
  useEffect(() => {
    if (revealing) {
      setLingering(true);
      return;
    }
    const timer = setTimeout(() => setLingering(false), WORD_FADE_MS);
    return () => clearTimeout(timer);
  }, [revealing]);

  return {
    text: reducedMotion ? text : text.slice(0, Math.min(shown, text.length)),
    revealing,
    fading: !reducedMotion && (revealing || lingering),
  };
}
