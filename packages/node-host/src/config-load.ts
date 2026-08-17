// The only fs-touching part of the config system. Reads the layers, hands them
// to the pure merger in @cte/core, and reports where each one came from so a
// surface can show "loaded from ~/.tokenmancer/config.json".

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  CONFIG_VERSION,
  DEFAULT_CONFIG,
  type PartialConfig,
  type TokenmancerConfig,
  mergeConfig,
  validateConfig,
} from '@cte/core';
import { atomicWriteJson, configPath, ensureDir, readJsonSafe, tokenmancerHome } from './paths.js';

/** Project-scoped config, committable so a repo can carry its own budget. */
export const PROJECT_CONFIG_NAME = '.tokenmancer.json';

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
    $schema: 'https://tokenmancer.dev/schema/config-v1.json',
    ...deepMergeRaw(existing, clean as Record<string, unknown>),
  });

  const reloaded = loadConfig(opts);
  return { file, problems: [...problems, ...reloaded.problems], config: reloaded.config };
}

/**
 * Write the default config on first run so there is something to edit. Returns
 * the path when it created the file, null when one already existed.
 */
export function ensureConfigFile(): string | null {
  const file = configPath();
  if (fs.existsSync(file)) return null;
  ensureDir(tokenmancerHome());
  const seed = {
    $schema: 'https://tokenmancer.dev/schema/config-v1.json',
    ...DEFAULT_CONFIG,
  };
  fs.writeFileSync(file, `${JSON.stringify(seed, null, 2)}\n`, 'utf8');
  return file;
}
