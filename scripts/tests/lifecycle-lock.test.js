'use strict';
// lifecycle-lock.test.js — R2-01: one writer per $CODEX_HOME across install /
// update / uninstall / restore --confirm / repair --confirm. Proves the H-04
// acceptance matrix deterministically: while a real holder process owns the lock,
// every mutating entry point refuses with exit 1 and a byte-identical sandbox
// (fingerprint), and a true N-way concurrent acquire admits exactly one owner.
// Stale-lock policy: dead pid → immediate reclaim; live pid with verified
// start-time → never stolen (lease irrelevant); recycled pid (start-time
// mismatch) → reclaim; unreadable owner.json → reclaim only past the 60 s grace.
// Everything runs in mkdtemp sandboxes (§8.V3) and disposes them (§8.V4).

const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const assert = require('assert');

let PASS = 0, FAIL = 0;
const t = (n, f) => Promise.resolve().then(f).then(
  () => { PASS++; console.log('  ok   ' + n); },
  (e) => { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); }
);

const SCRIPTS = path.join(__dirname, '..');
const LOCK_LIB = path.join(SCRIPTS, 'lib', 'lifecycle-lock.js');
const LOCK_DIRNAME = require(LOCK_LIB).LOCK_DIRNAME;

function fingerprint(root) {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      h.update(path.relative(root, full));
      if (e.isDirectory()) walk(full);
      else if (e.isFile()) { h.update(String(fs.statSync(full).mode)); h.update(fs.readFileSync(full)); }
      else if (e.isSymbolicLink()) h.update(fs.readlinkSync(full));
    }
  };
  walk(root);
  return h.digest('hex');
}

function run(script, args, env, input) {
  return cp.spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    encoding: 'utf8', env: { ...process.env, ...env }, input: input || undefined,
  });
}

// Spawn a real process that acquires the sandbox's lock and holds it until killed.
function spawnHolder(codexHome) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn(process.execPath, ['-e', `
      const L = require(${JSON.stringify(LOCK_LIB)});
      L.acquire('install');
      console.log('HELD');
      setInterval(() => {}, 1000);
    `], { env: { ...process.env, CODEX_HOME: codexHome }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; if (out.includes('HELD')) resolve(child); });
    child.on('exit', (code) => reject(new Error(`holder exited early (${code})`)));
    setTimeout(() => reject(new Error('holder never reported HELD')), 10000).unref();
  });
}

const killAndWait = (child) => new Promise((resolve) => { child.on('exit', resolve); child.kill('SIGKILL'); });

const SANDBOXES = [];
const sandbox = (name) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `agentsmd-lock-${name}-`));
  SANDBOXES.push(d);
  return d;
};

function lockWorker(home, mode = 'hold') {
  const child = cp.spawn(process.execPath, [path.join(__dirname, 'fixtures', 'lifecycle-lock-worker.js'), mode], {
    env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = [];
  let pending = null, buffer = '', errors = '';
  child.stdout.on('data', (data) => {
    buffer += data;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, end)));
      buffer = buffer.slice(end + 1);
    }
    if (pending && lines.length) { const done = pending; pending = null; done.resolve(lines.shift()); }
  });
  child.stderr.on('data', (data) => { errors += data; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => {
    resolve({ code, signal });
    if (pending) { pending.reject(new Error(`worker exited: ${code}/${signal}: ${errors}`)); pending = null; }
  }));
  return {
    child,
    next: () => {
      if (lines.length) return Promise.resolve(lines.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending = null; reject(new Error(`worker barrier timeout: ${errors}`)); }, 10000);
        pending = { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } };
      });
    },
    resume: () => child.stdin.write('\n'),
    stop: async () => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; },
    exited,
  };
}

async function deadLock(home) {
  const holder = await spawnHolder(home);
  await killAndWait(holder);
}

function claimFile(home, index) {
  const dir = path.join(home, LOCK_DIRNAME);
  const stat = fs.statSync(dir);
  return path.join(dir, `.reap-${stat.dev}-${stat.ino}-${index}.json`);
}

(async () => {

await t('acquire creates a private lock naming the owner; release removes it; reentrant depth works', () => {
  const home = sandbox('unit');
  const child = cp.spawnSync(process.execPath, ['-e', `
    const fs = require('fs'), path = require('path');
    const L = require(${JSON.stringify(LOCK_LIB)});
    const h1 = L.acquire('install');
    const dir = L.lockDir();
    const owner = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'));
    const mode = (fs.statSync(path.join(dir, 'owner.json')).mode & 0o777).toString(8);
    if (owner.pid !== process.pid || owner.action !== 'install' || owner.schemaVersion !== 1) throw new Error('owner fields');
    if (!/^\\d{4}-\\d{2}-\\d{2}T/.test(owner.startedAt) || !Number.isInteger(owner.leaseMs)) throw new Error('timestamp/lease shape');
    if (mode !== '600') throw new Error('owner.json mode ' + mode);
    const h2 = L.acquire('repair');            // reentrant (repair --confirm drives install in-process)
    if (h2 !== h1) throw new Error('reentrant acquire must return the held handle');
    L.release(h2);
    if (!fs.existsSync(dir)) throw new Error('inner release must not drop the lock');
    L.release(h1);
    if (fs.existsSync(dir)) throw new Error('outer release must remove the lock');
    console.log('UNIT-OK');
  `], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
  assert.strictEqual(child.status, 0, child.stderr);
  assert.ok(child.stdout.includes('UNIT-OK'));
});

await t('acceptance matrix: held lock → install/update, uninstall, restore --confirm, repair --confirm all refuse with zero mutation', async () => {
  const home = sandbox('matrix');
  // Real installed state so every entry point has something it WOULD mutate.
  // Installed TWICE: the second run's pre-install backup snapshots the 'present'
  // state, so restore's read-only planning succeeds and the --confirm path
  // actually reaches the lock (a fresh install's backup mismatches and exits
  // during planning, before any mutation attempt).
  for (let i = 0; i < 2; i++) {
    const seeded = run('install.js', [], { CODEX_HOME: home });
    assert.strictEqual(seeded.status, 0, seeded.stderr);
  }
  const holder = await spawnHolder(home);
  try {
    const before = fingerprint(home);
    const attempts = [
      ['install.js', []],
      ['uninstall.js', []],
      ['restore.js', ['--confirm']],
      ['repair.js', [`--confirm=${'a'.repeat(64)}`]],
    ];
    for (const [script, args] of attempts) {
      const r = run(script, args, { CODEX_HOME: home });
      assert.strictEqual(r.status, 1, `${script} must refuse (got ${r.status})\n${r.stdout}\n${r.stderr}`);
      assert.ok(/lifecycle lock/.test(r.stderr), `${script} stderr names the lock: ${r.stderr}`);
      assert.ok(/pid \d+/.test(r.stderr) && /started \d{4}-/.test(r.stderr), `${script} stderr names owner pid + start: ${r.stderr}`);
      assert.strictEqual(fingerprint(home), before, `${script} loser must leave the sandbox byte-identical`);
    }
  } finally { await killAndWait(holder); }
});

await t('dead owner (SIGKILL mid-hold) → next lifecycle run reclaims and succeeds', async () => {
  const home = sandbox('dead');
  const holder = await spawnHolder(home);
  await killAndWait(holder); // crash: lock dir left behind, owner pid gone
  assert.ok(fs.existsSync(path.join(home, LOCK_DIRNAME)), 'crashed holder leaves the lock');
  const r = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(r.status, 0, `install must reclaim the dead lock: ${r.stderr}`);
  assert.ok(!fs.existsSync(path.join(home, LOCK_DIRNAME)), 'lock released after the reclaimed run');
  assert.ok(fs.existsSync(path.join(home, '.agentsmd-state', 'manifest.json')), 'reclaimed run completed');
});

await t('a delayed stale observation cannot reclaim a newly acquired lock generation', async () => {
  const home = sandbox('stale-observation');
  await deadLock(home);
  const a = lockWorker(home, 'after-owner-read');
  let b;
  try {
    assert.strictEqual((await a.next()).event, 'after-owner-read');
    b = lockWorker(home);
    assert.strictEqual((await b.next()).event, 'acquired');
    const before = fingerprint(home);
    a.resume();
    assert.strictEqual((await a.next()).event, 'refused', 'old observation must not admit a second holder');
    assert.strictEqual((await a.exited).code, 1);
    assert.strictEqual(fingerprint(home), before, 'new holder and its bytes must remain unchanged');
    b.resume();
    assert.strictEqual((await b.next()).event, 'released');
  } finally { await a.stop(); if (b) await b.stop(); }
});

await t('a delayed preparation cannot poison the next generation with an unrecoverable claim', async () => {
  const home = sandbox('delayed-preparation');
  await deadLock(home);
  const a = lockWorker(home, 'before-prepared');
  let b;
  try {
    assert.strictEqual((await a.next()).event, 'before-prepared');
    b = lockWorker(home);
    assert.strictEqual((await b.next()).event, 'acquired');
    const before = fingerprint(home);
    a.resume();
    assert.strictEqual((await a.next()).event, 'refused');
    assert.strictEqual((await a.exited).code, 1);
    assert.strictEqual(fingerprint(home), before, 'new generation must not inherit the old generation claim');
  } finally { await a.stop(); if (b) await b.stop(); }
  const recovered = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(recovered.status, 0, recovered.stderr);
  assert.ok(!fs.existsSync(path.join(home, LOCK_DIRNAME)));
});

await t('an old-generation stray publication cannot block the current generation recovery', async () => {
  const home = sandbox('stray-publication');
  await deadLock(home);
  const oldFile = claimFile(home, 0);
  const a = lockWorker(home, 'before-rename');
  let oldClaim;
  try {
    assert.strictEqual((await a.next()).event, 'before-rename');
    oldClaim = fs.readFileSync(oldFile);
    a.resume();
    assert.strictEqual((await a.next()).event, 'acquired');
    // Inject the possible result of source/destination lookup straddling a
    // directory replacement; this does not claim to schedule inside link() or
    // assume that the filesystem never reuses a just-deleted directory inode.
    const current = fs.statSync(path.join(home, LOCK_DIRNAME));
    const stray = { ...JSON.parse(oldClaim), dev: String(current.dev), ino: String(BigInt(current.ino) + 1n) };
    const strayFile = path.join(home, LOCK_DIRNAME, `.reap-${stray.dev}-${stray.ino}-0.json`);
    fs.writeFileSync(strayFile, JSON.stringify(stray));
  } finally { await a.stop(); }
  const r = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.deepStrictEqual(fs.readdirSync(home).filter((name) => name.startsWith(LOCK_DIRNAME)), []);
});

await t('a live reclaimer excludes another reclaimer across the final rename boundary', async () => {
  const home = sandbox('reap-rename');
  await deadLock(home);
  const a = lockWorker(home, 'before-rename');
  let b;
  try {
    assert.strictEqual((await a.next()).event, 'before-rename');
    const before = fingerprint(home);
    b = lockWorker(home);
    assert.strictEqual((await b.next()).event, 'refused', 'live claim must exclude competing takeover');
    assert.strictEqual((await b.exited).code, 1);
    assert.strictEqual(fingerprint(home), before, 'loser must preserve claim and old generation');
    a.resume();
    assert.strictEqual((await a.next()).event, 'acquired');
    a.resume();
    assert.strictEqual((await a.next()).event, 'released');
  } finally { await a.stop(); if (b) await b.stop(); }
});

await t('crashed prepared writer leaves no published partial claim and recovery preserves neighbors', async () => {
  const home = sandbox('prepared-crash');
  const neighbor = path.join(home, 'tenant.txt');
  fs.writeFileSync(neighbor, 'preserve tenant bytes');
  await deadLock(home);
  const a = lockWorker(home, 'prepared');
  try {
    assert.strictEqual((await a.next()).event, 'prepared');
    const names = fs.readdirSync(path.join(home, LOCK_DIRNAME));
    assert.ok(names.some((name) => name.startsWith('.reap-prepared-')));
    assert.ok(!names.some((name) => /^\.reap-\d+-\d+-\d+\.json$/.test(name)), 'unpublished preparation is not a claim');
  } finally { await a.stop(); }
  const r = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.strictEqual(fs.readFileSync(neighbor, 'utf8'), 'preserve tenant bytes');
  assert.deepStrictEqual(fs.readdirSync(home).filter((name) => name.startsWith(LOCK_DIRNAME)), []);
});

await t('two successors of a killed claimant still admit one live reclaimer without reusing its claim', async () => {
  const home = sandbox('claim-crash');
  await deadLock(home);
  const a = lockWorker(home, 'before-rename');
  try { assert.strictEqual((await a.next()).event, 'before-rename'); }
  finally { await a.stop(); }
  const firstFile = claimFile(home, 0);
  const first = fs.readFileSync(firstFile);
  assert.strictEqual(fs.statSync(firstFile).mode & 0o777, 0o600);
  const b = lockWorker(home, 'before-rename');
  let c;
  try {
    assert.strictEqual((await b.next()).event, 'before-rename');
    assert.ok(fs.readFileSync(firstFile).equals(first), 'dead claim stays immutable');
    assert.ok(fs.existsSync(claimFile(home, 1)));
    const before = fingerprint(home);
    c = lockWorker(home);
    assert.strictEqual((await c.next()).event, 'refused');
    assert.strictEqual((await c.exited).code, 1);
    assert.strictEqual(fingerprint(home), before);
    b.resume();
    assert.strictEqual((await b.next()).event, 'acquired');
    b.resume();
    assert.strictEqual((await b.next()).event, 'released');
  } finally { await b.stop(); if (c) await c.stop(); }
});

await t('post-rename crash recovery cleans only a proven quarantine and completes an actual update', async () => {
  const home = sandbox('quarantine-crash');
  fs.writeFileSync(path.join(home, 'AGENTS.md'), 'Tenant guidance\n');
  assert.strictEqual(run('install.js', [], { CODEX_HOME: home }).status, 0);
  const unknown = path.join(home, `${LOCK_DIRNAME}.stale-0-${'a'.repeat(32)}`);
  fs.mkdirSync(unknown);
  fs.writeFileSync(path.join(unknown, 'tenant'), 'keep unknown quarantine');
  const linked = path.join(home, `${LOCK_DIRNAME}.stale-0-${'b'.repeat(32)}`);
  fs.symlinkSync(unknown, linked, 'dir');
  await deadLock(home);
  const a = lockWorker(home, 'after-rename');
  let moved;
  try {
    assert.strictEqual((await a.next()).event, 'after-rename');
    assert.ok(!fs.existsSync(path.join(home, LOCK_DIRNAME)));
    moved = fs.readdirSync(home).find((name) => name.startsWith(`${LOCK_DIRNAME}.stale-`) && ![path.basename(unknown), path.basename(linked)].includes(name));
    assert.ok(moved);
  } finally { await a.stop(); }
  const r = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(home, moved)), 'dead proven quarantine is disposed');
  assert.ok(!fs.existsSync(path.join(home, LOCK_DIRNAME)), 'update releases the current lock');
  assert.strictEqual(fs.readFileSync(path.join(unknown, 'tenant'), 'utf8'), 'keep unknown quarantine');
  assert.ok(fs.lstatSync(linked).isSymbolicLink(), 'unknown symlink remains a symlink');
  assert.ok(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8').startsWith('Tenant guidance\n'));
  assert.strictEqual(run('doctor.js', [], { CODEX_HOME: home }).status, 0, 'recovered update remains healthy');
});

await t('invalid, symlinked, foreign-host and unverifiable live claims refuse without deleting evidence', async () => {
  const home = sandbox('claim-near-negatives');
  await deadLock(home);
  const a = lockWorker(home, 'before-rename');
  try { assert.strictEqual((await a.next()).event, 'before-rename'); }
  finally { await a.stop(); }
  const file = claimFile(home, 0);
  const original = JSON.parse(fs.readFileSync(file, 'utf8'));
  const external = path.join(home, 'neighbor.json');
  fs.writeFileSync(external, JSON.stringify(original));
  const variants = [
    () => fs.writeFileSync(file, '{broken'),
    () => { fs.unlinkSync(file); fs.symlinkSync(external, file); },
    () => { fs.unlinkSync(file); fs.writeFileSync(file, JSON.stringify({ ...original, host: 'another-host.invalid' })); },
    () => fs.writeFileSync(file, JSON.stringify({ ...original, pid: process.pid, pidStartTime: null, startedAt: '2000-01-01T00:00:00Z', leaseMs: 1 })),
  ];
  for (const variant of variants) {
    variant();
    const before = fingerprint(home);
    const b = lockWorker(home);
    try {
      assert.strictEqual((await b.next()).event, 'refused');
      assert.strictEqual((await b.exited).code, 1);
      assert.strictEqual(fingerprint(home), before);
    } finally { await b.stop(); }
  }
});

await t('unsupported hard links and an exhausted claim chain refuse rather than stealing a lock', async () => {
  const home = sandbox('reap-bounds');
  await deadLock(home);
  const before = fingerprint(home);
  const unsupported = lockWorker(home, 'no-hardlinks');
  try {
    assert.strictEqual((await unsupported.next()).event, 'refused');
    assert.strictEqual((await unsupported.exited).code, 1);
    assert.strictEqual(fingerprint(home), before);
  } finally { await unsupported.stop(); }
  const a = lockWorker(home, 'before-rename');
  try { assert.strictEqual((await a.next()).event, 'before-rename'); }
  finally { await a.stop(); }
  const claim = fs.readFileSync(claimFile(home, 0));
  for (let index = 1; index < 64; index++) fs.writeFileSync(claimFile(home, index), claim);
  const full = fingerprint(home);
  const b = lockWorker(home);
  try {
    assert.strictEqual((await b.next()).event, 'refused');
    assert.strictEqual((await b.exited).code, 1);
    assert.strictEqual(fingerprint(home), full);
  } finally { await b.stop(); }
});

await t('live owner with verified start-time is NEVER stolen, even with an expired lease; recycled pid is', async () => {
  const home = sandbox('lease');
  const L = require(LOCK_LIB);
  const holder = await spawnHolder(home);
  try {
    // Force the on-disk lease to be long expired; owner is verifiably alive.
    const ownerFile = path.join(home, LOCK_DIRNAME, 'owner.json');
    const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'));
    assert.ok(owner.pidStartTime, 'holder recorded a verifiable start-time on this platform');
    owner.startedAt = new Date(Date.now() - 3600_000).toISOString();
    owner.leaseMs = 1;
    fs.writeFileSync(ownerFile, JSON.stringify(owner) + '\n');
    const refused = run('install.js', [], { CODEX_HOME: home });
    assert.strictEqual(refused.status, 1, 'verified-alive owner must not be stolen');
    assert.ok(/lifecycle lock/.test(refused.stderr));
    // Recycled pid: same pid claimed, but a start-time that cannot match → stale.
    owner.pidStartTime = 'jiffies:1';
    fs.writeFileSync(ownerFile, JSON.stringify(owner) + '\n');
    assert.strictEqual(L.inspectLock(path.join(home, LOCK_DIRNAME)).state, 'stale', 'start-time mismatch = recycled pid = stale');
    const reclaimed = run('install.js', [], { CODEX_HOME: home });
    assert.strictEqual(reclaimed.status, 0, `recycled-pid lock must be reclaimed: ${reclaimed.stderr}`);
  } finally { await killAndWait(holder); }
});

await t('unreadable owner.json: fresh lock refused (mid-write grace); past 60 s grace it is reclaimed', () => {
  const home = sandbox('grace');
  const L = require(LOCK_LIB);
  const dir = path.join(home, LOCK_DIRNAME);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'owner.json'), 'not json{');
  assert.strictEqual(L.inspectLock(dir).state, 'live', 'fresh unreadable lock = possible mid-write = live');
  const refused = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(refused.status, 1, 'fresh unreadable lock refuses');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(dir, old, old);
  assert.strictEqual(L.inspectLock(dir).state, 'stale', 'past grace = stale');
  const r = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(r.status, 0, `stale unreadable lock must be reclaimed: ${r.stderr}`);
});

await t('N-way simultaneous acquire admits exactly one owner', async () => {
  const home = sandbox('nway');
  const N = 6;
  const results = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
    const child = cp.spawn(process.execPath, ['-e', `
      const L = require(${JSON.stringify(LOCK_LIB)});
      try { L.acquire('install'); console.log('ACQUIRED'); setTimeout(() => process.exit(0), 700); }
      catch (e) { console.log(e.code === 'AGENTSMD_LOCK_HELD' ? 'LOCKED' : 'ERROR:' + e.message); process.exit(0); }
    `], { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.on('exit', () => resolve(out.trim()));
  })));
  const acquired = results.filter((r) => r === 'ACQUIRED').length;
  const locked = results.filter((r) => r === 'LOCKED').length;
  assert.strictEqual(acquired, 1, `exactly one owner (got ${acquired}: ${results.join(', ')})`);
  assert.strictEqual(locked, N - 1, `all others refused cleanly (${results.join(', ')})`);
});

await t('true concurrent install.js race: one healthy final tree, losers name the lock, no stage/lock residue', async () => {
  const home = sandbox('race');
  const N = 4;
  const results = await Promise.all(Array.from({ length: N }, () => new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [path.join(SCRIPTS, 'install.js')],
      { env: { ...process.env, CODEX_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('exit', (code) => resolve({ code, out, err }));
  })));
  const winners = results.filter((r) => r.code === 0);
  const losers = results.filter((r) => r.code !== 0);
  assert.ok(winners.length >= 1, `at least one install wins: ${results.map((r) => r.code).join(',')}`);
  for (const l of losers) assert.ok(/lifecycle lock/.test(l.err), `loser stderr names the lock: ${l.err}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(home, '.agentsmd-state', 'manifest.json'), 'utf8'));
  assert.ok(manifest.version, 'final tree carries a valid manifest');
  const residue = fs.readdirSync(home).filter((n) => n.startsWith('.agentsmd-stage-') || n.startsWith(LOCK_DIRNAME));
  assert.deepStrictEqual(residue, [], `no stage/lock residue: ${residue.join(', ')}`);
});

await t('release after a legitimate takeover must not delete the new owner\'s lock', () => {
  const home = sandbox('takeover');
  const r = cp.spawnSync(process.execPath, ['-e', `
    const fs = require('fs'), path = require('path');
    const L = require(${JSON.stringify(LOCK_LIB)});
    const h = L.acquire('install');
    const dir = L.lockDir();
    // Simulate: lease expired, another process reclaimed and now owns the lock.
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid: 99999, txid: 'other-txid', action: 'install', startedAt: new Date().toISOString(), leaseMs: 900000 }) + '\\n');
    L.release(h);
    if (!fs.existsSync(path.join(dir, 'owner.json'))) throw new Error('stale holder deleted the new owner lock');
    console.log('TAKEOVER-OK');
  `], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
  assert.strictEqual(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes('TAKEOVER-OK'));
});

await t('doctor: live lock passes with an in-progress note; stale lock fails with a remedy; no lock adds no check', async () => {
  const home = sandbox('doctor');
  const seeded = run('install.js', [], { CODEX_HOME: home });
  assert.strictEqual(seeded.status, 0, seeded.stderr);
  const doctorChecks = () => {
    const r = cp.spawnSync(process.execPath, ['-e',
      `console.log(JSON.stringify(require(${JSON.stringify(path.join(SCRIPTS, 'doctor.js'))}).doctor().checks))`],
      { encoding: 'utf8', env: { ...process.env, CODEX_HOME: home } });
    assert.strictEqual(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  assert.ok(!doctorChecks().some((c) => c.name === 'no stale lifecycle lock'), 'no lock → no lock check row');
  const holder = await spawnHolder(home);
  try {
    const liveCheck = doctorChecks().find((c) => c.name === 'no stale lifecycle lock');
    assert.ok(liveCheck && liveCheck.ok && /in progress/.test(liveCheck.detail), JSON.stringify(liveCheck));
  } finally { await killAndWait(holder); }
  const staleCheck = doctorChecks().find((c) => c.name === 'no stale lifecycle lock');
  assert.ok(staleCheck && !staleCheck.ok && /self-clears/.test(staleCheck.detail), JSON.stringify(staleCheck));
});

for (const d of SANDBOXES) fs.rmSync(d, { recursive: true, force: true }); // §8.V4

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);

})();
