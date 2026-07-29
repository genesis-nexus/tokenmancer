import { render } from 'preact';
import '../theme.css';
import { Simulator } from '../components/Simulator.js';

const root = document.getElementById('app');
if (root) render(<Simulator />, root);
