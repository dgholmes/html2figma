import { describe, expect, it } from 'vitest';
import { gradientTransformForLine, gradientTransformForRadial, invertTransform, toFigmaBlendMode, toFigmaEffects, toFigmaPaint } from '../src/main/paints';

const near = (t: number[][], expected: number[][]) => t.forEach((row, i) => row.forEach((v, j) => expect(v).toBeCloseTo(expected[i][j], 5)));

describe('transform math', () => {
  it('inverts affine transforms', () => {
    near(invertTransform([[2, 0, 4], [0, 4, 8]]), [[0.5, 0, -2], [0, 0.25, -2]]);
  });
  it('gives identity for the default left-to-right gradient', () => {
    near(gradientTransformForLine({ x: 0, y: 0.5 }, { x: 1, y: 0.5 }), [[1, 0, 0], [0, 1, 0]]);
  });
  it('matches Figma\'s known top-to-bottom transform', () => {
    near(gradientTransformForLine({ x: 0.5, y: 0 }, { x: 0.5, y: 1 }), [[0, 1, 0], [-1, 0, 1]]);
  });
  it('maps a centered radial with radius 0.5 to identity', () => {
    near(gradientTransformForRadial({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }), [[1, 0, 0], [0, 1, 0]]);
  });
});

describe('toFigmaPaint', () => {
  const images = new Map([['a1', 'hash1']]);
  it('converts solids with alpha to opacity', () => {
    expect(toFigmaPaint({ type: 'solid', color: { r: 1, g: 0.5, b: 0, a: 0.25 } }, images)).toEqual({ type: 'SOLID', color: { r: 1, g: 0.5, b: 0 }, opacity: 0.25 });
  });
  it('converts linear gradients with stops', () => {
    const p = toFigmaPaint({ type: 'gradient', gradient: 'linear', stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } }], start: { x: 0, y: 0.5 }, end: { x: 1, y: 0.5 } }, images) as GradientPaint;
    expect(p.type).toBe('GRADIENT_LINEAR');
    expect(p.gradientStops[1]).toEqual({ position: 1, color: { r: 0, g: 0, b: 1, a: 0.5 } });
  });
  it('converts image paints and drops missing assets', () => {
    expect(toFigmaPaint({ type: 'image', assetId: 'a1', scaleMode: 'fill' }, images)).toEqual({ type: 'IMAGE', imageHash: 'hash1', scaleMode: 'FILL', opacity: 1 });
    expect(toFigmaPaint({ type: 'image', assetId: 'a1', scaleMode: 'tile', scale: 0.5 }, images)).toMatchObject({ scaleMode: 'TILE', scalingFactor: 0.5 });
    expect(toFigmaPaint({ type: 'image', assetId: 'a1', scaleMode: 'crop', transform: [[0.5, 0, 0.25], [0, 1, 0]] }, images)).toMatchObject({ scaleMode: 'CROP', imageTransform: [[0.5, 0, 0.25], [0, 1, 0]] });
    expect(toFigmaPaint({ type: 'image', assetId: 'missing', scaleMode: 'fill' }, images)).toBeNull();
  });
});

describe('effects and blend modes', () => {
  it('converts shadows and blurs', () => {
    expect(toFigmaEffects([
      { type: 'drop-shadow', color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y: 4 }, blur: 12, spread: 2 },
      { type: 'inner-shadow', color: { r: 1, g: 1, b: 1, a: 1 }, offset: { x: 1, y: 1 }, blur: 0, spread: 0 },
      { type: 'layer-blur', radius: 5 },
      { type: 'background-blur', radius: 20 },
    ])).toEqual([
      { type: 'DROP_SHADOW', color: { r: 0, g: 0, b: 0, a: 0.3 }, offset: { x: 0, y: 4 }, radius: 12, spread: 2, visible: true, blendMode: 'NORMAL' },
      { type: 'INNER_SHADOW', color: { r: 1, g: 1, b: 1, a: 1 }, offset: { x: 1, y: 1 }, radius: 0, spread: 0, visible: true, blendMode: 'NORMAL' },
      { type: 'LAYER_BLUR', radius: 5, visible: true },
      { type: 'BACKGROUND_BLUR', radius: 20, visible: true },
    ]);
  });
  it('maps css blend modes', () => {
    expect(toFigmaBlendMode('normal')).toBe('NORMAL');
    expect(toFigmaBlendMode('multiply')).toBe('MULTIPLY');
    expect(toFigmaBlendMode('color-dodge')).toBe('COLOR_DODGE');
    expect(toFigmaBlendMode('plus-lighter')).toBe('NORMAL');
  });
});
