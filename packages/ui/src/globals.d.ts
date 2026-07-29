// CSS imported from a surface entry is bundled by esbuild into a sibling .css file.
declare module '*.css';

interface Window {
  /** Injected by the web-app server shell: per-run token for SSE + /api calls. */
  __CTE__?: { token?: string };
}
