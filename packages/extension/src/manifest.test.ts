import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, type PartialConfig } from '@cte/core';
import { describe, expect, it } from 'vitest';

/**
 * The manifest is a second, hand-maintained copy of the config surface, and
 * VS Code renders its `default` values in the Settings UI. Nothing at runtime
 * reads them — `vscodeConfigToPartial` deliberately takes only user-set values
 * via `inspect()` — so a drifted default is invisible in testing and wrong only
 * on the screen the user reads. That is exactly the failure this locks down.
 */
const manifest = JSON.parse(
  readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'),
    'utf8',
  ),
) as {
  contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
  activationEvents: string[];
  icon: string;
  main: string;
  scripts: Record<string, string>;
};

const props = manifest.contributes.configuration.properties;

/** Resolve `pricing.poolCredits` against DEFAULT_CONFIG. */
function configDefault(dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, k) => (node as Record<string, unknown> | undefined)?.[k],
      DEFAULT_CONFIG as PartialConfig,
    );
}

describe('extension manifest', () => {
  it('declares the same defaults the config module ships', () => {
    const drift: string[] = [];
    for (const [id, prop] of Object.entries(props)) {
      const dotted = id.replace(/^tokenmancer\./, '');
      // Convenience scalars with no 1:1 config path opt out by defaulting to null.
      if (prop.default === null) continue;
      const expected = configDefault(dotted);
      if (expected === undefined) continue;
      if (prop.default !== expected) drift.push(`${id}: manifest ${prop.default} ≠ ${expected}`);
    }
    expect(drift).toEqual([]);
  });

  /**
   * Every contributed setting must reach the config layer, or it is a control
   * in the Settings UI that silently does nothing.
   */
  it('contributes no setting that nothing reads', () => {
    const wired = new Set(
      readFileSync(
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'vscode-config.ts'),
        'utf8',
      )
        .match(/'([a-z][A-Za-z]*\.[A-Za-z.]+)'/g)
        ?.map((s) => s.slice(1, -1)) ?? [],
    );
    const orphans = Object.keys(props)
      .map((id) => id.replace(/^tokenmancer\./, ''))
      // Legacy alias kept for people who set it before the privacy group existed.
      .filter((k) => k !== 'showPrompts')
      .filter((k) => !wired.has(k));
    expect(orphans).toEqual([]);
  });

  it('builds before it publishes, and points at what it ships', () => {
    // Without vscode:prepublish, `vsce publish` ships whatever is in dist.
    expect(manifest.scripts['vscode:prepublish']).toContain('--production');
    expect(manifest.main).toBe('./dist/extension.js');
    // vsce rejects SVG marketplace icons.
    expect(manifest.icon).toMatch(/\.png$/);
    expect(manifest.activationEvents).toContain('onStartupFinished');
  });
});
