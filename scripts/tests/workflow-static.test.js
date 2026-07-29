'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

let PASS = 0;
let FAIL = 0;
function test(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    FAIL += 1;
    console.log(`  FAIL ${name}\n     ${error.message}`);
  }
}

test('all four distributed recipes exist and preserve authorization/worktree boundaries', () => {
  const expected = [
    'automation/weekly-runtime-canary.md',
    'automation/weekly-governance-review.md',
    'automation/release-readiness.md',
    'automation/pr-review.md',
  ];
  for (const file of expected) assert(fs.existsSync(path.join(ROOT, file)), `missing ${file}`);
  const runtime = read(expected[0]);
  assert.match(runtime, /pinned/i);
  assert.match(runtime, /latest/i);
  assert.match(runtime, /positive/i);
  assert.match(runtime, /near-negative/i);
  assert.match(runtime, /isolated CODEX_HOME/);
  assert.match(runtime, /do not push|no push|never push/i);
  const governance = read(expected[1]);
  for (const signal of ['rules', 'sampling', 'lesson', 'sparkline', 'prompt', 'performance', 'fallback']) {
    assert.match(governance, new RegExp(signal, 'i'), signal);
  }
  assert.match(governance, /no-opportunity/i);
  assert.match(governance, /runtime\/version split/i);
  const release = read(expected[2]);
  for (const gate of ['full check', 'conformance', 'perf', 'package', 'version', 'changelog', 'secret', 'rollback', 'authorization']) {
    assert.match(release, new RegExp(gate, 'i'), gate);
  }
  assert.match(release, /report-only/i);
  const combined = expected.map(read).join('\n');
  assert.match(combined, /dedicated worktree/i);
  assert.match(combined, /pinned.*active.*permanent|pinned\/active\/permanent/is);
  assert.match(combined, /task-owned/i);
});

test('weekly runtime workflow runs pinned/latest in isolation and retains failure captures', () => {
  const source = read('.github/workflows/runtime-canary.yml');
  assert.match(source, /^\s*schedule\s*:/m);
  assert.match(source, /channel:\s*pinned/);
  assert.match(source, /channel:\s*latest/);
  assert.match(source, /@openai\/codex@0\.145\.0/);
  assert.match(source, /@openai\/codex@latest/);
  assert.match(source, /qa\/runtime-canary\.js/);
  assert.match(source, /continue-on-error:\s*true/);
  assert.match(source, /if:\s*always\(\)/);
  assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(source, /matrix\.channel == 'pinned'/);
  assert.doesNotMatch(source, /\bissues:\s*write\b|\bcontents:\s*write\b|\bgit push\b/);
});

test('weekly governance workflow emits one read-only scorecard artifact', () => {
  const source = read('.github/workflows/governance-review.yml');
  assert.match(source, /^\s*schedule\s*:/m);
  assert.match(source, /scripts\/scorecard\.js --days=30 --json/);
  assert.match(source, /actions\/upload-artifact@[0-9a-f]{40}/);
  assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
  assert.doesNotMatch(source, /\bissues:\s*write\b|\bcontents:\s*write\b|\bgit push\b/);
});

test('PR review is optional, same-repository/trusted-actor constrained, read-only, and posts from a separate job', () => {
  const source = read('.github/workflows/codex-review.yml');
  assert.match(source, /^\s*pull_request\s*:/m);
  assert.doesNotMatch(source, /pull_request_target/);
  assert.match(source, /head\.repo\.full_name == github\.repository/);
  assert.match(source, /author_association/);
  assert.match(source, /openai\/codex-action@[0-9a-f]{40}/);
  assert.match(source, /sandbox:\s*read-only/);
  assert.match(source, /persist-credentials:\s*false/);
  assert.match(source, /OPENAI_API_KEY/);
  assert.match(source, /review_available/);
  assert.match(source, /feedback:\s*\n/);
  assert.match(source, /pull-requests:\s*write/);
  assert.match(source, /actions\/github-script@[0-9a-f]{40}/);
  assert.doesNotMatch(source, /\bcontents:\s*write\b|\bgit push\b/);
  const shellBlocks = [...source.matchAll(/run:\s*\|([\s\S]*?)(?=\n\s{6}-|\n\s{2}\w|\s*$)/g)].map((match) => match[1]).join('\n');
  assert.doesNotMatch(shellBlocks, /\$\{\{\s*github\.event\.pull_request\./);
});

test('Codex review prompt treats repository and PR text as untrusted review input', () => {
  const prompt = read('.github/codex/pr-review.md');
  assert.match(prompt, /untrusted/i);
  assert.match(prompt, /review only|do not modify/i);
  assert.match(prompt, /AGENTS\.md/);
  assert.match(prompt, /actionable/i);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
