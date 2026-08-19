import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AlertDraft, AlertsConfig, StepEvent } from '@cte/core';
import { DEFAULT_CONFIG } from '@cte/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { filterSuppressed, loadAlertState, saveAlertState } from './alert-state.js';
import { Ledger, entryFromStep, ledgerFileFor, readSpend, totalsOf } from './ledger.js';
import { atomicWriteJson, readJsonSafe, stateDir, tokenmancerHome } from './paths.js';

// Every test writes under TOKENMANCER_HOME, so the developer's real
// ~/.tokenmancer is never touched.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-store-'));
process.env.TOKENMANCER_HOME = tmp;
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

beforeEach(() => {
  fs.rmSync(stateDir(), { recursive: true, force: true });
});

const AUG = Date.parse('2026-08-16T10:00:00');
const SEP = Date.parse('2026-09-01T10:00:00');

function step(over: Partial<StepEvent> = {}): StepEvent {
  return {
    kind: 'step',
    id: 1,
    ts: AUG,
    source: 'tail',
    groupId: 'g1',
    promptGroupIndex: 1,
    stepIndex: 1,
    userPrompt: 'p',
    provider: 'copilot',
    model: 'claude-sonnet-4.6',
    requestType: 'request',
    toolName: '',
    stepKind: 'llm',
    isTool: false,
    targets: [],
    toolIntent: '',
    toolQuery: '',
    resultBytes: 0,
    prompt: 1000,
    completion: 100,
    cacheRead: 0,
    cacheWrite: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    freshInput: 1000,
    aic: 0.45,
    usd: 0.0045,
    exact: true,
    promptSnippet: '',
    systemPromptFile: '',
    sessionId: 's1',
    spanId: 'sp1',
    parentSpanId: '',
    eventType: 'request',
    rawKey: 'k1',
    ...over,
  };
}

describe('paths', () => {
  it('honours TOKENMANCER_HOME', () => {
    expect(tokenmancerHome()).toBe(tmp);
  });

  it('atomicWriteJson leaves no temp file behind', () => {
    const f = path.join(stateDir(), 'x.json');
    atomicWriteJson(f, { a: 1 });
    expect(readJsonSafe(f, null)).toEqual({ a: 1 });
    expect(fs.readdirSync(stateDir()).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });

  it('readJsonSafe falls back for missing, empty and corrupt files', () => {
    const f = path.join(stateDir(), 'bad.json');
    expect(readJsonSafe(f, 'fallback')).toBe('fallback');
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(f, '');
    expect(readJsonSafe(f, 'fallback')).toBe('fallback');
    fs.writeFileSync(f, '{not json');
    expect(readJsonSafe(f, 'fallback')).toBe('fallback');
  });

  it('a stale .tmp from a crashed writer does not break the read', () => {
    const f = path.join(stateDir(), 'y.json');
    atomicWriteJson(f, { good: true });
    fs.writeFileSync(`${f}.99999.tmp`, '{partial');
    expect(readJsonSafe(f, null)).toEqual({ good: true });
  });
});

describe('ledger', () => {
  it('appends and reads back', () => {
    const l = new Ledger();
    l.appendStep(step({ rawKey: 'a' }), 'ws1');
    l.appendStep(step({ rawKey: 'b' }), 'ws1');
    l.appendStep(step({ rawKey: 'c' }), 'ws1');
    expect(readSpend()).toHaveLength(3);
  });

  it('collapses a duplicate rawKey — the two-writer case', () => {
    const first = new Ledger();
    first.appendStep(step({ rawKey: 'dup' }), 'ws1');
    // A *second process* (fresh seen-set) records the very same step.
    const second = new Ledger();
    second.appendStep(step({ rawKey: 'dup' }), 'ws1');

    const lines = fs.readFileSync(ledgerFileFor(AUG), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // both really did write
    expect(readSpend()).toHaveLength(1); // but the reader sees one
  });

  it('refuses to re-append within one process', () => {
    const l = new Ledger();
    expect(l.appendStep(step({ rawKey: 'x' }), 'ws1')).toBe(true);
    expect(l.appendStep(step({ rawKey: 'x' }), 'ws1')).toBe(false);
  });

  it('survives a torn final line — a crash costs one step, not the month', () => {
    const l = new Ledger();
    l.appendStep(step({ rawKey: 'a' }), 'ws1');
    l.appendStep(step({ rawKey: 'b' }), 'ws1');
    l.appendStep(step({ rawKey: 'c' }), 'ws1');
    fs.appendFileSync(ledgerFileFor(AUG), '{"schema":1,"rawKey":"torn","ts":17638');
    expect(() => readSpend()).not.toThrow();
    expect(readSpend()).toHaveLength(3);
  });

  it('rotates monthly and reads across the boundary', () => {
    const l = new Ledger();
    l.appendStep(step({ rawKey: 'aug', ts: AUG }), 'ws1');
    l.appendStep(step({ rawKey: 'sep', ts: SEP }), 'ws1');

    const files = fs.readdirSync(stateDir()).filter((f) => f.startsWith('ledger-'));
    expect(files.sort()).toEqual(['ledger-2026-08.jsonl', 'ledger-2026-09.jsonl']);
    expect(readSpend({ from: AUG - 1000, to: SEP + 1000 })).toHaveLength(2);
    expect(readSpend({ from: SEP - 1000, to: SEP + 1000 }).map((e) => e.rawKey)).toEqual(['sep']);
  });

  it('filters by workspace', () => {
    const l = new Ledger();
    l.appendStep(step({ rawKey: 'a' }), 'ws1');
    l.appendStep(step({ rawKey: 'b' }), 'ws2');
    expect(readSpend({ workspaceId: 'ws2' }).map((e) => e.rawKey)).toEqual(['b']);
  });

  it('rejects rows from an unknown schema version', () => {
    const l = new Ledger();
    l.appendStep(step({ rawKey: 'ok' }), 'ws1');
    fs.appendFileSync(ledgerFileFor(AUG), `${JSON.stringify({ schema: 99, rawKey: 'future' })}\n`);
    expect(readSpend().map((e) => e.rawKey)).toEqual(['ok']);
  });

  it('records free tool steps with their targets but no credits', () => {
    const e = entryFromStep(
      step({ isTool: true, aic: 0, prompt: 0, completion: 0, targets: ['src/a.ts'] }),
      'ws1',
    );
    expect(e.aic).toBe(0);
    expect(e.targets).toEqual(['src/a.ts']);
    expect(e.contextTokens).toBe(0); // populated once attribution lands
  });

  it('totals credits, tokens and steps', () => {
    const l = new Ledger();
    l.appendStep(step({ rawKey: 'a', aic: 0.5, prompt: 100, completion: 10 }), 'ws1');
    l.appendStep(step({ rawKey: 'b', aic: 0.25, prompt: 200, completion: 20 }), 'ws1');
    expect(totalsOf(readSpend())).toEqual({ credits: 0.75, tokens: 330, steps: 2 });
  });
});

describe('alert state', () => {
  const cfg: AlertsConfig = { ...DEFAULT_CONFIG.alerts };
  const t0 = Date.parse('2026-08-16T10:00:00');

  function draft(over: Partial<AlertDraft> = {}): AlertDraft {
    return {
      id: 'r1:2026-08-16:0.5',
      ruleId: 'r1',
      periodKey: '2026-08-16',
      threshold: 0.5,
      period: 'day',
      metric: 'credits',
      severity: 'warn',
      observed: 50,
      limit: 100,
      title: 't',
      body: 'b',
      ...over,
    };
  }

  it('delivers a new crossing once, then never again', () => {
    const s = loadAlertState();
    expect(filterSuppressed([draft()], s, cfg, t0).deliver).toHaveLength(1);
    expect(filterSuppressed([draft()], s, cfg, t0 + 60 * 60_000).deliver).toHaveLength(0);
  });

  it('is monotonic: a lower threshold cannot fire after a higher one', () => {
    const s = loadAlertState();
    filterSuppressed([draft({ threshold: 0.8 })], s, cfg, t0);
    const later = filterSuppressed([draft({ threshold: 0.5 })], s, cfg, t0 + 10 * 60 * 60_000);
    expect(later.deliver).toHaveLength(0);
  });

  it('lets a higher threshold through, cooldown permitting', () => {
    const s = loadAlertState();
    filterSuppressed([draft({ threshold: 0.5 })], s, cfg, t0);
    const later = filterSuppressed(
      [draft({ threshold: 0.8, id: 'r1:2026-08-16:0.8' })],
      s,
      cfg,
      t0 + 20 * 60_000, // past the 15-minute cooldown
    );
    expect(later.deliver).toHaveLength(1);
  });

  it('suppresses inside the cooldown window', () => {
    const s = loadAlertState();
    filterSuppressed([draft({ threshold: 0.5 })], s, cfg, t0);
    const soon = filterSuppressed(
      [draft({ threshold: 0.8, id: 'r1:2026-08-16:0.8' })],
      s,
      cfg,
      t0 + 60_000, // one minute later
    );
    expect(soon.deliver).toHaveLength(0);
  });

  it('scopes the cooldown per rule so one alert cannot mute another', () => {
    // A monthly-pool warning must not silence the Cost Radar's loop alerts.
    const s = loadAlertState();
    filterSuppressed([draft({ ruleId: 'pool', id: 'pool:2026-08:0.5' })], s, cfg, t0);
    const loop = filterSuppressed(
      [draft({ ruleId: 'loop', periodKey: 'g7', id: 'loop:g7:1', threshold: 1 })],
      s,
      cfg,
      t0 + 60_000, // one minute later, well inside the cooldown
    );
    expect(loop.deliver).toHaveLength(1);
  });

  it('lets a critical breach punch through the cooldown', () => {
    const s = loadAlertState();
    filterSuppressed([draft({ threshold: 0.5 })], s, cfg, t0);
    const breach = filterSuppressed(
      [draft({ threshold: 1, id: 'r1:2026-08-16:1', severity: 'critical' })],
      s,
      cfg,
      t0 + 60_000,
    );
    expect(breach.deliver).toHaveLength(1);
  });

  it('a new period key starts clean with no cleanup job', () => {
    const s = loadAlertState();
    filterSuppressed([draft()], s, cfg, t0);
    const tomorrow = filterSuppressed(
      [draft({ periodKey: '2026-08-17', id: 'r1:2026-08-17:0.5' })],
      s,
      cfg,
      t0 + 24 * 60 * 60_000,
    );
    expect(tomorrow.deliver).toHaveLength(1);
  });

  it('caps the hourly rate and counts what it withheld', () => {
    const s = loadAlertState();
    const many = Array.from({ length: 10 }, (_, i) =>
      draft({ ruleId: `r${i}`, id: `r${i}:2026-08-16:0.5`, severity: 'critical' }),
    );
    const r = filterSuppressed(many, s, { ...cfg, maxPerHour: 3 }, t0);
    expect(r.deliver).toHaveLength(3);
    expect(r.suppressed).toBe(7);
  });

  it('delivers nothing at all when alerts are disabled', () => {
    const s = loadAlertState();
    expect(filterSuppressed([draft()], s, { ...cfg, enabled: false }, t0).deliver).toEqual([]);
  });

  it('round-trips through disk', () => {
    const s = loadAlertState();
    filterSuppressed([draft()], s, cfg, t0);
    saveAlertState(s);
    const reloaded = loadAlertState();
    expect(reloaded.fired['r1:2026-08-16']?.maxThreshold).toBe(0.5);
    // and the memory survives the restart
    expect(filterSuppressed([draft()], reloaded, cfg, t0 + 60 * 60_000).deliver).toHaveLength(0);
  });

  it('recovers from a corrupt state file rather than throwing', () => {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(path.join(stateDir(), 'alerts.json'), '{oh no');
    expect(loadAlertState().fired).toEqual({});
  });
});
