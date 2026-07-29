import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { type MeterEvent, redactEvent } from '@cte/core';
import {
  type TailController,
  discoverSessionsIn,
  discoverWorkspaces,
  isContained,
  isSafeLogFileName,
  loadLogFile,
  resolveLogPath,
  resolveWorkspaceSessions,
  startLiveTail,
} from '@cte/node-host';

/** Anything that can push a JSON message to the webview. */
export interface Poster {
  post(msg: unknown): void;
}

export interface BridgeOptions {
  /** debug-logs dir to auto-tail on `subscribe` (the current workspace by default). */
  defaultLogsDir?: string;
  showPrompts?: boolean;
  rateModel?: string;
}

/**
 * The extension host side of the webview transport. Vscode-free on purpose, so it
 * unit-tests without an editor: it takes a Poster + handles the same command RPCs
 * the web server exposes, reusing @cte/node-host + the single parser funnel.
 */
export class MeterBridge {
  private source: TailController | null = null;
  private readonly redactOpts: { showPrompts: boolean; salt: string };

  constructor(
    private readonly poster: Poster,
    private readonly opts: BridgeOptions = {},
  ) {
    this.redactOpts = {
      showPrompts: opts.showPrompts ?? false,
      salt: randomBytes(8).toString('hex'),
    };
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
    this.poster.post({ type: 'event', event: redactEvent(ev, this.redactOpts) });
  }

  private dispatch(method: string, params: unknown): unknown {
    const p = (params ?? {}) as { ws?: string; session?: string; log?: string };
    switch (method) {
      case 'listWorkspaces':
        return discoverWorkspaces().map((w) => ({
          id: w.id,
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
        return loadLogFile(abs, { sessionId: p.session, defaultModel: this.opts.rateModel }).map(
          (e) => redactEvent(e, this.redactOpts),
        );
      }
      case 'tailWorkspace': {
        const target = this.resolveTail(p.ws ?? '', p.session, p.log);
        if (!target) throw new Error('workspace/log not found');
        this.startTail(target.abs);
        return { workspace: target.workspace, log: target.log };
      }
      case 'newSession':
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
  ): { abs: string; workspace: string; log: string } | null {
    const r = resolveWorkspaceSessions(ws);
    if (!r || !r.sessions.length) return null;
    const s = sessionId ? r.sessions.find((x) => x.id === sessionId) : r.sessions[0];
    if (!s) return null;
    const log = logFile ?? s.logFiles[0];
    if (!log || !isSafeLogFileName(log) || !s.logFiles.includes(log)) return null;
    const abs = path.join(s.logDir, log);
    if (!isContained(abs, r.ws.debugLogsDir)) return null;
    return { abs, workspace: r.ws.folderName, log };
  }

  /** Tail a workspace's newest log by id (used by the pick-workspace command). */
  tailByWorkspace(ws: string): boolean {
    const target = this.resolveTail(ws);
    if (!target) return false;
    this.startTail(target.abs);
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

  startTail(file: string): void {
    this.stop();
    this.poster.post({ type: 'event', event: { kind: 'control', control: 'session' } });
    this.source = startLiveTail(file, {
      emit: (ev) => this.emit(ev),
      defaultModel: this.opts.rateModel,
    });
  }

  stop(): void {
    this.source?.stop();
    this.source = null;
  }

  dispose(): void {
    this.stop();
  }
}
