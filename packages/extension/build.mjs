import { execFileSync } from 'node:child_process';
import { build } from 'esbuild';

const prod = process.argv.includes('--production');

// 0) o200k ranks as a standalone JSON asset, loaded at runtime by both the
//    extension host (off disk) and the webviews (fetch). Keeping the ~2.3 MB
//    blob out of the JS keeps the bundles scanner-clean — see core/tokenizer.
execFileSync('node', ['../../tools/emit-ranks.mjs', 'dist/o200k_base.json'], {
  stdio: 'inherit',
});

// 1) Extension host — Node/CommonJS, `vscode` provided by the runtime.
await build({
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
});

// 2) Webview bundles — Preact + shared UI + tokenizer, all bundled offline (no
//    CDN). IIFE so no module loader is needed under the webview CSP.
await build({
  entryPoints: [
    'src/webview/live.tsx',
    'src/webview/replay.tsx',
    'src/webview/simulator.tsx',
    'src/webview/analytics.tsx',
  ],
  outdir: 'dist/webview',
  entryNames: '[name]',
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  target: ['es2020'],
  sourcemap: !prod,
  minify: true,
  logLevel: 'info',
});

console.log('extension build complete');
