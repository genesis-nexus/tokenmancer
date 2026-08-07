import type { JSX } from 'preact';
import type { SettingStatus } from '../transport.js';

export interface SettingsBannerProps {
  settings: SettingStatus[];
  onOpenSetting: (key: string) => void;
}

/** VS Code only: an actionable banner for Copilot settings Tokenmancer needs
 *  enabled, each with a button that jumps straight to it in the Settings UI. */
export function SettingsBanner({
  settings,
  onOpenSetting,
}: SettingsBannerProps): JSX.Element | null {
  const missing = settings.filter((s) => !s.enabled);
  if (!missing.length) return null;

  return (
    <div class="setupBanner" role="alert">
      <span class="setupBannerIcon" aria-hidden="true">
        ⚠
      </span>
      <div class="setupBannerBody">
        <div class="setupBannerTitle">
          {missing.length === 1
            ? 'A Copilot setting Tokenmancer needs is off'
            : `${missing.length} Copilot settings Tokenmancer needs are off`}
        </div>
        <div class="setupBannerText">
          The debug log Tokenmancer reads will be incomplete — prompts, or entire sessions, may not
          show up.
        </div>
        <div class="setupBannerActions">
          {missing.map((s) => (
            <button
              key={s.key}
              type="button"
              class="btn primary"
              onClick={() => onOpenSetting(s.key)}
            >
              Enable "{s.label}" →
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
