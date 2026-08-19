import type { StepKind } from '../contract/events.js';
import type { TokenDetail } from '../pricing/credits.js';

/** Aliases seen across Copilot debug-log schema variants. */
const KEY = {
  prompt: ['prompt_tokens', 'prompttokens', 'input_tokens', 'inputtokens'],
  completion: ['completion_tokens', 'completiontokens', 'output_tokens', 'outputtokens'],
  cacheRead: [
    'cached_tokens',
    'cachedtokens',
    'cache_read_input_tokens',
    'cachereadtokens',
    'cache_read',
  ],
  cacheWrite: [
    'cache_creation_input_tokens',
    'cache_creation_tokens',
    'cachecreationtokens',
    'cachecreationinputtokens',
    'cachewritetokens',
  ],
  model: ['resolved model', 'resolvedmodel', 'model', 'modelid', 'requestmodel'],
  reqType: ['requesttype', 'request_type', 'type', 'name'],
  tool: ['tool', 'toolname', 'tool_name', 'function', 'functionname', 'function_name'],
} as const;

type NumericField = 'prompt' | 'completion' | 'cacheRead' | 'cacheWrite';
type StringField = 'model' | 'reqType' | 'tool';

const NANO_KEYS = [
  'total_nano_aiu',
  'copilotusagenanoaiu',
  'copilot_usage_nano_aiu',
  'nano_aiu',
  'usagenanoaiu',
];

export interface Harvested {
  prompt?: number;
  completion?: number;
  cacheRead?: number;
  cacheWrite?: number;
  model?: string;
  reqType?: string;
  tool?: string;
  /** "1.94 AIC (… nano-AIU)" free-text usage string. */
  copilotUsageStr?: string;
  /** exact per-call credit in nano-AIU. */
  nano?: number;
  tokenDetails?: TokenDetail[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Recursively harvest known numeric/string fields from a log record, tolerant
 *  of schema drift. First occurrence of each field wins. */
export function harvest(obj: unknown, out: Harvested = {}): Harvested {
  if (!isRecord(obj)) {
    if (Array.isArray(obj)) for (const v of obj) harvest(v, out);
    return out;
  }
  if (Array.isArray(obj)) {
    for (const v of obj) harvest(v, out);
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    for (const field of Object.keys(KEY) as (keyof typeof KEY)[]) {
      if ((KEY[field] as readonly string[]).includes(lk) && out[field] == null) {
        if (field === 'model' || field === 'reqType' || field === 'tool') {
          if (typeof v === 'string') out[field as StringField] = v;
        } else if (typeof v === 'number') {
          out[field as NumericField] = v;
        }
      }
    }
    if (lk === 'copilotusage' && typeof v === 'string') out.copilotUsageStr = v;
    if (out.nano == null && typeof v === 'number' && NANO_KEYS.includes(lk)) out.nano = v;
    if (lk === 'token_details' && Array.isArray(v)) out.tokenDetails = v as TokenDetail[];
    harvest(v, out);
  }
  return out;
}

/**
 * Classify one agent-loop step so the meter reads like a story
 * (plan → read → search → edit → verify) rather than an anonymous call list.
 */
export function classifyStep(reqType?: string, toolName?: string): StepKind {
  // Separators are stripped before matching. Real Copilot tools are snake_case
  // (`create_file`, `read_file`), and without this `create_file` fell through
  // the edit rule — which looks for `createfile` — and was caught by the read
  // rule's `file\b`, so every file creation was reported as "Read file".
  const s = `${reqType || ''} ${toolName || ''}`.toLowerCase().replace(/[-_]/g, '');
  if (/edit|apply|patch|insert|replace|createfile|writefile|createdirectory/.test(s)) return 'edit';
  if (/grep|search|find|semantic|codebase|usages|ripgrep/.test(s)) return 'search';
  if (/read|open|view|file\b|readfile|cat/.test(s)) return 'read';
  if (/test|run|terminal|verify|build|lint|exec/.test(s)) return 'verify';
  if (/plan|reason|think|todo/.test(s)) return 'plan';
  if (/tool|mcp|function/.test(s)) return 'tool';
  if (/chat|ask|panel\/chat|reply|conversation/.test(s)) return 'chat';
  return 'llm';
}
