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
// Scope: only the agentsmd-owned / agentsmd-shared surfaces that no test may
// touch. ~/.codex/logs is deliberately excluded — a concurrent real Codex
// session appends telemetry legitimately and would make the guard flaky.
// Skip hatch for intentional live runs: AGENTSMD_SKIP_LIVE_GUARD=1.

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
];

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
  for (const rel of GUARDED) result[rel] = fingerprintEntry(path.join(LIVE_HOME, rel));
  return result;
}

function main() {
  const mode = process.argv[2];
  if (process.env.AGENTSMD_SKIP_LIVE_GUARD === '1') {
    process.stdout.write(`live-guard: skipped by AGENTSMD_SKIP_LIVE_GUARD=1 (${mode})\n`);
    return;
  }
  if (mode === 'snapshot') {
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({ home: LIVE_HOME, taken: fingerprint() }), { mode: 0o600 });
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
    const drifted = GUARDED.filter((rel) => snapshot.taken[rel] !== current[rel]);
    if (drifted.length > 0) {
      process.stderr.write(
        'live-guard: FAIL — the test run mutated the live CODEX_HOME surfaces: '
        + `${drifted.join(', ')} under ${LIVE_HOME}. Tests must sandbox $CODEX_HOME (HARD dev constraint).\n`
      );
      process.exit(1);
    }
    process.stdout.write(`live-guard: ${LIVE_HOME} unchanged across the suite (${GUARDED.length} surfaces)\n`);
    return;
  }
  process.stderr.write('usage: node scripts/tests/live-guard.js snapshot|verify\n');
  process.exit(2);
}

main();
