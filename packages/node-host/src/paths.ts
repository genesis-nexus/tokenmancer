// Where Tokenmancer keeps state, and the two write primitives everything else
// uses. Kept deliberately tiny: no new dependencies, and every write is either
// an O_APPEND append or a same-directory atomic rename.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * State root, in precedence order:
 *   TOKENMANCER_HOME > $XDG_STATE_HOME/tokenmancer > ~/.tokenmancer
 *
 * TOKENMANCER_HOME is what the tests point at a tmpdir, so nothing ever touches
 * a developer's real state.
 */
export function tokenmancerHome(): string {
  const explicit = process.env.TOKENMANCER_HOME;
  if (explicit?.trim()) return path.resolve(explicit);
  const xdg = process.env.XDG_STATE_HOME;
  if (xdg?.trim()) return path.join(path.resolve(xdg), 'tokenmancer');
  return path.join(os.homedir(), '.tokenmancer');
}

export function configPath(): string {
  return path.join(tokenmancerHome(), 'config.json');
}

export function stateDir(): string {
  return path.join(tokenmancerHome(), 'state');
}

export function cacheDir(): string {
  return path.join(stateDir(), 'cache');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** Parse a JSON file, returning `fallback` for missing, empty or corrupt files. */
export function readJsonSafe<T>(file: string, fallback: T): T {
  try {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.trim()) return fallback;
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

/**
 * Write JSON so a reader never observes a half-written file: write a sibling
 * temp, flush it, then rename. Same-directory rename is atomic on POSIX and
 * NTFS alike, which is why the temp must not go to os.tmpdir().
 */
export function atomicWriteJson(file: string, value: unknown): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/**
 * Append one line. Opening with 'a' gives an O_APPEND write, which the OS
 * serialises — so the web app and the extension can both be tailing the same
 * Copilot log without interleaving each other's ledger lines. Lines are ~200
 * bytes, well under the 4 KB PIPE_BUF atomicity guarantee.
 */
export function appendLine(file: string, line: string): void {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, `${line}\n`, { encoding: 'utf8' });
}
