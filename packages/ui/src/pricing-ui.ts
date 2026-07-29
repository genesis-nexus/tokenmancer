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
