import { type AlertSeverity, POOL } from '@cte/core';
import * as vscode from 'vscode';

/**
 * Always-visible month-to-date spend. This is the piece that makes the
 * extension worth keeping installed: it is the only surface that tells you what
 * you have spent without your having to go and ask.
 */
export class SpendStatusBar {
  private readonly item: vscode.StatusBarItem;
  private credits = 0;
  private poolCredits = POOL;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.item.command = 'tokenmancer.openLiveMeter';
    this.item.name = 'Tokenmancer spend';
    this.render();
  }

  update(credits: number, poolCredits: number): void {
    this.credits = credits;
    if (poolCredits > 0) this.poolCredits = poolCredits;
    this.render();
  }

  /** Tint the item when a budget alert lands, so the number itself carries the warning. */
  flag(severity: AlertSeverity): void {
    this.item.backgroundColor =
      severity === 'critical'
        ? new vscode.ThemeColor('statusBarItem.errorBackground')
        : severity === 'warn'
          ? new vscode.ThemeColor('statusBarItem.warningBackground')
          : undefined;
    this.render();
  }

  clearFlag(): void {
    this.item.backgroundColor = undefined;
  }

  show(): void {
    this.item.show();
  }

  private render(): void {
    const pct = this.poolCredits > 0 ? (this.credits / this.poolCredits) * 100 : 0;
    const cr = this.credits < 10 ? this.credits.toFixed(2) : this.credits.toFixed(1);
    this.item.text = `$(zap) ${cr} cr · ${pct.toFixed(pct < 1 ? 2 : 1)}%`;
    this.item.tooltip = `Tokenmancer — ${cr} credits this month (${pct.toFixed(1)}% of a ${this.poolCredits.toLocaleString()}-credit pool). Click to open the meter.`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
