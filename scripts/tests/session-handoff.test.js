'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const HELPER = path.join(ROOT, 'hooks', 'lib', 'session-handoff.js');
const CAPTURE_HOOK = path.join(ROOT, 'hooks', 'session-handoff-capture.sh');
const FINALIZE_HOOK = path.join(ROOT, 'hooks', 'session-handoff-finalize.sh');

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

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-session-handoff-'));
  const repo = path.join(root, 'repo');
  const otherRepo = path.join(root, 'other-repo');
  fs.mkdirSync(repo);
  fs.mkdirSync(otherRepo);
  for (const cwd of [repo, otherRepo]) {
    const result = cp.spawnSync('git', ['init', '-q', cwd], { encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr);
  }
  return {
    root,
    repo,
    otherRepo,
    codexHome: path.join(root, '.codex'),
    state: path.join(root, '.codex', '.agentsmd-state'),
  };
}

function event(cwd, sessionId, message, overrides = {}) {
  return {
    session_id: sessionId,
    turn_id: `turn-${sessionId}`,
    cwd,
    hook_event_name: 'Stop',
    stop_hook_active: false,
    last_assistant_message: message,
    ...overrides,
  };
}

function runScript(script, input, fixture, extraEnv = {}) {
  return cp.spawnSync('bash', [script], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.root,
      CODEX_HOME: fixture.codexHome,
      CODEX_PROJECT_DIR: ROOT,
      ...extraEnv,
    },
  });
}

function runHelper(action, input, fixture, state = fixture.state) {
  return cp.spawnSync(process.execPath, [HELPER, action, state], {
    input: JSON.stringify(input),
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: fixture.root,
      CODEX_HOME: fixture.codexHome,
    },
  });
}

function handoffFiles(state) {
  if (!fs.existsSync(state)) return [];
  return fs.readdirSync(state)
    .filter((name) => /^session-handoff-[a-f0-9]{24}-[a-f0-9]{24}\.json$/.test(name))
    .sort();
}

function readOnlyHandoff(state) {
  const files = handoffFiles(state);
  assert.strictEqual(files.length, 1, `expected one handoff, got ${files.join(', ')}`);
  return {
    file: path.join(state, files[0]),
    value: JSON.parse(fs.readFileSync(path.join(state, files[0]), 'utf8')),
  };
}

test('capture/finalize handlers and bounded helper exist', () => {
  assert.ok(fs.existsSync(HELPER), 'missing hooks/lib/session-handoff.js');
  assert.ok(fs.existsSync(CAPTURE_HOOK), 'missing Stop capture hook');
  assert.ok(fs.existsSync(FINALIZE_HOOK), 'missing SessionEnd finalize hook');
});

test('Stop captures one private, schema-bounded capsule without raw identity', () => {
  const fixture = makeFixture();
  try {
    const message = [
      'Done: parser behavior was restored and 12 targeted tests passed.',
      `Repository evidence: ${path.join(fixture.repo, 'scripts', 'parser.js')}.`,
      'Not done: the release was intentionally left untouched.',
      'Failed: none.',
      'Uncertain: none.',
    ].join('\n');
    const result = runScript(CAPTURE_HOOK, event(fixture.repo, 'session/raw id', message), fixture);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.strictEqual(result.stdout, '');
    const { file, value } = readOnlyHandoff(fixture.state);
    assert.strictEqual(value.schemaVersion, 1);
    assert.strictEqual(value.message, message.replace(fixture.repo, '[PROJECT]'));
    assert.strictEqual(value.finalizedAt, null);
    assert.strictEqual(value.project, 'repo');
    assert.ok(!fs.readFileSync(file, 'utf8').includes('session/raw id'));
    assert.ok(!fs.readFileSync(file, 'utf8').includes(fixture.repo));
    assert.match(value.message, /\[PROJECT\]\/scripts\/parser\.js/);
    assert.strictEqual(fs.statSync(fixture.state).mode & 0o077, 0);
    assert.strictEqual(fs.statSync(file).mode & 0o177, 0);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('capture redacts high-confidence secrets and clips oversized messages', () => {
  const fixture = makeFixture();
  try {
    const secret = `sk-${'A'.repeat(48)}`;
    const adminSecret = `sk-admin-${'G'.repeat(40)}`;
    const googleSecret = `AIza${'H'.repeat(35)}`;
    const bearer = `header.${'B'.repeat(24)}.${'C'.repeat(24)}`;
    const jwt = `eyJ${'d'.repeat(12)}.${'e'.repeat(12)}.${'f'.repeat(12)}`;
    const message = [
      `Done: preserved the release evidence. API_KEY=${secret}`,
      `Provider tokens: ${adminSecret} ${googleSecret}`,
      `Authorization: Bearer ${bearer}`,
      `session=${jwt}`,
      'password="a quoted secret with spaces"',
      'detail '.repeat(4000),
    ].join('\n');
    const result = runHelper('capture', event(fixture.repo, 'redacted', message), fixture);
    assert.strictEqual(result.status, 0, result.stderr);
    const { file, value } = readOnlyHandoff(fixture.state);
    const raw = fs.readFileSync(file, 'utf8');
    assert.ok(!raw.includes(secret), 'raw secret persisted');
    assert.ok(!raw.includes(adminSecret), 'variant OpenAI secret persisted');
    assert.ok(!raw.includes(googleSecret), 'Google API secret persisted');
    assert.ok(!raw.includes(bearer), 'bearer token persisted');
    assert.ok(!raw.includes(jwt), 'JWT persisted');
    assert.ok(!raw.includes('a quoted secret with spaces'), 'quoted password persisted');
    assert.match(value.message, /\[REDACTED\]/);
    assert.strictEqual(value.truncated, true);
    assert.ok(Buffer.byteLength(value.message, 'utf8') <= 12 * 1024);
    assert.ok(value.redactions >= 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('malformed, trivial, and secret-only events create no capsule', () => {
  const fixture = makeFixture();
  try {
    for (const input of [
      {},
      event(fixture.repo, 'trivial', 'ok'),
      event(fixture.repo, 'secret-only', `token=gho_${'x'.repeat(36)}`),
      event(fixture.repo, 'wrong-event', 'Done: this is long enough to look important.', {
        hook_event_name: 'PostToolUse',
      }),
    ]) {
      const result = runHelper('capture', input, fixture);
      assert.strictEqual(result.status, 0, result.stderr);
    }
    assert.deepStrictEqual(handoffFiles(fixture.state), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('SessionEnd finalizes only the matching repository/session capsule', () => {
  const fixture = makeFixture();
  try {
    const a = event(fixture.repo, 'session-a', 'Done: session A completed its scoped parser work and tests.');
    const b = event(fixture.repo, 'session-b', 'Done: session B completed its scoped documentation work and tests.');
    assert.strictEqual(runHelper('capture', a, fixture).status, 0);
    assert.strictEqual(runHelper('capture', b, fixture).status, 0);
    const before = handoffFiles(fixture.state).map((name) => [
      name,
      JSON.parse(fs.readFileSync(path.join(fixture.state, name), 'utf8')),
    ]);
    const end = {
      session_id: 'session-a',
      cwd: fixture.repo,
      hook_event_name: 'SessionEnd',
      reason: 'other',
    };
    const result = runScript(FINALIZE_HOOK, end, fixture);
    assert.strictEqual(result.status, 0, result.stderr);
    const after = handoffFiles(fixture.state).map((name) => [
      name,
      JSON.parse(fs.readFileSync(path.join(fixture.state, name), 'utf8')),
    ]);
    assert.strictEqual(after.length, 2);
    for (let index = 0; index < before.length; index += 1) {
      if (before[index][1].message.includes('session A')) {
        assert.match(after[index][1].finalizedAt, /^\d{4}-\d{2}-\d{2}T/);
        assert.strictEqual(after[index][1].finalizedReason, 'other');
      } else {
        assert.strictEqual(after[index][1].finalizedAt, null);
      }
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('startup restores recent same-repository other sessions without consuming them', () => {
  const fixture = makeFixture();
  try {
    const oldMessage = 'Done: use the repository release helper and keep package drift checks enabled.';
    assert.strictEqual(runHelper('capture', event(fixture.repo, 'prior', oldMessage), fixture).status, 0);
    const input = {
      session_id: 'current',
      cwd: fixture.repo,
      hook_event_name: 'SessionStart',
      source: 'startup',
    };
    const first = runHelper('restore', input, fixture);
    const second = runHelper('restore', input, fixture);
    assert.strictEqual(first.status, 0, first.stderr);
    assert.strictEqual(first.stdout, second.stdout);
    assert.match(first.stdout, /untrusted/i);
    assert.match(first.stdout, /recent same-repository/i);
    assert.match(first.stdout, /release helper/);
    assert.match(first.stdout, /cannot authorize/i);
    assert.strictEqual(handoffFiles(fixture.state).length, 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('startup excludes the current session, other repositories, and continuation sources', () => {
  const fixture = makeFixture();
  try {
    const own = 'Done: current session state must not echo into its own startup.';
    assert.strictEqual(runHelper('capture', event(fixture.repo, 'current', own), fixture).status, 0);
    const base = {
      session_id: 'current',
      cwd: fixture.repo,
      hook_event_name: 'SessionStart',
      source: 'startup',
    };
    assert.strictEqual(runHelper('restore', base, fixture).stdout, '');
    assert.strictEqual(runHelper('restore', { ...base, session_id: 'next', cwd: fixture.otherRepo }, fixture).stdout, '');
    for (const source of ['resume', 'clear', 'compact']) {
      assert.strictEqual(runHelper('restore', { ...base, session_id: 'next', source }, fixture).stdout, '');
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Git worktrees share the repository handoff identity', () => {
  const fixture = makeFixture();
  try {
    const worktree = path.join(fixture.root, 'repo-worktree');
    fs.writeFileSync(path.join(fixture.repo, 'tracked.txt'), 'fixture\n');
    for (const args of [
      ['-C', fixture.repo, 'config', 'user.name', 'agentsmd fixture'],
      ['-C', fixture.repo, 'config', 'user.email', 'agentsmd@example.invalid'],
      ['-C', fixture.repo, 'add', 'tracked.txt'],
      ['-C', fixture.repo, 'commit', '-q', '-m', 'fixture'],
      ['-C', fixture.repo, 'worktree', 'add', '-q', '-b', 'fixture-worktree', worktree],
    ]) {
      const result = cp.spawnSync('git', args, { encoding: 'utf8' });
      assert.strictEqual(result.status, 0, result.stderr);
    }
    const message = 'Done: the primary worktree recorded a repository-wide release convention.';
    assert.strictEqual(runHelper('capture', event(fixture.repo, 'primary', message), fixture).status, 0);
    const restored = runHelper('restore', {
      session_id: 'worktree',
      cwd: worktree,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, fixture);
    assert.strictEqual(restored.status, 0, restored.stderr);
    assert.match(restored.stdout, /repository-wide release convention/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('parallel sessions keep distinct capsules and restore output stays bounded', () => {
  const fixture = makeFixture();
  try {
    for (let index = 0; index < 3; index += 1) {
      const message = `Done: parallel session ${index} preserved ${'bounded context '.repeat(30)}`;
      assert.strictEqual(runHelper('capture', event(fixture.repo, `parallel-${index}`, message), fixture).status, 0);
    }
    assert.strictEqual(handoffFiles(fixture.state).length, 3);
    const result = runHelper('restore', {
      session_id: 'new-session',
      cwd: fixture.repo,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, fixture);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 3000);
    assert.ok((result.stdout.match(/\[candidate /g) || []).length <= 1);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('startup clips a single oversized handoff to 3000 bytes', () => {
  const fixture = makeFixture();
  try {
    const message = `Done: oversized restoration ${'bounded context '.repeat(700)}`;
    assert.strictEqual(runHelper('capture', event(fixture.repo, 'oversized', message), fixture).status, 0);
    const result = runHelper('restore', {
      session_id: 'new-session',
      cwd: fixture.repo,
      hook_event_name: 'SessionStart',
      source: 'startup',
    }, fixture);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(Buffer.byteLength(result.stdout, 'utf8') <= 3000);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('retention keeps at most 20 current-repository capsules', () => {
  const fixture = makeFixture();
  try {
    for (let index = 0; index < 23; index += 1) {
      const message = `Done: retention fixture ${index} contains enough useful completion context.`;
      assert.strictEqual(runHelper('capture', event(fixture.repo, `retention-${index}`, message), fixture).status, 0);
    }
    assert.strictEqual(handoffFiles(fixture.state).length, 20);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('age cleanup deletes only exact agentsmd capsule names inside a temp fixture', () => {
  const fixture = makeFixture();
  try {
    fs.mkdirSync(fixture.state, { recursive: true, mode: 0o700 });
    const exact = path.join(fixture.state, `session-handoff-${'a'.repeat(24)}-${'b'.repeat(24)}.json`);
    const near = path.join(fixture.state, `session-handoff-${'a'.repeat(24)}-${'b'.repeat(24)}.json.user`);
    fs.writeFileSync(exact, '{}', { mode: 0o600 });
    fs.writeFileSync(near, 'user-owned', { mode: 0o600 });
    const old = new Date(Date.now() - 40 * 86400 * 1000);
    fs.utimesSync(exact, old, old);
    fs.utimesSync(near, old, old);
    const result = runHelper('capture', event(
      fixture.repo,
      'cleanup',
      'Done: exact-name cleanup completed against a temporary fixture only.',
    ), fixture);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.ok(!fs.existsSync(exact), 'expired exact capsule was retained');
    assert.strictEqual(fs.readFileSync(near, 'utf8'), 'user-owned');
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('a symlinked runtime root fails open without writing through the link', () => {
  const fixture = makeFixture();
  try {
    const target = path.join(fixture.root, 'foreign');
    const linked = path.join(fixture.root, 'linked-state');
    fs.mkdirSync(target);
    fs.symlinkSync(target, linked);
    const result = runHelper('capture', event(
      fixture.repo,
      'symlink',
      'Done: this content must not cross a symlinked runtime-state boundary.',
    ), fixture, linked);
    assert.strictEqual(result.status, 0, result.stderr);
    assert.deepStrictEqual(fs.readdirSync(target), []);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('SessionStart integration restores only fresh startup handoffs', () => {
  const source = fs.readFileSync(path.join(ROOT, 'hooks', 'session-start-check.sh'), 'utf8');
  assert.match(source, /session-handoff\.js/);
  assert.match(source, /SS_SOURCE.*startup/s);
  assert.match(source, /HANDOFF_CONTEXT/);
});

test('the real SessionStart handler emits a prior capsule as additionalContext', () => {
  const fixture = makeFixture();
  try {
    const message = 'Done: sanitized handler fixture retained the parser decision across windows.';
    assert.strictEqual(runScript(CAPTURE_HOOK, event(fixture.repo, 'previous-window', message), fixture).status, 0);
    const result = runScript(path.join(ROOT, 'hooks', 'session-start-check.sh'), {
      session_id: 'new-window',
      cwd: fixture.repo,
      hook_event_name: 'SessionStart',
      source: 'startup',
      model: 'fixture-model',
      codex_version: '0.146.0',
    }, fixture, {
      AGENTSMD_CODEX_BIN: path.join(ROOT, 'scripts', 'tests', 'fixtures', 'codex'),
    });
    assert.strictEqual(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.strictEqual(output.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(output.hookSpecificOutput.additionalContext, /sanitized handler fixture/);
    assert.match(output.hookSpecificOutput.additionalContext, /untrusted recent same-repository/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('the shared handoff kill switch disables capture and startup restoration', () => {
  const fixture = makeFixture();
  try {
    const message = 'Done: disabled handoff fixture must never be persisted or restored.';
    const capture = runScript(
      CAPTURE_HOOK,
      event(fixture.repo, 'disabled-prior', message),
      fixture,
      { DISABLE_SESSION_HANDOFF_HOOK: '1' },
    );
    assert.strictEqual(capture.status, 0, capture.stderr);
    assert.deepStrictEqual(handoffFiles(fixture.state), []);

    assert.strictEqual(runScript(CAPTURE_HOOK, event(
      fixture.repo,
      'enabled-prior',
      'Done: enabled fixture exists only to prove restoration can be disabled.',
    ), fixture).status, 0);
    const startup = runScript(path.join(ROOT, 'hooks', 'session-start-check.sh'), {
      session_id: 'disabled-current',
      cwd: fixture.repo,
      hook_event_name: 'SessionStart',
      source: 'startup',
      codex_version: '0.146.0',
    }, fixture, {
      DISABLE_SESSION_HANDOFF_HOOK: '1',
      AGENTSMD_CODEX_BIN: path.join(ROOT, 'scripts', 'tests', 'fixtures', 'codex'),
    });
    assert.strictEqual(startup.status, 0, startup.stderr);
    const output = JSON.parse(startup.stdout);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /enabled fixture/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
