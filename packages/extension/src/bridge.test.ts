import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MeterEvent, StepEvent } from '@cte/core';
import { afterAll, describe, expect, it } from 'vitest';
import { MeterBridge, type Poster } from './bridge.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cte-ext-'));
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

const LINES = [
  '{"type":"user_message","sid":"s1","spanId":"p1","ts":1700000000000,"attrs":{"userRequest":"SECRET refactor formatPrice"}}',
  '{"type":"request","sid":"s1","spanId":"r1","parentSpanId":"p1","ts":1700000000001,"model":"claude-sonnet-4.6","prompt_tokens":12000,"completion_tokens":300,"cached_tokens":9000,"cache_creation_input_tokens":1000}',
];

function makeLogsDir(name: string): string {
  const dir = path.join(tmp, name, 'GitHub.copilot-chat', 'debug-logs');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'main.jsonl'), `${LINES.join('\n')}\n`);
  return dir;
}

interface Frame {
  type: string;
  event?: MeterEvent;
  id?: number;
  result?: unknown;
}
function collector(): { poster: Poster; msgs: Frame[] } {
  const msgs: Frame[] = [];
  return { poster: { post: (m) => msgs.push(m as Frame) }, msgs };
}
const steps = (msgs: Frame[]): StepEvent[] =>
  msgs
    .filter((m) => m.type === 'event' && m.event?.kind === 'step')
    .map((m) => m.event as StepEvent);

describe('MeterBridge', () => {
  it('auto-tails the default logs dir on subscribe, redacting prompts', () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, { defaultLogsDir: makeLogsDir('ws-a') });
    bridge.handle({ type: 'subscribe' });

    expect(msgs.some((m) => m.type === 'event' && m.event?.kind === 'control')).toBe(true);
    const s = steps(msgs);
    expect(s).toHaveLength(1);
    expect(JSON.stringify(msgs)).not.toContain('SECRET');
    expect(s[0]?.userPrompt).toBe('');
    expect(s[0]?.aic).toBeCloseTo(1.695, 6);
    bridge.dispose();
  });

  it('shows prompts when configured', () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {
      defaultLogsDir: makeLogsDir('ws-b'),
      showPrompts: true,
    });
    bridge.handle({ type: 'subscribe' });
    expect(JSON.stringify(msgs)).toContain('SECRET');
    bridge.dispose();
  });

  it('answers listWorkspaces RPC with a result frame', async () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {});
    bridge.handle({ type: 'rpc', id: 7, method: 'listWorkspaces' });
    await new Promise((r) => setTimeout(r, 10));
    const reply = msgs.find((m) => m.type === 'rpc-result' && m.id === 7);
    expect(reply).toBeDefined();
    expect(Array.isArray(reply?.result)).toBe(true);
    bridge.dispose();
  });

  it('rejects an unknown RPC method with an error frame', async () => {
    const { poster, msgs } = collector();
    const bridge = new MeterBridge(poster, {});
    bridge.handle({ type: 'rpc', id: 9, method: 'nope' });
    await new Promise((r) => setTimeout(r, 10));
    expect(msgs.some((m) => m.type === 'rpc-error' && m.id === 9)).toBe(true);
    bridge.dispose();
  });
});
