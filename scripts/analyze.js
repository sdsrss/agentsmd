'use strict';
// analyze.js — deterministic shell for the agentsmd-analyze skill. NO AI here.
// --gather: capped, ignore-aware source map for the agent to read.
// --write:  inject the agent's distilled conventions into ./AGENTS.md, refusing
//           (never truncating) past the size budget.
const fs = require('fs');
const path = require('path');
const { detect } = require('./lib/detect');
const AM = require('./lib/agents-md');
const { stampConventionAnchors, CONVENTIONS_CITE_NOTICE } = require('./lib/conventions-taxonomy');
const { audit } = require('./audit');

const MAX_FILES = 40, MAX_BYTES = 200 * 1024;
const HARD_SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.nuxt', 'coverage', '__pycache__', 'vendor', '.code-graph']);
const SRC_RE = /\.(js|jsx|ts|tsx|mjs|cjs|py|rs|go|rb|java|kt|php|vue|svelte)$/;

function gitignorePatterns(root) {
  const dirs = new Set(); const extGlobs = [];
  try {
    for (let line of fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split('\n')) {
      line = line.trim();
      if (!line || line.startsWith('#')) continue;
      const m = line.match(/^\*(\.[A-Za-z0-9.]+)$/);   // *.log, *.gen.ts
      if (m) { extGlobs.push(m[1]); continue; }
      const bare = line.replace(/\/$/, '').replace(/^\//, '');
      if (bare && !bare.includes('/') && !bare.includes('*')) dirs.add(bare);
    }
  } catch { /* no .gitignore */ }
  return { dirs, extGlobs };
}

function gather(root) {
  const base = root || process.cwd();
  const { dirs, extGlobs } = gitignorePatterns(base);
  const skip = new Set([...HARD_SKIP, ...dirs]);
  const files = []; let bytes = 0, truncated = false;
  const walk = (dir) => {
    if (truncated) return;
    let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (truncated) return;
      if (e.name.startsWith('.') && e.name !== '.') { if (e.isDirectory()) continue; }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { if (!skip.has(e.name)) walk(full); continue; }
      if (extGlobs.some((ext) => e.name.endsWith(ext))) continue;
      if (!SRC_RE.test(e.name)) continue;
      let sz = 0; try { sz = fs.statSync(full).size; } catch { continue; }
      if (files.length >= MAX_FILES || bytes + sz > MAX_BYTES) { truncated = true; return; }
      files.push({ path: full, bytes: sz }); bytes += sz;
    }
  };
  walk(base);
  return { detection: detect(base), files, truncated };
}

const MAX_CONVENTIONS_BYTES = 6 * 1024, MAX_AGENTS_MD_BYTES = 32 * 1024;
const readOrNull = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };

function writeConventions(root, md) {
  const base = root || process.cwd();
  const target = path.join(base, 'AGENTS.md');
  const stamped = stampConventionAnchors(String(md).trim());
  const body = `${CONVENTIONS_CITE_NOTICE}\n\n${stamped}`;
  if (Buffer.byteLength(body, 'utf8') > MAX_CONVENTIONS_BYTES)
    throw new Error(`conventions block ${Buffer.byteLength(body, 'utf8')}B exceeds ${MAX_CONVENTIONS_BYTES}B budget — distill fewer, higher-signal conventions`);
  const existing = readOrNull(target) || '';
  const { content } = AM.injectBlockBetween(existing, body, AM.CONVENTIONS_BEGIN, AM.CONVENTIONS_END);
  if (Buffer.byteLength(content, 'utf8') > MAX_AGENTS_MD_BYTES)
    throw new Error(`AGENTS.md would be ${Buffer.byteLength(content, 'utf8')}B, past the ~32 KiB discovery budget — trim facts or conventions`);
  fs.writeFileSync(target, content);
  return { action: 'written', target, bytes: Buffer.byteLength(content, 'utf8') };
}

// Extract the @conv-<slug> anchors literally present in a project's AGENTS.md —
// the same "ground truth from disk, not the taxonomy" rule
// hooks/convention-cite-scan.sh uses, so the report and the hook can never
// disagree about which anchors exist for a given project.
function knownAnchors(root) {
  const body = readOrNull(path.join(root, 'AGENTS.md')) || '';
  return [...new Set(body.match(/@conv-[a-z-]+/g) || [])].sort();
}

// Per-dimension adoption report: for every @conv-<slug> anchor actually present
// in this project's AGENTS.md, how many times was it CITED (an agent applied
// the convention and named its anchor) within the telemetry window? Zero cites
// is a prune candidate — advisory only — UNLESS none of this project's own
// anchors were cited at all, in which case the whole report reads 'no-data'
// (design doc §7: a fresh/never-run install must not look like proof of
// dilution). This can't key off the audit window being merely empty: the
// telemetry log is shared across every project on the machine, so a freshly
// distilled project reads inWindow>0 from unrelated activity long before its
// own anchors ever get cited. So the scope defaults to THIS project's own
// cwd-slug (the same encoding hooks/lib/rule-hits.sh stamps on every row),
// keeping cite counts from mixing across projects too. Independent of
// rules.js's §* demote logic — this never touches spec/hard-rules.json or its
// live_sections.
function adoptionReport({ root, days = 30, now = Date.now(), logPath, project = null } = {}) {
  const base = root || process.cwd();
  const anchors = knownAnchors(base);
  const scope = project != null ? project : String(base).replace(/[^a-zA-Z0-9-]/g, '-');
  const auditOpts = { days, now, project: scope };
  if (logPath) auditOpts.logPath = logPath;
  const a = audit(auditOpts);
  const cited = (x) => !!(a.bySection[x] && a.bySection[x].events && a.bySection[x].events.cite);
  const noData = anchors.every((x) => !cited(x));
  const dimensions = anchors.map((anchor) => {
    const cites = cited(anchor) ? a.bySection[anchor].events.cite : 0;
    const signal = cites > 0 ? 'active' : (noData ? 'no-data' : 'prune-candidate');
    return { anchor, cites, signal };
  });
  return {
    days, project: scope, noData,
    agentsMdPath: path.join(base, 'AGENTS.md'),
    dimensions,
    pruneCandidates: dimensions.filter((d) => d.signal === 'prune-candidate'),
  };
}

function formatAdoptionReport(r) {
  const L = [];
  L.push(`agentsmd convention adoption — last ${r.days}d${r.project ? ` (project filter: ${r.project})` : ''}`);
  if (!r.dimensions.length) {
    L.push(`  no @conv-* anchors found in ${r.agentsMdPath} — run agentsmd-analyze first.`);
    return L.join('\n');
  }
  if (r.noData) L.push('  no telemetry in window yet — cite counts below are not evidence either way.');
  for (const d of r.dimensions) {
    const flag = d.signal === 'prune-candidate' ? ' — prune candidate' : '';
    L.push(`  ${d.anchor}: ${d.cites} cite${d.cites === 1 ? '' : 's'}${flag}`);
  }
  if (r.pruneCandidates.length && !r.noData) {
    L.push('');
    L.push(`${r.pruneCandidates.length} dimension(s) had 0 cites this window — consider pruning from AGENTS.md (advisory, not automatic).`);
  }
  return L.join('\n');
}

module.exports = { gather, writeConventions, knownAnchors, adoptionReport, formatAdoptionReport, parseArgs };

const USAGE = 'Usage: agentsmd-analyze [--gather] | agentsmd-analyze --write --from <file> | agentsmd-analyze --adoption [--days=N] [--project=SUBSTR] | --help';

function parseArgs(argv) {
  const opts = { mode: 'gather', from: null, days: 30, project: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true };
    else if (a === '--gather') opts.mode = 'gather';
    else if (a === '--write') opts.mode = 'write';
    else if (a === '--adoption') opts.mode = 'adoption';
    else if (a === '--from') opts.from = argv[++i];
    else if (/^--days=/.test(a)) {
      const v = a.slice('--days='.length);
      if (!/^[1-9][0-9]*$/.test(v)) return { error: `invalid --days value: ${v}` };
      opts.days = Number(v);
    }
    else if (/^--project=/.test(a)) {
      const v = a.slice('--project='.length);
      if (!v) return { error: 'invalid --project value: (empty)' };
      opts.project = v;
    }
    else return { error: `unknown option: ${a}` };
  }
  if (opts.mode === 'write' && !opts.from) return { error: '--write requires --from <file>' };
  return opts;
}

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) { console.log(USAGE); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd analyze: ${parsed.error}`); console.error(USAGE); process.exit(1); }
  if (parsed.mode === 'write') {
    let md;
    try { md = fs.readFileSync(parsed.from, 'utf8'); }
    catch (e) { console.error(`agentsmd analyze: cannot read ${parsed.from}: ${e.message}`); process.exit(1); }
    try {
      const r = writeConventions(process.cwd(), md);
      console.log(`written: ${r.target}`);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  } else if (parsed.mode === 'adoption') {
    console.log(formatAdoptionReport(adoptionReport({ root: process.cwd(), days: parsed.days, project: parsed.project })));
  } else {
    const g = gather(process.cwd());
    console.log(`${g.detection.language} (${g.detection.packageManager}) — ${g.files.length} file(s)${g.truncated ? ', truncated' : ''}`);
    for (const f of g.files) console.log(`  ${f.path} (${f.bytes}B)`);
  }
}
