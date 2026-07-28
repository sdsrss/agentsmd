'use strict';

// Synchronize the release version across every structured source that ships or
// selects the Codex plugin. CHANGELOG prose remains an explicit release-author
// responsibility and is checked separately during release review.

const fs = require('fs');
const path = require('path');
const {
  sameSnapshot,
  snapshotFile,
  writeFileAtomic,
} = require('./lib/fs-atomic');
const { ArgvError, parseStrict, printHelpAndExit } = require('./lib/argv');
const SPEC = require('./spec-source');

const FILES = [
  'package.json',
  '.codex-plugin/plugin.json',
  '.agents/plugins/marketplace.json',
  'spec/hard-rules.json',
  'spec/source/full/00-pre-auth.md',
  'spec/AGENTS.md',
  'spec/AGENTS-extended.md',
  'install.sh',
];
const SPEC_FRAGMENT_FILES = [
  'spec/source/full/00-pre-auth.md',
  'spec/source/base/10-auth.md',
  'spec/source/full/20-post-auth-pre-safety.md',
  'spec/source/base/30-safety.md',
  'spec/source/full/40-post-safety.md',
];
const SNAPSHOT_FILES = [...new Set([...FILES, SPEC.LAYOUT, ...SPEC_FRAGMENT_FILES])];

const RELEASE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MARKETPLACE_MIN_VERSION = '4.23.0';

function compareStableVersions(left, right) {
  const a = String(left).split('.').map(BigInt);
  const b = String(right).split('.').map(BigInt);
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] > b[index]) return 1;
    if (a[index] < b[index]) return -1;
  }
  return 0;
}

function assertVersion(version) {
  if (!RELEASE_VERSION_RE.test(String(version))) {
    throw new Error(`release version must be a stable X.Y.Z semantic version: ${version}`);
  }
  if (compareStableVersions(version, MARKETPLACE_MIN_VERSION) < 0) {
    throw new Error(`release version must be >= marketplace baseline ${MARKETPLACE_MIN_VERSION}: ${version}`);
  }
}

function replaceExactlyOne(content, pattern, replacement, label) {
  const matches = content.match(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : pattern.flags + 'g')) || [];
  if (matches.length !== 1) throw new Error(`${label}: expected exactly one version field, found ${matches.length}`);
  return content.replace(pattern, replacement);
}

function renderFiles(root, version, sourceContent = null) {
  const content = sourceContent || Object.fromEntries(
    SNAPSHOT_FILES.map((rel) => [rel, fs.readFileSync(path.join(root, rel), 'utf8')])
  );
  const pkg = JSON.parse(content['package.json']);
  const plugin = JSON.parse(content['.codex-plugin/plugin.json']);
  const marketplace = JSON.parse(content['.agents/plugins/marketplace.json']);
  const hardRules = JSON.parse(content['spec/hard-rules.json']);
  const entry = (marketplace.plugins || []).find((candidate) => candidate.name === 'agentsmd');

  if (pkg.name !== '@sdsrs/agentsmd') throw new Error(`package.json: unexpected package name ${pkg.name}`);
  if (plugin.name !== 'agentsmd') throw new Error(`plugin.json: unexpected plugin name ${plugin.name}`);
  if (!entry || entry.source?.source !== 'npm' || entry.source.package !== pkg.name) {
    throw new Error('marketplace.json: agentsmd must select the published @sdsrs/agentsmd npm package');
  }
  if (compareStableVersions(version, pkg.version) < 0) {
    throw new Error(`release version must not move backward from ${pkg.version} to ${version}`);
  }
  const marketplaceVersions = String(entry.source.version || '').split(/\s*\|\|\s*/);
  if (
    marketplaceVersions.length < 1
    || marketplaceVersions.length > 2
    || marketplaceVersions.some((candidate) => !RELEASE_VERSION_RE.test(candidate))
    || marketplaceVersions[marketplaceVersions.length - 1] !== pkg.version
  ) {
    throw new Error('marketplace.json: source.version must end at the current package version and contain at most one exact fallback');
  }
  const marketplaceSelector = version === pkg.version
    ? entry.source.version
    : `${pkg.version} || ${version}`;

  const rendered = {
    'package.json': replaceExactlyOne(
      content['package.json'],
      /("version"\s*:\s*")[^"]+("\s*,)/,
      `$1${version}$2`,
      'package.json'
    ),
    '.codex-plugin/plugin.json': replaceExactlyOne(
      content['.codex-plugin/plugin.json'],
      /("version"\s*:\s*")[^"]+("\s*,)/,
      `$1${version}$2`,
      'plugin.json'
    ),
    '.agents/plugins/marketplace.json': replaceExactlyOne(
      content['.agents/plugins/marketplace.json'],
      /("version"\s*:\s*")[^"]+("\s*\n)/,
      `$1${marketplaceSelector}$2`,
      'marketplace.json'
    ),
    'spec/hard-rules.json': replaceExactlyOne(
      content['spec/hard-rules.json'],
      /("spec_version"\s*:\s*")v[^"]+("\s*,)/,
      `$1v${version}$2`,
      'hard-rules.json'
    ),
    'spec/source/full/00-pre-auth.md': replaceExactlyOne(
      content['spec/source/full/00-pre-auth.md'],
      /CODEX-CODING-SPEC v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/,
      `CODEX-CODING-SPEC v${version}`,
      'spec/source/full/00-pre-auth.md'
    ),
    'spec/AGENTS-extended.md': replaceExactlyOne(
      content['spec/AGENTS-extended.md'],
      /CODEX-CODING-SPEC v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/,
      `CODEX-CODING-SPEC v${version}`,
      'spec/AGENTS-extended.md'
    ),
    'install.sh': replaceExactlyOne(
      content['install.sh'],
      /(INSTALLER_VERSION=")[0-9]+\.[0-9]+\.[0-9]+(")/,
      `$1${version}$2`,
      'install.sh'
    ),
  };
  const generated = SPEC.renderAll({
    root,
    sourceContent: { ...content, ...rendered },
  });
  for (const [relative, buffer] of generated) rendered[relative] = buffer;
  return rendered;
}

function syncVersion({ root = path.join(__dirname, '..'), version, write = writeFileAtomic }) {
  assertVersion(version);
  const snapshots = new Map(SNAPSHOT_FILES.map((rel) => [rel, snapshotFile(path.join(root, rel))]));
  const sourceContent = Object.fromEntries(SNAPSHOT_FILES.map((rel) => {
    const snapshot = snapshots.get(rel);
    if (!snapshot.present) throw new Error(`${rel}: release version source is missing`);
    return [rel, snapshot.content.toString('utf8')];
  }));
  const rendered = renderFiles(root, version, sourceContent);
  const written = [];
  try {
    for (const rel of FILES) {
      for (const input of SNAPSHOT_FILES) {
        if (FILES.includes(input)) continue;
        if (!sameSnapshot(snapshotFile(path.join(root, input)), snapshots.get(input))) {
          throw new Error(`${input}: concurrent change detected`);
        }
      }
      const file = path.join(root, rel);
      write(file, rendered[rel], { expectedSnapshot: snapshots.get(rel) });
      written.push(rel);
    }
  } catch (error) {
    const rollbackErrors = [];
    for (const rel of written.reverse()) {
      const file = path.join(root, rel);
      const current = snapshotFile(file);
      const expectedWritten = { present: true, content: Buffer.from(rendered[rel]), mode: snapshots.get(rel).mode };
      if (!sameSnapshot(current, expectedWritten)) {
        rollbackErrors.push(`${rel}: concurrent bytes prevent rollback`);
        continue;
      }
      try {
        writeFileAtomic(file, snapshots.get(rel).content, {
          mode: snapshots.get(rel).mode,
          preserveMode: false,
          expectedSnapshot: current,
        });
      } catch (rollbackError) {
        rollbackErrors.push(`${rel}: ${rollbackError.message}`);
      }
    }
    if (rollbackErrors.length) error.message += `; rollback incomplete: ${rollbackErrors.join('; ')}`;
    throw error;
  }
  return { version, files: [...FILES] };
}

if (require.main === module) {
  const usage = 'Usage: npm run release:version -- --version=<X.Y.Z>';
  const argv = process.argv.slice(2);
  printHelpAndExit(argv, usage);
  let opts;
  try {
    opts = parseStrict(argv, { values: ['version'] });
    if (argv.length !== 1 || !opts.values.version) throw new ArgvError('exactly one --version=<X.Y.Z> is required');
    assertVersion(opts.values.version);
  } catch (error) {
    console.error(`agentsmd release:version: ${error.message}\n${usage}`);
    process.exit(2);
  }
  try {
    const result = syncVersion({ version: opts.values.version });
    console.log(`release version synchronized: ${result.version} (${result.files.length} files)`);
  } catch (error) {
    console.error(`agentsmd release:version failed: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  FILES,
  SNAPSHOT_FILES,
  SPEC_FRAGMENT_FILES,
  MARKETPLACE_MIN_VERSION,
  RELEASE_VERSION_RE,
  assertVersion,
  compareStableVersions,
  renderFiles,
  syncVersion,
};
