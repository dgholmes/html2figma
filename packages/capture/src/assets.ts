import type { Asset, ImageAsset } from '@h2f/schema';

export function hashString(s: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193);
    h2 = Math.imul(h2 ^ c, 0x01000193) ^ (h2 >>> 13);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export class AssetStore {
  private readonly assets = new Map<string, Asset>();
  private readonly byUrl = new Map<string, string>();
  private size = 0;

  addImage(input: Omit<ImageAsset, 'id' | 'kind'>): string {
    const id = `a${hashString(`${input.mime}:${input.data}`)}`;
    if (!this.assets.has(id)) {
      this.assets.set(id, { id, kind: 'image', ...input });
      this.size += input.data.length;
    }
    return id;
  }

  addSvg(svg: string, width: number, height: number): string {
    const id = `s${hashString(svg)}`;
    if (!this.assets.has(id)) {
      this.assets.set(id, { id, kind: 'svg', svg, width, height });
      this.size += svg.length;
    }
    return id;
  }

  rememberUrl(url: string, id: string): void { this.byUrl.set(url, id); }
  lookupUrl(url: string): string | undefined { return this.byUrl.get(url); }
  get(id: string): Asset | undefined { return this.assets.get(id); }
  toRecord(): Record<string, Asset> { return Object.fromEntries(this.assets); }
  get count(): number { return this.assets.size; }
  get bytes(): number { return this.size; }
}
