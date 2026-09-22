import { describe, expect, it } from 'vitest';
import { absoluteRect, computeGeometry, rectFromClientRects, unionRect } from '../src/geometry';

function fakeEl(rect: Partial<DOMRect>, extra: Record<string, unknown> = {}): Element {
  const r = { left: 0, top: 0, width: 0, height: 0, ...rect } as DOMRect;
  return { getBoundingClientRect: () => r, ...extra } as unknown as Element;
}
const win = { scrollX: 0, scrollY: 100 } as unknown as Window;

describe('rect helpers', () => {
  it('unions rects', () => {
    expect(unionRect({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toEqual({ x: 0, y: 0, width: 15, height: 15 });
  });
  it('adds scroll offsets to bounding rects', () => {
    expect(absoluteRect(fakeEl({ left: 10, top: 20, width: 30, height: 40 }), win)).toEqual({ x: 10, y: 120, width: 30, height: 40 });
  });
  it('unions client rects and ignores empty ones', () => {
    const rects = [
      { left: 0, top: 0, width: 50, height: 10 }, { left: 0, top: 10, width: 0, height: 0 }, { left: 10, top: 10, width: 20, height: 10 },
    ] as DOMRect[];
    expect(rectFromClientRects(rects, win)).toEqual({ x: 0, y: 100, width: 50, height: 20 });
    expect(rectFromClientRects([], win)).toBeNull();
  });
});

describe('computeGeometry', () => {
  const parent = { x: 100, y: 100, width: 500, height: 500 };
  it('positions relative to the parent without transforms', () => {
    const g = computeGeometry(fakeEl({ left: 150, top: 50, width: 20, height: 10 }), { transform: 'none' } as CSSStyleDeclaration, parent, win, true);
    expect(g).toMatchObject({ x: 50, y: 50, width: 20, height: 10, rotation: 0 });
    expect(g.abs).toEqual({ x: 150, y: 150, width: 20, height: 10 });
  });
  it('extracts rotation for a rotated leaf and keeps the unrotated size', () => {
    // 100x50 box rotated 90deg clockwise about its center at (200,200): bbox 50x100 centered there
    const el = fakeEl({ left: 175, top: 50, width: 50, height: 100 }, { offsetWidth: 100, offsetHeight: 50 });
    const g = computeGeometry(el, { transform: 'matrix(0, 1, -1, 0, 0, 0)' } as CSSStyleDeclaration, parent, win, true);
    expect(g.width).toBeCloseTo(100);
    expect(g.height).toBeCloseTo(50);
    expect(g.rotation).toBeCloseTo(-90);
    // transformed top-left corner = center (200,200) - linear·(50,25) = (200 - (0*50 + -1*25), 200 - (1*50 + 0*25)) = (225, 150) → minus parent
    expect(g.x).toBeCloseTo(125);
    expect(g.y).toBeCloseTo(50);
  });
  it('falls back to the bounding box when rotation is not allowed or the matrix skews', () => {
    const el = fakeEl({ left: 175, top: 50, width: 50, height: 100 }, { offsetWidth: 100, offsetHeight: 50 });
    expect(computeGeometry(el, { transform: 'matrix(0, 1, -1, 0, 0, 0)' } as CSSStyleDeclaration, parent, win, false)).toMatchObject({ width: 50, height: 100, rotation: 0 });
    expect(computeGeometry(el, { transform: 'matrix(1, 0, 0.5, 1, 0, 0)' } as CSSStyleDeclaration, parent, win, true)).toMatchObject({ rotation: 0 });
  });
});
