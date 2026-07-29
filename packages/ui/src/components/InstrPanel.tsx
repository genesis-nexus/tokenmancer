import { rateFor } from '@cte/core';
import { fmtCr, fmtTok } from '../format.js';
import { dominantModel, instructions, totals } from '../state/store.js';

function Chips({ items, tokens }: { items: string[]; tokens: Record<string, number> }) {
  if (!items.length) return <span class="inone">none</span>;
  return (
    <>
      {items.map((x) => (
        <span class="ichip" key={x}>
          {x}
          {tokens[x] != null ? <i>{fmtTok(tokens[x] as number)}</i> : null}
        </span>
      ))}
    </>
  );
}

export function InstrPanel() {
  const s = instructions.value;
  if (!s) return null;
  const t = totals.value;
  const active = s.resolvedCount > 0 || s.contextIncluded.length > 0 || s.loaded.length > 0;
  const fileTok: Record<string, number> = {};
  for (const f of s.files) fileTok[f.name] = f.tokens;

  // impact: first call pays full input rate, later calls read it cheaply from cache
  const r = rateFor(dominantModel.value);
  const billed = Math.max(t.calls, 1);
  const impactAic =
    (s.totalTokens / 1e6) * r.in + (s.totalTokens / 1e6) * r.cached * Math.max(0, billed - 1);

  return (
    <details class="instr" open={false}>
      <summary>
        <span class="chev">▶</span>
        {active ? (
          <>
            <b>Custom instructions</b> — ≈ {s.totalTokens ? `${fmtTok(s.totalTokens)} tok` : '?'}{' '}
            riding on every call{' '}
            <span class="isum">
              {s.totalTokens ? (
                <>
                  · ≈ <b>{fmtCr(impactAic)} cr</b> across {billed} call{billed > 1 ? 's' : ''} this
                  session (est)
                </>
              ) : (
                '· files not found on disk to measure'
              )}
            </span>
          </>
        ) : (
          <>
            <b>Custom instructions</b> <span class="isum">— none resolved</span>
          </>
        )}
      </summary>
      <div class="ibody">
        <div>
          <div class="ilbl">Always in context — every turn</div>
          <div class="ichips">
            <Chips items={s.contextIncluded} tokens={fileTok} />
          </div>
        </div>
        <div>
          <div class="ilbl">Loaded — applyTo-scoped</div>
          <div class="ichips">
            <Chips items={s.loaded} tokens={fileTok} />
          </div>
        </div>
        <div>
          <div class="ilbl">On-demand catalog</div>
          <div class="ichips">
            <span class="ichip">
              {s.onDemand.instructions.length}
              <i>instr</i>
            </span>
            <span class="ichip">
              {s.onDemand.skills.length}
              <i>skills</i>
            </span>
            <span class="ichip">
              {s.onDemand.agents.length}
              <i>agents</i>
            </span>
          </div>
        </div>
      </div>
      {s.folders.length ? (
        <div class="ifoot">
          <details class="idet">
            <summary>
              {s.folders.length} instruction folder(s) searched
              {s.discoveryMs != null ? ` · resolved ${s.resolvedCount} in ${s.discoveryMs}ms` : ''}
            </summary>
            <div class="idetbody">
              {s.folders.map((f) => (
                <div key={f}>{f}</div>
              ))}
            </div>
          </details>
        </div>
      ) : null}
    </details>
  );
}
