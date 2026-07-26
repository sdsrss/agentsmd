'use strict';
// live-guard.test.js — the guard that enforces the HARD dev constraint "in-repo
// development never modifies the live ~/.codex" is itself the last line of
// defense, so it needs its own coverage. The 2026-07-25 audit found it blind to
// three agentsmd-owned surfaces (skills/agentsmd-*, logs/agentsmd.jsonl, the
// lifecycle lock/journal) — a test could scribble in any of them and `verify`
// still printed "unchanged". Every case below drives the real script end to end
// against a sandbox home via AGENTSMD_LIVE_GUARD_HOME.

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');

let PASS = 0, FAIL = 0;
const t = (name, fn) => { try { fn(); PASS++; console.log('  ok   ' + name); } catch (e) { FAIL++; console.log('  FAIL ' + name + '\n     ' + e.message); } };

const GUARD = path.join(__dirname, 'live-guard.js');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-lgtest.'));

// Each case gets its own home AND its own cwd: the snapshot file is keyed by
// (home, cwd), so distinct homes cannot collide even when run in parallel.
function newHome(name) {
  const home = path.join(ROOT, name, 'codex');
  fs.mkdirSync(path.join(home, 'logs'), { recursive: true });
  fs.mkdirSync(path.join(home, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(home, 'agentsmd'), { recursive: true });
  fs.writeFileSync(path.join(home, 'AGENTS.md'), '# user\n');
  fs.writeFileSync(path.join(home, 'hooks.json'), '{}\n');
  return home;
}

function run(mode, home) {
  const r = cp.spawnSync(process.execPath, [GUARD, mode], {
    env: { ...process.env, AGENTSMD_LIVE_GUARD_HOME: home, AGENTSMD_SKIP_LIVE_GUARD: '' },
    cwd: path.dirname(home),
    encoding: 'utf8',
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

// mutate() runs between snapshot and verify; returns the verify result.
function cycle(name, mutate) {
  const home = newHome(name);
  const snap = run('snapshot', home);
  assert.strictEqual(snap.code, 0, `snapshot failed: ${snap.out}`);
  mutate(home);
  return run('verify', home);
}

const logRow = (extra = {}) => `${JSON.stringify({
  ts: '2026-07-25T00:00:00Z', hook: 'x', event: 'observe', spec_section: '§8-secrets', ...extra,
})}\n`;

t('clean run → verify passes and names the surface count', () => {
  const r = cycle('clean', () => {});
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /unchanged across the suite/);
});

t('write into an agentsmd-owned skill dir → FAIL', () => {
  const r = cycle('skills', (home) => {
    fs.mkdirSync(path.join(home, 'skills', 'agentsmd-doctor'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'agentsmd-doctor', 'SKILL.md'), 'x\n');
  });
  assert.strictEqual(r.code, 1, `expected failure, got: ${r.out}`);
  assert.match(r.out, /skills\/agentsmd-doctor/);
});

t('another tenant\'s skill dir is NOT ours to guard → passes', () => {
  const r = cycle('otherskill', (home) => {
    fs.mkdirSync(path.join(home, 'skills', 'omx-review'), { recursive: true });
    fs.writeFileSync(path.join(home, 'skills', 'omx-review', 'SKILL.md'), 'x\n');
  });
  assert.strictEqual(r.code, 0, r.out);
});

t('leaked lifecycle lock → FAIL', () => {
  const r = cycle('lock', (home) => {
    fs.mkdirSync(path.join(home, '.agentsmd-lifecycle-lock'), { recursive: true });
    fs.writeFileSync(path.join(home, '.agentsmd-lifecycle-lock', 'owner.json'), '{}\n');
  });
  assert.strictEqual(r.code, 1, `expected failure, got: ${r.out}`);
  assert.match(r.out, /agentsmd-lifecycle-lock/);
});

t('leaked lifecycle journal → FAIL', () => {
  const r = cycle('journal', (home) => {
    fs.writeFileSync(path.join(home, '.agentsmd-lifecycle-journal.json'), '{}\n');
  });
  assert.strictEqual(r.code, 1, `expected failure, got: ${r.out}`);
  assert.match(r.out, /agentsmd-lifecycle-journal/);
});

t('a single QA-tagged telemetry row → FAIL (only a harness sets a tag)', () => {
  const r = cycle('tagged', (home) => {
    fs.appendFileSync(path.join(home, 'logs', 'agentsmd.jsonl'), logRow({ tag: 'qa' }));
  });
  assert.strictEqual(r.code, 1, `expected failure, got: ${r.out}`);
  assert.match(r.out, /\+1 tagged/);
});

t('a burst of untagged rows past the budget → FAIL (the 4800-row incident class)', () => {
  const r = cycle('burst', (home) => {
    fs.appendFileSync(path.join(home, 'logs', 'agentsmd.jsonl'), logRow().repeat(200));
  });
  assert.strictEqual(r.code, 1, `expected failure, got: ${r.out}`);
  assert.match(r.out, /\+200 row\(s\)/);
});

t('a few untagged rows from a concurrent real session → passes (no flake)', () => {
  const r = cycle('concurrent', (home) => {
    fs.appendFileSync(path.join(home, 'logs', 'agentsmd.jsonl'), logRow().repeat(3));
  });
  assert.strictEqual(r.code, 0, r.out);
  assert.match(r.out, /telemetry \+3 row\(s\), 0 tagged/);
});

t('rotated segments count too', () => {
  const r = cycle('rotated', (home) => {
    fs.appendFileSync(path.join(home, 'logs', 'agentsmd.jsonl.1'), logRow({ tag: 'test' }));
  });
  assert.strictEqual(r.code, 1, `expected failure, got: ${r.out}`);
  assert.match(r.out, /\+1 tagged/);
});

t('the classic shared-file surfaces are still guarded', () => {
  const r = cycle('shared', (home) => {
    fs.appendFileSync(path.join(home, 'AGENTS.md'), 'injected\n');
  });
  assert.strictEqual(r.code, 1, `expected failure, got: ${r.out}`);
  assert.match(r.out, /AGENTS\.md/);
});

t('verify without a snapshot fails loudly instead of passing', () => {
  const home = newHome('nosnapshot');
  const r = run('verify', home);
  assert.strictEqual(r.code, 1, r.out);
  assert.match(r.out, /no snapshot found/);
});

fs.rmSync(ROOT, { recursive: true, force: true });
console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
