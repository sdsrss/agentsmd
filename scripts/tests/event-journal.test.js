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

const validationCases = [
  ['project validator', 'node verify.js', { exit_code: 0 }, true],
  ['syntax check', 'node --check calc.js', { exit_code: 0 }, true],
  ['Python assertion', 'python3 -c "assert 2 + 2 == 4"', { exit_code: 0 }, true],
  ['Python test module', 'python3 -m pytest', { exit_code: 0 }, true],
  ['check chain', 'node tests/a.test.js && bash hooks/tests/smoke.sh', { exit_code: 0 }, true],
  ['shell wrapper', 'bash -lc "npm test"', { exit_code: 0 }, true],
  ['env wrapper', 'env MODE=test npm test', { exit_code: 0 }, true],
  ['absolute executable', '/usr/bin/node --check calc.js', { exit_code: 0 }, true],
  ['quoted marker', 'printf "%s\\n" "npm test"', { exit_code: 0 }, false],
  ['comment marker', 'echo done # npm test', { exit_code: 0 }, false],
  ['dead branch', 'if false; then npm test; fi', { exit_code: 0 }, false],
  ['short circuit', 'true || npm test', { exit_code: 0 }, false],
  ['masked failure', 'npm test; true', { exit_code: 0 }, false],
  ['pipeline', 'npm test | cat', { exit_code: 0 }, false],
  ['background', 'npm test &', { exit_code: 0 }, false],
  ['deferred function', 'check() { npm test; }', { exit_code: 0 }, false],
  ['here document data', 'cat <<EOF\nnpm test\nEOF', { exit_code: 0 }, false],
  ['Python printed assertion', 'python3 -c "print(\'assert True\')"', { exit_code: 0 }, false],
  ['Python optimized assertion', 'python3 -O -c "assert False"', { exit_code: 0 }, false],
  ['Python env optimization', 'PYTHONOPTIMIZE=1 python3 -c "assert False"', { exit_code: 0 }, false],
  ['Python env wrapper optimization', 'env PYTHONOPTIMIZE=1 python3 -c "assert False"', { exit_code: 0 }, false],
  ['make dry run', 'make test -n', { exit_code: 0 }, false],
  ['npm skipped scripts', 'npm test --ignore-scripts', { exit_code: 0 }, false],
  ['typecheck config only', 'tsc --showConfig', { exit_code: 0 }, false],
  ['lint config only', 'eslint --print-config calc.js', { exit_code: 0 }, false],
  ['mutating equal option', 'biome check --write=true .', { exit_code: 0 }, false],
  ['dynamic command', '$RUNNER test', { exit_code: 0 }, false],
  ['failed check', 'npm test', { exit_code: 1 }, false],
  ['null exit', 'npm test', { exit_code: null }, false],
  ['boolean exit', 'npm test', { exit_code: false }, false],
  ['empty response', 'npm test', {}, false],
  ['running response', 'npm test', { session_id: 123, output: 'Process running' }, false],
  ['output spoof', 'npm test', { output: 'exit_code: 0' }, false],
  ['nested output spoof', 'npm test', { output: { exit_code: 0 } }, false],
  ['conflicting statuses', 'npm test', { exit_code: 0, exitCode: 1 }, false],
  ['terminal envelope', 'npm test', JSON.stringify({ exit_code: 0, output: 'PASS' }), false, true],
];
for (const [name, command, response, expected] of validationCases) {
  test(`validation evidence: ${name}`, () => {
    const event = eventFrom({ mode: 'post', tool_name: 'Bash', tool_use_id: 'check', command });
    event.tool_response = response;
    const result = JOURNAL.classifyPost(event);
    assert.strictEqual(result?.state === 'validation_completed' && result?.outcome === 'success', expected);
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

test('sanitized Codex 0.154.0 stdout-only response stays unknown and outside violation telemetry', () => {
  const fixture = require('./fixtures/event-journal-codex-0.154.0.json');
  const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-validation-unknown-')));
  const stateDir = path.join(box, '.codex/.agentsmd-state');
  try {
    const event = fixture.event;
    JOURNAL.processEvent('post', { ...event, tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch' }, tool_response: { exit_code: 0 } }, { stateDir, nowMs: 1 });
    const row = JOURNAL.processEvent('post', event, { stateDir, nowMs: 2 });
    assert.strictEqual(JOURNAL.classifyPost({ ...event, tool_response: '{"exit_code":0}' }).outcome, 'unknown');
    assert.strictEqual(row.state, 'validation_observed');
    assert.strictEqual(row.outcome, 'unknown');
    const summary = JOURNAL.summarizeJournal(stateDir, event.session_id, event.turn_id);
    assert.strictEqual(summary.fresh_validation, false);
    assert.strictEqual(summary.fresh_validation_unknown, true);
    assert.strictEqual(summary.validations, 0);
    assert.strictEqual(runStop({ ...event, cwd: box, hook_event_name: 'Stop' }, box).status, 0);
    const flag = fs.readFileSync(path.join(stateDir, 'unvalidated-sanitized-session.flag'), 'utf8');
    assert.match(flag, /validation=unknown/);
    const log = fs.readFileSync(path.join(box, '.codex/logs/agentsmd.jsonl'), 'utf8');
    assert.match(log, /validation-terminal-status-unavailable/);
    assert.doesNotMatch(log, /"event":"advisory"/);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
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

for (const [name, command, response, nativeExpected, expected = nativeExpected] of validationCases) {
  test(`Stop fallback validation: ${name}`, () => {
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-validation-parity-')));
    try {
      const transcript = path.join(box, 'events.jsonl');
      fs.writeFileSync(transcript, [
        { type: 'user_message', payload: { role: 'user' } },
        { type: 'custom_tool_call', payload: { name: 'apply_patch', call_id: 'edit' } },
        { type: 'function_call', payload: { name: 'exec_command', call_id: 'check', arguments: JSON.stringify({ cmd: command }) } },
        { type: 'function_call_output', payload: { call_id: 'check', output: response } },
      ].map(JSON.stringify).join('\n') + '\n');
      const result = runStop({ session_id: 'parity', cwd: box, transcript_path: transcript }, box);
      assert.strictEqual(result.status, 0, result.stderr);
      assert.strictEqual(fs.existsSync(path.join(box, '.codex/.agentsmd-state/unvalidated-parity.flag')), !expected);
      if (['empty response', 'running response', 'null exit', 'output spoof'].includes(name)) {
        assert.match(fs.readFileSync(path.join(box, '.codex/.agentsmd-state/unvalidated-parity.flag'), 'utf8'), /validation=unknown/);
        const log = fs.readFileSync(path.join(box, '.codex/logs/agentsmd.jsonl'), 'utf8');
        assert.match(log, /validation-terminal-status-unavailable/);
        assert.doesNotMatch(log, /"event":"advisory"|"event":"observe"/);
      }
    } finally { fs.rmSync(box, { recursive: true, force: true }); }
  });
}

for (const [name, source, expected, response = { exit_code: 0, wall_time_seconds: 0.1, output: "PASS" }] of [
  ['one awaited wrapper', 'text(await tools.exec_command({cmd: "node verify.js", max_output_tokens: 1000}));', true],
  ['unemitted awaited wrapper', 'await tools.exec_command({cmd: "npm test"});', false],
  ['outer-only success', 'text(await tools.exec_command({cmd: "npm test"}));', false, { exit_code: 0 }],
  ['failed child', 'text(await tools.exec_command({cmd: "npm test"}));', false, { exit_code: 1, wall_time_seconds: 0.1, output: "FAIL" }],
  ['conditional wrapper', 'if (false) { text(await tools.exec_command({cmd: "npm test"})); }', false],
  ['unawaited wrapper', 'tools.exec_command({cmd: "npm test"});', false],
  ['multiple wrappers', 'text(await tools.exec_command({cmd: "npm test"})); text(await tools.exec_command({cmd: "true"}));', false],
  ['dynamic argument', 'text(await tools.exec_command({cmd: "npm test", workdir: getPath()}));', false],
]) {
  test(`Stop wrapper execution evidence: ${name}`, () => {
    const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-validation-wrapper-')));
    try {
      const transcript = path.join(box, 'events.jsonl');
      fs.writeFileSync(transcript, [
        { type: 'user_message', payload: { role: 'user' } },
        { type: 'custom_tool_call', payload: { name: 'apply_patch' } },
        { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'wrapper', input: source } },
        { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'wrapper', output: response } },
      ].map(JSON.stringify).join('\n') + '\n');
      assert.strictEqual(runStop({ session_id: 'wrapper', cwd: box, transcript_path: transcript }, box).status, 0);
      assert.strictEqual(fs.existsSync(path.join(box, '.codex/.agentsmd-state/unvalidated-wrapper.flag')), !expected);
    } finally { fs.rmSync(box, { recursive: true, force: true }); }
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

const persistedFixture = require('./fixtures/event-journal-persisted-0.154.0.json');
function withReceiptFixture(fn) {
  const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-terminal-receipt-')));
  const file = path.join(box, 'transcript.jsonl');
  const records = structuredClone(persistedFixture.records);
  const event = { session_id: persistedFixture.session_id, turn_id: persistedFixture.turn_id, transcript_path: file };
  const write = () => fs.writeFileSync(file, records.map(JSON.stringify).join('\n') + '\n');
  try { write(); fn({ box, file, records, event, write }); }
  finally { fs.rmSync(box, { recursive: true, force: true }); }
}

// Exercise Darwin spellings on every CI platform while retaining real file,
// descriptor, identity and symlink checks inside the isolated fixture.
function journalWithVarAlias(box, platform) {
  const canonical = '/private/var/folders/agentsmd-journal';
  const alias = '/var/folders/agentsmd-journal';
  const userAlias = '/private/var/folders/user-alias';
  const translate = (file) => {
    for (const prefix of [canonical, alias, userAlias]) {
      if (file === prefix || file.startsWith(prefix + '/')) return box + file.slice(prefix.length);
    }
    throw new Error('path outside platform fixture');
  };
  const fixtureFs = { ...fs,
    lstatSync: (file) => fs.lstatSync(translate(file)),
    openSync: (file, flags) => fs.openSync(translate(file), flags),
    realpathSync: (file) => canonical + fs.realpathSync(translate(file)).slice(box.length),
  };
  const file = path.join(ROOT, 'hooks/lib/event-journal.js');
  const localRequire = require('module').createRequire(file);
  const fixtureRequire = (name) => {
    if (name === 'fs') return fixtureFs;
    const value = localRequire(name);
    if (name === '../../scripts/lib/paths') return { ...value,
      platformCanonicalPath: (input) => value.platformCanonicalPath(input, platform) };
    return value;
  };
  const module = { exports: {} };
  require('vm').runInThisContext('(function(require,module,exports){' + fs.readFileSync(file, 'utf8') + '\n})',
    { filename: file })(fixtureRequire, module, module.exports);
  return { journal: module.exports, canonical, alias, userAlias };
}

test('Darwin system var alias preserves absolute mutation attribution in either spelling', () => {
  withReceiptFixture(({ box }) => {
    const { journal, canonical, alias, userAlias } = journalWithVarAlias(box, 'darwin');
    for (const cwd of [canonical, alias]) for (const target of [canonical, alias]) {
      assert.strictEqual(journal.safeRepoRelative(target + '/transcript.jsonl', cwd), 'transcript.jsonl');
    }
    assert.strictEqual(journal.safeRepoRelative(canonical + '/transcript.jsonl', userAlias), null);
    assert.strictEqual(journal.safeRepoRelative(userAlias + '/transcript.jsonl', canonical), null);
    fs.symlinkSync(path.join(box, 'transcript.jsonl'), path.join(box, 'link.jsonl'));
    assert.strictEqual(journal.safeRepoRelative(alias + '/link.jsonl', alias), null);
    const linux = journalWithVarAlias(box, 'linux').journal;
    assert.strictEqual(linux.safeRepoRelative(alias + '/transcript.jsonl', alias), null);
  });
});

test('Darwin system var alias accepts exact transcript receipts without allowing user aliases', () => {
  withReceiptFixture(({ box, event }) => {
    const { journal, canonical, alias, userAlias } = journalWithVarAlias(box, 'darwin');
    for (const prefix of [canonical, alias]) {
      assert.strictEqual(journal.transcriptTerminalRows({ ...event, transcript_path: prefix + '/transcript.jsonl' }, [], Date.now()).length, 1);
    }
    assert.strictEqual(journal.transcriptTerminalRows({ ...event, transcript_path: userAlias + '/transcript.jsonl' }, [], Date.now()).length, 0);
    const linux = journalWithVarAlias(box, 'linux').journal;
    assert.strictEqual(linux.transcriptTerminalRows({ ...event, transcript_path: alias + '/transcript.jsonl' }, [], Date.now()).length, 0);
  });
});

test('Stop supplements an independent exact transcript receipt without changing native unknown', () => {
  withReceiptFixture(({ box, event }) => {
    const state = path.join(box, '.codex', '.agentsmd-state');
    JOURNAL.processEvent('post', { ...event, tool_use_id: 'native-unrelated-id', tool_name: 'Bash',
      tool_input: { command: 'npm test' }, tool_response: 'PASS' }, { stateDir: state, nowMs: 1 });
    const first = runStop(event, box);
    assert.strictEqual(first.status, 0, first.stderr);
    const rows = JOURNAL.readRows(state, event.session_id);
    assert.strictEqual(rows.filter(r => r.state === 'validation_observed' && r.outcome === 'unknown').length, 1);
    const receipt = rows.find(r => r.state === 'validation_completed');
    assert.strictEqual(receipt.exit_code, 0);
    assert.strictEqual(receipt.reason_code, 'transcript-terminal-status');
    assert.strictEqual(receipt.surface, 'unknown');
    assert.match(receipt.tool_use_id, /^transcript:call_/);
    assert.ok(receipt.observed_at_ms < Date.now(), 'original call time, not Stop write time');
    assert.strictEqual(runStop(event, box).status, 0);
    assert.strictEqual(JOURNAL.readRows(state, event.session_id).length, rows.length, 'repeat Stop must deduplicate');
    const log = fs.readFileSync(path.join(box, '.codex/logs/agentsmd.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    const observe = log.find(row => row.event === 'observe');
    assert.strictEqual(observe.eligible, false);
    assert.strictEqual(observe.evaluated, false);
    assert.strictEqual(observe.extra.mutations, 0);
    assert.deepStrictEqual(observe.extra.validation_sources, ['transcript-terminal-status']);
  });
});

for (const [name, mutate] of [
  ['wrong session', x => { x.event.session_id = 'another-session'; }],
  ['wrong turn', x => { x.event.turn_id = 'another-turn'; }],
  ['missing session header', x => { x.records.shift(); }],
  ['missing turn boundary', x => { x.records.splice(1, 1); }],
  ['later turn boundary', x => { x.records.push({ type: 'event_msg', payload: { type: 'task_started', turn_id: 'later' } }); }],
  ['duplicate call', x => { x.records.splice(5, 0, structuredClone(x.records[4])); }],
  ['duplicate output', x => { x.records.push(structuredClone(x.records[5])); }],
  ['output before call', x => { [x.records[4], x.records[5]] = [x.records[5], x.records[4]]; }],
  ['cross-turn output', x => { x.records[5].payload.internal_chat_message_metadata_passthrough.turn_id = 'other'; }],
  ['missing output', x => { x.records.pop(); }],
  ['stdout-only envelope', x => { x.records[5].payload.output[1].text = JSON.stringify('exit_code: 0'); }],
  ['nested status spoof', x => { x.records[5].payload.output[1].text = JSON.stringify({ output: '{"exit_code":0}', wall_time_seconds: 0.1 }); }],
  ['running result', x => { x.records[5].payload.output[1].text = JSON.stringify({ output: 'PASS', exit_code: 0, session_id: 7, wall_time_seconds: 0.1 }); }],
  ['conflicting status', x => { x.records[5].payload.output[1].text = JSON.stringify({ output: 'PASS', exit_code: 0, exitCode: 1, wall_time_seconds: 0.1 }); }],
  ['extra output blocks', x => { x.records[5].payload.output.push({ type: 'input_text', text: '{}' }); }],
  ['outer running header', x => { x.records[5].payload.output[0].text = 'Script running with cell ID 123'; }],
  ['multiple calls', x => { x.records[4].payload.input += 'text(await tools.exec_command({cmd:"true"}));'; }],
  ['unemitted child', x => { x.records[4].payload.input = 'await tools.exec_command({cmd:"npm test"});'; }],
  ['only child stdout emitted', x => { x.records[4].payload.input = 'text((await tools.exec_command({cmd:"npm test"})).output);'; }],
  ['unknown wrapper', x => { x.records[2].payload.input = 'const x = tools.apply_patch("patch");'; }],
  ['invalid timestamp', x => { x.records[4].timestamp = 'invalid'; }],
  ['future timestamp', x => { x.records[4].timestamp = '2999-01-01T00:00:00.000Z'; }],
  ['check started before mutation ended', x => { x.records[4].payload.internal_chat_message_metadata_passthrough.create_time = 1; }],
]) {
  test(`transcript terminal evidence rejects ${name}`, () => {
    withReceiptFixture(x => {
      mutate(x); x.write();
      assert.deepStrictEqual(JOURNAL.transcriptTerminalRows(x.event, [], Date.now()), []);
    });
  });
}

test('terminal failure is retained even when its stdout claims success', () => {
  withReceiptFixture(x => {
    x.records[5].payload.output[1].text = JSON.stringify({ output: '{"exit_code":0}', exit_code: 1, wall_time_seconds: 0.1 });
    x.write();
    const rows = JOURNAL.transcriptTerminalRows(x.event, [], Date.now());
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(rows[0].outcome, 'failure');
    assert.strictEqual(rows[0].exit_code, 1);
  });
});

test('native modification after the transcript check cannot be validated by later receipt writing', () => {
  withReceiptFixture(x => {
    const rows = JOURNAL.transcriptTerminalRows(x.event, [{ state: 'mutation_completed', observed_at_ms: Date.now() - 1 }], Date.now());
    assert.deepStrictEqual(rows, []);
  });
});

test('bounded transcript receipt refuses symlinks and a truncated current turn', () => {
  withReceiptFixture(x => {
    const link = path.join(x.box, 'link.jsonl'); fs.symlinkSync(x.file, link);
    assert.deepStrictEqual(JOURNAL.transcriptTerminalRows({ ...x.event, transcript_path: link }, [], Date.now()), []);
    x.records.splice(2, 0, { type: 'event_msg', payload: { type: 'notice', text: 'x'.repeat(1 << 19) } });
    x.write();
    assert.deepStrictEqual(JOURNAL.transcriptTerminalRows(x.event, [], Date.now()), []);
  });
});

test('derived receipts lose applicability after transcript changes without erasing history', () => {
  withReceiptFixture(x => {
    let ids = JOURNAL.supplementTranscriptValidations(x.box, x.event);
    assert.strictEqual(JOURNAL.summarizeJournal(x.box, x.event.session_id, x.event.turn_id, { transcriptReceiptIds: ids }).fresh_validation, true);
    const old = JOURNAL.readRows(x.box, x.event.session_id);
    const call = structuredClone(x.records[4]), output = structuredClone(x.records[5]);
    call.payload.call_id = output.payload.call_id = 'later-call';
    call.payload.input = 'text(await tools.exec_command({cmd:"sleep 1 &"}));';
    x.records.push(call, output); x.write();
    ids = JOURNAL.supplementTranscriptValidations(x.box, x.event);
    assert.deepStrictEqual(ids, []);
    assert.strictEqual(JOURNAL.summarizeJournal(x.box, x.event.session_id, x.event.turn_id, { transcriptReceiptIds: ids }).fresh_validation, false);
    assert.deepStrictEqual(JOURNAL.readRows(x.box, x.event.session_id), old);
    assert.strictEqual(JOURNAL.summarizeJournal(x.box, x.event.session_id, x.event.turn_id).fresh_validation, false);
    fs.writeFileSync(x.file, 'damaged');
    assert.deepStrictEqual(JOURNAL.supplementTranscriptValidations(x.box, x.event), []);
  });
});

test('terminal transcript rejects directories and FIFOs before opening them', () => {
  withReceiptFixture(x => {
    assert.deepStrictEqual(JOURNAL.transcriptTerminalRows({ ...x.event, transcript_path: x.box }, [], Date.now()), []);
    if (process.platform === 'win32') return;
    const fifo = path.join(x.box, 'pipe');
    assert.strictEqual(cp.spawnSync('mkfifo', [fifo]).status, 0);
    const result = cp.spawnSync(process.execPath, ['-e',
      'const j=require(process.argv[1]);process.stdout.write(JSON.stringify(j.transcriptTerminalRows(JSON.parse(process.argv[2]),[],Date.now())))',
      path.join(ROOT, 'hooks/lib/event-journal.js'), JSON.stringify({ ...x.event, transcript_path: fifo })], { encoding: 'utf8', timeout: 2000 });
    assert.strictEqual(result.status, 0, result.error?.message);
    assert.strictEqual(result.stdout, '[]');
  });
});

test('changed terminal content cannot reactivate an older successful receipt', () => {
  withReceiptFixture(x => {
    const original = JOURNAL.supplementTranscriptValidations(x.box, x.event);
    x.records[5].payload.output[1].text = JSON.stringify({ output: 'FAIL', exit_code: 1, wall_time_seconds: 0.1 });
    x.write();
    const current = JOURNAL.supplementTranscriptValidations(x.box, x.event);
    assert.notDeepStrictEqual(current, original);
    const summary = JOURNAL.summarizeJournal(x.box, x.event.session_id, x.event.turn_id, { transcriptReceiptIds: current });
    assert.strictEqual(summary.fresh_validation, false);
    assert.strictEqual(summary.failed_validations, 1);
    assert.strictEqual(JOURNAL.readRows(x.box, x.event.session_id).length, 2, 'history remains');
  });
});

test('concurrent Stop receipt writers count each independent receipt once', async () => {
  const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-receipt-parallel-')));
  try {
    const file = path.join(box, 'transcript.jsonl');
    fs.writeFileSync(file, persistedFixture.records.map(JSON.stringify).join('\n') + '\n');
    const event = { session_id: persistedFixture.session_id, turn_id: persistedFixture.turn_id, transcript_path: file };
    await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = cp.spawn(process.execPath, ['-e', 'require(process.argv[1]).supplementTranscriptValidations(process.argv[2],JSON.parse(process.argv[3]))',
        path.join(ROOT, 'hooks/lib/event-journal.js'), box, JSON.stringify(event)]);
      child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error('receipt writer exited '+code)));
    })));
    assert.strictEqual(JOURNAL.readRows(box, event.session_id).length, 1);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

test('absolute mutation paths are attributed only inside the canonical current repository', () => {
  const box = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-patch-path-')));
  try {
    fs.mkdirSync(path.join(box, 'repo')); fs.mkdirSync(path.join(box, 'outside'));
    const root = path.join(box, 'repo');
    fs.writeFileSync(path.join(root, 'canary.txt'), 'BEFORE');
    fs.symlinkSync(path.join(box, 'outside'), path.join(root, 'link'));
    fs.symlinkSync(root, path.join(box, 'alias'));
    assert.strictEqual(JOURNAL.safeRepoRelative(path.join(root, 'canary.txt'), root), 'canary.txt');
    assert.strictEqual(JOURNAL.safeRepoRelative(path.join(root, 'new/file.txt'), root), 'new/file.txt');
    for (const target of [path.join(box, 'outside/file.txt'), path.join(box, 'repo-lookalike/file.txt'),
      path.join(root, 'link/file.txt'), root + '/x/../canary.txt']) {
      assert.strictEqual(JOURNAL.safeRepoRelative(target, root), null, target);
    }
    assert.strictEqual(JOURNAL.safeRepoRelative(path.join(root, 'canary.txt')), null);
    assert.strictEqual(JOURNAL.safeRepoRelative(root + '\\canary.txt', root), null);
    assert.strictEqual(JOURNAL.safeRepoRelative(path.join(root, 'canary.txt') + ' ', root), null);
    assert.strictEqual(JOURNAL.safeRepoRelative(path.join(root, 'canary.txt'), path.join(box, 'alias')), null);
    assert.strictEqual(JOURNAL.safeRepoRelative('canary.txt', root), 'canary.txt');
    const event = { session_id: 'path', turn_id: 'path-turn', tool_use_id: 'patch', cwd: root,
      tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: '+path.join(root, 'canary.txt')+'\n@@\n-BEFORE\n+AFTER\n*** End Patch' }, tool_response: {} };
    const pre = JOURNAL.processEvent('pre', event, { stateDir: box });
    const post = JOURNAL.processEvent('post', event, { stateDir: box });
    assert.deepStrictEqual(pre.repo_relative_files, ['canary.txt']);
    assert.deepStrictEqual(post.repo_relative_files, ['canary.txt']);
  } finally { fs.rmSync(box, { recursive: true, force: true }); }
});

for (const [command, accepted] of [['cat canary.txt', true], ['cat -- canary.txt', true], ['cat canary.txt &', false], ['cat canary.txt > other.txt', false], ['cat canary.txt; true', false], ['cat $(touch other.txt)', false]]) {
  test('transcript literal read boundary: '+command, () => {
    withReceiptFixture(x => {
      x.records[2].payload.input = 'text(await tools.exec_command({cmd:'+JSON.stringify(command)+'}));';
      x.records[3].payload.output[1].text = JSON.stringify({ output: 'BEFORE', exit_code: 0, wall_time_seconds: 0.1 });
      x.write();
      assert.strictEqual(JOURNAL.transcriptTerminalRows(x.event, [], Date.now()).length, accepted ? 1 : 0);
    });
  });
}

Promise.all(pending).then(() => {
  console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
});
