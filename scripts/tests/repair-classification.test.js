'use strict';

const assert = require('assert');
const { classifyRepairEvidence } = require('../lib/repair-classification');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const source = { version: '5.3.3', deploySha256: HASH_A };
const manifest = {
  version: '5.3.3',
  ownedArtifacts: { deploy: { sha256: HASH_A } },
};

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

function decide(overrides = {}) {
  return classifyRepairEvidence({
    manifestState: { present: true, valid: true, manifest, error: null },
    source,
    missing: [],
    mismatched: [],
    unexpected: [],
    blockers: [],
    ...overrides,
  });
}

const cases = [
  {
    name: 'no manifest and no footprint is not installed',
    input: {
      manifestState: { present: false, valid: false, manifest: null, error: null },
    },
    expected: {
      classification: 'not-installed',
      applyAllowed: false,
      blockers: [],
      recommendedAction: {
        code: 'install',
        command: 'agentsmd install',
        reason: 'no active standalone install was found',
      },
    },
  },
  {
    name: 'manifest-less footprint requires manual ownership inspection',
    input: {
      manifestState: { present: false, valid: false, manifest: null, error: null },
      standaloneFootprintPresent: true,
    },
    expected: {
      classification: 'ownership-unprovable',
      applyAllowed: false,
      blockers: ['manifest is missing while an agentsmd runtime/shared footprint remains'],
      recommendedAction: {
        code: 'inspect-manually',
        command: 'agentsmd repair --plan',
        reason: 'automatic repair cannot prove ownership without a valid manifest',
      },
    },
  },
  {
    name: 'invalid manifest retains its exact evidence',
    input: {
      manifestState: { present: true, valid: false, manifest: null, error: 'manifest is not valid JSON' },
    },
    expected: {
      classification: 'ownership-unprovable',
      applyAllowed: false,
      blockers: ['manifest is not valid JSON'],
      recommendedAction: {
        code: 'inspect-manually',
        command: 'agentsmd repair --plan',
        reason: 'automatic repair cannot prove ownership from this manifest',
      },
    },
  },
  {
    name: 'matching missing files permit digest-bound confirmation',
    input: { missing: ['deploy:hooks/lib/hook-common.sh'] },
    expected: {
      classification: 'owned-files-missing',
      applyAllowed: true,
      blockers: [],
      recommendedAction: {
        code: 'confirm-repair',
        command: 'agentsmd repair --confirm=<planDigest>',
        reason: 'valid ownership exists and only manifest-recorded files or directories are missing',
      },
    },
  },
  {
    name: 'missing files from another release require the matching artifact',
    input: {
      manifestState: {
        present: true,
        valid: true,
        manifest: { version: '5.2.0', ownedArtifacts: { deploy: { sha256: HASH_B } } },
        error: null,
      },
      missing: ['extended:AGENTS-extended.md'],
    },
    expected: {
      classification: 'matching-artifact-required',
      applyAllowed: false,
      blockers: [],
      recommendedAction: {
        code: 'use-matching-artifact',
        command: 'run agentsmd repair --plan from @sdsrs/agentsmd@5.2.0',
        reason: 'repair replaces the complete release tree, so its source version and deploy digest must match the ownership manifest',
      },
    },
  },
  {
    name: 'intact older ownership is update ready',
    input: {
      manifestState: {
        present: true,
        valid: true,
        manifest: { version: '5.2.0', ownedArtifacts: { deploy: { sha256: HASH_B } } },
        error: null,
      },
    },
    expected: {
      classification: 'update-ready',
      applyAllowed: false,
      blockers: [],
      recommendedAction: {
        code: 'update',
        command: 'agentsmd update',
        reason: 'owned artifacts are intact and can use the ordinary update path',
      },
    },
  },
  {
    name: 'intact current ownership is healthy',
    input: {},
    expected: {
      classification: 'healthy',
      applyAllowed: false,
      blockers: [],
      recommendedAction: {
        code: 'none',
        command: null,
        reason: 'standalone owned artifacts are intact and current',
      },
    },
  },
];

for (const fixture of cases) {
  test(fixture.name, () => assert.deepStrictEqual(decide(fixture.input), fixture.expected));
}

test('blockers outrank modified and missing evidence without mutating inputs', () => {
  const blockers = ['shared path has unsafe live type: hooks.json:symlink'];
  const missing = ['deploy:hooks/lib/hook-common.sh'];
  const mismatched = ['extended:AGENTS-extended.md'];
  const unexpected = ['skill:agentsmd-future'];
  const inputBefore = JSON.stringify({ blockers, missing, mismatched, unexpected, manifest, source });
  const result = decide({ blockers, missing, mismatched, unexpected });
  assert.strictEqual(result.classification, 'ownership-unprovable');
  assert.strictEqual(result.applyAllowed, false);
  assert.deepStrictEqual(result.blockers, blockers);
  assert.notStrictEqual(result.blockers, blockers);
  assert.deepStrictEqual(result.recommendedAction, {
    code: 'inspect-manually',
    command: 'agentsmd repair --plan',
    reason: 'automatic repair will not overwrite modified, unexpected, unsafe, or unprovable content',
  });
  assert.strictEqual(JSON.stringify({ blockers, missing, mismatched, unexpected, manifest, source }), inputBefore);
});

test('modified or unexpected content outranks otherwise repairable missing files', () => {
  for (const evidence of [
    { mismatched: ['deploy:hooks/lib/hook-common.sh'] },
    { unexpected: ['deploy:unexpected.txt'] },
  ]) {
    const result = decide({ missing: ['extended:AGENTS-extended.md'], ...evidence });
    assert.strictEqual(result.classification, 'owned-content-modified');
    assert.strictEqual(result.applyAllowed, false);
    assert.strictEqual(result.recommendedAction.code, 'inspect-manually');
  }
});

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
