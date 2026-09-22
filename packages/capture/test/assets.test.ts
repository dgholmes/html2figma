import { describe, expect, it } from 'vitest';
import { AssetStore, hashString } from '../src/assets';

describe('hashString', () => {
  it('is deterministic, 16 hex chars, and differs for different input', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).toMatch(/^[0-9a-f]{16}$/);
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });
});

describe('AssetStore', () => {
  it('dedupes identical image data and remembers urls', () => {
    const store = new AssetStore();
    const a = store.addImage({ mime: 'image/png', data: 'AAAA', width: 1, height: 1, origin: 'img' });
    const b = store.addImage({ mime: 'image/png', data: 'AAAA', width: 1, height: 1, origin: 'background' });
    const c = store.addImage({ mime: 'image/png', data: 'BBBB', width: 1, height: 1, origin: 'img' });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(store.count).toBe(2);
    store.rememberUrl('https://x/a.png', a);
    expect(store.lookupUrl('https://x/a.png')).toBe(a);
    expect(store.lookupUrl('https://x/z.png')).toBeUndefined();
    expect(store.get(a)).toMatchObject({ kind: 'image', origin: 'img' });
  });
  it('stores svg assets and exports a record', () => {
    const store = new AssetStore();
    const id = store.addSvg('<svg xmlns="http://www.w3.org/2000/svg"/>', 24, 24);
    expect(store.toRecord()[id]).toEqual({ id, kind: 'svg', svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', width: 24, height: 24 });
    expect(store.bytes).toBeGreaterThan(0);
  });
});
