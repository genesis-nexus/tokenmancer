import type { JSX } from 'preact';
import {
  PROVIDER_LABEL,
  type ProviderFilterValue,
  providerFilter,
  providersIn,
  setProviderFilter,
} from '../state/provider-store.js';
import type { WorkspaceSummary } from '../transport.js';

/**
 * Segmented control for choosing which agent's workspaces to meter.
 *
 * Renders nothing unless this machine actually has both — a filter with one
 * option is a control that can only disappoint, and the overwhelming majority
 * of people run one coding agent, not two.
 */
export function ProviderFilter({
  workspaces,
}: {
  workspaces: readonly WorkspaceSummary[];
}): JSX.Element | null {
  const present = providersIn(workspaces);
  if (present.length < 2) return null;

  const current = providerFilter.value;
  const options: Array<{ id: ProviderFilterValue; label: string; title: string }> = [
    { id: 'all', label: 'All', title: 'Show workspaces from every coding agent' },
    ...present.map((p) => ({
      id: p as ProviderFilterValue,
      label: PROVIDER_LABEL[p],
      title: `Show only ${PROVIDER_LABEL[p]} workspaces`,
    })),
  ];

  return (
    <fieldset class="providerFilter">
      <legend class="visuallyHidden">Coding agent</legend>
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          class={`providerOpt${current === o.id ? ' on' : ''}`}
          aria-pressed={current === o.id}
          title={o.title}
          onClick={() => setProviderFilter(o.id)}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
