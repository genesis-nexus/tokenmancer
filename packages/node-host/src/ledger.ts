// The spend ledger: an append-only JSONL record of every billed step, rotated
// monthly. This is the only reason month-to-date spend can survive a restart,
// and the only reason a budget can mean anything.
//
// Two writers are expected. If the web app and the extension are both tailing
// the same Copilot log, both will observe the same StepEvent and both will try
// to record it. The entry's primary key is the step's `rawKey` — already a
// stable dedupe signature over (sid, spanId, ts, type, model, tokens, aic) — so
// readers collapse the duplicate. This is the same mechanism watchInbox uses.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { type StepEvent, extractObjects, periodKeyFor } from '@cte/core';
import { appendLine, ensureDir, stateDir } from './paths.js';

/** Bump when the entry shape changes; readers skip rows they do not understand. */
export const LEDGER_SCHEMA = 1;

export interface LedgerEntry {
  schema: number;
  /** Dedupe key. Two processes recording the same step produce the same value. */
  rawKey: string;
  ts: number;
  workspaceId: string;
  sessionId: string;
  groupId: string;
  model: string;
  aic: number;
  prompt: number;
  completion: number;
  cacheRead: number;
  freshInput: number;
  isTool: boolean;
  toolName: string;
  /**
   * Repo-relative paths the step touched. Written from day one even though the
   * attribution engine that reads it ships later — so when it does, it reports
   * on real history instead of an empty table.
   */
  targets: string[];
  /** Context tokens attributed to this step. 0 until the attribution engine lands. */
  contextTokens: number;
}

export interface SpendTotals {
  credits: number;
  tokens: number;
  steps: number;
}

export function ledgerFileFor(ts: number): string {
  return path.join(stateDir(), `ledger-${periodKeyFor('month', ts)}.jsonl`);
}

/**
 * Build an entry from a step. Free tool steps are recorded too: they contribute
 * 0 credits, but they carry the `targets` the repo report is built from.
 */
export function entryFromStep(ev: StepEvent, workspaceId: string): LedgerEntry {
  return {
    schema: LEDGER_SCHEMA,
    rawKey: ev.rawKey,
    ts: ev.ts,
    workspaceId,
    sessionId: ev.sessionId,
    groupId: ev.groupId,
    model: ev.model,
    aic: ev.aic,
    prompt: ev.prompt,
    completion: ev.completion,
    cacheRead: ev.cacheRead,
    freshInput: ev.freshInput,
    isTool: ev.isTool,
    toolName: ev.toolName,
    targets: ev.targets,
    contextTokens: 0,
  };
}

/**
 * A ledger writer. Holds the per-process seen-set that stops this process
 * re-appending a step it already recorded (a tail restart replays the tail of
 * the file); cross-process duplicates are collapsed on read instead.
 */
export class Ledger {
  private readonly seen = new Set<string>();

  /**
   * Teach this writer about steps already on disk, so a tail that replays the
   * head of a log recognises them as repeats. Without it a restart counts
   * previously-recorded spend twice: once from the seed, once from the replay.
   */
  markSeen(keys: Iterable<string>): void {
    for (const k of keys) if (k) this.seen.add(k);
  }

  /** Returns true when the entry was written, false when it was a repeat. */
  append(entry: LedgerEntry): boolean {
    if (!entry.rawKey || this.seen.has(entry.rawKey)) return false;
    this.seen.add(entry.rawKey);
    appendLine(ledgerFileFor(entry.ts), JSON.stringify(entry));
    return true;
  }

  appendStep(ev: StepEvent, workspaceId: string): boolean {
    return this.append(entryFromStep(ev, workspaceId));
  }
}

function monthFilesBetween(from: number, to: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const cursor = new Date(from);
  cursor.setDate(1);
  cursor.setHours(0, 0, 0, 0);
  // Guard against a pathological range rather than looping forever.
  for (let i = 0; i < 600 && cursor.getTime() <= to; i++) {
    const f = ledgerFileFor(cursor.getTime());
    if (!seen.has(f)) {
      seen.add(f);
      out.push(f);
    }
    cursor.setMonth(cursor.getMonth() + 1);
  }
  // A range inside a single month still needs that month's file.
  const last = ledgerFileFor(to);
  if (!seen.has(last)) out.push(last);
  return out;
}

export interface ReadSpendOptions {
  from?: number;
  to?: number;
  workspaceId?: string;
}

/**
 * Read ledger entries in a time range, de-duplicated by rawKey.
 *
 * Torn lines are survivable: the file is parsed with `extractObjects`, the same
 * brace-scanner the log parser uses, which skips malformed objects instead of
 * throwing. A crash mid-append therefore costs one step, not the month.
 */
export function readSpend(opts: ReadSpendOptions = {}): LedgerEntry[] {
  const to = opts.to ?? Date.now();
  const from = opts.from ?? 0;
  const files = from > 0 ? monthFilesBetween(from, to) : allLedgerFiles();

  const byKey = new Map<string, LedgerEntry>();
  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue; // month with no activity
    }
    for (const obj of extractObjects(text)) {
      const e = obj as Partial<LedgerEntry>;
      if (!e || e.schema !== LEDGER_SCHEMA || typeof e.rawKey !== 'string') continue;
      if (typeof e.ts !== 'number' || e.ts < from || e.ts > to) continue;
      if (opts.workspaceId && e.workspaceId !== opts.workspaceId) continue;
      byKey.set(e.rawKey, e as LedgerEntry);
    }
  }
  return [...byKey.values()].sort((a, b) => a.ts - b.ts);
}

function allLedgerFiles(): string[] {
  try {
    const dir = stateDir();
    return fs
      .readdirSync(dir)
      .filter((f) => /^ledger-\d{4}-\d{2}\.jsonl$/.test(f))
      .sort()
      .map((f) => path.join(dir, f));
  } catch {
    return [];
  }
}

export function totalsOf(entries: readonly LedgerEntry[]): SpendTotals {
  let credits = 0;
  let tokens = 0;
  for (const e of entries) {
    credits += e.aic;
    tokens += e.prompt + e.completion;
  }
  return { credits: Number(credits.toFixed(6)), tokens, steps: entries.length };
}

/** Create the state directory up front so the first append is not the first mkdir. */
export function initLedger(): void {
  ensureDir(stateDir());
}
