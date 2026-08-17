// The configuration contract. Types + defaults only — zero dependencies, no fs,
// no `process`, no clock — so the UI can import it to render a settings editor
// and the webview can bundle it under CSP.
//
// Reading config files is @cte/node-host's job (config-load.ts). This module is
// the shared vocabulary both surfaces agree on, and the place where the
// constants that used to be baked in (POOL, the duplicated RATE_MODEL) become
// user-settable.

import type { BudgetRule } from '../budget/types.js';

export const CONFIG_VERSION = 1;

export interface PricingConfig {
  /** Fallback model when a log record carries no model id. */
  defaultModel: string;
  /** Credits in the non-rolling monthly seat pool. */
  poolCredits: number;
  /** USD per AI-Credit. */
  creditUsd: number;
}

export interface PrivacyConfig {
  /** When false, prompt text and tool queries are redacted before they leave the parser. */
  showPrompts: boolean;
  /** When false, only repo-relative tool targets are reported; absolute ones are dropped. */
  showPaths: boolean;
  /** When false, workspace filesystem paths are withheld from the workspace list. */
  exposeAbsolutePaths: boolean;
}

export interface AlertChannels {
  banner: boolean;
  notification: boolean;
  statusBar: boolean;
}

export interface AlertsConfig {
  /** Master switch. When false the budget runner short-circuits entirely. */
  enabled: boolean;
  /** Suppresses everything but `critical` for this long after any alert. */
  cooldownMinutes: number;
  /** Hard cap; excess alerts are coalesced into a single suppressed-count line. */
  maxPerHour: number;
  channels: AlertChannels;
}

export interface UiConfig {
  /**
   * How much detail a surface opens with for someone who has not chosen yet.
   * The in-view toggle always wins and is remembered per machine.
   */
  defaultDetail: 'simple' | 'detailed';
}

export interface AnalyticsConfig {
  timeWindowDays: number;
}

export interface TokenmancerConfig {
  version: number;
  pricing: PricingConfig;
  privacy: PrivacyConfig;
  budgets: { rules: BudgetRule[] };
  alerts: AlertsConfig;
  analytics: AnalyticsConfig;
  ui: UiConfig;
}

/** Deep-partial, except arrays, which replace wholesale rather than merging. */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends object
      ? DeepPartial<T[K]>
      : T[K];
};

export type PartialConfig = DeepPartial<TokenmancerConfig>;

/**
 * Shipped defaults. A fresh install must not nag: exactly two rules are on, and
 * both are the kind you would have wanted anyway (you are burning your seat's
 * pool; this one loop is unusually expensive). Everything else is opt-in.
 */
export const DEFAULT_BUDGET_RULES: BudgetRule[] = [
  {
    id: 'pool-monthly',
    enabled: true,
    period: 'pool',
    metric: 'poolPercent',
    limit: 100,
    thresholds: [0.5, 0.8, 0.95],
    severity: 'warn',
    scope: 'global',
  },
  {
    id: 'loop-runaway',
    enabled: true,
    period: 'loop',
    metric: 'credits',
    limit: 5,
    thresholds: [1],
    severity: 'info',
    scope: 'global',
  },
];

export const DEFAULT_CONFIG: TokenmancerConfig = {
  version: CONFIG_VERSION,
  pricing: {
    // Mirrors DEFAULT_MODEL / POOL / CREDIT_USD in ../pricing/models.ts. Kept as
    // literals so this module stays free of the pricing graph; config.test.ts
    // asserts the two never drift.
    defaultModel: 'claude-sonnet-4.6',
    poolCredits: 3000,
    creditUsd: 0.01,
  },
  privacy: {
    showPrompts: false,
    showPaths: true,
    exposeAbsolutePaths: false,
  },
  budgets: { rules: DEFAULT_BUDGET_RULES },
  alerts: {
    enabled: true,
    cooldownMinutes: 15,
    maxPerHour: 6,
    channels: { banner: true, notification: true, statusBar: true },
  },
  analytics: {
    timeWindowDays: 30,
  },
  // Simple by default: someone meeting token economics for the first time is
  // the reader this has to win over.
  ui: { defaultDetail: 'simple' },
};
