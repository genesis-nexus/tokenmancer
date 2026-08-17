import { describe, expect, it } from 'vitest';
import type { StepEvent } from './contract/events.js';
import { redactEvent, redactStepEvent } from './redact.js';

function step(over: Partial<StepEvent> = {}): StepEvent {
  return {
    kind: 'step',
    id: 1,
    ts: 1000,
    source: 'tail',
    groupId: 'g1',
    promptGroupIndex: 1,
    stepIndex: 1,
    userPrompt: 'refactor the pricing table',
    model: 'claude-sonnet-4.6',
    requestType: 'request',
    toolName: 'read_file',
    stepKind: 'read',
    isTool: true,
    targets: ['src/server.ts'],
    toolIntent: 'read',
    toolQuery: 'rm -rf /tmp/secret-token-abc',
    resultBytes: 42,
    prompt: 100,
    completion: 10,
    cacheRead: 0,
    cacheWrite: 0,
    freshInput: 100,
    aic: 0.1,
    exact: true,
    promptSnippet: 'refactor the pricing table',
    systemPromptFile: '',
    sessionId: 's1',
    spanId: 'sp1',
    parentSpanId: '',
    eventType: 'tool_call',
    rawKey: 'k1',
    ...over,
  };
}

describe('redactStepEvent: default posture (prompts hidden)', () => {
  const opts = { showPrompts: false, salt: 'pepper' };

  it('blanks the prompt and replaces the snippet with a stable tag', () => {
    const r = redactStepEvent(step(), opts);
    expect(r.userPrompt).toBe('');
    expect(r.promptSnippet).toMatch(/^‹redacted [0-9a-f]{6}›$/);
  });

  it('blanks toolQuery — commands and search strings follow the prompt', () => {
    expect(redactStepEvent(step(), opts).toolQuery).toBe('');
  });

  it('KEEPS repo-relative targets: the file-cost report is the whole point', () => {
    expect(redactStepEvent(step(), opts).targets).toEqual(['src/server.ts']);
  });

  it('emits no tag when there was no prompt text to hide', () => {
    expect(redactStepEvent(step({ userPrompt: '', promptSnippet: '' }), opts).promptSnippet).toBe(
      '',
    );
  });
});

describe('redactStepEvent: path leakage', () => {
  const opts = { showPrompts: false };

  it('drops an absolute path that slipped past normalisation', () => {
    const r = redactStepEvent(step({ targets: ['src/a.ts', '/Users/dev/secret.ts'] }), opts);
    expect(r.targets).toEqual(['src/a.ts']);
  });

  it('drops a Windows drive path and any traversal', () => {
    const r = redactStepEvent(
      step({ targets: ['C:/Users/dev/x.ts', '../../etc/passwd', 'ok.ts'] }),
      opts,
    );
    expect(r.targets).toEqual(['ok.ts']);
  });

  it('drops every target when showPaths is off', () => {
    expect(redactStepEvent(step(), { showPrompts: false, showPaths: false }).targets).toEqual([]);
  });

  it('still filters non-relative targets when prompts ARE shown', () => {
    const r = redactStepEvent(step({ targets: ['/Users/dev/secret.ts'] }), { showPrompts: true });
    expect(r.targets).toEqual([]);
    expect(r.userPrompt).toBe('refactor the pricing table');
  });
});

describe('redactStepEvent: opt-in passthrough', () => {
  it('returns the event untouched when nothing needs redacting', () => {
    const ev = step();
    expect(redactStepEvent(ev, { showPrompts: true })).toBe(ev);
  });

  it('keeps the query when prompts are shown', () => {
    expect(redactStepEvent(step(), { showPrompts: true }).toolQuery).toContain('rm -rf');
  });
});

describe('redactEvent passes non-step events through', () => {
  it('leaves control and alert events alone', () => {
    const control = { kind: 'control', control: 'session' } as const;
    expect(redactEvent(control, { showPrompts: false })).toBe(control);

    const alert = {
      kind: 'alert',
      id: 'r1:2026-08:1',
      ts: 1,
      severity: 'warn',
      title: 'Budget exceeded — today',
      body: '10 cr of 10 cr',
      ruleId: 'r1',
      period: 'day',
      observed: 10,
      limit: 10,
    } as const;
    expect(redactEvent(alert, { showPrompts: false })).toBe(alert);
  });
});
