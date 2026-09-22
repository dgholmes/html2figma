// Usage: npm run test:browser   (requires: npm i -D playwright && npx playwright install chromium)
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, '..');
spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'], { cwd: pkg, stdio: 'inherit', shell: true });
const bundle = await readFile(resolve(pkg, 'dist/capture.iife.js'), 'utf8');

const types = { '.html': 'text/html', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (req, res) => {
  try {
    const file = resolve(pkg, 'fixtures', '.' + decodeURIComponent(new URL(req.url, 'http://x').pathname));
    res.setHeader('content-type', types[extname(file)] ?? 'application/octet-stream');
    res.end(await readFile(file));
  } catch { res.statusCode = 404; res.end('nope'); }
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const { chromium } = await import('playwright');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
const failures = [];
const check = (name, cond, detail = '') => { if (!cond) failures.push(`${name} ${detail}`); console.log(`${cond ? 'ok  ' : 'FAIL'} ${name} ${detail}`); };

async function capture(fixture) {
  await page.goto(`http://localhost:${port}/${fixture}`);
  await page.addScriptTag({ content: bundle });
  return page.evaluate(async () => {
    const toB64 = (buf) => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
    const loader = { fetchAsBase64: async (url) => { const r = await fetch(url); if (!r.ok) return null; return { mime: (r.headers.get('content-type') || '').split(';')[0], data: toB64(await r.arrayBuffer()) }; } };
    const { document: doc } = await window.__h2fCapture.capturePage({ loader });
    return doc;
  });
}
const all = (node, out = []) => { out.push(node); if (node.children) node.children.forEach((c) => all(c, out)); return out; };
const byName = (doc, re) => all(doc.root).filter((n) => re.test(n.name));

const reveal = await capture('reveal.html');
check('reveal: hero text captured', byName(reveal, /Hero headline/).length === 1);
check('reveal: never-revealed text captured', byName(reveal, /Never revealed/).length === 1);
check('reveal: header flagged fixed at top', byName(reveal, /header/)[0]?.meta.position === 'fixed' && byName(reveal, /header/)[0]?.y === 0);
check('reveal: oklch background parsed', reveal.root.fills[0]?.type === 'solid' && reveal.root.fills[0].color.r < 0.2);
check('reveal: warning about forced reveal', reveal.warnings.some((w) => /Forced/.test(w)), JSON.stringify(reveal.warnings));
// I7: a hidden overlay centered with a large translate(-50%, -50%) and no opacity transition must
// not be force-revealed — it stays opacity:0/visible:false, not relocated by `transform: none`.
const overlay = byName(reveal, /div\.overlay/)[0];
check('reveal: hidden overlay left untouched (not force-revealed)', overlay?.opacity === 0 && overlay?.visible === false, JSON.stringify(overlay));

const styles = await capture('styles.html');
const card = byName(styles, /div\.card/)[0];
check('styles: gradient fill on card', card?.fills.some((f) => f.type === 'gradient'), JSON.stringify(card?.fills));
check('styles: shadow on card', card?.effects[0]?.type === 'drop-shadow');
check('styles: headline is one text node with italic run', byName(styles, /Make your photos/).length === 1 && byName(styles, /Make your photos/)[0].runs.some((r) => r.italic));
check('styles: badge uppercase + dashed stroke', byName(styles, /NEW/).length === 1 && byName(styles, /span\.badge/)[0]?.stroke?.dash?.length === 2);
check('styles: rotated leaf has rotation ≈ 8', Math.abs((byName(styles, /div\.rotated/)[0]?.rotation ?? 0) - 8) < 0.5, String(byName(styles, /div\.rotated/)[0]?.rotation));
check('styles: inline svg became vector with currentColor inlined', byName(styles, /svg\.icon/)[0]?.type === 'vector' && /rgb\(0, 170, 119\)|#0a7|rgb\(0,170,119\)/.test(styles.assets[byName(styles, /svg\.icon/)[0].assetId].svg));
check('styles: ::before pseudo positioned absolutely', byName(styles, /div\.ring::before/)[0]?.x === 10);
check('styles: input placeholder text', byName(styles, /^Your email$/).length === 1);

const media = await capture('media.html');
check('media: img data-url svg became vector', byName(media, /^img/)[0]?.type === 'vector');
check('media: video used poster', /video poster/.test(byName(media, /video/)[0]?.name ?? ''));
check('media: canvas has image fill', byName(media, /canvas/)[0]?.fills.some((f) => f.type === 'image'));
check('media: tiled background', byName(media, /^div/).some((n) => n.fills.some((f) => f.type === 'image' && f.scaleMode === 'tile')));
check('media: iframe placeholder', byName(media, /^iframe.*\(not captured\)$/).length === 1);

await browser.close();
server.close();
if (failures.length) { console.error(`\n${failures.length} check(s) failed`); process.exit(1); }
console.log('\nall browser checks passed');
