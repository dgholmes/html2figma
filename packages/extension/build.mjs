import { build, context } from 'esbuild';
import { cpSync, mkdirSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, target: 'chrome120', logLevel: 'info', sourcemap: watch ? 'inline' : false };
const jobs = [
  { entryPoints: ['src/content.ts'], outfile: 'dist/content.js', format: 'iife' },
  { entryPoints: ['src/background.ts'], outfile: 'dist/background.js', format: 'esm' },
  { entryPoints: ['src/popup/popup.ts'], outfile: 'dist/popup.js', format: 'iife' },
];

mkdirSync('dist', { recursive: true });
cpSync('manifest.json', 'dist/manifest.json');
cpSync('src/popup/popup.html', 'dist/popup.html');
cpSync('src/popup/popup.css', 'dist/popup.css');

for (const job of jobs) {
  if (watch) (await context({ ...common, ...job })).watch();
  else await build({ ...common, ...job });
}
if (watch) console.log('watching extension sources…');
