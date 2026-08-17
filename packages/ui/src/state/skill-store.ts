import { effect, signal } from '@preact/signals';

/**
 * How much detail a person wants. Not a capability gate — everything is one
 * click away — but a default that decides whether the first thing you see is
 * four numbers or forty.
 *
 * Persisted like the theme, and for the same reason: it is a property of the
 * reader, not of the workspace, so it follows them across every surface.
 */
export type SkillMode = 'novice' | 'advanced';

const STORAGE_KEY = 'tokenmancer.skillMode';

function stored(): SkillMode | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'novice' || v === 'advanced' ? v : null;
}

/**
 * Novice is the default. Someone meeting token economics for the first time is
 * the person this tool has to win over, and the full dashboard is 16 metric
 * cards of vocabulary they have not learned yet.
 */
export const skillMode = signal<SkillMode>(stored() ?? 'novice');

/** True when the reader has never expressed a preference — drives the one-time hint. */
export const skillModeIsDefault = signal<boolean>(stored() === null);

if (typeof document !== 'undefined') {
  effect(() => {
    // Mirrored onto <html> so CSS can hide dense chrome without every component
    // having to thread the mode through its props.
    document.documentElement.dataset.skill = skillMode.value;
  });
}

export function setSkillMode(mode: SkillMode): void {
  skillMode.value = mode;
  skillModeIsDefault.value = false;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // storage unavailable (private mode, webview sandbox) — the choice still
    // applies for this session via the signal.
  }
}

/**
 * Apply a producer-supplied default. Deliberately a no-op once the reader has
 * touched the toggle: a workspace setting expresses where to start, not what
 * someone is allowed to see.
 */
export function applyConfigDefault(detail: 'simple' | 'detailed' | undefined): void {
  if (!detail || !skillModeIsDefault.value) return;
  skillMode.value = detail === 'detailed' ? 'advanced' : 'novice';
}
