// The webview entries import the shared stylesheet; esbuild bundles it to a
// sibling .css file. This ambient declaration keeps tsc happy.
declare module '*.css';
