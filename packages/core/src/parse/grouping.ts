import type { EventOrigin, InstructionsEvent, MeterEvent, StepEvent } from '../contract/events.js';
import {
  aicFromDetails,
  creditsFromCounts,
  freshInput,
  parseAicFromText,
} from '../pricing/credits.js';
import { CREDIT_USD, DEFAULT_MODEL, rateFor } from '../pricing/models.js';
import { classifyStep, harvest } from './harvest.js';
import {
  type InstructionAccumulator,
  isInstructionRecord,
  parseInstructions,
  repoRootsFromFolders,
} from './instructions.js';
import { extractPromptSnippet } from './prompt.js';
import { parseToolArgs } from './tool-args.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
function str(rec: Record<string, unknown>, key: string): string {
  const v = rec[key];
  return typeof v === 'string' ? v : '';
}

/** Per-session parsing state. Carries the sequence counters so nothing depends
 *  on module-level globals (makes the parser trivially testable + reentrant). */
export interface GroupingContext {
  currentPromptId: string;
  promptById: Map<string, string>;
  spanToPromptId: Map<string, string>;
  promptIndexById: Map<string, number>;
  stepCountById: Map<string, number>;
  promptSeq: number;
  seq: number;
  instr?: InstructionAccumulator;
}

export function createGroupingContext(): GroupingContext {
  return {
    currentPromptId: '',
    promptById: new Map(),
    spanToPromptId: new Map(),
    promptIndexById: new Map(),
    stepCountById: new Map(),
    promptSeq: 0,
    seq: 0,
  };
}

export interface ProcessOptions {
  /** Fallback model when a record carries no model id. */
  defaultModel?: string;
  /** Injected by the Node host to measure instruction files on disk (bytes/tokens). */
  measureInstructions?: (state: InstructionAccumulator) => void;
  /**
   * Workspace folders used to make tool targets repo-relative. The Node host
   * knows these up front; otherwise they are derived from the instruction
   * folders the log itself reports. A target that matches no root degrades to
   * its basename, so this only improves precision — it is never required.
   */
  repoRoots?: string[];
}

function registerPromptRecord(rec: Record<string, unknown>, ctx: GroupingContext): string {
  const sid = str(rec, 'sid') || 'session';
  const spanId = str(rec, 'spanId');
  const groupId = spanId || `${sid}:prompt:${++ctx.promptSeq}`;
  const attrs = isRecord(rec.attrs) ? rec.attrs : undefined;
  const promptText =
    extractPromptSnippet(rec) ||
    (typeof attrs?.content === 'string' ? attrs.content : '') ||
    '[Prompt text unavailable]';
  ctx.currentPromptId = groupId;
  ctx.promptById.set(groupId, promptText);
  if (!ctx.promptIndexById.has(groupId))
    ctx.promptIndexById.set(groupId, ctx.promptIndexById.size + 1);
  if (spanId) ctx.spanToPromptId.set(spanId, groupId);
  return groupId;
}

function linkRecordToPrompt(rec: Record<string, unknown>, ctx: GroupingContext): string {
  const spanId = str(rec, 'spanId');
  const parentSpanId = str(rec, 'parentSpanId');
  let groupId = '';
  if (parentSpanId) groupId = ctx.spanToPromptId.get(parentSpanId) || '';
  if (!groupId && parentSpanId && ctx.promptById.has(parentSpanId)) groupId = parentSpanId;
  if (!groupId) groupId = ctx.currentPromptId || '';
  if (spanId) ctx.spanToPromptId.set(spanId, groupId);
  return groupId;
}

/** Everything about a step EXCEPT id + grouping (which only `emitStep` assigns). */
export type StepCore = Omit<
  StepEvent,
  'kind' | 'id' | 'groupId' | 'promptGroupIndex' | 'stepIndex' | 'userPrompt'
>;

/**
 * Assign the grouping fields and emit. This is the funnel the contract's doc
 * comment refers to: a format parser produces a StepCore and hands it here, and
 * cannot construct a StepEvent any other way, so an ungrouped or prompt-less
 * step stays structurally impossible however many log formats we support.
 */
export function emitStep(
  core: StepCore,
  groupId: string,
  ctx: GroupingContext,
  emit: (ev: MeterEvent) => void,
): void {
  const gid = groupId || 'ungrouped';
  if (!ctx.promptIndexById.has(gid)) ctx.promptIndexById.set(gid, ctx.promptIndexById.size + 1);
  const promptGroupIndex = ctx.promptIndexById.get(gid) ?? 1;
  const stepIndex = (ctx.stepCountById.get(gid) ?? 0) + 1;
  ctx.stepCountById.set(gid, stepIndex);
  const userPrompt = ctx.promptById.get(gid) ?? '[Prompt text unavailable for this event]';

  emit({
    kind: 'step',
    id: ++ctx.seq,
    groupId: gid,
    promptGroupIndex,
    stepIndex,
    userPrompt,
    ...core,
  });
}

/** Cap on the result payload we measure — the weight only needs to be comparable. */
const MAX_RESULT_BYTES = 1_000_000;

function resultBytesOf(attrs: Record<string, unknown> | undefined): number {
  const r = attrs?.result ?? attrs?.output ?? attrs?.content;
  if (r == null) return 0;
  const s = typeof r === 'string' ? r : JSON.stringify(r);
  return Math.min(s?.length ?? 0, MAX_RESULT_BYTES);
}

function buildStepCore(
  rec: Record<string, unknown>,
  source: EventOrigin,
  defaultModel: string,
  repoRoots: readonly string[],
): StepCore | null {
  const h = harvest(rec, {});
  const hasTokens = h.prompt != null || h.completion != null;
  const hasCredit = h.nano != null || h.tokenDetails != null || h.copilotUsageStr != null;
  const isToolCall = rec.type === 'tool_call';
  if (!hasTokens && !hasCredit && !isToolCall) return null;

  const prompt = h.prompt || 0;
  const completion = h.completion || 0;
  const cacheRead = h.cacheRead || 0;
  const cacheWrite = h.cacheWrite || 0;
  const fresh = freshInput(prompt, cacheRead, cacheWrite);

  let aic = 0;
  if (h.nano != null) aic = h.nano / 1e9;
  else if (h.tokenDetails != null) aic = aicFromDetails(h.tokenDetails);
  else if (h.copilotUsageStr != null) aic = parseAicFromText(h.copilotUsageStr) ?? 0;
  else if (hasTokens) {
    const r = rateFor(h.model);
    aic = creditsFromCounts({ fresh, cacheRead, cacheWrite, output: completion }, r);
  }

  const isToolStep = isToolCall && !hasTokens && !hasCredit;
  let requestType: string;
  let toolName: string;
  let model: string;
  if (isToolStep) {
    toolName = str(rec, 'name') || h.tool || 'tool';
    requestType = 'tool_call';
    model = '';
  } else {
    requestType = h.reqType || 'LLM request';
    toolName = h.tool || '';
    model = h.model || defaultModel;
  }
  const stepKind = classifyStep(requestType, toolName);
  const snippet = extractPromptSnippet(rec);
  const attrs = isRecord(rec.attrs) ? rec.attrs : undefined;
  const ts = typeof rec.ts === 'number' ? rec.ts : Date.now();
  const roundedAic = Number(aic.toFixed(6));

  // Only tool steps have targets. An LLM step's cost is what a *previous* tool
  // put in its context, which is the attribution engine's job, not the parser's.
  const args = isToolStep ? parseToolArgs(attrs?.args, toolName, repoRoots) : null;

  return {
    ts,
    source,
    provider: 'copilot',
    model,
    requestType,
    toolName,
    stepKind,
    isTool: isToolStep,
    targets: args ? args.targets.map((t) => t.path) : [],
    toolIntent: args ? args.intent : '',
    toolQuery: args ? args.query : '',
    resultBytes: args ? resultBytesOf(attrs) : 0,
    prompt,
    completion,
    cacheRead,
    cacheWrite,
    // Copilot quotes a single cache-write rate and never says which TTL applied.
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    freshInput: fresh,
    aic: roundedAic,
    usd: Number((roundedAic * CREDIT_USD).toFixed(8)),
    exact: hasCredit || isToolStep,
    promptSnippet: snippet || '[No prompt/chat payload in this log event]',
    systemPromptFile: typeof attrs?.systemPromptFile === 'string' ? attrs.systemPromptFile : '',
    sessionId: str(rec, 'sid'),
    spanId: str(rec, 'spanId'),
    parentSpanId: str(rec, 'parentSpanId'),
    eventType: str(rec, 'type'),
    rawKey: `${str(rec, 'sid')}|${str(rec, 'spanId')}|${typeof rec.ts === 'number' ? rec.ts : ''}|${str(rec, 'type')}|${h.model || ''}|${prompt}|${completion}|${roundedAic}`,
  };
}

/**
 * THE single funnel. Every source (tail, archive, inbox) routes each record
 * through here, so the grouping fields are always assigned — the historical
 * inbox-bypass bug (ungrouped, prompt-less events) is structurally impossible.
 */
export function processRecord(
  rec: unknown,
  source: EventOrigin,
  ctx: GroupingContext,
  emit: (ev: MeterEvent) => void,
  opts: ProcessOptions = {},
): void {
  if (!isRecord(rec)) return;

  if (rec.type === 'user_message') {
    registerPromptRecord(rec, ctx);
    return;
  }

  if (isInstructionRecord(rec)) {
    ctx.instr = parseInstructions(rec, ctx.instr);
    opts.measureInstructions?.(ctx.instr);
    const s = ctx.instr;
    const ev: InstructionsEvent = {
      kind: 'instructions',
      id: ++ctx.seq,
      ts: s.ts,
      source,
      sessionId: str(rec, 'sid'),
      resolvedCount: s.resolvedCount,
      discoveryMs: s.discoveryMs,
      loaded: [...s.loaded],
      folders: [...s.folders],
      contextIncluded: [...s.contextIncluded],
      onDemand: {
        instructions: [...s.onDemand.instructions],
        skills: [...s.onDemand.skills],
        agents: [...s.onDemand.agents],
      },
      files: s.files.map((f) => ({ ...f })),
      totalBytes: s.totalBytes,
      totalTokens: s.totalTokens,
    };
    emit(ev);
    return;
  }

  // Host-supplied roots win; otherwise fall back to whatever the log's own
  // instruction telemetry has revealed so far.
  const repoRoots = opts.repoRoots?.length
    ? opts.repoRoots
    : ctx.instr
      ? repoRootsFromFolders(ctx.instr.folders)
      : [];

  const core = buildStepCore(rec, source, opts.defaultModel ?? DEFAULT_MODEL, repoRoots);
  if (!core) return;

  emitStep(core, linkRecordToPrompt(rec, ctx), ctx, emit);
}
