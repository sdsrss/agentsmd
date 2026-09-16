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
const crypto = require('crypto');
const path = require('path');
const P = require('./paths');
const F = require('./fs-atomic');

const JOURNAL_BASENAME = '.agentsmd-lifecycle-journal.json';
const JOURNAL_SCHEMA = 1;
const STALE_ARCHIVE_CAP = 3;

function journalPath() { return path.join(P.codexHome(), JOURNAL_BASENAME); }

// fsync the directory entry so a rename/unlink of the journal is itself durable.
// Shared implementation lives in fs-atomic (R2-04: every critical rename fsyncs
// its parent); re-exported here for existing callers.
const fsyncDir = F.fsyncDir;

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

// maybeCrash — test-only fault-injection points (R2-04). Inert unless an env
// var is set. Two modes at every named point inside the commit phase:
//   AGENTSMD_TEST_CRASH_AT=<point>          → SIGKILL self (crash path: the
//     journal + next entry's recovery are what save the tree);
//   AGENTSMD_TEST_FAULT_AT=<point>:<ERRNO>  → throw an fs-shaped error, e.g.
//     mid-writes:ENOSPC (error path: the in-process rollback saves the tree).
function maybeCrash(point, env = process.env) {
  if (env.AGENTSMD_TEST_CRASH_AT === point) process.kill(process.pid, 'SIGKILL');
  const fault = env.AGENTSMD_TEST_FAULT_AT;
  if (typeof fault === 'string' && fault.startsWith(`${point}:`)) {
    const code = fault.slice(point.length + 1) || 'EIO';
    const err = new Error(`${code}: injected fault at ${point}`);
    err.code = code;
    throw err;
  }
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

function recoveryConflict(reason) {
  const error = new Error(`pending lifecycle transaction is not auto-recoverable (${reason}); ` +
    `bytes preserved — review the journal at ${journalPath()}`);
  error.code = 'AGENTSMD_JOURNAL_CONFLICT';
  return error;
}

function assertDescriptor(target, expected) {
  if (!F.sameDescriptor(F.describePath(target), expected)) {
    throw recoveryConflict(`concurrent change detected for ${target}`);
  }
}

function recoveryTree(target, expectedHash) {
  const snapshot = F.describePath(target);
  if (!snapshot.present || snapshot.type !== 'tree' || snapshot.sha256 !== expectedHash) {
    throw recoveryConflict(`recovery tree changed for ${target}`);
  }
  return snapshot;
}

function removeRecoveryTree(target, snapshot) {
  assertDescriptor(target, snapshot);
  fs.rmSync(target, { recursive: true, force: true });
}

function driveFile(step, forward) {
  // Bind the actual mutation to the journal's source state, not a fresh foreign
  // value observed after planning. The atomic writer rechecks this same snapshot.
  F.assertNotSymbolicLink(step.target);
  const snapshot = F.snapshotFile(step.target);
  const source = forward ? 'before' : 'after';
  const destination = forward ? 'after' : 'before';
  const present = (side) => side === 'after' ? step.afterPresent !== false : step.beforePresent;
  const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
  if (snapshot.present !== present(source)
    || (snapshot.present && hash(snapshot.content) !== step[`${source}Sha256`])) {
    throw recoveryConflict(`concurrent change detected for ${step.target}`);
  }
  if (!present(destination)) {
    if (snapshot.present) F.unlinkFileIfUnchanged(step.target, snapshot);
    return;
  }
  const encoded = step[`${destination}ContentB64`];
  const content = typeof encoded === 'string' ? decode(encoded) : fs.readFileSync(step.plannedFile);
  if (hash(content) !== step[`${destination}Sha256`]) {
    throw recoveryConflict(`recovery content changed for ${step.target}`);
  }
  F.writeFileAtomic(step.target, content, { mode: 0o600, expectedSnapshot: snapshot });
}

function driveForward(step) {
  if (step.kind !== 'swap') return driveFile(step, true);
  const target = F.describePath(step.target);
  if (target.present && target.type !== 'tree') throw recoveryConflict(`recovery target changed for ${step.target}`);
  // Check all sources before moving/removing the target. Keep the snapshots for
  // immediate rechecks at each filesystem mutation boundary.
  if (classifyStep(step) !== 'before') throw recoveryConflict(`concurrent change detected for ${step.target}`);
  const staged = step.afterCheck !== 'uninstalled-shims' && step.afterPresent !== false
    ? recoveryTree(step.staged, step.afterSha256Tree) : null;
  const backup = typeof step.backupPath === 'string' ? F.describePath(step.backupPath) : null;
  if (backup && backup.present) recoveryTree(step.backupPath, step.beforeSha256Tree);
  if (target.present) {
    if (step.beforePresent && backup && !backup.present) {
      fs.mkdirSync(path.dirname(step.backupPath), { recursive: true });
      assertDescriptor(step.target, target);
      assertDescriptor(step.backupPath, backup);
      fs.renameSync(step.target, step.backupPath);
    } else removeRecoveryTree(step.target, target);
  }
  if (step.afterCheck === 'uninstalled-shims') {
    require('./uninstalled-shims').writeUninstalledHookShims({
      onStaged: () => assertDescriptor(step.target, { present: false }),
    });
  } else if (staged) {
    fs.mkdirSync(path.dirname(step.target), { recursive: true });
    assertDescriptor(step.staged, staged);
    assertDescriptor(step.target, { present: false });
    fs.renameSync(step.staged, step.target);
  }
}

function driveBackward(step) {
  if (step.kind !== 'swap') return driveFile(step, false);
  const target = F.describePath(step.target);
  if (target.present && target.type !== 'tree') throw recoveryConflict(`recovery target changed for ${step.target}`);
  if (classifyStep(step) !== 'after') throw recoveryConflict(`concurrent change detected for ${step.target}`);
  const backup = step.beforePresent ? recoveryTree(step.backupPath, step.beforeSha256Tree) : null;
  if (target.present) removeRecoveryTree(step.target, target);
  if (backup) {
    fs.mkdirSync(path.dirname(step.target), { recursive: true });
    assertDescriptor(step.backupPath, backup);
    assertDescriptor(step.target, { present: false });
    fs.renameSync(step.backupPath, step.target);
  }
}

// A staging-directory name is not ownership proof. Before recursive cleanup,
// account for every entry using the journal's source/backup/planned-file hashes.
function cleanupRecoveryStage(journal) {
  const root = journal.stageRoot;
  if (typeof root !== 'string' || path.dirname(root) !== P.codexHome()
    || !path.basename(root).startsWith('.agentsmd-') || !F.pathExists(root)) return;
  const snapshot = F.describePath(root);
  if (snapshot.type !== 'tree') throw recoveryConflict(`recovery stage changed for ${root}`);
  const known = [];
  const record = (target, type, hash) => {
    if (typeof target !== 'string') return;
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return;
    const current = F.describePath(target);
    if (current.present && (current.type !== type || current.sha256 !== hash)) {
      throw recoveryConflict(`recovery stage content changed for ${target}`);
    }
    known.push({ relative, type });
  };
  for (const step of journal.steps) {
    if (step.kind === 'swap') {
      record(step.staged, 'tree', step.afterSha256Tree);
      record(step.backupPath, 'tree', step.beforeSha256Tree);
    } else if (step.kind === 'write') record(step.plannedFile, 'file', step.afterSha256);
  }
  for (const entry of F.treeEntries(root)) {
    const covered = known.some(({ relative, type }) => entry.path === relative
      || (type === 'tree' && entry.path.startsWith(`${relative}/`))
      || (entry.type === 'dir' && relative.startsWith(`${entry.path}/`)));
    if (!covered) throw recoveryConflict(`unrecorded recovery stage entry ${entry.path}`);
  }
  removeRecoveryTree(root, snapshot);
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
    F.assertNotSymbolicLink(step.target);
    const state = classifyStep(step);
    if (state === 'other') throw recoveryConflict(`concurrent change detected for ${step.target}`);
    if (state === (forward ? 'after' : 'before')) continue;
    if (forward) driveForward(step); else driveBackward(step);
    const landed = classifyStep(step);
    if (landed !== (forward ? 'after' : 'before')) {
      throw new Error(`recovery verification failed for ${step.target}: expected ${forward ? 'after' : 'before'}, observed ${landed}`);
    }
  }
  // A completed step may have changed while a later step was recovering. Never
  // archive the journal or run cleanup on the strength of stale per-step reads.
  const verifyTargets = () => {
    for (const step of journal.steps) {
      F.assertNotSymbolicLink(step.target);
      if (classifyStep(step) !== (forward ? 'after' : 'before')) {
        throw recoveryConflict(`concurrent change detected for ${step.target}`);
      }
    }
  };
  verifyTargets();
  // Cleanup needs both a recorded transient path and its journal-bound hash.
  const transientOk = (p, marker) => typeof p === 'string' && path.basename(p).includes(marker);
  for (const step of journal.steps) {
    if (step.kind !== 'swap' || typeof step.backupPath !== 'string') continue;
    const isTransient = transientOk(step.backupPath, '.agentsmd-old-')
      || step.backupPath.includes(`${path.sep}quarantine${path.sep}`);
    // On rollback the backup was renamed back into place; remove only what remains.
    if (forward && isTransient && F.pathExists(step.backupPath)) {
      removeRecoveryTree(step.backupPath, recoveryTree(step.backupPath, step.beforeSha256Tree));
    }
  }
  cleanupRecoveryStage(journal);
  verifyTargets();
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
