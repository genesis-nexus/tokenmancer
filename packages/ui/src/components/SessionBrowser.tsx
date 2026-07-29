import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { connection, dispatch, resetSession } from '../state/store.js';
import type { MeterTransport, SessionSummary, WorkspaceSummary } from '../transport.js';

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
        if (!l.length)
          setMsg('No VS Code workspaces with Copilot debug logs were found on this machine.');
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

  async function replay() {
    const s = sessions.find((x) => x.id === session);
    if (!ws || !s) return;
    const log = s.logFiles[0] ?? 'main.jsonl';
    setBusy(true);
    setMsg('Loading session…');
    resetSession();
    try {
      const events = await transport.loadSession(ws, session, log);
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
    if (!ws) return;
    try {
      await transport.tailWorkspace(ws);
      location.href = '/';
    } catch (e) {
      setMsg(`Failed to start live tail: ${(e as Error).message}`);
    }
  }

  return (
    <div class="wsbar">
      <label for="wsSelect">Workspace</label>
      <select
        id="wsSelect"
        value={ws}
        onChange={(e) => onWorkspace((e.target as HTMLSelectElement).value)}
      >
        <option value="">
          {workspaces.length ? 'Select a workspace…' : 'No workspaces found'}
        </option>
        {workspaces.map((w) => {
          const chan = w.channel && w.channel !== 'Code' ? ` · ${w.channel}` : '';
          return (
            <option value={w.id} key={w.id}>
              {w.folderName} — {w.sessionCount} session{w.sessionCount > 1 ? 's' : ''}
              {chan}
            </option>
          );
        })}
      </select>
      <label for="sessionSelect">Session</label>
      <select
        id="sessionSelect"
        value={session}
        disabled={!sessions.length}
        onChange={(e) => setSession((e.target as HTMLSelectElement).value)}
      >
        <option value="">{sessions.length ? 'Select a session…' : '—'}</option>
        {sessions.map((s) => (
          <option value={s.id} key={s.id}>
            {s.dateStr} · {s.timeRange} · {s.events} events
          </option>
        ))}
      </select>
      <button type="button" class="btn primary" disabled={!session || busy} onClick={replay}>
        ▶ Replay
      </button>
      <button
        type="button"
        class="btn"
        disabled={!ws}
        onClick={tailLive}
        title="Switch to the live meter tailing this workspace"
      >
        Tail live →
      </button>
      <div class="wsmsg">{msg}</div>
    </div>
  );
}
