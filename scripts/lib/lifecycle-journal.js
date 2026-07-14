'use strict';
// lifecycle-journal.js — durable transaction journal for the install/update/
// repair commit phase (R2-02, audit H-03). Written BEFORE the first live
// mutation, so that at ANY process-termination point the decision between
// roll-forward and rollback is derivable from DISK STATE ALONE — no in-memory
// transaction object required.
//
// Shape (schemaVersion 1):
//   { schemaVersion, txid, action, pid, startedAt, phase: 'committing'|'cleanup',
//     backupId, stageRoot, plannedDir,
//     steps: [
//       { kind:'swap',  target, backupPath, beforePresent, beforeSha256Tree|null,
//         afterPresent, afterSha256Tree|null }
//       { kind:'write', target, beforePresent, beforeSha256|null,
//         afterSha256, plannedFile }
//     ] }
//
// Every step carries deterministic before/after fingerprints, all computable
// BEFORE the commit begins (staged trees are hashed in the stage dir; merged
// shared-file contents are persisted under <stageRoot>/planned/ and referenced
// by hash), so a crash between any two operations leaves each target provably
// at 'before', at 'after', or at 'other' (foreign concurrent change).
//
// Adjudication (pure disk read):
//   no journal            → clean
//   every step at after   → roll-forward   (commit landed; only cleanup is owed)
//   any step at other     → conflict       (fail closed, preserve current bytes)
//   otherwise             → rollback       (restore recorded befores)
// Recovery EXECUTION is R2-03; this module provides the durable record and the
// verdict. The journal lives OUTSIDE .agentsmd-state/ (like the R2-01 lock):
// state-dir lifecycle must never destroy the evidence describing it.
//
// Durability: the journal file is written atomically (temp + fsync + rename via
// fs-atomic) and its PARENT DIRECTORY is fsync'd after every rename/unlink, so
// the record itself survives the same crash it documents.

const fs = require('fs');
const path = require('path');
const P = require('./paths');
const F = require('./fs-atomic');

const JOURNAL_BASENAME = '.agentsmd-lifecycle-journal.json';
const JOURNAL_SCHEMA = 1;
const STALE_ARCHIVE_CAP = 3;

function journalPath() { return path.join(P.codexHome(), JOURNAL_BASENAME); }

// fsync the directory entry so a rename/unlink of the journal is itself durable.
function fsyncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch { /* best-effort: some platforms refuse dir fsync */ }
  finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* noop */ } } }
}

function writeJournal(record) {
  F.writeFileAtomic(journalPath(), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fsyncDir(path.dirname(journalPath()));
}

// begin(fields) → journal record persisted with phase 'committing'.
function begin({ txid, action, backupId = null, stageRoot = null, plannedDir = null, steps }) {
  const record = {
    schemaVersion: JOURNAL_SCHEMA,
    txid: txid || null,
    action,
    pid: process.pid,
    startedAt: new Date().toISOString(),
    phase: 'committing',
    backupId,
    stageRoot,
    plannedDir,
    steps,
  };
  writeJournal(record);
  return record;
}

function advance(record, phase) {
  record.phase = phase;
  writeJournal(record);
  return record;
}

// complete() — successful transaction: remove the journal durably.
function complete() {
  try { fs.unlinkSync(journalPath()); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
  fsyncDir(path.dirname(journalPath()));
}

function readJournal() {
  let raw;
  try { raw = fs.readFileSync(journalPath(), 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    return { unreadable: true, error: error.message };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.schemaVersion !== JOURNAL_SCHEMA || !Array.isArray(parsed.steps)) {
      return { unreadable: true, error: 'unknown schema or malformed journal' };
    }
    return parsed;
  } catch (error) { return { unreadable: true, error: error.message }; }
}

// classifyStep — where does the target sit RIGHT NOW: before / after / other?
// R2-03 extensions (all optional, forward-compatible within schema 1):
//   write steps may be deletions (afterPresent:false) and may inline their
//   before/after contents (base64) so recovery never depends on stage survival;
//   swap steps may declare afterCheck:'uninstalled-shims' (uninstall's deploy
//   target ends as the fixed shim tree, not absent).
function classifyStep(step) {
  if (step.kind === 'swap') {
    const present = F.pathExists(step.target);
    const hash = () => { try { return F.sha256Tree(step.target); } catch { return null; } };
    if (step.afterCheck === 'uninstalled-shims') {
      const S = require('./uninstalled-shims');
      if (present && S.isExactUninstalledShimTree(step.target)) return 'after';
      // Quarantined-but-shims-not-yet-written is a valid intermediate: both
      // directions remain executable from it (backward restores the quarantine
      // backup; forward writes the code-defined shim tree), so classify it with
      // the recoverable side rather than 'other'.
      if (!present) return 'before';
    } else if (present === step.afterPresent && (!present || hash() === step.afterSha256Tree)) return 'after';
    if (present === step.beforePresent && (!present || hash() === step.beforeSha256Tree)) return 'before';
    return 'other';
  }
  if (step.kind === 'write') {
    const present = F.pathExists(step.target);
    const afterPresent = step.afterPresent !== false;
    const hash = () => { try { return F.sha256File(step.target); } catch { return null; } };
    if (present === afterPresent && (!present || hash() === step.afterSha256)) return 'after';
    if (present === step.beforePresent && (!present || hash() === step.beforeSha256)) return 'before';
    return 'other';
  }
  return 'other';
}

// adjudicate — the R2-02 acceptance function: decision from disk state alone.
function adjudicate(journal = readJournal()) {
  if (journal === null) return { decision: 'clean', steps: [] };
  if (journal.unreadable) return { decision: 'conflict', reason: `journal unreadable: ${journal.error}`, steps: [] };
  const steps = journal.steps.map((step) => ({ kind: step.kind, target: step.target, state: classifyStep(step) }));
  const states = new Set(steps.map((s) => s.state));
  let decision;
  if (states.has('other')) decision = 'conflict';
  else if (!states.has('before')) decision = 'roll-forward';
  else decision = 'rollback';
  return { decision, phase: journal.phase, action: journal.action, txid: journal.txid, startedAt: journal.startedAt, steps };
}

// archiveStale — pre-R2-03 self-heal: a pending journal whose owner is dead is
// renamed to a timestamped sibling (evidence preserved, capped) so the next
// idempotent install can proceed instead of wedging. R2-03 replaces this with
// executed roll-forward/rollback.
function archiveStale() {
  const src = journalPath();
  if (!F.pathExists(src)) return null;
  const dest = `${src}.stale-${Date.now()}-${process.pid}`;
  fs.renameSync(src, dest);
  fsyncDir(path.dirname(src));
  const dir = path.dirname(src);
  const archives = fs.readdirSync(dir)
    .filter((name) => name.startsWith(`${JOURNAL_BASENAME}.stale-`))
    .sort();
  for (const name of archives.slice(0, Math.max(0, archives.length - STALE_ARCHIVE_CAP))) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch { /* best-effort */ }
  }
  return dest;
}

// maybeCrash — test-only fault-injection point (R2-04 pre-wiring). Inert unless
// the env var is set; used by the crash-matrix tests to SIGKILL the process at
// a named point inside the commit phase.
function maybeCrash(point, env = process.env) {
  if (env.AGENTSMD_TEST_CRASH_AT === point) process.kill(process.pid, 'SIGKILL');
}

// ── R2-03: recovery execution ────────────────────────────────────────────────

const decode = (b64) => Buffer.from(b64, 'base64');

// Can this step be driven to AFTER using only what is on disk right now?
function forwardSourceAvailable(step, state) {
  if (state === 'after') return true;
  if (step.kind === 'swap') {
    if (step.afterCheck === 'uninstalled-shims') return true;            // shim tree is code-defined
    if (step.afterPresent === false) return true;                        // removal needs nothing
    return typeof step.staged === 'string' && F.pathExists(step.staged); // staged tree must survive
  }
  if (step.kind === 'write') {
    if (step.afterPresent === false) return true;                        // deletion needs nothing
    if (typeof step.afterContentB64 === 'string') return true;           // inline content
    return typeof step.plannedFile === 'string' && F.pathExists(step.plannedFile)
      && F.sha256File(step.plannedFile) === step.afterSha256;
  }
  return false;
}

// Can this step be driven back to BEFORE using only what is on disk right now?
function rollbackSourceAvailable(step, state) {
  if (state === 'before') return true;
  if (step.kind === 'swap') {
    if (step.beforePresent === false) return true;                       // removal needs nothing
    return typeof step.backupPath === 'string' && F.pathExists(step.backupPath);
  }
  if (step.kind === 'write') {
    if (step.beforePresent === false) return true;                       // deletion needs nothing
    return typeof step.beforeContentB64 === 'string';
  }
  return false;
}

// planRecovery — pick the executable direction. Preference: roll-forward
// (complete the intended operation) when every step's forward source survives;
// else rollback; else conflict (fail closed, journal preserved).
function planRecovery(journal = readJournal()) {
  const verdict = adjudicate(journal);
  if (verdict.decision === 'clean') return { mode: 'clean', verdict };
  if (verdict.decision === 'conflict') return { mode: 'conflict', verdict };
  const states = journal.steps.map((step) => classifyStep(step));
  const forwardOk = journal.steps.every((step, i) => forwardSourceAvailable(step, states[i]));
  if (forwardOk) return { mode: 'roll-forward', verdict };
  const rollbackOk = journal.steps.every((step, i) => rollbackSourceAvailable(step, states[i]));
  if (rollbackOk) return { mode: 'rollback', verdict };
  return { mode: 'conflict', verdict, reason: 'neither direction fully executable from disk' };
}

function driveForward(step) {
  if (step.kind === 'swap') {
    if (step.beforePresent && F.pathExists(step.target)) {
      // Preserve the pre-state exactly as the original commit would have.
      if (typeof step.backupPath === 'string' && !F.pathExists(step.backupPath)) {
        fs.mkdirSync(path.dirname(step.backupPath), { recursive: true });
        fs.renameSync(step.target, step.backupPath);
      } else {
        fs.rmSync(step.target, { recursive: true, force: true });
      }
    } else if (F.pathExists(step.target)) fs.rmSync(step.target, { recursive: true, force: true });
    if (step.afterCheck === 'uninstalled-shims') {
      require('./uninstalled-shims').writeUninstalledHookShims();
    } else if (step.afterPresent !== false && typeof step.staged === 'string') {
      fs.mkdirSync(path.dirname(step.target), { recursive: true });
      fs.renameSync(step.staged, step.target);
    }
    return;
  }
  if (step.afterPresent === false) {
    try { fs.unlinkSync(step.target); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    return;
  }
  const content = typeof step.afterContentB64 === 'string' ? decode(step.afterContentB64) : fs.readFileSync(step.plannedFile);
  F.writeFileAtomic(step.target, content, { mode: 0o600 });
}

function driveBackward(step) {
  if (step.kind === 'swap') {
    if (F.pathExists(step.target)) fs.rmSync(step.target, { recursive: true, force: true });
    if (step.beforePresent && typeof step.backupPath === 'string' && F.pathExists(step.backupPath)) {
      fs.mkdirSync(path.dirname(step.target), { recursive: true });
      fs.renameSync(step.backupPath, step.target);
    }
    return;
  }
  if (step.beforePresent === false) {
    try { fs.unlinkSync(step.target); } catch (error) { if (!error || error.code !== 'ENOENT') throw error; }
    return;
  }
  F.writeFileAtomic(step.target, decode(step.beforeContentB64), { mode: 0o600 });
}

// executeRecovery — drive every step to the chosen side, verify each landed,
// clean up transaction transients, archive the journal (evidence, capped).
// Throws (journal preserved) on conflict or any post-drive verification miss.
function executeRecovery(journal = readJournal(), plan = planRecovery(journal)) {
  if (plan.mode === 'clean') { return { mode: 'clean', archivedTo: archiveStale() }; }
  if (plan.mode === 'conflict') {
    const err = new Error(
      `pending lifecycle transaction is not auto-recoverable (${plan.reason || 'foreign concurrent change detected'}); ` +
      `bytes preserved — review the journal at ${journalPath()}`
    );
    err.code = 'AGENTSMD_JOURNAL_CONFLICT';
    throw err;
  }
  const forward = plan.mode === 'roll-forward';
  const ordered = forward ? journal.steps : [...journal.steps].reverse();
  for (const step of ordered) {
    const state = classifyStep(step);
    if (state === (forward ? 'after' : 'before')) continue;
    if (forward) driveForward(step); else driveBackward(step);
    const landed = classifyStep(step);
    if (landed !== (forward ? 'after' : 'before')) {
      throw new Error(`recovery verification failed for ${step.target}: expected ${forward ? 'after' : 'before'}, observed ${landed}`);
    }
  }
  // Owed transaction cleanup. Path-shape guards keep a tampered journal from
  // aiming removal at foreign paths.
  const transientOk = (p, marker) => typeof p === 'string' && path.basename(p).includes(marker);
  for (const step of journal.steps) {
    if (step.kind !== 'swap' || typeof step.backupPath !== 'string') continue;
    const isTransient = transientOk(step.backupPath, '.agentsmd-old-')
      || step.backupPath.includes(`${path.sep}quarantine${path.sep}`);
    // On rollback the backup was renamed back into place; remove only what remains.
    if (forward && isTransient) { try { fs.rmSync(step.backupPath, { recursive: true, force: true }); } catch { /* best-effort */ } }
  }
  if (typeof journal.stageRoot === 'string'
    && path.dirname(journal.stageRoot) === P.codexHome()
    && path.basename(journal.stageRoot).startsWith('.agentsmd-')) {
    try { fs.rmSync(journal.stageRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  return { mode: plan.mode, action: journal.action, txid: journal.txid, archivedTo: archiveStale() };
}

// processPending — the ONE entry gate every lifecycle command calls first
// (R2-03 acceptance: all entries handle the pending journal before their own
// work). Returns null when there is nothing pending, a recovery report when a
// crashed transaction was rolled forward/back, and THROWS (fail closed, journal
// preserved) when recovery is not derivable from disk.
function processPending() {
  const journal = readJournal();
  if (journal === null) return null;
  if (journal.unreadable) {
    const err = new Error(`pending lifecycle journal is unreadable (${journal.error}); bytes preserved — review ${journalPath()}`);
    err.code = 'AGENTSMD_JOURNAL_CONFLICT';
    throw err;
  }
  return executeRecovery(journal);
}

module.exports = {
  JOURNAL_BASENAME, JOURNAL_SCHEMA,
  journalPath, begin, advance, complete, readJournal, classifyStep, adjudicate,
  planRecovery, executeRecovery, processPending,
  archiveStale, maybeCrash, fsyncDir,
};
