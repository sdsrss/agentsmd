'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HARD_RULES = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'hard-rules.json'), 'utf8'));
const FIXTURES = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'hook-contract-fixtures.json'), 'utf8'));
const REGISTRY = require('../lib/hook-registry');
const TRANSCRIPT_HOOK = path.join(ROOT, 'hooks', 'transcript-structure-scan.sh');
const SAFETY_HOOK = path.join(ROOT, 'hooks', 'pre-bash-safety-check.sh');

const CONTRACT_EVENTS = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PreCompact',
  'PostCompact',
  'UserPromptSubmit',
  'SubagentStop',
  'Stop',
  'SessionStart',
  'SubagentStart',
  'SessionEnd',
].sort();

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}\n       ${error.stack || error}`);
  }
}

function spawnHook(hook, event, sandbox) {
  return cp.spawnSync('bash', [hook], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: sandbox,
      CODEX_HOME: path.join(sandbox, '.codex'),
      CODEX_PROJECT_DIR: ROOT,
    },
  });
}

function telemetryRows(sandbox) {
  const file = path.join(sandbox, '.codex', 'logs', 'agentsmd.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function pendingText(sandbox, sessionId) {
  const state = path.join(sandbox, '.codex', '.agentsmd-state');
  const dir = path.join(state, `pending-advisories-${sessionId}.d`);
  if (!fs.existsSync(dir)) return '';
  return fs.readdirSync(dir).sort().map((name) => fs.readFileSync(path.join(dir, name), 'utf8')).join('');
}

test('hard-rules metadata separates documented, validated, and registered events', () => {
  assert.deepStrictEqual([...HARD_RULES.documented_hook_events].sort(), CONTRACT_EVENTS);
  assert.strictEqual(HARD_RULES.contract_source, 'official-codex-hooks');
  assert.strictEqual(HARD_RULES.contract_url, 'https://learn.chatgpt.com/docs/hooks');
  assert.deepStrictEqual(HARD_RULES.validated_codex_versions, ['0.145.0']);
  assert.match(HARD_RULES.validated_at, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(!Object.hasOwn(HARD_RULES, 'supported_hook_events'));
  assert.ok(HARD_RULES.registered_hook_events.every((event) => HARD_RULES.documented_hook_events.includes(event)));
});

test('contract fixtures cover current stable field shapes and roadmap boundary cases', () => {
  assert.strictEqual(FIXTURES.schema_version, 1);
  assert.strictEqual(FIXTURES.codex_version, '0.145.0');
  const ids = new Set(FIXTURES.fixtures.map((fixture) => fixture.id));
  for (const required of [
    'pretool-bash-deny',
    'pretool-bash-allow',
    'pretool-apply-patch',
    'posttool-bash-zero',
    'posttool-bash-nonzero',
    'posttool-unified-exec-write-stdin',
    'stop-last-assistant-message',
    'precompact-auto',
    'subagent-start',
    'subagent-stop',
    'plugin-session-start',
    'session-end-other',
  ]) assert.ok(ids.has(required), `missing ${required}`);
  for (const fixture of FIXTURES.fixtures.filter((item) => /ToolUse$/.test(item.event))) {
    assert.strictEqual(typeof fixture.input.turn_id, 'string', `${fixture.id} turn_id`);
    assert.strictEqual(typeof fixture.input.tool_use_id, 'string', `${fixture.id} tool_use_id`);
    assert.strictEqual(fixture.input.hook_event_name, fixture.event, `${fixture.id} event`);
  }
});

test('PreToolUse deny emits current permissionDecision plus the legacy block compatibility shape', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-hook-contract-'));
  try {
    const fixture = FIXTURES.fixtures.find((item) => item.id === 'pretool-bash-deny');
    const result = spawnHook(SAFETY_HOOK, fixture.input, sandbox);
    assert.strictEqual(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.strictEqual(output.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(output.hookSpecificOutput.permissionDecisionReason, /rm -rf/i);
    assert.strictEqual(output.decision, 'block');
    assert.match(output.reason, /rm -rf/i);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('PreToolUse near-negative remains an empty allow result', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-hook-contract-'));
  try {
    const fixture = FIXTURES.fixtures.find((item) => item.id === 'pretool-bash-allow');
    const result = spawnHook(SAFETY_HOOK, fixture.input, sandbox);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout.trim(), '');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Stop uses last_assistant_message without transcript access or fallback telemetry', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-hook-contract-'));
  try {
    const event = {
      session_id: 'canonical',
      turn_id: 'turn-canonical',
      hook_event_name: 'Stop',
      last_assistant_message: 'Done: changed parser.',
      transcript_path: path.join(sandbox, 'missing.jsonl'),
    };
    const result = spawnHook(TRANSCRIPT_HOOK, event, sandbox);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(pendingText(sandbox, 'canonical'), /four-section-order/);
    assert.ok(!telemetryRows(sandbox).some((row) => row.event === 'compat-fallback'));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Stop transcript compatibility fallback preserves verdict and records usage', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-hook-contract-'));
  try {
    const transcript = path.join(sandbox, 'transcript.jsonl');
    fs.writeFileSync(transcript, `${JSON.stringify({
      type: 'message',
      payload: { role: 'assistant', content: [{ type: 'output_text', text: 'Done: changed parser.' }] },
    })}\n`);
    const event = {
      session_id: 'fallback',
      turn_id: 'turn-fallback',
      hook_event_name: 'Stop',
      transcript_path: transcript,
    };
    const result = spawnHook(TRANSCRIPT_HOOK, event, sandbox);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.match(pendingText(sandbox, 'fallback'), /four-section-order/);
    assert.ok(telemetryRows(sandbox).some((row) => row.event === 'compat-fallback'
      && row.extra.from === 'last_assistant_message'
      && row.extra.to === 'transcript'));
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('every additional-context handler declares a bounded token limit in both wirings and registry', () => {
  const expected = new Map([
    ['session-start-check.sh', 6000],
    ['surface-advisories.sh', 1000],
    ['memory-prompt-hint.sh', 1000],
  ]);
  for (const relative of ['hooks.json', 'hooks/hooks.json']) {
    const wiring = JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
    const seen = new Map();
    for (const groups of Object.values(wiring.hooks)) {
      for (const group of groups) {
        for (const hook of group.hooks) {
          const match = hook.command.match(/\/([a-z0-9-]+\.sh)"/);
          if (match && expected.has(match[1])) seen.set(match[1], hook.additionalContextLimit);
        }
      }
    }
    assert.deepStrictEqual(seen, expected, relative);
  }
  for (const [basename, limit] of expected) {
    assert.strictEqual(REGISTRY.HOOK_REGISTRY.find((hook) => hook.basename === basename).additionalContextLimit, limit);
  }
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
