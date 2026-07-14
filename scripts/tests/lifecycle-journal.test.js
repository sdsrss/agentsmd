'use strict';
// lifecycle-journal.test.js — R2-02 + R2-03 (audit H-03): durable transaction
// journal + executed startup recovery. Proves both acceptance criteria:
//   R2-02 — at ANY termination point a FRESH process decides roll-forward vs
//   rollback from DISK STATE ALONE (adjudicator runs in a separate node
//   process, no in-memory transaction);
//   R2-03 — every pending transaction is driven back to COMPLETE OLD or
//   COMPLETE NEW by the next lifecycle entry, with no permanent ownership
//   lockout (every crash point is followed by a plain re-run that succeeds),
//   and conflicts fail closed preserving current bytes.
// Crash injection: AGENTSMD_TEST_CRASH_AT SIGKILL points inside install.js and
// uninstall.js (R2-04 pre-wiring). All in mkdtemp sandboxes (§8.V3/§8.V4).

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

function doctorChecks(codexHome) {
  const r = cp.spawnSync(process.execPath, ['-e',
    `console.log(JSON.stringify(require(${JSON.stringify(path.join(SCRIPTS, 'doctor.js'))}).doctor().checks))`],
    { encoding: 'utf8', env: { ...process.env, CODEX_HOME: codexHome } });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

const noPendingState = (home) => {
  assert.ok(!fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'no pending journal');
  const stray = fs.readdirSync(home).filter((n) => n.startsWith('.agentsmd-stage-') || n.startsWith('.agentsmd-uninstall-stage-') || n.startsWith('.agentsmd-lifecycle-lock'));
  assert.deepStrictEqual(stray, [], `no stage/lock residue: ${stray.join(', ')}`);
};

(async () => {

await t('classify + adjudicate: before/after/other over real files and trees; unreadable journal = conflict', () => {
  const home = sandbox('unit');
  process.env.CODEX_HOME = home;
  try {
    assert.deepStrictEqual(J.adjudicate(), { decision: 'clean', steps: [] }, 'no journal = clean');
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
    // deletion-write step (uninstall shape): after = absent
    const dstep = { kind: 'write', target, beforePresent: true, beforeSha256: sha(before), afterPresent: false, afterSha256: null };
    fs.rmSync(target);
    assert.strictEqual(J.classifyStep(dstep), 'after');
    const dir = path.join(home, 'deploy');
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    const F = require('../lib/fs-atomic');
    const sstep = { kind: 'swap', target: dir, beforePresent: false, beforeSha256Tree: null, afterPresent: true, afterSha256Tree: F.sha256Tree(dir) };
    assert.strictEqual(J.classifyStep(sstep), 'after');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'y\n');
    assert.strictEqual(J.classifyStep(sstep), 'other');
    fs.rmSync(dir, { recursive: true });
    assert.strictEqual(J.classifyStep(sstep), 'before');
    fs.writeFileSync(target, after);
    J.begin({ txid: 't1', action: 'install', steps: [wstep, sstep] });
    assert.strictEqual(J.adjudicate().decision, 'rollback', 'mixed = rollback');
    fs.mkdirSync(dir); fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    assert.strictEqual(J.adjudicate().decision, 'roll-forward', 'all after = roll-forward');
    fs.writeFileSync(target, 'foreign\n');
    assert.strictEqual(J.adjudicate().decision, 'conflict', 'any other = conflict');
    fs.writeFileSync(J.journalPath(), 'not json{');
    assert.strictEqual(J.adjudicate().decision, 'conflict', 'unreadable journal = conflict (fail closed)');
    J.complete();
    assert.strictEqual(J.adjudicate().decision, 'clean');
  } finally { delete process.env.CODEX_HOME; }
});

await t('planRecovery + executeRecovery: inline contents make rollback stage-independent; verification is per-step', () => {
  const home = sandbox('recover-unit');
  process.env.CODEX_HOME = home;
  try {
    const target = path.join(home, 'shared.json');
    const sha = (s) => require('crypto').createHash('sha256').update(s).digest('hex');
    const b64 = (s) => Buffer.from(s).toString('base64');
    const wstep = {
      kind: 'write', target,
      beforePresent: true, beforeSha256: sha('old\n'), beforeContentB64: b64('old\n'),
      afterSha256: sha('new\n'), afterContentB64: b64('new\n'),
    };
    // Mixed state, no stage dir at all: rollback must still be executable.
    fs.writeFileSync(target, 'new\n');
    J.begin({ txid: 't2', action: 'install', steps: [wstep, {
      kind: 'write', target: path.join(home, 'other.md'),
      beforePresent: false, beforeSha256: null, beforeContentB64: null,
      afterSha256: sha('x'), afterContentB64: b64('x'),
    }] });
    const plan = J.planRecovery();
    assert.strictEqual(plan.mode, 'roll-forward', 'forward preferred when inline sources cover it');
    // Destroy the forward preference by making forward unverifiable? Forward is
    // inline too — force rollback by choosing it explicitly.
    const report = J.executeRecovery(J.readJournal(), { mode: 'rollback', verdict: {} });
    assert.strictEqual(report.mode, 'rollback');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), 'old\n', 'write step restored from inline before-content');
    assert.ok(!fs.existsSync(path.join(home, 'other.md')), 'absent-before write step unlinked');
    assert.ok(!fs.existsSync(J.journalPath()), 'journal archived after recovery');
    assert.ok(fs.readdirSync(home).some((n) => n.includes('lifecycle-journal.json.stale-')), 'evidence archived');
  } finally { delete process.env.CODEX_HOME; }
});

await t('successful install leaves NO journal, no residue, and records no recovery', () => {
  const home = sandbox('success');
  const r = run('install.js', ['--json'], { CODEX_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  noPendingState(home);
  assert.ok(!('recoveredJournal' in JSON.parse(r.stdout)), 'clean install records no recovery');
});

const CRASH_MATRIX = [
  ['after-journal', 'rollback'],
  ['mid-swaps', 'rollback'],
  ['after-swaps', 'rollback'],
  ['mid-writes', 'rollback'],
  ['before-cleanup', 'roll-forward'],
];

for (const [point, expected] of CRASH_MATRIX) {
  await t(`install SIGKILL at ${point}: fresh-process disk adjudication = ${expected}; re-run install recovers to green (no lockout)`, () => {
    const home = sandbox(point);
    const crashed = run('install.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: point });
    assert.strictEqual(crashed.signal, 'SIGKILL', `install must die at ${point}\n${crashed.stderr}`);
    assert.ok(fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'journal survived the crash');
    const verdict = adjudicateFresh(home);
    assert.strictEqual(verdict.decision, expected, `adjudication at ${point}: ${JSON.stringify(verdict.steps)}`);
    // R2-03 acceptance: a PLAIN re-run recovers and completes — no manual step.
    const healed = run('install.js', ['--json'], { CODEX_HOME: home });
    assert.strictEqual(healed.status, 0, `${point}: re-run must recover: ${healed.stderr}`);
    const manifest = JSON.parse(healed.stdout);
    assert.ok(['roll-forward', 'rollback'].includes(manifest.recoveredJournal.mode), JSON.stringify(manifest.recoveredJournal));
    noPendingState(home);
    const checks = doctorChecks(home);
    assert.ok(!checks.some((c) => !c.ok), `doctor green after recovery: ${JSON.stringify(checks.filter((c) => !c.ok))}`);
  });
}

await t('destroyed stage after mid-swaps crash: forward sources gone → executed ROLLBACK from backups + inline contents, then fresh install succeeds', () => {
  const home = sandbox('stageless');
  const crashed = run('install.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: 'mid-swaps' });
  assert.strictEqual(crashed.signal, 'SIGKILL');
  const stage = fs.readdirSync(home).find((n) => n.startsWith('.agentsmd-stage-'));
  assert.ok(stage, 'crashed stage present');
  fs.rmSync(path.join(home, stage), { recursive: true, force: true });
  const healed = run('install.js', ['--json'], { CODEX_HOME: home });
  assert.strictEqual(healed.status, 0, healed.stderr);
  assert.strictEqual(JSON.parse(healed.stdout).recoveredJournal.mode, 'rollback', 'without staged trees the executable direction is rollback');
  noPendingState(home);
});

await t('conflict (foreign change on a journaled target) fails closed: entries refuse, bytes + journal preserved, doctor says not auto-recoverable', () => {
  const home = sandbox('conflict');
  const crashed = run('install.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: 'mid-writes' });
  assert.strictEqual(crashed.signal, 'SIGKILL');
  const foreign = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"echo other-tenant"}]}]}}\n';
  fs.writeFileSync(path.join(home, 'hooks.json'), foreign);
  const refused = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(refused.status, 1, 'conflict must refuse');
  assert.ok(/not auto-recoverable|bytes preserved/.test(refused.stderr), refused.stderr);
  assert.strictEqual(fs.readFileSync(path.join(home, 'hooks.json'), 'utf8'), foreign, 'foreign bytes preserved');
  assert.ok(fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'journal preserved as evidence');
  const check = doctorChecks(home).find((c) => c.name === 'no pending lifecycle transaction');
  assert.ok(check && !check.ok && /NOT auto-recoverable/.test(check.detail), JSON.stringify(check));
});

const UNINSTALL_MATRIX = ['u-after-journal', 'u-mid-files', 'u-after-quarantine', 'u-before-cleanup'];

for (const point of UNINSTALL_MATRIX) {
  await t(`uninstall SIGKILL at ${point}: re-run uninstall recovers and completes the removal`, () => {
    const home = sandbox(point);
    const seeded = run('install.js', [], { CODEX_HOME: home });
    assert.strictEqual(seeded.status, 0, seeded.stderr);
    const crashed = run('uninstall.js', [], { CODEX_HOME: home, AGENTSMD_TEST_CRASH_AT: point });
    assert.strictEqual(crashed.signal, 'SIGKILL', `uninstall must die at ${point}\n${crashed.stderr}`);
    assert.ok(fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'uninstall journal survived');
    const rerun = run('uninstall.js', [], { CODEX_HOME: home });
    assert.strictEqual(rerun.status, 0, `${point}: uninstall re-run must recover: ${rerun.stderr}`);
    // Complete OLD-or-NEW: the final state is a FULL uninstall (the state dir
    // may legitimately survive holding backups — uninstall preserves those).
    assert.ok(!fs.existsSync(path.join(home, '.agentsmd-state', 'manifest.json')), 'manifest gone');
    const agents = fs.existsSync(path.join(home, 'AGENTS.md')) ? fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8') : '';
    assert.ok(!agents.includes('>>> agentsmd >>>'), 'sentinel block gone');
    const hooks = fs.existsSync(path.join(home, 'hooks.json')) ? fs.readFileSync(path.join(home, 'hooks.json'), 'utf8') : '';
    assert.ok(!hooks.includes('/agentsmd/'), 'no agentsmd hook entries remain');
    assert.ok(!fs.existsSync(path.join(home, '.agentsmd-lifecycle-journal.json')), 'no pending journal after recovery');
  });
}

await t('doctor names the exact recovery command per action (update vs uninstall)', () => {
  const homeA = sandbox('cmd-install');
  const c1 = run('install.js', [], { CODEX_HOME: homeA, AGENTSMD_TEST_CRASH_AT: 'mid-writes' });
  assert.strictEqual(c1.signal, 'SIGKILL');
  const checkA = doctorChecks(homeA).find((c) => c.name === 'no pending lifecycle transaction');
  assert.ok(checkA && !checkA.ok && /`agentsmd update`/.test(checkA.detail) && /recovery plan from disk: (roll-forward|rollback)/.test(checkA.detail), JSON.stringify(checkA));
  const homeB = sandbox('cmd-uninstall');
  assert.strictEqual(run('install.js', [], { CODEX_HOME: homeB }).status, 0);
  const c2 = run('uninstall.js', [], { CODEX_HOME: homeB, AGENTSMD_TEST_CRASH_AT: 'u-mid-files' });
  assert.strictEqual(c2.signal, 'SIGKILL');
  const checkB = doctorChecks(homeB).find((c) => c.name === 'no pending lifecycle transaction');
  assert.ok(checkB && !checkB.ok && /`agentsmd uninstall`/.test(checkB.detail), JSON.stringify(checkB));
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
    const check = doctorChecks(home).find((c) => c.name === 'no pending lifecycle transaction');
    assert.ok(check && check.ok && /in progress/.test(check.detail), JSON.stringify(check));
  } finally {
    await new Promise((resolve) => { holder.on('exit', resolve); holder.kill('SIGKILL'); });
  }
});

for (const d of SANDBOXES) fs.rmSync(d, { recursive: true, force: true }); // §8.V4

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);

})();
