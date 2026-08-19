import { fmtCr } from '../format.js';
import { type SpendSummary, spend, spendRatio } from '../state/budget-store.js';
import { skillMode } from '../state/skill-store.js';

/**
 * How the month is going, in one line. A monthly pool does not roll over, so
 * the question is never "how fast am I spending" in the abstract — it is
 * whether this rate clears the calendar. That makes the projection, not the
 * rate, the number worth printing.
 */
function paceLine(s: SpendSummary, amt: (cr: number) => string): string {
  if (s.burnRate <= 0) return '';
  if (s.limit == null) return `on pace for ${amt(s.projected)} by month end`;
  if (s.credits >= s.limit) return 'already over';
  if (s.exhaustsOnDay != null) {
    return `on pace to run out around the ${ordinal(s.exhaustsOnDay)}`;
  }
  return `on pace for ${amt(s.projected)} of ${amt(s.limit)}`;
}

function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  const suffix = { 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th';
  return `${n}${suffix}`;
}

function daysLine(s: SpendSummary): string {
  if (s.daysLeft === 0) return `last day of ${s.monthLabel}`;
  return `${s.daysLeft} day${s.daysLeft === 1 ? '' : 's'} left in ${s.monthLabel}`;
}

/**
 * Month-to-date spend against the governing budget, with the calendar it is
 * racing. Deliberately a linear projection: 44 sessions is not a training set,
 * and "you run out on the 24th" is the part anyone actually acts on.
 */
export function BudgetBar() {
  const s = spend.value;
  if (!s) return null;

  // Units follow the rest of the view: the simple readout leads with money, so
  // a credits-denominated gauge beside it reads as two different scales.
  const money = skillMode.value === 'novice';
  const amt = (cr: number): string =>
    money ? `$${(cr * s.creditUsd).toFixed(2)}` : `${fmtCr(cr)} cr`;

  const ratio = spendRatio.value;
  const pace = paceLine(s, amt);

  if (ratio == null || !s.limit) {
    return (
      <div class="budgetbar budgetbar-unset">
        <div class="budgetbar-head">
          <span class="lbl">This month</span>
          <span class="val">{amt(s.credits)}</span>
        </div>
        <div class="sub">
          {daysLine(s)} · no budget set
          {pace ? ` · ${pace}` : ''}
        </div>
      </div>
    );
  }

  const pct = Math.min(100, ratio * 100);
  // The projection escalates the tint before the spend does: a rate that
  // clearly will not clear the month is the warning worth having early.
  const overPace = s.exhaustsOnDay != null;
  const state = ratio >= 1 ? 'crit' : ratio >= 0.8 || overPace ? 'warn' : 'ok';

  return (
    <div class={`budgetbar budgetbar-${state}`}>
      <div class="budgetbar-head">
        <span class="lbl">This month</span>
        <span class="val">
          {amt(s.credits)} / {amt(s.limit)}
        </span>
      </div>
      <div class="budgetbar-track">
        <div class="budgetbar-fill" style={`width:${pct}%`} />
        {/* Where the month itself has got to. Spend behind this mark is on
            track; spend ahead of it is outrunning the calendar. */}
        {s.daysInMonth > 0 && (
          <div
            class="budgetbar-today"
            style={`left:${(s.daysElapsed / s.daysInMonth) * 100}%`}
            title={`Day ${s.daysElapsed} of ${s.daysInMonth}`}
          />
        )}
      </div>
      <div class="sub">
        {pct.toFixed(pct < 1 ? 2 : 0)}% used · {daysLine(s)}
        {pace ? ` · ${pace}` : ''}
      </div>
    </div>
  );
}
