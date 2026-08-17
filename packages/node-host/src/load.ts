import * as fs from 'node:fs';
import { type MeterEvent, createGroupingContext, extractObjects, processRecord } from '@cte/core';
import { measureInstructionFiles } from './instrument.js';

export interface LoadOptions {
  /** Stamp step events with this session id (for archive replay). */
  sessionId?: string;
  defaultModel?: string;
  /** Workspace folders, so tool targets come out repo-relative. */
  repoRoots?: string[];
  /** Measure instruction files on disk. Defaults to the real fs measurer. */
  measureInstructions?: (s: Parameters<typeof measureInstructionFiles>[0]) => void;
  onError?: (e: unknown) => void;
}

/** Load and parse an entire jsonl log into a flat, grouped event list. */
export function loadLogFile(absFile: string, opts: LoadOptions = {}): MeterEvent[] {
  const events: MeterEvent[] = [];
  const ctx = createGroupingContext();
  const measure = opts.measureInstructions ?? measureInstructionFiles;
  try {
    const lines = fs.readFileSync(absFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const obj of extractObjects(line)) {
        processRecord(
          obj,
          'archive',
          ctx,
          (ev) => {
            if (ev.kind === 'step' && opts.sessionId) ev.sessionId = opts.sessionId;
            events.push(ev);
          },
          {
            defaultModel: opts.defaultModel,
            repoRoots: opts.repoRoots,
            measureInstructions: measure,
          },
        );
      }
    }
  } catch (e) {
    opts.onError?.(e);
  }
  return events;
}
