import { fmtCr } from '../format.js';
import { shortModel } from '../format.js';
import { costParts, stepMeta } from '../pricing-ui.js';
import type { LoopGroup } from '../state/store.js';

export function StepTable({ group }: { group: LoopGroup }) {
  return (
    <details class="stepTbl">
      <summary>▸ step table — every number</summary>
      <div class="tblWrap">
        <table class="stepTable">
          <tr>
            <th>#</th>
            <th>step</th>
            <th>tool</th>
            <th>model</th>
            <th>ctx</th>
            <th>fresh</th>
            <th>cache-R</th>
            <th>cache-W</th>
            <th>out</th>
            <th>cr</th>
          </tr>
          {group.steps.map((s, i) =>
            s.isTool ? (
              <tr key={s.id}>
                <td>{i + 1}</td>
                <td>{stepMeta(s.stepKind).label}</td>
                <td>{s.toolName || ''}</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>—</td>
                <td>free</td>
              </tr>
            ) : (
              <tr key={s.id}>
                <td>{i + 1}</td>
                <td>{stepMeta(s.stepKind).label}</td>
                <td>{s.toolName || ''}</td>
                <td>{shortModel(s.model)}</td>
                <td>{(s.prompt || 0).toLocaleString()}</td>
                <td>{(s.freshInput || 0).toLocaleString()}</td>
                <td>{(s.cacheRead || 0).toLocaleString()}</td>
                <td>{(s.cacheWrite || 0).toLocaleString()}</td>
                <td>{(s.completion || 0).toLocaleString()}</td>
                <td>
                  {s.exact ? '' : '≈ '}
                  {fmtCr(s.aic)}
                </td>
              </tr>
            ),
          )}
        </table>
      </div>
    </details>
  );
}
