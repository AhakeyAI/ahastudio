export type SplitDirection = 'horizontal' | 'vertical';

export type PaneLayoutNode =
  | { type: 'leaf'; id: string }
  | {
      type: 'split';
      direction: SplitDirection;
      ratio: number;
      first: PaneLayoutNode;
      second: PaneLayoutNode;
    };

export type SplitNodePath = readonly ('first' | 'second')[];

export type PaneNavigateDirection = 'left' | 'right' | 'up' | 'down' | 'next' | 'prev';

export interface PaneRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const MIN_SPLIT_RATIO = 0.15;
export const MAX_SPLIT_RATIO = 0.85;
export const DEFAULT_SPLIT_RATIO = 0.5;

export function clampSplitRatio(ratio: number): number {
  if (!Number.isFinite(ratio)) return DEFAULT_SPLIT_RATIO;
  return Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, ratio));
}

export function collectLayoutLeafIdsInOrder(node: PaneLayoutNode): string[] {
  if (node.type === 'leaf') return [node.id];
  return [
    ...collectLayoutLeafIdsInOrder(node.first),
    ...collectLayoutLeafIdsInOrder(node.second),
  ];
}

export function findLeafInLayout(node: PaneLayoutNode, leafId: string): boolean {
  if (node.type === 'leaf') return node.id === leafId;
  return findLeafInLayout(node.first, leafId) || findLeafInLayout(node.second, leafId);
}

export function splitLeafInLayout(
  node: PaneLayoutNode,
  targetLeafId: string,
  newLeafId: string,
  direction: SplitDirection,
  ratio = DEFAULT_SPLIT_RATIO,
): { layout: PaneLayoutNode; inserted: boolean } {
  if (node.type === 'leaf') {
    if (node.id !== targetLeafId) {
      return { layout: node, inserted: false };
    }
    return {
      layout: {
        type: 'split',
        direction,
        ratio: clampSplitRatio(ratio),
        first: { type: 'leaf', id: targetLeafId },
        second: { type: 'leaf', id: newLeafId },
      },
      inserted: true,
    };
  }

  const firstAttempt = splitLeafInLayout(node.first, targetLeafId, newLeafId, direction, ratio);
  if (firstAttempt.inserted) {
    return {
      layout: { ...node, first: firstAttempt.layout },
      inserted: true,
    };
  }

  const secondAttempt = splitLeafInLayout(node.second, targetLeafId, newLeafId, direction, ratio);
  if (secondAttempt.inserted) {
    return {
      layout: { ...node, second: secondAttempt.layout },
      inserted: true,
    };
  }

  return { layout: node, inserted: false };
}

function firstLeafId(node: PaneLayoutNode): string {
  return node.type === 'leaf' ? node.id : firstLeafId(node.first);
}

function lastLeafId(node: PaneLayoutNode): string {
  return node.type === 'leaf' ? node.id : lastLeafId(node.second);
}

export function removeLeafFromLayout(
  node: PaneLayoutNode,
  targetLeafId: string,
): { layout: PaneLayoutNode | null; removed: boolean; fallbackFocusId: string | null } {
  if (node.type === 'leaf') {
    if (node.id === targetLeafId) {
      return { layout: null, removed: true, fallbackFocusId: null };
    }
    return { layout: node, removed: false, fallbackFocusId: null };
  }

  if (node.first.type === 'leaf' && node.first.id === targetLeafId) {
    return {
      layout: node.second,
      removed: true,
      fallbackFocusId: firstLeafId(node.second),
    };
  }

  if (node.second.type === 'leaf' && node.second.id === targetLeafId) {
    return {
      layout: node.first,
      removed: true,
      fallbackFocusId: lastLeafId(node.first),
    };
  }

  const firstRes = removeLeafFromLayout(node.first, targetLeafId);
  if (firstRes.removed) {
    if (!firstRes.layout) {
      return {
        layout: node.second,
        removed: true,
        fallbackFocusId: firstLeafId(node.second),
      };
    }
    return {
      layout: { ...node, first: firstRes.layout },
      removed: true,
      fallbackFocusId: firstRes.fallbackFocusId ?? firstLeafId(firstRes.layout),
    };
  }

  const secondRes = removeLeafFromLayout(node.second, targetLeafId);
  if (secondRes.removed) {
    if (!secondRes.layout) {
      return {
        layout: node.first,
        removed: true,
        fallbackFocusId: lastLeafId(node.first),
      };
    }
    return {
      layout: { ...node, second: secondRes.layout },
      removed: true,
      fallbackFocusId: secondRes.fallbackFocusId ?? lastLeafId(secondRes.layout),
    };
  }

  return { layout: node, removed: false, fallbackFocusId: null };
}

export function setSplitRatioAtPath(
  node: PaneLayoutNode,
  path: SplitNodePath,
  ratio: number,
): PaneLayoutNode {
  if (node.type === 'leaf') return node;
  if (path.length === 0) {
    const nextRatio = clampSplitRatio(ratio);
    return nextRatio === node.ratio ? node : { ...node, ratio: nextRatio };
  }
  const [branch, ...rest] = path;
  if (branch === 'first') {
    const updated = setSplitRatioAtPath(node.first, rest, ratio);
    return updated === node.first ? node : { ...node, first: updated };
  }
  const updated = setSplitRatioAtPath(node.second, rest, ratio);
  return updated === node.second ? node : { ...node, second: updated };
}

export function equalizePaneTree(node: PaneLayoutNode): PaneLayoutNode {
  if (node.type === 'leaf') return node;
  const first = equalizePaneTree(node.first);
  const second = equalizePaneTree(node.second);
  if (node.ratio === DEFAULT_SPLIT_RATIO && first === node.first && second === node.second) {
    return node;
  }
  return { ...node, ratio: DEFAULT_SPLIT_RATIO, first, second };
}

export function replaceLeafId(
  node: PaneLayoutNode,
  oldId: string,
  newId: string,
): PaneLayoutNode {
  if (oldId === newId) return node;
  if (node.type === 'leaf') {
    return node.id === oldId ? { type: 'leaf', id: newId } : node;
  }
  const first = replaceLeafId(node.first, oldId, newId);
  const second = replaceLeafId(node.second, oldId, newId);
  if (first === node.first && second === node.second) return node;
  return { ...node, first, second };
}

export function computeLeafBounds(
  node: PaneLayoutNode,
  rect: PaneRect = { x: 0, y: 0, width: 1, height: 1 },
  out = new Map<string, PaneRect>(),
): Map<string, PaneRect> {
  if (node.type === 'leaf') {
    out.set(node.id, rect);
    return out;
  }
  const ratio = clampSplitRatio(node.ratio);
  if (node.direction === 'horizontal') {
    const firstWidth = rect.width * ratio;
    computeLeafBounds(
      node.first,
      { x: rect.x, y: rect.y, width: firstWidth, height: rect.height },
      out,
    );
    computeLeafBounds(
      node.second,
      { x: rect.x + firstWidth, y: rect.y, width: rect.width - firstWidth, height: rect.height },
      out,
    );
  } else {
    const firstHeight = rect.height * ratio;
    computeLeafBounds(
      node.first,
      { x: rect.x, y: rect.y, width: rect.width, height: firstHeight },
      out,
    );
    computeLeafBounds(
      node.second,
      { x: rect.x, y: rect.y + firstHeight, width: rect.width, height: rect.height - firstHeight },
      out,
    );
  }
  return out;
}

export function findNeighborLeafId(
  node: PaneLayoutNode,
  currentLeafId: string,
  direction: PaneNavigateDirection,
): string | null {
  const ordered = collectLayoutLeafIdsInOrder(node);
  if (ordered.length <= 1) return null;
  const idx = ordered.indexOf(currentLeafId);
  if (idx === -1) return ordered[0] ?? null;

  if (direction === 'next') {
    return ordered[(idx + 1) % ordered.length] ?? null;
  }
  if (direction === 'prev') {
    return ordered[(idx - 1 + ordered.length) % ordered.length] ?? null;
  }

  const bounds = computeLeafBounds(node);
  const cur = bounds.get(currentLeafId);
  if (!cur) return null;

  const curCenterX = cur.x + cur.width / 2;
  const curCenterY = cur.y + cur.height / 2;
  const EPS = 1e-6;

  let bestId: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const [candidateId, cand] of bounds) {
    if (candidateId === currentLeafId) continue;

    let primaryGap = 0;
    let perpOverlap = 0;
    let perpDist = 0;

    if (direction === 'right') {
      if (cand.x + EPS < cur.x + cur.width) continue;
      primaryGap = Math.max(0, cand.x - (cur.x + cur.width));
      perpOverlap = Math.max(0, Math.min(cur.y + cur.height, cand.y + cand.height) - Math.max(cur.y, cand.y));
      perpDist = Math.abs(cand.y + cand.height / 2 - curCenterY);
    } else if (direction === 'left') {
      if (cand.x + cand.width - EPS > cur.x) continue;
      primaryGap = Math.max(0, cur.x - (cand.x + cand.width));
      perpOverlap = Math.max(0, Math.min(cur.y + cur.height, cand.y + cand.height) - Math.max(cur.y, cand.y));
      perpDist = Math.abs(cand.y + cand.height / 2 - curCenterY);
    } else if (direction === 'down') {
      if (cand.y + EPS < cur.y + cur.height) continue;
      primaryGap = Math.max(0, cand.y - (cur.y + cur.height));
      perpOverlap = Math.max(0, Math.min(cur.x + cur.width, cand.x + cand.width) - Math.max(cur.x, cand.x));
      perpDist = Math.abs(cand.x + cand.width / 2 - curCenterX);
    } else {
      if (cand.y + cand.height - EPS > cur.y) continue;
      primaryGap = Math.max(0, cur.y - (cand.y + cand.height));
      perpOverlap = Math.max(0, Math.min(cur.x + cur.width, cand.x + cand.width) - Math.max(cur.x, cand.x));
      perpDist = Math.abs(cand.x + cand.width / 2 - curCenterX);
    }

    const overlapPenalty = perpOverlap > EPS ? 0 : 10;
    const score = primaryGap * 100 + overlapPenalty + perpDist;
    if (score < bestScore) {
      bestScore = score;
      bestId = candidateId;
    }
  }

  return bestId;
}
