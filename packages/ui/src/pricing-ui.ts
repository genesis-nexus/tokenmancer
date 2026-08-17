import { type StepEvent, type StepKind, rateFor } from '@cte/core';

export interface CostParts {
  read: number;
  write: number;
  fresh: number;
  out: number;
}

/** Split one billed call's cost into the four segments, in credits. */
export function costParts(ev: StepEvent): CostParts {
  const r = rateFor(ev.model);
  return {
    read: (ev.cacheRead * r.cached) / 1e6,
    write: (ev.cacheWrite * r.cw) / 1e6,
    fresh: (ev.freshInput * r.in) / 1e6,
    out: (ev.completion * r.out) / 1e6,
  };
}

export const SEG: Array<[keyof CostParts, string, string]> = [
  ['read', 'cache-read', 'var(--read)'],
  ['write', 'cache-write', 'var(--write)'],
  ['fresh', 'fresh input', 'var(--fresh)'],
  ['out', 'output', 'var(--out)'],
];

export const SEG_COLOR: Record<keyof CostParts, string> = {
  read: '#3987e5',
  write: '#008300',
  fresh: '#d55181',
  out: '#c98500',
};

/** The same four segments, said the way you would say them out loud. */
export const SEG_PLAIN: Record<keyof CostParts, string> = {
  read: 're-reading the conversation so far',
  write: 'saving the conversation for reuse',
  fresh: 'new material sent to the model',
  out: "the model's own reply",
};

/**
 * The single sentence a beginner needs about one loop: which of the four
 * segments dominated, and what that means. Anything below a third is not
 * really a story, so those get the neutral phrasing.
 */
export function dominantCostPhrase(parts: CostParts): string {
  const total = parts.read + parts.write + parts.fresh + parts.out;
  if (total <= 0) return 'This one was free — no billed model calls.';

  const entries = (Object.keys(parts) as Array<keyof CostParts>).map((k) => [k, parts[k]] as const);
  entries.sort((a, b) => b[1] - a[1]);
  const top = entries[0];
  if (!top) return '';

  const share = Math.round((top[1] / total) * 100);
  if (share < 34) return 'The cost was spread fairly evenly across reading, sending and replying.';
  return `Most of this — about ${share}% — went on ${SEG_PLAIN[top[0]]}.`;
}

export const STEP_META: Record<StepKind, { label: string; icon: string }> = {
  plan: { label: 'Plan / Reason', icon: '◆' },
  read: { label: 'Read file', icon: '▤' },
  search: { label: 'Search repo', icon: '⌕' },
  edit: { label: 'Edit code', icon: '✎' },
  verify: { label: 'Verify / Test', icon: '✓' },
  tool: { label: 'Tool call', icon: '⚙︎' },
  chat: { label: 'Chat reply', icon: '❯' },
  llm: { label: 'LLM request', icon: '·' },
};

export const stepMeta = (k: StepKind): { label: string; icon: string } =>
  STEP_META[k] ?? STEP_META.llm;

/** Tooltip payload shape shared by the cost/context bars. */
export interface TooltipData {
  t?: string;
  rows: Array<[string, string, string]>;
  n?: string;
}
