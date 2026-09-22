// C3 regression: when figma.createImage throws for a received asset, the failure must survive
// into the warnings returned with the 'done' message, not just the transient 'progress' stage
// line (which the very next asset's progress post immediately overwrites). Without this, an
// import can report "imported N layers" / "no warnings" while a chunk of fills silently vanished.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { H2FDocument } from '@h2f/schema';
import { installFigmaMock, type MockFigma } from './figmaMock';

let mock: MockFigma;
beforeEach(() => { mock = installFigmaMock(); });

async function loadMain(): Promise<(msg: unknown) => Promise<void> | void> {
  vi.resetModules();
  await import('../src/main/index');
  const figma = (globalThis as unknown as { figma: { ui: { onmessage?: (msg: unknown) => Promise<void> | void } } }).figma;
  const handler = figma.ui.onmessage;
  if (!handler) throw new Error('main/index.ts did not wire figma.ui.onmessage');
  return handler;
}

function docWithImageFill(assetId: string): H2FDocument {
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

describe('asset registration failures are surfaced as durable warnings', () => {
  it('keeps a figma.createImage failure for a regular asset in the warnings returned with done', async () => {
    const onmessage = await loadMain();
    const figma = (globalThis as unknown as { figma: { createImage: (bytes: Uint8Array) => { hash: string } } }).figma;
    const realCreateImage = figma.createImage;
    figma.createImage = (bytes: Uint8Array) => {
      if (bytes.length === 1 && bytes[0] === 0xff) throw new Error('unsupported image format');
      return realCreateImage(bytes);
    };

    await onmessage({ type: 'begin', assetCount: 1, options: { newPage: false } });
    await onmessage({ type: 'asset', id: 'bad-asset', bytes: new Uint8Array([0xff]), width: 10, height: 10 });
    await onmessage({ type: 'tree', document: docWithImageFill('bad-asset') });

    const done = mock.posted.find((m): m is { type: 'done'; nodeCount: number; warnings: string[] } => (m as { type: string }).type === 'done');
    expect(done).toBeTruthy();
    expect(done!.warnings.some((w) => /bad-asset/.test(w))).toBe(true);

    // The transient progress messages posted during the failure must not be the *only* record —
    // this is the actual regression: before the fix, `warnings` on 'done' was built solely from
    // `doc.warnings`, so this array would be empty even though an asset failed to register.
    const progressOnly = mock.posted.filter((m): m is { type: 'progress'; stage: string } => (m as { type: string }).type === 'progress' && /bad-asset/.test((m as { stage: string }).stage ?? ''));
    expect(progressOnly.length).toBeGreaterThan(0);
  });

  it('keeps a figma.createImage failure for an svg fallback image in the warnings returned with done', async () => {
    const onmessage = await loadMain();
    const figma = (globalThis as unknown as { figma: { createImage: (bytes: Uint8Array) => { hash: string } } }).figma;
    const realCreateImage = figma.createImage;
    figma.createImage = (bytes: Uint8Array) => {
      if (bytes.length === 1 && bytes[0] === 0xee) throw new Error('bad fallback bytes');
      return realCreateImage(bytes);
    };

    await onmessage({ type: 'begin', assetCount: 1, options: { newPage: false } });
    await onmessage({ type: 'svg', id: 'bad-svg', svg: '<svg/>', fallback: new Uint8Array([0xee]) });
    await onmessage({ type: 'tree', document: docWithImageFill('bad-svg') });

    const done = mock.posted.find((m): m is { type: 'done'; nodeCount: number; warnings: string[] } => (m as { type: string }).type === 'done');
    expect(done).toBeTruthy();
    expect(done!.warnings.some((w) => /bad-svg/.test(w))).toBe(true);
  });

  it('clears stale asset warnings from a previous run on a fresh begin', async () => {
    const onmessage = await loadMain();
    const figma = (globalThis as unknown as { figma: { createImage: (bytes: Uint8Array) => { hash: string } } }).figma;
    const realCreateImage = figma.createImage;
    figma.createImage = (bytes: Uint8Array) => {
      if (bytes.length === 1 && bytes[0] === 0xff) throw new Error('unsupported image format');
      return realCreateImage(bytes);
    };

    await onmessage({ type: 'begin', assetCount: 1, options: { newPage: false } });
    await onmessage({ type: 'asset', id: 'bad-asset', bytes: new Uint8Array([0xff]), width: 10, height: 10 });
    await onmessage({ type: 'tree', document: docWithImageFill('bad-asset') });

    // Second run with no failing assets at all.
    await onmessage({ type: 'begin', assetCount: 0, options: { newPage: false } });
    await onmessage({ type: 'tree', document: { ...docWithImageFill('bad-asset'), root: { ...docWithImageFill('bad-asset').root, fills: [] } } });

    const doneMessages = mock.posted.filter((m): m is { type: 'done'; nodeCount: number; warnings: string[] } => (m as { type: string }).type === 'done');
    expect(doneMessages).toHaveLength(2);
    expect(doneMessages[1].warnings.some((w) => /bad-asset/.test(w))).toBe(false);
  });
});
