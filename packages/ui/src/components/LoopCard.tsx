import { useEffect, useRef, useState } from 'preact/hooks';
import { fmtCr, fmtTime, fmtTok, shortModel } from '../format.js';
import { SEG, SEG_COLOR, type TooltipData } from '../pricing-ui.js';
import type { LoopGroup } from '../state/store.js';
import { Step } from './Step.js';
import { StepTable } from './StepTable.js';
import { ttAttr } from './TooltipLayer.js';

interface LoopCardProps {
  group: LoopGroup;
  hasInstr: boolean;
  fresh: boolean;
}

export function LoopCard({ group: g, hasInstr, fresh }: LoopCardProps) {
  const [pop, setPop] = useState(fresh);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!fresh) return;
    const t = setTimeout(() => setPop(false), 400);
    return () => clearTimeout(t);
  }, [fresh]);

  const maxPrompt = Math.max(...g.steps.map((s) => s.prompt || 0), 1);
  const loopCost = g.cParts.read + g.cParts.write + g.cParts.fresh + g.cParts.out;
  const outPct = loopCost > 0 ? Math.round((g.cParts.out / loopCost) * 100) : 0;
  const cachePct = g.prompt > 0 ? Math.round((g.cacheRead / g.prompt) * 100) : 0;
  const billed = g.steps.filter((s) => !s.isTool);
  const allExact = billed.length > 0 && billed.every((s) => s.exact);

  const segTokens = [g.cacheRead, g.cacheWrite, g.fresh, g.completion];
  const loopTT: TooltipData = {
    t: `loop cost · ${fmtCr(g.aic)} cr`,
    rows: SEG.map(([k, label], i) => {
      const tok = segTokens[i] ?? 0;
      return [SEG_COLOR[k], label, `${fmtTok(tok)} tok · ${fmtCr(g.cParts[k])} cr`] as [
        string,
        string,
        string,
      ];
    }),
    n: `output = ${outPct}% of this loop's cost`,
  };

  return (
    <div class={`loop${pop ? ' fresh' : ''}`} ref={ref}>
      <div class="loopHead">
        <div class="loopMeta">
          <span>#{g.index}</span>
          <span>{fmtTime(g.startTs)}</span>
          <span>{g.steps.length} steps</span>
          <span class="cost">
            {allExact ? '' : '≈ '}
            {fmtCr(g.aic)} <small>cr</small>
          </span>
        </div>
        <div class="loopPrompt">
          {g.promptText ? (
            g.redacted ? (
              <span
                class="noPrompt redactedTag"
                title="Prompt text is redacted by default. Pass --show-prompts (web app) or enable Tokenmancer › Show Prompts (VS Code setting) to reveal it."
              >
                🔒 {g.promptText}
              </span>
            ) : (
              g.promptText
            )
          ) : (
            <span class="noPrompt">[No prompt text found in the debug log for this step]</span>
          )}
        </div>
        {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the cost split is reachable by keyboard */}
        <div class="barHit" data-tt={ttAttr(loopTT)} tabIndex={0}>
          <div class="bar">
            {SEG.map(([k, , color]) =>
              g.cParts[k] > 0 ? (
                <i key={k} style={`width:${(g.cParts[k] / loopCost) * 100}%;background:${color}`} />
              ) : null,
            )}
          </div>
        </div>
        <div class="loopStats">
          <span>
            in <b>{fmtTok(g.prompt)}</b> · out <b>{fmtTok(g.completion)}</b>
          </span>
          {cachePct > 0 ? (
            <span>
              cache-hit <b>{cachePct}%</b>
            </span>
          ) : null}
          <span>
            peak context <b>{fmtTok(maxPrompt)}</b>
          </span>
          {g.models.length ? <span>{g.models.map((m) => shortModel(m)).join(' · ')}</span> : null}
        </div>
      </div>
      <div class="steps">
        <div class="step hd">
          <span class="stepNum">#</span>
          <span class="kindCol">step</span>
          <span class="sbarHit" style="padding:0">
            context window →
          </span>
          <span class="tokCol">ctx → out</span>
          <span class="costCol" style="font-weight:500">
            cr
          </span>
        </div>
        {g.steps.map((s, i) => (
          <Step key={s.id} ev={s} stepNo={i + 1} maxPrompt={maxPrompt} hasInstr={hasInstr} />
        ))}
        <StepTable group={g} />
      </div>
    </div>
  );
}
