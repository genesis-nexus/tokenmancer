import type { ProviderId } from '@cte/core';
import { signal } from '@preact/signals';
import type { WorkspaceSummary } from '../transport.js';

/**
 * Which meter's workspaces to show. Persisted like the theme and the detail
 * level, and for the same reason: which coding agent you use is a property of
 * the reader, not of any one surface, so the choice follows them from the live
 * meter to replay to analytics rather than being re-made three times.
 */
export type ProviderFilterValue = 'all' | ProviderId;

const STORAGE_KEY = 'tokenmancer.providerFilter';

function stored(): ProviderFilterValue | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'all' || v === 'copilot' || v === 'claude' ? v : null;
}

export const providerFilter = signal<ProviderFilterValue>(stored() ?? 'all');

export function setProviderFilter(v: ProviderFilterValue): void {
  providerFilter.value = v;
  try {
    localStorage.setItem(STORAGE_KEY, v);
  } catch {
    // storage unavailable (private mode, webview sandbox) — the choice still
    // applies for this session via the signal.
  }
}

export const PROVIDER_LABEL: Record<ProviderId, string> = {
  copilot: 'Copilot',
  claude: 'Claude Code',
};

/** Providers actually present on this machine, in a stable display order. */
export function providersIn(list: readonly WorkspaceSummary[]): ProviderId[] {
  const seen = new Set(list.map((w) => w.provider));
  return (['copilot', 'claude'] as const).filter((p) => seen.has(p));
}

export function matchesProvider(w: WorkspaceSummary, filter: ProviderFilterValue): boolean {
  return filter === 'all' || w.provider === filter;
}

export function filterWorkspaces(
  list: readonly WorkspaceSummary[],
  filter: ProviderFilterValue,
): WorkspaceSummary[] {
  return list.filter((w) => matchesProvider(w, filter));
}

/**
 * One label for all three pickers. Naming the provider on every row matters
 * more than it looks: the same folder metered by both agents appears twice, and
 * without this the two entries are character-for-character identical.
 */
export function workspaceLabel(w: WorkspaceSummary, opts: { modified?: boolean } = {}): string {
  const provider = PROVIDER_LABEL[w.provider] ?? w.provider;
  // The editor only earns a mention when it is not the default one.
  const channel =
    w.provider === 'copilot' && w.channel && w.channel !== 'Code' ? ` (${w.channel})` : '';
  const sessions = `${w.sessionCount} session${w.sessionCount === 1 ? '' : 's'}`;
  const parts = [`${provider}${channel}`];
  if (opts.modified && w.modifiedStr) parts.push(w.modifiedStr);
  parts.push(sessions);
  return `${w.folderName} — ${parts.join(' · ')}`;
}
