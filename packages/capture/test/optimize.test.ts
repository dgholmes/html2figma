import { describe, expect, it, vi } from 'vitest';
import { IMAGE_QUALITY, canvasHasAlpha, chooseStoredRaster, encodeRaster, targetRasterSize } from '../src/optimize';

function stubCanvas(over: { getContext?: () => unknown; toDataURL?: (mime?: string, q?: number) => string } = {}) {
  return {
    width: 0,
    height: 0,
    getContext: vi.fn(over.getContext ?? (() => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) }))),
    toDataURL: vi.fn(over.toDataURL ?? ((mime = 'image/png') => `data:${mime};base64,ZZZZ`)),
  };
}
const stubDoc = (canvas: unknown) => ({ createElement: vi.fn(() => canvas) }) as unknown as Document;

describe('IMAGE_QUALITY presets', () => {
  it('keeps original bytes at density 0 and raises density with quality', () => {
    expect(IMAGE_QUALITY.original.density).toBe(0);
    expect(IMAGE_QUALITY.balanced.density).toBeGreaterThan(0);
    expect(IMAGE_QUALITY.high.density).toBeGreaterThan(IMAGE_QUALITY.balanced.density);
    expect(IMAGE_QUALITY.high.jpegQuality).toBeGreaterThan(IMAGE_QUALITY.balanced.jpegQuality);
  });
});

describe('targetRasterSize', () => {
  it('scales a huge photo down to its display size times the density', () => {
    // the real case from layrd.pro: a 3664x4579 gallery photo shown in a ~400x500 box
    expect(targetRasterSize({ width: 3664, height: 4579 }, { width: 400, height: 500 }, 2)).toEqual({ width: 800, height: 1000 });
  });

  it('covers the display box when the aspect ratios differ (object-fit: cover)', () => {
    // a wide source in a tall box must keep enough pixels to fill the box's height
    expect(targetRasterSize({ width: 4000, height: 1000 }, { width: 200, height: 400 }, 1)).toEqual({ width: 1600, height: 400 });
  });

  it('never upscales past the natural size', () => {
    expect(targetRasterSize({ width: 100, height: 100 }, { width: 400, height: 400 }, 2)).toEqual({ width: 100, height: 100 });
  });

  it('clamps to the Figma raster limit, with or without a display size', () => {
    expect(targetRasterSize({ width: 8000, height: 4000 }, null, 2)).toEqual({ width: 4096, height: 2048 });
    expect(targetRasterSize({ width: 9000, height: 9000 }, { width: 5000, height: 5000 }, 2)).toEqual({ width: 4096, height: 4096 });
  });

  it('keeps the natural size when it is already small and no display size is known', () => {
    expect(targetRasterSize({ width: 320, height: 240 }, null, 2)).toEqual({ width: 320, height: 240 });
  });

  it('rounds to whole pixels and never returns a zero dimension', () => {
    expect(targetRasterSize({ width: 1000, height: 1000 }, { width: 33.4, height: 33.4 }, 1)).toEqual({ width: 33, height: 33 });
    expect(targetRasterSize({ width: 1000, height: 1000 }, { width: 0.1, height: 0.1 }, 1)).toEqual({ width: 1, height: 1 });
  });

  it('treats a zero or missing display box as unknown rather than scaling to nothing', () => {
    expect(targetRasterSize({ width: 800, height: 600 }, { width: 0, height: 0 }, 2)).toEqual({ width: 800, height: 600 });
  });
});

describe('canvasHasAlpha', () => {
  const ctxWith = (data: number[]) => ({ getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(data) })) }) as unknown as CanvasRenderingContext2D;

  it('is false when every pixel is fully opaque', () => {
    expect(canvasHasAlpha(ctxWith([10, 20, 30, 255, 40, 50, 60, 255]), 2, 1)).toBe(false);
  });

  it('is true when any pixel is not fully opaque', () => {
    expect(canvasHasAlpha(ctxWith([10, 20, 30, 255, 40, 50, 60, 128]), 2, 1)).toBe(true);
  });

  it('assumes alpha when the pixels cannot be read, so nothing is silently flattened', () => {
    const ctx = { getImageData: () => { throw new DOMException('tainted', 'SecurityError'); } } as unknown as CanvasRenderingContext2D;
    expect(canvasHasAlpha(ctx, 10, 10)).toBe(true);
  });
});

describe('encodeRaster', () => {
  it('encodes an opaque image as JPEG at the requested quality and size', () => {
    const drawImage = vi.fn();
    const canvas = stubCanvas({
      getContext: () => ({ drawImage, getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 255]) }) }),
      toDataURL: (mime) => `data:${mime};base64,JJJJ`,
    });
    const result = encodeRaster({} as CanvasImageSource, { width: 800, height: 1000 }, stubDoc(canvas), 0.82);
    expect(result).toEqual({ mime: 'image/jpeg', data: 'JJJJ', width: 800, height: 1000 });
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(1000);
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 800, 1000);
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/jpeg', 0.82);
  });

  it('keeps PNG when the image has transparency', () => {
    const canvas = stubCanvas({
      getContext: () => ({ drawImage: vi.fn(), getImageData: () => ({ data: new Uint8ClampedArray([1, 2, 3, 0]) }) }),
    });
    const result = encodeRaster({} as CanvasImageSource, { width: 64, height: 64 }, stubDoc(canvas), 0.82);
    expect(result!.mime).toBe('image/png');
    expect(canvas.toDataURL).toHaveBeenCalledWith('image/png');
  });

  it('returns null when there is no 2d context', () => {
    expect(encodeRaster({} as CanvasImageSource, { width: 10, height: 10 }, stubDoc(stubCanvas({ getContext: () => null })), 0.8)).toBeNull();
  });

  it('returns null instead of throwing when the canvas is tainted', () => {
    const canvas = stubCanvas({ toDataURL: () => { throw new DOMException('tainted', 'SecurityError'); } });
    expect(encodeRaster({} as CanvasImageSource, { width: 10, height: 10 }, stubDoc(canvas), 0.8)).toBeNull();
  });

  it('refuses a zero-sized target without touching the document', () => {
    const doc = { createElement: vi.fn() } as unknown as Document;
    expect(encodeRaster({} as CanvasImageSource, { width: 0, height: 10 }, doc, 0.8)).toBeNull();
    expect(doc.createElement).not.toHaveBeenCalled();
  });
});

describe('chooseStoredRaster', () => {
  const original = { mime: 'image/jpeg', data: 'x'.repeat(1000) };
  const natural = { width: 900, height: 600 };

  it('stores the re-encoded image when it is smaller than the original', () => {
    const encoded = { mime: 'image/jpeg', data: 'y'.repeat(120), width: 450, height: 300 };
    expect(chooseStoredRaster(original, encoded, natural)).toEqual({ mime: 'image/jpeg', data: 'y'.repeat(120), width: 450, height: 300 });
  });

  it('keeps the original when re-encoding made it bigger, so small images are never bloated', () => {
    const encoded = { mime: 'image/png', data: 'y'.repeat(4000), width: 900, height: 600 };
    expect(chooseStoredRaster(original, encoded, natural)).toEqual({ mime: 'image/jpeg', data: original.data, width: 900, height: 600 });
  });

  it('keeps the original when encoding was not possible', () => {
    expect(chooseStoredRaster(original, null, natural)).toEqual({ mime: 'image/jpeg', data: original.data, width: 900, height: 600 });
  });
});
