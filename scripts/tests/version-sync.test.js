'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const cp = require('child_process');
const V = require('../version-sync');

const ROOT = path.resolve(__dirname, '..', '..');
const FILES = [
  'package.json',
  '.codex-plugin/plugin.json',
  '.agents/plugins/marketplace.json',
  'spec/hard-rules.json',
  'spec/AGENTS.md',
  'spec/AGENTS-extended.md',
  'install.sh',
];

let PASS = 0, FAIL = 0;
const t = (name, fn) => {
  try { fn(); PASS++; console.log('  ok   ' + name); }
  catch (error) { FAIL++; console.log('  FAIL ' + name + '\n     ' + error.message); }
};

function withFixture(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmd-version-sync.'));
  try {
    for (const rel of FILES) {
      const target = path.join(root, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.copyFileSync(path.join(ROOT, rel), target);
    }
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

t('syncVersion updates package, plugin, marketplace, manifest, and both spec headers', () => withFixture((root) => {
  const result = V.syncVersion({ root, version: '4.0.1' });
  assert.deepStrictEqual(result.files, FILES);
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).version, '4.0.1');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, '.codex-plugin/plugin.json'))).version, '4.0.1');
  const marketplace = JSON.parse(fs.readFileSync(path.join(root, '.agents/plugins/marketplace.json')));
  assert.strictEqual(marketplace.plugins[0].source.version, '4.0.1');
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'spec/hard-rules.json'))).spec_version, 'v4.0.1');
  assert.match(fs.readFileSync(path.join(root, 'spec/AGENTS.md'), 'utf8'), /CODEX-CODING-SPEC v4\.0\.1/);
  assert.match(fs.readFileSync(path.join(root, 'spec/AGENTS-extended.md'), 'utf8'), /CODEX-CODING-SPEC v4\.0\.1/);
  assert.match(fs.readFileSync(path.join(root, 'install.sh'), 'utf8'), /INSTALLER_VERSION="4\.0\.1"/);
}));

t('syncVersion rejects invalid semver before changing any file', () => withFixture((root) => {
  const before = new Map(FILES.map((rel) => [rel, fs.readFileSync(path.join(root, rel))]));
  for (const version of ['4.0', '04.0.1', '4.00.1', '4.0.01', '4.0.1-rc.1', '4.0.1+build.1']) {
    assert.throws(() => V.syncVersion({ root, version }), /stable X\.Y\.Z semantic version/i, version);
  }
  for (const rel of FILES) assert.deepStrictEqual(fs.readFileSync(path.join(root, rel)), before.get(rel), rel);
}));

t('syncVersion detects a concurrent edit after snapshot and preserves its bytes', () => withFixture((root) => {
  const before = new Map(FILES.map((rel) => [rel, fs.readFileSync(path.join(root, rel))]));
  const atomic = require('../lib/fs-atomic').writeFileAtomic;
  const packageFile = path.join(root, 'package.json');
  let injected = false;
  assert.throws(() => V.syncVersion({
    root,
    version: '4.0.1',
    write(file, content, options) {
      if (!injected) {
        fs.appendFileSync(packageFile, '\nconcurrent-marker\n');
        injected = true;
      }
      atomic(file, content, options);
    },
  }), /concurrent change detected/);
  assert.match(fs.readFileSync(packageFile, 'utf8'), /concurrent-marker/);
  for (const rel of FILES.slice(1)) assert.deepStrictEqual(fs.readFileSync(path.join(root, rel)), before.get(rel), rel);
}));

t('syncVersion rolls back earlier files when a later atomic write fails', () => withFixture((root) => {
  const before = new Map(FILES.map((rel) => [rel, fs.readFileSync(path.join(root, rel))]));
  const atomic = require('../lib/fs-atomic').writeFileAtomic;
  let writes = 0;
  assert.throws(() => V.syncVersion({
    root,
    version: '4.0.1',
    write(file, content, options) {
      writes++;
      if (writes === 4) throw new Error('simulated version-sync write failure');
      atomic(file, content, options);
    },
  }), /simulated version-sync write failure/);
  for (const rel of FILES) assert.deepStrictEqual(fs.readFileSync(path.join(root, rel)), before.get(rel), rel);
}));

t('CLI rejects a missing version with usage exit 2', () => {
  const script = path.join(ROOT, 'scripts/version-sync.js');
  for (const args of [[], ['--version=4.0'], ['--version=4.0.1-rc.1'], ['--version=4.0.1', '--version=4.0.2']]) {
    const result = cp.spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.strictEqual(result.status, 2, `${args.join(' ')}\n${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /Usage:/);
  }
});

console.log(`\nRESULT: ${PASS} passed, ${FAIL} failed`);
process.exit(FAIL === 0 ? 0 : 1);
