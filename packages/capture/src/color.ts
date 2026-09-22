import type { RGBA } from '@h2f/schema';

export type ColorNormalizer = (input: string) => RGBA | null;
export type ColorFn = (input: string | null | undefined) => RGBA | null;

export const TRANSPARENT: RGBA = { r: 0, g: 0, b: 0, a: 0 };
export const BLACK: RGBA = { r: 0, g: 0, b: 0, a: 1 };

const NAMED: Record<string, [number, number, number]> = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
  yellow: [255, 255, 0], cyan: [0, 255, 255], aqua: [0, 255, 255], magenta: [255, 0, 255], fuchsia: [255, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192], maroon: [128, 0, 0], olive: [128, 128, 0],
  lime: [0, 255, 0], teal: [0, 128, 128], navy: [0, 0, 128], purple: [128, 0, 128], orange: [255, 165, 0],
  pink: [255, 192, 203], brown: [165, 42, 42], gold: [255, 215, 0], coral: [255, 127, 80], salmon: [250, 128, 114],
  tomato: [255, 99, 71], crimson: [220, 20, 60], indigo: [75, 0, 130], violet: [238, 130, 238], turquoise: [64, 224, 208],
  khaki: [240, 230, 140], beige: [245, 245, 220], ivory: [255, 255, 240], tan: [210, 180, 140], chocolate: [210, 105, 30],
  rebeccapurple: [102, 51, 153], whitesmoke: [245, 245, 245], lightgray: [211, 211, 211], lightgrey: [211, 211, 211],
  darkgray: [169, 169, 169], darkgrey: [169, 169, 169], dimgray: [105, 105, 105], dimgrey: [105, 105, 105],
  slategray: [112, 128, 144], lightblue: [173, 216, 230], skyblue: [135, 206, 235], royalblue: [65, 105, 225],
  steelblue: [70, 130, 180], dodgerblue: [30, 144, 255], deepskyblue: [0, 191, 255], midnightblue: [25, 25, 112],
  forestgreen: [34, 139, 34], seagreen: [46, 139, 87], limegreen: [50, 205, 50], darkgreen: [0, 100, 0],
  orangered: [255, 69, 0], darkorange: [255, 140, 0], hotpink: [255, 105, 180], deeppink: [255, 20, 147],
  lavender: [230, 230, 250], plum: [221, 160, 221], orchid: [218, 112, 214], wheat: [245, 222, 179],
};

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function channel(token: string): number {
  return token.endsWith('%') ? (parseFloat(token) / 100) * 255 : parseFloat(token);
}

function alpha(token: string | undefined): number {
  if (token === undefined) return 1;
  return token.endsWith('%') ? parseFloat(token) / 100 : parseFloat(token);
}

export function parseColor(input: string | null | undefined, normalizer?: ColorNormalizer): RGBA | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === '' || s === 'transparent' || s === 'none') return { ...TRANSPARENT };
  if (s === 'currentcolor') return null;
  const hex = /^#([0-9a-f]{3,8})$/.exec(s);
  if (hex) {
    let h = hex[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((c) => c + c).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i: number) => parseInt(h.slice(i, i + 2), 16) / 255;
    return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) : 1 };
  }
  const rgb = /^rgba?\(\s*(.+?)\s*\)$/.exec(s);
  if (rgb) {
    const parts = rgb[1].replace(/\s*\/\s*/, ' ').split(/[\s,]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const vals = [channel(parts[0]), channel(parts[1]), channel(parts[2]), alpha(parts[3])];
    if (vals.some(Number.isNaN)) return null;
    return { r: clamp01(vals[0] / 255), g: clamp01(vals[1] / 255), b: clamp01(vals[2] / 255), a: clamp01(vals[3]) };
  }
  const named = NAMED[s];
  if (named) return { r: named[0] / 255, g: named[1] / 255, b: named[2] / 255, a: 1 };
  return normalizer ? normalizer(input.trim()) : null;
}

export function createCanvasNormalizer(doc: Document): ColorNormalizer {
  const canvas = doc.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
  const cache = new Map<string, RGBA | null>();
  return (input: string) => {
    if (!ctx) return null;
    const key = input.trim();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let result: RGBA | null = null;
    ctx.fillStyle = 'rgba(1, 2, 3, 0.5)';
    const sentinel = ctx.fillStyle;
    ctx.fillStyle = key;
    if (ctx.fillStyle !== sentinel) {
      ctx.clearRect(0, 0, 1, 1);
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      result = { r: d[0] / 255, g: d[1] / 255, b: d[2] / 255, a: d[3] / 255 };
    }
    cache.set(key, result);
    return result;
  };
}

export function isVisible(c: RGBA | null): c is RGBA {
  return !!c && c.a > 0.001;
}
