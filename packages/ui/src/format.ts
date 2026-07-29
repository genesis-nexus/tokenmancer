export const fmtCr = (n: number): string => n.toFixed(n < 1 ? 3 : n < 10 ? 2 : 1);

export const fmtTok = (n: number): string =>
  n >= 1000 ? `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k` : `${n}`;

export const shortModel = (m: string): string =>
  String(m || '')
    .replace(/^(claude-|gpt-|gemini-)/, '')
    .slice(0, 16);

export const fmtTime = (ts: number): string =>
  new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
