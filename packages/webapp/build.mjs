import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { build } from 'esbuild';

const prod = process.argv.includes('--production');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/public', { recursive: true });

// o200k ranks as a served asset instead of a ~2.3 MB blob inlined into the
// browser bundles — see core/tokenizer. Fetched by the surfaces at runtime.
execFileSync('node', ['../../tools/emit-ranks.mjs', 'dist/public/o200k_base.json'], {
  stdio: 'inherit',
});

// 1) Node server — single self-contained ESM file.
await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/server.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  banner: { js: '#!/usr/bin/env node' },
  sourcemap: !prod,
  minify: prod,
  logLevel: 'info',
});

// 2) Browser surfaces — Preact + shared UI, tokenizer bundled offline. Each entry
//    emits <name>.js and <name>.css into dist/public (served by the server).
await build({
  entryPoints: [
    '../ui/src/surfaces/live.tsx',
    '../ui/src/surfaces/replay.tsx',
    '../ui/src/surfaces/simulator.tsx',
    '../ui/src/surfaces/analytics.tsx',
  ],
  outdir: 'dist/public',
  entryNames: '[name]',
  bundle: true,
  platform: 'browser',
  format: 'esm',
  jsx: 'automatic',
  jsxImportSource: 'preact',
  target: ['es2020'],
  sourcemap: !prod,
  minify: true,
  logLevel: 'info',
});

// 3) Static brand assets. Copied rather than bundled: the favicon is fetched by
//    the browser from a <link>, not imported by any module.
copyFileSync('../ui/src/brand/favicon.svg', 'dist/public/favicon.svg');

console.log('webapp build complete');
