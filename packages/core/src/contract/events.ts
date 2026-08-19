// The wire contract shared by every producer (web server, extension host) and the
// single UI renderer. Making the grouping fields REQUIRED on StepEvent is what
// prevents the historical bug where the inbox path emitted ungrouped, prompt-less
// events (see plan §2): the only way to construct a StepEvent is through
// `processRecord`, which always assigns them.

import type { AlertSeverity, BudgetPeriod } from '../budget/types.js';
import type { ToolIntent } from '../parse/tool-args.js';
import type { ProviderId } from '../pricing/provider.js';

export type StepKind = 'plan' | 'read' | 'search' | 'edit' | 'tool' | 'verify' | 'chat' | 'llm';

/** Where an event was sourced from. (Named EventOrigin to avoid colliding with
 *  the DOM `EventSource` SSE class in browser packages.) */
export type EventOrigin = 'tail' | 'archive' | 'inbox';

/** One billed (or free tool) step of an agent loop. */
export interface StepEvent {
  kind: 'step';
  id: number;
  ts: number;
  source: EventOrigin;

  // --- grouping: REQUIRED. A producer cannot emit a step without these. ---
  groupId: string;
  promptGroupIndex: number;
  stepIndex: number;
  userPrompt: string;

  // --- classification ---
  /** Which meter produced this step. Decides the unit `cost` is denominated in. */
  provider: ProviderId;
  model: string;
  requestType: string;
  toolName: string;
  stepKind: StepKind;
  isTool: boolean;

  // --- what the step touched: REQUIRED, same reasoning as grouping above. ---
  /** Repo-relative paths this step touched. Always [] for an LLM step. */
  targets: string[];
  /** What it did to them. '' for an LLM step. */
  toolIntent: ToolIntent | '';
  /** Search query or command head. '' when redacted or absent. */
  toolQuery: string;
  /** Size of the tool's result payload; the weight for parallel-tool splits. */
  resultBytes: number;

  // --- token counts ---
  prompt: number;
  completion: number;
  cacheRead: number;
  /** Total cache-write tokens. Always authoritative. */
  cacheWrite: number;
  /**
   * Optional breakdown of `cacheWrite` by TTL, which Anthropic prices differently
   * (5-minute 1.25x input, 1-hour 2x). Both 0 when the provider does not report a
   * split — read `cacheWrite` for the total, never these two summed.
   */
  cacheWrite5m: number;
  cacheWrite1h: number;
  freshInput: number;

  // --- cost ---
  /**
   * Cost in hundredths of a US dollar. Named for Copilot's AI-Credit, which is
   * *defined* as $0.01 — so the same number is a credit count for Copilot and a
   * cent count for Claude, and a credit-denominated budget spans both correctly.
   */
  aic: number;
  /** The canonical cost axis. Always populated; `aic` is this times 100. */
  usd: number;
  /** true = number came straight from the log; false = rate-table estimate. */
  exact: boolean;

  // --- text (either field may be '' when redacted) ---
  promptSnippet: string;
  systemPromptFile: string;

  // --- provenance ---
  sessionId: string;
  spanId: string;
  parentSpanId: string;
  eventType: string;
  /** stable signature used for de-duplication across replay/tail. */
  rawKey: string;
}

export interface InstructionFile {
  name: string;
  kind: string;
  bytes: number;
  tokens: number;
}

/** Custom-instruction / always-in-context telemetry that rides on every call. */
export interface InstructionsEvent {
  kind: 'instructions';
  id: number;
  ts: number;
  source: EventOrigin;
  sessionId: string;
  resolvedCount: number;
  discoveryMs: number | null;
  loaded: string[];
  folders: string[];
  contextIncluded: string[];
  onDemand: { instructions: string[]; skills: string[]; agents: string[] };
  files: InstructionFile[];
  totalBytes: number;
  totalTokens: number;
}

/** Out-of-band control signal folded into the same stream. */
export interface ControlEvent {
  kind: 'control';
  control: 'session';
}

/**
 * A budget threshold crossing that survived dedupe and cooldown. Riding the same
 * union as steps is what gets alerts to both surfaces for free: the SSE framer
 * and the webview poster already forward every MeterEvent.
 */
export interface AlertEvent {
  kind: 'alert';
  /** `${ruleId}:${periodKey}:${threshold}` — stable, so a UI can de-dupe too. */
  id: string;
  ts: number;
  severity: AlertSeverity;
  title: string;
  body: string;
  ruleId: string;
  period: BudgetPeriod;
  observed: number;
  limit: number;
  /** Optional call to action the UI renders as a button. */
  action?: { kind: 'openSetting' | 'openBudget' | 'openRepoReport'; arg?: string };
}

export type MeterEvent = StepEvent | InstructionsEvent | ControlEvent | AlertEvent;
