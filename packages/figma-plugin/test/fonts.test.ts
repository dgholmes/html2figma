import { describe, expect, it } from 'vitest';
import type { FrameNode, TextNode } from '@h2f/schema';
import { FontResolver, parseStyleName } from '../src/main/fonts';

describe('parseStyleName', () => {
  it('maps common style names to weights and italic', () => {
    expect(parseStyleName('Regular')).toEqual({ weight: 400, italic: false });
    expect(parseStyleName('Semi Bold Italic')).toEqual({ weight: 600, italic: true });
    expect(parseStyleName('SemiBold')).toEqual({ weight: 600, italic: false });
    expect(parseStyleName('ExtraLight')).toEqual({ weight: 200, italic: false });
    expect(parseStyleName('Extra Bold')).toEqual({ weight: 800, italic: false });
    expect(parseStyleName('Black')).toEqual({ weight: 900, italic: false });
    expect(parseStyleName('Light Italic')).toEqual({ weight: 300, italic: true });
    expect(parseStyleName('700')).toEqual({ weight: 700, italic: false });
    expect(parseStyleName('Bold')).toEqual({ weight: 700, italic: false });
  });
});

describe('FontResolver', () => {
  const make = async () => new FontResolver(await figma.listAvailableFontsAsync());
  it('matches family case-insensitively and picks the nearest weight', async () => {
    const r = await make();
    expect(r.resolve('inter', 600, false)).toEqual({ fontName: { family: 'Inter', style: 'Semi Bold' }, substituted: false });
    expect(r.resolve('"Playfair Display"', 800, false).fontName).toEqual({ family: 'Playfair Display', style: 'Bold' });
    expect(r.resolve('Roboto', 500, false).fontName.style).toBe('Regular');
  });
  it('prefers italic styles when requested and tolerates missing italics', async () => {
    const r = await make();
    expect(r.resolve('Inter', 400, true).fontName.style).toBe('Italic');
    expect(r.resolve('Roboto', 400, true).fontName.style).toBe('Regular');
  });
  it('substitutes Inter for unknown families', async () => {
    const r = await make();
    expect(r.resolve('Comic Sans MS', 700, false)).toEqual({ fontName: { family: 'Inter', style: 'Bold' }, substituted: true });
  });
  it('fontFor loads once and falls back when loading fails', async () => {
    const r = await make();
    const run = { fontFamily: 'Inter', fontWeight: 700, italic: false };
    expect(await r.fontFor(run)).toEqual({ family: 'Inter', style: 'Bold' });
    await r.fontFor(run);
    expect((figma.loadFontAsync as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter((c) => (c[0] as FontName).style === 'Bold' && (c[0] as FontName).family === 'Inter').length).toBe(1);
    expect(await r.fontFor({ fontFamily: 'Broken', fontWeight: 400, italic: false })).toEqual({ family: 'Inter', style: 'Regular' });
  });
  it('preload warns once per missing family', async () => {
    const r = await make();
    const text = (family: string): TextNode => ({
      id: 't', name: 't', type: 'text', x: 0, y: 0, width: 1, height: 1, rotation: 0, visible: true, opacity: 1, blendMode: 'normal', fills: [], radius: [0, 0, 0, 0], effects: [], clip: false,
      meta: { tag: 'p', classes: [] }, characters: 'a', align: 'left', verticalAlign: 'top',
      runs: [{ start: 0, end: 1, fontFamily: family, fontWeight: 400, italic: false, fontSize: 12, lineHeight: null, letterSpacing: 0, color: { r: 0, g: 0, b: 0, a: 1 }, decoration: 'none', textCase: 'original' }],
    });
    const root: FrameNode = { ...text('Inter'), type: 'frame', children: [text('Nope'), text('Nope'), text('Inter')] } as unknown as FrameNode;
    const warnings: string[] = [];
    await r.preload(root, warnings);
    expect(warnings).toEqual(['Font "Nope" is not available in Figma; using Inter instead.']);
  });
});
