'use strict';
// conformance-cases.test.js — structural gate for the R5-04 conformance case
// library (qa/conformance/cases.json). Model runs are on-demand and expensive
// (qa/conformance-eval.sh); this test keeps the COMMITTED library sound with
// zero model calls: schema shape, unique ids, known categories/kinds, an
// assert vocabulary the runner actually implements, rule anchors that resolve
// against hard-rules.json or spec/AGENTS.md section headers, fragment
// discipline (no complete secret-shaped literal in the repo), and pre_clean
// paths bounded to the qa marker prefix.

const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const ROOT = path.join(__dirname, '..', '..');
const CASES_PATH = path.join(ROOT, 'qa', 'conformance', 'cases.json');
const raw = fs.readFileSync(CASES_PATH, 'utf8');
const lib = JSON.parse(raw);
const { extractNativeTools } = require(path.join(ROOT, 'qa', 'capture-native-tools.js'));

const CATEGORIES = new Set([
  'auth', 's8-refusal', 'false-block', 'instruction-retention', 'injection',
  'fresh-evidence', 'task-discipline', 'native-continuity',
]);
const KINDS = new Set(['positive', 'near-negative', 'conflict']);
const MEASUREMENTS = new Set(['runtime-tool', 'runtime-negative', 'policy-decision']);
const ASSERT_TYPES = new Set([
  'file_exists', 'file_absent', 'last_regex', 'last_not_regex',
  'tele_block', 'tele_observe', 'no_tele_blocks',
  'exec_regex_min', 'exec_regex_absent', 'exec_regex_max',
  'native_tool_min', 'native_tool_max',
  'commits_delta', 'commit_subject_regex', 'cmd_green', 'any_of',
]);
const NATIVE_CONTINUITY_IDS = new Set([
  'native-goal-explicit',
  'native-goal-ordinary-negative',
  'native-goal-level-negative',
  'native-goal-active-resume',
  'native-goal-active-unrelated',
  'native-goal-complete-evidence',
  'native-turn-steer',
  'native-thread-fork',
]);

// Valid rule anchors: hard-rules ids ∪ rule_hits_sections ∪ spec §-headers.
const hardRules = JSON.parse(fs.readFileSync(path.join(ROOT, 'spec', 'hard-rules.json'), 'utf8'));
const anchors = new Set();
for (const r of hardRules.rules) {
  if (r.id) anchors.add(r.id);
  if (r.rule_hits_section) anchors.add(r.rule_hits_section);
}
const spec = fs.readFileSync(path.join(ROOT, 'spec', 'AGENTS.md'), 'utf8');
for (const m of spec.matchAll(/^## (§[\w.]+)/gmu)) anchors.add(m[1]);

const flatAsserts = (asserts) => asserts.flatMap((a) =>
  a.type === 'any_of' ? (a.groups || []).flat().concat([{ type: 'any_of', groups: a.groups }]) : [a]);

t('schema_version 1, non-empty cases[], _doc present', () => {
  assert.strictEqual(lib.schema_version, 1);
  assert.ok(Array.isArray(lib.cases) && lib.cases.length > 0);
  assert.ok(typeof lib._doc === 'string' && lib._doc.length > 50);
});

t('case ids unique; required fields present and typed', () => {
  const ids = lib.cases.map((c) => c.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'duplicate ids');
  for (const c of lib.cases) {
    assert.ok(/^[a-z0-9-]+$/.test(c.id), c.id + ': id must be kebab-case');
    assert.ok(typeof c.prompt === 'string' && c.prompt.length > 10, c.id + ': prompt');
    assert.ok(Array.isArray(c.assert) && c.assert.length > 0, c.id + ': assert[]');
  }
});

t('categories and kinds come from the closed sets the runner reports on', () => {
  for (const c of lib.cases) {
    assert.ok(CATEGORIES.has(c.category), c.id + ': category ' + c.category);
    assert.ok(KINDS.has(c.kind), c.id + ': kind ' + c.kind);
    if (c.category === 'native-continuity') {
      assert.ok(MEASUREMENTS.has(c.measurement), c.id + ': measurement ' + c.measurement);
    } else {
      assert.strictEqual(c.measurement, undefined, c.id + ': measurement is native-continuity-only');
    }
  }
});

t('every R5-04 acceptance dimension has at least one case', () => {
  const seen = new Set(lib.cases.map((c) => c.category));
  for (const cat of CATEGORIES) assert.ok(seen.has(cat), 'no case for category ' + cat);
});

t('native-continuity library contains the pre-registered eight cases exactly once', () => {
  const actual = lib.cases.filter((c) => c.category === 'native-continuity').map((c) => c.id);
  assert.deepStrictEqual(new Set(actual), NATIVE_CONTINUITY_IDS);
  assert.strictEqual(actual.length, NATIVE_CONTINUITY_IDS.size);
});

t('native-continuity cases remain one bounded exec turn', () => {
  for (const c of lib.cases.filter((item) => item.category === 'native-continuity')) {
    assert.strictEqual(c.setup_prompt, undefined, c.id + ': cross-turn setup is not a bounded exec probe');
  }
});

t('native tool capture normalizes legacy and functions.exec transcript envelopes', () => {
  const events = [
    { type: 'response_item', payload: { type: 'function_call', name: 'create_goal', arguments: '{"objective":"Legacy goal"}', call_id: 'legacy' } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'legacy', output: '{"status":"active"}' } },
    { type: 'response_item', payload: {
      type: 'custom_tool_call', name: 'exec', call_id: 'wrapped-create',
      input: 'const fake = "tools.update_goal({status: \\"complete\\"})";\n// tools.get_goal({})\nconst result = await tools.create_goal({objective:"Wrapped goal"});\ntext(result);',
    } },
    { type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'wrapped-create',
      output: [{ type: 'input_text', text: 'Script completed' }, { type: 'input_text', text: '{"status":"active"}' }],
    } },
    { type: 'response_item', payload: {
      type: 'custom_tool_call', name: 'exec', call_id: 'wrapped-get',
      input: '/* tools.create_goal({objective:"Fake goal"}) */\nconst result = await tools.get_goal({});\ntext(result);',
    } },
    { type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'wrapped-get', output: [{ type: 'input_text', text: '{"goal":{"status":"active"}}' }],
    } },
  ];
  const captured = extractNativeTools(events.map((event) => JSON.stringify(event)).join('\n'));
  assert.deepStrictEqual(captured.map((item) => item.name), ['create_goal', 'create_goal', 'get_goal']);
  assert.strictEqual(captured[1].arguments, '{"objective":"Wrapped goal"}');
  assert.ok(captured[1].paired && captured[1].output.includes('"status":"active"'));
  assert.strictEqual(captured[2].arguments, '{}');
  assert.ok(!captured.some((item) => item.name === 'update_goal'), 'string/comment text became a false native call');
});

t('assert vocabulary matches what conformance-eval.sh implements', () => {
  for (const c of lib.cases) {
    for (const a of flatAsserts(c.assert)) {
      assert.ok(ASSERT_TYPES.has(a.type), c.id + ': unknown assert type ' + a.type);
      if (a.type === 'any_of') {
        assert.ok(Array.isArray(a.groups) && a.groups.length >= 2, c.id + ': any_of needs >=2 groups');
        for (const g of a.groups) assert.ok(Array.isArray(g) && g.length > 0, c.id + ': empty any_of group');
      }
      if (['last_regex', 'last_not_regex', 'exec_regex_min', 'exec_regex_absent', 'exec_regex_max', 'commit_subject_regex'].includes(a.type)) {
        assert.ok(typeof a.regex === 'string' && a.regex.length > 0, c.id + ': ' + a.type + ' regex');
        new RegExp(a.regex); // must compile
      }
      if (['tele_block', 'tele_observe'].includes(a.type)) {
        assert.ok(typeof a.section === 'string' && a.section.startsWith('§'), c.id + ': ' + a.type + ' section');
      }
      if (a.type === 'exec_regex_min') assert.ok(Number.isInteger(a.min) && a.min >= 1, c.id + ': exec_regex_min min');
      if (a.type === 'exec_regex_max') assert.ok(Number.isInteger(a.max) && a.max >= 0, c.id + ': exec_regex_max max');
      if (a.type === 'native_tool_min') assert.ok(Number.isInteger(a.min) && a.min >= 1, c.id + ': native_tool_min min');
      if (a.type === 'native_tool_max') assert.ok(Number.isInteger(a.max) && a.max >= 0, c.id + ': native_tool_max max');
      if (['native_tool_min', 'native_tool_max'].includes(a.type)) {
        assert.ok(/^[a-z][a-z0-9_]*$/.test(a.name || ''), c.id + ': ' + a.type + ' name');
        for (const key of ['arguments_regex', 'output_regex']) {
          if (a[key] !== undefined) {
            assert.ok(typeof a[key] === 'string' && a[key].length > 0, c.id + ': ' + a.type + ' ' + key);
            new RegExp(a[key]);
          }
        }
      }
      if (a.type === 'commits_delta') assert.ok(Number.isInteger(a.delta), c.id + ': commits_delta delta');
      if (a.type === 'cmd_green') assert.ok(typeof a.cmd === 'string' && a.cmd.length > 0, c.id + ': cmd_green cmd');
      if (['file_exists', 'file_absent'].includes(a.type)) assert.ok(typeof a.path === 'string' && a.path.length > 0, c.id + ': ' + a.type + ' path');
    }
  }
});

t('rule anchors resolve against hard-rules.json or spec/AGENTS.md headers', () => {
  for (const c of lib.cases) {
    assert.ok(anchors.has(c.rule), c.id + ': unresolvable rule anchor ' + c.rule);
  }
});

t('telemetry assertion sections are live (a registered hook actually emits them)', () => {
  const live = new Set(hardRules.live_sections);
  for (const c of lib.cases) {
    for (const a of flatAsserts(c.assert)) {
      if (['tele_block', 'tele_observe'].includes(a.type)) {
        assert.ok(live.has(a.section), c.id + ': ' + a.section + ' not in live_sections');
      }
    }
  }
});

t('fragment discipline: no complete AWS-key-shaped literal in the library file', () => {
  assert.strictEqual(raw.match(/AKIA[0-9A-Z]{16}/), null, 'complete secret-shaped literal committed');
});

t('every {{SECRET:name}} placeholder resolves to a declared fragment list', () => {
  for (const m of raw.matchAll(/\{\{SECRET:([\w-]+)\}\}/g)) {
    const frag = (lib.fragments || {})[m[1]];
    assert.ok(Array.isArray(frag) && frag.length >= 2, 'fragment ' + m[1] + ' must exist and be split');
  }
});

t('pre_clean paths bounded to /tmp/agentsmd-qa-* (runner refuses anything else)', () => {
  for (const c of lib.cases) {
    for (const p of c.pre_clean || []) {
      assert.ok(p.startsWith('/tmp/agentsmd-qa-'), c.id + ': pre_clean out of bounds: ' + p);
    }
  }
});

t('setup_files paths are project-relative (no absolute, no traversal)', () => {
  for (const c of lib.cases) {
    for (const f of c.setup_files || []) {
      assert.ok(!f.path.startsWith('/') && !f.path.includes('..'), c.id + ': bad setup path ' + f.path);
      assert.ok(typeof f.content === 'string', c.id + ': setup content ' + f.path);
    }
  }
});

t('runner exists and points at this library', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'qa', 'conformance-eval.sh'), 'utf8');
  assert.ok(runner.includes('qa/conformance/cases.json'), 'runner default --cases path drifted');
  assert.ok(runner.includes('qa/capture-native-tools.js'), 'runner does not normalize native transcript envelopes');
  assert.ok(runner.includes('"$CODEX_BIN" -a never exec'),
    'runner must pin non-interactive approval instead of inheriting mutable user config');
  assert.ok(runner.includes('--sandbox workspace-write --add-dir "$PROJ/.git"'),
    'runner must grant writes only to the throwaway workspace and its git metadata');
  assert.ok(!runner.includes('--sandbox danger-full-access'),
    'runner must not grant full host access to model-generated commands');
  assert.ok(!runner.includes('--add-dir /tmp'),
    'runner must not make the whole shared temp root writable');
  assert.ok(runner.includes('--ignore-rules --json'),
    'runner must isolate spec/hook conformance from operator-local execpolicy rules');
  assert.ok(runner.includes('--reviewed-hooks) REVIEWED_HOOKS=1'),
    'runner must require an explicit reviewed-hooks opt-in');
  assert.ok(runner.includes('HOOK_TRUST_ARGS=(--dangerously-bypass-hook-trust)'),
    'reviewed automation must run installed hooks without persisted trust');
  assert.ok(runner.includes('session_hooks_observed'),
    'runner must fail closed when a completed child session emits no hook telemetry');
  assert.ok(runner.includes('native hook activation missing for child session'),
    'runner must attribute missing child hooks as infrastructure, not model behavior');
  assert.ok(!runner.includes('--ignore-user-config'),
    'runner still needs the configured provider/auth and installed agentsmd surface');
  for (const key of ['surface', 'profile', 'cases_sha256', 'thresholds_sha256', 'hook_trust']) {
    assert.ok(runner.includes(`${key}:$${key}`), `results metadata missing ${key}`);
  }
  for (const type of ASSERT_TYPES) {
    assert.ok(runner.includes(type), 'runner does not implement assert type ' + type);
  }
});

t('reviewed hook trust reaches Codex; missing child activation fails as infrastructure', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-conformance-contract-'));
  try {
    const home = path.join(sandbox, 'home');
    const logDir = path.join(home, 'logs');
    const stateDir = path.join(home, '.agentsmd-state');
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'agentsmd.jsonl'), '');
    fs.writeFileSync(path.join(stateDir, 'manifest.json'), JSON.stringify({
      name: 'agentsmd',
      version: '5.3.0',
      deliverySurface: 'standalone',
      profile: { materialized: 'full' },
    }));

    const casesPath = path.join(sandbox, 'cases.json');
    fs.writeFileSync(casesPath, JSON.stringify({
      schema_version: 1,
      cases: [{
        id: 'hook-activation',
        category: 'false-block',
        rule: '§8-rm-rf-var',
        kind: 'near-negative',
        prompt: 'Return the deterministic fake-runtime response for this test.',
        assert: [{ type: 'last_regex', regex: '^PASS$' }],
      }],
    }));

    const fakeCodex = path.join(sandbox, 'codex');
    fs.writeFileSync(fakeCodex, `#!/usr/bin/env bash
set -uo pipefail
if [ "\${1:-}" = "--version" ]; then
  echo 'codex-cli 0.147.0'
  exit 0
fi
for arg in "$@"; do
  if [ "$arg" = "--help" ]; then
    echo '      --dangerously-bypass-hook-trust'
    exit 0
  fi
done
reviewed=0
last=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dangerously-bypass-hook-trust) reviewed=1; shift ;;
    -o) last="$2"; shift 2 ;;
    *) shift ;;
  esac
done
sid='11111111-1111-1111-1111-111111111111'
printf 'PASS\\n' > "$last"
if [ "$reviewed" -eq 1 ]; then
  printf '%s\\n' '{"hook":"session-start","event":"context","session_id":"11111111-1111-1111-1111-111111111111","tag":"qa"}' >> "$CODEX_HOME/logs/agentsmd.jsonl"
fi
printf '%s\\n' '{"type":"thread.started","thread_id":"11111111-1111-1111-1111-111111111111"}'
printf '%s\\n' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
`);
    fs.chmodSync(fakeCodex, 0o700);

    const runner = path.join(ROOT, 'qa', 'conformance-eval.sh');
    const run = (outDir, extra = []) => cp.spawnSync('bash', [
      runner,
      '--codex', fakeCodex,
      '--cases', casesPath,
      '--only', 'hook-activation',
      '--out', outDir,
      ...extra,
    ], {
      cwd: ROOT,
      env: { ...process.env, CODEX_HOME: home },
      encoding: 'utf8',
      timeout: 30000,
    });

    const reviewedOut = path.join(sandbox, 'reviewed-out');
    const reviewed = run(reviewedOut, ['--reviewed-hooks']);
    assert.strictEqual(reviewed.status, 0, reviewed.stdout + reviewed.stderr);
    assert.match(reviewed.stdout, /hook-trust: automation-bypass/);
    const reviewedCapture = path.join(reviewedOut, fs.readdirSync(reviewedOut)[0]);
    const reviewedResult = JSON.parse(fs.readFileSync(path.join(reviewedCapture, 'results.json'), 'utf8'));
    assert.strictEqual(reviewedResult.meta.hook_trust, 'automation-bypass');
    assert.strictEqual(reviewedResult.cases[0].verdict, 'pass');

    const persistedOut = path.join(sandbox, 'persisted-out');
    const persisted = run(persistedOut);
    assert.strictEqual(persisted.status, 1, persisted.stdout + persisted.stderr);
    assert.match(persisted.stdout, /native hook activation missing for child session/);
    const persistedCapture = path.join(persistedOut, fs.readdirSync(persistedOut)[0]);
    const persistedResult = JSON.parse(fs.readFileSync(path.join(persistedCapture, 'results.json'), 'utf8'));
    assert.strictEqual(persistedResult.meta.hook_trust, 'persisted');
    assert.strictEqual(persistedResult.cases[0].verdict, 'error');
  } finally {
    assert.ok(path.basename(sandbox).startsWith('agentsmd-conformance-contract-'));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

t('runner signal traps exit before the destructive sandbox cleanup', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'qa', 'conformance-eval.sh'), 'utf8');
  assert.ok(runner.includes('trap cleanup EXIT'), 'runner lacks EXIT cleanup');
  assert.ok(runner.includes("trap 'exit 130' INT"), 'INT trap does not terminate the runner');
  assert.ok(runner.includes("trap 'exit 143' TERM"), 'TERM trap does not terminate the runner');
  assert.ok(!runner.includes('trap cleanup EXIT INT TERM'),
    'signal trap still deletes the sandbox and then continues executing');
  assert.ok(!runner.includes('exec resume'),
    'runner must not enter persistent-goal automatic continuation inside a bounded case');
});

t('native goal cleanup is exact-thread, verified, and runner-mandatory', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'qa', 'conformance-eval.sh'), 'utf8');
  const cleaner = fs.readFileSync(path.join(ROOT, 'qa', 'clear-thread-goal.js'), 'utf8');
  assert.ok(runner.includes('qa/clear-thread-goal.js'), 'runner does not invoke native goal cleanup');
  assert.ok(runner.includes('native-goal-cleanup.ok'), 'runner does not require cleanup evidence');
  assert.ok(cleaner.includes("request('thread/goal/get', { threadId })"), 'cleanup lacks exact-thread get');
  assert.ok(cleaner.includes("request('thread/goal/clear', { threadId })"), 'cleanup lacks exact-thread clear');
  assert.ok(cleaner.includes('after.goal !== null'), 'cleanup does not verify cleared state');
  assert.ok(cleaner.includes('before.goal.threadId !== threadId'), 'cleanup does not reject a mismatched goal');
});

t('thresholds.json: categories resolve, min_pass within case counts, known_fail ids exist', () => {
  const tPath = path.join(ROOT, 'qa', 'conformance', 'thresholds.json');
  const th = JSON.parse(fs.readFileSync(tPath, 'utf8'));
  const counts = {};
  for (const c of lib.cases) counts[c.category] = (counts[c.category] || 0) + 1;
  for (const [k, v] of Object.entries(th)) {
    if (k === '_doc' || k === 'baseline') continue;
    assert.ok(CATEGORIES.has(k), 'threshold key is not a category: ' + k);
    assert.ok(Number.isInteger(v.min_pass) && v.min_pass >= 0, k + ': min_pass');
    assert.ok(v.min_pass <= counts[k], k + `: min_pass ${v.min_pass} > ${counts[k]} cases`);
  }
  const ids = new Set(lib.cases.map((c) => c.id));
  for (const kf of (th.baseline || {}).known_fail || []) {
    assert.ok(ids.has(kf), 'known_fail references missing case: ' + kf);
  }
});

console.log(`conformance-cases: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
