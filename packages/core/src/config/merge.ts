// Pure config composition: validate untrusted input into a PartialConfig, then
// deep-merge the layers over DEFAULT_CONFIG.
//
// Two invariants the callers rely on:
//   1. validateConfig NEVER throws. A corrupt config file must degrade to
//      defaults with a readable `problems` list, not stop the meter starting.
//   2. Arrays replace, they never concatenate. Merging budget rule lists would
//      make it impossible to remove a default rule from a lower layer.

import type { BudgetMetric, BudgetPeriod, BudgetRule, BudgetScope } from '../budget/types.js';
import type { AlertSeverity } from '../budget/types.js';
import { DEFAULT_CONFIG, type PartialConfig, type TokenmancerConfig } from './schema.js';

const PERIODS: readonly BudgetPeriod[] = ['loop', 'session', 'day', 'week', 'month', 'pool'];
const METRICS: readonly BudgetMetric[] = ['credits', 'usd', 'poolPercent', 'tokens', 'steps'];
const SEVERITIES: readonly AlertSeverity[] = ['info', 'warn', 'critical'];
const SCOPES: readonly BudgetScope[] = ['global', 'workspace'];

type Leaf =
  | { t: 'bool' }
  | { t: 'num'; min?: number; int?: boolean }
  | { t: 'str'; nonEmpty?: boolean; oneOf?: readonly string[] }
  | { t: 'rules' };

interface Group {
  [key: string]: Leaf | Group;
}

function isLeaf(n: Leaf | Group): n is Leaf {
  return typeof (n as Leaf).t === 'string';
}

/** Mirrors TokenmancerConfig. Anything absent here is an unknown key and is dropped. */
const SPEC: Group = {
  version: { t: 'num', int: true, min: 1 },
  pricing: {
    defaultModel: { t: 'str', nonEmpty: true },
    poolCredits: { t: 'num', min: 1 },
    creditUsd: { t: 'num', min: 0 },
  },
  privacy: {
    showPrompts: { t: 'bool' },
    showToolQueries: { t: 'bool' },
    showPaths: { t: 'bool' },
    exposeAbsolutePaths: { t: 'bool' },
  },
  budgets: {
    rules: { t: 'rules' },
  },
  alerts: {
    enabled: { t: 'bool' },
    cooldownMinutes: { t: 'num', min: 0 },
    maxPerHour: { t: 'num', min: 0, int: true },
    channels: {
      banner: { t: 'bool' },
      notification: { t: 'bool' },
      statusBar: { t: 'bool' },
    },
  },
  analytics: {
    timeWindowDays: { t: 'num', min: 1, int: true },
  },
  ui: {
    defaultDetail: { t: 'str', oneOf: ['simple', 'detailed'] },
  },
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkLeaf(spec: Leaf, v: unknown, path: string, problems: string[]): unknown {
  switch (spec.t) {
    case 'bool':
      if (typeof v !== 'boolean') {
        problems.push(`${path}: expected boolean, got ${typeof v}`);
        return undefined;
      }
      return v;
    case 'num': {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        problems.push(`${path}: expected a finite number, got ${JSON.stringify(v)}`);
        return undefined;
      }
      if (spec.int && !Number.isInteger(v)) {
        problems.push(`${path}: expected an integer, got ${v}`);
        return undefined;
      }
      if (spec.min != null && v < spec.min) {
        problems.push(`${path}: ${v} is below the minimum of ${spec.min}`);
        return undefined;
      }
      return v;
    }
    case 'str':
      if (typeof v !== 'string') {
        problems.push(`${path}: expected string, got ${typeof v}`);
        return undefined;
      }
      if (spec.nonEmpty && !v.trim()) {
        problems.push(`${path}: must not be empty`);
        return undefined;
      }
      if (spec.oneOf && !spec.oneOf.includes(v)) {
        problems.push(
          `${path}: expected one of ${spec.oneOf.join(' | ')}, got ${JSON.stringify(v)}`,
        );
        return undefined;
      }
      return v;
    case 'rules':
      return checkRules(v, path, problems);
  }
}

function oneOf<T extends string>(
  values: readonly T[],
  v: unknown,
  path: string,
  problems: string[],
): T | undefined {
  if (typeof v === 'string' && (values as readonly string[]).includes(v)) return v as T;
  problems.push(`${path}: expected one of ${values.join(' | ')}, got ${JSON.stringify(v)}`);
  return undefined;
}

/**
 * Budget rules are validated whole: a rule missing a field it needs is dropped
 * rather than half-merged, because a rule with a bogus period would silently
 * never fire — the worst possible failure mode for a budget.
 */
function checkRules(v: unknown, path: string, problems: string[]): BudgetRule[] | undefined {
  if (!Array.isArray(v)) {
    problems.push(`${path}: expected an array of budget rules`);
    return undefined;
  }
  const out: BudgetRule[] = [];
  const seen = new Set<string>();
  v.forEach((raw, i) => {
    const at = `${path}[${i}]`;
    if (!isPlainObject(raw)) {
      problems.push(`${at}: expected an object`);
      return;
    }
    const id = typeof raw.id === 'string' && raw.id.trim() ? raw.id.trim() : '';
    if (!id) {
      problems.push(`${at}.id: required, must be a non-empty string`);
      return;
    }
    if (seen.has(id)) {
      problems.push(`${at}.id: duplicate rule id "${id}" — later rules win`);
    }
    const period = oneOf(PERIODS, raw.period, `${at}.period`, problems);
    const metric = oneOf(METRICS, raw.metric, `${at}.metric`, problems);
    const severity =
      raw.severity === undefined
        ? 'warn'
        : oneOf(SEVERITIES, raw.severity, `${at}.severity`, problems);
    const scope =
      raw.scope === undefined ? 'global' : oneOf(SCOPES, raw.scope, `${at}.scope`, problems);
    if (!period || !metric || !severity || !scope) return;

    const limit = checkLeaf({ t: 'num', min: 0 }, raw.limit, `${at}.limit`, problems);
    if (typeof limit !== 'number') return;

    let thresholds = [0.5, 0.8, 1];
    if (raw.thresholds !== undefined) {
      if (
        !Array.isArray(raw.thresholds) ||
        !raw.thresholds.every((t) => typeof t === 'number' && Number.isFinite(t) && t > 0)
      ) {
        problems.push(`${at}.thresholds: expected an array of positive numbers`);
        return;
      }
      thresholds = [...(raw.thresholds as number[])].sort((a, b) => a - b);
    }

    if (scope === 'workspace' && typeof raw.workspaceId !== 'string') {
      problems.push(`${at}.workspaceId: required when scope is "workspace"`);
      return;
    }

    const rule: BudgetRule = {
      id,
      enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
      period,
      metric,
      limit,
      thresholds,
      severity,
      scope,
    };
    if (typeof raw.workspaceId === 'string') rule.workspaceId = raw.workspaceId;
    if (typeof raw.message === 'string') rule.message = raw.message;

    // Last definition of an id wins, so a higher layer can amend one rule.
    const dup = out.findIndex((r) => r.id === id);
    if (dup >= 0) out[dup] = rule;
    else out.push(rule);
    seen.add(id);
  });
  return out;
}

function walk(
  spec: Group,
  input: unknown,
  path: string,
  problems: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!isPlainObject(input)) {
    if (input !== undefined) problems.push(`${path || 'config'}: expected an object`);
    return out;
  }
  for (const [key, raw] of Object.entries(input)) {
    const at = path ? `${path}.${key}` : key;
    // `$schema` is an editor affordance, not configuration.
    if (key === '$schema') continue;
    const node = spec[key];
    if (!node) {
      problems.push(`${at}: unknown option (ignored)`);
      continue;
    }
    if (raw === undefined) continue;
    if (isLeaf(node)) {
      const v = checkLeaf(node, raw, at, problems);
      if (v !== undefined) out[key] = v;
    } else {
      const nested = walk(node, raw, at, problems);
      if (Object.keys(nested).length) out[key] = nested;
    }
  }
  return out;
}

/**
 * Coerce untrusted input (a parsed JSON file, env vars, a webview message) into
 * a PartialConfig. Unknown keys are dropped and bad values are skipped; both are
 * reported in `problems` so the surfaces can show a settings banner.
 */
export function validateConfig(input: unknown): { config: PartialConfig; problems: string[] } {
  const problems: string[] = [];
  const config = walk(SPEC, input, '', problems) as PartialConfig;
  return { config, problems };
}

function mergeInto(base: Record<string, unknown>, layer: Record<string, unknown>): void {
  for (const [key, v] of Object.entries(layer)) {
    if (v === undefined) continue;
    const cur = base[key];
    if (isPlainObject(v) && isPlainObject(cur)) {
      const next = { ...cur };
      mergeInto(next, v);
      base[key] = next;
    } else {
      // Arrays and scalars replace outright — see the header note.
      base[key] = v;
    }
  }
}

/**
 * Compose layers over the defaults, lowest precedence first:
 *   DEFAULT_CONFIG < ~/.tokenmancer/config.json < <repo>/.tokenmancer.json
 *   < TOKENMANCER_* env < surface overrides (CLI flags | VS Code settings)
 */
export function mergeConfig(...layers: PartialConfig[]): TokenmancerConfig {
  const out = structuredCloneish(DEFAULT_CONFIG) as unknown as Record<string, unknown>;
  for (const layer of layers) {
    if (layer) mergeInto(out, layer as Record<string, unknown>);
  }
  return out as unknown as TokenmancerConfig;
}

/** Deep copy without relying on structuredClone (not in every webview realm). */
function structuredCloneish<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}
