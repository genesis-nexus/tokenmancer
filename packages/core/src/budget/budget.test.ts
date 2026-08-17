import { describe, expect, it } from 'vitest';
import { evaluateBudgets, periodKeyFor } from './evaluate.js';
import type { BudgetPeriod, BudgetRule, PeriodSpend, SpendSnapshot } from './types.js';

const EMPTY: PeriodSpend = { key: '', credits: 0, tokens: 0, steps: 0 };

function snap(
  over: Partial<Record<BudgetPeriod, Partial<PeriodSpend>>>,
  extra: Partial<SpendSnapshot> = {},
): SpendSnapshot {
  const byPeriod = {
    loop: { ...EMPTY },
    session: { ...EMPTY },
    day: { ...EMPTY },
    week: { ...EMPTY },
    month: { ...EMPTY },
    pool: { ...EMPTY },
  } as Record<BudgetPeriod, PeriodSpend>;
  for (const [k, v] of Object.entries(over)) {
    byPeriod[k as BudgetPeriod] = { ...byPeriod[k as BudgetPeriod], key: k, ...v };
  }
  return {
    now: Date.parse('2026-08-16T10:00:00'),
    workspaceId: 'ws1',
    byPeriod,
    poolCredits: 5000,
    creditUsd: 0.01,
    ...extra,
  };
}

function rule(over: Partial<BudgetRule> = {}): BudgetRule {
  return {
    id: 'r1',
    enabled: true,
    period: 'day',
    metric: 'credits',
    limit: 100,
    thresholds: [0.5, 0.8, 1],
    severity: 'warn',
    scope: 'global',
    ...over,
  };
}

describe('periodKeyFor', () => {
  const at = (s: string) => Date.parse(s);

  it('keys day/month/pool in local time', () => {
    const ts = at('2026-08-16T23:30:00');
    expect(periodKeyFor('day', ts)).toBe('2026-08-16');
    expect(periodKeyFor('month', ts)).toBe('2026-08');
    expect(periodKeyFor('pool', ts)).toBe('2026-08');
  });

  it('rolls the day key over at local midnight', () => {
    expect(periodKeyFor('day', at('2026-08-16T23:59:59'))).toBe('2026-08-16');
    expect(periodKeyFor('day', at('2026-08-17T00:00:00'))).toBe('2026-08-17');
  });

  it('rolls the month key over at a month boundary', () => {
    expect(periodKeyFor('month', at('2026-08-31T23:59:59'))).toBe('2026-08');
    expect(periodKeyFor('month', at('2026-09-01T00:00:00'))).toBe('2026-09');
  });

  it('computes ISO week numbers, including the year-straddling case', () => {
    // 2026-01-01 is a Thursday, so it belongs to ISO week 1 of 2026.
    expect(periodKeyFor('week', at('2026-01-01T12:00:00'))).toBe('2026-W01');
    // 2025-12-29 is the Monday of that same ISO week.
    expect(periodKeyFor('week', at('2025-12-29T12:00:00'))).toBe('2026-W01');
    expect(periodKeyFor('week', at('2026-08-16T12:00:00'))).toBe('2026-W33');
  });

  it('returns no key for the periods whose identity the caller owns', () => {
    expect(periodKeyFor('loop', Date.now())).toBe('');
    expect(periodKeyFor('session', Date.now())).toBe('');
  });
});

describe('evaluateBudgets threshold crossing', () => {
  it('fires nothing below the lowest threshold', () => {
    expect(evaluateBudgets(snap({ day: { credits: 49 } }), [rule()])).toEqual([]);
  });

  it('fires the crossed threshold', () => {
    const [d] = evaluateBudgets(snap({ day: { credits: 50 } }), [rule()]);
    expect(d?.threshold).toBe(0.5);
    expect(d?.id).toBe('r1:day:0.5');
    expect(d?.title).toBe('Past 50% of budget — today');
    expect(d?.body).toBe('50.0 cr of your 100.0 cr budget for today (50%).');
  });

  it('reports only the HIGHEST threshold crossed, never a burst', () => {
    const drafts = evaluateBudgets(snap({ day: { credits: 90 } }), [rule()]);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.threshold).toBe(0.8);
    // The title names the threshold crossed; the body names actual spend.
    expect(drafts[0]?.title).toBe('Past 80% of budget — today');
    expect(drafts[0]?.body).toContain('90.0 cr of your 100.0 cr');
  });

  it('escalates severity once the real limit is reached', () => {
    const at80 = evaluateBudgets(snap({ day: { credits: 80 } }), [rule()])[0];
    const at100 = evaluateBudgets(snap({ day: { credits: 100 } }), [rule()])[0];
    expect(at80?.severity).toBe('warn');
    expect(at100?.severity).toBe('critical');
    expect(at100?.title).toBe('Budget exceeded — today');
  });

  it('is stateless: the same crossing re-drafts identically', () => {
    const s = snap({ day: { credits: 80 } });
    expect(evaluateBudgets(s, [rule()])).toEqual(evaluateBudgets(s, [rule()]));
  });
});

describe('evaluateBudgets rule gating', () => {
  it('ignores disabled rules and non-positive limits', () => {
    const s = snap({ day: { credits: 1000 } });
    expect(evaluateBudgets(s, [rule({ enabled: false })])).toEqual([]);
    expect(evaluateBudgets(s, [rule({ limit: 0 })])).toEqual([]);
    expect(evaluateBudgets(s, [rule({ limit: -5 })])).toEqual([]);
    expect(evaluateBudgets(s, [rule({ thresholds: [] })])).toEqual([]);
  });

  it('skips a period with no active instance rather than merging under ""', () => {
    // A `loop` rule while nothing is running: credits present, key absent.
    const s = snap({});
    s.byPeriod.loop = { key: '', credits: 999, tokens: 0, steps: 0 };
    expect(evaluateBudgets(s, [rule({ period: 'loop' })])).toEqual([]);
  });

  it('applies workspace-scoped rules only to their workspace', () => {
    const s = snap({ day: { credits: 100 } });
    const scoped = rule({ scope: 'workspace', workspaceId: 'ws2' });
    expect(evaluateBudgets(s, [scoped])).toEqual([]);
    expect(evaluateBudgets(s, [{ ...scoped, workspaceId: 'ws1' }])).toHaveLength(1);
  });

  it('evaluates each rule independently', () => {
    const s = snap({ day: { credits: 100 }, month: { credits: 100 } });
    const drafts = evaluateBudgets(s, [
      rule({ id: 'a', period: 'day' }),
      rule({ id: 'b', period: 'month', limit: 1000 }),
    ]);
    expect(drafts.map((d) => d.ruleId)).toEqual(['a']);
  });
});

describe('evaluateBudgets metrics', () => {
  it('derives usd from credits via the snapshot rate', () => {
    const [d] = evaluateBudgets(snap({ month: { credits: 500 } }), [
      rule({ period: 'month', metric: 'usd', limit: 5, thresholds: [1] }),
    ]);
    expect(d?.observed).toBeCloseTo(5, 6);
    expect(d?.body).toContain('$5.00');
  });

  it('derives poolPercent from the configured pool, not a constant', () => {
    const [d] = evaluateBudgets(snap({ pool: { credits: 2500 } }), [
      rule({ period: 'pool', metric: 'poolPercent', limit: 100, thresholds: [0.5] }),
    ]);
    expect(d?.observed).toBeCloseTo(50, 6);

    const smaller = snap({ pool: { credits: 2500 } }, { poolCredits: 2500 });
    const [d2] = evaluateBudgets(smaller, [
      rule({ period: 'pool', metric: 'poolPercent', limit: 100, thresholds: [0.5] }),
    ]);
    expect(d2?.observed).toBeCloseTo(100, 6);
  });

  it('survives a zero pool without dividing by it', () => {
    const s = snap({ pool: { credits: 10 } }, { poolCredits: 0 });
    expect(evaluateBudgets(s, [rule({ period: 'pool', metric: 'poolPercent' })])).toEqual([]);
  });

  it('supports token and step metrics', () => {
    const s = snap({ session: { tokens: 1_500_000, steps: 30 } });
    const [tok] = evaluateBudgets(s, [
      rule({ period: 'session', metric: 'tokens', limit: 1_000_000, thresholds: [1] }),
    ]);
    expect(tok?.body).toContain('1.5M');
    const [steps] = evaluateBudgets(s, [
      rule({ period: 'session', metric: 'steps', limit: 20, thresholds: [1] }),
    ]);
    expect(steps?.body).toContain('30 steps');
  });
});

describe('evaluateBudgets message templates', () => {
  it('substitutes the placeholders', () => {
    const [d] = evaluateBudgets(snap({ loop: { credits: 12 } }), [
      rule({
        period: 'loop',
        limit: 5,
        thresholds: [1],
        message: '{observed} spent in {period} ({percent}% of {limit}).',
      }),
    ]);
    expect(d?.body).toBe('12.0 cr spent in this loop (240% of 5.00 cr).');
  });
});
