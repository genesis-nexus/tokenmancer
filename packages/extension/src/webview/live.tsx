import '@cte/ui/theme.css';
import { App, PostMessageTransport } from '@cte/ui';
import { render } from 'preact';

const transport = new PostMessageTransport();
const root = document.getElementById('app');
if (root) render(<App transport={transport} navHref="" navText="" />, root);
