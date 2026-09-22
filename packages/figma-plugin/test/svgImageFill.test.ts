// Controller-required coverage: CSS `background-image: url(...svg...)` produces an
// `ImagePaint` (not a vector node) whose `assetId` names an svg-kind asset. The UI sends
// svg assets only as `{ type: 'svg', ... }` messages; unless `main` also registers that
// asset's rasterized fallback into its `images` map, `toFigmaPaint` (which resolves image
// paints exclusively through `images`) silently drops the fill. This test drives the real
// plugin message flow (`figma.ui.onmessage`, as wired by `src/main/index.ts`'s bootstrap)
// end-to-end and asserts the resulting frame gets a real IMAGE fill.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { H2FDocument } from '@h2f/schema';
import { installFigmaMock, type MockFigma, type MockNode } from './figmaMock';

let mock: MockFigma;

beforeEach(() => {
  mock = installFigmaMock();
});

async function loadMain(): Promise<(msg: unknown) => Promise<void> | void> {
  vi.resetModules();
  await import('../src/main/index');
  const figma = (globalThis as unknown as { figma: { ui: { onmessage?: (msg: unknown) => Promise<void> | void } } }).figma;
  const handler = figma.ui.onmessage;
  if (!handler) throw new Error('main/index.ts did not wire figma.ui.onmessage');
  return handler;
}

function docWithSvgBackedImagePaint(assetId: string): H2FDocument {
  return {
    version: 1,
    source: { url: 'https://example.com/page', title: 'Example', capturedAt: '2026-01-01T00:00:00.000Z', viewport: { width: 100, height: 100 }, devicePixelRatio: 1, userAgent: 'test', fullPageHeight: 100 },
    root: {
      id: 'root', name: 'root', type: 'frame', x: 0, y: 0, width: 100, height: 100, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
      fills: [{ type: 'image', assetId, scaleMode: 'fill' }],
      radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'div', classes: [] },
      children: [],
    },
    assets: {},
    warnings: [],
  } as unknown as H2FDocument;
}

describe('svg asset backing an ImagePaint fill', () => {
  it('registers a rasterized image for the svg asset so the fill is not dropped', async () => {
    const onmessage = await loadMain();
    await onmessage({ type: 'begin', assetCount: 1, options: { newPage: false } });
    await onmessage({ type: 'svg', id: 'svg1', svg: '<svg/>', fallback: new Uint8Array([9, 9, 9]) });
    await onmessage(docTreeMessage('svg1'));

    // The svg's fallback bytes must have been handed to figma.createImage.
    expect(mock.images).toContainEqual(new Uint8Array([9, 9, 9]));

    const root = mock.created.find((n): n is MockNode => n.type === 'FRAME' && n.name.startsWith('Example'));
    expect(root).toBeTruthy();
    expect(root!.fills).toEqual([{ type: 'IMAGE', imageHash: 'img1', scaleMode: 'FILL', opacity: 1 }]);

    const done = mock.posted.find((m): m is { type: 'done' } => (m as { type: string }).type === 'done');
    expect(done).toBeTruthy();
  });

  it('still builds the svg as a vector node from the same asset id (svgs map is unaffected)', async () => {
    const onmessage = await loadMain();
    await onmessage({ type: 'begin', assetCount: 1, options: { newPage: false } });
    await onmessage({ type: 'svg', id: 'svg1', svg: '<svg/>', fallback: new Uint8Array([9, 9, 9]) });
    const doc: H2FDocument = {
      version: 1,
      source: { url: 'https://example.com/page', title: 'Example2', capturedAt: '', viewport: { width: 100, height: 100 }, devicePixelRatio: 1, userAgent: '', fullPageHeight: 100 },
      root: {
        id: 'root', name: 'root', type: 'frame', x: 0, y: 0, width: 100, height: 100, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
        fills: [], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'div', classes: [] },
        children: [{ id: 'v', name: 'icon', type: 'vector', assetId: 'svg1', x: 0, y: 0, width: 10, height: 10, rotation: 0, visible: true, opacity: 1, blendMode: 'normal', fills: [], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'svg', classes: [] } }],
      },
      assets: {},
      warnings: [],
    } as unknown as H2FDocument;
    await onmessage({ type: 'tree', document: doc });
    const icon = mock.created.find((n) => n.name === 'icon');
    expect(icon).toBeTruthy();
    expect(icon!.type).toBe('FRAME');
  });
});

function docTreeMessage(assetId: string): { type: 'tree'; document: H2FDocument } {
  return { type: 'tree', document: docWithSvgBackedImagePaint(assetId) };
}
