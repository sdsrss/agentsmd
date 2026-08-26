'use strict';

const assert = require('assert');
const cp = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const LIB = path.join(ROOT, 'hooks', 'lib', 'rule-hits.sh');
const ALLOWED_KEYS = new Set([
  'ts',
  'hook',
  'event',
  'project',
  'session_id',
  'spec_version',
  'agentsmd_version',
  'surface',
  'codex_version',
  'model',
  'platform',
  'tag',
]);

let PASS = 0;
let FAIL = 0;
function test(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    FAIL += 1;
    console.log(`  FAIL ${name}\n     ${error.message}`);
  }
}

function invoke(home, sid, overrides = {}) {
  const values = {
    spec: 'v5.0.1',
    agentsmd: '5.0.1',
    surface: 'standalone',
    codex: '0.145.0',
    model: 'gpt-5.6-sol',
    platform: 'linux-x64',
    ...overrides,
  };
  const withoutJq = values.withoutJq === true;
  delete values.withoutJq;
  const script = withoutJq
    ? 'source "$1"; command() { if [[ "${1:-}" == "-v" && "${2:-}" == "jq" ]]; then return 1; fi; builtin command "$@"; }; rule_hits_session_dimension "$2" "$3" "$4" "$5" "$6" "$7" "$8"'
    : 'source "$1"; rule_hits_session_dimension "$2" "$3" "$4" "$5" "$6" "$7" "$8"';
  return cp.spawn('bash', [
    '-c',
    script,
    'session-dimension-test',
    LIB,
    sid,
    values.spec,
    values.agentsmd,
    values.surface,
    values.codex,
    values.model,
    values.platform,
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      CODEX_HOME: home,
      CODEX_PROJECT_DIR: ROOT,
      AGENTSMD_TELEMETRY_TAG: 'test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function wait(child) {
  return new Promise((resolve, reject) => {
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`dimension writer exited ${code}: ${stderr}`));
    });
  });
}

function rows(home) {
  const file = path.join(home, 'logs', 'agentsmd.jsonl');
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-session-dimension.'));
  try {
    await wait(invoke(home, 'session-one'));
    await wait(invoke(home, 'session-one'));

    test('one session emits exactly one bounded dimension row', () => {
      const found = rows(home).filter((row) => row.event === 'session-dimension' && row.session_id === 'session-one');
      assert.strictEqual(found.length, 1);
      assert.deepStrictEqual({
        spec_version: found[0].spec_version,
        agentsmd_version: found[0].agentsmd_version,
        surface: found[0].surface,
        codex_version: found[0].codex_version,
        model: found[0].model,
        platform: found[0].platform,
      }, {
        spec_version: 'v5.0.1',
        agentsmd_version: '5.0.1',
        surface: 'standalone',
        codex_version: '0.145.0',
        model: 'gpt-5.6-sol',
        platform: 'linux-x64',
      });
      assert(Object.keys(found[0]).every((key) => ALLOWED_KEYS.has(key)), Object.keys(found[0]).join(', '));
    });

    await Promise.all(Array.from({ length: 24 }, () => wait(invoke(home, 'session-concurrent'))));
    test('concurrent SessionStart writers retain exactly one dimension row', () => {
      const found = rows(home).filter((row) => row.event === 'session-dimension' && row.session_id === 'session-concurrent');
      assert.strictEqual(found.length, 1);
    });

    await wait(invoke(home, 'session-unknown', {
      spec: '',
      agentsmd: '',
      surface: '',
      codex: '',
      model: '',
      platform: '',
    }));
    test('missing runtime dimensions are explicit unknown values, never absent', () => {
      const row = rows(home).find((entry) => entry.session_id === 'session-unknown');
      for (const key of ['spec_version', 'agentsmd_version', 'surface', 'codex_version', 'model', 'platform']) {
        assert.strictEqual(row[key], 'unknown', `${key}=${row[key]}`);
      }
    });

    await wait(invoke(home, 'session-jqless', {
      withoutJq: true,
      model: 'model"with\\escapes',
    }));
    test('jq-less dimension fallback preserves valid bounded JSON and exact values', () => {
      const row = rows(home).find((entry) => entry.session_id === 'session-jqless');
      assert(row);
      assert.strictEqual(row.event, 'session-dimension');
      assert.strictEqual(row.model, 'model"with\\escapes');
      assert(Object.keys(row).every((key) => ALLOWED_KEYS.has(key)), Object.keys(row).join(', '));
    });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }

  console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
  process.exit(FAIL === 0 ? 0 : 1);
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
