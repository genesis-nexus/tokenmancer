// One isomorphic tokenizer for Node, the browser, and the VS Code webview.
//
// Pure-JS `js-tiktoken` (NOT the wasm build): needs no `wasm-unsafe-eval`, so it
// runs under the default webview CSP. The o200k_base ranks are ~2.3 MB, so they
// are NOT bundled into the JS — a multi-megabyte base64 literal inside minified
// code trips marketplace/AV scanners as a packed payload. Instead the ranks ship
// as a plain `.json` asset and each host loads them via `initTokenizer()`: the
// extension reads the file off disk, the web app fetches it. Both stay fully
// offline — no CDN. o200k_base is the canonical encoding (the Python harness's
// first choice too), so counts match to the token.
//
// `countTokens` stays synchronous (it runs in hot loops and during render), so
// until the ranks land it falls back to `estimateTokens`. Await `initTokenizer`
// before relying on exact counts; `isTokenizerReady()` reports the state.

import { Tiktoken, type TiktokenBPE } from 'js-tiktoken/lite';

export interface Tokenizer {
  readonly name: string;
  count(text: string): number;
  encode(text: string): number[];
}

let encoder: Tiktoken | null = null;
let loading: Promise<void> | null = null;

/** How a host hands over the o200k_base ranks JSON. */
export type RanksLoader = () => Promise<TiktokenBPE>;

/**
 * Load the o200k_base ranks and switch the tokenizer to exact counting.
 * Idempotent and concurrency-safe: repeated calls share one load. On failure the
 * tokenizer stays on the heuristic estimate and the error is rethrown so the
 * host can surface it; a later call retries.
 */
export function initTokenizer(load: RanksLoader): Promise<void> {
  if (encoder) return Promise.resolve();
  if (!loading) {
    loading = load()
      .then((ranks) => {
        encoder = new Tiktoken(ranks);
      })
      .catch((err) => {
        loading = null; // allow a retry
        throw err;
      });
  }
  return loading;
}

/** True once the real ranks are loaded and counts are exact. */
export function isTokenizerReady(): boolean {
  return encoder !== null;
}

/** The canonical tokenizer used across every surface. */
export const o200k: Tokenizer = {
  name: 'o200k_base',
  count(text: string): number {
    if (!text) return 0;
    return encoder ? encoder.encode(text).length : estimateTokens(text);
  },
  encode(text: string): number[] {
    if (!text || !encoder) return [];
    return encoder.encode(text);
  },
};

/** Count tokens with the canonical encoding (estimate until the ranks load). */
export function countTokens(text: string): number {
  return o200k.count(text);
}

/**
 * Heuristic fallback (~chars/4-ish, word-aware). Used before the ranks load and
 * as a cheap estimate where exactness doesn't matter. Labelled as an estimate
 * wherever it surfaces.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const parts = text.match(/\w+|[^\w\s]/gu) ?? [];
  const sum = parts.reduce((a, w) => a + Math.max(1, w.length / 4), 0);
  return Math.max(1, Math.round(sum + 0.3 * parts.length));
}
