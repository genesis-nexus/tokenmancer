import { CREDIT_USD, POOL } from '@cte/core';
import { fmtCr, fmtTok, shortModel } from '../format.js';
import { totals } from '../state/store.js';

export function Readout({ onNewSession }: { onNewSession: () => void }) {
  const t = totals.value;
  const poolPct = Math.min(100, (t.aic / POOL) * 100);
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
            ${(t.aic * CREDIT_USD).toFixed(4)} · {t.calls} calls ·{' '}
            {poolPct.toFixed(poolPct < 1 ? 2 : 1)}% of {POOL.toLocaleString()}-cr pool
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
        <button type="button" class="btn" id="newSession" onClick={onNewSession}>
          ⟲ New session
        </button>
      </div>
    </div>
  );
}
