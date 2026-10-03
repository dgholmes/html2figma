import { COPY_LIMIT, DEFAULT_SETTINGS, JOB_KEY, SETTINGS_KEY, type CaptureSettings, type ImageQualityName, type JobState, type ToBackground } from '../messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const send = (msg: ToBackground) => chrome.runtime.sendMessage(msg);

export interface PopupElements {
  capture: HTMLButtonElement; status: HTMLElement; barFill: HTMLElement; stage: HTMLElement; result: HTMLElement; resultText: HTMLElement;
  copy: HTMLButtonElement; warningsBox: HTMLDetailsElement; warningsSummary: HTMLElement; warnings: HTMLElement; error: HTMLElement; errorText: HTMLElement;
}

let lastState: JobState = { status: 'idle' };

export function render(state: JobState, el: PopupElements): void {
  lastState = state;
  const running = state.status === 'running';
  if (running) el.copy.disabled = false;
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
    el.resultText.textContent = `Saved ${state.fileName ?? 'file'} (${mb} MB) to Downloads. Click Copy to Figma, then paste into the html2figma plugin — or drop the file in.`;
    el.copy.classList.toggle('hidden', !state.canCopy);
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
  const quality = $<HTMLSelectElement>('opt-quality');
  const stored = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY] as CaptureSettings | undefined;
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  reveal.checked = settings.revealAnimations;
  video.checked = settings.captureVideoFrames;
  quality.value = settings.imageQuality;
  const currentSettings = (): CaptureSettings => ({ revealAnimations: reveal.checked, captureVideoFrames: video.checked, imageQuality: quality.value as ImageQualityName });
  const saveSettings = () => chrome.storage.local.set({ [SETTINGS_KEY]: currentSettings() });
  reveal.addEventListener('change', saveSettings);
  video.addEventListener('change', saveSettings);
  quality.addEventListener('change', saveSettings);

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
    await send({ type: 'start', tabId: tab.id, settings: currentSettings() });
  });
  el.copy.addEventListener('click', () => {
    if (el.copy.disabled) return;
    const say = (text: string, revert = 3000) => {
      el.copy.textContent = text;
      if (revert) setTimeout(() => { el.copy.textContent = 'Copy to Figma'; }, revert);
    };
    // Refuse before the transfer rather than after it: the size is already known from the
    // finished job, and a capture past the ceiling cannot survive the hop in the first place.
    const known = lastState.size ?? 0;
    if (known > COPY_LIMIT) {
      say(`Too large to copy (${(known / 1048576).toFixed(0)} MB). Drop the downloaded file into the plugin instead.`, 8000);
      return;
    }
    el.copy.disabled = true;
    // The capture lives in the page and takes a moment to come across, which outlasts the
    // click's user activation. Handing the clipboard a promise starts the write now and fills
    // it in when the data lands, so the gesture is never lost.
    let failure: string | null = null;
    const payload = (async () => {
      const res = (await Promise.race([
        send({ type: 'requestCapture' }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
      ])) as { json: string | null; reason?: string } | undefined;
      const json = res?.json;
      if (!json) {
        failure = res?.reason === 'tab-unreachable'
          ? 'That tab is gone. Re-open it and capture again, or drop the downloaded file into the plugin.'
          : 'The page no longer holds this capture. Capture again, or drop the downloaded file into the plugin.';
        throw new Error(failure);
      }
      return new Blob([json], { type: 'text/plain' });
    })();
    payload.catch(() => { failure ??= 'Copying timed out. Drop the downloaded file into the plugin instead.'; });
    say('Copying…', 0);
    // Chrome may replace a rejected item promise with its own error, so the reason is kept
    // aside rather than read back off whatever the clipboard throws.
    const write = typeof ClipboardItem === 'function'
      ? navigator.clipboard.write([new ClipboardItem({ 'text/plain': payload })])
      : payload.then((blob) => blob.text()).then((text) => navigator.clipboard.writeText(text));
    write.then(
      () => { el.copy.disabled = false; say('Copied — paste into the plugin'); },
      (e: unknown) => {
        el.copy.disabled = false;
        say(failure ?? (e instanceof Error ? e.message : 'Copy failed'), 8000);
      },
    );
  });
  $('copy-error').addEventListener('click', () => navigator.clipboard.writeText(el.errorText.textContent ?? ''));
  for (const id of ['reset', 'reset-error']) $(id).addEventListener('click', () => send({ type: 'reset' }));
}

if (typeof chrome !== 'undefined' && chrome.runtime?.id) void main();
