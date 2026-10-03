import { describe, expect, it, vi } from 'vitest';
import { AssetStore } from '../src/assets';
import { IMAGE_QUALITY } from '../src/optimize';
import {
  assetFromUrl, canvasAsset, decodeBase64Utf8, drawToPng, inlineSvgAsset, parseDataUrl, svgIntrinsicSize, videoAsset, type MediaContext,
} from '../src/media';

const PNG_1x1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function ctx(loader: MediaContext['loader']): MediaContext {
  return { doc: document, store: new AssetStore(), loader, warnings: [], quality: IMAGE_QUALITY.original };
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
  it('does not throw when a loader claims svg but returns invalid base64', async () => {
    const c = ctx({ fetchAsBase64: async () => ({ mime: 'image/svg+xml', data: 'not valid base64!!' }) });
    await expect(assetFromUrl('https://x/broken.svg', c, 'img')).resolves.toBeNull();
    expect(c.warnings[0]).toMatch(/broken.svg/);
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

// Stub canvas objects (not real <canvas> elements) so jsdom never logs its
// "Not implemented: HTMLCanvasElement's getContext()" warning.
function stubCanvas(overrides: { getContext?: () => unknown; toDataURL?: () => string } = {}) {
  return {
    width: 0,
    height: 0,
    getContext: vi.fn(overrides.getContext ?? (() => ({ drawImage: vi.fn() }))),
    toDataURL: vi.fn(overrides.toDataURL ?? (() => 'data:image/png;base64,AAAA')),
  };
}

describe('drawToPng', () => {
  it('scales a source larger than MAX_RASTER down and forwards the scaled size to drawImage', () => {
    const drawImage = vi.fn();
    const canvas = stubCanvas({ getContext: () => ({ drawImage }) });
    const doc = { createElement: vi.fn(() => canvas) } as unknown as Document;
    const result = drawToPng({} as CanvasImageSource, 8000, 4000, doc);
    expect(result).toEqual({ data: 'AAAA', width: 4096, height: 2048 });
    expect(canvas.width).toBe(4096);
    expect(canvas.height).toBe(2048);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 4096, 2048);
  });
  it('returns null when the canvas has no 2d context', () => {
    const canvas = stubCanvas({ getContext: () => null });
    const doc = { createElement: vi.fn(() => canvas) } as unknown as Document;
    expect(drawToPng({} as CanvasImageSource, 100, 100, doc)).toBeNull();
  });
  it('returns null instead of throwing when the canvas is tainted (SecurityError)', () => {
    const canvas = stubCanvas({
      toDataURL: () => { throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError'); },
    });
    const doc = { createElement: vi.fn(() => canvas) } as unknown as Document;
    expect(drawToPng({} as CanvasImageSource, 100, 100, doc)).toBeNull();
  });
  it('returns null for zero or negative dimensions without touching the document', () => {
    const doc = { createElement: vi.fn() } as unknown as Document;
    expect(drawToPng({} as CanvasImageSource, 0, 100, doc)).toBeNull();
    expect(drawToPng({} as CanvasImageSource, 100, -5, doc)).toBeNull();
    expect(doc.createElement).not.toHaveBeenCalled();
  });
});

describe('canvasAsset', () => {
  it('stores a rendered canvas as an image asset with origin canvas', () => {
    const canvas = stubCanvas({ toDataURL: () => 'data:image/png;base64,QUJD' });
    canvas.width = 12;
    canvas.height = 34;
    const c = ctx({ fetchAsBase64: async () => null });
    const a = canvasAsset(canvas as unknown as HTMLCanvasElement, c);
    expect(a).toMatchObject({ kind: 'image', width: 12, height: 34 });
    expect(c.store.get(a!.id)).toMatchObject({ mime: 'image/png', origin: 'canvas', data: 'QUJD' });
  });
  it('warns and returns null instead of throwing when the canvas is tainted', () => {
    const canvas = stubCanvas({
      toDataURL: () => { throw new DOMException('The canvas has been tainted by cross-origin data.', 'SecurityError'); },
    });
    const c = ctx({ fetchAsBase64: async () => null });
    expect(canvasAsset(canvas as unknown as HTMLCanvasElement, c)).toBeNull();
    expect(c.warnings[0]).toMatch(/tainted/i);
  });
});

describe('inlineSvgAsset', () => {
  it('bakes computed style onto clones, strips class attributes, sets sizing/viewBox, and pulls a same-document <use> target into <defs>', () => {
    document.body.innerHTML = `
      <style>.icon { fill: currentColor; color: rgb(1, 2, 3); }</style>
      <svg id="src" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <rect class="icon" width="10" height="10"></rect>
        <use href="#external"></use>
      </svg>
      <rect id="external" width="5" height="5"></rect>
    `;
    const svg = document.getElementById('src') as unknown as SVGSVGElement;
    const c = ctx({ fetchAsBase64: async () => null });
    const id = inlineSvgAsset(svg, c, window, 24, 24);
    const asset = c.store.get(id) as { svg: string };
    expect(asset.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(asset.svg).toContain('xmlns:xlink="http://www.w3.org/1999/xlink"');
    expect(asset.svg).toContain('width="24"');
    expect(asset.svg).toContain('height="24"');
    expect(asset.svg).toContain('viewBox="0 0 24 24"');
    expect(asset.svg).not.toMatch(/class="/);
    expect(asset.svg).toMatch(/fill:\s*rgb\(1,\s*2,\s*3\)/);
    expect(asset.svg).toContain('<defs');
  });
  it('bakes computed style onto a <use> target pulled in from outside the svg, and strips its class', () => {
    document.body.innerHTML = `
      <style>.ext { fill: rgb(9, 9, 9); }</style>
      <svg id="src2" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
        <use href="#external2"></use>
      </svg>
      <svg style="display:none">
        <rect id="external2" class="ext" width="5" height="5"></rect>
      </svg>
    `;
    const svg = document.getElementById('src2') as unknown as SVGSVGElement;
    const c = ctx({ fetchAsBase64: async () => null });
    const id = inlineSvgAsset(svg, c, window, 24, 24);
    const asset = c.store.get(id) as { svg: string };
    expect(asset.svg).toContain('<defs');
    expect(asset.svg).toMatch(/fill:\s*rgb\(9,\s*9,\s*9\)/);
    expect(asset.svg).not.toMatch(/class="/);
  });
});
