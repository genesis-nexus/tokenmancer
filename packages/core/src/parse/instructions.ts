import type { InstructionFile } from '../contract/events.js';

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Mutable running state while scanning a log for instruction telemetry. File
 *  measurement (bytes/tokens) is filled in by the Node host, not here. */
export interface InstructionAccumulator {
  resolvedCount: number;
  discoveryMs: number | null;
  loaded: string[];
  folders: string[];
  contextIncluded: string[];
  onDemand: { instructions: string[]; skills: string[]; agents: string[] };
  files: InstructionFile[];
  totalBytes: number;
  totalTokens: number;
  ts: number;
}

export function newInstructionAccumulator(): InstructionAccumulator {
  return {
    resolvedCount: 0,
    discoveryMs: null,
    loaded: [],
    folders: [],
    contextIncluded: [],
    onDemand: { instructions: [], skills: [], agents: [] },
    files: [],
    totalBytes: 0,
    totalTokens: 0,
    ts: 0,
  };
}

export function isInstructionRecord(rec: unknown): boolean {
  if (!isRecord(rec)) return false;
  const n = String(rec.name ?? '');
  return (
    (rec.type === 'discovery' && /instruction/i.test(n)) ||
    (rec.type === 'generic' && /custom instructions/i.test(n))
  );
}

function splitList(s: unknown): string[] {
  return String(s ?? '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

function uniqMerge(a: string[], b: string[]): string[] {
  return [...new Set([...a, ...b])];
}

/** Scrape the free-text `details` summary of an instruction record. */
export function parseInstructions(
  rec: unknown,
  prev?: InstructionAccumulator,
): InstructionAccumulator {
  const s = prev ?? newInstructionAccumulator();
  if (!isRecord(rec)) return s;
  const recTs = typeof rec.ts === 'number' ? rec.ts : s.ts;
  s.ts = recTs || Date.now();
  const attrs = isRecord(rec.attrs) ? rec.attrs : undefined;
  const d = attrs?.details;
  if (typeof d !== 'string') return s;

  const mRes = d.match(/Resolved\s+(\d+)\s+instructions(?:\s+in\s+([\d.]+)ms)?/i);
  if (mRes?.[1]) {
    s.resolvedCount = Math.max(s.resolvedCount, +mRes[1]);
    if (mRes[2]) s.discoveryMs = +mRes[2];
  }
  const mLoaded = d.match(/loaded:\s*\[([^\]]*)\]/i);
  if (mLoaded?.[1] !== undefined) s.loaded = uniqMerge(s.loaded, splitList(mLoaded[1]));
  const mFolders = d.match(/folders:\s*\[([^\]]*)\]/i);
  if (mFolders?.[1] !== undefined) s.folders = uniqMerge(s.folders, splitList(mFolders[1]));
  const mCtx = d.match(/context included:\s*\[(\d+)\]\s*([^\n]*)/i);
  if (mCtx?.[2] !== undefined) s.contextIncluded = uniqMerge(s.contextIncluded, splitList(mCtx[2]));
  const mInstr = d.match(/(?:^|\n)\s*instructions:\s*\[(\d+)\]\s*([^\n]*)/i);
  if (mInstr?.[2] !== undefined)
    s.onDemand.instructions = uniqMerge(s.onDemand.instructions, splitList(mInstr[2]));
  const mSkills = d.match(/skills:\s*\[(\d+)\]\s*([^\n]*)/i);
  if (mSkills?.[2] !== undefined)
    s.onDemand.skills = uniqMerge(s.onDemand.skills, splitList(mSkills[2]));
  const mAgents = d.match(/agents:\s*\[(\d+)\]\s*([^\n]*)/i);
  if (mAgents?.[2] !== undefined)
    s.onDemand.agents = uniqMerge(s.onDemand.agents, splitList(mAgents[2]));
  return s;
}

/** Derive candidate repo roots by stripping known instruction-folder suffixes. */
export function repoRootsFromFolders(folders: string[]): string[] {
  const roots = new Set<string>();
  for (const f of folders) {
    const r = f.replace(
      /[\\/](\.github[\\/]instructions|\.claude[\\/]rules|\.copilot[\\/]instructions|\.github)[\\/]?$/i,
      '',
    );
    if (r && r !== f) roots.add(r);
  }
  return [...roots];
}
