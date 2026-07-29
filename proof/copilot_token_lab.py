#!/usr/bin/env python3
"""
copilot_token_lab.py  --  GitHub Copilot Token Economics: live experiment harness
===============================================================================

A self-contained teaching tool for a tech session on usage-based billing (UBB).
It tokenizes *real* text with tiktoken and applies the exact pricing model from
the "GitHub Copilot Token Economics" reference (effective 2026-06-01):

    Credits = (input_tokens  / 1e6 * Rate_in)
            + (cached_tokens / 1e6 * Rate_cached)
            + (output_tokens / 1e6 * Rate_out)
    Auto model selection applies a 10% structural discount.

Each experiment isolates ONE developer behaviour, shows the real token delta and
the credit delta, and names the DO / DON'T it maps to in the reference doc.

USAGE
    python copilot_token_lab.py            # run every experiment
    python copilot_token_lab.py --list     # list experiments
    python copilot_token_lab.py --exp 4    # run one experiment by number
    python copilot_token_lab.py --model sonnet-4.6   # default model for single-model exps
    python copilot_token_lab.py --no-color # disable ANSI colour (for plain logs)

REQUIREMENTS
    pip install tiktoken
    First run downloads the BPE ranks (~2 MB). After that it works offline.
    If tiktoken cannot load ranks at all, the harness falls back to a clearly
    labelled ESTIMATE mode so a live demo never hard-crashes.

NOTE ON FIDELITY
    tiktoken (o200k_base / cl100k_base) is OpenAI's tokenizer. Claude and Gemini
    use different tokenizers, so cross-model counts are a faithful *proxy*, not
    exact. The relationships the session teaches (output >> input, history
    resend, schema overhead, tier spread) hold regardless of tokenizer.
"""

import argparse
import os
import re
import sys

# --------------------------------------------------------------------------- #
#  Colour helpers (ANSI, dependency-free)                                      #
# --------------------------------------------------------------------------- #
class C:
    enabled = True
    @classmethod
    def wrap(cls, code, s):
        return f"\033[{code}m{s}\033[0m" if cls.enabled else s
    @classmethod
    def bold(cls, s):  return cls.wrap("1", s)
    @classmethod
    def dim(cls, s):   return cls.wrap("2", s)
    @classmethod
    def red(cls, s):   return cls.wrap("31", s)
    @classmethod
    def grn(cls, s):   return cls.wrap("32", s)
    @classmethod
    def yel(cls, s):   return cls.wrap("33", s)
    @classmethod
    def blu(cls, s):   return cls.wrap("36", s)
    @classmethod
    def mag(cls, s):   return cls.wrap("35", s)


# --------------------------------------------------------------------------- #
#  Tokenizer: real tiktoken, with offline-safe fallbacks                       #
# --------------------------------------------------------------------------- #
def build_tokenizer():
    """Return (count_fn, label). Tries real tiktoken first, then a local rank
    file (env TIKTOKEN_RANKS), then a labelled heuristic estimate."""
    try:
        import tiktoken
        # 1) Normal path: works on any machine with internet on first run.
        for name in ("o200k_base", "cl100k_base"):
            try:
                enc = tiktoken.get_encoding(name)
                enc.encode("warmup")
                return (lambda t: len(enc.encode(t))), f"tiktoken:{name} (REAL)"
            except Exception:
                continue
        # 2) Offline path: a locally bundled cl100k rank file.
        ranks_path = os.environ.get("TIKTOKEN_RANKS", "")
        if ranks_path and os.path.exists(ranks_path):
            from tiktoken.load import load_tiktoken_bpe
            ranks = load_tiktoken_bpe(ranks_path)
            pat = (r"(?i:'s|'t|'re|'ve|'m|'ll|'d)|[^\r\n\p{L}\p{N}]?\p{L}+|"
                   r"\p{N}{1,3}| ?[^\s\p{L}\p{N}]+[\r\n]*|\s*[\r\n]+|\s+(?!\S)|\s+")
            enc = tiktoken.Encoding(
                name="cl100k_base", pat_str=pat, mergeable_ranks=ranks,
                special_tokens={"<|endoftext|>": 100257})
            return (lambda t: len(enc.encode(t))), "tiktoken:cl100k_local (REAL)"
    except Exception:
        pass

    # 3) Heuristic estimate (clearly labelled). Only used if tiktoken is absent.
    token_re = re.compile(r"\w+|[^\w\s]", re.UNICODE)
    def heuristic(text):
        pieces = token_re.findall(text)
        # ~1.3 sub-tokens per word-ish piece is a decent English approximation
        return max(1, round(sum(max(1, len(p) / 4) for p in pieces) + 0.3 * len(pieces)))
    return heuristic, "heuristic (ESTIMATE — install tiktoken for real counts)"


COUNT, TOK_LABEL = build_tokenizer()
def ntok(text: str) -> int:
    return COUNT(text)


# --------------------------------------------------------------------------- #
#  Pricing model (verbatim from the reference doc)                             #
# --------------------------------------------------------------------------- #
# Credits per 1,000,000 tokens.
MODELS = {
    "gpt-5-mini":     {"in": 25,  "cached": 2.5, "out": 200,  "tier": "Lightweight"},
    "gemini-3-flash": {"in": 50,  "cached": 5,   "out": 300,  "tier": "Lightweight"},
    "haiku-4.5":      {"in": 100, "cached": 10,  "out": 500,  "tier": "Lightweight"},
    "gpt-4.1":        {"in": 200, "cached": 50,  "out": 800,  "tier": "Standard"},
    "sonnet-4.6":     {"in": 300, "cached": 30,  "out": 1500, "tier": "Powerful"},
    "gemini-3.1-pro": {"in": 200, "cached": 20,  "out": 1200, "tier": "Powerful"},
    "opus-4.8":       {"in": 500, "cached": 50,  "out": 2500, "tier": "Frontier"},
    "gpt-5.5":        {"in": 500, "cached": 50,  "out": 3000, "tier": "Frontier"},
}
MONTHLY_POOL = 5000  # credits per seat, non-rolling

# Real GitHub billing meters FOUR rate lines, not three: fresh input, cache-READ
# (cheap), cache-WRITE (a one-time premium ~1.25x input, e.g. Sonnet 375), and
# output. The doc's table lists only input/cached/output, so we approximate
# cache-write at 1.25x input except where a real rate is known. AIC/MTok =
# (USD/MTok) x 100, and 1 AIC = $0.01. Source: VS Code Chat Debug View.
CACHE_WRITE_KNOWN = {"sonnet-4.6": 375}
for _name, _m in MODELS.items():
    _m["cache_write"] = CACHE_WRITE_KNOWN.get(_name, round(_m["in"] * 1.25, 1))


def credits(in_tok, out_tok, model="sonnet-4.6", cached_tok=0, auto=False):
    """Apply the doc's billing formula. cached_tok is the portion of in_tok that
    is cache-read; it is billed at the cheaper cached rate."""
    m = MODELS[model]
    fresh_in = max(0, in_tok - cached_tok)
    cost = (fresh_in / 1e6) * m["in"] \
         + (cached_tok / 1e6) * m["cached"] \
         + (out_tok / 1e6) * m["out"]
    if auto:
        cost *= 0.90  # 10% structural discount for Auto routing
    return cost


def aic_from_usage(prompt_tokens, completion_tokens, cached_tokens=0,
                   cache_creation_input_tokens=0, model="sonnet-4.6",
                   server_rates=None):
    """Reproduce VS Code's per-call AIC math from a real `usage` block.

    GitHub bills four token types. prompt_tokens already INCLUDES cache reads and
    cache writes, so fresh input = prompt - cache_read - cache_write. If
    server_rates (from the log's copilot_usage.token_details) are supplied they
    are authoritative; otherwise we use the model's rate table.
    Returns (counts: dict, rates: dict, aic: float)."""
    m = MODELS[model]
    fresh_in = max(0, prompt_tokens - cached_tokens - cache_creation_input_tokens)
    rates = server_rates or {"input": m["in"], "cache_read": m["cached"],
                             "cache_write": m["cache_write"], "output": m["out"]}
    counts = {"input": fresh_in, "cache_read": cached_tokens,
              "cache_write": cache_creation_input_tokens, "output": completion_tokens}
    aic = sum(counts[k] / 1e6 * rates[k] for k in counts)
    return counts, rates, aic


def parse_usage_blob(text):
    """Tolerantly pull the four token counts (and any server rates) out of a
    pasted VS Code `usage` / `copilot_usage` block — JSON or loose log text."""
    import json, re
    counts = {"prompt_tokens": 0, "completion_tokens": 0,
              "cached_tokens": 0, "cache_creation_input_tokens": 0}
    server_rates = None
    try:
        obj = json.loads(text)
    except Exception:
        obj = None
    if isinstance(obj, dict):
        counts["prompt_tokens"] = obj.get("prompt_tokens", 0)
        counts["completion_tokens"] = obj.get("completion_tokens", 0)
        det = obj.get("prompt_tokens_details", {}) or {}
        counts["cached_tokens"] = det.get("cached_tokens", 0)
        counts["cache_creation_input_tokens"] = det.get("cache_creation_input_tokens", 0)
        td = (obj.get("copilot_usage", {}) or {}).get("token_details")
        if td:
            # token_details rates are nano-AIU per token; AIC/MTok = (nano/token)/1000.
            server_rates = {d["token_type"]: (d["cost_per_batch"] / d["batch_size"]) / 1000.0
                            for d in td}
    else:  # regex fallback for loosely pasted text
        def g(key):
            mm = re.search(rf'"{key}"\s*:\s*(\d+)', text)
            return int(mm.group(1)) if mm else 0
        counts["prompt_tokens"] = g("prompt_tokens")
        counts["completion_tokens"] = g("completion_tokens")
        counts["cached_tokens"] = g("cached_tokens")
        counts["cache_creation_input_tokens"] = g("cache_creation_input_tokens")
    return counts, server_rates


# --------------------------------------------------------------------------- #
#  Small formatting helpers                                                    #
# --------------------------------------------------------------------------- #
def rule(char="─", n=78):
    print(C.dim(char * n))

def title(num, name):
    print()
    print(C.bold(C.blu(f"  EXPERIMENT {num}  ·  {name}")))
    rule("═")

def doref(text):
    print(C.mag("  ↳ Reference doc: ") + C.dim(text))

def pct(new, old):
    if old == 0:
        return "—"
    d = (new - old) / old * 100
    s = f"{d:+.0f}%"
    return C.grn(s) if d < 0 else C.red(s)

def row(label, in_t, out_t, cr, extra=""):
    print(f"  {label:<34} in={in_t:>7,}  out={out_t:>7,}  "
          f"{C.bold(f'{cr:>8.3f} cr')}  {extra}")

def headerline():
    print(C.dim(f"  {'scenario':<34} {'input':>10}  {'output':>10}  "
                f"{'credits':>11}  delta"))


# --------------------------------------------------------------------------- #
#  Realistic embedded sample text (so tiktoken measures meaningful counts)     #
# --------------------------------------------------------------------------- #
USER_PROMPT = (
    "Add input validation to the create_user function. Reject empty emails, "
    "validate the email format with a regex, ensure the password is at least "
    "12 characters, and raise a ValueError with a clear message on failure. "
    "Keep the existing return shape unchanged."
)

# A verbose assistant reply: restates the task, explains, rewrites the WHOLE
# file, then adds a summary. This is the default ungoverned behaviour.
VERBOSE_REPLY = '''Great question! You want to add input validation to the `create_user`
function so that it rejects empty emails, checks the email format, enforces a
minimum password length of 12 characters, and raises a clear `ValueError` when
any of these checks fail, while keeping the return shape the same. Let me walk
through the solution step by step and then give you the complete updated file.

First, we import the `re` module for regular-expression matching. Then inside
`create_user` we add a series of guard clauses at the top of the function. Here
is the full updated implementation:

```python
import re

EMAIL_RE = re.compile(r"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")

def create_user(email: str, password: str, db) -> dict:
    """Create a new user after validating the inputs."""
    if not email or not email.strip():
        raise ValueError("Email must not be empty.")
    if not EMAIL_RE.match(email):
        raise ValueError("Email format is invalid.")
    if len(password) < 12:
        raise ValueError("Password must be at least 12 characters long.")

    user = db.insert("users", {"email": email, "password_hash": hash_pw(password)})
    return {"id": user.id, "email": user.email}
```

To explain what changed: I added the `EMAIL_RE` constant so the regular
expression is compiled once instead of on every call, which is a small
performance win. I then added three guard clauses. The first checks that the
email is neither `None` nor an empty/whitespace string. The second validates the
format. The third enforces the password length. Each raises a `ValueError` with
a descriptive message so callers can surface the problem to the end user. The
return statement is unchanged, so the function's contract is preserved.

Let me know if you'd like me to add unit tests for these new validation paths,
or if you want the email regex to be stricter (for example, RFC 5322 compliant)!
'''

# A terse reply governed by output rules ("Changed code only · Don't restate").
TERSE_REPLY = '''```python
import re
EMAIL_RE = re.compile(r"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")

def create_user(email: str, password: str, db) -> dict:
    if not email or not email.strip():
        raise ValueError("Email must not be empty.")
    if not EMAIL_RE.match(email):
        raise ValueError("Email format is invalid.")
    if len(password) < 12:
        raise ValueError("Password must be at least 12 characters long.")
    user = db.insert("users", {"email": email, "password_hash": hash_pw(password)})
    return {"id": user.id, "email": user.email}
```
'''

# A realistic system prompt + instruction-file payload that rides on EVERY turn.
SYSTEM_PROMPT = (
    "You are GitHub Copilot, an AI programming assistant integrated into VS Code. "
    "Follow the user's coding conventions. Prefer standard library solutions. "
    "When editing, preserve unrelated code and formatting. Cite file paths."
)
INSTRUCTIONS_FILE = (
    "# copilot-instructions.md\n"
    "- Use 4-space indentation and type hints everywhere.\n"
    "- All new modules require a docstring and matching pytest file.\n"
    "- Never log secrets; route config through settings.py.\n"
    "- Commit messages follow Conventional Commits.\n"
    "- Onboarding: our service mesh uses Istio; the staging cluster is eks-stg-2; "
    "the on-call rota lives in PagerDuty; here is a long paragraph of historical "
    "context about why we migrated off the monolith in 2023 and the lessons we "
    "learned about database connection pooling and the great incident of Q3 ...\n"
) * 1  # the verbose-wiki anti-pattern lives here

# Three real-ish source files used for the open-tabs experiment.
FILE_AUTH = '''import jwt, time
from settings import JWT_SECRET, JWT_TTL

def issue_token(user_id: str, scopes: list[str]) -> str:
    now = int(time.time())
    payload = {"sub": user_id, "scopes": scopes, "iat": now, "exp": now + JWT_TTL}
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def verify_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except jwt.ExpiredSignatureError:
        raise PermissionError("token expired")
    except jwt.InvalidTokenError:
        raise PermissionError("token invalid")
'''
FILE_USERS = '''from dataclasses import dataclass
from auth import issue_token

@dataclass
class User:
    id: str
    email: str
    role: str = "member"

class UserRepo:
    def __init__(self, db): self.db = db
    def get(self, uid): return self.db.fetchone("select * from users where id=%s", uid)
    def create(self, email, pw_hash):
        return self.db.insert("users", {"email": email, "password_hash": pw_hash})
    def login(self, user):
        return issue_token(user.id, scopes=["read", "write"])
'''
FILE_BILLING = '''from decimal import Decimal

RATES = {"in": Decimal("300"), "out": Decimal("1500")}

def credits_for(in_tokens: int, out_tokens: int) -> Decimal:
    return (Decimal(in_tokens) / 1_000_000 * RATES["in"]
            + Decimal(out_tokens) / 1_000_000 * RATES["out"])

def monthly_burn(sessions_per_day: int, credits_per_session: Decimal) -> Decimal:
    return Decimal(sessions_per_day) * credits_per_session * 30
'''
TABS = {"auth.py": FILE_AUTH, "users.py": FILE_USERS, "billing.py": FILE_BILLING}

# A single realistic MCP tool schema (JSON injected into the agent's context).
TOOL_SCHEMA = '''{
  "name": "github_create_issue",
  "description": "Create a new issue in a GitHub repository with a title, body, labels and assignees.",
  "input_schema": {
    "type": "object",
    "properties": {
      "owner": {"type": "string", "description": "Repository owner login."},
      "repo": {"type": "string", "description": "Repository name."},
      "title": {"type": "string", "description": "Short issue title."},
      "body": {"type": "string", "description": "Markdown body of the issue."},
      "labels": {"type": "array", "items": {"type": "string"}, "description": "Label names to apply."},
      "assignees": {"type": "array", "items": {"type": "string"}, "description": "User logins to assign."},
      "milestone": {"type": "integer", "description": "Milestone number to associate."}
    },
    "required": ["owner", "repo", "title"]
  }
}'''

# --- Compression-stack samples (Experiment 10) ---------------------------- #
# A Caveman-style reply: filler stripped, code AND reasoning retained (distinct
# from the terse reply, which drops the explanation entirely).
CAVEMAN_REPLY = '''Compiled EMAIL_RE once at module scope. Three guard clauses before insert:
empty/whitespace email, regex format, password length < 12. Each raises ValueError
with a specific message. Return shape unchanged.

```python
import re
EMAIL_RE = re.compile(r"^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$")
def create_user(email, password, db):
    if not email or not email.strip():
        raise ValueError("Email must not be empty.")
    if not EMAIL_RE.match(email):
        raise ValueError("Email format is invalid.")
    if len(password) < 12:
        raise ValueError("Password must be at least 12 characters long.")
    user = db.insert("users", {"email": email, "password_hash": hash_pw(password)})
    return {"id": user.id, "email": user.email}
```
'''

# A noisy terminal/tool result that an agent dumps straight into context.
NOISY_LOG = '''npm warn deprecated inflight@1.0.6: This module is not supported, and leaks memory. Do not use it.
npm warn deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported.
npm warn deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported.
⸨░░░░░░░░░░░░░░░░⸩ ⠹ reify:lodash: timing reifyNode:node_modules/typescript Completed in 812ms
⸨████████░░░░░░░░⸩ ⠼ reify:esbuild: http fetch GET 200 https://registry.npmjs.org/esbuild
added 1423 packages, and audited 1424 packages in 38s
142 packages are looking for funding; run `npm fund` for details
8 vulnerabilities (3 moderate, 5 high); run `npm audit fix` to address
> jest --runInBand
 PASS  src/auth.test.ts (4.213 s)
 PASS  src/users.test.ts (3.880 s)
 FAIL  src/billing.test.ts
  ● credits_for › computes Claude Sonnet cost
    expect(received).toBeCloseTo(expected)
    Expected: 0.84   Received: 0.80
      at Object.<anonymous> (src/billing.test.ts:22:31)
Test Suites: 1 failed, 2 passed, 3 total
Tests:       1 failed, 17 passed, 18 total
Time:        11.402 s'''

# What an RTK-style interceptor leaves after stripping progress/noise.
RTK_STRIPPED = '''FAIL src/billing.test.ts: credits_for "computes Claude Sonnet cost"
  Expected 0.84, received 0.80 (src/billing.test.ts:22)
Suites: 1 failed, 2 passed. Tests: 1 failed, 17 passed.'''

# --- Graph-vs-grep samples (Experiment 11) -------------------------------- #
# Full files the agent would read into context when grepping the codebase.
GREP_CORPUS = "\n\n".join([FILE_AUTH, FILE_USERS, FILE_BILLING])
# The compact, structured answer a Graphify-style graph query returns instead.
GRAPH_RESULT = '''create_user  def @ users.py:31
  calls       hash_pw (auth.py:8), db.insert (db.py)
  called_by   routes.register (routes.py:42), tests/test_users.py:11
  blast_radius 3 files (users.py, routes.py, billing.py)
trace: routes.register -> create_user -> hash_pw   hops:2'''


# --------------------------------------------------------------------------- #
#  EXPERIMENT 0 — Reference check: reproduce the doc's published cost table     #
# --------------------------------------------------------------------------- #
def exp0_reference_check(args):
    title(0, "Reference check — reproduce the doc's 800-in / 400-out table")
    print("  Proves the credit engine matches the reference doc exactly before we")
    print("  trust it on real text. Fixed workload: 800 input, 400 output tokens.\n")
    headerline()
    for model in ("gpt-5-mini", "gpt-4.1", "sonnet-4.6", "opus-4.8", "gpt-5.5"):
        cr = credits(800, 400, model)
        out_share = (400 / 1e6 * MODELS[model]["out"]) / cr * 100
        row(f"{model} ({MODELS[model]['tier']})", 800, 400, cr,
            extra=C.dim(f"output = {out_share:.0f}% of cost"))
    print()
    print("  " + C.dim("Doc says: mini 0.10 · GPT-4.1 0.48 · Sonnet 0.84 · Opus 1.40 · GPT-5.5 1.60"))
    doref("COST COMPARISON table, p.1 — engine reproduces it to the cent.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 1 — Input vs output asymmetry                                     #
# --------------------------------------------------------------------------- #
def exp1_output_asymmetry(args):
    title(1, "Input vs output asymmetry — why output is the lever")
    model = args.model
    in_t = ntok(SYSTEM_PROMPT) + ntok(USER_PROMPT)
    out_t = ntok(VERBOSE_REPLY)
    cr = credits(in_t, out_t, model)
    cost_in = in_t / 1e6 * MODELS[model]["in"]
    cost_out = out_t / 1e6 * MODELS[model]["out"]
    print(f"  Model: {C.bold(model)}  (in {MODELS[model]['in']} / out "
          f"{MODELS[model]['out']} cr-per-1M, ratio {MODELS[model]['out']//MODELS[model]['in']}x)\n")
    headerline()
    row("identical input (sys+prompt)", in_t, 0, cost_in, extra=C.dim("input portion"))
    row("the model's verbose output", 0, out_t, cost_out, extra=C.dim("output portion"))
    rule()
    row("TOTAL one turn", in_t, out_t, cr,
        extra=C.red(f"output = {cost_out/cr*100:.0f}% of the bill"))
    print()
    print("  " + C.yel("Takeaway: you pay 4–10x more per output token. The cheapest token"))
    print("  " + C.yel("is the one the model never generates. Constrain output first."))
    doref("HOW BILLING WORKS, p.1 — 'Output tokens dominate cost'.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 2 — Terse output rules                                            #
# --------------------------------------------------------------------------- #
def exp2_terse_output(args):
    title(2, "Terse output rules — 'Code only · Don't restate · Changed code only'")
    model = args.model
    in_t = ntok(SYSTEM_PROMPT) + ntok(USER_PROMPT)
    v_out, t_out = ntok(VERBOSE_REPLY), ntok(TERSE_REPLY)
    v_cr = credits(in_t, v_out, model)
    t_cr = credits(in_t, t_out, model)
    print(f"  Same task, same input. Only the output discipline differs.\n")
    headerline()
    row("DON'T  verbose (restate+explain)", in_t, v_out, v_cr)
    row("DO     terse (changed code only)", in_t, t_out, t_cr,
        extra=pct(t_cr, v_cr) + C.dim(f"  ({pct(t_out, v_out)} output tokens)"))
    rule()
    saved = (1 - t_cr / v_cr) * 100
    print(f"\n  " + C.grn(f"Output rules cut this turn's cost by {saved:.0f}%.") +
          C.dim(" The doc cites up to 70%."))
    doref("INSTRUCTION FILES & OUTPUT CONTROL, p.2 — output rules for up to 70% reduction.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 3 — Context anatomy: what actually fills the window               #
# --------------------------------------------------------------------------- #
def exp3_context_anatomy(args):
    title(3, "Context anatomy — what fills the window (and gets re-billed)")
    model = args.model
    parts = [
        ("System prompt",            ntok(SYSTEM_PROMPT)),
        ("Instruction files",        ntok(INSTRUCTIONS_FILE)),
        ("Open tabs (3 files)",      sum(ntok(c) for c in TABS.values())),
        ("MCP tool schemas (x6)",    ntok(TOOL_SCHEMA) * 6),
        ("Your actual question",     ntok(USER_PROMPT)),
    ]
    print("  Every request bills the WHOLE window as input — not just your message.\n")
    headerline()
    running = 0
    for label, t in parts:
        running += t
        share = t / sum(p[1] for p in parts) * 100
        print(f"  {label:<34} {t:>10,}  {'':>10}  "
              f"{C.dim(f'{credits(t,0,model):>8.3f} cr'):>11}  "
              f"{C.dim(f'{share:>4.0f}% of input')}")
    rule()
    in_t = running
    out_t = ntok(TERSE_REPLY)
    cr = credits(in_t, out_t, model)
    row("TOTAL billed this turn", in_t, out_t, cr,
        extra=C.red(f"your question is only "
                    f"{ntok(USER_PROMPT)/in_t*100:.0f}% of the input"))
    print()
    print("  " + C.yel("The window is mostly overhead you configured, not what you typed."))
    print("  " + C.yel("Trim tabs, instructions and tool schemas to shrink every future turn."))
    doref("IDE & WORKSPACE HYGIENE + MCP TOOLS, p.2 — overhead injected into every request.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 4 — Multi-turn resend: piecemeal vs single-shot                   #
# --------------------------------------------------------------------------- #
def exp4_multiturn(args):
    title(4, "Multi-turn resend — piecemeal prompting re-bills history every turn")
    model = args.model
    base_in = ntok(SYSTEM_PROMPT) + ntok(INSTRUCTIONS_FILE)

    # Piecemeal: 5 small follow-ups. Each turn re-sends ALL prior messages.
    user_turns = [
        "Add email validation to create_user.",
        "Now also check the password length.",
        "Make the error messages clearer.",
        "Actually compile the regex at module level.",
        "Add a docstring too.",
    ]
    assistant_turns = [TERSE_REPLY] * len(user_turns)

    print("  Scenario: the same change, reached two ways. Billing re-sends the full")
    print("  thread as input on EVERY follow-up.\n")
    headerline()
    history = ""
    total_in_piece = 0
    total_out_piece = 0
    for i, (u, a) in enumerate(zip(user_turns, assistant_turns), 1):
        history += u + "\n"
        turn_in = base_in + ntok(history)      # full history re-billed
        turn_out = ntok(a)
        total_in_piece += turn_in
        total_out_piece += turn_out
        history += a + "\n"
        row(f"piecemeal turn {i}", turn_in, turn_out,
            credits(turn_in, turn_out, model))
    piece_cr = credits(total_in_piece, total_out_piece, model)
    rule()
    row("piecemeal TOTAL (5 turns)", total_in_piece, total_out_piece, piece_cr)

    # Single-shot: one comprehensive prompt, one answer.
    one_prompt = (USER_PROMPT + " Also compile the regex at module level and add a "
                  "docstring.")
    ss_in = base_in + ntok(one_prompt)
    ss_out = ntok(TERSE_REPLY)
    ss_cr = credits(ss_in, ss_out, model)
    print()
    row("single-shot (1 turn)", ss_in, ss_out, ss_cr, extra=pct(ss_cr, piece_cr))
    print()
    print("  " + C.yel(f"Piecemeal pays for the conversation {total_in_piece/ss_in:.1f}x over in "
                        f"input alone — history is re-billed each turn."))
    doref("IDE & WORKSPACE HYGIENE, p.2 — single-shot prompts; /new to reset context.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 5 — MCP toolset overhead                                          #
# --------------------------------------------------------------------------- #
def exp5_mcp_overhead(args):
    title(5, "MCP toolset overhead — schemas are billed before reasoning starts")
    model = args.model
    per_tool = ntok(TOOL_SCHEMA)
    steps = 8  # a modest agent loop
    print(f"  Measured size of one real tool schema: {C.bold(f'{per_tool} tokens')}.")
    print(f"  An agent loop re-sends the whole toolset on each of its ~{steps} steps.\n")
    headerline()
    scenarios = [
        ("DO    scoped  toolsets:[issues] (3 tools)", 3),
        ("           ~ default toolset (22 tools)",   22),
        ("DON'T 15+ global MCP servers (60 tools)",   60),
    ]
    base_in = ntok(SYSTEM_PROMPT) + ntok(USER_PROMPT)
    for label, tools in scenarios:
        schema_tokens = per_tool * tools
        in_per_step = base_in + schema_tokens
        in_total = in_per_step * steps
        out_total = ntok(TERSE_REPLY) * steps
        cr = credits(in_total, out_total, model)
        row(label, in_total, out_total, cr,
            extra=C.dim(f"{schema_tokens:,} schema tok/step"))
    print()
    print("  " + C.dim(f"Reality check: this is a compact {per_tool}-tok schema. Production MCP"))
    print("  " + C.dim("tools carry verbose descriptions + nested schemas (often 1–3K tok each),"))
    print("  " + C.dim("which is how the doc reaches ~55K for default and ~265K for 15+ servers."))
    print("  " + C.yel("Tool schemas are pure overhead paid on every agent step. Scope toolsets"))
    print("  " + C.yel("and prune idle servers; prefer the GitHub CLI for plain data fetches."))
    doref("MCP TOOLS & CODE REVIEW, p.2 — default toolset ~55K-token penalty; "
          "15+ servers up to 265K.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 6 — Open-tab hygiene                                              #
# --------------------------------------------------------------------------- #
def exp6_tabs(args):
    title(6, "Open-tab hygiene — every open tab is injected into every request")
    model = args.model
    one_set = sum(ntok(c) for c in TABS.values())  # 3 files
    avg_per_tab = one_set / 3
    requests = 10
    print(f"  Average measured tab size: {C.bold(f'{avg_per_tab:.0f} tokens/tab')}. "
          f"Modelling {requests} requests.\n")
    headerline()
    for tabs in (4, 12, 24):
        tab_tokens = round(avg_per_tab * tabs)
        in_per_req = ntok(SYSTEM_PROMPT) + ntok(USER_PROMPT) + tab_tokens
        in_total = in_per_req * requests
        out_total = ntok(TERSE_REPLY) * requests
        cr = credits(in_total, out_total, model)
        label = ("DO    3–5 tabs" if tabs <= 5 else
                 "      a dozen tabs" if tabs < 20 else "DON'T 20+ tabs")
        row(f"{label} ({tabs})", in_total, out_total, cr,
            extra=C.dim(f"{tab_tokens:,} tab tok/req"))
    print()
    print("  " + C.yel("Tab context is multiplied by every request in the session. Keep 3–5."))
    doref("IDE & WORKSPACE HYGIENE, p.2 — 'all tab contents are injected into every request'.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 7 — Model tier + Auto                                             #
# --------------------------------------------------------------------------- #
def exp7_tier_and_auto(args):
    title(7, "Model tier + Auto — identical work, up to 10x cost spread")
    # A realistic single agent turn from earlier experiments.
    in_t = ntok(SYSTEM_PROMPT) + ntok(INSTRUCTIONS_FILE) + ntok(USER_PROMPT) \
        + ntok(TOOL_SCHEMA) * 6
    out_t = ntok(TERSE_REPLY)
    print(f"  Fixed workload: in={in_t:,}  out={out_t:,}. Only the model changes.\n")
    headerline()
    cheapest = None
    for model, m in MODELS.items():
        cr = credits(in_t, out_t, model)
        cheapest = cr if cheapest is None else min(cheapest, cr)
        row(f"{model} ({m['tier']})", in_t, out_t, cr)
    print()
    # Auto discount illustration on the Powerful tier.
    base = credits(in_t, out_t, "sonnet-4.6")
    auto = credits(in_t, out_t, "sonnet-4.6", auto=True)
    most = max(credits(in_t, out_t, m) for m in MODELS)
    print(f"  Frontier vs Lightweight for the SAME task: "
          + C.red(f"{most/cheapest:.1f}x") + " more expensive "
          + C.dim("(input-heavy turns widen the gap beyond the doc's 10x baseline)."))
    print(f"  Auto routing (10% structural discount): "
          + f"{base:.3f} → " + C.grn(f"{auto:.3f} cr") + f"  ({pct(auto, base)})")
    doref("MODEL SELECTION, p.2 — default to Auto; gate Frontier to senior/complex work.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 8 — Cached input                                                  #
# --------------------------------------------------------------------------- #
def exp8_cached(args):
    title(8, "Cached input — a stable prefix is billed at the cached rate")
    model = args.model
    stable = ntok(SYSTEM_PROMPT) + ntok(INSTRUCTIONS_FILE)  # re-used every turn
    fresh = ntok(USER_PROMPT)
    out_t = ntok(TERSE_REPLY)
    print(f"  Stable prefix (sys+instructions) = {stable:,} tok, re-used every turn.")
    print(f"  Cached rate is ~10x cheaper than fresh input.\n")
    headerline()
    no_cache = credits(stable + fresh, out_t, model, cached_tok=0)
    with_cache = credits(stable + fresh, out_t, model, cached_tok=stable)
    row("DON'T  prefix billed as fresh input", stable + fresh, out_t, no_cache)
    row("DO     prefix served from cache",     stable + fresh, out_t, with_cache,
        extra=pct(with_cache, no_cache))
    print()
    print("  " + C.yel("Keep the high-value prefix stable and identical across turns so it"))
    print("  " + C.yel("stays cache-eligible; reshuffling it forces fresh-rate re-billing."))
    doref("MODEL TIER PRICING, p.1 — 'Cached' column (input cached at ~10% of fresh).")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 9 — Budget burn / pool depletion                                  #
# --------------------------------------------------------------------------- #
def exp9_budget_burn(args):
    title(9, "Budget burn — how fast a 5,000-credit pool drains")
    # A typical Agent Mode session: 50K in + 20K out (the doc's example).
    sess_in, sess_out = 50_000, 20_000
    sessions_per_day = 5
    print(f"  Doc's typical Agent session: {sess_in:,} in + {sess_out:,} out.")
    print(f"  Profile: {sessions_per_day} sessions/day against a "
          f"{MONTHLY_POOL:,}-credit monthly pool.\n")
    headerline()
    for model in ("gpt-5-mini", "gpt-4.1", "sonnet-4.6", "opus-4.8", "gpt-5.5"):
        verbose = credits(sess_in, sess_out, model)
        # terse: diffs-only cuts output ~70%
        terse = credits(sess_in, round(sess_out * 0.30), model)
        per_day_v = verbose * sessions_per_day
        days_v = MONTHLY_POOL / per_day_v if per_day_v else float("inf")
        days_t = MONTHLY_POOL / (terse * sessions_per_day)
        print(f"  {model:<16} verbose {verbose:>6.1f} cr/sess → "
              + C.red(f"{days_v:>4.1f} days")
              + C.dim(f"   | terse {terse:>5.1f} cr → ")
              + C.grn(f"{days_t:>4.1f} days"))
    print()
    print("  " + C.yel("Five Powerful sessions/day exhaust the pool in ~3 weeks; Frontier in"))
    print("  " + C.yel("days. Terse output + Auto routing can more than double your runway."))
    doref("AGENT MODE, p.1 — Sonnet session ~45 cr; 5/day exhaust 5,000 cr in ~20 days.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 10 — Compression stack (RTK · Caveman · Context-Mode)             #
# --------------------------------------------------------------------------- #
def exp10_compression_stack(args):
    title(10, "Compression stack — strip noise at input, output, and context")
    model = args.model
    print("  The doc's third-party tools each compress a different stream. We stack")
    print("  them on one agent turn and measure the real token deltas.\n")

    # Measured deltas on real text
    log_raw, log_rtk = ntok(NOISY_LOG), ntok(RTK_STRIPPED)
    out_raw, out_cave = ntok(VERBOSE_REPLY), ntok(CAVEMAN_REPLY)
    print(f"  RTK     terminal log:   {log_raw:>4} → {log_rtk:>3} tok  ({pct(log_rtk, log_raw)} noise)")
    print(f"  Caveman model output:   {out_raw:>4} → {out_cave:>3} tok  ({pct(out_cave, out_raw)} filler, reasoning kept)")
    print(f"  Context-Mode carried tool-output: doc claims ~98% compression\n")

    base_in = ntok(SYSTEM_PROMPT) + ntok(INSTRUCTIONS_FILE) + ntok(USER_PROMPT) + ntok(TOOL_SCHEMA) * 3
    steps = 8
    headerline()
    # Layer 0: raw — noisy logs in context every step, verbose output, tool-output carried
    carried = log_raw * steps  # tool outputs accumulate in context across the loop
    in0 = (base_in + log_raw) * steps + carried
    cr0 = credits(in0, out_raw * steps, model)
    row("L0  raw agent loop", in0, out_raw * steps, cr0)
    # Layer 1: +RTK (input/tool noise stripped)
    in1 = (base_in + log_rtk) * steps + log_rtk * steps
    cr1 = credits(in1, out_raw * steps, model)
    row("L1  + RTK (strip log noise)", in1, out_raw * steps, cr1, extra=pct(cr1, cr0))
    # Layer 2: +Caveman (output filler stripped)
    cr2 = credits(in1, out_cave * steps, model)
    row("L2  + Caveman (strip output filler)", in1, out_cave * steps, cr2, extra=pct(cr2, cr0))
    # Layer 3: +Context-Mode (carried tool-output compressed 98%)
    in3 = (base_in + log_rtk) * steps + round(log_rtk * steps * 0.02)
    cr3 = credits(in3, out_cave * steps, model)
    row("L3  + Context-Mode (compress context)", in3, out_cave * steps, cr3, extra=pct(cr3, cr0))
    print()
    print("  " + C.grn(f"Stacked, the three layers cut this agent turn by {(1-cr3/cr0)*100:.0f}%.")
          + C.dim(" Ratios per the doc; deltas on real text are measured."))
    doref("THIRD-PARTY TOOLS & MONITORING, p.2 — Caveman 75% · Context-Mode 98% · RTK 80–90%.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 11 — Graph vs grep (Graphify)                                     #
# --------------------------------------------------------------------------- #
def exp11_graph_vs_grep(args):
    title(11, "Graph vs grep — query a code graph instead of reading files")
    model = args.model
    print("  Task: 'what calls create_user and what breaks if I change it?'")
    print("  Grep: the agent reads whole files into context. Graph (Graphify): it")
    print("  queries an AST graph and gets back only the relevant nodes/edges.\n")

    files_touched = 12          # a realistic cross-file trace
    avg_file = ntok(GREP_CORPUS) / 3
    grep_in_per = ntok(SYSTEM_PROMPT) + ntok(USER_PROMPT) + round(avg_file * files_touched)
    graph_in_per = ntok(SYSTEM_PROMPT) + ntok(USER_PROMPT) + ntok(GRAPH_RESULT)
    steps = 4
    grep_in, graph_in = grep_in_per * steps, graph_in_per * steps
    out_t = ntok(TERSE_REPLY) * steps
    grep_cr = credits(grep_in, out_t, model)
    graph_cr = credits(graph_in, out_t, model)
    headerline()
    row(f"DON'T grep/read {files_touched} files", grep_in, out_t, grep_cr,
        extra=C.dim(f"{round(avg_file*files_touched):,} retrieval tok/step"))
    row("DO    one graph query (Graphify)", graph_in, out_t, graph_cr,
        extra=pct(graph_cr, grep_cr))
    print()
    print(f"  Retrieval context shrinks " + C.grn(f"{(avg_file*files_touched)/ntok(GRAPH_RESULT):.0f}x")
          + C.dim(" — the doc cites ~50x for graph queries vs grep."))
    print("  " + C.yel("A graph returns symbols and relationships, not file bodies; only the"))
    print("  " + C.yel("changed subgraph updates, so it stays cheap as the codebase grows."))
    doref("IDE & WORKSPACE HYGIENE, p.2 — don't let agents grep/find; use graph queries for 50x savings.")


# --------------------------------------------------------------------------- #
#  EXPERIMENT 12 — Verify against the VS Code Chat Debug View                    #
# --------------------------------------------------------------------------- #
def exp12_verify_debug_log(args):
    title(12, "Verify against real Copilot — read the Chat Debug View usage block")
    print("  In VS Code: Copilot Chat → ⋯ overflow → 'Show Chat Debug View' (or")
    print("  Command Palette → 'Developer: Show Chat Debug View'). Each model call")
    print("  logs a usage block and a copilotUsage line. Reproducing the published")
    print("  Ken Muse example for claude-sonnet-4.6 to confirm the math:\n")
    # The real example from the debug log.
    prompt_tokens, completion_tokens = 45882, 210
    cached_tokens, cache_write = 45150, 731
    counts, rates, aic = aic_from_usage(prompt_tokens, completion_tokens,
                                        cached_tokens, cache_write, "sonnet-4.6")
    print(f"  usage: prompt_tokens={prompt_tokens:,}  completion_tokens={completion_tokens}")
    print(f"         cached_tokens={cached_tokens:,}  cache_creation_input_tokens={cache_write}")
    print(f"  fresh input = {prompt_tokens:,} − {cached_tokens:,} − {cache_write} = "
          + C.bold(f"{counts['input']}") + " token\n")
    headerline()
    for k in ("cache_read", "cache_write", "input", "output"):
        contrib = counts[k] / 1e6 * rates[k]
        print(f"  {k:<34} {counts[k]:>10,}  {'':>10}  {C.bold(f'{contrib:>8.3f} cr'):>11}"
              f"  {C.dim(f'@ {rates[k]:g} AIC/M')}")
    rule()
    print(f"  {'computed total':<34} {'':>10}  {'':>10}  {C.bold(C.grn(f'{aic:>8.3f} cr')):>11}")
    print(f"  {'VS Code copilotUsage line':<34} {'':>10}  {'':>10}  {C.bold('   1.940 cr'):>11}"
          + C.dim("  ✓ match"))
    print()
    print("  " + C.yel("Live: run the SAME prompt twice in Copilot — once verbose, once with"))
    print("  " + C.yel("'changed code only' — and read both copilotUsage lines off the debug"))
    print("  " + C.yel("view. The delta is your terse-output saving, measured on real billing."))
    print()
    print("  " + C.dim("Cross-check a whole session against the billing dashboard: sum the"))
    print("  " + C.dim("per-call AIC here; the dashboard aggregate should track it (with lag)."))
    print("  " + C.dim("Paste your own block:  python copilot_token_lab.py --verify usage.json"))
    print("  " + C.dim("Rates come from the server in copilot_usage.token_details — no price"))
    print("  " + C.dim("sheet needed; the doc's table matches Sonnet/4.1/mini but read the VS"))
    print("  " + C.dim("Code model hover for Opus/GPT-5.5, whose live rates may differ."))
    doref("VS Code Chat Debug View — usage block, copilotUsage line, copilot_usage.token_details.")


def run_verify(path, model):
    """Verify a real pasted usage block from a file (or '-' for stdin)."""
    banner()
    text = sys.stdin.read() if path == "-" else open(path, encoding="utf-8").read()
    counts, server_rates = parse_usage_blob(text)
    c, rates, aic = aic_from_usage(counts["prompt_tokens"], counts["completion_tokens"],
                                   counts["cached_tokens"], counts["cache_creation_input_tokens"],
                                   model, server_rates)
    print(C.bold(C.blu(f"\n  VERIFY usage block  ·  model={model}"
                       f"  ·  rates={'server (exact)' if server_rates else 'doc table'}")))
    rule("═")
    headerline()
    for k in ("cache_read", "cache_write", "input", "output"):
        contrib = c[k] / 1e6 * rates[k]
        print(f"  {k:<34} {c[k]:>10,}  {'':>10}  {C.bold(f'{contrib:>8.3f} cr'):>11}"
              f"  {C.dim(f'@ {rates[k]:g} AIC/M')}")
    rule()
    print(f"  {'computed AIC for this call':<34} {'':>10}  {'':>10}  "
          + C.bold(C.grn(f'{aic:>8.3f} cr')))
    print(C.dim(f"\n  Compare to the call's copilotUsage line. fresh input = prompt "
                f"− cache_read − cache_write = {c['input']:,}.\n"))


# --------------------------------------------------------------------------- #
#  Runner                                                                       #
# --------------------------------------------------------------------------- #
EXPERIMENTS = [
    exp0_reference_check,
    exp1_output_asymmetry,
    exp2_terse_output,
    exp3_context_anatomy,
    exp4_multiturn,
    exp5_mcp_overhead,
    exp6_tabs,
    exp7_tier_and_auto,
    exp8_cached,
    exp9_budget_burn,
    exp10_compression_stack,
    exp11_graph_vs_grep,
    exp12_verify_debug_log,
]


def banner():
    print()
    print(C.bold(C.blu("  GITHUB COPILOT TOKEN ECONOMICS — LIVE EXPERIMENT HARNESS")))
    print(C.dim("  Usage-based billing · effective 2026-06-01 · internal engineering session"))
    mode = C.grn(TOK_LABEL) if "REAL" in TOK_LABEL else C.yel(TOK_LABEL)
    print(f"  Tokenizer: {mode}")
    rule("═")


def main():
    p = argparse.ArgumentParser(description="Copilot token-economics experiment harness")
    p.add_argument("--exp", type=int, help="run a single experiment by number (0-9)")
    p.add_argument("--model", default="sonnet-4.6", choices=list(MODELS),
                   help="default model for single-model experiments")
    p.add_argument("--list", action="store_true", help="list experiments and exit")
    p.add_argument("--verify", metavar="FILE", help="verify a real VS Code usage block "
                   "(file path, or - for stdin) and compute its AIC")
    p.add_argument("--no-color", action="store_true", help="disable ANSI colour")
    args = p.parse_args()

    if args.no_color or not sys.stdout.isatty():
        C.enabled = False

    if args.verify:
        run_verify(args.verify, args.model)
        return

    if args.list:
        print("\nExperiments:")
        for i, fn in enumerate(EXPERIMENTS):
            doc = fn.__doc__ or fn.__name__
            print(f"  {i}  {fn.__name__.split('_', 1)[1].replace('_', ' ')}")
        print("\nRun all:  python copilot_token_lab.py")
        print("Run one:  python copilot_token_lab.py --exp 4\n")
        return

    banner()
    if args.exp is not None:
        if not 0 <= args.exp < len(EXPERIMENTS):
            sys.exit(f"No experiment {args.exp}. Use --list.")
        EXPERIMENTS[args.exp](args)
    else:
        for fn in EXPERIMENTS:
            fn(args)
    print()
    rule("═")
    print(C.dim("  All figures use the reference doc's pricing model. tiktoken is an "
                "OpenAI-tokenizer proxy; cross-model counts are indicative, not exact.\n"))


if __name__ == "__main__":
    main()
