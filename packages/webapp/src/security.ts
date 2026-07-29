import { randomUUID } from 'node:crypto';

export interface ServerOptions {
  port: number;
  host: string;
  token: string;
  /** When false (default), prompt text is redacted before it leaves the process. */
  showPrompts: boolean;
  /** When false (default), absolute project paths are withheld from /api/workspaces. */
  exposePaths: boolean;
  tail: string | null;
  inbox: string | null;
  fromStart: boolean;
  rateModel: string;
  open: boolean;
}

const DEFAULT_INBOX = 'copilot-meter-inbox.jsonl';

/** Parse CLI args into hardened server options. Unknown/invalid input fails safe. */
export function parseArgs(argv: string[]): ServerOptions {
  const opt: ServerOptions = {
    port: 7878,
    host: '127.0.0.1',
    token: randomUUID(),
    showPrompts: false,
    exposePaths: false,
    tail: null,
    inbox: null,
    fromStart: false,
    rateModel: 'claude-sonnet-4.6',
    open: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      const n = Number.parseInt(argv[++i] ?? '', 10);
      if (Number.isInteger(n) && n >= 1024 && n <= 65535) opt.port = n;
      else throw new Error(`--port must be an integer in [1024, 65535], got: ${argv[i]}`);
    } else if (a === '--tail') {
      opt.tail = argv[++i] ?? null;
    } else if (a === '--inbox') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        opt.inbox = next;
        i++;
      } else {
        opt.inbox = DEFAULT_INBOX;
      }
    } else if (a === '--from-start') {
      opt.fromStart = true;
    } else if (a === '--rate-model') {
      opt.rateModel = argv[++i] ?? opt.rateModel;
    } else if (a === '--show-prompts') {
      opt.showPrompts = true;
    } else if (a === '--expose-paths') {
      opt.exposePaths = true;
    } else if (a === '--open') {
      opt.open = true;
    } else if (a === '--token') {
      opt.token = argv[++i] ?? opt.token;
    }
  }
  // Guaranteed-to-work default: an inbox file, if no live source was chosen.
  if (!opt.tail && !opt.inbox) opt.inbox = DEFAULT_INBOX;
  return opt;
}

/** Accept only loopback Host headers (blocks DNS-rebinding). */
export function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  const host = hostHeader.split(':')[0]?.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
}

/** If an Origin/Referer is present, it must be loopback too. Absent is fine
 *  (non-browser clients, EventSource in some engines). */
export function originAllowed(origin: string | undefined): boolean {
  if (!origin) return true;
  try {
    const u = new URL(origin);
    return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '::1';
  } catch {
    return false;
  }
}

/** Constant-ish token comparison from the request URL's `token` query param. */
export function tokenOk(reqUrl: string | undefined, token: string): boolean {
  if (!reqUrl) return false;
  const q = reqUrl.indexOf('?');
  if (q < 0) return false;
  const params = new URLSearchParams(reqUrl.slice(q + 1));
  const got = params.get('token');
  return !!got && got.length === token.length && timingSafeEqualStr(got, token);
}

function timingSafeEqualStr(a: string, b: string): boolean {
  let mismatch = a.length ^ b.length;
  for (let i = 0; i < a.length && i < b.length; i++) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

/** Minimal fixed-window rate limiter for the fs-touching routes. */
export class RateLimiter {
  private hits = 0;
  private windowStart = Date.now();
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}
  allow(): boolean {
    const now = Date.now();
    if (now - this.windowStart > this.windowMs) {
      this.windowStart = now;
      this.hits = 0;
    }
    this.hits++;
    return this.hits <= this.max;
  }
}
