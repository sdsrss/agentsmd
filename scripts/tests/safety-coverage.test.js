'use strict';
// safety-coverage.test.js — pins scripts/safety-coverage-audit.js to the real hook
// tree (byte-exact: catches a hook-rename / claim-drift / dropped-emission in one
// shot) AND proves the detector has teeth on a synthetic broken tree, so a green
// result means "no gaps", never "the check is vacuous".

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { auditSafetyCoverage, clauseCoverage, splitClauses, findArrowClaimSites } = require('../safety-coverage-audit');

const ROOT = path.resolve(__dirname, '..', '..');
let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

// ── A. real-tree audit ──────────────────────────────────────────────────────
const R = auditSafetyCoverage({ root: ROOT });

t('audit runs on real hooks and returns a structured report', () => {
  assert.match(R.spec_version, /^v\d+\.\d+\.\d+$/, 'spec_version: ' + R.spec_version);
  assert.ok(R.summary.hooksAudited >= 13, 'hooksAudited: ' + R.summary.hooksAudited);
  assert.ok(Array.isArray(R.ruleEnforcement) && Array.isArray(R.claimSites));
});

t('§8 immutable rules are implemented in their hooks', () => {
  const impl = (id, suffix) => {
    const r = R.ruleEnforcement.find((x) => x.id === id);
    assert.ok(r, 'missing rule ' + id);
    assert.strictEqual(r.status, 'implemented', id + ' status ' + r.status);
    assert.ok(r.implementingHooks.some((h) => h.endsWith(suffix)), id + ' not in ' + suffix + ': ' + JSON.stringify(r.implementingHooks));
  };
  impl('§8-rm-rf-var', 'pre-bash-safety-check.sh');
  impl('§8-unknown-script', 'pre-bash-safety-check.sh');
  impl('§8-secrets', 'secrets-scan.sh');
  impl('§8.V4-sandbox-disposal', 'sandbox-disposal-check.sh');
});

t('C4 observer sections are implemented in transcript-structure-scan.sh', () => {
  for (const id of ['§6-iron-law-2', '§10-honesty']) {
    const r = R.ruleEnforcement.find((x) => x.id === id);
    assert.ok(r && r.status === 'implemented', id + ' status ' + (r && r.status));
    assert.ok(r.implementingHooks.some((h) => h.endsWith('transcript-structure-scan.sh')), id + ' hooks: ' + JSON.stringify(r.implementingHooks));
  }
});

t('§8-home-traversal is self-enforced (no reliable bash detector), not a false hook claim', () => {
  // Relabeled from enforcement:"both" (which claimed a hook that was never built)
  // to "self", matching the §8-sql-no-where precedent. It must therefore NOT appear
  // among the hook-enforced rules, and must not read as an unimplemented gap.
  const r = R.ruleEnforcement.find((x) => x.id === '§8-home-traversal');
  assert.ok(!r, '§8-home-traversal must not be a hook-enforced rule (it is self-enforced until a detector ships)');
  assert.ok(!R.summary.unimplementedRules.includes('§8-home-traversal'));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'hard-rules.json'), 'utf8'));
  const rule = manifest.rules.find((x) => x.id === '§8-home-traversal');
  assert.ok(rule && rule.enforcement === 'self', 'manifest must mark §8-home-traversal enforcement:"self"');
});

t('current hook tree is clean — zero gaps of every class', () => {
  assert.strictEqual(R.summary.partialCandidates, 0, 'partial: ' + JSON.stringify(R.summary.partialCandidateRefs));
  assert.strictEqual(R.summary.unimplementedRules.length, 0, 'unimpl: ' + R.summary.unimplementedRules.join(','));
  assert.strictEqual(R.summary.bypassGaps.length, 0, 'bypass: ' + R.summary.bypassGaps.join(','));
  assert.strictEqual(R.summary.orphanEmissions.length, 0, 'orphan: ' + R.summary.orphanEmissions.join(','));
  assert.strictEqual(R.summary.gapCount, 0);
});

t('documented bypass tokens are backed by a code guard', () => {
  const rmrf = R.bypassChecks.find((b) => b.token === '[allow-rm-rf-var]' && b.hook.endsWith('pre-bash-safety-check.sh'));
  assert.ok(rmrf && rmrf.status === 'covered', 'rm-rf bypass: ' + JSON.stringify(rmrf));
  assert.ok(R.bypassChecks.length >= 5, 'expected several bypass tokens, got ' + R.bypassChecks.length);
});

t('--hook filter restricts the audit to a single hook', () => {
  const one = auditSafetyCoverage({ root: ROOT, hookFilter: 'pre-bash-safety-check.sh' });
  assert.strictEqual(one.summary.hooksAudited, 1);
  assert.ok(one.claimSites.every((s) => s.hook.endsWith('pre-bash-safety-check.sh')));
});

// ── B. detector teeth: pure-function unit checks ─────────────────────────────
t('clauseCoverage flags an uncovered clause as a gap', () => {
  assert.strictEqual(clauseCoverage('validate the lockfile first', 'code that mentions nothing relevant').coverage, 'gap');
  assert.strictEqual(clauseCoverage('run npm test', 'we run npm test in ci').coverage, 'covered');
});

t('splitClauses enumerates → and ; separated links', () => {
  assert.deepStrictEqual(splitClauses('lockfile → local → pinned; none'), ['lockfile', 'local', 'pinned', 'none']);
});

t('findArrowClaimSites + coverage catch a documented-but-unimplemented link', () => {
  const src = ['#!/usr/bin/env bash',
    '# fake-hook.sh — resolves foo as alpha → betazoid → gammaray',
    'set -e',
    'echo "only alpha is handled here"'].join('\n');
  const sites = findArrowClaimSites(src, 'hooks/fake-hook.sh');
  assert.ok(sites.length >= 1, 'expected an arrow claim site');
  const body = src.split('\n').slice(2).join('\n');
  const gaps = sites[0].clauses.map((c) => clauseCoverage(c, body)).filter((cc) => cc.coverage === 'gap').map((cc) => cc.clause);
  assert.ok(gaps.some((g) => g.includes('betazoid')) && gaps.some((g) => g.includes('gammaray')), 'expected betazoid+gammaray gaps, got ' + JSON.stringify(gaps));
});

// ── C. integration: a synthetic broken tree must trip every gap class ────────
t('auditSafetyCoverage surfaces gaps end-to-end on a synthetic broken tree', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-safety-'));
  try {
    fs.mkdirSync(path.join(tmp, 'hooks'));
    fs.mkdirSync(path.join(tmp, 'spec'));
    fs.writeFileSync(path.join(tmp, 'hooks', 'broken.sh'),
      ['#!/usr/bin/env bash',
       '# broken.sh — foo resolves alpha -> betazoid via arrow: alpha → betazoid; bypass [allow-broken]',
       'hook_record "$HOOK" "block" "{}" \'§99-orphan\' "$SID"',
       'echo alpha'].join('\n'));
    fs.writeFileSync(path.join(tmp, 'spec', 'hard-rules.json'), JSON.stringify({
      spec_version: 'v2.99.0',
      live_sections: ['§77-live-no-emitter'],
      rules: [{ id: '§77', name: 'live no emitter', scope: 'core', rule_hits_section: '§77-live-no-emitter', enforcement: 'both' }],
    }));
    const br = auditSafetyCoverage({ root: tmp });
    assert.ok(br.summary.gapCount >= 3, 'gapCount: ' + br.summary.gapCount);
    assert.ok(br.summary.unimplementedRules.includes('§77'), 'expected §77 unimplemented: ' + JSON.stringify(br.summary.unimplementedRules));
    assert.ok(br.summary.orphanEmissions.some((o) => o.includes('§99-orphan')), 'expected §99 orphan: ' + JSON.stringify(br.summary.orphanEmissions));
    assert.ok(br.summary.bypassGaps.some((b) => b.includes('[allow-broken]')), 'expected [allow-broken] gap: ' + JSON.stringify(br.summary.bypassGaps));
    assert.ok(br.summary.partialCandidates >= 1, 'expected a partial-impl candidate');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true }); // §8.V4 sandbox disposal
  }
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
