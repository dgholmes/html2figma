import { build, context } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const watch = process.argv.includes('--watch');
mkdirSync('dist', { recursive: true });
cpSync('manifest.json', 'dist/manifest.json');

const mainOpts = { entryPoints: ['src/main/index.ts'], bundle: true, format: 'iife', target: 'es2020', outfile: 'dist/main.js', logLevel: 'info' };
const uiOpts = {
  entryPoints: ['src/ui/ui.ts'], bundle: true, format: 'iife', target: 'chrome110', write: false, logLevel: 'info',
  plugins: [{
    name: 'inline-html',
    setup(b) {
      b.onEnd((result) => {
        const js = result.outputFiles?.[0]?.text ?? '';
        const html = readFileSync('src/ui/index.html', 'utf8').replace('/*__UI_JS__*/', () => js);
        writeFileSync('dist/ui.html', html);
        console.log(`ui.html written (${(html.length / 1024).toFixed(0)} kB)`);
      });
    },
  }],
};

if (watch) {
  (await context(mainOpts)).watch();
  (await context(uiOpts)).watch();
  console.log('watching plugin sources…');
} else {
  await build(mainOpts);
  await build(uiOpts);
}
