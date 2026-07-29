import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { resetSession } from '../state/store.js';
import type { MeterTransport, WorkspaceSummary } from '../transport.js';

export function WorkspaceBar({ transport }: { transport: MeterTransport }) {
  const [list, setList] = useState<WorkspaceSummary[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<ComponentChildren>(
    'Pick any VS Code project on this machine (newest first) to point the meter at its live Copilot log.',
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
            'No VS Code workspaces with Copilot debug logs were found. Enable agent debug logging in VS Code, or use --inbox.',
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

  async function tail() {
    if (!selected) return;
    const w = list.find((x) => x.id === selected);
    setMsg('Switching live tail…');
    resetSession();
    try {
      const j = await transport.tailWorkspace(selected);
      setMsg(
        <>
          Now tailing <b>{j.workspace || w?.folderName}</b> · {j.log || 'main.jsonl'} — send an
          Agent request in VS Code to see it here.
        </>,
      );
    } catch (e) {
      setMsg(`Failed to start live tail: ${(e as Error).message}`);
    }
  }

  return (
    <div class="wsbar">
      <label for="wsSelect">Workspace</label>
      <select
        id="wsSelect"
        value={selected}
        onChange={(e) => setSelected((e.target as HTMLSelectElement).value)}
      >
        <option value="">
          {loading
            ? 'Loading workspaces…'
            : list.length
              ? 'Select a workspace…'
              : 'No workspaces with Copilot logs found'}
        </option>
        {list.map((w) => {
          const chan = w.channel && w.channel !== 'Code' ? ` · ${w.channel}` : '';
          return (
            <option value={w.id} key={w.id}>
              {w.folderName} — {w.modifiedStr} · {w.sessionCount} session
              {w.sessionCount > 1 ? 's' : ''}
              {chan}
            </option>
          );
        })}
      </select>
      <button type="button" class="btn primary" disabled={!selected} onClick={tail}>
        ▶ Tail live
      </button>
      <div class="wsmsg">{msg}</div>
    </div>
  );
}
