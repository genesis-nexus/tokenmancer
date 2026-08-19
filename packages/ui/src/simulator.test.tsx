// @vitest-environment jsdom
import { render } from 'preact';
import { describe, expect, it } from 'vitest';
import { Simulator } from './components/Simulator.js';

const tick = () => new Promise((r) => setTimeout(r, 20));

describe('interactive simulator', () => {
  it('tokenizes input live and computes a credit cost that reacts to output', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<Simulator navLinks={[]} />, root);
    await tick();

    // hero credit value renders
    const hero = () => document.querySelector('.stat.hero .val')?.textContent ?? '';
    expect(hero()).toContain('cr');

    // the per-model comparison table lists every model
    const rows = document.querySelectorAll('table.stepTable tr');
    expect(rows.length).toBeGreaterThan(8); // header + 9 models

    // bump output tokens → cost must strictly increase
    const before = Number.parseFloat(hero());
    const outInput = [...document.querySelectorAll('input[type=number]')].find(
      (i) => (i as HTMLInputElement).value === '400',
    ) as HTMLInputElement;
    outInput.value = '4000';
    outInput.dispatchEvent(new Event('input'));
    await tick();
    const after = Number.parseFloat(hero());
    expect(after).toBeGreaterThan(before);

    render(null, root);
    root.remove();
  });
});
