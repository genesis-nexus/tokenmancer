import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { type MeterEvent, redactEvent } from '@cte/core';
import {
  type InboxController,
  type TailController,
  discoverWorkspaces,
  isContained,
  isSafeLogFileName,
  loadLogFile,
  resolveLogPath,
  resolveWorkspaceSessions,
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

const CONTENT_TYPE: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const SURFACE_TITLE: Record<string, string> = {
  live: 'Copilot Live Meter',
  replay: 'Copilot Session Replay',
  simulator: 'Copilot Token Simulator',
};

function htmlShell(surface: string, token: string, nonce: string): string {
  const title = SURFACE_TITLE[surface] ?? 'Copilot Token Economics';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
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

export function startServer(opts: ServerOptions): Promise<RunningServer> {
  const clients = new Set<http.ServerResponse>();
  const ring: string[] = [];
  const heartbeats = new Map<http.ServerResponse, ReturnType<typeof setInterval>>();
  let source: TailController | InboxController | null = null;
  const logRateLimit = new RateLimiter(30, 10_000);

  const redactOpts = { showPrompts: opts.showPrompts, salt: randomBytes(8).toString('hex') };

  function frame(ev: MeterEvent): string {
    return `data: ${JSON.stringify(redactEvent(ev, redactOpts))}\n\n`;
  }
  function publish(ev: MeterEvent): void {
    const data = frame(ev);
    ring.push(data);
    if (ring.length > RING_MAX) ring.shift();
    for (const res of clients) res.write(data);
  }
  function broadcast(control: 'session'): void {
    const data = `data: ${JSON.stringify({ kind: 'control', control })}\n\n`;
    if (control === 'session') ring.length = 0;
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

  function startTail(file: string, fresh: boolean): void {
    stopSource();
    if (fresh) {
      ring.length = 0;
      broadcast('session');
    }
    source = startLiveTail(file, {
      emit: publish,
      fromStart: opts.fromStart,
      defaultModel: opts.rateModel,
    });
  }

  // Initial source: an explicit --tail file, else the paste inbox.
  if (opts.tail) {
    const abs = path.resolve(opts.tail);
    const file =
      fs.existsSync(abs) && fs.statSync(abs).isDirectory() ? path.join(abs, 'main.jsonl') : abs;
    startTail(file, false);
  } else if (opts.inbox) {
    source = watchInbox(path.resolve(opts.inbox), { emit: publish, defaultModel: opts.rateModel });
  }

  function resolveTailTarget(
    ws: string,
    sessionId: string | null,
    logFile: string | null,
  ): { abs: string; workspace: string; log: string } | null {
    const r = resolveWorkspaceSessions(ws);
    if (!r || !r.sessions.length) return null;
    const s = sessionId ? r.sessions.find((x) => x.id === sessionId) : r.sessions[0];
    if (!s) return null;
    const log = logFile ?? s.logFiles[0];
    if (!log || !isSafeLogFileName(log) || !s.logFiles.includes(log)) return null;
    const abs = path.join(s.logDir, log);
    if (!isContained(abs, r.ws.debugLogsDir)) return null;
    return { abs, workspace: r.ws.folderName, log };
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
    if (!/^[a-z0-9.\-]+\.(js|css|map)$/i.test(name)) {
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
        ...(opts.exposePaths ? { folder: w.folder } : {}),
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
      const events = loadLogFile(abs, { sessionId: session, defaultModel: opts.rateModel }).map(
        (e) => redactEvent(e, redactOpts),
      );
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
      startTail(target.abs, true);
      sendJson(res, 200, { ok: true, workspace: target.workspace, log: target.log });
      return;
    }
    if (method === 'POST' && urlPath === '/session/new') {
      broadcast('session');
      sendJson(res, 200, { ok: true });
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
  const opts = parseArgs(process.argv.slice(2));
  const s = await startServer(opts);
  const link = `${s.url}?token=${s.token}`;
  console.log('GitHub Copilot Tokenometer — local-first meter');
  console.log(`  ▶ open: ${link}`);
  console.log(
    `  prompts: ${opts.showPrompts ? 'shown (--show-prompts)' : 'redacted by default'} · paths: ${opts.exposePaths ? 'exposed' : 'hidden'}`,
  );
  if (opts.open) openBrowser(link);
  const shutdown = async () => {
    await s.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
