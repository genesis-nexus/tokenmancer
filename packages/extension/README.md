# Tokenometer

See what every AI coding prompt really costs — a live **AI-Credit meter**, **session replay**, and a **what-if simulator**, right inside VS Code.

Every prompt you send fans out into a loop of model calls (plan → read → search → edit → verify). Tokenometer reads Copilot's own agent debug log and lays each loop out as a priced, step-by-step timeline: which model ran, the context window growing call after call, and a cost bar splitting each bill into cache-read / cache-write / fresh-input / output.

## Views & commands

- **Live Meter** (activity-bar view) — meters the **current workspace's** Copilot log as you work.
- **Tokenometer: Open Session Replay** — browse past sessions on this machine and replay any of them.
- **Tokenometer: Open What-if Simulator** — model token/credit trade-offs.
- **Tokenometer: Tail a Workspace's Log…** — point the live meter at any other workspace.

Enable Copilot's agent debug log in VS Code settings:

```json
"github.copilot.chat.agentDebugLog.enabled": true,
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

## Privacy

Everything runs locally in the extension host — no data leaves your machine. Prompt text is **redacted by default**; only token counts and costs are shown.

MIT-licensed.
