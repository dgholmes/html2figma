import type { ImageAsset } from '@h2f/schema';

export const MAX_DIM = 4096;
const NATIVE = new Set(['image/png', 'image/jpeg', 'image/gif']);

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function needsReencode(asset: ImageAsset): boolean {
  return !NATIVE.has(asset.mime) || asset.width > MAX_DIM || asset.height > MAX_DIM || asset.width <= 0 || asset.height <= 0;
}

async function toPng(source: ImageBitmap | HTMLImageElement, width: number, height: number): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const scale = Math.min(1, MAX_DIM / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no 2d context');
  ctx.drawImage(source, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return { bytes: new Uint8Array(await blob.arrayBuffer()), width: w, height: h };
}

export async function prepareImageAsset(asset: ImageAsset): Promise<{ bytes: Uint8Array; width: number; height: number } | null> {
  // I9: base64ToBytes ran outside this try, so malformed base64 (a corrupt/truncated download)
  // threw straight out of prepareImageAsset and, uncaught, out of startImport as an unhandled
  // rejection — the import button stayed disabled and the progress bar just stopped with no
  // message. Moving it inside means any decode failure is reported the same way an
  // unsupported-format image already is: this asset's fill is skipped, not the whole import.
  try {
    const bytes = base64ToBytes(asset.data);
    if (!needsReencode(asset)) return { bytes, width: asset.width, height: asset.height };
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: asset.mime }));
    const out = await toPng(bitmap, bitmap.width, bitmap.height);
    bitmap.close();
    return out;
  } catch {
    return null;
  }
}

export async function rasterizeSvg(svg: string, width: number, height: number): Promise<Uint8Array | undefined> {
  try {
    const img = new Image();
    const url = `data:image/svg+xml;base64,${bytesToBase64(new TextEncoder().encode(svg))}`;
    await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('svg decode failed')); img.src = url; });
    const w = (width || img.naturalWidth || 100) * 2;
    const h = (height || img.naturalHeight || 100) * 2;
    return (await toPng(img, w, h)).bytes;
  } catch {
    return undefined;
  }
}
