import '@cte/ui/theme.css';
import { Simulator } from '@cte/ui';
import { render } from 'preact';

const root = document.getElementById('app');
if (root) render(<Simulator navLinks={[]} />, root);
