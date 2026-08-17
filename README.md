<p align="center">
  <img src="assets/brand/tokenmancer-lockup.png" alt="Tokenmancer — spend less, ship more" width="560">
</p>

# GitHub Copilot Tokenmancer

See what every GitHub Copilot prompt **really costs** — a live AI-Credit meter, session replay, and a what-if simulator. Two ways to run it, one shared engine:

- **Local-first web app** — `npx tokenmancer`, opens in your browser.
- **VS Code extension** — the meter lives in your editor's sidebar.

Every prompt fans out into a loop of model calls (plan → read → search → edit → verify). Tokenmancer reads Copilot's own agent debug log and lays each loop out as a priced, step-by-step timeline: which model ran each step, the context window growing call after call, and a cost bar splitting every bill into **cache-read / cache-write / fresh-input / output** — with output, a few hundred tokens, routinely the biggest slice.

Everything runs **on your machine**. Prompt text is **redacted by default**; only token counts and costs leave the parser.

## Quick start

### Web app (no install)

```bash
npx tokenmancer --open        # once published to npm
```

### From this repo

```bash
pnpm install
pnpm start                # builds + runs; prints http://127.0.0.1:7878/?token=…
pnpm meter                # same, and opens the browser
pnpm start -- --tail "<…/GitHub.copilot-chat/debug-logs/main.jsonl>"
```

Then open the printed URL, pick a workspace in the bar, and hit **▶ Tail live** — or open **Past sessions →** to browse and replay any recorded run.

Enable Copilot's agent debug log in VS Code settings first:

```json
"github.copilot.chat.agentDebugLog.enabled": true,
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

### VS Code extension

```bash
pnpm --filter tokenmancer package   # → dist/tokenmancer.vsix
code --install-extension packages/extension/dist/tokenmancer.vsix
```

The **Tokenmancer** activity-bar view meters the current workspace; the command palette opens Session Replay, the Simulator, or points the meter at another workspace.

## Surfaces

| Surface | What it does |
|---|---|
| **Live Meter** | Tails a Copilot log and prices each agent loop as it happens. |
| **Session Replay** | Browse past sessions on this machine by date and replay any of them — great for debugging a run after the fact. |
| **What-if Simulator** | Paste text → exact o200k token counts → model the AI-Credit cost across every model, with cache and output levers. |
| **Workspace Analytics** | Day-by-day trends, cache and model-switching behaviour, and plain-English recommendations across every session in a workspace. Each measure is drawn with the mark that fits it — counted events as bars on whole-number gridlines, spend as an area, a bounded rate as a bare line. |
| **Budgets & alerts** | Set a monthly credit limit and get told at 50 / 80 / 100% — in the browser, in the VS Code sidebar, and in the status bar. |

## Simple and Detailed

Every surface has a **Simple / Detailed** switch in the top right, and it starts on Simple.

**Simple** answers one question — *what did that cost me, and why?* Spend is shown in dollars, each prompt gets a one-line explanation of where its money went ("Most of this — about 61% — went on the model's own reply"), and the step list is folded away behind a per-card toggle. A rotating **Learn** card explains one idea at a time: why replies cost more than questions, why staying in one chat is cheaper, why the first message of a session is the expensive one. Each card ends with a link into the exact detailed view that proves it.

**Detailed** is the full instrument: per-step context bars, the four-way cost split, the every-number step table, cache-reuse and model-switching metrics, context-pressure bands and the complete usage breakdown.

The point of Simple is not to withhold anything — it is one click away, and the Learn card keeps pointing at it. It is to make the first screen readable by someone who has never thought about token economics, and give them a reason to go looking for the second.

## Budgets

Spend is recorded to an append-only ledger, so **month-to-date survives a restart** — a budget you can close the tab on is the whole point.

The gauge frames spend against the **calendar**, because a seat's credit pool does not roll over: how much of the month is gone matters as much as how much of the budget is. It reads *"86% used · 14 days left in August · on pace to run out around the 20th"*, and the tick on the track marks where the month itself has got to — fill behind it is under pace, fill ahead of it is outrunning the calendar. The projection is deliberately linear; "you run out on the 20th" is the part anyone acts on.

### Setting one

Click the **⚙** in the top right of any surface. Four fields:

| Field | What it does |
|---|---|
| Monthly allowance | What your seat gives you each month. Defaults to **3,000 credits** ($30). |
| Budget cap | Warn me before I use the whole allowance. Empty means track the allowance itself. |
| Expensive-prompt warning | Flag any single prompt that costs more than this. |
| Show alerts | Master switch for every banner and notification. |

Changes are written to `~/.tokenmancer/config.json`, so they hold across restarts and apply to both surfaces. If a higher-precedence layer (a project `.tokenmancer.json`, a `TOKENMANCER_*` var) still outranks what you saved, the dialog says so rather than claiming success.

The equivalent from the command line and from VS Code:

```bash
npx tokenmancer --budget-month 400   # 400 credits/month, alerts at 50/80/100%
npx tokenmancer --no-alerts          # meter only, no interruptions
```

In VS Code, run **Tokenmancer: Set Monthly Credit Budget…**, or set `tokenmancer.budgets.monthlyCredits`. The status bar then shows `⚡ 42.0 cr · 0.8%` at all times.

Alerts fire on a **crossing**, never on a level, and are monotonic — once 80% has fired for a period, 50% cannot fire again. A per-period cooldown (15 min) stops 50% and 80% arriving back to back, and a hard cap (6/hour) is the backstop. Hitting the limit itself escalates to critical and always gets through.

### Configuration

Layered, lowest precedence first:

| Layer | Where |
|---|---|
| defaults | built in |
| user | `~/.tokenmancer/config.json` — created on first run |
| project | `<repo>/.tokenmancer.json` — committable, so a repo can carry its own budget |
| environment | `TOKENMANCER_DEFAULT_MODEL`, `TOKENMANCER_POOL_CREDITS`, `TOKENMANCER_SHOW_PROMPTS`, `TOKENMANCER_SHOW_PATHS`, `TOKENMANCER_ALERTS_ENABLED` |
| flags / settings | CLI flags, or `tokenmancer.*` in VS Code settings |

`TOKENMANCER_HOME` relocates the whole state directory. A malformed config file is reported and skipped — it never stops the meter starting.

State lives beside it in `~/.tokenmancer/state/`: `ledger-YYYY-MM.jsonl` (append-only, one line per billed step) and `alerts.json`. Plain JSON, no database, no native dependencies — `npx tokenmancer` still ships with **zero runtime dependencies**.

## Architecture

A pnpm/TypeScript monorepo. The reuse axis is **runtime capability**, not product surface — both apps compose the same libraries.

```
packages/
  core/        runtime-agnostic: pricing model, AIC math, log parser, event contract, o200k tokenizer
  node-host/   Node-only: workspace/log discovery, jsonl tailer, on-disk instruction measurement
  ui/          Preact + signals renderer + pluggable transports (SSE, replay, postMessage)
  webapp/      → npm package `tokenmancer`: hardened local-first HTTP/SSE server
  extension/   → VS Code extension: host bridge + webviews over postMessage
proof/         copilot_token_lab.py — the tiktoken golden oracle the pricing tests lock against
tools/         scaffold-mfe.js — deterministic demo-repo generator (dev fixture)
legacy/        the original single-file demo kit this was built from (kept for reference)
```

**One source of truth for pricing** (previously copied five times and drifting) lives in `core/pricing`, locked by golden tests that reproduce the Python oracle to the cent. The typed `MeterEvent` contract makes the loop-grouping fields *required*, so every producer must route through the single parser funnel.

### Security (web app)

Loopback bind (`127.0.0.1`), a per-run token on every data route, `Host`/`Origin` validation (DNS-rebind defense), prompt redaction by default (`--show-prompts` to opt in), workspace paths hidden (`--expose-paths` to opt in), path-traversal guards, request limits, and graceful shutdown. Covered by an automated security suite.

### What Tokenmancer records about your code

To answer *where did my credits actually go*, the meter reads which files the agent touched — a `read_file` on `src/server.ts` is recorded as `src/server.ts`.

- **File contents are never read or recorded.** Only the path, and the line range when the tool gave one.
- **Paths are always repo-relative.** A path outside a known workspace root is reduced to its bare filename before it leaves the parser, and dropped entirely by the redaction layer if it still looks absolute. Set `privacy.showPaths: false` (or `--hide-paths`) to record no paths at all.
- **Search queries and shell commands follow the prompt, not the paths.** They are blanked unless you pass `--show-prompts`, because a command line leaks intent and occasionally a secret.

## Development

```bash
pnpm check       # lint + typecheck + test
pnpm build       # build every package
pnpm test:watch
```

MIT-licensed.

## Brand assets

`assets/brand/` holds the source artwork: the mark on dark (`tokenmancer-mark.png`), on light (`tokenmancer-light.png`), the monochrome cut (`tokenmancer-mono.png`), and the horizontal lockup.

The in-app mark is **vector, not one of those PNGs** — [`Logo.tsx`](packages/ui/src/components/Logo.tsx) traces the same geometry so it stays crisp at the ~30px a masthead uses, and follows the theme from a single asset: the hood is `currentColor`, and only the accents are tokens (`--brand-eye`, `--brand-mouth`), which is what lets one file serve both the dark and light variants the artwork ships separately.

Three places keep that geometry in step, and all three need editing together:

| Where | Why it differs |
|---|---|
| [`Logo.tsx`](packages/ui/src/components/Logo.tsx) | Theme-aware, cropped to the drawn content — a masthead supplies its own margin. |
| [`favicon.svg`](packages/ui/src/brand/favicon.svg) | Carries its own dark plate; a tab strip is not theme-aware, and a transparent mark dissolves into dark browser chrome. |
| [`media/icon.svg`](packages/extension/media/icon.svg) | VS Code masks activity-bar icons, so only alpha survives — built from positive space alone, or it flattens into a blob. |

The green is a brand colour, deliberately scoped to the mark. It stays out of the meter itself, where the palette carries meaning (cache-read / cache-write / fresh input / output) and a fifth accent would just compete.
