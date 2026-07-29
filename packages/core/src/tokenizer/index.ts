// One isomorphic tokenizer for Node, the browser, and the VS Code webview.
//
// Pure-JS `js-tiktoken` (NOT the wasm build): needs no `wasm-unsafe-eval`, so it
// runs under the default webview CSP, and the o200k_base ranks are bundled as
// data — no CDN, works offline. o200k_base is the canonical encoding (it is the
// Python harness's first choice too), so counts match to the token.

import { Tiktoken } from 'js-tiktoken/lite';
import o200kBase from 'js-tiktoken/ranks/o200k_base';

export interface Tokenizer {
  readonly name: string;
  count(text: string): number;
  encode(text: string): number[];
}

let cached: Tiktoken | null = null;
function encoder(): Tiktoken {
  if (!cached) cached = new Tiktoken(o200kBase);
  return cached;
}

/** The canonical tokenizer used across every surface. */
export const o200k: Tokenizer = {
  name: 'o200k_base',
  count(text: string): number {
    return text ? encoder().encode(text).length : 0;
  },
  encode(text: string): number[] {
    return text ? encoder().encode(text) : [];
  },
};

/** Count tokens with the canonical encoding. */
export function countTokens(text: string): number {
  return o200k.count(text);
}

/**
 * Heuristic fallback (~chars/4-ish, word-aware). Never used when the ranks are
 * bundled — kept only for resilience and as a cheap estimate where exactness
 * doesn't matter. Labelled as an estimate wherever it surfaces.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const parts = text.match(/\w+|[^\w\s]/gu) ?? [];
  const sum = parts.reduce((a, w) => a + Math.max(1, w.length / 4), 0);
  return Math.max(1, Math.round(sum + 0.3 * parts.length));
}
