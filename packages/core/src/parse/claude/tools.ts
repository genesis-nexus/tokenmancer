// Claude Code's tools are a closed, PascalCase set, so they map exactly rather
// than through the regex guessing `classifyStep` has to do for Copilot's log.
// Getting this table right is what makes "which tool spent my money" honest.

import type { StepKind } from '../../contract/events.js';
import { type ToolIntent, normalizeTargetPath } from '../tool-args.js';

const INTENTS: Record<string, ToolIntent> = {
  Read: 'read',
  NotebookRead: 'read',
  Edit: 'edit',
  MultiEdit: 'edit',
  NotebookEdit: 'edit',
  Write: 'create',
  Glob: 'search',
  Grep: 'search',
  ToolSearch: 'search',
  Bash: 'exec',
  BashOutput: 'exec',
  KillShell: 'exec',
  TodoWrite: 'meta',
  AskUserQuestion: 'meta',
  ExitPlanMode: 'meta',
  Skill: 'meta',
  Agent: 'meta',
  Task: 'meta',
  WebFetch: 'other',
  WebSearch: 'other',
};

const KINDS: Record<ToolIntent, StepKind> = {
  read: 'read',
  edit: 'edit',
  create: 'edit',
  search: 'search',
  exec: 'verify',
  meta: 'plan',
  other: 'tool',
};

/** MCP tools arrive as `mcp__server__tool`; treat the whole family as external. */
export function claudeToolIntent(name: string): ToolIntent {
  if (name.startsWith('mcp__')) return 'other';
  return INTENTS[name] ?? 'other';
}

export function claudeStepKind(intent: ToolIntent): StepKind {
  return KINDS[intent];
}

function firstString(input: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v;
  }
  return '';
}

const PATH_KEYS = ['file_path', 'notebook_path', 'filePath', 'path'] as const;

/** Repo-relative paths a tool call touched, taken from its declared input. */
export function claudeTargets(
  input: Record<string, unknown> | undefined,
  roots: readonly string[],
): string[] {
  if (!input) return [];
  const out: string[] = [];
  const one = firstString(input, PATH_KEYS);
  if (one) {
    const p = normalizeTargetPath(one, roots);
    if (p) out.push(p);
  }
  // Edit-family tools can carry a batch of edits, each naming its own file.
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const e of edits) {
      if (typeof e !== 'object' || e === null) continue;
      const p = firstString(e as Record<string, unknown>, PATH_KEYS);
      if (!p) continue;
      const n = normalizeTargetPath(p, roots);
      if (n && !out.includes(n)) out.push(n);
    }
  }
  return out;
}

const QUERY_KEYS = ['command', 'pattern', 'query', 'url', 'prompt', 'description'] as const;

/** Cap matches parse/tool-args, so one redaction rule covers both formats. */
const MAX_QUERY = 120;

/**
 * The searchable/executable part of a tool call. Held to the same stricter
 * privacy switch as Copilot's: a command line is where a token gets pasted.
 */
export function claudeToolQuery(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const q = firstString(input, QUERY_KEYS);
  return q.length > MAX_QUERY ? `${q.slice(0, MAX_QUERY)}…` : q;
}
