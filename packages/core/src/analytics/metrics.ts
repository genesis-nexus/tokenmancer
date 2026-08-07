/**
 * Type definitions for workspace-level analytics metrics.
 * These help users understand their Copilot interaction patterns.
 */

import type { StepKind } from '../contract/events.js';

/** Summary metrics for a single chat/agentic session. */
export interface SessionMetrics {
  sessionId: string;
  startTime: number;
  endTime: number;
  durationMs: number;

  // Cost & tokens
  totalAic: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshInput: number;

  // Structure
  loopCount: number;
  stepCount: number;
  llmCallCount: number; // excludes tool calls

  // Tool usage
  toolCallCount: number;
  uniqueTools: string[];

  // Model usage
  models: string[];
  modelCalls: Record<string, number>;
  modelAic: Record<string, number>;

  // Step kinds distribution
  stepKinds: Record<StepKind, number>;

  // Model switching — how often the developer changed model mid-session.
  /** Count of adjacent LLM calls whose model differs from the previous one. */
  modelSwitchCount: number;
  /** Directed transition counts, keyed `from>to`. */
  modelSwitchPairs: Record<string, number>;

  // Context pressure — how close each call ran to its model's window.
  /** Highest prompt/window ratio seen on any LLM call (0..1+). */
  peakContextRatio: number;
  /** Mean prompt/window ratio across LLM calls. */
  avgContextRatio: number;
  /** LLM calls whose context exceeded HIGH_CONTEXT_THRESHOLD. */
  highContextCallCount: number;
  /** True when the session crossed the threshold at least once. */
  crossedHighContext: boolean;

  // Agentic depth — how long the agent ran per prompt.
  maxLoopSteps: number;
  avgStepsPerLoop: number;

  // Rework — an immediate repeat of the same tool is usually the agent retrying.
  repeatedToolCallCount: number;

  // Prompt shape
  promptCount: number;
  avgPromptChars: number;
  /** Prompts shorter than SHORT_PROMPT_CHARS. */
  shortPromptCount: number;

  /** Steps bucketed by local hour-of-day, 24 entries. */
  hourlyActivity: number[];

  // Derived metrics
  contextFillRate: number; // cacheRead / (cacheRead + freshInput)
  avgCostPerLoop: number;
  avgTokensPerLoop: number;
}

/** Time-bucketed data point for trend charts. */
export interface TrendDataPoint {
  date: string; // ISO date string (YYYY-MM-DD)
  sessionCount: number;
  totalAic: number;
  totalLoops: number;
  avgContextFillRate: number;
  modelSwitches: number;
  highContextCalls: number;
  avgStepsPerLoop: number;
}

/** One directed model transition, e.g. sonnet → opus. */
export interface ModelSwitchStats {
  from: string;
  to: string;
  count: number;
  percentOfSwitches: number;
}

/** Sessions grouped by how full their context got at peak. */
export interface ContextPressureBucket {
  /** Inclusive lower bound of the band, as a ratio (0, 0.5, 0.8, 0.95). */
  from: number;
  /** Exclusive upper bound; Infinity for the top band. */
  to: number;
  label: string;
  sessionCount: number;
  percent: number;
}

/** Tool usage statistics. */
export interface ToolUsageStats {
  toolName: string;
  callCount: number;
  sessionCount: number; // how many sessions used this tool
  percentOfSessions: number;
}

/** Model usage statistics. */
export interface ModelUsageStats {
  model: string;
  callCount: number;
  totalAic: number;
  percentOfCalls: number;
  percentOfCost: number;
}

/** Step kind distribution. */
export interface StepKindStats {
  kind: StepKind;
  count: number;
  percent: number;
}

/** Aggregated analytics for an entire workspace. */
export interface WorkspaceAnalytics {
  workspaceId: string;
  workspaceName: string;
  computedAt: number;
  timeWindowDays: number;

  // Session overview
  totalSessions: number;
  totalLoops: number;
  totalSteps: number;
  totalLlmCalls: number;
  totalToolCalls: number;

  // Cost & tokens
  totalAic: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheRead: number;
  totalCacheWrite: number;
  totalFreshInput: number;

  // Averages
  avgSessionDurationMs: number;
  avgLoopsPerSession: number;
  avgCostPerSession: number;
  avgCostPerLoop: number;
  avgContextFillRate: number;

  // Session frequency
  sessionsPerDay: number;
  activeDays: number;

  // Tool usage
  toolUsageRate: number; // tool calls / total calls
  uniqueToolCount: number;
  toolStats: ToolUsageStats[];

  // Model distribution
  modelStats: ModelUsageStats[];

  // Step kind distribution
  stepKindStats: StepKindStats[];

  // --- Interaction quality -------------------------------------------------

  // Model switching
  totalModelSwitches: number;
  avgModelSwitchesPerSession: number;
  /** Sessions that changed model at least once. */
  sessionsWithModelSwitch: number;
  /** sessionsWithModelSwitch / totalSessions. */
  modelSwitchRate: number;
  modelSwitchStats: ModelSwitchStats[];

  // Context pressure
  /** The ratio a call must exceed to count as "high context" (0.8). */
  contextThreshold: number;
  totalHighContextCalls: number;
  /** Sessions that crossed the threshold at least once. */
  sessionsOverContextThreshold: number;
  /** sessionsOverContextThreshold / totalSessions. */
  contextPressureRate: number;
  avgPeakContextRatio: number;
  maxPeakContextRatio: number;
  contextPressureBuckets: ContextPressureBucket[];

  // Agentic depth & rework
  avgStepsPerLoop: number;
  maxLoopSteps: number;
  totalRepeatedToolCalls: number;
  /** repeated tool calls / total tool calls. */
  repeatedToolRate: number;

  // Prompt shape
  totalPrompts: number;
  avgPromptChars: number;
  /** Share of prompts shorter than SHORT_PROMPT_CHARS. */
  shortPromptRate: number;

  /** Steps bucketed by local hour-of-day, 24 entries. */
  hourlyActivity: number[];

  // Trend data (daily buckets)
  dailyTrend: TrendDataPoint[];

  // Individual session summaries (for drill-down)
  sessions: SessionMetrics[];
}

/** Insights and recommendations derived from analytics. */
export interface AnalyticsInsight {
  type: 'success' | 'warning' | 'tip';
  title: string;
  description: string;
  metric?: string;
  value?: number;
}
