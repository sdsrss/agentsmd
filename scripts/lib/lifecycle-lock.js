'use strict';
// lifecycle-lock.js — cross-process mutual exclusion for every mutating lifecycle
// operation on one $CODEX_HOME (install / update / uninstall / restore --confirm /
// repair --confirm). H-04: two concurrent writers could interleave staged swaps
// and shared-file merges into a state neither would produce alone. The lock makes
// contention explicit: exactly one writer proceeds, the loser exits with zero
// mutation and a message naming the owner.
//
// Mechanics:
// - Acquisition is an atomic non-recursive mkdir of $CODEX_HOME/.agentsmd-lifecycle-lock
//   (deliberately OUTSIDE .agentsmd-state/ — uninstall removes the state dir and
//   must not delete its own lock mid-operation). Owner metadata lands in owner.json
//   (0600) right after the mkdir wins.
// - Reentrant per process via a module singleton: repair --confirm calls install()
//   in-process; both require this same module instance, so the inner acquire only
//   bumps a depth counter.
// - Reclaim policy (the R2-03 "no permanent ownership lockout" pre-commitment):
//     owner pid alive + recorded start-time matches  → NEVER reclaimed (lease irrelevant)
//     pid dead, or start-time mismatch (recycled pid) → stale, reclaim immediately
//     start-time unverifiable (no /proc, no ps)       → reclaim only after the lease expires
//     owner.json unreadable (mid-write window)        → reclaim only when the lock dir
//                                                       mtime is older than a 60 s grace
//   Reclaim uses an append-only chain of atomically published claims inside the
//   old directory. Only a provably dead local claimant can be succeeded; claim
//   names are never deleted/reused before the entire generation is quarantined.
//   This binds the stale decision to a generation instead of a reusable path.
// - Release verifies the txid before removing: if the lease expired mid-run and
//   another process legitimately reclaimed, the stale holder must not delete the
//   new owner's lock.
// L1 hooks never touch this file (L1→L2 isolation invariant).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const P = require('./paths');

const LOCK_DIRNAME = '.agentsmd-lifecycle-lock';
const DEFAULT_LEASE_MS = 15 * 60 * 1000; // lifecycle ops take seconds; 100x headroom
const UNREADABLE_GRACE_MS = 60 * 1000;   // mkdir-won-but-owner.json-not-yet-written window
const MAX_REAP_CLAIMS = 64;
const REAP_KIND = 'agentsmd-lifecycle-reap-v1';

let held = null; // module singleton → same-process reentrancy

function lockDir() { return path.join(P.codexHome(), LOCK_DIRNAME); }
function ownerPath(dir) { return path.join(dir, 'owner.json'); }

function leaseMs(env = process.env) {
  const raw = env.AGENTSMD_LIFECYCLE_LEASE_MS;
  if (raw !== undefined) {
    const n = Number.parseInt(raw, 10);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_LEASE_MS;
}

// Best-effort process start-time fingerprint, to tell a live owner apart from an
// unrelated process that recycled its pid. Linux: /proc/<pid>/stat field 22
// (starttime in jiffies — stable for the process's lifetime). Fallback: ps lstart.
// null = unverifiable (the lease becomes the backstop).
function processStartTime(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm may contain spaces/parens; fields are counted after the LAST ')'.
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const starttime = rest[19]; // field 22 overall; 20th after pid+comm+state
    if (starttime && /^[0-9]+$/.test(starttime)) return `jiffies:${starttime}`;
  } catch { /* not Linux or pid gone */ }
  try {
    const cp = require('child_process');
    const r = cp.spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000 });
    const out = (r.stdout || '').trim();
    if (r.status === 0 && out) return `lstart:${out}`;
  } catch { /* no ps */ }
  return null;
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (e) { return e.code === 'EPERM'; } // EPERM = exists, other user
}

function readOwner(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(ownerPath(dir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch { return null; }
}

// Classify an existing lock: {state: 'live'|'stale', owner}. Conservative — a
// lock we cannot prove stale is live (refusing is always mutation-safe).
function inspectLock(dir, now = Date.now()) {
  const owner = readOwner(dir);
  if (!owner) {
    let mtimeMs = now;
    try { mtimeMs = fs.statSync(dir).mtimeMs; } catch { return { state: 'stale', owner: null }; } // vanished → treat as reclaimable; rename below settles the race
    return { state: now - mtimeMs > UNREADABLE_GRACE_MS ? 'stale' : 'live', owner: null };
  }
  const startedAtMs = Date.parse(owner.startedAt || '') || 0;
  const lease = Number.isInteger(owner.leaseMs) && owner.leaseMs > 0 ? owner.leaseMs : DEFAULT_LEASE_MS;
  const leaseExpired = now - startedAtMs > lease;
  if (owner.host && owner.host !== os.hostname()) {
    // Cannot probe a foreign host's pid ($CODEX_HOME on a shared filesystem):
    // the lease is the only signal.
    return { state: leaseExpired ? 'stale' : 'live', owner };
  }
  if (!pidAlive(owner.pid)) return { state: 'stale', owner };
  const currentStart = processStartTime(owner.pid);
  if (owner.pidStartTime && currentStart && owner.pidStartTime !== currentStart) {
    return { state: 'stale', owner }; // pid recycled → original owner is dead
  }
  if (owner.pidStartTime && currentStart) return { state: 'live', owner }; // verified alive → lease irrelevant
  return { state: leaseExpired ? 'stale' : 'live', owner }; // unverifiable → lease backstop
}

function generation(dir) {
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    let owner = null;
    try { owner = fs.readFileSync(ownerPath(dir), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') return null; }
    return { dev: String(stat.dev), ino: String(stat.ino), owner };
  } catch { return null; }
}

function sameGeneration(left, right) {
  return !!left && !!right && left.dev === right.dev && left.ino === right.ino && left.owner === right.owner;
}

function claimPath(dir, index, identity) {
  return path.join(dir, `.reap-${identity.dev}-${identity.ino}-${index}.json`);
}

function readClaim(file) {
  let fd;
  try {
    const before = fs.lstatSync(file);
    if (!before.isFile() || before.isSymbolicLink()) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096 || stat.dev !== before.dev || stat.ino !== before.ino) return null;
    const claim = JSON.parse(fs.readFileSync(fd, 'utf8'));
    if (claim.kind !== REAP_KIND || !/^[a-f0-9]{32}$/.test(claim.token)
        || !Number.isInteger(claim.pid) || claim.pid <= 0 || typeof claim.host !== 'string'
        || !(claim.pidStartTime === null || typeof claim.pidStartTime === 'string')
        || typeof claim.dev !== 'string' || typeof claim.ino !== 'string') return null;
    return claim;
  } catch { return null; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

function claimantDead(claim) {
  // A lease cannot prove that a paused reclaimer will never resume its rename.
  if (!claim || claim.host !== os.hostname()) return false;
  if (!pidAlive(claim.pid)) return true;
  const start = processStartTime(claim.pid);
  return !!(claim.pidStartTime && start && claim.pidStartTime !== start);
}

function removeQuarantine(target, index, token, requireDead) {
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const claim = readClaim(claimPath(target, index, stat));
    if (!claim || claim.token !== token
        || claim.dev !== String(stat.dev) || claim.ino !== String(stat.ino)
        || (requireDead && !claimantDead(claim))) return;
    // This exact random quarantine name is never reused by the protocol.
    fs.rmSync(target, { recursive: true, force: true });
  } catch { /* Preserve unverified or inaccessible recovery material. */ }
}

function sweepQuarantines(dir) {
  let entries;
  try { entries = fs.readdirSync(path.dirname(dir), { withFileTypes: true }); } catch { return; }
  let inspected = 0;
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(`${LOCK_DIRNAME}.stale-`)) continue;
    const match = /^([0-9]+)-([a-f0-9]{32})$/.exec(entry.name.slice(`${LOCK_DIRNAME}.stale-`.length));
    if (!match || Number(match[1]) >= MAX_REAP_CLAIMS) continue;
    if (++inspected > MAX_REAP_CLAIMS) break;
    removeQuarantine(path.join(path.dirname(dir), entry.name), Number(match[1]), match[2], true);
  }
}

function reclaim(dir, before, verdict) {
  if (!sameGeneration(before, generation(dir))) return false;
  const claim = {
    kind: REAP_KIND, token: crypto.randomBytes(16).toString('hex'),
    pid: process.pid, pidStartTime: processStartTime(process.pid), host: os.hostname(),
    dev: before.dev, ino: before.ino,
  };
  const prepared = path.join(dir, `.reap-prepared-${claim.token}`);
  try {
    // Publish complete metadata with link(), not open('wx') followed by a write:
    // a killed writer must never leave a partially initialized official claim.
    fs.writeFileSync(prepared, `${JSON.stringify(claim)}\n`, { flag: 'wx', mode: 0o600 });
    if (!sameGeneration(before, generation(dir))) return false;
    for (let index = 0; index < MAX_REAP_CLAIMS; index++) {
      // Generation-qualified names keep a stray old-generation publication out
      // of a replacement directory's claim chain, even across link path lookup.
      const file = claimPath(dir, index, before);
      try { fs.linkSync(prepared, file); }
      catch (error) {
        if (error.code !== 'EEXIST') return false;
        const previous = readClaim(file);
        if (!previous || previous.dev !== before.dev || previous.ino !== before.ino || !claimantDead(previous)) return false;
        continue;
      }
      // Claimed nodes remain immutable even if this attempt is abandoned.
      // Our coordination writes change the root mtime: for an unreadable owner,
      // retain the already-established grace verdict only while its exact bytes
      // and directory identity remain unchanged. A newly published owner aborts.
      if (!sameGeneration(before, generation(dir)) || readClaim(file)?.token !== claim.token
          || (verdict.owner && inspectLock(dir).state !== 'stale')) return false;
      const tombstone = `${dir}.stale-${index}-${claim.token}`;
      fs.renameSync(dir, tombstone);
      removeQuarantine(tombstone, index, claim.token, false);
      return true;
    }
    return false;
  } catch { return false; }
  finally {
    // Only a task-unique prepared name; never unlink a published claim node.
    try { fs.unlinkSync(prepared); } catch { /* Moved with the old generation. */ }
  }
}

function lockHeldError(owner, recovery = false) {
  const who = owner
    ? `${owner.action || 'unknown-action'} (pid ${owner.pid}, started ${owner.startedAt || 'unknown'}${owner.host ? `, host ${owner.host}` : ''})`
    : 'an operation whose owner record is still being written';
  const err = new Error(
    `lifecycle lock: another agentsmd lifecycle operation is in progress — ${who}. ` +
    'Refusing to run concurrently; no installation files were changed. Re-run after it finishes. ' +
    (recovery
      ? 'Recovery could not prove exclusive ownership: a live/unverifiable claimant, changed lock, unsupported hard links, or the bounded claim limit may require inspection. Lock evidence was preserved; run agentsmd doctor before retrying.'
      : 'A crashed owner is reclaimed automatically on the next run (immediately once its process is gone, ' +
        `or after its ${Math.round(leaseMs() / 60000)} min lease when liveness cannot be verified).`)
  );
  err.code = 'AGENTSMD_LOCK_HELD';
  return err;
}

// acquire(action) → opaque handle for release(). Throws AGENTSMD_LOCK_HELD when a
// live owner holds the lock. Never called from read-only commands.
function acquire(action, env = process.env) {
  if (held) { held.depth += 1; return held; }
  const dir = lockDir();
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  sweepQuarantines(dir);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const before = generation(dir);
      const verdict = inspectLock(dir);
      if (verdict.state === 'live') throw lockHeldError(verdict.owner);
      reclaim(dir, before, verdict); // Re-inspect on contention; never reuse the stale observation.
      continue;
    }
    const owner = {
      schemaVersion: 1,
      pid: process.pid,
      pidStartTime: processStartTime(process.pid),
      txid: `${action}-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      action,
      startedAt: new Date().toISOString(),
      leaseMs: leaseMs(env),
      host: os.hostname(),
    };
    fs.writeFileSync(ownerPath(dir), `${JSON.stringify(owner)}\n`, { mode: 0o600 });
    held = { dir, owner, depth: 1 };
    return held;
  }
  throw lockHeldError(readOwner(dir), true);
}

function release(handle) {
  if (!handle || handle !== held) return;
  held.depth -= 1;
  if (held.depth > 0) return;
  const current = readOwner(held.dir);
  if (!current || current.txid === held.owner.txid) {
    try { fs.rmSync(held.dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  // else: our lease expired and another process reclaimed — their lock stays.
  held = null;
}

// Read-only view for doctor/status: null when unlocked.
function currentLock() {
  const dir = lockDir();
  if (!fs.existsSync(dir)) return null;
  const verdict = inspectLock(dir);
  return { path: dir, state: verdict.state, owner: verdict.owner };
}

module.exports = { acquire, release, currentLock, inspectLock, lockDir, processStartTime, pidAlive, LOCK_DIRNAME, DEFAULT_LEASE_MS };
