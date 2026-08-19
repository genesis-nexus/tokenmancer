import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import {
  type AlertEvent,
  type BudgetRule,
  type MeterEvent,
  type PartialConfig,
  type TokenmancerConfig,
  redactEvent,
  validateConfig,
} from '@cte/core';
import {
  BudgetRunner,
  type TailController,
  discoverSessionsIn,
  discoverWorkspaces,
  formatForWorkspace,
  getWorkspaceAnalyticsWithInsights,
  isContained,
  isSafeLogFileName,
  loadConfig,
  loadLogFile,
  resolveLogPath,
  resolveWorkspaceSessions,
  saveConfigPatch,
  startLiveTail,
} from '@cte/node-host';

/** Anything that can push a JSON message to the webview. */
export interface Poster {
  post(msg: unknown): void;
}

/** Status of a VS Code setting Tokenmancer depends on to read a complete log. */
export interface RequiredSettingStatus {
  key: string;
  label: string;
  enabled: boolean;
}

export interface BridgeOptions {
  /** debug-logs dir to auto-tail on `subscribe` (the current workspace by default). */
  defaultLogsDir?: string;
  showPrompts?: boolean;
  rateModel?: string;
  /** Injected by the extension host (vscode-free bridge can't read settings itself). */
  checkSettings?: () => RequiredSettingStatus[];
  openSetting?: (key: string) => void | Promise<void>;
  /** Composed config; drives budgets, redaction and pricing. */
  config?: TokenmancerConfig;
  /** Host-side tap so extension.ts can raise a toast and update the status bar. */
  onAlert?: (a: AlertEvent) => void;
  /** Called whenever spend moves, so the status bar can follow it. */
  onSpend?: (credits: number, poolCredits: number) => void;
}

/**
 * The extension host side of the webview transport. Vscode-free on purpose, so it
 * unit-tests without an editor: it takes a Poster + handles the same command RPCs
 * the web server exposes, reusing @cte/node-host + the single parser funnel.
 */
export class MeterBridge {
  private source: TailController | null = null;
  private readonly redactOpts: {
    showPrompts: boolean;
    showToolQueries: boolean;
    showPaths: boolean;
    salt: string;
  };
  private config: TokenmancerConfig;
  private budget: BudgetRunner;
  private workspaceId = 'default';

  constructor(
    private readonly poster: Poster,
    private readonly opts: BridgeOptions = {},
  ) {
    this.config = opts.config ?? loadConfig().config;
    this.redactOpts = {
      showPrompts: opts.showPrompts ?? this.config.privacy.showPrompts,
      showToolQueries: this.config.privacy.showToolQueries,
      showPaths: this.config.privacy.showPaths,
      salt: randomBytes(8).toString('hex'),
    };
    this.budget = new BudgetRunner({
      config: this.config,
      workspaceId: this.workspaceId,
      onError: () => {
        /* a ledger hiccup must never take the meter down */
      },
    });
    this.budget.onAlert((a) => {
      this.poster.post({ type: 'event', event: a });
      this.opts.onAlert?.(a);
    });
  }

  /** Live-toggle prompt visibility (e.g. the user flipped the VS Code setting). */
  setShowPrompts(v: boolean): void {
    this.redactOpts.showPrompts = v;
  }

  /** Re-apply the whole config after an onDidChangeConfiguration. */
  setConfig(config: TokenmancerConfig): void {
    this.config = config;
    this.redactOpts.showPrompts = config.privacy.showPrompts;
    this.redactOpts.showToolQueries = config.privacy.showToolQueries;
    this.redactOpts.showPaths = config.privacy.showPaths;
    this.budget.setConfig(config);
  }

  private rateModel(): string {
    return this.opts.rateModel ?? this.config.pricing.defaultModel;
  }

  /** Route a message received from the webview. */
  handle(msg: unknown): void {
    if (!msg || typeof msg !== 'object') return;
    const m = msg as { type?: string; id?: number; method?: string; params?: unknown };
    if (m.type === 'subscribe') {
      this.startDefault();
      return;
    }
    if (m.type !== 'rpc' || typeof m.id !== 'number' || !m.method) return;
    const id = m.id;
    Promise.resolve()
      .then(() => this.dispatch(m.method as string, m.params))
      .then((result) => this.poster.post({ type: 'rpc-result', id, result }))
      .catch((e: unknown) =>
        this.poster.post({
          type: 'rpc-error',
          id,
          error: e instanceof Error ? e.message : String(e),
        }),
      );
  }

  private emit(ev: MeterEvent): void {
    this.budget.observe(ev);
    this.poster.post({ type: 'event', event: redactEvent(ev, this.redactOpts) });
    if (ev.kind === 'step') {
      const snap = this.budget.snapshot();
      this.opts.onSpend?.(snap.byPeriod.month.credits, snap.poolCredits);
    }
  }

  private dispatch(method: string, params: unknown): unknown {
    const p = (params ?? {}) as {
      ws?: string;
      session?: string;
      log?: string;
      timeWindowDays?: number;
      key?: string;
      period?: string;
      rules?: unknown;
      patch?: unknown;
    };
    switch (method) {
      case 'getConfig':
        return this.config;
      case 'getSpend':
        return { snapshot: this.budget.snapshot(), rules: this.config.budgets.rules };
      case 'setBudget': {
        // Same validator the config files use, so a webview cannot install a
        // rule shape the evaluator would silently ignore.
        const { config: patch, problems } = validateConfig({ budgets: { rules: p.rules } });
        const rules = patch.budgets?.rules as BudgetRule[] | undefined;
        if (!rules) return { ok: false, problems };
        this.setConfig({ ...this.config, budgets: { rules } });
        return { ok: true, rules, problems };
      }
      case 'updateSettings': {
        const { config: patch, problems } = validateConfig(p.patch as PartialConfig);
        if (!Object.keys(patch).length) {
          return { ok: false, problems: problems.length ? problems : ['empty patch'] };
        }
        // Persisted to ~/.tokenmancer/config.json, the layer both surfaces
        // read — so a limit set in the sidebar governs the web app too.
        const saved = saveConfigPatch(patch);
        this.setConfig(saved.config);
        return {
          ok: true,
          config: saved.config,
          savedTo: saved.file,
          problems: [...problems, ...saved.problems],
        };
      }
      case 'checkSettings':
        return this.opts.checkSettings?.() ?? [];
      case 'openSetting':
        return Promise.resolve(this.opts.openSetting?.(p.key ?? '')).then(() => ({ ok: true }));
      case 'listWorkspaces':
        return discoverWorkspaces().map((w) => ({
          id: w.id,
          provider: w.provider,
          folderName: w.folderName,
          modifiedStr: w.modifiedStr,
          sessionCount: w.sessionCount,
          channel: w.channel,
        }));
      case 'listSessions': {
        const r = resolveWorkspaceSessions(p.ws ?? '');
        return (r?.sessions ?? []).map((s) => ({
          id: s.id,
          name: s.name,
          dateStr: s.dateStr,
          timeRange: s.timeRange,
          events: s.events,
          logFiles: s.logFiles,
        }));
      }
      case 'loadSession': {
        const abs = resolveLogPath(p.ws ?? '', p.session ?? 'main', p.log ?? 'main.jsonl');
        if (!abs) return [];
        return loadLogFile(abs, {
          sessionId: p.session,
          format: formatForWorkspace(p.ws ?? ''),
          defaultModel: this.rateModel(),
        }).map((e) => redactEvent(e, this.redactOpts));
      }
      case 'tailWorkspace': {
        const target = this.resolveTail(p.ws ?? '', p.session, p.log);
        if (!target) throw new Error('workspace/log not found');
        this.workspaceId = p.ws ?? 'default';
        this.budget.setWorkspace(this.workspaceId);
        this.startTail(target.abs, target.repoRoots);
        return { workspace: target.workspace, log: target.log };
      }
      case 'getWorkspaceAnalytics': {
        const r = resolveWorkspaceSessions(p.ws ?? '');
        if (!r) throw new Error('workspace not found');
        return getWorkspaceAnalyticsWithInsights(r.ws, {
          timeWindowDays: p.timeWindowDays ?? 30,
          defaultModel: this.rateModel(),
        });
      }
      case 'newSession':
        this.budget.resetSession();
        this.poster.post({ type: 'event', event: { kind: 'control', control: 'session' } });
        return { ok: true };
      default:
        throw new Error(`unknown method: ${method}`);
    }
  }

  private resolveTail(
    ws: string,
    sessionId?: string,
    logFile?: string,
  ): { abs: string; workspace: string; log: string; repoRoots: string[] } | null {
    const r = resolveWorkspaceSessions(ws);
    if (!r || !r.sessions.length) return null;
    const s = sessionId ? r.sessions.find((x) => x.id === sessionId) : r.sessions[0];
    if (!s) return null;
    const log = logFile ?? s.logFiles[0];
    if (!log || !isSafeLogFileName(log) || !s.logFiles.includes(log)) return null;
    const abs = path.join(s.logDir, log);
    if (!isContained(abs, r.ws.debugLogsDir)) return null;
    return { abs, workspace: r.ws.folderName, log, repoRoots: r.ws.folder ? [r.ws.folder] : [] };
  }

  /** Tail a workspace's newest log by id (used by the pick-workspace command). */
  tailByWorkspace(ws: string): boolean {
    const target = this.resolveTail(ws);
    if (!target) return false;
    this.workspaceId = ws;
    this.budget.setWorkspace(ws);
    this.startTail(target.abs, target.repoRoots);
    return true;
  }

  /** Auto-tail the newest session in the default (current-workspace) logs dir. */
  startDefault(): void {
    if (!this.opts.defaultLogsDir) return;
    const sessions = discoverSessionsIn(this.opts.defaultLogsDir);
    const s = sessions[0];
    const log = s?.logFiles[0];
    if (s && log) this.startTail(path.join(s.logDir, log));
  }

  startTail(file: string, repoRoots: string[] = []): void {
    this.stop();
    this.budget.resetSession();
    this.poster.post({ type: 'event', event: { kind: 'control', control: 'session' } });
    this.source = startLiveTail(file, {
      emit: (ev) => this.emit(ev),
      defaultModel: this.rateModel(),
      repoRoots,
    });
  }

  stop(): void {
    this.source?.stop();
    this.source = null;
  }

  /** Current month-to-date spend, for the status bar on activation. */
  spendSnapshot(): { credits: number; poolCredits: number } {
    const snap = this.budget.snapshot();
    return { credits: snap.byPeriod.month.credits, poolCredits: snap.poolCredits };
  }

  dispose(): void {
    this.stop();
    this.budget.dispose();
  }
}
