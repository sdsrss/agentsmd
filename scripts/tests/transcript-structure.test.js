'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'hooks', 'transcript-structure-scan.sh');

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
