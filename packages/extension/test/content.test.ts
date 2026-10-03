import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { H2FDocument } from '@h2f/schema';
import { downloadInPage, getHeldCapture, makeFileName, runCapture, type ContentIO } from '../src/content';

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
  it('captures, downloads, relays progress and asset fetches, and reports completion', async () => {
    const i = io();
    await runCapture({ revealAnimations: true, captureVideoFrames: true, imageQuality: 'balanced' }, i);
    expect(i.capture).toHaveBeenCalledWith(expect.objectContaining({ revealAnimations: true, captureVideoFrames: true, imageQuality: 'balanced' }));
    expect(i.sent).toContainEqual({ type: 'progress', stage: 'Capturing elements', done: 1, total: 2 });
    expect(i.sent).toContainEqual({ type: 'fetchAsset', url: 'https://x/a.png' });
    expect(i.download).toHaveBeenCalledWith(JSON.stringify(doc), expect.stringMatching(/^layrd\.pro-.*\.h2f\.json$/));
    const complete = i.sent.find((m) => (m as { type: string }).type === 'complete') as { warnings: string[]; size: number };
    expect(complete.warnings).toEqual(['w1']);
    expect(complete.size).toBe(JSON.stringify(doc).length);
  });
  it('reports failures', async () => {
    const i = io({ capture: vi.fn(async () => { throw new Error('kaput'); }) });
    await runCapture({ revealAnimations: true, captureVideoFrames: true, imageQuality: 'balanced' }, i);
    expect(i.sent.at(-1)).toMatchObject({ type: 'failed', error: expect.stringContaining('kaput') });
  });
});

// C1 regression: a Blob URL created here is same-origin with the captured page, so exposing it
// through any node the page's own DOM can observe would let page JavaScript fetch() the whole
// capture file back out (and, chained with background.ts's credentialed fetchAsset, exfiltrate
// authenticated cross-origin resources the page inlined into itself). downloadInPage must trigger
// the download without ever attaching the anchor to the page's document.
describe('downloadInPage', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  let revokeObjectURL: ReturnType<typeof vi.fn>;
  let clicked: HTMLAnchorElement[];
  let originalClick: () => void;

  beforeEach(() => {
    // jsdom does not implement URL.createObjectURL/revokeObjectURL; stub them so the function
    // under test can run without touching real Blob storage.
    if (!('createObjectURL' in URL)) (URL as unknown as { createObjectURL: unknown }).createObjectURL = () => '';
    if (!('revokeObjectURL' in URL)) (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = () => {};
    createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation(() => 'blob:mock-url');
    revokeObjectURL = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    clicked = [];
    originalClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) { clicked.push(this); };
  });
  afterEach(() => {
    HTMLAnchorElement.prototype.click = originalClick;
    vi.restoreAllMocks();
  });

  it('never attaches the download anchor to the page document, and clicks it detached', () => {
    const before = document.body.innerHTML;
    downloadInPage('{"a":1}', 'capture.h2f.json');
    expect(document.body.innerHTML).toBe(before);
    expect(document.querySelectorAll('a[download]')).toHaveLength(0);
    expect(clicked).toHaveLength(1);
    expect(clicked[0].isConnected).toBe(false);
    expect(clicked[0].download).toBe('capture.h2f.json');
  });

  it('revokes the object URL shortly after, not left dangling for 30s', () => {
    vi.useFakeTimers();
    downloadInPage('{"a":1}', 'capture.h2f.json');
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1000);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
    vi.useRealTimers();
  });
});

describe('holding the capture for Copy to Figma', () => {
  it('keeps the captured json in the page so the popup can copy it later, however large', async () => {
    const big = { ...doc, warnings: ['x'.repeat(6 * 1024 * 1024)] } as unknown as H2FDocument;
    const i = io({ capture: vi.fn(async () => ({ document: big })) });
    await runCapture({ revealAnimations: false, captureVideoFrames: false, imageQuality: 'balanced' }, i);
    expect(getHeldCapture()).toBe(JSON.stringify(big));
  });

  it('stops offering a stale capture once a new one fails', async () => {
    const i = io();
    await runCapture({ revealAnimations: true, captureVideoFrames: true, imageQuality: 'balanced' }, i);
    expect(getHeldCapture()).not.toBeNull();
    const failing = io({ capture: vi.fn(async () => { throw new Error('kaput'); }) });
    await runCapture({ revealAnimations: true, captureVideoFrames: true, imageQuality: 'balanced' }, failing);
    expect(getHeldCapture()).toBeNull();
  });

  it('passes the chosen image quality through to capture', async () => {
    const i = io();
    await runCapture({ revealAnimations: true, captureVideoFrames: true, imageQuality: 'original' }, i);
    expect(i.capture).toHaveBeenCalledWith(expect.objectContaining({ imageQuality: 'original' }));
  });
});
