/**
 * Aggregation functions to compute analytics metrics from raw session events.
 */

import type { MeterEvent, StepEvent, StepKind } from '../contract/events.js';
import { contextWindowFor } from '../pricing/models.js';
import type {
  AnalyticsInsight,
  ContextPressureBucket,
  ModelSwitchStats,
  ModelUsageStats,
  SessionMetrics,
  StepKindStats,
  ToolUsageStats,
  TrendDataPoint,
  WorkspaceAnalytics,
} from './metrics.js';

const STEP_KINDS: StepKind[] = ['plan', 'read', 'search', 'edit', 'tool', 'verify', 'chat', 'llm'];

/** A call using more than this share of its model's window is "high context". */
export const HIGH_CONTEXT_THRESHOLD = 0.8;

/** Prompts shorter than this are counted as terse — a common cause of extra loops. */
export const SHORT_PROMPT_CHARS = 40;

/** Bands used to group sessions by their peak context ratio. */
const CONTEXT_BANDS: Array<{ from: number; to: number; label: string }> = [
  { from: 0, to: 0.5, label: 'Under 50%' },
  { from: 0.5, to: HIGH_CONTEXT_THRESHOLD, label: '50–80%' },
  { from: HIGH_CONTEXT_THRESHOLD, to: 0.95, label: '80–95%' },
  { from: 0.95, to: Number.POSITIVE_INFINITY, label: 'Over 95%' },
];

/** `from>to` key for a directed model transition. */
const switchKey = (from: string, to: string): string => `${from}>${to}`;

function emptyHours(): number[] {
  return new Array<number>(24).fill(0);
}

/**
 * Compute summary metrics for a single session from its events.
 */
export function computeSessionMetrics(sessionId: string, events: MeterEvent[]): SessionMetrics {
  // Model-switch and tool-repeat detection both read the steps as a sequence, so
  // normalise the order here rather than trusting the producer's emit order.
  const steps = events
    .filter((e): e is StepEvent => e.kind === 'step')
    .slice()
    .sort(
      (a, b) => a.ts - b.ts || a.promptGroupIndex - b.promptGroupIndex || a.stepIndex - b.stepIndex,
    );

  if (steps.length === 0) {
    return emptySessionMetrics(sessionId);
  }

  // Time bounds
  const timestamps = steps.map((s) => s.ts);
  const startTime = Math.min(...timestamps);
  const endTime = Math.max(...timestamps);
  const durationMs = endTime - startTime;

  // Token & cost totals
  let totalAic = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalFreshInput = 0;

  // Counts
  let llmCallCount = 0;
  let toolCallCount = 0;
  const loopIds = new Set<string>();
  const tools = new Set<string>();
  const models = new Set<string>();
  const modelCalls: Record<string, number> = {};
  const modelAic: Record<string, number> = {};
  const stepKinds: Record<StepKind, number> = {} as Record<StepKind, number>;
  for (const k of STEP_KINDS) stepKinds[k] = 0;

  // Sequence-derived signals.
  let modelSwitchCount = 0;
  const modelSwitchPairs: Record<string, number> = {};
  let previousModel = '';
  let repeatedToolCallCount = 0;
  let previousToolName = '';

  // Context pressure.
  let peakContextRatio = 0;
  let contextRatioSum = 0;
  let contextRatioCount = 0;
  let highContextCallCount = 0;

  // Loop shape & prompts.
  const loopSteps = new Map<string, number>();
  const promptsByLoop = new Map<string, string>();
  const hourlyActivity = emptyHours();

  for (const step of steps) {
    loopIds.add(step.groupId);
    loopSteps.set(step.groupId, (loopSteps.get(step.groupId) ?? 0) + 1);
    if (step.userPrompt && !promptsByLoop.has(step.groupId)) {
      promptsByLoop.set(step.groupId, step.userPrompt);
    }
    const hour = new Date(step.ts).getHours();
    hourlyActivity[hour] = (hourlyActivity[hour] ?? 0) + 1;

    totalAic += step.aic;
    totalPromptTokens += step.prompt;
    totalCompletionTokens += step.completion;
    totalCacheRead += step.cacheRead;
    totalCacheWrite += step.cacheWrite;
    totalFreshInput += step.freshInput;

    if (step.isTool) {
      toolCallCount++;
      if (step.toolName) {
        tools.add(step.toolName);
        // Back-to-back calls to the same tool are the agent retrying the same
        // move — the cheapest available proxy for rework.
        if (step.toolName === previousToolName) repeatedToolCallCount++;
        previousToolName = step.toolName;
      }
    } else {
      llmCallCount++;
      previousToolName = '';
      if (step.model) {
        models.add(step.model);
        modelCalls[step.model] = (modelCalls[step.model] ?? 0) + 1;
        modelAic[step.model] = (modelAic[step.model] ?? 0) + step.aic;

        if (previousModel && previousModel !== step.model) {
          modelSwitchCount++;
          const key = switchKey(previousModel, step.model);
          modelSwitchPairs[key] = (modelSwitchPairs[key] ?? 0) + 1;
        }
        previousModel = step.model;
      }

      // Context pressure is only meaningful for billed LLM calls: a tool step
      // carries no prompt of its own.
      const window = contextWindowFor(step.model);
      if (window > 0 && step.prompt > 0) {
        const ratio = step.prompt / window;
        contextRatioSum += ratio;
        contextRatioCount++;
        if (ratio > peakContextRatio) peakContextRatio = ratio;
        if (ratio > HIGH_CONTEXT_THRESHOLD) highContextCallCount++;
      }
    }

    if (step.stepKind && STEP_KINDS.includes(step.stepKind)) {
      stepKinds[step.stepKind]++;
    }
  }

  const loopCount = loopIds.size;
  const contextFillRate =
    totalCacheRead + totalFreshInput > 0 ? totalCacheRead / (totalCacheRead + totalFreshInput) : 0;

  const stepCounts = [...loopSteps.values()];
  const prompts = [...promptsByLoop.values()];
  const promptChars = prompts.reduce((a, p) => a + p.length, 0);

  return {
    sessionId,
    startTime,
    endTime,
    durationMs,
    totalAic,
    totalPromptTokens,
    totalCompletionTokens,
    totalCacheRead,
    totalCacheWrite,
    totalFreshInput,
    loopCount,
    stepCount: steps.length,
    llmCallCount,
    toolCallCount,
    uniqueTools: [...tools],
    models: [...models],
    modelCalls,
    modelAic,
    stepKinds,
    modelSwitchCount,
    modelSwitchPairs,
    peakContextRatio,
    avgContextRatio: contextRatioCount > 0 ? contextRatioSum / contextRatioCount : 0,
    highContextCallCount,
    crossedHighContext: highContextCallCount > 0,
    maxLoopSteps: stepCounts.length > 0 ? Math.max(...stepCounts) : 0,
    avgStepsPerLoop: loopCount > 0 ? steps.length / loopCount : 0,
    repeatedToolCallCount,
    promptCount: prompts.length,
    avgPromptChars: prompts.length > 0 ? promptChars / prompts.length : 0,
    shortPromptCount: prompts.filter((p) => p.length < SHORT_PROMPT_CHARS).length,
    hourlyActivity,
    contextFillRate,
    avgCostPerLoop: loopCount > 0 ? totalAic / loopCount : 0,
    avgTokensPerLoop: loopCount > 0 ? (totalPromptTokens + totalCompletionTokens) / loopCount : 0,
  };
}

function emptySessionMetrics(sessionId: string): SessionMetrics {
  const stepKinds: Record<StepKind, number> = {} as Record<StepKind, number>;
  for (const k of STEP_KINDS) stepKinds[k] = 0;
  return {
    sessionId,
    startTime: 0,
    endTime: 0,
    durationMs: 0,
    totalAic: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalFreshInput: 0,
    loopCount: 0,
    stepCount: 0,
    llmCallCount: 0,
    toolCallCount: 0,
    uniqueTools: [],
    models: [],
    modelCalls: {},
    modelAic: {},
    stepKinds,
    modelSwitchCount: 0,
    modelSwitchPairs: {},
    peakContextRatio: 0,
    avgContextRatio: 0,
    highContextCallCount: 0,
    crossedHighContext: false,
    maxLoopSteps: 0,
    avgStepsPerLoop: 0,
    repeatedToolCallCount: 0,
    promptCount: 0,
    avgPromptChars: 0,
    shortPromptCount: 0,
    hourlyActivity: emptyHours(),
    contextFillRate: 0,
    avgCostPerLoop: 0,
    avgTokensPerLoop: 0,
  };
}

/**
 * Aggregate multiple session metrics into workspace-level analytics.
 */
export function computeWorkspaceAnalytics(
  workspaceId: string,
  workspaceName: string,
  sessions: SessionMetrics[],
  timeWindowDays = 30,
): WorkspaceAnalytics {
  const now = Date.now();
  const cutoff = now - timeWindowDays * 24 * 60 * 60 * 1000;

  // Filter sessions within time window
  const recentSessions = sessions.filter((s) => s.startTime >= cutoff || s.endTime >= cutoff);

  if (recentSessions.length === 0) {
    return emptyWorkspaceAnalytics(workspaceId, workspaceName, timeWindowDays, sessions);
  }

  // Aggregate totals
  let totalLoops = 0;
  let totalSteps = 0;
  let totalLlmCalls = 0;
  let totalToolCalls = 0;
  let totalAic = 0;
  let totalPromptTokens = 0;
  let totalCompletionTokens = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let totalFreshInput = 0;
  let totalDurationMs = 0;
  let contextFillRateSum = 0;

  const allTools = new Map<string, { callCount: number; sessions: Set<string> }>();
  const allModels = new Map<string, { callCount: number; aic: number }>();
  const aggregatedStepKinds: Record<StepKind, number> = {} as Record<StepKind, number>;
  for (const k of STEP_KINDS) aggregatedStepKinds[k] = 0;

  // Interaction-quality accumulators.
  let totalModelSwitches = 0;
  let sessionsWithModelSwitch = 0;
  let totalHighContextCalls = 0;
  let sessionsOverContextThreshold = 0;
  let peakContextSum = 0;
  let maxPeakContextRatio = 0;
  let maxLoopSteps = 0;
  let totalRepeatedToolCalls = 0;
  let totalPrompts = 0;
  let promptCharSum = 0;
  let shortPromptCount = 0;
  const switchPairs = new Map<string, number>();
  const hourlyActivity = emptyHours();
  const peakRatios: number[] = [];

  // Daily buckets for trends
  const dailyBuckets = new Map<
    string,
    {
      count: number;
      aic: number;
      loops: number;
      fillRates: number[];
      switches: number;
      highContext: number;
      steps: number;
    }
  >();

  for (const s of recentSessions) {
    totalLoops += s.loopCount;
    totalSteps += s.stepCount;
    totalLlmCalls += s.llmCallCount;
    totalToolCalls += s.toolCallCount;
    totalAic += s.totalAic;
    totalPromptTokens += s.totalPromptTokens;
    totalCompletionTokens += s.totalCompletionTokens;
    totalCacheRead += s.totalCacheRead;
    totalCacheWrite += s.totalCacheWrite;
    totalFreshInput += s.totalFreshInput;
    totalDurationMs += s.durationMs;
    contextFillRateSum += s.contextFillRate;

    // Tools
    for (const tool of s.uniqueTools) {
      const existing = allTools.get(tool) ?? { callCount: 0, sessions: new Set() };
      existing.sessions.add(s.sessionId);
      allTools.set(tool, existing);
    }
    // Count tool calls from session
    // We use toolCallCount per session since we don't have per-tool counts here
    // For detailed tool stats, we'd need to track per-tool in SessionMetrics

    // Models
    for (const [model, calls] of Object.entries(s.modelCalls)) {
      const existing = allModels.get(model) ?? { callCount: 0, aic: 0 };
      existing.callCount += calls;
      existing.aic += s.modelAic[model] ?? 0;
      allModels.set(model, existing);
    }

    // Step kinds
    for (const k of STEP_KINDS) {
      aggregatedStepKinds[k] += s.stepKinds[k] ?? 0;
    }

    // Interaction quality
    totalModelSwitches += s.modelSwitchCount;
    if (s.modelSwitchCount > 0) sessionsWithModelSwitch++;
    for (const [key, count] of Object.entries(s.modelSwitchPairs)) {
      switchPairs.set(key, (switchPairs.get(key) ?? 0) + count);
    }

    totalHighContextCalls += s.highContextCallCount;
    if (s.crossedHighContext) sessionsOverContextThreshold++;
    peakContextSum += s.peakContextRatio;
    peakRatios.push(s.peakContextRatio);
    if (s.peakContextRatio > maxPeakContextRatio) maxPeakContextRatio = s.peakContextRatio;

    if (s.maxLoopSteps > maxLoopSteps) maxLoopSteps = s.maxLoopSteps;
    totalRepeatedToolCalls += s.repeatedToolCallCount;

    totalPrompts += s.promptCount;
    promptCharSum += s.avgPromptChars * s.promptCount;
    shortPromptCount += s.shortPromptCount;

    for (let h = 0; h < 24; h++) {
      hourlyActivity[h] = (hourlyActivity[h] ?? 0) + (s.hourlyActivity[h] ?? 0);
    }

    // Daily trend bucket
    const dateKey = new Date(s.startTime).toISOString().slice(0, 10);
    const bucket = dailyBuckets.get(dateKey) ?? {
      count: 0,
      aic: 0,
      loops: 0,
      fillRates: [],
      switches: 0,
      highContext: 0,
      steps: 0,
    };
    bucket.count++;
    bucket.aic += s.totalAic;
    bucket.loops += s.loopCount;
    bucket.fillRates.push(s.contextFillRate);
    bucket.switches += s.modelSwitchCount;
    bucket.highContext += s.highContextCallCount;
    bucket.steps += s.stepCount;
    dailyBuckets.set(dateKey, bucket);
  }

  const totalSessions = recentSessions.length;

  // Compute tool stats
  const toolStats: ToolUsageStats[] = [...allTools.entries()]
    .map(([toolName, data]) => ({
      toolName,
      callCount: data.callCount,
      sessionCount: data.sessions.size,
      percentOfSessions: (data.sessions.size / totalSessions) * 100,
    }))
    .sort((a, b) => b.sessionCount - a.sessionCount);

  // Compute model stats
  const totalCalls = totalLlmCalls;
  const modelStats: ModelUsageStats[] = [...allModels.entries()]
    .map(([model, data]) => ({
      model,
      callCount: data.callCount,
      totalAic: data.aic,
      percentOfCalls: totalCalls > 0 ? (data.callCount / totalCalls) * 100 : 0,
      percentOfCost: totalAic > 0 ? (data.aic / totalAic) * 100 : 0,
    }))
    .sort((a, b) => b.totalAic - a.totalAic);

  // Step kind stats
  const stepKindStats: StepKindStats[] = STEP_KINDS.map((kind) => ({
    kind,
    count: aggregatedStepKinds[kind],
    percent: totalSteps > 0 ? (aggregatedStepKinds[kind] / totalSteps) * 100 : 0,
  })).filter((s) => s.count > 0);

  // Model switch transitions, most frequent first
  const modelSwitchStats: ModelSwitchStats[] = [...switchPairs.entries()]
    .map(([key, count]) => {
      const [from = '', to = ''] = key.split('>');
      return {
        from,
        to,
        count,
        percentOfSwitches: totalModelSwitches > 0 ? (count / totalModelSwitches) * 100 : 0,
      };
    })
    .sort((a, b) => b.count - a.count);

  // Sessions grouped by peak context ratio
  const contextPressureBuckets: ContextPressureBucket[] = CONTEXT_BANDS.map((band) => {
    const sessionCount = peakRatios.filter((r) => r >= band.from && r < band.to).length;
    return {
      from: band.from,
      to: band.to,
      label: band.label,
      sessionCount,
      percent: totalSessions > 0 ? (sessionCount / totalSessions) * 100 : 0,
    };
  });

  // Daily trend
  const dailyTrend: TrendDataPoint[] = [...dailyBuckets.entries()]
    .map(([date, data]) => ({
      date,
      sessionCount: data.count,
      totalAic: data.aic,
      totalLoops: data.loops,
      avgContextFillRate:
        data.fillRates.length > 0
          ? data.fillRates.reduce((a, b) => a + b, 0) / data.fillRates.length
          : 0,
      modelSwitches: data.switches,
      highContextCalls: data.highContext,
      avgStepsPerLoop: data.loops > 0 ? data.steps / data.loops : 0,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const activeDays = dailyBuckets.size;

  return {
    workspaceId,
    workspaceName,
    computedAt: now,
    timeWindowDays,
    totalSessions,
    totalLoops,
    totalSteps,
    totalLlmCalls,
    totalToolCalls,
    totalAic,
    totalPromptTokens,
    totalCompletionTokens,
    totalCacheRead,
    totalCacheWrite,
    totalFreshInput,
    avgSessionDurationMs: totalSessions > 0 ? totalDurationMs / totalSessions : 0,
    avgLoopsPerSession: totalSessions > 0 ? totalLoops / totalSessions : 0,
    avgCostPerSession: totalSessions > 0 ? totalAic / totalSessions : 0,
    avgCostPerLoop: totalLoops > 0 ? totalAic / totalLoops : 0,
    avgContextFillRate: totalSessions > 0 ? contextFillRateSum / totalSessions : 0,
    sessionsPerDay: activeDays > 0 ? totalSessions / activeDays : 0,
    activeDays,
    toolUsageRate:
      totalLlmCalls + totalToolCalls > 0 ? totalToolCalls / (totalLlmCalls + totalToolCalls) : 0,
    uniqueToolCount: allTools.size,
    toolStats,
    modelStats,
    stepKindStats,
    totalModelSwitches,
    avgModelSwitchesPerSession: totalSessions > 0 ? totalModelSwitches / totalSessions : 0,
    sessionsWithModelSwitch,
    modelSwitchRate: totalSessions > 0 ? sessionsWithModelSwitch / totalSessions : 0,
    modelSwitchStats,
    contextThreshold: HIGH_CONTEXT_THRESHOLD,
    totalHighContextCalls,
    sessionsOverContextThreshold,
    contextPressureRate: totalSessions > 0 ? sessionsOverContextThreshold / totalSessions : 0,
    avgPeakContextRatio: totalSessions > 0 ? peakContextSum / totalSessions : 0,
    maxPeakContextRatio,
    contextPressureBuckets,
    avgStepsPerLoop: totalLoops > 0 ? totalSteps / totalLoops : 0,
    maxLoopSteps,
    totalRepeatedToolCalls,
    repeatedToolRate: totalToolCalls > 0 ? totalRepeatedToolCalls / totalToolCalls : 0,
    totalPrompts,
    avgPromptChars: totalPrompts > 0 ? promptCharSum / totalPrompts : 0,
    shortPromptRate: totalPrompts > 0 ? shortPromptCount / totalPrompts : 0,
    hourlyActivity,
    dailyTrend,
    sessions: recentSessions,
  };
}

function emptyWorkspaceAnalytics(
  workspaceId: string,
  workspaceName: string,
  timeWindowDays: number,
  allSessions: SessionMetrics[],
): WorkspaceAnalytics {
  return {
    workspaceId,
    workspaceName,
    computedAt: Date.now(),
    timeWindowDays,
    totalSessions: 0,
    totalLoops: 0,
    totalSteps: 0,
    totalLlmCalls: 0,
    totalToolCalls: 0,
    totalAic: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    totalCacheRead: 0,
    totalCacheWrite: 0,
    totalFreshInput: 0,
    avgSessionDurationMs: 0,
    avgLoopsPerSession: 0,
    avgCostPerSession: 0,
    avgCostPerLoop: 0,
    avgContextFillRate: 0,
    sessionsPerDay: 0,
    activeDays: 0,
    toolUsageRate: 0,
    uniqueToolCount: 0,
    toolStats: [],
    modelStats: [],
    stepKindStats: [],
    totalModelSwitches: 0,
    avgModelSwitchesPerSession: 0,
    sessionsWithModelSwitch: 0,
    modelSwitchRate: 0,
    modelSwitchStats: [],
    contextThreshold: HIGH_CONTEXT_THRESHOLD,
    totalHighContextCalls: 0,
    sessionsOverContextThreshold: 0,
    contextPressureRate: 0,
    avgPeakContextRatio: 0,
    maxPeakContextRatio: 0,
    contextPressureBuckets: CONTEXT_BANDS.map((b) => ({ ...b, sessionCount: 0, percent: 0 })),
    avgStepsPerLoop: 0,
    maxLoopSteps: 0,
    totalRepeatedToolCalls: 0,
    repeatedToolRate: 0,
    totalPrompts: 0,
    avgPromptChars: 0,
    shortPromptRate: 0,
    hourlyActivity: emptyHours(),
    dailyTrend: [],
    sessions: allSessions,
  };
}

/**
 * Generate actionable insights from workspace analytics.
 */
export function generateInsights(analytics: WorkspaceAnalytics): AnalyticsInsight[] {
  const insights: AnalyticsInsight[] = [];

  // Context fill rate insight
  if (analytics.avgContextFillRate >= 0.7) {
    insights.push({
      type: 'success',
      title: 'Great cache utilization',
      description: `Your average context fill rate is ${(analytics.avgContextFillRate * 100).toFixed(0)}%. You're effectively reusing cached context.`,
      metric: 'contextFillRate',
      value: analytics.avgContextFillRate,
    });
  } else if (analytics.avgContextFillRate < 0.3 && analytics.totalSessions >= 3) {
    insights.push({
      type: 'tip',
      title: 'Low cache utilization',
      description: `Your context fill rate is ${(analytics.avgContextFillRate * 100).toFixed(0)}%. Consider starting fewer new sessions and continuing existing ones to benefit from cached context.`,
      metric: 'contextFillRate',
      value: analytics.avgContextFillRate,
    });
  }

  // Session frequency
  if (analytics.sessionsPerDay > 5) {
    insights.push({
      type: 'warning',
      title: 'High session frequency',
      description: `You're starting ${analytics.sessionsPerDay.toFixed(1)} sessions per day on average. Consider consolidating work into fewer, longer sessions for better cache efficiency.`,
      metric: 'sessionsPerDay',
      value: analytics.sessionsPerDay,
    });
  }

  // Tool usage
  if (analytics.toolUsageRate > 0.5) {
    insights.push({
      type: 'success',
      title: 'Active tool usage',
      description: `${(analytics.toolUsageRate * 100).toFixed(0)}% of your interactions involve tool calls. You're leveraging agentic capabilities effectively.`,
      metric: 'toolUsageRate',
      value: analytics.toolUsageRate,
    });
  }

  // Loops per session
  if (analytics.avgLoopsPerSession > 20) {
    insights.push({
      type: 'tip',
      title: 'Deep interaction sessions',
      description: `Your sessions average ${analytics.avgLoopsPerSession.toFixed(1)} prompt loops. Consider breaking complex tasks into smaller, focused sessions.`,
      metric: 'avgLoopsPerSession',
      value: analytics.avgLoopsPerSession,
    });
  } else if (analytics.avgLoopsPerSession < 3 && analytics.totalSessions >= 5) {
    insights.push({
      type: 'tip',
      title: 'Short sessions',
      description: `Your sessions average only ${analytics.avgLoopsPerSession.toFixed(1)} loops. Try continuing conversations for related follow-up questions.`,
      metric: 'avgLoopsPerSession',
      value: analytics.avgLoopsPerSession,
    });
  }

  // Cost efficiency
  if (analytics.avgCostPerLoop > 0.5 && analytics.totalLoops >= 10) {
    insights.push({
      type: 'warning',
      title: 'High cost per loop',
      description: `Each prompt loop costs ${analytics.avgCostPerLoop.toFixed(2)} AIC on average. Review if complex queries can be simplified.`,
      metric: 'avgCostPerLoop',
      value: analytics.avgCostPerLoop,
    });
  }

  // Context pressure
  const pressurePct = (analytics.contextPressureRate * 100).toFixed(0);
  const thresholdPct = (analytics.contextThreshold * 100).toFixed(0);
  if (analytics.contextPressureRate > 0.25 && analytics.totalSessions >= 3) {
    insights.push({
      type: 'warning',
      title: 'Sessions are running out of context',
      description: `${pressurePct}% of your sessions pushed past ${thresholdPct}% of the model's context window (${analytics.totalHighContextCalls} calls in total). Late-session calls in that band cost the most and recall the least — split the work or start a fresh session once you cross it.`,
      metric: 'contextPressureRate',
      value: analytics.contextPressureRate,
    });
  } else if (analytics.contextPressureRate === 0 && analytics.totalSessions >= 5) {
    insights.push({
      type: 'success',
      title: 'Context stays comfortable',
      description: `No session crossed ${thresholdPct}% of its context window; your peak sat at ${(analytics.maxPeakContextRatio * 100).toFixed(0)}%. You're scoping work to fit.`,
      metric: 'maxPeakContextRatio',
      value: analytics.maxPeakContextRatio,
    });
  }

  // Model switching
  if (analytics.avgModelSwitchesPerSession >= 2) {
    const top = analytics.modelSwitchStats[0];
    const topPhrase = top ? ` Most often ${top.from} → ${top.to}.` : '';
    insights.push({
      type: 'tip',
      title: 'Frequent mid-session model switching',
      description: `You change model ${analytics.avgModelSwitchesPerSession.toFixed(1)} times per session on average.${topPhrase} Each switch re-sends the conversation as fresh input rather than a cache hit, so picking one model for a task is usually cheaper than escalating mid-flight.`,
      metric: 'avgModelSwitchesPerSession',
      value: analytics.avgModelSwitchesPerSession,
    });
  } else if (analytics.modelSwitchRate > 0 && analytics.avgModelSwitchesPerSession < 1) {
    insights.push({
      type: 'success',
      title: 'Deliberate model choice',
      description: `Only ${(analytics.modelSwitchRate * 100).toFixed(0)}% of sessions changed model, and rarely more than once. You're picking a model up front instead of escalating mid-task.`,
      metric: 'modelSwitchRate',
      value: analytics.modelSwitchRate,
    });
  }

  // Rework
  if (analytics.repeatedToolRate > 0.2 && analytics.totalToolCalls >= 20) {
    insights.push({
      type: 'warning',
      title: 'The agent is repeating itself',
      description: `${(analytics.repeatedToolRate * 100).toFixed(0)}% of tool calls immediately re-ran the same tool (${analytics.totalRepeatedToolCalls} times). That usually means it is searching blind — naming the file or symbol in your prompt cuts these loops.`,
      metric: 'repeatedToolRate',
      value: analytics.repeatedToolRate,
    });
  }

  // Prompt shape
  if (analytics.shortPromptRate > 0.4 && analytics.totalPrompts >= 10) {
    insights.push({
      type: 'tip',
      title: 'Prompts are running terse',
      description: `${(analytics.shortPromptRate * 100).toFixed(0)}% of your prompts are under ${SHORT_PROMPT_CHARS} characters (${analytics.avgPromptChars.toFixed(0)} on average). Terse prompts push the agent into exploratory tool loops; stating the file, the constraint and the expected outcome up front is the cheapest fix available.`,
      metric: 'shortPromptRate',
      value: analytics.shortPromptRate,
    });
  }

  // Agentic depth
  if (analytics.avgStepsPerLoop > 15) {
    insights.push({
      type: 'tip',
      title: 'Long agent runs per prompt',
      description: `Each prompt averages ${analytics.avgStepsPerLoop.toFixed(1)} steps, with a longest run of ${analytics.maxLoopSteps}. Long runs drift from the original ask — interrupting to re-aim is usually cheaper than letting one finish and redoing it.`,
      metric: 'avgStepsPerLoop',
      value: analytics.avgStepsPerLoop,
    });
  }

  return insights;
}
