'use strict';
// preflight.test.js — R1-03: prerequisites gate BEFORE mutation, shared by every
// install surface. Proves the acceptance criteria mechanically:
//   (a) jq missing + no opt-in → install refuses with ZERO mutation — the whole
//       $CODEX_HOME tree (hooks.json / config.toml / AGENTS.md / manifest) is
//       byte-identical, and no new file appears anywhere in it;
//   (b) --degraded (or AGENTSMD_ALLOW_DEGRADED=1) is the ONLY way past a miss,
//       and it records enforcement:false + missingPrerequisites in the manifest;
//   (c) status reports enforcement:false with a stderr warning; doctor keeps a
//       failing "install enforcement active" check (exit 1) — the persistent
//       degraded-mode signal;
//   (d) a later healthy install (jq back on PATH) heals to enforcement:true.
// Fully sandboxed via CODEX_HOME; children get a stripped PATH (node only) to
// simulate the missing prerequisite.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const assert = require('assert');
const cp = require('child_process');

let PASS = 0, FAIL = 0;
const t = (name, fn) => { try { fn(); PASS++; console.log('  ok   ' + name); } catch (e) { FAIL++; console.log('  FAIL ' + name + '\n     ' + e.message); } };

const ROOT = path.join(__dirname, '..', '..');
const INSTALL = path.join(ROOT, 'scripts', 'install.js');
const STATUS = path.join(ROOT, 'scripts', 'status.js');
const DOCTOR = path.join(ROOT, 'scripts', 'doctor.js');
const PF = require('../lib/preflight');

// A PATH with node but no jq. node is a symlink to the running binary.
const noJqBin = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-nojq.'));
fs.symlinkSync(process.execPath, path.join(noJqBin, 'node'));

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-preflight.'));
const OMX_CMD = 'node "/omx/dist/scripts/codex-native-hook.js"';
fs.writeFileSync(path.join(SANDBOX, 'hooks.json'), JSON.stringify({
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: OMX_CMD }] }] },
}, null, 2) + '\n');
fs.writeFileSync(path.join(SANDBOX, 'config.toml'), '[features]\nsomething_else = true\n');
fs.writeFileSync(path.join(SANDBOX, 'AGENTS.md'), '# user notes\n');

function fingerprint(dir) {
  const rows = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(d, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) { rows.push(`dir ${rel}`); walk(full); }
      else if (entry.isFile()) rows.push(`file ${rel} ${crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex')} ${fs.statSync(full).mode.toString(8)}`);
      else rows.push(`other ${rel}`);
    }
  };
  walk(dir);
  return rows.sort().join('\n');
}

const runChild = (script, args, env) => cp.spawnSync(process.execPath, [script, ...args], {
  encoding: 'utf8',
  env: { HOME: os.homedir(), CODEX_HOME: SANDBOX, ...env },
});

t('unit: checkPrerequisites flags jq when PATH lacks it, passes when present', () => {
  const prevPath = process.env.PATH;
  try {
    process.env.PATH = noJqBin;
    const miss = PF.checkPrerequisites();
    assert.strictEqual(miss.ok, false);
    assert.ok(miss.missing.some((m) => m.name === 'jq'), JSON.stringify(miss.missing));
  } finally { process.env.PATH = prevPath; }
  const ok = PF.checkPrerequisites();
  assert.strictEqual(ok.ok, true, JSON.stringify(ok.missing));
});

t('jq missing, no opt-in → install exits 1 with ZERO mutation (tree byte-identical)', () => {
  const before = fingerprint(SANDBOX);
  const r = runChild(INSTALL, [], { PATH: noJqBin });
  assert.strictEqual(r.status, 1, `status=${r.status} stderr=${r.stderr}`);
  assert.ok(/zero-mutation/.test(r.stderr), r.stderr);
  assert.ok(/--degraded/.test(r.stderr), 'refusal must teach the explicit opt-in');
  assert.strictEqual(fingerprint(SANDBOX), before, 'CODEX_HOME changed despite refusal');
  assert.ok(!fs.existsSync(path.join(SANDBOX, '.agentsmd-state')), 'state dir must not appear');
});

t('AGENTSMD_ALLOW_DEGRADED unset-but-falsy values do not opt in', () => {
  const before = fingerprint(SANDBOX);
  const r = runChild(INSTALL, [], { PATH: noJqBin, AGENTSMD_ALLOW_DEGRADED: '0' });
  assert.strictEqual(r.status, 1, r.stderr);
  assert.strictEqual(fingerprint(SANDBOX), before);
});

t('--degraded → installs, manifest records enforcement:false + missing jq, warns on stderr', () => {
  const r = runChild(INSTALL, ['--degraded', '--json'], { PATH: noJqBin });
  assert.strictEqual(r.status, 0, `status=${r.status} stderr=${r.stderr}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.agentsmd-state', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.enforcement, false);
  assert.deepStrictEqual(manifest.missingPrerequisites, ['jq']);
  assert.ok(/WARNING: degraded install/.test(r.stderr), r.stderr);
});

t('status: enforcement:false in JSON + persistent stderr warning', () => {
  const r = runChild(STATUS, [], {});
  assert.strictEqual(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.strictEqual(out.enforcement, false);
  assert.deepStrictEqual(out.missingPrerequisites, ['jq']);
  assert.ok(/enforcement:false/.test(r.stderr), r.stderr);
});

t('doctor: "install enforcement active" check fails and doctor exits non-zero', () => {
  const r = runChild(DOCTOR, [], {});
  assert.notStrictEqual(r.status, 0, 'doctor must stay red on a degraded install');
  assert.ok(/install enforcement active/.test(r.stdout), r.stdout);
  assert.ok(/degraded install \(missing: jq\)/.test(r.stdout), r.stdout);
});

t('healthy update heals: jq back on PATH → enforcement:true, no missing prerequisites', () => {
  const r = runChild(INSTALL, ['--json'], {});
  assert.strictEqual(r.status, 0, r.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(SANDBOX, '.agentsmd-state', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.enforcement, true);
  assert.deepStrictEqual(manifest.missingPrerequisites, []);
  const s = runChild(STATUS, [], {});
  assert.strictEqual(JSON.parse(s.stdout).enforcement, true);
  assert.ok(!/enforcement:false/.test(s.stderr));
});

t('env opt-in AGENTSMD_ALLOW_DEGRADED=1 equals --degraded', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-preflight-env.'));
  const r = cp.spawnSync(process.execPath, [INSTALL], {
    encoding: 'utf8',
    env: { HOME: os.homedir(), CODEX_HOME: dir, PATH: noJqBin, AGENTSMD_ALLOW_DEGRADED: '1' },
  });
  assert.strictEqual(r.status, 0, r.stderr);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, '.agentsmd-state', 'manifest.json'), 'utf8'));
  assert.strictEqual(manifest.enforcement, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.rmSync(noJqBin, { recursive: true, force: true });
console.log(`preflight: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
