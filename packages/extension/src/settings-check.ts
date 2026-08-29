import * as vscode from 'vscode';
import type { RequiredSettingStatus } from './bridge.js';

interface RequiredSetting {
  /** Dotted VS Code setting id, e.g. github.copilot.chat.agentDebugLog.enabled. */
  key: string;
  /** getConfiguration() section (everything before the last dot). */
  section: string;
  /** get() property within that section (everything after the last dot). */
  prop: string;
  label: string;
}

// Without this, Copilot's agent debug log isn't written at all, so Tokenmancer
// has nothing to read — see README "Setup". `agentDebugLog.enabled` (no
// `fileLogging`) used to be a second required setting, but GitHub folded it
// into this one and deprecated it as of Copilot Chat 0.48 — it's a no-op now,
// so it's no longer checked here even though old README copies still mention it.
const REQUIRED_SETTINGS: RequiredSetting[] = [
  {
    key: 'github.copilot.chat.agentDebugLog.fileLogging.enabled',
    section: 'github.copilot.chat',
    prop: 'agentDebugLog.fileLogging.enabled',
    label: 'Copilot agent debug log',
  },
];

export function checkRequiredSettings(): RequiredSettingStatus[] {
  return REQUIRED_SETTINGS.map((s) => {
    const cfg = vscode.workspace.getConfiguration(s.section);
    return { key: s.key, label: s.label, enabled: cfg.get<boolean>(s.prop) === true };
  });
}

/** Jump straight to the setting in VS Code's Settings UI, pre-filtered to it. */
export async function openRequiredSetting(key: string): Promise<void> {
  await vscode.commands.executeCommand('workbench.action.openSettings', `@id:${key}`);
}
