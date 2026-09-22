import { build } from 'esbuild';

await build({
  entryPoints: ['src/global.ts'],
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  outfile: 'dist/capture.iife.js',
  logLevel: 'info',
});
