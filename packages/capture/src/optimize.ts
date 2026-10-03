// Raster image optimization.
//
// Capture used to store every image's original bytes. On a real page that is
// overwhelmingly the whole file: a measured capture of layrd.pro came to 42 MB, of
// which 42 MB was image payloads and 0.15 MB the actual layer tree — gallery photos
// stored at 3664x4579 while displayed a few hundred pixels wide, and video frames
// saved as PNG, the worst format for photographic content. Storing each image at the
// size it is actually used, in a format that suits its content, is what keeps a
// capture small enough to hand to Figma through the clipboard.

import { MAX_RASTER } from './media';

export type ImageQualityName = 'original' | 'balanced' | 'high';

export interface ImageQuality {
  /** Multiplier on the CSS display size. 0 means "keep the original bytes untouched". */
  density: number;
  /** Quality passed to the JPEG encoder, 0..1. */
  jpegQuality: number;
}

export const IMAGE_QUALITY: Record<ImageQualityName, ImageQuality> = {
  original: { density: 0, jpegQuality: 1 },
  balanced: { density: 2, jpegQuality: 0.82 },
  high: { density: 3, jpegQuality: 0.92 },
};

export interface Size { width: number; height: number }

export interface EncodedRaster { mime: string; data: string; width: number; height: number }

/**
 * The size an image should be stored at: large enough to cover its display box at
 * `density` device pixels, never larger than the source, never past Figma's limit.
 */
export function targetRasterSize(natural: Size, display: Size | null, density: number): Size {
  const nw = Math.max(1, natural.width);
  const nh = Math.max(1, natural.height);
  // `max` rather than `min`: with object-fit: cover the display box is filled by the
  // larger axis, so fitting the smaller one would throw away pixels that stay visible.
  const wanted = display && display.width > 0 && display.height > 0 && density > 0
    ? Math.max((display.width * density) / nw, (display.height * density) / nh)
    : 1;
  const limit = Math.min(1, MAX_RASTER / Math.max(nw, nh));
  const scale = Math.min(wanted, 1, limit);
  return { width: Math.max(1, Math.round(nw * scale)), height: Math.max(1, Math.round(nh * scale)) };
}

/** True when any pixel is not fully opaque. Unreadable pixels count as alpha, so nothing is flattened by accident. */
export function canvasHasAlpha(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  try {
    const { data } = ctx.getImageData(0, 0, width, height);
    for (let i = 3; i < data.length; i += 4) if (data[i] < 255) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * Pick what actually gets stored. Re-encoding only wins when it produces fewer bytes —
 * an already-small or already-optimal image would otherwise be made larger by a round trip
 * through the canvas.
 */
export function chooseStoredRaster(
  original: { mime: string; data: string },
  encoded: EncodedRaster | null,
  natural: Size,
): EncodedRaster {
  if (encoded && encoded.data.length < original.data.length) return encoded;
  return { mime: original.mime, data: original.data, width: natural.width, height: natural.height };
}

/** Draw `source` at `target` and encode it: JPEG when opaque, PNG when it carries transparency. */
export function encodeRaster(source: CanvasImageSource, target: Size, doc: Document, jpegQuality: number): EncodedRaster | null {
  const width = Math.round(target.width);
  const height = Math.round(target.height);
  if (!(width > 0 && height > 0)) return null;
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, width, height);
    const mime = canvasHasAlpha(ctx, width, height) ? 'image/png' : 'image/jpeg';
    const url = mime === 'image/jpeg' ? canvas.toDataURL(mime, jpegQuality) : canvas.toDataURL(mime);
    const data = url.split(',')[1];
    return data ? { mime, data, width, height } : null;
  } catch {
    return null;
  }
}
