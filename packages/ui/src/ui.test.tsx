// @vitest-environment jsdom
import { type MeterEvent, createGroupingContext, processRecord } from '@cte/core';
import { render } from 'preact';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './components/App.js';
import { SessionBrowser } from './components/SessionBrowser.js';
import { resetSession } from './state/store.js';
import type { MeterTransport, SessionSummary, WorkspaceSummary } from './transport.js';
import { ReplayTransport } from './transport.js';

function generate(lines: string[]): MeterEvent[] {
  const ctx = createGroupingContext();
  const out: MeterEvent[] = [];
  for (const l of lines) processRecord(JSON.parse(l), 'archive', ctx, (e) => out.push(e));
  return out;
}

const LINES = [
  '{"type":"user_message","sid":"s1","spanId":"p1","ts":1700000000000,"attrs":{"userRequest":"Refactor formatPrice"}}',
  '{"type":"request","sid":"s1","spanId":"r1","parentSpanId":"p1","ts":1700000000001,"model":"claude-sonnet-4.6","prompt_tokens":12000,"completion_tokens":300,"cached_tokens":9000,"cache_creation_input_tokens":1000}',
];

const tick = () => new Promise((r) => setTimeout(r, 20));

afterEach(() => resetSession());

describe('meter UI renders the loop card', () => {
  it('shows the prompt, a loop cost, a step row, and the step table', async () => {
    const events = generate(LINES);
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(<App transport={new ReplayTransport(() => events)} sourceBar={null} />, root);
    await tick();

    const html = document.body.innerHTML;
    expect(document.querySelector('.loop')).not.toBeNull();
    expect(html).toContain('Refactor formatPrice');
    // sticky readout hero shows a credit total
    expect(document.querySelector('.readout .stat.hero .val')?.textContent).toContain('cr');
    // the step table (every-number view) is present
    expect(document.querySelector('table.stepTable')).not.toBeNull();
    // loop cost renders the computed 1.695 cr (rounded display 1.70)
    expect(document.querySelector('.loopMeta .cost')?.textContent).toContain('1.70');

    render(null, root);
    root.remove();
  });
});

class FakeTransport implements MeterTransport {
  constructor(private readonly events: MeterEvent[]) {}
  subscribe(): () => void {
    return () => {};
  }
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return [{ id: 'w1', folderName: 'Demo', modifiedStr: 'now', sessionCount: 1, channel: 'Code' }];
  }
  async listSessions(): Promise<SessionSummary[]> {
    return [
      {
        id: 'main',
        name: 'Session A',
        dateStr: 'Jul 22',
        timeRange: '10:00 - 10:05',
        events: 2,
        logFiles: ['main.jsonl'],
      },
    ];
  }
  async loadSession(): Promise<MeterEvent[]> {
    return this.events;
  }
  async tailWorkspace() {
    return {};
  }
  async newSession() {}
  dispose() {}
}

describe('session browser → replay', () => {
  it('picks a workspace, lists sessions, and replays the selected one', async () => {
    const t = new FakeTransport(generate(LINES));
    const root = document.createElement('div');
    document.body.appendChild(root);
    render(
      <App
        transport={t}
        subscribe={false}
        showConnection={false}
        sourceBar={<SessionBrowser transport={t} />}
      />,
      root,
    );
    await tick();

    const wsSel = document.getElementById('wsSelect') as HTMLSelectElement;
    wsSel.value = 'w1';
    wsSel.dispatchEvent(new Event('change'));
    await tick();

    const sesSel = document.getElementById('sessionSelect') as HTMLSelectElement;
    expect(sesSel.querySelectorAll('option').length).toBeGreaterThan(1);
    sesSel.value = 'main';
    sesSel.dispatchEvent(new Event('change'));
    await tick();

    const replayBtn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Replay'),
    );
    replayBtn?.click();
    await tick();

    expect(document.querySelector('.loop')).not.toBeNull();
    expect(document.body.innerHTML).toContain('Refactor formatPrice');

    render(null, root);
    root.remove();
  });
});
