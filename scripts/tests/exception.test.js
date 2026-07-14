'use strict';
// exception.test.js — R1-01 structured-exception CLI + doctor integration.
// Covers: entry building/validation per rule, renewal dedupe, rm/prune, the
// 16 KiB write refusal (hooks fail-closed past it), schema rejection, and the
// doctor check (healthy / expired / absent). Fully sandboxed via mkdtempSync +
// CODEX_HOME/chdir swaps, disposed in finally (§8.V4).

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

const EXC = require('../exception');

let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

function mkRepo(base, name) {
  const dir = path.join(base, name);
  fs.mkdirSync(path.join(dir, 'tests', 'fixtures'), { recursive: true });
  cp.execFileSync('git', ['-C', dir, 'init', '-q']);
  fs.writeFileSync(path.join(dir, 'tests', 'fixtures', 'fake.js'), 'const k = 1;\n');
  return dir;
}

function inDir(dir, fn) {
  const prev = process.cwd();
  process.chdir(dir);
  try { return fn(); } finally { process.chdir(prev); }
}

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-exception-'));
try {
  const REPO = mkRepo(SB, 'repo');

  t('add --rule=§8-secrets --pattern builds a pattern entry with expiry and deterministic id', () => {
    const code = inDir(REPO, () => EXC.main([
      'add', '--rule=§8-secrets', '--path=tests/fixtures/fake.js',
      '--pattern=AKIA[0-9A-Z]{16}', '--days=30', '--reason=fixture',
    ]));
    assert.strictEqual(code, 0);
    const store = JSON.parse(fs.readFileSync(EXC.exceptionsPath(REPO), 'utf8'));
    assert.strictEqual(store.schemaVersion, EXC.SCHEMA_VERSION);
    assert.strictEqual(store.exceptions.length, 1);
    const e = store.exceptions[0];
    assert.strictEqual(e.rule, '§8-secrets');
    assert.strictEqual(e.detector, 'pattern');
    assert.deepStrictEqual(e.fingerprint, { pattern: 'AKIA[0-9A-Z]{16}', path: 'tests/fixtures/fake.js' });
    assert.ok(/^exc-[0-9a-f]{10}$/.test(e.id));
    assert.ok(e.expires_at > e.created_at, 'expiry after creation');
  });

  t('re-adding the same fingerprint renews in place (no duplicate)', () => {
    const code = inDir(REPO, () => EXC.main([
      'add', '--rule=§8-secrets', '--path=tests/fixtures/fake.js',
      '--pattern=AKIA[0-9A-Z]{16}', '--days=7', '--reason=renewed',
    ]));
    assert.strictEqual(code, 0);
    const store = JSON.parse(fs.readFileSync(EXC.exceptionsPath(REPO), 'utf8'));
    assert.strictEqual(store.exceptions.length, 1);
    assert.strictEqual(store.exceptions[0].reason, 'renewed');
  });

  t('rule alias without § normalizes; url rule requires https', () => {
    const ok = inDir(REPO, () => EXC.main([
      'add', '--rule=8-unknown-script', '--url=https://example.com/i-v1.sh', '--reason=pinned',
    ]));
    assert.strictEqual(ok, 0);
    const store = JSON.parse(fs.readFileSync(EXC.exceptionsPath(REPO), 'utf8'));
    assert.ok(store.exceptions.some((e) => e.rule === '§8-unknown-script' && e.fingerprint.url === 'https://example.com/i-v1.sh'));
    const bad = inDir(REPO, () => EXC.main(['add', '--rule=§8-unknown-script', '--url=http://plain.sh', '--reason=x']));
    assert.strictEqual(bad, 1, 'http:// must be refused');
  });

  t('validation rejects: rm-rf-var rule, missing file, out-of-repo path, unknown pattern, bad days, empty reason', () => {
    const cases = [
      ['add', '--rule=§8-rm-rf-var', '--path=tests/fixtures/fake.js', '--reason=x'],
      ['add', '--rule=§8-secrets', '--path=tests/fixtures/nope.js', '--reason=x'],
      ['add', '--rule=§8-secrets', '--path=../outside.js', '--reason=x'],
      ['add', '--rule=§8-secrets', '--path=tests/fixtures/fake.js', '--pattern=password.*', '--reason=x'],
      ['add', '--rule=§8-secrets', '--path=tests/fixtures/fake.js', '--days=91', '--reason=x'],
      ['add', '--rule=§8-secrets', '--path=tests/fixtures/fake.js', '--reason=   '],
      ['add', '--rule=§8-secrets', '--path=tests/fixtures/fake.js', '--bogus=1', '--reason=x'],
    ];
    for (const argv of cases) {
      assert.strictEqual(inDir(REPO, () => EXC.main(argv)), 1, `expected rejection: ${argv.join(' ')}`);
    }
  });

  t('rm removes by id; prune drops expired entries only', () => {
    const store = JSON.parse(fs.readFileSync(EXC.exceptionsPath(REPO), 'utf8'));
    const urlId = store.exceptions.find((e) => e.detector === 'url').id;
    assert.strictEqual(inDir(REPO, () => EXC.main(['rm', `--id=${urlId}`])), 0);
    assert.strictEqual(inDir(REPO, () => EXC.main(['rm', `--id=${urlId}`])), 1, 'second rm finds nothing');
    const withExpired = JSON.parse(fs.readFileSync(EXC.exceptionsPath(REPO), 'utf8'));
    withExpired.exceptions.push({
      id: 'exc-dead000000', rule: '§8-secrets', detector: 'filename',
      fingerprint: { path: 'tests/fixtures/fake.js' }, reason: 'stale',
      created_at: '2026-01-01T00:00:00Z', expires_at: '2026-01-02T00:00:00Z',
    });
    EXC.writeStore(EXC.exceptionsPath(REPO), withExpired);
    assert.strictEqual(inDir(REPO, () => EXC.main(['prune'])), 0);
    const pruned = JSON.parse(fs.readFileSync(EXC.exceptionsPath(REPO), 'utf8'));
    assert.ok(!pruned.exceptions.some((e) => e.id === 'exc-dead000000'), 'expired entry pruned');
    assert.strictEqual(pruned.exceptions.length, 1, 'live entry survives');
  });

  t('writeStore refuses to exceed the hook size cap; readStore rejects foreign schema', () => {
    const big = { schemaVersion: 1, exceptions: [] };
    for (let i = 0; i < 200; i += 1) {
      big.exceptions.push({ id: `exc-${String(i).padStart(10, '0')}`, rule: '§8-secrets', detector: 'filename', fingerprint: { path: `f/${i}.js` }, reason: 'x'.repeat(40), created_at: '2026-01-01T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' });
    }
    assert.throws(() => EXC.writeStore(path.join(SB, 'big.json'), big), /refusing to write/);
    const foreign = path.join(SB, 'foreign.json');
    fs.writeFileSync(foreign, JSON.stringify({ schemaVersion: 2, exceptions: [] }));
    assert.throws(() => EXC.readStore(foreign), /unsupported exceptions file/);
  });

  t('outside a git repository the CLI refuses (exceptions are per-repo)', () => {
    const bare = path.join(SB, 'norepo');
    fs.mkdirSync(bare, { recursive: true });
    assert.strictEqual(inDir(bare, () => EXC.main(['list'])), 1);
  });

  t('doctor: healthy exceptions file → passing check; expired → failing with prune hint; absent → no row', () => {
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(SB, 'codexhome');
    try {
      const { doctor } = require('../doctor');
      const row = () => inDir(REPO, () => doctor().checks.find((c) => c.name === 'project §8 exceptions file is healthy'));
      const healthy = row();
      assert.ok(healthy && healthy.ok, `healthy row: ${JSON.stringify(healthy)}`);
      const store = JSON.parse(fs.readFileSync(EXC.exceptionsPath(REPO), 'utf8'));
      store.exceptions[0].expires_at = '2026-01-02T00:00:00Z';
      EXC.writeStore(EXC.exceptionsPath(REPO), store);
      const stale = row();
      assert.ok(stale && !stale.ok && /prune/.test(stale.detail), `stale row: ${JSON.stringify(stale)}`);
      fs.rmSync(path.dirname(EXC.exceptionsPath(REPO)), { recursive: true, force: true });
      assert.strictEqual(row(), undefined, 'no exceptions file → no check row');
    } finally {
      if (prevHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = prevHome;
    }
  });
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
}

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
