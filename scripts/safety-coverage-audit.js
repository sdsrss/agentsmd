'use strict';
// safety-coverage-audit.js — static audit of the hook layer against its own spec
// enforcement CLAIMS. Header comments and deny/advisory strings are DOCUMENTATION,
// not proof; this catches the drift where a hook quotes a multi-clause rule but only
// one clause has implementing code. Four deterministic cross-references, all pure
// static analysis over hooks/*.sh + spec/hard-rules.json (no telemetry, no FS
// outside the repo):
//   A. arrow-claim sweep — every '→' claim (header comment block or deny/advisory
//      string) is split on →/; and each clause keyword-grepped against the hook's
//      code body (header stripped). A clause with zero keyword hits = partial-impl
//      candidate (the header promises a link the code never implements).
//   B. manifest cross-ref — every hard-rules.json rule with enforcement hook|both
//      whose rule_hits_section is LIVE must be emitted by some hook; a live section
//      with no emitter is an unimplemented gap. A hook-enforced rule whose section is
//      NOT live is 'hook-planned' (its hook isn't built yet — expected, not a gap),
//      mirroring live_sections semantics + scripts/rules.js.
//   C. bypass-token coverage — every documented [allow-*] escape hatch (named in a
//      comment) must ALSO appear on a code line (a real guard), not just prose.
//   D. orphan emission — a §-section literal a hook emits that no manifest rule
//      declares (telemetry the governance layer can't see).
// Adapted from claudemd/scripts/safety-coverage-audit.js (ESM→CommonJS). Its rm-rf
// $VAR whitelist anchor is replaced by bypass-token coverage: agentsmd's §8 rm-rf
// hook detects variable EXPANSION rather than enumerating a HOME/PWD/OLDPWD/TMPDIR
// list, so there is no fixed var set to anchor on — the escape-hatch tokens are the
// analogous "documented list that must exist in code, not just the comment".
//
// Exit 0 = clean; exit 3 = a gap surfaced (partial-impl / unimplemented-live /
// bypass / orphan); exit 2 = argv-shape error. Wired into npm test as a drift gate.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const HOOKS_DIR = 'hooks';

// Arrow-claim shape: spec quotes wrap arrows in whitespace ("lockfile → local");
// require whitespace bounds so a packed regex literal ("(→|->)") in code is skipped.
const ARROW_CLAIM_RE = /(?:^|\s)→(?:\s|$)/;
// A section-id literal: §-prefixed, no whitespace/quote — distinguishes the emitted
// '§8-rm-rf-var' token from a prose string like "§8 SAFETY (immutable): ...".
const SECTION_TOKEN_RE = /['"](§[^'"\s]+)['"]/g;
// A documented bypass token, e.g. [allow-rm-rf-var].
const ALLOW_TOKEN_RE = /\[allow-[a-z0-9-]+\]/g;

// Grammatical / context tokens that shouldn't drive coverage ('none' is grammatical
// here — "none of the above" — not a code keyword).
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'or', 'and', 'no', 'not', 'none', 'with', 'without',
  'in', 'on', 'of', 'to', 'is', 'are', 'be', 'as', 'by', 'for', 'from',
  'spec', 'rule', 'this', 'that', 'these', 'those', 'then', 'else',
  'pkg', 'cwd', 'var', 'etc', 'fix', 'link', 'note',
]);

function splitClauses(text) {
  return text.split(/[→;]/).map((s) => s.trim()).filter(Boolean);
}

function clauseKeywords(clause) {
  return clause
    .toLowerCase()
    .replace(/[`"'[\]()]/g, '')
    .split(/[\s/,]+/)
    .map((w) => w.replace(/[^a-z0-9_§.]/g, ''))
    .filter((w) => w && !STOP_WORDS.has(w) && w.length >= 3);
}

function clauseCoverage(clause, codeBody) {
  const keywords = clauseKeywords(clause);
  if (keywords.length === 0) return { clause, coverage: 'unknown', keywords, keywordHits: [] };
  const lower = codeBody.toLowerCase();
  const hits = keywords.filter((kw) => lower.includes(kw));
  return { clause, coverage: hits.length > 0 ? 'covered' : 'gap', keywords, keywordHits: hits };
}

// Strip the leading header comment block (#! + initial '#' lines + blanks) so the
// keyword grep against "code body" doesn't trivially hit the comment we're auditing.
// Mid-file comments stay — they annotate the implementation.
function stripHeaderComments(source) {
  const lines = source.split('\n');
  let i = 0;
  if (i < lines.length && lines[i].startsWith('#!')) i++;
  while (i < lines.length && (/^\s*#/.test(lines[i]) || /^\s*$/.test(lines[i]))) i++;
  return lines.slice(i).join('\n');
}

// Every '→' claim site: contiguous comment blocks (header) + non-comment arrow lines
// (deny/advisory strings), the latter collapsed when adjacent (multi-line strings).
function findArrowClaimSites(source, hookRel) {
  const lines = source.split('\n');
  const sites = [];
  let i = 0;
  while (i < lines.length) {
    if (/^\s*#/.test(lines[i])) {
      const start = i;
      const buf = [];
      while (i < lines.length && /^\s*#/.test(lines[i])) { buf.push(lines[i].replace(/^\s*#\s?/, '')); i++; }
      const block = buf.join(' ').replace(/\s+/g, ' ').trim();
      if (ARROW_CLAIM_RE.test(block)) {
        sites.push({ hook: hookRel, startLine: start + 1, endLine: start + buf.length, location: 'header', text: block, clauses: splitClauses(block) });
      }
      continue;
    }
    i++;
  }
  let lastEnd = -1;
  for (let j = 0; j < lines.length; j++) {
    if (/^\s*#/.test(lines[j])) continue;
    if (!ARROW_CLAIM_RE.test(lines[j])) continue;
    if (j === lastEnd + 1 && sites.length > 0) {
      const prev = sites[sites.length - 1];
      prev.endLine = j + 1;
      prev.text = (prev.text + ' ' + lines[j].trim()).replace(/\s+/g, ' ').trim();
      prev.clauses = splitClauses(prev.text);
      lastEnd = j;
      continue;
    }
    sites.push({ hook: hookRel, startLine: j + 1, endLine: j + 1, location: 'string', text: lines[j].trim(), clauses: splitClauses(lines[j]) });
    lastEnd = j;
  }
  return sites;
}

function auditSafetyCoverage({ root = ROOT, hookFilter = null } = {}) {
  const hooksDir = path.join(root, HOOKS_DIR);
  if (!fs.existsSync(hooksDir)) throw new Error(`safety-coverage-audit: hooks dir not found: ${hooksDir}`);

  const allHookFiles = fs.readdirSync(hooksDir).filter((f) => f.endsWith('.sh')).sort();
  if (hookFilter && !allHookFiles.includes(hookFilter)) {
    throw new Error(`hook ${hookFilter} not found`);
  }
  const auditedHookFiles = hookFilter ? allHookFiles.filter((f) => f === hookFilter) : allHookFiles;
  const allHookSources = {};
  for (const f of allHookFiles) allHookSources[f] = fs.readFileSync(path.join(hooksDir, f), 'utf8');

  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'spec/hard-rules.json'), 'utf8'));
  const liveSet = new Set(manifest.live_sections || []);
  const knownSections = new Set(manifest.rules.map((r) => r.rule_hits_section).filter(Boolean));

  // A — arrow-claim sweep.
  const claimSites = [];
  for (const f of auditedHookFiles) {
    const codeBody = stripHeaderComments(allHookSources[f]);
    const sites = findArrowClaimSites(allHookSources[f], `${HOOKS_DIR}/${f}`);
    for (const site of sites) {
      site.clauseCoverage = site.clauses.map((c) => clauseCoverage(c, codeBody));
      site.gapClauses = site.clauseCoverage.filter((cc) => cc.coverage === 'gap').map((cc) => cc.clause);
    }
    claimSites.push(...sites);
  }

  // B — manifest cross-ref (live-aware: not-live hook rule = hook-planned, not a gap).
  const ruleEnforcement = manifest.rules
    .filter((r) => r.enforcement === 'hook' || r.enforcement === 'both')
    .map((r) => {
      const section = r.rule_hits_section;
      const implementingHooks = section
        ? Object.entries(allHookSources)
            .filter(([, src]) => src.includes(`'${section}'`) || src.includes(`"${section}"`))
            .map(([f]) => `${HOOKS_DIR}/${f}`)
        : [];
      const live = !!(section && liveSet.has(section));
      let status;
      if (implementingHooks.length > 0) status = 'implemented';
      else if (live) status = 'unimplemented'; // live section, no emitter = real gap
      else status = 'hook-planned';            // not live yet (or null section) = expected
      return { id: r.id, name: r.name, rule_hits_section: section, scope: r.scope, enforcement: r.enforcement, live, implementingHooks, status };
    });

  // C — bypass-token coverage: a token named in a comment must exist on a code line.
  const bypassChecks = [];
  for (const f of auditedHookFiles) {
    const documented = new Set();
    const inCode = new Set();
    for (const raw of allHookSources[f].split('\n')) {
      const toks = raw.match(ALLOW_TOKEN_RE) || [];
      const target = /^\s*#/.test(raw) ? documented : inCode;
      for (const t of toks) target.add(t);
    }
    for (const tok of documented) {
      bypassChecks.push({ hook: `${HOOKS_DIR}/${f}`, token: tok, status: inCode.has(tok) ? 'covered' : 'gap' });
    }
  }

  // D — orphan §-emission: a section literal a hook emits that no rule declares.
  const emissions = [];
  const orphanEmissions = [];
  for (const f of auditedHookFiles) {
    const seen = new Set();
    for (const raw of allHookSources[f].split('\n')) {
      if (/^\s*#/.test(raw)) continue; // comments are claims, not emissions
      for (const m of raw.matchAll(SECTION_TOKEN_RE)) {
        const tok = m[1];
        if (seen.has(tok)) continue;
        seen.add(tok);
        emissions.push({ hook: `${HOOKS_DIR}/${f}`, section: tok });
        if (!knownSections.has(tok)) orphanEmissions.push({ hook: `${HOOKS_DIR}/${f}`, section: tok });
      }
    }
  }

  const partialCandidates = claimSites.filter((s) => s.gapClauses.length > 0);
  const unimplementedRules = ruleEnforcement.filter((r) => r.status === 'unimplemented');
  const hookPlanned = ruleEnforcement.filter((r) => r.status === 'hook-planned');
  const bypassGaps = bypassChecks.filter((b) => b.status === 'gap');
  const gapCount = partialCandidates.length + unimplementedRules.length + bypassGaps.length + orphanEmissions.length;

  return {
    spec_version: manifest.spec_version,
    hookFilter,
    claimSites,
    ruleEnforcement,
    bypassChecks,
    emissions,
    orphanEmissions,
    summary: {
      hooksAudited: auditedHookFiles.length,
      claimSiteCount: claimSites.length,
      partialCandidates: partialCandidates.length,
      partialCandidateRefs: partialCandidates.map((s) => ({ hook: s.hook, startLine: s.startLine, location: s.location, gapClauses: s.gapClauses })),
      hookEnforcedRules: ruleEnforcement.length,
      unimplementedRules: unimplementedRules.map((r) => r.id),
      hookPlanned: hookPlanned.map((r) => r.id),
      bypassGaps: bypassGaps.map((b) => `${b.hook}:${b.token}`),
      orphanEmissions: orphanEmissions.map((o) => `${o.hook}:${o.section}`),
      gapCount,
    },
  };
}

function formatReport(r) {
  const out = [];
  out.push(`Spec ${r.spec_version}  |  hooks audited: ${r.summary.hooksAudited}  |  arrow-claim sites: ${r.summary.claimSiteCount}`);
  out.push('');
  out.push('## Manifest cross-reference (enforcement = hook | both)');
  for (const re of r.ruleEnforcement) {
    const mark = re.status === 'implemented' ? '✓' : re.status === 'hook-planned' ? '·' : '✗';
    const impl = re.implementingHooks.length ? re.implementingHooks.join(', ') : (re.status === 'hook-planned' ? '(hook-planned — section not live yet)' : '(NO hook emits this live section)');
    out.push(`  [${mark}] ${re.id} (${re.rule_hits_section || 'no section'}) → ${impl}`);
  }
  out.push('');
  out.push('## Bypass-token coverage');
  if (!r.bypassChecks.length) out.push('  (no [allow-*] tokens documented)');
  for (const b of r.bypassChecks) out.push(`  [${b.status === 'covered' ? '✓' : '✗'}] ${b.hook}: ${b.token}`);
  out.push('');
  out.push('## Summary');
  out.push(`  Partial-impl candidates: ${r.summary.partialCandidates}`);
  for (const ref of r.summary.partialCandidateRefs) out.push(`    - ${ref.hook}:${ref.startLine} (${ref.location}) gap: [${ref.gapClauses.join(' | ')}]`);
  out.push(`  Unimplemented live rules: ${r.summary.unimplementedRules.length}${r.summary.unimplementedRules.length ? ' — ' + r.summary.unimplementedRules.join(', ') : ''}`);
  out.push(`  Hook-planned (not gaps): ${r.summary.hookPlanned.length}${r.summary.hookPlanned.length ? ' — ' + r.summary.hookPlanned.join(', ') : ''}`);
  out.push(`  Bypass-token gaps: ${r.summary.bypassGaps.length}${r.summary.bypassGaps.length ? ' — ' + r.summary.bypassGaps.join(', ') : ''}`);
  out.push(`  Orphan emissions: ${r.summary.orphanEmissions.length}${r.summary.orphanEmissions.length ? ' — ' + r.summary.orphanEmissions.join(', ') : ''}`);
  out.push(`  TOTAL GAPS: ${r.summary.gapCount}`);
  return out.join('\n');
}

function parseArgs(argv) {
  let json = false;
  let hookFilter = null;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg === '--json') { json = true; continue; }
    let m;
    if ((m = arg.match(/^--hook=(.+)$/))) {
      if (hookFilter !== null) return { error: 'duplicate option: --hook' };
      hookFilter = m[1];
      continue;
    }
    return { error: `unknown option: ${arg}` };
  }
  return { json, hookFilter };
}

if (require.main === module) {
  const parsed = parseArgs(process.argv.slice(2));
  const usage = 'Usage: agentsmd-safety-coverage-audit [--json] [--hook=<basename.sh>]';
  if (parsed.help) { console.log(usage); process.exit(0); }
  if (parsed.error) { console.error(`agentsmd safety-coverage-audit: ${parsed.error}`); console.error(usage); process.exit(2); }
  let r;
  try { r = auditSafetyCoverage({ hookFilter: parsed.hookFilter }); }
  catch (error) { console.error(`agentsmd safety-coverage-audit: ${error.message}`); process.exit(2); }
  console.log(parsed.json ? JSON.stringify(r, null, 2) : formatReport(r));
  process.exit(r.summary.gapCount > 0 ? 3 : 0);
}

module.exports = {
  auditSafetyCoverage, formatReport, parseArgs,
  splitClauses, clauseKeywords, clauseCoverage, stripHeaderComments, findArrowClaimSites,
};
