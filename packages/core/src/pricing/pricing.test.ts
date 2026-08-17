import { describe, expect, it } from 'vitest';
import { aicFromDetails, aicFromUsage, credits, parseAicFromText } from './credits.js';
import { MODELS, POOL, rateFor } from './models.js';

// Golden-lock: these reproduce the numbers the Python harness (proof/) proves.
// Changing the pricing table without updating these fails CI — that is the point.

describe('pricing golden: exp0 reference table (800 in / 400 out)', () => {
  const cases: Array<[string, number]> = [
    ['gpt-5-mini', 0.1],
    ['gpt-4.1', 0.48],
    ['claude-sonnet-4.6', 0.84],
    ['claude-opus-4.8', 1.4],
    ['gpt-5.5', 1.6],
  ];
  for (const [model, expected] of cases) {
    it(`${model} => ${expected}`, () => {
      expect(credits(800, 400, { model })).toBeCloseTo(expected, 6);
    });
  }
});

describe('pricing golden: exp12 real Copilot call (four rate lines)', () => {
  it('reproduces the Sonnet usage block to 1.943925 AIC', () => {
    const { counts, aic } = aicFromUsage(
      { prompt: 45882, completion: 210, cacheRead: 45150, cacheWrite: 731 },
      { model: 'claude-sonnet-4.6' },
    );
    expect(counts.input).toBe(1); // fresh = 45882 − 45150 − 731
    expect(aic).toBeCloseTo(1.943925, 6);
    // ...and within a rounding hair of the real VS Code copilotUsage line (1.940).
    expect(Math.abs(aic - 1.94)).toBeLessThan(0.01);
  });
});

describe('pricing modifiers and helpers', () => {
  it('applies the 10% Auto discount only when asked (simulator-only)', () => {
    expect(credits(800, 400, { model: 'claude-sonnet-4.6' })).toBeCloseTo(0.84, 6);
    expect(credits(800, 400, { model: 'claude-sonnet-4.6', auto: true })).toBeCloseTo(0.756, 6);
  });

  it('bills cache-write as a fourth line (the old 3-line formula dropped it)', () => {
    // 1M cache-write tokens on Sonnet (cw=375/M) => 375 credits (0 if the line is dropped).
    const { aic } = aicFromUsage(
      { prompt: 1_000_000, completion: 0, cacheRead: 0, cacheWrite: 1_000_000 },
      { model: 'claude-sonnet-4.6' },
    );
    expect(aic).toBeCloseTo(375, 6);
  });

  it('prefers server-provided token_details rates', () => {
    expect(aicFromDetails([{ token_count: 1e9, cost_per_batch: 2, batch_size: 1 }])).toBe(2);
  });

  it('parses AIC out of free text, or returns null', () => {
    expect(parseAicFromText('1.94 AIC (1,940,000 nano-AIU)')).toBeCloseTo(1.94, 6);
    expect(parseAicFromText('1,234.56 cr')).toBeCloseTo(1234.56, 6);
    expect(parseAicFromText('no credits here')).toBeNull();
    expect(parseAicFromText(42)).toBeNull();
  });
});

describe('rateFor fuzzy matching + table invariants', () => {
  it('matches vendor-prefixed and spaced names to the right row', () => {
    expect(rateFor('Claude Sonnet 4.6')).toBe(MODELS['claude-sonnet-4.6']);
    expect(rateFor('gpt-5.3-codex')).toBe(MODELS['gpt-5.3-codex']);
    expect(rateFor('anything-unknown')).toBe(MODELS['claude-sonnet-4.6']); // default
  });

  it('keeps cache-write at 1.25x input except the known Sonnet rate', () => {
    for (const [id, m] of Object.entries(MODELS)) {
      const expected = id === 'claude-sonnet-4.6' ? 375 : Math.round(m.in * 1.25);
      expect(m.cw).toBe(expected);
    }
    expect(POOL).toBe(3000);
  });
});
