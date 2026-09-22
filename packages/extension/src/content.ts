import { capturePage } from '@h2f/capture';
import { CLIPBOARD_LIMIT, type CaptureSettings, type ToBackground, type ToContent } from './messages';

export interface ContentIO {
  send(msg: ToBackground): Promise<unknown>;
  download(text: string, fileName: string): void;
  capture: typeof capturePage;
  location: { hostname: string };
}

export function makeFileName(host: string, now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  const safeHost = host.replace(/[^a-z0-9.-]/gi, '_') || 'page';
  return `${safeHost}-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}.h2f.json`;
}

export async function runCapture(settings: CaptureSettings, io: ContentIO): Promise<void> {
  try {
    const { document: doc } = await io.capture({
      revealAnimations: settings.revealAnimations,
      captureVideoFrames: settings.captureVideoFrames,
      loader: { fetchAsBase64: (url) => io.send({ type: 'fetchAsset', url }) as Promise<{ mime: string; data: string } | null> },
      onProgress: (stage, done, total) => { void io.send({ type: 'progress', stage, done, total }); },
    });
    const json = JSON.stringify(doc);
    const fileName = makeFileName(io.location.hostname);
    io.download(json, fileName);
    await io.send({ type: 'complete', fileName, size: json.length, warnings: doc.warnings, json: json.length < CLIPBOARD_LIMIT ? json : undefined });
  } catch (e) {
    await io.send({ type: 'failed', error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) });
  }
}

export function downloadInPage(text: string, fileName: string): void {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  // Deliberately never appended to the captured page's document. Content-script Blob URLs are
  // same-origin with the page, so any node exposing this href — even briefly, even detached a
  // moment later — would let the page's own JavaScript recover the URL (e.g. via a
  // MutationObserver) and fetch() the whole capture file back out. Combined with background.ts's
  // fetchAsset, which fetches attacker-chosen cross-origin URLs with the user's cookies on the
  // page's behalf, that would let a hostile page read back credentialed cross-origin resources it
  // could never fetch itself. A detached anchor's .click() still triggers a normal Chrome
  // download without ever placing the URL where page script can observe it.
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

declare global { interface Window { __h2fContentInstalled?: boolean; __h2fRunning?: boolean } }

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage && !window.__h2fContentInstalled) {
  window.__h2fContentInstalled = true;
  const io: ContentIO = {
    send: (msg) => chrome.runtime.sendMessage(msg),
    download: downloadInPage,
    capture: capturePage,
    location: window.location,
  };
  chrome.runtime.onMessage.addListener((msg: ToContent, _sender, sendResponse) => {
    if (msg?.type === 'run') {
      if (window.__h2fRunning) { sendResponse({ ok: false, reason: 'already running' }); return false; }
      window.__h2fRunning = true;
      void runCapture(msg.settings, io).finally(() => { window.__h2fRunning = false; });
      sendResponse({ ok: true });
    }
    return false;
  });
}
