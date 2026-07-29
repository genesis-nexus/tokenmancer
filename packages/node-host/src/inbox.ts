import * as fs from 'node:fs';
import * as path from 'node:path';
import { type MeterEvent, createGroupingContext, extractObjects, processRecord } from '@cte/core';
import { measureInstructionFiles } from './instrument.js';

export interface InboxOptions {
  emit: (ev: MeterEvent) => void;
  pollInterval?: number;
  defaultModel?: string;
  measureInstructions?: (s: Parameters<typeof measureInstructionFiles>[0]) => void;
  onError?: (e: unknown) => void;
}

export interface InboxController {
  readonly file: string;
  stop(): void;
}

/**
 * Watch a paste-inbox file and emit newly-seen usage blocks. Unlike the original
 * server (which emitted raw `toEvent()` results and thus produced ungrouped,
 * prompt-less events), this rescans the whole file through `processRecord` and
 * de-duplicates by the event's stable `rawKey`, so inbox events group correctly.
 */
export function watchInbox(file: string, opts: InboxOptions): InboxController {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, '');
  const measure = opts.measureInstructions ?? measureInstructionFiles;
  const seenSteps = new Set<string>();
  let lastInstrSig = '';

  function rescan(): void {
    try {
      const text = fs.readFileSync(abs, 'utf8');
      const ctx = createGroupingContext();
      const batch: MeterEvent[] = [];
      for (const obj of extractObjects(text)) {
        processRecord(obj, 'inbox', ctx, (ev) => batch.push(ev), {
          defaultModel: opts.defaultModel,
          measureInstructions: measure,
        });
      }
      for (const ev of batch) {
        if (ev.kind === 'step') {
          if (seenSteps.has(ev.rawKey)) continue;
          seenSteps.add(ev.rawKey);
          opts.emit(ev);
        } else if (ev.kind === 'instructions') {
          const sig = `${ev.totalTokens}|${ev.resolvedCount}|${ev.loaded.join(',')}`;
          if (sig === lastInstrSig) continue;
          lastInstrSig = sig;
          opts.emit(ev);
        } else {
          opts.emit(ev);
        }
      }
    } catch (e) {
      opts.onError?.(e);
    }
  }

  const listener = () => rescan();
  fs.watchFile(abs, { interval: opts.pollInterval ?? 400 }, listener);
  rescan();

  return {
    file: abs,
    stop(): void {
      try {
        fs.unwatchFile(abs, listener);
      } catch {
        // already detached
      }
    },
  };
}
