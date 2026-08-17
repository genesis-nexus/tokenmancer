import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MeterEvent, StepEvent } from '@cte/core';
import { afterAll, describe, expect, it } from 'vitest';
import { MeterBridge, type Poster } from './bridge.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-ext-'));
// The bridge now runs a BudgetRunner, which writes a ledger; keep it off the
// developer's real ~/.tokenmancer.
process.env.TOKENMANCER_HOME = path.join(tmp, 'home');
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const LINES = [
  '{"type":"user_message","sid":"s1","spanId":"p1","ts":1700000000000,"attrs":{"userRequest":"SECRET refactor formatPrice"}}',
  '{"type":"request","sid":"s1","spanId":"r1","parentSpanId":"p1","ts":1700000000001,"model":"claude-sonnet-4.6","prompt_tokens":12000,"completion_tokens":300,"cached_tokens":9000,"cache_creation_input_tokens":1000}',
];

function makeLogsDir(name: string): string {
  const dir = path.join(tmp, name, 'GitHub.copilot-chat', 'debug-logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.jsonl'), `${LINES.join('\n')}\n`);
  return dir;
}

interface Frame {
  type: string;
  event?: MeterEvent;
  id?: number;
  result?: unknown;
}
function collector(): { poster: Poster; msgs: Frame[] } {
  const msgs: Frame[] = [];
  return { poster: { post: (m) => msgs.push(m as Frame) }, msgs };
}
const steps = (msgs: Frame[]): StepEvent[] =>
  msgs
    .filter((m) => m.type === 'event' && m.event?.kind === 'step')
    .map((m) => m.event as StepEvent);

describe('MeterBridge', () => {
  it('auto-tails the default logs dir on subscribe, redacting prompts', () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, { defaultLogsDir: makeLogsDir('ws-a') });
    bridge.handle({ type: 'subscribe' });

    expect(msgs.some((m) => m.type === 'event' && m.event?.kind === 'control')).toBe(true);
    const s = steps(msgs);
    expect(s).toHaveLength(1);
    expect(JSON.stringify(msgs)).not.toContain('SECRET');
    expect(s[0]?.userPrompt).toBe('');
    expect(s[0]?.aic).toBeCloseTo(1.695, 6);
    bridge.dispose();
  });

  it('shows prompts when configured', () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {
      defaultLogsDir: makeLogsDir('ws-b'),
      showPrompts: true,
    });
    bridge.handle({ type: 'subscribe' });
    expect(JSON.stringify(msgs)).toContain('SECRET');
    bridge.dispose();
  });

  it('answers listWorkspaces RPC with a result frame', async () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {});
    bridge.handle({ type: 'rpc', id: 7, method: 'listWorkspaces' });
    await new Promise((r) => setTimeout(r, 10));
    const reply = msgs.find((m) => m.type === 'rpc-result' && m.id === 7);
    expect(reply).toBeDefined();
    expect(Array.isArray(reply?.result)).toBe(true);
    bridge.dispose();
  });

  it('rejects an unknown RPC method with an error frame', async () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {});
    bridge.handle({ type: 'rpc', id: 9, method: 'nope' });
    await new Promise((r) => setTimeout(r, 10));
    expect(msgs.some((m) => m.type === 'rpc-error' && m.id === 9)).toBe(true);
    bridge.dispose();
  });

  it('answers checkSettings via the injected callback, and defaults to empty', async () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {
      checkSettings: () => [{ key: 'a.b', label: 'A B', enabled: false }],
    });
    bridge.handle({ type: 'rpc', id: 1, method: 'checkSettings' });
    await new Promise((r) => setTimeout(r, 10));
    const reply = msgs.find((m) => m.type === 'rpc-result' && m.id === 1);
    expect(reply?.result).toEqual([{ key: 'a.b', label: 'A B', enabled: false }]);
    bridge.dispose();

    const { poster: p2, msgs: m2 } = collector();
    const bridgeNoOpt = new MeterBridge(p2, {});
    bridgeNoOpt.handle({ type: 'rpc', id: 2, method: 'checkSettings' });
    await new Promise((r) => setTimeout(r, 10));
    expect(m2.find((m) => m.type === 'rpc-result' && m.id === 2)?.result).toEqual([]);
    bridgeNoOpt.dispose();
  });

  it('routes openSetting to the injected callback with the requested key', async () => {
    const { poster, msgs } = collector();
    let opened = '';
    const bridge = new MeterBridge(poster, {
      openSetting: (key) => {
        opened = key;
      },
    });
    bridge.handle({ type: 'rpc', id: 3, method: 'openSetting', params: { key: 'a.b.c' } });
    await new Promise((r) => setTimeout(r, 10));
    expect(opened).toBe('a.b.c');
    expect(msgs.find((m) => m.type === 'rpc-result' && m.id === 3)?.result).toEqual({ ok: true });
    bridge.dispose();
  });

  it('setShowPrompts flips redaction live for subsequent tail output', () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, { defaultLogsDir: makeLogsDir('ws-c') });
    bridge.setShowPrompts(true);
    bridge.handle({ type: 'subscribe' });
    expect(JSON.stringify(msgs)).toContain('SECRET');
    bridge.dispose();
  });
});

describe('MeterBridge budget RPCs', () => {
  function rpc(bridge: MeterBridge, msgs: Frame[], method: string, params?: unknown): unknown {
    const id = Math.floor(Math.random() * 1e6);
    bridge.handle({ type: 'rpc', id, method, params });
    return msgs.find((m) => m.type === 'rpc-result' && m.id === id)?.result;
  }

  it('round-trips getConfig and setBudget', async () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {});
    rpc(bridge, msgs, 'getConfig');
    await new Promise((r) => setTimeout(r, 10));

    const cfg = msgs.find((m) => m.type === 'rpc-result')?.result as {
      pricing: { poolCredits: number };
    };
    expect(cfg.pricing.poolCredits).toBe(3000);

    bridge.handle({
      type: 'rpc',
      id: 99,
      method: 'setBudget',
      params: {
        rules: [{ id: 'm', period: 'month', metric: 'credits', limit: 250, thresholds: [1] }],
      },
    });
    await new Promise((r) => setTimeout(r, 10));
    const set = msgs.find((m) => m.id === 99)?.result as { ok: boolean };
    expect(set.ok).toBe(true);

    bridge.handle({ type: 'rpc', id: 100, method: 'getSpend' });
    await new Promise((r) => setTimeout(r, 10));
    const spend = msgs.find((m) => m.id === 100)?.result as {
      rules: Array<{ limit: number }>;
      snapshot: { byPeriod: Record<string, unknown> };
    };
    expect(spend.rules[0]?.limit).toBe(250);
    expect(spend.snapshot.byPeriod.month).toBeDefined();
    bridge.dispose();
  });

  it('rejects a malformed rule rather than installing one that never fires', async () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {});
    bridge.handle({
      type: 'rpc',
      id: 7,
      method: 'setBudget',
      params: { rules: [{ id: 'bad', period: 'fortnight', metric: 'credits', limit: 1 }] },
    });
    await new Promise((r) => setTimeout(r, 10));
    const r = msgs.find((m) => m.id === 7)?.result as { ok: boolean; rules?: unknown[] };
    // The rule is dropped by the validator, so the resulting list is empty.
    expect(r.rules).toEqual([]);
    bridge.dispose();
  });

  it('pushes an alert to the webview and taps the host callback', async () => {
    const { poster, msgs } = collector();
    const seen: string[] = [];
    const dir = makeLogsDir('alerting');
    const bridge = new MeterBridge(poster, {
      defaultLogsDir: dir,
      onAlert: (a) => seen.push(a.severity),
    });
    // A limit low enough that the fixture's single call blows straight past it.
    bridge.handle({
      type: 'rpc',
      id: 1,
      method: 'setBudget',
      params: {
        rules: [{ id: 'tiny', period: 'session', metric: 'credits', limit: 0.01, thresholds: [1] }],
      },
    });
    // RPCs dispatch on a microtask, so the rule must land before the tail starts.
    await new Promise((r) => setTimeout(r, 10));
    bridge.handle({ type: 'subscribe' });
    await new Promise((r) => setTimeout(r, 60));

    expect(seen).toContain('critical');
    expect(msgs.some((m) => m.type === 'event' && m.event?.kind === 'alert')).toBe(true);
    bridge.dispose();
  });

  it('reports spend to the status-bar callback as steps arrive', async () => {
    const { poster } = collector();
    // The status bar shows month-to-date, and a month only counts steps that
    // happened in it — so this fixture needs today's date, not the shared one.
    const dir = path.join(tmp, 'spending-now', 'GitHub.copilot-chat', 'debug-logs');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(
      path.join(dir, 'main.jsonl'),
      `${LINES.map((l) => l.replace(/"ts":\d+/, `"ts":${now}`)).join('\n')}\n`,
    );
    const seen: number[] = [];
    const bridge = new MeterBridge(poster, {
      defaultLogsDir: dir,
      onSpend: (credits) => seen.push(credits),
    });
    bridge.handle({ type: 'subscribe' });
    await new Promise((r) => setTimeout(r, 60));
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[seen.length - 1]).toBeGreaterThan(0);
    bridge.dispose();
  });
});
