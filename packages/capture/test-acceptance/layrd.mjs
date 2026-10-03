// Automated acceptance test for the regression that motivated this project.
//
// https://layrd.pro/ hides ~27 blocks at opacity:0 with a small transform until an
// IntersectionObserver reveals them on scroll; a commercial capture tool that snapshots the
// page without scrolling captures them invisible and produces large blank bands. This script
// captures the real, live site with the real capture bundle (same code path as production) and
// asserts every major section survived with visible, non-hidden-by-opacity text, no blank bands,
// the fixed header at y=0, real video frames/posters instead of placeholders, and oklch()
// backgrounds resolved to real colors.
//
// On success it then spawns the second half — a Vitest test (packages/figma-plugin/test/
// acceptance.layrd.test.ts) that feeds the SAME captured document through the Figma plugin's
// Builder to prove the import half works too — and this script's exit code is that test's exit
// code. On SKIP (site unreachable) or a capture-side check failure, the second half is not run
// at all: see "Stale-capture handling" below for why.
//
// Usage: npm run test:acceptance
// Network required. If layrd.pro is unreachable, this prints a SKIPPED message and exits 0 so
// the suite does not break when offline (e.g. in a sandboxed CI runner).
//
// Stale-capture handling: this script is the only writer of CAPTURE_PATH, and it deletes any
// existing file there before doing anything else, every run. That means the file can only ever
// be in one of two states when the Vitest half (or a plain `npm test`, which also picks up that
// test file) looks at it: freshly written by a capture that just finished, genuinely passing its
// own checks — or absent. There is no third state where a SKIPPED/failed run leaves a stale file
// behind for a later, unrelated `vitest run` to silently pass against. The RUN_ID envelope field
// plus the H2F_ACCEPTANCE_RUN_ID env var passed to the spawned Vitest process below are a second,
// belt-and-suspenders check for the specific case where this script's two halves are run
// together: if a file somehow exists but wasn't written by *this* invocation, the Vitest half
// fails loudly instead of quietly trusting it.
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL = 'https://layrd.pro/';
const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
const repoRoot = resolve(pkg, '../..');

// Shared with packages/figma-plugin/test/acceptance.layrd.test.ts — keep the path in sync.
export const CAPTURE_PATH = join(tmpdir(), 'h2f-acceptance', 'layrd.captured.json');
const RUN_ID = randomUUID();

// Delete any capture left over from a previous run FIRST, before the network is even touched, so
// a SKIPPED or failed run this time can never be followed by a pass on old data (see header).
if (existsSync(CAPTURE_PATH)) rmSync(CAPTURE_PATH, { force: true });

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
  console.log('SKIPPED: the Figma-import half was not run either (no fresh capture to feed it).');
  await browser.close();
  process.exit(0);
}
if (!response || !response.ok()) {
  console.log(`SKIPPED: layrd.pro responded with status ${response ? response.status() : '(no response)'}, not treating as a failure.`);
  console.log('SKIPPED: the Figma-import half was not run either (no fresh capture to feed it).');
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
// Depth-first search for the first text node whose (whitespace-normalized) characters contain
// `phrase`, returning the full ancestor path from `root` (inclusive) down to that text node
// (inclusive) — so callers can check opacity along the whole chain, not just the leaf. `opacity`
// is the literal subject of the layrd.pro regression (sections hidden via `opacity: 0` until an
// IntersectionObserver reveals them): a text node can be `visible` (CSS `visibility`) with
// nonzero width/height while still being invisible on screen because it — or a parent frame —
// was left at opacity 0, e.g. if the force-reveal fallback in prepare.ts regressed. `visible`
// alone can't catch that; this can.
function findTextPath(root, phrase) {
  const path = [];
  function dfs(node) {
    path.push(node);
    if (node.type === 'text' && normalize(node.characters).includes(phrase)) return true;
    if (node.children) for (const c of node.children) if (dfs(c)) return true;
    path.pop();
    return false;
  }
  return dfs(root) ? path.slice() : null;
}

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

const OPACITY_THRESHOLD = 0.01;
const emptySections = [];
for (const spec of SECTIONS) {
  const section = findSection(doc, spec.match);
  check(`section found: ${spec.label}`, !!section, section ? '' : JSON.stringify(spec.match));
  if (!section) { emptySections.push(spec.label); continue; }

  const path = findTextPath(section, spec.phrase);
  const textHit = path ? path[path.length - 1] : null;
  check(`text visible: ${spec.label}`, !!textHit && textHit.visible === true && textHit.width > 0 && textHit.height > 0,
    textHit ? `(visible=${textHit.visible} w=${textHit.width.toFixed(1)} h=${textHit.height.toFixed(1)})` : `(no text node containing "${spec.phrase}")`);

  const dim = path ? path.filter((n) => !(n.opacity > OPACITY_THRESHOLD)) : [];
  check(`text and ancestors not opacity-hidden: ${spec.label}`, !!path && dim.length === 0,
    dim.length ? `(${dim.map((n) => `${n.name} opacity=${n.opacity}`).join('; ')})` : '');

  const descendants = allNodes(section);
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

// ---- 7b: size budget ----------------------------------------------------------------------
// Before images were stored at their display size this same page captured at 42.23 MB, of
// which 42.09 MB was image payloads against 0.15 MB of actual layer tree; it now lands around
// 8 MB. The budget guards the regression that would quietly break Copy to Figma, which has
// to move the whole capture through one runtime message and one clipboard write.
const SIZE_BUDGET_MB = 12;
const sizeMb = Buffer.byteLength(JSON.stringify(doc)) / 1048576;
check(`capture stays under ${SIZE_BUDGET_MB} MB`, sizeMb < SIZE_BUDGET_MB, `${sizeMb.toFixed(2)} MB`);

const videoFrames = Object.values(doc.assets).filter((a) => a.origin === 'video-frame');
check('video frames stored as jpeg, not png', videoFrames.length > 0 && videoFrames.every((a) => a.mime === 'image/jpeg'),
  [...new Set(videoFrames.map((a) => a.mime))].join(', '));

const oversized = Object.values(doc.assets).filter((a) => a.width > 4096 || a.height > 4096);
check('no stored asset exceeds the 4096 px Figma limit', oversized.length === 0, `${oversized.length} oversized`);

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

if (failures.length) {
  console.error(`\n${failures.length} capture-side check(s) failed`);
  console.error('The Figma-import half was not run either — it would only be testing against known-bad data.');
  process.exit(1);
}
console.log('\nall capture-side acceptance checks passed');

// ---- write the captured document for the plugin-import half of the acceptance test -----------
// Only reached when every capture-side check above passed. RUN_ID is echoed to the child Vitest
// process via an env var below, so that half can confirm the file it reads is the one this exact
// run just wrote (see the "Stale-capture handling" note at the top of this file).
mkdirSync(dirname(CAPTURE_PATH), { recursive: true });
writeFileSync(CAPTURE_PATH, JSON.stringify({ runId: RUN_ID, capturedAt: new Date().toISOString(), document: doc }));
console.log(`Wrote captured document to ${CAPTURE_PATH} (runId ${RUN_ID}) for the Figma-import half of the acceptance test.`);

// ---- second half: feed the same document through the Figma plugin's Builder -------------------
console.log('\nRunning the Figma-import half (packages/figma-plugin/test/acceptance.layrd.test.ts)…');
const vitestResult = spawnSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['vitest', 'run', 'packages/figma-plugin/test/acceptance.layrd.test.ts'],
  { cwd: repoRoot, stdio: 'inherit', shell: true, env: { ...process.env, H2F_ACCEPTANCE_RUN_ID: RUN_ID } },
);
process.exit(vitestResult.status ?? 1);
