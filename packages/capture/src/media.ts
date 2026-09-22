import type { ImageAsset } from '@h2f/schema';
import type { AssetStore } from './assets';

export const MAX_RASTER = 4096;

export interface AssetLoader { fetchAsBase64(url: string): Promise<{ mime: string; data: string } | null> }
export interface MediaContext { doc: Document; store: AssetStore; loader: AssetLoader; warnings: string[] }
export interface LoadedAsset { id: string; kind: 'image' | 'svg'; width: number; height: number }

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

function decodeImageSize(mime: string, data: string, doc: Document): Promise<{ width: number; height: number }> {
  return new Promise((resolve) => {
    const img = doc.createElement('img');
    const timer = setTimeout(() => resolve({ width: 0, height: 0 }), 1500);
    img.onload = () => { clearTimeout(timer); resolve({ width: img.naturalWidth, height: img.naturalHeight }); };
    img.onerror = () => { clearTimeout(timer); resolve({ width: 0, height: 0 }); };
    img.src = `data:${mime};base64,${data}`;
  });
}

export async function assetFromUrl(url: string, ctx: MediaContext, origin: ImageAsset['origin'], fallbackImg?: HTMLImageElement): Promise<LoadedAsset | null> {
  if (!url || url.startsWith('about:') || url.startsWith('blob:') && !fallbackImg) return null;
  const cachedId = ctx.store.lookupUrl(url);
  if (cachedId) {
    const a = ctx.store.get(cachedId)!;
    return { id: cachedId, kind: a.kind, width: a.width, height: a.height };
  }
  let fetched: { mime: string; data: string } | null = null;
  if (url.startsWith('data:')) fetched = parseDataUrl(url);
  else if (!url.startsWith('blob:')) {
    try { fetched = await ctx.loader.fetchAsBase64(url); } catch { fetched = null; }
  }
  if (fetched && looksLikeSvg(fetched)) {
    const svg = decodeBase64Utf8(fetched.data);
    const dims = svgIntrinsicSize(svg) ?? { width: fallbackImg?.naturalWidth || 0, height: fallbackImg?.naturalHeight || 0 };
    const id = ctx.store.addSvg(svg, dims.width, dims.height);
    ctx.store.rememberUrl(url, id);
    return { id, kind: 'svg', ...dims };
  }
  if (fetched) {
    const dims = fallbackImg && fallbackImg.naturalWidth > 0
      ? { width: fallbackImg.naturalWidth, height: fallbackImg.naturalHeight }
      : await decodeImageSize(fetched.mime, fetched.data, ctx.doc);
    const id = ctx.store.addImage({ mime: fetched.mime, data: fetched.data, width: dims.width, height: dims.height, origin });
    ctx.store.rememberUrl(url, id);
    return { id, kind: 'image', ...dims };
  }
  if (fallbackImg && fallbackImg.naturalWidth > 0) {
    const png = drawToPng(fallbackImg, fallbackImg.naturalWidth, fallbackImg.naturalHeight, ctx.doc);
    if (png) {
      const id = ctx.store.addImage({ mime: 'image/png', data: png.data, width: png.width, height: png.height, origin });
      ctx.store.rememberUrl(url, id);
      return { id, kind: 'image', width: png.width, height: png.height };
    }
  }
  ctx.warnings.push(`Could not load image: ${url.slice(0, 160)}`);
  return null;
}

export async function videoAsset(video: HTMLVideoElement, ctx: MediaContext, captureFrames: boolean): Promise<(LoadedAsset & { label: string }) | { id: null; label: string }> {
  if (captureFrames && video.readyState >= 2 && video.videoWidth > 0) {
    const png = drawToPng(video, video.videoWidth, video.videoHeight, ctx.doc);
    if (png) {
      const id = ctx.store.addImage({ mime: 'image/png', data: png.data, width: png.width, height: png.height, origin: 'video-frame' });
      return { id, kind: 'image', width: png.width, height: png.height, label: '(video)' };
    }
    ctx.warnings.push(`Video frame capture was blocked (cross-origin video): ${video.currentSrc.slice(0, 160)}`);
  }
  if (video.poster) {
    const poster = await assetFromUrl(video.poster, ctx, 'video-poster');
    if (poster) return { ...poster, label: '(video poster)' };
  }
  return { id: null, label: '(video, frame unavailable)' };
}

export function canvasAsset(canvas: HTMLCanvasElement, ctx: MediaContext): LoadedAsset | null {
  try {
    const data = canvas.toDataURL('image/png').split(',')[1];
    if (!data) return null;
    const id = ctx.store.addImage({ mime: 'image/png', data, width: canvas.width, height: canvas.height, origin: 'canvas' });
    return { id, kind: 'image', width: canvas.width, height: canvas.height };
  } catch {
    ctx.warnings.push('A canvas element could not be read (tainted by cross-origin content).');
    return null;
  }
}

const SVG_STYLE_PROPS = ['fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'opacity', 'color', 'font-family', 'font-size', 'font-weight', 'display', 'visibility', 'transform', 'transform-origin'];

export function inlineSvgAsset(svg: SVGSVGElement, ctx: MediaContext, win: Window, width: number, height: number): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const originals = [svg, ...Array.from(svg.querySelectorAll('*'))];
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
  for (const use of Array.from(clone.querySelectorAll('use'))) {
    const ref = use.getAttribute('href') ?? use.getAttribute('xlink:href') ?? '';
    if (!ref.startsWith('#')) continue;
    const id = ref.slice(1);
    if (clone.querySelector(`#${CSS.escape(id)}`)) continue;
    const target = ctx.doc.getElementById(id);
    if (!target) continue;
    let defs = clone.querySelector('defs');
    if (!defs) { defs = ctx.doc.createElementNS('http://www.w3.org/2000/svg', 'defs'); clone.insertBefore(defs, clone.firstChild); }
    defs.appendChild(target.cloneNode(true));
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
