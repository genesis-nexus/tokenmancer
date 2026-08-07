// THE single source of truth for the pricing model. Reconciles the five drifting
// copies that used to live in the server, three HTML files, and the Python harness
// (see plan §1). Canonical form: full model ids, four explicit rate lines, tiers.
//
// Rates are AI-Credits (AIC) per 1,000,000 tokens. 1 AIC = $0.01. Cache-write is a
// one-time premium ≈ 1.25× input (Sonnet's 375 is a known real rate); every `cw`
// below equals round(in × 1.25) except Sonnet. The monthly pool is 5,000
// non-rolling credits per seat.

export type Tier = 'Lightweight' | 'Standard' | 'Powerful' | 'Frontier';

export interface ModelRate {
  /** fresh input */
  in: number;
  /** cache-read (cheap) */
  cached: number;
  /** cache-write (one-time premium) */
  cw: number;
  /** output */
  out: number;
  tier: Tier;
}

export const MODELS = {
  'gpt-5-mini': { in: 25, cached: 2.5, cw: 31, out: 200, tier: 'Lightweight' },
  // Copilot's gpt-5.3-codex telemetry currently aligns with mini-tier economics.
  'gpt-5.3-codex': { in: 25, cached: 2.5, cw: 31, out: 200, tier: 'Lightweight' },
  'gemini-3-flash': { in: 50, cached: 5, cw: 63, out: 300, tier: 'Lightweight' },
  'claude-haiku-4.5': { in: 100, cached: 10, cw: 125, out: 500, tier: 'Lightweight' },
  'gpt-4.1': { in: 200, cached: 50, cw: 250, out: 800, tier: 'Standard' },
  'claude-sonnet-4.6': { in: 300, cached: 30, cw: 375, out: 1500, tier: 'Powerful' },
  'gemini-3.1-pro': { in: 200, cached: 20, cw: 250, out: 1200, tier: 'Powerful' },
  'claude-opus-4.8': { in: 500, cached: 50, cw: 625, out: 2500, tier: 'Frontier' },
  'gpt-5.5': { in: 500, cached: 50, cw: 625, out: 3000, tier: 'Frontier' },
} satisfies Record<string, ModelRate>;

export type ModelId = keyof typeof MODELS;

/**
 * Nominal context window (total input tokens) per model, used to turn a call's
 * `prompt` count into a "how full was the context" ratio. These are the published
 * windows, not Copilot's per-request cap — which is lower and not exposed in the
 * logs — so treat the ratio as a pressure signal, not an exact fill gauge.
 */
export const CONTEXT_WINDOWS = {
  'gpt-5-mini': 128_000,
  'gpt-5.3-codex': 272_000,
  'gemini-3-flash': 1_000_000,
  'claude-haiku-4.5': 200_000,
  'gpt-4.1': 1_000_000,
  'claude-sonnet-4.6': 200_000,
  'gemini-3.1-pro': 1_000_000,
  'claude-opus-4.8': 200_000,
  'gpt-5.5': 272_000,
} satisfies Record<ModelId, number>;

/** Credits in the non-rolling monthly seat pool. */
export const POOL = 5000;
/** USD per AI-Credit. */
export const CREDIT_USD = 0.01;

export const DEFAULT_MODEL: ModelId = 'claude-sonnet-4.6';

/**
 * Fuzzy-match a model name (as it appears in a log) to a rate row. Tolerant of
 * separators and vendor prefixes; falls back to `fallback` (default Sonnet).
 */
export function rateFor(
  model: string | null | undefined,
  fallback: ModelId = DEFAULT_MODEL,
): ModelRate {
  return MODELS[modelIdFor(model, fallback)];
}

/**
 * The same fuzzy match as `rateFor`, but returns the canonical id — so callers
 * that need something other than the rate row (context window, tier) resolve a
 * log's model name through exactly one table.
 */
export function modelIdFor(
  model: string | null | undefined,
  fallback: ModelId = DEFAULT_MODEL,
): ModelId {
  const n = String(model ?? '')
    .toLowerCase()
    .replace(/[-_ .]/g, '');
  if (n.includes('opus')) return 'claude-opus-4.8';
  if (n.includes('sonnet')) return 'claude-sonnet-4.6';
  if (n.includes('haiku')) return 'claude-haiku-4.5';
  if (n.includes('codex')) return 'gpt-5.3-codex';
  if (n.includes('gpt5mini') || n.includes('gpt5.mini')) return 'gpt-5-mini';
  if (n.includes('gpt55') || n.includes('gpt5.5')) return 'gpt-5.5';
  if (n.includes('gpt41')) return 'gpt-4.1';
  if (n.includes('flash')) return 'gemini-3-flash';
  if (n.includes('gemini')) return 'gemini-3.1-pro';
  return fallback;
}

/** Nominal context window for a log's model name. */
export function contextWindowFor(
  model: string | null | undefined,
  fallback: ModelId = DEFAULT_MODEL,
): number {
  return CONTEXT_WINDOWS[modelIdFor(model, fallback)];
}
