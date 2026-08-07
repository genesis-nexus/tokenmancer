import type { AnalyticsInsight, MeterEvent, WorkspaceAnalytics } from '@cte/core';
import type { ConnState } from './state/store.js';

export interface WorkspaceSummary {
  id: string;
  folderName: string;
  modifiedStr: string;
  sessionCount: number;
  channel: string;
}

export interface SessionSummary {
  id: string;
  name: string;
  dateStr: string;
  timeRange: string;
  events: number;
  logFiles: string[];
}

export interface AnalyticsResult {
  analytics: WorkspaceAnalytics;
  insights: AnalyticsInsight[];
}

/** Status of a VS Code setting Tokenmancer depends on to read a complete log. */
export interface SettingStatus {
  key: string;
  label: string;
  enabled: boolean;
}

/**
 * One renderer, pluggable source. The web app implements this over SSE + fetch;
 * the VS Code extension implements it over postMessage (added in P6). The App
 * component never knows which one it is talking to.
 */
export interface MeterTransport {
  subscribe(cb: (ev: MeterEvent) => void): () => void;
  onConnection?(cb: (s: ConnState) => void): () => void;
  listWorkspaces(): Promise<WorkspaceSummary[]>;
  listSessions(wsId: string): Promise<SessionSummary[]>;
  loadSession(wsId: string, sessionId: string, log?: string): Promise<MeterEvent[]>;
  tailWorkspace(wsId: string): Promise<{ workspace?: string; log?: string }>;
  newSession(): Promise<void>;
  getWorkspaceAnalytics?(wsId: string, timeWindowDays?: number): Promise<AnalyticsResult>;
  /** VS Code only: read the Copilot settings Tokenmancer depends on. Absent on
   *  transports (web app) that have no VS Code settings API to query. */
  checkSettings?(): Promise<SettingStatus[]>;
  /** VS Code only: jump straight to the named setting in the Settings UI. */
  openSetting?(key: string): Promise<void>;
  dispose(): void;
}

export interface SseOptions {
  baseUrl?: string;
  token?: string;
}

function withToken(url: string, token?: string): string {
  if (!token) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Live web-app transport: SSE for events, fetch for commands. */
export class SseTransport implements MeterTransport {
  private es: EventSource | null = null;
  private readonly base: string;
  private readonly token?: string;

  constructor(opts: SseOptions = {}) {
    this.base = opts.baseUrl ?? '';
    this.token = opts.token;
  }

  subscribe(cb: (ev: MeterEvent) => void): () => void {
    const es = new EventSource(withToken(`${this.base}/events`, this.token));
    es.onmessage = (e) => {
      try {
        cb(JSON.parse(e.data) as MeterEvent);
      } catch {
        // ignore malformed frame
      }
    };
    this.es = es;
    return () => {
      es.close();
      if (this.es === es) this.es = null;
    };
  }

  onConnection(cb: (s: ConnState) => void): () => void {
    // the EventSource is created in subscribe(); wire once it exists.
    const wire = (): boolean => {
      if (!this.es) return false;
      this.es.onopen = () => cb('live');
      this.es.onerror = () => cb('down');
      return true;
    };
    if (wire()) return () => {};
    const t = setInterval(() => {
      if (wire()) clearInterval(t);
    }, 50);
    return () => clearInterval(t);
  }

  private async get<T>(path: string): Promise<T> {
    const r = await fetch(withToken(`${this.base}${path}`, this.token));
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  }
  private async post<T>(path: string): Promise<T> {
    const r = await fetch(withToken(`${this.base}${path}`, this.token), { method: 'POST' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as T;
  }

  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.get<WorkspaceSummary[]>('/api/workspaces');
  }
  listSessions(wsId: string): Promise<SessionSummary[]> {
    return this.get<SessionSummary[]>(`/api/workspace-sessions?ws=${encodeURIComponent(wsId)}`);
  }
  loadSession(wsId: string, sessionId: string, log = 'main.jsonl'): Promise<MeterEvent[]> {
    const q = new URLSearchParams({ ws: wsId, session: sessionId, log });
    return this.get<MeterEvent[]>(`/api/log?${q.toString()}`);
  }
  tailWorkspace(wsId: string): Promise<{ workspace?: string; log?: string }> {
    return this.post(`/api/tail?ws=${encodeURIComponent(wsId)}`);
  }
  async newSession(): Promise<void> {
    await this.post('/session/new');
  }
  getWorkspaceAnalytics(wsId: string, timeWindowDays = 30): Promise<AnalyticsResult> {
    const q = new URLSearchParams({ ws: wsId, days: String(timeWindowDays) });
    return this.get<AnalyticsResult>(`/api/analytics?${q.toString()}`);
  }
  dispose(): void {
    this.es?.close();
    this.es = null;
  }
}

/** Replay a fixed list of events (session viewer, tests, fixtures). */
export class ReplayTransport implements MeterTransport {
  constructor(private readonly load: () => Promise<MeterEvent[]> | MeterEvent[]) {}

  subscribe(cb: (ev: MeterEvent) => void): () => void {
    let cancelled = false;
    Promise.resolve(this.load()).then((events) => {
      if (cancelled) return;
      for (const ev of events) cb(ev);
    });
    return () => {
      cancelled = true;
    };
  }
  onConnection(cb: (s: ConnState) => void): () => void {
    cb('live');
    return () => {};
  }
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return [];
  }
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }
  async loadSession(): Promise<MeterEvent[]> {
    return Promise.resolve(this.load());
  }
  async tailWorkspace(): Promise<{ workspace?: string; log?: string }> {
    return {};
  }
  async newSession(): Promise<void> {}
  dispose(): void {}
}

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

let cachedVsCodeApi: VsCodeApi | undefined;
function getVsCodeApi(): VsCodeApi {
  if (!cachedVsCodeApi) cachedVsCodeApi = acquireVsCodeApi();
  return cachedVsCodeApi;
}

interface RpcMessage {
  type: 'event' | 'rpc-result' | 'rpc-error' | 'connection';
  id?: number;
  event?: MeterEvent;
  result?: unknown;
  error?: string;
  state?: ConnState;
}

/**
 * VS Code webview transport: the extension host is on the other side of
 * `postMessage`. Requests are correlated RPC calls; live events arrive as
 * `{type:'event'}` frames — the same renderer, no HTTP, CSP-friendly.
 */
export class PostMessageTransport implements MeterTransport {
  private readonly api: VsCodeApi;
  private rpcId = 0;
  private readonly pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private readonly eventCbs = new Set<(ev: MeterEvent) => void>();
  private readonly connCbs = new Set<(s: ConnState) => void>();
  private readonly onMessage: (e: MessageEvent) => void;

  constructor(api?: VsCodeApi) {
    this.api = api ?? getVsCodeApi();
    this.onMessage = (e: MessageEvent) => {
      const m = e.data as RpcMessage | null;
      if (!m || typeof m !== 'object') return;
      if (m.type === 'event' && m.event) {
        for (const cb of this.eventCbs) cb(m.event);
      } else if (m.type === 'rpc-result' && m.id != null) {
        this.pending.get(m.id)?.resolve(m.result);
        this.pending.delete(m.id);
      } else if (m.type === 'rpc-error' && m.id != null) {
        this.pending.get(m.id)?.reject(new Error(m.error ?? 'rpc error'));
        this.pending.delete(m.id);
      } else if (m.type === 'connection' && m.state) {
        for (const cb of this.connCbs) cb(m.state);
      }
    };
    window.addEventListener('message', this.onMessage);
  }

  private rpc<T>(method: string, params?: unknown): Promise<T> {
    const id = ++this.rpcId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.api.postMessage({ type: 'rpc', id, method, params });
    });
  }

  subscribe(cb: (ev: MeterEvent) => void): () => void {
    this.eventCbs.add(cb);
    this.api.postMessage({ type: 'subscribe' });
    return () => this.eventCbs.delete(cb);
  }
  onConnection(cb: (s: ConnState) => void): () => void {
    this.connCbs.add(cb);
    cb('live');
    return () => this.connCbs.delete(cb);
  }
  listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.rpc('listWorkspaces');
  }
  listSessions(wsId: string): Promise<SessionSummary[]> {
    return this.rpc('listSessions', { ws: wsId });
  }
  loadSession(wsId: string, sessionId: string, log = 'main.jsonl'): Promise<MeterEvent[]> {
    return this.rpc('loadSession', { ws: wsId, session: sessionId, log });
  }
  tailWorkspace(wsId: string): Promise<{ workspace?: string; log?: string }> {
    return this.rpc('tailWorkspace', { ws: wsId });
  }
  newSession(): Promise<void> {
    return this.rpc('newSession');
  }
  getWorkspaceAnalytics(wsId: string, timeWindowDays = 30): Promise<AnalyticsResult> {
    return this.rpc('getWorkspaceAnalytics', { ws: wsId, timeWindowDays });
  }
  checkSettings(): Promise<SettingStatus[]> {
    return this.rpc('checkSettings');
  }
  openSetting(key: string): Promise<void> {
    return this.rpc('openSetting', { key });
  }
  dispose(): void {
    window.removeEventListener('message', this.onMessage);
  }
}
