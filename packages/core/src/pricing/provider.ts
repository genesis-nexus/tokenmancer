// The provider layer: one meter, two billing realities.
//
// Copilot bills a seat in AI-Credits; Claude Code bills tokens in USD (or draws
// down a subscription window). Rather than pick a winner, each provider declares
// its own unit and the core normalises on USD — which costs nothing, because
// 1 AIC is *defined* as $0.01. That identity is what lets a credit-denominated
// budget keep meaning exactly what it meant when a Claude step lands in the same
// ledger.
//
// This module sits ABOVE ./models.ts rather than replacing it. The Copilot rate
// table is locked to the cent by pricing.test.ts against the Python oracle in
// proof/, so the adapter reads it instead of restating it — the five-drifting-
// copies problem this repo already solved once does not get a sequel.

import { CONTEXT_WINDOWS, CREDIT_USD, MODELS, type Tier, modelIdFor } from './models.js';

export type ProviderId = 'copilot' | 'claude';

/**
 * Which transcript dialect a log file is written in. One-to-one with the
 * provider today, but named separately because a provider could plausibly gain
 * a second format without becoming a second provider.
 */
export type LogFormat = ProviderId;

/** The unit a provider bills in, plus its conversion to the shared USD axis. */
export interface CostUnit {
  id: 'aic' | 'usd';
  /** Suffix for display next to a number: 'cr' or '$'. */
  label: string;
  usdPerUnit: number;
}

export const AIC_UNIT: CostUnit = { id: 'aic', label: 'cr', usdPerUnit: CREDIT_USD };
export const USD_UNIT: CostUnit = { id: 'usd', label: '$', usdPerUnit: 1 };

/**
 * Rate lines in the provider's own unit, per 1,000,000 tokens.
 *
 * Five lines, not four: Anthropic prices a 5-minute cache write at 1.25x input
 * and a 1-hour write at 2x. Copilot has a single cache-write rate and simply
 * reports the same number for both.
 */
export interface Rates {
  in: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  out: number;
}

export interface ModelSpec {
  id: string;
  displayName: string;
  tier: Tier;
  contextWindow: number;
  rates: Rates;
}

/** Token counts for one billed call, already split by how they were charged. */
export interface UsageCounts {
  fresh: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  /** Server-side web searches, billed per request rather than per token. */
  webSearches?: number;
}

export interface PricedCall {
  /** Cost in the provider's own unit. */
  cost: number;
  /** The same cost on the shared axis. */
  usd: number;
}

export interface Provider {
  id: ProviderId;
  displayName: string;
  unit: CostUnit;
  models: Readonly<Record<string, ModelSpec>>;
  defaultModel: string;
  /**
   * Canonicalise a model string as it appears in a log.
   * Returns null for records that name no real model (Claude's `<synthetic>`),
   * which the caller must treat as "not a billable call".
   */
  resolveModel(raw: string | null | undefined): string | null;
  /** Nominal context window for a raw model string. */
  contextWindow(raw: string | null | undefined): number;
  price(counts: UsageCounts, raw: string | null | undefined): PricedCall;
}

function priceWith(rates: Rates, c: UsageCounts, perSearch: number): number {
  return (
    (c.fresh / 1e6) * rates.in +
    (c.cacheRead / 1e6) * rates.cacheRead +
    (c.cacheWrite5m / 1e6) * rates.cacheWrite5m +
    (c.cacheWrite1h / 1e6) * rates.cacheWrite1h +
    (c.output / 1e6) * rates.out +
    (c.webSearches ?? 0) * perSearch
  );
}

// --- Copilot -----------------------------------------------------------------
// A view over the existing table, not a second copy of it.

const copilotModels: Record<string, ModelSpec> = Object.fromEntries(
  Object.entries(MODELS).map(([id, r]) => [
    id,
    {
      id,
      displayName: id,
      tier: r.tier,
      contextWindow: CONTEXT_WINDOWS[id as keyof typeof CONTEXT_WINDOWS],
      // Copilot quotes one cache-write rate; both tiers report it.
      rates: { in: r.in, cacheRead: r.cached, cacheWrite5m: r.cw, cacheWrite1h: r.cw, out: r.out },
    },
  ]),
);

export const copilotProvider: Provider = {
  id: 'copilot',
  displayName: 'GitHub Copilot',
  unit: AIC_UNIT,
  models: copilotModels,
  defaultModel: 'claude-sonnet-4.6',
  resolveModel: (raw) => modelIdFor(raw),
  contextWindow: (raw) => CONTEXT_WINDOWS[modelIdFor(raw)],
  price(counts, raw) {
    const spec = copilotModels[modelIdFor(raw)];
    // Non-null: modelIdFor only ever returns a key of MODELS.
    const cost = priceWith((spec as ModelSpec).rates, counts, 0);
    return { cost, usd: cost * CREDIT_USD };
  },
};

// --- Claude ------------------------------------------------------------------
// Anthropic list pricing, USD per 1M tokens. Cache multipliers ride on the input
// rate: read 0.1x, 5-minute write 1.25x, 1-hour write 2x.

/** USD per web-search request ($10 per 1,000). */
export const CLAUDE_WEB_SEARCH_USD = 10 / 1000;

function claudeSpec(
  id: string,
  displayName: string,
  input: number,
  output: number,
  contextWindow: number,
  tier: Tier,
): ModelSpec {
  return {
    id,
    displayName,
    tier,
    contextWindow,
    rates: {
      in: input,
      cacheRead: input * 0.1,
      cacheWrite5m: input * 1.25,
      cacheWrite1h: input * 2,
      out: output,
    },
  };
}

const M = 1_000_000;

const claudeModels: Record<string, ModelSpec> = Object.fromEntries(
  [
    claudeSpec('claude-fable-5', 'Claude Fable 5', 10, 50, M, 'Frontier'),
    claudeSpec('claude-opus-5', 'Claude Opus 5', 5, 25, M, 'Frontier'),
    claudeSpec('claude-opus-4.8', 'Claude Opus 4.8', 5, 25, M, 'Frontier'),
    claudeSpec('claude-opus-4.7', 'Claude Opus 4.7', 5, 25, M, 'Frontier'),
    claudeSpec('claude-opus-4.6', 'Claude Opus 4.6', 5, 25, M, 'Frontier'),
    claudeSpec('claude-sonnet-5', 'Claude Sonnet 5', 3, 15, M, 'Powerful'),
    claudeSpec('claude-sonnet-4.6', 'Claude Sonnet 4.6', 3, 15, M, 'Powerful'),
    claudeSpec('claude-haiku-4.5', 'Claude Haiku 4.5', 1, 5, 200_000, 'Lightweight'),
  ].map((s) => [s.id, s]),
);

/**
 * Claude Code writes the wire model id, sometimes with a date suffix
 * (`claude-haiku-4-5-20251001`). Normalising away separators lets one substring
 * test cover every spelling.
 */
export function claudeModelIdFor(raw: string | null | undefined): string | null {
  const n = String(raw ?? '')
    .toLowerCase()
    .replace(/[-_ .<>]/g, '');
  if (!n) return null;
  // Placeholder rows Claude Code writes for non-API turns. Not a billable call.
  if (n === 'synthetic') return null;
  if (n.includes('fable') || n.includes('mythos')) return 'claude-fable-5';
  if (n.includes('opus')) {
    if (n.includes('opus48')) return 'claude-opus-4.8';
    if (n.includes('opus47')) return 'claude-opus-4.7';
    if (n.includes('opus46')) return 'claude-opus-4.6';
    // Unknown Opus revisions price identically; name them as the current one.
    return 'claude-opus-5';
  }
  if (n.includes('sonnet')) {
    if (n.includes('sonnet46')) return 'claude-sonnet-4.6';
    return 'claude-sonnet-5';
  }
  if (n.includes('haiku')) return 'claude-haiku-4.5';
  return null;
}

export const claudeProvider: Provider = {
  id: 'claude',
  displayName: 'Claude Code',
  unit: USD_UNIT,
  models: claudeModels,
  defaultModel: 'claude-sonnet-5',
  resolveModel: claudeModelIdFor,
  contextWindow(raw) {
    const id = claudeModelIdFor(raw) ?? this.defaultModel;
    return (claudeModels[id] as ModelSpec).contextWindow;
  },
  price(counts, raw) {
    const id = claudeModelIdFor(raw) ?? this.defaultModel;
    const usd = priceWith((claudeModels[id] as ModelSpec).rates, counts, CLAUDE_WEB_SEARCH_USD);
    return { cost: usd, usd };
  },
};

// --- registry ----------------------------------------------------------------

export const PROVIDERS: Readonly<Record<ProviderId, Provider>> = {
  copilot: copilotProvider,
  claude: claudeProvider,
};

export function providerFor(id: ProviderId | string | null | undefined): Provider {
  return id === 'claude' ? claudeProvider : copilotProvider;
}

/**
 * Context window for a step, routed through its own provider. Analytics needs
 * this: asking the Copilot table for `claude-opus-5` yields a 200k window and a
 * context-pressure ratio five times too high.
 */
export function contextWindowForProvider(
  provider: ProviderId | string | null | undefined,
  model: string | null | undefined,
): number {
  return providerFor(provider).contextWindow(model);
}
