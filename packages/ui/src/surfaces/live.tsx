import { render } from 'preact';
import '../theme.css';
import { App } from '../components/App.js';
import { SseTransport } from '../transport.js';

const token = window.__CTE__?.token;
const transport = new SseTransport({ token });
const root = document.getElementById('app');
if (root) render(<App transport={transport} />, root);
