import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AlertEvent, PartialConfig, StepEvent, TokenmancerConfig } from '@cte/core';
import { mergeConfig } from '@cte/core';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { BudgetRunner } from './budget-runner.js';
import {
  PROJECT_CONFIG_NAME,
  ensureConfigFile,
  loadConfig,
  saveConfigPatch,
} from './config-load.js';
import { readSpend } from './ledger.js';
import { configPath, stateDir } from './paths.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-runner-'));
process.env.TOKENMANCER_HOME = tmp;
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const T0 = Date.parse('2026-08-16T10:00:00');

beforeEach(() => {
  fs.rmSync(stateDir(), { recursive: true, force: true });
  fs.rmSync(configPath(), { force: true });
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('TOKENMANCER_') && k !== 'TOKENMANCER_HOME') delete process.env[k];
  }
});

function step(over: Partial<StepEvent> = {}): StepEvent {
  return {
    kind: 'step',
    id: 1,
    ts: T0,
    source: 'tail',
    groupId: 'g1',
    promptGroupIndex: 1,
    stepIndex: 1,
    userPrompt: 'p',
    model: 'claude-sonnet-4.6',
    requestType: 'request',
    toolName: '',
    stepKind: 'llm',
    isTool: false,
    targets: [],
    toolIntent: '',
    toolQuery: '',
    resultBytes: 0,
    prompt: 1000,
    completion: 100,
    cacheRead: 0,
    cacheWrite: 0,
    freshInput: 1000,
    aic: 1,
    exact: true,
    promptSnippet: '',
    systemPromptFile: '',
    sessionId: 's1',
    spanId: 'sp1',
    parentSpanId: '',
    eventType: 'request',
    rawKey: 'k1',
    ...over,
  };
}

function cfgWith(limit: number, extra: PartialConfig = {}): TokenmancerConfig {
  return mergeConfig(
    {
      budgets: {
        rules: [
          {
            id: 'day-limit',
            enabled: true,
            period: 'day',
            metric: 'credits',
            limit,
            thresholds: [0.5, 0.8, 1],
            severity: 'warn',
            scope: 'global',
          },
        ],
      },
    },
    extra,
  );
}

function runner(config: TokenmancerConfig, now = () => T0) {
  const got: AlertEvent[] = [];
  const r = new BudgetRunner({ config, workspaceId: 'ws1', now });
  r.onAlert((a) => got.push(a));
  return { r, got };
}

describe('BudgetRunner alerts', () => {
  it('fires once when spend crosses a threshold', () => {
    const { r, got } = runner(cfgWith(10));
    r.observe(step({ rawKey: 'a', aic: 4 })); // 40% — nothing
    expect(got).toHaveLength(0);
    r.observe(step({ rawKey: 'b', aic: 2 })); // 60% — crosses 50%
    expect(got).toHaveLength(1);
    expect(got[0]?.title).toBe('Past 50% of budget — today');
  });

  it('does not re-fire the same threshold on subsequent steps', () => {
    const { r, got } = runner(cfgWith(10));
    r.observe(step({ rawKey: 'a', aic: 6 }));
    r.observe(step({ rawKey: 'b', aic: 0.1 }));
    r.observe(step({ rawKey: 'c', aic: 0.1 }));
    expect(got).toHaveLength(1);
  });

  it('escalates to critical when the limit itself is passed', () => {
    const { r, got } = runner(cfgWith(10));
    r.observe(step({ rawKey: 'a', aic: 11 }));
    expect(got).toHaveLength(1);
    expect(got[0]?.severity).toBe('critical');
    expect(got[0]?.title).toBe('Budget exceeded — today');
  });

  it('stays silent when alerts are disabled', () => {
    const { r, got } = runner(cfgWith(1, { alerts: { enabled: false } }));
    r.observe(step({ rawKey: 'a', aic: 100 }));
    expect(got).toEqual([]);
  });

  it('stays silent when no rule is enabled', () => {
    const { r, got } = runner(mergeConfig({ budgets: { rules: [] } }));
    r.observe(step({ rawKey: 'a', aic: 999 }));
    expect(got).toEqual([]);
  });

  it('tracks a loop budget per groupId, restarting on a new loop', () => {
    const cfg = mergeConfig({
      budgets: {
        rules: [
          {
            id: 'loop',
            enabled: true,
            period: 'loop',
            metric: 'credits',
            limit: 5,
            thresholds: [1],
            severity: 'info',
            scope: 'global',
          },
        ],
      },
    });
    const { r, got } = runner(cfg);
    r.observe(step({ rawKey: 'a', groupId: 'g1', aic: 6 }));
    expect(got).toHaveLength(1);
    // A different loop starts from zero, so it must not immediately re-fire.
    r.observe(step({ rawKey: 'b', groupId: 'g2', aic: 1 }));
    expect(got).toHaveLength(1);
    r.observe(step({ rawKey: 'c', groupId: 'g2', aic: 6 }));
    expect(got).toHaveLength(2);
  });
});

describe('BudgetRunner persistence', () => {
  it('writes one ledger line per step, carrying targets', () => {
    const { r } = runner(cfgWith(1000));
    r.observe(step({ rawKey: 'a' }));
    r.observe(
      step({ rawKey: 'b', isTool: true, aic: 0, toolName: 'read_file', targets: ['src/a.ts'] }),
    );
    const rows = readSpend();
    expect(rows).toHaveLength(2);
    expect(rows.find((e) => e.rawKey === 'b')?.targets).toEqual(['src/a.ts']);
  });

  /**
   * The single most important assertion in Phase 1: month-to-date must come off
   * disk, not out of memory, or a budget means nothing the moment you restart.
   */
  it('month-to-date survives a restart', () => {
    const first = runner(cfgWith(100));
    first.r.observe(step({ rawKey: 'a', aic: 30 }));
    first.r.dispose();

    const second = runner(cfgWith(100));
    expect(second.r.snapshot().byPeriod.month.credits).toBe(30);

    // ...and the seeded total counts toward the next crossing.
    second.r.observe(step({ rawKey: 'b', aic: 25 })); // 55 of 100
    expect(second.got).toHaveLength(1);
    expect(second.got[0]?.observed).toBe(55);
  });

  it('remembers fired alerts across a restart', () => {
    const first = runner(cfgWith(10));
    first.r.observe(step({ rawKey: 'a', aic: 6 }));
    expect(first.got).toHaveLength(1);
    first.r.dispose();

    // A new process re-observes the same spend level; it must stay quiet.
    const second = runner(cfgWith(10));
    second.r.observe(step({ rawKey: 'b', aic: 0.1 }));
    expect(second.got).toEqual([]);
  });

  it('does not double-count a step it has already recorded', () => {
    const { r } = runner(cfgWith(1000));
    r.observe(step({ rawKey: 'same', aic: 7 }));
    r.observe(step({ rawKey: 'same', aic: 7 }));
    expect(readSpend()).toHaveLength(1);
    // ...and the in-memory counter agrees with the ledger, not with the stream.
    expect(r.snapshot().byPeriod.month.credits).toBe(7);
  });

  /**
   * A restart re-tails the log from its head, so previously-recorded steps come
   * back through `observe`. They are seeded from disk already; counting them
   * again turned 1.695 cr into 3.39 cr.
   */
  it('does not re-count seeded spend when a restarted tail replays it', () => {
    const first = runner(cfgWith(1000));
    first.r.observe(step({ rawKey: 'replayed', aic: 1.695 }));
    expect(first.r.snapshot().byPeriod.month.credits).toBeCloseTo(1.695, 6);
    first.r.dispose();

    const second = runner(cfgWith(1000));
    expect(second.r.snapshot().byPeriod.month.credits).toBeCloseTo(1.695, 6);
    second.r.observe(step({ rawKey: 'replayed', aic: 1.695 })); // the replay
    expect(second.r.snapshot().byPeriod.month.credits).toBeCloseTo(1.695, 6);

    // A genuinely new step still lands.
    second.r.observe(step({ rawKey: 'fresh', aic: 1 }));
    expect(second.r.snapshot().byPeriod.month.credits).toBeCloseTo(2.695, 6);
  });

  /**
   * Replaying an archived log must not spend today's budget. The ledger row is
   * written under the step's own month, so counting it against the current one
   * would make the live figure disagree with what a restart reconstructs.
   */
  it('does not charge a historical step to the current period', () => {
    const lastYear = Date.parse('2025-08-16T10:00:00');
    const { r, got } = runner(cfgWith(1));
    r.observe(step({ rawKey: 'old', ts: lastYear, aic: 50 }));

    const snap = r.snapshot();
    expect(snap.byPeriod.month.credits).toBe(0);
    expect(snap.byPeriod.day.credits).toBe(0);
    expect(got).toEqual([]);

    // ...but it is still recorded, under its own month.
    expect(readSpend({ from: 0, to: Date.now() }).map((e) => e.rawKey)).toContain('old');
    // ...and the loop/session tallies, which are identity-keyed, do count it.
    expect(snap.byPeriod.session.credits).toBe(50);
  });

  it('resetSession clears session and loop tallies but not the month', () => {
    const { r } = runner(cfgWith(1000));
    r.observe(step({ rawKey: 'a', aic: 5 }));
    r.resetSession();
    expect(r.snapshot().byPeriod.session.credits).toBe(0);
    expect(r.snapshot().byPeriod.month.credits).toBe(5);
  });
});

describe('loadConfig', () => {
  it('returns defaults when nothing is configured', () => {
    const { config, sources, problems } = loadConfig({ cwd: tmp });
    expect(problems).toEqual([]);
    expect(sources).toEqual(['defaults']);
    expect(config.pricing.poolCredits).toBe(3000);
  });

  it('layers global file < project file < env < overrides', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ pricing: { poolCredits: 1000 } }));

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-proj-'));
    fs.writeFileSync(
      path.join(projDir, PROJECT_CONFIG_NAME),
      JSON.stringify({ pricing: { poolCredits: 2000, defaultModel: 'gpt-4.1' } }),
    );

    expect(loadConfig({ cwd: projDir }).config.pricing.poolCredits).toBe(2000);

    process.env.TOKENMANCER_POOL_CREDITS = '3000';
    expect(loadConfig({ cwd: projDir }).config.pricing.poolCredits).toBe(3000);

    const withFlags = loadConfig({
      cwd: projDir,
      overrides: { pricing: { poolCredits: 4000 } },
    });
    expect(withFlags.config.pricing.poolCredits).toBe(4000);
    // the project file's other key still shows through
    expect(withFlags.config.pricing.defaultModel).toBe('gpt-4.1');
    expect(withFlags.sources).toEqual([
      'defaults',
      configPath(),
      path.join(projDir, PROJECT_CONFIG_NAME),
      'env',
      'flags',
    ]);
    fs.rmSync(projDir, { recursive: true, force: true });
  });

  it('reports a corrupt file as a problem and carries on with defaults', () => {
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(configPath(), '{ this is not json');
    const { config, problems } = loadConfig({ cwd: tmp });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/not valid JSON/);
    expect(config.pricing.poolCredits).toBe(3000);
  });

  it('parses boolean env vars', () => {
    process.env.TOKENMANCER_SHOW_PROMPTS = 'true';
    expect(loadConfig({ cwd: tmp }).config.privacy.showPrompts).toBe(true);
    process.env.TOKENMANCER_SHOW_PROMPTS = 'no';
    expect(loadConfig({ cwd: tmp }).config.privacy.showPrompts).toBe(false);
  });

  it('ensureConfigFile seeds defaults once, then leaves them alone', () => {
    expect(ensureConfigFile()).toBe(configPath());
    const written = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    expect(written.$schema).toBeTruthy();
    expect(written.pricing.poolCredits).toBe(3000);
    // $schema must not become a validation problem on the next load
    expect(loadConfig({ cwd: tmp }).problems).toEqual([]);
    expect(ensureConfigFile()).toBeNull();
  });
});

describe('saveConfigPatch', () => {
  it('persists a setting and reads it back on the next load', () => {
    const saved = saveConfigPatch({ pricing: { poolCredits: 1234 } }, { cwd: tmp });
    expect(saved.config.pricing.poolCredits).toBe(1234);
    // The point of the whole exercise: a limit that does not survive a restart
    // is not a limit.
    expect(loadConfig({ cwd: tmp }).config.pricing.poolCredits).toBe(1234);
  });

  it('keeps the file sparse, so untouched keys still track the defaults', () => {
    saveConfigPatch({ pricing: { poolCredits: 1234 } }, { cwd: tmp });
    const written = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
    expect(written.pricing).toEqual({ poolCredits: 1234 });
    // Serialising the whole composed config here would freeze today's defaults
    // into the file forever.
    expect(written.alerts).toBeUndefined();
    expect(loadConfig({ cwd: tmp }).config.alerts.cooldownMinutes).toBe(15);
  });

  it('merges successive writes instead of replacing the file', () => {
    saveConfigPatch({ pricing: { poolCredits: 1234 } }, { cwd: tmp });
    saveConfigPatch({ alerts: { enabled: false } }, { cwd: tmp });
    const cfg = loadConfig({ cwd: tmp }).config;
    expect(cfg.pricing.poolCredits).toBe(1234);
    expect(cfg.alerts.enabled).toBe(false);
  });

  it('replaces the rule array wholesale rather than merging by index', () => {
    saveConfigPatch(
      {
        budgets: {
          rules: [
            {
              id: 'a',
              enabled: true,
              period: 'month',
              metric: 'credits',
              limit: 10,
              thresholds: [1],
              severity: 'warn',
              scope: 'global',
            },
            {
              id: 'b',
              enabled: true,
              period: 'day',
              metric: 'credits',
              limit: 5,
              thresholds: [1],
              severity: 'warn',
              scope: 'global',
            },
          ],
        },
      },
      { cwd: tmp },
    );
    saveConfigPatch(
      {
        budgets: {
          rules: [
            {
              id: 'a',
              enabled: true,
              period: 'month',
              metric: 'credits',
              limit: 99,
              thresholds: [1],
              severity: 'warn',
              scope: 'global',
            },
          ],
        },
      },
      { cwd: tmp },
    );
    const rules = loadConfig({ cwd: tmp }).config.budgets.rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ id: 'a', limit: 99 });
  });

  it('drops what the validator rejects and reports why', () => {
    const saved = saveConfigPatch({ pricing: { poolCredits: 'lots' } } as never, { cwd: tmp });
    expect(saved.problems.length).toBeGreaterThan(0);
    expect(saved.config.pricing.poolCredits).toBe(3000);
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8')).pricing?.poolCredits).toBeUndefined();
  });

  /**
   * The layering consequence worth knowing about: a project file outranks the
   * global one, so a saved value can legitimately not take effect. The returned
   * config has to report what governs, not what was asked for.
   */
  it('reports the governing value when a higher layer outranks the save', () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-proj-save-'));
    fs.writeFileSync(
      path.join(projDir, PROJECT_CONFIG_NAME),
      JSON.stringify({ pricing: { poolCredits: 777 } }),
    );
    const saved = saveConfigPatch({ pricing: { poolCredits: 1234 } }, { cwd: projDir });
    expect(saved.config.pricing.poolCredits).toBe(777);
    // ...and the write still landed, so removing the project file reveals it.
    expect(JSON.parse(fs.readFileSync(configPath(), 'utf8')).pricing.poolCredits).toBe(1234);
    fs.rmSync(projDir, { recursive: true, force: true });
  });
});
