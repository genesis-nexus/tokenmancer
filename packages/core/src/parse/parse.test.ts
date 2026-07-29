import { describe, expect, it } from 'vitest';
import type { MeterEvent, StepEvent } from '../contract/events.js';
import { createGroupingContext, processRecord } from './grouping.js';
import { classifyStep } from './harvest.js';
import { extractObjects } from './scan.js';

function runLog(records: unknown[]): MeterEvent[] {
  const ctx = createGroupingContext();
  const out: MeterEvent[] = [];
  for (const rec of records) processRecord(rec, 'inbox', ctx, (ev) => out.push(ev));
  return out;
}
const steps = (evs: MeterEvent[]): StepEvent[] =>
  evs.filter((e): e is StepEvent => e.kind === 'step');

describe('extractObjects', () => {
  it('splits concatenated and brace-containing objects', () => {
    expect(extractObjects('{"x":1}{"y":2}')).toEqual([{ x: 1 }, { y: 2 }]);
    // a brace inside a string must not confuse the scanner
    expect(extractObjects('{"a":"}"}\n{"b":2}')).toEqual([{ a: '}' }, { b: 2 }]);
  });
});

describe('grouping funnel (regression-locks the inbox bug)', () => {
  it('carries prompt text and a real group id onto each billed step', () => {
    const log = [
      {
        type: 'user_message',
        sid: 's1',
        spanId: 'p1',
        attrs: { userRequest: 'Refactor formatPrice' },
      },
      {
        type: 'request',
        sid: 's1',
        spanId: 'r1',
        parentSpanId: 'p1',
        ts: 1000,
        model: 'claude-sonnet-4.6',
        prompt_tokens: 1000,
        completion_tokens: 100,
      },
      {
        type: 'request',
        sid: 's1',
        spanId: 'r2',
        parentSpanId: 'p1',
        ts: 1001,
        model: 'claude-sonnet-4.6',
        prompt_tokens: 1200,
        completion_tokens: 80,
      },
    ];
    const s = steps(runLog(log));
    expect(s).toHaveLength(2);

    // The historical bug: these would be 'ungrouped' with '[prompt text not in log]'.
    expect(s[0]?.groupId).toBe('p1');
    expect(s[0]?.userPrompt).toBe('Refactor formatPrice');
    expect(s[0]?.promptGroupIndex).toBe(1);
    expect(s[0]?.stepIndex).toBe(1);
    expect(s[1]?.stepIndex).toBe(2); // same loop, next step
    expect(s[1]?.groupId).toBe('p1');

    // rate-table fallback: fresh 1000 * 300/M + out 100 * 1500/M = 0.45
    expect(s[0]?.aic).toBeCloseTo(0.45, 6);
    expect(s[0]?.exact).toBe(false);
  });

  it('still assigns all required grouping fields to an orphan record (no user_message)', () => {
    const s = steps(
      runLog([
        {
          type: 'request',
          sid: 's9',
          spanId: 'x1',
          ts: 5,
          model: 'gpt-5-mini',
          prompt_tokens: 500,
          completion_tokens: 50,
        },
      ]),
    );
    expect(s).toHaveLength(1);
    const ev = s[0];
    expect(ev?.groupId).toBe('ungrouped');
    expect(ev?.promptGroupIndex).toBe(1);
    expect(ev?.stepIndex).toBe(1);
    expect(typeof ev?.userPrompt).toBe('string'); // present, never undefined
  });

  it('treats a tool_call as a free, classified step (no model, exact)', () => {
    const s = steps(
      runLog([
        { type: 'user_message', sid: 's1', spanId: 'p1', attrs: { userRequest: 'go' } },
        { type: 'tool_call', sid: 's1', spanId: 't1', parentSpanId: 'p1', name: 'readFile' },
      ]),
    );
    expect(s[0]?.isTool).toBe(true);
    expect(s[0]?.aic).toBe(0);
    expect(s[0]?.model).toBe('');
    expect(s[0]?.stepKind).toBe('read');
    expect(s[0]?.exact).toBe(true);
  });

  it('reads exact credits from the log when present (nano-AIU wins over rate table)', () => {
    const s = steps(
      runLog([
        {
          type: 'request',
          sid: 's1',
          spanId: 'r1',
          model: 'claude-sonnet-4.6',
          prompt_tokens: 1000,
          completion_tokens: 100,
          total_nano_aiu: 1_940_000_000,
        },
      ]),
    );
    expect(s[0]?.aic).toBeCloseTo(1.94, 6);
    expect(s[0]?.exact).toBe(true);
  });
});

describe('classifyStep', () => {
  it('maps request/tool names to the loop taxonomy', () => {
    expect(classifyStep('applyPatch')).toBe('edit');
    expect(classifyStep('', 'ripgrep')).toBe('search');
    expect(classifyStep('', 'readFile')).toBe('read');
    expect(classifyStep('runInTerminal')).toBe('verify');
    expect(classifyStep('planning')).toBe('plan');
    expect(classifyStep('chat request')).toBe('chat');
    expect(classifyStep('something else')).toBe('llm');
  });
});
