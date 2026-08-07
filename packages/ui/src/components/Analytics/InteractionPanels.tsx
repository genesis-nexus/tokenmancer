/**
 * InteractionPanels - The "how you work with the agent" half of the dashboard:
 * context pressure, model switching and time-of-day activity.
 */

import type { ContextPressureBucket, ModelSwitchStats } from '@cte/core';
import type { JSX } from 'preact';
import { shortModel } from '../../format.js';

export interface ContextPressurePanelProps {
  buckets: ContextPressureBucket[];
  /** Threshold as a ratio, e.g. 0.8. */
  threshold: number;
  sessionsOver: number;
  totalSessions: number;
  highContextCalls: number;
  maxPeakRatio: number;
}

/**
 * Distribution of sessions by how full their context got at peak. Ordered bands,
 * so the bars use the ordinal blue ramp (light → dark with severity); the labels
 * carry the meaning, not the hue.
 */
export function ContextPressurePanel({
  buckets,
  threshold,
  sessionsOver,
  totalSessions,
  highContextCalls,
  maxPeakRatio,
}: ContextPressurePanelProps): JSX.Element {
  const thresholdPct = (threshold * 100).toFixed(0);
  const hasData = buckets.some((b) => b.sessionCount > 0);

  return (
    <div class="usage-breakdown">
      <div class="breakdown-title">Context pressure</div>
      <div class="breakdown-caption">Peak share of the model's context window, per session</div>

      {!hasData ? (
        <div class="breakdown-empty">No sessions in range</div>
      ) : (
        <>
          <div class="pressure-headline">
            <span class="pressure-figure">
              {sessionsOver}
              <span class="pressure-of">/{totalSessions}</span>
            </span>
            <span class="pressure-text">
              sessions crossed {thresholdPct}% · peak {(maxPeakRatio * 100).toFixed(0)}%
            </span>
          </div>

          <div class="breakdown-bars">
            {buckets.map((b, i) => (
              <div key={b.label} class="breakdown-item">
                <div class="breakdown-item-header">
                  <span class="breakdown-item-name">{b.label}</span>
                  <span class="breakdown-item-value">
                    {b.sessionCount} · {b.percent.toFixed(0)}%
                  </span>
                </div>
                <div class="breakdown-bar-track">
                  <div
                    class={`breakdown-bar ordinal-${i + 1}`}
                    style={{ width: `${b.percent}%` }}
                  />
                </div>
              </div>
            ))}
          </div>

          <div class="breakdown-footer">
            {highContextCalls} call{highContextCalls === 1 ? '' : 's'} ran above {thresholdPct}%
          </div>
        </>
      )}
    </div>
  );
}

export interface ModelSwitchPanelProps {
  stats: ModelSwitchStats[];
  totalSwitches: number;
  avgPerSession: number;
}

/** Which model hand-offs happen most, mid-session. */
export function ModelSwitchPanel({
  stats,
  totalSwitches,
  avgPerSession,
}: ModelSwitchPanelProps): JSX.Element {
  if (!stats.length) {
    return (
      <div class="usage-breakdown">
        <div class="breakdown-title">Model switching</div>
        <div class="breakdown-caption">Model changes inside a single session</div>
        <div class="breakdown-empty">No mid-session switches — one model per session</div>
      </div>
    );
  }

  const top = stats.slice(0, 6);

  return (
    <div class="usage-breakdown">
      <div class="breakdown-title">Model switching</div>
      <div class="breakdown-caption">Model changes inside a single session</div>

      <div class="pressure-headline">
        <span class="pressure-figure">{totalSwitches}</span>
        <span class="pressure-text">switches · {avgPerSession.toFixed(1)} per session</span>
      </div>

      <div class="breakdown-bars">
        {top.map((s) => (
          <div key={`${s.from}>${s.to}`} class="breakdown-item">
            <div class="breakdown-item-header">
              <span class="breakdown-item-name" title={`${s.from} → ${s.to}`}>
                {shortModel(s.from)} <span class="switch-arrow">→</span> {shortModel(s.to)}
              </span>
              <span class="breakdown-item-value">{s.count}×</span>
            </div>
            <div class="breakdown-bar-track">
              <div class="breakdown-bar series-1" style={{ width: `${s.percentOfSwitches}%` }} />
            </div>
          </div>
        ))}
      </div>

      {stats.length > top.length && (
        <div class="breakdown-footer">+{stats.length - top.length} more transitions</div>
      )}
    </div>
  );
}

export interface ActivityByHourProps {
  hourlyActivity: number[];
}

/** Steps by hour of day — when the developer actually leans on the agent. */
export function ActivityByHour({ hourlyActivity }: ActivityByHourProps): JSX.Element {
  const max = Math.max(...hourlyActivity, 0);

  if (max === 0) {
    return (
      <div class="usage-breakdown">
        <div class="breakdown-title">Activity by hour</div>
        <div class="breakdown-caption">Agent steps by local time of day</div>
        <div class="breakdown-empty">No activity recorded</div>
      </div>
    );
  }

  const peakHour = hourlyActivity.indexOf(max);
  const total = hourlyActivity.reduce((a, b) => a + b, 0);

  return (
    <div class="usage-breakdown">
      <div class="breakdown-title">Activity by hour</div>
      <div class="breakdown-caption">Agent steps by local time of day</div>

      <div class="pressure-headline">
        <span class="pressure-figure">{hourLabel(peakHour)}</span>
        <span class="pressure-text">
          busiest hour · {max} of {total} steps
        </span>
      </div>

      <div class="hour-columns">
        {hourlyActivity.map((count, hour) => (
          // The array is a fixed 24-slot histogram, so the hour label is the
          // column's stable identity.
          <div
            key={hourLabel(hour)}
            class={`hour-column ${hour === peakHour ? 'is-peak' : ''}`}
            title={`${hourLabel(hour)} — ${count} step${count === 1 ? '' : 's'}`}
          >
            <div
              class="hour-bar"
              style={{ height: `${Math.max((count / max) * 100, count > 0 ? 4 : 0)}%` }}
            />
          </div>
        ))}
      </div>
      <div class="hour-axis">
        <span>12a</span>
        <span>6a</span>
        <span>12p</span>
        <span>6p</span>
        <span>11p</span>
      </div>
    </div>
  );
}

function hourLabel(hour: number): string {
  if (hour === 0) return '12am';
  if (hour === 12) return '12pm';
  return hour < 12 ? `${hour}am` : `${hour - 12}pm`;
}
