'use strict';
// lifecycle-journal.test.js — R2-02 (audit H-03): the durable transaction
// journal. Proves the acceptance criterion directly: at ANY process-termination
// point inside the install commit phase, a FRESH process can decide
// roll-forward vs rollback from DISK STATE ALONE (the adjudicator runs in a
// separate node process with no in-memory transaction). Crash injection uses
// the AGENTSMD_TEST_CRASH_AT SIGKILL points wired into install.js (R2-04
// pre-wiring). Everything runs in mkdtemp sandboxes (§8.V3), disposed on exit
// (§8.V4).

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (n, f) => Promise.resolve().then(f).then(
  () => { PASS++; console.log('  ok   ' + n); },
  (e) => { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); }
);

const SCRIPTS = path.join(__dirname, '..');
const J_LIB = path.join(SCRIPTS, 'lib', 'lifecycle-journal.js');
const J = require(J_LIB);

const SANDBOXES = [];
const sandbox = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `agentsmd-journal-${name}-`));
  SANDBOXES.push(d);
  return d;
};

const run = (script, args, env) => cp.spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args],
  { encoding: 'utf8', env: { ...process.env, ...env } });

// The R2-02 acceptance instrument: adjudicate in a FRESH process, disk only.
function adjudicateFresh(codexHome) {
  const r = cp.spawnSync(process.execPath, ['-e',
    `console.log(JSON.stringify(require(${JSON.stringify(J_LIB)}).adjudicate()))`],
    { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome } });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

(async () => {

await t('classify + adjudicate: before/after/other over real files and trees; unreadable journal = conflict', () => {
  const home = sandbox('unit');
  process.env.CODEX_HOME = home;
  try {
    assert.deepStrictEqual(J.adjudicate(), { decision: 'clean', steps: [] }, 'no journal = clean');
    // write-step classification
    const target = path.join(home, 'shared.json');
    const before = 'old\n', after = 'new\n';
    const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
    const wstep = { kind: 'write', target, beforePresent: true, beforeSha256: sha(before), afterSha256: sha(after) };
    fs.writeFileSync(target, before);
    assert.strictEqual(J.classifyStep(wstep), 'before');
    fs.writeFileSync(target, after);
    assert.strictEqual(J.classifyStep(wstep), 'after');
    fs.writeFileSync(target, 'foreign\n');
    assert.strictEqual(J.classifyStep(wstep), 'other');
    // swap-step classification (tree present/absent)
    const dir = path.join(home, 'deploy');
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    const F = require('../lib/fs-atomic');
    const sstep = { kind: 'swap', target: dir, beforePresent: false, beforeSha256Tree: null, afterPresent: true, afterSha256Tree: F.sha256Tree(dir) };
    assert.strictEqual(J.classifyStep(sstep), 'after');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'y\n');
    assert.strictEqual(J.classifyStep(sstep), 'other');
    fs.rmSync(dir, { recursive: true });
    assert.strictEqual(J.classifyStep(sstep), 'before');
    // decision matrix via a crafted persisted journal
    const rec = J.begin({ txid: 't1', action: 'install', steps: [wstep, sstep] });
    fs.writeFileSync(target, after); // wstep after; sstep before (dir absent)
    assert.strictEqual(J.adjudicate().decision, 'rollback', 'mixed = rollback');
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    assert.strictEqual(J.adjudicate().decision, 'roll-forward', 'all after = roll-forward');
    fs.writeFileSync(target, 'foreign\n');
    assert.strictEqual(J.adjudicate().decision, 'conflict', 'any other = conflict');
    assert.strictEqual(rec.phase, 'committing');
    fs.writeFileSync(J.journalPath(), 'not json{');
    assert.strictEqual(J.adjudicate().decision, 'conflict', 'unreadable journal = conflict (fail closed)');
    J.complete();
    assert.strictEqual(J.adjudicate().decision, 'clean');
  } finally { delete process.env.CODEX_HOME; }
});

await t('successful install leaves NO journal, no planned/stage residue, and records nothing stale', () => {
  const home = sandbox('success');
  const r = run('install.js', ['--json'], { CODEX_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'journal removed on success');
  const residue = fs.readdirSync(home).filter((n) => n.startsWith('.agentsmd-stage-') || n.includes('lifecycle-journal'));
  assert.deepStrictEqual(residue, [], `no stage/journal residue: ${residue.join(', ')}`);
  assert.ok(!('archivedStaleJournal' in JSON.parse(r.stdout)), 'clean install records no stale journal');
});

const CRASH_MATRIX = [
  ['after-journal', 'rollback'],      // nothing mutated yet → every step at before
  ['mid-swaps', 'rollback'],          // deploy swapped, rest untouched
  ['after-swaps', 'rollback'],        // all swaps landed, writes untouched
  ['mid-writes', 'rollback'],         // hooks.json written, remaining writes untouched
  ['before-cleanup', 'roll-forward'], // every step landed; only cleanup owed
];

for (const [point, expected] of CRASH_MATRIX) {
  await t(`SIGKILL at ${point}: fresh-process disk adjudication = ${expected}`, () => {
    const home = sandbox(point);
    const r = run('install.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: point });
    assert.strictEqual(r.signal, 'SIGKILL', `install must die at ${point} (status=${r.status} signal=${r.signal})\n${r.stderr}`);
    assert.ok(fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'journal survived the crash (fsync)');
    const verdict = adjudicateFresh(home);
    assert.strictEqual(verdict.decision, expected, `adjudication at ${point}: ${JSON.stringify(verdict.steps)}`);
    assert.ok(verdict.steps.length >= 5, 'journal describes every planned step');
  });
}

await t('roll-forward crash state: doctor names it; re-run install archives the journal and heals to green', () => {
  const home = sandbox('heal-forward');
  const crashed = run('install.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: 'before-cleanup' });
  assert.strictEqual(crashed.signal, 'SIGKILL');
  // doctor: dead owner + pending journal → failing check with the verdict
  const doctorOut = cp.spawnSync(process.execPath, ['-e',
    `console.log(JSON.stringify(require(${JSON.stringify(path.join(SCRIPTS, 'doctor.js'))}).doctor().checks))`],
    { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
  const check = JSON.parse(doctorOut.stdout).find((c) => c.name === 'no pending lifecycle transaction');
  assert.ok(check && !check.ok && /roll-forward/.test(check.detail), JSON.stringify(check));
  // re-run: reclaims the dead lock, archives the journal, completes cleanly
  const healed = run('install.js', ['--json'], { CODEX_HOME: home });
  assert.strictEqual(healed.status, 0, healed.stderr);
  const manifest = JSON.parse(healed.stdout);
  assert.strictEqual(manifest.archivedStaleJournal.decision, 'roll-forward', 'heal records what it archived');
  assert.ok(!fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'no pending journal after heal');
  assert.ok(fs.readdirSync(home).some((n) => n.startsWith('.agentsmd-lifecycle-journal.json.stale-')), 'evidence archived');
  const stray = fs.readdirSync(home).filter((n) => n.startsWith('.agentsmd-stage-'));
  assert.deepStrictEqual(stray, [], 'crashed stage dirs cleaned by... ' + stray.join(','));
});

await t('rollback crash state: install refuses to build on it (fail closed), journal preserved', () => {
  const home = sandbox('refuse');
  const crashed = run('install.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: 'mid-swaps' });
  assert.strictEqual(crashed.signal, 'SIGKILL');
  const refused = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(refused.status, 1, 'must refuse a half-committed state');
  assert.ok(/crashed lifecycle transaction .*rollback|half-committed/s.test(refused.stderr), refused.stderr);
  assert.ok(fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'journal (evidence) NOT consumed by the refusal');
  const verdict = adjudicateFresh(home);
  assert.strictEqual(verdict.decision, 'rollback', 'evidence still adjudicable after refusal');
});

await t('in-flight transaction (live lock + journal) keeps doctor calm', async () => {
  const home = sandbox('inflight');
  const seeded = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(seeded.status, 0, seeded.stderr);
  const holder = await new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, ['-e', `
      const L = require(${JSON.stringify(path.join(SCRIPTS, 'lib', 'lifecycle-lock.js'))});
      const J = require(${JSON.stringify(J_LIB)});
      L.acquire('install');
      J.begin({ txid: 'inflight-tx', action: 'install', steps: [] });
      console.log('HELD');
      setInterval(() => {}, 1000);
    `], { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('HELD')) resolve(child); });
    child.on('exit', (code) => reject(new Error(`holder exited early (${code})`)));
    setTimeout(() => reject(new Error('holder never reported HELD')), 10000).unref();
  });
  try {
    const doctorOut = cp.spawnSync(process.execPath, ['-e',
      `console.log(JSON.stringify(require(${JSON.stringify(path.join(SCRIPTS, 'doctor.js'))}).doctor().checks))`],
      { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
    const check = JSON.parse(doctorOut.stdout).find((c) => c.name === 'no pending lifecycle transaction');
    assert.ok(check && check.ok && /in progress/.test(check.detail), JSON.stringify(check));
  } finally {
    await new Promise((resolve) => { holder.on('exit', resolve); holder.kill('SIGKILL'); });
  }
});

for (const d of SANDBOXES) fs.rmSync(d, { recursive: true, force: true }); // §8.V4

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);

})();
