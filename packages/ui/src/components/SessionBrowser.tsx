import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import {
  filterWorkspaces,
  matchesProvider,
  providerFilter,
  workspaceLabel,
} from '../state/provider-store.js';
import { connection, dispatch, resetSession } from '../state/store.js';
import type { MeterTransport, SessionSummary, WorkspaceSummary } from '../transport.js';
import { ProviderFilter } from './ProviderFilter.js';

/** Workspace → session-by-date → Replay picker for the archive/debugging view. */
export function SessionBrowser({ transport }: { transport: MeterTransport }) {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [ws, setWs] = useState('');
  const [session, setSession] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<ComponentChildren>(
    'Pick a workspace, then a recorded session, to replay it step by step.',
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const l = await transport.listWorkspaces();
        if (!alive) return;
        setWorkspaces(l);
        if (!l.length) setMsg('No Copilot or Claude Code sessions were found on this machine.');
      } catch (e) {
        if (alive) setMsg(`Failed to load workspaces: ${(e as Error).message}`);
      }
    })();
    return () => {
      alive = false;
    };
  }, [transport]);

  async function onWorkspace(id: string) {
    setWs(id);
    setSession('');
    setSessions([]);
    if (!id) return;
    try {
      const s = await transport.listSessions(id);
      setSessions(s);
      setMsg(
        s.length
          ? 'Pick a session by date, then Replay.'
          : 'This workspace has no recorded sessions yet.',
      );
    } catch (e) {
      setMsg(`Failed to load sessions: ${(e as Error).message}`);
    }
  }

  const filter = providerFilter.value;
  const shown = filterWorkspaces(workspaces, filter);

  // Changing the filter out from under a selection would leave the session list
  // showing sessions from a workspace the select no longer displays.
  const chosen = workspaces.find((w) => w.id === ws);
  const effectiveWs = chosen && matchesProvider(chosen, filter) ? ws : '';
  const effectiveSession = effectiveWs ? session : '';

  async function replay() {
    const s = sessions.find((x) => x.id === effectiveSession);
    if (!effectiveWs || !s) return;
    const log = s.logFiles[0] ?? 'main.jsonl';
    setBusy(true);
    setMsg('Loading session…');
    resetSession();
    try {
      const events = await transport.loadSession(effectiveWs, effectiveSession, log);
      for (const ev of events) dispatch(ev);
      connection.value = 'live';
      setMsg(
        <>
          Replaying <b>{s.name}</b> · {events.length} events. Pick another session to switch.
        </>,
      );
    } catch (e) {
      setMsg(`Failed to load session: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function tailLive() {
    if (!effectiveWs) return;
    try {
      await transport.tailWorkspace(effectiveWs);
      location.href = '/';
    } catch (e) {
      setMsg(`Failed to start live tail: ${(e as Error).message}`);
    }
  }

  return (
    <div class="wsbar">
      <ProviderFilter workspaces={workspaces} />
      <label for="wsSelect">Workspace</label>
      <select
        id="wsSelect"
        value={effectiveWs}
        onChange={(e) => onWorkspace((e.target as HTMLSelectElement).value)}
      >
        <option value="">
          {shown.length
            ? 'Select a workspace…'
            : workspaces.length
              ? 'No workspaces for this agent'
              : 'No workspaces found'}
        </option>
        {shown.map((w) => (
          <option value={w.id} key={w.id}>
            {workspaceLabel(w)}
          </option>
        ))}
      </select>
      <label for="sessionSelect">Session</label>
      <select
        id="sessionSelect"
        value={effectiveSession}
        disabled={!effectiveWs || !sessions.length}
        onChange={(e) => setSession((e.target as HTMLSelectElement).value)}
      >
        <option value="">{sessions.length ? 'Select a session…' : '—'}</option>
        {sessions.map((s) => (
          <option value={s.id} key={s.id}>
            {s.dateStr} · {s.timeRange} · {s.events} events
          </option>
        ))}
      </select>
      <button
        type="button"
        class="btn primary"
        disabled={!effectiveSession || busy}
        onClick={replay}
      >
        ▶ Replay
      </button>
      <button
        type="button"
        class="btn"
        disabled={!effectiveWs}
        onClick={tailLive}
        title="Switch to the live meter tailing this workspace"
      >
        Tail live →
      </button>
      <div class="wsmsg">{msg}</div>
    </div>
  );
}
