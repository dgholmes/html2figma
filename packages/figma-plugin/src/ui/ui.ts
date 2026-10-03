import { countNodes, validateDocument, walkNodes, type H2FDocument } from '@h2f/schema';
import type { MainToUi, UiToMain } from '../messages';
import { prepareImageAsset, rasterizeSvg } from './assets';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const post = (msg: UiToMain) => parent.postMessage({ pluginMessage: msg }, '*');

let current: H2FDocument | null = null;
// C3: asset-stage failures discovered here (image decode, svg rasterize) accumulate separately
// from `msg.warnings`, and the 'done' handler below appends both lists rather than replacing the
// log with whichever arrives last — otherwise an early decode-failure message logged mid-loop is
// simply overwritten by the final "Import finished" text and never seen.
let assetWarnings: string[] = [];
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
  // I9: everything below (in particular the byte-size reduce, which reads `.data`/`.svg` off
  // every asset) previously ran unguarded. validateDocument now checks each asset's own shape,
  // so this should no longer be reachable with malformed data — but wrapping it too means any
  // other unexpected failure here is reported instead of silently wedging the UI.
  try {
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
  } catch (e) {
    current = null;
    importBtn.disabled = true;
    setLog(`This file could not be loaded: ${e instanceof Error ? e.message : String(e)}`, true);
  }
}

// I8: rasterizing every svg asset "just in case" uploads an orphan, oversized (2x) PNG for every
// inline icon on the page, most of which Figma's own createNodeFromSvg parses fine and never
// needs. Only assets an ImagePaint actually names need the fallback proactively — that's the one
// path (CSS background-image on an svg) main.ts can't otherwise resolve a fill for.
function imagePaintAssetIds(doc: H2FDocument): Set<string> {
  const ids = new Set<string>();
  walkNodes(doc.root, (n) => { for (const f of n.fills) if (f.type === 'image') ids.add(f.assetId); });
  return ids;
}

async function startImport(doc: H2FDocument): Promise<void> {
  importBtn.disabled = true;
  assetWarnings = [];
  const assets = Object.values(doc.assets);
  const neededAsImage = imagePaintAssetIds(doc);
  post({ type: 'begin', assetCount: assets.length, options: { newPage: $<HTMLInputElement>('opt-newpage').checked } });
  let i = 0;
  for (const asset of assets) {
    i++;
    setProgress(`Preparing assets (${i}/${assets.length})`, i, assets.length);
    if (asset.kind === 'image') {
      const prepared = await prepareImageAsset(asset);
      if (prepared) post({ type: 'asset', id: asset.id, bytes: prepared.bytes, width: prepared.width, height: prepared.height });
      else assetWarnings.push(`Could not decode image ${asset.id} (${asset.mime}); its fill will be skipped.`);
    } else {
      // I8: only rasterize when some ImagePaint actually references this svg id. A vector node
      // using this asset doesn't need a raster at all — createVector only falls back to it when
      // figma.createNodeFromSvg itself throws, which is the uncommon case.
      const needsFallback = neededAsImage.has(asset.id);
      const fallback = needsFallback ? await rasterizeSvg(asset.svg, asset.width, asset.height) : undefined;
      // C3: rasterizeSvg failing produced no message anywhere before this fix — the ImagePaint
      // that names this asset would silently resolve to nothing on the main side.
      if (needsFallback && !fallback) assetWarnings.push(`Could not rasterize SVG asset ${asset.id} as a fallback; if Figma can't parse it directly, its fill will be skipped.`);
      post({ type: 'svg', id: asset.id, svg: asset.svg, fallback });
    }
    if (i % 10 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  post({ type: 'tree', document: { ...doc, assets: {} } });
}

async function readFile(file: File): Promise<void> {
  try {
    setProgress(`Reading ${file.name}`, 0, 1);
    loadText(await file.text());
  } catch (e) {
    // I9: file.text() rejecting (or any other failure reading the drop/picked file) previously
    // escaped as an unhandled rejection — the progress bar just stopped with nothing logged.
    setProgress('Could not read file', 0, 1);
    setLog(`Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`, true);
    current = null;
    importBtn.disabled = true;
  }
}

drop.addEventListener('click', () => fileInput.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
fileInput.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) void readFile(f); });
for (const evt of ['dragenter', 'dragover']) drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.add('over'); });
for (const evt of ['dragleave', 'drop']) drop.addEventListener(evt, (e) => { e.preventDefault(); drop.classList.remove('over'); });
drop.addEventListener('drop', (e) => { const f = (e as DragEvent).dataTransfer?.files?.[0]; if (f) void readFile(f); });
paste.addEventListener('input', () => {
  const t = paste.value.trim();
  if (!t) return;
  if (t.startsWith('{')) { loadText(t); paste.value = ''; return; }
  setLog('That does not look like a captured document. Click "Copy to Figma" in the extension, then paste here.', true);
});
// A multi-megabyte paste takes a moment to land; say so rather than looking frozen.
paste.addEventListener('paste', () => { setProgress('Reading pasted capture…', 0, 1); });
paste.focus();
importBtn.addEventListener('click', () => {
  if (!current) return;
  // I9: an unhandled rejection here (e.g. a truly unexpected failure inside startImport) used to
  // escape silently — the import button stayed disabled and the progress bar just stopped.
  startImport(current).catch((e) => {
    setProgress('Import failed', 0, 1);
    setLog(`Could not import: ${e instanceof Error ? e.message : String(e)}`, true);
    importBtn.disabled = false;
  });
});

window.onmessage = async (event: MessageEvent<{ pluginMessage?: MainToUi }>) => {
  const msg = event.data?.pluginMessage;
  if (!msg) return;
  switch (msg.type) {
    case 'ready': setProgress('Drop a file to begin', 0, 1); break;
    case 'progress': setProgress(msg.stage, msg.done, msg.total); break;
    case 'done': {
      setProgress(`Imported ${msg.nodeCount} layers`, 1, 1);
      // C3: append the UI-side asset warnings (decode/rasterize failures collected during
      // startImport) to the main-side ones rather than only showing whichever arrives last.
      const warnings = [...assetWarnings, ...msg.warnings];
      setLog(warnings.length ? `${warnings.length} warning(s):\n${warnings.slice(0, 40).join('\n')}` : 'Import finished without warnings.');
      importBtn.disabled = false;
      break;
    }
    case 'error': setProgress('Import failed', 0, 1); setLog(msg.message, true); importBtn.disabled = false; break;
    case 'needFallback': {
      // I8 follow-up: main asked for a specific svg to be rasterized reactively, because
      // figma.createNodeFromSvg just failed on it and no proactive fallback was supplied for it
      // (it wasn't referenced by any ImagePaint). Rasterize on demand and hand the bytes back so
      // that node degrades to a real image fill instead of a red "import failed" placeholder.
      const bytes = await rasterizeSvg(msg.svg, msg.width, msg.height);
      post({ type: 'fallback', id: msg.id, bytes });
      break;
    }
  }
};
