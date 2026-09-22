import type { H2FDocument } from '@h2f/schema';
export interface ImportOptions { newPage: boolean }
export type UiToMain =
  | { type: 'begin'; assetCount: number; options: ImportOptions }
  | { type: 'asset'; id: string; bytes: Uint8Array; width: number; height: number }
  | { type: 'svg'; id: string; svg: string; fallback?: Uint8Array }
  | { type: 'tree'; document: H2FDocument }
  // I8 follow-up: the UI's response to a main-initiated 'needFallback' request — rasterizing one
  // specific svg on demand, after figma.createNodeFromSvg has already failed for it on the main
  // side. `bytes` is omitted when the UI's own rasterization also failed.
  | { type: 'fallback'; id: string; bytes?: Uint8Array }
  | { type: 'cancel' };
export type MainToUi =
  | { type: 'ready' }
  | { type: 'progress'; stage: string; done: number; total: number }
  | { type: 'done'; nodeCount: number; warnings: string[] }
  | { type: 'error'; message: string }
  // I8 follow-up: main asks the UI (which alone has DOM/canvas access) to rasterize this one svg
  // asset because figma.createNodeFromSvg just threw on it and no fallback was proactively
  // supplied — see Builder.createVector and main/index.ts's requestFallback.
  | { type: 'needFallback'; id: string; svg: string; width: number; height: number };
