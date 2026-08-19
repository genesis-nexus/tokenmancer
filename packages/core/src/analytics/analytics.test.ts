import { describe, expect, it } from 'vitest';
import type { MeterEvent, StepEvent } from '../contract/events.js';
import { CONTEXT_WINDOWS } from '../pricing/models.js';
import {
  HIGH_CONTEXT_THRESHOLD,
  computeSessionMetrics,
  computeWorkspaceAnalytics,
  generateInsights,
} from './aggregate.js';

function makeStep(overrides: Partial<StepEvent> = {}): StepEvent {
  return {
    kind: 'step',
    id: 1,
    ts: Date.now(),
    source: 'archive',
    groupId: 'g1',
    promptGroupIndex: 1,
    stepIndex: 1,
    userPrompt: 'test prompt',
    provider: 'copilot',
    model: 'claude-sonnet-4.6',
    requestType: 'request',
    toolName: '',
    stepKind: 'chat',
    isTool: false,
    targets: [],
    toolIntent: '',
    toolQuery: '',
    resultBytes: 0,
    prompt: 1000,
    completion: 100,
    cacheRead: 500,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    freshInput: 500,
    aic: 0.45,
    usd: 0.0045,
    exact: false,
    promptSnippet: '',
    systemPromptFile: '',
    sessionId: 's1',
    spanId: 'sp1',
    parentSpanId: '',
    eventType: 'request',
    rawKey: 'key1',
    ...overrides,
  };
}

describe('computeSessionMetrics', () => {
  it('returns empty metrics for empty events', () => {
    const metrics = computeSessionMetrics('s1', []);
    expect(metrics.sessionId).toBe('s1');
    expect(metrics.stepCount).toBe(0);
    expect(metrics.loopCount).toBe(0);
    expect(metrics.totalAic).toBe(0);
  });

  it('computes basic metrics from steps', () => {
    const events: MeterEvent[] = [
      makeStep({ ts: 1000, groupId: 'g1', aic: 0.5, prompt: 1000, completion: 100 }),
      makeStep({ ts: 2000, groupId: 'g1', aic: 0.3, prompt: 800, completion: 80, stepIndex: 2 }),
      makeStep({
        ts: 3000,
        groupId: 'g2',
        aic: 0.4,
        prompt: 900,
        completion: 90,
        promptGroupIndex: 2,
      }),
    ];

    const metrics = computeSessionMetrics('s1', events);

    expect(metrics.stepCount).toBe(3);
    expect(metrics.loopCount).toBe(2); // g1 and g2
    expect(metrics.totalAic).toBeCloseTo(1.2, 6);
    expect(metrics.totalPromptTokens).toBe(2700);
    expect(metrics.totalCompletionTokens).toBe(270);
    expect(metrics.llmCallCount).toBe(3);
    expect(metrics.toolCallCount).toBe(0);
    expect(metrics.startTime).toBe(1000);
    expect(metrics.endTime).toBe(3000);
    expect(metrics.durationMs).toBe(2000);
  });

  it('tracks tool calls separately', () => {
    const events: MeterEvent[] = [
      makeStep({ isTool: false, aic: 0.5 }),
      makeStep({ isTool: true, aic: 0, toolName: 'read_file', stepIndex: 2 }),
      makeStep({ isTool: true, aic: 0, toolName: 'grep_search', stepIndex: 3 }),
      makeStep({ isTool: true, aic: 0, toolName: 'read_file', stepIndex: 4 }), // duplicate tool
    ];

    const metrics = computeSessionMetrics('s1', events);

    expect(metrics.llmCallCount).toBe(1);
    expect(metrics.toolCallCount).toBe(3);
    expect(metrics.uniqueTools).toEqual(['read_file', 'grep_search']);
  });

  it('computes context fill rate', () => {
    const events: MeterEvent[] = [
      makeStep({ cacheRead: 800, freshInput: 200 }), // 80% fill rate
      makeStep({ cacheRead: 600, freshInput: 400, stepIndex: 2 }), // 60% fill rate
    ];

    const metrics = computeSessionMetrics('s1', events);

    // total: 1400 cache read, 600 fresh input => 70% fill rate
    expect(metrics.contextFillRate).toBeCloseTo(0.7, 6);
  });

  it('tracks model distribution', () => {
    const events: MeterEvent[] = [
      makeStep({ model: 'claude-sonnet-4.6', aic: 0.5 }),
      makeStep({ model: 'claude-sonnet-4.6', aic: 0.3, stepIndex: 2 }),
      makeStep({ model: 'gpt-5-mini', aic: 0.1, stepIndex: 3 }),
    ];

    const metrics = computeSessionMetrics('s1', events);

    expect(metrics.models).toContain('claude-sonnet-4.6');
    expect(metrics.models).toContain('gpt-5-mini');
    expect(metrics.modelCalls['claude-sonnet-4.6']).toBe(2);
    expect(metrics.modelCalls['gpt-5-mini']).toBe(1);
    expect(metrics.modelAic['claude-sonnet-4.6']).toBeCloseTo(0.8, 6);
    expect(metrics.modelAic['gpt-5-mini']).toBeCloseTo(0.1, 6);
  });
});

describe('computeWorkspaceAnalytics', () => {
  it('returns empty analytics for no sessions', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test-workspace', [], 30);

    expect(analytics.workspaceId).toBe('ws1');
    expect(analytics.workspaceName).toBe('test-workspace');
    expect(analytics.totalSessions).toBe(0);
    expect(analytics.totalLoops).toBe(0);
    expect(analytics.totalAic).toBe(0);
  });

  it('aggregates session metrics', () => {
    const now = Date.now();
    const sessions = [
      {
        ...computeSessionMetrics('s1', [
          makeStep({ ts: now - 1000, aic: 0.5, groupId: 'g1' }),
          makeStep({ ts: now - 500, aic: 0.3, groupId: 'g2', promptGroupIndex: 2 }),
        ]),
      },
      {
        ...computeSessionMetrics('s2', [
          makeStep({ ts: now - 2000, aic: 0.4, groupId: 'g3', sessionId: 's2' }),
        ]),
      },
    ];

    const analytics = computeWorkspaceAnalytics('ws1', 'test', sessions, 30);

    expect(analytics.totalSessions).toBe(2);
    expect(analytics.totalLoops).toBe(3); // g1, g2, g3
    expect(analytics.totalSteps).toBe(3);
    expect(analytics.totalAic).toBeCloseTo(1.2, 6);
    expect(analytics.avgLoopsPerSession).toBeCloseTo(1.5, 6);
    expect(analytics.avgCostPerSession).toBeCloseTo(0.6, 6);
  });

  it('filters sessions by time window', () => {
    const now = Date.now();
    const oldTime = now - 40 * 24 * 60 * 60 * 1000; // 40 days ago

    const sessions = [
      {
        ...computeSessionMetrics('recent', [makeStep({ ts: now - 1000, aic: 1.0 })]),
      },
      {
        ...computeSessionMetrics('old', [makeStep({ ts: oldTime, aic: 2.0 })]),
        startTime: oldTime,
        endTime: oldTime,
      },
    ];

    const analytics = computeWorkspaceAnalytics('ws1', 'test', sessions, 30);

    // Only recent session should be included
    expect(analytics.totalSessions).toBe(1);
    expect(analytics.totalAic).toBeCloseTo(1.0, 6);
  });

  it('computes daily trends', () => {
    const now = Date.now();
    const day1 = new Date(now).toISOString().slice(0, 10);

    const sessions = [
      computeSessionMetrics('s1', [
        makeStep({ ts: now - 1000, aic: 0.5, cacheRead: 700, freshInput: 300 }),
      ]),
      computeSessionMetrics('s2', [
        makeStep({ ts: now - 2000, aic: 0.3, cacheRead: 500, freshInput: 500 }),
      ]),
    ];

    const analytics = computeWorkspaceAnalytics('ws1', 'test', sessions, 30);

    expect(analytics.dailyTrend.length).toBeGreaterThan(0);
    const todayTrend = analytics.dailyTrend.find((t) => t.date === day1);
    expect(todayTrend).toBeDefined();
    expect(todayTrend?.sessionCount).toBe(2);
  });
});

describe('generateInsights', () => {
  it('generates success insight for high context fill rate', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test', [], 30);
    analytics.avgContextFillRate = 0.8;
    analytics.totalSessions = 5;

    const insights = generateInsights(analytics);

    const fillRateInsight = insights.find((i) => i.metric === 'contextFillRate');
    expect(fillRateInsight).toBeDefined();
    expect(fillRateInsight?.type).toBe('success');
  });

  it('generates tip for low context fill rate', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test', [], 30);
    analytics.avgContextFillRate = 0.2;
    analytics.totalSessions = 5;

    const insights = generateInsights(analytics);

    const fillRateInsight = insights.find((i) => i.metric === 'contextFillRate');
    expect(fillRateInsight).toBeDefined();
    expect(fillRateInsight?.type).toBe('tip');
  });

  it('generates warning for high session frequency', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test', [], 30);
    analytics.sessionsPerDay = 8;
    analytics.totalSessions = 5;

    const insights = generateInsights(analytics);

    const freqInsight = insights.find((i) => i.metric === 'sessionsPerDay');
    expect(freqInsight).toBeDefined();
    expect(freqInsight?.type).toBe('warning');
  });

  it('generates success for high tool usage', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test', [], 30);
    analytics.toolUsageRate = 0.6;
    analytics.totalSessions = 5;

    const insights = generateInsights(analytics);

    const toolInsight = insights.find((i) => i.metric === 'toolUsageRate');
    expect(toolInsight).toBeDefined();
    expect(toolInsight?.type).toBe('success');
  });
});

const SONNET_WINDOW = CONTEXT_WINDOWS['claude-sonnet-4.6'];

describe('model switching', () => {
  it('counts a switch only when the model actually changes', () => {
    const events: MeterEvent[] = [
      makeStep({ ts: 1000, model: 'claude-sonnet-4.6' }),
      makeStep({ ts: 2000, model: 'claude-sonnet-4.6', stepIndex: 2 }),
      makeStep({ ts: 3000, model: 'claude-opus-4.8', stepIndex: 3 }),
      makeStep({ ts: 4000, model: 'claude-sonnet-4.6', stepIndex: 4 }),
    ];

    const m = computeSessionMetrics('s1', events);

    expect(m.modelSwitchCount).toBe(2);
    expect(m.modelSwitchPairs['claude-sonnet-4.6>claude-opus-4.8']).toBe(1);
    expect(m.modelSwitchPairs['claude-opus-4.8>claude-sonnet-4.6']).toBe(1);
  });

  it('ignores tool steps when detecting switches', () => {
    const events: MeterEvent[] = [
      makeStep({ ts: 1000, model: 'claude-sonnet-4.6' }),
      makeStep({ ts: 2000, isTool: true, toolName: 'read_file', model: '', stepIndex: 2 }),
      makeStep({ ts: 3000, model: 'claude-sonnet-4.6', stepIndex: 3 }),
    ];

    expect(computeSessionMetrics('s1', events).modelSwitchCount).toBe(0);
  });

  it('detects switches from out-of-order events', () => {
    const events: MeterEvent[] = [
      makeStep({ ts: 3000, model: 'claude-sonnet-4.6', stepIndex: 3 }),
      makeStep({ ts: 1000, model: 'claude-sonnet-4.6', stepIndex: 1 }),
      makeStep({ ts: 2000, model: 'claude-opus-4.8', stepIndex: 2 }),
    ];

    // sonnet → opus → sonnet once sorted, not the two switches the raw order implies
    expect(computeSessionMetrics('s1', events).modelSwitchCount).toBe(2);
  });

  it('aggregates switches across sessions', () => {
    // Inside the 30-day window, or computeWorkspaceAnalytics filters them out.
    const now = Date.now();
    const a = computeSessionMetrics('s1', [
      makeStep({ ts: now - 3000, model: 'claude-sonnet-4.6' }),
      makeStep({ ts: now - 2000, model: 'claude-opus-4.8', stepIndex: 2 }),
    ]);
    const b = computeSessionMetrics('s2', [
      makeStep({ ts: now - 1000, sessionId: 's2', model: 'claude-sonnet-4.6' }),
    ]);

    const analytics = computeWorkspaceAnalytics('ws1', 'test', [a, b], 30);

    expect(analytics.totalModelSwitches).toBe(1);
    expect(analytics.sessionsWithModelSwitch).toBe(1);
    expect(analytics.modelSwitchRate).toBeCloseTo(0.5, 6);
    expect(analytics.modelSwitchStats[0]).toMatchObject({
      from: 'claude-sonnet-4.6',
      to: 'claude-opus-4.8',
      count: 1,
    });
  });
});

describe('context pressure', () => {
  it('flags calls past the threshold and records the peak', () => {
    const events: MeterEvent[] = [
      makeStep({ ts: 1000, prompt: SONNET_WINDOW * 0.5 }),
      makeStep({ ts: 2000, prompt: SONNET_WINDOW * 0.9, stepIndex: 2 }),
      makeStep({ ts: 3000, prompt: SONNET_WINDOW * 0.85, stepIndex: 3 }),
    ];

    const m = computeSessionMetrics('s1', events);

    expect(m.highContextCallCount).toBe(2);
    expect(m.crossedHighContext).toBe(true);
    expect(m.peakContextRatio).toBeCloseTo(0.9, 6);
    expect(m.avgContextRatio).toBeCloseTo(0.75, 6);
  });

  it('leaves a session below the threshold unflagged', () => {
    const m = computeSessionMetrics('s1', [makeStep({ prompt: SONNET_WINDOW * 0.4 })]);

    expect(m.highContextCallCount).toBe(0);
    expect(m.crossedHighContext).toBe(false);
  });

  it('scales the ratio to each model’s own window', () => {
    // The same token count is 80%+ of haiku's window but a rounding error of gemini's.
    const tokens = CONTEXT_WINDOWS['claude-haiku-4.5'] * 0.9;
    const haiku = computeSessionMetrics('s1', [
      makeStep({ model: 'claude-haiku-4.5', prompt: tokens }),
    ]);
    const gemini = computeSessionMetrics('s2', [
      makeStep({ model: 'gemini-3.1-pro', prompt: tokens }),
    ]);

    expect(haiku.crossedHighContext).toBe(true);
    expect(gemini.crossedHighContext).toBe(false);
  });

  it('buckets sessions by peak ratio', () => {
    const low = computeSessionMetrics('s1', [makeStep({ prompt: SONNET_WINDOW * 0.2 })]);
    const high = computeSessionMetrics('s2', [
      makeStep({ sessionId: 's2', prompt: SONNET_WINDOW * 0.9 }),
    ]);

    const analytics = computeWorkspaceAnalytics('ws1', 'test', [low, high], 30);

    expect(analytics.contextThreshold).toBe(HIGH_CONTEXT_THRESHOLD);
    expect(analytics.sessionsOverContextThreshold).toBe(1);
    expect(analytics.contextPressureRate).toBeCloseTo(0.5, 6);
    expect(
      analytics.contextPressureBuckets.find((b) => b.label === 'Under 50%')?.sessionCount,
    ).toBe(1);
    expect(analytics.contextPressureBuckets.find((b) => b.label === '80–95%')?.sessionCount).toBe(
      1,
    );
    // Every session lands in exactly one band.
    const bucketed = analytics.contextPressureBuckets.reduce((a, b) => a + b.sessionCount, 0);
    expect(bucketed).toBe(2);
  });
});

describe('rework, loop shape and prompts', () => {
  it('counts only back-to-back repeats of the same tool', () => {
    const events: MeterEvent[] = [
      makeStep({ ts: 1000, isTool: true, toolName: 'grep', stepIndex: 1 }),
      makeStep({ ts: 2000, isTool: true, toolName: 'grep', stepIndex: 2 }),
      makeStep({ ts: 3000, isTool: true, toolName: 'grep', stepIndex: 3 }),
      makeStep({ ts: 4000, isTool: true, toolName: 'read_file', stepIndex: 4 }),
      makeStep({ ts: 5000, isTool: true, toolName: 'grep', stepIndex: 5 }),
    ];

    expect(computeSessionMetrics('s1', events).repeatedToolCallCount).toBe(2);
  });

  it('breaks a tool repeat run across an intervening LLM call', () => {
    const events: MeterEvent[] = [
      makeStep({ ts: 1000, isTool: true, toolName: 'grep', stepIndex: 1 }),
      makeStep({ ts: 2000, isTool: false, stepIndex: 2 }),
      makeStep({ ts: 3000, isTool: true, toolName: 'grep', stepIndex: 3 }),
    ];

    expect(computeSessionMetrics('s1', events).repeatedToolCallCount).toBe(0);
  });

  it('measures loop depth and prompt length', () => {
    const events: MeterEvent[] = [
      makeStep({ ts: 1000, groupId: 'g1', userPrompt: 'fix it' }),
      makeStep({ ts: 2000, groupId: 'g1', userPrompt: 'fix it', stepIndex: 2 }),
      makeStep({ ts: 3000, groupId: 'g1', userPrompt: 'fix it', stepIndex: 3 }),
      makeStep({
        ts: 4000,
        groupId: 'g2',
        promptGroupIndex: 2,
        userPrompt: 'x'.repeat(100),
      }),
    ];

    const m = computeSessionMetrics('s1', events);

    expect(m.maxLoopSteps).toBe(3);
    expect(m.avgStepsPerLoop).toBe(2); // 4 steps / 2 loops
    expect(m.promptCount).toBe(2);
    expect(m.shortPromptCount).toBe(1); // 'fix it' only
    expect(m.avgPromptChars).toBeCloseTo((6 + 100) / 2, 6);
  });

  it('bins steps by hour of day', () => {
    const at = (hour: number) => new Date(2026, 0, 15, hour, 30).getTime();
    const m = computeSessionMetrics('s1', [
      makeStep({ ts: at(9) }),
      makeStep({ ts: at(9), stepIndex: 2 }),
      makeStep({ ts: at(22), stepIndex: 3 }),
    ]);

    expect(m.hourlyActivity).toHaveLength(24);
    expect(m.hourlyActivity[9]).toBe(2);
    expect(m.hourlyActivity[22]).toBe(1);
    expect(m.hourlyActivity.reduce((a, b) => a + b, 0)).toBe(3);
  });
});

describe('interaction-quality insights', () => {
  it('warns when sessions repeatedly run out of context', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test', [], 30);
    analytics.totalSessions = 10;
    analytics.contextPressureRate = 0.5;
    analytics.totalHighContextCalls = 12;

    const insight = generateInsights(analytics).find((i) => i.metric === 'contextPressureRate');
    expect(insight?.type).toBe('warning');
  });

  it('tips on frequent model switching', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test', [], 30);
    analytics.totalSessions = 5;
    analytics.avgModelSwitchesPerSession = 3;
    analytics.modelSwitchStats = [
      { from: 'claude-sonnet-4.6', to: 'claude-opus-4.8', count: 9, percentOfSwitches: 100 },
    ];

    const insight = generateInsights(analytics).find(
      (i) => i.metric === 'avgModelSwitchesPerSession',
    );
    expect(insight?.type).toBe('tip');
    expect(insight?.description).toContain('claude-opus-4.8');
  });

  it('warns on a high tool-repeat rate', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test', [], 30);
    analytics.totalToolCalls = 50;
    analytics.totalRepeatedToolCalls = 15;
    analytics.repeatedToolRate = 0.3;

    const insight = generateInsights(analytics).find((i) => i.metric === 'repeatedToolRate');
    expect(insight?.type).toBe('warning');
  });

  it('tips when prompts are mostly terse', () => {
    const analytics = computeWorkspaceAnalytics('ws1', 'test', [], 30);
    analytics.totalPrompts = 20;
    analytics.shortPromptRate = 0.6;
    analytics.avgPromptChars = 25;

    const insight = generateInsights(analytics).find((i) => i.metric === 'shortPromptRate');
    expect(insight?.type).toBe('tip');
  });
});
