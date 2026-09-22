import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameNode, Node as H2FNode, TextNode, VectorNode } from '@h2f/schema';
import { Builder, type BuilderDeps } from '../src/main/builder';
import { FontResolver } from '../src/main/fonts';
import { installFigmaMock, type MockFigma, type MockNode } from './figmaMock';

const base = { x: 5, y: 6, width: 100, height: 50, rotation: 0, visible: true, opacity: 1, blendMode: 'normal', fills: [], radius: [0, 0, 0, 0] as [number, number, number, number], effects: [], clip: false, meta: { tag: 'div', classes: [] } };
const run = { start: 0, end: 5, fontFamily: 'Inter', fontWeight: 700, italic: false, fontSize: 20, lineHeight: 24, letterSpacing: 0.5, color: { r: 1, g: 0, b: 0, a: 1 }, decoration: 'underline' as const, textCase: 'original' as const };

let mock: MockFigma;
let deps: BuilderDeps;
beforeEach(async () => {
  mock = installFigmaMock();
  deps = { images: new Map([['a1', 'hash1']]), svgs: new Map([['s1', { svg: '<svg/>' }], ['bad', { svg: 'BAD', fallback: new Uint8Array([1]) }]]), fonts: new FontResolver(await figma.listAvailableFontsAsync()), warnings: [], onProgress: () => {} };
  mock.svgFailsFor.add('BAD');
});

const build = (n: H2FNode) => new Builder(deps).build(n, mock.currentPage as unknown as PageNode) as unknown as Promise<MockNode>;

describe('Builder', () => {
  it('builds frames with geometry, fills, stroke, radius, clip, and children', async () => {
    const node: FrameNode = { ...base, id: 'f', name: 'section.hero', type: 'frame', clip: true, radius: [1, 2, 3, 4], opacity: 0.5,
      fills: [{ type: 'solid', color: { r: 0, g: 0, b: 1, a: 1 } }, { type: 'image', assetId: 'a1', scaleMode: 'fill' }],
      stroke: { color: { r: 0, g: 0, b: 0, a: 1 }, weights: { top: 1, right: 0, bottom: 2, left: 0 }, align: 'inside', dash: [3, 2] },
      effects: [{ type: 'layer-blur', radius: 2 }],
      children: [{ ...base, id: 'c', name: 'child', type: 'frame', children: [] }] };
    const f = await build(node);
    expect(f).toMatchObject({ type: 'FRAME', name: 'section.hero', x: 5, y: 6, width: 100, height: 50, clipsContent: true, opacity: 0.5, topLeftRadius: 1, topRightRadius: 2, bottomRightRadius: 3, bottomLeftRadius: 4, strokeAlign: 'INSIDE', strokeTopWeight: 1, strokeBottomWeight: 2, dashPattern: [3, 2] });
    expect(f.fills).toHaveLength(2);
    expect(f.effects).toEqual([{ type: 'LAYER_BLUR', radius: 2, visible: true }]);
    expect(f.children[0].name).toBe('child');
    expect(mock.currentPage.children).toContain(f);
  });

  // I6 regression: every DOM element becomes a frame, so mapping the default `normal` blend
  // mode straight to Figma's NORMAL isolated every single frame — a descendant with a real
  // blend mode (e.g. mix-blend-mode: difference) then blended only against its immediate parent
  // instead of the page background. Non-isolating frames must get PASS_THROUGH; a frame that
  // does isolate (opacity < 1) keeps NORMAL; text leaves never get PASS_THROUGH at all.
  it('gives non-isolating frames PASS_THROUGH instead of NORMAL, and keeps NORMAL for isolating frames and text leaves', async () => {
    const passthrough = await build({ ...base, id: 'pt', name: 'pt', type: 'frame', blendMode: 'normal', children: [] });
    expect(passthrough.blendMode).toBe('PASS_THROUGH');

    const isolating = await build({ ...base, id: 'iso', name: 'iso', type: 'frame', blendMode: 'normal', opacity: 0.5, children: [] });
    expect(isolating.blendMode).toBe('NORMAL');

    const blended = await build({ ...base, id: 'bl', name: 'bl', type: 'frame', blendMode: 'difference', children: [] });
    expect(blended.blendMode).toBe('DIFFERENCE');

    const text = await build({ ...base, id: 't3', name: 'Hi', type: 'text', characters: 'Hi', runs: [], blendMode: 'normal', align: 'left', verticalAlign: 'top' } as TextNode);
    expect(text.blendMode).toBe('NORMAL');
  });

  it('applies rotation through relativeTransform', async () => {
    const f = await build({ ...base, id: 'r', name: 'r', type: 'frame', rotation: 90, children: [] });
    const t = f.relativeTransform;
    expect(t[0][0]).toBeCloseTo(0); expect(t[0][1]).toBeCloseTo(1); expect(t[1][0]).toBeCloseTo(-1); expect(t[1][1]).toBeCloseTo(0);
    expect(t[0][2]).toBe(5); expect(t[1][2]).toBe(6);
  });

  it('builds text with runs, alignment and fixed size', async () => {
    const node: TextNode = { ...base, id: 't', name: 'Hello', type: 'text', characters: 'Hello', runs: [run], align: 'center', verticalAlign: 'top' };
    const t = await build(node);
    expect(t).toMatchObject({ type: 'TEXT', characters: 'Hello', textAutoResize: 'NONE', textAlignHorizontal: 'CENTER', textAlignVertical: 'TOP', width: 100, height: 50, fontName: { family: 'Inter', style: 'Bold' } });
    const methods = t.ranges.map((r) => r.method);
    expect(methods).toEqual(expect.arrayContaining(['setRangeFontName', 'setRangeFontSize', 'setRangeLineHeight', 'setRangeLetterSpacing', 'setRangeFills', 'setRangeTextDecoration', 'setRangeTextCase']));
    expect(t.ranges.find((r) => r.method === 'setRangeLineHeight')!.value).toEqual({ unit: 'PIXELS', value: 24 });
    expect(t.ranges.find((r) => r.method === 'setRangeTextDecoration')!.value).toBe('UNDERLINE');
    expect(t.ranges.find((r) => r.method === 'setRangeFills')!.value).toEqual([{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1 }]);
  });

  it('uses AUTO line height when null and clamps runs to the character count', async () => {
    const node: TextNode = { ...base, id: 't', name: 'Hi', type: 'text', characters: 'Hi', runs: [{ ...run, end: 5, lineHeight: null }], align: 'left', verticalAlign: 'center' };
    const t = await build(node);
    const lh = t.ranges.find((r) => r.method === 'setRangeLineHeight')!;
    expect(lh.value).toEqual({ unit: 'AUTO' });
    expect(lh.end).toBe(2);
    expect(t.textAlignVertical).toBe('CENTER');
  });

  it('builds vectors from svg and rescales them to the target box', async () => {
    const v = await build({ ...base, id: 'v', name: 'svg.icon', type: 'vector', assetId: 's1', width: 40, height: 20 } as VectorNode);
    expect(v.type).toBe('FRAME');
    expect(v.width).toBeCloseTo(40); expect(v.height).toBeCloseTo(20);
    expect(v.name).toBe('svg.icon');
  });

  it('falls back to a rasterized image fill when svg parsing fails', async () => {
    const v = await build({ ...base, id: 'v', name: 'svg.bad', type: 'vector', assetId: 'bad' } as VectorNode);
    expect(v.fills).toEqual([{ type: 'IMAGE', imageHash: 'img1', scaleMode: 'FIT' }]);
    expect(deps.warnings.some((w) => /svg\.bad/.test(w))).toBe(true);
  });

  it('never throws: a failing node becomes a placeholder with a warning', async () => {
    const v = await build({ ...base, id: 'v', name: 'svg.missing', type: 'vector', assetId: 'nope' } as VectorNode);
    expect(v.name).toMatch(/svg\.missing \(import failed/);
    expect(v.strokes).toHaveLength(1);
    expect(deps.warnings.some((w) => /svg\.missing/.test(w))).toBe(true);
  });

  it('reports progress every 50 nodes', async () => {
    const seen: number[] = [];
    deps.onProgress = (d) => seen.push(d);
    const children: FrameNode[] = Array.from({ length: 120 }, (_, i) => ({ ...base, id: `c${i}`, name: `c${i}`, type: 'frame', children: [] }));
    await build({ ...base, id: 'root', name: 'root', type: 'frame', children });
    expect(seen).toEqual([50, 100]);
  });

  // I10 regression: createFrame appends the frame to its parent before configuring it, so a
  // throw partway through (after appendChild) used to leave a stray, half-built default frame in
  // the document *alongside* the red-dashed placeholder build()'s catch creates — two children
  // where there should be one.
  it('does not leave an orphan half-built frame behind when a throw happens after the frame was already appended', async () => {
    const realCreateFrame = figma.createFrame.bind(figma);
    let poisonNext = true;
    vi.spyOn(figma, 'createFrame').mockImplementation(() => {
      const f = realCreateFrame();
      if (poisonNext) {
        poisonNext = false; // only the node under test throws; the placeholder frame created next must succeed
        (f as unknown as MockNode).resize = () => { throw new Error('boom mid-build'); };
      }
      return f;
    });
    const node: FrameNode = { ...base, id: 'bad-frame', name: 'bad-frame', type: 'frame', children: [] };
    const result = await build(node);
    expect(result.name).toMatch(/bad-frame \(import failed/);
    expect(mock.currentPage.children).toHaveLength(1);
    expect(mock.currentPage.children[0]).toBe(result);
    vi.restoreAllMocks();
  });
});
