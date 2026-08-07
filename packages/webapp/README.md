# tokenmancer

A local-first meter that prices every GitHub Copilot agent step (AI-Credits), live from the debug log. Runs entirely on your machine — the browser is just the UI.

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
| `--show-prompts` | Include prompt text (redacted by default). |
| `--expose-paths` | Include absolute project paths in the workspace list. |

Enable Copilot's agent debug log in VS Code settings:

```json
"github.copilot.chat.agentDebugLog.enabled": true,
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

Loopback-only, token-gated, prompts redacted by default. MIT-licensed. Part of [Tokenmancer](https://github.com/genesis-nexus/tokenmancer).
