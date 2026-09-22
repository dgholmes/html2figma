import type { Effect, ShadowEffect } from '@h2f/schema';
import { BLACK, type ColorFn } from './color';
import { splitTopLevel } from './css';

const TOKEN = /[a-z-]+\([^)]*\)|#?[\w.%-]+/gi;

export function parseShadowList(value: string, color: ColorFn, allowInset: boolean): ShadowEffect[] {
  if (!value || value === 'none') return [];
  const out: ShadowEffect[] = [];
  for (const part of splitTopLevel(value)) {
    let inset = false;
    let colorText: string | null = null;
    const nums: number[] = [];
    for (const token of part.match(TOKEN) ?? []) {
      if (token === 'inset') inset = true;
      else if (/^-?\d*\.?\d+(px)?$/.test(token)) nums.push(parseFloat(token));
      else colorText = token;
    }
    const c = colorText ? color(colorText) : { ...BLACK };
    if (!c || c.a <= 0.001) continue;
    const [x = 0, y = 0, blur = 0, spread = 0] = nums;
    out.push({ type: inset && allowInset ? 'inner-shadow' : 'drop-shadow', color: c, offset: { x, y }, blur, spread });
  }
  return out;
}

export function parseFilterBlur(filter: string | undefined): number | null {
  const m = /blur\((\d*\.?\d+)px\)/.exec(filter ?? '');
  return m ? parseFloat(m[1]) : null;
}

export function collectEffects(cs: CSSStyleDeclaration, color: ColorFn): Effect[] {
  const effects: Effect[] = [...parseShadowList(cs.boxShadow, color, true)];
  const blur = parseFilterBlur(cs.filter);
  if (blur) effects.push({ type: 'layer-blur', radius: blur });
  const backdrop = parseFilterBlur(cs.backdropFilter || (cs as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter);
  if (backdrop) effects.push({ type: 'background-blur', radius: backdrop });
  return effects;
}
