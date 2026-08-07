/**
 * Analytics state store - Signals for workspace analytics data.
 */

import type { AnalyticsInsight, WorkspaceAnalytics } from '@cte/core';
import { computed, signal } from '@preact/signals';

export type AnalyticsState = 'idle' | 'loading' | 'loaded' | 'error';

export const analyticsState = signal<AnalyticsState>('idle');
export const analyticsError = signal<string | null>(null);
export const workspaceAnalytics = signal<WorkspaceAnalytics | null>(null);
export const analyticsInsights = signal<AnalyticsInsight[]>([]);
export const selectedTimeWindow = signal<number>(30);

/** Load analytics by dispatching to the set functions. */
export function setAnalytics(analytics: WorkspaceAnalytics, insights: AnalyticsInsight[]): void {
  workspaceAnalytics.value = analytics;
  analyticsInsights.value = insights;
  analyticsState.value = 'loaded';
  analyticsError.value = null;
}

export function setAnalyticsLoading(): void {
  analyticsState.value = 'loading';
  analyticsError.value = null;
}

export function setAnalyticsError(error: string): void {
  analyticsState.value = 'error';
  analyticsError.value = error;
}

export function resetAnalytics(): void {
  workspaceAnalytics.value = null;
  analyticsInsights.value = [];
  analyticsState.value = 'idle';
  analyticsError.value = null;
}

/** Computed: formatted duration string. */
export const formattedDuration = computed(() => {
  const a = workspaceAnalytics.value;
  if (!a) return '—';
  const ms = a.avgSessionDurationMs;
  if (ms < 60000) return `${(ms / 1000).toFixed(0)}s`;
  if (ms < 3600000) return `${(ms / 60000).toFixed(1)}m`;
  return `${(ms / 3600000).toFixed(1)}h`;
});

/** Computed: context fill rate as percentage string. */
export const contextFillRatePct = computed(() => {
  const a = workspaceAnalytics.value;
  if (!a) return '—';
  return `${(a.avgContextFillRate * 100).toFixed(0)}%`;
});

/** Computed: tool usage rate as percentage string. */
export const toolUsageRatePct = computed(() => {
  const a = workspaceAnalytics.value;
  if (!a) return '—';
  return `${(a.toolUsageRate * 100).toFixed(0)}%`;
});
