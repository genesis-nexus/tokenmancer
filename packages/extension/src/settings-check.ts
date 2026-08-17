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

// Without these, Copilot's agent debug log either isn't written at all or is
// missing the user_message records Tokenmancer needs to show prompt text and
// group steps into loops — see README "Quick start".
const REQUIRED_SETTINGS: RequiredSetting[] = [
  {
    key: 'github.copilot.chat.agentDebugLog.enabled',
    section: 'github.copilot.chat',
    prop: 'agentDebugLog.enabled',
    label: 'Copilot agent debug log',
  },
  {
    key: 'github.copilot.chat.agentDebugLog.fileLogging.enabled',
    section: 'github.copilot.chat',
    prop: 'agentDebugLog.fileLogging.enabled',
    label: 'Debug log file logging',
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
