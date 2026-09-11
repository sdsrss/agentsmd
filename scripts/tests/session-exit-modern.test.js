'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const HOOK = path.join(ROOT, 'hooks', 'session-exit-checkpoint.sh');

function runCase(source, output = 'Script completed', following = []) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-session-exit-'));
  try {
    const transcript = path.join(sandbox, 'transcript.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user_message', payload: { input_text: 'change it' } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-1', input: source } }),
      JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'exec-1', output } }),
    ].concat(following.map(JSON.stringify)).join('\n') + '\n');
    const event = JSON.stringify({ session_id: 'modern-exec', cwd: ROOT, transcript_path: transcript });
    const result = cp.spawnSync('bash', [HOOK], {
      input: event,
      encoding: 'utf8',
      env: { ...process.env, CODEX_HOME: sandbox },
    });
    assert.strictEqual(result.status, 0, result.stderr);
    return fs.existsSync(path.join(sandbox, '.agentsmd-state', 'unvalidated-modern-exec.flag'));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

const cases = [
  ['functions.exec apply_patch creates checkpoint', () => assert.strictEqual(runCase('const r = await tools.apply_patch(patch); text(r);'), true)],
  ['functions.exec formatter creates checkpoint', () => assert.strictEqual(runCase('const r = await tools.exec_command({cmd:"npx prettier --write README.md"}); text(r.output);'), true)],
  ['shared wrapper completion cannot certify child validation', () => assert.strictEqual(runCase('const a = await tools.apply_patch(patch); const t = await tools.exec_command({cmd:"npm test"}); text(t.output);'), true)],
  ['paired terminal validation after apply_patch clears checkpoint', () => assert.strictEqual(runCase('const a = await tools.apply_patch(patch);', 'Script completed', [
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'exec-2', input: 'text(await tools.exec_command({cmd:"npm test"}));' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'exec-2', output: { exit_code: 0, wall_time_seconds: 0.1, output: 'PASS' } } },
  ]), false)],
  ['failed functions.exec validation is not evidence', () => assert.strictEqual(runCase('const a = await tools.apply_patch(patch); const t = await tools.exec_command({cmd:"npm test"}); text(t.output);', 'Script failed: Process exited with code 1'), true)],
  ['marker in string is not a mutation', () => assert.strictEqual(runCase('text("tools.apply_patch(patch)");'), false)],
  ['marker in comment is not a mutation', () => assert.strictEqual(runCase('// tools.apply_patch(patch)\ntext("no edit");'), false)],
];

let passed = 0;
for (const [name, fn] of cases) {
  try { fn(); passed += 1; console.log(`  ok   ${name}`); }
  catch (error) { console.error(`  FAIL ${name}\n       ${error.stack || error}`); }
}
console.log(`\nRESULT: ${passed} passed, ${cases.length - passed} failed`);
if (passed !== cases.length) process.exit(1);
