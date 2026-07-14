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
//   Reclaim itself is race-safe: rename the dir to a pid-unique tombstone (only one
//   renamer wins), remove the tombstone, then retry the mkdir once.
// - Release verifies the txid before removing: if the lease expired mid-run and
//   another process legitimately reclaimed, the stale holder must not delete the
//   new owner's lock.
// L1 hooks never touch this file (L1→L2 isolation invariant).

const fs = require('fs');
const os = require('os');
const path = require('path');
const P = require('./paths');

const LOCK_DIRNAME = '.agentsmd-lifecycle-lock';
const DEFAULT_LEASE_MS = 15 * 60 * 1000; // lifecycle ops take seconds; 100x headroom
const UNREADABLE_GRACE_MS = 60 * 1000;   // mkdir-won-but-owner.json-not-yet-written window

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

// Race-safe stale-lock removal: only one process wins the rename; the loser
// returns false and retries its mkdir (the winner's fresh lock now exists).
function reclaim(dir) {
  const tombstone = `${dir}.stale-${process.pid}-${Date.now()}`;
  try { fs.renameSync(dir, tombstone); }
  catch { return false; }
  try { fs.rmSync(tombstone, { recursive: true, force: true }); } catch { /* best-effort */ }
  return true;
}

function lockHeldError(owner) {
  const who = owner
    ? `${owner.action || 'unknown-action'} (pid ${owner.pid}, started ${owner.startedAt || 'unknown'}${owner.host ? `, host ${owner.host}` : ''})`
    : 'an operation whose owner record is still being written';
  const err = new Error(
    `lifecycle lock: another agentsmd lifecycle operation is in progress — ${who}. ` +
    'Refusing to run concurrently; nothing was changed. Re-run after it finishes. ' +
    'A crashed owner is reclaimed automatically on the next run (immediately once its process is gone, ' +
    `or after its ${Math.round(leaseMs() / 60000)} min lease when liveness cannot be verified).`
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
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const verdict = inspectLock(dir);
      if (verdict.state === 'live') throw lockHeldError(verdict.owner);
      reclaim(dir); // false = lost the reclaim race; loop re-inspects the fresh lock
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
  throw lockHeldError(readOwner(dir));
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
