// Emit the o200k_base ranks as a standalone JSON asset.
//
// `js-tiktoken` ships the ranks as a JS module, so bundling the tokenizer inlines
// a ~2.3 MB base64 literal into the output. Minified code carrying a
// multi-megabyte opaque blob looks like a packed payload to marketplace and AV
// scanners, so every surface loads this JSON at runtime instead. Still offline —
// the file ships inside the extension/package.
//
// Usage: node tools/emit-ranks.mjs <outfile>

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

const out = process.argv[2];
if (!out) {
  console.error('usage: node tools/emit-ranks.mjs <outfile>');
  process.exit(1);
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(o200kBase));
console.log(`ranks → ${out}`);
