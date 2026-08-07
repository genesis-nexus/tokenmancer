import { effect, signal } from '@preact/signals';

export type Theme = 'light' | 'dark';

const STORAGE_KEY = 'tokenmancer.theme';

function systemTheme(): Theme {
  if (typeof window === 'undefined' || !window.matchMedia) return 'dark';
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}

function storedTheme(): Theme | null {
  if (typeof localStorage === 'undefined') return null;
  const v = localStorage.getItem(STORAGE_KEY);
  return v === 'light' || v === 'dark' ? v : null;
}

export const theme = signal<Theme>(storedTheme() ?? systemTheme());

// Reflect the current theme onto <html data-theme> and persist explicit
// choices, so theme.css / analytics.css's [data-theme] overrides pick it up
// and every surface (live meter, replay, simulator, analytics) stays in sync.
if (typeof document !== 'undefined') {
  effect(() => {
    document.documentElement.dataset.theme = theme.value;
    try {
      localStorage.setItem(STORAGE_KEY, theme.value);
    } catch {
      // storage unavailable (private mode, webview sandbox) — theme still
      // applies for this session via the signal.
    }
  });
}

export function toggleTheme(): void {
  theme.value = theme.value === 'dark' ? 'light' : 'dark';
}
