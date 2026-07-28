'use strict';

// Protocol-v2 characterization gate for the single full profile.
//
// The writer now emits only full + extended metadata. The reader still accepts
// the immediately previous dual-profile schema so an owned install can migrate
// through `agentsmd update`; no runtime selection or public OMX profile remains.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const F = require('../lib/fs-atomic');
const AM = require('../lib/agents-md');

const ROOT = path.join(__dirname, '..', '..');
let PASS = 0;
let FAIL = 0;

function t(name, fn) {
  try {
    fn();
    PASS += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    FAIL += 1;
    console.log(`  FAIL ${name}\n     ${error.message}`);
  }
}

function clearLifecycleModules() {
  for (const key of Object.keys(require.cache)) {
    if (/scripts[\\/](lib[\\/])?[a-z-]+\.js$/.test(key)) delete require.cache[key];
  }
}

function loadLifecycle() {
  clearLifecycleModules();
  return {
    install: require('../install').install,
    uninstall: require('../uninstall').uninstall,
    arbitration: require('../lib/surface-arbitration'),
  };
}

function withSandbox(name, fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `agentsmd-protocol-v2-${name}-`));
  const previous = process.env.CODEX_HOME;
  const previousCodexBin = process.env.AGENTSMD_CODEX_BIN;
  process.env.CODEX_HOME = home;
  process.env.AGENTSMD_CODEX_BIN = path.join(__dirname, 'fixtures', 'codex');
  try {
    fn(home);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
    if (previousCodexBin === undefined) delete process.env.AGENTSMD_CODEX_BIN;
    else process.env.AGENTSMD_CODEX_BIN = previousCodexBin;
    clearLifecycleModules();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function manifestPath(home) {
  return path.join(home, '.agentsmd-state', 'manifest.json');
}

function readManifest(home) {
  return JSON.parse(fs.readFileSync(manifestPath(home), 'utf8'));
}

function writeManifest(home, manifest) {
  fs.writeFileSync(manifestPath(home), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function asV1Manifest(manifest) {
  const legacy = structuredClone(manifest);
  delete legacy.manifestSchemaVersion;
  legacy.surfaceProtocolVersion = 1;
  delete legacy.deliverySurface;
  delete legacy.profile;
  delete legacy.bundleProfiles;
  return legacy;
}

function asLegacyDualProfile(home, manifest) {
  const legacy = structuredClone(manifest);
  const deploy = path.join(home, 'agentsmd');
  const relativePath = 'spec/AGENTS-omx.md';
  const legacyCore = [
    '# CODEX-CODING-SPEC v4.25.4 — legacy OMX compatibility fixture',
    '',
    'Legacy profile bytes used only to exercise one-way update migration.',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(deploy, relativePath), legacyCore);
  const deployedFiles = F.treeEntries(deploy).filter((entry) => entry.type !== 'dir');
  const legacyRecord = deployedFiles.find((entry) => entry.path === relativePath);
  assert.ok(legacyRecord && legacyRecord.type === 'file', 'legacy profile fixture missing');

  legacy.profile = {
    selectionMode: 'auto',
    materialized: 'omx-compatible',
    reason: 'active-global-marker',
    coreRelativePath: relativePath,
    coreSha256: legacyRecord.sha256,
    capabilityContractVersion: 1,
  };
  legacy.bundleProfiles['omx-compatible'] = {
    relativePath,
    sha256: legacyRecord.sha256,
  };
  legacy.deployedFiles = deployedFiles;
  legacy.ownedArtifacts.deploy.sha256 = F.sha256Tree(deploy);

  const agentsPath = path.join(home, 'AGENTS.md');
  const withoutManaged = AM.removeSpecBlock(fs.readFileSync(agentsPath, 'utf8')).content;
  fs.writeFileSync(agentsPath, AM.injectSpecBlock(withoutManaged, legacyCore).content);
  return legacy;
}

function assertCompleteFullManifest(manifest, reason = 'single-full-profile') {
  assert.strictEqual(manifest.manifestSchemaVersion, 2);
  assert.strictEqual(manifest.surfaceProtocolVersion, 2);
  assert.strictEqual(manifest.deliverySurface, 'standalone');
  assert.deepStrictEqual(
    {
      selectionMode: manifest.profile.selectionMode,
      materialized: manifest.profile.materialized,
      reason: manifest.profile.reason,
      coreRelativePath: manifest.profile.coreRelativePath,
      capabilityContractVersion: manifest.profile.capabilityContractVersion,
    },
    {
      selectionMode: 'full',
      materialized: 'full',
      reason,
      coreRelativePath: 'spec/AGENTS.md',
      capabilityContractVersion: 1,
    }
  );
  assert.strictEqual(manifest.profile.coreSha256, manifest.bundleProfiles.full.sha256);
  assert.deepStrictEqual(
    Object.keys(manifest.bundleProfiles).sort(),
    ['extended', 'full', 'layoutSchemaVersion', 'layoutSha256']
  );
  for (const name of ['full', 'extended']) {
    assert.match(manifest.bundleProfiles[name].sha256, /^[a-f0-9]{64}$/);
  }
  assert.strictEqual(manifest.bundleProfiles.layoutSchemaVersion, 1);
  assert.match(manifest.bundleProfiles.layoutSha256, /^[a-f0-9]{64}$/);
}

withSandbox('writer-default', (home) => {
  const { install, arbitration } = loadLifecycle();
  const installed = install('2026-07-27T09:55:00.000Z');

  t('PV2-M01: the writer emits one complete full profile and directly manages global AGENTS.md', () => {
    assertCompleteFullManifest(installed);
    assert.strictEqual(arbitration.validateInstallManifest(installed), null);
    assert.match(fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'), /CLASSIFY → AUTH → ROUTE/);
    assert.strictEqual(fs.existsSync(path.join(home, 'agentsmd', 'spec', 'AGENTS-omx.md')), false);
  });
});

withSandbox('explicit-full', (home) => {
  const { install } = loadLifecycle();
  const installed = install('2026-07-27T09:56:00.000Z', { profile: 'full' });
  clearLifecycleModules();
  const status = require('../status').status();

  t('PV2-P01: explicit full selects the same complete profile', () => {
    assertCompleteFullManifest(installed, 'explicit-full');
    assert.strictEqual(status.configuredProfile, 'full');
    assert.strictEqual(status.desiredProfile, 'full');
    assert.strictEqual(status.profileState, 'aligned');
    assert.strictEqual(status.bundleProfilesComplete, true);
    assert.strictEqual(Object.hasOwn(status, 'omxDetection'), false);
  });
});

for (const removedProfile of ['auto', 'omx-compatible', 'legacy-full']) {
  withSandbox(`removed-${removedProfile}`, (home) => {
    const { install } = loadLifecycle();
    t(`PV2-P02: removed profile ${removedProfile} is rejected before mutation`, () => {
      assert.throws(
        () => install('2026-07-27T09:57:00.000Z', { profile: removedProfile }),
        /profile must be full/
      );
      assert.deepStrictEqual(fs.readdirSync(home), []);
    });
  });
}

withSandbox('foreign-marker', (home) => {
  fs.writeFileSync(
    path.join(home, 'AGENTS.md'),
    '<!-- omx:generated:agents-md -->\n# Foreign tenant content\n'
  );
  const { install } = loadLifecycle();
  const installed = install('2026-07-27T09:58:00.000Z');

  t('PV2-P03: a former OMX marker is ordinary preserved tenant content and cannot shrink the profile', () => {
    assertCompleteFullManifest(installed);
    const active = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    assert.match(active, /# Foreign tenant content/);
    assert.match(active, /CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT/);
  });
});

withSandbox('v1-read-update', (home) => {
  let { install, arbitration } = loadLifecycle();
  install('2026-07-27T10:00:00.000Z');
  const legacy = asV1Manifest(readManifest(home));

  t('PV2-M02: the current reader still accepts an implicit schema-1 manifest', () => {
    assert.strictEqual(arbitration.validateInstallManifest(legacy), null);
  });

  writeManifest(home, legacy);
  ({ install } = loadLifecycle());
  const updated = install('2026-07-27T10:01:00.000Z');

  t('PV2-L01: update migrates an owned v1 manifest to the single full schema', () => {
    assertCompleteFullManifest(updated);
    assert.strictEqual(readManifest(home).surfaceProtocolVersion, 2);
  });
});

withSandbox('dual-profile-update', (home) => {
  fs.writeFileSync(
    path.join(home, 'AGENTS.md'),
    '<!-- omx:generated:agents-md -->\n# Former OMX tenant fixture\n'
  );
  let { install, arbitration } = loadLifecycle();
  install('2026-07-27T10:02:00.000Z');
  const legacy = asLegacyDualProfile(home, readManifest(home));
  writeManifest(home, legacy);

  t('PV2-M03: the immediately previous dual-profile manifest remains readable', () => {
    assert.strictEqual(arbitration.validateInstallManifest(legacy), null);
  });

  ({ install } = loadLifecycle());
  const updated = install('2026-07-27T10:03:00.000Z');

  t('PV2-M03: update migrates a materialized OMX-compatible profile to full', () => {
    assertCompleteFullManifest(updated);
    assert.strictEqual(fs.existsSync(path.join(home, 'agentsmd', 'spec', 'AGENTS-omx.md')), false);
    const active = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    assert.match(active, /# Former OMX tenant fixture/);
    assert.match(active, /CLASSIFY → AUTH → ROUTE → PLAN → EXECUTE → VALIDATE → REPORT/);
    assert.doesNotMatch(active, /Legacy profile bytes used only/);
  });
});

withSandbox('manifest-validation', (home) => {
  const { install, arbitration } = loadLifecycle();
  const installed = install('2026-07-27T10:05:00.000Z');

  t('PV2-M03: missing full-profile metadata and future schemas fail closed', () => {
    const missing = structuredClone(installed);
    delete missing.bundleProfiles.extended;
    assert.match(arbitration.validateInstallManifest(missing), /bundleProfiles\.extended/);

    const malformedLegacy = structuredClone(installed);
    malformedLegacy.bundleProfiles['omx-compatible'] = 'corrupt legacy record';
    assert.match(
      arbitration.validateInstallManifest(malformedLegacy),
      /bundleProfiles\.omx-compatible must be an object/
    );

    const removedMode = structuredClone(installed);
    removedMode.profile.selectionMode = 'auto';
    assert.match(arbitration.validateInstallManifest(removedMode), /selectionMode must be one of: full/);

    const future = structuredClone(installed);
    future.manifestSchemaVersion = 3;
    assert.match(arbitration.validateInstallManifest(future), /unsupported manifest schema version 3/);
  });

  const mismatched = readManifest(home);
  mismatched.bundleProfiles.extended.sha256 = 'f'.repeat(64);
  writeManifest(home, mismatched);
  clearLifecycleModules();
  const damaged = require('../lib/surface-arbitration').inspectStandaloneSurface();

  t('PV2-M04: declared profile hash drift makes standalone health fail', () => {
    assert.strictEqual(damaged.healthy, false);
    assert(damaged.reasons.some((reason) => /bundle profile hash differs.*extended/.test(reason)),
      JSON.stringify(damaged.reasons));
  });
});

withSandbox('uninstall-authority', (home) => {
  const { install } = loadLifecycle();
  install('2026-07-27T10:20:00.000Z');
  const foreign = path.join(home, 'foreign-artifact.txt');
  fs.writeFileSync(foreign, 'foreign tenant\n');
  const manifest = readManifest(home);
  manifest.futureOwnedArtifactHints = [{ path: foreign, purpose: 'must-not-delete' }];
  writeManifest(home, manifest);

  const { uninstall } = loadLifecycle();
  uninstall();

  t('PV2-L02: additive metadata never grants uninstall deletion authority', () => {
    assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'foreign tenant\n');
    assert.strictEqual(fs.existsSync(manifestPath(home)), false);
  });
});

t('the shipped profile bundle contains aligned full and extended artifacts only', () => {
  const version = require(path.join(ROOT, 'package.json')).version;
  const files = [
    path.join(ROOT, 'spec', 'AGENTS.md'),
    path.join(ROOT, 'spec', 'AGENTS-extended.md'),
  ];
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'spec', 'AGENTS-omx.md')), false);
  for (const file of files) {
    assert.ok(fs.statSync(file).isFile(), `${path.relative(ROOT, file)} missing`);
    assert.match(
      fs.readFileSync(file, 'utf8'),
      new RegExp(`CODEX-CODING-SPEC v${version.replace(/\./g, '\\.')}(?:\\s|\\b)`)
    );
  }
});

t('protocol-v1 arbitration keeps its existing version-based yield direction', () => {
  const { arbitrateSurfaces } = require('../lib/surface-arbitration');
  const candidate = (version, protocolVersion) => ({
    detected: true,
    healthy: true,
    version,
    protocolVersion,
  });

  const standaloneWins = arbitrateSurfaces(candidate('4.2.0', 1), candidate('4.1.0', 1));
  assert.strictEqual(standaloneWins.selection.selected, 'standalone');
  assert.strictEqual(standaloneWins.selection.exclusive, true);

  const pluginWins = arbitrateSurfaces(candidate('4.1.0', 1), candidate('4.2.0', 1));
  assert.strictEqual(pluginWins.selection.selected, 'plugin');
  assert.strictEqual(pluginWins.selection.exclusive, false);
  assert.strictEqual(pluginWins.selection.loserCanYield, false);
});

console.log(`\nprotocol-v2 characterization: ${PASS} passed, ${FAIL} failed`);
if (FAIL) process.exit(1);
