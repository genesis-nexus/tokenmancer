// Claude Code transcript parser.
//
// Reads `~/.claude/projects/<slug>/<session>.jsonl` and emits the same StepEvent
// contract the Copilot parser does, through the same `emitStep` funnel — so every
// downstream surface (meter, replay, analytics, budgets, ledger) works untouched.
//
// Two things about this format bite hard if you skim it:
//
//   1. One API response is written as SEVERAL `assistant` lines — one per content
//      block — and every one of them repeats the FULL, identical `usage` and
//      `requestId`. Summing lines nearly doubles the bill (measured: 1241 lines
//      for 673 real responses). Billing is therefore keyed on `requestId`.
//   2. Anthropic's `input_tokens` is FRESH input only; cache reads and writes are
//      separate counts. Copilot's `prompt` is the opposite — it already includes
//      them. So `prompt` here is a SUM, not a starting point to subtract from.

import type { EventOrigin, MeterEvent } from '../../contract/events.js';
import { claudeProvider } from '../../pricing/provider.js';
import { type GroupingContext, type StepCore, emitStep } from '../grouping.js';
import { claudeStepKind, claudeTargets, claudeToolIntent, claudeToolQuery } from './tools.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === 'string' ? v : '';
}
function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Per-session state a Claude transcript needs on top of the shared grouping. */
export interface ClaudeContext extends GroupingContext {
  /** requestIds already billed, so repeated content-block lines are free. */
  billed: Set<string>;
}

export function createClaudeContext(base: GroupingContext): ClaudeContext {
  return Object.assign(base, { billed: new Set<string>() });
}

/** Text of a user turn, or '' when the record is a tool result rather than a prompt. */
function userPromptText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!isRecord(message)) return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'text') continue;
    if (typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join('\n').trim();
}

const MAX_SNIPPET = 500;

function snippet(s: string): string {
  return s.length > MAX_SNIPPET ? `${s.slice(0, MAX_SNIPPET)}…` : s;
}

function tsOf(rec: Record<string, unknown>): number {
  const raw = rec.timestamp;
  if (typeof raw === 'number') return raw;
  if (typeof raw === 'string') {
    const t = Date.parse(raw);
    if (Number.isFinite(t)) return t;
  }
  return Date.now();
}

export interface ClaudeProcessOptions {
  /** Extra roots for making targets repo-relative; the record's own cwd is always used. */
  repoRoots?: string[];
  /** Identifies a subagent transcript so its steps can be attributed and reported. */
  agent?: { id: string; type: string; spawnDepth: number; parentGroupId?: string };
}

/** Anthropic usage block, as written into the transcript. */
interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
  server_tool_use?: { web_search_requests?: number };
}

function billedCore(
  rec: Record<string, unknown>,
  message: Record<string, unknown>,
  source: EventOrigin,
  model: string,
  opts: ClaudeProcessOptions,
): StepCore | null {
  const usage = (isRecord(message.usage) ? message.usage : {}) as Usage;

  const fresh = num(usage.input_tokens);
  const cacheRead = num(usage.cache_read_input_tokens);
  const cacheWrite = num(usage.cache_creation_input_tokens);
  const output = num(usage.output_tokens);
  const cw5m = num(usage.cache_creation?.ephemeral_5m_input_tokens);
  const cw1h = num(usage.cache_creation?.ephemeral_1h_input_tokens);
  const webSearches = num(usage.server_tool_use?.web_search_requests);

  // A record with no tokens at all is a placeholder, not a call.
  if (fresh + cacheRead + cacheWrite + output === 0) return null;

  const { usd } = claudeProvider.price(
    {
      fresh,
      cacheRead,
      // When the split is absent, bill the whole write at the cheaper 5m tier
      // rather than inventing an hour-TTL premium the user may not have paid.
      cacheWrite5m: cw5m || (cw1h ? 0 : cacheWrite),
      cacheWrite1h: cw1h,
      output,
      webSearches,
    },
    model,
  );

  const requestId = str(rec, 'requestId') || str(message, 'id');
  const sessionId = str(rec, 'sessionId');

  return {
    ts: tsOf(rec),
    source,
    provider: 'claude',
    model,
    requestType: 'LLM request',
    toolName: '',
    stepKind: 'llm',
    isTool: false,
    targets: [],
    toolIntent: '',
    toolQuery: '',
    resultBytes: 0,
    // Anthropic reports the three input classes separately; the meter's `prompt`
    // is the whole context that went over the wire, so it is their sum.
    prompt: fresh + cacheRead + cacheWrite,
    completion: output,
    cacheRead,
    cacheWrite,
    cacheWrite5m: cw5m,
    cacheWrite1h: cw1h,
    freshInput: fresh,
    aic: Number((usd * 100).toFixed(6)),
    usd: Number(usd.toFixed(8)),
    // Claude Code records tokens, never a price — every figure here is our own
    // arithmetic over list rates, so it is an estimate by construction.
    exact: false,
    promptSnippet: '',
    systemPromptFile: '',
    sessionId,
    spanId: str(rec, 'uuid'),
    parentSpanId: str(rec, 'parentUuid'),
    eventType: opts.agent ? 'assistant:subagent' : 'assistant',
    rawKey: `claude|${sessionId}|${requestId}`,
  };
}

function toolCore(
  rec: Record<string, unknown>,
  block: Record<string, unknown>,
  source: EventOrigin,
  roots: readonly string[],
  opts: ClaudeProcessOptions,
): StepCore {
  const toolName = str(block, 'name') || 'tool';
  const input = isRecord(block.input) ? block.input : undefined;
  const intent = claudeToolIntent(toolName);
  const sessionId = str(rec, 'sessionId');

  return {
    ts: tsOf(rec),
    source,
    provider: 'claude',
    model: '',
    requestType: 'tool_call',
    toolName,
    stepKind: claudeStepKind(intent),
    isTool: true,
    targets: claudeTargets(input, roots),
    toolIntent: intent,
    toolQuery: claudeToolQuery(input),
    // The payload size lives on the matching tool_result record, which arrives
    // later; emitting on the call instead keeps interrupted tools from vanishing.
    resultBytes: 0,
    prompt: 0,
    completion: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    freshInput: 0,
    aic: 0,
    usd: 0,
    exact: true,
    promptSnippet: '',
    systemPromptFile: '',
    sessionId,
    spanId: str(block, 'id'),
    parentSpanId: str(rec, 'uuid'),
    eventType: opts.agent ? 'tool_use:subagent' : 'tool_use',
    rawKey: `claude|${sessionId}|${str(block, 'id')}`,
  };
}

/**
 * The Claude counterpart to `processRecord`. Same signature shape, same funnel:
 * it builds StepCores and hands them to `emitStep`, so grouping fields are
 * always assigned and the contract's invariant holds for this format too.
 */
export function processClaudeRecord(
  rec: unknown,
  source: EventOrigin,
  ctx: ClaudeContext,
  emit: (ev: MeterEvent) => void,
  opts: ClaudeProcessOptions = {},
): void {
  if (!isRecord(rec)) return;
  const type = rec.type;
  if (type !== 'user' && type !== 'assistant') return;

  const message = isRecord(rec.message) ? rec.message : undefined;
  if (!message) return;

  // Every user record carries the promptId of the loop it belongs to — including
  // the tool_result records interleaved through it — so it is the loop identity
  // outright, with none of the span-chain reconstruction the Copilot log needs.
  if (type === 'user') {
    const promptId = str(rec, 'promptId') || str(rec, 'uuid');
    if (promptId) {
      ctx.currentPromptId = promptId;
      if (!ctx.promptIndexById.has(promptId))
        ctx.promptIndexById.set(promptId, ctx.promptIndexById.size + 1);
    }
    const text = userPromptText(message);
    // Only a real typed turn names the loop; a tool result must not overwrite it.
    if (text && promptId && !ctx.promptById.has(promptId)) {
      ctx.promptById.set(promptId, snippet(text));
    }
    return;
  }

  const model = claudeProvider.resolveModel(str(message, 'model'));
  // `<synthetic>` and friends name no real call. Billing them invents spend.
  if (!model) return;

  const groupId = opts.agent?.parentGroupId || ctx.currentPromptId;
  const roots = [str(rec, 'cwd'), ...(opts.repoRoots ?? [])].filter(Boolean);

  // Bill once per API response, however many content-block lines it was split
  // across. This is the whole ballgame for Claude cost accuracy.
  const requestId = str(rec, 'requestId') || str(message, 'id');
  if (requestId && !ctx.billed.has(requestId)) {
    ctx.billed.add(requestId);
    const core = billedCore(rec, message, source, model, opts);
    if (core) emitStep(core, groupId, ctx, emit);
  }

  const content = message.content;
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block) || block.type !== 'tool_use') continue;
    emitStep(toolCore(rec, block, source, roots, opts), groupId, ctx, emit);
  }
}
