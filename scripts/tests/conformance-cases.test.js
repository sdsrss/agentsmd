'use strict';
// conformance-cases.test.js — structural gate for the R5-04 conformance case
// library (qa/conformance/cases.json). Model runs are on-demand and expensive
// (qa/conformance-eval.sh); this test keeps the COMMITTED library sound with
// zero model calls: schema shape, unique ids, known categories/kinds, an
// assert vocabulary the runner actually implements, rule anchors that resolve
// against hard-rules.json or spec/AGENTS.md section headers, fragment
// discipline (no complete secret-shaped literal in the repo), and pre_clean
// paths bounded to the qa marker prefix.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const ROOT = path.join(__dirname, '..', '..');
const CASES_PATH = path.join(ROOT, 'qa', 'conformance', 'cases.json');
const raw = fs.readFileSync(CASES_PATH, 'utf8');
const lib = JSON.parse(raw);

const CATEGORIES = new Set(['auth', 's8-refusal', 'false-block', 'instruction-retention', 'injection', 'fresh-evidence']);
const KINDS = new Set(['positive', 'near-negative', 'conflict']);
const ASSERT_TYPES = new Set([
  'file_exists', 'file_absent', 'last_regex', 'last_not_regex',
  'tele_block', 'no_tele_blocks', 'exec_regex_min', 'exec_regex_absent',
  'commits_delta', 'commit_subject_regex', 'cmd_green', 'any_of',
]);

// Valid rule anchors: hard-rules ids ∪ rule_hits_sections ∪ spec §-headers.
const hardRules = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'hard-rules.json'), 'utf8'));
const anchors = new Set();
for (const r of hardRules.rules) {
  if (r.id) anchors.add(r.id);
  if (r.rule_hits_section) anchors.add(r.rule_hits_section);
}
const spec = fs.readFileSync(path.join(ROOT, 'spec', 'AGENTS.md'), 'utf8');
for (const m of spec.matchAll(/^## (§[\w.]+)/gmu)) anchors.add(m[1]);

const flatAsserts = (asserts) => asserts.flatMap((a) =>
  a.type === 'any_of' ? (a.groups || []).flat().concat([{ type: 'any_of', groups: a.groups }]) : [a]);

t('schema_version 1, non-empty cases[], _doc present', () => {
  assert.strictEqual(lib.schema_version, 1);
  assert.ok(Array.isArray(lib.cases) && lib.cases.length > 0);
  assert.ok(typeof lib._doc === 'string' && lib._doc.length > 50);
});

t('case ids unique; required fields present and typed', () => {
  const ids = lib.cases.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids');
  for (const c of lib.cases) {
    assert.ok(/^[a-z0-9-]+$/.test(c.id), c.id + ': id must be kebab-case');
    assert.ok(typeof c.prompt === 'string' && c.prompt.length > 10, c.id + ': prompt');
    assert.ok(Array.isArray(c.assert) && c.assert.length > 0, c.id + ': assert[]');
  }
});

t('categories and kinds come from the closed sets the runner reports on', () => {
  for (const c of lib.cases) {
    assert.ok(CATEGORIES.has(c.category), c.id + ': category ' + c.category);
    assert.ok(KINDS.has(c.kind), c.id + ': kind ' + c.kind);
  }
});

t('every R5-04 acceptance dimension has at least one case', () => {
  const seen = new Set(lib.cases.map((c) => c.category));
  for (const cat of CATEGORIES) assert.ok(seen.has(cat), 'no case for category ' + cat);
});

t('assert vocabulary matches what conformance-eval.sh implements', () => {
  for (const c of lib.cases) {
    for (const a of flatAsserts(c.assert)) {
      assert.ok(ASSERT_TYPES.has(a.type), c.id + ': unknown assert type ' + a.type);
      if (a.type === 'any_of') {
        assert.ok(Array.isArray(a.groups) && a.groups.length >= 2, c.id + ': any_of needs >=2 groups');
        for (const g of a.groups) assert.ok(Array.isArray(g) && g.length > 0, c.id + ': empty any_of group');
      }
      if (['last_regex', 'last_not_regex', 'exec_regex_min', 'exec_regex_absent', 'commit_subject_regex'].includes(a.type)) {
        assert.ok(typeof a.regex === 'string' && a.regex.length > 0, c.id + ': ' + a.type + ' regex');
        new RegExp(a.regex); // must compile
      }
      if (a.type === 'tele_block') assert.ok(typeof a.section === 'string' && a.section.startsWith('§'), c.id + ': tele_block section');
      if (a.type === 'exec_regex_min') assert.ok(Number.isInteger(a.min) && a.min >= 1, c.id + ': exec_regex_min min');
      if (a.type === 'commits_delta') assert.ok(Number.isInteger(a.delta), c.id + ': commits_delta delta');
      if (a.type === 'cmd_green') assert.ok(typeof a.cmd === 'string' && a.cmd.length > 0, c.id + ': cmd_green cmd');
      if (['file_exists', 'file_absent'].includes(a.type)) assert.ok(typeof a.path === 'string' && a.path.length > 0, c.id + ': ' + a.type + ' path');
    }
  }
});

t('rule anchors resolve against hard-rules.json or spec/AGENTS.md headers', () => {
  for (const c of lib.cases) {
    assert.ok(anchors.has(c.rule), c.id + ': unresolvable rule anchor ' + c.rule);
  }
});

t('tele_block sections are live (a registered hook actually emits them)', () => {
  const live = new Set(hardRules.live_sections);
  for (const c of lib.cases) {
    for (const a of flatAsserts(c.assert)) {
      if (a.type === 'tele_block') assert.ok(live.has(a.section), c.id + ': ' + a.section + ' not in live_sections');
    }
  }
});

t('fragment discipline: no complete AWS-key-shaped literal in the library file', () => {
  assert.strictEqual(raw.match(/AKIA[0-9A-Z]{16}/), null, 'complete secret-shaped literal committed');
});

t('every {{SECRET:name}} placeholder resolves to a declared fragment list', () => {
  for (const m of raw.matchAll(/\{\{SECRET:([\w-]+)\}\}/g)) {
    const frag = (lib.fragments || {})[m[1]];
    assert.ok(Array.isArray(frag) && frag.length >= 2, 'fragment ' + m[1] + ' must exist and be split');
  }
});

t('pre_clean paths bounded to /tmp/agentsmd-qa-* (runner refuses anything else)', () => {
  for (const c of lib.cases) {
    for (const p of c.pre_clean || []) {
      assert.ok(p.startsWith('/tmp/agentsmd-qa-'), c.id + ': pre_clean out of bounds: ' + p);
    }
  }
});

t('setup_files paths are project-relative (no absolute, no traversal)', () => {
  for (const c of lib.cases) {
    for (const f of c.setup_files || []) {
      assert.ok(!f.path.startsWith('/') && !f.path.includes('..'), c.id + ': bad setup path ' + f.path);
      assert.ok(typeof f.content === 'string', c.id + ': setup content ' + f.path);
    }
  }
});

t('runner exists and points at this library', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'qa', 'conformance-eval.sh'), 'utf8');
  assert.ok(runner.includes('qa/conformance/cases.json'), 'runner default --cases path drifted');
  for (const type of ASSERT_TYPES) {
    assert.ok(runner.includes(type), 'runner does not implement assert type ' + type);
  }
});

t('thresholds.json: categories resolve, min_pass within case counts, known_fail ids exist', () => {
  const tPath = path.join(ROOT, 'qa', 'conformance', 'thresholds.json');
  const th = JSON.parse(fs.readFileSync(tPath, 'utf8'));
  const counts = {};
  for (const c of lib.cases) counts[c.category] = (counts[c.category] || 0) + 1;
  for (const [k, v] of Object.entries(th)) {
    if (k === '_doc' || k === 'baseline') continue;
    assert.ok(CATEGORIES.has(k), 'threshold key is not a category: ' + k);
    assert.ok(Number.isInteger(v.min_pass) && v.min_pass >= 0, k + ': min_pass');
    assert.ok(v.min_pass <= counts[k], k + `: min_pass ${v.min_pass} > ${counts[k]} cases`);
  }
  const ids = new Set(lib.cases.map((c) => c.id));
  for (const kf of (th.baseline || {}).known_fail || []) {
    assert.ok(ids.has(kf), 'known_fail references missing case: ' + kf);
  }
});

console.log(`conformance-cases: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
