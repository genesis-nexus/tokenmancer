import type { StepEvent } from '@cte/core';
import { fmtCr, fmtTok } from '../format.js';
import { SEG_COLOR, type TooltipData, costParts, stepMeta } from '../pricing-ui.js';
import { ttAttr } from './TooltipLayer.js';

interface StepProps {
  ev: StepEvent;
  stepNo: number;
  maxPrompt: number;
  hasInstr: boolean;
}

export function Step({ ev, stepNo, maxPrompt, hasInstr }: StepProps) {
  const m = stepMeta(ev.stepKind);

  if (ev.isTool) {
    return (
      <div class="step">
        <span class="stepNum">{stepNo}</span>
        <div class="kindCol">
          <div class="kindTop">
            <span class="ic">{m.icon}</span>
            {m.label}
            {ev.toolName ? (
              <span class="kindSub" style="display:inline">
                {' '}
                · {ev.toolName}
              </span>
            ) : null}
          </div>
        </div>
        <span class="sbarHit" style="padding:0" />
        <span class="tokCol" style="color:var(--muted)">
          —
        </span>
        <span class="costCol free">free</span>
      </div>
    );
  }

  const p = costParts(ev);
  const cost = p.read + p.write + p.fresh + p.out;
  const outPct = cost > 0 ? Math.round((p.out / cost) * 100) : 0;
  const ctxPct = Math.max(2, Math.round(((ev.prompt || 0) / maxPrompt) * 100));
  const ctxTot = ev.cacheRead + ev.cacheWrite + ev.freshInput || 1;
  const tt: TooltipData = {
    t: `step ${stepNo} · context ${fmtTok(ev.prompt)} tok`,
    rows: [
      [SEG_COLOR.read, 'cache-read', `${fmtTok(ev.cacheRead)} tok · ${fmtCr(p.read)} cr`],
      [SEG_COLOR.write, 'cache-write', `${fmtTok(ev.cacheWrite)} tok · ${fmtCr(p.write)} cr`],
      [SEG_COLOR.fresh, 'fresh input', `${fmtTok(ev.freshInput)} tok · ${fmtCr(p.fresh)} cr`],
      [SEG_COLOR.out, 'output', `${fmtTok(ev.completion)} tok · ${fmtCr(p.out)} cr`],
    ],
    n: `output = ${outPct}% of this step's cost`,
  };
  const seg = (v: number, c: string) =>
    v > 0 ? <i style={`width:${(v / ctxTot) * 100}%;background:${c}`} /> : null;
  const toolPrefix = ev.toolName && ev.toolName !== 'plan' ? `${ev.toolName} · ` : '';
  const snip = (ev.promptSnippet || '').trim();
  const showSnip = stepNo === 1 && !!snip && !/^\[No |unavailable|redacted/i.test(snip);

  return (
    <>
      <div class="step">
        <span class="stepNum">{stepNo}</span>
        <div class="kindCol">
          <div class="kindTop">
            <span class="ic">{m.icon}</span>
            {m.label}
            {ev.systemPromptFile && hasInstr ? (
              <span class="flag" title="Custom instructions rode along on this call">
                ⚑
              </span>
            ) : null}
          </div>
          <div class="kindSub">
            {toolPrefix}
            <span class="mdl">{ev.model}</span>
          </div>
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the context split is reachable by keyboard */}
        <div class="sbarHit" data-tt={ttAttr(tt)} tabIndex={0}>
          <div class="sTrack">
            <div class="sbar" style={`width:${ctxPct}%`}>
              {seg(ev.cacheRead, 'var(--read)')}
              {seg(ev.cacheWrite, 'var(--write)')}
              {seg(ev.freshInput, 'var(--fresh)')}
            </div>
          </div>
        </div>
        <span class="tokCol">
          {fmtTok(ev.prompt)} <span class="ar">→</span> {fmtTok(ev.completion)}
        </span>
        <span class="costCol">
          {ev.exact ? null : <span class="es">≈ </span>}
          {fmtCr(ev.aic)}
        </span>
      </div>
      {showSnip ? (
        <details class="snip">
          <summary>▸ system payload</summary>
          <pre>{snip}</pre>
        </details>
      ) : null}
    </>
  );
}
