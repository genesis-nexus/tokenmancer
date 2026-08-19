// Budget rules and the shapes the pure evaluator consumes/produces.
//
// The evaluator in ./evaluate.ts is deliberately stateless: it takes a
// SpendSnapshot (assembled by the Node host from the ledger) plus the rule list
// and returns AlertDrafts. It has no clock — `now` rides on the snapshot — so it
// is golden-testable the same way pricing/ is.

/** The window a rule measures over. */
export type BudgetPeriod = 'loop' | 'session' | 'day' | 'week' | 'month' | 'pool';

/** What a rule measures within that window. */
export type BudgetMetric = 'credits' | 'usd' | 'poolPercent' | 'tokens' | 'steps';

export type AlertSeverity = 'info' | 'warn' | 'critical';

export type BudgetScope = 'global' | 'workspace';

export interface BudgetRule {
  /** Stable id; also the first segment of every alert identity it produces. */
  id: string;
  enabled: boolean;
  period: BudgetPeriod;
  metric: BudgetMetric;
  /** Zero or negative disables the rule as surely as `enabled: false`. */
  limit: number;
  /** Fractions of `limit` that fire an alert when crossed, e.g. [0.5, 0.8, 1]. */
  thresholds: number[];
  severity: AlertSeverity;
  scope: BudgetScope;
  /** Required when scope === 'workspace'; the rule is inert without it. */
  workspaceId?: string;
  /** Overrides the generated body. Supports {observed} {limit} {percent} {period}. */
  message?: string;
}

/** Accumulated spend for one period instance (one day, one session, one loop…). */
export interface PeriodSpend {
  /**
   * Identity of this period instance — `2026-08-16`, `2026-08`, a sessionId, a
   * groupId. Half of an alert's dedupe key, and the reason a new day starts
   * clean with no cleanup job.
   */
  key: string;
  credits: number;
  tokens: number;
  steps: number;
}

export interface SpendSnapshot {
  /** Evaluation time, injected so tests are not flaky at midnight. */
  now: number;
  /** Workspace the spend belongs to; gates `scope: 'workspace'` rules. */
  workspaceId: string;
  byPeriod: Record<BudgetPeriod, PeriodSpend>;
  /** From config, not the POOL const — a seat's pool is configurable. */
  poolCredits: number;
  creditUsd: number;
}

/**
 * A candidate alert. Becomes an AlertEvent only after the Node host's
 * dedupe/cooldown filter has had a say — the evaluator has no memory, so it
 * will happily re-draft the same crossing on every step.
 */
export interface AlertDraft {
  /** `${ruleId}:${periodKey}:${threshold}` — the dedupe identity. */
  id: string;
  ruleId: string;
  periodKey: string;
  threshold: number;
  period: BudgetPeriod;
  metric: BudgetMetric;
  severity: AlertSeverity;
  observed: number;
  limit: number;
  title: string;
  body: string;
}
