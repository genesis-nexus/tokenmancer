import type { PartialConfig } from '@cte/core';
import * as vscode from 'vscode';

/**
 * Turn VS Code settings into the highest-precedence config layer.
 *
 * The contributed property ids mirror the JSON config paths exactly
 * (`tokenmancer.pricing.defaultModel` ↔ `pricing.defaultModel`), so this is a
 * mechanical walk rather than a mapping table that can drift.
 *
 * Only keys the user has actually set are included: `inspect()` distinguishes
 * an explicit value from a package.json default, and folding defaults in here
 * would let them silently outrank the config files.
 */
const KEYS = [
  'pricing.defaultModel',
  'pricing.poolCredits',
  'privacy.showPrompts',
  'privacy.showToolQueries',
  'privacy.showPaths',
  'alerts.enabled',
  'alerts.cooldownMinutes',
  'alerts.maxPerHour',
  'ui.defaultDetail',
] as const;

function explicitValue(cfg: vscode.WorkspaceConfiguration, key: string): unknown {
  const i = cfg.inspect(key);
  if (!i) return undefined;
  return (
    i.workspaceFolderValue ?? i.workspaceValue ?? i.globalValue ?? i.workspaceFolderLanguageValue
  );
}

function setPath(target: Record<string, unknown>, dotted: string, value: unknown): void {
  const parts = dotted.split('.');
  let node = target;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i] as string;
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[parts[parts.length - 1] as string] = value;
}

export function vscodeConfigToPartial(): PartialConfig {
  const cfg = vscode.workspace.getConfiguration('tokenmancer');
  const out: Record<string, unknown> = {};

  for (const key of KEYS) {
    const v = explicitValue(cfg, key);
    if (v !== undefined) setPath(out, key, v);
  }

  // `budgets.monthlyCredits` is a convenience scalar, not a raw rule array —
  // asking someone to hand-write a rule object in settings.json is a bad ask.
  const monthly = explicitValue(cfg, 'budgets.monthlyCredits');
  if (typeof monthly === 'number' && monthly > 0) {
    out.budgets = {
      rules: [
        {
          id: 'vscode-month',
          enabled: true,
          period: 'month',
          metric: 'credits',
          limit: monthly,
          thresholds: [0.5, 0.8, 1],
          severity: 'warn',
          scope: 'global',
        },
      ],
    };
  }

  return out as PartialConfig;
}

/** True when a changed setting affects anything in the composed config. */
export function affectsTokenmancerConfig(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration('tokenmancer');
}
