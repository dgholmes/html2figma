// I11 regression: nothing offline previously fed a representative capture-shaped document through
// validateDocument and the real Builder together — the only end-to-end coverage
// (acceptance.layrd.test.ts) needs the live site and skips silently without network, so a plain
// `npm test` never exercised that path at all. This hand-builds a small H2FDocument exercising
// frames, text runs, a gradient fill, an image-paint fill, and a vector node (the schema's own
// test suite already covers validateDocument's rules in isolation, and walk.test.ts covers the
// capture side — this is specifically about the two halves working together).
import { beforeEach, describe, expect, it } from 'vitest';
import { validateDocument, type H2FDocument } from '@h2f/schema';
import { Builder, type BuilderDeps } from '../src/main/builder';
import { FontResolver } from '../src/main/fonts';
import { installFigmaMock, type MockFigma, type MockNode } from './figmaMock';

function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function sampleDocument(): H2FDocument {
  return {
    version: 1,
    source: { url: 'https://example.com/', title: 'Sample', capturedAt: '2026-09-22T00:00:00.000Z', viewport: { width: 400, height: 300 }, devicePixelRatio: 1, userAgent: 'test', fullPageHeight: 300 },
    assets: {
      img1: { id: 'img1', kind: 'image', mime: 'image/png', data: 'AAAA', width: 40, height: 40, origin: 'img' },
      vec1: { id: 'vec1', kind: 'svg', svg: '<svg width="24" height="24"><circle cx="12" cy="12" r="10"/></svg>', width: 24, height: 24 },
    },
    warnings: [],
    root: {
      id: 'root', name: 'Sample page', type: 'frame', x: 0, y: 0, width: 400, height: 300, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
      fills: [{ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } }], radius: [0, 0, 0, 0], effects: [], clip: true, meta: { tag: 'html', classes: [] },
      children: [
        {
          id: 'hero', name: 'section.hero', type: 'frame', x: 0, y: 0, width: 400, height: 120, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
          fills: [{
            type: 'gradient', gradient: 'linear',
            stops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }],
            start: { x: 0, y: 0 }, end: { x: 1, y: 0 },
          }],
          radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'section', classes: ['hero'] },
          children: [
            {
              id: 'headline', name: 'Headline', type: 'text', x: 20, y: 20, width: 200, height: 40, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
              fills: [], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'h1', classes: [] },
              characters: 'Hello world', align: 'left', verticalAlign: 'top',
              runs: [{ start: 0, end: 11, fontFamily: 'Inter', fontWeight: 700, italic: false, fontSize: 24, lineHeight: null, letterSpacing: 0, color: { r: 1, g: 1, b: 1, a: 1 }, decoration: 'none', textCase: 'original' }],
            },
            {
              id: 'photo', name: 'img.photo', type: 'frame', x: 20, y: 70, width: 40, height: 40, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
              fills: [{ type: 'image', assetId: 'img1', scaleMode: 'fill' }], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'img', classes: ['photo'] }, children: [],
            },
            {
              id: 'icon', name: 'svg.icon', type: 'vector', x: 300, y: 20, width: 24, height: 24, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
              fills: [], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'svg', classes: ['icon'] }, assetId: 'vec1',
            },
          ],
        },
      ],
    },
  };
}

let mock: MockFigma;
beforeEach(() => { mock = installFigmaMock(); });

describe('offline capture-to-build round trip', () => {
  it('validates a hand-built document exercising frames, text runs, a gradient, an image paint and a vector, then builds it end to end against the figma mock', async () => {
    const validated = validateDocument(sampleDocument());
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    const doc = validated.document;

    const images = new Map<string, string>();
    const svgs = new Map<string, { svg: string; fallback?: Uint8Array }>();
    for (const asset of Object.values(doc.assets)) {
      if (asset.kind === 'image') images.set(asset.id, figma.createImage(base64ToBytes(asset.data)).hash);
      else svgs.set(asset.id, { svg: asset.svg });
    }

    const fonts = new FontResolver(await figma.listAvailableFontsAsync());
    const warnings: string[] = [...doc.warnings];
    const deps: BuilderDeps = { images, svgs, fonts, warnings, onProgress: () => {} };
    const builder = new Builder(deps);
    const root = (await builder.build(doc.root, mock.currentPage as unknown as PageNode)) as unknown as MockNode;

    // Shape: root frame -> one hero section -> [text, image frame, vector].
    expect(root.type).toBe('FRAME');
    expect(root.children).toHaveLength(1);
    const hero = root.children[0];
    expect(hero.type).toBe('FRAME');
    expect(hero.fills).toMatchObject([{ type: 'GRADIENT_LINEAR' }]);
    expect(hero.children.map((c) => c.type)).toEqual(['TEXT', 'FRAME', 'FRAME']);

    // Text nodes actually got characters set (not left blank).
    const headline = hero.children.find((c) => c.name === 'Headline')!;
    expect(headline.type).toBe('TEXT');
    expect(headline.characters).toBe('Hello world');

    // Image paints actually resolved to a real fill (not silently dropped).
    const photo = hero.children.find((c) => c.name === 'img.photo')!;
    expect(photo.fills).toEqual([{ type: 'IMAGE', imageHash: 'img1', scaleMode: 'FILL', opacity: 1 }]);

    // The vector node built from the svg asset.
    const icon = hero.children.find((c) => c.name === 'svg.icon')!;
    expect(icon.type).toBe('FRAME'); // createNodeFromSvg wraps vector shapes in a frame

    expect(warnings).toEqual([]);
    expect(mock.currentPage.children).toContain(root);
  });
});
