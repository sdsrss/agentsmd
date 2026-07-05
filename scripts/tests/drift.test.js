'use strict';
// drift.test.js — CI gate keeping the spec, its machine-readable manifest, the
// two hook wirings, and the version in sync. A silent edit to any one side that
// isn't mirrored on the others fails here (claudemd's hard-rules-drift pattern).

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

const hr = JSON.parse(read('spec/hard-rules.json'));
const specFiles = { core: read('spec/AGENTS.md'), extended: read('spec/AGENTS-extended.md') };

// 1. every rule anchor still resolves verbatim in its spec file.
t('hard-rules: all section_anchors resolve in the spec', () => {
  const miss = hr.rules.filter((r) => !specFiles[r.scope].includes(r.section_anchor));
  assert.strictEqual(miss.length, 0, 'unresolved: ' + miss.map((r) => r.id).join(', '));
});

// 2. live_sections must reference sections that actually exist in the manifest.
t('hard-rules: live_sections ⊆ manifest rule_hits_sections', () => {
  const known = new Set(hr.rules.map((r) => r.rule_hits_section).filter(Boolean));
  const orphan = (hr.live_sections || []).filter((s) => !known.has(s));
  assert.strictEqual(orphan.length, 0, 'live_sections not in any rule: ' + orphan.join(', '));
});

// 3. every live_section is actually emitted by a hook script (honest claim).
t('hard-rules: every live_section is emitted by some hook', () => {
  const hooksDir = path.join(ROOT, 'hooks');
  const allHookSrc = fs.readdirSync(hooksDir).filter((f) => f.endsWith('.sh'))
    .map((f) => fs.readFileSync(path.join(hooksDir, f), 'utf8')).join('\n');
  const missing = (hr.live_sections || []).filter((s) => !allHookSrc.includes(s));
  assert.strictEqual(missing.length, 0, 'live_sections no hook emits: ' + missing.join(', '));
});

// 4. the two hook wirings (install template + plugin manifest) register the
//    same set of hook scripts per event — neither drifts silently.
t('hooks: install-template and plugin-manifest wirings match', () => {
  const basenames = (content) => {
    const cfg = JSON.parse(content);
    const out = {};
    for (const [ev, groups] of Object.entries(cfg.hooks)) {
      out[ev] = (groups || []).flatMap((g) => (g.hooks || []).map((h) => (h.command.match(/([a-z0-9-]+\.sh)/) || [])[1])).filter(Boolean).sort();
    }
    return out;
  };
  const a = basenames(read('hooks/hooks.json'));
  const b = basenames(read('hooks.json'));
  assert.deepStrictEqual(a, b, 'install-template vs plugin-manifest wiring differ');
});

// 5. version is consistent across package.json / plugin.json / manifest / BOTH
//    spec headers. Core + extended carry ONE shared version and move together
//    (AGENTS-CHANGELOG.md, since v1.4.0) — the extended header must be asserted
//    too, or it drifts silently (it sat at v2.3.0 through six releases because
//    this gate only checked the core header).
t('version: package.json = plugin.json = hard-rules = core + extended headers', () => {
  const norm = (v) => String(v).replace(/^v/, '');
  const pkg = norm(JSON.parse(read('package.json')).version);
  const plugin = norm(JSON.parse(read('.codex-plugin/plugin.json')).version);
  const manifest = norm(hr.spec_version);
  const specHeader = (specFiles.core.match(/CODEX-CODING-SPEC v([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
  const extHeader = (specFiles.extended.match(/CODEX-CODING-SPEC v([0-9]+\.[0-9]+\.[0-9]+)/) || [])[1];
  assert.strictEqual(pkg, plugin, `package(${pkg}) != plugin(${plugin})`);
  assert.strictEqual(pkg, manifest, `package(${pkg}) != manifest(${manifest})`);
  assert.strictEqual(pkg, specHeader, `package(${pkg}) != core spec header(${specHeader})`);
  assert.strictEqual(pkg, extHeader, `package(${pkg}) != extended spec header(${extHeader})`);
});

// 6. plugin.json declares the skills dir and it exists with SKILL.md files.
t('plugin: skills dir declared and populated', () => {
  const plugin = JSON.parse(read('.codex-plugin/plugin.json'));
  assert.strictEqual(plugin.skills, './skills/', 'plugin.json skills path');
  const skills = fs.readdirSync(path.join(ROOT, 'skills')).filter((d) => d.startsWith('agentsmd-'));
  assert(skills.length >= 4, 'expected ≥4 agentsmd-* skills, got ' + skills.length);
  for (const s of skills) assert(fs.existsSync(path.join(ROOT, 'skills', s, 'SKILL.md')), s + ' missing SKILL.md');
});

// 7. no shipped hook hardcodes a spec version string (it goes stale every release;
//    session-start-check.sh derives it from the installed spec, fallback neutral).
t('version: shipped hooks carry no hardcoded spec version fallback', () => {
  const ss = read('hooks/session-start-check.sh');
  const bad = ss.match(/VER="v?\d+\.\d+\.\d+"/);
  assert(!bad, `session-start-check.sh hardcodes ${bad && bad[0]} — the fallback must be version-neutral (e.g. VER="unknown")`);
});

// 8. the agentsmd-status skill's stated hook count matches the actual wiring —
//    a doc number that silently drifts misleads the agent reading it.
t('skill: agentsmd-status hook count matches the wiring', () => {
  const wiring = JSON.parse(read('hooks/hooks.json'));
  let n = 0;
  for (const groups of Object.values(wiring.hooks)) for (const g of groups || []) n += (g.hooks || []).length;
  const claim = (read('skills/agentsmd-status/SKILL.md').match(/agentsmdHooksRegistered`?\s*\(should be (\d+)\)/) || [])[1];
  assert.strictEqual(Number(claim), n, `SKILL.md claims ${claim} hooks, wiring registers ${n}`);
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
