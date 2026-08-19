import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  filterWorkspaces,
  matchesProvider,
  providerFilter,
  workspaceLabel,
} from '../state/provider-store.js';
import { resetSession } from '../state/store.js';
import type { MeterTransport, WorkspaceSummary } from '../transport.js';
import { ProviderFilter } from './ProviderFilter.js';

export function WorkspaceBar({ transport }: { transport: MeterTransport }) {
  const [list, setList] = useState<WorkspaceSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<ComponentChildren>(
    'Pick any project on this machine (newest first) to point the meter at its live agent log.',
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const l = await transport.listWorkspaces();
        if (!alive) return;
        setList(l);
        if (!l.length)
          setMsg(
            'No agent logs were found. For Copilot, enable agent debug logging in VS Code; Claude Code needs no setup. Or use --inbox.',
          );
      } catch (e) {
        if (alive) setMsg(`Failed to load workspaces: ${(e as Error).message}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  const filter = providerFilter.value;
  const shown = filterWorkspaces(list, filter);

  // A selection the filter just hid would keep ▶ Tail live enabled while the
  // select showed a blank — drop it rather than act on something invisible.
  const chosen = list.find((w) => w.id === selected);
  const effective = chosen && matchesProvider(chosen, filter) ? selected : '';

  async function tail() {
    if (!effective) return;
    const w = list.find((x) => x.id === effective);
    setMsg('Switching live tail…');
    resetSession();
    try {
      const j = await transport.tailWorkspace(effective);
      setMsg(
        <>
          Now tailing <b>{j.workspace || w?.folderName}</b> · {j.log || 'main.jsonl'} — send an
          agent request to see it here.
        </>,
      );
    } catch (e) {
      setMsg(`Failed to start live tail: ${(e as Error).message}`);
    }
  }

  return (
    <div class="wsbar">
      <ProviderFilter workspaces={list} />
      <label for="wsSelect">Workspace</label>
      <select
        id="wsSelect"
        value={effective}
        onChange={(e) => setSelected((e.target as HTMLSelectElement).value)}
      >
        <option value="">
          {loading
            ? 'Loading workspaces…'
            : shown.length
              ? 'Select a workspace…'
              : list.length
                ? 'No workspaces for this agent'
                : 'No agent logs found'}
        </option>
        {shown.map((w) => (
          <option value={w.id} key={w.id}>
            {workspaceLabel(w, { modified: true })}
          </option>
        ))}
      </select>
      <button type="button" class="btn primary" disabled={!effective} onClick={tail}>
        ▶ Tail live
      </button>
      <div class="wsmsg">{msg}</div>
    </div>
  );
}
