import type { MeterEvent, StepEvent } from './contract/events.js';

/** Small, non-cryptographic FNV-1a hash — enough to give a redacted event a
 *  stable, opaque tag without revealing the prompt. Not a security primitive. */
function shortHash(s: string): string {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
}

export interface RedactOptions {
  /** When true, prompt text passes through untouched. Default posture is false. */
  showPrompts: boolean;
  /** Per-run salt so tags aren't stable across processes/machines. */
  salt?: string;
}

export function redactStepEvent(ev: StepEvent, opts: RedactOptions): StepEvent {
  if (opts.showPrompts) return ev;
  const material = (opts.salt ?? '') + (ev.userPrompt || ev.promptSnippet || '');
  const tag = material.trim() ? `‹redacted ${shortHash(material)}›` : '';
  return { ...ev, userPrompt: '', promptSnippet: tag };
}

/** Redact prompt text from any event before it leaves the producer. Non-step
 *  events carry no prompt text and pass through unchanged. */
export function redactEvent(ev: MeterEvent, opts: RedactOptions): MeterEvent {
  return ev.kind === 'step' ? redactStepEvent(ev, opts) : ev;
}
