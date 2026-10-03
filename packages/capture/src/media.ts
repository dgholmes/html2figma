import { chooseStoredRaster, encodeRaster, shouldReencode, targetRasterSize, type ImageQuality, type Size } from './optimize';
import type { ImageAsset } from '@h2f/schema';
import type { AssetStore } from './assets';

export const MAX_RASTER = 4096;

export interface AssetLoader { fetchAsBase64(url: string): Promise<{ mime: string; data: string } | null> }
export interface MediaContext { doc: Document; store: AssetStore; loader: AssetLoader; warnings: string[]; quality: ImageQuality }
export interface LoadedAsset {
  id: string;
  kind: 'image' | 'svg';
  /** Size of the bytes actually stored, which optimization may have reduced. */
  width: number;
  height: number;
  /**
   * The source's intrinsic CSS size. Placement maths (background-position, background-size,
   * object-fit) is defined against this, not against whatever resolution we chose to store —
   * conflating the two sends a sprite's crop window outside its own sheet.
   */
  naturalWidth: number;
  naturalHeight: number;
}

export function parseDataUrl(url: string): { mime: string; data: string } | null {
  const m = /^data:([^;,]+)?((?:;[^;,]+)*),(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || 'text/plain';
  const isBase64 = (m[2] ?? '').split(';').includes('base64');
  const payload = m[3];
  if (isBase64) return { mime, data: payload.replace(/\s+/g, '') };
  const text = decodeURIComponent(payload);
  return { mime, data: btoa(unescape(encodeURIComponent(text))) };
}

export function decodeBase64Utf8(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function svgIntrinsicSize(svg: string): { width: number; height: number } | null {
  const open = /<svg\b[^>]*>/i.exec(svg)?.[0] ?? '';
  const attr = (name: string) => new RegExp(`\\s${name}\\s*=\\s*["']([^"']+)["']`, 'i').exec(open)?.[1];
  const w = parseFloat(attr('width') ?? '');
  const h = parseFloat(attr('height') ?? '');
  if (w > 0 && h > 0 && !/%/.test(attr('width') ?? '')) return { width: w, height: h };
  const vb = (attr('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) return { width: vb[2], height: vb[3] };
  return null;
}

function looksLikeSvg(fetched: { mime: string; data: string }): boolean {
  if (fetched.mime.includes('svg')) return true;
  if (!/^(image\/|text\/|application\/(xml|octet-stream))/.test(fetched.mime) || fetched.mime.startsWith('image/png') || fetched.mime.startsWith('image/jpeg')) return false;
  try { return /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(decodeBase64Utf8(fetched.data.slice(0, 400))); } catch { return false; }
}

export function drawToPng(source: CanvasImageSource, width: number, height: number, doc: Document): { data: string; width: number; height: number } | null {
  if (!(width > 0 && height > 0)) return null;
  const scale = Math.min(1, MAX_RASTER / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  try {
    const canvas = doc.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    const data = canvas.toDataURL('image/png').split(',')[1];
    return data ? { data, width: w, height: h } : null;
  } catch {
    return null;
  }
}

/**
 * Decode fetched bytes into an image element. Decoding from a `data:` URL rather than
 * reusing the live page element matters: a cross-origin `<img>` taints the canvas, so
 * drawing it to re-encode would throw and we would lose the optimization on exactly the
 * images most worth shrinking.
 */
function loadImageFromData(mime: string, data: string, doc: Document): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = doc.createElement('img');
    const timer = setTimeout(() => resolve(null), 1500);
    img.onload = () => { clearTimeout(timer); resolve(img); };
    img.onerror = () => { clearTimeout(timer); resolve(null); };
    img.src = `data:${mime};base64,${data}`;
  });
}

export async function assetFromUrl(
  url: string,
  ctx: MediaContext,
  origin: ImageAsset['origin'],
  fallbackImg?: HTMLImageElement,
  display?: Size,
): Promise<LoadedAsset | null> {
  if (!url || url.startsWith('about:') || url.startsWith('blob:') && !fallbackImg) return null;
  // The display size is part of the identity of what we store: one image used at two sizes
  // needs two assets, or the second use inherits the first one's resolution.
  const cacheKey = ctx.quality.density > 0 && display && display.width > 0
    ? `${url}@${Math.round(display.width)}x${Math.round(display.height)}`
    : url;
  const cachedId = ctx.store.lookupUrl(cacheKey);
  if (cachedId) {
    const a = ctx.store.get(cachedId)!;
    const nat = ctx.store.lookupNatural(cachedId) ?? { width: a.width, height: a.height };
    return { id: cachedId, kind: a.kind, width: a.width, height: a.height, naturalWidth: nat.width, naturalHeight: nat.height };
  }
  let fetched: { mime: string; data: string } | null = null;
  if (url.startsWith('data:')) fetched = parseDataUrl(url);
  else if (!url.startsWith('blob:')) {
    try { fetched = await ctx.loader.fetchAsBase64(url); } catch { fetched = null; }
  }
  if (fetched && looksLikeSvg(fetched)) {
    try {
      const svg = decodeBase64Utf8(fetched.data);
      const dims = svgIntrinsicSize(svg) ?? { width: fallbackImg?.naturalWidth || 0, height: fallbackImg?.naturalHeight || 0 };
      const id = ctx.store.addSvg(svg, dims.width, dims.height);
      ctx.store.rememberUrl(cacheKey, id);
      ctx.store.rememberNatural(id, dims);
      return { id, kind: 'svg', ...dims, naturalWidth: dims.width, naturalHeight: dims.height };
    } catch {
      // Malformed base64 payload despite an svg-looking mime type: fall through to the raster/warning paths below.
      fetched = null;
    }
  }
  if (fetched) {
    const skipDecode = ctx.quality.density <= 0 && !!fallbackImg && fallbackImg.naturalWidth > 0;
    const decoded = skipDecode ? null : await loadImageFromData(fetched.mime, fetched.data, ctx.doc);
    const natural = decoded && decoded.naturalWidth > 0
      ? { width: decoded.naturalWidth, height: decoded.naturalHeight }
      : fallbackImg && fallbackImg.naturalWidth > 0
        ? { width: fallbackImg.naturalWidth, height: fallbackImg.naturalHeight }
        : { width: 0, height: 0 };
    const target = natural.width > 0 ? targetRasterSize(natural, display ?? null, ctx.quality.density) : null;
    const encoded = decoded && target && shouldReencode(fetched.mime, natural, target, ctx.quality.density)
      ? encodeRaster(decoded, target, ctx.doc, ctx.quality.jpegQuality)
      : null;
    const stored = chooseStoredRaster(fetched, encoded, natural);
    const id = ctx.store.addImage({ mime: stored.mime, data: stored.data, width: stored.width, height: stored.height, origin });
    ctx.store.rememberUrl(cacheKey, id);
    ctx.store.rememberNatural(id, natural);
    return { id, kind: 'image', width: stored.width, height: stored.height, naturalWidth: natural.width, naturalHeight: natural.height };
  }
  if (fallbackImg && fallbackImg.naturalWidth > 0) {
    // blob: URLs, failed fetches and oversized responses land here. Without the same
    // optimization this path alone would put a page's worth of natural-size PNGs back.
    const natural = { width: fallbackImg.naturalWidth, height: fallbackImg.naturalHeight };
    const target = targetRasterSize(natural, ctx.quality.density > 0 ? display ?? null : null, ctx.quality.density);
    const drawn = ctx.quality.density > 0
      ? encodeRaster(fallbackImg, target, ctx.doc, ctx.quality.jpegQuality)
      : null;
    const png = drawn ?? (() => { const p = drawToPng(fallbackImg, natural.width, natural.height, ctx.doc); return p && { mime: 'image/png', ...p }; })();
    if (png) {
      const id = ctx.store.addImage({ mime: png.mime, data: png.data, width: png.width, height: png.height, origin });
      ctx.store.rememberUrl(cacheKey, id);
      ctx.store.rememberNatural(id, natural);
      return { id, kind: 'image', width: png.width, height: png.height, naturalWidth: natural.width, naturalHeight: natural.height };
    }
  }
  ctx.warnings.push(`Could not load image: ${url.slice(0, 160)}`);
  return null;
}

export async function videoAsset(
  video: HTMLVideoElement,
  ctx: MediaContext,
  captureFrames: boolean,
  display?: Size,
): Promise<(LoadedAsset & { label: string }) | { id: null; label: string }> {
  if (captureFrames && video.readyState >= 2 && video.videoWidth > 0) {
    const natural = { width: video.videoWidth, height: video.videoHeight };
    // Video frames are photographic, so PNG was the worst possible choice: five of them
    // accounted for 5.9 MB of a measured layrd.pro capture.
    const png = ctx.quality.density > 0 ? null : drawToPng(video, natural.width, natural.height, ctx.doc);
    const frame = ctx.quality.density > 0
      ? encodeRaster(video, targetRasterSize(natural, display ?? null, ctx.quality.density), ctx.doc, ctx.quality.jpegQuality)
      : png && { mime: 'image/png', ...png };
    if (frame) {
      const id = ctx.store.addImage({ mime: frame.mime, data: frame.data, width: frame.width, height: frame.height, origin: 'video-frame' });
      ctx.store.rememberNatural(id, natural);
      return { id, kind: 'image', width: frame.width, height: frame.height, naturalWidth: natural.width, naturalHeight: natural.height, label: '(video)' };
    }
    ctx.warnings.push(`Video frame capture was blocked (cross-origin video): ${video.currentSrc.slice(0, 160)}`);
  }
  if (video.poster) {
    const poster = await assetFromUrl(video.poster, ctx, 'video-poster', undefined, display);
    if (poster) return { ...poster, label: '(video poster)' };
  }
  return { id: null, label: '(video, frame unavailable)' };
}

export function canvasAsset(canvas: HTMLCanvasElement, ctx: MediaContext): LoadedAsset | null {
  try {
    const data = canvas.toDataURL('image/png').split(',')[1];
    if (!data) return null;
    const id = ctx.store.addImage({ mime: 'image/png', data, width: canvas.width, height: canvas.height, origin: 'canvas' });
    return { id, kind: 'image', width: canvas.width, height: canvas.height, naturalWidth: canvas.width, naturalHeight: canvas.height };
  } catch {
    ctx.warnings.push('A canvas element could not be read (tainted by cross-origin content).');
    return null;
  }
}

const SVG_STYLE_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'opacity', 'color', 'font-family', 'font-size', 'font-weight', 'display', 'visibility', 'transform', 'transform-origin'];

function bakeComputedStyle(original: Element, clone: Element, win: Window): void {
  const originals = [original, ...Array.from(original.querySelectorAll('*'))];
  const clones = [clone, ...Array.from(clone.querySelectorAll('*'))];
  for (let i = 0; i < originals.length && i < clones.length; i++) {
    const cs = win.getComputedStyle(originals[i]);
    const target = clones[i] as SVGElement;
    for (const prop of SVG_STYLE_PROPS) {
      const value = cs.getPropertyValue(prop);
      if (value && value !== 'none' || (prop === 'fill' || prop === 'stroke' || prop === 'display')) target.style.setProperty(prop, value);
    }
    target.removeAttribute('class');
  }
}

export function inlineSvgAsset(svg: SVGSVGElement, ctx: MediaContext, win: Window, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  bakeComputedStyle(svg, clone, win);
  for (const use of Array.from(clone.querySelectorAll('use'))) {
    const ref = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    if (!ref.startsWith('#')) continue;
    const id = ref.slice(1);
    if (clone.querySelector(`#${CSS.escape(id)}`)) continue;
    const target = ctx.doc.getElementById(id);
    if (!target) continue;
    let defs = clone.querySelector('defs');
    if (!defs) { defs = ctx.doc.createElementNS('http://www.w3.org/2000/svg', 'defs'); clone.insertBefore(defs, clone.firstChild); }
    const targetClone = target.cloneNode(true) as Element;
    bakeComputedStyle(target, targetClone, win);
    defs.appendChild(targetClone);
  }
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(Math.max(1, Math.round(width))));
  clone.setAttribute('height', String(Math.max(1, Math.round(height))));
  if (!clone.getAttribute('viewBox')) {
    const vb = svg.viewBox?.baseVal;
    if (vb && vb.width > 0 && vb.height > 0) clone.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
    else clone.setAttribute('viewBox', `0 0 ${Math.max(1, Math.round(width))} ${Math.max(1, Math.round(height))}`);
  }
  const markup = new XMLSerializer().serializeToString(clone);
  return ctx.store.addSvg(markup, width, height);
}
