// Recover *what a tool touched* from a tool_call record's `attrs.args`.
//
// Why this is its own module rather than more keys in harvest.ts: `attrs.args`
// is always a JSON **string**, so harvest's recursive descent never sees inside
// it, and harvest's "first occurrence of any alias wins" rule is exactly wrong
// here — a multi-file edit has many paths and we want all of them.
//
// Measured against every tool_call in the Copilot logs on this machine:
//   * 456/456 have attrs.args as a string
//   * 441 parse cleanly; 15 are truncated mid-JSON by Copilot's payload cap
//   * 226 (50%) yield a path. The rest are genuinely pathless — run_in_terminal,
//     manage_todo_list, kill_terminal — and must yield [] rather than a guess.

/** What the tool did to its targets. Coarser than StepKind, and about intent. */
export type ToolIntent = 'read' | 'edit' | 'create' | 'search' | 'exec' | 'meta' | 'other';

export interface ToolTarget {
  /** Repo-relative when a root matched, else the basename. Never absolute. */
  path: string;
  intent: ToolIntent;
  /** 0 when the tool read the whole file — the signal the sprawl detector wants. */
  startLine: number;
  endLine: number;
}

export interface ParsedToolArgs {
  targets: ToolTarget[];
  /**
   * What the tool did, derived from its name — so it survives the half of all
   * tool calls that have no path at all (run_in_terminal, manage_todo_list).
   */
  intent: ToolIntent;
  /** Search query or command head. The sensitive field — redacted with prompts. */
  query: string;
  /** True when args were cut off mid-JSON and paths came from the regex fallback. */
  truncated: boolean;
}

/** Keys that hold a single file path. */
const PATH_KEYS = ['filePath', 'path', 'file', 'uri', 'fsPath'];

/**
 * Keys that look like paths but are not. `chatSessionResource` is a VS Code
 * `$mid` URI object pointing at the chat session itself; letting it through
 * would put a phantom entry at the top of every file-cost table.
 */
const NOT_A_TARGET = new Set(['chatSessionResource', 'pageId', 'id', 'sessionId', 'toolCallId']);

const QUERY_KEYS = ['query', 'command', 'pattern', 'searchText', 'prompt'];

/** Recovers `"filePath": "..."` from JSON that was cut off before it closed. */
const PATH_RE = /"(?:filePath|path|file|uri|fsPath)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;

/** apply_patch envelopes: `*** Update File: src/x.ts` */
const PATCH_RE = /^\*\*\*\s+(?:Update|Add|Delete)\s+File:\s*(.+)$/gm;

const MAX_QUERY = 120;
const MAX_TARGETS = 32;

function intentFor(toolName: string): ToolIntent {
  const s = toolName.toLowerCase().replace(/[-_\s]/g, '');
  if (/^(createfile|createdirectory|newfile)/.test(s)) return 'create';
  if (/replacestring|applypatch|insertedit|editfile|editnotebook|multireplace/.test(s))
    return 'edit';
  if (/readfile|readnotebook|openfile|getfile/.test(s)) return 'read';
  if (/search|grep|usages|findfiles|findtext/.test(s)) return 'search';
  if (/terminal|runtask|runtest|runcommand|execute/.test(s)) return 'exec';
  if (/todo|memory|think|plan|fetch|websearch/.test(s)) return 'meta';
  return 'other';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Normalise a raw path to something safe to report: forward slashes, no scheme,
 * and repo-relative when one of `roots` contains it. A path that matches no root
 * degrades to its basename rather than leaking an absolute path — the redaction
 * layer can then drop it entirely if `showPaths` is off.
 */
/** Backslashes to forward slashes, and `C:/`/`/c:/` drive letters to `/c/`,
 *  folding the letter's case — it's a case-insensitive drive label, not a
 *  filesystem name — so a Windows target path and a Windows repo root
 *  compare on equal footing regardless of which API produced each string. */
function normalizeSlashesAndDrive(s: string): string {
  return s
    .replace(/\\/g, '/')
    .replace(/\/{2,}/g, '/')
    .replace(/^\/?([a-zA-Z]):\//, (_, d: string) => `/${d.toLowerCase()}/`);
}

export function normalizeTargetPath(raw: string, roots: readonly string[] = []): string {
  let p = raw.trim();
  if (!p) return '';
  // file:///Users/x/y → /Users/x/y
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) {
    p = p.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '/');
    try {
      p = decodeURIComponent(p);
    } catch {
      // keep the encoded form rather than dropping the target
    }
  }
  p = normalizeSlashesAndDrive(p);

  let best = '';
  for (const root of roots) {
    if (!root) continue;
    const r = `${normalizeSlashesAndDrive(root).replace(/\/+$/, '')}/`;
    if (p.startsWith(r) && r.length > best.length) best = r;
  }
  if (best) return p.slice(best.length);

  if (p.startsWith('/')) {
    // No root matched — keep only the basename so nothing absolute escapes.
    const parts = p.split('/');
    return parts[parts.length - 1] ?? '';
  }
  return p.replace(/^\.\//, '');
}

function pushTarget(
  out: ToolTarget[],
  raw: unknown,
  intent: ToolIntent,
  roots: readonly string[],
  startLine = 0,
  endLine = 0,
): void {
  if (typeof raw !== 'string') return;
  const path = normalizeTargetPath(raw, roots);
  if (!path || out.length >= MAX_TARGETS) return;
  const dup = out.find((t) => t.path === path);
  if (dup) {
    // Widen the range rather than listing the same file twice.
    if (startLine && (!dup.startLine || startLine < dup.startLine)) dup.startLine = startLine;
    if (endLine > dup.endLine) dup.endLine = endLine;
    return;
  }
  out.push({ path, intent, startLine, endLine });
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

function collectFromObject(
  obj: Record<string, unknown>,
  intent: ToolIntent,
  roots: readonly string[],
  out: ToolTarget[],
): void {
  const startLine = num(obj.startLine ?? obj.startLineNumber);
  const endLine = num(obj.endLine ?? obj.endLineNumber);

  for (const key of PATH_KEYS) {
    const v = obj[key];
    if (typeof v === 'string') {
      pushTarget(out, v, intent, roots, startLine, endLine);
      break; // one path per object level; nested objects get their own pass
    }
  }

  // multi_replace_string_in_file.replacements[], and any similar array of edits.
  for (const [key, v] of Object.entries(obj)) {
    if (NOT_A_TARGET.has(key)) continue;
    if (Array.isArray(v)) {
      for (const item of v) if (isRecord(item)) collectFromObject(item, intent, roots, out);
    } else if (isRecord(v)) {
      collectFromObject(v, intent, roots, out);
    }
  }
}

function firstQuery(obj: Record<string, unknown>): string {
  for (const key of QUERY_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, MAX_QUERY);
  }
  return '';
}

/**
 * Extract the file targets and the query/command from a tool call's arguments.
 *
 * Never throws: malformed, truncated and missing args all degrade to a best
 * effort, because a parser that dies on one odd record loses the whole tail.
 */
export function parseToolArgs(
  rawArgs: unknown,
  toolName: string,
  roots: readonly string[] = [],
): ParsedToolArgs {
  const intent = intentFor(toolName);
  const targets: ToolTarget[] = [];
  let query = '';
  let truncated = false;

  if (rawArgs == null) return { targets, intent, query, truncated };

  let parsed: unknown = rawArgs;
  let text = '';

  if (typeof rawArgs === 'string') {
    text = rawArgs;
    try {
      parsed = JSON.parse(rawArgs);
    } catch {
      parsed = null;
      truncated = true;
    }
  }

  if (isRecord(parsed)) {
    collectFromObject(parsed, intent, roots, targets);
    query = firstQuery(parsed);
    // apply_patch carries its paths inside a patch envelope, not as JSON keys.
    const patchBody = typeof parsed.input === 'string' ? parsed.input : '';
    if (patchBody) {
      for (const m of patchBody.matchAll(PATCH_RE)) {
        pushTarget(targets, m[1], intent, roots);
      }
    }
  } else if (truncated && text) {
    // Cut off mid-JSON: recover whatever path keys survived. `filePath` is
    // usually the first key, so this rescues most of them.
    for (const m of text.matchAll(PATH_RE)) pushTarget(targets, m[1], intent, roots);
    for (const m of text.matchAll(PATCH_RE)) pushTarget(targets, m[1], intent, roots);
  }

  return { targets, intent, query, truncated };
}
