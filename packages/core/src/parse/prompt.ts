function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Depth-first collect of human-readable text, preferring known payload keys. */
export function collectText(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === 'string') {
    const t = node.trim();
    if (t) out.push(t);
    return;
  }
  if (Array.isArray(node)) {
    for (const v of node) collectText(v, out);
    return;
  }
  if (isRecord(node)) {
    const preferred = ['text', 'content', 'prompt', 'message', 'userRequest'];
    for (const k of preferred) if (k in node) collectText(node[k], out);
    // Don't revisit the preferred keys — that would double-count the payload.
    for (const [k, v] of Object.entries(node)) if (!preferred.includes(k)) collectText(v, out);
  }
}

/** Parse a value that may be a JSON string; null if it isn't parseable JSON. */
export function maybeJsonParse(v: unknown): unknown {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t || !(t.startsWith('{') || t.startsWith('['))) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** Best-effort extraction of the user prompt text from a record, capped at 500 chars. */
export function extractPromptSnippet(rec: unknown): string {
  if (!isRecord(rec)) return '';
  const c: string[] = [];
  const attrs = isRecord(rec.attrs) ? rec.attrs : undefined;

  // Most Copilot debug logs store the user payload here.
  if (attrs?.userRequest !== undefined) {
    const parsed = maybeJsonParse(attrs.userRequest);
    if (parsed) collectText(parsed, c);
    else collectText(attrs.userRequest, c);
  }

  const fallbackFields: unknown[] = [
    attrs?.content,
    attrs?.prompt,
    attrs?.message,
    rec.request,
    rec.messages,
    rec.message,
    rec.prompt,
    rec.text,
    attrs?.args,
  ];
  for (const f of fallbackFields) {
    const parsed = maybeJsonParse(f);
    if (parsed) collectText(parsed, c);
    else collectText(f, c);
  }

  if (!c.length) return '';
  return c.join('\n').replace(/\s+/g, ' ').trim().slice(0, 500);
}
