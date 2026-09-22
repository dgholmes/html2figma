export function splitTopLevel(input: string, separator = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let current = '';
  for (const ch of input) {
    if (quote) { current += ch; if (ch === quote) quote = null; continue; }
    if (ch === '"' || ch === "'") { quote = ch; current += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === separator && depth === 0) { if (current.trim()) out.push(current.trim()); current = ''; }
    else current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

export function parseLength(value: string | null | undefined): number {
  if (!value) return 0;
  const m = /^(-?\d*\.?\d+)(px)?$/.exec(value.trim());
  return m ? parseFloat(m[1]) : 0;
}

export interface Matrix2D { a: number; b: number; c: number; d: number; e: number; f: number }

export function parseMatrix(transform: string): Matrix2D | null {
  const t = (transform ?? '').trim();
  if (!t || t === 'none') return null;
  let m = /^matrix\(([^)]+)\)$/.exec(t);
  if (m) {
    const v = m[1].split(',').map((s) => parseFloat(s.trim()));
    if (v.length !== 6 || v.some(Number.isNaN)) return null;
    return { a: v[0], b: v[1], c: v[2], d: v[3], e: v[4], f: v[5] };
  }
  m = /^matrix3d\(([^)]+)\)$/.exec(t);
  if (m) {
    const v = m[1].split(',').map((s) => parseFloat(s.trim()));
    if (v.length !== 16 || v.some(Number.isNaN)) return null;
    const near = (x: number, y: number) => Math.abs(x - y) < 1e-6;
    const is2d = near(v[2], 0) && near(v[3], 0) && near(v[6], 0) && near(v[7], 0) && near(v[8], 0) && near(v[9], 0)
      && near(v[10], 1) && near(v[11], 0) && near(v[14], 0) && near(v[15], 1);
    if (!is2d) return null;
    return { a: v[0], b: v[1], c: v[4], d: v[5], e: v[12], f: v[13] };
  }
  return null;
}

export function isIdentityMatrix(m: Matrix2D): boolean {
  const eps = 1e-6;
  return Math.abs(m.a - 1) < eps && Math.abs(m.b) < eps && Math.abs(m.c) < eps && Math.abs(m.d - 1) < eps && Math.abs(m.e) < eps && Math.abs(m.f) < eps;
}

export interface Decomposed { scaleX: number; scaleY: number; rotationDeg: number; uniform: boolean; skewed: boolean }

export function decomposeMatrix(m: Matrix2D): Decomposed {
  const scaleX = Math.hypot(m.a, m.b);
  const scaleY = Math.hypot(m.c, m.d);
  const rotationDeg = (Math.atan2(m.b, m.a) * 180) / Math.PI;
  const dot = m.a * m.c + m.b * m.d;
  const skewed = Math.abs(dot) > 1e-3 * Math.max(1, scaleX * scaleY);
  const uniform = Math.abs(scaleX - scaleY) < 1e-3 * Math.max(1, scaleX);
  return { scaleX, scaleY, rotationDeg, uniform, skewed };
}

export function parseCornerRadius(value: string, width: number, height: number): number {
  const first = (value ?? '').trim().split(/\s+/)[0] ?? '0px';
  if (first.endsWith('%')) return (parseFloat(first) / 100) * Math.min(width, height);
  return parseLength(first);
}

export function clampRadii(r: [number, number, number, number], width: number, height: number): [number, number, number, number] {
  const max = Math.max(0, Math.min(width, height) / 2);
  return r.map((v) => Math.max(0, Math.min(v || 0, max))) as [number, number, number, number];
}
