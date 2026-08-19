import type { BudgetRule, PartialConfig } from '@cte/core';
import { useEffect, useRef, useState } from 'preact/hooks';
import {
  config as configSignal,
  setConfig,
  setSpend,
  settingsOpen,
  summarizeSpend,
} from '../state/budget-store.js';
import type { MeterTransport } from '../transport.js';

/** Rule id for the optional user cap, distinct from the shipped pool rule. */
const MONTH_RULE_ID = 'month-limit';
/** Rule id of the shipped per-loop warning, edited rather than duplicated. */
const LOOP_RULE_ID = 'loop-runaway';

interface SettingsPanelProps {
  transport: MeterTransport;
  open: boolean;
  onClose: () => void;
}

/** A number field's text, kept as typed so the box can be emptied mid-edit. */
type Draft = Record<'pool' | 'monthCap' | 'loopCap', string>;

function draftFrom(rules: readonly BudgetRule[], poolCredits: number): Draft {
  const month = rules.find((r) => r.id === MONTH_RULE_ID && r.enabled);
  const loop = rules.find((r) => r.id === LOOP_RULE_ID && r.enabled);
  return {
    pool: String(poolCredits),
    monthCap: month && month.limit > 0 ? String(month.limit) : '',
    loopCap: loop && loop.limit > 0 ? String(loop.limit) : '',
  };
}

/**
 * Fold the form back into the rule list. Rules the panel does not own are
 * carried through untouched — the file is hand-editable and may hold rules with
 * no field here, and dropping those on save would be a silent data loss.
 *
 * A cleared field disables its rule rather than deleting it, so the thresholds
 * someone tuned by hand survive being switched off and on again.
 */
function rulesFrom(existing: readonly BudgetRule[], d: Draft): BudgetRule[] {
  const monthCap = Number(d.monthCap);
  const loopCap = Number(d.loopCap);
  const out = existing.map((r) => {
    if (r.id === MONTH_RULE_ID) {
      return monthCap > 0 ? { ...r, enabled: true, limit: monthCap } : { ...r, enabled: false };
    }
    if (r.id === LOOP_RULE_ID) {
      return loopCap > 0 ? { ...r, enabled: true, limit: loopCap } : { ...r, enabled: false };
    }
    return r;
  });

  if (monthCap > 0 && !out.some((r) => r.id === MONTH_RULE_ID)) {
    out.push({
      id: MONTH_RULE_ID,
      enabled: true,
      period: 'month',
      metric: 'credits',
      limit: monthCap,
      thresholds: [0.5, 0.8, 1],
      severity: 'warn',
      scope: 'global',
    });
  }
  if (loopCap > 0 && !out.some((r) => r.id === LOOP_RULE_ID)) {
    out.push({
      id: LOOP_RULE_ID,
      enabled: true,
      period: 'loop',
      metric: 'credits',
      limit: loopCap,
      thresholds: [1],
      severity: 'info',
      scope: 'global',
    });
  }
  return out;
}

/**
 * The settings dialog. Deliberately four fields: the numbers that change what
 * the meter *tells you*, not every key the config file accepts. The file stays
 * the place for the long tail, and its path is shown here so the panel points
 * at it rather than pretending to be the whole surface.
 */
export function SettingsPanel({ transport, open, onClose }: SettingsPanelProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const cfg = configSignal.value;

  const [draft, setDraft] = useState<Draft>({ pool: '', monthCap: '', loopCap: '' });
  const [alertsOn, setAlertsOn] = useState(true);
  const [status, setStatus] = useState<{ kind: 'ok' | 'warn' | 'err'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  /**
   * Seed from config once per opening, so the panel never shows a stale draft
   * over a value the file or another surface has changed.
   *
   * Once per opening, not once per config change: a successful save publishes
   * the new config, and re-running this on that would clear the draft and the
   * "Saved to…" line the save just set — the write would land while the UI
   * reported nothing at all. `cfg` stays a dependency only so the first
   * opening can still seed if it beat the initial config fetch.
   */
  const seeded = useRef(false);
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    if (seeded.current || !cfg) return;
    seeded.current = true;
    setDraft(draftFrom(cfg.budgets.rules, cfg.pricing.poolCredits));
    setAlertsOn(cfg.alerts.enabled);
    setStatus(null);
  }, [open, cfg]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Feature-detected: `showModal` is what gives focus trapping and Escape,
    // but it is absent in jsdom and in any renderer without full <dialog>
    // support. The `open` attribute still shows the panel there, just inline.
    if (open && !el.open) {
      if (typeof el.showModal === 'function') el.showModal();
      else el.setAttribute('open', '');
    }
    if (!open && el.open) {
      if (typeof el.close === 'function') el.close();
      else el.removeAttribute('open');
    }
  }, [open]);

  if (!cfg) return null;

  const usd = (cr: number): string => `$${(cr * cfg.pricing.creditUsd).toFixed(2)}`;
  const poolNum = Number(draft.pool);
  const monthNum = Number(draft.monthCap);
  const capOverAllowance = monthNum > 0 && poolNum > 0 && monthNum > poolNum;

  const set = (k: keyof Draft) => (e: Event) =>
    setDraft((d) => ({ ...d, [k]: (e.target as HTMLInputElement).value }));

  async function save() {
    if (!transport.updateSettings || !cfg) return;
    setSaving(true);
    setStatus(null);

    const patch: PartialConfig = {
      pricing: poolNum > 0 ? { poolCredits: poolNum } : {},
      alerts: { enabled: alertsOn },
      budgets: { rules: rulesFrom(cfg.budgets.rules, draft) },
    };

    try {
      const r = await transport.updateSettings(patch);
      if (!r.ok) {
        setStatus({ kind: 'err', text: r.problems?.join(' · ') ?? 'Could not save' });
        return;
      }
      // Trust the returned config over the submitted patch: a project file or a
      // TOKENMANCER_* var outranks what we just wrote, and the panel should
      // report what governs rather than what was asked for. Saying "Saved"
      // over a value that is not in force would be the worst of both.
      if (r.config) setConfig(r.config);

      // Re-read spend against the new rules straight away. The gauge is
      // otherwise on a 30-second poll, so setting a budget would appear to do
      // nothing for up to half a minute — the moment the reader is looking
      // hardest for confirmation that it took.
      if (transport.getSpend) {
        try {
          const s = await transport.getSpend();
          setSpend(summarizeSpend(s.snapshot, s.rules));
        } catch {
          // The poll will catch up; the save itself already succeeded.
        }
      }

      const governing = r.config?.pricing.poolCredits;
      if (poolNum > 0 && governing != null && governing !== poolNum) {
        setStatus({
          kind: 'warn',
          text: `Written to the config file, but a higher-precedence layer still sets the allowance to ${governing} credits.`,
        });
        return;
      }
      setStatus({ kind: 'ok', text: r.savedTo ? `Saved to ${r.savedTo}` : 'Saved' });
    } catch {
      setStatus({ kind: 'err', text: 'Could not reach the meter to save' });
    } finally {
      setSaving(false);
    }
  }

  return (
    // No backdrop-click-to-close: this is a form, and a stray click outside it
    // discarding half-typed edits is a worse outcome than one extra keystroke.
    // Escape (native to <dialog>) and the two Close buttons are the ways out.
    <dialog class="settingsDlg" ref={ref} onClose={onClose}>
      {/* Saving is driven by the button's click, not by form submission: the
          server serves this page under `form-action 'none'`, so Chrome drops a
          submit silently — no event, no violation. Enter is wired by hand
          below because that same block takes implicit submission with it. */}
      <div
        class="settingsForm"
        onKeyDown={(e) => {
          if (e.key !== 'Enter') return;
          e.preventDefault();
          void save();
        }}
      >
        <header class="settingsHead">
          <h2>Settings</h2>
          <button type="button" class="settingsX" aria-label="Close settings" onClick={onClose}>
            ✕
          </button>
        </header>

        <div class="settingsBody">
          <label class="setRow">
            <span class="setLbl">Monthly allowance</span>
            <span class="setHint">What your Copilot seat gives you each month.</span>
            <span class="setInput">
              <input
                type="number"
                min="0"
                step="100"
                value={draft.pool}
                onInput={set('pool')}
                aria-describedby="poolEq"
              />
              <span class="setUnit">credits</span>
              <span class="setEq" id="poolEq">
                {poolNum > 0 ? usd(poolNum) : '—'}
              </span>
            </span>
          </label>

          <label class="setRow">
            <span class="setLbl">Budget cap</span>
            <span class="setHint">
              Warn me before I use the whole allowance. Leave empty to track the allowance itself.
            </span>
            <span class="setInput">
              <input
                type="number"
                min="0"
                step="50"
                placeholder="no cap"
                value={draft.monthCap}
                onInput={set('monthCap')}
                aria-describedby="capEq"
              />
              <span class="setUnit">credits</span>
              <span class="setEq" id="capEq">
                {monthNum > 0 ? usd(monthNum) : '—'}
              </span>
            </span>
            {capOverAllowance ? (
              <span class="setWarn">
                Higher than the allowance, so the allowance is what you will hit first.
              </span>
            ) : null}
          </label>

          <label class="setRow">
            <span class="setLbl">Expensive-prompt warning</span>
            <span class="setHint">Flag any single prompt that costs more than this.</span>
            <span class="setInput">
              <input
                type="number"
                min="0"
                step="1"
                placeholder="off"
                value={draft.loopCap}
                onInput={set('loopCap')}
                aria-describedby="loopEq"
              />
              <span class="setUnit">credits</span>
              <span class="setEq" id="loopEq">
                {Number(draft.loopCap) > 0 ? usd(Number(draft.loopCap)) : '—'}
              </span>
            </span>
          </label>

          <label class="setRow setRow-check">
            <input
              type="checkbox"
              checked={alertsOn}
              onChange={(e) => setAlertsOn((e.target as HTMLInputElement).checked)}
            />
            <span>
              <span class="setLbl">Show alerts</span>
              <span class="setHint">
                Off silences every banner and notification, including the ones above.
              </span>
            </span>
          </label>
        </div>

        <footer class="settingsFoot">
          {status ? (
            <output class={`setStatus setStatus-${status.kind}`}>{status.text}</output>
          ) : (
            <span class="setStatus setStatus-idle">Saved for every Tokenmancer surface.</span>
          )}
          <span class="settingsBtns">
            <button type="button" class="btn" onClick={onClose}>
              Close
            </button>
            <button
              type="button"
              class="btn primary settingsSave"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </span>
        </footer>
      </div>
    </dialog>
  );
}

/** Masthead entry point. Renders nothing where settings cannot be persisted. */
export function SettingsButton({ transport }: { transport: MeterTransport }) {
  if (!transport.updateSettings) return null;
  return (
    <>
      <button
        type="button"
        class="iconBtn settingsBtn"
        title="Settings — budgets and alerts"
        aria-label="Settings"
        onClick={() => {
          settingsOpen.value = true;
        }}
      >
        ⚙
      </button>
      <SettingsPanel
        transport={transport}
        open={settingsOpen.value}
        onClose={() => {
          settingsOpen.value = false;
        }}
      />
    </>
  );
}
