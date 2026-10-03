import type { FrameNode, Node, NodeMeta, Paint, SolidPaint, Stroke, TextNode, VectorNode } from '@h2f/schema';
import { isVisible, type ColorFn } from './color';
import { clampRadii, parseCornerRadius, parseLength } from './css';
import { collectEffects, parseShadowList } from './effects';
import { absoluteRect, computeGeometry, rectFromClientRects, type Geometry, type Rect } from './geometry';
import { assetFromUrl, canvasAsset, inlineSvgAsset, videoAsset, type LoadedAsset, type MediaContext } from './media';
import { nameForElement, nameForText } from './naming';
import { backgroundPlacement, cropTransform, extractUrl, parseBackgroundLayers, parseGradient, scaleModeForObjectFit } from './paints';
import { applyTextTransform, assembleText, mapTextAlign, runStyleFromComputed, type RunStyle, type TextFragment } from './text';

export interface WalkContext extends MediaContext {
  win: Window; color: ColorFn; captureVideoFrames: boolean;
  isFontAvailable: (family: string) => boolean; nextId: () => string; tick: () => Promise<void>;
  // Shared counter for estimated-geometry pseudo-element warnings (see pseudoNode): incremented
  // per element instead of pushing one warning each, so a page with hundreds of decorative
  // ::before/::after rules doesn't flood ctx.warnings and bury warnings that explain real
  // problems. The caller (capturePage) turns the final count into one aggregated warning.
  pseudoEstimates: { count: number };
}

export const PLACEHOLDER_FILL: SolidPaint = { type: 'solid', color: { r: 0.2, g: 0.2, b: 0.2, a: 1 } };

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'HEAD', 'TITLE', 'NOSCRIPT', 'TEMPLATE', 'OPTION', 'BASE', 'SOURCE', 'TRACK']);
const LEAF_MEDIA = new Set(['IMG', 'SVG', 'VIDEO', 'CANVAS', 'PICTURE', 'SOURCE']);
// Replaced elements are never hoisted, even when display is inline.
const REPLACED = new Set([...LEAF_MEDIA, 'IFRAME', 'EMBED', 'OBJECT']);
const TEXT_INPUT_TYPES = new Set(['text', 'email', 'search', 'url', 'tel', 'password', 'number', 'date', 'time', 'datetime-local', 'month', 'week', '']);

// Computed values can be '' in some environments (jsdom); treat empty like the initial value.
const isSet = (v: string | undefined) => !!v && v !== 'none';
const clips = (v: string | undefined) => !!v && v !== 'visible';

export function hasVisualBox(cs: CSSStyleDeclaration): boolean {
  const bg = cs.backgroundColor;
  const hasBg = !!bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
  const border = [cs.borderTopWidth, cs.borderRightWidth, cs.borderBottomWidth, cs.borderLeftWidth].some((w) => parseLength(w) > 0);
  return hasBg || isSet(cs.backgroundImage) || border || isSet(cs.boxShadow) || isSet(cs.transform) || parseFloat(cs.opacity || '1') < 1
    || clips(cs.overflowX) || clips(cs.overflowY) || isSet(cs.filter) || (isSet(cs.outlineStyle) && parseLength(cs.outlineWidth) > 0);
}

function metaFor(el: Element, cs: CSSStyleDeclaration): NodeMeta {
  const meta: NodeMeta = { tag: el.tagName.toLowerCase(), classes: (el.getAttribute('class') ?? '').trim().split(/\s+/).filter(Boolean) };
  if (el.id) meta.id = el.id;
  if (cs.position === 'fixed' || cs.position === 'sticky') meta.position = cs.position;
  return meta;
}

function baseNode(ctx: WalkContext, el: Element, cs: CSSStyleDeclaration, geo: Geometry, name: string) {
  return {
    id: ctx.nextId(), name, x: geo.x, y: geo.y, width: geo.width, height: geo.height, rotation: geo.rotation,
    visible: cs.visibility !== 'hidden', opacity: Math.min(1, Math.max(0, parseFloat(cs.opacity || '1'))), blendMode: cs.mixBlendMode || 'normal',
    fills: [] as Paint[], radius: radiusFor(cs, geo.width, geo.height), effects: collectEffects(cs, ctx.color),
    clip: clips(cs.overflowX) || clips(cs.overflowY), meta: metaFor(el, cs),
  };
}

function radiusFor(cs: CSSStyleDeclaration, w: number, h: number): [number, number, number, number] {
  return clampRadii([
    parseCornerRadius(cs.borderTopLeftRadius, w, h), parseCornerRadius(cs.borderTopRightRadius, w, h),
    parseCornerRadius(cs.borderBottomRightRadius, w, h), parseCornerRadius(cs.borderBottomLeftRadius, w, h),
  ], w, h);
}

function strokeFor(cs: CSSStyleDeclaration, color: ColorFn): Stroke | undefined {
  const side = (width: string, style: string) => (style === 'none' || style === 'hidden' ? 0 : parseLength(width));
  const weights = {
    top: side(cs.borderTopWidth, cs.borderTopStyle), right: side(cs.borderRightWidth, cs.borderRightStyle),
    bottom: side(cs.borderBottomWidth, cs.borderBottomStyle), left: side(cs.borderLeftWidth, cs.borderLeftStyle),
  };
  if (!Object.values(weights).some((w) => w > 0)) return undefined;
  const firstSide = (['Top', 'Right', 'Bottom', 'Left'] as const).find((s) => weights[s.toLowerCase() as keyof typeof weights] > 0)!;
  const c = color(cs[`border${firstSide}Color` as 'borderTopColor']);
  if (!isVisible(c)) return undefined;
  const style = cs[`border${firstSide}Style` as 'borderTopStyle'];
  const w = Math.max(...Object.values(weights));
  const dash = style === 'dashed' ? [w * 3, w * 2] : style === 'dotted' ? [w, w] : undefined;
  return { color: c, weights, align: 'inside', dash };
}

async function backgroundFills(cs: CSSStyleDeclaration, geo: Geometry, ctx: WalkContext): Promise<Paint[]> {
  const fills: Paint[] = [];
  const bg = ctx.color(cs.backgroundColor);
  if (isVisible(bg)) fills.push({ type: 'solid', color: bg });
  for (const layer of parseBackgroundLayers(cs).reverse()) {
    const url = extractUrl(layer.image);
    if (url) {
      const asset = await assetFromUrl(url, ctx, 'background', undefined, { width: geo.width, height: geo.height });
      if (!asset) continue;
      fills.push(imagePaintForBackground(layer, asset, geo));
    } else {
      const g = parseGradient(layer.image, geo.width, geo.height, ctx.color);
      if (g) fills.push(g);
    }
  }
  return fills;
}

function imagePaintForBackground(layer: ReturnType<typeof parseBackgroundLayers>[number], asset: LoadedAsset, geo: Geometry): Paint {
  const repeat = /\brepeat\b|repeat-x|repeat-y|space|round/.test(layer.repeat) && !/^no-repeat( no-repeat)?$/.test(layer.repeat);
  // Placement is defined against the source's intrinsic size, never the stored resolution.
  const placement = backgroundPlacement(layer, geo.width, geo.height, asset.naturalWidth, asset.naturalHeight);
  if (repeat) return { type: 'image', assetId: asset.id, scaleMode: 'tile', scale: asset.width ? placement.width / asset.width : 1 };
  if (layer.size === 'cover') return { type: 'image', assetId: asset.id, scaleMode: 'fill' };
  if (layer.size === 'contain') return { type: 'image', assetId: asset.id, scaleMode: 'fit' };
  return { type: 'image', assetId: asset.id, scaleMode: 'crop', transform: cropTransform(placement, geo.width, geo.height) };
}

function imagePaintForObjectFit(asset: LoadedAsset, cs: CSSStyleDeclaration, geo: Geometry): Paint {
  const mode = scaleModeForObjectFit(cs.objectFit || 'fill');
  if (mode !== 'crop') return { type: 'image', assetId: asset.id, scaleMode: mode };
  // object-fit: none paints the image at its intrinsic size, centred — again independent of what we stored.
  const placement = { x: (geo.width - asset.naturalWidth) / 2, y: (geo.height - asset.naturalHeight) / 2, width: asset.naturalWidth || geo.width, height: asset.naturalHeight || geo.height };
  return { type: 'image', assetId: asset.id, scaleMode: 'crop', transform: cropTransform(placement, geo.width, geo.height) };
}

function isLeafLike(el: Element): boolean {
  // I5: rotation is only safe for an element that produces no child nodes of its own. `frameFor`
  // places children using `geo.abs` — the axis-aligned bounding box — as their parent rect
  // regardless of rotation, which is only correct when there ARE no children to place. The prior
  // check (`el.children.every(isMedia)`) was true *vacuously* for any element with zero element
  // children, which wrongly included ordinary text-bearing elements like `<h2>Title</h2>`: their
  // text child then got measured against the rotated bbox instead of the unrotated local frame,
  // producing an offset, oversized heading. Requiring both no element children AND no
  // non-whitespace text keeps rotation for genuinely empty/replaced leaves (the common case:
  // decorative divs, icons) while falling back to the correct unrotated placement for anything
  // that actually has content to lay out inside it.
  if (el.children.length > 0) return false;
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3 && (child.textContent ?? '').trim()) return false;
  }
  return true;
}

export async function walkElement(el: Element, parentAbs: Rect, ctx: WalkContext): Promise<Node[]> {
  if (SKIP_TAGS.has(el.tagName)) return [];
  const cs = ctx.win.getComputedStyle(el);
  if (cs.display === 'none') return [];
  try {
    // TS7's bundled DOM lib doesn't merge global constructors (SVGSVGElement, HTMLElement, ...)
    // onto the `Window` interface, so `ctx.win.SVGSVGElement` doesn't typecheck against `Window`
    // even though it resolves fine at runtime. Cast locally rather than widen WalkContext.win.
    const svgCtor = (ctx.win as unknown as { SVGSVGElement: typeof SVGSVGElement }).SVGSVGElement;
    if (el instanceof svgCtor || (el.tagName.toUpperCase() === 'SVG' && el.namespaceURI === 'http://www.w3.org/2000/svg')) {
      const geo = computeGeometry(el, cs, parentAbs, ctx.win, true);
      if (geo.width <= 0 || geo.height <= 0) return [];
      const assetId = inlineSvgAsset(el as SVGSVGElement, ctx, ctx.win, geo.width, geo.height);
      const node: VectorNode = { ...baseNode(ctx, el, cs, geo, nameForElement(el)), type: 'vector', assetId };
      return [node];
    }
    if ((cs.display === 'inline' || cs.display === 'contents') && !hasVisualBox(cs) && !REPLACED.has(el.tagName) && !isFormControl(el)) {
      return walkChildren(el, parentAbs, ctx);
    }
    return [await frameFor(el, cs, parentAbs, ctx)];
  } catch (e) {
    ctx.warnings.push(`Element <${el.tagName.toLowerCase()}> failed: ${e instanceof Error ? e.message : String(e)}`);
    try {
      const abs = absoluteRect(el, ctx.win);
      const geo: Geometry = { x: abs.x - parentAbs.x, y: abs.y - parentAbs.y, width: abs.width, height: abs.height, rotation: 0, abs };
      return [{ ...baseNode(ctx, el, cs, geo, nameForElement(el, '(capture failed)')), type: 'frame', fills: [PLACEHOLDER_FILL], effects: [], children: [] }];
    } catch (fallbackError) {
      // The fallback itself reads layout (absoluteRect) and derives node metadata (baseNode) from
      // `cs`/`el`, either of which could theoretically throw too (e.g. a hostile
      // getBoundingClientRect). Never let that escape walkElement: an uncaught throw here would
      // propagate through walkChildren's `await` and abort the entire capture, which is exactly
      // the "an element is silently dropped" outcome this whole fallback path exists to prevent.
      // Fall back further to a hand-built, zero-size placeholder that cannot fail the same way.
      ctx.warnings.push(`Element <${el.tagName.toLowerCase()}> placeholder fallback also failed: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`);
      const placeholder: FrameNode = {
        id: ctx.nextId(), name: `${el.tagName.toLowerCase()} (capture failed)`, x: 0, y: 0, width: 0, height: 0, rotation: 0,
        visible: true, opacity: 1, blendMode: 'normal', fills: [PLACEHOLDER_FILL], radius: [0, 0, 0, 0], effects: [], clip: false,
        meta: { tag: el.tagName.toLowerCase(), classes: [] }, type: 'frame', children: [],
      };
      return [placeholder];
    }
  }
}

function isFormControl(el: Element): boolean {
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.tagName === 'BUTTON';
}

async function frameFor(el: Element, cs: CSSStyleDeclaration, parentAbs: Rect, ctx: WalkContext): Promise<Node> {
  const geo = computeGeometry(el, cs, parentAbs, ctx.win, isLeafLike(el));
  const tag = el.tagName;
  let suffix = '';
  const fills = await backgroundFills(cs, geo, ctx);
  let vector: string | null = null;

  if (tag === 'IMG') {
    const img = el as HTMLImageElement;
    const asset = await assetFromUrl(img.currentSrc || img.src, ctx, 'img', img, { width: geo.width, height: geo.height });
    if (asset?.kind === 'svg') vector = asset.id;
    else if (asset) fills.push(imagePaintForObjectFit(asset, cs, geo));
    else { fills.push(PLACEHOLDER_FILL); suffix = '(image not captured)'; }
  } else if (tag === 'VIDEO') {
    const result = await videoAsset(el as HTMLVideoElement, ctx, ctx.captureVideoFrames, { width: geo.width, height: geo.height });
    if (result.id) fills.push(imagePaintForObjectFit(result as LoadedAsset, cs, geo));
    else fills.push(PLACEHOLDER_FILL);
    suffix = result.label;
  } else if (tag === 'CANVAS') {
    const asset = canvasAsset(el as HTMLCanvasElement, ctx);
    if (asset) fills.push({ type: 'image', assetId: asset.id, scaleMode: 'fill' });
    else { fills.push(PLACEHOLDER_FILL); suffix = '(canvas not captured)'; }
  } else if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT') {
    fills.push(PLACEHOLDER_FILL);
    suffix = '(not captured)';
  }
  if (cs.position === 'fixed') suffix = suffix ? `${suffix} (fixed)` : '(fixed)';

  const base = baseNode(ctx, el, cs, geo, nameForElement(el, suffix));
  if (vector) return { ...base, type: 'vector', assetId: vector, fills };
  const frame: FrameNode = { ...base, type: 'frame', fills, stroke: strokeFor(cs, ctx.color), children: [] };
  if (tag === 'IFRAME' || tag === 'EMBED' || tag === 'OBJECT' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'IMG') return frame;

  const childAbs = geo.abs;
  const before = pseudoNode(el, cs, '::before', childAbs, ctx);
  if (before) frame.children.push(before);
  frame.children.push(...await walkChildren(el, childAbs, ctx));
  const synthetic = formControlText(el, cs, geo, ctx);
  if (synthetic) frame.children.push(synthetic);
  const after = pseudoNode(el, cs, '::after', childAbs, ctx);
  if (after) frame.children.push(after);
  return frame;
}

export async function walkChildren(el: Element, parentAbs: Rect, ctx: WalkContext): Promise<Node[]> {
  const out: Node[] = [];
  let fragments: TextFragment[] = [];
  const blockCs = ctx.win.getComputedStyle(el);
  // `visibility` is inherited, so a fragment's own parent commonly reports 'hidden' simply
  // because this whole block is hidden — that's not information loss, since the merged text
  // node below carries the same `visible: false`. Only a *local* override back to visible/hidden
  // partway through an otherwise-opposite block would be lost by merging; see fragmentForText.
  const blockHidden = blockCs.visibility === 'hidden';
  const flush = () => {
    const t = textNodeFromFragments(fragments, parentAbs, blockCs, ctx);
    if (t) out.push(t);
    fragments = [];
  };
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) {
      const frag = fragmentForText(child as Text, ctx, blockHidden);
      if (frag) fragments.push(frag);
      continue;
    }
    if (child.nodeType !== 1) continue;
    const ce = child as Element;
    if (SKIP_TAGS.has(ce.tagName)) continue;
    if (ce.tagName === 'BR') { fragments.push({ text: '', isBreak: true, style: runStyleFromComputed(blockCs, ctx.color, ctx.isFontAvailable), rect: null, whiteSpace: 'normal' }); continue; }
    const ccs = ctx.win.getComputedStyle(ce);
    if (ccs.display === 'none') continue;
    if ((ccs.display === 'inline' || ccs.display === 'contents') && !hasVisualBox(ccs) && !REPLACED.has(ce.tagName) && !isFormControl(ce) && onlyInlineContent(ce, ctx)) {
      fragments.push(...collectInlineFragments(ce, ctx, blockHidden));
      continue;
    }
    flush();
    out.push(...await walkElement(ce, parentAbs, ctx));
    await ctx.tick();
  }
  flush();
  return out;
}

function onlyInlineContent(el: Element, ctx: WalkContext): boolean {
  for (const child of Array.from(el.children)) {
    if (child.tagName === 'BR') continue;
    if (SKIP_TAGS.has(child.tagName) || REPLACED.has(child.tagName) || isFormControl(child)) return false;
    const cs = ctx.win.getComputedStyle(child);
    if (cs.display === 'none') continue;
    if (cs.display !== 'inline' && cs.display !== 'contents') return false;
    if (hasVisualBox(cs) || !onlyInlineContent(child, ctx)) return false;
  }
  return true;
}

function collectInlineFragments(el: Element, ctx: WalkContext, blockHidden: boolean): TextFragment[] {
  const out: TextFragment[] = [];
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === 3) { const f = fragmentForText(child as Text, ctx, blockHidden); if (f) out.push(f); }
    else if (child.nodeType === 1) {
      const ce = child as Element;
      if (ce.tagName === 'BR') out.push({ text: '', isBreak: true, style: runStyleFromComputed(ctx.win.getComputedStyle(el), ctx.color, ctx.isFontAvailable), rect: null, whiteSpace: 'normal' });
      else if (!SKIP_TAGS.has(ce.tagName) && ctx.win.getComputedStyle(ce).display !== 'none') out.push(...collectInlineFragments(ce, ctx, blockHidden));
    }
  }
  return out;
}

function fragmentForText(text: Text, ctx: WalkContext, blockHidden: boolean): TextFragment | null {
  const parent = text.parentElement;
  if (!parent) return null;
  const cs = ctx.win.getComputedStyle(parent);
  // `visibility` is inherited, so a hidden immediate parent is expected — and harmless — whenever
  // the enclosing block being flushed is itself hidden: textNodeFromFragments marks the merged
  // node `visible: false` and the text is preserved for later reveal. What we must still drop is a
  // *locally* hidden run (an explicit `visibility: hidden` override, or inheritance from a nearer
  // hidden ancestor than the block) inside an otherwise-visible block: a single merged text node
  // has no per-character visibility, so keeping it would render normally-hidden copy as if shown.
  if (cs.visibility === 'hidden' && !blockHidden) return null;
  const raw = text.data;
  if (!raw) return null;
  const range = ctx.doc.createRange();
  range.selectNodeContents(text);
  const rect = rectFromClientRects(range.getClientRects(), ctx.win);
  return { text: applyTextTransform(raw, cs.textTransform), style: runStyleFromComputed(cs, ctx.color, ctx.isFontAvailable), rect, whiteSpace: cs.whiteSpace || 'normal' };
}

function textNodeFromFragments(fragments: TextFragment[], parentAbs: Rect, blockCs: CSSStyleDeclaration, ctx: WalkContext): TextNode | null {
  if (!fragments.length) return null;
  const assembled = assembleText(fragments);
  if (!assembled || !assembled.rect) return null;
  const r = assembled.rect;
  return {
    id: ctx.nextId(), name: nameForText(assembled.characters), type: 'text',
    x: r.x - parentAbs.x, y: r.y - parentAbs.y, width: r.width + 1, height: r.height, rotation: 0,
    visible: blockCs.visibility !== 'hidden', opacity: 1, blendMode: 'normal', fills: [], radius: [0, 0, 0, 0],
    effects: parseShadowList(blockCs.textShadow, ctx.color, false), clip: false,
    meta: { tag: 'text', classes: [] }, characters: assembled.characters, runs: assembled.runs,
    align: mapTextAlign(blockCs.textAlign, blockCs.direction), verticalAlign: 'top',
  };
}

function formControlText(el: Element, cs: CSSStyleDeclaration, geo: Geometry, ctx: WalkContext): TextNode | null {
  let value = '';
  let placeholder = false;
  let vertical: TextNode['verticalAlign'] = 'center';
  if (el.tagName === 'INPUT') {
    const input = el as HTMLInputElement;
    if (!TEXT_INPUT_TYPES.has(input.type)) return null;
    if (input.type === 'password') {
      // Never emit the real password value into the capture file: it would be stored in
      // plaintext in the .h2f.json download, in chrome.storage.session, and be offered to the
      // clipboard by the popup's Copy button. A same-length bullet mask keeps the layout honest
      // (the field still looks filled at the right width) without leaking the secret.
      value = input.value ? '•'.repeat(input.value.length) : input.placeholder;
      placeholder = !input.value;
    } else {
      value = input.value; if (!value) { value = input.placeholder; placeholder = true; }
    }
  } else if (el.tagName === 'TEXTAREA') {
    const ta = el as HTMLTextAreaElement;
    value = ta.value; if (!value) { value = ta.placeholder; placeholder = true; }
    vertical = 'top';
  } else if (el.tagName === 'SELECT') {
    value = (el as HTMLSelectElement).selectedOptions[0]?.label ?? '';
  } else return null;
  if (!value) return null;
  const style: RunStyle = runStyleFromComputed(cs, ctx.color, ctx.isFontAvailable);
  if (placeholder) style.color = { ...style.color, a: style.color.a * 0.5 };
  const left = parseLength(cs.borderLeftWidth) + parseLength(cs.paddingLeft);
  const top = parseLength(cs.borderTopWidth) + parseLength(cs.paddingTop);
  const width = Math.max(1, geo.width - left - parseLength(cs.borderRightWidth) - parseLength(cs.paddingRight));
  const height = Math.max(1, geo.height - top - parseLength(cs.borderBottomWidth) - parseLength(cs.paddingBottom));
  return {
    id: ctx.nextId(), name: nameForText(value), type: 'text', x: left, y: top, width, height, rotation: 0, visible: true, opacity: 1,
    blendMode: 'normal', fills: [], radius: [0, 0, 0, 0], effects: [], clip: false, meta: { tag: el.tagName.toLowerCase(), classes: [] },
    characters: value, runs: [{ start: 0, end: value.length, ...style }], align: mapTextAlign(cs.textAlign, cs.direction), verticalAlign: vertical,
  };
}

function pseudoNode(el: Element, parentCs: CSSStyleDeclaration, which: '::before' | '::after', parentAbs: Rect, ctx: WalkContext): Node | null {
  let cs: CSSStyleDeclaration;
  try { cs = ctx.win.getComputedStyle(el, which); } catch { return null; }
  const content = cs.content;
  if (!content || content === 'none' || content === 'normal' || cs.display === 'none') return null;
  const quoted = /^"(.*)"$|^'(.*)'$/s.exec(content);
  const text = quoted ? (quoted[1] ?? quoted[2] ?? '') : '';
  const hasBox = hasVisualBox(cs) || extractUrl(content) !== null;
  if (!quoted && !hasBox) return null;
  if (quoted && text === '' && !hasBox) return null;
  const abs = absoluteRect(el, ctx.win);
  const bl = parseLength(parentCs.borderLeftWidth), bt = parseLength(parentCs.borderTopWidth);
  const contentX = bl + parseLength(parentCs.paddingLeft);
  const contentY = bt + parseLength(parentCs.paddingTop);
  const contentW = Math.max(1, abs.width - contentX - parseLength(parentCs.borderRightWidth) - parseLength(parentCs.paddingRight));
  const contentH = Math.max(1, abs.height - contentY - parseLength(parentCs.borderBottomWidth) - parseLength(parentCs.paddingBottom));
  const w = cs.width && cs.width !== 'auto' ? parseLength(cs.width) : contentW;
  const h = cs.height && cs.height !== 'auto' ? parseLength(cs.height) : (quoted && text ? (cs.lineHeight !== 'normal' ? parseLength(cs.lineHeight) : parseLength(cs.fontSize) * 1.2) : contentH);
  let x = contentX;
  let y = contentY;
  if (cs.position === 'absolute' || cs.position === 'fixed') {
    if (cs.left !== 'auto') x = bl + parseLength(cs.left); else if (cs.right !== 'auto') x = abs.width - parseLength(parentCs.borderRightWidth) - parseLength(cs.right) - w;
    if (cs.top !== 'auto') y = bt + parseLength(cs.top); else if (cs.bottom !== 'auto') y = abs.height - parseLength(parentCs.borderBottomWidth) - parseLength(cs.bottom) - h;
  } else if (which === '::after') {
    y = contentY + contentH - h;
  }
  ctx.pseudoEstimates.count++;
  const geo: Geometry = { x, y, width: w, height: h, rotation: 0, abs: { x: abs.x + x, y: abs.y + y, width: w, height: h } };
  const name = `${nameForElement(el)}${which}`;
  const fills: Paint[] = [];
  const bg = ctx.color(cs.backgroundColor);
  if (isVisible(bg)) fills.push({ type: 'solid', color: bg });
  for (const layer of parseBackgroundLayers(cs).reverse()) {
    const g = extractUrl(layer.image) ? null : parseGradient(layer.image, w, h, ctx.color);
    if (g) fills.push(g);
  }
  const base = { ...baseNode(ctx, el, cs, geo, name), meta: { ...metaFor(el, cs), pseudo: which === '::before' ? 'before' as const : 'after' as const } };
  if (quoted && text) {
    const style = runStyleFromComputed(cs, ctx.color, ctx.isFontAvailable);
    const chars = applyTextTransform(text, cs.textTransform);
    return { ...base, type: 'text', fills, characters: chars, runs: [{ start: 0, end: chars.length, ...style }], align: mapTextAlign(cs.textAlign, cs.direction), verticalAlign: 'top' };
  }
  return { ...base, type: 'frame', fills, stroke: strokeFor(cs, ctx.color), children: [] };
}

export async function buildRoot(root: HTMLElement, ctx: WalkContext): Promise<FrameNode> {
  const doc = ctx.doc;
  const htmlCs = ctx.win.getComputedStyle(root);
  const width = doc.documentElement.clientWidth || ctx.win.innerWidth;
  const height = Math.max(doc.documentElement.scrollHeight, doc.body?.scrollHeight ?? 0, ctx.win.innerHeight);
  const abs: Rect = { x: 0, y: 0, width, height };
  const fills: Paint[] = [];
  const htmlBg = ctx.color(htmlCs.backgroundColor);
  const bodyBg = doc.body ? ctx.color(ctx.win.getComputedStyle(doc.body).backgroundColor) : null;
  if (isVisible(htmlBg)) fills.push({ type: 'solid', color: htmlBg });
  else if (isVisible(bodyBg)) fills.push({ type: 'solid', color: bodyBg });
  else fills.push({ type: 'solid', color: { r: 1, g: 1, b: 1, a: 1 } });
  const children = await walkChildren(root, abs, ctx);
  // One aggregated warning instead of one per pseudo-element (see WalkContext.pseudoEstimates):
  // a page with hundreds of decorative ::before/::after rules would otherwise flood `warnings`
  // and push out warnings that explain real problems, which the UI truncates for display.
  if (ctx.pseudoEstimates.count) ctx.warnings.push(`Estimated geometry for ${ctx.pseudoEstimates.count} pseudo-element(s).`);
  return {
    id: ctx.nextId(), name: doc.title || 'Page', type: 'frame', x: 0, y: 0, width, height, rotation: 0, visible: true, opacity: 1,
    blendMode: 'normal', fills, radius: [0, 0, 0, 0], effects: [], clip: true, meta: { tag: 'html', classes: [] }, children,
  };
}
