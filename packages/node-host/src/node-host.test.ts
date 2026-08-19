import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MeterEvent, StepEvent } from '@cte/core';
import { newInstructionAccumulator } from '@cte/core';
import { afterAll, describe, expect, it } from 'vitest';
import {
  discoverSessionsIn,
  isContained,
  isSafeLogFileName,
  readWorkspaceMeta,
  resolveLogPath,
} from './discover.js';
import { watchInbox } from './inbox.js';
import { measureInstructionFiles } from './instrument.js';
import { loadLogFile } from './load.js';
import { startLiveTail } from './tail.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-nh-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const steps = (evs: MeterEvent[]): StepEvent[] =>
  evs.filter((e): e is StepEvent => e.kind === 'step');

const LOG_LINES = [
  '{"type":"user_message","sid":"s1","spanId":"p1","ts":1000,"attrs":{"userRequest":"Do the thing"}}',
  '{"type":"request","sid":"s1","spanId":"r1","parentSpanId":"p1","ts":1001,"model":"claude-sonnet-4.6","prompt_tokens":1000,"completion_tokens":100}',
];

function makeDebugLogs(): string {
  const dir = path.join(tmp, 'GitHub.copilot-chat', 'debug-logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.jsonl'), `${LOG_LINES.join('\n')}\n`);
  return dir;
}

describe('discoverSessionsIn', () => {
  it('finds a flat main.jsonl session with a real event count', () => {
    const dir = makeDebugLogs();
    const sessions = discoverSessionsIn(dir);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.id).toBe('main');
    expect(sessions[0]?.logFiles).toContain('main.jsonl');
    expect(sessions[0]?.events).toBe(2);
  });
});

describe('readWorkspaceMeta', () => {
  function withWorkspaceJson(folder: string): string {
    const dir = fs.mkdtempSync(path.join(tmp, 'wsmeta-'));
    fs.writeFileSync(path.join(dir, 'workspace.json'), JSON.stringify({ folder }));
    return dir;
  }

  it('decodes a macOS/Linux file:// URI as-is', () => {
    const dir = withWorkspaceJson('file:///Users/dev/my-project');
    const meta = readWorkspaceMeta(dir);
    expect(meta.folder).toBe('/Users/dev/my-project');
    expect(meta.folderName).toBe('my-project');
  });

  it('strips the leading slash VS Code puts before a Windows drive letter', () => {
    // What VS Code actually writes for C:\Users\dev\my-project.
    const dir = withWorkspaceJson('file:///c%3A/Users/dev/my-project');
    const meta = readWorkspaceMeta(dir);
    expect(meta.folder).toBe('c:/Users/dev/my-project');
    expect(meta.folderName).toBe('my-project');
  });
});

describe('loadLogFile (archive) routes through the funnel', () => {
  it('produces grouped, prompt-carrying steps', () => {
    const dir = makeDebugLogs();
    const evs = loadLogFile(path.join(dir, 'main.jsonl'), { sessionId: 'sess-x' });
    const s = steps(evs);
    expect(s).toHaveLength(1);
    expect(s[0]?.groupId).toBe('p1');
    expect(s[0]?.userPrompt).toBe('Do the thing');
    expect(s[0]?.sessionId).toBe('sess-x');
    expect(s[0]?.aic).toBeCloseTo(0.45, 6);
  });

  it('makes tool targets repo-relative when the workspace folder is known', () => {
    const dir = path.join(tmp, 'roots', 'GitHub.copilot-chat', 'debug-logs');
    fs.mkdirSync(dir, { recursive: true });
    const repo = '/Users/dev/myproj';
    fs.writeFileSync(
      path.join(dir, 'main.jsonl'),
      `${[
        '{"type":"user_message","sid":"s1","spanId":"p1","ts":1000,"attrs":{"userRequest":"go"}}',
        JSON.stringify({
          type: 'tool_call',
          sid: 's1',
          spanId: 't1',
          parentSpanId: 'p1',
          ts: 1001,
          name: 'read_file',
          attrs: { args: JSON.stringify({ filePath: `${repo}/src/server.ts` }) },
        }),
      ].join('\n')}\n`,
    );

    // Without a root, the path degrades to a basename so nothing absolute leaks.
    const bare = steps(loadLogFile(path.join(dir, 'main.jsonl'), {}));
    expect(bare[0]?.targets).toEqual(['server.ts']);

    // With the workspace folder, it becomes the repo-relative path the
    // file-cost report needs to tell two server.ts files apart.
    const rooted = steps(loadLogFile(path.join(dir, 'main.jsonl'), { repoRoots: [repo] }));
    expect(rooted[0]?.targets).toEqual(['src/server.ts']);
    expect(rooted[0]?.toolIntent).toBe('read');
  });
});

describe('startLiveTail preload', () => {
  it('emits grouped steps for the recent lines, then stops cleanly', () => {
    const dir = makeDebugLogs();
    const got: MeterEvent[] = [];
    const tail = startLiveTail(path.join(dir, 'main.jsonl'), { emit: (e) => got.push(e) });
    tail.stop();
    const s = steps(got);
    expect(s).toHaveLength(1);
    expect(s[0]?.userPrompt).toBe('Do the thing');
  });
});

describe('watchInbox (bug fix)', () => {
  it('emits a GROUPED step through processRecord (not a bare ungrouped event)', () => {
    const inbox = path.join(tmp, 'inbox.jsonl');
    fs.writeFileSync(
      inbox,
      '{"type":"request","sid":"s2","spanId":"r9","model":"gpt-5-mini","prompt_tokens":500,"completion_tokens":50,"total_nano_aiu":100000000}\n',
    );
    const got: MeterEvent[] = [];
    const ctl = watchInbox(inbox, { emit: (e) => got.push(e) });
    ctl.stop();
    const s = steps(got);
    expect(s).toHaveLength(1);
    // The old inbox path left these undefined/ungrouped — the fix guarantees them.
    expect(s[0]?.promptGroupIndex).toBe(1);
    expect(s[0]?.stepIndex).toBe(1);
    expect(typeof s[0]?.userPrompt).toBe('string');
    expect(s[0]?.aic).toBeCloseTo(0.1, 6); // exact nano-AIU
    expect(s[0]?.exact).toBe(true);
  });
});

describe('measureInstructionFiles', () => {
  it('measures always-in-context files with the real tokenizer', () => {
    const repo = path.join(tmp, 'repo');
    fs.mkdirSync(path.join(repo, '.github'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.github', 'copilot-instructions.md'), 'Always be terse.\n');
    const acc = newInstructionAccumulator();
    acc.contextIncluded = ['copilot-instructions.md'];
    acc.folders = [path.join(repo, '.github', 'instructions')];
    measureInstructionFiles(acc);
    expect(acc.files).toHaveLength(1);
    expect(acc.files[0]?.name).toBe('copilot-instructions.md');
    expect(acc.totalTokens).toBeGreaterThan(0);
  });
});

describe('path-traversal guards', () => {
  it('isSafeLogFileName rejects traversal, separators, and non-jsonl', () => {
    expect(isSafeLogFileName('main.jsonl')).toBe(true);
    expect(isSafeLogFileName('../secret.jsonl')).toBe(false);
    expect(isSafeLogFileName('a/b.jsonl')).toBe(false);
    expect(isSafeLogFileName('notes.txt')).toBe(false);
    expect(isSafeLogFileName('/etc/passwd')).toBe(false);
  });

  it('isContained is symlink-aware and rejects outside paths', () => {
    const root = path.join(tmp, 'root');
    fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
    const inside = path.join(root, 'sub', 'f.jsonl');
    fs.writeFileSync(inside, '{}');
    const outside = path.join(tmp, 'elsewhere');
    fs.mkdirSync(outside, { recursive: true });
    expect(isContained(inside, root)).toBe(true);
    expect(isContained(outside, root)).toBe(false);
    expect(isContained(path.join(root, 'nope'), root)).toBe(false); // nonexistent
  });

  it('resolveLogPath returns null for an unknown workspace id', () => {
    expect(resolveLogPath('no-such-hash', 'main', 'main.jsonl')).toBeNull();
  });
});
