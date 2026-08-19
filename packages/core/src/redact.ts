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
  /**
   * When true (the shipped default), prompt text passes through untouched. The
   * prompt is the only human-readable handle on a loop — without it a card is
   * an anonymous pile of token counts — and it never leaves the machine.
   */
  showPrompts: boolean;
  /**
   * Shell command heads and search strings. Independent of `showPrompts` and
   * defaulting to off: these are the field most likely to contain a pasted
   * secret, and unlike the prompt nobody needs one to recognise a loop.
   */
  showToolQueries?: boolean;
  /**
   * When false, only repo-relative tool targets survive. `normalizeTargetPath`
   * already degrades an unmatched absolute path to a bare basename, so this is
   * the second line of defence, not the first. Defaults to true: knowing the
   * agent read `src/server.ts` is the whole point of the file-cost report, and
   * it reveals far less than the prompt text does.
   */
  showPaths?: boolean;
  /** Per-run salt so tags aren't stable across processes/machines. */
  salt?: string;
}

/** A path that still looks absolute or escapes the repo must not leave the host. */
function isRelativeTarget(p: string): boolean {
  return !!p && !p.startsWith('/') && !/^[a-z]:/i.test(p) && !p.split('/').includes('..');
}

export function redactStepEvent(ev: StepEvent, opts: RedactOptions): StepEvent {
  const dropPaths = opts.showPaths === false;
  // A non-relative target is a leak whatever the other switches say.
  const targets = dropPaths ? [] : ev.targets.filter(isRelativeTarget);
  const toolQuery = opts.showToolQueries === true ? ev.toolQuery : '';

  if (opts.showPrompts) {
    // Identity when nothing needed removing, so the common path allocates
    // nothing and `===` still holds for callers that memoise on the event.
    return targets.length === ev.targets.length && toolQuery === ev.toolQuery
      ? ev
      : { ...ev, toolQuery, targets };
  }

  // Emptiness is decided on the text alone — folding the salt in first made a
  // salted run tag every prompt-less step, implying text that was never there.
  const text = ev.userPrompt || ev.promptSnippet || '';
  const tag = text.trim() ? `‹redacted ${shortHash((opts.salt ?? '') + text)}›` : '';
  return { ...ev, userPrompt: '', promptSnippet: tag, toolQuery, targets };
}

/** Redact prompt text from any event before it leaves the producer. Non-step
 *  events carry no prompt text and pass through unchanged. */
export function redactEvent(ev: MeterEvent, opts: RedactOptions): MeterEvent {
  return ev.kind === 'step' ? redactStepEvent(ev, opts) : ev;
}
