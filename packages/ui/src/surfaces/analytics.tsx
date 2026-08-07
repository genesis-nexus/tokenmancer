import { render } from 'preact';
import '../theme.css';
import './analytics.css';
import { SseTransport } from '../transport.js';
import { AnalyticsView } from './AnalyticsView.js';

// Analytics surface for the web app version
const transport = new SseTransport({ token: window.__CTE__?.token });

const root = document.getElementById('app');
if (root) render(<AnalyticsView transport={transport} />, root);
