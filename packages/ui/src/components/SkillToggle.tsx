import type { JSX } from 'preact';
import { type SkillMode, setSkillMode, skillMode } from '../state/skill-store.js';

const MODES: Array<{ id: SkillMode; label: string; title: string }> = [
  {
    id: 'novice',
    label: 'Simple',
    title: 'Simple view — the few numbers that matter, in plain language',
  },
  {
    id: 'advanced',
    label: 'Detailed',
    title: 'Detailed view — every step, every metric, the full breakdown',
  },
];

/**
 * Segmented control rather than an icon: unlike the theme toggle, the current
 * state is not obvious from what is on screen, so the modes have to name
 * themselves. "Simple/Detailed" over "Novice/Advanced" — nobody wants to click
 * a button that calls them a novice.
 */
export function SkillToggle(): JSX.Element {
  const current = skillMode.value;
  return (
    <fieldset class="skillToggle">
      <legend class="visuallyHidden">Level of detail</legend>
      {MODES.map((m) => (
        <button
          key={m.id}
          type="button"
          class={`skillOpt${current === m.id ? ' on' : ''}`}
          aria-pressed={current === m.id}
          title={m.title}
          onClick={() => setSkillMode(m.id)}
        >
          {m.label}
        </button>
      ))}
    </fieldset>
  );
}
