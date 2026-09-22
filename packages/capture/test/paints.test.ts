import { describe, expect, it } from 'vitest';
import { parseColor } from '../src/color';
import { backgroundPlacement, cropTransform, directionToAngle, extractUrl, linearGradientLine, parseBackgroundLayers, parseGradient, scaleModeForObjectFit } from '../src/paints';

const color = (s: string | null | undefined) => parseColor(s);

describe('linearGradientLine', () => {
  it('maps 180deg (to bottom) to a vertical line through the center', () => {
    const { start, end } = linearGradientLine(180, 200, 100);
    expect(start.x).toBeCloseTo(0.5); expect(start.y).toBeCloseTo(0);
    expect(end.x).toBeCloseTo(0.5); expect(end.y).toBeCloseTo(1);
  });
  it('maps 90deg (to right) to a horizontal line', () => {
    const { start, end } = linearGradientLine(90, 200, 100);
    expect(start).toEqual({ x: expect.closeTo(0, 5), y: expect.closeTo(0.5, 5) });
    expect(end).toEqual({ x: expect.closeTo(1, 5), y: expect.closeTo(0.5, 5) });
  });
  it('extends the line so corners hit 0% and 100% for 45deg on a square', () => {
    const { start, end } = linearGradientLine(45, 100, 100);
    expect(start.x).toBeCloseTo(0); expect(start.y).toBeCloseTo(1);
    expect(end.x).toBeCloseTo(1); expect(end.y).toBeCloseTo(0);
  });
});

describe('directionToAngle', () => {
  it('handles sides and corners', () => {
    expect(directionToAngle('to top', 100, 100)).toBe(0);
    expect(directionToAngle('to right', 100, 100)).toBe(90);
    expect(directionToAngle('to bottom', 100, 100)).toBe(180);
    expect(directionToAngle('to left', 100, 100)).toBe(270);
    expect(directionToAngle('to top right', 100, 100)).toBeCloseTo(45);
    expect(directionToAngle('to right top', 200, 100)).toBeCloseTo(26.565, 2);
    expect(directionToAngle('to bottom left', 100, 100)).toBeCloseTo(225);
  });
});

describe('parseGradient', () => {
  it('parses a linear gradient with explicit stops', () => {
    const g = parseGradient('linear-gradient(90deg, rgb(255, 0, 0) 0%, rgba(0, 0, 255, 0.5) 100%)', 100, 50, color)!;
    expect(g.gradient).toBe('linear');
    expect(g.stops).toEqual([
      { position: 0, color: { r: 1, g: 0, b: 0, a: 1 } },
      { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } },
    ]);
    expect(g.start.x).toBeCloseTo(0); expect(g.end.x).toBeCloseTo(1);
  });
  it('distributes missing stop positions evenly and defaults to 180deg', () => {
    const g = parseGradient('linear-gradient(red, white, blue)', 100, 100, color)!;
    expect(g.stops.map((s) => s.position)).toEqual([0, 0.5, 1]);
    expect(g.start.y).toBeCloseTo(0); expect(g.end.y).toBeCloseTo(1);
  });
  it('converts px positions using the gradient line length and skips hints', () => {
    const g = parseGradient('linear-gradient(to right, red 0px, 25%, blue 50px)', 200, 100, color)!;
    expect(g.stops.map((s) => s.position)).toEqual([0, 0.25]);
  });
  it('treats repeating gradients as plain and parses direction keywords', () => {
    const g = parseGradient('repeating-linear-gradient(to top, red, blue)', 100, 100, color)!;
    expect(g.start.y).toBeCloseTo(1); expect(g.end.y).toBeCloseTo(0);
  });
  it('parses radial gradients with a center', () => {
    const g = parseGradient('radial-gradient(circle at 25% 50%, red, blue)', 200, 100, color)!;
    expect(g.gradient).toBe('radial');
    expect(g.center).toEqual({ x: 0.25, y: 0.5 });
    expect(g.radius!.x).toBeGreaterThan(0.5);
  });
  it('parses conic gradients as angular', () => {
    const g = parseGradient('conic-gradient(from 90deg, red, blue)', 100, 100, color)!;
    expect(g.gradient).toBe('angular');
    expect(g.center).toEqual({ x: 0.5, y: 0.5 });
    expect(g.end.x).toBeCloseTo(1); expect(g.end.y).toBeCloseTo(0.5);
  });
  it('returns null for non-gradients and single-color gradients', () => {
    expect(parseGradient('url("x.png")', 10, 10, color)).toBeNull();
    expect(parseGradient('linear-gradient(red)', 10, 10, color)).toBeNull();
  });
});

describe('background layers and placement', () => {
  it('parses multi-layer computed styles', () => {
    const cs = {
      backgroundImage: 'url("https://x/a.png"), linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))',
      backgroundSize: 'cover, auto',
      backgroundRepeat: 'no-repeat, repeat',
      backgroundPosition: '50% 50%, 0% 0%',
    } as unknown as CSSStyleDeclaration;
    expect(parseBackgroundLayers(cs)).toEqual([
      { image: 'url("https://x/a.png")', size: 'cover', repeat: 'no-repeat', position: '50% 50%' },
      { image: 'linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))', size: 'auto', repeat: 'repeat', position: '0% 0%' },
    ]);
    expect(parseBackgroundLayers({ backgroundImage: 'none' } as unknown as CSSStyleDeclaration)).toEqual([]);
  });
  it('extracts urls', () => {
    expect(extractUrl('url("https://x/a.png")')).toBe('https://x/a.png');
    expect(extractUrl("url('a.png')")).toBe('a.png');
    expect(extractUrl('url(a.png)')).toBe('a.png');
    expect(extractUrl('linear-gradient(red, blue)')).toBeNull();
  });
  it('computes cover, contain, auto and explicit placements', () => {
    const layer = (size: string, position = '0% 0%') => ({ image: '', size, repeat: 'no-repeat', position });
    expect(backgroundPlacement(layer('cover', '50% 50%'), 200, 100, 100, 100)).toEqual({ x: 0, y: -50, width: 200, height: 200 });
    expect(backgroundPlacement(layer('contain', '50% 50%'), 200, 100, 100, 100)).toEqual({ x: 50, y: 0, width: 100, height: 100 });
    expect(backgroundPlacement(layer('auto'), 200, 100, 40, 20)).toEqual({ x: 0, y: 0, width: 40, height: 20 });
    expect(backgroundPlacement(layer('50px auto', '100% 0%'), 200, 100, 40, 20)).toEqual({ x: 150, y: 0, width: 50, height: 25 });
    expect(backgroundPlacement(layer('50% 100%'), 200, 100, 40, 20)).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });
  it('builds a crop transform mapping node unit space into image unit space', () => {
    expect(cropTransform({ x: -50, y: 0, width: 200, height: 100 }, 100, 100)).toEqual([[0.5, 0, 0.25], [0, 1, 0]]);
  });
  it('maps object-fit', () => {
    expect(scaleModeForObjectFit('cover')).toBe('fill');
    expect(scaleModeForObjectFit('fill')).toBe('fill');
    expect(scaleModeForObjectFit('contain')).toBe('fit');
    expect(scaleModeForObjectFit('scale-down')).toBe('fit');
    expect(scaleModeForObjectFit('none')).toBe('crop');
  });
});
