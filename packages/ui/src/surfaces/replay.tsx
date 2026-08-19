import { render } from 'preact';
import '../theme.css';
import { App } from '../components/App.js';
import { SessionBrowser } from '../components/SessionBrowser.js';
import { SseTransport } from '../transport.js';

// Replay reuses the same meter renderer; the SessionBrowser drives loading (no
// live SSE subscription). The per-run token guards the API calls it makes.
const transport = new SseTransport({ token: window.__CTE__?.token });

const root = document.getElementById('app');
if (root)
  render(
    <App
      transport={transport}
      title="Copilot Session Replay"
      subtitle="Browse past agent sessions on this machine and replay any of them, step by step."
      subscribe={false}
      showConnection={false}
      sourceBar={<SessionBrowser transport={transport} />}
      navCurrent="/sessions"
      emptyText="Pick a workspace and a session above, then Replay to re-open a recorded run here."
    />,
    root,
  );
