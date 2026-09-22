// @vitest-environment jsdom
//
// The figma-plugin package's default vitest environment is 'node' (the plugin's *main* thread has
// no DOM), but src/ui/ui.ts runs inside a real browser iframe and uses `document`/`window`
// directly. This file overrides the environment to jsdom just for itself so ui.ts's DOM-driven
// logic (C3, I8, I9) can be exercised the same way a real Figma UI iframe would run it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { H2FDocument } from '@h2f/schema';
import type { MainToUi } from '../src/messages';

vi.mock('../src/ui/assets', () => ({
  prepareImageAsset: vi.fn(async () => ({ bytes: new Uint8Array([1]), width: 1, height: 1 })),
  rasterizeSvg: vi.fn(async () => undefined as Uint8Array | undefined),
}));

import { prepareImageAsset, rasterizeSvg } from '../src/ui/assets';

interface Posted { type: string; [key: string]: unknown }

function domHtml(): string {
  return `
    <div id="drop" class="drop" tabindex="0">Drop</div>
    <input id="file" type="file" class="hidden">
    <textarea id="paste"></textarea>
    <div id="info" class="info hidden">
      <div><span>Page</span><span id="info-title"></span></div>
      <div><span>URL</span><span id="info-url"></span></div>
      <div><span>Viewport</span><span id="info-viewport"></span></div>
      <div><span>Layers / assets</span><span id="info-counts"></span></div>
    </div>
    <label><input id="opt-newpage" type="checkbox" checked> Create on a new page</label>
    <button id="import" disabled>Import into Figma</button>
    <div class="bar"><div id="bar-fill"></div></div>
    <div id="stage"></div>
    <pre id="log" class="hidden"></pre>`;
}

async function loadUi(): Promise<{ posted: Posted[]; emitFromMain: (msg: MainToUi) => void }> {
  vi.resetModules();
  document.body.innerHTML = domHtml();
  const posted: Posted[] = [];
  vi.spyOn(window, 'postMessage').mockImplementation((msg: unknown) => {
    const pm = (msg as { pluginMessage?: Posted } | undefined)?.pluginMessage;
    if (pm) posted.push(pm);
  });
  await import('../src/ui/ui');
  const emitFromMain = (msg: MainToUi) => {
    const handler = window.onmessage;
    if (!handler) throw new Error('ui.ts did not wire window.onmessage');
    handler.call(window, { data: { pluginMessage: msg } } as MessageEvent);
  };
  return { posted, emitFromMain };
}

function sampleDoc(): H2FDocument {
  return {
    version: 1,
    source: { url: 'https://example.com/', title: 'Example', capturedAt: '2026-01-01T00:00:00.000Z', viewport: { width: 100, height: 100 }, devicePixelRatio: 1, userAgent: 'test', fullPageHeight: 100 },
    // svg1 is referenced by an ImagePaint (not just present as an unused asset), so rasterizing it
    // is genuinely needed — this keeps the test valid after the I8 fix, which stops rasterizing
    // svg assets that no ImagePaint actually references.
    root: {
      id: 'root', name: 'root', type: 'frame', x: 0, y: 0, width: 100, height: 100, rotation: 0, visible: true, opacity: 1, blendMode: 'normal',
      fills: [{ type: 'image', assetId: 'svg1', scaleMode: 'fill' }], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: 'div', classes: [] }, children: [],
    },
    assets: {
      img1: { id: 'img1', kind: 'image', mime: 'image/png', data: 'AAAA', width: 10, height: 10, origin: 'img' },
      svg1: { id: 'svg1', kind: 'svg', svg: '<svg/>', width: 10, height: 10 },
    },
    warnings: [],
  } as unknown as H2FDocument;
}

function pasteAndImport(doc: H2FDocument): void {
  const paste = document.getElementById('paste') as HTMLTextAreaElement;
  paste.value = JSON.stringify(doc);
  paste.dispatchEvent(new Event('input'));
  (document.getElementById('import') as HTMLButtonElement).click();
}

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(prepareImageAsset).mockResolvedValue({ bytes: new Uint8Array([1]), width: 1, height: 1 });
  vi.mocked(rasterizeSvg).mockResolvedValue(new Uint8Array([2]));
});
afterEach(() => vi.restoreAllMocks());

// C3 regression: an asset-stage failure discovered in the UI (image decode, svg rasterize) used
// to either get erased by the 'done' handler's setLog() replacing the whole log, or (for
// rasterizeSvg) never get logged at all. Both must survive into the final warning summary.
describe('ui asset-failure accumulation (C3)', () => {
  it('keeps an image-decode failure and an svg-rasterize failure in the final log instead of the done handler erasing them', async () => {
    vi.mocked(prepareImageAsset).mockResolvedValueOnce(null);
    vi.mocked(rasterizeSvg).mockResolvedValueOnce(undefined);

    const { posted, emitFromMain } = await loadUi();
    pasteAndImport(sampleDoc());
    await flush();

    // Main finishes with zero warnings of its own — proves the log content below comes from the
    // UI's own accumulator, not from msg.warnings.
    emitFromMain({ type: 'done', nodeCount: 3, warnings: [] });

    const log = document.getElementById('log')!;
    expect(log.textContent).toMatch(/Could not decode image img1/);
    expect(log.textContent).toMatch(/Could not rasterize SVG asset svg1/);
    expect(posted.some((m) => m.type === 'tree')).toBe(true);
  });

  it('concatenates UI-side and main-side warnings rather than showing only the last one received', async () => {
    vi.mocked(prepareImageAsset).mockResolvedValueOnce(null);

    const { emitFromMain } = await loadUi();
    pasteAndImport(sampleDoc());
    await flush();

    emitFromMain({ type: 'done', nodeCount: 3, warnings: ['Font "Foo" is not available in Figma; using Inter instead.'] });

    const log = document.getElementById('log')!;
    expect(log.textContent).toMatch(/Could not decode image img1/);
    expect(log.textContent).toMatch(/Font "Foo" is not available/);
    expect(log.textContent).toMatch(/^2 warning\(s\):/);
  });

  it('reports "no warnings" only when neither side had a failure', async () => {
    const { emitFromMain } = await loadUi();
    pasteAndImport(sampleDoc());
    await flush();
    emitFromMain({ type: 'done', nodeCount: 3, warnings: [] });
    expect(document.getElementById('log')!.textContent).toBe('Import finished without warnings.');
  });
});

// I8 regression: rasterizing every svg asset "just in case" uploads an orphan, oversized raster
// for every icon on the page even though most of them parse fine as vectors in Figma. Only an
// asset an ImagePaint actually names should be rasterized proactively.
describe('ui rasterizes svg assets only when needed (I8)', () => {
  it('does not rasterize an svg asset that is only used as a vector node', async () => {
    const { posted } = await loadUi();
    const doc = sampleDoc();
    // Not referenced by any ImagePaint — only as a (hypothetical) vector node elsewhere.
    doc.root.fills = [];
    pasteAndImport(doc);
    await flush();

    expect(rasterizeSvg).not.toHaveBeenCalled();
    const svgMsg = posted.find((m) => m.type === 'svg' && m.id === 'svg1') as { fallback?: Uint8Array } | undefined;
    expect(svgMsg).toBeTruthy();
    expect(svgMsg!.fallback).toBeUndefined();
  });

  it('still rasterizes an svg asset that an ImagePaint references', async () => {
    const { posted } = await loadUi();
    pasteAndImport(sampleDoc()); // sampleDoc's root fill references svg1 as an ImagePaint
    await flush();

    expect(rasterizeSvg).toHaveBeenCalledWith('<svg/>', 10, 10);
    const svgMsg = posted.find((m) => m.type === 'svg' && m.id === 'svg1') as { fallback?: Uint8Array } | undefined;
    expect(svgMsg!.fallback).toBeInstanceOf(Uint8Array);
  });
});

// I9 regression: a corrupt/truncated file (or any other unexpected failure reading it or
// importing it) must be reported and leave the UI usable, not wedge it with the button stuck
// disabled and nothing logged.
describe('ui error handling for corrupt files and unexpected failures (I9)', () => {
  it('logs an error and does not leave the button stuck when file.text() rejects', async () => {
    await loadUi();
    const badFile = { name: 'broken.h2f.json', text: () => Promise.reject(new Error('stream errored')) } as unknown as File;
    const fileInput = document.getElementById('file') as HTMLInputElement;
    Object.defineProperty(fileInput, 'files', { value: [badFile], configurable: true });
    fileInput.dispatchEvent(new Event('change'));
    await flush();

    const log = document.getElementById('log')!;
    expect(log.textContent).toMatch(/Could not read broken\.h2f\.json/);
    expect(log.classList.contains('error')).toBe(true);
    expect((document.getElementById('import') as HTMLButtonElement).disabled).toBe(true);
  });

  it('logs an error and re-enables the button when startImport rejects unexpectedly', async () => {
    vi.mocked(prepareImageAsset).mockRejectedValueOnce(new Error('boom'));
    await loadUi();
    pasteAndImport(sampleDoc());
    await flush();

    const log = document.getElementById('log')!;
    expect(log.textContent).toMatch(/Could not import: boom/);
    expect((document.getElementById('import') as HTMLButtonElement).disabled).toBe(false);
  });
});
