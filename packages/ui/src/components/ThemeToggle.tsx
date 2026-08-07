import type { JSX } from 'preact';
import { theme, toggleTheme } from '../state/theme-store.js';

/** Sun/moon toggle: switches the whole app between light and dark, persisted. */
export function ThemeToggle(): JSX.Element {
  const isLight = theme.value === 'light';
  return (
    <button
      type="button"
      class="themeToggle"
      onClick={toggleTheme}
      aria-label={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
      title={isLight ? 'Switch to dark mode' : 'Switch to light mode'}
    >
      {isLight ? (
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M10 2a1 1 0 0 1 1 1v1.5a1 1 0 1 1-2 0V3a1 1 0 0 1 1-1Zm0 13.5a1 1 0 0 1 1 1V18a1 1 0 1 1-2 0v-1.5a1 1 0 0 1 1-1ZM18 9a1 1 0 1 1 0 2h-1.5a1 1 0 1 1 0-2H18ZM3.5 9a1 1 0 1 1 0 2H2a1 1 0 1 1 0-2h1.5Zm11.62-5.12a1 1 0 0 1 1.42 1.42l-1.07 1.06a1 1 0 1 1-1.41-1.41l1.06-1.07Zm-9.55 9.54a1 1 0 0 1 1.42 1.42l-1.07 1.06a1 1 0 1 1-1.41-1.41l1.06-1.07ZM15.12 15.12a1 1 0 0 1 1.42-1.42l1.06 1.07a1 1 0 1 1-1.41 1.41l-1.07-1.06ZM5.57 5.57A1 1 0 0 1 4.15 4.15l1.07-1.06a1 1 0 1 1 1.41 1.41L5.57 5.57ZM10 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 20 20" width="14" height="14" aria-hidden="true">
          <path
            fill="currentColor"
            d="M17.3 12.6a7 7 0 0 1-9.9-9.9 1 1 0 0 0-1.16-1.53A8.98 8.98 0 0 0 2 9a9 9 0 0 0 15.28 6.46A8.98 8.98 0 0 0 18.84 13.8a1 1 0 0 0-1.53-1.16Z"
          />
        </svg>
      )}
    </button>
  );
}
