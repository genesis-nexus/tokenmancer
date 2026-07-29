/**
 * Pull top-level JSON objects out of a chunk of text. Handles both true jsonl
 * (one object per line) and pretty-printed multi-line pastes, using a
 * string-aware brace scanner so braces inside string literals don't confuse it.
 */
export function extractObjects(text: string): unknown[] {
  const objs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0 && start >= 0) {
        try {
          objs.push(JSON.parse(text.slice(start, i + 1)));
        } catch {
          // partial / malformed object — skip, keep scanning
        }
        start = -1;
      }
    }
  }
  return objs;
}
