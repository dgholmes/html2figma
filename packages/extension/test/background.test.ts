import { describe, expect, it, vi } from 'vitest';
import { bytesToBase64, fetchAsset, handleMessage, MAX_ASSET_BYTES, type BackgroundDeps } from '../src/background';
import type { JobState } from '../src/messages';

function deps(over: Partial<BackgroundDeps> = {}) {
  let job: JobState = { status: 'idle' };
  let result: string | undefined;
  const d: BackgroundDeps = {
    getJob: async () => job,
    setJob: async (patch) => { job = { ...job, ...patch }; return job; },
    setResult: async (json) => { result = json; },
    inject: vi.fn(async () => {}),
    sendToTab: vi.fn(async () => {}),
    fetchAsset: vi.fn(async () => ({ mime: 'image/png', data: 'QUJD' })),
    now: () => 1000,
    ...over,
  };
  return { d, job: () => job, result: () => result };
}

describe('handleMessage', () => {
  it('start injects the content script, sends run, and marks the job running', async () => {
    const { d, job } = deps();
    await handleMessage({ type: 'start', tabId: 7, settings: { revealAnimations: true, captureVideoFrames: false } }, d);
    expect(d.inject).toHaveBeenCalledWith(7);
    expect(d.sendToTab).toHaveBeenCalledWith(7, { type: 'run', settings: { revealAnimations: true, captureVideoFrames: false } });
    expect(job()).toMatchObject({ status: 'running', tabId: 7, startedAt: 1000 });
  });
  it('start records an error when injection fails', async () => {
    const { d, job } = deps({ inject: vi.fn(async () => { throw new Error('Cannot access chrome:// URL'); }) });
    await handleMessage({ type: 'start', tabId: 1, settings: { revealAnimations: true, captureVideoFrames: true } }, d);
    expect(job()).toMatchObject({ status: 'error' });
    expect(job().error).toMatch(/chrome:\/\//);
  });
  it('progress, complete and failed update the job; complete stores small json', async () => {
    const { d, job, result } = deps();
    await handleMessage({ type: 'progress', stage: 'Capturing elements', done: 5, total: 10 }, d);
    expect(job()).toMatchObject({ stage: 'Capturing elements', done: 5, total: 10 });
    await handleMessage({ type: 'complete', fileName: 'x.h2f.json', size: 12, warnings: ['w'], json: '{"a":1}' }, d);
    expect(job()).toMatchObject({ status: 'done', fileName: 'x.h2f.json', size: 12, warnings: ['w'], hasClipboardCopy: true, finishedAt: 1000 });
    expect(result()).toBe('{"a":1}');
    await handleMessage({ type: 'failed', error: 'boom' }, d);
    expect(job()).toMatchObject({ status: 'error', error: 'boom' });
  });
  it('fetchAsset delegates, getState returns the job, reset clears it', async () => {
    const { d, job } = deps();
    expect(await handleMessage({ type: 'fetchAsset', url: 'https://x/a.png' }, d)).toEqual({ mime: 'image/png', data: 'QUJD' });
    expect(await handleMessage({ type: 'getState' }, d)).toEqual(job());
    await handleMessage({ type: 'reset' }, d);
    expect(job()).toEqual({ status: 'idle' });
  });
});

describe('fetchAsset', () => {
  it('returns base64 with the content type, null on errors or oversize', async () => {
    const ok = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png; charset=binary' } }));
    expect(await fetchAsset('https://x/a.png', ok as unknown as typeof fetch)).toEqual({ mime: 'image/png', data: 'AQID' });
    const bad = vi.fn(async () => new Response('nope', { status: 404 }));
    expect(await fetchAsset('https://x/a.png', bad as unknown as typeof fetch)).toBeNull();
    const boom = vi.fn(async () => { throw new TypeError('network'); });
    expect(await fetchAsset('https://x/a.png', boom as unknown as typeof fetch)).toBeNull();
  });

  // I12 regression: a response declaring an oversized Content-Length must be rejected without
  // ever buffering the body — previously arrayBuffer() ran first, fully reading a response well
  // over the cap into memory before the size check could reject it.
  it('bails on a declared oversized Content-Length without reading the body', async () => {
    const arrayBuffer = vi.fn(async () => { throw new Error('response body should never have been read'); });
    const huge = vi.fn(async () => ({
      ok: true,
      headers: { get: (h: string) => (h === 'content-length' ? String(MAX_ASSET_BYTES + 1) : 'image/png') },
      arrayBuffer,
    } as unknown as Response));
    expect(await fetchAsset('https://x/huge.png', huge as unknown as typeof fetch)).toBeNull();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('still allows a response within the Content-Length cap through to the byteLength read', async () => {
    const small = vi.fn(async () => new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png', 'content-length': '3' } }));
    expect(await fetchAsset('https://x/small.png', small as unknown as typeof fetch)).toEqual({ mime: 'image/png', data: 'AQID' });
  });

  it('falls back to the post-hoc byteLength check when Content-Length is absent (chunked response)', async () => {
    const chunked = vi.fn(async () => {
      const body = new Uint8Array(MAX_ASSET_BYTES + 1);
      return new Response(body, { headers: { 'content-type': 'image/png' } });
    });
    expect(await fetchAsset('https://x/chunked.png', chunked as unknown as typeof fetch)).toBeNull();
  });
});

describe('bytesToBase64', () => {
  it('encodes large arrays in chunks', () => {
    const bytes = new Uint8Array(70000).fill(65);
    expect(bytesToBase64(bytes)).toBe(btoa('A'.repeat(70000)));
  });
});
