/**
 * AnalyticsDashboard - Main analytics view component.
 */

import { CREDIT_USD, type TrendDataPoint } from '@cte/core';
import type { JSX } from 'preact';
import { fmtCr, fmtTok } from '../../format.js';
import {
  analyticsError,
  analyticsInsights,
  analyticsState,
  contextFillRatePct,
  formattedDuration,
  selectedTimeWindow,
  toolUsageRatePct,
  workspaceAnalytics,
} from '../../state/analytics-store.js';
import { skillMode } from '../../state/skill-store.js';
import { ANALYTICS_LESSONS, LearnCard, MoreDetail } from '../LearnCard.js';
import { SkillToggle } from '../SkillToggle.js';
import { InsightsList } from './InsightsList.js';
import { ActivityByHour, ContextPressurePanel, ModelSwitchPanel } from './InteractionPanels.js';
import { MetricCard, type MetricDelta, MetricGrid } from './MetricCard.js';
import { TrendChart } from './TrendChart.js';
import { ModelBreakdown, StepKindBreakdown, ToolBreakdown } from './UsageBreakdown.js';

export interface AnalyticsDashboardProps {
  workspaceName: string;
  onTimeWindowChange?: (days: number) => void;
  onRefresh?: () => void;
}

export function AnalyticsDashboard({
  workspaceName,
  onTimeWindowChange,
  onRefresh,
}: AnalyticsDashboardProps): JSX.Element {
  const state = analyticsState.value;
  const error = analyticsError.value;
  const analytics = workspaceAnalytics.value;
  const insights = analyticsInsights.value;
  const timeWindow = selectedTimeWindow.value;

  if (state === 'loading') {
    return (
      <div class="analytics-dashboard loading">
        <div class="analytics-loading">
          <div class="loading-spinner" />
          <div class="loading-text">Analyzing workspace sessions...</div>
        </div>
      </div>
    );
  }

  if (state === 'error') {
    return (
      <div class="analytics-dashboard error">
        <div class="analytics-error">
          <div class="error-icon">⚠</div>
          <div class="error-text">{error ?? 'Failed to load analytics'}</div>
          {onRefresh && (
            <button type="button" class="btn" onClick={onRefresh}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!analytics || state === 'idle') {
    return (
      <div class="analytics-dashboard empty">
        <div class="analytics-empty">
          <div class="empty-icon">📊</div>
          <div class="empty-text">Select a workspace to view analytics</div>
        </div>
      </div>
    );
  }

  const costUsd = analytics.totalAic * CREDIT_USD;
  const trend = analytics.dailyTrend;
  const rangeLabel = timeWindow >= 365 ? 'All time' : `Past ${timeWindow} days`;
  const thresholdPct = (analytics.contextThreshold * 100).toFixed(0);
  const novice = skillMode.value === 'novice';

  return (
    <div class="analytics-dashboard">
      {/* Header */}
      <div class="analytics-header">
        <div class="analytics-title">
          <h2>{workspaceName}</h2>
          <span class="analytics-subtitle">Workspace analytics · {rangeLabel.toLowerCase()}</span>
        </div>
        <div class="analytics-controls">
          <SkillToggle />
          <select
            class="time-select"
            value={timeWindow}
            onChange={(e) => {
              const days = Number((e.target as HTMLSelectElement).value);
              selectedTimeWindow.value = days;
              onTimeWindowChange?.(days);
            }}
          >
            <option value={7}>Last 7 days</option>
            <option value={14}>Last 14 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>All time</option>
          </select>
          {onRefresh && (
            <button type="button" class="btn btn-icon" onClick={onRefresh} title="Refresh">
              ⟲
            </button>
          )}
        </div>
      </div>

      {/* Key metrics. The simple view swaps billing vocabulary for money and
          plain nouns, and drops the token card entirely — a raw token count is
          not a number anyone can act on until they know what a token costs. */}
      <section class="analytics-section">
        <div class="section-head">
          <h3>{novice ? 'Your numbers' : 'Key metrics'}</h3>
          <span class="section-meta">
            {novice
              ? `Over the ${rangeLabel.toLowerCase()}`
              : `Totals across ${rangeLabel.toLowerCase()}`}
          </span>
        </div>
        <MetricGrid>
          <MetricCard
            label={novice ? 'Spent' : 'Credits spent'}
            value={novice ? `$${costUsd.toFixed(2)}` : fmtCr(analytics.totalAic)}
            unit={novice ? undefined : 'cr'}
            icon="◈"
            status={costUsd > 10 ? 'warning' : 'good'}
            delta={deltaFor(trend, 'totalAic', 'sum', false)}
            comparison={
              novice ? `${fmtCr(analytics.totalAic)} credits` : `$${costUsd.toFixed(2)} USD`
            }
          />
          <MetricCard
            label={novice ? 'Chats' : 'Sessions'}
            value={analytics.totalSessions}
            icon="◷"
            status="neutral"
            delta={deltaFor(trend, 'sessionCount', 'sum')}
          />
          <MetricCard
            label={novice ? 'Things you asked for' : 'Prompt loops'}
            value={analytics.totalLoops}
            unit={novice ? undefined : 'loops'}
            icon="⟳"
            status="neutral"
            delta={deltaFor(trend, 'totalLoops', 'sum')}
          />
          {novice ? (
            <MetricCard
              label="Typical cost per ask"
              value={`$${(analytics.avgCostPerLoop * CREDIT_USD).toFixed(3)}`}
              icon="◉"
              status={analytics.avgCostPerLoop > 100 ? 'warning' : 'good'}
              comparison={`${fmtCr(analytics.avgCostPerLoop)} credits each`}
            />
          ) : (
            <MetricCard
              label="Tokens"
              value={fmtTok(analytics.totalPromptTokens + analytics.totalCompletionTokens)}
              icon="▤"
              status="neutral"
              comparison={`In ${fmtTok(analytics.totalPromptTokens)} · Out ${fmtTok(analytics.totalCompletionTokens)}`}
            />
          )}
        </MetricGrid>
      </section>

      {/* Efficiency — advanced only: cache-reuse and cost-per-loop need the
          vocabulary the Learn card is still introducing. */}
      {novice ? null : (
        <section class="analytics-section">
          <div class="section-head">
            <h3>Efficiency</h3>
            <span class="section-meta">Cost and cache behaviour</span>
          </div>
          <MetricGrid>
            <MetricCard
              label="Cache reuse"
              value={contextFillRatePct.value}
              icon="⚡"
              status={analytics.avgContextFillRate >= 0.5 ? 'good' : 'warning'}
              delta={deltaFor(trend, 'avgContextFillRate', 'mean')}
            />
            <MetricCard
              label="Tool usage"
              value={toolUsageRatePct.value}
              icon="⚒"
              status="neutral"
              comparison={`${analytics.uniqueToolCount} unique tools`}
            />
            <MetricCard
              label="Avg session"
              value={formattedDuration.value}
              icon="⏱"
              status="neutral"
              comparison={`${analytics.activeDays} active days`}
            />
            <MetricCard
              label="Cost per loop"
              value={fmtCr(analytics.avgCostPerLoop)}
              unit="cr"
              icon="◈"
              status={analytics.avgCostPerLoop > 100 ? 'warning' : 'good'}
              comparison={`${analytics.totalLlmCalls} LLM calls`}
            />
          </MetricGrid>
        </section>
      )}

      {/* Trends */}
      <section class="analytics-section">
        <div class="section-head">
          <div>
            <h3>{novice ? 'Day by day' : 'Performance trends'}</h3>
            <span class="section-sub">Hover a point for that day's numbers</span>
          </div>
          <span class="range-pill">{rangeLabel}</span>
        </div>
        {novice ? (
          <TrendChart
            data={trend}
            only={['totalAic', 'sessionCount', 'totalLoops']}
            initial="totalAic"
          />
        ) : (
          <TrendChart data={trend} />
        )}
      </section>

      {/* Interaction quality — advanced only. */}
      {novice ? null : (
        <section class="analytics-section">
          <div class="section-head">
            <h3>Interaction quality</h3>
            <span class="section-meta">How you and the agent work together</span>
          </div>
          <MetricGrid>
            <MetricCard
              label="Model switches"
              value={analytics.avgModelSwitchesPerSession.toFixed(1)}
              unit="per session"
              icon="⇄"
              status={analytics.avgModelSwitchesPerSession >= 2 ? 'warning' : 'good'}
              comparison={`${analytics.totalModelSwitches} total · ${(analytics.modelSwitchRate * 100).toFixed(0)}% of sessions`}
            />
            <MetricCard
              label={`Sessions over ${thresholdPct}% context`}
              value={analytics.sessionsOverContextThreshold}
              unit={`of ${analytics.totalSessions}`}
              icon="▰"
              status={
                analytics.contextPressureRate > 0.25
                  ? 'critical'
                  : analytics.contextPressureRate > 0
                    ? 'warning'
                    : 'good'
              }
              comparison={`${analytics.totalHighContextCalls} calls · peak ${(analytics.maxPeakContextRatio * 100).toFixed(0)}%`}
            />
            <MetricCard
              label="Steps per loop"
              value={analytics.avgStepsPerLoop.toFixed(1)}
              unit="steps"
              icon="⋯"
              status={analytics.avgStepsPerLoop > 15 ? 'warning' : 'neutral'}
              comparison={`Longest run ${analytics.maxLoopSteps} steps`}
            />
            <MetricCard
              label="Repeat tool calls"
              value={`${(analytics.repeatedToolRate * 100).toFixed(0)}%`}
              icon="⟲"
              status={analytics.repeatedToolRate > 0.2 ? 'warning' : 'good'}
              comparison={`${analytics.totalRepeatedToolCalls} of ${analytics.totalToolCalls} tool calls`}
            />
          </MetricGrid>
        </section>
      )}

      {/* Insights are already plain English and already actionable, so they are
          the one dense-view section that earns its place in the simple one. */}
      <section class="analytics-section">
        <InsightsList insights={insights} />
      </section>

      {novice ? (
        <section class="analytics-section">
          <LearnCard lessons={ANALYTICS_LESSONS} title="Learn" />
        </section>
      ) : null}

      {/* Interaction breakdowns — advanced only. */}
      {novice ? null : (
        <section class="analytics-section">
          <div class="section-head">
            <h3>Session patterns</h3>
            <span class="section-meta">
              {analytics.totalPrompts} prompts · {analytics.avgPromptChars.toFixed(0)} chars average
            </span>
          </div>
          <div class="breakdown-grid">
            <ContextPressurePanel
              buckets={analytics.contextPressureBuckets}
              threshold={analytics.contextThreshold}
              sessionsOver={analytics.sessionsOverContextThreshold}
              totalSessions={analytics.totalSessions}
              highContextCalls={analytics.totalHighContextCalls}
              maxPeakRatio={analytics.maxPeakContextRatio}
            />
            <ModelSwitchPanel
              stats={analytics.modelSwitchStats}
              totalSwitches={analytics.totalModelSwitches}
              avgPerSession={analytics.avgModelSwitchesPerSession}
            />
            <ActivityByHour hourlyActivity={analytics.hourlyActivity} />
          </div>
        </section>
      )}

      {/* Usage breakdowns — advanced only. */}
      {novice ? null : (
        <section class="analytics-section">
          <div class="section-head">
            <h3>Usage breakdown</h3>
            <span class="section-meta">Where the calls and credits go</span>
          </div>
          <div class="breakdown-grid">
            <ModelBreakdown stats={analytics.modelStats} />
            <ToolBreakdown stats={analytics.toolStats} totalSessions={analytics.totalSessions} />
            <StepKindBreakdown stats={analytics.stepKindStats} />
          </div>
        </section>
      )}

      {novice ? (
        <section class="analytics-section">
          <MoreDetail label="See cache efficiency, model switching, context pressure and the full usage breakdown" />
        </section>
      ) : null}

      {/* Footer */}
      <div class="analytics-footer">
        <span class="analytics-computed">
          {novice
            ? `Updated ${new Date(analytics.computedAt).toLocaleTimeString()}`
            : `Computed at ${new Date(analytics.computedAt).toLocaleString()}`}
        </span>
        <span class="analytics-sessions">
          Based on {analytics.totalSessions} sessions · {rangeLabel.toLowerCase()}
        </span>
      </div>
    </div>
  );
}

type NumericTrendKey = {
  [K in keyof TrendDataPoint]: TrendDataPoint[K] extends number ? K : never;
}[keyof TrendDataPoint];

/**
 * Change between the most recent active days and the equally-sized block before
 * them. Buckets exist only for days with activity, so this compares *active*
 * days rather than calendar days — returns undefined when there is too little
 * history to make an honest comparison.
 */
function deltaFor(
  trend: TrendDataPoint[],
  key: NumericTrendKey,
  mode: 'sum' | 'mean',
  upIsGood = true,
): MetricDelta | undefined {
  if (trend.length < 4) return undefined;

  const n = Math.min(7, Math.floor(trend.length / 2));
  const recent = trend.slice(-n);
  const prior = trend.slice(-2 * n, -n);
  if (prior.length === 0) return undefined;

  const reduce = (rows: TrendDataPoint[]): number => {
    const total = rows.reduce((a, r) => a + r[key], 0);
    return mode === 'mean' ? total / rows.length : total;
  };

  const before = reduce(prior);
  const after = reduce(recent);
  if (before === 0) return undefined;

  return {
    percent: ((after - before) / before) * 100,
    label: `vs prev ${n} active day${n === 1 ? '' : 's'}`,
    upIsGood,
  };
}
