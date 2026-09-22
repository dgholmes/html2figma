import { describe, expect, it, vi } from 'vitest';
import { AssetStore } from '../src/assets';
import { assetFromUrl, decodeBase64Utf8, parseDataUrl, svgIntrinsicSize, videoAsset, type MediaContext } from '../src/media';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function ctx(loader: MediaContext['loader']): MediaContext {
  return { doc: document, store: new AssetStore(), loader, warnings: [] };
}

describe('helpers', () => {
  it('parses data urls', () => {
    expect(parseDataUrl('data:image/png;base64,AAAA')).toEqual({ mime: 'image/png', data: 'AAAA' });
    expect(parseDataUrl('data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E')).toEqual({
      mime: 'image/svg+xml', data: btoa('<svg xmlns="http://www.w3.org/2000/svg"/>'),
    });
    expect(parseDataUrl('https://x')).toBeNull();
  });
  it('decodes utf8 base64', () => {
    expect(decodeBase64Utf8(btoa(unescape(encodeURIComponent('héllo'))))).toBe('héllo');
  });
  it('reads svg intrinsic size from width/height or viewBox', () => {
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="12"/>')).toEqual({ width: 24, height: 12 });
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"/>')).toEqual({ width: 100, height: 50 });
    expect(svgIntrinsicSize('<svg xmlns="http://www.w3.org/2000/svg"/>')).toBeNull();
  });
});

describe('assetFromUrl', () => {
  it('stores fetched svg as a vector asset and dedupes by url', async () => {
    const c = ctx({ fetchAsBase64: vi.fn(async () => ({ mime: 'image/svg+xml', data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="20"/>') })) });
    const a = await assetFromUrl('https://x/icon.svg', c, 'img');
    expect(a).toMatchObject({ kind: 'svg', width: 10, height: 20 });
    const b = await assetFromUrl('https://x/icon.svg', c, 'img');
    expect(b!.id).toBe(a!.id);
    expect(c.loader.fetchAsBase64).toHaveBeenCalledTimes(1);
  });
  it('stores fetched raster images using the fallback element dimensions', async () => {
    const c = ctx({ fetchAsBase64: async () => ({ mime: 'image/png', data: PNG_1x1 }) });
    const img = { naturalWidth: 640, naturalHeight: 480 } as HTMLImageElement;
    const a = await assetFromUrl('https://x/photo.png', c, 'img', img);
    expect(a).toMatchObject({ kind: 'image', width: 640, height: 480 });
    expect(c.store.get(a!.id)).toMatchObject({ mime: 'image/png', origin: 'img' });
  });
  it('warns and returns null when nothing works', async () => {
    const c = ctx({ fetchAsBase64: async () => null });
    expect(await assetFromUrl('https://x/missing.png', c, 'background')).toBeNull();
    expect(c.warnings[0]).toMatch(/missing.png/);
  });
  it('accepts data urls without calling the loader', async () => {
    const c = ctx({ fetchAsBase64: vi.fn(async () => null) });
    const a = await assetFromUrl(`data:image/png;base64,${PNG_1x1}`, c, 'img', { naturalWidth: 1, naturalHeight: 1 } as HTMLImageElement);
    expect(a).toMatchObject({ kind: 'image', width: 1, height: 1 });
    expect(c.loader.fetchAsBase64).not.toHaveBeenCalled();
  });
});

describe('videoAsset', () => {
  it('falls back to the poster when frames cannot be drawn', async () => {
    const c = ctx({ fetchAsBase64: async () => ({ mime: 'image/jpeg', data: 'QUJD' }) });
    const video = { readyState: 0, videoWidth: 0, videoHeight: 0, poster: 'https://x/poster.jpg', currentSrc: 'https://x/v.mp4', getBoundingClientRect: () => ({ width: 320, height: 180 }) } as unknown as HTMLVideoElement;
    const a = await videoAsset(video, c, true);
    expect(a.id).not.toBeNull();
    expect(a.label).toBe('(video poster)');
  });
  it('returns a null id with a label when nothing is available', async () => {
    const c = ctx({ fetchAsBase64: async () => null });
    const video = { readyState: 0, videoWidth: 0, videoHeight: 0, poster: '', currentSrc: '', getBoundingClientRect: () => ({ width: 320, height: 180 }) } as unknown as HTMLVideoElement;
    const a = await videoAsset(video, c, true);
    expect(a.id).toBeNull();
    expect(a.label).toBe('(video, frame unavailable)');
  });
});
