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
function classifyStep(step) {
  if (step.kind === 'swap') {
    const present = F.pathExists(step.target);
    const hash = () => { try { return F.sha256Tree(step.target); } catch { return null; } };
    if (present === step.afterPresent && (!present || hash() === step.afterSha256Tree)) return 'after';
    if (present === step.beforePresent && (!present || hash() === step.beforeSha256Tree)) return 'before';
    return 'other';
  }
  if (step.kind === 'write') {
    const present = F.pathExists(step.target);
    const hash = () => { try { return F.sha256File(step.target); } catch { return null; } };
    if (present && hash() === step.afterSha256) return 'after';
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

module.exports = {
  JOURNAL_BASENAME, JOURNAL_SCHEMA,
  journalPath, begin, advance, complete, readJournal, classifyStep, adjudicate,
  archiveStale, maybeCrash, fsyncDir,
};
