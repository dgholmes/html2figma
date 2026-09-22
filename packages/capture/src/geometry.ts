import { decomposeMatrix, isIdentityMatrix, parseMatrix } from './css';

export interface Rect { x: number; y: number; width: number; height: number }

export function unionRect(a: Rect, b: Rect): Rect {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, width: Math.max(a.x + a.width, b.x + b.width) - x, height: Math.max(a.y + a.height, b.y + b.height) - y };
}

export function absoluteRect(el: Element, win: Window): Rect {
  const r = el.getBoundingClientRect();
  return { x: r.left + win.scrollX, y: r.top + win.scrollY, width: r.width, height: r.height };
}

export function rectFromClientRects(rects: ArrayLike<DOMRect>, win: Window): Rect | null {
  let out: Rect | null = null;
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (r.width <= 0 || r.height <= 0) continue;
    const rect = { x: r.left + win.scrollX, y: r.top + win.scrollY, width: r.width, height: r.height };
    out = out ? unionRect(out, rect) : rect;
  }
  return out;
}

export interface Geometry { x: number; y: number; width: number; height: number; rotation: number; abs: Rect }

export function computeGeometry(el: Element, cs: CSSStyleDeclaration, parentAbs: Rect, win: Window, allowRotation: boolean): Geometry {
  const abs = absoluteRect(el, win);
  const base: Geometry = { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y, width: abs.width, height: abs.height, rotation: 0, abs };
  if (!allowRotation) return base;
  const m = parseMatrix(cs.transform);
  if (!m || isIdentityMatrix(m)) return base;
  const d = decomposeMatrix(m);
  if (d.skewed || !d.uniform || Math.abs(d.rotationDeg) < 0.05) return base;
  const he = el as HTMLElement;
  const w0 = he.offsetWidth;
  const h0 = he.offsetHeight;
  if (!w0 || !h0) return base;
  const cx = abs.x + abs.width / 2;
  const cy = abs.y + abs.height / 2;
  const tlx = cx - (m.a * w0) / 2 - (m.c * h0) / 2;
  const tly = cy - (m.b * w0) / 2 - (m.d * h0) / 2;
  return { x: tlx - parentAbs.x, y: tly - parentAbs.y, width: w0 * d.scaleX, height: h0 * d.scaleX, rotation: -d.rotationDeg, abs };
}
