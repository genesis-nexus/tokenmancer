# GitHub Copilot Token Litmus Test — Guided Live Demo (MFE repo + Live Meter)

Run this on a microfrontend repo, drive Agent/Chat in VS Code, and watch each interaction
move a live AI-Credit meter — no manual log-reading. Every command below is copy-paste.

**Kit files (keep in one folder):** `scaffold_mfe_demo.js` · `copilot_meter_server.js` ·
`copilot_live_meter.html` · `copilot_token_lab.py` · `copilot_token_meter.html`

---

## What "deterministic" means here (say it once)

A live LLM is not deterministic — exact **output** tokens vary run to run. So we engineer for
reproducibility and read GitHub's real numbers off the meter rather than promising integers:

- **Input-side effects are near-deterministic** — context is assembled before the model runs.
- **Rates are exact**; the meter shows the real AIC per call.
- **Direction and magnitude are robust** even where output wobbles.

The fixed MFE repo + a pinned model + a fresh chat per experiment remove the variance we control.

| # | Experiment | Lever | Determinism |
|---|---|---|---|
| 1 | Attached-context size | `#file` count | ★★★ |
| 2 | Multi-turn resend | follow-ups | ★★★ |
| 3 | Cache reads | repeat in session | ★★★ |
| 4 | MCP / tool schemas | toolset size | ★★☆ |
| 5 | Model rate | pinned model | ★★★ |
| 6 | Output discipline | terse rule | ★★☆ |
| 7 | Explore vs targeted | search vs `#file` | ★★☆ |

---

## Part 0 — Prerequisites (one-time)

- **VS Code + GitHub Copilot Chat updated to the latest version** (the agent debug-log file is a
  recent feature; older builds gate it behind a flag — see Part 2 fallback).
- **Node 18+** and **Python 3.9+** on PATH.
- Put the five kit files in one working folder and `cd` into it.

```bash
node --version && python3 --version    # confirm both exist
```

---

## Part 1 — Generate the demo repo (deterministic, 44 files)

```bash
node scaffold_mfe_demo.js mfe-demo
cd mfe-demo
git init -q && git add -A && git commit -qm "demo baseline"
code .                                  # open in VS Code
```

Structure: a host shell + three remotes (`product`, `cart`, `checkout`) + a `shared` package.
Two targets are baked in for the experiments:

- **`shared/src/utils/formatPrice.ts`** — imported by all three remotes (the cross-file fan-out).
- **`shared/src/utils/validateEmail.ts`** — the small, self-contained edit target.

> Prefer your own MFE repo? Use it — just commit a baseline so you can `git reset --hard` between
> runs. Everything below still applies; swap the two target files for equivalents in your repo.

---

## Part 2 — Turn on the agent debug log, then find the file

In VS Code, open **Settings (JSON)** (`Cmd/Ctrl+Shift+P` → *Preferences: Open User Settings (JSON)*)
and add:

```json
"github.copilot.chat.agentDebugLog.enabled": true,
"github.copilot.chat.agentDebugLog.fileLogging.enabled": true
```

Send one Agent message so the log file gets created, then locate it. It lives under
`…/Code/User/workspaceStorage/<hash>/GitHub.copilot-chat/debug-logs/main.jsonl`. Grab the newest one
(it's the workspace you just used):

```bash
# macOS
ls -t "$HOME/Library/Application Support/Code/User/workspaceStorage"/*/GitHub.copilot-chat/debug-logs/main.jsonl | head -1
# Linux
ls -t "$HOME/.config/Code/User/workspaceStorage"/*/GitHub.copilot-chat/debug-logs/main.jsonl | head -1
# Windows (PowerShell)
Get-ChildItem "$env:APPDATA\Code\User\workspaceStorage\*\GitHub.copilot-chat\debug-logs\main.jsonl" | Sort-Object LastWriteTime -Desc | Select-Object -First 1
```

> Using VS Code **Insiders**? Replace `Code` with `Code - Insiders`.
> **If `main.jsonl` never appears** (older build / gated flag), skip to the *manual inbox* fallback in
> Part 3 — the meter still works, you just paste each call's `usage` block.

---

## Part 3 — Start the live meter

```bash
# from the kit folder (not inside mfe-demo)
node copilot_meter_server.js
```

Open **http://localhost:7878**. You don't need the Part 2 path in the command any more — the server
scans this machine for **every VS Code workspace** with Copilot logs and lists them in the UI, newest
first, with the project folder name, date/time, and session count. In the **"Tail a workspace"** bar at
the top, pick your `mfe-demo` project and hit **▶ Tail live** to point the meter at its log. (Prefer the
old way? `node copilot_meter_server.js --tail "<main.jsonl path>" --inbox` still locks onto one file up
front and enables the manual-paste inbox.)

Each user prompt appears as an **agent loop** — a numbered step
timeline of the model calls it triggered (plan → read → search → edit → verify). Every step shows the
model that ran it, its AI-Credit cost, and a context-window bar (watch it grow step after step as history
is re-sent, and watch cache-read absorb it); the loop's cost bar shows a tiny output token count taking
the biggest slice of the bill. Hover any bar for its exact split; each loop's **step table** lists every
number. The sticky readout totals the session:
cost + 5,000-credit pool burn, tokens in/out, number of loops, and a **per-model spend** breakdown. The
**⟲ New session** button segments the meter so each experiment's totals stand alone. A collapsible
**"How to read this meter"** panel up top narrates all of it for the room.

Replaying a past run: **http://localhost:7878/sessions** lists every workspace on this machine (newest
first). Pick a **workspace**, then a **session by date**, then **Replay** to re-open it in the same step
view — handy for a backup if a live request misbehaves on stage. The **▶ Tail this workspace live**
button there jumps straight to the live meter pointed at that workspace.

**Manual inbox fallback** (guaranteed, ~1 keystroke per call): in VS Code open the Chat → `⋯` →
**Show Chat Debug View**, copy a call's `usage` block, then append it to the inbox:

```bash
# macOS                                  # Linux (X11)                              # Windows (PowerShell)
pbpaste >> copilot-meter-inbox.jsonl     xclip -o -selection clipboard >> copilot-meter-inbox.jsonl   Get-Clipboard | Add-Content copilot-meter-inbox.jsonl
```

The meter dedups and renders it instantly. (The server auto-created `copilot-meter-inbox.jsonl`.)

---

## Part 4 — Clean room (the determinism controls)

1. **Pin a model** in the Chat model picker (e.g., **Claude Sonnet 4.6**) — **not Auto** — for every
   experiment except #5. Auto hides which model ran.
2. **Reset code between edit experiments:** `git reset --hard HEAD && git clean -fdq` inside `mfe-demo`.
3. **Fresh chat per experiment:** click **New Chat**, and hit **⟲ New session** on the meter so totals
   don't carry over. *Exceptions:* #2 and #3 reuse one thread on purpose.
4. **Kill hidden context:** close all editor tabs between runs; disable other AI extensions; keep
   Copilot codebase indexing / web search in the **same** on/off state across all runs.
5. **Use Agent mode** for #4 and #7; Chat (Ask) mode is fine for the rest.

---

## Part 5 — The guided experiments

Each: **Reset → exact prompt to paste → what the meter shows → expected → if it varies.** Press
**⟲ New session** before each one.

### 1 — Attached-context size  ★★★  *(open with this)*
- **Reset:** New Chat. New session. Pinned model. Nothing attached.
- **A:** attach only the target — type `#` and pick `formatPrice.ts` — then:
  > `In this file, what does formatPrice do? One sentence.`
  Note the card's **input** tokens (P1) and session total.
- **B:** New Chat + New session. Attach `formatPrice.ts` **plus ~8 others** (`validateEmail.ts`,
  `http.ts`, `store.ts`, `cartSlice.ts`, `ProductList.tsx`, `CartView.tsx`, `Checkout.tsx`,
  `useProducts.ts`), then ask the identical question.
- **Meter shows:** the input segment and session total jump by roughly the added files' size.
- **Expected:** P8 ≫ P1. **If it varies:** barely — attached files are included verbatim.

### 2 — Multi-turn resend  ★★★
- **Reset:** New Chat + New session. Attach `validateEmail.ts` once.
- **Same thread**, five follow-ups:
  > `Add a guard that rejects an empty string.`
  > `Now also reject strings without a dot after the @.`
  > `Make the return type a discriminated result, not a boolean.`
  > `Add JSDoc with two examples.`
  > `Add a second function normalizeEmail that lowercases and trims.`
- **Meter shows:** each card's **input** climbs turn over turn (history re-sent); the session total
  accelerates.
- **Then:** New Chat + New session; ask for all five in one prompt. Compare its single input to the
  five-card sum. **Expected:** Σ(turns) ≫ single-shot.

### 3 — Cache reads  ★★★
- **Reset:** New Chat + New session. Pin a **Claude** model. Attach `formatPrice.ts`.
- **A:** ask anything about it — first card shows a large **cache-write** segment.
- **B (same thread):** ask a follow-up — next card shows a large **cache-read** segment billed cheap;
  per-call AIC drops despite similar token counts.
- **Expected:** call 1 pays the write premium; call 2 reads cheaply. **If it varies:** cache windows
  are short — do A then B back to back.

### 4 — MCP / tool-schema overhead  ★★☆  *(Agent mode)*
- **Reset:** New Chat + New session. **Agent** mode. Pinned model.
- **A (lean):** no MCP servers (or a scoped toolset). Small task:
  > `In formatPrice.ts, add a unit test file next to it covering USD and LKR.`
  Read the **first** card's input (P_lean).
- **B (loaded):** enable an MCP server (or the default/full toolset). New Chat + New session. Same task.
  Read the **first** card's input (P_loaded).
- **Expected:** P_loaded > P_lean by the injected schemas. **If it varies:** agent step count varies —
  that's why you read only the *first* card, which carries the schemas regardless.

### 5 — Model rate  ★★★
- **Reset:** New Chat + New session. Attach `formatPrice.ts`.
- **A:** pin **Claude Sonnet 4.6**, ask a fixed question, note the card's AIC.
- **B:** New Chat + New session, pin **GPT-5-mini** (or Haiku), ask the identical question.
- **Expected:** token counts are similar; AIC differs ~an order of magnitude. Hover each model in the
  picker to show its per-MTok rate. **If it varies:** tokenizers differ slightly; the rate gap dominates.

### 6 — Output discipline  ★★☆  *(the headline lever)*
- **Reset:** `git reset --hard HEAD`. New Chat + New session. Pinned model. Attach `validateEmail.ts`.
- **A (verbose):**
  > `Add stricter validation to validateEmail and explain your reasoning and everything you changed.`
  Note the **output** segment + AIC.
- **B (terse):** New Chat + New session. First add a rule — inline or in `.github/copilot-instructions.md`:
  > `Reply with only the changed lines as a diff. No prose, no restating the question.`
  Same task. **Expected:** the output segment shrinks sharply and AIC drops.
- **If it varies:** noisiest experiment — run each 2–3× and quote the **ratio** (verbose ≈ 3–5× terse).
  The meter shows the real billed output regardless.

### 7 — Explore vs targeted retrieval  ★★☆  *(the Graphify analog; Agent mode)*
- **Reset:** New Chat + New session. **Agent** mode. Pinned model.
- **A (explore):** no file hints —
  > `Where is formatPrice used across the repo, and what would break if I changed its signature?`
  Let it search/read. Note the **summed** input across the cards.
- **B (targeted):** New Chat + New session. Same question, but attach the three call sites with `#`:
  `ProductDetail.tsx`, `CartItem.tsx`, `CartView.tsx`.
- **Expected:** explore pulls far more file content into context than targeted.
- **Optional:** if Graphify is installed (`/graphify`, or its MCP), show a graph query returning the
  call-graph for `formatPrice` instead of file bodies.

---

## Part 6 — Results table (the meter auto-sums; fill for your backup)

| # | Variant | model | input | output | cache-read | cache-write | AIC (per call) | session AIC | Δ |
|---|---|---|---|---|---|---|---|---|---|
| 1 | 1 file | | | | | | | | — |
| 1 | 9 files | | | | | | | | |
| 2 | turn 1 | | | | | | | | — |
| 2 | turn 5 | | | | | | | | |
| 2 | single-shot | | | | | | | | |
| 3 | call 1 (write) | | | | | | | | — |
| 3 | call 2 (read) | | | | | | | | |
| 4 | lean toolset | | | | | | | | — |
| 4 | loaded toolset | | | | | | | | |
| 5 | Sonnet 4.6 | | | | | | | | — |
| 5 | GPT-5-mini | | | | | | | | |
| 6 | verbose | | | | | | | | — |
| 6 | terse | | | | | | | | |
| 7 | explore | | | | | | | | — |
| 7 | targeted | | | | | | | | |

Cross-check any single call against the harness: paste its `usage` block into
`python copilot_token_lab.py --verify usage.json` — it reproduces the AIC (server rates when present).

---

## Part 7 — Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Meter shows nothing on `--tail` | log file not created / wrong path / older VS Code | re-check Part 2 path; update VS Code; use the **inbox** fallback |
| Card badge says `est` not `exact` | that log line had no credit fields | fine — it's computed from counts × rates; the inbox/Ken-Muse block shows `exact` |
| Numbers drift rehearsal → live | model version update, or Auto switched models | pin models; run all A/B in one sitting |
| `output` segment unexpectedly large | model emitted hidden reasoning tokens | pin a non-reasoning model, or note it |
| "lean" run's input too high | leftover open tabs / indexing context | close tabs; keep indexing constant |
| "fresh" call already cheap | cache leaked from a prior thread | New Chat **and** New session before the run |

---

## Part 8 — The honest close (say it out loud)

> "Every number on that meter is GitHub's, not mine. I can't promise the same integer twice — a live
> model won't give you that — but watch the **direction** and the **magnitude** hold every time, and
> watch the cost bar put the weight on output. That's what you're actually optimizing day to day."
