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

let PASS = 0, FAIL = 0, SKIP = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };
const bashMapfileProbe = cp.spawnSync('bash', ['-c', 'type mapfile >/dev/null 2>&1'], { stdio: 'ignore' });
const bashHasMapfile = process.env.AGENTSMD_TEST_BASH_MAPFILE === '0'
  ? false
  : !bashMapfileProbe.error && bashMapfileProbe.status === 0;
const tBashMapfile = (n, f) => {
  if (bashHasMapfile) return t(n, f);
  SKIP++;
  console.log('  skip ' + n + '\n     active bash lacks the mapfile builtin required by the GNU/Linux conformance runner');
};

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
  'commits_delta', 'commit_subject_regex', 'cmd_green', 'any_of', 'task_orphan_import',
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
  assert.deepStrictEqual(captured.map((item) => item.output_attribution), ['direct', 'wrapper-exact', 'wrapper-exact']);
  assert.strictEqual(captured[1].arguments, '{"objective":"Wrapped goal"}');
  assert.ok(captured[1].paired && captured[1].output.includes('"status":"active"'));
  assert.strictEqual(captured[2].arguments, '{}');
  assert.ok(!captured.some((item) => item.name === 'update_goal'), 'string/comment text became a false native call');

  const sharedWrapper = [
    { type: 'response_item', payload: {
      type: 'custom_tool_call', name: 'exec', call_id: 'wrapped-shared',
      input: 'await tools.create_goal({objective:"Shared goal"});\nawait tools.get_goal({});',
    } },
    { type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: 'wrapped-shared', output: 'Script completed\nOutput:\n',
    } },
  ];
  const ambiguous = extractNativeTools(sharedWrapper.map((event) => JSON.stringify(event)).join('\n'));
  assert.deepStrictEqual(ambiguous.map((item) => item.name), ['create_goal', 'get_goal']);
  assert.deepStrictEqual(ambiguous.map((item) => item.output_attribution), ['wrapper-shared', 'wrapper-shared']);
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

t('unsupported wrapper execution is unmeasurable rather than a guessed or zero tool count', () => {
  const capture = (input) => extractNativeTools([
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'fixture', input } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'fixture', output: 'Script completed' } },
  ].map(JSON.stringify).join('\n'));
  for (const input of [
    'if (false) { await tools.update_goal({status:"complete"}); }',
    'await tools["create_goal"]({objective:"fixture"});',
    'for(let i=0;i<2;i++){await tools.create_goal({objective:"fixture"});}',
    'const t = tools; await t.create_goal({objective:"fixture"});',
    'const f = () => tools.create_goal({objective:"fixture"});',
    'await tools.create_goal({objective: makeObjective()});',
    'text(`goal: ${await tools.create_goal({objective:"fixture"})}`);',
    'const tools = {}; await tools.get_goal({});',
    'const if = {}; await tools.get_goal({});',
    'await tools.get_goal({value: 1e999});',
    'text("fake goal result");',
  ]) assert.throws(() => capture(input), /unmeasurable|unsupported/u, input);
  assert.strictEqual(capture('text(await tools.get_goal({}));')[0].name, 'get_goal');
  assert.deepStrictEqual(capture('// No tool required.\n'), []);
  assert.throws(() => capture(null), /unmeasurable/u);
  const duplicate = [
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'duplicate', output: 'first' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'duplicate', output: 'second' } },
  ];
  assert.throws(() => extractNativeTools(duplicate.map(JSON.stringify).join('\n')), /unmeasurable/u);
});

t('task orphan import assertion ignores prose but rejects stale imports and removed legacy bindings', () => {
  const { gradeTaskOrphan } = require(path.join(ROOT, 'qa/grade-task-orphan.js'));
  const render = '\nexports.render = (value) => String(value).trim();';
  for (const source of [
    "const { legacyMarker } = require('./helpers.js');" + render,
    '// Replaces the normalize call.\nconst {\nlegacyMarker\n} = require("./helpers.js");' + render,
    "const { legacyMarker } = require('./helpers.js');\nconst note = 'normalize';" + render,
    "const note = 'normalize';\nconst { legacyMarker } = require('./helpers.js');" + render,
  ]) assert.strictEqual(gradeTaskOrphan(source), true, source);
  for (const source of [
    "const { normalize, legacyMarker } = require('./helpers.js');" + render,
    "const { normalize: unused, legacyMarker } = require('./helpers.js');" + render,
    'const { "normalize": unused, legacyMarker } = require("./helpers.js");' + render,
    '// legacyMarker\n' + render,
    "const legacyMarker = 'not an import';" + render,
    "if (false) { const { legacyMarker } = require('./helpers.js'); }" + render,
    "const { legacyMarker } = require('./helpers.js').constructor;" + render,
    "if (false) var { legacyMarker } = require('./helpers.js');" + render,
  ]) assert.strictEqual(gradeTaskOrphan(source), false, source);
});

t('native wrapper comments terminate at every JavaScript line terminator', () => {
  const { literalToolCalls } = require(path.join(ROOT, 'qa/native-wrapper-grammar.js'));
  for (const newline of ['\n', '\r', '\u2028', '\u2029']) {
    assert.strictEqual(literalToolCalls(`// fixture${newline}await tools.get_goal({});`).length, 1);
  }
});

t('capture protocol covers ordinary tools as well as goal tools without relaxing assertions', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'qa', 'conformance-eval.sh'), 'utf8');
  const protocol = runner.match(/^NATIVE_TOOL_CAPTURE_PROTOCOL='([^']+)'$/m)[1];
  assert.match(protocol, /every nested tool call/);
  assert.match(protocol, /exec_command/);
  assert.match(protocol, /one.*functions\.exec/);
  assert.match(protocol, /tool-count and final-answer constraint unchanged/);
  const shared = extractNativeTools([
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'ordinary-shared',
      input: 'await tools.exec_command({cmd:"pwd"}); await tools.exec_command({cmd:"true"});' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'ordinary-shared', output: 'combined output' } },
  ].map(JSON.stringify).join('\n'));
  assert.deepStrictEqual(shared.map((item) => item.output_attribution), ['wrapper-shared', 'wrapper-shared']);
});

t('standalone context pins a manifest-owned matching spec and rejects unsafe or stale inputs', () => {
  const { standaloneContext } = require(path.join(ROOT, 'qa', 'conformance-context.js'));
  const crypto = require('crypto');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-context-'));
  try {
    const home = path.join(sandbox, 'isolated home');
    fs.mkdirSync(path.join(home, '.agentsmd-state'), { recursive: true });
    const extended = path.join(home, 'AGENTS-extended.md');
    const manifestFile = path.join(home, '.agentsmd-state', 'manifest.json');
    const bytes = '# CODEX-CODING-SPEC v5.4.3 — Extended\n';
    const manifest = { version: '5.4.3', deliverySurface: 'standalone', ownedArtifacts: {
      extended: { path: extended, sha256: crypto.createHash('sha256').update(bytes).digest('hex') },
    } };
    const writeManifest = () => fs.writeFileSync(manifestFile, JSON.stringify(manifest));
    fs.writeFileSync(extended, bytes);
    writeManifest();
    assert.match(standaloneContext(home), new RegExp(JSON.stringify(fs.realpathSync(extended)).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.match(standaloneContext(home), /only when.*requires/i);
    assert.match(standaloneContext(home), /Do not.*~\/\.codex/);
    fs.appendFileSync(extended, 'drift\n');
    assert.throws(() => standaloneContext(home), /hash/);
    fs.writeFileSync(extended, bytes);
    manifest.version = '5.4.2'; writeManifest();
    assert.throws(() => standaloneContext(home), /version/);
    manifest.version = '5.4.3';
    manifest.ownedArtifacts.extended.path = path.join(sandbox, 'other.md'); writeManifest();
    assert.throws(() => standaloneContext(home), /path/);
    manifest.ownedArtifacts.extended.path = extended; writeManifest();
    fs.unlinkSync(extended);
    assert.throws(() => standaloneContext(home), /ENOENT|missing/);
    const other = path.join(sandbox, 'other.md'); fs.writeFileSync(other, bytes);
    fs.symlinkSync(other, extended);
    assert.throws(() => standaloneContext(home), /symlink|regular/);
    fs.unlinkSync(extended); fs.writeFileSync(extended, bytes);
    manifest.deliverySurface = 'plugin'; writeManifest();
    assert.throws(() => standaloneContext(home), /standalone/);
    assert.strictEqual(fs.readFileSync(other, 'utf8'), bytes);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

t('formal measurement receipts verify the actual owned deployment and remain stable only across identical source identities', () => {
  const { installedReceipt, stableSource, sourceReceipt } = require('../lib/release-measurement');
  const F = require('../lib/fs-atomic');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-measurement-'));
  try {
    const deploy = path.join(sandbox, 'agentsmd');
    fs.mkdirSync(deploy); fs.writeFileSync(path.join(deploy, 'fixture'), 'original');
    fs.mkdirSync(path.join(sandbox, '.agentsmd-state'));
    const manifest = { version: '5.4.3', deliverySurface: 'standalone', profile: { materialized: 'full' },
      ownedArtifacts: { deploy: { path: deploy, sha256: F.sha256Tree(deploy) } } };
    const file = path.join(sandbox, '.agentsmd-state/manifest.json');
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.strictEqual(installedReceipt(sandbox).deploy_sha256, manifest.ownedArtifacts.deploy.sha256);
    fs.writeFileSync(path.join(deploy, 'fixture'), 'changed');
    assert.throws(() => installedReceipt(sandbox), /hash mismatch/u);
    manifest.ownedArtifacts.deploy.path = path.join(sandbox, 'neighbor');
    fs.writeFileSync(file, JSON.stringify(manifest));
    assert.throws(() => installedReceipt(sandbox), /manifest-owned/u);
    const measured = { state: 'measured', source_tree: 'a'.repeat(40) };
    assert.deepStrictEqual(stableSource(measured, { ...measured }), measured);
    assert.strictEqual(stableSource(measured, { ...measured, source_tree: 'b'.repeat(40) }).state, 'unverified');
    assert.strictEqual(sourceReceipt(sandbox).state, 'unverified', 'non-repo cannot claim measured source');
    const runner = fs.readFileSync(path.join(ROOT, 'qa/conformance-eval.sh'), 'utf8');
    assert.match(runner, /--declaration\)/);
    assert.strictEqual((runner.match(/qa\/conformance-receipt\.js/g) || []).length, 2, 'before and after receipts required');
    assert.strictEqual((runner.match(/session_sha256:\$session_sha256/g) || []).length, 4, 'every result path retains session digest');
    assert.match(runner, /THRESH_FAIL="\$MEASUREMENT_FAILED"/);
  } finally { fs.rmSync(sandbox, { recursive: true, force: false }); }
});

t('infrastructure diagnostics distinguish unfinished turns, capture attribution, and goal cleanup', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'qa', 'conformance-eval.sh'), 'utf8');
  const match = runner.match(/session_infrastructure_error\(\) \{\n[\s\S]*?\n\}/);
  assert.ok(match, 'runner lacks evidence-specific infrastructure diagnostics');
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-conf-infra-'));
  try {
    const events = path.join(sandbox, 'fixture.jsonl');
    fs.writeFileSync(events, '');
    const inspect = () => cp.spawnSync('bash', ['-c', `${match[0]}\ncase_field() { echo native-continuity; }\nsession_infrastructure_error`], {
      env: { ...process.env, SBX: sandbox, CID: 'fixture' }, encoding: 'utf8',
    }).stdout.trim();
    assert.match(inspect(), /turn never completed/);
    fs.writeFileSync(events, '{"type":"turn.completed"}\n');
    assert.match(inspect(), /native transcript capture.*attribution/);
    fs.writeFileSync(path.join(sandbox, 'fixture.native-transcript.ok'), '');
    assert.match(inspect(), /goal cleanup/);
    fs.writeFileSync(path.join(sandbox, 'fixture.native-goal-cleanup.ok'), '');
    assert.strictEqual(inspect(), '');
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
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
  assert.ok(runner.includes('NATIVE_TOOL_CAPTURE_PROTOCOL='),
    'runner must tell native-continuity probes how to preserve per-tool output attribution');
  assert.ok(runner.includes('wrapper-shared'),
    'runner must reject a shared functions.exec output as unmeasurable instead of grading it');
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
    'reviewed automation must run installed hooks without persisted hook trust');
  assert.ok(runner.includes('qa/cleanup-project-trust.js'),
    'runner must remove only its exact task-owned project trust tables');
  assert.ok(runner.includes('session_hooks_observed'),
    'runner must fail closed when a completed child session emits no hook telemetry');
  assert.ok(runner.includes('native hook activation missing for child session'),
    'runner must attribute missing child hooks as infrastructure, not model behavior');
  assert.ok(!runner.includes('--ignore-user-config'),
    'runner still needs the configured subscription provider and installed agentsmd surface');
  for (const key of [
    'surface', 'profile', 'source_commit', 'source_tracked_clean',
    'cases_sha256', 'thresholds_sha256', 'hook_trust',
  ]) {
    assert.ok(runner.includes(`${key}:$${key}`), `results metadata missing ${key}`);
  }
  for (const type of ASSERT_TYPES) {
    assert.ok(runner.includes(type), 'runner does not implement assert type ' + type);
  }
});

t('blackbox requires explicit reviewed hook trust for every Codex exec path', () => {
  const runner = fs.readFileSync(path.join(ROOT, 'qa', 'codex-blackbox.sh'), 'utf8');
  assert.ok(
    runner.includes('--reviewed-hooks) REVIEWED_HOOKS=1'),
    'blackbox must require an explicit reviewed-hooks opt-in',
  );
  assert.ok(
    runner.includes('HOOK_TRUST_ARGS=(--dangerously-bypass-hook-trust)'),
    'reviewed blackbox automation must bypass persisted hook trust explicitly',
  );
  const trustSpreads = runner.split('\n')
    .filter((line) => line.includes('${HOOK_TRUST_ARGS[@]+"${HOOK_TRUST_ARGS[@]}"}'));
  assert.strictEqual(trustSpreads.length, 2,
    'both fresh-session and resume exec paths must receive reviewed hook trust');
  const runtimeSummary = runner.indexOf('.agentsmd-state/runtime/session-summary-$sid.json');
  const legacySummary = runner.indexOf('.agentsmd-state/session-summary-$sid.json');
  assert.ok(runtimeSummary >= 0 && legacySummary > runtimeSummary,
    'blackbox must prefer standalone-private summaries and retain the legacy fallback');
});

tBashMapfile('reviewed hook trust reaches Codex; missing child activation fails as infrastructure', () => {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-conformance-contract-'));
  try {
    const home = path.join(sandbox, 'home');
    const logDir = path.join(home, 'logs');
    const stateDir = path.join(home, '.agentsmd-state');
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'agentsmd.jsonl'), '');
    const configPath = path.join(home, 'config.toml');
    const initialConfig = 'model = "fixture"\n';
    fs.writeFileSync(configPath, initialConfig);
    const extendedPath = path.join(home, 'AGENTS-extended.md');
    const extendedBytes = '# CODEX-CODING-SPEC v5.3.0 — Extended\n';
    fs.writeFileSync(extendedPath, extendedBytes);
    fs.writeFileSync(path.join(stateDir, 'manifest.json'), JSON.stringify({
      name: 'agentsmd',
      version: '5.3.0',
      deliverySurface: 'standalone',
      profile: { materialized: 'full' },
      ownedArtifacts: { extended: { path: extendedPath,
        sha256: require('crypto').createHash('sha256').update(extendedBytes).digest('hex') } },
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
printf '%s\\n' "$arg" > "$CODEX_HOME/probe-prompt.txt"
reviewed=0
project=''
last=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --dangerously-bypass-hook-trust) reviewed=1; shift ;;
    -C) project="$2"; shift 2 ;;
    -o) last="$2"; shift 2 ;;
    *) shift ;;
  esac
done
sid='11111111-1111-1111-1111-111111111111'
printf 'PASS\\n' > "$last"
printf '\\n[projects."%s"]\\ntrust_level = "trusted"\\n' "$project" >> "$CODEX_HOME/config.toml"
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
    assert.ok(fs.readFileSync(path.join(home, 'probe-prompt.txt'), 'utf8').includes(JSON.stringify(extendedPath)),
      'actual probe prompt must pin the isolated standalone extended path');
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), initialConfig);

    const persistedOut = path.join(sandbox, 'persisted-out');
    const persisted = run(persistedOut);
    assert.strictEqual(persisted.status, 1, persisted.stdout + persisted.stderr);
    assert.match(persisted.stdout, /native hook activation missing for child session/);
    const persistedCapture = path.join(persistedOut, fs.readdirSync(persistedOut)[0]);
    const persistedResult = JSON.parse(fs.readFileSync(path.join(persistedCapture, 'results.json'), 'utf8'));
    assert.strictEqual(persistedResult.meta.hook_trust, 'persisted');
    assert.strictEqual(persistedResult.cases[0].verdict, 'error');

    // Fail before a model invocation or sandbox creation when the selected
    // standalone spec has drifted; do not fall back to another installation.
    fs.unlinkSync(path.join(home, 'probe-prompt.txt'));
    fs.appendFileSync(extendedPath, 'drift\n');
    const staleOut = path.join(sandbox, 'stale-out');
    const stale = run(staleOut, ['--reviewed-hooks']);
    assert.strictEqual(stale.status, 1, stale.stdout + stale.stderr);
    assert.match(stale.stderr, /extended spec hash/);
    assert.strictEqual(fs.existsSync(path.join(home, 'probe-prompt.txt')), false);
    assert.strictEqual(fs.existsSync(staleOut), false);
    assert.strictEqual(fs.readFileSync(configPath, 'utf8'), initialConfig);

    // A plugin surface continues to receive its SessionStart bundle routing;
    // the standalone helper must not require or invent a plugin file path.
    const manifestPath = path.join(stateDir, 'manifest.json');
    const pluginManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    pluginManifest.deliverySurface = 'plugin';
    fs.writeFileSync(manifestPath, JSON.stringify(pluginManifest));
    const plugin = run(path.join(sandbox, 'plugin-out'), ['--reviewed-hooks']);
    assert.strictEqual(plugin.status, 0, plugin.stdout + plugin.stderr);
    assert.ok(!fs.readFileSync(path.join(home, 'probe-prompt.txt'), 'utf8').includes(extendedPath));
  } finally {
    assert.ok(path.basename(sandbox).startsWith('agentsmd-conformance-contract-'));
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
});

t('project trust cleanup removes exact task tables and preserves every neighbor', () => {
  const helperPath = path.join(ROOT, 'qa', 'cleanup-project-trust.js');
  assert.ok(fs.existsSync(helperPath), 'project trust cleanup helper missing');
  const { parseArgs, removeProjectTrustTables, sameCanonicalPath } = require(helperPath);
  assert.strictEqual(
    sameCanonicalPath('/var/folders/fixture', '/private/var/folders/fixture', 'darwin'),
    true,
    'macOS /var and /private/var aliases must compare as the same sandbox',
  );
  assert.strictEqual(
    sameCanonicalPath('/var/folders/fixture', '/private/var/folders/other', 'darwin'),
    false,
    'macOS alias handling must not accept a different sandbox',
  );
  assert.strictEqual(
    sameCanonicalPath('/var/folders/fixture', '/private/var/folders/fixture', 'linux'),
    false,
    'non-macOS platforms must not gain a path alias',
  );
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-conformance.'));
  try {
    const config = path.join(sandbox, 'config.toml');
    assert.deepStrictEqual(parseArgs([`--config=${config}`, `--sandbox=${sandbox}`]), { config, sandbox });
    assert.throws(() => parseArgs(['--config', config, `--sandbox=${sandbox}`]), /requires '=value'/u);
    assert.throws(() => parseArgs([`--config=${config}`, `--sandbox=${sandbox}`, '--unknown']), /Unknown flag/u);
    const original = [
      'model = "fixture"',
      'notes = """',
      `[projects."${sandbox}/case-string-data"]`,
      'trust_level = "trusted"',
      '"""',
      '',
      '[projects."/tmp/foreign"]',
      'trust_level = "trusted"',
      '',
    ].join('\n');
    const taskTable = `\n[projects."${sandbox}/case-fixture"]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(config, original + taskTable, { mode: 0o600 });
    const cleaned = removeProjectTrustTables(config, sandbox);
    assert.strictEqual(cleaned.removed, 1);
    assert.strictEqual(fs.readFileSync(config, 'utf8'), original);

    const adjacentTaskTables = `${taskTable}\n[projects."${sandbox}/case-second"]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(config, original + adjacentTaskTables, { mode: 0o600 });
    const adjacentCleaned = removeProjectTrustTables(config, sandbox);
    assert.strictEqual(adjacentCleaned.removed, 2);
    assert.strictEqual(fs.readFileSync(config, 'utf8'), original);

    const unsafe = `${original}\n[projects."${sandbox}/case-unsafe"]\ntrust_level = "trusted"\nextra = true\n`;
    fs.writeFileSync(config, unsafe, { mode: 0o600 });
    assert.throws(() => removeProjectTrustTables(config, sandbox), /unexpected content/u);
    assert.strictEqual(fs.readFileSync(config, 'utf8'), unsafe);

    const unterminated = `${original}notes = """\n[projects."${sandbox}/case-string-data"]\ntrust_level = "trusted"\n`;
    fs.writeFileSync(config, unterminated, { mode: 0o600 });
    assert.throws(() => removeProjectTrustTables(config, sandbox), /unterminated TOML string/u);
    assert.strictEqual(fs.readFileSync(config, 'utf8'), unterminated);

    fs.writeFileSync(config, original + taskTable, { mode: 0o600 });
    const F = require('../lib/fs-atomic');
    assert.throws(() => removeProjectTrustTables(config, sandbox, {
      write: (file, content, options) => {
        fs.appendFileSync(file, '# concurrent\n');
        F.writeFileAtomic(file, content, options);
      },
    }), /concurrent change/u);
    assert.match(fs.readFileSync(config, 'utf8'), /# concurrent\n$/u);

    const target = path.join(sandbox, 'target.toml');
    const link = path.join(sandbox, 'linked.toml');
    fs.writeFileSync(target, original, { mode: 0o600 });
    fs.symlinkSync(target, link);
    assert.throws(() => removeProjectTrustTables(link, sandbox), /symlink/u);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), original);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: false });
  }
});

t('outcome-first assertion accepts strict English/Chinese answers and rejects evidence-first prose', () => {
  const target = lib.cases.find((item) => item.id === 'discipline-outcome-first');
  assert.ok(target, 'discipline-outcome-first case missing');
  const assertion = target.assert.find((item) => item.type === 'last_regex' && item.regex.startsWith('^'));
  assert.ok(assertion, 'outcome-first anchored assertion missing');
  const matches = (input) => cp.spawnSync('grep', ['-Eiq', assertion.regex], {
    input,
    encoding: 'utf8',
  }).status === 0;
  assert.strictEqual(matches('Yes — the service is enabled.\n'), true);
  assert.strictEqual(matches('Enabled: true.\n'), true);
  assert.strictEqual(matches('服务**已启用**。证据为 "enabled": true。\n'), true);
  assert.strictEqual(matches('证据显示服务已启用。\n'), false);
  assert.strictEqual(matches('The evidence says enabled.\n'), false);
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

console.log(`conformance-cases: ${PASS} passed, ${FAIL} failed, ${SKIP} skipped`);
process.exit(FAIL === 0 ? 0 : 1);
