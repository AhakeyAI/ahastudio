// Adapted from T3 Code apps/web/src/lib/imageCompression.ts (https://github.com/pingdotgg/t3code).
// MIT, Copyright (c) 2026 T3 Tools Inc. Trimmed to what the session composer needs: no HEIC, no stash.

/** Longest edge an attached image keeps; larger photos and screenshots are scaled down to it. */
export const IMAGE_MAX_EDGE = 2000;
/** Decoding enormous sources can exhaust the renderer before they are resized. */
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const QUALITY_STEPS = [0.92, 0.85, 0.78, 0.68] as const;
const FALLBACK_SCALE_STEPS = [0.75, 0.55] as const;
/** GIFs may be animated; re-encoding through a canvas would keep only the first frame. */
const RESIZABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export type PrepareImageResult =
  | { ok: true; file: File; recompressed: boolean }
  | { ok: false; reason: 'too-large' | 'unreadable' };

interface Canvas2D {
  canvas: OffscreenCanvas | HTMLCanvasElement;
  context: OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D;
}

/** The size that fits `IMAGE_MAX_EDGE`, or null when the image already fits. */
export function fitToMaxEdge(size: { width: number; height: number }, maxEdge = IMAGE_MAX_EDGE) {
  const longest = Math.max(size.width, size.height);
  if (longest <= maxEdge || longest <= 0) return null;
  const scale = maxEdge / longest;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

const canRecompress = () => typeof createImageBitmap === 'function'
  && (typeof OffscreenCanvas === 'function' || typeof document !== 'undefined');

function createCanvas(width: number, height: number): Canvas2D | null {
  if (typeof OffscreenCanvas === 'function') {
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d');
    return context ? { canvas, context } : null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  return context ? { canvas, context } : null;
}

async function encodeCanvas(canvas: OffscreenCanvas | HTMLCanvasElement, quality: number, type: string): Promise<Blob | null> {
  const blob = typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement
    ? await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality))
    : await (canvas as OffscreenCanvas).convertToBlob({ type, quality });
  return blob?.type === type ? blob : null;
}

function renamed(name: string, type: string): string {
  const extension = type === 'image/webp' ? '.webp' : type === 'image/png' ? '.png' : '.jpg';
  const dot = name.lastIndexOf('.');
  return `${dot > 0 ? name.slice(0, dot) : name || 'image'}${extension}`;
}

function draw(bitmap: ImageBitmap, width: number, height: number, matte: boolean): Canvas2D | null {
  const target = createCanvas(width, height);
  if (!target) return null;
  // JPEG has no alpha, so transparent pixels need a white background instead of black.
  if (matte) {
    target.context.fillStyle = '#ffffff';
    target.context.fillRect(0, 0, width, height);
  }
  target.context.imageSmoothingQuality = 'high';
  target.context.drawImage(bitmap, 0, 0, width, height);
  return target;
}

/**
 * Scales an image down to `IMAGE_MAX_EDGE` and, if it is still over `maxBytes`, re-encodes it as
 * WebP (or JPEG) at falling quality and size until it fits. Small images are sent unchanged.
 */
export async function prepareImageForAttachment(file: File, maxBytes: number): Promise<PrepareImageResult> {
  if (!RESIZABLE_TYPES.has(file.type) || !canRecompress()) {
    return file.size <= maxBytes ? { ok: true, file, recompressed: false } : { ok: false, reason: 'too-large' };
  }
  if (file.size > MAX_SOURCE_BYTES) return { ok: false, reason: 'too-large' };
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const fitted = fitToMaxEdge(bitmap);
    if (!fitted && file.size <= maxBytes) return { ok: true, file, recompressed: false };
    let current = file;
    if (fitted) {
      const target = draw(bitmap, fitted.width, fitted.height, file.type === 'image/jpeg');
      const blob = target && await encodeCanvas(target.canvas, QUALITY_STEPS[0], file.type);
      if (blob) {
        current = new File([blob], file.name, { type: file.type, lastModified: file.lastModified });
        if (blob.size <= maxBytes) return { ok: true, file: current, recompressed: true };
      }
    }
    const base = Math.min(IMAGE_MAX_EDGE, Math.max(bitmap.width, bitmap.height));
    for (const scale of [1, ...FALLBACK_SCALE_STEPS]) {
      const size = fitToMaxEdge(bitmap, Math.max(1, Math.round(base * scale))) ?? { width: bitmap.width, height: bitmap.height };
      const probe = createCanvas(1, 1);
      const type = probe && await encodeCanvas(probe.canvas, QUALITY_STEPS[0], 'image/webp') ? 'image/webp' : 'image/jpeg';
      const target = draw(bitmap, size.width, size.height, type === 'image/jpeg');
      if (!target) break;
      for (const quality of QUALITY_STEPS) {
        const blob = await encodeCanvas(target.canvas, quality, type);
        if (!blob) break;
        if (blob.size <= maxBytes) {
          return { ok: true, file: new File([blob], renamed(file.name, type), { type }), recompressed: true };
        }
      }
    }
    return current.size <= maxBytes ? { ok: true, file: current, recompressed: true } : { ok: false, reason: 'too-large' };
  } catch {
    return { ok: false, reason: 'unreadable' };
  } finally {
    bitmap.close();
  }
}
