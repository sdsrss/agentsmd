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

function commitVerdict(command) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-vocab-'));
  try {
    const result = cp.spawnSync('bash', [path.join(ROOT, 'hooks', 'banned-vocab-check.sh')], {
      input: JSON.stringify({ session_id: 'vocab-test', cwd: ROOT, tool_name: 'Bash', tool_input: { command } }),
      encoding: 'utf8', env: { ...process.env, CODEX_HOME: sandbox },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const log = path.join(sandbox, 'logs', 'agentsmd.jsonl');
    const rows = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    assert.ok(rows.some((row) => row.event === 'observe' && row.evaluated === true), 'scan must actually run');
    return result.stdout.trim() ? JSON.parse(result.stdout).decision : null;
  } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
}

const cases = [
  ['single analyzer preserves issue and eligibility semantics', () => {
    const result = analyze('Done: fixed parser.\nUncertain: it might regress.');
    assert.strictEqual(result.issues.fourSectionOrder, false);
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
    assert.strictEqual(result.issues.fourSectionOrder, false);
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
      assert.strictEqual(result.issues.fourSectionOrder, false);
    } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
  }],
  ['short reports do not imply a task level or missing-section violation', () => {
    for (const message of [
      'Done: Updated a comment; git diff --check passed.',
      'Uncertain: Browser rendering was not checked.',
      'Done: comment updated.\nUncertain: Browser rendering was not checked.',
      'Done: first item.\nDone: second item.',
      'Done: changed parser.\nNot done: none.',
    ]) assert.doesNotMatch(pendingFor(message), /four-section-order/, message);
    assert.strictEqual(analyze('Done: comment updated.').eligible.order, false);
  }],
  ['present labels still require relative order, including without Done', () => {
    for (const message of ['Uncertain: none\nDone: comment updated.', 'Failed: none\nNot done: pending']) {
      assert.match(pendingFor(message), /four-section-order/, message);
    }
  }],
  ['timing baselines support only adjacent numerically consistent speed ratios', () => {
    for (const message of [
      'Benchmark median fell from 100 ms to 20 ms across 30 runs, 5x faster.',
      'Latency 100ms→20ms, 5x faster.',
      'Latency 1 s -> 200 ms (5x faster).',
      'Latency 0.5 s -> 100 ms, 5x faster.',
    ]) {
      assert.strictEqual(analyze(message).issues.bannedVocabulary, null, message);
      assert.doesNotMatch(pendingFor(message), /banned-vocab/, message);
    }
  }],
  ['unsupported or unrelated speed claims retain vocabulary diagnostics', () => {
    for (const message of [
      'Parser is 5x faster.',
      '100 ms -> 20 ms, 4x faster.',
      '20 ms -> 100 ms, 5x faster.',
      '0 ms -> 0 ms, 5x faster.',
      '-100 ms -> -20 ms, 5x faster.',
      'Latency 1100' + ' '.repeat(496) + 'ms -> 20 ms, 5x faster.',
      'Latency -100' + ' '.repeat(496) + 'ms -> 20 ms, 5x faster.',
      '100 tests -> 20 tests, 5x faster.',
      'Latency 100 ms -> 20 ms. Parser is 5x faster.',
      'Latency 100 ms -> 20 ms\n5x faster.',
      'Cache 100 ms -> 20 ms; parser is 5x faster.',
      'Latency 100 ms -> 20 ms, 5x faster; startup is 9x faster.',
      'Latency 100 ms -> 20 ms, 5x faster and significantly better.',
    ]) assert.ok(analyze(message).issues.bannedVocabulary, message);
  }],
  ['statistical terms do not exempt independent quality adjectives', () => {
    assert.strictEqual(analyze('The robust regression estimator uses Huber loss.').issues.bannedVocabulary, null);
    assert.strictEqual(analyze('Use robust statistics.').issues.bannedVocabulary, null);
    for (const message of [
      'Use robust regression to make the service robust.',
      'Robust regression is significantly better.',
      'The parser is robust.', 'It works robustly.', 'Added robustness.',
    ]) assert.ok(analyze(message).issues.bannedVocabulary, message);
  }],
  ['commit scanning shares narrow vocabulary exceptions without mixing invocations or paragraphs', () => {
    for (const command of [
      'git commit -m "perf: latency 100 ms -> 20 ms, 5x faster"',
      'git commit -am "fix: robust regression estimator"',
    ]) assert.strictEqual(commitVerdict(command), null, command);
    for (const command of [
      'git commit -m "perf: latency 100 ms -> 20 ms"; git commit -m "5x faster"',
      'git commit -m "perf: latency 100 ms -> 20 ms" -m "5x faster"',
      'git commit -m "perf: latency 100 ms -> 20 ms, 4x faster"',
      'git commit -m "fix: robust regression makes the service robust"',
      'git commit -m "``` significantly better ```"',
    ]) assert.strictEqual(commitVerdict(command), 'block', command);
  }],
  ['commit analyzer rejects unreadable or malformed inputs', () => {
    for (const input of ['{', '{}', '[null]', '[{"messages":[2]}]']) {
      const result = cp.spawnSync(process.execPath, [ANALYZER, PATTERNS, '--commits'], { input, encoding: 'utf8' });
      assert.strictEqual(result.status, 1, input);
      assert.strictEqual(result.stdout, '', input);
    }
    const result = cp.spawnSync(process.execPath, [ANALYZER, `${PATTERNS}.missing`, '--commits'], {
      input: '[{"messages":["plain message"]}]', encoding: 'utf8',
    });
    assert.strictEqual(result.status, 1);
    assert.strictEqual(result.stdout, '');
  }],
  ['failed or empty commit analysis never records a successful evaluation', () => {
    for (const [source, reason] of [['process.exit(1);', 'analysis-failed'], ['', 'analysis-empty']]) {
      const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-vocab-failure-'));
      try {
        const hooks = path.join(sandbox, 'hooks');
        const home = path.join(sandbox, 'home');
        fs.cpSync(path.join(ROOT, 'hooks'), hooks, { recursive: true });
        fs.writeFileSync(path.join(hooks, 'lib', 'transcript-structure.js'), source);
        const result = cp.spawnSync('bash', [path.join(hooks, 'banned-vocab-check.sh')], {
          input: JSON.stringify({ session_id: 'vocab-failure', cwd: ROOT, tool_name: 'Bash', tool_input: { command: 'git commit -m "plain message"' } }),
          encoding: 'utf8', env: { ...process.env, CODEX_HOME: home },
        });
        assert.strictEqual(result.status, 0, result.stderr);
        assert.strictEqual(result.stdout, '');
        const rows = fs.readFileSync(path.join(home, 'logs', 'agentsmd.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
        assert.ok(!rows.some((row) => row.event === 'observe' && row.evaluated === true));
        assert.ok(rows.some((row) => row.event === 'fail-open' && row.extra.reason === reason), JSON.stringify(rows));
      } finally { fs.rmSync(sandbox, { recursive: true, force: true }); }
    }
  }],
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
