// Automated acceptance test for the regression that motivated this project.
//
// https://layrd.pro/ hides ~27 blocks at opacity:0 with a small transform until an
// IntersectionObserver reveals them on scroll; a commercial capture tool that snapshots the
// page without scrolling captures them invisible and produces large blank bands. This script
// captures the real, live site with the real capture bundle (same code path as production) and
// asserts every major section survived with visible text, no blank bands, the fixed header at
// y=0, real video frames/posters instead of placeholders, and oklch() backgrounds resolved to
// real colors.
//
// It then feeds the SAME captured document through the Figma plugin's Builder (see the second
// half in ../../figma-plugin/test/acceptance.layrd.test.ts) to prove the import half works too.
//
// Usage: npm run test:acceptance
// Network required. If layrd.pro is unreachable, this prints a SKIPPED message and exits 0 so
// the suite does not break when offline (e.g. in a sandboxed CI runner).
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = 'https://layrd.pro/';
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');

// Shared with packages/figma-plugin/test/acceptance.layrd.test.ts — keep the path in sync.
export const CAPTURE_PATH = join(tmpdir(), 'h2f-acceptance', 'layrd.captured.json');

const failures = [];
const check = (name, cond, detail = '') => {
  if (!cond) failures.push(`${name} ${detail}`);
  console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${detail}`);
};

console.log(`Building @h2f/capture…`);
const buildResult = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: pkg, stdio: 'inherit', shell: true });
if (buildResult.status !== 0) {
  console.error('capture build failed');
  process.exit(1);
}
const bundle = readFileSync(resolve(pkg, 'dist/capture.iife.js'), 'utf8');

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.setDefaultTimeout(30000);
page.on('console', (msg) => { if (msg.type() === 'error') console.log(`[page console] ${msg.text()}`); });

let response;
try {
  response = await page.goto(URL, { waitUntil: 'load', timeout: 30000 });
} catch (e) {
  console.log(`SKIPPED: layrd.pro is unreachable (${e instanceof Error ? e.message : String(e)}). This is not a failure — the suite does not require network access.`);
  await browser.close();
  process.exit(0);
}
if (!response || !response.ok()) {
  console.log(`SKIPPED: layrd.pro responded with status ${response ? response.status() : '(no response)'}, not treating as a failure.`);
  await browser.close();
  process.exit(0);
}

// Give the autoplay/loop demo videos a moment to decode a frame before capturePage pauses them —
// mirrors the real extension flow ("pause videos on the frame you want") more closely than
// capturing at t=0 immediately after load.
await page.waitForTimeout(2000);

await page.exposeFunction('h2fProgress', (stage, done, total) => console.log(`  [capture] ${stage} (${done}/${total})`));
await page.addScriptTag({ content: bundle });

console.log('Running capturePage() against the live site…');
const started = Date.now();
let doc;
try {
  doc = await Promise.race([
    page.evaluate(async () => {
      const toB64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
      const loader = { fetchAsBase64: async (url) => { try { const r = await fetch(url); if (!r.ok) return null; return { mime: (r.headers.get('content-type') || '').split(';')[0], data: toB64(await r.arrayBuffer()) }; } catch { return null; } } };
      const { document: capturedDoc } = await window.__h2fCapture.capturePage({ loader, revealAnimations: true, captureVideoFrames: true, onProgress: window.h2fProgress });
      return capturedDoc;
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('capturePage() did not finish within 180s')), 180000)),
  ]);
} catch (e) {
  console.error(`FAIL capturePage() threw: ${e instanceof Error ? e.message : String(e)}`);
  await browser.close();
  process.exit(1);
}
console.log(`capturePage() finished in ${((Date.now() - started) / 1000).toFixed(1)}s`);
await browser.close();

// ---- helpers over the captured H2FDocument -------------------------------------------------
function allNodes(node, out = []) {
  out.push(node);
  if (node.children) for (const c of node.children) allNodes(c, out);
  return out;
}
function normalize(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
function findSection(doc, m) {
  return allNodes(doc.root).find((n) => n.type === 'frame' && n.meta?.tag === m.tag && (m.id ? n.meta.id === m.id : (n.meta.classes || []).includes(m.class)));
}
function hasImageFill(n) { return (n.fills || []).some((f) => f.type === 'image'); }

// ---- 3: every major section shows its copy, and (4) no blank bands --------------------------
const SECTIONS = [
  { label: 'hero ("look published")', match: { tag: 'section', id: 'top' }, phrase: 'look published' },
  { label: 'positioning ("Not another filter app")', match: { tag: 'section', class: 'v13-positioning' }, phrase: 'Not another filter app' },
  { label: 'built for photographers (light section)', match: { tag: 'section', class: 'v13-built' }, phrase: 'Built for photographers' },
  { label: 'depth-aware type feature', match: { tag: 'section', id: 'depth' }, phrase: 'slips behind the subject' },
  { label: 'carousel studio feature', match: { tag: 'section', id: 'spread' }, phrase: 'Multiple swipes' },
  { label: 'animated type / motion', match: { tag: 'section', id: 'motion' }, phrase: 'their own rhythm' },
  { label: 'phone showcase ("Everything after the good shot")', match: { tag: 'section', id: 'features' }, phrase: 'the good shot' },
  { label: 'privacy ("stays out of the editing cloud")', match: { tag: 'section', class: 'v13-privacy' }, phrase: 'stay out of the editing cloud' },
  { label: 'gallery (#madewithlayrd)', match: { tag: 'section', id: 'showcase' }, phrase: '#madewithlayrd' },
  { label: 'faq ("Before you ask")', match: { tag: 'section', id: 'faq' }, phrase: 'Before you ask' },
  { label: 'waitlist ("Leave with the post")', match: { tag: 'section', id: 'waitlist' }, phrase: 'Leave with the post' },
];

const emptySections = [];
for (const spec of SECTIONS) {
  const section = findSection(doc, spec.match);
  check(`section found: ${spec.label}`, !!section, section ? '' : JSON.stringify(spec.match));
  if (!section) { emptySections.push(spec.label); continue; }
  const descendants = allNodes(section);
  const textHit = descendants.find((n) => n.type === 'text' && normalize(n.characters).includes(spec.phrase));
  check(`text visible: ${spec.label}`, !!textHit && textHit.visible === true && textHit.width > 0 && textHit.height > 0,
    textHit ? `(visible=${textHit.visible} w=${textHit.width.toFixed(1)} h=${textHit.height.toFixed(1)})` : `(no text node containing "${spec.phrase}")`);
  const notBlank = descendants.some((n) => n.type === 'text' || hasImageFill(n));
  check(`no blank band: ${spec.label}`, notBlank);
  if (!notBlank) emptySections.push(spec.label);
}
if (emptySections.length) console.error(`Empty/blank section(s): ${emptySections.join(', ')}`);

// ---- 5: fixed header at the top --------------------------------------------------------------
const header = allNodes(doc.root).find((n) => n.meta?.tag === 'header');
check('fixed header captured', !!header && header.meta.position === 'fixed', header ? `(position=${header.meta.position})` : '(no <header>)');
check('fixed header at y≈0', !!header && Math.abs(header.y) < 2, header ? `(y=${header.y})` : '');

// ---- 6: all five videos produced an image fill, not a placeholder -----------------------------
const videoNodes = allNodes(doc.root).filter((n) => n.meta?.tag === 'video');
check('found 5 <video> elements', videoNodes.length === 5, `(found ${videoNodes.length})`);
for (const v of videoNodes) {
  const label = /\(video poster\)/.test(v.name) ? 'poster' : /\(video\)/.test(v.name) ? 'captured frame' : 'UNAVAILABLE';
  check(`video got an image fill: ${v.name}`, hasImageFill(v), `[${label}]`);
}

// ---- 7: oklch() backgrounds resolved to real colors --------------------------------------------
const darkPositioning = findSection(doc, { tag: 'section', class: 'v13-positioning' });
const lightBuilt = findSection(doc, { tag: 'section', class: 'v13-built' });
const darkWaitlist = findSection(doc, { tag: 'section', id: 'waitlist' });
const solidColor = (n) => n?.fills?.find((f) => f.type === 'solid')?.color;
const posColor = solidColor(darkPositioning);
const builtColor = solidColor(lightBuilt);
const waitColor = solidColor(darkWaitlist);
check('oklch dark background resolved (positioning)', !!posColor && posColor.r < 0.3 && posColor.g < 0.3 && posColor.b < 0.3, JSON.stringify(posColor));
check('oklch light background resolved (built)', !!builtColor && builtColor.r > 0.8, JSON.stringify(builtColor));
check('oklch dark background resolved (waitlist)', !!waitColor && waitColor.r < 0.3, JSON.stringify(waitColor));

// ---- 8: summary ---------------------------------------------------------------------------
const nodeCount = allNodes(doc.root).length;
const assetCount = Object.keys(doc.assets).length;
const jsonSize = Buffer.byteLength(JSON.stringify(doc));
console.log('\n--- capture summary ---');
console.log(`nodes: ${nodeCount}`);
console.log(`assets: ${assetCount}`);
console.log(`document JSON size: ${(jsonSize / 1024 / 1024).toFixed(2)} MB`);
console.log(`capture warnings (${doc.warnings.length}):`);
for (const w of doc.warnings) console.log(`  - ${w}`);

// ---- write the captured document for the plugin-import half of the acceptance test -----------
mkdirSync(dirname(CAPTURE_PATH), { recursive: true });
writeFileSync(CAPTURE_PATH, JSON.stringify(doc));
console.log(`\nWrote captured document to ${CAPTURE_PATH} for the Figma-import half of the acceptance test.`);

if (failures.length) {
  console.error(`\n${failures.length} capture-side check(s) failed`);
  process.exit(1);
}
console.log('\nall capture-side acceptance checks passed');
