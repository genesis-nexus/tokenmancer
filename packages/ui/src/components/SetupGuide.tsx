import type { JSX } from 'preact';

const SNIPPET = `"github.copilot.chat.agentDebugLog.enabled": true,
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true`;

/** Web app fallback for SettingsBanner: no VS Code API here, so this is a
 *  static landing page — what to enable and how, step by step. */
export function SetupGuide(): JSX.Element {
  return (
    <details class="help setupGuide">
      <summary>
        <span class="chev">▶</span>Not seeing sessions or prompt text? Check Copilot's debug log
        settings
      </summary>
      <div class="hbody">
        <ol>
          <li>
            In VS Code, open <b>Settings</b> (<kbd>Cmd/Ctrl</kbd>+<kbd>,</kbd>), then click the{' '}
            <b>Open Settings (JSON)</b> icon in the top-right corner.
          </li>
          <li>Add these two lines (or search "agentDebugLog" in the regular Settings UI):</li>
        </ol>
        <pre>{SNIPPET}</pre>
        <ol start={3}>
          <li>
            Save the file, then reload the VS Code window (Command Palette → "Reload Window").
          </li>
          <li>Send a Copilot Chat / Agent request, then reopen or refresh this page.</li>
        </ol>
        <p>
          Prompt text itself is also <b>redacted by default</b> for privacy — token counts and costs
          still show either way. To see prompt text too, start the web app with{' '}
          <code>--show-prompts</code>, or (in the VS Code extension) enable{' '}
          <b>Tokenmancer › Show Prompts</b> in Settings.
        </p>
      </div>
    </details>
  );
}
