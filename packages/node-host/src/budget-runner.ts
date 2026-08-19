// Wires the three layers together: ledger (state) → evaluator (pure) →
// alert-state (memory) → AlertEvent (delivery).
//
// The performance constraint that shapes this: `observe` runs on every step of
// a live tail, so it must not re-read the ledger. Instead the counters are
// seeded once from disk at construction — which is what makes month-to-date
// survive a restart — and then accumulated in memory.

import {
  type AlertEvent,
  type BudgetPeriod,
  type MeterEvent,
  type PeriodSpend,
  type SpendSnapshot,
  type StepEvent,
  type TokenmancerConfig,
  evaluateBudgets,
  periodKeyFor,
} from '@cte/core';
import {
  type AlertState,
  emptyAlertState,
  filterSuppressed,
  loadAlertState,
  pruneAlertState,
  saveAlertState,
} from './alert-state.js';
import { Ledger, readSpend, totalsOf } from './ledger.js';

export interface BudgetRunnerOptions {
  config: TokenmancerConfig;
  /** Scopes ledger writes and `scope: 'workspace'` rules. */
  workspaceId: string;
  /** Injectable clock so tests are not flaky at midnight. */
  now?: () => number;
  /** Set false in tests to keep alert memory in-process. */
  persistAlerts?: boolean;
  /** Set false to evaluate without recording — used by replay. */
  record?: boolean;
  onError?: (e: unknown) => void;
}

const TIME_PERIODS: BudgetPeriod[] = ['day', 'week', 'month', 'pool'];

function empty(key: string): PeriodSpend {
  return { key, credits: 0, tokens: 0, steps: 0 };
}

function add(spend: PeriodSpend, ev: StepEvent): void {
  spend.credits += ev.aic;
  spend.tokens += ev.prompt + ev.completion;
  spend.steps += 1;
}

export class BudgetRunner {
  private config: TokenmancerConfig;
  private workspaceId: string;
  private readonly now: () => number;
  private readonly persistAlerts: boolean;
  private readonly record: boolean;
  private readonly onError?: (e: unknown) => void;

  private readonly ledger = new Ledger();
  private alertState: AlertState;
  private readonly listeners = new Set<(a: AlertEvent) => void>();

  private readonly byPeriod: Record<BudgetPeriod, PeriodSpend>;
  private lastSuppressed = 0;
  private disposed = false;

  constructor(opts: BudgetRunnerOptions) {
    this.config = opts.config;
    this.workspaceId = opts.workspaceId;
    this.now = opts.now ?? (() => Date.now());
    this.persistAlerts = opts.persistAlerts !== false;
    this.record = opts.record !== false;
    this.onError = opts.onError;

    this.alertState = this.persistAlerts ? loadAlertState() : emptyAlertState();

    this.byPeriod = {
      loop: empty(''),
      session: empty(''),
      day: empty(''),
      week: empty(''),
      month: empty(''),
      pool: empty(''),
    };
    this.seedFromLedger();
  }

  /**
   * Read the current day/week/month totals off disk exactly once. This single
   * read is the difference between a budget that resets every time you close
   * the tab and one that means something.
   */
  private seedFromLedger(): void {
    const now = this.now();
    try {
      const monthStart = new Date(now);
      monthStart.setDate(1);
      monthStart.setHours(0, 0, 0, 0);
      const entries = readSpend({ from: monthStart.getTime(), to: now });

      for (const period of TIME_PERIODS) {
        const key = periodKeyFor(period, now);
        const inPeriod = entries.filter((e) => periodKeyFor(period, e.ts) === key);
        const t = totalsOf(inPeriod);
        this.byPeriod[period] = { key, ...t };
      }

      // These steps are already counted above. Marking them seen is what stops
      // a tail that replays the head of its log from counting them a second
      // time — the difference between 1.695 cr and 3.39 cr after a restart.
      this.ledger.markSeen(entries.map((e) => e.rawKey));
    } catch (e) {
      this.onError?.(e);
      for (const period of TIME_PERIODS) this.byPeriod[period] = empty(periodKeyFor(period, now));
    }

    if (this.persistAlerts) {
      pruneAlertState(
        this.alertState,
        TIME_PERIODS.map((p) => periodKeyFor(p, now)),
      );
    }
  }

  /** Roll a time period over to a fresh key when the clock crosses a boundary. */
  private rollPeriods(now: number): void {
    for (const period of TIME_PERIODS) {
      const key = periodKeyFor(period, now);
      if (this.byPeriod[period].key !== key) this.byPeriod[period] = empty(key);
    }
  }

  setConfig(config: TokenmancerConfig): void {
    this.config = config;
  }

  /** Point subsequent ledger writes at a different workspace (a new tail). */
  setWorkspace(workspaceId: string): void {
    this.workspaceId = workspaceId;
  }

  onAlert(cb: (a: AlertEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  /** Feed the runner every event; it picks out the steps it cares about. */
  observe(ev: MeterEvent): void {
    if (this.disposed || ev.kind !== 'step') return;
    const now = this.now();

    // The ledger is the arbiter of what counts. `appendStep` returns false for
    // a step this process has already recorded (or seeded from disk), and that
    // is exactly the set the in-memory counters must skip — otherwise the live
    // figure drifts away from the one a restart reconstructs.
    let isNew = true;
    if (this.record) {
      try {
        isNew = this.ledger.appendStep(ev, this.workspaceId);
      } catch (e) {
        this.onError?.(e);
      }
    }
    if (!isNew) return;

    this.rollPeriods(now);

    // A step belonging to a different loop starts that loop's tally over.
    if (this.byPeriod.loop.key !== ev.groupId) this.byPeriod.loop = empty(ev.groupId);
    if (!this.byPeriod.session.key) this.byPeriod.session = empty(ev.sessionId || 'session');

    // Loop and session are identity-keyed: whatever is being replayed is the
    // loop you are watching, so it always counts.
    add(this.byPeriod.loop, ev);
    add(this.byPeriod.session, ev);

    // Time-bucketed periods count the step only if it actually happened in the
    // period they are tracking. Replaying last month's log must not spend this
    // month's budget — the ledger row goes to the step's own month, so counting
    // it here too would make the live figure disagree with the one a restart
    // reconstructs from disk.
    for (const period of TIME_PERIODS) {
      if (periodKeyFor(period, ev.ts) === this.byPeriod[period].key) add(this.byPeriod[period], ev);
    }

    this.evaluate(now);
  }

  private evaluate(now: number): void {
    const cfg = this.config;
    if (!cfg.alerts.enabled) return;
    // Nothing enabled means nothing to do — a default install pays nothing.
    if (!cfg.budgets.rules.some((r) => r.enabled && r.limit > 0)) return;

    const drafts = evaluateBudgets(this.snapshot(now), cfg.budgets.rules);
    if (!drafts.length) return;

    const { deliver, suppressed } = filterSuppressed(drafts, this.alertState, cfg.alerts, now);
    this.lastSuppressed = suppressed;
    if (!deliver.length) return;

    if (this.persistAlerts) {
      try {
        saveAlertState(this.alertState);
      } catch (e) {
        this.onError?.(e);
      }
    }

    for (const d of deliver) {
      const alert: AlertEvent = {
        kind: 'alert',
        id: d.id,
        ts: now,
        severity: d.severity,
        title: d.title,
        body: suppressed > 0 ? `${d.body} (${suppressed} further alert(s) suppressed)` : d.body,
        ruleId: d.ruleId,
        period: d.period,
        observed: d.observed,
        limit: d.limit,
        action: { kind: 'openBudget' },
      };
      for (const cb of this.listeners) {
        try {
          cb(alert);
        } catch (e) {
          this.onError?.(e);
        }
      }
    }
  }

  snapshot(now = this.now()): SpendSnapshot {
    return {
      now,
      workspaceId: this.workspaceId,
      byPeriod: {
        loop: { ...this.byPeriod.loop },
        session: { ...this.byPeriod.session },
        day: { ...this.byPeriod.day },
        week: { ...this.byPeriod.week },
        month: { ...this.byPeriod.month },
        pool: { ...this.byPeriod.pool },
      },
      poolCredits: this.config.pricing.poolCredits,
      creditUsd: this.config.pricing.creditUsd,
    };
  }

  /** How many alerts the rate cap withheld on the last evaluation. */
  get suppressedCount(): number {
    return this.lastSuppressed;
  }

  /** Clear the per-session and per-loop tallies; the ledger-backed ones persist. */
  resetSession(): void {
    this.byPeriod.session = empty('');
    this.byPeriod.loop = empty('');
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    if (this.persistAlerts) {
      try {
        saveAlertState(this.alertState);
      } catch {
        // best effort on shutdown
      }
    }
  }
}
