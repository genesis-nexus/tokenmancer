import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { discoverWorkspaces } from '@cte/node-host';
import * as vscode from 'vscode';
import { MeterBridge } from './bridge.js';
import { checkRequiredSettings, openRequiredSetting } from './settings-check.js';

const RATE_MODEL = 'claude-sonnet-4.6';

function showPromptsSetting(): boolean {
  return vscode.workspace.getConfiguration('tokenmancer').get<boolean>('showPrompts', false);
}

function bridgeOptions(): {
  showPrompts: boolean;
  checkSettings: () => ReturnType<typeof checkRequiredSettings>;
  openSetting: (key: string) => Promise<void>;
} {
  return {
    showPrompts: showPromptsSetting(),
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
  constructor(private readonly context: vscode.ExtensionContext) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = webviewHtml(view.webview, this.context.extensionUri, 'live');
    const bridge = new MeterBridge(
      { post: (m) => view.webview.postMessage(m) },
      {
        defaultLogsDir: currentWorkspaceLogsDir(this.context),
        rateModel: RATE_MODEL,
        ...bridgeOptions(),
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
    { rateModel: RATE_MODEL, ...bridgeOptions() },
  );
  panel.webview.onDidReceiveMessage((m) => bridge.handle(m));
  panel.onDidDispose(() => bridge.dispose());
}

export function activate(context: vscode.ExtensionContext): void {
  const provider = new LiveViewProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('tokenmancer.live', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand('tokenmancer.openLiveMeter', () =>
      vscode.commands.executeCommand('tokenmancer.live.focus'),
    ),
    vscode.commands.registerCommand('tokenmancer.openReplay', () =>
      openPanel(context, 'replay', 'Copilot Session Replay'),
    ),
    vscode.commands.registerCommand('tokenmancer.openSimulator', () =>
      openPanel(context, 'simulator', 'Copilot Token Simulator'),
    ),
    vscode.commands.registerCommand('tokenmancer.openAnalytics', () =>
      openPanel(context, 'analytics', 'Copilot Workspace Analytics'),
    ),
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
      if (e.affectsConfiguration('tokenmancer.showPrompts')) {
        provider.bridge?.setShowPrompts(showPromptsSetting());
      }
    }),
  );
}

export function deactivate(): void {
  // subscriptions are disposed by VS Code
}
