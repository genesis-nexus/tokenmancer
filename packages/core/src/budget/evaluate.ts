// The pure budget evaluator. No clock, no I/O, no memory.
//
// It answers one question: given this spend and these rules, which thresholds
// are currently crossed? Deciding whether a crossing is *new* — dedupe, cooldown,
// rate caps — belongs to the Node host, which is the only layer with state.

import type {
  AlertDraft,
  AlertSeverity,
  BudgetMetric,
  BudgetPeriod,
  BudgetRule,
  PeriodSpend,
  SpendSnapshot,
} from './types.js';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** ISO-8601 week number, computed in local time. */
function isoWeek(d: Date): { year: number; week: number } {
  const t = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dayMon0 = (t.getDay() + 6) % 7;
  t.setDate(t.getDate() - dayMon0 + 3); // the Thursday that defines the ISO year
  const isoYear = t.getFullYear();
  const jan4 = new Date(isoYear, 0, 4);
  const week1Thursday = new Date(isoYear, 0, 4 - ((jan4.getDay() + 6) % 7) + 3);
  const week = 1 + Math.round((t.getTime() - week1Thursday.getTime()) / (7 * 86_400_000));
  return { year: isoYear, week };
}

/**
 * Identity of the period instance containing `ts`, in **local time** — a "day"
 * budget bounded by UTC midnight is useless to a human.
 *
 * `loop` and `session` are not time-derived; their keys are the groupId and
 * sessionId, which only the caller knows, so this returns '' for them.
 */
export function periodKeyFor(period: BudgetPeriod, ts: number): string {
  const d = new Date(ts);
  switch (period) {
    case 'day':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    case 'week': {
      const { year, week } = isoWeek(d);
      return `${year}-W${pad(week)}`;
    }
    case 'month':
    case 'pool':
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
    default:
      return '';
  }
}

function observedFor(metric: BudgetMetric, spend: PeriodSpend, snap: SpendSnapshot): number {
  switch (metric) {
    case 'credits':
      return spend.credits;
    case 'usd':
      return spend.credits * snap.creditUsd;
    case 'poolPercent':
      return snap.poolCredits > 0 ? (spend.credits / snap.poolCredits) * 100 : 0;
    case 'tokens':
      return spend.tokens;
    case 'steps':
      return spend.steps;
  }
}

const PERIOD_LABEL: Record<BudgetPeriod, string> = {
  loop: 'this loop',
  session: 'this session',
  day: 'today',
  week: 'this week',
  month: 'this month',
  pool: 'your monthly pool',
};

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtMetric(metric: BudgetMetric, v: number): string {
  switch (metric) {
    case 'credits':
      return `${v < 10 ? v.toFixed(2) : v.toFixed(1)} cr`;
    case 'usd':
      return `$${v.toFixed(2)}`;
    case 'poolPercent':
      return `${v.toFixed(1)}%`;
    case 'tokens':
      return fmtTokens(v);
    case 'steps':
      return `${Math.round(v)} steps`;
  }
}

/**
 * Reaching the actual limit outranks reaching a warning fraction of it. This is
 * also what lets a real breach punch through the cooldown, which suppresses
 * everything below `critical`.
 */
function escalate(base: AlertSeverity): AlertSeverity {
  return base === 'info' ? 'warn' : 'critical';
}

function renderBody(rule: BudgetRule, observed: number, label: string): string {
  const observedStr = fmtMetric(rule.metric, observed);
  const limitStr = fmtMetric(rule.metric, rule.limit);
  const percent = rule.limit > 0 ? Math.round((observed / rule.limit) * 100) : 0;
  if (rule.message) {
    return rule.message
      .replaceAll('{observed}', observedStr)
      .replaceAll('{limit}', limitStr)
      .replaceAll('{percent}', String(percent))
      .replaceAll('{period}', label);
  }
  return `${observedStr} of your ${limitStr} budget for ${label} (${percent}%).`;
}

/**
 * Draft an alert for every rule whose spend has crossed one of its thresholds.
 *
 * At most one draft per rule: the **highest** threshold crossed. Going from 0 to
 * 90% in a single step should say "80%", not fire "50%" and "80%" together.
 */
export function evaluateBudgets(snap: SpendSnapshot, rules: BudgetRule[]): AlertDraft[] {
  const drafts: AlertDraft[] = [];

  for (const rule of rules) {
    if (!rule.enabled || rule.limit <= 0 || !rule.thresholds.length) continue;
    if (rule.scope === 'workspace' && rule.workspaceId !== snap.workspaceId) continue;

    const spend = snap.byPeriod[rule.period];
    // No key means the period has no instance right now — e.g. a `loop` rule
    // while nothing is running. Charging it to '' would merge every loop.
    if (!spend || !spend.key) continue;

    const observed = observedFor(rule.metric, spend, snap);
    const ratio = observed / rule.limit;

    let highest = 0;
    for (const t of rule.thresholds) if (ratio >= t && t > highest) highest = t;
    if (!highest) continue;

    const label = PERIOD_LABEL[rule.period];
    const severity = highest >= 1 ? escalate(rule.severity) : rule.severity;
    // "Past 50%", not "50%": the body reports actual spend, which is at or
    // above the threshold, so a bare "50%" next to "(70%)" reads as a mistake.
    const title =
      highest >= 1
        ? `Budget exceeded — ${label}`
        : `Past ${Math.round(highest * 100)}% of budget — ${label}`;

    drafts.push({
      id: `${rule.id}:${spend.key}:${highest}`,
      ruleId: rule.id,
      periodKey: spend.key,
      threshold: highest,
      period: rule.period,
      metric: rule.metric,
      severity,
      observed,
      limit: rule.limit,
      title,
      body: renderBody(rule, observed, label),
    });
  }

  return drafts;
}
