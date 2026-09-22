import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FrameNode, TextNode, VectorNode } from '@h2f/schema';
import { AssetStore } from '../src/assets';
import { parseColor } from '../src/color';
import { buildRoot, hasVisualBox, walkElement, type WalkContext } from '../src/walk';

// jsdom has no layout: rects come from data attributes `data-rect="x,y,w,h"` on elements and text parents.
function rectOf(el: Element | null): DOMRect {
  const spec = el?.getAttribute('data-rect');
  const [x = 0, y = 0, w = 0, h = 0] = spec ? spec.split(',').map(Number) : [];
  return { left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) } as DOMRect;
}

function makeCtx(over: Partial<WalkContext> = {}): WalkContext {
  let n = 0;
  return {
    doc: document, win: window, store: new AssetStore(), warnings: [],
    loader: { fetchAsBase64: async () => null },
    color: (s) => parseColor(s), captureVideoFrames: true, isFontAvailable: () => true,
    nextId: () => `n${++n}`, tick: async () => {}, pseudoEstimates: { count: 0 }, ...over,
  };
}

beforeEach(() => {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) { return rectOf(this); });
  // jsdom does no layout, so Range.prototype.getClientRects isn't implemented at all (unlike
  // getBoundingClientRect, which jsdom stubs). vi.spyOn requires the property to already exist,
  // so define a placeholder first; the spy below then replaces it for real.
  if (!('getClientRects' in Range.prototype)) {
    (Range.prototype as unknown as { getClientRects: () => DOMRectList }).getClientRects = () => [] as unknown as DOMRectList;
  }
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    const parent = this.startContainer.parentElement;
    const r = rectOf(parent?.closest('[data-text-rect]') ? { getAttribute: () => parent!.closest('[data-text-rect]')!.getAttribute('data-text-rect') } as unknown as Element : null);
    return (r.width ? [r] : []) as unknown as DOMRectList;
  });
  // walk.ts's pseudoNode() legitimately probes `getComputedStyle(el, '::before'|'::after')` on every
  // frameFor call, exactly as it should on a real browser. jsdom, however, doesn't implement
  // pseudo-element computed styles: window.getComputedStyle unconditionally logs a "Not implemented"
  // console error whenever a non-empty pseudo-element argument is passed, then falls through to
  // compute (and return) the element's own style regardless — the pseudo argument never actually
  // affects the result in this jsdom version. So stripping it before delegating to the real
  // implementation produces byte-identical output with none of the console noise. This only touches
  // the test harness's window.getComputedStyle binding, not walk.ts's calls or any other console
  // method, so genuine errors/warnings from elsewhere still surface normally.
  const realGetComputedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((elt: Element) => realGetComputedStyle(elt));
  document.body.innerHTML = '';
});
afterEach(() => vi.restoreAllMocks());

const ROOT = { x: 0, y: 0, width: 1000, height: 1000 };

describe('hasVisualBox', () => {
  it('detects backgrounds, borders, shadows, transforms, opacity and clipping', () => {
    const base = { backgroundColor: 'rgba(0, 0, 0, 0)', backgroundImage: 'none', borderTopWidth: '0px', borderRightWidth: '0px', borderBottomWidth: '0px', borderLeftWidth: '0px', boxShadow: 'none', transform: 'none', opacity: '1', overflowX: 'visible', overflowY: 'visible', filter: 'none', outlineStyle: 'none' };
    expect(hasVisualBox(base as unknown as CSSStyleDeclaration)).toBe(false);
    expect(hasVisualBox({ ...base, backgroundColor: 'rgb(0, 0, 0)' } as unknown as CSSStyleDeclaration)).toBe(true);
    expect(hasVisualBox({ ...base, borderLeftWidth: '1px' } as unknown as CSSStyleDeclaration)).toBe(true);
    expect(hasVisualBox({ ...base, opacity: '0.5' } as unknown as CSSStyleDeclaration)).toBe(true);
    expect(hasVisualBox({ ...base, overflowY: 'hidden' } as unknown as CSSStyleDeclaration)).toBe(true);
  });
});

describe('walkElement', () => {
  it('skips scripts and display:none, emits frames with solid fills and radius', async () => {
    document.body.innerHTML = `
      <div id="card" data-rect="10,20,200,100" style="background-color: rgb(255, 0, 0); border-top-left-radius: 8px; border-top-right-radius: 8px; border-bottom-right-radius: 8px; border-bottom-left-radius: 8px; overflow-x: hidden; overflow-y: hidden">
        <script>1</script><span style="display:none">gone</span>
      </div>`;
    const nodes = await walkElement(document.getElementById('card')!, ROOT, makeCtx());
    expect(nodes).toHaveLength(1);
    const f = nodes[0] as FrameNode;
    expect(f.type).toBe('frame');
    expect(f).toMatchObject({ x: 10, y: 20, width: 200, height: 100, clip: true, name: 'div#card' });
    expect(f.fills).toEqual([{ type: 'solid', color: { r: 1, g: 0, b: 0, a: 1 } }]);
    expect(f.radius).toEqual([8, 8, 8, 8]);
    expect(f.children).toEqual([]);
  });

  it('merges inline text into one text node with styled runs', async () => {
    document.body.innerHTML = `
      <h1 data-rect="0,0,600,120" data-text-rect="0,0,600,120" style="font-size: 48px; text-align: center">Make your photos look <em style="font-style: italic; font-size: 48px">published.</em></h1>`;
    const nodes = await walkElement(document.querySelector('h1')!, ROOT, makeCtx());
    const h1 = nodes[0] as FrameNode;
    expect(h1.children).toHaveLength(1);
    const t = h1.children[0] as TextNode;
    expect(t.type).toBe('text');
    expect(t.characters).toBe('Make your photos look published.');
    expect(t.align).toBe('center');
    expect(t.runs).toHaveLength(2);
    expect(t.runs[1]).toMatchObject({ start: 22, end: 32, italic: true, fontSize: 48 });
    expect(t.width).toBe(601);
  });

  it('keeps styled inline elements as frames and hoists plain ones', async () => {
    document.body.innerHTML = `
      <p data-rect="0,0,300,20" data-text-rect="0,0,300,20">a <a href="#" style="background-color: rgb(0, 0, 255)" data-rect="20,0,50,20">link</a> b</p>`;
    const nodes = await walkElement(document.querySelector('p')!, ROOT, makeCtx());
    const p = nodes[0] as FrameNode;
    expect(p.children.map((c) => c.type)).toEqual(['text', 'frame', 'text']);
    expect((p.children[0] as TextNode).characters).toBe('a');
    expect((p.children[2] as TextNode).characters).toBe('b');
  });

  it('turns img with an svg asset into a vector and raster img into an image fill', async () => {
    document.body.innerHTML = `
      <img id="icon" src="https://x/icon.svg" data-rect="0,0,24,24">
      <img id="photo" src="https://x/photo.png" data-rect="0,40,100,50" style="object-fit: cover">`;
    const ctx = makeCtx({ loader: { fetchAsBase64: async (url) => url.endsWith('.svg')
      ? { mime: 'image/svg+xml', data: btoa('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"/>') }
      : { mime: 'image/png', data: 'QUJD' } } });
    const icon = (await walkElement(document.getElementById('icon')!, ROOT, ctx))[0] as VectorNode;
    expect(icon.type).toBe('vector');
    expect(ctx.store.get(icon.assetId)!.kind).toBe('svg');
    const photo = (await walkElement(document.getElementById('photo')!, ROOT, ctx))[0] as FrameNode;
    expect(photo.fills[0]).toMatchObject({ type: 'image', scaleMode: 'fill' });
  });

  it('emits placeholders for iframes and failed images with warnings', async () => {
    document.body.innerHTML = `<iframe data-rect="0,0,300,150" src="https://y/"></iframe><img id="bad" src="https://x/404.png" data-rect="0,0,10,10">`;
    const ctx = makeCtx();
    const frame = (await walkElement(document.querySelector('iframe')!, ROOT, ctx))[0] as FrameNode;
    expect(frame.name).toBe('iframe (not captured)');
    expect(frame.fills[0]).toMatchObject({ type: 'solid' });
    const bad = (await walkElement(document.getElementById('bad')!, ROOT, ctx))[0] as FrameNode;
    expect(bad.name).toMatch(/not captured/);
    expect(ctx.warnings.some((w) => w.includes('404.png'))).toBe(true);
  });

  it('records fixed positioning and hidden visibility', async () => {
    document.body.innerHTML = `<header data-rect="0,0,1000,96" data-text-rect="0,0,20,20" style="position: fixed; visibility: hidden"><span>x</span></header>`;
    const header = (await walkElement(document.querySelector('header')!, ROOT, makeCtx()))[0] as FrameNode;
    expect(header.meta.position).toBe('fixed');
    expect(header.visible).toBe(false);
    expect(header.name).toBe('header (fixed)');
    const text = header.children[0] as TextNode;
    expect(text.characters).toBe('x');
    expect(text.visible).toBe(false);
  });

  it('emits a text node for a hidden block, marked not visible', async () => {
    document.body.innerHTML = `<p data-rect="0,0,300,20" data-text-rect="0,0,300,20" style="visibility: hidden">Some text</p>`;
    const p = (await walkElement(document.querySelector('p')!, ROOT, makeCtx()))[0] as FrameNode;
    expect(p.visible).toBe(false);
    const text = p.children[0] as TextNode;
    expect(text.type).toBe('text');
    expect(text.characters).toBe('Some text');
    expect(text.visible).toBe(false);
  });

  it('still emits text nested under a hidden ancestor through a hoisted plain inline span', async () => {
    document.body.innerHTML = `<div data-rect="0,0,300,20" data-text-rect="0,0,300,20" style="visibility: hidden"><span>hidden text</span></div>`;
    const div = (await walkElement(document.querySelector('div')!, ROOT, makeCtx()))[0] as FrameNode;
    expect(div.visible).toBe(false);
    const text = div.children[0] as TextNode;
    expect(text.characters).toBe('hidden text');
    expect(text.visible).toBe(false);
  });

  it('drops a locally hidden inline run instead of merging it into an otherwise-visible text node', async () => {
    document.body.innerHTML = `<p data-rect="0,0,300,20" data-text-rect="0,0,300,20">visible <span style="visibility: hidden">hidden</span> text</p>`;
    const p = (await walkElement(document.querySelector('p')!, ROOT, makeCtx()))[0] as FrameNode;
    expect(p.visible).toBe(true);
    const text = p.children[0] as TextNode;
    expect(text.characters).toBe('visible text');
    expect(text.visible).toBe(true);
  });

  it('adds synthetic text for inputs from placeholder', async () => {
    document.body.innerHTML = `<input data-rect="0,0,200,40" placeholder="Email" style="padding: 8px; border: 1px solid rgb(0, 0, 0)">`;
    const input = (await walkElement(document.querySelector('input')!, ROOT, makeCtx()))[0] as FrameNode;
    expect(input.stroke).toMatchObject({ weights: { top: 1, right: 1, bottom: 1, left: 1 } });
    const text = input.children[0] as TextNode;
    expect(text.characters).toBe('Email');
    expect(text.runs[0].color.a).toBeCloseTo(0.5);
    expect(text.verticalAlign).toBe('center');
  });

  // C2 regression: a password value must never appear in plaintext in the captured document (it
  // ends up in the downloaded .h2f.json, chrome.storage.session, and the popup's clipboard copy).
  it('masks a password input value with bullets instead of capturing it in plaintext', async () => {
    document.body.innerHTML = `<input type="password" data-rect="0,0,200,40" value="hunter2" placeholder="Password">`;
    const input = (await walkElement(document.querySelector('input')!, ROOT, makeCtx()))[0] as FrameNode;
    const text = input.children[0] as TextNode;
    expect(text.characters).toBe('•••••••');
    expect(text.characters).not.toContain('hunter2');
    expect(text.characters.length).toBe('hunter2'.length);
  });

  it('falls back to the placeholder (dimmed, not masked) for an empty password input', async () => {
    document.body.innerHTML = `<input type="password" data-rect="0,0,200,40" placeholder="Password">`;
    const input = (await walkElement(document.querySelector('input')!, ROOT, makeCtx()))[0] as FrameNode;
    const text = input.children[0] as TextNode;
    expect(text.characters).toBe('Password');
    expect(text.runs[0].color.a).toBeCloseTo(0.5);
  });

});

describe('buildRoot', () => {
  it('creates a page frame sized to the document with a white default fill', async () => {
    document.body.innerHTML = `<main data-rect="0,0,1000,300"><p data-rect="0,0,100,20" data-text-rect="0,0,100,20">hi</p></main>`;
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 1000, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 2400, configurable: true });
    const root = await buildRoot(document.documentElement, makeCtx());
    expect(root).toMatchObject({ type: 'frame', x: 0, y: 0, width: 1000, height: 2400, clip: true });
    expect(root.fills).toEqual([{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }]);
    expect(root.children[0]).toMatchObject({ name: 'body' });
  });

  // C4 regression: previously one "Estimated geometry for ::before of <x>." warning was pushed
  // per pseudo-element, which floods `warnings` on a page with many decorative ::before/::after
  // rules and buries warnings about real problems (the UI truncates the list for display).
  it('aggregates many pseudo-element geometry estimates into a single counted warning instead of one per element', async () => {
    const kids = Array.from({ length: 6 }, (_, i) => `<div class="deco" data-rect="0,${i * 10},50,10" style="content: 'x'"></div>`).join('');
    document.body.innerHTML = `<main data-rect="0,0,300,300">${kids}</main>`;
    Object.defineProperty(document.documentElement, 'clientWidth', { value: 300, configurable: true });
    Object.defineProperty(document.documentElement, 'scrollHeight', { value: 300, configurable: true });
    const ctx = makeCtx();
    await buildRoot(document.documentElement, ctx);
    const pseudoWarnings = ctx.warnings.filter((w) => /pseudo-element/.test(w));
    expect(pseudoWarnings).toHaveLength(1);
    expect(pseudoWarnings[0]).toMatch(/^Estimated geometry for \d+ pseudo-element\(s\)\.$/);
  });
});
