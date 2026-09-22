import { vi } from 'vitest';

export interface MockNode {
  id: string; type: string; name: string; x: number; y: number; width: number; height: number; rotation: number;
  visible: boolean; opacity: number; blendMode: string; fills: unknown[]; strokes: unknown[]; effects: unknown[];
  clipsContent: boolean; relativeTransform: number[][]; children: MockNode[]; parent: MockNode | null;
  strokeAlign?: string; strokeTopWeight?: number; strokeRightWeight?: number; strokeBottomWeight?: number; strokeLeftWeight?: number; dashPattern?: number[];
  topLeftRadius?: number; topRightRadius?: number; bottomRightRadius?: number; bottomLeftRadius?: number;
  characters?: string; fontName?: unknown; textAutoResize?: string; textAlignHorizontal?: string; textAlignVertical?: string; ranges: { method: string; start: number; end: number; value: unknown }[];
  resize(w: number, h: number): void; rescale(s: number): void; appendChild(n: MockNode): void; remove(): void; setPluginData(k: string, v: string): void;
  [key: string]: unknown;
}

export interface MockFigma {
  created: MockNode[]; images: Uint8Array[]; loadedFonts: { family: string; style: string }[]; posted: unknown[]; pages: MockNode[]; currentPage: MockNode;
  svgFailsFor: Set<string>;
}

let counter = 0;
function node(type: string, figma: MockFigma): MockNode {
  const n: MockNode = {
    id: `${type}:${++counter}`, type, name: type, x: 0, y: 0, width: 100, height: 100, rotation: 0, visible: true, opacity: 1, blendMode: 'PASS_THROUGH',
    fills: [], strokes: [], effects: [], clipsContent: false, relativeTransform: [[1, 0, 0], [0, 1, 0]], children: [], parent: null, ranges: [],
    resize(w, h) { this.width = w; this.height = h; },
    rescale(s) { this.width *= s; this.height *= s; },
    appendChild(c) { c.parent = this; this.children.push(c); },
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((c) => c !== this); },
    setPluginData() {},
  };
  for (const m of ['setRangeFontName', 'setRangeFontSize', 'setRangeLineHeight', 'setRangeLetterSpacing', 'setRangeFills', 'setRangeTextDecoration', 'setRangeTextCase']) {
    n[m] = (start: number, end: number, value: unknown) => { n.ranges.push({ method: m, start, end, value }); };
  }
  Object.defineProperty(n, 'relativeTransform', {
    get() { return this._rt ?? [[1, 0, this.x], [0, 1, this.y]]; },
    set(v: number[][]) { this._rt = v; this.x = v[0][2]; this.y = v[1][2]; },
  });
  figma.created.push(n);
  return n;
}

export function installFigmaMock(): MockFigma {
  const figma = { created: [], images: [], loadedFonts: [], posted: [], pages: [], svgFailsFor: new Set<string>() } as unknown as MockFigma;
  const page = node('PAGE', figma);
  figma.pages.push(page);
  figma.currentPage = page;
  const api = {
    createFrame: () => node('FRAME', figma),
    createText: () => node('TEXT', figma),
    createPage: () => { const p = node('PAGE', figma); figma.pages.push(p); return p; },
    setCurrentPageAsync: async (p: MockNode) => { figma.currentPage = p; },
    createImage: (bytes: Uint8Array) => { figma.images.push(bytes); return { hash: `img${figma.images.length}` }; },
    createNodeFromSvg: (svg: string) => { if (figma.svgFailsFor.has(svg)) throw new Error('bad svg'); const f = node('FRAME', figma); f.width = 10; f.height = 10; return f; },
    loadFontAsync: vi.fn(async (f: { family: string; style: string }) => { if (f.family === 'Broken') throw new Error('font missing'); figma.loadedFonts.push(f); }),
    listAvailableFontsAsync: async () => [
      ...['Regular', 'Medium', 'Semi Bold', 'Bold', 'Italic'].map((style) => ({ fontName: { family: 'Inter', style } })),
      ...['Regular', 'Bold', 'Italic'].map((style) => ({ fontName: { family: 'Playfair Display', style } })),
      ...['Light', 'Regular', 'Black'].map((style) => ({ fontName: { family: 'Roboto', style } })),
      { fontName: { family: 'Broken', style: 'Regular' } },
    ],
    ui: { postMessage: (m: unknown) => figma.posted.push(m), onmessage: undefined as unknown, show: () => {}, resize: () => {} },
    viewport: { scrollAndZoomIntoView: () => {} },
    showUI: () => {},
    closePlugin: () => {},
    notify: () => {},
    get currentPage() { return figma.currentPage; },
  };
  (globalThis as unknown as { figma: unknown }).figma = api;
  (globalThis as unknown as { __html__: string }).__html__ = '<html></html>';
  return figma;
}
