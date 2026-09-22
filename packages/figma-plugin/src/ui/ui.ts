import { countNodes, validateDocument, type H2FDocument } from '@h2f/schema';
import type { MainToUi, UiToMain } from '../messages';
import { prepareImageAsset, rasterizeSvg } from './assets';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const post = (msg: UiToMain) => parent.postMessage({ pluginMessage: msg }, '*');

let current: H2FDocument | null = null;
const drop = $('drop');
const fileInput = $<HTMLInputElement>('file');
const paste = $<HTMLTextAreaElement>('paste');
const importBtn = $<HTMLButtonElement>('import');
const log = $('log');
const stage = $('stage');
const barFill = $('bar-fill');

function setLog(text: string, isError = false): void {
  log.textContent = text;
  log.classList.toggle('hidden', !text);
  log.classList.toggle('error', isError);
}

function setProgress(text: string, done: number, total: number): void {
  stage.textContent = text;
  barFill.style.width = `${total ? Math.min(100, Math.round((done / total) * 100)) : 0}%`;
}

function loadText(text: string): void {
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch (e) { setLog(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`, true); return; }
  const result = validateDocument(parsed);
  if (!result.ok) { setLog(`This file is not a valid html2figma document:\n${result.errors.slice(0, 8).join('\n')}`, true); current = null; importBtn.disabled = true; return; }
  current = result.document;
  const assets = Object.values(current.assets);
  const bytes = assets.reduce((n, a) => n + (a.kind === 'image' ? a.data.length * 0.75 : a.svg.length), 0);
  $('info').classList.remove('hidden');
  $('info-title').textContent = current.source.title || '(untitled)';
  $('info-url').textContent = current.source.url;
  $('info-viewport').textContent = `${current.source.viewport.width} × ${current.source.fullPageHeight} px`;
  $('info-counts').textContent = `${countNodes(current.root)} layers · ${assets.length} assets · ${(bytes / 1024 / 1024).toFixed(1)} MB`;
  setLog(current.warnings.length ? `${current.warnings.length} capture warning(s):\n${current.warnings.slice(0, 20).join('\n')}` : '');
  importBtn.disabled = false;
  setProgress('Ready to import', 0, 1);
}

async function startImport(doc: H2FDocument): Promise<void> {
  importBtn.disabled = true;
  const assets = Object.values(doc.assets);
  post({ type: 'begin', assetCount: assets.length, options: { newPage: $<HTMLInputElement>('opt-newpage').checked } });
  let i = 0;
  for (const asset of assets) {
    i++;
    setProgress(`Preparing assets (${i}/${assets.length})`, i, assets.length);
    if (asset.kind === 'image') {
      const prepared = await prepareImageAsset(asset);
      if (prepared) post({ type: 'asset', id: asset.id, bytes: prepared.bytes, width: prepared.width, height: prepared.height });
      else setLog(`${log.textContent ?? ''}\nCould not decode image ${asset.id} (${asset.mime}); its fill will be skipped.`.trim());
    } else {
      post({ type: 'svg', id: asset.id, svg: asset.svg, fallback: await rasterizeSvg(asset.svg, asset.width, asset.height) });
    }
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  post({ type: 'tree', document: { ...doc, assets: {} } });
}

async function readFile(file: File): Promise<void> {
  setProgress(`Reading ${file.name}`, 0, 1);
  loadText(await file.text());
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) void readFile(f); });
for (const evt of ['dragenter', 'dragover']) drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const evt of ['dragleave', 'drop']) drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => { const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) void readFile(f); });
paste.addEventListener('input', () => { const t = paste.value.trim(); if (t.startsWith('{')) { loadText(t); paste.value = ''; } });
importBtn.addEventListener('click', () => { if (current) void startImport(current); });

window.onmessage = (event: MessageEvent<{ pluginMessage?: MainToUi }>) => {
  const msg = event.data?.pluginMessage;
  if (!msg) return;
  switch (msg.type) {
    case 'ready': setProgress('Drop a file to begin', 0, 1); break;
    case 'progress': setProgress(msg.stage, msg.done, msg.total); break;
    case 'done':
      setProgress(`Imported ${msg.nodeCount} layers`, 1, 1);
      setLog(msg.warnings.length ? `${msg.warnings.length} warning(s):\n${msg.warnings.slice(0, 40).join('\n')}` : 'Import finished without warnings.');
      importBtn.disabled = false;
      break;
    case 'error': setProgress('Import failed', 0, 1); setLog(msg.message, true); importBtn.disabled = false; break;
  }
};
