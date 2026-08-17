import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AlertEvent, TokenmancerConfig } from '@cte/core';
import { discoverWorkspaces, ensureConfigFile, loadConfig } from '@cte/node-host';
import * as vscode from 'vscode';
import { type BridgeOptions, MeterBridge } from './bridge.js';
import { checkRequiredSettings, openRequiredSetting } from './settings-check.js';
import { SpendStatusBar } from './status-bar.js';
import { affectsTokenmancerConfig, vscodeConfigToPartial } from './vscode-config.js';

/**
 * The composed config, rebuilt on any settings change. `showPrompts` keeps its
 * legacy top-level id as well, so an existing user's setting is not silently
 * dropped when they upgrade.
 */
function composeConfig(): TokenmancerConfig {
  const legacyShowPrompts = vscode.workspace
    .getConfiguration('tokenmancer')
    .inspect<boolean>('showPrompts');
  const explicitLegacy =
    legacyShowPrompts?.workspaceFolderValue ??
    legacyShowPrompts?.workspaceValue ??
    legacyShowPrompts?.globalValue;

  const overrides = vscodeConfigToPartial();
  if (explicitLegacy !== undefined) {
    overrides.privacy = { ...overrides.privacy, showPrompts: explicitLegacy };
  }
  return loadConfig({
    cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
    overrides,
  }).config;
}

function bridgeOptions(config: TokenmancerConfig): BridgeOptions {
  return {
    config,
    showPrompts: config.privacy.showPrompts,
    checkSettings: checkRequiredSettings,
    openSetting: openRequiredSetting,
  };
}

function nonce(): string {
  return randomBytes(16).toString('base64');
}

function webviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  surface: 'live' | 'replay' | 'simulator' | 'analytics',
): string {
  const base = vscode.Uri.joinPath(extensionUri, 'dist', 'webview');
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(base, `${surface}.js`));
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(base, `${surface}.css`));
  const n = nonce();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${n}'`,
    `img-src ${webview.cspSource} data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<link rel="stylesheet" href="${cssUri}">
</head>
<body><div id="app"></div><script nonce="${n}" src="${jsUri}"></script></body>
</html>`;
}

/** Resolve the current workspace's Copilot debug-logs dir (the privacy-friendly
 *  default target), matching by folder path and falling back to storage walk. */
function currentWorkspaceLogsDir(context: vscode.ExtensionContext): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) {
    const match = discoverWorkspaces().find(
      (w) => w.folder && path.resolve(w.folder) === path.resolve(folder),
    );
    if (match) return match.debugLogsDir;
  }
  const sp = context.storageUri?.fsPath;
  if (sp) {
    for (const up of [sp, path.dirname(sp), path.dirname(path.dirname(sp))]) {
      const cand = path.join(up, 'GitHub.copilot-chat', 'debug-logs');
      try {
        if (fs.existsSync(cand)) return cand;
      } catch {
        // ignore
      }
    }
  }
  return undefined;
}

function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist', 'webview')],
  };
}

class LiveViewProvider implements vscode.WebviewViewProvider {
  public bridge?: MeterBridge;
  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly getConfig: () => TokenmancerConfig,
    private readonly onAlert: (a: AlertEvent) => void,
    private readonly onSpend: (credits: number, pool: number) => void,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, 'live');
    const bridge = new MeterBridge(
      { post: (m) => view.webview.postMessage(m) },
      {
        defaultLogsDir: currentWorkspaceLogsDir(this.context),
        onAlert: this.onAlert,
        onSpend: this.onSpend,
        ...bridgeOptions(this.getConfig()),
      },
    );
    this.bridge = bridge;
    view.webview.onDidReceiveMessage((m) => bridge.handle(m));
    view.onDidDispose(() => {
      bridge.dispose();
      if (this.bridge === bridge) this.bridge = undefined;
    });
  }
}

function openPanel(
  context: vscode.ExtensionContext,
  surface: 'replay' | 'simulator' | 'analytics',
  title: string,
  config: TokenmancerConfig,
): void {
  const panel = vscode.window.createWebviewPanel(
    `tokenmancer.${surface}`,
    title,
    vscode.ViewColumn.Active,
    webviewOptions(context.extensionUri),
  );
  panel.webview.html = webviewHtml(panel.webview, context.extensionUri, surface);
  if (surface === 'simulator') return; // pure client, no host bridge needed
  const bridge = new MeterBridge(
    { post: (m) => panel.webview.postMessage(m) },
    bridgeOptions(config),
  );
  panel.webview.onDidReceiveMessage((m) => bridge.handle(m));
  panel.onDidDispose(() => bridge.dispose());
}

export function activate(context: vscode.ExtensionContext): void {
  // Activation is now `onStartupFinished`, so this runs in every window. Keep it
  // to one config read: `discoverWorkspaces()` is deferred to the first tail,
  // and the status bar only appears when there is something to say.
  let config = composeConfig();

  const statusBar = new SpendStatusBar();
  context.subscriptions.push(statusBar);

  const budgetsOn = () =>
    config.alerts.enabled && config.budgets.rules.some((r) => r.enabled && r.limit > 0);

  const onAlert = (a: AlertEvent): void => {
    if (!config.alerts.channels.statusBar) statusBar.clearFlag();
    else statusBar.flag(a.severity);
    if (!config.alerts.channels.notification) return;
    // Only a real breach interrupts with a modal-ish toast; warnings stay in
    // the banner and the status bar.
    if (a.severity === 'critical') vscode.window.showWarningMessage(`Tokenmancer — ${a.body}`);
  };
  const onSpend = (credits: number, pool: number): void => {
    if (config.alerts.channels.statusBar) {
      statusBar.update(credits, pool);
      statusBar.show();
    }
  };

  const provider = new LiveViewProvider(context, () => config, onAlert, onSpend);

  if (config.alerts.channels.statusBar && budgetsOn()) statusBar.show();

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tokenmancer.live', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('tokenmancer.openLiveMeter', () =>
      vscode.commands.executeCommand('tokenmancer.live.focus'),
    ),
    vscode.commands.registerCommand('tokenmancer.openReplay', () =>
      openPanel(context, 'replay', 'Copilot Session Replay', config),
    ),
    vscode.commands.registerCommand('tokenmancer.openSimulator', () =>
      openPanel(context, 'simulator', 'Copilot Token Simulator', config),
    ),
    vscode.commands.registerCommand('tokenmancer.openAnalytics', () =>
      openPanel(context, 'analytics', 'Copilot Workspace Analytics', config),
    ),
    vscode.commands.registerCommand('tokenmancer.showSpend', () => {
      const s = provider.bridge?.spendSnapshot();
      const created = ensureConfigFile();
      const where = created ? `Created ${created}` : 'Edit ~/.tokenmancer/config.json';
      vscode.window.showInformationMessage(
        s
          ? `Tokenmancer — ${s.credits.toFixed(2)} credits this month of a ${s.poolCredits.toLocaleString()}-credit pool. ${where}`
          : `Tokenmancer — no spend recorded yet. ${where}`,
      );
    }),
    vscode.commands.registerCommand('tokenmancer.setBudget', async () => {
      const answer = await vscode.window.showInputBox({
        title: 'Monthly credit budget',
        prompt: 'Credits per month. Leave empty to clear.',
        value: String(
          config.budgets.rules.find((r) => r.period === 'month' && r.enabled)?.limit ?? '',
        ),
        validateInput: (v) =>
          !v.trim() || (Number(v) > 0 && Number.isFinite(Number(v)))
            ? null
            : 'Enter a positive number of credits, or leave empty.',
      });
      if (answer === undefined) return;
      const target = vscode.ConfigurationTarget.Global;
      await vscode.workspace
        .getConfiguration('tokenmancer')
        .update('budgets.monthlyCredits', answer.trim() ? Number(answer) : undefined, target);
    }),
    vscode.commands.registerCommand('tokenmancer.pickWorkspace', async () => {
      const items = discoverWorkspaces().map((w) => ({
        label: w.folderName,
        description: `${w.sessionCount} session${w.sessionCount > 1 ? 's' : ''} · ${w.modifiedStr}`,
        id: w.id,
      }));
      if (!items.length) {
        vscode.window.showInformationMessage(
          'No VS Code workspaces with Copilot debug logs found.',
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(items, {
        placeHolder: 'Tail a workspace’s live Copilot log',
      });
      if (!pick) return;
      await vscode.commands.executeCommand('tokenmancer.live.focus');
      // give the view a moment to resolve if it wasn't open yet
      setTimeout(() => {
        if (!provider.bridge?.tailByWorkspace(pick.id)) {
          vscode.window.showWarningMessage('Could not tail that workspace log.');
        }
      }, 300);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // Re-merge the whole config, not just showPrompts — every key is now
      // settable, and a partial refresh would leave the bridge inconsistent.
      if (!affectsTokenmancerConfig(e)) return;
      config = composeConfig();
      provider.bridge?.setConfig(config);
      if (config.alerts.channels.statusBar && budgetsOn()) statusBar.show();
    }),
  );
}

export function deactivate(): void {
  // subscriptions are disposed by VS Code
}
