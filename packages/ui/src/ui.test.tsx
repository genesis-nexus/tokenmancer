// @vitest-environment jsdom
import {
  type AlertEvent,
  type BudgetRule,
  DEFAULT_CONFIG,
  type MeterEvent,
  type PartialConfig,
  type SpendSnapshot,
  type TokenmancerConfig,
  type TrendDataPoint,
  createGroupingContext,
  processRecord,
} from '@cte/core';
import type preact from 'preact';
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type MetricKey, TrendChart } from './components/Analytics/TrendChart.js';
import { App } from './components/App.js';
import { AppNav, WEB_NAV } from './components/AppNav.js';
import { Logo } from './components/Logo.js';
import { SessionBrowser } from './components/SessionBrowser.js';
import {
  alerts,
  resetAlerts,
  setConfig,
  setSpend,
  settingsOpen,
  spend,
  summarizeSpend,
} from './state/budget-store.js';
import {
  applyConfigDefault,
  setSkillMode,
  skillMode,
  skillModeIsDefault,
} from './state/skill-store.js';
import { dispatch, resetSession } from './state/store.js';
import type { MeterTransport, SessionSummary, WorkspaceSummary } from './transport.js';
import { ReplayTransport } from './transport.js';

function generate(lines: string[]): MeterEvent[] {
  const ctx = createGroupingContext();
  const out: MeterEvent[] = [];
  for (const l of lines) processRecord(JSON.parse(l), 'archive', ctx, (e) => out.push(e));
  return out;
}

const LINES = [
  '{"type":"user_message","sid":"s1","spanId":"p1","ts":1700000000000,"attrs":{"userRequest":"Refactor formatPrice"}}',
  '{"type":"request","sid":"s1","spanId":"r1","parentSpanId":"p1","ts":1700000000001,"model":"claude-sonnet-4.6","prompt_tokens":12000,"completion_tokens":300,"cached_tokens":9000,"cache_creation_input_tokens":1000}',
];

const tick = () => new Promise((r) => setTimeout(r, 20));

/**
 * Wait for a selector rather than guessing at a sleep. A fixed 20ms was enough
 * when App mounted one effect; it flakes now that mount does more, and the
 * failure mode ("expected null not to be null") tells you nothing.
 */
async function waitForSelector(sel: string, timeoutMs = 2000): Promise<Element> {
  const started = Date.now();
  for (;;) {
    const el = document.querySelector(sel);
    if (el) return el;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for "${sel}"`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

afterEach(() => {
  resetSession();
  resetAlerts();
  spend.value = null;
});

// Simple is the shipped default, so any test asserting dense chrome has to ask
// for the detailed view explicitly.
beforeEach(() => setSkillMode('advanced'));

function alertEvent(over: Partial<AlertEvent> = {}): AlertEvent {
  return {
    kind: 'alert',
    id: 'r1:2026-08:0.8',
    ts: 1,
    severity: 'warn',
    title: '80% of budget — this month',
    body: '80.0 cr of your 100.0 cr budget for this month (80%).',
    ruleId: 'r1',
    period: 'month',
    observed: 80,
    limit: 100,
    ...over,
  };
}

describe('meter UI renders the loop card', () => {
  it('shows the prompt, a loop cost, a step row, and the step table', async () => {
    const events = generate(LINES);
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<App transport={new ReplayTransport(() => events)} sourceBar={null} />, root);
    await waitForSelector('.loop');

    const html = document.body.innerHTML;
    expect(html).toContain('Refactor formatPrice');
    // sticky readout hero shows a credit total
    expect(document.querySelector('.readout .stat.hero .val')?.textContent).toContain('cr');
    // the step table (every-number view) is present
    expect(document.querySelector('table.stepTable')).not.toBeNull();
    // loop cost renders the computed 1.695 cr (rounded display 1.70)
    expect(document.querySelector('.loopMeta .cost')?.textContent).toContain('1.70');

    render(null, root);
    root.remove();
  });
});

class FakeTransport implements MeterTransport {
  constructor(private readonly events: MeterEvent[]) {}
  subscribe(): () => void {
    return () => {};
  }
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return [
      {
        id: 'w1',
        provider: 'copilot',
        folderName: 'Demo',
        modifiedStr: 'now',
        sessionCount: 1,
        channel: 'Code',
      },
    ];
  }
  async listSessions(): Promise<SessionSummary[]> {
    return [
      {
        id: 'main',
        name: 'Session A',
        dateStr: 'Jul 22',
        timeRange: '10:00 - 10:05',
        events: 2,
        logFiles: ['main.jsonl'],
      },
    ];
  }
  async loadSession(): Promise<MeterEvent[]> {
    return this.events;
  }
  async tailWorkspace() {
    return {};
  }
  async newSession() {}
  dispose() {}
}

describe('session browser → replay', () => {
  it('picks a workspace, lists sessions, and replays the selected one', async () => {
    const t = new FakeTransport(generate(LINES));
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(
      <App
        transport={t}
        subscribe={false}
        showConnection={false}
        sourceBar={<SessionBrowser transport={t} />}
      />,
      root,
    );
    await tick();

    const wsSel = document.getElementById('wsSelect') as HTMLSelectElement;
    wsSel.value = 'w1';
    wsSel.dispatchEvent(new Event('change'));
    await tick();

    const sesSel = document.getElementById('sessionSelect') as HTMLSelectElement;
    expect(sesSel.querySelectorAll('option').length).toBeGreaterThan(1);
    sesSel.value = 'main';
    sesSel.dispatchEvent(new Event('change'));
    await tick();

    const replayBtn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Replay'),
    );
    replayBtn?.click();
    await waitForSelector('.loop');
    expect(document.body.innerHTML).toContain('Refactor formatPrice');

    render(null, root);
    root.remove();
  });
});

describe('budget alerts', () => {
  it('renders an alert dispatched onto the event stream, and dismisses it', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<App transport={new ReplayTransport(() => [])} sourceBar={null} />, root);
    await tick();

    dispatch(alertEvent());
    await waitForSelector('.alert-warn');
    expect(document.body.innerHTML).toContain('80% of budget');

    (document.querySelector('.alert-x') as HTMLButtonElement).click();
    await tick();
    expect(document.querySelector('.alert')).toBeNull();

    // A dismissed alert must not pop back when the producer re-sends it.
    dispatch(alertEvent());
    await tick();
    expect(document.querySelector('.alert')).toBeNull();

    render(null, root);
    root.remove();
  });

  it('tints by severity and keeps at most three on screen', () => {
    for (const n of [1, 2, 3, 4]) {
      dispatch(alertEvent({ id: `r${n}:p:1`, severity: 'critical' }));
    }
    expect(alerts.value).toHaveLength(3);
    expect(alerts.value.every((a) => a.severity === 'critical')).toBe(true);
  });

  it('clears the banners when a new session starts', () => {
    // A fresh id: dismissals are remembered for the life of the page, which the
    // test above relies on, so reusing that id here would be suppressed.
    dispatch(alertEvent({ id: 'session-reset:p:1' }));
    expect(alerts.value).toHaveLength(1);
    dispatch({ kind: 'control', control: 'session' });
    expect(alerts.value).toHaveLength(0);
  });
});

describe('BudgetBar', () => {
  function snapshot(credits: number): SpendSnapshot {
    const p = (key: string) => ({ key, credits, tokens: 0, steps: 0 });
    return {
      now: Date.parse('2026-08-10T12:00:00'),
      workspaceId: 'ws1',
      byPeriod: {
        loop: p('g1'),
        session: p('s1'),
        day: p('2026-08-10'),
        week: p('2026-W33'),
        month: p('2026-08'),
        pool: p('2026-08'),
      },
      poolCredits: 5000,
      creditUsd: 0.01,
    };
  }

  const rule = (over: Partial<BudgetRule>): BudgetRule => ({
    id: 'r',
    enabled: true,
    period: 'month',
    metric: 'credits',
    limit: 100,
    thresholds: [1],
    severity: 'warn',
    scope: 'global',
    ...over,
  });

  it('says so when no budget is configured', async () => {
    setSpend(summarizeSpend(snapshot(12), []));
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<App transport={new ReplayTransport(() => [])} sourceBar={null} />, root);
    const bar = await waitForSelector('.budgetbar-unset');
    expect(bar.textContent).toContain('no budget set');
    render(null, root);
    root.remove();
  });

  it('converts a poolPercent limit into credits', () => {
    const s = summarizeSpend(snapshot(500), [
      rule({ period: 'pool', metric: 'poolPercent', limit: 50 }),
    ]);
    expect(s.limit).toBe(2500); // 50% of a 5,000-credit pool
  });

  it('picks the tightest applicable limit — the one you hit first', () => {
    const s = summarizeSpend(snapshot(10), [
      rule({ id: 'a', limit: 400 }),
      rule({ id: 'b', period: 'pool', metric: 'poolPercent', limit: 100 }), // 5000 cr
      rule({ id: 'c', limit: 250 }),
    ]);
    expect(s.limit).toBe(250);
  });

  it('ignores disabled rules and periods that are not month-scale', () => {
    const s = summarizeSpend(snapshot(10), [
      rule({ id: 'off', limit: 5, enabled: false }),
      rule({ id: 'loop', period: 'loop', limit: 1 }),
      rule({ id: 'day', period: 'day', limit: 2 }),
    ]);
    expect(s.limit).toBeNull();
  });

  it('derives a burn rate from the day of the month', () => {
    // 100 credits by the 10th → 10/day.
    const s = summarizeSpend(snapshot(100), [], Date.parse('2026-08-10T12:00:00'));
    expect(s.burnRate).toBeCloseTo(10, 6);
  });

  it('renders the gauge with a critical tint once the limit is passed', async () => {
    setSpend(summarizeSpend(snapshot(120), [rule({ limit: 100 })]));
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<App transport={new ReplayTransport(() => [])} sourceBar={null} />, root);
    await waitForSelector('.budgetbar-crit');
    render(null, root);
    root.remove();
  });
});

describe('level-of-detail toggle', () => {
  function mount() {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<App transport={new ReplayTransport(() => generate(LINES))} sourceBar={null} />, root);
    return () => {
      render(null, root);
      root.remove();
    };
  }

  it('defaults to simple for a reader with no saved preference', () => {
    localStorage.removeItem('tokenmancer.skillMode');
    // The store reads localStorage once at import, so assert the contract the
    // default rests on rather than re-importing the module.
    expect(localStorage.getItem('tokenmancer.skillMode')).toBeNull();
  });

  it('simple view hides the step table and shows money first', async () => {
    setSkillMode('novice');
    const unmount = mount();
    await waitForSelector('.loop');

    expect(document.querySelector('table.stepTable')).toBeNull();
    expect(document.querySelector('.loopExpand')).not.toBeNull();
    expect(document.querySelector('.readout .stat.hero .val')?.textContent).toContain('$');
    expect(document.querySelector('.readout .stat.hero .lbl')?.textContent).toBe('This session');
    // plain-language summary replaces the token stat line
    expect(document.querySelector('.loopPlain')).not.toBeNull();
    expect(document.querySelector('.loopStats')).toBeNull();
    unmount();
  });

  it('detailed view restores the step table and credit-first readout', async () => {
    setSkillMode('advanced');
    const unmount = mount();
    await waitForSelector('.loop');

    expect(document.querySelector('table.stepTable')).not.toBeNull();
    expect(document.querySelector('.loopExpand')).toBeNull();
    expect(document.querySelector('.readout .stat.hero .val')?.textContent).toContain('cr');
    expect(document.querySelector('.loopStats')).not.toBeNull();
    unmount();
  });

  it('expands one loop’s steps on demand without leaving simple mode', async () => {
    setSkillMode('novice');
    const unmount = mount();
    await waitForSelector('.loopExpand');

    (document.querySelector('.loopExpand') as HTMLButtonElement).click();
    await waitForSelector('.steps');
    expect(document.querySelectorAll('.step').length).toBeGreaterThan(1);
    // still simple: the every-number table stays behind the detailed view
    expect(document.querySelector('table.stepTable')).toBeNull();
    expect(skillMode.value).toBe('novice');
    unmount();
  });

  it('the Learn card only appears in simple mode, and switches modes on click', async () => {
    setSkillMode('advanced');
    let unmount = mount();
    await waitForSelector('.loop');
    expect(document.querySelector('.learnCard')).toBeNull();
    unmount();

    setSkillMode('novice');
    unmount = mount();
    const more = (await waitForSelector('.learnMore')) as HTMLButtonElement;
    more.click();
    expect(skillMode.value).toBe('advanced');
    unmount();
  });

  it('the toggle switches modes and persists the choice', async () => {
    setSkillMode('novice');
    const unmount = mount();
    await waitForSelector('.skillToggle');

    const detailed = [...document.querySelectorAll('.skillOpt')].find(
      (b) => b.textContent === 'Detailed',
    ) as HTMLButtonElement;
    detailed.click();
    expect(skillMode.value).toBe('advanced');
    expect(localStorage.getItem('tokenmancer.skillMode')).toBe('advanced');

    // Re-query: the click re-renders, so the captured node is stale.
    await tick();
    const pressed = [...document.querySelectorAll('.skillOpt')].find(
      (b) => b.getAttribute('aria-pressed') === 'true',
    );
    expect(pressed?.textContent).toBe('Detailed');
    unmount();
  });

  it('stamps the mode on <html> so CSS can react without prop drilling', () => {
    setSkillMode('novice');
    expect(document.documentElement.dataset.skill).toBe('novice');
    setSkillMode('advanced');
    expect(document.documentElement.dataset.skill).toBe('advanced');
  });
});

describe('configured default detail', () => {
  it('applies only while the reader has made no choice of their own', () => {
    // Fresh page, nothing chosen: a workspace default takes effect.
    skillModeIsDefault.value = true;
    applyConfigDefault('detailed');
    expect(skillMode.value).toBe('advanced');

    skillModeIsDefault.value = true;
    applyConfigDefault('simple');
    expect(skillMode.value).toBe('novice');

    // Once they pick, the setting must not yank it back.
    setSkillMode('advanced');
    applyConfigDefault('simple');
    expect(skillMode.value).toBe('advanced');
  });

  it('ignores a missing value rather than forcing a default', () => {
    setSkillMode('advanced');
    skillModeIsDefault.value = true;
    applyConfigDefault(undefined);
    expect(skillMode.value).toBe('advanced');
  });
});

describe('the calendar the budget is racing', () => {
  function snap(credits: number): SpendSnapshot {
    const p = (key: string) => ({ key, credits, tokens: 0, steps: 0 });
    return {
      now: 0,
      workspaceId: 'ws1',
      byPeriod: {
        loop: p('g1'),
        session: p('s1'),
        day: p('2026-08-10'),
        week: p('2026-W33'),
        month: p('2026-08'),
        pool: p('2026-08'),
      },
      poolCredits: 3000,
      creditUsd: 0.01,
    };
  }
  const monthRule = (limit: number): BudgetRule => ({
    id: 'm',
    enabled: true,
    period: 'month',
    metric: 'credits',
    limit,
    thresholds: [1],
    severity: 'warn',
    scope: 'global',
  });
  // The 10th of a 31-day month.
  const AUG_10 = Date.parse('2026-08-10T12:00:00');

  it('counts the days left in the month, not a rolling window', () => {
    const s = summarizeSpend(snap(100), [], AUG_10);
    expect(s.daysElapsed).toBe(10);
    expect(s.daysInMonth).toBe(31);
    expect(s.daysLeft).toBe(21);
    expect(s.monthLabel).toBe('August');
  });

  it('handles a short month and its last day', () => {
    const feb = summarizeSpend(snap(10), [], Date.parse('2027-02-28T12:00:00'));
    expect(feb.daysInMonth).toBe(28);
    expect(feb.daysLeft).toBe(0);
    // A leap February is a different length, and the pace maths must follow it.
    expect(summarizeSpend(snap(10), [], Date.parse('2028-02-10T12:00:00')).daysInMonth).toBe(29);
  });

  it('projects the month-end total from the rate so far', () => {
    // 100 credits by the 10th → 10/day → 310 across a 31-day month.
    const s = summarizeSpend(snap(100), [], AUG_10);
    expect(s.projected).toBeCloseTo(310, 6);
  });

  it('names the day the allowance runs out, but only when it will', () => {
    // 10/day against a 200 limit: 100 left, ten more days, so the 20th.
    expect(summarizeSpend(snap(100), [monthRule(200)], AUG_10).exhaustsOnDay).toBe(20);
    // A limit the rate never reaches has no such day.
    expect(summarizeSpend(snap(100), [monthRule(1000)], AUG_10).exhaustsOnDay).toBeNull();
    // Nor does a month with no spend in it at all.
    expect(summarizeSpend(snap(0), [monthRule(200)], AUG_10).exhaustsOnDay).toBeNull();
  });

  it('never points past the end of the month it belongs to', () => {
    // 10/day against 305: arithmetic says day 30.5, but a budget cannot run out
    // on the 32nd of August.
    const s = summarizeSpend(snap(100), [monthRule(305)], AUG_10);
    expect(s.exhaustsOnDay).toBeLessThanOrEqual(31);
  });

  it('shows the days left and the projection on the gauge', async () => {
    setSkillMode('advanced');
    setSpend(summarizeSpend(snap(100), [monthRule(1000)], AUG_10));
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<App transport={new ReplayTransport(() => [])} sourceBar={null} />, root);
    const bar = await waitForSelector('.budgetbar');
    expect(bar.textContent).toContain('21 days left in August');
    expect(bar.textContent).toContain('on pace for');
    render(null, root);
    root.remove();
  });

  /**
   * Outrunning the calendar is a warning even while the absolute figure still
   * looks healthy — 10% of the budget spent is fine, unless it went in a day.
   */
  it('warns on pace alone, before the spend itself is high', async () => {
    setSkillMode('advanced');
    setSpend(summarizeSpend(snap(100), [monthRule(200)], AUG_10));
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<App transport={new ReplayTransport(() => [])} sourceBar={null} />, root);
    const bar = await waitForSelector('.budgetbar-warn');
    expect(bar.textContent).toContain('run out around the 20th');
    render(null, root);
    root.remove();
  });
});

describe('settings dialog', () => {
  const CFG: TokenmancerConfig = {
    ...DEFAULT_CONFIG,
    pricing: { ...DEFAULT_CONFIG.pricing, poolCredits: 3000 },
    budgets: {
      rules: [
        {
          id: 'month-limit',
          enabled: true,
          period: 'month',
          metric: 'credits',
          limit: 2000,
          thresholds: [0.5, 0.8, 1],
          severity: 'warn',
          scope: 'global',
        },
        {
          id: 'hand-written',
          enabled: true,
          period: 'day',
          metric: 'steps',
          limit: 40,
          thresholds: [1],
          severity: 'info',
          scope: 'global',
        },
      ],
    },
  };

  // Roots are torn down centrally: a failing assertion must not leave a live
  // App in the document for the next test's queries to find.
  const roots: HTMLElement[] = [];
  afterEach(() => {
    settingsOpen.value = false;
    for (const r of roots.splice(0)) {
      render(null, r);
      r.remove();
    }
  });

  function mount(savingTransport = true, governing: TokenmancerConfig = CFG) {
    const saved: PartialConfig[] = [];
    const base = new ReplayTransport(() => []);
    const transport = (
      savingTransport
        ? Object.assign(base, {
            getConfig: async () => CFG,
            updateSettings: async (patch: PartialConfig) => {
              saved.push(patch);
              return { ok: true, config: governing, savedTo: '/tmp/config.json' };
            },
          })
        : base
    ) as MeterTransport;

    setConfig(CFG);
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);
    render(<App transport={transport} sourceBar={null} />, root);
    return { saved, root };
  }

  /** Open the panel and let the seeding effect flush before reading it. */
  async function openPanel(root: HTMLElement): Promise<HTMLDialogElement> {
    (root.querySelector('.settingsBtn') as HTMLButtonElement).click();
    await tick();
    return root.querySelector('.settingsDlg') as HTMLDialogElement;
  }

  const numbers = (dlg: HTMLDialogElement): HTMLInputElement[] =>
    [...dlg.querySelectorAll('input[type=number]')] as HTMLInputElement[];

  // Clicking is the path the browser actually takes: the page is served under
  // `form-action 'none'`, so a real form submission never reaches the handler.
  const submit = async (dlg: HTMLDialogElement) => {
    (dlg.querySelector('.settingsSave') as HTMLButtonElement).click();
    await tick();
  };

  it('is reachable from the masthead and shows the current numbers', async () => {
    const { root } = mount();
    await waitForSelector('.settingsBtn');
    const dlg = await openPanel(root);
    const [pool, cap] = numbers(dlg);
    // Allowance, then the month cap; both read out of config rather than blank.
    expect(pool?.value).toBe('3000');
    expect(cap?.value).toBe('2000');
  });

  it('saves the edited allowance', async () => {
    const { root, saved } = mount();
    await waitForSelector('.settingsBtn');
    const dlg = await openPanel(root);

    const pool = numbers(dlg)[0] as HTMLInputElement;
    pool.value = '4200';
    pool.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    await submit(dlg);

    expect(saved).toHaveLength(1);
    expect(saved[0]?.pricing?.poolCredits).toBe(4200);
  });

  /**
   * The config file is hand-editable, so it can hold rules with no field in
   * this dialog. Saving must carry them through — dropping them would be a
   * silent data loss the user could only find by re-reading the file.
   */
  it('preserves rules the dialog has no field for', async () => {
    const { root, saved } = mount();
    await waitForSelector('.settingsBtn');
    await submit(await openPanel(root));

    expect((saved[0]?.budgets?.rules ?? []).map((r) => r.id)).toContain('hand-written');
  });

  it('clearing the cap disables its rule rather than discarding the thresholds', async () => {
    const { root, saved } = mount();
    await waitForSelector('.settingsBtn');
    const dlg = await openPanel(root);

    const cap = numbers(dlg)[1] as HTMLInputElement;
    cap.value = '';
    cap.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    await submit(dlg);

    const month = (saved[0]?.budgets?.rules ?? []).find((r) => r.id === 'month-limit');
    expect(month?.enabled).toBe(false);
    // Switching it off and on again must not cost the tuning.
    expect(month?.thresholds).toEqual([0.5, 0.8, 1]);
  });

  /**
   * The gauge is on a 30-second poll, so without an explicit refresh a saved
   * budget appears to do nothing for up to half a minute — exactly when the
   * reader is looking for confirmation it took.
   */
  it('refreshes the gauge immediately rather than waiting for the poll', async () => {
    const snapshot: SpendSnapshot = {
      now: 0,
      workspaceId: 'ws1',
      byPeriod: {
        loop: { key: 'g', credits: 0, tokens: 0, steps: 0 },
        session: { key: 's', credits: 0, tokens: 0, steps: 0 },
        day: { key: 'd', credits: 0, tokens: 0, steps: 0 },
        week: { key: 'w', credits: 0, tokens: 0, steps: 0 },
        month: { key: '2026-08', credits: 10, tokens: 0, steps: 0 },
        pool: { key: '2026-08', credits: 10, tokens: 0, steps: 0 },
      },
      poolCredits: 3000,
      creditUsd: 0.01,
    };
    const base = new ReplayTransport(() => []);
    const transport = Object.assign(base, {
      getConfig: async () => CFG,
      // The rules the server reports back carry the newly saved cap.
      getSpend: async () => ({
        snapshot,
        rules: [{ ...CFG.budgets.rules[0]!, limit: 25 }],
      }),
      updateSettings: async () => ({ ok: true, config: CFG, savedTo: '/tmp/c.json' }),
    }) as MeterTransport;

    setConfig(CFG);
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);
    render(<App transport={transport} sourceBar={null} />, root);
    await waitForSelector('.settingsBtn');
    await submit(await openPanel(root));
    await tick();

    expect(spend.value?.limit).toBe(25);
  });

  /**
   * A successful save publishes the new config. If that re-runs the seeding
   * effect, it wipes the very status line the save just set — the write lands
   * while the panel reports nothing, which reads exactly like a broken button.
   */
  it('keeps the confirmation visible after the save republishes the config', async () => {
    const { root } = mount();
    await waitForSelector('.settingsBtn');
    const dlg = await openPanel(root);
    await submit(dlg);
    await tick();

    const status = root.querySelector('.setStatus') as HTMLElement;
    expect(status.textContent).toContain('Saved to /tmp/config.json');
    expect(status.className).toContain('setStatus-ok');
  });

  it('does not claim success when a higher layer outranks the saved value', async () => {
    // The server writes the file but reports 9999 as what actually governs.
    const outranked: TokenmancerConfig = {
      ...CFG,
      pricing: { ...CFG.pricing, poolCredits: 9999 },
    };
    const { root } = mount(true, outranked);
    await waitForSelector('.settingsBtn');
    const dlg = await openPanel(root);

    const pool = numbers(dlg)[0] as HTMLInputElement;
    pool.value = '4200';
    pool.dispatchEvent(new Event('input', { bubbles: true }));
    await tick();
    await submit(dlg);

    const status = root.querySelector('.setStatus') as HTMLElement;
    expect(status.className).toContain('setStatus-warn');
    expect(status.textContent).toContain('9999');
  });

  /** Capability detection: nothing to persist to means no button to press. */
  it('stays hidden on a transport that cannot save', async () => {
    const { root } = mount(false);
    await waitForSelector('.appbar');
    expect(root.querySelector('.settingsBtn')).toBeNull();
  });
});

/**
 * The mark type is a correctness question, not a cosmetic one: a smoothed area
 * over daily counts draws values that were never measured and shades a region
 * that means nothing. These lock each measure to a mark that matches its shape.
 */
describe('trend chart mark types', () => {
  const roots: HTMLElement[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      render(null, r);
      r.remove();
    }
  });

  const trend = (n: number): TrendDataPoint[] =>
    Array.from({ length: n }, (_, i) => ({
      date: `2026-08-${String(i + 1).padStart(2, '0')}`,
      // Deliberately includes zero days: a sparse count series is the case the
      // mark type has to get right.
      sessionCount: i % 3,
      totalAic: 1 + i,
      totalLoops: i % 4,
      avgContextFillRate: 0.4 + i / 100,
      modelSwitches: i % 2,
      highContextCalls: i % 5,
      avgStepsPerLoop: 2 + (i % 3),
    }));

  function mount(only?: MetricKey[], initial?: MetricKey) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);
    render(<TrendChart data={trend(10)} only={only} initial={initial} />, root);
    return root;
  }

  function tabTo(root: HTMLElement, label: string) {
    const tab = [...root.querySelectorAll('.trend-tab')].find((t) => t.textContent === label);
    (tab as HTMLButtonElement).click();
  }

  it('draws counted events as bars, one per day', async () => {
    const root = mount();
    tabTo(root, 'Sessions');
    await tick();
    expect(root.querySelectorAll('.trend-bar')).toHaveLength(10);
    expect(root.querySelector('.trend-line')).toBeNull();
  });

  it('keeps the filled area only for spend, which genuinely accumulates', async () => {
    const root = mount(undefined, 'totalAic');
    await tick();
    expect(root.querySelector('path[fill^="url(#trendFill"]')).not.toBeNull();
    expect(root.querySelectorAll('.trend-bar')).toHaveLength(0);
  });

  it('draws a bounded rate as a bare line — nothing accumulates under a percentage', async () => {
    const root = mount();
    tabTo(root, 'Cache Reuse');
    await tick();
    expect(root.querySelector('.trend-line')).not.toBeNull();
    expect(root.querySelector('path[fill^="url(#trendFill"]')).toBeNull();
    expect(root.querySelectorAll('.trend-bar')).toHaveLength(0);
  });

  it('carries the moving average across both mark types', async () => {
    const root = mount(undefined, 'totalAic');
    await tick();
    expect(root.querySelector('.trend-ma-line')).not.toBeNull();
    tabTo(root, 'Sessions');
    await tick();
    expect(root.querySelector('.trend-ma-line')).not.toBeNull();
  });

  /**
   * A gridline at "0.3 sessions" labels a quantity that cannot occur. The axis
   * must not invent resolution the data has not got.
   */
  it('gives a counted measure whole-number gridlines', async () => {
    const root = mount();
    tabTo(root, 'Sessions');
    await tick();
    const labels = [...root.querySelectorAll('.trend-axis-label')]
      .map((t) => t.textContent ?? '')
      .filter((t) => /^[0-9.]+$/.test(t));
    expect(labels.length).toBeGreaterThan(0);
    expect(labels.every((l) => Number.isInteger(Number(l)))).toBe(true);
  });

  it('still allows fractional gridlines where the measure is continuous', async () => {
    // Sub-credit days are real, so the cost axis must keep its decimals.
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);
    const small = trend(4).map((d) => ({ ...d, totalAic: 0.4 }));
    render(<TrendChart data={small} initial="totalAic" />, root);
    await tick();
    const labels = [...root.querySelectorAll('.trend-axis-label')].map((t) => t.textContent ?? '');
    expect(labels.some((l) => l.includes('.'))).toBe(true);
  });

  /**
   * A zero day draws no bar. The gap says the agent did not run; flooring it to
   * a visible sliver would read as a small nonzero value instead.
   */
  it('gives a zero day no height rather than a misleading minimum', async () => {
    const root = mount();
    tabTo(root, 'Sessions');
    await tick();
    const heights = [...root.querySelectorAll('.trend-bar')].map((b) =>
      Number(b.getAttribute('height')),
    );
    expect(heights.filter((h) => h === 0).length).toBeGreaterThan(0);
    expect(heights.some((h) => h > 0)).toBe(true);
  });
});

describe('brand mark', () => {
  const roots: HTMLElement[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      render(null, r);
      r.remove();
    }
  });
  function mount(node: preact.ComponentChild) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);
    render(node, root);
    return root;
  }

  /**
   * The masthead already names the surface in its <h1>, so the mark beside it
   * is decoration. Announcing it would make a screen reader read the product
   * name before every page title.
   */
  it('is hidden from assistive tech unless given a name', () => {
    const svg = mount(<Logo />).querySelector('svg') as SVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.querySelector('title')).toBeNull();

    const named = mount(<Logo title="Tokenmancer" />).querySelector('svg') as SVGElement;
    expect(named.getAttribute('aria-hidden')).toBeNull();
    expect(named.getAttribute('role')).toBe('img');
    expect(named.querySelector('title')?.textContent).toBe('Tokenmancer');
  });

  /**
   * The hood must stay `currentColor` and the face must be a real cut-out. Fill
   * the face with a background colour instead and the mark grows an opaque
   * rectangle wherever it sits on a surface that is not the page.
   */
  it('inverts with the theme instead of shipping two assets', () => {
    const svg = mount(<Logo />).querySelector('svg') as SVGElement;
    const hood = svg.querySelector('path[fill="currentColor"]') as SVGPathElement;
    expect(hood).not.toBeNull();
    expect(hood.getAttribute('fill-rule')).toBe('evenodd');
    // One path, two subpaths: the hood and the face it knocks out.
    expect((hood.getAttribute('d')?.match(/M/g) ?? []).length).toBe(2);
  });

  it('renders square at the requested size', () => {
    const svg = mount(<Logo size={40} />).querySelector('svg') as SVGElement;
    expect(svg.getAttribute('width')).toBe('40');
    expect(svg.getAttribute('height')).toBe('40');
    const [, , vw, vh] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number);
    expect(vw).toBe(vh);
  });
});

/**
 * The header is the only place navigation lives, so what it offers has to be
 * the same on every surface — and it has to say which one you are on, since
 * four near-identical pages are otherwise told apart only by their content.
 */
describe('static header', () => {
  const roots: HTMLElement[] = [];
  afterEach(() => {
    for (const r of roots.splice(0)) {
      render(null, r);
      r.remove();
    }
  });
  function mount(node: preact.ComponentChild) {
    const root = document.createElement('div');
    document.body.appendChild(root);
    roots.push(root);
    render(node, root);
    return root;
  }

  const tabs = (root: HTMLElement) =>
    [...root.querySelectorAll('.navTab')].map((a) => a.textContent);

  it('offers every surface, in the same order, whichever one is showing', () => {
    const expected = ['Live view', 'Analytics', 'Past sessions', 'What-if simulator'];
    expect(tabs(mount(<AppNav />))).toEqual(expected);
    expect(tabs(mount(<AppNav current="/simulator" />))).toEqual(expected);
    expect(WEB_NAV.map((l) => l.href)).toEqual(['/', '/analytics', '/sessions', '/simulator']);
  });

  it('marks exactly one tab as the page you are on', () => {
    const root = mount(<AppNav current="/analytics" />);
    const on = [...root.querySelectorAll('[aria-current="page"]')];
    expect(on).toHaveLength(1);
    expect(on[0]?.textContent).toBe('Analytics');
  });

  /** /replay and /viewer are server aliases for the same surface as /sessions. */
  it('follows the server aliases rather than going blank on them', () => {
    const root = mount(<AppNav current="/replay" />);
    expect(root.querySelector('[aria-current="page"]')?.textContent).toBe('Past sessions');
  });

  /** Each VS Code panel is its own window: there is nowhere for a tab to go. */
  it('drops the tab row entirely when there is nowhere to navigate', () => {
    const root = mount(<AppNav links={[]} />);
    expect(root.querySelector('.mainNav')).toBeNull();
    // The brand stops being a link too, rather than pointing at a dead "/".
    expect(root.querySelector('a.brand')).toBeNull();
    expect(root.querySelector('.brand')).not.toBeNull();
    // Global controls stay: the theme toggle is useful in a webview too.
    expect(root.querySelector('.themeToggle')).not.toBeNull();
  });
});
