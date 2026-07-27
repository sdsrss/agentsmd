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
  process.env.CODEX_HOME = home;
  try {
    fn(home);
  } finally {
    if (previous === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previous;
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
      coreSha256: manifest.deployedFiles.find((record) => record.path === 'spec/AGENTS.md').sha256,
      capabilityContractVersion: 1,
    },
    bundleProfiles: {
      full: { relativePath: 'spec/AGENTS.md', sha256: '0'.repeat(64) },
      'omx-compatible': { relativePath: 'spec/AGENTS-omx.md', sha256: '1'.repeat(64) },
      extended: { relativePath: 'spec/AGENTS-extended.md', sha256: '2'.repeat(64) },
      ...(foreignPath ? {
        foreign: { relativePath: foreignPath, sha256: '3'.repeat(64) },
      } : {}),
      layoutSchemaVersion: 1,
      layoutSha256: '4'.repeat(64),
    },
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
    assert.strictEqual(arbitration.validateInstallManifest(additive), null);
    const brokenOwnership = structuredClone(additive);
    brokenOwnership.ownedArtifacts.deploy.sha256 = 'not-a-digest';
    assert.match(arbitration.validateInstallManifest(brokenOwnership), /SHA-256/);
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

