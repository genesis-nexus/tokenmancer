import { randomUUID } from 'node:crypto';
import { DEFAULT_CONFIG, type PartialConfig } from '@cte/core';

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
  /** Explicit config file, bypassing the usual search. */
  configFile: string | null;
}

/**
 * Flags split in two. Genuinely server-only options stay on ServerOptions;
 * anything that also exists as a config key becomes the highest-precedence
 * config layer instead of a second source of truth.
 */
export interface ParsedArgs {
  server: ServerOptions;
  overrides: PartialConfig;
}

const DEFAULT_INBOX = 'copilot-meter-inbox.jsonl';

/** Parse CLI args into hardened server options. Unknown/invalid input fails safe. */
export function parseArgs(argv: string[]): ParsedArgs {
  const opt: ServerOptions = {
    port: 7878,
    host: '127.0.0.1',
    token: randomUUID(),
    showPrompts: false,
    exposePaths: false,
    tail: null,
    inbox: null,
    fromStart: false,
    // No longer a literal duplicated with the extension — one default, in core.
    rateModel: DEFAULT_CONFIG.pricing.defaultModel,
    open: false,
    configFile: null,
  };
  const overrides: PartialConfig = {};
  let monthlyBudget: number | null = null;

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
      overrides.pricing = { ...overrides.pricing, defaultModel: opt.rateModel };
    } else if (a === '--show-prompts') {
      opt.showPrompts = true;
      overrides.privacy = { ...overrides.privacy, showPrompts: true };
    } else if (a === '--expose-paths') {
      opt.exposePaths = true;
      overrides.privacy = { ...overrides.privacy, exposeAbsolutePaths: true };
    } else if (a === '--hide-paths') {
      overrides.privacy = { ...overrides.privacy, showPaths: false };
    } else if (a === '--open') {
      opt.open = true;
    } else if (a === '--token') {
      opt.token = argv[++i] ?? opt.token;
    } else if (a === '--config') {
      opt.configFile = argv[++i] ?? null;
    } else if (a === '--no-alerts') {
      overrides.alerts = { ...overrides.alerts, enabled: false };
    } else if (a === '--budget-month') {
      const n = Number(argv[++i] ?? '');
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--budget-month must be a positive number of credits, got: ${argv[i]}`);
      }
      monthlyBudget = n;
    }
  }

  // A month budget from the CLI is expressed as a rule, so it flows through the
  // same evaluator as a configured one rather than being a special case.
  if (monthlyBudget != null) {
    overrides.budgets = {
      rules: [
        ...DEFAULT_CONFIG.budgets.rules,
        {
          id: 'cli-month',
          enabled: true,
          period: 'month',
          metric: 'credits',
          limit: monthlyBudget,
          thresholds: [0.5, 0.8, 1],
          severity: 'warn',
          scope: 'global',
        },
      ],
    };
  }

  // Guaranteed-to-work default: an inbox file, if no live source was chosen.
  if (!opt.tail && !opt.inbox) opt.inbox = DEFAULT_INBOX;
  return { server: opt, overrides };
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
