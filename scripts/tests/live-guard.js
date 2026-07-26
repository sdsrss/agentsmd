'use strict';

// Live-home guard for the test suite (roadmap R1-05, audit 2026-07-13).
//
// Every test must sandbox $CODEX_HOME; this guard makes a violation fail CI
// instead of silently polluting the developer's real install (qa-* session
// residue was found in the live ~/.codex/.agentsmd-state — the writer is no
// longer in-tree, so the defense is a fingerprint, not a code fix).
//
// Usage in the npm test chain (fail-fast && chain):
//   node scripts/tests/live-guard.js snapshot   # first step
//   ...all suites...
//   node scripts/tests/live-guard.js verify     # last step
//
// Scope: every agentsmd-owned / agentsmd-shared surface under the live home.
// The telemetry log cannot be hashed (a concurrent real Codex session appends to
// it legitimately), so it is compared by SIGNAL instead of being excluded — see
// logSignal() below. Skip hatch for intentional live runs:
// AGENTSMD_SKIP_LIVE_GUARD=1.

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const LIVE_HOME = process.env.AGENTSMD_LIVE_GUARD_HOME
  || path.join(os.homedir(), '.codex');
// Keyed by (home, repo) — stable across the separate snapshot/verify processes
// of one npm test chain, distinct across repos and sandboxed homes.
const SNAPSHOT_PATH = path.join(
  os.tmpdir(),
  `agentsmd-live-guard-${crypto
    .createHash('sha256')
    .update(`${LIVE_HOME}:${process.cwd()}`)
    .digest('hex')
    .slice(0, 16)}.json`
);

// Surfaces no test is ever allowed to mutate.
const GUARDED = [
  '.agentsmd-state',
  'agentsmd',
  'hooks.json',
  'config.toml',
  'AGENTS.md',
  'AGENTS-extended.md',
  'AGENTS.override.md',
  // Lifecycle transients: normally absent, so a leaked lock/journal from a test
  // that skipped the sandbox shows up as absent → present (R2-01 / R2-02).
  '.agentsmd-lifecycle-lock',
  '.agentsmd-lifecycle-journal.json',
];

// ~/.codex/skills is shared with other plugins; only our own `agentsmd-*` dirs
// are ours to guard. Resolved at both snapshot and verify time so a skill dir a
// test CREATES in the live home also registers as drift (absent → dir:…).
const OWNED_SKILL_PREFIX = 'agentsmd-';
function ownedSkillSurfaces() {
  try {
    return fs
      .readdirSync(path.join(LIVE_HOME, 'skills'), { withFileTypes: true })
      .filter((entry) => entry.name.startsWith(OWNED_SKILL_PREFIX))
      .map((entry) => `skills/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

// Telemetry log — compared by signal, not by hash. A real Codex session running
// in another terminal appends rows legitimately, so a hash would be flaky; but
// leaving the log unguarded is what let a repro script that forgot to export a
// sandbox CODEX_HOME write 4800 synthetic rows into the live log (2026-07-14
// incident). Two signals, each of which a real session cannot produce:
//   * a TAGGED row — AGENTSMD_TELEMETRY_TAG is set only by QA/test harnesses;
//   * more than LOG_ROW_BUDGET new rows inside one suite run.
const LOG_FILES = ['logs/agentsmd.jsonl', 'logs/agentsmd.jsonl.1', 'logs/agentsmd.jsonl.2'];
const LOG_ROW_BUDGET = 50;

function logSignal() {
  let rows = 0;
  let tagged = 0;
  for (const rel of LOG_FILES) {
    let text;
    try {
      text = fs.readFileSync(path.join(LIVE_HOME, rel), 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      rows++;
      if (/"tag"[ \t]*:/.test(line)) tagged++;
    }
  }
  return { rows, tagged };
}

function hashFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fingerprintEntry(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return 'absent';
  }
  if (stat.isSymbolicLink()) return `symlink:${fs.readlinkSync(target)}`;
  if (stat.isFile()) return `file:${stat.size}:${hashFile(target)}`;
  if (!stat.isDirectory()) return `other:${stat.mode}`;
  const rows = [];
  const walk = (dir, rel) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relName = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) rows.push(`${relName}:symlink`);
      else if (entry.isDirectory()) { rows.push(`${relName}:dir`); walk(full, relName); }
      else if (entry.isFile()) rows.push(`${relName}:${fs.statSync(full).size}:${hashFile(full)}`);
      else rows.push(`${relName}:other`);
    }
  };
  walk(target, '');
  return `dir:${crypto.createHash('sha256').update(rows.join('\n')).digest('hex')}`;
}

function fingerprint() {
  const result = {};
  for (const rel of [...GUARDED, ...ownedSkillSurfaces()]) {
    result[rel] = fingerprintEntry(path.join(LIVE_HOME, rel));
  }
  return result;
}

function main() {
  const mode = process.argv[2];
  if (process.env.AGENTSMD_SKIP_LIVE_GUARD === '1') {
    process.stdout.write(`live-guard: skipped by AGENTSMD_SKIP_LIVE_GUARD=1 (${mode})\n`);
    return;
  }
  if (mode === 'snapshot') {
    fs.writeFileSync(
      SNAPSHOT_PATH,
      JSON.stringify({ home: LIVE_HOME, taken: fingerprint(), log: logSignal() }),
      { mode: 0o600 }
    );
    process.stdout.write(`live-guard: snapshot of ${LIVE_HOME} recorded\n`);
    return;
  }
  if (mode === 'verify') {
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8'));
    } catch {
      process.stderr.write('live-guard: FAIL — no snapshot found; run the full npm test chain from the start\n');
      process.exit(1);
    }
    fs.rmSync(SNAPSHOT_PATH, { force: true });
    const current = fingerprint();
    // Union of both key sets — a surface CREATED during the run (a fresh
    // agentsmd-* skill dir) exists only in `current` and must still count.
    const surfaces = [...new Set([...Object.keys(snapshot.taken), ...Object.keys(current)])].sort();
    const drifted = surfaces.filter((rel) => snapshot.taken[rel] !== current[rel]);
    if (drifted.length > 0) {
      process.stderr.write(
        'live-guard: FAIL — the test run mutated the live CODEX_HOME surfaces: '
        + `${drifted.join(', ')} under ${LIVE_HOME}. Tests must sandbox $CODEX_HOME (HARD dev constraint).\n`
      );
      process.exit(1);
    }
    const before = snapshot.log || { rows: 0, tagged: 0 };
    const after = logSignal();
    const newTagged = after.tagged - before.tagged;
    const newRows = after.rows - before.rows;
    if (newTagged > 0 || newRows > LOG_ROW_BUDGET) {
      process.stderr.write(
        'live-guard: FAIL — the test run wrote telemetry into the live log '
        + `(${LOG_FILES[0]} under ${LIVE_HOME}): +${newRows} row(s), +${newTagged} tagged. `
        + 'A harness that sources hooks/lib/rule-hits.sh MUST export a sandbox CODEX_HOME '
        + 'before spawning writers (HARD dev constraint).\n'
      );
      process.exit(1);
    }
    process.stdout.write(
      `live-guard: ${LIVE_HOME} unchanged across the suite `
      + `(${surfaces.length} surfaces; telemetry +${newRows} row(s), 0 tagged)\n`
    );
    return;
  }
  process.stderr.write('usage: node scripts/tests/live-guard.js snapshot|verify\n');
  process.exit(2);
}

main();
