import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type AlertEvent,
  initTokenizer,
  type MeterEvent,
  type PartialConfig,
  type TokenmancerConfig,
  redactEvent,
  validateConfig,
} from '@cte/core';
import {
  BudgetRunner,
  type InboxController,
  type TailController,
  discoverWorkspaces,
  ensureConfigFile,
  getWorkspaceAnalyticsWithInsights,
  isContained,
  isSafeLogFileName,
  loadConfig,
  loadLogFile,
  resolveLogPath,
  resolveWorkspaceSessions,
  saveConfigPatch,
  startLiveTail,
  watchInbox,
} from '@cte/node-host';
import {
  RateLimiter,
  type ServerOptions,
  hostAllowed,
  originAllowed,
  parseArgs,
  tokenOk,
} from './security.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, 'public');
const RING_MAX = 200;
/**
 * Alerts get their own ring. The step ring evicts after 200 frames and is
 * cleared outright on a new session, so a budget warning fired before you
 * opened the tab would otherwise be lost — exactly when you most need it.
 */
const ALERT_RING_MAX = 20;

const CONTENT_TYPE: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  // Required, not cosmetic: responses carry `nosniff`, so an SVG served as the
  // octet-stream fallback is refused as an image and the favicon never renders.
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.json': 'application/json; charset=utf-8',
};

const SURFACE_TITLE: Record<string, string> = {
  live: 'Copilot Live Meter',
  replay: 'Copilot Session Replay',
  simulator: 'Copilot Token Simulator',
  analytics: 'Copilot Workspace Analytics',
};

function htmlShell(surface: string, token: string, nonce: string): string {
  const title = SURFACE_TITLE[surface] ?? 'Copilot Token Economics';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="icon" href="/public/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/public/${surface}.css">
<script nonce="${nonce}">window.__CTE__={token:${JSON.stringify(token)}};</script>
<script type="module" src="/public/${surface}.js"></script>
</head>
<body><div id="app"></div></body>
</html>`;
}

function cspHeader(nonce: string): string {
  return [
    "default-src 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'", // dynamic bar widths are set via inline style attrs
    "img-src 'self' data:",
    "connect-src 'self'",
    "font-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

export interface RunningServer {
  url: string;
  token: string;
  port: number;
  close(): Promise<void>;
}

export interface StartServerOptions extends ServerOptions {
  /** Composed config. Falls back to a file+env load when omitted. */
  config?: TokenmancerConfig;
  /** Where to look for a project-scoped `.tokenmancer.json`. */
  cwd?: string;
  /**
   * The highest-precedence layer that produced `config`. Kept so a settings
   * write can recompose the same stack: without it, saving would silently
   * promote a value the CLI flags were overriding.
   */
  overrides?: PartialConfig;
}

export function startServer(opts: StartServerOptions): Promise<RunningServer> {
  const clients = new Set<http.ServerResponse>();
  const ring: string[] = [];
  const alertRing: string[] = [];
  const heartbeats = new Map<http.ServerResponse, ReturnType<typeof setInterval>>();
  let source: TailController | InboxController | null = null;
  const logRateLimit = new RateLimiter(30, 10_000);

  // When no composed config is handed in, the server flags still win over the
  // config files — so `startServer(opts)` behaves the same for any caller.
  const overrides: PartialConfig = opts.overrides ?? {
    pricing: { defaultModel: opts.rateModel },
    privacy: { showPrompts: opts.showPrompts, exposeAbsolutePaths: opts.exposePaths },
  };
  let config = opts.config ?? loadConfig({ cwd: opts.cwd, overrides }).config;

  const redactOpts = {
    showPrompts: config.privacy.showPrompts,
    showPaths: config.privacy.showPaths,
    salt: randomBytes(8).toString('hex'),
  };

  // Workspace scoping is per-tail; until one is chosen, spend is recorded
  // against the source that produced it.
  let workspaceId = 'default';
  const budget = new BudgetRunner({
    config,
    workspaceId,
    onError: () => {
      /* a ledger hiccup must never take the meter down */
    },
  });
  budget.onAlert((a) => publishAlert(a));

  function frame(ev: MeterEvent): string {
    return `data: ${JSON.stringify(redactEvent(ev, redactOpts))}\n\n`;
  }
  function publish(ev: MeterEvent): void {
    budget.observe(ev);
    const data = frame(ev);
    ring.push(data);
    if (ring.length > RING_MAX) ring.shift();
    for (const res of clients) res.write(data);
  }
  function publishAlert(a: AlertEvent): void {
    const data = `data: ${JSON.stringify(a)}\n\n`;
    alertRing.push(data);
    if (alertRing.length > ALERT_RING_MAX) alertRing.shift();
    for (const res of clients) res.write(data);
  }
  function broadcast(control: 'session'): void {
    const data = `data: ${JSON.stringify({ kind: 'control', control })}\n\n`;
    if (control === 'session') {
      ring.length = 0;
      budget.resetSession();
    }
    for (const res of clients) res.write(data);
  }

  function stopSource(): void {
    if (source) {
      try {
        source.stop();
      } catch {
        // already stopped
      }
      source = null;
    }
  }

  function startTail(file: string, fresh: boolean, repoRoots: string[] = []): void {
    stopSource();
    if (fresh) {
      ring.length = 0;
      broadcast('session');
    }
    source = startLiveTail(file, {
      emit: publish,
      fromStart: opts.fromStart,
      defaultModel: config.pricing.defaultModel,
      repoRoots,
    });
  }

  // Initial source: an explicit --tail file, else the paste inbox.
  if (opts.tail) {
    const abs = path.resolve(opts.tail);
    const file =
      fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, 'main.jsonl') : abs;
    startTail(file, false);
  } else if (opts.inbox) {
    source = watchInbox(path.resolve(opts.inbox), {
      emit: publish,
      defaultModel: config.pricing.defaultModel,
    });
  }

  function resolveTailTarget(
    ws: string,
    sessionId: string | null,
    logFile: string | null,
  ): { abs: string; workspace: string; log: string; repoRoots: string[] } | null {
    const r = resolveWorkspaceSessions(ws);
    if (!r || !r.sessions.length) return null;
    const s = sessionId ? r.sessions.find((x) => x.id === sessionId) : r.sessions[0];
    if (!s) return null;
    const log = logFile ?? s.logFiles[0];
    if (!log || !isSafeLogFileName(log) || !s.logFiles.includes(log)) return null;
    const abs = path.join(s.logDir, log);
    if (!isContained(abs, r.ws.debugLogsDir)) return null;
    // The workspace folder is what makes a tool target repo-relative instead of
    // a bare basename — without it the file-cost report cannot tell two
    // index.ts apart.
    return { abs, workspace: r.ws.folderName, log, repoRoots: r.ws.folder ? [r.ws.folder] : [] };
  }

  function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
    const s = JSON.stringify(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'x-content-type-options': 'nosniff',
      'content-length': Buffer.byteLength(s),
    });
    res.end(s);
  }
  function sendText(res: http.ServerResponse, code: number, body: string): void {
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(body);
  }

  /** Read a request body with a hard cap, so a POST cannot exhaust memory. */
  function readBody(req: http.IncomingMessage, done: (raw: string) => void): void {
    const MAX = 64 * 1024;
    let raw = '';
    let over = false;
    req.on('data', (c) => {
      if (over) return;
      raw += c;
      if (raw.length > MAX) {
        over = true;
        raw = '';
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!over) done(raw);
    });
  }

  function servePage(res: http.ServerResponse, surface: string): void {
    const nonce = randomBytes(16).toString('base64');
    const html = htmlShell(surface, opts.token, nonce);
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': cspHeader(nonce),
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    res.end(html);
  }

  function serveAsset(res: http.ServerResponse, name: string): void {
    // Allowlisted by extension, so a traversal or a stray file in dist/public
    // can never be served. Every type here must also have a CONTENT_TYPE entry.
    if (!/^[a-z0-9._\-]+\.(js|css|map|svg|png|json)$/i.test(name)) {
      sendText(res, 404, 'not found');
      return;
    }
    const abs = path.join(PUBLIC_DIR, name);
    if (!isContained(abs, PUBLIC_DIR) && abs !== PUBLIC_DIR) {
      sendText(res, 404, 'not found');
      return;
    }
    fs.readFile(abs, (err, buf) => {
      if (err) {
        sendText(res, 404, 'not found');
        return;
      }
      const ext = path.extname(name).toLowerCase();
      res.writeHead(200, {
        'content-type': CONTENT_TYPE[ext] ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-cache',
      });
      res.end(buf);
    });
  }

  function serveEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-content-type-options': 'nosniff',
    });
    res.write('retry: 1000\n\n');
    for (const data of ring) res.write(data);
    // Alerts replay after the steps and out of their own ring, so one fired
    // before this client connected still reaches it.
    for (const data of alertRing) res.write(data);
    clients.add(res);
    const hb = setInterval(() => res.write(': hb\n\n'), 15_000);
    heartbeats.set(res, hb);
    req.on('close', () => {
      clearInterval(hb);
      heartbeats.delete(res);
      clients.delete(res);
    });
  }

  const server = http.createServer((req, res) => {
    const method = req.method ?? 'GET';
    const rawUrl = req.url ?? '/';
    const urlPath = rawUrl.split('?')[0] ?? '/';

    // --- security gate (loopback + DNS-rebind + CSRF) ---
    if (!hostAllowed(req.headers.host)) {
      sendText(res, 403, 'forbidden: non-loopback host');
      return;
    }
    if (!originAllowed(req.headers.origin as string | undefined)) {
      sendText(res, 403, 'forbidden: cross-origin');
      return;
    }

    const needsToken =
      urlPath === '/events' || urlPath.startsWith('/api/') || urlPath === '/session/new';
    if (needsToken && !tokenOk(rawUrl, opts.token)) {
      sendText(res, 401, 'unauthorized: missing or bad token');
      return;
    }

    // --- routes ---
    if (method === 'GET' && (urlPath === '/' || urlPath === '/live' || urlPath === '/index.html')) {
      servePage(res, 'live');
      return;
    }
    if (
      method === 'GET' &&
      (urlPath === '/replay' || urlPath === '/sessions' || urlPath === '/viewer')
    ) {
      servePage(res, 'replay');
      return;
    }
    if (method === 'GET' && urlPath === '/simulator') {
      servePage(res, 'simulator');
      return;
    }
    if (method === 'GET' && urlPath === '/analytics') {
      servePage(res, 'analytics');
      return;
    }
    if (method === 'GET' && urlPath.startsWith('/public/')) {
      serveAsset(res, urlPath.slice('/public/'.length));
      return;
    }
    if (method === 'GET' && urlPath === '/health') {
      sendText(res, 200, 'ok');
      return;
    }
    if (method === 'GET' && urlPath === '/events') {
      serveEvents(req, res);
      return;
    }
    if (method === 'GET' && urlPath === '/api/workspaces') {
      const list = discoverWorkspaces().map((w) => ({
        id: w.id,
        folderName: w.folderName,
        modifiedStr: w.modifiedStr,
        sessionCount: w.sessionCount,
        channel: w.channel,
        ...(config.privacy.exposeAbsolutePaths ? { folder: w.folder } : {}),
      }));
      sendJson(res, 200, list);
      return;
    }
    if (method === 'GET' && urlPath === '/api/workspace-sessions') {
      const q = new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1));
      const r = resolveWorkspaceSessions(q.get('ws') ?? '');
      const sessions = (r?.sessions ?? []).map((s) => ({
        id: s.id,
        name: s.name,
        dateStr: s.dateStr,
        timeRange: s.timeRange,
        events: s.events,
        logFiles: s.logFiles,
      }));
      sendJson(res, 200, sessions);
      return;
    }
    if (method === 'GET' && urlPath === '/api/log') {
      if (!logRateLimit.allow()) {
        sendText(res, 429, 'rate limited');
        return;
      }
      const q = new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1));
      const ws = q.get('ws') ?? '';
      const session = q.get('session') ?? 'main';
      const log = q.get('log') ?? 'main.jsonl';
      const abs = resolveLogPath(ws, session, log);
      if (!abs) {
        sendText(res, 404, 'log not found');
        return;
      }
      const folder = resolveWorkspaceSessions(ws)?.ws.folder;
      const events = loadLogFile(abs, {
        sessionId: session,
        defaultModel: config.pricing.defaultModel,
        repoRoots: folder ? [folder] : [],
      }).map((e) => redactEvent(e, redactOpts));
      sendJson(res, 200, events);
      return;
    }
    if (method === 'POST' && urlPath === '/api/tail') {
      if (!logRateLimit.allow()) {
        sendText(res, 429, 'rate limited');
        return;
      }
      const q = new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1));
      const ws = q.get('ws') ?? '';
      const target = resolveTailTarget(ws, q.get('session'), q.get('log'));
      if (!target) {
        sendText(res, 404, 'workspace/log not found');
        return;
      }
      // Spend from here on belongs to this workspace.
      workspaceId = ws;
      budget.setWorkspace(ws);
      startTail(target.abs, true, target.repoRoots);
      sendJson(res, 200, { ok: true, workspace: target.workspace, log: target.log });
      return;
    }
    if (method === 'POST' && urlPath === '/session/new') {
      broadcast('session');
      sendJson(res, 200, { ok: true });
      return;
    }
    if (method === 'GET' && urlPath === '/api/analytics') {
      const q = new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1));
      const ws = q.get('ws') ?? '';
      const days = Number(q.get('days') ?? 30);
      const r = resolveWorkspaceSessions(ws);
      if (!r) {
        sendText(res, 404, 'workspace not found');
        return;
      }
      const result = getWorkspaceAnalyticsWithInsights(r.ws, {
        timeWindowDays: Number.isFinite(days) ? days : 30,
        defaultModel: config.pricing.defaultModel,
      });
      sendJson(res, 200, result);
      return;
    }
    if (method === 'GET' && urlPath === '/api/config') {
      sendJson(res, 200, config);
      return;
    }
    if (method === 'GET' && urlPath === '/api/spend') {
      const snap = budget.snapshot();
      const q = new URLSearchParams(rawUrl.slice(rawUrl.indexOf('?') + 1));
      const period = q.get('period');
      sendJson(res, 200, {
        snapshot: snap,
        rules: config.budgets.rules,
        ...(period && period in snap.byPeriod
          ? { period: snap.byPeriod[period as keyof typeof snap.byPeriod] }
          : {}),
      });
      return;
    }
    if (method === 'POST' && (urlPath === '/api/budget' || urlPath === '/api/settings')) {
      if (!logRateLimit.allow()) {
        sendText(res, 429, 'rate limited');
        return;
      }
      readBody(req, (raw) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw || '{}');
        } catch {
          sendText(res, 400, 'invalid JSON');
          return;
        }
        // /api/budget is the narrow legacy shape ({rules}); /api/settings takes
        // any config patch. Both funnel through the same validator the config
        // files use, so neither can install a shape the evaluator would ignore.
        const submitted: PartialConfig =
          urlPath === '/api/budget'
            ? { budgets: parsed as PartialConfig['budgets'] }
            : (parsed as PartialConfig);
        const { config: patch, problems } = validateConfig(submitted);
        if (urlPath === '/api/budget' && !patch.budgets?.rules) {
          sendJson(res, 400, { ok: false, problems });
          return;
        }
        if (!Object.keys(patch).length) {
          sendJson(res, 400, { ok: false, problems: problems.length ? problems : ['empty patch'] });
          return;
        }

        // Persist before applying. A limit that evaporates on restart is not a
        // limit, and the reload is what proves a higher-precedence layer (a
        // project file, a TOKENMANCER_* var) has not quietly overridden it.
        const saved = saveConfigPatch(patch, { cwd: opts.cwd, overrides });
        config = saved.config;
        budget.setConfig(config);
        sendJson(res, 200, {
          ok: true,
          rules: config.budgets.rules,
          config,
          savedTo: saved.file,
          problems: [...problems, ...saved.problems],
        });
      });
      return;
    }

    sendText(res, 404, 'not found');
  });

  return new Promise((resolve) => {
    server.listen(opts.port, opts.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : opts.port;
      resolve({
        url: `http://${opts.host}:${port}/`,
        token: opts.token,
        port,
        close: () =>
          new Promise<void>((done) => {
            stopSource();
            for (const [, hb] of heartbeats) clearInterval(hb);
            for (const res of clients) res.end();
            clients.clear();
            server.close(() => done());
          }),
      });
    });
  });
}

function openBrowser(url: string): void {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { detached: true, stdio: 'ignore' }).unref();
  } catch {
    // opening is best-effort; the URL is printed regardless
  }
}

/** CLI entrypoint. */
export async function main(): Promise<void> {
  const { server: opts, overrides } = parseArgs(process.argv.slice(2));

  // Seed a config file on first run so there is something to edit.
  const created = ensureConfigFile();
  const { config, sources, problems } = loadConfig({ overrides });

  // Ranks ship next to the bundles rather than inside them; load them so
  // server-side instruction measurement counts exactly (it estimates until then).
  await initTokenizer(async () =>
    JSON.parse(await fs.promises.readFile(path.join(PUBLIC_DIR, 'o200k_base.json'), 'utf8')),
  ).catch((err) => {
    console.warn('could not load o200k ranks, using estimates:', err?.message ?? err);
  });

  const s = await startServer({ ...opts, config, overrides });
  const link = `${s.url}?token=${s.token}`;
  console.log('GitHub Copilot Tokenmancer — local-first meter');
  console.log(`  ▶ open: ${link}`);
  console.log(
    `  prompts: ${config.privacy.showPrompts ? 'shown (--show-prompts)' : 'redacted by default'} · paths: ${config.privacy.exposeAbsolutePaths ? 'exposed' : 'hidden'}`,
  );
  if (created) console.log(`  config: created ${created}`);
  else console.log(`  config: ${sources.join(' → ')}`);

  const budgeted = config.budgets.rules.filter((r) => r.enabled && r.limit > 0);
  console.log(
    budgeted.length
      ? `  budgets: ${budgeted.map((r) => `${r.id} (${r.limit} ${r.metric}/${r.period})`).join(', ')}`
      : '  budgets: none set',
  );
  for (const p of problems) console.warn(`  ! ${p}`);

  if (opts.open) openBrowser(link);
  const shutdown = async () => {
    await s.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
