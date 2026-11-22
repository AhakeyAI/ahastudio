// Scroll decisions for the Agent session timeline, kept free of DOM access so they can be tested.
// resolveDisclosureRevealScrollDelta is ported from T3 Code
// (apps/web/src/components/chat/timelineScrollAnchoring.ts).
// Copyright (c) 2026 T3 Tools Inc. — MIT License. See THIRD_PARTY_NOTICES.md.

export type TimelineScrollMode = 'following-end' | 'free-scrolling';

/** Gap kept between the top of the viewport and a row anchored there. */
export const TIMELINE_ANCHOR_OFFSET = 24;
export const TIMELINE_END_THRESHOLD = 48;

export interface TimelineScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

export function distanceFromEnd(metrics: TimelineScrollMetrics): number {
  return Math.max(0, metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight);
}

/**
 * Content growing under a pinned view also leaves the end, so only an upward move counts as the
 * reader letting go; reaching the end again resumes following.
 */
export function modeAfterScroll(
  mode: TimelineScrollMode,
  previousScrollTop: number,
  metrics: TimelineScrollMetrics,
): TimelineScrollMode {
  if (distanceFromEnd(metrics) <= TIMELINE_END_THRESHOLD) return 'following-end';
  if (metrics.scrollTop < previousScrollTop - 1) return 'free-scrolling';
  return mode;
}

/**
 * Height the newest turn needs so its first row can sit at the anchor offset while the view is
 * pinned to the end. The pin then keeps a new prompt at the top until its answer outgrows the
 * viewport, after which the same pin follows the answer.
 */
export function anchoredTurnMinHeight(input: {
  viewportHeight: number;
  composerInset: number;
  anchorOffset?: number;
}): number {
  return Math.max(0, Math.floor(input.viewportHeight - input.composerInset - (input.anchorOffset ?? TIMELINE_ANCHOR_OFFSET)));
}

/**
 * How far to scroll after a row expands: enough to show what the composer hides, but never so
 * far that the row's own header leaves the top of the viewport.
 */
export function resolveDisclosureRevealScrollDelta({
  rowTop,
  rowBottom,
  viewportTop,
  viewportBottom,
  composerOverlayHeight,
  anchorOffset,
}: {
  readonly rowTop: number;
  readonly rowBottom: number;
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly composerOverlayHeight: number;
  readonly anchorOffset: number;
}): number {
  const hiddenBelow = rowBottom - (viewportBottom - composerOverlayHeight);
  if (!(hiddenBelow > 0)) return 0;
  const roomAbove = rowTop - (viewportTop + anchorOffset);
  return Math.max(0, Math.min(hiddenBelow, roomAbove));
}
