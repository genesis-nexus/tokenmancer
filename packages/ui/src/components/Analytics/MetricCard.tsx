/**
 * MetricCard - KPI tile: label, tinted icon badge, hero value, signed delta.
 */

import type { JSX } from 'preact';

export type MetricStatus = 'good' | 'warning' | 'critical' | 'neutral';

/** A period-over-period change, already reduced to a signed percentage. */
export interface MetricDelta {
  /** Signed percent change, e.g. -54.7. */
  percent: number;
  /** What it is measured against, e.g. "vs prev 7 days". */
  label: string;
  /** Whether an increase is the good direction. Omit for a neutral metric. */
  upIsGood?: boolean;
}

export interface MetricCardProps {
  label: string;
  value: string | number;
  unit?: string;
  /** Secondary line shown when there is no delta to show. */
  comparison?: string;
  delta?: MetricDelta;
  status?: MetricStatus;
  /** Single glyph for the badge. */
  icon?: string;
}

export function MetricCard({
  label,
  value,
  unit,
  comparison,
  delta,
  status = 'neutral',
  icon,
}: MetricCardProps): JSX.Element {
  return (
    <div class={`metric-card metric-${status}`}>
      <div class="metric-header">
        <span class="metric-label">{label}</span>
        {icon && (
          <span class="metric-badge" aria-hidden="true">
            {icon}
          </span>
        )}
      </div>
      <div class="metric-value-row">
        <span class="metric-value">{value}</span>
        {unit && <span class="metric-unit">{unit}</span>}
      </div>
      {delta ? (
        <DeltaLine delta={delta} />
      ) : comparison ? (
        <div class="metric-comparison">{comparison}</div>
      ) : null}
    </div>
  );
}

function DeltaLine({ delta }: { delta: MetricDelta }): JSX.Element {
  const { percent, label, upIsGood } = delta;
  // Anything that rounds to 0.0% is shown as flat, so the arrow and the tone
  // never contradict the number printed beside them.
  const flat = Math.abs(percent) < 0.05;
  const rising = percent > 0;
  // Direction alone is not a verdict: falling cost is good, falling cache reuse
  // is not. Only tone the number when the caller says which way is up.
  const tone =
    upIsGood === undefined || flat
      ? 'delta-flat'
      : rising === upIsGood
        ? 'delta-good'
        : 'delta-bad';

  return (
    <div class={`metric-comparison metric-delta ${tone}`}>
      <span class="delta-arrow" aria-hidden="true">
        {flat ? '→' : rising ? '↗' : '↘'}
      </span>
      <span class="delta-value">{Math.abs(percent).toFixed(1)}%</span>
      <span class="delta-label">{label}</span>
    </div>
  );
}

export interface MetricGridProps {
  children: JSX.Element | JSX.Element[];
}

export function MetricGrid({ children }: MetricGridProps): JSX.Element {
  return <div class="metric-grid">{children}</div>;
}
