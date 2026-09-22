import type { FrameNode as H2FFrame, Node as H2FNode, NodeBase, TextNode as H2FText, VectorNode as H2FVector } from '@h2f/schema';
import type { FontResolver } from './fonts';
import { toFigmaBlendMode, toFigmaColor, toFigmaEffects, toFigmaPaint } from './paints';

export interface BuilderDeps {
  images: Map<string, string>;
  svgs: Map<string, { svg: string; fallback?: Uint8Array }>;
  fonts: FontResolver;
  warnings: string[];
  onProgress: (done: number) => void;
  // I8 follow-up: a proactive `fallback` is only ever supplied for svg assets an ImagePaint
  // references (see ui.ts's imagePaintAssetIds) — most svgs parse fine and were never rasterized
  // ahead of time. When one of those DOES fail to parse in createVector below and has no
  // proactive fallback, this lets it ask the UI (the only side with DOM/canvas access) to
  // rasterize that one svg on demand, so the failure still degrades to a raster fill instead of
  // a red "import failed" placeholder — without paying the upload cost for every svg up front.
  // Optional so tests/callers that don't need the reactive path can omit it.
  requestFallback?: (id: string, svg: string, width: number, height: number) => Promise<Uint8Array | undefined>;
}

const ALIGN: Record<H2FText['align'], 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> = { left: 'LEFT', center: 'CENTER', right: 'RIGHT', justified: 'JUSTIFIED' };
const VALIGN: Record<H2FText['verticalAlign'], 'TOP' | 'CENTER' | 'BOTTOM'> = { top: 'TOP', center: 'CENTER', bottom: 'BOTTOM' };
const TEXT_CASE: Record<H2FText['runs'][number]['textCase'], TextCase> = { original: 'ORIGINAL', upper: 'UPPER', lower: 'LOWER', title: 'TITLE' };
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

export class Builder {
  private count = 0;
  // I10: the node most recently appendChild'd to its parent by create() but not yet fully
  // configured. createFrame/createText/createVector all append immediately (so children can be
  // built into the right parent) and only fill in geometry/fills/etc afterwards, so a throw
  // partway through leaves a stray, partially-built node in the document alongside the red-dashed
  // placeholder build()'s catch below creates. Tracking it here lets that catch remove the orphan
  // first. Safe as a single shared field because the Builder never runs two create() calls
  // concurrently — createFrame's children loop awaits each child's build() in turn — so by the
  // time any create() call can throw, this always still points at *its own* just-appended node.
  private pendingNode: SceneNode | null = null;
  constructor(private readonly deps: BuilderDeps) {}
  get done(): number { return this.count; }

  async build(node: H2FNode, parent: ChildrenMixin & BaseNode): Promise<SceneNode> {
    let created: SceneNode;
    try {
      created = await this.create(node, parent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.warnings.push(`Failed to build "${node.name}": ${message}`);
      if (this.pendingNode) {
        try { this.pendingNode.remove(); } catch { /* already gone */ }
        this.pendingNode = null;
      }
      created = this.placeholder(node, parent, message);
    }
    this.count++;
    if (this.count % 50 === 0) { this.deps.onProgress(this.count); await yieldToUi(); }
    return created;
  }

  private async create(node: H2FNode, parent: ChildrenMixin & BaseNode): Promise<SceneNode> {
    switch (node.type) {
      case 'frame': return this.createFrame(node, parent);
      case 'text': return this.createText(node, parent);
      case 'vector': return this.createVector(node, parent);
    }
  }

  private place(fig: SceneNode & LayoutMixin, node: NodeBase): void {
    fig.resize(Math.max(0.01, node.width), Math.max(0.01, node.height));
    if (node.rotation) {
      const r = (node.rotation * Math.PI) / 180;
      fig.relativeTransform = [[Math.cos(r), Math.sin(r), node.x], [-Math.sin(r), Math.cos(r), node.y]];
    } else {
      fig.x = node.x;
      fig.y = node.y;
    }
  }

  private applyCommon(fig: SceneNode & BlendMixin & SceneNodeMixin, node: NodeBase, isContainer = false): void {
    fig.name = node.name;
    fig.visible = node.visible;
    fig.opacity = Math.min(1, Math.max(0, node.opacity));
    // I6: PASS_THROUGH is only offered for container nodes (frames), and only when this node
    // doesn't itself isolate — opacity below 1 or a blur filter both create a CSS stacking
    // context, matching the isolation an explicit `isolation: isolate` would force. (CSS
    // `isolation` itself isn't captured by the schema; this is the closest approximation without
    // widening it — see the code review report for that gap.)
    const isolates = node.opacity < 1 || node.effects.some((e) => e.type === 'layer-blur' || e.type === 'background-blur');
    fig.blendMode = toFigmaBlendMode(node.blendMode, isContainer && !isolates);
    if (node.effects.length) {
      try { fig.effects = toFigmaEffects(node.effects); }
      catch (e) { this.deps.warnings.push(`Effects skipped on "${node.name}": ${e instanceof Error ? e.message : String(e)}`); }
    }
  }

  private fillsFor(node: NodeBase): Paint[] {
    return node.fills.map((p) => toFigmaPaint(p, this.deps.images)).filter((p): p is Paint => p !== null);
  }

  private async createFrame(node: H2FFrame, parent: ChildrenMixin & BaseNode): Promise<FrameNode> {
    const f = figma.createFrame();
    parent.appendChild(f);
    this.pendingNode = f;
    this.place(f, node);
    this.applyCommon(f, node, true);
    f.clipsContent = node.clip;
    f.fills = this.fillsFor(node);
    if (node.stroke) {
      const { color, opacity } = toFigmaColor(node.stroke.color);
      f.strokes = [{ type: 'SOLID', color, opacity }];
      f.strokeAlign = 'INSIDE';
      f.strokeTopWeight = node.stroke.weights.top;
      f.strokeRightWeight = node.stroke.weights.right;
      f.strokeBottomWeight = node.stroke.weights.bottom;
      f.strokeLeftWeight = node.stroke.weights.left;
      if (node.stroke.dash) f.dashPattern = node.stroke.dash;
    }
    [f.topLeftRadius, f.topRightRadius, f.bottomRightRadius, f.bottomLeftRadius] = node.radius;
    for (const child of node.children) await this.build(child, f);
    this.pendingNode = null;
    return f;
  }

  private async createText(node: H2FText, parent: ChildrenMixin & BaseNode): Promise<TextNode> {
    const t = figma.createText();
    parent.appendChild(t);
    this.pendingNode = t;
    const runs = node.runs.filter((r) => r.start < node.characters.length);
    const first = runs[0] ?? { fontFamily: 'Inter', fontWeight: 400, italic: false };
    t.fontName = await this.deps.fonts.fontFor(first);
    t.characters = node.characters;
    t.textAutoResize = 'NONE';
    this.place(t, node);
    this.applyCommon(t, node);
    t.textAlignHorizontal = ALIGN[node.align];
    t.textAlignVertical = VALIGN[node.verticalAlign];
    for (const run of runs) {
      const end = Math.min(run.end, node.characters.length);
      if (end <= run.start) continue;
      const font = await this.deps.fonts.fontFor(run);
      t.setRangeFontName(run.start, end, font);
      t.setRangeFontSize(run.start, end, Math.max(1, run.fontSize));
      t.setRangeLineHeight(run.start, end, run.lineHeight ? { unit: 'PIXELS', value: run.lineHeight } : { unit: 'AUTO' });
      t.setRangeLetterSpacing(run.start, end, { unit: 'PIXELS', value: run.letterSpacing });
      const { color, opacity } = toFigmaColor(run.color);
      t.setRangeFills(run.start, end, [{ type: 'SOLID', color, opacity }]);
      t.setRangeTextDecoration(run.start, end, run.decoration === 'underline' ? 'UNDERLINE' : run.decoration === 'strikethrough' ? 'STRIKETHROUGH' : 'NONE');
      t.setRangeTextCase(run.start, end, TEXT_CASE[run.textCase]);
    }
    this.pendingNode = null;
    return t;
  }

  private async createVector(node: H2FVector, parent: ChildrenMixin & BaseNode): Promise<SceneNode> {
    const entry = this.deps.svgs.get(node.assetId);
    if (!entry) throw new Error(`missing svg asset ${node.assetId}`);
    let fig: FrameNode;
    try {
      fig = figma.createNodeFromSvg(entry.svg);
      parent.appendChild(fig);
      this.pendingNode = fig;
      const sx = node.width / (fig.width || 1);
      const sy = node.height / (fig.height || 1);
      const s = Math.min(sx, sy);
      if (Number.isFinite(s) && s > 0 && Math.abs(s - 1) > 1e-6) fig.rescale(s);
    } catch (e) {
      // I8 follow-up: resolve a raster fallback for this failing svg, preferring (in order) an
      // already-registered image (this asset already got a hash — from a proactive ImagePaint
      // registration, or from a previous vector node that hit this same catch block for the same
      // repeated asset id), then a proactively-supplied fallback, then a reactive UI round trip.
      // This means a repeated icon that fails to parse only ever gets rasterized and uploaded
      // once, however many times it's used.
      let hash = this.deps.images.get(node.assetId);
      if (!hash) {
        const fallback = entry.fallback ?? (this.deps.requestFallback ? await this.deps.requestFallback(node.assetId, entry.svg, node.width, node.height) : undefined);
        if (!fallback) throw e;
        hash = figma.createImage(fallback).hash;
        this.deps.images.set(node.assetId, hash);
      }
      this.deps.warnings.push(`SVG "${node.name}" could not be parsed by Figma; using a rasterized copy.`);
      fig = figma.createFrame();
      parent.appendChild(fig);
      this.pendingNode = fig;
      fig.fills = [{ type: 'IMAGE', imageHash: hash, scaleMode: 'FIT' }];
    }
    this.place(fig, node);
    // Both branches above produce a real FrameNode (createNodeFromSvg wraps the vector shapes in
    // one; the rasterized fallback is a plain frame), so PASS_THROUGH is offered here too.
    this.applyCommon(fig, node, true);
    fig.clipsContent = false;
    this.pendingNode = null;
    return fig;
  }

  private placeholder(node: H2FNode, parent: ChildrenMixin & BaseNode, message: string): FrameNode {
    const f = figma.createFrame();
    parent.appendChild(f);
    f.name = `${node.name} (import failed: ${message.slice(0, 60)})`;
    f.resize(Math.max(1, node.width), Math.max(1, node.height));
    f.x = node.x;
    f.y = node.y;
    f.fills = [];
    f.strokes = [{ type: 'SOLID', color: { r: 1, g: 0, b: 0 }, opacity: 1 }];
    f.strokeWeight = 1;
    f.dashPattern = [4, 4];
    return f;
  }
}
