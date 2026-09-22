import { describe, expect, it } from 'vitest';
import { clampRadii, decomposeMatrix, isIdentityMatrix, parseCornerRadius, parseLength, parseMatrix, splitTopLevel } from '../src/css';

describe('splitTopLevel', () => {
  it('splits on top-level commas only', () => {
    expect(splitTopLevel('rgb(1, 2, 3) 0%, url("a,b.png"), linear-gradient(90deg, red, blue)')).toEqual([
      'rgb(1, 2, 3) 0%', 'url("a,b.png")', 'linear-gradient(90deg, red, blue)',
    ]);
  });
  it('returns [] for empty input', () => {
    expect(splitTopLevel('')).toEqual([]);
  });
});

describe('parseLength', () => {
  it('parses px and bare zero', () => {
    expect(parseLength('12.5px')).toBe(12.5);
    expect(parseLength('0')).toBe(0);
    expect(parseLength('-4px')).toBe(-4);
    expect(parseLength('auto')).toBe(0);
    expect(parseLength(null)).toBe(0);
  });
});

describe('parseMatrix / decomposeMatrix', () => {
  it('parses matrix() and detects identity', () => {
    const m = parseMatrix('matrix(1, 0, 0, 1, 0, 0)')!;
    expect(isIdentityMatrix(m)).toBe(true);
    expect(parseMatrix('none')).toBeNull();
  });
  it('parses 2D matrix3d and rejects true 3D', () => {
    expect(parseMatrix('matrix3d(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 0, 1)')).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 });
    expect(parseMatrix('matrix3d(1, 0, 0, 0, 0, 0.5, 0.8, 0, 0, -0.8, 0.5, 0, 0, 0, 0, 1)')).toBeNull();
  });
  it('decomposes rotation and uniform scale', () => {
    // rotate(30deg) scale(2): a = 2cos30, b = 2sin30, c = -2sin30, d = 2cos30
    const d = decomposeMatrix({ a: 1.7320508, b: 1, c: -1, d: 1.7320508, e: 0, f: 0 });
    expect(d.rotationDeg).toBeCloseTo(30, 3);
    expect(d.scaleX).toBeCloseTo(2, 3);
    expect(d.uniform).toBe(true);
    expect(d.skewed).toBe(false);
  });
  it('flags non-uniform scale and skew', () => {
    expect(decomposeMatrix({ a: 2, b: 0, c: 0, d: 1, e: 0, f: 0 }).uniform).toBe(false);
    expect(decomposeMatrix({ a: 1, b: 0, c: 0.5, d: 1, e: 0, f: 0 }).skewed).toBe(true);
  });
});

describe('radius helpers', () => {
  it('parses px, elliptical pairs and percentages', () => {
    expect(parseCornerRadius('12px', 100, 50)).toBe(12);
    expect(parseCornerRadius('12px 8px', 100, 50)).toBe(12);
    expect(parseCornerRadius('50%', 100, 60)).toBe(30);
  });
  it('clamps to half the smaller side', () => {
    expect(clampRadii([100, 5, -2, 30], 100, 40)).toEqual([20, 5, 0, 20]);
  });
});
