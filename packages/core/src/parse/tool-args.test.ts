import { describe, expect, it } from 'vitest';
import { normalizeTargetPath, parseToolArgs } from './tool-args.js';

const ROOTS = ['/Users/dev/proj'];

describe('parseToolArgs: the six real argument shapes', () => {
  it('read_file — clean JSON string with a line range', () => {
    const r = parseToolArgs(
      JSON.stringify({ filePath: '/Users/dev/proj/src/server.ts', startLine: 1, endLine: 80 }),
      'read_file',
      ROOTS,
    );
    expect(r.truncated).toBe(false);
    expect(r.targets).toEqual([
      { path: 'src/server.ts', intent: 'read', startLine: 1, endLine: 80 },
    ]);
  });

  it('read_file — truncated mid-JSON, path recovered by regex', () => {
    // Copilot caps large payloads; filePath is usually the first key, which is
    // why the fallback rescues most of them.
    const cut = '{"filePath":"/Users/dev/proj/src/big.ts","explanation":"reading the who';
    const r = parseToolArgs(cut, 'read_file', ROOTS);
    expect(r.truncated).toBe(true);
    expect(r.targets.map((t) => t.path)).toEqual(['src/big.ts']);
  });

  it('apply_patch — paths come from the patch envelope, not JSON keys', () => {
    const r = parseToolArgs(
      JSON.stringify({
        input: [
          '*** Begin Patch',
          '*** Update File: src/a.ts',
          '@@',
          '-old',
          '+new',
          '*** Add File: src/b.ts',
          '*** Delete File: src/c.ts',
          '*** End Patch',
        ].join('\n'),
      }),
      'apply_patch',
      ROOTS,
    );
    expect(r.targets.map((t) => t.path)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
    expect(r.targets.every((t) => t.intent === 'edit')).toBe(true);
  });

  it('multi_replace_string_in_file — every replacement target is captured', () => {
    const r = parseToolArgs(
      JSON.stringify({
        replacements: [
          { filePath: '/Users/dev/proj/src/a.ts', oldString: 'x', newString: 'y' },
          { filePath: '/Users/dev/proj/src/b.ts', oldString: 'p', newString: 'q' },
        ],
      }),
      'multi_replace_string_in_file',
      ROOTS,
    );
    expect(r.targets.map((t) => t.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('chatSessionResource is never a target', () => {
    const r = parseToolArgs(
      JSON.stringify({
        chatSessionResource: {
          $mid: 1,
          path: '/Users/dev/Library/.../chatSessions/abc.json',
          scheme: 'file',
        },
        todoList: [],
      }),
      'manage_todo_list',
      ROOTS,
    );
    expect(r.targets).toEqual([]);
  });

  it('run_in_terminal — no target, command captured as the query', () => {
    const r = parseToolArgs(
      JSON.stringify({ command: 'pnpm test --run', isBackground: false }),
      'run_in_terminal',
      ROOTS,
    );
    expect(r.targets).toEqual([]);
    expect(r.query).toBe('pnpm test --run');
  });
});

describe('parseToolArgs intent classification', () => {
  const cases: Array<[string, string]> = [
    ['read_file', 'read'],
    ['create_file', 'create'],
    ['replace_string_in_file', 'edit'],
    ['apply_patch', 'edit'],
    ['grep_search', 'search'],
    ['semantic_search', 'search'],
    ['list_code_usages', 'search'],
    ['run_in_terminal', 'exec'],
    ['get_terminal_output', 'exec'],
    ['manage_todo_list', 'meta'],
    ['some_new_tool', 'other'],
  ];
  for (const [tool, intent] of cases) {
    it(`${tool} → ${intent}`, () => {
      const r = parseToolArgs(JSON.stringify({ filePath: 'x.ts' }), tool, ROOTS);
      expect(r.targets[0]?.intent).toBe(intent);
    });
  }
});

describe('parseToolArgs query extraction', () => {
  it('picks up grep and semantic search queries', () => {
    expect(parseToolArgs('{"query":"startLiveTail"}', 'grep_search').query).toBe('startLiveTail');
    expect(parseToolArgs('{"query":"how is pricing done"}', 'semantic_search').query).toBe(
      'how is pricing done',
    );
  });

  it('caps a long command at 120 chars', () => {
    const long = `echo ${'a'.repeat(300)}`;
    expect(parseToolArgs(JSON.stringify({ command: long }), 'run_in_terminal').query).toHaveLength(
      120,
    );
  });
});

describe('parseToolArgs never throws', () => {
  for (const bad of [null, undefined, '', '{', 'not json at all', 42, [], {}]) {
    it(`survives ${JSON.stringify(bad)}`, () => {
      const r = parseToolArgs(bad, 'read_file', ROOTS);
      expect(Array.isArray(r.targets)).toBe(true);
      expect(typeof r.query).toBe('string');
    });
  }

  it('flags unparseable non-empty strings as truncated', () => {
    expect(parseToolArgs('{', 'read_file').truncated).toBe(true);
    expect(parseToolArgs('{"filePath":"a.ts"}', 'read_file').truncated).toBe(false);
  });

  it('de-duplicates the same file, widening the line range', () => {
    const r = parseToolArgs(
      JSON.stringify({
        replacements: [
          { filePath: 'src/a.ts', startLine: 40, endLine: 50 },
          { filePath: 'src/a.ts', startLine: 10, endLine: 90 },
        ],
      }),
      'multi_replace_string_in_file',
    );
    expect(r.targets).toEqual([{ path: 'src/a.ts', intent: 'edit', startLine: 10, endLine: 90 }]);
  });
});

describe('normalizeTargetPath', () => {
  it('makes a path repo-relative when a root matches', () => {
    expect(normalizeTargetPath('/Users/dev/proj/src/a.ts', ROOTS)).toBe('src/a.ts');
  });

  it('prefers the longest matching root', () => {
    const roots = ['/Users/dev', '/Users/dev/proj'];
    expect(normalizeTargetPath('/Users/dev/proj/src/a.ts', roots)).toBe('src/a.ts');
  });

  it('degrades an unmatched absolute path to its basename — never leaks a path', () => {
    expect(normalizeTargetPath('/etc/passwd', ROOTS)).toBe('passwd');
    expect(normalizeTargetPath('/Users/someone-else/secret/keys.txt', ROOTS)).toBe('keys.txt');
  });

  it('decodes file:// URIs', () => {
    expect(normalizeTargetPath('file:///Users/dev/proj/src/my%20file.ts', ROOTS)).toBe(
      'src/my file.ts',
    );
  });

  it('normalises Windows separators and drive letters', () => {
    expect(normalizeTargetPath('C:\\Users\\dev\\proj\\src\\a.ts', ['/C/Users/dev/proj'])).toBe(
      'src/a.ts',
    );
  });

  it('leaves an already-relative path alone', () => {
    expect(normalizeTargetPath('./src/a.ts')).toBe('src/a.ts');
    expect(normalizeTargetPath('src/a.ts')).toBe('src/a.ts');
  });
});
