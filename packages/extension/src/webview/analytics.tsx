import '@cte/ui/theme.css';
import '@cte/ui/surfaces/analytics.css';
import { AnalyticsView, PostMessageTransport } from '@cte/ui';
import { render } from 'preact';

const transport = new PostMessageTransport();
const root = document.getElementById('app');
if (root) render(<AnalyticsView transport={transport} />, root);
