import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MeterEvent, StepEvent } from '@cte/core';
import { afterAll, describe, expect, it } from 'vitest';
import type { ServerOptions } from './security.js';
import { type RunningServer, startServer } from './server.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-web-'));
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
    ...over,
  };
  const s = await startServer(opts);
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
