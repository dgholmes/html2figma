import { SCHEMA_VERSION, type H2FDocument } from '@h2f/schema';
import { AssetStore } from './assets';
import { createCanvasNormalizer, parseColor } from './color';
import type { AssetLoader } from './media';
import { preparePage, type ProgressFn } from './prepare';
import { buildRoot, type WalkContext } from './walk';

export type { AssetLoader } from './media';
export type { H2FDocument } from '@h2f/schema';
export type { ProgressFn } from './prepare';

export interface CaptureOptions {
  root?: Element; window?: Window; revealAnimations?: boolean; captureVideoFrames?: boolean;
  loader: AssetLoader; onProgress?: ProgressFn;
}
export interface CaptureResult { document: H2FDocument }

export async function capturePage(options: CaptureOptions): Promise<CaptureResult> {
  const win = options.window ?? window;
  const doc = win.document;
  const root = (options.root ?? doc.documentElement) as HTMLElement;
  const progress: ProgressFn = options.onProgress ?? (() => {});
  const warnings: string[] = [];
  progress('Preparing page', 0, 1);
  const prep = await preparePage(win, root, { revealAnimations: options.revealAnimations ?? true, onProgress: progress });
  warnings.push(...prep.warnings);
  try {
    const store = new AssetStore();
    const normalizer = createCanvasNormalizer(doc);
    const total = root.querySelectorAll('*').length || 1;
    let done = 0;
    let lastYield = Date.now();
    let counter = 0;
    const ctx: WalkContext = {
      doc, win, store, loader: options.loader, warnings,
      color: (s) => parseColor(s, normalizer),
      captureVideoFrames: options.captureVideoFrames ?? true,
      isFontAvailable: (family) => { try { return doc.fonts.check(`12px "${family}"`); } catch { return true; } },
      nextId: () => `n${++counter}`,
      tick: async () => {
        done++;
        if (Date.now() - lastYield > 50) {
          progress('Capturing elements', Math.min(done, total), total);
          await new Promise<void>((r) => setTimeout(r, 0));
          lastYield = Date.now();
        }
      },
      // buildRoot aggregates and pushes the pseudo-element estimate warning into this same
      // `warnings` array once the whole tree has been walked (see WalkContext.pseudoEstimates).
      pseudoEstimates: { count: 0 },
    };
    const rootNode = await buildRoot(root, ctx);
    progress('Finishing', 1, 1);
    const document: H2FDocument = {
      version: SCHEMA_VERSION,
      source: {
        url: doc.location.href, title: doc.title, capturedAt: new Date().toISOString(),
        viewport: { width: doc.documentElement.clientWidth || win.innerWidth, height: win.innerHeight },
        devicePixelRatio: win.devicePixelRatio || 1, userAgent: win.navigator.userAgent, fullPageHeight: rootNode.height,
      },
      root: rootNode, assets: store.toRecord(), warnings,
    };
    return { document };
  } finally {
    prep.restore();
  }
}
