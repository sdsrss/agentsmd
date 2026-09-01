'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'hooks', 'transcript-structure-scan.sh');
const ANALYZER = path.join(ROOT, 'hooks', 'lib', 'transcript-structure.js');
const PATTERNS = path.join(ROOT, 'hooks', 'banned-vocab.patterns');

function analyze(message) {
  const result = cp.spawnSync(process.execPath, [ANALYZER, PATTERNS], {
    input: message,
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function analyzeEvent(event) {
  const result = cp.spawnSync(process.execPath, [ANALYZER, PATTERNS, '--event'], {
    input: JSON.stringify(event),
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function pendingFor(message) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-report-'));
  try {
    const transcript = path.join(sandbox, 'transcript.jsonl');
    fs.writeFileSync(transcript, JSON.stringify({
      type: 'message', payload: { role: 'assistant', content: [{ type: 'output_text', text: message }] },
    }) + '\n');
    const event = JSON.stringify({ session_id: 'report-test', transcript_path: transcript });
    const result = cp.spawnSync('bash', [HOOK], { input: event, encoding: 'utf8', env: { ...process.env, CODEX_HOME: sandbox } });
    assert.strictEqual(result.status, 0, result.stderr);
    const state = path.join(sandbox, '.agentsmd-state');
    // Advisories are per-message files under pending-advisories-<key>.d, named so a
    // lexicographic sort reflects arrival order. Concatenate them; fall back to the
    // ≤4.3.0 single-file queue.
    const dir = path.join(state, 'pending-advisories-report-test.d');
    if (fs.existsSync(dir)) {
      return fs.readdirSync(dir)
        .filter((name) => /^[0-9]/.test(name))
        .sort()
        .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
        .join('');
    }
    const legacy = path.join(state, 'pending-advisories-report-test');
    return fs.existsSync(legacy) ? fs.readFileSync(legacy, 'utf8') : '';
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}

const cases = [
  ['single analyzer preserves issue and eligibility semantics', () => {
    const result = analyze('Done: fixed parser.\nUncertain: it might regress.');
    assert.strictEqual(result.issues.fourSectionOrder, true);
    assert.strictEqual(result.issues.ironLaw2, true);
    assert.strictEqual(result.issues.uncertainHedge, true);
    assert.deepStrictEqual(result.eligible, {
      vocabulary: true,
      order: true,
      fixEvidence: true,
      honesty: true,
    });
  }],
  ['single analyzer ignores fenced banned vocabulary but detects prose', () => {
    assert.strictEqual(analyze('Example:\n```\nshould work\n```').issues.bannedVocabulary, null);
    assert.strictEqual(analyze('This should work.').issues.bannedVocabulary, '\\bshould work\\b');
  }],
  ['single analyzer accepts ordered reports and concrete fix evidence', () => {
    const result = analyze('Done: fixed parser; 2 tests passed.\nNot done: none\nFailed: none\nUncertain: uncertain because the external canary was not run.');
    assert.strictEqual(result.issues.fourSectionOrder, false);
    assert.strictEqual(result.issues.ironLaw2, false);
    assert.strictEqual(result.issues.uncertainHedge, false);
  }],
  ['event mode extracts stable Stop fields in the analyzer process', () => {
    const result = analyzeEvent({
      session_id: 'event-direct',
      last_assistant_message: 'Done: changed parser.',
    });
    assert.strictEqual(result.sessionId, 'event-direct');
    assert.strictEqual(result.messageSource, 'event');
    assert.strictEqual(result.issues.fourSectionOrder, true);
  }],
  ['event mode preserves the bounded transcript compatibility fallback', () => {
    const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-report-event-'));
    try {
      const transcript = path.join(sandbox, 'transcript.jsonl');
      fs.writeFileSync(transcript, [
        JSON.stringify({ type: 'message', payload: { role: 'assistant', content: 'Done: stale.' } }),
        JSON.stringify({ type: 'message', payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Done: latest parser result.' }] } }),
      ].join('\n') + '\n');
      const result = analyzeEvent({ session_id: 'event-fallback', transcript_path: transcript });
      assert.strictEqual(result.sessionId, 'event-fallback');
      assert.strictEqual(result.messageSource, 'transcript');
      assert.strictEqual(result.issues.fourSectionOrder, true);
    } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
  }],
  ['Done-only report is incomplete', () => assert.match(pendingFor('Done: changed parser.'), /four-section-order/)],
  ['two-label report is incomplete', () => assert.match(pendingFor('Done: changed parser.\nNot done: none.'), /four-section-order/)],
  ['four ordered labels pass', () => assert.doesNotMatch(pendingFor('Done: x\nNot done: none\nFailed: none\nUncertain: none'), /four-section-order/)],
  ['ordinary sentence beginning with Done is not a report', () => assert.doesNotMatch(pendingFor('Done is a status word in this example.'), /four-section-order/)],
];

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.error(`  FAIL ${name}\n       ${error.stack || error}`); }
}
console.log(`\nRESULT: ${passed} passed, ${cases.length - passed} failed`);
if (passed !== cases.length) process.exit(1);
