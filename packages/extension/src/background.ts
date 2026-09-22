import { JOB_KEY, RESULT_KEY, type JobState, type ToBackground, type ToContent } from './messages';

export const MAX_ASSET_BYTES = 25 * 1024 * 1024;

export interface BackgroundDeps {
  getJob(): Promise<JobState>;
  setJob(patch: Partial<JobState>): Promise<JobState>;
  setResult(json: string | undefined): Promise<void>;
  inject(tabId: number): Promise<void>;
  sendToTab(tabId: number, msg: ToContent): Promise<void>;
  fetchAsset(url: string): Promise<{ mime: string; data: string } | null>;
  now(): number;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function fetchAsset(url: string, fetchImpl: typeof fetch = fetch): Promise<{ mime: string; data: string } | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    const res = await fetchImpl(url, { credentials: 'include', signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > MAX_ASSET_BYTES) return null;
    const mime = (res.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
    return { mime, data: bytesToBase64(new Uint8Array(buf)) };
  } catch {
    return null;
  }
}

export async function handleMessage(msg: ToBackground, deps: BackgroundDeps): Promise<unknown> {
  switch (msg.type) {
    case 'start': {
      await deps.setResult(undefined);
      await deps.setJob({ status: 'running', tabId: msg.tabId, stage: 'Injecting capture script', done: 0, total: 1, error: undefined, fileName: undefined, size: undefined, warnings: undefined, hasClipboardCopy: false, startedAt: deps.now(), finishedAt: undefined });
      try {
        await deps.inject(msg.tabId);
        await deps.sendToTab(msg.tabId, { type: 'run', settings: msg.settings });
      } catch (e) {
        await deps.setJob({ status: 'error', error: `Could not start capture: ${e instanceof Error ? e.message : String(e)}`, finishedAt: deps.now() });
      }
      return { ok: true };
    }
    case 'fetchAsset':
      return deps.fetchAsset(msg.url);
    case 'progress':
      await deps.setJob({ stage: msg.stage, done: msg.done, total: msg.total });
      return { ok: true };
    case 'complete':
      await deps.setResult(msg.json);
      await deps.setJob({ status: 'done', fileName: msg.fileName, size: msg.size, warnings: msg.warnings, hasClipboardCopy: !!msg.json, stage: 'Done', finishedAt: deps.now() });
      return { ok: true };
    case 'failed':
      await deps.setJob({ status: 'error', error: msg.error, finishedAt: deps.now() });
      return { ok: true };
    case 'getState':
      return deps.getJob();
    case 'reset':
      await deps.setResult(undefined);
      await deps.setJob({ status: 'idle', tabId: undefined, stage: undefined, done: undefined, total: undefined, fileName: undefined, size: undefined, error: undefined, warnings: undefined, startedAt: undefined, finishedAt: undefined, hasClipboardCopy: undefined });
      return { ok: true };
  }
}

// ---- Chrome wiring (not exercised by unit tests) ----
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  const storage = chrome.storage.session;
  const deps: BackgroundDeps = {
    getJob: async () => ((await storage.get(JOB_KEY))[JOB_KEY] as JobState | undefined) ?? { status: 'idle' },
    setJob: async (patch) => {
      const current = ((await storage.get(JOB_KEY))[JOB_KEY] as JobState | undefined) ?? { status: 'idle' };
      const next: JobState = { ...current, ...patch };
      for (const key of Object.keys(next) as (keyof JobState)[]) if (next[key] === undefined) delete next[key];
      await storage.set({ [JOB_KEY]: next });
      return next;
    },
    setResult: async (json) => { if (json === undefined) await storage.remove(RESULT_KEY); else await storage.set({ [RESULT_KEY]: json }); },
    inject: async (tabId) => { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); },
    sendToTab: async (tabId, msg) => { await chrome.tabs.sendMessage(tabId, msg); },
    fetchAsset: (url) => fetchAsset(url),
    now: () => Date.now(),
  };
  chrome.runtime.onMessage.addListener((msg: ToBackground, _sender, sendResponse) => {
    handleMessage(msg, deps).then(sendResponse, (e) => sendResponse({ error: e instanceof Error ? e.message : String(e) }));
    return true;
  });
}
