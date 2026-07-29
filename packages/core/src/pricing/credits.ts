import { DEFAULT_MODEL, type ModelRate, rateFor } from './models.js';

/** fresh input = prompt − cache-read − cache-write (never negative). */
export function freshInput(prompt: number, cacheRead: number, cacheWrite: number): number {
  return Math.max(0, prompt - cacheRead - cacheWrite);
}

export interface CostCounts {
  fresh: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

/**
 * Canonical billing: FOUR rate lines. This is the one true formula — the old
 * simulator's three-line version (which dropped cache-write) was a bug.
 */
export function creditsFromCounts(c: CostCounts, r: ModelRate): number {
  return (
    (c.fresh / 1e6) * r.in +
    (c.cacheRead / 1e6) * r.cached +
    (c.cacheWrite / 1e6) * r.cw +
    (c.output / 1e6) * r.out
  );
}

/** The 10% Auto-routing discount. Applies ONLY in the simulator, never to
 *  log-derived "exact" credits. */
export const AUTO_DISCOUNT = 0.9;

export interface CreditsOptions {
  model?: string;
  cachedTok?: number;
  cacheWriteTok?: number;
  /** simulator-only Auto discount; do not use on real billed calls. */
  auto?: boolean;
}

/** Convenience wrapper over {@link creditsFromCounts} for simulator-style inputs. */
export function credits(inTok: number, outTok: number, opts: CreditsOptions = {}): number {
  const r = rateFor(opts.model ?? DEFAULT_MODEL);
  const cacheRead = opts.cachedTok ?? 0;
  const cacheWrite = opts.cacheWriteTok ?? 0;
  const fresh = freshInput(inTok, cacheRead, cacheWrite);
  let c = creditsFromCounts({ fresh, cacheRead, cacheWrite, output: outTok }, r);
  if (opts.auto) c *= AUTO_DISCOUNT;
  return c;
}

export interface AicRates {
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
}

export interface UsageBlock {
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface AicResult {
  counts: { input: number; cache_read: number; cache_write: number; output: number };
  rates: AicRates;
  aic: number;
}

/**
 * Reproduce VS Code's per-call AIC from a usage block (four rate lines).
 * `prompt` already includes cache reads + writes, so fresh = prompt − read − write.
 * If `serverRates` (from copilot_usage.token_details) are supplied they win.
 */
export function aicFromUsage(
  u: UsageBlock,
  opts: { model?: string; serverRates?: AicRates } = {},
): AicResult {
  const r = rateFor(opts.model ?? DEFAULT_MODEL);
  const fresh = freshInput(u.prompt, u.cacheRead, u.cacheWrite);
  const rates: AicRates = opts.serverRates ?? {
    input: r.in,
    cache_read: r.cached,
    cache_write: r.cw,
    output: r.out,
  };
  const counts = {
    input: fresh,
    cache_read: u.cacheRead,
    cache_write: u.cacheWrite,
    output: u.completion,
  };
  const aic =
    (counts.input / 1e6) * rates.input +
    (counts.cache_read / 1e6) * rates.cache_read +
    (counts.cache_write / 1e6) * rates.cache_write +
    (counts.output / 1e6) * rates.output;
  return { counts, rates, aic };
}

// (ModelId is re-exported from ./models via the pricing barrel.)

/** One server-provided token-detail line (nano-AIU pricing). */
export interface TokenDetail {
  batch_size?: number;
  cost_per_batch?: number;
  token_count?: number;
  token_type?: string;
}

/** Exact per-call AIC summed from the log's `token_details` (nano-AIU). */
export function aicFromDetails(td: TokenDetail[]): number {
  let nano = 0;
  for (const d of td)
    nano += (d.token_count || 0) * ((d.cost_per_batch || 0) / (d.batch_size || 1e6));
  return nano / 1e9;
}

// parseAicFromText follows.

/** Parse "53.5 AIC" / "1,234.56 cr" style strings; null if none present. */
export function parseAicFromText(s: unknown): number | null {
  if (typeof s !== 'string') return null;
  const m = s.match(/([\d,]+(?:\.\d+)?)\s*(AIC|AIU|cr|credits?)/i);
  if (!m || m[1] === undefined) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
