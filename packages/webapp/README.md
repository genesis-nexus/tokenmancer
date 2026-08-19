# tokenmancer

A local-first meter that prices every GitHub Copilot agent step (AI-Credits), live from the debug log. Runs entirely on your machine — the browser is just the UI.

**Homepage:** https://genesis-nexus.github.io/tokenmancer/

```bash
npx tokenmancer --open
```

Prints a loopback URL with a per-run token. Pick a workspace and hit **Tail live**, or open **Past sessions** to replay a recorded run.

## Flags

| Flag | Effect |
|---|---|
| `--open` | Open the browser automatically. |
| `--port <n>` | Port (default 7878, must be 1024–65535). |
| `--tail <path>` | Tail a specific `main.jsonl` up front. |
| `--redact-prompts` | Replace prompt text with an opaque tag. For screenshares. |
| `--show-tool-queries` | Include shell commands and search strings (blanked by default). |
| `--expose-paths` | Include absolute project paths in the workspace list. |
| `--hide-paths` | Record no file targets at all. |
| `--budget-month <n>` | Alert at 50/80/100% of `n` credits per month. |
| `--no-alerts` | Meter only; never interrupt. |
| `--config <path>` | Use a specific config file. |

## Budgets and config

Month-to-date spend is written to an append-only ledger under `~/.tokenmancer/state/`, so it survives a restart. Config layers, lowest first: defaults → `~/.tokenmancer/config.json` (created on first run) → `<repo>/.tokenmancer.json` → `TOKENMANCER_*` env → the flags above. `TOKENMANCER_HOME` relocates the state directory.

Tokenmancer records **which** repo-relative files the agent touched, never their contents, and never an absolute path.

Enable Copilot's agent debug log in VS Code settings:

```json
"github.copilot.chat.agentDebugLog.enabled": true,
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

Loopback-only, token-gated, shell commands blanked by default, zero runtime dependencies. MIT-licensed. Part of [Tokenmancer](https://github.com/genesis-nexus/tokenmancer).
