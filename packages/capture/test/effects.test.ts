import { describe, expect, it } from 'vitest';
import { parseColor } from '../src/color';
import { collectEffects, parseFilterBlur, parseShadowList } from '../src/effects';

const color = (s: string | null | undefined) => parseColor(s);

describe('parseShadowList', () => {
  it('parses computed box-shadow with color first', () => {
    expect(parseShadowList('rgba(0, 0, 0, 0.2) 0px 4px 12px 0px', color, true)).toEqual([
      { type: 'drop-shadow', color: { r: 0, g: 0, b: 0, a: 0.2 }, offset: { x: 0, y: 4 }, blur: 12, spread: 0 },
    ]);
  });
  it('parses inset and multiple shadows in order', () => {
    const result = parseShadowList('rgb(255, 0, 0) 1px 2px 3px 4px inset, rgba(0, 0, 255, 0.5) -1px -2px', color, true);
    expect(result.map((e) => e.type)).toEqual(['inner-shadow', 'drop-shadow']);
    expect(result[0]).toMatchObject({ offset: { x: 1, y: 2 }, blur: 3, spread: 4 });
    expect(result[1]).toMatchObject({ offset: { x: -1, y: -2 }, blur: 0, spread: 0 });
  });
  it('turns inset into a drop shadow when inset is not allowed (text-shadow)', () => {
    expect(parseShadowList('rgb(0, 0, 0) 1px 1px 2px inset', color, false)[0].type).toBe('drop-shadow');
  });
  it('drops none and fully transparent shadows', () => {
    expect(parseShadowList('none', color, true)).toEqual([]);
    expect(parseShadowList('rgba(0, 0, 0, 0) 0px 1px 2px', color, true)).toEqual([]);
  });
});

describe('parseFilterBlur', () => {
  it('extracts blur radius', () => {
    expect(parseFilterBlur('blur(8px)')).toBe(8);
    expect(parseFilterBlur('drop-shadow(1px 1px 1px black) blur(2.5px)')).toBe(2.5);
    expect(parseFilterBlur('none')).toBeNull();
    expect(parseFilterBlur(undefined)).toBeNull();
  });
});

describe('collectEffects', () => {
  it('combines shadows and blurs', () => {
    const cs = { boxShadow: 'rgba(0, 0, 0, 0.5) 0px 2px 4px 0px', filter: 'blur(3px)', backdropFilter: 'blur(10px)' } as unknown as CSSStyleDeclaration;
    expect(collectEffects(cs, color)).toEqual([
      { type: 'drop-shadow', color: { r: 0, g: 0, b: 0, a: 0.5 }, offset: { x: 0, y: 2 }, blur: 4, spread: 0 },
      { type: 'layer-blur', radius: 3 },
      { type: 'background-blur', radius: 10 },
    ]);
  });
});
