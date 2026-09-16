'use strict';

const assert = require('assert');
const { inspectStandaloneConfiguration } = require('../lib/doctor-standalone');
const { HOOK_REGISTRY } = require('../lib/hook-registry');

function fixture() {
  return {
    surfaceStatus: {
      dualSurface: false,
      surfaceArbitration: {
        selection: {
          selected: 'standalone',
          reasonCode: 'standalone-only-healthy',
        },
        candidates: {
          plugin: { detected: false },
          standalone: {
            healthy: true,
            config: {
              parseable: true,
              validator: 'codex fixture',
              hooksEnabled: true,
            },
          },
        },
      },
    },
    cfg: '[tui]\nstatus_line = ["model-name"]\n',
    hooksParseable: true,
    registeredHooks: HOOK_REGISTRY.length,
    manifestRaw: '{"name":"agentsmd"}',
  };
}

const cases = [
  ['healthy', () => {}, []],
  [
    'unselected',
    (v) => {
      v.surfaceStatus.surfaceArbitration.selection.selected = null;
    },
    ['surface arbitration selected a healthy candidate'],
  ],
  [
    'unhealthy',
    (v) => {
      v.surfaceStatus.surfaceArbitration.candidates.standalone.healthy = false;
    },
    ['surface arbitration selected a healthy candidate'],
  ],
  [
    'dual',
    (v) => {
      v.surfaceStatus.dualSurface = true;
      v.surfaceStatus.surfaceArbitration.candidates.plugin.detected = true;
    },
    ['dual surface absent'],
  ],
  [
    'CLI absent',
    (v) => {
      Object.assign(
        v.surfaceStatus.surfaceArbitration.candidates.standalone.config,
        { parseable: false, errorCode: 'codex-cli-unavailable' }
      );
    },
    ['config.toml accepted by Codex parser'],
  ],
  [
    'config rejected',
    (v) => {
      Object.assign(
        v.surfaceStatus.surfaceArbitration.candidates.standalone.config,
        { parseable: false, errorCode: 'invalid-config', hooksEnabled: false }
      );
    },
    ['config.toml accepted by Codex parser', 'config.toml features.hooks=true'],
  ],
  [
    'status line missing',
    (v) => {
      v.cfg = '';
    },
    ['config.toml tui.status_line configured'],
  ],
  [
    'status line malformed',
    (v) => {
      v.cfg = '[tui]\nstatus_line = 42\n';
    },
    ['config.toml tui.status_line configured'],
  ],
  [
    'hooks malformed',
    (v) => {
      v.hooksParseable = false;
      v.registeredHooks = 0;
    },
    ['hooks.json parseable', 'agentsmd hooks registered'],
  ],
  [
    'hooks missing',
    (v) => {
      v.registeredHooks = 0;
    },
    ['agentsmd hooks registered'],
  ],
  [
    'partial install',
    (v) => {
      v.manifestRaw = null;
    },
    ['install state consistent (manifest vs live hooks)'],
  ],
  [
    'uninstalled',
    (v) => {
      v.manifestRaw = null;
      v.registeredHooks = 0;
    },
    ['agentsmd hooks registered'],
  ],
  [
    'manifest malformed',
    (v) => {
      v.manifestRaw = '{';
    },
    [],
  ],
  [
    'manifest JSON null',
    (v) => {
      v.manifestRaw = 'null';
    },
    [],
  ],
];

let failed = 0;
for (const [name, change, failures] of cases) {
  try {
    const input = fixture();
    change(input);
    const before = JSON.stringify(input);
    const result = inspectStandaloneConfiguration(input);
    assert.strictEqual(
      JSON.stringify(input),
      before,
      'mapping must not mutate evidence'
    );
    assert.deepStrictEqual(Object.keys(result), [
      'checks',
      'manifestInstalled',
      'manifest',
    ]);
    assert.deepStrictEqual(
      result.checks.filter((row) => !row.ok).map((row) => row.name),
      failures
    );
    assert.deepStrictEqual(
      result.checks.map((row) => row.name),
      [
        'surface arbitration selected a healthy candidate',
        ...(input.surfaceStatus.surfaceArbitration.candidates.plugin.detected
          ? ['dual surface absent']
          : []),
        'config.toml accepted by Codex parser',
        'config.toml features.hooks=true',
        'config.toml tui.status_line configured',
        'hooks.json parseable',
        'agentsmd hooks registered',
        'install state consistent (manifest vs live hooks)',
      ]
    );
    assert.strictEqual(result.manifestInstalled, input.manifestRaw !== null);
    if (name === 'manifest malformed' || name === 'manifest JSON null')
      assert.strictEqual(result.manifest, null);
    if (name === 'CLI absent')
      assert.match(result.checks[1].detail, /surface health unverifiable/);
    if (name === 'partial install')
      assert.match(
        result.checks.at(-1).detail,
        /repair --plan; automatic apply requires valid ownership evidence/
      );
    console.log(`  ok   standalone mapping: ${name}`);
  } catch (error) {
    failed += 1;
    console.error(`  FAIL ${name}: ${error.stack}`);
  }
}
console.log(`\nRESULT: ${cases.length - failed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;

module.exports = { fixture, cases };
