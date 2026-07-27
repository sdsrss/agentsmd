'use strict';

// Protocol-v2 characterization gate.
//
// These tests intentionally run against the protocol-v1 writer. They lock the
// downgrade and no-regression behavior that must remain true while v2 readers
// and writers are introduced:
//   - v1 manifests remain readable;
//   - an immediately previous v1 lifecycle command tolerates additive v2
//     metadata without treating it as deletion authority;
//   - v1 update can replace a v2-shaped additive manifest with a complete v1
//     install;
//   - the complete full/OMX/extended profile bundle remains available;
//   - protocol-v1 arbitration never invents reciprocal standalone-to-plugin
//     yield.
//
// Every filesystem mutation is confined to a mkdtemp CODEX_HOME.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

function additiveV2Envelope(manifest, foreignPath = null) {
  const deployedSha = (relative) => {
    const record = manifest.deployedFiles.find((candidate) => candidate.path === relative);
    assert.ok(record && typeof record.sha256 === 'string', `missing deployed digest: ${relative}`);
    return record.sha256;
  };
  return {
    ...manifest,
    manifestSchemaVersion: 2,
    surfaceProtocolVersion: 2,
    deliverySurface: 'standalone',
    profile: {
      selectionMode: 'legacy-full',
      materialized: 'full',
      reason: 'v1-upgrade-preservation',
      coreRelativePath: 'spec/AGENTS.md',
      coreSha256: deployedSha('spec/AGENTS.md'),
      capabilityContractVersion: 1,
    },
    bundleProfiles: {
      full: { relativePath: 'spec/AGENTS.md', sha256: deployedSha('spec/AGENTS.md') },
      'omx-compatible': {
        relativePath: 'spec/AGENTS-omx.md',
        sha256: deployedSha('spec/AGENTS-omx.md'),
      },
      extended: {
        relativePath: 'spec/AGENTS-extended.md',
        sha256: deployedSha('spec/AGENTS-extended.md'),
      },
      layoutSchemaVersion: 1,
      layoutSha256: deployedSha('spec/source/layout.json'),
    },
    ...(foreignPath ? {
      futureOwnedArtifactHints: [{ path: foreignPath, purpose: 'must-not-delete' }],
    } : {}),
  };
}

withSandbox('v1-read', (home) => {
  const { install, arbitration } = loadLifecycle();
  install('2026-07-27T10:00:00.000Z');
  const manifest = readManifest(home);

  t('PV2-M01: current standalone output is a valid implicit schema-1 manifest', () => {
    assert.strictEqual(manifest.surfaceProtocolVersion, 1);
    assert.strictEqual(Object.hasOwn(manifest, 'manifestSchemaVersion'), false);
    assert.strictEqual(arbitration.validateInstallManifest(manifest), null);
  });

  t('PV2-M08: the previous v1 reader tolerates additive v2 metadata', () => {
    const additive = additiveV2Envelope(manifest);
    assert.strictEqual(arbitration.validateInstallManifestV1(additive), null);
    const brokenOwnership = structuredClone(additive);
    brokenOwnership.ownedArtifacts.deploy.sha256 = 'not-a-digest';
    assert.match(arbitration.validateInstallManifestV1(brokenOwnership), /SHA-256/);
  });

  t('PV2-M02/M04/M07: the current reader strictly separates valid, damaged, and future v2 schemas', () => {
    const valid = additiveV2Envelope(manifest);
    assert.strictEqual(arbitration.validateInstallManifest(valid), null);

    const missingProfile = structuredClone(valid);
    delete missingProfile.bundleProfiles.extended;
    assert.match(arbitration.validateInstallManifest(missingProfile), /bundleProfiles\.extended/);

    const future = structuredClone(valid);
    future.manifestSchemaVersion = 3;
    assert.match(arbitration.validateInstallManifest(future), /unsupported manifest schema version 3/);
  });
});

withSandbox('v1-update', (home) => {
  let { install } = loadLifecycle();
  install('2026-07-27T10:10:00.000Z');
  writeManifest(home, additiveV2Envelope(readManifest(home)));

  ({ install } = loadLifecycle());
  const updated = install('2026-07-27T10:11:00.000Z');

  t('PV2-L10: the previous v1 updater replaces additive v2 metadata with a complete v1 install', () => {
    assert.strictEqual(updated.surfaceProtocolVersion, 1);
    assert.strictEqual(Object.hasOwn(updated, 'manifestSchemaVersion'), false);
    assert.strictEqual(Object.hasOwn(updated, 'profile'), false);
    assert.strictEqual(readManifest(home).surfaceProtocolVersion, 1);
    assert.ok(fs.existsSync(path.join(home, 'agentsmd', 'spec', 'AGENTS.md')));
    assert.ok(fs.existsSync(path.join(home, 'agentsmd', 'spec', 'AGENTS-omx.md')));
    assert.ok(fs.existsSync(path.join(home, 'agentsmd', 'spec', 'AGENTS-extended.md')));
  });
});

withSandbox('v2-full-read', (home) => {
  const { install } = loadLifecycle();
  install('2026-07-27T10:15:00.000Z');
  writeManifest(home, additiveV2Envelope(readManifest(home)));

  clearLifecycleModules();
  const arbitration = require('../lib/surface-arbitration');
  const status = require('../status').status();
  const inspected = arbitration.inspectStandaloneSurface();

  t('dual reader accepts a valid metadata-only v2 full profile without changing active bytes', () => {
    assert.strictEqual(inspected.healthy, true, JSON.stringify(inspected.reasons));
    assert.strictEqual(inspected.manifestSchemaVersion, 2);
    assert.deepStrictEqual(inspected.profile, {
      selectionMode: 'legacy-full',
      materialized: 'full',
      reason: 'v1-upgrade-preservation',
    });
    assert.strictEqual(status.manifestSchemaVersion, 2);
    assert.strictEqual(status.surfaceProtocolVersion, 2);
    assert.strictEqual(status.configuredProfile, 'full');
    assert.strictEqual(status.profileSelectionMode, 'legacy-full');
  });

  const mismatched = readManifest(home);
  mismatched.bundleProfiles.extended.sha256 = 'f'.repeat(64);
  writeManifest(home, mismatched);
  clearLifecycleModules();
  const damaged = require('../lib/surface-arbitration').inspectStandaloneSurface();

  t('PV2-M04: dual reader fails structural health when a declared fallback artifact hash lies', () => {
    assert.strictEqual(damaged.healthy, false);
    assert(damaged.reasons.some((reason) => /bundle profile hash differs.*extended/.test(reason)),
      JSON.stringify(damaged.reasons));
  });
});

withSandbox('v2-omx-read', (home) => {
  const { install } = loadLifecycle();
  install('2026-07-27T10:17:00.000Z');
  const manifest = additiveV2Envelope(readManifest(home));
  manifest.profile = {
    selectionMode: 'omx-compatible',
    materialized: 'omx-compatible',
    reason: 'active-global-marker',
    coreRelativePath: 'spec/AGENTS-omx.md',
    coreSha256: manifest.bundleProfiles['omx-compatible'].sha256,
    capabilityContractVersion: 1,
  };
  const AM = require('../lib/agents-md');
  const globalPath = path.join(home, 'AGENTS.md');
  const global = fs.readFileSync(globalPath, 'utf8');
  const omxCore = fs.readFileSync(path.join(home, 'agentsmd', 'spec', 'AGENTS-omx.md'), 'utf8');
  fs.writeFileSync(globalPath, AM.injectSpecBlock(global, omxCore).content);
  writeManifest(home, manifest);

  clearLifecycleModules();
  const inspected = require('../lib/surface-arbitration').inspectStandaloneSurface();

  t('dual reader validates a materialized OMX-compatible standalone profile', () => {
    assert.strictEqual(inspected.healthy, true, JSON.stringify(inspected.reasons));
    assert.strictEqual(inspected.profile.materialized, 'omx-compatible');
    assert.strictEqual(inspected.activeSpec.contentMatchesDeployed, true);
  });
});

withSandbox('v1-uninstall', (home) => {
  let { install } = loadLifecycle();
  install('2026-07-27T10:20:00.000Z');
  const foreign = path.join(home, 'foreign-profile-artifact.txt');
  fs.writeFileSync(foreign, 'foreign tenant\n');
  writeManifest(home, additiveV2Envelope(readManifest(home), foreign));

  const { uninstall } = loadLifecycle();
  uninstall();

  t('PV2-L11: the previous v1 uninstaller ignores additive profile paths as deletion authority', () => {
    assert.strictEqual(fs.readFileSync(foreign, 'utf8'), 'foreign tenant\n');
    assert.strictEqual(fs.existsSync(manifestPath(home)), false);
    assert.strictEqual(fs.existsSync(path.join(home, 'agentsmd', 'spec', 'AGENTS.md')), false);
  });
});

t('profile bundle keeps full, OMX-compatible, and extended artifacts aligned', () => {
  const version = require(path.join(ROOT, 'package.json')).version;
  const files = [
    path.join(ROOT, 'spec', 'AGENTS.md'),
    path.join(ROOT, 'spec', 'AGENTS-omx.md'),
    path.join(ROOT, 'spec', 'AGENTS-extended.md'),
  ];
  for (const file of files) {
    assert.ok(fs.statSync(file).isFile(), `${path.relative(ROOT, file)} missing`);
    assert.match(fs.readFileSync(file, 'utf8'), new RegExp(`CODEX-CODING-SPEC v${version.replace(/\./g, '\\.')}(?:\\s|\\b)`));
  }
});

t('protocol-v1 arbitration exposes only the existing plugin-to-standalone yield direction', () => {
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
