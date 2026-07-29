'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const JOURNAL = require(path.join(ROOT, 'hooks', 'lib', 'event-journal.js'));
const CASES = JSON.parse(fs.readFileSync(path.join(ROOT, 'qa', 'event-journal-cases.json'), 'utf8'));
const PRE_HOOK = path.join(ROOT, 'hooks', 'pre-mutation-journal.sh');
const POST_HOOK = path.join(ROOT, 'hooks', 'post-tool-journal.sh');
const STOP_HOOK = path.join(ROOT, 'hooks', 'session-exit-checkpoint.sh');

let passed = 0;
let failed = 0;
const pending = [];
function pass(name) {
  passed += 1;
  console.log(`  ok   ${name}`);
}
function fail(name, error) {
  failed += 1;
  console.error(`  FAIL ${name}\n       ${error.stack || error}`);
}
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      pending.push(result.then(() => pass(name), (error) => fail(name, error)));
    } else {
      pass(name);
    }
  } catch (error) {
    fail(name, error);
  }
}

function eventFrom(step, sessionId = 'journal-session', turnId = 'turn-1') {
  const response = step.exit_code == null ? {} : { exit_code: step.exit_code, output: 'PRIVATE TOOL OUTPUT' };
  return {
    session_id: sessionId,
    turn_id: turnId,
    tool_use_id: step.tool_use_id,
    cwd: '/private/workspace',
    hook_event_name: step.mode === 'pre' ? 'PreToolUse' : 'PostToolUse',
    tool_name: step.tool_name,
    tool_input: step.command == null ? {} : { command: step.command },
    tool_response: response,
    model: 'gpt-5.6-sol',
  };
}

function runCase(testCase) {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-journal-case-'));
  try {
    for (const [index, step] of testCase.events.entries()) {
      JOURNAL.processEvent(step.mode, eventFrom(step), {
        stateDir: sandbox,
        surface: 'standalone',
        nowMs: step.at_ms,
        nonce: `n${index}`,
      });
    }
    return {
      rows: JOURNAL.readRows(sandbox, 'journal-session'),
      summary: JOURNAL.summarizeJournal(sandbox, 'journal-session', 'turn-1'),
    };
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}

for (const testCase of CASES.cases) {
  test(`timing: ${testCase.id}`, () => {
    const { summary } = runCase(testCase);
    assert.strictEqual(summary.mutations, testCase.expected.mutations);
    assert.strictEqual(summary.fresh_validation, testCase.expected.fresh_validation);
    if (Object.hasOwn(testCase.expected, 'preflight_before_mutation')) {
      assert.strictEqual(summary.preflight_before_mutation, testCase.expected.preflight_before_mutation);
      assert.strictEqual(summary.plan_before_mutation, testCase.expected.plan_before_mutation);
    }
  });
}

test('persisted rows are privacy-bounded and contain only repo-relative paths', () => {
  const { rows } = runCase(CASES.cases.find((item) => item.id === 'mutation-then-validation'));
  const serialized = JSON.stringify(rows);
  for (const forbidden of [
    'npm run check',
    '*** Begin Patch',
    'PRIVATE TOOL OUTPUT',
    '/private/workspace',
    'gpt-5.6-sol',
  ]) assert.ok(!serialized.includes(forbidden), `journal leaked ${forbidden}`);
  assert.ok(rows.some((row) => row.repo_relative_files.includes('src/new.js')));
  for (const row of rows) {
    for (const file of row.repo_relative_files) {
      assert.ok(!path.isAbsolute(file));
      assert.ok(!file.startsWith('..'));
    }
  }
});

test('Edit and Write mutation intents retain only safe repo-relative target paths', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-journal-edit-write-'));
  try {
    for (const [index, toolName] of ['Edit', 'Write'].entries()) {
      JOURNAL.processEvent('pre', {
        session_id: 'edit-write',
        turn_id: 'turn-edit-write',
        tool_use_id: `tool-${index}`,
        cwd: '/private/workspace',
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
        tool_input: {
          file_path: index === 0 ? 'src/edit.js' : '/private/absolute.js',
          path: index === 1 ? 'src/write.js' : undefined,
          content: 'PRIVATE FILE CONTENT',
          old_string: 'PRIVATE OLD CONTENT',
          new_string: 'PRIVATE NEW CONTENT',
        },
        model: 'gpt-5.6-sol',
      }, {
        stateDir: sandbox,
        surface: 'standalone',
        nowMs: 1000 + index,
        nonce: `edit-write-${index}`,
      });
    }
    const rows = JOURNAL.readRows(sandbox, 'edit-write');
    assert.strictEqual(rows.length, 2);
    assert.deepStrictEqual(rows.map((row) => row.repo_relative_files), [
      ['src/edit.js'],
      ['src/write.js'],
    ]);
    const serialized = JSON.stringify(rows);
    for (const forbidden of [
      '/private/workspace',
      '/private/absolute.js',
      'PRIVATE FILE CONTENT',
      'PRIVATE OLD CONTENT',
      'PRIVATE NEW CONTENT',
      'gpt-5.6-sol',
    ]) assert.ok(!serialized.includes(forbidden), `journal leaked ${forbidden}`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('Pre/Post wrapper hooks persist bounded rows and honor their kill switches', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-journal-wrappers-'));
  const codexHome = path.join(sandbox, '.codex');
  const stateDir = path.join(codexHome, '.agentsmd-state');
  const baseEnv = { ...process.env, HOME: sandbox, CODEX_HOME: codexHome };
  try {
    const pre = eventFrom({
      mode: 'pre',
      tool_use_id: 'wrapper-edit',
      tool_name: 'apply_patch',
      command: '*** Begin Patch\n*** Update File: src/wrapper.js\n@@\n-old\n+new\n*** End Patch',
    }, 'wrapper-session', 'wrapper-turn');
    const post = eventFrom({
      mode: 'post',
      tool_use_id: 'wrapper-edit',
      tool_name: 'apply_patch',
      command: '*** Begin Patch\n*** Update File: src/wrapper.js\n@@\n-old\n+new\n*** End Patch',
      exit_code: 0,
    }, 'wrapper-session', 'wrapper-turn');
    const preResult = cp.spawnSync('bash', [PRE_HOOK], {
      input: JSON.stringify(pre),
      encoding: 'utf8',
      env: baseEnv,
    });
    const postResult = cp.spawnSync('bash', [POST_HOOK], {
      input: JSON.stringify(post),
      encoding: 'utf8',
      env: baseEnv,
    });
    assert.strictEqual(preResult.status, 0, preResult.stderr);
    assert.strictEqual(postResult.status, 0, postResult.stderr);
    const rows = JOURNAL.readRows(stateDir, 'wrapper-session');
    assert.deepStrictEqual(rows.map((row) => row.state), ['mutation_intent', 'mutation_completed']);
    assert.ok(rows.every((row) => row.repo_relative_files.includes('src/wrapper.js')));

    const disabledPre = cp.spawnSync('bash', [PRE_HOOK], {
      input: JSON.stringify({ ...pre, tool_use_id: 'disabled-pre' }),
      encoding: 'utf8',
      env: { ...baseEnv, DISABLE_PRE_MUTATION_JOURNAL_HOOK: '1' },
    });
    const disabledPost = cp.spawnSync('bash', [POST_HOOK], {
      input: JSON.stringify({ ...post, tool_use_id: 'disabled-post' }),
      encoding: 'utf8',
      env: { ...baseEnv, DISABLE_POST_TOOL_JOURNAL_HOOK: '1' },
    });
    assert.strictEqual(disabledPre.status, 0, disabledPre.stderr);
    assert.strictEqual(disabledPost.status, 0, disabledPost.stderr);
    assert.strictEqual(JOURNAL.readRows(stateDir, 'wrapper-session').length, 2);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('concurrent atomic writes lose and duplicate zero events across sessions', async () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-journal-concurrent-'));
  try {
    const writes = [];
    for (let index = 0; index < 40; index += 1) {
      const event = eventFrom({
        mode: 'post',
        tool_use_id: `tool-${index}`,
        tool_name: 'Bash',
        command: 'npm test',
        exit_code: 0,
      }, index % 2 === 0 ? 'session-a' : 'session-b');
      writes.push(new Promise((resolve, reject) => {
        const child = cp.spawn(process.execPath, [path.join(ROOT, 'hooks', 'lib', 'event-journal.js'), '--mode=post'], {
          env: {
            ...process.env,
            AGENTSMD_EVENT_JOURNAL_STATE_DIR: sandbox,
            AGENTSMD_EVENT_JOURNAL_SURFACE: 'standalone',
          },
          stdio: ['pipe', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', reject);
        child.on('exit', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`worker ${index} exited ${code}: ${stderr}`));
        });
        child.stdin.end(JSON.stringify(event));
      }));
    }
    await Promise.all(writes);
    const a = JOURNAL.readRows(sandbox, 'session-a');
    const b = JOURNAL.readRows(sandbox, 'session-b');
    assert.strictEqual(a.length, 20);
    assert.strictEqual(b.length, 20);
    assert.strictEqual(new Set([...a, ...b].map((row) => row.tool_use_id)).size, 40);
    assert.ok(a.every((row) => row.session_id === 'session-a'));
    assert.ok(b.every((row) => row.session_id === 'session-b'));
  } catch (error) {
    throw error;
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

test('journal cap prunes only old journal rows inside an isolated fixture', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-journal-cap-'));
  const sentinel = path.join(sandbox, 'outside-sentinel');
  fs.writeFileSync(sentinel, 'keep');
  try {
    for (let index = 0; index < JOURNAL.JOURNAL_MAX_FILES + 5; index += 1) {
      JOURNAL.processEvent('post', eventFrom({
        mode: 'post',
        tool_use_id: `cap-${index}`,
        tool_name: 'Bash',
        command: 'npm test',
        exit_code: 0,
      }), {
        stateDir: sandbox,
        surface: 'standalone',
        nowMs: 1000 + index,
        nonce: `p${index}`,
      });
    }
    assert.strictEqual(JOURNAL.readRows(sandbox, 'journal-session').length, JOURNAL.JOURNAL_MAX_FILES);
    assert.strictEqual(fs.readFileSync(sentinel, 'utf8'), 'keep');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

function runStop(event, sandbox) {
  return cp.spawnSync('bash', [STOP_HOOK], {
    input: JSON.stringify(event),
    encoding: 'utf8',
    env: { ...process.env, HOME: sandbox, CODEX_HOME: path.join(sandbox, '.codex') },
  });
}

test('Stop native consumer and transcript fallback produce the same unvalidated flag verdict', () => {
  const nativeBox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-journal-stop-native-'));
  const legacyBox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-journal-stop-legacy-'));
  try {
    // Source-tree hooks have no installed physical surface, so the documented
    // fail-open state path is the legacy shared root. Installed standalone
    // coverage for the private runtime path remains in runtime-state.test.js.
    const nativeState = path.join(nativeBox, '.codex', '.agentsmd-state');
    JOURNAL.processEvent('post', eventFrom({
      mode: 'post',
      tool_use_id: 'edit-native',
      tool_name: 'apply_patch',
      command: '*** Begin Patch\n*** Update File: src/a.js\n@@\n-a\n+b\n*** End Patch',
      exit_code: 0,
    }, 'parity', 'turn-parity'), {
      stateDir: nativeState,
      surface: 'standalone',
      nowMs: 1000,
      nonce: 'native',
    });
    const nativeResult = runStop({
      session_id: 'parity',
      turn_id: 'turn-parity',
      cwd: ROOT,
      hook_event_name: 'Stop',
    }, nativeBox);
    assert.strictEqual(nativeResult.status, 0, nativeResult.stderr);

    const transcript = path.join(legacyBox, 'legacy.jsonl');
    fs.writeFileSync(transcript, [
      JSON.stringify({ type: 'user_message', payload: { role: 'user', content: 'edit' } }),
      JSON.stringify({ type: 'custom_tool_call', payload: { name: 'apply_patch' } }),
    ].join('\n') + '\n');
    const legacyResult = runStop({
      session_id: 'parity',
      cwd: ROOT,
      hook_event_name: 'Stop',
      transcript_path: transcript,
    }, legacyBox);
    assert.strictEqual(legacyResult.status, 0, legacyResult.stderr);

    const nativeFlag = path.join(nativeState, 'unvalidated-parity.flag');
    const legacyFlag = path.join(legacyBox, '.codex', '.agentsmd-state', 'unvalidated-parity.flag');
    assert.strictEqual(fs.existsSync(nativeFlag), true);
    assert.strictEqual(fs.existsSync(legacyFlag), true);
  } finally {
    fs.rmSync(nativeBox, { recursive: true, force: true });
    fs.rmSync(legacyBox, { recursive: true, force: true });
  }
});

Promise.all(pending).then(() => {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
});
