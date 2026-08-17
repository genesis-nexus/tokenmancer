#!/usr/bin/env node
/*
 * copilot_meter_server.js — tail GitHub Copilot's agent debug log (or a manual
 * inbox) and stream each LLM request's token + AI-Credit cost to a live browser
 * meter over Server-Sent Events. Pure Node stdlib — no npm install.
 *
 * USAGE
 *   node copilot_meter_server.js --tail "<path-to>/main.jsonl"     # auto: tail VS Code's agent debug log
 *   node copilot_meter_server.js --inbox                            # manual: tail ./copilot-meter-inbox.jsonl
 *   node copilot_meter_server.js --tail <file> --inbox --port 7878  # combine sources
 *
 * Then open http://localhost:7878
 *
 * The agent debug log appears once you set, in VS Code settings.json:
 *   "github.copilot.chat.agentDebugLog.enabled": true,
 *   "github.copilot.chat.agentDebugLog.fileLogging.enabled": true
 * It lives at: <workspaceStorage>/<hash>/GitHub.copilot-chat/debug-logs/main.jsonl
 * (the runbook has the per-OS path + a finder command).
 *
 * The parser is deliberately tolerant: it recursively hunts each JSON record for
 * token/credit fields under many possible names, so it survives schema drift. If
 * the auto-tail finds nothing on your VS Code build, use --inbox and paste the
 * Chat Debug View `usage` block — same UI, guaranteed to work.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ---- options ---------------------------------------------------------------
const argv = process.argv.slice(2);
const OPT = { port: 7878, tail: null, inbox: null, fromStart: false, rateModel: 'claude-sonnet-4.6' };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') OPT.port = +argv[++i];
  else if (a === '--tail') OPT.tail = argv[++i];
  else if (a === '--inbox') OPT.inbox = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : 'copilot-meter-inbox.jsonl';
  else if (a === '--from-start') OPT.fromStart = true;
  else if (a === '--rate-model') OPT.rateModel = argv[++i];
}
if (!OPT.tail && !OPT.inbox) OPT.inbox = 'copilot-meter-inbox.jsonl'; // sensible default: guaranteed to work with zero VS Code prerequisites

// ---- pricing (AIC per 1M tokens) for fallback when a log lacks credit fields
const MODELS = {
  'gpt-5-mini': { in: 25, cached: 2.5, cw: 31, out: 200 },
  // Copilot's gpt-5.3-codex telemetry currently aligns closer to mini-tier economics.
  'gpt-5.3-codex': { in: 25, cached: 2.5, cw: 31, out: 200 },
  'gemini-3-flash': { in: 50, cached: 5, cw: 63, out: 300 },
  'claude-haiku-4.5': { in: 100, cached: 10, cw: 125, out: 500 },
  'gpt-4.1': { in: 200, cached: 50, cw: 250, out: 800 },
  'claude-sonnet-4.6': { in: 300, cached: 30, cw: 375, out: 1500 },
  'gemini-3.1-pro': { in: 200, cached: 20, cw: 250, out: 1200 },
  'claude-opus-4.8': { in: 500, cached: 50, cw: 625, out: 2500 },
  'gpt-5.5': { in: 500, cached: 50, cw: 625, out: 3000 },
};
function rateFor(model) {
  const n = String(model || '').toLowerCase().replace(/[-_ .]/g, '');
  if (n.includes('opus')) return MODELS['claude-opus-4.8'];
  if (n.includes('sonnet')) return MODELS['claude-sonnet-4.6'];
  if (n.includes('haiku')) return MODELS['claude-haiku-4.5'];
  if (n.includes('codex')) return MODELS['gpt-5.3-codex'];
  if (n.includes('gpt5mini') || n.includes('gpt5.mini')) return MODELS['gpt-5-mini'];
  if (n.includes('gpt55') || n.includes('gpt5.5')) return MODELS['gpt-5.5'];
  if (n.includes('gpt41')) return MODELS['gpt-4.1'];
  if (n.includes('flash')) return MODELS['gemini-3-flash'];
  if (n.includes('gemini')) return MODELS['gemini-3.1-pro'];
  return MODELS[OPT.rateModel] || MODELS['claude-sonnet-4.6'];
}

function parseAicFromText(s) {
  if (typeof s !== 'string') return null;
  // Accept formats like: "53.5 AIC", "1,234.56 AIC", "53.5 cr"
  const m = s.match(/([\d,]+(?:\.\d+)?)\s*(AIC|AIU|cr|credits?)/i);
  if (!m) return null;
  const n = Number(String(m[1]).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

// ---- tolerant field harvesting --------------------------------------------
const KEY = {
  prompt: ['prompt_tokens', 'prompttokens', 'input_tokens', 'inputtokens'],
  completion: ['completion_tokens', 'completiontokens', 'output_tokens', 'outputtokens'],
  cacheRead: ['cached_tokens', 'cachedtokens', 'cache_read_input_tokens', 'cachereadtokens', 'cache_read'],
  cacheWrite: ['cache_creation_input_tokens', 'cache_creation_tokens', 'cachecreationtokens', 'cachecreationinputtokens', 'cachewritetokens'],
  model: ['resolved model', 'resolvedmodel', 'model', 'modelid', 'requestmodel'],
  reqType: ['requesttype', 'request_type', 'type', 'name'],
  tool: ['tool', 'toolname', 'tool_name', 'function', 'functionname', 'function_name'],
};

// ---- agentic-loop step classification -------------------------------------
// Every LLM round-trip inside one user prompt is a "step" of the agent loop.
// We label each step by what it was doing so the meter reads like a story:
// plan → read → search → edit → verify, rather than an anonymous call list.
const STEP_KINDS = {
  plan:   { label: 'Plan / Reason', icon: '◆', hint: 'Model thinks about the task and picks the next move' },
  read:   { label: 'Read file',     icon: '▤', hint: 'Model pulls a file into context to inspect it' },
  search: { label: 'Search repo',   icon: '⌕', hint: 'Model greps / semantic-searches to locate code' },
  edit:   { label: 'Edit code',     icon: '✎', hint: 'Model writes a change back into the workspace' },
  tool:   { label: 'Tool call',     icon: '⚙', hint: 'Model invokes a tool / MCP server' },
  verify: { label: 'Verify / Test', icon: '✓', hint: 'Model runs or checks the result' },
  chat:   { label: 'Chat reply',    icon: '💬', hint: 'Model answers you directly' },
  llm:    { label: 'LLM request',   icon: '•', hint: 'A model round-trip' },
};
function classifyStep(reqType, toolName) {
  const s = `${reqType || ''} ${toolName || ''}`.toLowerCase();
  if (/edit|apply|patch|insert|replace|createfile|writefile/.test(s)) return 'edit';
  if (/grep|search|find|semantic|codebase|usages|ripgrep/.test(s)) return 'search';
  if (/read|open|view|file\b|readfile|cat/.test(s)) return 'read';
  if (/test|run|terminal|verify|build|lint|exec/.test(s)) return 'verify';
  if (/plan|reason|think|todo/.test(s)) return 'plan';
  if (/tool|mcp|function/.test(s)) return 'tool';
  if (/chat|ask|panel\/chat|reply|conversation/.test(s)) return 'chat';
  return 'llm';
}
function harvest(obj, out) {
  if (obj == null || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) { obj.forEach(v => harvest(v, out)); return out; }
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    for (const field in KEY) if (KEY[field].includes(lk) && out[field] == null) {
      if (field === 'model' || field === 'reqType' || field === 'tool') { if (typeof v === 'string') out[field] = v; }
      else if (typeof v === 'number') out[field] = v;
    }
    if (lk === 'copilotusage' && typeof v === 'string') out._copilotUsageStr = v;          // "1.94 AIC (… nano-AIU)"
    // Exact per-call credit in nano-AIU. VS Code's agent log uses camelCase
    // `copilotUsageNanoAiu`; the Chat Debug View paste uses `total_nano_aiu`.
    if (out._nano == null && typeof v === 'number' &&
        ['total_nano_aiu', 'copilotusagenanoaiu', 'copilot_usage_nano_aiu', 'nano_aiu', 'usagenanoaiu'].includes(lk)) out._nano = v;
    if (lk === 'token_details' && Array.isArray(v)) out._tokenDetails = v;
    harvest(v, out);
  }
  return out;
}
function aicFromDetails(td) {
  // each: { batch_size, cost_per_batch (nano-AIU), token_count, token_type }
  let nano = 0;
  for (const d of td) nano += (d.token_count || 0) * ((d.cost_per_batch || 0) / (d.batch_size || 1e6));
  return nano / 1e9;
}

function collectText(node, out) {
  if (node == null) return;
  if (typeof node === 'string') {
    const t = node.trim();
    if (t) out.push(t);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach(v => collectText(v, out));
    return;
  }
  if (typeof node === 'object') {
    const preferred = ['text', 'content', 'prompt', 'message', 'userRequest'];
    for (const k of preferred) if (k in node) collectText(node[k], out);
    // Don't revisit the preferred keys — that double-counts the payload text.
    for (const [k, v] of Object.entries(node)) if (!preferred.includes(k)) collectText(v, out);
  }
}

function maybeJsonParse(v) {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!t) return null;
  if (!(t.startsWith('{') || t.startsWith('['))) return null;
  try { return JSON.parse(t); } catch (_) { return null; }
}

function extractPromptSnippet(rec) {
  const c = [];

  // Most Copilot debug logs store the user payload here.
  if (rec?.attrs?.userRequest) {
    const parsed = maybeJsonParse(rec.attrs.userRequest);
    if (parsed) collectText(parsed, c);
    else collectText(rec.attrs.userRequest, c);
  }

  // Additional fallback locations seen across schema variants.
  const fallbackFields = [
    rec?.attrs?.content,
    rec?.attrs?.prompt,
    rec?.attrs?.message,
    rec?.request,
    rec?.messages,
    rec?.message,
    rec?.prompt,
    rec?.text,
    rec?.attrs?.args,
  ];
  for (const f of fallbackFields) {
    const parsed = maybeJsonParse(f);
    if (parsed) collectText(parsed, c);
    else collectText(f, c);
  }

  if (!c.length) return '';
  const joined = c.join('\n').replace(/\s+/g, ' ').trim();
  return joined.slice(0, 500);
}

// ---- custom-instruction / context telemetry -------------------------------
// The agent log records which custom instructions, always-in-context files, and
// on-demand skill/agent catalogs were active. These ride along in the system
// prompt and are re-billed as input on every model call — a real, measurable
// lever. We parse the summary and (best-effort) measure the files on disk.
function isInstructionRecord(rec) {
  const n = String(rec && rec.name || '');
  return (rec && rec.type === 'discovery' && /instruction/i.test(n)) ||
         (rec && rec.type === 'generic' && /custom instructions/i.test(n));
}
function splitList(s) { return String(s || '').split(',').map(x => x.trim()).filter(Boolean); }
function uniqMerge(a, b) { return [...new Set([...(a || []), ...(b || [])])]; }
function estTokens(chars) { return Math.round(chars / 4); }   // labelled estimate; server has no tiktoken

function parseInstructions(rec, prev) {
  const s = prev || {
    meta: 'instructions', resolvedCount: 0, discoveryMs: null,
    loaded: [], folders: [], contextIncluded: [],
    onDemand: { instructions: [], skills: [], agents: [] },
    files: [], totalBytes: 0, totalTokens: 0, ts: 0,
  };
  s.ts = (typeof rec.ts === 'number' ? rec.ts : s.ts) || Date.now();
  const d = rec && rec.attrs && rec.attrs.details;
  if (typeof d !== 'string') return s;

  const mRes = d.match(/Resolved\s+(\d+)\s+instructions(?:\s+in\s+([\d.]+)ms)?/i);
  if (mRes) { s.resolvedCount = Math.max(s.resolvedCount, +mRes[1]); if (mRes[2]) s.discoveryMs = +mRes[2]; }
  const mLoaded = d.match(/loaded:\s*\[([^\]]*)\]/i);
  if (mLoaded) s.loaded = uniqMerge(s.loaded, splitList(mLoaded[1]));
  const mFolders = d.match(/folders:\s*\[([^\]]*)\]/i);
  if (mFolders) s.folders = uniqMerge(s.folders, splitList(mFolders[1]));
  const mCtx = d.match(/context included:\s*\[(\d+)\]\s*([^\n]*)/i);
  if (mCtx) s.contextIncluded = uniqMerge(s.contextIncluded, splitList(mCtx[2]));
  const mInstr = d.match(/(?:^|\n)\s*instructions:\s*\[(\d+)\]\s*([^\n]*)/i);
  if (mInstr) s.onDemand.instructions = uniqMerge(s.onDemand.instructions, splitList(mInstr[2]));
  const mSkills = d.match(/skills:\s*\[(\d+)\]\s*([^\n]*)/i);
  if (mSkills) s.onDemand.skills = uniqMerge(s.onDemand.skills, splitList(mSkills[2]));
  const mAgents = d.match(/agents:\s*\[(\d+)\]\s*([^\n]*)/i);
  if (mAgents) s.onDemand.agents = uniqMerge(s.onDemand.agents, splitList(mAgents[2]));
  return s;
}

// Derive candidate repo roots by stripping the known instruction-folder suffixes.
function repoRootsFromFolders(folders) {
  const roots = new Set();
  for (const f of folders || []) {
    const r = f.replace(/[\\/](\.github[\\/]instructions|\.claude[\\/]rules|\.copilot[\\/]instructions|\.github)[\\/]?$/i, '');
    if (r && r !== f) roots.add(r);
  }
  return [...roots];
}

// Best-effort: read the always-in-context + loaded instruction files to estimate
// how many tokens ride along on every call. Silently skips anything not found.
function measureInstructionFiles(s) {
  const files = [];
  const seenPaths = new Set();
  const tryRead = (p, name, kind) => {
    try {
      const abs = path.resolve(p);
      if (seenPaths.has(abs)) return true;
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        const c = fs.readFileSync(abs, 'utf8');
        files.push({ name, kind, bytes: c.length, tokens: estTokens(c.length) });
        seenPaths.add(abs);
        return true;
      }
    } catch (_) {}
    return false;
  };
  const roots = repoRootsFromFolders(s.folders);
  for (const f of s.contextIncluded) {
    const cands = [];
    for (const r of roots) { cands.push(path.join(r, f), path.join(r, '.github', f)); }
    cands.some(p => tryRead(p, f, 'context'));
  }
  for (const name of s.loaded) {
    const fname = /\.md$/i.test(name) ? name : `${name}.instructions.md`;
    (s.folders || []).some(folder => tryRead(path.join(folder, fname), fname, 'loaded'));
  }
  s.files = files;
  s.totalBytes = files.reduce((a, f) => a + f.bytes, 0);
  s.totalTokens = files.reduce((a, f) => a + f.tokens, 0);
  return s;
}

function createGroupingContext() {
  return {
    currentPromptId: '',
    promptById: new Map(),
    spanToPromptId: new Map(),
    promptIndexById: new Map(),   // groupId -> human-facing "Prompt #N"
    stepCountById: new Map(),     // groupId -> steps (LLM calls) seen so far
    promptSeq: 0,
  };
}

function registerPromptRecord(rec, ctx) {
  const sid = rec.sid || 'session';
  const spanId = rec.spanId || '';
  const groupId = spanId || `${sid}:prompt:${++ctx.promptSeq}`;
  const promptText = extractPromptSnippet(rec) || (rec?.attrs?.content || '[Prompt text unavailable]');
  ctx.currentPromptId = groupId;
  ctx.promptById.set(groupId, promptText);
  if (!ctx.promptIndexById.has(groupId)) ctx.promptIndexById.set(groupId, ctx.promptIndexById.size + 1);
  if (spanId) ctx.spanToPromptId.set(spanId, groupId);
  return groupId;
}

function linkRecordToPrompt(rec, ctx) {
  const spanId = rec.spanId || '';
  const parentSpanId = rec.parentSpanId || '';

  let groupId = '';
  if (parentSpanId) groupId = ctx.spanToPromptId.get(parentSpanId) || '';
  if (!groupId && parentSpanId && ctx.promptById.has(parentSpanId)) groupId = parentSpanId;
  if (!groupId) groupId = ctx.currentPromptId || '';

  if (spanId) ctx.spanToPromptId.set(spanId, groupId);
  return groupId;
}

function processRecord(rec, source, ctx, onEvent) {
  if (!rec || typeof rec !== 'object') return;

  if (rec.type === 'user_message') {
    registerPromptRecord(rec, ctx);
    return;
  }

  // Custom-instruction / context telemetry → its own panel, not a loop step.
  if (isInstructionRecord(rec)) {
    ctx._instr = parseInstructions(rec, ctx._instr);
    measureInstructionFiles(ctx._instr);
    onEvent({ ...ctx._instr, onDemand: { ...ctx._instr.onDemand }, files: [...ctx._instr.files], id: ++SEQ, source, sessionId: rec.sid || '' });
    return;
  }

  const ev = toEvent(rec, source);
  if (!ev) return;

  const groupId = linkRecordToPrompt(rec, ctx);
  ev.groupId = groupId || 'ungrouped';
  // Assign a stable, human-facing prompt number even for groups we never saw a
  // user_message for (some log shapes only carry request records).
  if (!ctx.promptIndexById.has(ev.groupId)) ctx.promptIndexById.set(ev.groupId, ctx.promptIndexById.size + 1);
  ev.promptGroupIndex = ctx.promptIndexById.get(ev.groupId);
  // Step number within this agent loop (1-based, in arrival order).
  const step = (ctx.stepCountById.get(ev.groupId) || 0) + 1;
  ctx.stepCountById.set(ev.groupId, step);
  ev.stepIndex = step;
  ev.userPrompt = ctx.promptById.get(ev.groupId) || '[Prompt text unavailable for this event]';
  onEvent(ev);
}

function toEvent(rec, source) {
  const h = harvest(rec, {});
  const hasTokens = h.prompt != null || h.completion != null;
  const hasCredit = h._nano != null || h._tokenDetails || h._copilotUsageStr;
  // Tool calls carry no model cost, but they ARE steps of the agent loop and the
  // user wants to see them in the breakdown alongside the priced LLM requests.
  const isTool = rec && rec.type === 'tool_call';
  if (!hasTokens && !hasCredit && !isTool) return null;

  const prompt = h.prompt || 0, completion = h.completion || 0;
  const cacheRead = h.cacheRead || 0, cacheWrite = h.cacheWrite || 0;
  const fresh = Math.max(0, prompt - cacheRead - cacheWrite);
  let aic = 0;
  if (h._nano != null) aic = h._nano / 1e9;                                   // exact credits from the log
  else if (h._tokenDetails) aic = aicFromDetails(h._tokenDetails);            // exact, from server rate lines
  else if (h._copilotUsageStr) { aic = parseAicFromText(h._copilotUsageStr) ?? 0; }
  else if (hasTokens) { const r = rateFor(h.model); aic = fresh / 1e6 * r.in + cacheRead / 1e6 * r.cached + cacheWrite / 1e6 * r.cw + completion / 1e6 * r.out; }

  const snippet = extractPromptSnippet(rec);
  let reqType, toolName, stepKind, model;
  if (isTool && !hasTokens && !hasCredit) {
    toolName = rec.name || h.tool || 'tool';
    reqType = 'tool_call';
    stepKind = classifyStep('tool_call', toolName);
    model = '';                              // tool execution — no model, no billed cost
  } else {
    reqType = h.reqType || 'LLM request';
    toolName = h.tool || '';
    stepKind = classifyStep(reqType, toolName);
    model = h.model || OPT.rateModel;
  }

  return {
    id: ++SEQ, ts: (typeof rec.ts === 'number' ? rec.ts : Date.now()), source,
    model, requestType: reqType,
    toolName, stepKind, isTool: !!(isTool && !hasTokens && !hasCredit),
    prompt, completion, cacheRead, cacheWrite, freshInput: fresh,
    aic: +aic.toFixed(6),
    systemPromptFile: (rec && rec.attrs && rec.attrs.systemPromptFile) || '',
    // exact = number came straight from the log (or a free tool step); est = rate-table fallback.
    exact: hasCredit || (isTool && !hasTokens && !hasCredit) ? true : false,
    promptSnippet: snippet || '[No prompt/chat payload in this log event] ',
    sessionId: rec.sid || '',
    spanId: rec.spanId || '',
    parentSpanId: rec.parentSpanId || '',
    eventType: rec.type || '',
    rawKey: `${rec.sid || ''}|${rec.spanId || ''}|${rec.ts || ''}|${rec.type || ''}|${h.model || ''}|${prompt}|${completion}|${aic}`,
  };
}

// ---- JSON object extraction (handles jsonl lines AND pretty-printed pastes)
function extractObjects(text) {
  const objs = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}') { depth--; if (depth === 0 && start >= 0) { try { objs.push(JSON.parse(text.slice(start, i + 1))); } catch (e) {} start = -1; } }
  }
  return objs;
}

// ---- event fan-out (SSE) ---------------------------------------------------
let SEQ = 0;
const clients = new Set();
const ring = [];                       // recent events for late-joining browsers
const seen = new Set();                 // dedup signatures
let INSTR_LATEST = null;               // latest custom-instruction summary (replayed to new SSE clients)
function emit(ev) {
  if (!ev) return;
  if (ev.meta === 'instructions') {     // custom-instruction summary — panel, not a step; always fresh
    INSTR_LATEST = ev;
    const l = `data: ${JSON.stringify(ev)}\n\n`;
    for (const res of clients) res.write(l);
    console.log(`  instructions: resolved=${ev.resolvedCount} context=[${ev.contextIncluded.join(', ')}] loaded=[${ev.loaded.join(', ')}]  ≈${ev.totalTokens} tok/call`);
    return;
  }
  const sig = ev.rawKey || `${ev.model}|${ev.prompt}|${ev.completion}|${ev.cacheRead}|${ev.aic}`;
  if (seen.has(sig)) return;            // skip re-reads of the same record
  seen.add(sig); if (seen.size > 5000) seen.clear();
  ring.push(ev); if (ring.length > 200) ring.shift();
  const line = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of clients) res.write(line);
  const tag = ev.exact ? 'exact' : 'est';
  console.log(`· ${ev.requestType} ${ev.model}  in=${ev.prompt} out=${ev.completion} cacheR=${ev.cacheRead}  ${ev.aic.toFixed(3)} AIC (${tag})`);
}
function broadcast(payload) { const l = `data: ${JSON.stringify(payload)}\n\n`; for (const r of clients) r.write(l); }

// ---- source: tail a jsonl file (per-line), switchable at runtime -----------
let ACTIVE_TAIL = null;   // { abs, read } — the file we're currently watching
function startLiveTail(file, { fresh = false } = {}) {
  const abs = path.resolve(file);
  // Stop watching the previous file (e.g. when the UI switches workspaces).
  if (ACTIVE_TAIL) { try { fs.unwatchFile(ACTIVE_TAIL.abs, ACTIVE_TAIL.read); } catch (_) {} ACTIVE_TAIL = null; }
  // On an explicit switch, clear history so the meter starts clean on the new file.
  if (fresh) { ring.length = 0; seen.clear(); INSTR_LATEST = null; broadcast({ control: 'session' }); }

  let pos = 0, buf = '';
  const ctx = createGroupingContext();

  function preloadRecent(limit) {
    try {
      const content = fs.readFileSync(abs, 'utf8');
      const lines = content.split('\n').filter(l => l.trim());
      const start = Math.max(0, lines.length - limit);
      for (let i = start; i < lines.length; i++) {
        extractObjects(lines[i]).forEach(o => processRecord(o, 'tail', ctx, emit));
      }
      console.log(`  preloaded ${Math.max(0, lines.length - start)} recent events`);
    } catch (_) {}
  }

  function read() {
    fs.stat(abs, (err, st) => {
      if (err) return;
      if (st.size < pos) { pos = 0; buf = ''; }          // rotated/truncated
      if (st.size === pos) return;
      const s = fs.createReadStream(abs, { start: pos, end: st.size - 1 });
      s.on('data', d => buf += d.toString('utf8'));
      s.on('end', () => {
        pos = st.size;
        let nl; while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
          if (line) extractObjects(line).forEach(o => processRecord(o, 'tail', ctx, emit));
        }
      });
    });
  }

  fs.stat(abs, (e, st) => {
    if (e) {
      pos = 0;
      read();
      return;
    }
    if (OPT.fromStart) {
      pos = 0;
      read();
      return;
    }
    preloadRecent(200);
    pos = st.size;
  });

  fs.watchFile(abs, { interval: 400 }, read);
  ACTIVE_TAIL = { abs, read };
  console.log(`  tailing: ${abs}`);
}

function resolveTailFile(inputPath) {
  const abs = path.resolve(inputPath);
  if (!fs.existsSync(abs)) return abs;
  const st = fs.statSync(abs);
  if (st.isDirectory()) {
    const main = path.join(abs, 'main.jsonl');
    if (fs.existsSync(main) && fs.statSync(main).isFile()) return main;
    throw new Error(`--tail points to a directory without main.jsonl: ${abs}`);
  }
  return abs;
}

function resolveSessionsRoot(tailInput) {
  const abs = path.resolve(tailInput);
  if (!fs.existsSync(abs)) return path.dirname(abs);
  const st = fs.statSync(abs);

  // If this is a session directory (contains main.jsonl), root is its parent.
  if (st.isDirectory()) {
    if (fs.existsSync(path.join(abs, 'main.jsonl'))) return path.dirname(abs);
    return abs;
  }

  // If this is a log file under a session dir, root is grandparent.
  if (st.isFile()) {
    const maybeSessionDir = path.dirname(abs);
    if (fs.existsSync(path.join(maybeSessionDir, 'main.jsonl'))) return path.dirname(maybeSessionDir);
    return path.dirname(abs);
  }

  return path.dirname(abs);
}

// ---- workstation-wide VS Code workspace discovery -------------------------
// So the browser can pick any workspace + session by date, no --tail needed.
function vsCodeStorageRoots() {
  const home = os.homedir();
  const channels = ['Code', 'Code - Insiders', 'VSCodium', 'Cursor'];
  const bases = [];
  if (process.platform === 'darwin') {
    for (const c of channels) bases.push(path.join(home, 'Library', 'Application Support', c, 'User', 'workspaceStorage'));
  } else if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const c of channels) bases.push(path.join(appdata, c, 'User', 'workspaceStorage'));
  } else {
    for (const c of channels) bases.push(path.join(home, '.config', c, 'User', 'workspaceStorage'));
  }
  return bases.filter(p => { try { return fs.existsSync(p) && fs.statSync(p).isDirectory(); } catch (_) { return false; } });
}

// Parse <hash>/workspace.json to recover the human folder name the user opened.
function readWorkspaceMeta(hashDir) {
  try {
    const p = path.join(hashDir, 'workspace.json');
    if (!fs.existsSync(p)) return { folder: '', folderName: '', isWorkspaceFile: false };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const uri = j.folder || j.workspace || '';
    let folder = uri;
    try { folder = decodeURIComponent(String(uri).replace(/^file:\/\//, '')); } catch (_) {}
    const folderName = folder ? path.basename(folder.replace(/[\\/]$/, '')) : '';
    return { folder, folderName, isWorkspaceFile: !!j.workspace };
  } catch (_) { return { folder: '', folderName: '', isWorkspaceFile: false }; }
}

// First/last timestamps across a set of jsonl lines (tolerant of non-ts lines).
function firstLastTs(lines) {
  let first = null, last = null;
  for (let i = 0; i < lines.length && first == null; i++) {
    if (!lines[i].trim()) continue;
    const o = extractObjects(lines[i])[0];
    if (o && typeof o.ts === 'number') first = o.ts;
  }
  for (let i = lines.length - 1; i >= 0 && last == null; i--) {
    if (!lines[i].trim()) continue;
    const o = extractObjects(lines[i])[0];
    if (o && typeof o.ts === 'number') last = o.ts;
  }
  return { first, last };
}

function buildSession(id, logDir, logFiles) {
  const primary = logFiles[0];
  const mainPath = path.join(logDir, primary);
  let eventCount = 0, first = null, last = null;
  try {
    const lines = fs.readFileSync(mainPath, 'utf8').split('\n').filter(l => l.trim());
    eventCount = lines.length;
    const t = firstLastTs(lines); first = t.first; last = t.last;
  } catch (_) {}
  let mtime = Date.now();
  try { mtime = fs.statSync(mainPath).mtime.getTime(); } catch (_) {}
  const start = new Date(first || mtime), end = new Date(last || mtime);
  const dateStr = start.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
  const timeRange = `${start.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} - ${end.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  return {
    id, name: `${dateStr} ${timeRange}`, shortId: String(id).slice(0, 8),
    logDir, logFiles, events: eventCount,
    modified: new Date(mtime).toISOString(),
    startTime: start.toISOString(), endTime: end.toISOString(), dateStr, timeRange,
  };
}

// Sessions inside one debug-logs dir. Handles both the flat layout
// (main.jsonl directly in debug-logs) and the per-session-subdir layout.
function discoverSessionsIn(debugLogsDir) {
  const dir = path.resolve(debugLogsDir);
  const sessions = [];
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return sessions; }
  const orderLogs = arr => arr.sort((a, b) => a === 'main.jsonl' ? -1 : b === 'main.jsonl' ? 1 : a.localeCompare(b));

  const flat = entries.filter(e => e.isFile() && e.name.endsWith('.jsonl')).map(e => e.name);
  if (flat.length) sessions.push(buildSession('main', dir, orderLogs(flat)));

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const sdir = path.join(dir, ent.name);
    let files = [];
    try { files = fs.readdirSync(sdir).filter(f => f.endsWith('.jsonl')); } catch (_) { continue; }
    if (!files.length) continue;
    sessions.push(buildSession(ent.name, sdir, orderLogs(files)));
  }
  return sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

function discoverWorkspaces() {
  const out = [];
  for (const root of vsCodeStorageRoots()) {
    const channel = path.basename(path.dirname(path.dirname(root))); // .../<channel>/User/workspaceStorage
    let hashes = [];
    try { hashes = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name); } catch (_) { continue; }
    for (const hash of hashes) {
      const hashDir = path.join(root, hash);
      const debugLogsDir = path.join(hashDir, 'GitHub.copilot-chat', 'debug-logs');
      if (!fs.existsSync(debugLogsDir)) continue;
      let sessions = [];
      try { sessions = discoverSessionsIn(debugLogsDir); } catch (_) {}
      if (!sessions.length) continue;
      const meta = readWorkspaceMeta(hashDir);
      let modified = 0;
      for (const s of sessions) { const t = new Date(s.modified).getTime(); if (t > modified) modified = t; }
      const modDate = new Date(modified || Date.now());
      out.push({
        id: hash, channel, storageRoot: root, debugLogsDir,
        folder: meta.folder, folderName: meta.folderName || hash.slice(0, 8),
        isWorkspaceFile: meta.isWorkspaceFile,
        sessionCount: sessions.length,
        modified: modDate.toISOString(),
        modifiedStr: modDate.toLocaleString('en-US', { month: 'short', day: 'numeric', year: '2-digit', hour: '2-digit', minute: '2-digit' }),
      });
    }
  }
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

function findWorkspace(wsId) { return discoverWorkspaces().find(w => w.id === wsId); }

function resolveWorkspaceSessions(wsId) {
  const ws = findWorkspace(wsId);
  if (!ws) return null;
  return { ws, sessions: discoverSessionsIn(ws.debugLogsDir) };
}

// Resolve (workspace, session, logFile) → absolute path, guarding against
// path traversal outside the workspace's debug-logs dir.
function resolveLogPath(wsId, sessionId, logFile) {
  const r = resolveWorkspaceSessions(wsId);
  if (!r) return null;
  const s = r.sessions.find(x => x.id === sessionId);
  if (!s || !s.logFiles.includes(logFile)) return null;
  const abs = path.resolve(path.join(s.logDir, logFile));
  const rootAbs = path.resolve(r.ws.debugLogsDir);
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null;
  return abs;
}

function loadLogFile(absFile, sessionId) {
  const events = [];
  const ctx = createGroupingContext();
  try {
    const lines = fs.readFileSync(absFile, 'utf8').split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      extractObjects(line).forEach(obj => processRecord(obj, 'archive', ctx, ev => { ev.sessionId = sessionId; events.push(ev); }));
    }
  } catch (e) { console.error(`Failed to load log: ${e.message}`); }
  return events;
}

// ---- source: manual inbox (whole-file rescan, supports pasted blocks) -------
function watchInbox(file) {
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, '');
  function rescan() { try { extractObjects(fs.readFileSync(abs, 'utf8')).forEach(o => emit(toEvent(o, 'inbox'))); } catch (e) {} }
  fs.watchFile(abs, { interval: 400 }, rescan);
  rescan();
  console.log(`  inbox (paste usage blocks here): ${abs}`);
}

// ---- archive session discovery & loading ----------------------------------
function discoverSessions(rootDir) {
  // Find all session dirs containing log files
  const sessions = [];
  try {
    const debugLogsDir = path.resolve(rootDir);
    const entries = fs.readdirSync(debugLogsDir, { withFileTypes: true });
    
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const sessionPath = path.join(debugLogsDir, ent.name);
      const files = fs.readdirSync(sessionPath);
      
      // Look for .jsonl files (main.jsonl, title-*.jsonl, etc.)
      const logFiles = files.filter(f => f.endsWith('.jsonl'));
      if (logFiles.length === 0) continue;
      
      // Count events and get timing from main log
      let eventCount = 0;
      let firstEvent = null;
      let lastEvent = null;
      
      const mainLog = path.join(sessionPath, 'main.jsonl');
      if (fs.existsSync(mainLog)) {
        try {
          const content = fs.readFileSync(mainLog, 'utf8');
          const lines = content.split('\n').filter(l => l.trim());
          eventCount = lines.length;
          
          // Parse first and last event for timing
          if (lines.length > 0) {
            const firstObjs = extractObjects(lines[0]);
            if (firstObjs.length > 0) {
              const firstEv = toEvent(firstObjs[0], 'archive');
              if (firstEv) firstEvent = firstEv.ts;
            }
            
            const lastObjs = extractObjects(lines[lines.length - 1]);
            if (lastObjs.length > 0) {
              const lastEv = toEvent(lastObjs[0], 'archive');
              if (lastEv) lastEvent = lastEv.ts;
            }
          }
        } catch (e) {}
      }
      
      const stat = fs.statSync(sessionPath);
      const modDate = new Date(stat.mtime);
      const startDate = firstEvent ? new Date(firstEvent) : modDate;
      const endDate = lastEvent ? new Date(lastEvent) : modDate;
      
      const dateStr = startDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
      const timeRange = `${startDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })} - ${endDate.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
      
      sessions.push({
        id: ent.name,
        name: `${dateStr} ${timeRange}`,
        shortId: ent.name.slice(0, 8),
        path: sessionPath,
        logFiles,
        events: eventCount,
        modified: stat.mtime.toISOString(),
        startTime: startDate.toISOString(),
        endTime: endDate.toISOString(),
        dateStr,
        timeRange,
      });
    }
  } catch (e) {
    console.error(`Failed to discover sessions: ${e.message}`);
  }
  return sessions.sort((a, b) => b.startTime.localeCompare(a.startTime));
}

function loadSessionLog(sessionPath, logFile, sessionId) {
  // Parse all events from a specific log file
  const events = [];
  const filePath = path.join(sessionPath, logFile);
  const ctx = createGroupingContext();
  
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    let firstTs = null, lastTs = null;
    
    for (const line of lines) {
      if (!line.trim()) continue;
      const objs = extractObjects(line);
      for (const obj of objs) {
        processRecord(obj, 'archive', ctx, (ev) => {
          ev.sessionId = sessionId;
          events.push(ev);
          if (!firstTs) firstTs = ev.ts;
          lastTs = ev.ts;
        });
      }
    }
  } catch (e) {
    console.error(`Failed to load session log: ${e.message}`);
  }
  
  return events;
}

// ---- http server ------------------------------------------------------------
const HTML = path.join(__dirname, 'copilot_live_meter.html');
const VIEWER = path.join(__dirname, 'copilot_session_viewer.html');
let SESSIONS = [];  // cached session list

function parseUrl(url) {
  const [path, query] = url.split('?');
  const params = new URLSearchParams(query || '');
  return { path, params };
}

const server = http.createServer((req, res) => {
  const { path: urlPath, params } = parseUrl(req.url);
  
  if (urlPath === '/' || urlPath === '/index.html' || urlPath === '/live') {
    fs.readFile(HTML, (e, b) => {
      if (e) { res.writeHead(500); res.end('copilot_live_meter.html not found next to the server'); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(b); }
    });
  } else if (urlPath === '/sessions' || urlPath === '/viewer') {
    fs.readFile(VIEWER, (e, b) => {
      if (e) { res.writeHead(500); res.end('copilot_session_viewer.html not found next to the server'); }
      else { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(b); }
    });
  } else if (urlPath === '/api/sessions') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(SESSIONS));
  } else if (urlPath.startsWith('/api/session/')) {
    const sessionId = urlPath.replace('/api/session/', '');
    const logFile = params.get('log') || 'main.jsonl';
    const session = SESSIONS.find(s => s.id === sessionId);
    
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }
    
    if (!session.logFiles.includes(logFile)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Log file not found in session' }));
      return;
    }
    
    const events = loadSessionLog(session.path, logFile, sessionId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
  } else if (urlPath === '/api/workspaces') {
    // Every VS Code workspace on this machine that has Copilot debug logs.
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(discoverWorkspaces()));
  } else if (urlPath === '/api/workspace-sessions') {
    const r = resolveWorkspaceSessions(params.get('ws'));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(r ? r.sessions : []));
  } else if (urlPath === '/api/log') {
    const abs = resolveLogPath(params.get('ws'), params.get('session'), params.get('log') || 'main.jsonl');
    if (!abs) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Log not found' })); return; }
    const events = loadLogFile(abs, params.get('session') || 'main');
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(events));
  } else if (urlPath === '/api/tail' && req.method === 'POST') {
    // Point the live meter at a chosen workspace/session — no --tail flag needed.
    const r = resolveWorkspaceSessions(params.get('ws'));
    if (!r || !r.sessions.length) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Workspace not found or has no sessions' })); return; }
    const sessionId = params.get('session');
    const s = sessionId ? r.sessions.find(x => x.id === sessionId) : r.sessions[0];
    if (!s) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Session not found' })); return; }
    let logFile = params.get('log');
    if (!logFile || !s.logFiles.includes(logFile)) logFile = s.logFiles[0];
    const abs = path.resolve(path.join(s.logDir, logFile));
    startLiveTail(abs, { fresh: true });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, file: abs, workspace: r.ws.folderName, session: s.id, log: logFile }));
  } else if (req.url === '/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    if (INSTR_LATEST) res.write(`data: ${JSON.stringify(INSTR_LATEST)}\n\n`);   // replay instruction panel
    ring.forEach(ev => res.write(`data: ${JSON.stringify(ev)}\n\n`));   // replay history
    clients.add(res);
    const hb = setInterval(() => res.write(': hb\n\n'), 15000);
    req.on('close', () => { clearInterval(hb); clients.delete(res); });
  } else if (req.url === '/session/new' && req.method === 'POST') {
    broadcast({ control: 'session' }); res.writeHead(204); res.end();
  } else if (req.url === '/health') { res.writeHead(200); res.end('ok'); }
  else { res.writeHead(404); res.end(); }
});
server.listen(OPT.port, () => {
  console.log(`\nCopilot live meter → http://localhost:${OPT.port}`);
  console.log(`Copilot session viewer → http://localhost:${OPT.port}/sessions\n`);

  // Always scan the whole workstation for VS Code workspaces with Copilot logs,
  // so the browser can pick any workspace + session by date — no --tail needed.
  const workspaces = discoverWorkspaces();
  console.log(`Found ${workspaces.length} VS Code workspace(s) with Copilot logs:`);
  workspaces.slice(0, 12).forEach(w => console.log(`  [${w.id.slice(0, 8)}] ${w.folderName}  ·  ${w.modifiedStr}  ·  ${w.sessionCount} session(s)`));
  if (workspaces.length > 12) console.log(`  … and ${workspaces.length - 12} more (all listed in the browser picker)`);
  console.log('');

  // Discover archived sessions (from --tail path parent directory)
  if (OPT.tail) {
    const sessionRoot = resolveSessionsRoot(OPT.tail);
    SESSIONS = discoverSessions(sessionRoot);
    console.log(`Found ${SESSIONS.length} archived session(s) near --tail:`);
    SESSIONS.forEach(s => console.log(`  [${s.shortId}] ${s.name} - ${s.events} events`));
    console.log('');
    const tailFile = resolveTailFile(OPT.tail);
    startLiveTail(tailFile);
  }

  if (OPT.inbox) watchInbox(OPT.inbox);
  console.log('');
});
