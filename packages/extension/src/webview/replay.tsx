import '@cte/ui/theme.css';
import { App, PostMessageTransport, SessionBrowser } from '@cte/ui';
import { render } from 'preact';

const transport = new PostMessageTransport();
const root = document.getElementById('app');
if (root)
  render(
    <App
      transport={transport}
      title="Session Replay"
      subtitle="Browse past agent sessions on this machine and replay any of them, step by step."
      subscribe={false}
      showConnection={false}
      sourceBar={<SessionBrowser transport={transport} />}
      navLinks={[]}
      emptyText="Pick a workspace and a session above, then Replay to re-open a recorded run here."
    />,
    root,
  );
