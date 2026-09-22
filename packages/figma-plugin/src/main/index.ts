import { countNodes, type H2FDocument } from '@h2f/schema';
import type { ImportOptions, MainToUi, UiToMain } from '../messages';
import { Builder } from './builder';
import { FontResolver } from './fonts';

export interface ImportState {
  images: Map<string, string>; svgs: Map<string, { svg: string; fallback?: Uint8Array }>; options: ImportOptions;
  // Asset-registration failures (figma.createImage throwing for a received asset or svg
  // fallback) accumulated across the 'asset'/'svg' handlers below, so they survive into the
  // final warnings list instead of only ever reaching the transient 'progress' stage line that
  // the next asset's progress message immediately overwrites (see importDocument).
  assetWarnings: string[];
}

const post = (msg: MainToUi) => figma.ui.postMessage(msg);

export async function importDocument(
  doc: H2FDocument,
  state: ImportState,
  requestFallback?: (id: string, svg: string, width: number, height: number) => Promise<Uint8Array | undefined>,
): Promise<{ root: FrameNode; warnings: string[]; nodeCount: number }> {
  const warnings = [...doc.warnings, ...state.assetWarnings];
  post({ type: 'progress', stage: 'Loading fonts', done: 0, total: 1 });
  const fonts = new FontResolver(await figma.listAvailableFontsAsync());
  await fonts.preload(doc.root, warnings);
  let page = figma.currentPage;
  if (state.options.newPage) {
    page = figma.createPage();
    page.name = (doc.source.title || doc.source.url).slice(0, 60);
    await figma.setCurrentPageAsync(page);
  }
  const total = countNodes(doc.root);
  const builder = new Builder({ images: state.images, svgs: state.svgs, fonts, warnings, onProgress: (done) => post({ type: 'progress', stage: 'Building layers', done, total }), requestFallback });
  const root = (await builder.build(doc.root, page)) as FrameNode;
  let host = '';
  try { host = new URL(doc.source.url).hostname; } catch { /* ignore */ }
  root.name = `${doc.source.title || 'Page'}${host ? ` — ${host}` : ''}`;
  root.setPluginData('h2f-source', doc.source.url);
  figma.viewport.scrollAndZoomIntoView([root]);
  return { root, warnings, nodeCount: total };
}

if (typeof figma !== 'undefined' && typeof __html__ !== 'undefined') {
  figma.showUI(__html__, { width: 420, height: 560, themeColors: true });
  const state: ImportState = { images: new Map(), svgs: new Map(), options: { newPage: true }, assetWarnings: [] };
  let expected = 0;
  let received = 0;
  // I8 follow-up: at most one 'needFallback' round trip is ever in flight — the Builder is
  // single-threaded through the tree (createFrame awaits each child's build() in turn before
  // moving on, same invariant I10 relies on for `pendingNode`), so a single pending resolver is
  // sufficient; there's never a second request queued behind it.
  let pendingFallback: { id: string; resolve: (bytes: Uint8Array | undefined) => void } | null = null;
  const requestFallback = (id: string, svg: string, width: number, height: number): Promise<Uint8Array | undefined> =>
    new Promise((resolve) => {
      pendingFallback = { id, resolve };
      post({ type: 'needFallback', id, svg, width, height });
    });
  figma.ui.onmessage = async (msg: UiToMain) => {
    try {
      switch (msg.type) {
        case 'begin':
          state.images.clear(); state.svgs.clear(); state.options = msg.options; state.assetWarnings = []; expected = msg.assetCount; received = 0;
          post({ type: 'progress', stage: 'Receiving assets', done: 0, total: Math.max(1, expected) });
          break;
        case 'asset':
          try { state.images.set(msg.id, figma.createImage(msg.bytes).hash); }
          catch (e) {
            // C3: a transient 'progress' stage message alone isn't enough — the very next
            // asset's progress post overwrites it in the UI before the user can read it. Keep
            // this failure in `assetWarnings` too so it survives into the final warnings list
            // (see importDocument), instead of the import silently reporting success with a
            // missing fill.
            const m = `Could not register image asset "${msg.id}": ${e instanceof Error ? e.message : String(e)}`;
            state.assetWarnings.push(m);
            post({ type: 'progress', stage: m, done: received, total: Math.max(1, expected) });
          }
          received++;
          post({ type: 'progress', stage: 'Receiving assets', done: received, total: Math.max(1, expected) });
          break;
        case 'svg':
          state.svgs.set(msg.id, { svg: msg.svg, fallback: msg.fallback });
          // Controller-required fix: capture can emit an ImagePaint (from CSS
          // background-image) whose assetId names an svg-kind asset, not a vector node.
          // toFigmaPaint resolves image paints exclusively through `images`, so without
          // this the fill would silently vanish. Rasterize the same svg's fallback PNG
          // (already produced by the UI for the "svg failed to parse" vector fallback)
          // into an image and register its hash under the same asset id, so an ImagePaint
          // referencing this id still resolves to a real image fill.
          if (msg.fallback) {
            try { state.images.set(msg.id, figma.createImage(msg.fallback).hash); }
            catch (e) {
              const m = `Could not register svg fallback image "${msg.id}": ${e instanceof Error ? e.message : String(e)}`;
              state.assetWarnings.push(m);
              post({ type: 'progress', stage: m, done: received, total: Math.max(1, expected) });
            }
          }
          received++;
          post({ type: 'progress', stage: 'Receiving assets', done: received, total: Math.max(1, expected) });
          break;
        case 'tree': {
          const result = await importDocument(msg.document, state, requestFallback);
          post({ type: 'done', nodeCount: result.nodeCount, warnings: result.warnings });
          figma.notify(`html2figma: imported ${result.nodeCount} layers`);
          break;
        }
        case 'fallback':
          if (pendingFallback && pendingFallback.id === msg.id) {
            pendingFallback.resolve(msg.bytes);
            pendingFallback = null;
          }
          break;
        case 'cancel':
          figma.closePlugin();
          break;
      }
    } catch (e) {
      post({ type: 'error', message: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
    }
  };
  post({ type: 'ready' });
}
