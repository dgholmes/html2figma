import { describe, expect, it } from 'vitest';
import type { ImageAsset } from '@h2f/schema';
import { base64ToBytes, bytesToBase64, needsReencode } from '../src/ui/assets';

const asset = (over: Partial<ImageAsset>): ImageAsset => ({ id: 'a', kind: 'image', mime: 'image/png', data: 'AAAA', width: 100, height: 100, origin: 'img', ...over });

describe('base64 helpers', () => {
  it('round-trips bytes', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});

describe('needsReencode', () => {
  it('keeps png/jpeg/gif within limits, re-encodes others or oversize or unknown size', () => {
    expect(needsReencode(asset({}))).toBe(false);
    expect(needsReencode(asset({ mime: 'image/jpeg' }))).toBe(false);
    expect(needsReencode(asset({ mime: 'image/webp' }))).toBe(true);
    expect(needsReencode(asset({ mime: 'image/avif' }))).toBe(true);
    expect(needsReencode(asset({ width: 5000 }))).toBe(true);
    expect(needsReencode(asset({ width: 0, height: 0 }))).toBe(true);
  });
});
