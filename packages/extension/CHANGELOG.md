# Changelog

All notable changes to the Tokenmancer extension are documented here.
This project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-08-17

First public release.

### Added

- **Live Meter** in the activity bar — tails the current workspace's Copilot agent
  debug log and prices each agent loop as it runs: which model ran each step, the
  context window growing call after call, and a cost bar splitting every bill into
  cache-read / cache-write / fresh-input / output.
- **Session Replay** — browse past sessions on this machine by date and replay any
  of them.
- **What-if Simulator** — exact o200k token counts, modelled across every rate row
  with cache and output levers.
- **Workspace Analytics** — day-by-day trends, cache and model-switching behaviour,
  context-pressure bands, and plain-English recommendations across every session in
  a workspace.
- **Budgets and alerts** — a monthly credit limit with warnings at 50 / 80 / 100%.
  Spend is written to an append-only ledger, so month-to-date survives a restart.
  Alerts fire on a threshold *crossing*, are monotonic within a period, and are
  bounded by a cooldown and an hourly cap.
- **Spend status bar** — `⚡ 42.0 cr · 1.4%` at all times; click to open the meter.
- **Simple / Detailed toggle** — Simple leads with money and folds the step tables
  away behind a per-card control, with a rotating Learn card that explains one idea
  at a time and links into the detailed view that evidences it. Your choice is
  remembered and always beats the workspace default.
- Settings under `tokenmancer.*` for the credit pool, budgets, alerts, privacy and
  the default level of detail.

### Privacy

Everything runs locally. Prompt text and tool queries are redacted by default
(`tokenmancer.showPrompts`), and absolute paths are withheld — Tokenmancer reports
*which* files the agent read, never their contents.
