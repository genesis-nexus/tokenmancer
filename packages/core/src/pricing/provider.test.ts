import { describe, expect, it } from 'vitest';
import { CREDIT_USD, MODELS } from './models.js';
import {
  CLAUDE_WEB_SEARCH_USD,
  type UsageCounts,
  claudeModelIdFor,
  claudeProvider,
  contextWindowForProvider,
  copilotProvider,
  providerFor,
} from './provider.js';

const zero: UsageCounts = { fresh: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0 };

describe('claude model resolution', () => {
  it('canonicalises the wire ids Claude Code actually writes', () => {
    expect(claudeModelIdFor('claude-opus-5')).toBe('claude-opus-5');
    expect(claudeModelIdFor('claude-sonnet-5')).toBe('claude-sonnet-5');
    expect(claudeModelIdFor('claude-haiku-4-5-20251001')).toBe('claude-haiku-4.5');
    expect(claudeModelIdFor('claude-opus-4-8')).toBe('claude-opus-4.8');
    expect(claudeModelIdFor('claude-fable-5')).toBe('claude-fable-5');
  });

  it('returns null for records that name no real model', () => {
    // Claude Code writes these for non-API turns; billing them would invent spend.
    expect(claudeModelIdFor('<synthetic>')).toBeNull();
    expect(claudeModelIdFor('')).toBeNull();
    expect(claudeModelIdFor(null)).toBeNull();
    expect(claudeModelIdFor('gpt-4.1')).toBeNull();
  });

  it('prices an unknown Opus revision as the current one rather than guessing low', () => {
    expect(claudeModelIdFor('claude-opus-9-20991231')).toBe('claude-opus-5');
  });
});

describe('claude pricing', () => {
  it('bills the four token lines at list rates', () => {
    // Sonnet 5: $3 in / $15 out per 1M. Cache read 0.1x, 5m write 1.25x, 1h write 2x.
    const { usd } = claudeProvider.price(
      {
        ...zero,
        fresh: 1_000_000,
        cacheRead: 1_000_000,
        cacheWrite5m: 1_000_000,
        cacheWrite1h: 1_000_000,
        output: 1_000_000,
      },
      'claude-sonnet-5',
    );
    // 3 + 0.3 + 3.75 + 6 + 15
    expect(usd).toBeCloseTo(28.05, 6);
  });

  it('separates the two cache-write tiers', () => {
    const fiveMin = claudeProvider.price({ ...zero, cacheWrite5m: 1_000_000 }, 'claude-opus-5');
    const oneHour = claudeProvider.price({ ...zero, cacheWrite1h: 1_000_000 }, 'claude-opus-5');
    expect(fiveMin.usd).toBeCloseTo(6.25, 6); // 5 x 1.25
    expect(oneHour.usd).toBeCloseTo(10, 6); // 5 x 2
    // The whole point of the split: an hour-TTL write costs 1.6x a five-minute one.
    expect(oneHour.usd / fiveMin.usd).toBeCloseTo(1.6, 6);
  });

  it('bills server-side web search per request, not per token', () => {
    const { usd } = claudeProvider.price({ ...zero, webSearches: 250 }, 'claude-opus-5');
    expect(usd).toBeCloseTo(250 * CLAUDE_WEB_SEARCH_USD, 8);
    expect(usd).toBeCloseTo(2.5, 8); // $10 per 1,000
  });

  it('reports cost and usd identically, because its unit IS usd', () => {
    const p = claudeProvider.price({ ...zero, output: 500_000 }, 'claude-haiku-4.5');
    expect(p.cost).toBe(p.usd);
    expect(p.usd).toBeCloseTo(2.5, 6); // 0.5M x $5/1M
  });
});

describe('copilot adapter', () => {
  it('is a view over the existing rate table, not a second copy', () => {
    for (const [id, rate] of Object.entries(MODELS)) {
      const spec = copilotProvider.models[id];
      expect(spec?.rates.in).toBe(rate.in);
      expect(spec?.rates.cacheRead).toBe(rate.cached);
      expect(spec?.rates.out).toBe(rate.out);
      // One quoted cache-write rate, reported for both TTLs.
      expect(spec?.rates.cacheWrite5m).toBe(rate.cw);
      expect(spec?.rates.cacheWrite1h).toBe(rate.cw);
    }
  });

  it('converts credits to the shared usd axis at 1 AIC = $0.01', () => {
    const { cost, usd } = copilotProvider.price({ ...zero, fresh: 1_000_000 }, 'claude-sonnet-4.6');
    expect(cost).toBe(MODELS['claude-sonnet-4.6'].in);
    expect(usd).toBeCloseTo(cost * CREDIT_USD, 10);
  });
});

describe('provider-aware context windows', () => {
  it('does not price a Claude model through the Copilot table', () => {
    // The bug this exists to prevent: Copilot's table has no Opus 5 row, so a
    // fuzzy match lands on a 200k window and reports context pressure 5x high.
    expect(contextWindowForProvider('claude', 'claude-opus-5')).toBe(1_000_000);
    expect(contextWindowForProvider('copilot', 'claude-opus-4.8')).toBe(200_000);
  });

  it('falls back to Copilot for an unknown provider id', () => {
    expect(providerFor(undefined).id).toBe('copilot');
    expect(providerFor('nonsense').id).toBe('copilot');
    expect(providerFor('claude').id).toBe('claude');
  });
});
