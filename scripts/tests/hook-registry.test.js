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

// Flatten a hooks.json wiring into
// { basename → { event, matcher, timeout, additionalContextLimit } }.
function wiringMap(relPath) {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, relPath), 'utf8'));
  const map = {};
  for (const [event, groups] of Object.entries(j.hooks || {})) {
    for (const g of groups || []) {
      const matcher = g.matcher != null ? g.matcher : null;
      for (const h of g.hooks || []) {
        const m = (h.command || '').match(/\/([A-Za-z0-9._-]+\.sh)"/);
        assert.ok(m, 'unparseable hook command: ' + h.command);
        map[m[1]] = {
          event,
          matcher,
          timeout: h.timeout,
          additionalContextLimit: h.additionalContextLimit,
        };
      }
    }
  }
  return map;
}

t('HOOK_REGISTRY has 19 entries (matches drift hook count)', () => {
  assert.strictEqual(REG.HOOK_REGISTRY.length, 19);
});

for (const rel of ['hooks/hooks.json', 'hooks.json']) {
  t(`${rel} uses only Codex hook-manifest top-level fields`, () => {
    const wiring = JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
    assert.deepStrictEqual(
      Object.keys(wiring).sort(),
      ['description', 'hooks'],
      `${rel} top level must match Codex's strict hook-manifest schema`
    );
    assert.strictEqual(typeof wiring.description, 'string');
    assert.ok(wiring.description.trim(), `${rel} description must be non-empty`);
  });

  t(`registry <-> ${rel} agree on basename/event/matcher/timeout/context limit (both ways)`, () => {
    const w = wiringMap(rel);
    for (const h of REG.HOOK_REGISTRY) {
      const wired = w[h.basename];
      assert.ok(wired, `${h.basename} missing from ${rel}`);
      assert.strictEqual(wired.event, h.hookEvent, `${h.basename} event`);
      assert.strictEqual(wired.matcher, h.matcher, `${h.basename} matcher`);
      assert.strictEqual(wired.timeout, h.timeout, `${h.basename} timeout`);
      assert.strictEqual(
        wired.additionalContextLimit,
        h.additionalContextLimit,
        `${h.basename} additionalContextLimit`
      );
    }
    assert.strictEqual(Object.keys(w).length, REG.HOOK_REGISTRY.length, `${rel} introduces a hook the registry omits`);
  });
}

t('SessionStart subscribes to every context-rehydration source', () => {
  const expected = 'startup|resume|clear|compact';
  const registry = REG.HOOK_REGISTRY.find((hook) => hook.basename === 'session-start-check.sh');
  assert.strictEqual(registry && registry.matcher, expected, 'registry SessionStart matcher');
  for (const relative of ['hooks.json', 'hooks/hooks.json']) {
    const wiring = JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
    assert.strictEqual(wiring.hooks.SessionStart[0].matcher, expected, `${relative} SessionStart matcher`);
  }
});

t('each hook file calls hook_kill_switch "<envVarSuffix>" (registry <-> hook source)', () => {
  for (const h of REG.HOOK_REGISTRY) {
    const src = fs.readFileSync(path.join(ROOT, 'hooks', h.basename), 'utf8');
    assert.ok(src.includes(`hook_kill_switch "${h.envVarSuffix}"`), `${h.basename} missing hook_kill_switch "${h.envVarSuffix}"`);
  }
});

t('each plugin hook yields to an existing standalone surface', () => {
  for (const hook of REG.HOOK_REGISTRY) {
    const source = fs.readFileSync(path.join(ROOT, 'hooks', hook.basename), 'utf8');
    assert(
      source.includes('hook_plugin_shadowed_by_standalone && exit 0'),
      `${hook.basename} does not suppress its duplicate plugin copy when standalone is active`
    );
  }
});

t('derived exports (BASENAMES / ENV_SUFFIXES / NAME_TO_ENV) are consistent', () => {
  assert.strictEqual(REG.HOOK_BASENAMES.length, 19);
  assert.strictEqual(REG.HOOK_ENV_SUFFIXES.length, 19);
  assert.strictEqual(new Set(REG.HOOK_ENV_SUFFIXES).size, 19, 'suffixes must be unique');
  assert.strictEqual(REG.HOOK_NAME_TO_ENV['session-summary'], 'SESSION_SUMMARY');
  assert.strictEqual(REG.HOOK_NAME_TO_ENV['session-handoff-finalize'], 'SESSION_HANDOFF_FINALIZE');
});

t('killSwitchState mirrors hook_kill_switch (global + per-hook DISABLE_*_HOOK==1)', () => {
  assert.deepStrictEqual(REG.killSwitchState({}), { global: false, disabled: [] });
  assert.deepStrictEqual(REG.killSwitchState({ DISABLE_SECRETS_SCAN_HOOK: '1' }), { global: false, disabled: ['secrets-scan'] });
  const all = REG.killSwitchState({ DISABLE_AGENTSMD_HOOKS: '1' });
  assert.strictEqual(all.global, true);
  assert.strictEqual(all.disabled.length, 19);
  assert.deepStrictEqual(REG.killSwitchState({ DISABLE_SECRETS_SCAN_HOOK: '0' }).disabled, []); // only "1" counts
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
