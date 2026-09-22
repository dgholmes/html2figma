import { describe, expect, it, vi } from 'vitest';
import { createCanvasNormalizer, isVisible, parseColor } from '../src/color';

describe('parseColor', () => {
  it('parses hex forms', () => {
    expect(parseColor('#fff')).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseColor('#0000')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('#FF8000')).toEqual({ r: 1, g: 128 / 255, b: 0, a: 1 });
    expect(parseColor('#ff800080')!.a).toBeCloseTo(128 / 255, 5);
  });
  it('parses rgb()/rgba() in comma and space syntax', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
    expect(parseColor('rgba(0, 0, 0, 0.5)')).toEqual({ r: 0, g: 0, b: 0, a: 0.5 });
    expect(parseColor('rgb(0 128 255 / 50%)')).toEqual({ r: 0, g: 128 / 255, b: 1, a: 0.5 });
    expect(parseColor('rgb(100%, 0%, 0%)')).toEqual({ r: 1, g: 0, b: 0, a: 1 });
  });
  it('handles keywords', () => {
    expect(parseColor('transparent')).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(parseColor('rebeccapurple')).toEqual({ r: 102 / 255, g: 51 / 255, b: 153 / 255, a: 1 });
    expect(parseColor('currentcolor')).toBeNull();
    expect(parseColor(null)).toBeNull();
  });
  it('delegates unknown syntaxes to the normalizer', () => {
    const normalizer = vi.fn(() => ({ r: 0.1, g: 0.2, b: 0.3, a: 1 }));
    expect(parseColor('oklch(0.15 0.004 95)', normalizer)).toEqual({ r: 0.1, g: 0.2, b: 0.3, a: 1 });
    expect(normalizer).toHaveBeenCalledWith('oklch(0.15 0.004 95)');
    expect(parseColor('oklch(0.15 0.004 95)')).toBeNull();
  });
});

describe('createCanvasNormalizer', () => {
  it('reads the pixel back from a canvas context and memoizes', () => {
    const data = new Uint8ClampedArray([255, 128, 0, 255]);
    const ctx = {
      fillStyle: '' as string,
      clearRect: vi.fn(),
      fillRect: vi.fn(),
      getImageData: vi.fn(() => ({ data })),
    };
    const canvas = { width: 0, height: 0, getContext: vi.fn(() => ctx) } as unknown as HTMLCanvasElement;
    const doc = { createElement: vi.fn(() => canvas) } as unknown as Document;
    const normalize = createCanvasNormalizer(doc);
    expect(normalize('oklch(0.7 0.2 60)')).toEqual({ r: 1, g: 128 / 255, b: 0, a: 1 });
    normalize('oklch(0.7 0.2 60)');
    expect(ctx.fillRect).toHaveBeenCalledTimes(1);
  });
  it('returns null when the browser rejects the color', () => {
    const ctx = {
      _fs: '',
      get fillStyle() { return this._fs; },
      set fillStyle(v: string) { if (v.startsWith('rgba(1, 2, 3') || v === 'valid') this._fs = v === 'valid' ? '#123456' : 'rgba(1, 2, 3, 0.5)'; },
      clearRect: vi.fn(), fillRect: vi.fn(), getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 0]) })),
    };
    const canvas = { getContext: () => ctx } as unknown as HTMLCanvasElement;
    const doc = { createElement: () => canvas } as unknown as Document;
    expect(createCanvasNormalizer(doc)('not-a-color')).toBeNull();
  });
});

describe('isVisible', () => {
  it('is false for null and fully transparent', () => {
    expect(isVisible(null)).toBe(false);
    expect(isVisible({ r: 1, g: 1, b: 1, a: 0 })).toBe(false);
    expect(isVisible({ r: 1, g: 1, b: 1, a: 0.2 })).toBe(true);
  });
});
