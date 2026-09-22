import { countNodes, type H2FDocument } from '@h2f/schema';
import type { ImportOptions, MainToUi, UiToMain } from '../messages';
import { Builder } from './builder';
import { FontResolver } from './fonts';

export interface ImportState { images: Map<string, string>; svgs: Map<string, { svg: string; fallback?: Uint8Array }>; options: ImportOptions }

const post = (msg: MainToUi) => figma.ui.postMessage(msg);

export async function importDocument(doc: H2FDocument, state: ImportState): Promise<{ root: FrameNode; warnings: string[]; nodeCount: number }> {
  const warnings = [...doc.warnings];
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
  const builder = new Builder({ images: state.images, svgs: state.svgs, fonts, warnings, onProgress: (done) => post({ type: 'progress', stage: 'Building layers', done, total }) });
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
  const state: ImportState = { images: new Map(), svgs: new Map(), options: { newPage: true } };
  let expected = 0;
  let received = 0;
  figma.ui.onmessage = async (msg: UiToMain) => {
    try {
      switch (msg.type) {
        case 'begin':
          state.images.clear(); state.svgs.clear(); state.options = msg.options; expected = msg.assetCount; received = 0;
          post({ type: 'progress', stage: 'Receiving assets', done: 0, total: Math.max(1, expected) });
          break;
        case 'asset':
          try { state.images.set(msg.id, figma.createImage(msg.bytes).hash); }
          catch (e) { post({ type: 'progress', stage: `Skipped image ${msg.id}: ${e instanceof Error ? e.message : String(e)}`, done: received, total: Math.max(1, expected) }); }
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
            catch (e) { post({ type: 'progress', stage: `Skipped svg fallback image ${msg.id}: ${e instanceof Error ? e.message : String(e)}`, done: received, total: Math.max(1, expected) }); }
          }
          received++;
          post({ type: 'progress', stage: 'Receiving assets', done: received, total: Math.max(1, expected) });
          break;
        case 'tree': {
          const result = await importDocument(msg.document, state);
          post({ type: 'done', nodeCount: result.nodeCount, warnings: result.warnings });
          figma.notify(`html2figma: imported ${result.nodeCount} layers`);
          break;
        }
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
