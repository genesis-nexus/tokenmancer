import {
  AUTO_DISCOUNT,
  CREDIT_USD,
  MODELS,
  type ModelId,
  POOL,
  aicFromUsage,
  countTokens,
} from '@cte/core';
import { useMemo, useState } from 'preact/hooks';
import { fmtCr, fmtTok } from '../format.js';
import { SEG, SEG_COLOR, type TooltipData } from '../pricing-ui.js';
import { TooltipLayer, ttAttr } from './TooltipLayer.js';

type Scenario = 'none' | 'first' | 'cached';

const SAMPLE = `In this file, what does formatPrice do and where is it used across the repo?
Attach the three call sites and summarize the blast radius of changing its signature.`;

export function Simulator({
  navHref = '/',
  navText = '← Live meter',
}: { navHref?: string; navText?: string } = {}) {
  const [model, setModel] = useState<ModelId>('claude-sonnet-4.6');
  const [text, setText] = useState(SAMPLE);
  const [attached, setAttached] = useState(8000);
  const [output, setOutput] = useState(400);
  const [cacheablePct, setCacheablePct] = useState(80);
  const [scenario, setScenario] = useState<Scenario>('cached');
  const [auto, setAuto] = useState(false);

  const promptTokens = useMemo(() => countTokens(text), [text]);
  const input = promptTokens + Math.max(0, attached);
  const cacheable = Math.round((input * cacheablePct) / 100);
  const cacheRead = scenario === 'cached' ? cacheable : 0;
  const cacheWrite = scenario === 'first' ? cacheable : 0;

  const { counts, aic: rawAic } = aicFromUsage(
    { prompt: input, completion: output, cacheRead, cacheWrite },
    { model },
  );
  const aic = auto ? rawAic * AUTO_DISCOUNT : rawAic;

  const r = MODELS[model];
  const parts = {
    read: (cacheRead * r.cached) / 1e6,
    write: (cacheWrite * r.cw) / 1e6,
    fresh: (counts.input * r.in) / 1e6,
    out: (output * r.out) / 1e6,
  };
  const total = parts.read + parts.write + parts.fresh + parts.out;
  const segTokens = [cacheRead, cacheWrite, counts.input, output];
  const tt: TooltipData = {
    t: `call cost · ${fmtCr(total)} cr`,
    rows: SEG.map(([k, label], i) => [
      SEG_COLOR[k],
      label,
      `${fmtTok(segTokens[i] ?? 0)} tok · ${fmtCr(parts[k])} cr`,
    ]),
    n: `output = ${total > 0 ? Math.round((parts.out / total) * 100) : 0}% of this call`,
  };
  const poolPct = Math.min(100, (aic / POOL) * 100);

  return (
    <div class="wrap">
      <header class="mast">
        <div>
          <h1>What-if Simulator</h1>
          <p class="sub">
            Real o200k token counts, the same pricing model as the meter — model a call before you
            spend it.
          </p>
        </div>
        {navHref ? (
          <a class="navlink" href={navHref}>
            {navText}
          </a>
        ) : null}
      </header>

      <div class="loop">
        <div class="loopHead">
          <div class="simControls">
            <label class="simField">
              <span class="ilbl">Model</span>
              <select
                value={model}
                onChange={(e) => setModel((e.target as HTMLSelectElement).value as ModelId)}
              >
                {Object.keys(MODELS).map((id) => (
                  <option value={id} key={id}>
                    {id}
                  </option>
                ))}
              </select>
            </label>
            <label class="simField">
              <span class="ilbl">Cache scenario</span>
              <select
                value={scenario}
                onChange={(e) => setScenario((e.target as HTMLSelectElement).value as Scenario)}
              >
                <option value="none">No cache (all fresh)</option>
                <option value="first">First call — cache-write</option>
                <option value="cached">Follow-up — cache-read</option>
              </select>
            </label>
          </div>

          <div class="simField" style="margin-top:10px">
            <span class="ilbl">
              Prompt / context text — tokenized live ({fmtTok(promptTokens)} tok)
            </span>
            <textarea
              class="simText"
              value={text}
              onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
              rows={4}
            />
          </div>

          <div class="simControls" style="margin-top:10px">
            <label class="simField">
              <span class="ilbl">Attached files (tok)</span>
              <input
                type="number"
                min={0}
                value={attached}
                onInput={(e) => setAttached(+(e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="simField">
              <span class="ilbl">Output (tok)</span>
              <input
                type="number"
                min={0}
                value={output}
                onInput={(e) => setOutput(+(e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="simField">
              <span class="ilbl">Cacheable {cacheablePct}%</span>
              <input
                type="range"
                min={0}
                max={100}
                value={cacheablePct}
                onInput={(e) => setCacheablePct(+(e.target as HTMLInputElement).value)}
              />
            </label>
            <label class="simField simToggle">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => setAuto((e.target as HTMLInputElement).checked)}
              />
              <span>Auto routing (−10%)</span>
            </label>
          </div>
        </div>

        <div class="steps">
          <div class="rrow" style="gap:24px">
            <div class="stat hero">
              <div class="lbl">Call cost</div>
              <div class="val">
                {fmtCr(aic)}
                <small>cr</small>
              </div>
              <div class="sub">
                ${(aic * CREDIT_USD).toFixed(4)} · {poolPct.toFixed(poolPct < 1 ? 2 : 1)}% of{' '}
                {POOL.toLocaleString()}-cr pool
              </div>
            </div>
            <div class="stat">
              <div class="lbl">Input</div>
              <div class="val">{fmtTok(input)}</div>
              <div class="sub">
                fresh {fmtTok(counts.input)} · read {fmtTok(cacheRead)} · write {fmtTok(cacheWrite)}
              </div>
            </div>
            <div class="stat" style="flex:1;min-width:200px">
              <div class="lbl">Cost split</div>
              {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so the split is reachable by keyboard */}
              <div class="barHit" data-tt={ttAttr(tt)} tabIndex={0}>
                <div class="bar">
                  {SEG.map(([k, , color]) =>
                    parts[k] > 0 ? (
                      <i key={k} style={`width:${(parts[k] / total) * 100}%;background:${color}`} />
                    ) : null,
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="feedHead">
        <span class="feedLbl">Same call, every model</span>
      </div>
      <div class="loop">
        <div class="loopHead tblWrap">
          <table class="stepTable">
            <tr>
              <th>model</th>
              <th>tier</th>
              <th>fresh</th>
              <th>cache-R</th>
              <th>cache-W</th>
              <th>out</th>
              <th>cr</th>
            </tr>
            {Object.keys(MODELS).map((id) => {
              const res = aicFromUsage(
                { prompt: input, completion: output, cacheRead, cacheWrite },
                { model: id },
              );
              const cr = auto ? res.aic * AUTO_DISCOUNT : res.aic;
              return (
                <tr key={id}>
                  <td>{id}</td>
                  <td>{MODELS[id as ModelId].tier}</td>
                  <td>{res.counts.input.toLocaleString()}</td>
                  <td>{cacheRead.toLocaleString()}</td>
                  <td>{cacheWrite.toLocaleString()}</td>
                  <td>{output.toLocaleString()}</td>
                  <td>{fmtCr(cr)}</td>
                </tr>
              );
            })}
          </table>
        </div>
      </div>

      <div class="foot">
        Token counts are exact o200k (bundled — no network); cross-model counts are a faithful
        proxy. The Auto discount is a simulator lever only — real billed calls are never discounted
        here.
      </div>
      <TooltipLayer />
    </div>
  );
}
