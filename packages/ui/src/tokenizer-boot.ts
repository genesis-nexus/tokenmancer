import { initTokenizer, isTokenizerReady } from '@cte/core';
import { useEffect, useState } from 'preact/hooks';

// The o200k ranks are a runtime asset (~2.3 MB of JSON) rather than part of the
// bundle — see core/tokenizer for why. Every browser surface fetches them from
// its own host: the VS Code webview gets an injected `vscode-webview://` URL,
// the web app serves them from /public.

// Declared locally rather than in globals.d.ts: this module is compiled by each
// consuming package's tsconfig, and not all of them include the ui globals.
declare global {
  interface Window {
    /** Injected by the VS Code webview shell: URL of the o200k ranks asset. */
    __RANKS_URL__?: string;
  }
}

function ranksUrl(): string {
  return window.__RANKS_URL__ ?? '/public/o200k_base.json';
}

/** Fetch the ranks and switch the tokenizer to exact counting. Idempotent. */
export function bootTokenizer(): Promise<void> {
  return initTokenizer(async () => {
    const res = await fetch(ranksUrl());
    if (!res.ok) throw new Error(`ranks fetch failed: ${res.status}`);
    return res.json();
  });
}

/**
 * Boot the tokenizer and re-render once it is ready, so components showing token
 * counts swap from the heuristic estimate to exact counts. Returns readiness.
 */
export function useTokenizer(): boolean {
  const [ready, setReady] = useState(isTokenizerReady());
  useEffect(() => {
    if (ready) return;
    let live = true;
    bootTokenizer().then(
      () => {
        if (live) setReady(true);
      },
      (err) => console.error('tokenmancer: could not load o200k ranks', err),
    );
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
}
