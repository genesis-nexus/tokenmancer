// Discovery for Claude Code transcripts.
//
// Claude Code keys its history on the working directory, not on a VS Code
// workspaceStorage hash:
//
//   ~/.claude/projects/<slug>/<session-uuid>.jsonl          main transcript
//   ~/.claude/projects/<slug>/<session-uuid>/subagents/…    delegated agents
//
// `<slug>` is the absolute cwd with every '/' replaced by '-', which is lossy —
// a directory whose own name contains a dash is indistinguishable from a path
// separator. So the slug is never un-mangled by string surgery; the real cwd is
// read out of the transcript, which records it on every line.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { LogFormat } from '@cte/core';
import type { SessionInfo, WorkspaceInfo } from '../discover.js';

/** Root of Claude Code's per-project transcript store. */
export function claudeProjectsRoot(): string {
  const home = os.homedir();
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
  return path.join(base, 'projects');
}

/** Workspace ids are provider-prefixed so one id space serves both meters. */
export const CLAUDE_ID_PREFIX = 'claude:';

export function isClaudeWorkspaceId(id: string): boolean {
  return id.startsWith(CLAUDE_ID_PREFIX);
}

/**
 * Which dialect a log file on disk is written in, inferred from where it lives.
 * Lets `--tail <a-claude-transcript>` do the obvious thing without the caller
 * having to name the format.
 */
export function formatForLogPath(absFile: string): LogFormat {
  const root = path.resolve(claudeProjectsRoot());
  const p = path.resolve(absFile);
  return p === root || p.startsWith(root + path.sep) ? 'claude' : 'copilot';
}

function readJsonl(file: string, limit = 0): string[] {
  try {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    const kept = lines.filter((l) => l.trim());
    return limit > 0 ? kept.slice(0, limit) : kept;
  } catch {
    return [];
  }
}

function fieldOf(line: string, key: string): string {
  try {
    const v = (JSON.parse(line) as Record<string, unknown>)[key];
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

function tsOf(line: string): number | null {
  try {
    const raw = (JSON.parse(line) as Record<string, unknown>).timestamp;
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string') {
      const t = Date.parse(raw);
      return Number.isFinite(t) ? t : null;
    }
  } catch {
    // torn or non-JSON line
  }
  return null;
}

/** The cwd a transcript was recorded in, read from the file rather than the slug. */
function cwdOf(file: string): string {
  for (const line of readJsonl(file, 20)) {
    const cwd = fieldOf(line, 'cwd');
    if (cwd) return cwd;
  }
  return '';
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}
function fmtTime(d: Date): string {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function buildSession(id: string, dir: string, file: string): SessionInfo {
  const abs = path.join(dir, file);
  const lines = readJsonl(abs);
  let first: number | null = null;
  let last: number | null = null;
  for (const l of lines) {
    const t = tsOf(l);
    if (t == null) continue;
    if (first == null) first = t;
    last = t;
  }
  let mtime = Date.now();
  try {
    mtime = fs.statSync(abs).mtime.getTime();
  } catch {
    // unreadable — fall back to now
  }
  const start = new Date(first ?? mtime);
  const end = new Date(last ?? mtime);
  const dateStr = fmtDate(start);
  return {
    id,
    name: `${dateStr} ${fmtTime(start)} - ${fmtTime(end)}`,
    shortId: id.slice(0, 8),
    logDir: dir,
    logFiles: [file],
    events: lines.length,
    modified: new Date(mtime).toISOString(),
    startTime: start.toISOString(),
    endTime: end.toISOString(),
    dateStr,
    timeRange: `${fmtTime(start)} - ${fmtTime(end)}`,
  };
}

/**
 * Sessions in one project directory. Each `<uuid>.jsonl` is a session; the
 * sibling `<uuid>/` directory holds that session's subagent transcripts and is
 * deliberately not treated as a session of its own.
 */
export function discoverClaudeSessionsIn(projectDir: string): SessionInfo[] {
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SessionInfo[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    out.push(buildSession(e.name.replace(/\.jsonl$/, ''), projectDir, e.name));
  }
  return out.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

/** Subagent transcripts belonging to one session, with their spawn metadata. */
export interface SubagentLog {
  id: string;
  file: string;
  agentType: string;
  description: string;
  toolUseId: string;
  spawnDepth: number;
}

export function discoverSubagents(projectDir: string, sessionId: string): SubagentLog[] {
  const dir = path.join(projectDir, sessionId, 'subagents');
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }
  const out: SubagentLog[] = [];
  for (const file of entries) {
    const id = file.replace(/^agent-/, '').replace(/\.jsonl$/, '');
    let meta: Record<string, unknown> = {};
    try {
      meta = JSON.parse(fs.readFileSync(path.join(dir, `agent-${id}.meta.json`), 'utf8'));
    } catch {
      // A transcript without its sidecar is still worth metering.
    }
    out.push({
      id,
      file: path.join(dir, file),
      agentType: typeof meta.agentType === 'string' ? meta.agentType : 'agent',
      description: typeof meta.description === 'string' ? meta.description : '',
      toolUseId: typeof meta.toolUseId === 'string' ? meta.toolUseId : '',
      spawnDepth: typeof meta.spawnDepth === 'number' ? meta.spawnDepth : 1,
    });
  }
  return out;
}

/** Every project on this machine with Claude Code history. */
export function discoverClaudeWorkspaces(): WorkspaceInfo[] {
  const root = claudeProjectsRoot();
  let slugs: string[] = [];
  try {
    slugs = fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }

  const out: WorkspaceInfo[] = [];
  for (const slug of slugs) {
    const dir = path.join(root, slug);
    const sessions = discoverClaudeSessionsIn(dir);
    if (!sessions.length) continue;

    const newest = sessions[0];
    const folder = newest ? cwdOf(path.join(dir, newest.logFiles[0] ?? '')) : '';
    let modified = 0;
    for (const s of sessions) {
      const ms = new Date(s.modified).getTime();
      if (ms > modified) modified = ms;
    }
    const modDate = new Date(modified || Date.now());
    out.push({
      id: `${CLAUDE_ID_PREFIX}${slug}`,
      provider: 'claude',
      channel: 'Claude Code',
      storageRoot: root,
      debugLogsDir: dir,
      folder,
      folderName: folder ? path.basename(folder) : slug.replace(/^-/, '').replace(/-/g, '/'),
      isWorkspaceFile: false,
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
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

export function findClaudeWorkspace(wsId: string): WorkspaceInfo | undefined {
  return discoverClaudeWorkspaces().find((w) => w.id === wsId);
}
