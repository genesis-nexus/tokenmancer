/**
 * InsightsList - Display actionable insights from analytics.
 */

import type { AnalyticsInsight } from '@cte/core';
import type { JSX } from 'preact';

export interface InsightsListProps {
  insights: AnalyticsInsight[];
}

const INSIGHT_ICONS: Record<string, string> = {
  success: '✓',
  warning: '⚠',
  tip: '💡',
};

const INSIGHT_CLASSES: Record<string, string> = {
  success: 'insight-success',
  warning: 'insight-warning',
  tip: 'insight-tip',
};

export function InsightsList({ insights }: InsightsListProps): JSX.Element {
  if (!insights.length) {
    return (
      <div class="insights-panel empty">
        <div class="insights-title">Insights</div>
        <div class="insights-empty">Not enough data to generate insights. Keep using Copilot!</div>
      </div>
    );
  }

  return (
    <div class="insights-panel">
      <div class="insights-title">Insights & Recommendations</div>
      <div class="insights-list">
        {insights.map((insight) => (
          <div key={insight.title} class={`insight-card ${INSIGHT_CLASSES[insight.type] ?? ''}`}>
            <div class="insight-header">
              <span class="insight-icon">{INSIGHT_ICONS[insight.type] ?? '·'}</span>
              <span class="insight-title">{insight.title}</span>
            </div>
            <div class="insight-description">{insight.description}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
