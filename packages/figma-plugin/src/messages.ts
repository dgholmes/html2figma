import type { H2FDocument } from '@h2f/schema';
export interface ImportOptions { newPage: boolean }
export type UiToMain =
  | { type: 'begin'; assetCount: number; options: ImportOptions }
  | { type: 'asset'; id: string; bytes: Uint8Array; width: number; height: number }
  | { type: 'svg'; id: string; svg: string; fallback?: Uint8Array }
  | { type: 'tree'; document: H2FDocument }
  | { type: 'cancel' };
export type MainToUi =
  | { type: 'ready' }
  | { type: 'progress'; stage: string; done: number; total: number }
  | { type: 'done'; nodeCount: number; warnings: string[] }
  | { type: 'error'; message: string };
