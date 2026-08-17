import type { ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { setConfig, setSpend, settingsOpen, summarizeSpend } from '../state/budget-store.js';
import { applyConfigDefault, skillMode } from '../state/skill-store.js';
import {
  connection,
  dispatch,
  freshGroups,
  groups,
  instructions,
  resetSession,
} from '../state/store.js';
import type { MeterTransport, SettingStatus } from '../transport.js';
import { AlertBanner } from './AlertBanner.js';
import { InstrPanel } from './InstrPanel.js';
import { LearnCard } from './LearnCard.js';
import { Logo } from './Logo.js';
import { LoopCard } from './LoopCard.js';
import { Readout } from './Readout.js';
import { SettingsBanner } from './SettingsBanner.js';
import { SettingsButton } from './SettingsPanel.js';
import { SetupGuide } from './SetupGuide.js';
import { SkillToggle } from './SkillToggle.js';
import { ThemeToggle } from './ThemeToggle.js';
import { TooltipLayer } from './TooltipLayer.js';
import { WorkspaceBar } from './WorkspaceBar.js';

export interface AppProps {
  transport: MeterTransport;
  title?: string;
  subtitle?: string;
  /** Custom bar under the masthead. Omit for the default live WorkspaceBar; pass
   *  null to render none. */
  sourceBar?: ComponentChildren;
  /** Wire the transport's live stream on mount (true for live, false for replay). */
  subscribe?: boolean;
  showConnection?: boolean;
  navLinks?: { href: string; text: string }[];
  emptyText?: string;
}

export function App({
  transport,
  title = 'Copilot Live Meter',
  subtitle = 'The agent loop, priced — every step, its model, its cost, live from the debug log.',
  sourceBar,
  subscribe = true,
  showConnection = true,
  navLinks = [
    { href: '/analytics', text: 'Analytics →' },
    { href: '/sessions', text: 'Past sessions →' },
    { href: '/simulator', text: 'What-if simulator →' },
  ],
  emptyText = 'Waiting for Copilot activity — run an Agent request in VS Code, or paste a usage block into the inbox file.',
}: AppProps) {
  useEffect(() => {
    if (!subscribe) return;
    const unsub = transport.subscribe(dispatch);
    const unconn = transport.onConnection?.((s) => {
      connection.value = s;
    });
    return () => {
      unsub();
      unconn?.();
      transport.dispose();
    };
  }, [transport, subscribe]);

  // VS Code only: transport.checkSettings exists there and nowhere else, so
  // this doubles as the switch between the actionable banner and the static
  // web-app setup guide.
  const [settings, setSettings] = useState<SettingStatus[] | null>(null);
  useEffect(() => {
    if (!transport.checkSettings) return;
    const check = () =>
      transport
        .checkSettings?.()
        .then(setSettings)
        .catch(() => {});
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [transport]);

  // Budget state, on producers that have it (SSE + postMessage, not replay).
  // Polled rather than pushed: spend changes continuously, but only the
  // threshold crossings are urgent, and those arrive as AlertEvents.
  useEffect(() => {
    if (!transport.getSpend) return;
    let alive = true;
    const refresh = () => {
      transport
        .getConfig?.()
        .then((c) => {
          if (!alive) return;
          setConfig(c);
          applyConfigDefault(c.ui?.defaultDetail);
        })
        .catch(() => {});
      transport
        .getSpend?.()
        .then((r) => {
          if (alive) setSpend(summarizeSpend(r.snapshot, r.rules));
        })
        .catch(() => {});
    };
    refresh();
    const t = setInterval(refresh, 30_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [transport]);

  const conn = connection.value;
  const gs = groups.value;
  const fresh = freshGroups.value;
  const instr = instructions.value;
  const hasInstr =
    !!instr &&
    (instr.resolvedCount > 0 || instr.contextIncluded.length > 0 || instr.loaded.length > 0);

  async function newSession() {
    try {
      await transport.newSession();
    } catch {
      resetSession();
    }
  }

  const bar = sourceBar !== undefined ? sourceBar : <WorkspaceBar transport={transport} />;
  const novice = skillMode.value === 'novice';

  return (
    <div class="wrap">
      <header class="mast">
        <div class="mastLeft">
          {/* Decorative: the <h1> beside it already names the surface. */}
          <Logo size={30} />
          <div>
            <h1>{title}</h1>
            <p class="sub">{subtitle}</p>
          </div>
        </div>
        <div class="mastRight">
          {showConnection ? (
            <span class="conn">
              <span class={`dot${conn === 'live' ? ' live' : conn === 'down' ? ' down' : ''}`} />
              <span>
                {conn === 'live' ? 'live' : conn === 'down' ? 'reconnecting…' : 'connecting…'}
              </span>
            </span>
          ) : null}
          {navLinks.map((link) => (
            <a class="navlink" href={link.href} key={link.href}>
              {link.text}
            </a>
          ))}
          <SkillToggle />
          <SettingsButton transport={transport} />
          <ThemeToggle />
        </div>
      </header>

      {settings ? (
        <SettingsBanner settings={settings} onOpenSetting={(key) => transport.openSetting?.(key)} />
      ) : !transport.checkSettings ? (
        <SetupGuide />
      ) : null}

      <AlertBanner
        onAction={(kind, arg) => {
          // VS Code jumps to its own settings UI; the web app has no such thing,
          // so it opens the in-app dialog rather than doing nothing at all.
          if (kind === 'openSetting' && arg && transport.openSetting) transport.openSetting(arg);
          else if (transport.updateSettings) settingsOpen.value = true;
          else transport.openSetting?.('tokenmancer.budgets');
        }}
      />

      {bar}

      <Readout onNewSession={newSession} />
      {novice ? null : <InstrPanel />}

      {novice ? <LearnCard /> : null}

      <div class="feedHead">
        <span class="feedLbl">
          {novice ? 'What you asked for · newest first' : 'Agent loops · newest first'}
        </span>
        {/* The cost bar is still on every card in the simple view, so the key
            stays — said in words rather than in billing terms. */}
        <div class="legend">
          <span>
            <i class="sw" style="background:var(--read)" />
            {novice ? 'conversation so far' : 'cache-read'}
          </span>
          <span>
            <i class="sw" style="background:var(--write)" />
            {novice ? 'saved for reuse' : 'cache-write'}
          </span>
          <span>
            <i class="sw" style="background:var(--fresh)" />
            {novice ? 'new material' : 'fresh input'}
          </span>
          <span>
            <i class="sw" style="background:var(--out)" />
            {novice ? "the model's reply" : 'output'}
          </span>
        </div>
      </div>

      <details class="help">
        <summary>
          <span class="chev">▶</span>
          {novice ? 'How to read this' : 'How to read this meter'}
        </summary>
        {novice ? (
          <div class="hbody">
            <b>One card = one thing you asked for.</b> The number on the right is what it cost you.
            The coloured bar shows where that money went, and the four colours are explained just
            above. Open <b>Show the steps</b> on any card to see what the agent actually did to
            answer you — reading files, searching, editing, checking its work. When you want the
            exact token counts behind all of it, switch to <b>Detailed</b> at the top right.
          </div>
        ) : (
          <div class="hbody">
            <b>One prompt = one loop card.</b> Steps run top to bottom; each is one model
            round-trip. The bar on a step is that call's <b>context window</b>, scaled to the loop's
            largest — it grows step after step because the whole conversation is re-sent on every
            call. Its segments show who absorbed it: cache-read (cheap), cache-write (one-time
            premium), fresh input (full price). The bar under the prompt splits the{' '}
            <b>loop's cost</b> — watch output, a few hundred tokens, take the biggest slice of the
            bill. Hover any bar for exact numbers; a loop's <b>step table</b> holds every figure.
          </div>
        )}
      </details>

      <div class="feed">
        {gs.length ? (
          gs.map((g) => (
            <LoopCard key={g.groupId} group={g} hasInstr={hasInstr} fresh={fresh.has(g.groupId)} />
          ))
        ) : (
          <div class="empty">{emptyText}</div>
        )}
      </div>

      <div class="foot">
        {novice ? (
          <>
            Costs marked ≈ are our best estimate; the rest come straight from Copilot's own records.
            One credit is one US cent.
          </>
        ) : (
          <>
            Costs marked ≈ are estimated from token counts × the rate table; unmarked costs come
            straight from the log's own credit fields. Hover any bar for its split · every number is
            also in the loop's step table.
          </>
        )}
      </div>

      <TooltipLayer />
    </div>
  );
}
