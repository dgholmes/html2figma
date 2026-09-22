import type { FrameNode as H2FFrame, Node as H2FNode, NodeBase, TextNode as H2FText, VectorNode as H2FVector } from '@h2f/schema';
import type { FontResolver } from './fonts';
import { toFigmaBlendMode, toFigmaColor, toFigmaEffects, toFigmaPaint } from './paints';

export interface BuilderDeps {
  images: Map<string, string>;
  svgs: Map<string, { svg: string; fallback?: Uint8Array }>;
  fonts: FontResolver;
  warnings: string[];
  onProgress: (done: number) => void;
}

const ALIGN: Record<H2FText['align'], 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFIED'> = { left: 'LEFT', center: 'CENTER', right: 'RIGHT', justified: 'JUSTIFIED' };
const VALIGN: Record<H2FText['verticalAlign'], 'TOP' | 'CENTER' | 'BOTTOM'> = { top: 'TOP', center: 'CENTER', bottom: 'BOTTOM' };
const TEXT_CASE: Record<H2FText['runs'][number]['textCase'], TextCase> = { original: 'ORIGINAL', upper: 'UPPER', lower: 'LOWER', title: 'TITLE' };
const yieldToUi = () => new Promise<void>((r) => setTimeout(r, 0));

export class Builder {
  private count = 0;
  constructor(private readonly deps: BuilderDeps) {}
  get done(): number { return this.count; }

  async build(node: H2FNode, parent: ChildrenMixin & BaseNode): Promise<SceneNode> {
    let created: SceneNode;
    try {
      created = await this.create(node, parent);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.warnings.push(`Failed to build "${node.name}": ${message}`);
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

  private applyCommon(fig: SceneNode & BlendMixin & SceneNodeMixin, node: NodeBase): void {
    fig.name = node.name;
    fig.visible = node.visible;
    fig.opacity = Math.min(1, Math.max(0, node.opacity));
    fig.blendMode = toFigmaBlendMode(node.blendMode);
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
    this.place(f, node);
    this.applyCommon(f, node);
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
    return f;
  }

  private async createText(node: H2FText, parent: ChildrenMixin & BaseNode): Promise<TextNode> {
    const t = figma.createText();
    parent.appendChild(t);
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
    return t;
  }

  private async createVector(node: H2FVector, parent: ChildrenMixin & BaseNode): Promise<SceneNode> {
    const entry = this.deps.svgs.get(node.assetId);
    if (!entry) throw new Error(`missing svg asset ${node.assetId}`);
    let fig: FrameNode;
    try {
      fig = figma.createNodeFromSvg(entry.svg);
      parent.appendChild(fig);
      const sx = node.width / (fig.width || 1);
      const sy = node.height / (fig.height || 1);
      const s = Math.min(sx, sy);
      if (Number.isFinite(s) && s > 0 && Math.abs(s - 1) > 1e-6) fig.rescale(s);
    } catch (e) {
      if (!entry.fallback) throw e;
      this.deps.warnings.push(`SVG "${node.name}" could not be parsed by Figma; using a rasterized copy.`);
      fig = figma.createFrame();
      parent.appendChild(fig);
      fig.fills = [{ type: 'IMAGE', imageHash: figma.createImage(entry.fallback).hash, scaleMode: 'FIT' }];
    }
    this.place(fig, node);
    this.applyCommon(fig, node);
    fig.clipsContent = false;
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
