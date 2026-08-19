// The only fs-touching part of the config system. Reads the layers, hands them
// to the pure merger in @cte/core, and reports where each one came from so a
// surface can show "loaded from ~/.tokenmancer/config.json".

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFIG_VERSION,
  DEFAULT_BUDGET_RULES,
  type PartialConfig,
  type TokenmancerConfig,
  mergeConfig,
  validateConfig,
} from '@cte/core';
import { atomicWriteJson, configPath, ensureDir, readJsonSafe, tokenmancerHome } from './paths.js';

/** Project-scoped config, committable so a repo can carry its own budget. */
export const PROJECT_CONFIG_NAME = '.tokenmancer.json';

const SCHEMA_URL = `https://tokenmancer.dev/schema/config-v${CONFIG_VERSION}.json`;

export interface LoadConfigOptions {
  /** Directory to look for a project config in. Defaults to process.cwd(). */
  cwd?: string;
  /** Highest-precedence layer: CLI flags or VS Code settings. */
  overrides?: PartialConfig;
  /** Skip the two config files; used by tests and by --no-config. */
  skipFiles?: boolean;
}

export interface LoadedConfig {
  config: TokenmancerConfig;
  /** Files and layers that actually contributed, in precedence order. */
  sources: string[];
  /** Human-readable validation complaints. Never fatal. */
  problems: string[];
}

/**
 * Environment overrides. An explicit allowlist rather than a
 * TOKENMANCER_FOO_BAR → foo.bar derivation, because that mapping is ambiguous
 * (defaultModel vs default_model) and silently mis-set config is worse than
 * config you cannot set from the environment.
 */
const ENV_MAP: Array<{ env: string; apply: (v: string, into: PartialConfig) => void }> = [
  {
    env: 'TOKENMANCER_DEFAULT_MODEL',
    apply: (v, c) => {
      c.pricing = { ...c.pricing, defaultModel: v };
    },
  },
  {
    env: 'TOKENMANCER_POOL_CREDITS',
    apply: (v, c) => {
      c.pricing = { ...c.pricing, poolCredits: Number(v) };
    },
  },
  {
    env: 'TOKENMANCER_SHOW_PROMPTS',
    apply: (v, c) => {
      c.privacy = { ...c.privacy, showPrompts: isTruthy(v) };
    },
  },
  {
    env: 'TOKENMANCER_SHOW_TOOL_QUERIES',
    apply: (v, c) => {
      c.privacy = { ...c.privacy, showToolQueries: isTruthy(v) };
    },
  },
  {
    env: 'TOKENMANCER_SHOW_PATHS',
    apply: (v, c) => {
      c.privacy = { ...c.privacy, showPaths: isTruthy(v) };
    },
  },
  {
    env: 'TOKENMANCER_ALERTS_ENABLED',
    apply: (v, c) => {
      c.alerts = { ...c.alerts, enabled: isTruthy(v) };
    },
  },
];

function isTruthy(v: string): boolean {
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function envLayer(problems: string[]): PartialConfig | null {
  const raw: PartialConfig = {};
  let any = false;
  for (const { env, apply } of ENV_MAP) {
    const v = process.env[env];
    if (v == null || !v.trim()) continue;
    apply(v, raw);
    any = true;
  }
  if (!any) return null;
  const { config, problems: p } = validateConfig(raw);
  for (const x of p) problems.push(`env: ${x}`);
  return config;
}

function fileLayer(file: string, problems: string[]): PartialConfig | null {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return null; // absent is the normal case, not a problem
  }
  if (!text.trim()) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    problems.push(`${file}: not valid JSON (${(e as Error).message}) — ignored`);
    return null;
  }
  const { config, problems: p } = validateConfig(parsed);
  for (const x of p) problems.push(`${file}: ${x}`);
  return config;
}

/**
 * Compose the config. Precedence, lowest first:
 *   DEFAULT_CONFIG < ~/.tokenmancer/config.json < <cwd>/.tokenmancer.json
 *   < TOKENMANCER_* env < overrides
 *
 * A corrupt file at any layer is skipped with a `problem`, never thrown — the
 * meter must still start.
 */
export function loadConfig(opts: LoadConfigOptions = {}): LoadedConfig {
  const problems: string[] = [];
  const sources: string[] = ['defaults'];
  const layers: PartialConfig[] = [];

  if (!opts.skipFiles) {
    const global = configPath();
    const g = fileLayer(global, problems);
    if (g) {
      layers.push(g);
      sources.push(global);
    }

    const project = path.join(path.resolve(opts.cwd ?? process.cwd()), PROJECT_CONFIG_NAME);
    if (project !== global) {
      const p = fileLayer(project, problems);
      if (p) {
        layers.push(p);
        sources.push(project);
      }
    }
  }

  const env = envLayer(problems);
  if (env) {
    layers.push(env);
    sources.push('env');
  }

  if (opts.overrides) {
    layers.push(opts.overrides);
    sources.push('flags');
  }

  const config = mergeConfig(...layers);
  if (config.version !== CONFIG_VERSION) {
    problems.push(
      `config version ${config.version} does not match ${CONFIG_VERSION}; using it anyway`,
    );
  }
  return { config, sources, problems };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Deep-merge a patch into raw file JSON. Arrays replace wholesale — a budget
 * rule list is a set, not something to element-wise merge — which matches
 * `mergeConfig`'s rule so the saved file layers the way the reader expects.
 */
function deepMergeRaw(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    const prev = out[k];
    out[k] = isPlainObject(v) && isPlainObject(prev) ? deepMergeRaw(prev, v) : v;
  }
  return out;
}

export interface SavedConfig {
  file: string;
  problems: string[];
  /** The full config as it now reads back, defaults and all layers applied. */
  config: TokenmancerConfig;
}

/**
 * Persist a settings change to the global config file.
 *
 * The patch is merged into the file's *existing* JSON rather than a serialised
 * full config: the file stays sparse, so a key the user never set keeps
 * tracking `DEFAULT_CONFIG` instead of being frozen at today's default. Anything
 * the validator rejects is dropped and reported — a settings write must never
 * be able to install a shape the evaluator would silently ignore.
 *
 * Note the layering consequence: a project `.tokenmancer.json` or a
 * `TOKENMANCER_*` env var outranks this file, so a saved value can legitimately
 * fail to take effect. The returned `config` is what actually governs.
 */
export function saveConfigPatch(patch: PartialConfig, opts: LoadConfigOptions = {}): SavedConfig {
  const file = configPath();
  const { config: clean, problems } = validateConfig(patch);

  const existing = readJsonSafe<Record<string, unknown>>(file, {});
  ensureDir(tokenmancerHome());
  atomicWriteJson(file, {
    $schema: SCHEMA_URL,
    ...deepMergeRaw(existing, clean as Record<string, unknown>),
  });

  const reloaded = loadConfig(opts);
  return { file, problems: [...problems, ...reloaded.problems], config: reloaded.config };
}

/**
 * Every default as v1 wrote them. Frozen deliberately: this is a record of what
 * old files contain, not a second copy of DEFAULT_CONFIG, and it must not move
 * when the shipped defaults do. Includes the `radar` / `thresholds` /
 * `cacheEnabled` keys v1 seeded for features that were never implemented.
 */
const V1_DEFAULTS: Record<string, unknown> = {
  version: 1,
  pricing: { defaultModel: 'claude-sonnet-4.6', poolCredits: 3000, creditUsd: 0.01 },
  privacy: { showPrompts: false, showPaths: true, exposeAbsolutePaths: false },
  // Arrays compare whole (JSON.stringify), matching mergeConfig's replace-don't-
  // concatenate rule: an untouched rule list is dropped, an edited one is kept.
  budgets: { rules: DEFAULT_BUDGET_RULES },
  alerts: {
    enabled: true,
    cooldownMinutes: 15,
    maxPerHour: 6,
    channels: { banner: true, notification: true, statusBar: true },
  },
  radar: {
    enabled: true,
    loopCredits: 5,
    loopSteps: 15,
    toolContextTokens: 5000,
    repeatReadCount: 3,
  },
  thresholds: { highContextRatio: 0.8, shortPromptChars: 40 },
  analytics: { timeWindowDays: 30, cacheEnabled: true },
  ui: { defaultDetail: 'simple' },
};

/**
 * Drop every leaf that still holds the default it was seeded with. A value the
 * user genuinely chose that happens to equal the default resolves to the same
 * thing either way, so this is lossless — it only decides whether the key keeps
 * tracking future releases.
 */
function stripSeededDefaults(
  node: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node)) {
    const d = defaults[k];
    if (isPlainObject(v) && isPlainObject(d)) {
      const nested = stripSeededDefaults(v, d);
      if (Object.keys(nested).length) out[k] = nested;
    } else if (JSON.stringify(v) !== JSON.stringify(d)) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Bring an older config file up to the current schema. Returns the path when it
 * rewrote something, null when there was nothing to do.
 *
 * v1 → v2 exists because v1's seed wrote out the entire default config. That
 * froze `privacy.showPrompts: false` on every machine that ever started the
 * meter, so changing the shipped default could not reach an existing user —
 * their prompts stayed redacted forever. It also left `radar` and `thresholds`
 * behind for features that were dropped, which the validator now reports as
 * unknown options on every single load.
 */
export function migrateConfigFile(): string | null {
  const file = configPath();
  let raw: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!isPlainObject(parsed)) return null;
    raw = parsed;
  } catch {
    // Absent or corrupt. loadConfig already reports corruption as a problem;
    // a migration must never be the thing that stops the meter starting.
    return null;
  }
  const version = typeof raw.version === 'number' ? raw.version : 1;
  if (version >= CONFIG_VERSION) return null;

  // validateConfig prunes unknown keys and bad values; strip then removes what
  // was only ever a copied default. What survives is what the user chose.
  const { config: known } = validateConfig(raw);
  const kept = stripSeededDefaults(known as Record<string, unknown>, V1_DEFAULTS);

  // `version` last so it wins over whatever the old file carried.
  atomicWriteJson(file, { $schema: SCHEMA_URL, ...kept, version: CONFIG_VERSION });
  return file;
}

/**
 * Write a config file on first run so there is something to edit. Returns the
 * path when it created the file, null when one already existed.
 *
 * The seed is deliberately near-empty. Writing out every default looks helpful
 * but pins them: a key present in the file stops tracking DEFAULT_CONFIG, so
 * the user is frozen at whatever shipped the day they first ran the meter —
 * exactly the trap v1 fell into. `$schema` carries the discoverability instead.
 */
export function ensureConfigFile(): string | null {
  const file = configPath();
  if (fs.existsSync(file)) return null;
  ensureDir(tokenmancerHome());
  const seed = { $schema: SCHEMA_URL, version: CONFIG_VERSION };
  fs.writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  return file;
}
