// @vitest-environment jsdom
import { render } from 'preact';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderFilter } from './components/ProviderFilter.js';
import { WorkspaceBar } from './components/WorkspaceBar.js';
import {
  filterWorkspaces,
  providerFilter,
  providersIn,
  setProviderFilter,
  workspaceLabel,
} from './state/provider-store.js';
import type { MeterTransport, SessionSummary, WorkspaceSummary } from './transport.js';

function ws(over: Partial<WorkspaceSummary> = {}): WorkspaceSummary {
  return {
    id: 'w1',
    provider: 'copilot',
    folderName: 'tokenmancer',
    modifiedStr: 'Aug 18, 26',
    sessionCount: 2,
    channel: 'Code',
    ...over,
  };
}

const COPILOT = ws({ id: 'c1' });
const CLAUDE = ws({ id: 'claude:-x', provider: 'claude', channel: 'Claude Code', sessionCount: 5 });

class Fake implements MeterTransport {
  constructor(private readonly list: WorkspaceSummary[]) {}
  subscribe(): () => void {
    return () => {};
  }
  async listWorkspaces(): Promise<WorkspaceSummary[]> {
    return this.list;
  }
  async listSessions(): Promise<SessionSummary[]> {
    return [];
  }
  async loadSession() {
    return [];
  }
  async tailWorkspace() {
    return {};
  }
  async newSession(): Promise<void> {}
  dispose(): void {}
}

const tick = () => new Promise((r) => setTimeout(r, 20));

let root: HTMLDivElement;
beforeEach(() => {
  setProviderFilter('all');
  root = document.createElement('div');
  document.body.appendChild(root);
});
afterEach(() => {
  render(null, root);
  root.remove();
  setProviderFilter('all');
});

describe('provider filtering', () => {
  it('keeps only the chosen agent, and everything under "all"', () => {
    const list = [COPILOT, CLAUDE];
    expect(filterWorkspaces(list, 'all')).toHaveLength(2);
    expect(filterWorkspaces(list, 'claude')).toEqual([CLAUDE]);
    expect(filterWorkspaces(list, 'copilot')).toEqual([COPILOT]);
  });

  it('reports which agents are present, in a stable order', () => {
    expect(providersIn([CLAUDE, COPILOT])).toEqual(['copilot', 'claude']);
    expect(providersIn([CLAUDE])).toEqual(['claude']);
    expect(providersIn([])).toEqual([]);
  });

  it('names the agent on every row, so the same folder is distinguishable', () => {
    // The reason this helper exists: both entries are folderName "tokenmancer".
    expect(workspaceLabel(COPILOT)).toBe('tokenmancer — Copilot · 2 sessions');
    expect(workspaceLabel(CLAUDE)).toBe('tokenmancer — Claude Code · 5 sessions');
  });

  it('mentions a non-default editor but not the default one', () => {
    expect(workspaceLabel(ws({ channel: 'Cursor' }))).toContain('Copilot (Cursor)');
    expect(workspaceLabel(ws({ channel: 'Code' }))).not.toContain('(');
  });

  it('does not pluralise a single session', () => {
    expect(workspaceLabel(ws({ sessionCount: 1 }))).toContain('1 session');
    expect(workspaceLabel(ws({ sessionCount: 1 }))).not.toContain('1 sessions');
  });
});

describe('the toggle only appears when there is a choice to make', () => {
  it('renders nothing when only one agent is on this machine', () => {
    render(<ProviderFilter workspaces={[COPILOT]} />, root);
    expect(root.querySelector('.providerFilter')).toBeNull();
  });

  it('offers All plus one option per present agent', () => {
    render(<ProviderFilter workspaces={[COPILOT, CLAUDE]} />, root);
    const labels = [...root.querySelectorAll('.providerOpt')].map((b) => b.textContent);
    expect(labels).toEqual(['All', 'Copilot', 'Claude Code']);
  });

  it('marks the active option for assistive tech, not just visually', () => {
    setProviderFilter('claude');
    render(<ProviderFilter workspaces={[COPILOT, CLAUDE]} />, root);
    const on = [...root.querySelectorAll('.providerOpt')].filter(
      (b) => b.getAttribute('aria-pressed') === 'true',
    );
    expect(on).toHaveLength(1);
    expect(on[0]?.textContent).toBe('Claude Code');
  });
});

describe('the workspace picker respects the filter', () => {
  it('lists both agents by default and narrows when one is chosen', async () => {
    render(<WorkspaceBar transport={new Fake([COPILOT, CLAUDE])} />, root);
    await tick();

    const sel = () => document.getElementById('wsSelect') as HTMLSelectElement;
    // 2 workspaces + the placeholder row
    expect(sel().querySelectorAll('option')).toHaveLength(3);

    const claudeBtn = [...document.querySelectorAll('.providerOpt')].find(
      (b) => b.textContent === 'Claude Code',
    ) as HTMLButtonElement;
    claudeBtn.click();
    await tick();

    const opts = [...sel().querySelectorAll('option')].map((o) => o.textContent);
    expect(opts).toHaveLength(2);
    expect(opts[1]).toContain('Claude Code');
  });

  it('drops a selection the filter has hidden rather than acting on it', async () => {
    render(<WorkspaceBar transport={new Fake([COPILOT, CLAUDE])} />, root);
    await tick();

    const sel = document.getElementById('wsSelect') as HTMLSelectElement;
    sel.value = 'c1';
    sel.dispatchEvent(new Event('change'));
    await tick();

    const tailBtn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Tail live'),
    ) as HTMLButtonElement;
    expect(tailBtn.disabled).toBe(false);

    // Filtering to the other agent must disarm the button, not leave it primed
    // to tail a workspace the select no longer shows.
    const claudeBtn = [...document.querySelectorAll('.providerOpt')].find(
      (b) => b.textContent === 'Claude Code',
    ) as HTMLButtonElement;
    claudeBtn.click();
    await tick();

    expect(
      (
        [...document.querySelectorAll('button')].find((b) =>
          b.textContent?.includes('Tail live'),
        ) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('says so when the filter empties an otherwise populated list', async () => {
    render(<WorkspaceBar transport={new Fake([COPILOT, CLAUDE])} />, root);
    await tick();
    setProviderFilter('claude');
    render(<WorkspaceBar transport={new Fake([COPILOT])} />, root);
    await tick();

    const first = document.querySelector('#wsSelect option');
    expect(first?.textContent).toBe('No workspaces for this agent');
  });

  it('survives a machine with only one agent — no toggle, full list', async () => {
    render(<WorkspaceBar transport={new Fake([COPILOT])} />, root);
    await tick();
    expect(document.querySelector('.providerFilter')).toBeNull();
    expect(document.querySelectorAll('#wsSelect option')).toHaveLength(2);
  });
});

describe('the choice persists', () => {
  it('writes through to localStorage so it survives a reload', () => {
    setProviderFilter('claude');
    expect(localStorage.getItem('tokenmancer.providerFilter')).toBe('claude');
    expect(providerFilter.value).toBe('claude');
  });
});
