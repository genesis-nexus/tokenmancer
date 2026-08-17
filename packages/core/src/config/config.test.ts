import { describe, expect, it } from 'vitest';
import { HIGH_CONTEXT_THRESHOLD, SHORT_PROMPT_CHARS } from '../analytics/aggregate.js';
import { CREDIT_USD, DEFAULT_MODEL, POOL } from '../pricing/models.js';
import { mergeConfig, validateConfig } from './merge.js';
import { DEFAULT_CONFIG } from './schema.js';

describe('DEFAULT_CONFIG stays pinned to the constants it replaced', () => {
  // schema.ts keeps these as literals so the config module has no dependency on
  // the pricing/analytics graph. This test is what stops the two drifting.
  it('mirrors the pricing constants', () => {
    expect(DEFAULT_CONFIG.pricing.defaultModel).toBe(DEFAULT_MODEL);
    expect(DEFAULT_CONFIG.pricing.poolCredits).toBe(POOL);
    expect(DEFAULT_CONFIG.pricing.creditUsd).toBe(CREDIT_USD);
  });

  it('mirrors the analytics thresholds', () => {
    expect(DEFAULT_CONFIG.thresholds.highContextRatio).toBe(HIGH_CONTEXT_THRESHOLD);
    expect(DEFAULT_CONFIG.thresholds.shortPromptChars).toBe(SHORT_PROMPT_CHARS);
  });

  it('ships quiet: only the pool and runaway-loop rules are on', () => {
    const on = DEFAULT_CONFIG.budgets.rules.filter((r) => r.enabled).map((r) => r.id);
    expect(on).toEqual(['pool-monthly', 'loop-runaway']);
  });
});

describe('mergeConfig layer precedence', () => {
  it('applies layers lowest-first, later layers winning', () => {
    const cfg = mergeConfig(
      { pricing: { defaultModel: 'gpt-4.1' } },
      { pricing: { defaultModel: 'claude-opus-4.8' } },
    );
    expect(cfg.pricing.defaultModel).toBe('claude-opus-4.8');
    // untouched siblings survive the merge
    expect(cfg.pricing.poolCredits).toBe(DEFAULT_CONFIG.pricing.poolCredits);
  });

  it('merges nested groups instead of replacing them', () => {
    const cfg = mergeConfig({ alerts: { channels: { notification: false } } });
    expect(cfg.alerts.channels).toEqual({ banner: true, notification: false, statusBar: true });
  });

  it('replaces arrays wholesale so a layer can remove a default rule', () => {
    const cfg = mergeConfig({
      budgets: {
        rules: [
          {
            id: 'only-mine',
            enabled: true,
            period: 'day',
            metric: 'credits',
            limit: 20,
            thresholds: [1],
            severity: 'warn',
            scope: 'global',
          },
        ],
      },
    });
    expect(cfg.budgets.rules.map((r) => r.id)).toEqual(['only-mine']);
  });

  it('does not mutate DEFAULT_CONFIG across calls', () => {
    mergeConfig({ budgets: { rules: [] } });
    expect(DEFAULT_CONFIG.budgets.rules.length).toBe(2);
    expect(mergeConfig().budgets.rules.length).toBe(2);
  });
});

describe('validateConfig never throws', () => {
  it('returns defaults and a problem for a non-object', () => {
    for (const bad of [null, 42, 'nope', [1, 2]]) {
      const { config, problems } = validateConfig(bad);
      expect(config).toEqual({});
      if (bad !== null) expect(problems.length).toBeGreaterThan(0);
      expect(mergeConfig(config)).toEqual(DEFAULT_CONFIG);
    }
  });

  it('drops unknown keys and reports them', () => {
    const { config, problems } = validateConfig({ nope: 1, pricing: { bogus: true } });
    expect(config).toEqual({});
    expect(problems).toContain('nope: unknown option (ignored)');
    expect(problems).toContain('pricing.bogus: unknown option (ignored)');
  });

  it('ignores the $schema editor affordance', () => {
    const { problems } = validateConfig({ $schema: './x.json' });
    expect(problems).toEqual([]);
  });

  it('skips a bad value but keeps its valid siblings', () => {
    const { config, problems } = validateConfig({
      pricing: { poolCredits: 'lots', creditUsd: 0.02 },
    });
    expect(config.pricing).toEqual({ creditUsd: 0.02 });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/poolCredits/);
  });

  it('rejects an out-of-range enum value', () => {
    const { config, problems } = validateConfig({ ui: { defaultDetail: 'expert' } });
    expect(config.ui).toBeUndefined();
    expect(problems[0]).toMatch(/expected one of simple \| detailed/);
    expect(validateConfig({ ui: { defaultDetail: 'detailed' } }).problems).toEqual([]);
  });

  it('enforces numeric bounds', () => {
    expect(validateConfig({ thresholds: { highContextRatio: 1.5 } }).problems[0]).toMatch(
      /above the maximum/,
    );
    expect(validateConfig({ analytics: { timeWindowDays: 0 } }).problems[0]).toMatch(
      /below the minimum/,
    );
    expect(validateConfig({ alerts: { maxPerHour: 2.5 } }).problems[0]).toMatch(/integer/);
  });
});

describe('validateConfig budget rules', () => {
  const base = {
    id: 'r1',
    period: 'day',
    metric: 'credits',
    limit: 25,
  };

  it('accepts a minimal rule and fills the defaults', () => {
    const { config, problems } = validateConfig({ budgets: { rules: [base] } });
    expect(problems).toEqual([]);
    expect(config.budgets?.rules?.[0]).toEqual({
      id: 'r1',
      enabled: true,
      period: 'day',
      metric: 'credits',
      limit: 25,
      thresholds: [0.5, 0.8, 1],
      severity: 'warn',
      scope: 'global',
    });
  });

  it('sorts thresholds ascending', () => {
    const { config } = validateConfig({
      budgets: { rules: [{ ...base, thresholds: [1, 0.25, 0.9] }] },
    });
    expect(config.budgets?.rules?.[0]?.thresholds).toEqual([0.25, 0.9, 1]);
  });

  it('drops a rule with an unknown period rather than half-merging it', () => {
    const { config, problems } = validateConfig({
      budgets: { rules: [{ ...base, period: 'fortnight' }] },
    });
    expect(config.budgets?.rules).toEqual([]);
    expect(problems[0]).toMatch(/period: expected one of/);
  });

  it('requires workspaceId when the scope is workspace', () => {
    const { config, problems } = validateConfig({
      budgets: { rules: [{ ...base, scope: 'workspace' }] },
    });
    expect(config.budgets?.rules).toEqual([]);
    expect(problems[0]).toMatch(/workspaceId: required/);
  });

  it('lets a later rule with the same id replace an earlier one', () => {
    const { config, problems } = validateConfig({
      budgets: { rules: [base, { ...base, limit: 99 }] },
    });
    expect(config.budgets?.rules).toHaveLength(1);
    expect(config.budgets?.rules?.[0]?.limit).toBe(99);
    expect(problems[0]).toMatch(/duplicate rule id/);
  });
});
