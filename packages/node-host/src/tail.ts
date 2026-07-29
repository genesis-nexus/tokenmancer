import * as fs from 'node:fs';
import * as path from 'node:path';
import { type MeterEvent, createGroupingContext, extractObjects, processRecord } from '@cte/core';
import { measureInstructionFiles } from './instrument.js';

export interface TailOptions {
  emit: (ev: MeterEvent) => void;
  /** Replay the whole file instead of only new lines. */
  fromStart?: boolean;
  /** Recent lines to preload on start (default 200). */
  preloadLines?: number;
  /** watchFile poll interval in ms (default 400). */
  pollInterval?: number;
  defaultModel?: string;
  measureInstructions?: (s: Parameters<typeof measureInstructionFiles>[0]) => void;
  onError?: (e: unknown) => void;
}

export interface TailController {
  readonly file: string;
  stop(): void;
}

/**
 * Tail a jsonl log line-by-line and route every record through the single
 * `processRecord` funnel (so tailed events are always grouped). Returns a
 * controller whose `stop()` detaches the watcher.
 */
export function startLiveTail(file: string, opts: TailOptions): TailController {
  const abs = path.resolve(file);
  const pollInterval = opts.pollInterval ?? 400;
  const preloadLines = opts.preloadLines ?? 200;
  const ctx = createGroupingContext();
  const measure = opts.measureInstructions ?? measureInstructionFiles;
  const feed = (obj: unknown) =>
    processRecord(obj, 'tail', ctx, opts.emit, {
      defaultModel: opts.defaultModel,
      measureInstructions: measure,
    });

  let pos = 0;
  let buf = '';

  function preloadRecent(limit: number): void {
    try {
      const lines = fs
        .readFileSync(abs, 'utf8')
        .split('\n')
        .filter((l) => l.trim());
      const start = Math.max(0, lines.length - limit);
      for (let i = start; i < lines.length; i++) {
        const line = lines[i];
        if (!line) continue;
        for (const o of extractObjects(line)) feed(o);
      }
    } catch {
      // file not readable yet — the watcher will pick it up
    }
  }

  function read(): void {
    fs.stat(abs, (err, st) => {
      if (err) return;
      if (st.size < pos) {
        pos = 0;
        buf = '';
      } // rotated/truncated
      if (st.size === pos) return;
      const s = fs.createReadStream(abs, { start: pos, end: st.size - 1 });
      s.on('data', (d) => {
        buf += d.toString('utf8');
      });
      s.on('end', () => {
        pos = st.size;
        for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) for (const o of extractObjects(line)) feed(o);
        }
      });
      s.on('error', (e) => opts.onError?.(e));
    });
  }

  try {
    const st = fs.statSync(abs);
    if (opts.fromStart) {
      pos = 0;
      read();
    } else {
      preloadRecent(preloadLines);
      pos = st.size;
    }
  } catch {
    pos = 0;
    read();
  }

  const listener = () => read();
  fs.watchFile(abs, { interval: pollInterval }, listener);

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
