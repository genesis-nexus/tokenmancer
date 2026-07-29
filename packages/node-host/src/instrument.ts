import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type InstructionAccumulator,
  type InstructionFile,
  countTokens,
  repoRootsFromFolders,
} from '@cte/core';

/**
 * Best-effort: read the always-in-context + loaded instruction files off disk to
 * estimate how many tokens ride along on every model call. Uses the real o200k
 * tokenizer (the old server used a chars/4 estimate). Mutates the accumulator.
 * This is the ONLY fs-touching part of the instruction feature — the parsing of
 * the log's instruction telemetry stays runtime-agnostic in `@cte/core`.
 */
export function measureInstructionFiles(s: InstructionAccumulator): void {
  const files: InstructionFile[] = [];
  const seen = new Set<string>();
  const tryRead = (p: string, name: string, kind: string): boolean => {
    try {
      const abs = path.resolve(p);
      if (seen.has(abs)) return true;
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const c = fs.readFileSync(abs, 'utf8');
        files.push({ name, kind, bytes: c.length, tokens: countTokens(c) });
        seen.add(abs);
        return true;
      }
    } catch {
      // unreadable — skip
    }
    return false;
  };

  const roots = repoRootsFromFolders(s.folders);
  for (const f of s.contextIncluded) {
    const cands: string[] = [];
    for (const r of roots) cands.push(path.join(r, f), path.join(r, '.github', f));
    cands.some((p) => tryRead(p, f, 'context'));
  }
  for (const name of s.loaded) {
    const fname = /\.md$/i.test(name) ? name : `${name}.instructions.md`;
    s.folders.some((folder) => tryRead(path.join(folder, fname), fname, 'loaded'));
  }

  s.files = files;
  s.totalBytes = files.reduce((a, f) => a + f.bytes, 0);
  s.totalTokens = files.reduce((a, f) => a + f.tokens, 0);
}
