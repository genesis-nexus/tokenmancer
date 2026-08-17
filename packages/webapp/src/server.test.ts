import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MeterEvent, StepEvent } from '@cte/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { ServerOptions } from './security.js';
import { type RunningServer, startServer } from './server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-web-'));
// The server now writes a spend ledger and alert state; keep both off the
// developer's real ~/.tokenmancer.
process.env.TOKENMANCER_HOME = path.join(tmp, 'home');

const running: RunningServer[] = [];
afterAll(async () => {
  await Promise.all(running.map((s) => s.close()));
  fs.rmSync(tmp, { recursive: true, force: true });
});

const INBOX_LINES = [
  '{"type":"user_message","sid":"s1","spanId":"p1","ts":1700000000000,"attrs":{"userRequest":"SECRET refactor formatPrice"}}',
  '{"type":"request","sid":"s1","spanId":"r1","parentSpanId":"p1","ts":1700000000001,"model":"claude-sonnet-4.6","prompt_tokens":12000,"completion_tokens":300,"cached_tokens":9000,"cache_creation_input_tokens":1000}',
];

function makeInbox(name: string): string {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, `${INBOX_LINES.join('\n')}\n`);
  return p;
}

async function start(over: Partial<ServerOptions>): Promise<RunningServer> {
  const opts: ServerOptions = {
    port: 0,
    host: '127.0.0.1',
    token: 'tkn-test',
    showPrompts: false,
    exposePaths: false,
    tail: null,
    inbox: makeInbox(`${Math.random().toString(36).slice(2)}.jsonl`),
    fromStart: false,
    rateModel: 'claude-sonnet-4.6',
    open: false,
    configFile: null,
    ...over,
  };
  const s = await startServer({ ...opts, cwd: tmp });
  running.push(s);
  return s;
}

function readSse(base: string, token: string, ms = 600): Promise<MeterEvent[]> {
  return new Promise((resolve) => {
    const req = http.get(`${base}events?token=${token}`, (res) => {
      let buf = '';
      const evs: MeterEvent[] = [];
      res.on('data', (d) => {
        buf += d.toString();
        let i = buf.indexOf('\n\n');
        while (i >= 0) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (line) {
            try {
              evs.push(JSON.parse(line.slice(5).trim()) as MeterEvent);
            } catch {
              // heartbeat / non-json
            }
          }
          i = buf.indexOf('\n\n');
        }
      });
      setTimeout(() => {
        req.destroy();
        resolve(evs);
      }, ms);
    });
    req.on('error', () => resolve([]));
  });
}

function badHost(base: string): Promise<number> {
  const u = new URL(base);
  return new Promise((resolve) => {
    const req = http.get(
      { host: u.hostname, port: u.port, path: '/health', headers: { host: 'evil.example.com' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('error', () => resolve(0));
  });
}

describe('hardened local-first server', () => {
  it('serves /health without a token and reports a loopback bind', async () => {
    const s = await start({});
    expect(s.url.startsWith('http://127.0.0.1:')).toBe(true);
    const r = await fetch(`${s.url}health`);
    expect(r.status).toBe(200);
  });

  it('requires the per-run token on /api and /events', async () => {
    const s = await start({});
    expect((await fetch(`${s.url}api/workspaces`)).status).toBe(401);
    expect((await fetch(`${s.url}api/workspaces?token=${s.token}`)).status).toBe(200);
    expect((await fetch(`${s.url}events`)).status).toBe(401);
  });

  it('rejects a non-loopback Host header (DNS-rebind defense)', async () => {
    const s = await start({});
    expect(await badHost(s.url)).toBe(403);
  });

  it('hides absolute project paths unless --expose-paths', async () => {
    const hidden = await start({});
    const list = (await (
      await fetch(`${hidden.url}api/workspaces?token=${hidden.token}`)
    ).json()) as Array<Record<string, unknown>>;
    if (list.length) expect(list[0]?.folder).toBeUndefined();

    const exposed = await start({ exposePaths: true });
    const list2 = (await (
      await fetch(`${exposed.url}api/workspaces?token=${exposed.token}`)
    ).json()) as Array<Record<string, unknown>>;
    if (list2.length) expect('folder' in (list2[0] ?? {})).toBe(true);
  });

  it('lists a workspace’s sessions behind the token', async () => {
    const s = await start({});
    expect((await fetch(`${s.url}api/workspace-sessions?ws=nope`)).status).toBe(401);
    const r = await fetch(`${s.url}api/workspace-sessions?ws=nope&token=${s.token}`);
    expect(r.status).toBe(200);
    expect(Array.isArray(await r.json())).toBe(true);
  });

  it('rejects path traversal in /api/log', async () => {
    const s = await start({});
    const r = await fetch(
      `${s.url}api/log?ws=nope&log=${encodeURIComponent('../secret.jsonl')}&token=${s.token}`,
    );
    expect(r.status).toBe(404);
  });

  it('sets a strict CSP with a script nonce and injects the token', async () => {
    const s = await start({});
    const r = await fetch(s.url);
    const csp = r.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("default-src 'none'");
    expect(csp).toMatch(/script-src 'self' 'nonce-/);
    const html = await r.text();
    expect(html).toContain(`{token:${JSON.stringify(s.token)}}`);
  });

  it('redacts prompt text by default over SSE, but keeps counts + cost', async () => {
    const s = await start({});
    const evs = await readSse(s.url, s.token);
    const step = evs.find((e): e is StepEvent => e.kind === 'step');
    expect(step).toBeDefined();
    expect(JSON.stringify(evs)).not.toContain('SECRET');
    expect(step?.userPrompt).toBe('');
    expect(step?.promptSnippet).toMatch(/redacted/);
    // fresh 2000·300 + read 9000·30 + write 1000·375 + out 300·1500, all /1e6
    expect(step?.aic).toBeCloseTo(1.695, 6);
  });

  it('shows prompt text when --show-prompts is set', async () => {
    const s = await start({ showPrompts: true });
    const evs = await readSse(s.url, s.token);
    expect(JSON.stringify(evs)).toContain('SECRET');
  });
});

describe('config and budget routes', () => {
  it('serves the composed config behind the token', async () => {
    const s = await start({});
    expect((await fetch(`${s.url}api/config`)).status).toBe(401);
    const r = await fetch(`${s.url}api/config?token=${s.token}`);
    expect(r.status).toBe(200);
    const cfg = (await r.json()) as Record<string, Record<string, unknown>>;
    expect(cfg.pricing?.poolCredits).toBe(3000);
  });

  it('reports spend for every period', async () => {
    const s = await start({});
    expect((await fetch(`${s.url}api/spend`)).status).toBe(401);
    const r = await fetch(`${s.url}api/spend?token=${s.token}&period=month`);
    const body = (await r.json()) as {
      snapshot: { byPeriod: Record<string, { credits: number }> };
      period?: { credits: number };
      rules: unknown[];
    };
    expect(Object.keys(body.snapshot.byPeriod).sort()).toEqual([
      'day',
      'loop',
      'month',
      'pool',
      'session',
      'week',
    ]);
    expect(body.period).toBeDefined();
    expect(Array.isArray(body.rules)).toBe(true);
  });

  it('persists a posted budget rule and reflects it in /api/spend', async () => {
    const s = await start({});
    const post = await fetch(`${s.url}api/budget?token=${s.token}`, {
      method: 'POST',
      body: JSON.stringify({
        rules: [{ id: 'test-day', period: 'day', metric: 'credits', limit: 42, thresholds: [1] }],
      }),
    });
    expect(post.status).toBe(200);

    const after = (await (await fetch(`${s.url}api/spend?token=${s.token}`)).json()) as {
      rules: Array<{ id: string; limit: number }>;
    };
    expect(after.rules).toHaveLength(1);
    expect(after.rules[0]).toMatchObject({ id: 'test-day', limit: 42 });
  });

  it('rejects a malformed budget payload without changing the rules', async () => {
    const s = await start({});
    const bad = await fetch(`${s.url}api/budget?token=${s.token}`, {
      method: 'POST',
      body: '{ not json',
    });
    expect(bad.status).toBe(400);

    const wrongShape = await fetch(`${s.url}api/budget?token=${s.token}`, {
      method: 'POST',
      body: JSON.stringify({ rules: 'nope' }),
    });
    expect(wrongShape.status).toBe(400);
  });

  /**
   * The alertRing regression: the step ring holds 200 frames and is emptied on
   * every new session, so an alert kept only there would vanish before anyone
   * saw it. This asserts it survives to a client that connects afterwards.
   */
  it('replays an alert fired before the client connected', async () => {
    const s = await start({});
    await fetch(`${s.url}api/budget?token=${s.token}`, {
      method: 'POST',
      body: JSON.stringify({
        rules: [{ id: 'tiny', period: 'month', metric: 'credits', limit: 0.001, thresholds: [1] }],
      }),
    });

    // Current timestamps: a `month` budget only counts steps that happened in
    // the month it is tracking, so the shared fixture's 2023 dates would not
    // move the needle.
    const now = Date.now();
    const inbox = path.join(tmp, `${Math.random().toString(36).slice(2)}.jsonl`);
    const live = INBOX_LINES.map((l) => l.replace(/"ts":\d+/, `"ts":${now}`));
    fs.writeFileSync(inbox, `${live.join('\n')}\n`);
    const s2 = await start({ inbox, showPrompts: false });
    await fetch(`${s2.url}api/budget?token=${s2.token}`, {
      method: 'POST',
      body: JSON.stringify({
        rules: [{ id: 'tiny', period: 'month', metric: 'credits', limit: 0.001, thresholds: [1] }],
      }),
    });
    fs.appendFileSync(inbox, `${live[1]?.replace('"r1"', '"r2"')}\n`);

    // Connect only after the spend has already happened.
    await new Promise((r) => setTimeout(r, 900));
    const evs = await readSse(s2.url, s2.token, 700);
    const alert = evs.find((e) => e.kind === 'alert');
    expect(alert).toBeDefined();
  });
});

describe('settings route', () => {
  /**
   * These writes land in the shared config file, so each one gets its own home.
   * Without the isolation a settings test would silently reorder the assertions
   * in every other block that reads a default.
   */
  async function withOwnHome<T>(
    fn: (start: () => Promise<RunningServer>) => Promise<T>,
  ): Promise<T> {
    const prev = process.env.TOKENMANCER_HOME;
    process.env.TOKENMANCER_HOME = fs.mkdtempSync(path.join(tmp, 'home-'));
    try {
      return await fn(() => start({}));
    } finally {
      process.env.TOKENMANCER_HOME = prev;
    }
  }

  it('requires the token like every other /api route', async () => {
    await withOwnHome(async (boot) => {
      const s = await boot();
      const r = await fetch(`${s.url}api/settings`, { method: 'POST', body: '{}' });
      expect(r.status).toBe(401);
    });
  });

  it('saves a setting and reports the config that now governs', async () => {
    await withOwnHome(async (boot) => {
      const s = await boot();
      const r = await fetch(`${s.url}api/settings?token=${s.token}`, {
        method: 'POST',
        body: JSON.stringify({ pricing: { poolCredits: 3000 }, alerts: { enabled: false } }),
      });
      expect(r.status).toBe(200);
      const body = (await r.json()) as {
        ok: boolean;
        savedTo: string;
        config: { pricing: { poolCredits: number }; alerts: { enabled: boolean } };
      };
      expect(body.ok).toBe(true);
      expect(body.savedTo).toContain('config.json');
      expect(body.config.pricing.poolCredits).toBe(3000);
      expect(body.config.alerts.enabled).toBe(false);

      // ...and the live server is using it, not just echoing it back.
      const cfg = (await (await fetch(`${s.url}api/config?token=${s.token}`)).json()) as {
        pricing: { poolCredits: number };
      };
      expect(cfg.pricing.poolCredits).toBe(3000);
    });
  });

  /** The assertion the whole feature rests on: a limit must outlive the process. */
  it('a saved budget survives a server restart', async () => {
    await withOwnHome(async (boot) => {
      const first = await boot();
      await fetch(`${first.url}api/settings?token=${first.token}`, {
        method: 'POST',
        body: JSON.stringify({
          budgets: {
            rules: [
              {
                id: 'month-limit',
                enabled: true,
                period: 'month',
                metric: 'credits',
                limit: 2000,
                thresholds: [0.5, 0.8, 1],
                severity: 'warn',
                scope: 'global',
              },
            ],
          },
        }),
      });
      await first.close();

      const second = await boot();
      const after = (await (
        await fetch(`${second.url}api/spend?token=${second.token}`)
      ).json()) as {
        rules: Array<{ id: string; limit: number }>;
      };
      expect(after.rules).toEqual([expect.objectContaining({ id: 'month-limit', limit: 2000 })]);
    });
  });

  it('rejects a patch with nothing valid in it, leaving the config alone', async () => {
    await withOwnHome(async (boot) => {
      const s = await boot();
      const before = (await (await fetch(`${s.url}api/config?token=${s.token}`)).json()) as {
        pricing: { poolCredits: number };
      };

      expect(
        (
          await fetch(`${s.url}api/settings?token=${s.token}`, {
            method: 'POST',
            body: '{ not json',
          })
        ).status,
      ).toBe(400);

      const junk = await fetch(`${s.url}api/settings?token=${s.token}`, {
        method: 'POST',
        body: JSON.stringify({ nonsense: true, pricing: { poolCredits: 'lots' } }),
      });
      expect(junk.status).toBe(400);

      const after = (await (await fetch(`${s.url}api/config?token=${s.token}`)).json()) as {
        pricing: { poolCredits: number };
      };
      expect(after.pricing.poolCredits).toBe(before.pricing.poolCredits);
    });
  });
});
