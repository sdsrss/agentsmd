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
// Scope note: this retrospective tool scans vocabulary and report order (both
// mirrored from the live hook), plus two CALIBRATION detectors. The live hook
// also has iron-law-2 and honesty observers; they are excluded here until their
// per-turn classifiers share a tested implementation.
//
// Calibration detectors (R2, 2026-07-25 audit). The §10 pair above re-measures
// rules a Stop hook ALREADY observes live — useful for a denominator, useless as
// blind-spot coverage. 28 of 43 manifest rules have no mechanical measurement at
// all; these two are the subset that is genuinely sequence-detectable without
// semantic understanding:
//   §9-preflight            — did `git status` run before the first mutation?
//   §3-plan-before-execute  — did `update_plan` run before the first mutation of
//                             an L2+-shaped session?
// Both are PROXIES and ship in calibration mode: counted and printed, never fed
// to a keep/demote decision, exactly like §9-tmp-residue-proxy's telemetry. What
// they can be wrong about is documented at each detector.

const fs = require('fs');
const path = require('path');
const P = require('./lib/paths');
// Same self/external classifier the telemetry side uses — one definition of
// "agentsmd's own sandbox" across the loop. R6-04 found ~50 QA sandboxes posing
// as field data in the telemetry ledger; transcripts carry the identical
// hazard (a conformance case runs in a real Codex session with a real cwd).
const { classifyProject } = require('./audit');

const RULE_KEYS = ['§10-V', '§10-four-section-order'];
// Calibration keys are deliberately a SEPARATE result shape (eligible/violations,
// not bare hits) so nothing downstream can mistake a proxy for a graded signal.
const CALIBRATION_KEYS = ['§9-preflight', '§3-plan-before-execute'];
const MAX_DAYS = 100000000;

// L2+ proxy: a session that mutated ≥2 distinct files, or applied ≥3 patches.
// No transcript states its own LEVEL, so this stands in for "coordinated
// multi-component Δ". It under-selects (a single-file contract change is L2 and
// is missed) and cannot see intent — hence calibration-only.
const L2_PROXY_MIN_FILES = 2;
const L2_PROXY_MIN_PATCHES = 3;

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
  const re = new RegExp('(^|\\n)[\\s>*-]*(?:\\*\\*)?' + label + '(?:\\*\\*)?[\\s]*:', 'i');
  const m = re.exec(text);
  return m ? m.index : -1;
}

// Four-section completeness/order (Done → Not done → Failed → Uncertain). Only
// judged whenever a literal `Done:` label makes the turn a structured report,
// exactly like transcript-structure-scan.sh.
function scanOrder(text) {
  const done = labelPos(text, 'Done');
  const parts = [labelPos(text, 'Not done'), labelPos(text, 'Failed'), labelPos(text, 'Uncertain')];
  if (done < 0) return false;
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

// Tool-call names Codex has used for shell execution across the versions in the
// session archive (exec / exec_command / shell_command / shell / run) — verified
// against ~/.codex/sessions before being listed. An unknown future name degrades
// to "no shell seen", never to a false violation.
const SHELL_TOOLS = new Set(['exec', 'exec_command', 'shell', 'shell_command', 'run', 'local_shell']);
const PATCH_TOOLS = new Set(['apply_patch', 'edit_file', 'write_file']);
const PLAN_TOOLS = new Set(['update_plan']);

// Pull the command text out of a tool call's arguments, whatever the shape:
// exec_command → {"cmd":"…"}, shell → {"command":["bash","-lc","…"]},
// custom_tool_call → a bare `input` string. Falls back to the raw JSON so a
// shape we have not seen still contributes its text to the `git status` scan
// (over-matching here can only SUPPRESS a violation, never invent one).
function toolCallText(payload) {
  const raw = payload && (payload.arguments != null ? payload.arguments : payload.input);
  if (raw == null) return '';
  if (typeof raw !== 'string') return JSON.stringify(raw);
  let o; try { o = JSON.parse(raw); } catch { return raw; }
  if (o == null || typeof o !== 'object') return raw;
  const cmd = o.cmd != null ? o.cmd : o.command;
  if (typeof cmd === 'string') return cmd;
  if (Array.isArray(cmd)) return cmd.join(' ');
  return raw;
}

// A patch issued through a shell/custom tool rather than a named apply_patch
// tool — modern Codex sends `apply_patch <<'EOF' *** Begin Patch …` through exec.
const PATCH_MARKER_RE = /apply_patch|\*\*\* Begin Patch/;

// Ordered tool events for the sequence detectors, read from the `response_item`
// stream ONLY. Two traps forced that restriction, both found by hand-checking a
// flagged transcript against its raw JSONL:
//
//  1. Two streams, two write latencies. `event_msg` rows (patch_apply_end,
//     agent_message) are appended live; `response_item` rows (the model's own
//     call history) land later. File order stays timestamp-monotonic, so the
//     mixture LOOKS ordered while placing a completed patch before the shell
//     calls that preceded it — a systematic false-violation generator for any
//     before/after rule.
//  2. Subagent attribution. An orchestrator transcript carries patch_apply_end
//     events emitted by its subagents (different turn_id, own transcripts). The
//     parent never touched a file, yet was scored as mutating without preflight.
//
// Within response_item, ordering is the session's own call order and every row
// belongs to this session. Mutation is therefore an apply_patch-shaped call, not
// "a shell command that might write": a heredoc or `sed -i` write is missed, so
// the detector under-counts eligibility instead of inventing violations.
function extractToolEvents(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return []; }
  const out = [];
  for (const ln of raw.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (!o || o.type !== 'response_item' || o.payload == null) continue;
    const p = o.payload;
    if (typeof p !== 'object') continue;
    const ptype = p.type;
    if (ptype !== 'function_call' && ptype !== 'custom_tool_call' && ptype !== 'local_shell_call') continue;
    const name = String(p.name || (ptype === 'local_shell_call' ? 'local_shell' : ''));
    const text = toolCallText(p);
    if (PLAN_TOOLS.has(name)) { out.push({ kind: 'plan', files: [], text }); continue; }
    // Patch shape wins over tool identity: an `exec` carrying apply_patch is a
    // mutation, not a read.
    if (PATCH_TOOLS.has(name) || PATCH_MARKER_RE.test(text)) { out.push({ kind: 'mutation', files: patchPaths(text), text }); continue; }
    if (SHELL_TOOLS.has(name)) { out.push({ kind: 'shell', files: [], text }); continue; }
  }
  return out;
}

// Best-effort file list from an apply_patch payload (`*** Update File: path`
// / `*** Add File: path`, or a JSON `path` field). Only feeds the L2+ proxy's
// distinct-file count; an empty list just makes the session look smaller.
function patchPaths(text) {
  const s = String(text || '');
  const out = new Set();
  for (const m of s.matchAll(/\*\*\* (?:Update|Add|Delete) File: ([^\n\\"]+)/g)) out.add(m[1].trim());
  for (const m of s.matchAll(/"(?:path|file_path)"\s*:\s*"([^"]+)"/g)) out.add(m[1]);
  return [...out];
}

// The session's working directory, slugified exactly as hooks/lib/rule-hits.sh
// writes `project` (every non-[a-zA-Z0-9-] char → '-'), so one classifier serves
// both surfaces. Absent session_meta → unknown, never silently "external".
function sessionClass(filePath) {
  let raw;
  try { raw = fs.readFileSync(filePath, 'utf8'); } catch { return 'unknown'; }
  for (const ln of raw.split(/\r?\n/)) {
    if (!ln.trim()) continue;
    let o; try { o = JSON.parse(ln); } catch { continue; }
    if (!o || o.type !== 'session_meta') continue;
    const cwd = o.payload && o.payload.cwd;
    if (typeof cwd !== 'string' || !cwd) return 'unknown';
    return classifyProject(cwd.replace(/[^a-zA-Z0-9-]/g, '-'));
  }
  return 'unknown';
}

const GIT_STATUS_RE = /\bgit\b[^\n;|&]{0,80}\bstatus\b/i;

// §9-preflight: "run `git status --short` before edits (L1+)". Eligible = the
// session applied ≥1 patch. Violation = no `git status` in any tool call before
// the FIRST mutation. Known blind spots (why this is calibration, not a gate):
// a status run in an earlier session of the same task, a non-git directory, and
// shell-only writes (invisible per the mutation definition above).
function scanPreflight(events) {
  const first = events.findIndex((e) => e.kind === 'mutation');
  if (first < 0) return { eligible: false, violation: false };
  const before = events.slice(0, first);
  const sawStatus = before.some((e) => e.kind === 'shell' && GIT_STATUS_RE.test(e.text));
  return { eligible: true, violation: !sawStatus };
}

// §3-plan-before-execute: "Plan before execute (L2+, MUST) — use update_plan".
// Eligible = the session looks L2+ by the file/patch proxy above. Violation = no
// update_plan call before the first mutation. Blind spots: the LEVEL proxy is
// structural (a big mechanical rename inflates it; a single-file contract change
// deflates it), and a plan kept in the task file instead of the tool is unseen.
function scanPlanBeforeExecute(events) {
  const mutations = events.filter((e) => e.kind === 'mutation');
  const files = new Set();
  for (const m of mutations) for (const f of m.files) files.add(f);
  const looksL2 = files.size >= L2_PROXY_MIN_FILES || mutations.length >= L2_PROXY_MIN_PATCHES;
  if (!looksL2) return { eligible: false, violation: false };
  const first = events.findIndex((e) => e.kind === 'mutation');
  const planned = events.slice(0, first).some((e) => e.kind === 'plan');
  return { eligible: true, violation: !planned };
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
    // eligible = sessions where the rule had an opportunity; violations = the
    // subset that missed it. A rate without its denominator is the exact mistake
    // OPERATOR §O2 forbids, so the shape carries both or neither.
    byCalibration: Object.fromEntries(CALIBRATION_KEYS.map((k) => [k, {
      eligible: 0, violations: 0,
      byClass: { self: { eligible: 0, violations: 0 }, external: { eligible: 0, violations: 0 }, unknown: { eligible: 0, violations: 0 } },
    }])),
    calibration: true,
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
    // Calibration detectors are per-TRANSCRIPT (a sequence property of the
    // session), not per-turn like the §10 pair above.
    const events = extractToolEvents(f);
    const cls = sessionClass(f);
    for (const [key, scan] of [['§9-preflight', scanPreflight], ['§3-plan-before-execute', scanPlanBeforeExecute]]) {
      const v = scan(events);
      if (!v.eligible) continue;
      const b = result.byCalibration[key];
      b.eligible++;
      b.byClass[cls].eligible++;
      if (v.violation) { b.violations++; b.byClass[cls].violations++; }
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
  lines.push('');
  lines.push('CALIBRATION — self-enforced rules no hook observes (proxy; NOT a governance signal yet):');
  lines.push('rule                         eligible   missed   rate    external-only (eligible/missed/rate)');
  for (const k of CALIBRATION_KEYS) {
    const b = r.byCalibration[k];
    const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—');
    const x = b.byClass.external;
    lines.push(`  ${k.padEnd(27)} ${String(b.eligible).padStart(6)}   ${String(b.violations).padStart(6)}   ${pct(b.violations, b.eligible).padStart(4)}    ${x.eligible}/${x.violations}/${pct(x.violations, x.eligible)}`);
  }
  lines.push('');
  lines.push('Eligibility is structural, not semantic: §9-preflight counts sessions that applied a');
  lines.push('patch; §3-plan-before-execute counts those whose file/patch spread looks L2+. Shell-only');
  lines.push('writes and cross-session context are invisible. agentsmd-owned sandboxes (conformance /');
  lines.push('blackbox cases) classify as self, so the external-only column is the field-data reading.');
  lines.push('Read these as a trend to calibrate against hand-reviewed sessions — do NOT keep/demote');
  lines.push('a rule off them.');
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
  extractToolEvents, toolCallText, patchPaths, scanPreflight, scanPlanBeforeExecute, sessionClass,
  RULE_KEYS, CALIBRATION_KEYS, MAX_DAYS, L2_PROXY_MIN_FILES, L2_PROXY_MIN_PATCHES,
};
