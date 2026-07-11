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
    const pending = path.join(sandbox, '.agentsmd-state', 'pending-advisories-report-test');
    return fs.existsSync(pending) ? fs.readFileSync(pending, 'utf8') : '';
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
