import { CREDIT_USD, POOL } from '@cte/core';
import { fmtCr, fmtTok, shortModel } from '../format.js';
import { config } from '../state/budget-store.js';
import { skillMode } from '../state/skill-store.js';
import { totals } from '../state/store.js';
import { BudgetBar } from './BudgetBar.js';

export function Readout({ onNewSession }: { onNewSession: () => void }) {
  const t = totals.value;
  // The pool is configurable now; the constants are only the fallback for
  // transports that expose no config at all (replay, fixtures).
  const cfg = config.value;
  const pool = cfg?.pricing.poolCredits ?? POOL;
  const creditUsd = cfg?.pricing.creditUsd ?? CREDIT_USD;
  const poolPct = pool > 0 ? Math.min(100, (t.aic / pool) * 100) : 0;
  const usd = t.aic * creditUsd;
  const novice = skillMode.value === 'novice';

  if (novice) {
    // Money first, in the unit people actually think in. Credits stay visible
    // as the secondary figure, because that is the vocabulary the rest of the
    // tool — and the budget — is denominated in.
    return (
      <div class="readout readout-simple">
        <div class="rrow">
          <div class="stat hero">
            <div class="lbl">This session</div>
            <div class="val">
              <small>$</small>
              {usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}
            </div>
            <div class="sub">{fmtCr(t.aic)} credits</div>
          </div>
          <div class="stat">
            <div class="lbl">Things you asked for</div>
            <div class="val">{t.loops}</div>
            <div class="sub">{t.loops === 1 ? 'one prompt' : `${t.loops} prompts`} so far</div>
          </div>
          <div class="stat">
            <div class="lbl">Work the agent did</div>
            <div class="val">{t.steps}</div>
            <div class="sub">steps across those prompts</div>
          </div>
          <BudgetBar />
          <button type="button" class="btn" id="newSession" onClick={onNewSession}>
            ⟲ New session
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="readout">
      <div class="rrow">
        <div class="stat hero">
          <div class="lbl">Session cost</div>
          <div class="val">
            {fmtCr(t.aic)}
            <small>cr</small>
          </div>
          <div class="sub">
            ${usd.toFixed(4)} · {t.calls} calls · {poolPct.toFixed(poolPct < 1 ? 2 : 1)}% of{' '}
            {pool.toLocaleString()}-cr pool
          </div>
        </div>
        <div class="stat">
          <div class="lbl">Tokens</div>
          <div class="val">{fmtTok(t.tok)}</div>
          <div class="sub">
            in {fmtTok(t.inTok)} · out {fmtTok(t.outTok)}
          </div>
        </div>
        <div class="stat">
          <div class="lbl">Loops</div>
          <div class="val">{t.loops}</div>
          <div class="sub">
            {t.steps} steps · {t.calls} billed
          </div>
        </div>
        <div class="stat">
          <div class="lbl">Model spend</div>
          <div class="mrows">
            {t.models.length ? (
              t.models.map((m) => (
                <span class="mrow" key={m.model} title={`${m.model} · ${m.calls} calls`}>
                  {shortModel(m.model)}
                  <em>{fmtCr(m.aic)} cr</em>
                </span>
              ))
            ) : (
              <span class="sub">—</span>
            )}
          </div>
        </div>
        <BudgetBar />
        <button type="button" class="btn" id="newSession" onClick={onNewSession}>
          ⟲ New session
        </button>
      </div>
    </div>
  );
}
