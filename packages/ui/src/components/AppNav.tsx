import type { ComponentChildren, JSX } from 'preact';
import type { MeterTransport } from '../transport.js';
import { Logo } from './Logo.js';
import { SettingsButton } from './SettingsPanel.js';
import { ThemeToggle } from './ThemeToggle.js';

export interface NavLink {
  href: string;
  text: string;
  /** Other server paths that render the same surface, so the tab still reads
   *  as current when one of them is what the browser is on. */
  aliases?: string[];
}

/**
 * Every surface the web app serves, in the order they are meant to be walked.
 * Shared by all four so the bar is identical wherever you land — the point of a
 * static header is that the same four destinations are always in the same place.
 */
export const WEB_NAV: readonly NavLink[] = [
  { href: '/', text: 'Live view', aliases: ['/live', '/index.html'] },
  { href: '/analytics', text: 'Analytics' },
  { href: '/sessions', text: 'Past sessions', aliases: ['/replay', '/viewer'] },
  { href: '/simulator', text: 'What-if simulator' },
];

export interface AppNavProps {
  /** Pass `[]` inside the VS Code webviews: each panel is its own window there,
   *  so cross-surface links have nowhere to go. */
  links?: readonly NavLink[];
  /** `href` of the surface on screen. Falls back to the browser location, which
   *  is right for the web app but wrong for anything server-aliased. */
  current?: string;
  /** Omitted on surfaces with no transport (the simulator) — no settings there. */
  transport?: MeterTransport;
  /** Status shown ahead of the global actions; the live connection pill. */
  status?: ComponentChildren;
}

function isCurrent(link: NavLink, path: string): boolean {
  return link.href === path || !!link.aliases?.includes(path);
}

/**
 * The app-wide bar: brand, the four destinations, and the controls that belong
 * to the whole app rather than to one view (settings, theme). Everything scoped
 * to a single view — the detail toggle, workspace pickers, time windows — lives
 * in that view's own head row instead, which is what keeps this one readable.
 */
export function AppNav({ links = WEB_NAV, current, transport, status }: AppNavProps): JSX.Element {
  const path = current ?? (typeof location === 'undefined' ? '/' : location.pathname);
  const home = links[0]?.href;
  const brand = (
    <>
      {/* Decorative: the wordmark beside it already says the name. */}
      <Logo size={24} />
      <span class="brandName">Tokenmancer</span>
    </>
  );

  return (
    <header class="appbar">
      <div class="appbarInner">
        {home ? (
          <a class="brand" href={home}>
            {brand}
          </a>
        ) : (
          <span class="brand">{brand}</span>
        )}

        {links.length ? (
          <nav class="mainNav" aria-label="Views">
            {links.map((l) => {
              const on = isCurrent(l, path);
              return (
                <a
                  key={l.href}
                  class={`navTab${on ? ' on' : ''}`}
                  href={l.href}
                  aria-current={on ? 'page' : undefined}
                >
                  {l.text}
                </a>
              );
            })}
          </nav>
        ) : null}

        <div class="appbarActions">
          {status}
          {transport ? <SettingsButton transport={transport} /> : null}
          <ThemeToggle />
        </div>
      </div>
    </header>
  );
}
