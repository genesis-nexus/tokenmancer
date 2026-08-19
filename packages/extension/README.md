# Tokenmancer

See what every AI coding prompt **really costs** — a live AI-Credit meter, budgets, workspace analytics and a what-if simulator, inside VS Code.

**Homepage:** https://genesis-nexus.github.io/tokenmancer/

Every prompt you send fans out into a loop of model calls (plan → read → search → edit → verify). Tokenmancer reads Copilot's own agent debug log and lays each loop out as a priced, step-by-step timeline: which model ran each step, the context window growing call after call, and a cost bar splitting every bill into cache-read / cache-write / fresh-input / output — with output, a few hundred tokens, routinely the biggest slice.

Everything runs on your machine. Nothing is uploaded.

## Setup

Tokenmancer reads a log Copilot only writes when you ask it to. Add these to your VS Code settings, then reload the window:

```json
"github.copilot.chat.agentDebugLog.enabled": true,
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

Send an Agent request, then open the **Tokenmancer** view in the activity bar. If either setting is off, the view says so and offers to jump you to it.

## What you get

**Live Meter** — the current workspace's Copilot log, priced as it happens.

**Budgets and alerts** — set a monthly credit limit and get told at 50 / 80 / 100%. Spend is written to an append-only ledger, so month-to-date survives a restart; the gauge frames it against the calendar (*"86% used · 14 days left in August · on pace to run out around the 20th"*), because a seat's pool does not roll over. Alerts fire on a threshold **crossing**, never on a level, and are monotonic within a period — once 80% has fired, 50% cannot fire again — with a cooldown and an hourly cap behind that.

**Status bar** — `⚡ 42.0 cr · 1.4%` at all times. Click it to open the meter.

**Workspace Analytics** — day-by-day trends, cache reuse, model-switching, context-pressure bands and plain-English recommendations across every session in a workspace.

**Session Replay** — browse past sessions on this machine by date and replay any of them.

**What-if Simulator** — exact o200k token counts, modelled across every rate row with cache and output levers.

## Simple and Detailed

Every surface has a **Simple / Detailed** switch, and it starts on Simple.

Simple answers one question — *what did that cost me, and why?* Spend leads in dollars, each prompt gets a one-line explanation of where its money went, and step tables fold away behind a per-card control. A rotating **Learn** card introduces one idea at a time — why replies cost more than questions, why staying in one chat is cheaper, why the first message of a session is the expensive one — and each ends with a link into the exact detailed view that evidences it.

Detailed is the full instrument: per-step context bars, the four-way cost split, the every-number step table, and the complete analytics breakdown. Your choice is remembered and always beats the workspace default.

## Commands

| Command | |
|---|---|
| `Tokenmancer: Open Live Meter` | The priced agent loop, live |
| `Tokenmancer: Open Workspace Analytics` | Trends and recommendations |
| `Tokenmancer: Open Session Replay` | Browse and replay past sessions |
| `Tokenmancer: Open What-if Simulator` | Model token/credit trade-offs |
| `Tokenmancer: Tail a Workspace's Log…` | Point the meter at another workspace |
| `Tokenmancer: Show Month-to-date Spend` | |
| `Tokenmancer: Set Monthly Credit Budget…` | |

## Settings

All under `tokenmancer.*` — pool size and default model, the monthly budget, alert cooldown and rate cap, privacy, and the default level of detail. Settings you leave alone fall through to `~/.tokenmancer/config.json`, which a repo can also override with a committed `.tokenmancer.json`.

## Privacy

Everything runs in the extension host; no data leaves your machine.

**Your prompt text is shown** — it is how you tell one loop from another, and it never leaves the extension host. Set `tokenmancer.privacy.showPrompts` to `false` before a screenshare and each loop falls back to an opaque `‹redacted a1b2c3›` tag.

**Shell commands and search strings are blanked by default** (`tokenmancer.privacy.showToolQueries`), because a command line is where a token or connection string tends to get pasted.

Tokenmancer reports **which** files the agent read, never their contents, and absolute paths are withheld unless you ask for them.

## Requires

VS Code 1.90+, and GitHub Copilot Chat with the agent debug log enabled (above).

MIT-licensed. [Source and issues](https://github.com/genesis-nexus/tokenmancer).
