import type { InstructionsEvent, MeterEvent, StepEvent } from '@cte/core';
import { computed, signal } from '@preact/signals';
import { type CostParts, costParts } from '../pricing-ui.js';

export interface LoopGroup {
  groupId: string;
  index: number;
  promptText: string;
  startTs: number;
  steps: StepEvent[];
  aic: number;
  prompt: number;
  completion: number;
  cacheRead: number;
  cacheWrite: number;
  fresh: number;
  cParts: CostParts;
  models: string[];
}

export type ConnState = 'connecting' | 'live' | 'down';

export const groups = signal<LoopGroup[]>([]); // newest first
export const instructions = signal<InstructionsEvent | null>(null);
export const connection = signal<ConnState>('connecting');
/** ids of groups created since the last frame, for the pop animation. */
export const freshGroups = signal<Set<string>>(new Set());

const MEANINGLESS = /unavailable|not in log|no linked|prompt text not in log/i;

export function addStep(ev: StepEvent): void {
  const list = groups.value;
  let g = list.find((x) => x.groupId === ev.groupId);
  let order = list;
  if (!g) {
    g = {
      groupId: ev.groupId,
      index: ev.promptGroupIndex,
      promptText: '',
      startTs: ev.ts,
      steps: [],
      aic: 0,
      prompt: 0,
      completion: 0,
      cacheRead: 0,
      cacheWrite: 0,
      fresh: 0,
      cParts: { read: 0, write: 0, fresh: 0, out: 0 },
      models: [],
    };
    order = [g, ...list]; // newest first
    const fresh = new Set(freshGroups.value);
    fresh.add(g.groupId);
    freshGroups.value = fresh;
  }
  if (ev.userPrompt && !MEANINGLESS.test(ev.userPrompt)) g.promptText = ev.userPrompt;
  g.steps = [...g.steps, ev];
  g.aic += ev.aic;
  g.prompt += ev.prompt;
  g.completion += ev.completion;
  g.cacheRead += ev.cacheRead;
  g.cacheWrite += ev.cacheWrite;
  g.fresh += ev.freshInput;
  if (!ev.isTool) {
    const p = costParts(ev);
    g.cParts = {
      read: g.cParts.read + p.read,
      write: g.cParts.write + p.write,
      fresh: g.cParts.fresh + p.fresh,
      out: g.cParts.out + p.out,
    };
  }
  if (ev.model && !g.models.includes(ev.model)) g.models = [...g.models, ev.model];
  groups.value = [...order]; // notify subscribers
}

export function setInstructions(ev: InstructionsEvent): void {
  instructions.value = ev;
}

export function resetSession(): void {
  groups.value = [];
  instructions.value = null;
  freshGroups.value = new Set();
}

/** Dispatch any event from a transport into the store. */
export function dispatch(ev: MeterEvent): void {
  if (ev.kind === 'control') {
    if (ev.control === 'session') resetSession();
    return;
  }
  if (ev.kind === 'instructions') {
    setInstructions(ev);
    return;
  }
  addStep(ev);
}

export interface ModelSpend {
  model: string;
  calls: number;
  aic: number;
  tok: number;
}
export interface Totals {
  aic: number;
  calls: number;
  steps: number;
  tok: number;
  inTok: number;
  outTok: number;
  loops: number;
  models: ModelSpend[];
}

export const totals = computed<Totals>(() => {
  let aic = 0;
  let calls = 0;
  let steps = 0;
  let tok = 0;
  let inTok = 0;
  let outTok = 0;
  const models = new Map<string, ModelSpend>();
  for (const g of groups.value) {
    for (const ev of g.steps) {
      aic += ev.aic;
      steps++;
      if (!ev.isTool) {
        calls++;
        tok += ev.prompt + ev.completion;
        inTok += ev.prompt;
        outTok += ev.completion;
        const mv = models.get(ev.model) ?? { model: ev.model, calls: 0, aic: 0, tok: 0 };
        mv.calls++;
        mv.aic += ev.aic;
        mv.tok += ev.prompt + ev.completion;
        models.set(ev.model, mv);
      }
    }
  }
  return {
    aic,
    calls,
    steps,
    tok,
    inTok,
    outTok,
    loops: groups.value.length,
    models: [...models.values()].sort((a, b) => b.aic - a.aic),
  };
});

export const dominantModel = computed<string>(() => {
  let dom = 'claude-sonnet-4.6';
  let n = 0;
  for (const m of totals.value.models) {
    if (m.calls > n) {
      n = m.calls;
      dom = m.model;
    }
  }
  return dom;
});
