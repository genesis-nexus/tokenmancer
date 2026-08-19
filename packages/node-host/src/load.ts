import * as fs from 'node:fs';
import {
  type LogFormat,
  type MeterEvent,
  createClaudeContext,
  createGroupingContext,
  extractObjects,
  processClaudeRecord,
  processRecord,
} from '@cte/core';
import { measureInstructionFiles } from './instrument.js';
import { formatForLogPath } from './sources/claude.js';

export interface LoadOptions {
  /** Stamp step events with this session id (for archive replay). */
  sessionId?: string;
  /** Which transcript dialect the file is written in. Defaults to Copilot. */
  format?: LogFormat;
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
  const measure = opts.measureInstructions ?? measureInstructionFiles;
  const claude = (opts.format ?? formatForLogPath(absFile)) === 'claude';
  const ctx = claude ? createClaudeContext(createGroupingContext()) : createGroupingContext();
  const push = (ev: MeterEvent) => {
    if (ev.kind === 'step' && opts.sessionId) ev.sessionId = opts.sessionId;
    events.push(ev);
  };
  try {
    const lines = fs.readFileSync(absFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      for (const obj of extractObjects(line)) {
        if (claude) {
          processClaudeRecord(obj, 'archive', ctx as ReturnType<typeof createClaudeContext>, push, {
            repoRoots: opts.repoRoots,
          });
        } else {
          processRecord(obj, 'archive', ctx, push, {
            defaultModel: opts.defaultModel,
            repoRoots: opts.repoRoots,
            measureInstructions: measure,
          });
        }
      }
    }
  } catch (e) {
    opts.onError?.(e);
  }
  return events;
}
