import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type RefObject } from 'react';
import {
  TIMELINE_ANCHOR_OFFSET,
  TIMELINE_END_THRESHOLD,
  anchoredTurnMinHeight,
  distanceFromEnd,
  modeAfterScroll,
  resolveDisclosureRevealScrollDelta,
  type TimelineScrollMode,
} from '../lib/timeline-scroll-anchoring';

/** A toggle only explains a resize that lands right after it. */
const DISCLOSURE_WINDOW_MS = 400;

export interface TimelineScroll {
  scrollerRef: RefObject<HTMLDivElement>;
  contentRef: RefObject<HTMLDivElement>;
  following: boolean;
  /** Turn that keeps a viewport-sized minimum height so its prompt can rest at the top. */
  anchoredTurnKey: string | null;
  anchoredMinHeight: number;
  scrollToEnd: () => void;
  onScroll: () => void;
  onClickCapture: (event: MouseEvent<HTMLElement>) => void;
}

/**
 * Keeps the timeline pinned to its end while the reader follows along, releases it when they
 * scroll up or open a row, and rests each new turn's prompt at the top of the viewport.
 */
export function useTimelineScroll(opts: {
  /** Key of the newest turn; null until the timeline has loaded. */
  lastTurnKey: string | null;
  /** Height of the composer floating over the bottom of the scroller. */
  composerInset: number;
}): TimelineScroll {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<TimelineScrollMode>('following-end');
  const lastScrollTopRef = useRef(0);
  const disclosureRef = useRef<{ row: Element; at: number } | null>(null);
  const insetRef = useRef(opts.composerInset);
  insetRef.current = opts.composerInset;
  const [following, setFollowing] = useState(true);
  const [anchoredTurnKey, setAnchoredTurnKey] = useState<string | null>(null);
  const [anchoredMinHeight, setAnchoredMinHeight] = useState(0);

  const setMode = useCallback((mode: TimelineScrollMode) => {
    modeRef.current = mode;
    setFollowing(mode === 'following-end');
  }, []);

  const pinToEnd = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    scroller.scrollTop = scroller.scrollHeight;
    lastScrollTopRef.current = scroller.scrollTop;
  }, []);

  const scrollToEnd = useCallback(() => {
    setMode('following-end');
    pinToEnd();
  }, [pinToEnd, setMode]);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const next = modeAfterScroll(modeRef.current, lastScrollTopRef.current, scroller);
    lastScrollTopRef.current = scroller.scrollTop;
    if (next !== modeRef.current) setMode(next);
  }, [setMode]);

  // Rows toggle with a plain aria-expanded button, so one delegated listener sees every disclosure.
  const onClickCapture = useCallback((event: MouseEvent<HTMLElement>) => {
    const toggle = (event.target as Element).closest?.('[aria-expanded]');
    if (!toggle) return;
    disclosureRef.current = { row: toggle.closest('[data-asv-row]') ?? toggle, at: performance.now() };
  }, []);

  const measureAnchor = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setAnchoredMinHeight(anchoredTurnMinHeight({ viewportHeight: scroller.clientHeight, composerInset: insetRef.current }));
  }, []);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const content = contentRef.current;
    if (!scroller || !content || typeof ResizeObserver === 'undefined') return;
    const handleResize = () => {
      measureAnchor();
      const disclosure = disclosureRef.current;
      disclosureRef.current = null;
      if (disclosure && performance.now() - disclosure.at <= DISCLOSURE_WINDOW_MS && disclosure.row.isConnected) {
        // The reader opened or closed a row: show it instead of yanking the view back to the end.
        const row = disclosure.row.getBoundingClientRect();
        const viewport = scroller.getBoundingClientRect();
        const delta = resolveDisclosureRevealScrollDelta({
          rowTop: row.top,
          rowBottom: row.bottom,
          viewportTop: viewport.top,
          viewportBottom: viewport.bottom,
          composerOverlayHeight: insetRef.current,
          anchorOffset: TIMELINE_ANCHOR_OFFSET,
        });
        if (delta > 0) scroller.scrollTop += delta;
        lastScrollTopRef.current = scroller.scrollTop;
        setMode(distanceFromEnd(scroller) <= TIMELINE_END_THRESHOLD ? 'following-end' : 'free-scrolling');
        return;
      }
      if (modeRef.current === 'following-end') pinToEnd();
    };
    const observer = new ResizeObserver(handleResize);
    observer.observe(scroller);
    // Border box, so a change of the composer inset (bottom padding) is reported as well.
    observer.observe(content, { box: 'border-box' });
    return () => observer.disconnect();
  }, [measureAnchor, pinToEnd, setMode]);

  useEffect(measureAnchor, [measureAnchor, opts.composerInset]);

  const seenTurnKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const previous = seenTurnKeyRef.current;
    seenTurnKeyRef.current = opts.lastTurnKey;
    if (opts.lastTurnKey === null || previous === opts.lastTurnKey) return;
    if (previous === null) {
      // First load opens at the end of the existing history.
      pinToEnd();
      return;
    }
    setAnchoredTurnKey(modeRef.current === 'following-end' ? opts.lastTurnKey : null);
  }, [opts.lastTurnKey, pinToEnd]);

  return { scrollerRef, contentRef, following, anchoredTurnKey, anchoredMinHeight, scrollToEnd, onScroll, onClickCapture };
}
