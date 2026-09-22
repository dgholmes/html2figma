import type { GradientPaint, GradientStop, ImagePaint, Point, RGBA, Transform2x3 } from '@h2f/schema';
import type { ColorFn } from './color';
import { parseLength, splitTopLevel } from './css';

export function linearGradientLine(angleDeg: number, width: number, height: number): { start: Point; end: Point } {
  const rad = (angleDeg * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  const len = Math.abs(width * Math.sin(rad)) + Math.abs(height * Math.cos(rad));
  const cx = width / 2;
  const cy = height / 2;
  const hx = (dx * len) / 2;
  const hy = (dy * len) / 2;
  const w = width || 1;
  const h = height || 1;
  return { start: { x: (cx - hx) / w, y: (cy - hy) / h }, end: { x: (cx + hx) / w, y: (cy + hy) / h } };
}

export function directionToAngle(direction: string, width: number, height: number): number {
  const words = direction.replace(/^to\s+/, '').trim().split(/\s+/).sort().join(' ');
  const corner = (Math.atan2(height, width) * 180) / Math.PI;
  switch (words) {
    case 'top': return 0;
    case 'right': return 90;
    case 'bottom': return 180;
    case 'left': return 270;
    case 'right top': return corner;
    case 'bottom right': return 180 - corner;
    case 'bottom left': return 180 + corner;
    case 'left top': return 360 - corner;
    default: return 180;
  }
}

function toDegrees(value: string, unit: string): number {
  const n = parseFloat(value);
  switch (unit) {
    case 'turn': return n * 360;
    case 'rad': return (n * 180) / Math.PI;
    case 'grad': return n * 0.9;
    default: return n;
  }
}

function parsePosition(text: string, width: number, height: number): Point {
  const parts = text.trim().split(/\s+/);
  const axis = (token: string | undefined, size: number, fallback: number): number => {
    if (!token) return fallback;
    switch (token) {
      case 'left': case 'top': return 0;
      case 'right': case 'bottom': return 1;
      case 'center': return 0.5;
    }
    if (token.endsWith('%')) return parseFloat(token) / 100;
    const px = parseLength(token);
    return size ? px / size : 0;
  };
  return { x: axis(parts[0], width, 0.5), y: axis(parts[1], height, 0.5) };
}

interface RawStop { color: RGBA; positions: (number | null)[] }

function splitColorAndPositions(part: string): { colorText: string; positions: string[] } | null {
  const t = part.trim();
  const paren = t.indexOf('(');
  let colorText: string;
  let rest: string;
  if (paren > 0 && /^[a-z-]+$/i.test(t.slice(0, paren))) {
    let depth = 0;
    let i = 0;
    for (; i < t.length; i++) {
      if (t[i] === '(') depth++;
      else if (t[i] === ')') { depth--; if (depth === 0) { i++; break; } }
    }
    colorText = t.slice(0, i);
    rest = t.slice(i);
  } else {
    const sp = t.search(/\s/);
    colorText = sp === -1 ? t : t.slice(0, sp);
    rest = sp === -1 ? '' : t.slice(sp);
  }
  if (/^-?\d*\.?\d+(%|px|em|rem|deg)?$/.test(colorText)) return null;
  return { colorText, positions: rest.trim().split(/\s+/).filter(Boolean) };
}

function parseStops(parts: string[], color: ColorFn, lengthPx: number): GradientStop[] {
  const raw: RawStop[] = [];
  for (const part of parts) {
    const split = splitColorAndPositions(part);
    if (!split) continue;
    const c = color(split.colorText);
    if (!c) continue;
    const positions = split.positions.slice(0, 2).map((p) => {
      if (p.endsWith('%')) return parseFloat(p) / 100;
      const px = parseLength(p);
      return lengthPx ? px / lengthPx : 0;
    });
    raw.push({ color: c, positions: positions.length ? positions : [null] });
  }
  const flat: { color: RGBA; pos: number | null }[] = [];
  for (const r of raw) for (const p of r.positions) flat.push({ color: r.color, pos: p });
  if (flat.length === 0) return [];
  if (flat[0].pos === null) flat[0].pos = 0;
  if (flat[flat.length - 1].pos === null) flat[flat.length - 1].pos = 1;
  let i = 0;
  while (i < flat.length) {
    if (flat[i].pos !== null) { i++; continue; }
    let j = i;
    while (flat[j].pos === null) j++;
    const from = flat[i - 1].pos as number;
    const to = flat[j].pos as number;
    const count = j - i + 1;
    for (let k = i; k < j; k++) flat[k].pos = from + ((to - from) * (k - i + 1)) / count;
    i = j;
  }
  let last = 0;
  return flat.map((s) => {
    const pos = Math.min(1, Math.max(last, s.pos as number));
    last = pos;
    return { position: pos, color: s.color };
  });
}

export function parseGradient(input: string, width: number, height: number, color: ColorFn): GradientPaint | null {
  const m = /^(repeating-)?(linear|radial|conic)-gradient\((.*)\)$/s.exec(input.trim());
  if (!m) return null;
  const kind = m[2];
  const args = splitTopLevel(m[3]);
  let angle = kind === 'linear' ? 180 : 0;
  let stopArgs = args;
  let center: Point = { x: 0.5, y: 0.5 };
  const first = args[0] ?? '';
  if (kind === 'linear') {
    const ang = /^(-?\d*\.?\d+)(deg|turn|rad|grad)$/.exec(first);
    if (ang) { angle = toDegrees(ang[1], ang[2]); stopArgs = args.slice(1); }
    else if (/^to\s/.test(first)) { angle = directionToAngle(first, width, height); stopArgs = args.slice(1); }
  } else if (kind === 'conic') {
    if (/^(from|at)\s/.test(first)) {
      const from = /from\s+(-?\d*\.?\d+)(deg|turn|rad|grad)/.exec(first);
      if (from) angle = toDegrees(from[1], from[2]);
      const at = /at\s+(.+)$/.exec(first);
      if (at) center = parsePosition(at[1], width, height);
      stopArgs = args.slice(1);
    }
  } else if (!splitColorAndPositions(first) || /^(circle|ellipse|closest|farthest|at\s|\d)/.test(first)) {
    const at = /at\s+(.+)$/.exec(first);
    if (at) center = parsePosition(at[1], width, height);
    stopArgs = args.slice(1);
  }
  const lineLength = kind === 'linear'
    ? Math.abs(width * Math.sin((angle * Math.PI) / 180)) + Math.abs(height * Math.cos((angle * Math.PI) / 180))
    : Math.max(width, height);
  const stops = parseStops(stopArgs, color, lineLength);
  if (stops.length < 2) return null;
  if (kind === 'linear') {
    const { start, end } = linearGradientLine(angle, width, height);
    return { type: 'gradient', gradient: 'linear', stops, start, end };
  }
  if (kind === 'radial') {
    const cx = center.x * width;
    const cy = center.y * height;
    const r = Math.hypot(Math.max(cx, width - cx), Math.max(cy, height - cy));
    const radius = { x: r / (width || 1), y: r / (height || 1) };
    return { type: 'gradient', gradient: 'radial', stops, start: center, end: { x: center.x + radius.x, y: center.y }, center, radius };
  }
  const rad = (angle * Math.PI) / 180;
  return {
    type: 'gradient', gradient: 'angular', stops, start: center,
    end: { x: center.x + Math.sin(rad) / 2, y: center.y - Math.cos(rad) / 2 }, center, radius: { x: 0.5, y: 0.5 },
  };
}

export interface BackgroundLayer { image: string; size: string; repeat: string; position: string }

export function parseBackgroundLayers(cs: CSSStyleDeclaration): BackgroundLayer[] {
  const images = splitTopLevel(cs.backgroundImage ?? '').filter((i) => i !== 'none');
  if (images.length === 0) return [];
  const sizes = splitTopLevel(cs.backgroundSize ?? 'auto');
  const repeats = splitTopLevel(cs.backgroundRepeat ?? 'repeat');
  const positions = splitTopLevel(cs.backgroundPosition ?? '0% 0%');
  const pick = (list: string[], i: number, fallback: string) => (list.length ? list[i % list.length] : fallback);
  return images.map((image, i) => ({
    image, size: pick(sizes, i, 'auto'), repeat: pick(repeats, i, 'repeat'), position: pick(positions, i, '0% 0%'),
  }));
}

export function extractUrl(image: string): string | null {
  const m = /^url\((?:"([^"]*)"|'([^']*)'|([^)]*))\)$/.exec(image.trim());
  if (!m) return null;
  return (m[1] ?? m[2] ?? m[3] ?? '').trim();
}

export interface Placement { x: number; y: number; width: number; height: number }

export function backgroundPlacement(layer: BackgroundLayer, nodeW: number, nodeH: number, imgW: number, imgH: number): Placement {
  const iw = imgW || 1;
  const ih = imgH || 1;
  let w: number;
  let h: number;
  if (layer.size === 'cover' || layer.size === 'contain') {
    const s = layer.size === 'cover' ? Math.max(nodeW / iw, nodeH / ih) : Math.min(nodeW / iw, nodeH / ih);
    w = iw * s;
    h = ih * s;
  } else {
    const [sw = 'auto', sh = 'auto'] = layer.size.trim().split(/\s+/);
    const dim = (token: string, size: number) => (token === 'auto' ? NaN : token.endsWith('%') ? (size * parseFloat(token)) / 100 : parseLength(token));
    w = dim(sw, nodeW);
    h = dim(sh, nodeH);
    if (Number.isNaN(w) && Number.isNaN(h)) { w = iw; h = ih; }
    else if (Number.isNaN(w)) w = (h * iw) / ih;
    else if (Number.isNaN(h)) h = (w * ih) / iw;
  }
  const [px = '0%', py = '0%'] = layer.position.trim().split(/\s+/);
  const offset = (token: string, free: number) => (token.endsWith('%') ? (free * parseFloat(token)) / 100 : parseLength(token));
  return { x: offset(px, nodeW - w), y: offset(py, nodeH - h), width: w, height: h };
}

export function cropTransform(p: Placement, nodeW: number, nodeH: number): Transform2x3 {
  const pw = p.width || 1;
  const ph = p.height || 1;
  return [[nodeW / pw, 0, -p.x / pw || 0], [0, nodeH / ph, -p.y / ph || 0]];
}

export function scaleModeForObjectFit(fit: string): ImagePaint['scaleMode'] {
  switch (fit) {
    case 'contain': case 'scale-down': return 'fit';
    case 'none': return 'crop';
    default: return 'fill';
  }
}
