import { describe, expect, it, vi } from 'vitest';
import type { H2FDocument } from '@h2f/schema';
import { makeFileName, runCapture, type ContentIO } from '../src/content';

const doc = { version: 1, warnings: ['w1'], root: { type: 'frame' } } as unknown as H2FDocument;

function io(over: Partial<ContentIO> = {}): ContentIO & { sent: unknown[] } {
  const sent: unknown[] = [];
  return {
    sent,
    send: vi.fn(async (m) => { sent.push(m); return { mime: 'image/png', data: 'QUJD' }; }),
    download: vi.fn(),
    capture: vi.fn(async (opts) => { opts.onProgress?.('Capturing elements', 1, 2); await opts.loader.fetchAsBase64('https://x/a.png'); return { document: doc }; }),
    location: { hostname: 'layrd.pro' },
    ...over,
  };
}

describe('makeFileName', () => {
  it('uses host and timestamp', () => {
    expect(makeFileName('layrd.pro', new Date(2026, 8, 22, 13, 5))).toBe('layrd.pro-20260922-1305.h2f.json');
    expect(makeFileName('', new Date(2026, 0, 1, 0, 0))).toBe('page-20260101-0000.h2f.json');
  });
});

describe('runCapture', () => {
  it('captures, downloads, relays progress and asset fetches, and reports completion with json', async () => {
    const i = io();
    await runCapture({ revealAnimations: true, captureVideoFrames: true }, i);
    expect(i.capture).toHaveBeenCalledWith(expect.objectContaining({ revealAnimations: true, captureVideoFrames: true }));
    expect(i.sent).toContainEqual({ type: 'progress', stage: 'Capturing elements', done: 1, total: 2 });
    expect(i.sent).toContainEqual({ type: 'fetchAsset', url: 'https://x/a.png' });
    expect(i.download).toHaveBeenCalledWith(JSON.stringify(doc), expect.stringMatching(/^layrd\.pro-.*\.h2f\.json$/));
    const complete = i.sent.find((m) => (m as { type: string }).type === 'complete') as { json?: string; warnings: string[]; size: number };
    expect(complete.json).toBe(JSON.stringify(doc));
    expect(complete.warnings).toEqual(['w1']);
    expect(complete.size).toBe(JSON.stringify(doc).length);
  });
  it('omits json above the clipboard limit', async () => {
    const big = { ...doc, warnings: ['x'.repeat(6 * 1024 * 1024)] } as unknown as H2FDocument;
    const i = io({ capture: vi.fn(async () => ({ document: big })) });
    await runCapture({ revealAnimations: false, captureVideoFrames: false }, i);
    const complete = i.sent.find((m) => (m as { type: string }).type === 'complete') as { json?: string };
    expect(complete.json).toBeUndefined();
  });
  it('reports failures', async () => {
    const i = io({ capture: vi.fn(async () => { throw new Error('kaput'); }) });
    await runCapture({ revealAnimations: true, captureVideoFrames: true }, i);
    expect(i.sent.at(-1)).toMatchObject({ type: 'failed', error: expect.stringContaining('kaput') });
  });
});
