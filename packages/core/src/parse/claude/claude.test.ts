import { describe, expect, it } from 'vitest';
import type { MeterEvent, StepEvent } from '../../contract/events.js';
import { createGroupingContext } from '../grouping.js';
import { type ClaudeContext, createClaudeContext, processClaudeRecord } from './index.js';

const SESSION = 'sess-1';
const CWD = '/Users/dev/proj';

function ctx(): ClaudeContext {
  return createClaudeContext(createGroupingContext());
}

function run(records: unknown[], c: ClaudeContext = ctx()): StepEvent[] {
  const out: MeterEvent[] = [];
  for (const r of records) processClaudeRecord(r, 'archive', c, (ev) => out.push(ev));
  return out.filter((e): e is StepEvent => e.kind === 'step');
}

function userTurn(promptId: string, text: string) {
  return {
    type: 'user',
    promptId,
    uuid: `u-${promptId}`,
    sessionId: SESSION,
    cwd: CWD,
    timestamp: '2026-08-05T11:10:24.033Z',
    message: { role: 'user', content: [{ type: 'text', text }] },
  };
}

function toolResultTurn(promptId: string, toolUseId: string) {
  return {
    type: 'user',
    promptId,
    uuid: `ur-${toolUseId}`,
    sessionId: SESSION,
    cwd: CWD,
    timestamp: '2026-08-05T11:10:30.000Z',
    message: {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
    },
  };
}

const USAGE = {
  input_tokens: 2,
  cache_creation_input_tokens: 11449,
  cache_read_input_tokens: 21205,
  output_tokens: 268,
  cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 11449 },
  server_tool_use: { web_search_requests: 0 },
};

/** One content block per line — exactly how Claude Code writes a response. */
function assistantLine(
  requestId: string,
  uuid: string,
  block: Record<string, unknown>,
  over: Record<string, unknown> = {},
) {
  return {
    type: 'assistant',
    requestId,
    uuid,
    parentUuid: 'u-p1',
    isSidechain: false,
    sessionId: SESSION,
    cwd: CWD,
    gitBranch: 'main',
    timestamp: '2026-08-05T11:10:32.060Z',
    message: {
      id: `msg-${requestId}`,
      role: 'assistant',
      model: 'claude-sonnet-5',
      usage: USAGE,
      content: [block],
      ...over,
    },
  };
}

describe('billing is keyed on requestId, not on lines', () => {
  it('bills one API response once however many content blocks it was split across', () => {
    // The real hazard: every line repeats the FULL identical usage block.
    const steps = run([
      userTurn('p1', 'do the thing'),
      assistantLine('req-1', 'a1', { type: 'thinking', thinking: '…' }),
      assistantLine('req-1', 'a2', { type: 'text', text: 'Working on it' }),
      assistantLine('req-1', 'a3', {
        type: 'tool_use',
        id: 'toolu_1',
        name: 'Read',
        input: { file_path: `${CWD}/src/server.ts` },
      }),
    ]);

    const billed = steps.filter((s) => !s.isTool);
    expect(billed).toHaveLength(1);
    expect(billed[0]?.completion).toBe(268);

    // Three lines, one bill, one tool step.
    expect(steps.filter((s) => s.isTool)).toHaveLength(1);
  });

  it('bills each distinct response separately', () => {
    const steps = run([
      userTurn('p1', 'go'),
      assistantLine('req-1', 'a1', { type: 'text', text: 'one' }),
      assistantLine('req-2', 'a2', { type: 'text', text: 'two' }),
    ]);
    expect(steps.filter((s) => !s.isTool)).toHaveLength(2);
  });

  it('falls back to message.id when requestId is absent', () => {
    const line = assistantLine('', 'a1', { type: 'text', text: 'hi' });
    const steps = run([userTurn('p1', 'go'), line, line]);
    expect(steps.filter((s) => !s.isTool)).toHaveLength(1);
  });
});

describe('token semantics', () => {
  it('sums the three input classes, because Anthropic reports them separately', () => {
    // Copilot's `prompt` already includes cache; Anthropic's input_tokens does not.
    const [billed] = run([
      userTurn('p1', 'go'),
      assistantLine('req-1', 'a1', { type: 'text', text: 'hi' }),
    ]);
    expect(billed?.freshInput).toBe(2);
    expect(billed?.cacheRead).toBe(21205);
    expect(billed?.cacheWrite).toBe(11449);
    expect(billed?.prompt).toBe(2 + 21205 + 11449);
  });

  it('carries the cache-write TTL split through to the event', () => {
    const [billed] = run([
      userTurn('p1', 'go'),
      assistantLine('req-1', 'a1', { type: 'text', text: 'hi' }),
    ]);
    expect(billed?.cacheWrite1h).toBe(11449);
    expect(billed?.cacheWrite5m).toBe(0);
  });

  it('prices at Sonnet 5 list rates, with the 1h write at 2x input', () => {
    const [billed] = run([
      userTurn('p1', 'go'),
      assistantLine('req-1', 'a1', { type: 'text', text: 'hi' }),
    ]);
    // fresh 2 @ $3 + read 21205 @ $0.30 + 1h write 11449 @ $6 + out 268 @ $15, per 1M
    const expected = (2 / 1e6) * 3 + (21205 / 1e6) * 0.3 + (11449 / 1e6) * 6 + (268 / 1e6) * 15;
    expect(billed?.usd).toBeCloseTo(expected, 8);
    // aic is USD in hundredths, so a credit budget spans both providers.
    expect(billed?.aic).toBeCloseTo(expected * 100, 6);
    expect(billed?.provider).toBe('claude');
    // Claude states tokens, never a price — the figure is always our arithmetic.
    expect(billed?.exact).toBe(false);
  });

  it('skips records that name no real model', () => {
    const steps = run([
      userTurn('p1', 'go'),
      assistantLine('req-1', 'a1', { type: 'text', text: 'hi' }, { model: '<synthetic>' }),
    ]);
    expect(steps).toHaveLength(0);
  });
});

describe('tool steps', () => {
  it('maps Claude tool names to intents without regex guessing', () => {
    const steps = run([
      userTurn('p1', 'go'),
      assistantLine('req-1', 'a1', {
        type: 'tool_use',
        id: 't1',
        name: 'Write',
        input: { file_path: `${CWD}/src/new.ts` },
      }),
      assistantLine('req-2', 'a2', {
        type: 'tool_use',
        id: 't2',
        name: 'Bash',
        input: { command: 'pnpm test' },
      }),
      assistantLine('req-3', 'a3', {
        type: 'tool_use',
        id: 't3',
        name: 'Grep',
        input: { pattern: 'TODO' },
      }),
    ]);
    const tools = steps.filter((s) => s.isTool);
    expect(tools.map((t) => [t.toolName, t.toolIntent, t.stepKind])).toEqual([
      ['Write', 'create', 'edit'],
      ['Bash', 'exec', 'verify'],
      ['Grep', 'search', 'search'],
    ]);
  });

  it('records repo-relative targets and costs nothing', () => {
    const steps = run([
      userTurn('p1', 'go'),
      assistantLine('req-1', 'a1', {
        type: 'tool_use',
        id: 't1',
        name: 'Read',
        input: { file_path: `${CWD}/packages/core/src/index.ts` },
      }),
    ]);
    const tool = steps.find((s) => s.isTool);
    expect(tool?.targets).toEqual(['packages/core/src/index.ts']);
    expect(tool?.usd).toBe(0);
    expect(tool?.aic).toBe(0);
  });

  it('never lets an absolute path outside the workspace escape the parser', () => {
    const steps = run([
      userTurn('p1', 'go'),
      assistantLine('req-1', 'a1', {
        type: 'tool_use',
        id: 't1',
        name: 'Read',
        input: { file_path: '/etc/passwd' },
      }),
    ]);
    expect(steps.find((s) => s.isTool)?.targets).toEqual(['passwd']);
  });
});

describe('loop grouping', () => {
  it('groups every step of a loop under the prompt that started it', () => {
    const steps = run([
      userTurn('p1', 'first request'),
      assistantLine('req-1', 'a1', { type: 'text', text: 'ok' }),
      toolResultTurn('p1', 't1'),
      assistantLine('req-2', 'a2', { type: 'text', text: 'still going' }),
      userTurn('p2', 'second request'),
      assistantLine('req-3', 'a3', { type: 'text', text: 'new loop' }),
    ]);

    expect(steps.map((s) => s.groupId)).toEqual(['p1', 'p1', 'p2']);
    expect(steps.map((s) => s.userPrompt)).toEqual([
      'first request',
      'first request',
      'second request',
    ]);
    expect(steps.map((s) => s.promptGroupIndex)).toEqual([1, 1, 2]);
    expect(steps.map((s) => s.stepIndex)).toEqual([1, 2, 1]);
  });

  it('does not let an interleaved tool result overwrite the loop prompt', () => {
    const steps = run([
      userTurn('p1', 'the real prompt'),
      toolResultTurn('p1', 't1'),
      assistantLine('req-1', 'a1', { type: 'text', text: 'ok' }),
    ]);
    expect(steps[0]?.userPrompt).toBe('the real prompt');
  });
});
