import type { JSX } from 'preact';

/**
 * The Tokenmancer mark, traced from the brand artwork in `assets/brand/`.
 *
 * Authored as vector rather than shipped as a PNG so it stays crisp at the
 * 20-odd pixels the masthead actually uses it at, and so it can follow the
 * theme: the hood is `currentColor` and the accents are brand tokens, which is
 * what lets one file serve the dark and light marks the artwork supplies as two
 * separate exports.
 *
 * Coordinates are in a 64-unit box and symmetric about x=32.
 */

/**
 * Cropped to the drawn content. The source export is an app icon, so it carries
 * a wide safe margin; inline in a masthead that margin is the layout's job, and
 * leaving it in the asset renders the mark about a third smaller than the size
 * it is asked for. Square, so the mark never distorts.
 */
const VIEW_BOX = '9.8 9.15 44.2 44.2';

/** Outer silhouette, including the three-point banner hem. */
const HOOD =
  'M32 11.06 L47 23.75 L47.75 50.69 L40.19 46.62 L32 51.44 L23.81 46.62 L16.25 50.69 L17 23.75 Z';
/** The face, cut out of the hood so whatever sits behind shows through. */
const FACE = 'M32 18.5 L22.25 27.44 L23 43.31 L32 47.38 L41 43.31 L41.75 27.44 Z';
const EYE_L = 'M26 30.94 L31.94 33.5 L29.44 37.56 L24.88 34.62 Z';
const EYE_R = 'M38 30.94 L39.12 34.62 L34.56 37.56 L32.06 33.5 Z';
const MOUTH = 'M29.06 41.8 L34.94 41.8 L33.5 44.38 L30.5 44.38 Z';

export interface LogoProps {
  /** Rendered size in px. The mark is square. */
  size?: number;
  class?: string;
  /**
   * Give the mark an accessible name. Omit inside a element that already names
   * it — a logo beside the word "Tokenmancer" is decoration, not content.
   */
  title?: string;
}

/**
 * The full-colour mark. The hood inherits `currentColor`, so it sits correctly
 * on either theme without a second asset.
 */
export function Logo({ size = 26, class: cls, title }: LogoProps): JSX.Element {
  return (
    <svg
      class={`tmLogo${cls ? ` ${cls}` : ''}`}
      width={size}
      height={size}
      viewBox={VIEW_BOX}
      fill="none"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : 'true'}
      aria-label={title}
    >
      {title ? <title>{title}</title> : null}
      {/* evenodd punches the face out of the hood rather than painting a
          background colour into it, so the mark works on any surface. */}
      <path d={`${HOOD} ${FACE}`} fill="currentColor" fill-rule="evenodd" />
      <path d={EYE_L} class="tmLogo-eye" />
      <path d={EYE_R} class="tmLogo-eye" />
      <path d={MOUTH} class="tmLogo-mouth" />
      <circle cx="13.62" cy="18.12" r="1.97" class="tmLogo-dot" fill="none" stroke-width="1.69" />
      <circle cx="46.62" cy="12.88" r="1.12" class="tmLogo-dot" />
      <circle cx="51.12" cy="21.5" r="1.88" class="tmLogo-dot" />
    </svg>
  );
}
