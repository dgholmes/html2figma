import { describe, expect, it } from 'vitest';
import { parseColor } from '../src/color';
import { applyTextTransform, assembleText, collapseWhitespace, mapTextAlign, pickFontFamily, runStyleFromComputed, type RunStyle, type TextFragment } from '../src/text';

const color = (s: string | null | undefined) => parseColor(s);

const style = (over: Partial<RunStyle> = {}): RunStyle => ({
  fontFamily: 'Inter', fontWeight: 400, italic: false, fontSize: 16, lineHeight: 24, letterSpacing: 0,
  color: { r: 0, g: 0, b: 0, a: 1 }, decoration: 'none', textCase: 'original', ...over,
});
const frag = (text: string, over: Partial<TextFragment> = {}): TextFragment => ({ text, style: style(), rect: null, whiteSpace: 'normal', ...over });

describe('collapseWhitespace', () => {
  it('collapses runs for normal and keeps pre intact', () => {
    expect(collapseWhitespace('  a \n\t b  ', 'normal')).toBe(' a b ');
    expect(collapseWhitespace('a \n b', 'pre')).toBe('a \n b');
    expect(collapseWhitespace('a  \n  b', 'pre-line')).toBe('a\nb');
  });
});

describe('applyTextTransform', () => {
  it('applies uppercase, lowercase, capitalize', () => {
    expect(applyTextTransform('hello world', 'uppercase')).toBe('HELLO WORLD');
    expect(applyTextTransform('Hello', 'lowercase')).toBe('hello');
    expect(applyTextTransform('hello big world', 'capitalize')).toBe('Hello Big World');
    expect(applyTextTransform('x', 'none')).toBe('x');
  });
});

describe('pickFontFamily', () => {
  it('skips generic families and prefers an available one', () => {
    expect(pickFontFamily('-apple-system, system-ui, "Helvetica Neue", Roboto, sans-serif', (f) => f === 'Roboto')).toBe('Roboto');
    expect(pickFontFamily('"Playfair Display", serif', () => false)).toBe('Playfair Display');
    expect(pickFontFamily('sans-serif', () => true)).toBe('Inter');
  });
});

describe('runStyleFromComputed', () => {
  it('maps computed properties', () => {
    const cs = {
      fontFamily: 'Inter, sans-serif', fontWeight: '600', fontStyle: 'italic', fontSize: '18px', lineHeight: 'normal',
      letterSpacing: '0.5px', color: 'rgb(255, 0, 0)', textDecorationLine: 'underline', textTransform: 'none',
    } as unknown as CSSStyleDeclaration;
    expect(runStyleFromComputed(cs, color, () => true)).toEqual(style({
      fontWeight: 600, italic: true, fontSize: 18, lineHeight: null, letterSpacing: 0.5, color: { r: 1, g: 0, b: 0, a: 1 }, decoration: 'underline',
    }));
  });
  it('handles keyword weights and line-through', () => {
    const cs = { fontFamily: 'X', fontWeight: 'bold', fontStyle: 'normal', fontSize: '10px', lineHeight: '12px', letterSpacing: 'normal', color: 'rgb(0, 0, 0)', textDecorationLine: 'line-through', textTransform: 'none' } as unknown as CSSStyleDeclaration;
    const s = runStyleFromComputed(cs, color, () => true);
    expect(s.fontWeight).toBe(700);
    expect(s.lineHeight).toBe(12);
    expect(s.decoration).toBe('strikethrough');
  });
});

describe('mapTextAlign', () => {
  it('resolves start/end with direction', () => {
    expect(mapTextAlign('start', 'ltr')).toBe('left');
    expect(mapTextAlign('end', 'ltr')).toBe('right');
    expect(mapTextAlign('start', 'rtl')).toBe('right');
    expect(mapTextAlign('center', 'ltr')).toBe('center');
    expect(mapTextAlign('justify', 'ltr')).toBe('justified');
  });
});

describe('assembleText', () => {
  it('joins fragments, merges equal styles, and trims edge whitespace', () => {
    const r = assembleText([frag('  Make your photos look '), frag('published.', { style: style({ italic: true }) }), frag('  ')])!;
    expect(r.characters).toBe('Make your photos look published.');
    expect(r.runs).toEqual([
      { start: 0, end: 22, ...style() },
      { start: 22, end: 32, ...style({ italic: true }) },
    ]);
  });
  it('collapses whitespace across fragment boundaries', () => {
    const r = assembleText([frag('foo '), frag(' bar')])!;
    expect(r.characters).toBe('foo bar');
  });
  it('turns breaks into newlines and unions rects', () => {
    const r = assembleText([
      frag('a', { rect: { x: 0, y: 0, width: 10, height: 10 } }),
      frag('', { isBreak: true }),
      frag('b', { rect: { x: 0, y: 12, width: 20, height: 10 } }),
    ])!;
    expect(r.characters).toBe('a\nb');
    expect(r.rect).toEqual({ x: 0, y: 0, width: 20, height: 22 });
    expect(r.runs).toEqual([{ start: 0, end: 3, ...style() }]);
  });
  it('returns null when nothing remains', () => {
    expect(assembleText([frag('   '), frag('', { isBreak: true })])).toBeNull();
  });
});
