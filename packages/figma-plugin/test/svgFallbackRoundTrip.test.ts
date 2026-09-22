// I8 follow-up (scoped re-review finding): the original I8 fix implemented only the "an
// ImagePaint references this asset" proactive-rasterization trigger and skipped the finding's
// second required trigger, "or when createNodeFromSvg actually failed." Consequence: for an svg
// asset NOT referenced by any ImagePaint (the common case — inline icon svgs), ui.ts's real
// gating sends `fallback: undefined`, so when figma.createNodeFromSvg throws in
// packages/figma-plugin/src/main/builder.ts's createVector, `if (!entry.fallback) throw e` fires
// and the node becomes a red-dashed "import failed" placeholder — worse than the pre-I8 baseline,
// which always rasterized (at the cost of orphan uploads for the ~good case).
//
// Fix (option (a) of the three offered): a lazy round trip. When createVector hits a parse
// failure with no proactive fallback, it now calls `BuilderDeps.requestFallback`, which
// main/index.ts implements by posting a new 'needFallback' message and awaiting a correlated
// 'fallback' response — the same request/response shape ui.ts already answers by calling the
// real `rasterizeSvg`. I chose this over (b) (proactively rasterize "cheap" svgs under a size
// threshold) and (c) (rasterize proactively at 1x instead of 2x) because it's the only one of the
// three that exactly satisfies BOTH of the finding's original triggers without any heuristic: it
// never uploads anything for an svg that never needed it (any size, not just "cheap" ones — see
// the second test below), and it guarantees — not just makes likely — that any svg failing to
// parse still gets a raster fallback, once, cached, however many times that asset id recurs.
//
// This test drives the REAL end-to-end path through main/index.ts's actual figma.ui.onmessage
// handler and Builder — not a pre-populated `entry.fallback` (which is how builder.test.ts's
// existing fallback test works, and which the scoped re-review specifically flagged as bypassing
// the UI gating this fix is about).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { H2FDocument } from '@h2f/schema';
import { installFigmaMock, type MockFigma, type MockNode } from './figmaMock';

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

// Answers a main-initiated 'needFallback' request the way the real ui.ts's window.onmessage
// handler does (calling rasterizeSvg and posting back 'fallback') — patched onto the actual
// global figma.ui.postMessage main/index.ts posts through, not routed via MockFigma (which
// doesn't expose `ui`, only the messages it records in `.posted`).
function respondToFallbackRequests(onmessage: (msg: unknown) => Promise<void> | void, bytesFor: (id: string) => Uint8Array | undefined): { sawRequestFor: string[] } {
  const sawRequestFor: string[] = [];
  const figmaGlobal = (globalThis as unknown as { figma: { ui: { postMessage: (msg: unknown) => void } } }).figma;
  const originalPostMessage = figmaGlobal.ui.postMessage;
  figmaGlobal.ui.postMessage = (msg: unknown) => {
    originalPostMessage(msg);
    const m = msg as { type: string; id?: string };
    if (m.type === 'needFallback' && m.id) {
      sawRequestFor.push(m.id);
      void onmessage({ type: 'fallback', id: m.id, bytes: bytesFor(m.id) });
    }
  };
  return { sawRequestFor };
}

function docWithVector(assetId: string): H2FDocument {
  return {
    version: 1,
    source: { url: 'https://example.com/page', title: 'Example', capturedAt: '2026-01-01T00:00:00.000Z', viewport: { width: 100, height: 100 }, devicePixelRatio: 1, userAgent: 'test', fullPageHeight: 100 },
    root: {
      id: 'root', name: 'root', type: 'frame', x: 0, y: 0, width: 100, height: 100, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
      fills: [], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'div', classes: [] },
      children: [
        {
          id: 'v', name: 'icon', type: 'vector', assetId, x: 0, y: 0, width: 24, height: 24, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
          fills: [], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'svg', classes: [] },
        },
      ],
    },
    assets: {},
    warnings: [],
  } as unknown as H2FDocument;
}

describe('I8 follow-up: reactive svg fallback round trip', () => {
  it('an unreferenced svg whose createNodeFromSvg fails still produces a real image fill, not an "import failed" placeholder', async () => {
    const onmessage = await loadMain();
    const badSvg = '<svg><this-is-not-real-svg-markup/></svg>';
    mock.svgFailsFor.add(badSvg);
    const rasterBytes = new Uint8Array([7, 7, 7]);
    const { sawRequestFor } = respondToFallbackRequests(onmessage, () => rasterBytes);

    await onmessage({ type: 'begin', assetCount: 1, options: { newPage: false } });
    // Exactly what ui.ts's real I8 gating sends for an svg NOT referenced by any ImagePaint:
    // `fallback: undefined` — never pre-populated. (The gating decision itself — that
    // imagePaintAssetIds excludes this asset — is covered directly by ui.test.ts's "does not
    // rasterize an svg asset that is only used as a vector node".)
    await onmessage({ type: 'svg', id: 'unreferenced-icon', svg: badSvg, fallback: undefined });
    await onmessage({ type: 'tree', document: docWithVector('unreferenced-icon') });

    expect(sawRequestFor).toEqual(['unreferenced-icon']);
    expect(mock.images).toContainEqual(rasterBytes);

    const icon = mock.created.find((n): n is MockNode => n.name === 'icon')!;
    expect(icon).toBeTruthy();
    expect(icon.name).not.toMatch(/import failed/);
    expect(icon.fills).toEqual([{ type: 'IMAGE', imageHash: expect.any(String), scaleMode: 'FIT' }]);
    expect(mock.created.filter((n) => /import failed/.test(n.name))).toEqual([]);
  });

  it('reuses the same uploaded raster (one round trip, one upload) when the same failing asset id recurs', async () => {
    const onmessage = await loadMain();
    const badSvg = '<svg><this-is-not-real-svg-markup/></svg>';
    mock.svgFailsFor.add(badSvg);
    const { sawRequestFor } = respondToFallbackRequests(onmessage, () => new Uint8Array([9, 9, 9]));

    const doc = docWithVector('repeated-icon');
    doc.root.children.push({ ...doc.root.children[0], id: 'v2', name: 'icon2' });

    await onmessage({ type: 'begin', assetCount: 1, options: { newPage: false } });
    await onmessage({ type: 'svg', id: 'repeated-icon', svg: badSvg, fallback: undefined });
    await onmessage({ type: 'tree', document: doc });

    expect(sawRequestFor).toEqual(['repeated-icon']); // only one round trip for two uses of the same asset
    expect(mock.images.filter((b) => b.length === 3 && b[0] === 9)).toHaveLength(1); // uploaded once
    const icons = mock.created.filter((n): n is MockNode => n.name === 'icon' || n.name === 'icon2');
    expect(icons).toHaveLength(2);
    for (const n of icons) expect(n.fills).toEqual([{ type: 'IMAGE', imageHash: expect.any(String), scaleMode: 'FIT' }]);
  });

  it('does not rasterize or upload anything for an unreferenced svg whose createNodeFromSvg succeeds — confirms the orphan-upload cost I8 removed has not come back', async () => {
    const onmessage = await loadMain();
    // Deliberately large-ish markup and dimensions — the point of choosing the reactive round
    // trip (over a size-threshold heuristic) is that NOTHING about this path depends on the
    // asset's size: an unreferenced svg that parses fine is never rasterized regardless of how
    // big it is, exactly like a decorative full-bleed svg.
    const goodSvg = `<svg width="1600" height="900" viewBox="0 0 1600 900">${'<path d="M0 0 L10 10 Z"/>'.repeat(50)}</svg>`;
    const { sawRequestFor } = respondToFallbackRequests(onmessage, () => new Uint8Array([1]));

    await onmessage({ type: 'begin', assetCount: 1, options: { newPage: false } });
    await onmessage({ type: 'svg', id: 'fine-decorative-icon', svg: goodSvg, fallback: undefined });
    await onmessage({ type: 'tree', document: docWithVector('fine-decorative-icon') });

    expect(sawRequestFor).toEqual([]);
    expect(mock.images).toEqual([]);
    const icon = mock.created.find((n): n is MockNode => n.name === 'icon')!;
    expect(icon.type).toBe('FRAME'); // built as a real vector (createNodeFromSvg succeeded)
    expect(icon.fills).toEqual([]);
  });
});
