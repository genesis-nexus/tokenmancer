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

## Development

```bash
pnpm check       # lint + typecheck + test (50 tests)
pnpm build       # build every package
pnpm test:watch
```

MIT-licensed.
