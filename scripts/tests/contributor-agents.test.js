'use strict';
// contributor-agents.test.js — structural acceptance for the repository-level
// Codex guidance introduced by docs/codex-optimization-roadmap.md workflow A.
// Real Codex review behavior remains an explicit QA/canary concern; this gate
// keeps the committed instruction chain, review fixtures, and byte budget from
// drifting silently in ordinary npm test runs.

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const bytes = (relative) => fs.statSync(path.join(ROOT, relative)).size;
let PASS = 0, FAIL = 0;
const t = (name, fn) => {
  try {
    fn();
    PASS++;
    console.log('  ok   ' + name);
  } catch (error) {
    FAIL++;
    console.log('  FAIL ' + name + '\n     ' + error.message);
  }
};

const FILES = ['AGENTS.md', 'hooks/AGENTS.md', 'scripts/AGENTS.md', 'qa/AGENTS.md'];

function section(markdown, heading) {
  const marker = `### ${heading}\n`;
  const start = markdown.indexOf(marker);
  if (start < 0) return '';
  const tail = markdown.slice(start + marker.length);
  const nextHeading = tail.search(/^#{2,3} /m);
  return nextHeading < 0 ? tail : tail.slice(0, nextHeading);
}

t('root and nested contributor instruction files exist and are non-empty', () => {
  for (const relative of FILES) {
    assert(fs.statSync(path.join(ROOT, relative)).isFile(), `${relative} is missing`);
    assert(read(relative).trim().length > 0, `${relative} is empty`);
  }
});

t('instruction chains stay inside the roadmap discovery budget', () => {
  const rootBytes = bytes('AGENTS.md');
  assert(rootBytes >= 3 * 1024, `root AGENTS.md is below the 3 KiB target: ${rootBytes}B`);
  assert(rootBytes <= 4 * 1024, `root AGENTS.md exceeds the 4 KiB target: ${rootBytes}B`);
  for (const nested of FILES.slice(1)) {
    const chainBytes = rootBytes + bytes(nested);
    assert(bytes(nested) <= 2 * 1024, `${nested} exceeds 2 KiB: ${bytes(nested)}B`);
    assert(chainBytes <= 6 * 1024, `root + ${nested} exceeds 6 KiB: ${chainBytes}B`);
  }
});

t('root guidance records source-of-truth, validation, live-home, and placement contracts', () => {
  const root = read('AGENTS.md');
  for (const heading of [
    '# agentsmd contributor instructions',
    '## Source of truth',
    '## Repository map',
    '## Change-to-validation map',
    '## Live CODEX_HOME boundary',
    '## Generated and local-only files',
    '## Code Review Rules',
    '## Release-only requirements',
  ]) {
    assert(root.includes(heading), `missing heading: ${heading}`);
  }
  for (const required of [
    '`spec/AGENTS.md` is generated',
    '`spec/source/**`',
    '`npm run spec:generate`',
    '`npm run spec:check`',
    '`npm run check`',
    '`node scripts/perf-baseline.js --slo --json`',
    'must not modify the live `$CODEX_HOME`',
    '`docs/`',
    '`tasks/`',
    '`tmp/`',
  ]) {
    assert(root.includes(required), `missing root contract: ${required}`);
  }
});

t('four consequential review rules state a flag, safe path, and non-finding boundary', () => {
  const root = read('AGENTS.md');
  for (const heading of [
    'Generated artifacts',
    'Lifecycle ownership',
    'Hook contracts',
    'Hot-path performance',
  ]) {
    const body = section(root, heading);
    assert(body, `missing review rule: ${heading}`);
    assert(body.includes('Flag when:'), `${heading} lacks Flag when`);
    assert(body.includes('Safe path:'), `${heading} lacks Safe path`);
    assert(body.includes('Do not flag:'), `${heading} lacks Do not flag`);
  }
});

t('review eval fixtures cover a violation, a safe counterexample, and an unrelated change', () => {
  const fixture = JSON.parse(read('qa/contributor-review-cases.json'));
  assert.strictEqual(fixture.schema_version, 1);
  assert(Array.isArray(fixture.cases) && fixture.cases.length >= 3, 'expected at least three cases');
  assert.deepStrictEqual(
    new Set(fixture.cases.map((item) => item.kind)),
    new Set(['violation', 'safe-counterexample', 'unrelated'])
  );
  const positive = fixture.cases.find((item) => item.kind === 'violation');
  assert(positive.expected_rules.includes('generated-artifacts'), 'violation must expect the generated-artifacts rule');
  for (const item of fixture.cases.filter((candidate) => candidate.kind !== 'violation')) {
    assert.deepStrictEqual(item.expected_rules, [], `${item.id} must not expect a custom finding`);
  }
});

t('nested guidance supplies only the closest directory-specific routing', () => {
  const hooks = read('hooks/AGENTS.md');
  for (const required of [
    '`scripts/lib/hook-registry.js`',
    '`bash hooks/tests/smoke.sh`',
    '`npm run lint:shell`',
    '`node scripts/safety-coverage-audit.js`',
    '`node scripts/perf-baseline.js --slo --json`',
    '`session_id`',
  ]) assert(hooks.includes(required), `hooks/AGENTS.md missing ${required}`);

  const scripts = read('scripts/AGENTS.md');
  for (const required of [
    'isolated `CODEX_HOME`',
    '`scripts/tests/live-guard.js`',
    '`scripts/tests/fault-injection.test.js`',
    'exact path, content hash, and manifest',
  ]) assert(scripts.includes(required), `scripts/AGENTS.md missing ${required}`);

  const qa = read('qa/AGENTS.md');
  for (const required of [
    'real model call',
    '`bash qa/conformance-eval.sh --validate`',
    '`docs/qa-captures/`',
    '`AGENTSMD_TELEMETRY_TAG=qa`',
  ]) assert(qa.includes(required), `qa/AGENTS.md missing ${required}`);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
