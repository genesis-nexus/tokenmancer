import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { type LogFormat, type ProviderId, extractObjects } from '@cte/core';
import {
  discoverClaudeSessionsIn,
  discoverClaudeWorkspaces,
  isClaudeWorkspaceId,
} from './sources/claude.js';

export interface SessionInfo {
  id: string;
  name: string;
  shortId: string;
  logDir: string;
  logFiles: string[];
  events: number;
  modified: string;
  startTime: string;
  endTime: string;
  dateStr: string;
  timeRange: string;
}

export interface WorkspaceInfo {
  id: string;
  /** Which meter this workspace's logs feed. */
  provider: ProviderId;
  channel: string;
  storageRoot: string;
  debugLogsDir: string;
  folder: string;
  folderName: string;
  isWorkspaceFile: boolean;
  sessionCount: number;
  modified: string;
  modifiedStr: string;
}

/** OS-specific VS Code / Cursor / VSCodium workspaceStorage roots that exist. */
export function vsCodeStorageRoots(): string[] {
  const home = os.homedir();
  const channels = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor'];
  const bases: string[] = [];
  if (process.platform === 'darwin') {
    for (const c of channels)
      bases.push(path.join(home, 'Library', 'Application Support', c, 'User', 'workspaceStorage'));
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const c of channels) bases.push(path.join(appdata, c, 'User', 'workspaceStorage'));
  } else {
    const config = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const c of channels) bases.push(path.join(config, c, 'User', 'workspaceStorage'));
  }
  return bases.filter((p) => {
    try {
      return fs.existsSync(p) && fs.statSync(p).isDirectory();
    } catch {
      return false;
    }
  });
}

interface WorkspaceMeta {
  folder: string;
  folderName: string;
  isWorkspaceFile: boolean;
}

/** Parse <hash>/workspace.json to recover the human folder name. */
export function readWorkspaceMeta(hashDir: string): WorkspaceMeta {
  try {
    const p = path.join(hashDir, 'workspace.json');
    if (!fs.existsSync(p)) return { folder: '', folderName: '', isWorkspaceFile: false };
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as { folder?: string; workspace?: string };
    const uri = j.folder || j.workspace || '';
    let folder = uri;
    try {
      folder = decodeURIComponent(String(uri).replace(/^file:\/\//, ''));
    } catch {
      // keep raw uri
    }
    // file:///C:/Users/... decodes to "/C:/Users/..." — strip the leading
    // slash before a Windows drive letter so it's a real, resolvable path.
    folder = folder.replace(/^\/([a-zA-Z]:)/, '$1');
    const folderName = folder ? path.basename(folder.replace(/[\\/]$/, '')) : '';
    return { folder, folderName, isWorkspaceFile: !!j.workspace };
  } catch {
    return { folder: '', folderName: '', isWorkspaceFile: false };
  }
}

function firstLastTs(lines: string[]): { first: number | null; last: number | null } {
  let first: number | null = null;
  let last: number | null = null;
  for (let i = 0; i < lines.length && first == null; i++) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const o = extractObjects(line)[0] as { ts?: unknown } | undefined;
    if (o && typeof o.ts === 'number') first = o.ts;
  }
  for (let i = lines.length - 1; i >= 0 && last == null; i--) {
    const line = lines[i];
    if (!line?.trim()) continue;
    const o = extractObjects(line)[0] as { ts?: unknown } | undefined;
    if (o && typeof o.ts === 'number') last = o.ts;
  }
  return { first, last };
}

function orderLogs(arr: string[]): string[] {
  return [...arr].sort((a, b) =>
    a === 'main.jsonl' ? -1 : b === 'main.jsonl' ? 1 : a.localeCompare(b),
  );
}

function buildSession(id: string, logDir: string, logFiles: string[]): SessionInfo {
  const primary = logFiles[0] ?? 'main.jsonl';
  const mainPath = path.join(logDir, primary);
  let eventCount = 0;
  let first: number | null = null;
  let last: number | null = null;
  try {
    const lines = fs
      .readFileSync(mainPath, 'utf8')
      .split('\n')
      .filter((l) => l.trim());
    eventCount = lines.length;
    const t = firstLastTs(lines);
    first = t.first;
    last = t.last;
  } catch {
    // unreadable log — leave zeros
  }
  let mtime = Date.now();
  try {
    mtime = fs.statSync(mainPath).mtime.getTime();
  } catch {
    // ignore
  }
  const start = new Date(first || mtime);
  const end = new Date(last || mtime);
  const dateStr = start.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: '2-digit',
  });
  const t = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  return {
    id,
    name: `${dateStr} ${t(start)} - ${t(end)}`,
    shortId: String(id).slice(0, 8),
    logDir,
    logFiles,
    events: eventCount,
    modified: new Date(mtime).toISOString(),
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    dateStr,
    timeRange: `${t(start)} - ${t(end)}`,
  };
}

/** Sessions inside one debug-logs dir. Handles the flat layout (main.jsonl in
 *  the dir) and the per-session-subdirectory layout. */
export function discoverSessionsIn(debugLogsDir: string): SessionInfo[] {
  const dir = path.resolve(debugLogsDir);
  const sessions: SessionInfo[] = [];
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return sessions;
  }

  const flat = entries.filter((e) => e.isFile() && e.name.endsWith('.jsonl')).map((e) => e.name);
  if (flat.length) sessions.push(buildSession('main', dir, orderLogs(flat)));

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sdir = path.join(dir, ent.name);
    let files: string[] = [];
    try {
      files = fs.readdirSync(sdir).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    if (!files.length) continue;
    sessions.push(buildSession(ent.name, sdir, orderLogs(files)));
  }
  return sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

/** Every VS Code / Cursor workspace on this machine that has Copilot debug logs. */
export function discoverCopilotWorkspaces(): WorkspaceInfo[] {
  const out: WorkspaceInfo[] = [];
  for (const root of vsCodeStorageRoots()) {
    const channel = path.basename(path.dirname(path.dirname(root)));
    let hashes: string[] = [];
    try {
      hashes = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const hash of hashes) {
      const hashDir = path.join(root, hash);
      const debugLogsDir = path.join(hashDir, 'GitHub.copilot-chat', 'debug-logs');
      if (!fs.existsSync(debugLogsDir)) continue;
      let sessions: SessionInfo[] = [];
      try {
        sessions = discoverSessionsIn(debugLogsDir);
      } catch {
        sessions = [];
      }
      if (!sessions.length) continue;
      const meta = readWorkspaceMeta(hashDir);
      let modified = 0;
      for (const s of sessions) {
        const ms = new Date(s.modified).getTime();
        if (ms > modified) modified = ms;
      }
      const modDate = new Date(modified || Date.now());
      out.push({
        id: hash,
        provider: 'copilot',
        channel,
        storageRoot: root,
        debugLogsDir,
        folder: meta.folder,
        folderName: meta.folderName || hash.slice(0, 8),
        isWorkspaceFile: meta.isWorkspaceFile,
        sessionCount: sessions.length,
        modified: modDate.toISOString(),
        modifiedStr: modDate.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          year: '2-digit',
          hour: '2-digit',
          minute: '2-digit',
        }),
      });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

/**
 * Every metered workspace on this machine, across both providers.
 *
 * Copilot and Claude Code are listed as separate entries even when they point at
 * the same folder: they are genuinely two different histories with two different
 * session lists, and merging them here would force every id-keyed caller below to
 * learn about providers. The UI groups them by `folder` for display instead.
 */
export function discoverWorkspaces(): WorkspaceInfo[] {
  return [...discoverCopilotWorkspaces(), ...discoverClaudeWorkspaces()].sort((a, b) =>
    b.modified.localeCompare(a.modified),
  );
}

export function findWorkspace(wsId: string): WorkspaceInfo | undefined {
  return discoverWorkspaces().find((w) => w.id === wsId);
}

/** The transcript dialect a workspace's logs are written in. */
export function formatForWorkspace(wsId: string): LogFormat {
  return isClaudeWorkspaceId(wsId) ? 'claude' : 'copilot';
}

/** Sessions for a workspace, dispatched on the layout its provider uses. */
export function sessionsForWorkspace(ws: WorkspaceInfo): SessionInfo[] {
  return ws.provider === 'claude'
    ? discoverClaudeSessionsIn(ws.debugLogsDir)
    : discoverSessionsIn(ws.debugLogsDir);
}

export function resolveWorkspaceSessions(
  wsId: string,
): { ws: WorkspaceInfo; sessions: SessionInfo[] } | null {
  const ws = findWorkspace(wsId);
  if (!ws) return null;
  return { ws, sessions: sessionsForWorkspace(ws) };
}

/** A log file name must be a bare `*.jsonl` — no path separators or traversal. */
export function isSafeLogFileName(name: string): boolean {
  return (
    !!name &&
    name.endsWith('.jsonl') &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    !path.isAbsolute(name)
  );
}

/** True if `abs` resolves inside `root` (symlink-aware). */
export function isContained(abs: string, root: string): boolean {
  try {
    const a = fs.realpathSync(abs);
    const r = fs.realpathSync(root);
    return a === r || a.startsWith(r + path.sep);
  } catch {
    return false;
  }
}

/**
 * Resolve (workspace, session, logFile) → absolute path, hardened against path
 * traversal: the file name must be a bare `.jsonl`, must belong to the session's
 * known files, and the realpath must stay inside the workspace debug-logs dir.
 */
export function resolveLogPath(wsId: string, sessionId: string, logFile: string): string | null {
  if (!isSafeLogFileName(logFile)) return null;
  const r = resolveWorkspaceSessions(wsId);
  if (!r) return null;
  const s = r.sessions.find((x) => x.id === sessionId);
  if (!s || !s.logFiles.includes(logFile)) return null;
  const abs = path.resolve(path.join(s.logDir, logFile));
  if (!isContained(abs, r.ws.debugLogsDir)) return null;
  return abs;
}
