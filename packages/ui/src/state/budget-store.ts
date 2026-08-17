/**
 * Budget + alert state. Alerts arrive on the same event stream as steps, so the
 * producer has already applied dedupe and cooldown — this store only has to
 * keep the last few, avoid re-showing a dismissed one, and not grow unbounded.
 */

import type { AlertEvent, BudgetRule, SpendSnapshot, TokenmancerConfig } from '@cte/core';
import { computed, signal } from '@preact/signals';

/** How many alerts stay on screen before the oldest is pushed off. */
const MAX_VISIBLE = 3;

export interface SpendSummary {
  /** Period key the figures belong to, e.g. `2026-08`. */
  periodKey: string;
  credits: number;
  /** Credits per day so far this period; 0 until there is a day of history. */
  burnRate: number;
  /** Limit in credits from the governing rule, or null when none is set. */
  limit: number | null;
  poolCredits: number;
  creditUsd: number;
  /** Month name for the period, e.g. `August`. */
  monthLabel: string;
  /** Days of the month gone, today included. */
  daysElapsed: number;
  daysInMonth: number;
  /** Whole days after today. 0 on the last of the month. */
  daysLeft: number;
  /** Spend the current rate reaches by month end. */
  projected: number;
  /**
   * Day of the month the limit runs out on at the current rate, or null when it
   * does not run out before the month does.
   */
  exhaustsOnDay: number | null;
}

export const config = signal<TokenmancerConfig | null>(null);
export const spend = signal<SpendSummary | null>(null);
export const alerts = signal<AlertEvent[]>([]);

/**
 * Whether the settings dialog is showing. A signal rather than local state
 * because the things that ask for settings — the masthead button, an alert's
 * "adjust budget" action — sit in different subtrees.
 */
export const settingsOpen = signal(false);

/** Ids the user has dismissed; a re-fired alert must not pop back up. */
const dismissed = new Set<string>();

export function pushAlert(ev: AlertEvent): void {
  if (dismissed.has(ev.id)) return;
  const rest = alerts.value.filter((a) => a.id !== ev.id);
  alerts.value = [...rest, ev].slice(-MAX_VISIBLE);
}

export function dismissAlert(id: string): void {
  dismissed.add(id);
  alerts.value = alerts.value.filter((a) => a.id !== id);
}

export function setConfig(cfg: TokenmancerConfig): void {
  config.value = cfg;
}

export function setSpend(s: SpendSummary): void {
  spend.value = s;
}

/**
 * Reduce a snapshot plus the rule list to the one number a person cares about:
 * month-to-date against the budget that governs it.
 *
 * A `pool` rule states its limit as a percentage, so it is converted to credits
 * here rather than making the bar understand two units. When several rules
 * could apply, the tightest wins — that is the one you will hit first.
 */
export function summarizeSpend(
  snapshot: SpendSnapshot,
  rules: readonly BudgetRule[],
  now = Date.now(),
): SpendSummary {
  const month = snapshot.byPeriod.month;

  let limit: number | null = null;
  for (const r of rules) {
    if (!r.enabled || r.limit <= 0) continue;
    if (r.period !== 'month' && r.period !== 'pool') continue;
    const asCredits =
      r.metric === 'poolPercent'
        ? (r.limit / 100) * snapshot.poolCredits
        : r.metric === 'usd'
          ? r.limit / (snapshot.creditUsd || 0.01)
          : r.metric === 'credits'
            ? r.limit
            : null;
    if (asCredits == null) continue;
    if (limit == null || asCredits < limit) limit = asCredits;
  }

  const d = new Date(now);
  // Day-of-month doubles as "days elapsed", which is what a burn rate needs.
  const daysElapsed = Math.max(1, d.getDate());
  // Day 0 of the next month is the last day of this one.
  const daysInMonth = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  const burnRate = month.credits / daysElapsed;

  // A non-rolling monthly pool makes the calendar, not the rolling window, the
  // thing to reason against: what matters is whether the rate clears the month.
  const projected = burnRate * daysInMonth;
  const remaining = limit == null ? Number.POSITIVE_INFINITY : limit - month.credits;
  const exhaustsOnDay =
    limit != null && burnRate > 0 && projected > limit
      ? Math.min(daysInMonth, Math.ceil(daysElapsed + Math.max(0, remaining) / burnRate))
      : null;

  return {
    periodKey: month.key,
    credits: month.credits,
    burnRate,
    limit,
    poolCredits: snapshot.poolCredits,
    creditUsd: snapshot.creditUsd,
    monthLabel: d.toLocaleDateString(undefined, { month: 'long' }),
    daysElapsed,
    daysInMonth,
    daysLeft: Math.max(0, daysInMonth - daysElapsed),
    projected,
    exhaustsOnDay,
  };
}

/** Clearing on a new session drops the banners but keeps the dismiss memory. */
export function resetAlerts(): void {
  alerts.value = [];
}

/** Fraction of the governing limit consumed, or null when no budget is set. */
export const spendRatio = computed(() => {
  const s = spend.value;
  if (!s || !s.limit) return null;
  return s.credits / s.limit;
});
