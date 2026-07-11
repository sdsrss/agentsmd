'use strict';
// sampling-audit.js — retrospective batch scan of §10 observer rules across
// historical Codex transcripts. The live Stop hook checks the current last turn
// whenever Stop fires, but hit telemetry has no every-assistant-turn denominator.
// This walks every assistant turn in the window and
// re-runs the hook's exact detection, making that rate observable.
//
// Drift safeguard: scripts/tests/sampling-audit.test.js pins scanVocab + scanOrder
// to transcript-structure-scan.sh — same text in, same verdict out — and both read
// the SAME hooks/banned-vocab.patterns, so the vocabulary can't fork.
//
// Scope note: this retrospective tool currently scans vocabulary and report
// order only. The live hook also has iron-law-2 and honesty observers; they are
// excluded here until their per-turn classifiers share a tested implementation.

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');

const RULE_KEYS = ['§10-V', '§10-four-section-order'];
const MAX_DAYS = 100000000;

function defaultPatternsPath() { return path.join(__dirname, '..', 'hooks', 'banned-vocab.patterns'); }
function defaultSessionsDir(codexHome = P.codexHome()) { return path.join(codexHome, 'sessions'); }

// Load the banned-vocab pattern lines the live hook uses (comments/blanks dropped).
function loadVocabPatterns(patternsPath = defaultPatternsPath()) {
  let raw;
  try { raw = fs.readFileSync(patternsPath, 'utf8'); } catch { return []; }
  return raw.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}

// Mirror the hook: strip fenced code before matching so a banned word quoted
// inside ``` … ``` is not a violation (transcript-structure-scan.sh:59).
function stripFenced(text) { return String(text).replace(/```[\s\S]*?```/g, ''); }

// One §10-V hit per turn (the hook breaks on first match) — returns the matched
// pattern or null.
function scanVocab(text, patterns) {
  const s = stripFenced(text);
  for (const pat of patterns) {
    let re; try { re = new RegExp(pat, 'i'); } catch { continue; }
    if (re.test(s)) return pat;
  }
  return null;
}

// Mirror order_pos: first line-anchored position of a section label (or -1).
function labelPos(text, label) {
  const re = new RegExp('(^|\\n)[\\s>*-]*' + label + '\\b', 'i');
  const m = re.exec(text);
  return m ? m.index : -1;
}

// Four-section completeness/order (Done → Not done → Failed → Uncertain). Only
// judged when it is clearly a four-section report (Done + ≥2 trailing markers),
// exactly
// like transcript-structure-scan.sh:74-87.
function scanOrder(text) {
  const done = labelPos(text, 'Done');
  const parts = [labelPos(text, 'Not done'), labelPos(text, 'Failed'), labelPos(text, 'Uncertain')];
  const markers = parts.filter((p) => p >= 0).length;
  if (done < 0 || markers < 2) return false;
  if (parts.some((p) => p < 0)) return true;
  let prev = done, bad = false;
  for (const p of parts) { if (p < 0) continue; if (p < prev) bad = true; prev = p; }
  return bad;
}

// Pull every assistant turn's plain text from a Codex session JSONL
// ({timestamp,type,payload}). Handles the message / response_item / agent_message
// shapes; ignores user + tool rows.
function extractAssistantTurns(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const turns = [];
  const pull = (v, out) => {
    if (v == null) return;
    if (typeof v === 'string') { out.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) pull(x, out); return; }
    if (typeof v === 'object') {
      if (typeof v.text === 'string') out.push(v.text);
      else if (Array.isArray(v.content)) pull(v.content, out);
    }
  };
  for (const ln of raw.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    const p = o && o.payload != null ? o.payload : o;
    const role = p && (p.role || p.author);
    const isAssistant = role === 'assistant' || (o && o.type === 'agent_message');
    const isMsg = o && (o.type === 'message' || o.type === 'response_item' || o.type === 'agent_message' || (p && p.type === 'message'));
    if (isAssistant && isMsg) {
      const out = [];
      pull(p.content != null ? p.content : (p.text != null ? p.text : p.message), out);
      const t = out.join('\n').trim();
      if (t) turns.push(t);
    }
  }
  return turns;
}

// Collect *.jsonl under the (date-nested) sessions dir whose mtime is within the
// window. Bounded stack walk (guarded) — no unbounded recursion.
function walkTranscripts(dir, { days, now }) {
  const cutoff = now - days * 86400000;
  const out = [];
  const stack = [dir];
  let guard = 0;
  while (stack.length && guard < 200000) {
    guard++;
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      let st; try { st = fs.statSync(full); } catch { continue; }
      if (st.mtimeMs >= cutoff && st.mtimeMs <= now) out.push({ full, mtimeMs: st.mtimeMs });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs); // most-recent first (for --limit)
  return out.map((x) => x.full);
}

function emptyResult(days, limit) {
  return {
    days, limit: limit || null, transcripts: 0, turns: 0, truncated: 0,
    byRule: Object.fromEntries(RULE_KEYS.map((k) => [k, { hits: 0, transcriptsAffected: 0 }])),
  };
}

function samplingAudit({ sessionsDir = defaultSessionsDir(), days = 30, now = Date.now(), limit = 0 } = {}) {
  if (!Number.isSafeInteger(days) || days <= 0 || days > MAX_DAYS) days = 30;
  const result = emptyResult(days, limit);
  const patterns = loadVocabPatterns();
  let files;
  try { files = walkTranscripts(sessionsDir, { days, now }); } catch { return result; }
  if (!files || !files.length) return result;
  if (limit && Number.isSafeInteger(limit) && limit > 0 && files.length > limit) {
    result.truncated = files.length - limit; // no silent cap — surface what was dropped (§9)
    files = files.slice(0, limit);
  }
  result.transcripts = files.length;
  const affected = Object.fromEntries(RULE_KEYS.map((k) => [k, new Set()]));
  for (const f of files) {
    for (const text of extractAssistantTurns(f)) {
      result.turns++;
      if (scanVocab(text, patterns)) { result.byRule['§10-V'].hits++; affected['§10-V'].add(f); }
      if (scanOrder(text)) { result.byRule['§10-four-section-order'].hits++; affected['§10-four-section-order'].add(f); }
    }
  }
  for (const k of RULE_KEYS) result.byRule[k].transcriptsAffected = affected[k].size;
  return result;
}

function formatReport(r) {
  const lines = [];
  lines.push(`agentsmd sampling-audit — last ${r.days}d (§10 per-turn retrospective)`);
  const cap = r.limit ? ` · limit ${r.limit}${r.truncated ? ` (dropped ${r.truncated} older)` : ''}` : '';
  lines.push(`transcripts scanned: ${r.transcripts}${cap} · assistant turns: ${r.turns}`);
  if (!r.transcripts) { lines.push('\n(no transcripts in window — nothing to measure)'); return lines.join('\n'); }
  lines.push('');
  lines.push('rule                         turns w/ violation   transcripts affected');
  for (const k of RULE_KEYS) {
    const b = r.byRule[k];
    lines.push(`  ${k.padEnd(27)} ${String(b.hits).padStart(6)}               ${String(b.transcriptsAffected).padStart(6)}`);
  }
  lines.push('');
  lines.push('Live Stop observations have no every-turn denominator; this retrospective supplies it.');
  lines.push('A rising rate informs OPERATOR §O2 review and never changes the spec automatically.');
  return lines.join('\n');
}

function parseArgs(argv) {
  let days = 30, limit = 0;
  let sawDays = false, sawLimit = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    let m = arg.match(/^--days=(.+)$/);
    if (m) {
      if (sawDays) return { error: 'duplicate option: --days' };
      sawDays = true;
      if (!/^[1-9][0-9]*$/.test(m[1])) return { error: `invalid --days value: ${m[1]}` };
      days = Number(m[1]);
      if (!Number.isSafeInteger(days) || days > MAX_DAYS) return { error: `invalid --days value: ${m[1]}` };
      continue;
    }
    m = arg.match(/^--limit=(.+)$/);
    if (m) {
      if (sawLimit) return { error: 'duplicate option: --limit' };
      sawLimit = true;
      if (!/^[1-9][0-9]*$/.test(m[1])) return { error: `invalid --limit value: ${m[1]}` };
      limit = Number(m[1]);
      if (!Number.isSafeInteger(limit)) return { error: `invalid --limit value: ${m[1]}` };
      continue;
    }
    return { error: `unknown option: ${arg}` };
  }
  return { days, limit };
}

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  const usage = 'Usage: agentsmd-sampling-audit [--days=N] [--limit=N]';
  if (parsed.help) { console.log(usage); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd sampling-audit: ${parsed.error}`); console.error(usage); process.exit(2); }
  console.log(formatReport(samplingAudit({ days: parsed.days, limit: parsed.limit })));
}

module.exports = {
  samplingAudit, scanVocab, scanOrder, labelPos, loadVocabPatterns, stripFenced,
  extractAssistantTurns, walkTranscripts, defaultSessionsDir, formatReport, parseArgs,
  RULE_KEYS, MAX_DAYS,
};
