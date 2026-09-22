import { DEFAULT_SETTINGS, JOB_KEY, RESULT_KEY, SETTINGS_KEY, type CaptureSettings, type JobState, type ToBackground } from '../messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: ToBackground) => chrome.runtime.sendMessage(msg);

export interface PopupElements {
  capture: HTMLButtonElement; status: HTMLElement; barFill: HTMLElement; stage: HTMLElement; result: HTMLElement; resultText: HTMLElement;
  copy: HTMLButtonElement; warningsBox: HTMLDetailsElement; warningsSummary: HTMLElement; warnings: HTMLElement; error: HTMLElement; errorText: HTMLElement;
}

export function render(state: JobState, el: PopupElements): void {
  const running = state.status === 'running';
  el.capture.disabled = running;
  el.capture.textContent = running ? 'Capturing…' : 'Capture page';
  el.status.classList.toggle('hidden', !running);
  el.result.classList.toggle('hidden', state.status !== 'done');
  el.error.classList.toggle('hidden', state.status !== 'error');
  if (running) {
    const pct = state.total ? Math.round(((state.done ?? 0) / state.total) * 100) : 0;
    el.barFill.style.width = `${pct}%`;
    el.stage.textContent = `${state.stage ?? 'Working'}${state.total && state.total > 1 ? ` (${pct}%)` : ''}`;
  }
  if (state.status === 'done') {
    const mb = ((state.size ?? 0) / 1024 / 1024).toFixed(1);
    el.resultText.textContent = `Saved ${state.fileName ?? 'file'} (${mb} MB) to your Downloads folder. Open the html2figma plugin in Figma and drop the file in.`;
    el.copy.classList.toggle('hidden', !state.hasClipboardCopy);
    const warnings = state.warnings ?? [];
    el.warningsBox.classList.toggle('hidden', warnings.length === 0);
    el.warningsSummary.textContent = `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`;
    el.warnings.textContent = warnings.join('\n');
  }
  if (state.status === 'error') el.errorText.textContent = state.error ?? 'Unknown error';
}

async function main(): Promise<void> {
  const el: PopupElements = {
    capture: $('capture'), status: $('status'), barFill: $('bar-fill'), stage: $('stage'), result: $('result'), resultText: $('result-text'),
    copy: $('copy'), warningsBox: $('warnings-box'), warningsSummary: $('warnings-summary'), warnings: $('warnings'), error: $('error'), errorText: $('error-text'),
  };
  $('version').textContent = `v${chrome.runtime.getManifest().version}`;
  const reveal = $<HTMLInputElement>('opt-reveal');
  const video = $<HTMLInputElement>('opt-video');
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as CaptureSettings | undefined;
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  reveal.checked = settings.revealAnimations;
  video.checked = settings.captureVideoFrames;
  const saveSettings = () => chrome.storage.local.set({ [SETTINGS_KEY]: { revealAnimations: reveal.checked, captureVideoFrames: video.checked } satisfies CaptureSettings });
  reveal.addEventListener('change', saveSettings);
  video.addEventListener('change', saveSettings);

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const url = tab?.url ?? '';
  const capturable = /^(https?|file):/.test(url);
  $('tab-title').textContent = tab?.title ?? '(no tab)';
  $('tab-url').textContent = url || 'This page cannot be captured (browser pages, the Web Store, and PDFs are blocked by Chrome).';
  if (!capturable) el.capture.disabled = true;

  render((await send({ type: 'getState' })) as JobState, el);
  chrome.storage.session.onChanged.addListener((changes) => { if (changes[JOB_KEY]) render(changes[JOB_KEY].newValue as JobState, el); });

  el.capture.addEventListener('click', async () => {
    if (!tab?.id || !capturable) return;
    await saveSettings();
    await send({ type: 'start', tabId: tab.id, settings: { revealAnimations: reveal.checked, captureVideoFrames: video.checked } });
  });
  el.copy.addEventListener('click', async () => {
    const json = (await chrome.storage.session.get(RESULT_KEY))[RESULT_KEY] as string | undefined;
    if (!json) { el.copy.textContent = 'Nothing to copy'; return; }
    await navigator.clipboard.writeText(json);
    el.copy.textContent = 'Copied!';
    setTimeout(() => { el.copy.textContent = 'Copy JSON'; }, 1500);
  });
  $('copy-error').addEventListener('click', () => navigator.clipboard.writeText(el.errorText.textContent ?? ''));
  for (const id of ['reset', 'reset-error']) $(id).addEventListener('click', () => send({ type: 'reset' }));
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) void main();
