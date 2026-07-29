// The wire contract shared by every producer (web server, extension host) and the
// single UI renderer. Making the grouping fields REQUIRED on StepEvent is what
// prevents the historical bug where the inbox path emitted ungrouped, prompt-less
// events (see plan §2): the only way to construct a StepEvent is through
// `processRecord`, which always assigns them.

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
  model: string;
  requestType: string;
  toolName: string;
  stepKind: StepKind;
  isTool: boolean;

  // --- token counts ---
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  freshInput: number;

  // --- cost ---
  aic: number;
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
  control: 'session' | 'hello';
}

export type MeterEvent = StepEvent | InstructionsEvent | ControlEvent;

/** Commands a UI sends back to its producer (server route or extension host). */
export type MeterCommand =
  | { type: 'tail'; ws: string; session?: string; log?: string }
  | { type: 'loadSession'; ws: string; session: string; log?: string }
  | { type: 'listWorkspaces' }
  | { type: 'newSession' };
