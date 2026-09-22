export const SCHEMA_VERSION = 1 as const;

export interface RGBA { r: number; g: number; b: number; a: number }
export interface Point { x: number; y: number }
export type Transform2x3 = [[number, number, number], [number, number, number]];

export interface ImageAsset {
  id: string; kind: 'image'; mime: string; data: string; width: number; height: number;
  origin: 'img' | 'background' | 'video-frame' | 'video-poster' | 'canvas' | 'svg-img' | 'placeholder';
}
export interface SvgAsset { id: string; kind: 'svg'; svg: string; width: number; height: number }
export type Asset = ImageAsset | SvgAsset;

export interface GradientStop { position: number; color: RGBA }
export interface SolidPaint { type: 'solid'; color: RGBA }
export interface GradientPaint {
  type: 'gradient'; gradient: 'linear' | 'radial' | 'angular'; stops: GradientStop[];
  start: Point; end: Point; center?: Point; radius?: Point;
}
export interface ImagePaint {
  type: 'image'; assetId: string; scaleMode: 'fill' | 'fit' | 'crop' | 'tile';
  transform?: Transform2x3; scale?: number; opacity?: number;
}
export type Paint = SolidPaint | GradientPaint | ImagePaint;

export interface Stroke {
  color: RGBA; weights: { top: number; right: number; bottom: number; left: number };
  align: 'inside'; dash?: number[];
}

export interface ShadowEffect { type: 'drop-shadow' | 'inner-shadow'; color: RGBA; offset: Point; blur: number; spread: number }
export interface BlurEffect { type: 'layer-blur' | 'background-blur'; radius: number }
export type Effect = ShadowEffect | BlurEffect;

export interface NodeMeta {
  tag: string; id?: string; classes: string[]; position?: 'fixed' | 'sticky'; pseudo?: 'before' | 'after';
}

export interface NodeBase {
  id: string; name: string;
  x: number; y: number; width: number; height: number; rotation: number;
  visible: boolean; opacity: number; blendMode: string;
  fills: Paint[]; stroke?: Stroke; radius: [number, number, number, number];
  effects: Effect[]; clip: boolean; meta: NodeMeta;
}
export interface FrameNode extends NodeBase { type: 'frame'; children: Node[] }
export interface TextRun {
  start: number; end: number; fontFamily: string; fontWeight: number; italic: boolean; fontSize: number;
  lineHeight: number | null; letterSpacing: number; color: RGBA;
  decoration: 'none' | 'underline' | 'strikethrough'; textCase: 'original' | 'upper' | 'lower' | 'title';
}
export interface TextNode extends NodeBase {
  type: 'text'; characters: string; runs: TextRun[];
  align: 'left' | 'center' | 'right' | 'justified'; verticalAlign: 'top' | 'center' | 'bottom';
}
export interface VectorNode extends NodeBase { type: 'vector'; assetId: string }
export type Node = FrameNode | TextNode | VectorNode;

export interface SourceInfo {
  url: string; title: string; capturedAt: string; viewport: { width: number; height: number };
  devicePixelRatio: number; userAgent: string; fullPageHeight: number;
}
export interface H2FDocument {
  version: typeof SCHEMA_VERSION; source: SourceInfo; root: FrameNode;
  assets: Record<string, Asset>; warnings: string[];
}

export type ValidationResult = { ok: true; document: H2FDocument } | { ok: false; errors: string[] };

const MAX_ERRORS = 50;
const NODE_TYPES = new Set(['frame', 'text', 'vector']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function validateDocument(input: unknown): ValidationResult {
  const errors: string[] = [];
  const err = (m: string) => { if (errors.length < MAX_ERRORS) errors.push(m); };
  if (!isObject(input)) return { ok: false, errors: ['document must be an object'] };
  if (input.version !== SCHEMA_VERSION) err(`unsupported version ${String(input.version)}, expected ${SCHEMA_VERSION}`);
  if (!isObject(input.source) || typeof input.source.url !== 'string' || typeof input.source.title !== 'string') err('source.url and source.title must be strings');
  if (!isObject(input.assets)) err('assets must be an object');
  if (!Array.isArray(input.warnings)) err('warnings must be an array');
  const assets = isObject(input.assets) ? input.assets : {};
  // I9: a corrupt/truncated capture file could previously validate successfully with a
  // malformed asset entry (e.g. missing `data`), and only crash later — as an unhandled
  // rejection wedging the plugin UI — when something tried to actually use it (e.g.
  // `asset.data.length` in the UI's byte-size estimate, or base64ToBytes decoding `undefined`).
  // Checking each asset's own shape here means that failure surfaces as a normal, readable
  // validation error instead.
  for (const [id, asset] of Object.entries(assets)) validateAsset(id, asset, err);
  if (!isObject(input.root) || input.root.type !== 'frame') err('root must be a frame node');
  else validateNode(input.root, 'root', assets, err);
  return errors.length ? { ok: false, errors } : { ok: true, document: input as unknown as H2FDocument };
}

function validateAsset(id: string, asset: unknown, err: (m: string) => void): void {
  if (!isObject(asset)) { err(`assets.${id}: must be an object`); return; }
  if (asset.kind === 'image') {
    if (typeof asset.mime !== 'string') err(`assets.${id}: mime must be a string`);
    if (typeof asset.data !== 'string') err(`assets.${id}: data must be a string`);
    if (typeof asset.width !== 'number' || typeof asset.height !== 'number') err(`assets.${id}: width and height must be numbers`);
  } else if (asset.kind === 'svg') {
    if (typeof asset.svg !== 'string') err(`assets.${id}: svg must be a string`);
    if (typeof asset.width !== 'number' || typeof asset.height !== 'number') err(`assets.${id}: width and height must be numbers`);
  } else {
    err(`assets.${id}: unknown asset kind ${String(asset.kind)}`);
  }
}

function validateNode(node: unknown, path: string, assets: Record<string, unknown>, err: (m: string) => void): void {
  if (!isObject(node)) { err(`${path}: node must be an object`); return; }
  if (typeof node.type !== 'string' || !NODE_TYPES.has(node.type)) { err(`${path}: unknown node type ${String(node.type)}`); return; }
  for (const key of ['x', 'y', 'width', 'height', 'rotation', 'opacity'] as const) {
    if (typeof node[key] !== 'number' || Number.isNaN(node[key])) err(`${path}: ${key} must be a number`);
  }
  if (typeof node.id !== 'string' || typeof node.name !== 'string') err(`${path}: id and name must be strings`);
  if (!Array.isArray(node.fills)) err(`${path}: fills must be an array`);
  else for (const [i, paint] of node.fills.entries()) {
    if (isObject(paint) && paint.type === 'image' && !(typeof paint.assetId === 'string' && paint.assetId in assets)) err(`${path}: fills[${i}] references missing asset "${String(paint.assetId)}"`);
  }
  if (!Array.isArray(node.radius) || node.radius.length !== 4) err(`${path}: radius must have 4 entries`);
  if (node.type === 'frame') {
    if (!Array.isArray(node.children)) err(`${path}: children must be an array`);
    else node.children.forEach((c, i) => validateNode(c, `${path}.children[${i}]`, assets, err));
  } else if (node.type === 'text') {
    const chars = typeof node.characters === 'string' ? node.characters : null;
    if (chars === null) err(`${path}: characters must be a string`);
    if (!Array.isArray(node.runs)) err(`${path}: runs must be an array`);
    else if (chars !== null) {
      let cursor = 0;
      for (const [i, r] of node.runs.entries()) {
        if (!isObject(r) || r.start !== cursor || typeof r.end !== 'number' || r.end <= r.start) { err(`${path}: runs[${i}] must start at ${cursor} and end after it`); cursor = -1; break; }
        cursor = r.end;
      }
      if (cursor !== -1 && cursor !== chars.length) err(`${path}: runs cover ${cursor} of ${chars.length} characters`);
    }
  } else if (node.type === 'vector') {
    if (!(typeof node.assetId === 'string' && node.assetId in assets)) err(`${path}: vector references missing asset "${String(node.assetId)}"`);
  }
}

export function walkNodes(node: Node, visit: (n: Node, depth: number) => void, depth = 0): void {
  visit(node, depth);
  if (node.type === 'frame') for (const child of node.children) walkNodes(child, visit, depth + 1);
}

export function countNodes(node: Node): number {
  let n = 0;
  walkNodes(node, () => { n++; });
  return n;
}
