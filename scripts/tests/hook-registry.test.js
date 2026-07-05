'use strict';
// hook-registry.test.js — hook-registry (scripts/lib/hook-registry.js) is the
// single source of truth for agentsmd's hooks + kill-switch suffixes. This asserts
// it never drifts from (a) either hooks.json wiring — the install template
// (hooks/hooks.json) and the plugin-root manifest (hooks.json) — agreeing on
// basename/event/matcher/timeout both ways, and (b) each hook's own
// `hook_kill_switch "<SUFFIX>"` call. Editing a wiring or a kill-switch name
// without updating the registry fails here. Complements drift.test #4 (which
// asserts the two wirings match EACH OTHER) by binding both to the registry.

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const REG = require('../lib/hook-registry');

const ROOT = path.join(__dirname, '..', '..');
let PASS = 0, FAIL = 0;
const t = (n, f) => { try { f(); PASS++; console.log('  ok   ' + n); } catch (e) { FAIL++; console.log('  FAIL ' + n + '\n     ' + e.message); } };

// Flatten a hooks.json wiring into { basename → { event, matcher, timeout } }.
function wiringMap(relPath) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
  const map = {};
  for (const [event, groups] of Object.entries(j.hooks || {})) {
    for (const g of groups || []) {
      const matcher = g.matcher != null ? g.matcher : null;
      for (const h of g.hooks || []) {
        const m = (h.command || '').match(/\/([A-Za-z0-9._-]+\.sh)"/);
        assert.ok(m, 'unparseable hook command: ' + h.command);
        map[m[1]] = { event, matcher, timeout: h.timeout };
      }
    }
  }
  return map;
}

t('HOOK_REGISTRY has 15 entries (matches drift #8 hook count)', () => {
  assert.strictEqual(REG.HOOK_REGISTRY.length, 15);
});

for (const rel of ['hooks/hooks.json', 'hooks.json']) {
  t(`registry <-> ${rel} agree on basename/event/matcher/timeout (both ways)`, () => {
    const w = wiringMap(rel);
    for (const h of REG.HOOK_REGISTRY) {
      const wired = w[h.basename];
      assert.ok(wired, `${h.basename} missing from ${rel}`);
      assert.strictEqual(wired.event, h.hookEvent, `${h.basename} event`);
      assert.strictEqual(wired.matcher, h.matcher, `${h.basename} matcher`);
      assert.strictEqual(wired.timeout, h.timeout, `${h.basename} timeout`);
    }
    assert.strictEqual(Object.keys(w).length, REG.HOOK_REGISTRY.length, `${rel} introduces a hook the registry omits`);
  });
}

t('each hook file calls hook_kill_switch "<envVarSuffix>" (registry <-> hook source)', () => {
  for (const h of REG.HOOK_REGISTRY) {
    const src = fs.readFileSync(path.join(ROOT, 'hooks', h.basename), 'utf8');
    assert.ok(src.includes(`hook_kill_switch "${h.envVarSuffix}"`), `${h.basename} missing hook_kill_switch "${h.envVarSuffix}"`);
  }
});

t('derived exports (BASENAMES / ENV_SUFFIXES / NAME_TO_ENV) are consistent', () => {
  assert.strictEqual(REG.HOOK_BASENAMES.length, 15);
  assert.strictEqual(REG.HOOK_ENV_SUFFIXES.length, 15);
  assert.strictEqual(new Set(REG.HOOK_ENV_SUFFIXES).size, 15, 'suffixes must be unique');
  assert.strictEqual(REG.HOOK_NAME_TO_ENV['session-summary'], 'SESSION_SUMMARY');
});

t('killSwitchState mirrors hook_kill_switch (global + per-hook DISABLE_*_HOOK==1)', () => {
  assert.deepStrictEqual(REG.killSwitchState({}), { global: false, disabled: [] });
  assert.deepStrictEqual(REG.killSwitchState({ DISABLE_SECRETS_SCAN_HOOK: '1' }), { global: false, disabled: ['secrets-scan'] });
  const all = REG.killSwitchState({ DISABLE_AGENTSMD_HOOKS: '1' });
  assert.strictEqual(all.global, true);
  assert.strictEqual(all.disabled.length, 15);
  assert.deepStrictEqual(REG.killSwitchState({ DISABLE_SECRETS_SCAN_HOOK: '0' }).disabled, []); // only "1" counts
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
