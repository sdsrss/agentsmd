'use strict';

const assert = require('assert');
const { inspectSelectedPluginSurface } = require('../lib/doctor-plugin');

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}: ${error.stack || error.message}`);
  }
}

function pluginStatus(overrides = {}) {
  const status = {
    dualSurface: false,
    pluginActivation: {
      observed: false,
      reason: 'receipt-missing',
      receipt: null,
    },
    surfaceArbitration: {
      candidates: {
        plugin: {
          detected: true,
          healthy: true,
          manifest: { valid: true, hooksPath: './hooks.json' },
          hooks: {
            valid: true,
            registered: 19,
            expected: 19,
            missingScripts: [],
            missingSupport: [],
          },
          spec: { core: true, extended: true },
          errors: [],
        },
        standalone: {
          detected: false,
          healthy: false,
          version: null,
          reasons: [],
        },
      },
      selection: {
        selected: 'plugin',
        reasonCode: 'plugin-only-healthy',
        exclusive: true,
      },
    },
  };
  return Object.assign(status, overrides);
}

test('returns null when the plugin is absent', () => {
  const status = pluginStatus();
  status.surfaceArbitration.candidates.plugin.detected = false;
  assert.strictEqual(inspectSelectedPluginSurface(status), null);
});

test('returns null when standalone wins arbitration', () => {
  const status = pluginStatus();
  status.surfaceArbitration.selection.selected = 'standalone';
  assert.strictEqual(inspectSelectedPluginSurface(status), null);
});

test('healthy plugin diagnosis preserves row order and does not mutate input', () => {
  const status = pluginStatus();
  const before = JSON.stringify(status);
  const result = inspectSelectedPluginSurface(status);
  assert.strictEqual(JSON.stringify(status), before);
  assert.deepStrictEqual(Object.keys(result), [
    'surface',
    'selectedSurface',
    'dualSurface',
    'pluginActivation',
    'surfaceArbitration',
    'checks',
  ]);
  assert.deepStrictEqual(result.checks.map((check) => check.name), [
    'plugin manifest selects ./hooks.json',
    'plugin hooks registered',
    'plugin hook scripts present',
    'plugin hook support present',
    'plugin core spec present',
    'plugin extended spec present',
    'plugin SessionStart activation',
    'dual surface absent',
    'surface arbitration selected a healthy candidate',
    'surface arbitration has no non-cooperative loser',
  ]);
  assert(result.checks.every((check) => check.ok));
  assert.strictEqual(result.checks[6].detail,
    'unverified (receipt-missing) — no SessionStart receipt was observed; review the agentsmd hooks, then start a new session');
});

test('broken dual surface retains bounded diagnostic details', () => {
  const status = pluginStatus({ dualSurface: true });
  Object.assign(status.surfaceArbitration.candidates.plugin, {
    healthy: false,
    manifest: { valid: false, hooksPath: 'hooks/hooks.json' },
    hooks: {
      valid: false,
      registered: 3,
      expected: 19,
      missingScripts: ['pre-bash-safety-check.sh'],
      missingSupport: ['hooks/lib/hook-common.sh'],
    },
    spec: { core: false, extended: false },
    errors: ['manifest hooks path must be ./hooks.json'],
  });
  Object.assign(status.surfaceArbitration.candidates.standalone, {
    detected: true,
    healthy: false,
    version: '5.3.3',
    reasons: ['manifest invalid', 'hooks invalid', 'config invalid', 'fourth reason is bounded'],
  });
  Object.assign(status.surfaceArbitration.selection, {
    reasonCode: 'plugin-less-unhealthy',
    exclusive: false,
  });
  const result = inspectSelectedPluginSurface(status);
  const byName = new Map(result.checks.map((check) => [check.name, check]));
  assert.strictEqual(byName.get('plugin manifest selects ./hooks.json').detail, 'hooks/hooks.json');
  assert.strictEqual(byName.get('plugin hook scripts present').detail, 'missing: pre-bash-safety-check.sh');
  assert.strictEqual(byName.get('plugin hook support present').detail, 'missing: hooks/lib/hook-common.sh');
  assert.match(byName.get('dual surface absent').detail, /plugin-less-unhealthy/);
  assert.match(byName.get('surface arbitration has no non-cooperative loser').detail, /non-cooperative/);
  assert.strictEqual(byName.get('standalone candidate healthy').detail,
    'manifest invalid; hooks invalid; config invalid');
});

test('observed activation renders the bounded receipt fields', () => {
  const status = pluginStatus({
    pluginActivation: {
      observed: true,
      reason: 'receipt-valid',
      receipt: {
        observedAt: '2026-08-25T00:00:00.000Z',
        sessionId: 'session-1',
        profile: 'full',
        profileReason: 'default',
        extendedPath: '/plugin/spec/AGENTS-extended.md',
      },
    },
  });
  const row = inspectSelectedPluginSurface(status).checks
    .find((check) => check.name === 'plugin SessionStart activation');
  assert.strictEqual(row.ok, true);
  assert.match(row.detail, /session=session-1; profile=full; reason=default/);
  assert.match(row.detail, /not that Codex accepted the response/);
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
